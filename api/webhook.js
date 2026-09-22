const Stripe = require('stripe');
const { sql } = require('../lib/db');
const { applyRefundToOrder } = require('../lib/order-refund');
const { isEmailConfigured, sendOrderConfirmation } = require('../lib/email');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function readRawBody(readable) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readable.on('data', (chunk) => chunks.push(chunk));
    readable.on('end', () => resolve(Buffer.concat(chunks)));
    readable.on('error', reject);
  });
}

// Commande payée : statut, coordonnées, port réel, décrément du stock (une seule fois).
// Renvoie l'id de la commande (ou null si elle est introuvable).
async function markOrderPaid(checkoutSession) {
  const { rows } = await sql`
    select id, items from orders where stripe_session_id = ${checkoutSession.id}
  `;
  if (!rows.length) {
    console.error('[webhook] Paiement reçu pour une session sans commande en base :', checkoutSession.id);
    return null;
  }
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

  // Identifiant du paiement Stripe : indispensable pour pouvoir rembourser.
  const paymentIntentId =
    typeof checkoutSession.payment_intent === 'string'
      ? checkoutSession.payment_intent
      : (checkoutSession.payment_intent && checkoutSession.payment_intent.id) || null;

  // "status in ('pending','failed')" + returning : si Stripe renvoie deux fois le même
  // événement, la commande n'est traitée — et le stock décrémenté — qu'une seule fois.
  // (On n'utilise plus "status <> 'paid'" : une commande remboursée repasserait
  // sinon à "paid" si l'événement était rejoué.)
  const { rows: updated } = await sql`
    update orders
    set status = 'paid',
        customer_email = ${customerEmail},
        shipping_name = ${shippingName},
        shipping_address = ${shippingAddress ? JSON.stringify(shippingAddress) : null},
        shipping_cents = ${shippingCents},
        total_cents = coalesce(${totalCents}, total_cents),
        payment_intent_id = ${paymentIntentId},
        updated_at = now()
    where id = ${order.id} and status in ('pending', 'failed')
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
  return order.id;
}

// E-mail de confirmation, envoyé une seule fois par commande.
// - Rien n'est tenté (ni marqué) si l'e-mail n'est pas configuré.
// - La ligne est "réservée" avant l'envoi (confirmation_email_sent_at) pour éviter
//   un doublon si deux événements arrivent en même temps ; si l'envoi échoue, la
//   réservation est levée et l'erreur remonte → Stripe rejouera le webhook plus tard.
async function sendConfirmationOnce(orderId) {
  if (!isEmailConfigured()) {
    console.warn('[webhook] E-mail non configuré (RESEND_API_KEY / MAIL_FROM) : confirmation non envoyée pour la commande', orderId);
    return;
  }
  const { rows } = await sql`
    update orders
    set confirmation_email_sent_at = now()
    where id = ${orderId}
      and status in ('paid', 'partially_refunded')
      and confirmation_email_sent_at is null
      and customer_email is not null
    returning id, items, total_cents, shipping_cents, customer_email, shipping_name, shipping_address
  `;
  if (!rows.length) return;
  try {
    await sendOrderConfirmation(rows[0]);
  } catch (err) {
    await sql`update orders set confirmation_email_sent_at = null where id = ${orderId}`;
    throw err;
  }
}

// Retrouve la commande d'un paiement Stripe. Pour les commandes payées avant
// l'ajout de payment_intent_id, on remonte via la session Checkout.
async function findOrderIdByPaymentIntent(paymentIntentId) {
  const { rows } = await sql`select id from orders where payment_intent_id = ${paymentIntentId}`;
  if (rows.length) return rows[0].id;

  const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
  if (!sessions.data.length) return null;
  const { rows: linked } = await sql`
    update orders set payment_intent_id = ${paymentIntentId}
    where stripe_session_id = ${sessions.data[0].id}
    returning id
  `;
  return linked.length ? linked[0].id : null;
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
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const checkoutSession = event.data.object;
      // Carte : payment_status vaut "paid" tout de suite. Pour un moyen de paiement
      // différé, on attend l'événement async_payment_succeeded.
      if (checkoutSession.payment_status === 'paid') {
        const orderId = await markOrderPaid(checkoutSession);
        if (orderId) await sendConfirmationOnce(orderId);
      }
    } else if (event.type === 'checkout.session.expired' || event.type === 'checkout.session.async_payment_failed') {
      const checkoutSession = event.data.object;
      await sql`
        update orders set status = 'failed', updated_at = now()
        where stripe_session_id = ${checkoutSession.id} and status = 'pending'
      `;
    } else if (event.type === 'charge.refunded') {
      // Remboursement (total ou partiel) fait depuis l'admin OU depuis le Dashboard Stripe.
      const charge = event.data.object;
      const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : (charge.payment_intent && charge.payment_intent.id);
      if (paymentIntentId) {
        const orderId = await findOrderIdByPaymentIntent(paymentIntentId);
        if (orderId) await applyRefundToOrder(orderId, charge.amount_refunded);
        else console.error('[webhook] Remboursement reçu sans commande correspondante :', paymentIntentId);
      }
    }

    res.status(200).json({ received: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur de traitement du webhook.' });
  }
}

module.exports = handler;
module.exports.config = { api: { bodyParser: false } };
