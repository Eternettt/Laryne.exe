// api/admin/orders.js
// Liste toutes les commandes, réservé admin (requireAdmin revérifie le rôle
// en base à chaque appel).

const { sql } = require('../../lib/db');
const { requireAdmin } = require('../../lib/session');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
    const { rows: orders } = await sql`
      SELECT o.id, o.user_id, o.email, o.status, o.kind, o.total_cents, o.created_at,
             u.email AS account_email, u.name AS account_name
      FROM orders o
      LEFT JOIN users u ON u.id = o.user_id
      ORDER BY o.created_at DESC
      LIMIT 300
    `;
    const orderIds = orders.map(o => o.id);
    let itemsByOrder = {};
    if (orderIds.length) {
      const { rows: items } = await sql`
        SELECT order_id, name_snapshot, unit_price_cents, quantity
        FROM order_items WHERE order_id = ANY(${orderIds})
      `;
      itemsByOrder = items.reduce((acc, it) => {
        (acc[it.order_id] = acc[it.order_id] || []).push({
          name: it.name_snapshot, unitPrice: it.unit_price_cents / 100, qty: it.quantity,
        });
        return acc;
      }, {});
    }

    res.status(200).json({
      orders: orders.map(o => ({
        id: o.id,
        status: o.status,
        kind: o.kind,
        total: o.total_cents / 100,
        date: o.created_at,
        email: o.account_email || o.email || '(invité)',
        accountName: o.account_name || null,
        items: itemsByOrder[o.id] || [],
      })),
    });
  } catch (err) {
    console.error('Erreur GET /api/admin/orders:', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
