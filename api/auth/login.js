const { sql } = require('../../lib/db');
const { verifyPassword } = require('../../lib/password');
const { setSessionCookie } = require('../../lib/session');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const { email, password } = req.body || {};
  if (!email || !password) {
    res.status(400).json({ error: 'Identifiants incorrects.' });
    return;
  }

  const cleanEmail = String(email).trim().toLowerCase();

  try {
    const { rows } = await sql`
      select id, email, name, role, password_hash, password_salt, deleted_at
      from users where email = ${cleanEmail}
    `;
    const user = rows[0];

    // Message volontairement identique dans tous les cas d'échec, pour ne
    // pas révéler si un e-mail existe en base.
    if (!user || user.deleted_at || !verifyPassword(password, user.password_hash, user.password_salt)) {
      res.status(401).json({ error: 'Identifiants incorrects.' });
      return;
    }

    setSessionCookie(res, user);
    res.status(200).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
