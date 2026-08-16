// api/orders/index.js
// Historique de commandes de la personne CONNECTÉE uniquement. L'id
// utilisateur vient du cookie de session côté serveur (lib/session.js),
// jamais d'un paramètre envoyé par le client — impossible de consulter les
// commandes de quelqu'un d'autre en changeant un id dans l'URL ou le corps
// de la requête (IDOR).

const { sql } = require('../../lib/db');
const { requireUser } = require('../../lib/session');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const user = await requireUser(req, res);
  if (!user) return;

  try {
    const { rows: orders } = await sql`
      SELECT id, status, kind, total_cents, created_at
      FROM orders
      WHERE user_id = ${user.id}
      ORDER BY created_at DESC
      LIMIT 100
    `;

    const orderIds = orders.map(o => o.id);
    let itemsByOrder = {};
    if (orderIds.length) {
      const { rows: items } = await sql`
        SELECT order_id, name_snapshot, unit_price_cents, quantity
        FROM order_items
        WHERE order_id = ANY(${orderIds})
      `;
      itemsByOrder = items.reduce((acc, it) => {
        (acc[it.order_id] = acc[it.order_id] || []).push({
          name: it.name_snapshot,
          unitPrice: it.unit_price_cents / 100,
          qty: it.quantity,
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
        items: itemsByOrder[o.id] || [],
      })),
    });
  } catch (err) {
    console.error('Erreur GET /api/orders:', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
