// api/auth/login.js
// Vérifie les identifiants (utilisateur·rice classique OU admin — le rôle
// vient uniquement de la colonne `role` en base) et pose un cookie de
// session httpOnly. Remplace l'ancien /api/login.js dédié uniquement à
// l'admin : il n'y a plus qu'un seul mécanisme de connexion, avec permissions
// vérifiées côté serveur à chaque requête protégée (voir lib/session.js).

const { sql } = require('../../lib/db');
const { verifyPassword } = require('../../lib/crypto');
const { setSessionCookie } = require('../../lib/session');

// Anti brute-force très simple (mémoire du process — suffisant pour limiter
// les essais automatisés basiques, pas un vrai rate-limit distribué).
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;

function isRateLimited(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.first > WINDOW_MS) {
    attempts.set(key, { count: 1, first: now });
    return false;
  }
  entry.count++;
  return entry.count > MAX_ATTEMPTS;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const email = String((body && body.email) || '').trim().toLowerCase();
  const password = String((body && body.password) || '');

  // Rate-limit par IP ET par email ciblé (empêche à la fois le bourrinage
  // depuis une seule IP et le ciblage d'un compte précis depuis plusieurs IP).
  if (isRateLimited(`ip:${ip}`) || (email && isRateLimited(`email:${email}`))) {
    res.status(429).json({ error: 'Trop de tentatives, réessaie dans quelques minutes.' });
    return;
  }

  if (!email || !password) {
    res.status(400).json({ error: 'Email et mot de passe requis.' });
    return;
  }

  try {
    const { rows } = await sql`
      SELECT id, email, name, role, password_hash FROM users
      WHERE email = ${email} AND deleted_at IS NULL
      LIMIT 1
    `;
    const user = rows[0];

    // Message d'erreur volontairement identique que l'email existe ou non,
    // pour ne pas laisser deviner quels emails ont un compte (énumération).
    if (!user || !verifyPassword(password, user.password_hash)) {
      res.status(401).json({ error: 'Identifiants incorrects.' });
      return;
    }

    setSessionCookie(res, user.id);
    res.status(200).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error('Erreur login:', err.message);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  }
};
