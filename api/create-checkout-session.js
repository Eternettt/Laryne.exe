const Stripe = require('stripe');
const { sql } = require('../lib/db');
const { getSession } = require('../lib/session');
const { computeCustomOrderPrice } = require('../lib/custom-order-pricing');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const origin = `https://${req.headers.host}`;
  const session = getSession(req); // peut être null (achat sans compte)
  const body = req.body || {};

  try {
    let lineItems = [];
    let orderItems = [];
    let totalCents = 0;

    // ---- Cas 1 : panier boutique (boutique.html) ----
    if (body.cart && typeof body.cart === 'object') {
      const ids = Object.keys(body.cart)
        .map((n) => parseInt(n, 10))
        .filter((n) => Number.isInteger(n));

      if (!ids.length) {
        res.status(400).json({ error: 'Panier vide.' });
        return;
      }

      const { rows: products } = await sql`
        select id, name, price_cents, stock from products where id = any(${ids})
      `;

      for (const id of ids) {
        const qty = Math.max(1, Math.min(99, parseInt(body.cart[id], 10) || 0));
        const product = products.find((p) => p.id === id);
        if (!product) {
          res.status(400).json({ error: `Produit ${id} introuvable.` });
          return;
        }
        if (product.stock < qty) {
          res.status(400).json({ error: `Stock insuffisant pour "${product.name}".` });
          return;
        }

        lineItems.push({
          price_data: {
            currency: 'eur',
            product_data: { name: product.name },
            unit_amount: product.price_cents,
          },
          quantity: qty,
        });
        orderItems.push({ productId: product.id, name: product.name, qty, unitPrice: product.price_cents / 100 });
        totalCents += product.price_cents * qty;
      }

    // ---- Cas 2 : création personnalisée (commande_perso.html) ----
    } else if (body.customOrder) {
      const { totalCents: t, name } = computeCustomOrderPrice(body.customOrder);
      totalCents = t;
      lineItems.push({
        price_data: { currency: 'eur', product_data: { name }, unit_amount: t },
        quantity: 1,
      });
      orderItems.push({ name, qty: 1, unitPrice: t / 100, customOrder: body.customOrder });

    // ---- Cas 3 : article libre (ex. acompte atelier, workshop.html) ----
    // NB : les ateliers ne sont pas encore en base (voir shared-data.js),
    // donc le montant vient du client ici. On le borne à une plage
    // raisonnable pour limiter les abus, mais une vraie garantie
    // nécessiterait de migrer aussi les ateliers en base plus tard.
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

    const checkoutSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: lineItems,
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/boutique.html`,
    });

    // La commande est créée en base tout de suite, statut "pending" — le
    // webhook Stripe la passera à "paid" (ou "failed") une fois le paiement
    // confirmé (voir api/webhook.js). success.html la retrouve ensuite via
    // stripe_session_id.
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
