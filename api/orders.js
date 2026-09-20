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

  // Seules les commandes payées et pas encore marquées comme expédiées
  // apparaissent ici. Les plus anciennes en premier, pour traiter la file
  // dans l'ordre d'arrivée.
  const { rows } = await sql`
    select o.id, o.stripe_session_id, o.status, o.items, o.total_cents, o.shipping_cents,
           o.customer_email, o.created_at, o.shipping_name, o.shipping_address,
           u.email as account_email
    from orders o
    left join users u on u.id = o.user_id
    where o.status = 'paid' and o.shipped_at is null
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
    update orders set shipped_at = now() where id = ${id} and shipped_at is null
    returning id
  `;
  if (!rows.length) {
    res.status(404).json({ error: 'Commande introuvable ou déjà marquée comme expédiée.' });
    return;
  }
  res.status(200).json({ ok: true });
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

    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Méthode non autorisée.' });
      return;
    }

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
