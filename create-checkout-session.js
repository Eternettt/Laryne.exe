const Stripe = require('stripe');
const { sql } = require('../lib/db');
const { getSession } = require('../lib/session');
const { computeCustomOrderPrice } = require('../lib/custom-order-pricing');
const { getShippingRates } = require('../lib/shipping-pricing');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Pays livrés. FR = tarif "France", tous les autres = tarif "étranger".
// Élargis cette liste si tu livres ailleurs (c'est la seule chose à changer).
const INTERNATIONAL_COUNTRIES = [
  'BE', 'CH', 'LU', 'MC', 'DE', 'ES', 'IT', 'PT', 'NL', 'AT', 'IE',
  'GB', 'SE', 'DK', 'NO', 'FI', 'PL', 'US', 'CA',
];
const ALL_SHIPPABLE_COUNTRIES = ['FR', ...INTERNATIONAL_COUNTRIES];

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const origin = `https://${req.headers.host}`;
  const session = getSession(req); // peut être null (achat sans compte)
  const body = req.body || {};

  // Compatibilité : si un ancien boutique.html envoie encore le panier au
  // format {id: quantité} (avant la gestion des tailles/types), on le
  // convertit ici en liste de lignes — sans ça, Object.keys() sur un
  // panier déjà au nouveau format (un tableau) renverrait des indices
  // (0, 1, 2...) pris à tort pour des identifiants produit.
  if (body.cart && !Array.isArray(body.cart) && typeof body.cart === 'object') {
    body.cart = Object.entries(body.cart).map(([id, qty]) => ({ productId: Number(id), qty }));
  }

  try {
    let lineItems = [];
    let orderItems = [];
    let totalCents = 0;
    let shippingQty = 0; // nombre de pièces, sert à choisir le palier de port

    // ---- Cas 1 : panier boutique (boutique.html) ----
    // body.cart est un tableau de lignes : { productId, qty, type, size, remark }
    // (une ligne par combinaison produit + type + taille, pas juste par produit :
    // deux tailles du même modèle sont deux lignes distinctes).
    if (Array.isArray(body.cart)) {
      // Diagnostic (visible dans Vercel > Logs) : ce que le serveur reçoit vraiment.
      console.log('[checkout v2] panier reçu :', JSON.stringify(body.cart));

      const lines = body.cart
        .map((l) => ({
          productId: parseInt(l && l.productId, 10),
          qty: Math.max(1, Math.min(99, parseInt(l && l.qty, 10) || 0)),
          type: l && l.type ? String(l.type).slice(0, 60) : null,
          size: l && l.size ? String(l.size).slice(0, 20) : null,
          remark: l && l.remark ? String(l.remark).slice(0, 500) : null,
        }))
        .filter((l) => Number.isInteger(l.productId));

      if (!lines.length) {
        res.status(400).json({ error: 'Panier vide.' });
        return;
      }

      const ids = [...new Set(lines.map((l) => l.productId))];
      const { rows: products } = await sql`
        select id, name, price_cents, stock from products where id = any(${ids})
      `;

      // Le stock se vérifie sur le total par produit, tailles/types confondus.
      const qtyByProduct = {};
      for (const l of lines) qtyByProduct[l.productId] = (qtyByProduct[l.productId] || 0) + l.qty;

      for (const line of lines) {
        const product = products.find((p) => p.id === line.productId);
        if (!product) {
          res.status(400).json({ error: `Produit ${line.productId} introuvable. (v2)` });
          return;
        }
        if (product.stock < qtyByProduct[line.productId]) {
          res.status(400).json({ error: `Stock insuffisant pour "${product.name}".` });
          return;
        }

        const details = [line.type, line.size ? `Taille ${line.size}` : null].filter(Boolean).join(' - ');
        lineItems.push({
          price_data: {
            currency: 'eur',
            product_data: { name: details ? `${product.name} (${details})` : product.name },
            unit_amount: product.price_cents,
          },
          quantity: line.qty,
        });
        orderItems.push({
          productId: product.id,
          name: product.name,
          qty: line.qty,
          unitPrice: product.price_cents / 100,
          type: line.type,
          size: line.size,
          remark: line.remark,
        });
        totalCents += product.price_cents * line.qty;
        shippingQty += line.qty;
      }

    // ---- Cas 2 : création personnalisée (commande_perso.html) ----
    } else if (body.customOrder) {
      const { totalCents: t, name } = computeCustomOrderPrice(body.customOrder);
      totalCents = t;
      shippingQty = 1;
      lineItems.push({
        price_data: { currency: 'eur', product_data: { name }, unit_amount: t },
        quantity: 1,
      });
      orderItems.push({ name, qty: 1, unitPrice: t / 100, customOrder: body.customOrder });

    // ---- Cas 3 : article libre (ex. acompte atelier, workshop.html) ----
    } else if (body.customItem && body.customItem.name) {
      const cleanAmount = Math.max(50, Math.min(500000, Math.round(Number(body.customItem.unitAmount) || 0)));
      if (!cleanAmount) {
        res.status(400).json({ error: 'Montant invalide.' });
        return;
      }
      totalCents = cleanAmount;
      lineItems.push({
        price_data: {
          currency: 'eur',
          product_data: { name: String(body.customItem.name).slice(0, 250) },
          unit_amount: cleanAmount,
        },
        quantity: 1,
      });
      orderItems.push({ name: body.customItem.name, qty: 1, unitPrice: cleanAmount / 100 });
    } else {
      res.status(400).json({ error: 'Requête invalide.' });
      return;
    }

    // ---- Adresse de livraison + frais de port ----
    // Demandées par Stripe Checkout uniquement pour les commandes d'articles
    // physiques (panier, création perso) : inutile pour un acompte d'atelier.
    // Le tarif dépend du nombre de pièces ET du pays saisi par la personne sur
    // la page Stripe : on propose donc DEUX tarifs (France / étranger),
    // chacun restreint à ses pays via "restrictions" — Stripe n'affiche et
    // n'applique automatiquement que celui qui correspond à l'adresse tapée.
    const needsShipping = Array.isArray(body.cart) || !!body.customOrder;
    let shippingOptionsBlock = {};
    if (needsShipping) {
      const rates = getShippingRates(shippingQty);
      shippingOptionsBlock = {
        shipping_address_collection: { allowed_countries: ALL_SHIPPABLE_COUNTRIES },
        shipping_options: [
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: rates.franceCents, currency: 'eur' },
              display_name: 'Livraison France',
              restrictions: { allowed_countries: ['FR'] },
            },
          },
          {
            shipping_rate_data: {
              type: 'fixed_amount',
              fixed_amount: { amount: rates.abroadCents, currency: 'eur' },
              display_name: 'Livraison internationale',
              restrictions: { allowed_countries: INTERNATIONAL_COUNTRIES },
            },
          },
        ],
      };
    }

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/boutique.html`,
      ...shippingOptionsBlock,
    });

    // totalCents ici ne compte que les articles : le port choisi par Stripe
    // (selon l'adresse tapée) n'est connu qu'après paiement. webhook.js met
    // à jour total_cents et shipping_cents avec les vrais montants dès que
    // le paiement est confirmé.
    await sql`
      insert into orders (stripe_session_id, user_id, status, items, total_cents, linked_to_account)
      values (${checkoutSession.id}, ${session ? session.uid : null}, 'pending', ${JSON.stringify(orderItems)}, ${totalCents}, ${!!session})
    `;

    res.status(200).json({ url: checkoutSession.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Erreur lors de la création du paiement." });
  }
};
