const { sql } = require('../../lib/db');
const { getSession } = require('../../lib/session');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const session = getSession(req);
  if (!session) {
    res.status(200).json({ orders: [] });
    return;
  }

  try {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
