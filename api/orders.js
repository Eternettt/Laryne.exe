/* ==========================================================================
   api/orders.js — Mes commandes, recherche par session Stripe, liste admin
   ET validation d'envoi, regroupées dans une seule fonction serverless.

   - GET /api/orders                          → mes commandes (connecté)
   - GET /api/orders/by-session?session_id=.. → réécrit vers
       /api/orders?mode=by-session&session_id=.. (public, page succès)
   - GET /api/admin/orders                    → réécrit vers
       /api/orders?mode=admin (admin uniquement) : commandes payées pas
       encore expédiées, les plus anciennes en premier, avec l'adresse.
   - PUT /api/orders?mode=admin  { id }       (admin uniquement) : marque la
       commande comme expédiée (shipped_at = now()) — elle disparaît alors
       de la liste ci-dessus.
   - GET /api/orders?mode=admin&scope=all     (admin uniquement) : toutes les
       commandes payées / remboursées, expédiées ou non, les plus récentes
       en premier (pour retrouver une commande à rembourser).
   - POST /api/orders?mode=refund { id, amount? } (admin uniquement) :
       rembourse la commande via Stripe. "amount" en euros = remboursement
       partiel ; absent = tout ce qui reste à rembourser (port inclus).
   ========================================================================== */

const Stripe = require('stripe');
const { sql } = require('../lib/db');
const { getSession } = require('../lib/session');
const { applyRefundToOrder } = require('../lib/order-refund');

// Créé à la demande : les routes qui n'utilisent pas Stripe ne dépendent
// pas de STRIPE_SECRET_KEY.
let stripeClient = null;
function getStripe() {
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

async function requireAdmin(req, res) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Non connecté.' });
    return null;
  }
  const { rows } = await sql`select id, role, deleted_at from users where id = ${session.uid}`;
  const user = rows[0];
  if (!user || user.deleted_at || user.role !== 'admin') {
    res.status(403).json({ error: 'Accès refusé.' });
    return null;
  }
  return user;
}

async function handleBySession(req, res, sessionId) {
  if (!sessionId) {
    res.status(400).json({ error: 'session_id manquant.' });
    return;
  }
  const { rows } = await sql`
    select status, items, total_cents, linked_to_account
    from orders where stripe_session_id = ${sessionId}
  `;
  if (!rows.length) {
    res.status(404).json({ order: null });
    return;
  }
  const r = rows[0];
  res.status(200).json({
    order: {
      status: r.status,
      items: r.items,
      total: r.total_cents / 100,
      linkedToAccount: r.linked_to_account,
    },
  });
}

async function handleAdmin(req, res, includeAll) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  // Par défaut : seules les commandes payées (même partiellement remboursées) et
  // pas encore marquées comme expédiées, les plus anciennes en premier, pour traiter
  // la file dans l'ordre d'arrivée. Avec scope=all : tout l'historique payé/remboursé,
  // du plus récent au plus ancien.
  const { rows } = includeAll
    ? await sql`
        select o.id, o.stripe_session_id, o.status, o.items, o.total_cents, o.shipping_cents,
               o.refunded_cents, o.shipped_at,
               o.customer_email, o.created_at, o.shipping_name, o.shipping_address,
               u.email as account_email
        from orders o
        left join users u on u.id = o.user_id
        where o.status in ('paid', 'partially_refunded', 'refunded')
        order by o.created_at desc
        limit 500
      `
    : await sql`
        select o.id, o.stripe_session_id, o.status, o.items, o.total_cents, o.shipping_cents,
               o.refunded_cents, o.shipped_at,
               o.customer_email, o.created_at, o.shipping_name, o.shipping_address,
               u.email as account_email
        from orders o
        left join users u on u.id = o.user_id
        where o.status in ('paid', 'partially_refunded') and o.shipped_at is null
        order by o.created_at asc
        limit 500
      `;
  const orders = rows.map((r) => ({
    id: r.id,
    sessionId: r.stripe_session_id,
    status: r.status,
    items: r.items,
    total: r.total_cents / 100,
    shippingCost: r.shipping_cents != null ? r.shipping_cents / 100 : null,
    refunded: (r.refunded_cents || 0) / 100,
    shippedAt: r.shipped_at || null,
    customerEmail: r.customer_email || r.account_email || null,
    createdAt: r.created_at,
    shippingName: r.shipping_name || null,
    shippingAddress: r.shipping_address || null, // {line1, line2, city, postal_code, country, state}
  }));
  res.status(200).json({ orders });
}

