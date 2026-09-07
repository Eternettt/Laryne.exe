/* ==========================================================================
   api/webhook.js — Reçoit les événements Stripe (paiement confirmé/échoué).
   ==========================================================================
   C'est la SEULE source de vérité sur le statut réel d'un paiement (jamais
   le navigateur, voir success.html). La signature Stripe est vérifiée à
   partir du corps BRUT de la requête, d'où la config bodyParser: false
   ci-dessous.
   ========================================================================== */

const Stripe = require('stripe');
const { sql } = require('../lib/db');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function readRawBody(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const signature = req.headers['stripe-signature'];
  let event;
  try {
    const rawBody = await readRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook Stripe invalide :', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const checkoutSession = event.data.object;

      const { rows } = await sql`
        select id, items from orders where stripe_session_id = ${checkoutSession.id}
      `;
      if (rows.length) {
        const order = rows[0];
        const customerEmail = checkoutSession.customer_details ? checkoutSession.customer_details.email : null;

        await sql`
          update orders
          set status = 'paid', customer_email = ${customerEmail}, updated_at = now()
          where id = ${order.id}
        `;

        // Décrémente le stock uniquement pour les lignes venant de la
        // boutique (produits en base) — les créations perso / ateliers
        // n'ont pas de stock à décrémenter.
        const items = order.items || [];
        for (const item of items) {
          if (item.productId) {
            await sql`
              update products set stock = greatest(0, stock - ${item.qty}) where id = ${item.productId}
            `;
          }
        }
      }
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const checkoutSession = event.data.object;
      await sql`
        update orders set status = 'failed', updated_at = now() where stripe_session_id = ${checkoutSession.id}
      `;
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur de traitement du webhook.' });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
