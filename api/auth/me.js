const { sql } = require('../../lib/db');
const { getSession } = require('../../lib/session');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const session = getSession(req);
  if (!session) {
    res.status(200).json({ user: null });
    return;
  }

  try {
    // On revérifie toujours en base (rôle, existence, suppression) plutôt
    // que de faire confiance au seul contenu du cookie.
    const { rows } = await sql`
      select id, email, name, role, deleted_at from users where id = ${session.uid}
    `;
    const user = rows[0];
    if (!user || user.deleted_at) {
      res.status(200).json({ user: null });
      return;
    }
    res.status(200).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(200).json({ user: null });
  }
};