async function handleMarkShipped(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { id } = req.body || {};
  if (!id) {
    res.status(400).json({ error: 'id requis.' });
    return;
  }

  const { rows } = await sql`
    update orders set shipped_at = now()
    where id = ${id} and shipped_at is null and status in ('paid', 'partially_refunded')
    returning id
  `;
  if (!rows.length) {
    res.status(404).json({ error: 'Commande introuvable, non payée, remboursée ou déjà marquée comme expédiée.' });
    return;
  }
  res.status(200).json({ ok: true });
}

async function handleRefund(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { id, amount } = req.body || {};
  if (!id) {
    res.status(400).json({ error: 'id requis.' });
    return;
  }

  const { rows } = await sql`
    select id, status, stripe_session_id, payment_intent_id, total_cents, refunded_cents
    from orders where id = ${id}
  `;
  const order = rows[0];
  if (!order) {
    res.status(404).json({ error: 'Commande introuvable.' });
    return;
  }
  if (order.status !== 'paid' && order.status !== 'partially_refunded') {
    res.status(409).json({ error: 'Seule une commande payée (non totalement remboursée) peut être remboursée.' });
    return;
  }

  const alreadyRefunded = order.refunded_cents || 0;
  const remaining = order.total_cents - alreadyRefunded;
  let refundCents = remaining;
  if (amount !== undefined && amount !== null && amount !== '') {
    refundCents = Math.round(Number(amount) * 100);
    if (!Number.isFinite(refundCents) || refundCents <= 0) {
      res.status(400).json({ error: 'Montant de remboursement invalide.' });
      return;
    }
  }
  if (refundCents > remaining) {
    res.status(400).json({ error: `Montant supérieur au reste remboursable (${(remaining / 100).toFixed(2)} €).` });
    return;
  }

  const stripe = getStripe();

  // Commandes payées avant l'ajout de payment_intent_id : on le retrouve via la session Checkout.
  let paymentIntentId = order.payment_intent_id;
  if (!paymentIntentId) {
    const checkoutSession = await stripe.checkout.sessions.retrieve(order.stripe_session_id);
    paymentIntentId = typeof checkoutSession.payment_intent === 'string'
      ? checkoutSession.payment_intent
      : (checkoutSession.payment_intent && checkoutSession.payment_intent.id) || null;
    if (!paymentIntentId) {
      res.status(409).json({ error: 'Aucun paiement Stripe associé à cette commande.' });
      return;
    }
    await sql`update orders set payment_intent_id = ${paymentIntentId} where id = ${order.id}`;
  }

  try {
    // La clé d'idempotence évite un double remboursement en cas de double clic
    // ou de nouvel essai (même commande, même état, même montant).
    await stripe.refunds.create(
      { payment_intent: paymentIntentId, amount: refundCents, metadata: { order_id: String(order.id) } },
      { idempotencyKey: `refund-${order.id}-${alreadyRefunded}-${refundCents}` }
    );
  } catch (err) {
    console.error('[refund] Stripe :', err);
    res.status(502).json({ error: 'Stripe a refusé le remboursement : ' + (err && err.message ? err.message : 'erreur inconnue') });
    return;
  }

  // Le webhook "charge.refunded" mettra aussi la commande à jour ; les deux
  // chemins sont sans conflit (voir lib/order-refund.js).
  const updated = await applyRefundToOrder(order.id, alreadyRefunded + refundCents);
  res.status(200).json({
    ok: true,
    status: updated ? updated.status : null,
    refunded: (refundCents / 100),
    totalRefunded: (alreadyRefunded + refundCents) / 100,
  });
}

async function handleMine(req, res) {
  const session = getSession(req);
  if (!session) {
    res.status(200).json({ orders: [] });
    return;
  }
  const { rows } = await sql`
    select id, stripe_session_id, status, items, total_cents, created_at
    from orders
    where user_id = ${session.uid}
    order by created_at desc
  `;
  const orders = rows.map((r) => ({
    id: r.id,
    sessionId: r.stripe_session_id,
    status: r.status,
    items: r.items,
    total: r.total_cents / 100,
    createdAt: r.created_at,
  }));
  res.status(200).json({ orders });
}

module.exports = async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const mode = url.searchParams.get('mode');

  try {
    if (req.method === 'PUT') {
      // Seule action d'écriture : marquer une commande comme expédiée (admin).
      await handleMarkShipped(req, res);
      return;
    }

    if (req.method === 'POST' && mode === 'refund') {
      await handleRefund(req, res);
      return;
    }

    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Méthode non autorisée.' });
      return;
    }

    if (mode === 'by-session') {
      await handleBySession(req, res, url.searchParams.get('session_id'));
      return;
    }
    if (mode === 'admin') {
      await handleAdmin(req, res, url.searchParams.get('scope') === 'all');
      return;
    }
    await handleMine(req, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
