const { sql } = require('../../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const sessionId = req.query ? req.query.session_id : null;
  if (!sessionId) {
    res.status(400).json({ error: 'session_id manquant.' });
    return;
  }

  try {
    const { rows } = await sql`
      select status, items, total_cents, linked_to_account
      from orders
      where stripe_session_id = ${sessionId}
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
