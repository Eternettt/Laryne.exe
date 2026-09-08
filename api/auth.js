/* ==========================================================================
   api/auth.js — Regroupe TOUT ce qui touche au compte utilisateur dans une
   seule fonction serverless (signup / login / logout / me / suppression de
   compte), pour rester très en dessous de la limite de 12 fonctions du plan
   Hobby de Vercel.

   Appelé via /api/auth?action=signup|login|logout|me|delete-account
   Les anciennes URLs du front (/api/auth/signup, /api/account/delete...)
   continuent de fonctionner à l'identique grâce aux rewrites dans
   vercel.json — aucun changement à faire dans shared-data.js.
   ========================================================================== */

const crypto = require('crypto');
const { sql } = require('../lib/db');
const { hashPassword, verifyPassword } = require('../lib/password');
const { getSession, setSessionCookie, clearSessionCookie } = require('../lib/session');

function isValidEmail(v) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

async function handleSignup(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });
  const { email, password, name } = req.body || {};

  if (!email || !isValidEmail(email)) return res.status(400).json({ error: 'E-mail invalide.' });
  if (!password || String(password).length < 8) {
    return res.status(400).json({ error: 'Le mot de passe doit faire au moins 8 caractères.' });
  }

  const cleanEmail = String(email).trim().toLowerCase();

  const { rows: existing } = await sql`
    select id from users where email = ${cleanEmail} and deleted_at is null
  `;
  if (existing.length) return res.status(409).json({ error: 'Un compte existe déjà avec cet e-mail.' });

  const { hash, salt } = hashPassword(password);
  const { rows } = await sql`
    insert into users (email, password_hash, password_salt, name, role)
    values (${cleanEmail}, ${hash}, ${salt}, ${name || ''}, 'user')
    returning id, email, name, role
  `;
  const user = rows[0];
  setSessionCookie(res, user);
  res.status(200).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}

async function handleLogin(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(401).json({ error: 'Identifiants incorrects.' });

  const cleanEmail = String(email).trim().toLowerCase();
  const { rows } = await sql`
    select id, email, name, role, password_hash, password_salt, deleted_at
    from users where email = ${cleanEmail}
  `;
  const user = rows[0];

  if (!user || user.deleted_at || !verifyPassword(password, user.password_hash, user.password_salt)) {
    return res.status(401).json({ error: 'Identifiants incorrects.' });
  }

  setSessionCookie(res, user);
  res.status(200).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}

async function handleLogout(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
}

async function handleMe(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Méthode non autorisée.' });
  const session = getSession(req);
  if (!session) return res.status(200).json({ user: null });

  const { rows } = await sql`
    select id, email, name, role, deleted_at from users where id = ${session.uid}
  `;
  const user = rows[0];
  if (!user || user.deleted_at) return res.status(200).json({ user: null });
  res.status(200).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}

async function handleDeleteAccount(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Méthode non autorisée.' });
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: 'Non connecté.' });

  const anonEmail = `deleted-${session.uid}-${crypto.randomBytes(4).toString('hex')}@deleted.local`;
  await sql`
    update users
    set email = ${anonEmail}, name = '', password_hash = '', password_salt = '', deleted_at = now()
    where id = ${session.uid}
  `;
  clearSessionCookie(res);
  res.status(200).json({ ok: true, message: 'Compte supprimé.' });
}

module.exports = async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const action = url.searchParams.get('action');

  try {
    switch (action) {
      case 'signup':
        return await handleSignup(req, res);
      case 'login':
        return await handleLogin(req, res);
      case 'logout':
        return await handleLogout(req, res);
      case 'me':
        return await handleMe(req, res);
      case 'delete-account':
        return await handleDeleteAccount(req, res);
      default:
        res.status(404).json({ error: 'Action inconnue.' });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
