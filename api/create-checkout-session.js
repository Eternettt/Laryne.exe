const Stripe = require('stripe');
const { sql } = require('../lib/db');
const { getSession } = require('../lib/session');
const { computeCustomOrderPrice } = require('../lib/custom-order-pricing');
// ---- Frais de port selon le nombre de pièces (intégré ici : pas de fichier en plus) ----
// Paliers : 1-2 / 3-5 / 6-10 pièces. Au-delà de 10, on applique le dernier palier.
const SHIPPING_TIERS = [
  { max: 2, franceCents: 350, abroadCents: 750 },
  { max: 5, franceCents: 570, abroadCents: 1410 },
  { max: 10, franceCents: 772, abroadCents: 1900 },
];
function getShippingRates(quantity) {
  const qty = Math.max(1, Math.round(Number(quantity) || 1));
  const tier = SHIPPING_TIERS.find((t) => qty <= t.max) || SHIPPING_TIERS[SHIPPING_TIERS.length - 1];
  return { franceCents: tier.franceCents, abroadCents: tier.abroadCents };
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ---- Ateliers : l'acompte est lu ici, jamais fourni par le navigateur ----
// Liste enregistrée par l'admin (table site_settings, clé "workshops", voir
// api/products.js). Tant que l'admin n'a rien enregistré, le site affiche
// l'atelier par défaut de shared-data.js (STRINGZ_DEFAULT_WORKSHOPS) : on en
// garde ici la même copie (id + acompte), sinon il serait impossible à réserver.
const DEFAULT_WORKSHOPS = [
  { id: 'upcycling-2026-09-06', title: 'Atelier upcycling', dateLabel: '6 septembre 2026', deposit: 20 },
];

async function findWorkshop(workshopId) {
  if (typeof workshopId !== 'string' || !/^[a-z0-9-]{1,120}$/.test(workshopId)) return null;
  const { rows } = await sql`select value from site_settings where key = 'workshops'`;
  const list = rows.length && Array.isArray(rows[0].value) ? rows[0].value : DEFAULT_WORKSHOPS;
  return list.find((w) => w && w.id === workshopId) || null;
}

function cleanShortText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

// Pays livrés. FR = tarif "France", tous les autres = tarif "étranger".
// Élargis cette liste si tu livres ailleurs (c'est la seule chose à changer,
// pense aussi à mettre à jour le libellé de l'option "Étranger" dans boutique.html).
const INTERNATIONAL_COUNTRIES = [
  'BE', 'CH', 'LU', 'MC', 'DE', 'ES', 'IT', 'PT', 'NL', 'AT', 'IE',
  'GB', 'SE', 'DK', 'NO', 'FI', 'PL', 'US', 'CA',
];
const ALL_SHIPPABLE_COUNTRIES = ['FR', ...INTERNATIONAL_COUNTRIES];

// ---- Adresse de livraison + frais de port ----
// Stripe Checkout n'accepte pas de restreindre un tarif de port à certains
// pays : tous les tarifs passés sont proposés au client. Pour que le port
// facturé corresponde toujours au pays de livraison, la destination
// ("FR" ou "INTL") est donc choisie AVANT le paiement (menu dans le panier de
// boutique.html) : on ne passe alors à Stripe que le bon tarif, et
// shipping_address_collection n'autorise que les pays de cette zone — Stripe
// refuse lui-même une adresse hors zone.
// La destination est OBLIGATOIRE et validée côté serveur ('FR' ou 'INTL') pour
// tout envoi physique (panier ET création perso) : sans elle, Stripe proposerait
// les deux tarifs et un client à l'étranger pourrait choisir le tarif France.
const VALID_DESTINATIONS = ['FR', 'INTL'];
function buildShippingBlock(quantity, destination) {
  const rates = getShippingRates(quantity);
  const franceOption = {
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: { amount: rates.franceCents, currency: 'eur' },
      display_name: 'Livraison France',
    },
  };
  const abroadOption = {
    shipping_rate_data: {
      type: 'fixed_amount',
      fixed_amount: { amount: rates.abroadCents, currency: 'eur' },
      display_name: 'Livraison internationale',
    },
  };

  if (destination === 'FR') {
    return {
      shipping_address_collection: { allowed_countries: ['FR'] },
      shipping_options: [franceOption],
    };
  }
  if (destination === 'INTL') {
    return {
      shipping_address_collection: { allowed_countries: INTERNATIONAL_COUNTRIES },
      shipping_options: [abroadOption],
    };
  }
  // Ne devrait jamais arriver (la destination est validée avant l'appel).
  throw new Error('Destination de livraison invalide.');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const origin = `https://${req.headers.host}`;
  const session = getSession(req); // peut être null (achat sans compte)
  const body = req.body || {};

  // Compatibilité : un ancien boutique.html envoyait le panier au format
  // {id: quantité}. On le convertit en liste de lignes. Un panier déjà au
  // nouveau format (tableau) n'est PAS touché — sinon Object.keys() renverrait
  // des indices (0, 1, 2...) pris à tort pour des identifiants produit.
  if (body.cart && !Array.isArray(body.cart) && typeof body.cart === 'object') {
    body.cart = Object.entries(body.cart).map(([id, qty]) => ({ productId: Number(id), qty }));
  }

  // Destination de livraison : validée avant toute lecture en base ou appel Stripe.
  const needsShipping = Array.isArray(body.cart) || !!body.customOrder;
  if (needsShipping && !VALID_DESTINATIONS.includes(body.destination)) {
    res.status(400).json({ error: 'Choisis une destination de livraison (France ou étranger).' });
    return;
  }

  try {
    const lineItems = [];
    const orderItems = [];
    let totalCents = 0;
    let shippingQty = 0; // nombre de pièces, sert à choisir le palier de port

    // ---- Cas 1 : panier boutique (boutique.html) ----
    // body.cart est un tableau de lignes : { productId, qty, type, size, remark }
    // (une ligne par combinaison produit + type + taille : deux tailles du même
    // modèle sont deux lignes distinctes).
    if (Array.isArray(body.cart)) {
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
        const product = products.find((p) => Number(p.id) === line.productId);
        if (!product) {
          res.status(400).json({ error: `Produit ${line.productId} introuvable.` });
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
          productId: Number(product.id),
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
      let priced;
      try {
        priced = computeCustomOrderPrice(body.customOrder);
      } catch (pricingErr) {
        if (pricingErr && pricingErr.isValidation) {
          res.status(400).json({ error: pricingErr.message });
          return;
        }
        throw pricingErr;
      }
      const { totalCents: t, name, fabrication } = priced;
      totalCents = t;
      shippingQty = 1;
      lineItems.push({
        price_data: { currency: 'eur', product_data: { name }, unit_amount: t },
        quantity: 1,
      });
      // On enregistre la fiche de fabrication reconstruite par le serveur (valeurs
      // validées, celles qui ont servi au calcul du prix), jamais le JSON brut du navigateur.
      orderItems.push({ name, qty: 1, unitPrice: t / 100, customOrder: fabrication });

    // ---- Cas 3 : acompte d'atelier (workshop.html) ----
    // Le navigateur n'envoie QUE l'identifiant de l'atelier et les coordonnées du
    // participant. Le montant de l'acompte, le titre et la date viennent de la
    // liste des ateliers enregistrée côté serveur. (L'ancien format "customItem"
    // avec un montant fourni par le client n'est plus accepté.)
    } else if (body.workshopBooking && typeof body.workshopBooking === 'object') {
      const wb = body.workshopBooking;
      const workshop = await findWorkshop(wb.workshopId);
      if (!workshop) {
        res.status(400).json({ error: 'Atelier introuvable (il a peut-être été supprimé).' });
        return;
      }
      const depositCents = Math.round(Number(workshop.deposit) * 100);
      if (!Number.isFinite(depositCents) || depositCents < 50 || depositCents > 500000) {
        res.status(400).json({ error: "Cet atelier n'a pas d'acompte payable en ligne." });
        return;
      }
      const participantName = cleanShortText(wb.participantName, 100);
      const participantContact = cleanShortText(wb.contact, 100);
      if (!participantName || !participantContact) {
        res.status(400).json({ error: 'Nom et moyen de contact requis.' });
        return;
      }
      const itemName = `${workshop.title} - ${workshop.dateLabel} (acompte) — ${participantName} (${participantContact})`.slice(0, 250);
      totalCents = depositCents;
      lineItems.push({
        price_data: { currency: 'eur', product_data: { name: itemName }, unit_amount: depositCents },
        quantity: 1,
      });
      orderItems.push({ name: itemName, qty: 1, unitPrice: depositCents / 100, workshopId: workshop.id });
    } else {
      res.status(400).json({ error: 'Requête invalide.' });
      return;
    }

    // Adresse + port : uniquement pour les articles physiques (panier, création
    // perso), pas pour un acompte d'atelier.
    const shippingBlock = needsShipping ? buildShippingBlock(shippingQty, body.destination) : {};

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/boutique.html`,
      ...shippingBlock,
    });

    // totalCents ne compte ici que les articles : le port n'est connu
    // qu'après paiement. webhook.js met à jour total_cents et shipping_cents
    // avec les vrais montants dès que le paiement est confirmé.
    try {
      await sql`
        insert into orders (stripe_session_id, user_id, status, items, total_cents, linked_to_account)
        values (${checkoutSession.id}, ${session ? session.uid : null}, 'pending', ${JSON.stringify(orderItems)}, ${totalCents}, ${!!session})
      `;
    } catch (insertErr) {
      // Sans ligne en base, un paiement réussi ne pourrait jamais être rattaché à une
      // commande (ni mail, ni stock, ni remboursement). On invalide donc la session
      // Stripe pour que le client ne puisse pas payer.
      await stripe.checkout.sessions.expire(checkoutSession.id).catch(() => {});
      throw insertErr;
    }

    res.status(200).json({ url: checkoutSession.url });
  } catch (err) {
    console.error('[checkout] erreur :', err);
    // Message générique côté client (une erreur brute peut révéler des détails
    // internes). Pour revoir la vraie cause dans le toast de boutique.html pendant
    // un débogage, ajoute la variable d'environnement CHECKOUT_DEBUG=1 sur Vercel
    // (puis retire-la). Dans tous les cas, l'erreur complète est dans les logs Vercel.
    const detail = process.env.CHECKOUT_DEBUG === '1' && err && err.message ? ' : ' + err.message : '';
    res.status(500).json({ error: 'Erreur lors de la création du paiement' + detail + (detail ? '' : '.') });
  }
};