const { sql } = require('../../lib/db');
const { hashPassword } = require('../../lib/password');
const { setSessionCookie } = require('../../lib/session');

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const { email, password, name } = req.body || {};

  if (!email || !isValidEmail(email)) {
    res.status(400).json({ error: 'E-mail invalide.' });
    return;
  }
  if (!password || String(password).length < 8) {
    res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères.' });
    return;
  }

  const cleanEmail = String(email).trim().toLowerCase();

  try {
    const { rows: existing } = await sql`
      select id from users where email = ${cleanEmail} and deleted_at is null
    `;
    if (existing.length) {
      res.status(409).json({ error: 'Un compte existe déjà avec cet e-mail.' });
      return;
    }

    const { hash, salt } = hashPassword(password);
    const { rows } = await sql`
      insert into users (email, password_hash, password_salt, name, role)
      values (${cleanEmail}, ${hash}, ${salt}, ${name || ''}, 'user')
      returning id, email, name, role
    `;
    const user = rows[0];

    setSessionCookie(res, user);
    res.status(200).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
