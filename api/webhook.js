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

        // Adresse de livraison : présente seulement si shipping_address_collection
        // était activé (panier / création perso), absente pour un acompte d'atelier.
        // Selon la version d'API du webhook Stripe, elle est dans shipping_details
        // (ancien) ou collected_information.shipping_details (récent).
        const shippingDetails =
          checkoutSession.shipping_details ||
          (checkoutSession.collected_information && checkoutSession.collected_information.shipping_details) ||
          null;
        const shippingName = shippingDetails ? shippingDetails.name : null;
        const shippingAddress = shippingDetails ? shippingDetails.address : null;

        // Le port n'est connu qu'ici : on remplace le total "articles seuls"
        // posé à la création de la session par le vrai montant payé, port inclus.
        const shippingCents =
          (checkoutSession.shipping_cost && checkoutSession.shipping_cost.amount_total) ||
          (checkoutSession.total_details && checkoutSession.total_details.amount_shipping) ||
          0;
        const totalCents = typeof checkoutSession.amount_total === 'number' ? checkoutSession.amount_total : null;

        // "and status <> 'paid'" + returning : si Stripe renvoie deux fois le même
        // événement (nouvel essai après un délai dépassé, par exemple), la
        // commande n'est traitée — et le stock décrémenté — qu'une seule fois.
        const { rows: updated } = await sql`
          update orders
          set status = 'paid',
              customer_email = ${customerEmail},
              shipping_name = ${shippingName},
              shipping_address = ${shippingAddress ? JSON.stringify(shippingAddress) : null},
              shipping_cents = ${shippingCents},
              total_cents = coalesce(${totalCents}, total_cents),
              updated_at = now()
          where id = ${order.id} and status <> 'paid'
          returning id
        `;

        if (updated.length) {
          const items = order.items || [];
          for (const item of items) {
            if (item.productId) {
              await sql`
                update products set stock = greatest(0, stock - ${item.qty}) where id = ${item.productId}
              `;
            }
          }
        }
      }
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const checkoutSession = event.data.object;
      await sql`
        update orders set status = 'failed', updated_at = now()
        where stripe_session_id = ${checkoutSession.id} and status = 'pending'
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
