// api/auth/signup.js
// Crée un compte "utilisateur·rice" classique (jamais admin — le rôle admin
// ne peut être posé que directement en base, voir scripts/create-admin.js).

const { sql } = require('../../lib/db');
const { hashPassword } = require('../../lib/crypto');
const { setSessionCookie } = require('../../lib/session');

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const email = String((body && body.email) || '').trim().toLowerCase();
  const password = String((body && body.password) || '');
  const name = String((body && body.name) || '').trim().slice(0, 80);

  if (!isValidEmail(email)) {
    res.status(400).json({ error: 'Adresse e-mail invalide.' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Le mot de passe doit contenir au moins 6 caractères.' });
    return;
  }
  if (!name) {
    res.status(400).json({ error: 'Merci d\'indiquer un pseudo.' });
    return;
  }

  try {
    const existing = await sql`SELECT id FROM users WHERE email = ${email} AND deleted_at IS NULL LIMIT 1`;
    if (existing.rows.length) {
      res.status(409).json({ error: 'Un compte existe déjà avec cet e-mail.' });
      return;
    }

    const passwordHash = hashPassword(password);
    const { rows } = await sql`
      INSERT INTO users (email, password_hash, name, role)
      VALUES (${email}, ${passwordHash}, ${name}, 'user')
      RETURNING id, email, name, role
    `;
    const user = rows[0];

    setSessionCookie(res, user.id);
    res.status(201).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error('Erreur signup:', err.message);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
};
