const { sql } = require('../../lib/db');
const { getSession } = require('../../lib/session');

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

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const admin = await requireAdmin(req, res);
  if (!admin) return;

  try {
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
