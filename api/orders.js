/* ==========================================================================
   api/orders.js — Mes commandes, recherche par session Stripe, ET liste
   admin, regroupées dans une seule fonction serverless.

   - GET /api/orders                          → mes commandes (connecté)
   - GET /api/orders/by-session?session_id=.. → réécrit vers
       /api/orders?mode=by-session&session_id=.. (public, page succès)
   - GET /api/admin/orders                    → réécrit vers
       /api/orders?mode=admin (admin uniquement)
   ========================================================================== */

const { sql } = require('../lib/db');
const { getSession } = require('../lib/session');

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

async function handleAdmin(req, res) {
  const admin = await requireAdmin(req, res);
  if (!admin) return;

  const { rows } = await sql`
    select o.id, o.stripe_session_id, o.status, o.items, o.total_cents, o.customer_email, o.created_at,
           u.email as account_email
    from orders o
    left join users u on u.id = o.user_id
    order by o.created_at desc
    limit 500
  `;
  const orders = rows.map((r) => ({
    id: r.id,
    sessionId: r.stripe_session_id,
    status: r.status,
    items: r.items,
    total: r.total_cents / 100,
    customerEmail: r.customer_email || r.account_email || null,
    createdAt: r.created_at,
  }));
  res.status(200).json({ orders });
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
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const url = new URL(req.url, `https://${req.headers.host}`);
  const mode = url.searchParams.get('mode');

  try {
    if (mode === 'by-session') {
      await handleBySession(req, res, url.searchParams.get('session_id'));
      return;
    }
    if (mode === 'admin') {
      await handleAdmin(req, res);
      return;
    }
    await handleMine(req, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
