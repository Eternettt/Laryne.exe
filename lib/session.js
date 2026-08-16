// lib/session.js
// Sessions par cookie httpOnly signé — remplace l'ancien système où le
// statut admin vivait dans sessionStorage (lisible/modifiable en JS côté
// navigateur). Un cookie httpOnly n'est jamais accessible depuis le
// JavaScript de la page : impossible à falsifier depuis les DevTools.
//
// Protection CSRF : le cookie est posé en SameSite=Lax, donc le navigateur
// ne l'envoie PAS avec une requête POST/PUT/DELETE déclenchée depuis un
// autre site (ex. un <form> malveillant sur un site tiers) — seulement
// avec une navigation GET de premier niveau. Toutes les routes qui modifient
// des données (login excepté, qui ne fait que créer la session) exigent en
// plus POST/PUT/DELETE explicitement (jamais GET), ce qui élimine aussi les
// attaques CSRF "image src" classiques.

const { sql } = require('./db');
const { signToken, verifyToken } = require('./crypto');
const { parseCookies, serializeCookie } = require('./cookies');

const COOKIE_NAME = 'stringz_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 jours

function setSessionCookie(res, userId) {
  const secret = process.env.SESSION_SECRET;
  const token = signToken({ uid: userId, exp: Date.now() + SESSION_DURATION_MS }, secret);
  const cookie = serializeCookie(COOKIE_NAME, token, {
    maxAge: SESSION_DURATION_MS / 1000,
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV !== 'development',
  });
  res.setHeader('Set-Cookie', cookie);
}

function clearSessionCookie(res) {
  const cookie = serializeCookie(COOKIE_NAME, '', {
    maxAge: 0,
    httpOnly: true,
    sameSite: 'Lax',
    secure: process.env.NODE_ENV !== 'development',
  });
  res.setHeader('Set-Cookie', cookie);
}

// Lit le cookie, vérifie la signature/expiration, PUIS revérifie en base que
// l'utilisateur existe toujours et n'a pas été supprimé (révocation
// immédiate possible : suppression de compte, bannissement, etc.) — on ne
// fait jamais confiance au contenu du jeton seul pour l'identité/le rôle.
async function getSessionUser(req) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];
  if (!token) return null;

  const payload = verifyToken(token, process.env.SESSION_SECRET);
  if (!payload || !payload.uid) return null;

  try {
    const { rows } = await sql`
      SELECT id, email, name, role FROM users
      WHERE id = ${payload.uid} AND deleted_at IS NULL
      LIMIT 1
    `;
    return rows[0] || null;
  } catch (e) {
    console.error('Erreur DB dans getSessionUser:', e.message);
    return null;
  }
}

// ---- Garde-fous à utiliser en tête de chaque route protégée ----
// Retournent l'utilisateur si autorisé, ou envoient eux-mêmes la réponse
// d'erreur (401/403) et retournent null — l'appelant doit alors `return`.
async function requireUser(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'Non connecté·e.' });
    return null;
  }
  return user;
}

async function requireAdmin(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: 'Non connecté·e.' });
    return null;
  }
  if (user.role !== 'admin') {
    res.status(403).json({ error: 'Accès réservé aux administrateur·rices.' });
    return null;
  }
  return user;
}

module.exports = { setSessionCookie, clearSessionCookie, getSessionUser, requireUser, requireAdmin, COOKIE_NAME };
