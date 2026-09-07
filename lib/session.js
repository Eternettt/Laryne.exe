/* ==========================================================================
   lib/session.js — Sessions via cookie httpOnly signé (HMAC-SHA256)
   ==========================================================================
   Pas de JWT ni de dépendance externe : un jeton = payload base64url +
   signature base64url, vérifiée en temps constant. Le rôle admin/user
   n'est JAMAIS lu depuis ce cookie seul dans les routes sensibles : chaque
   route qui en a besoin revérifie le rôle en base (voir les fichiers
   api/admin/*.js) pour empêcher un cookie modifié de mentir sur le rôle.
   ========================================================================== */

const crypto = require('crypto');

const COOKIE_NAME = 'stringz_session';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 jours

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error('SESSION_SECRET manquant dans les variables d\'environnement Vercel.');
  }
  return secret;
}

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(input) {
  let str = input.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64').toString('utf8');
}

function sign(encodedPayload) {
  return base64url(crypto.createHmac('sha256', getSecret()).update(encodedPayload).digest());
}

function createToken(payload) {
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [encodedPayload, signature] = token.split('.');
  if (!encodedPayload || !signature) return null;

  const expected = sign(encodedPayload);
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;

  try {
    const payload = JSON.parse(base64urlDecode(encodedPayload));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

function parseCookies(req) {
  if (req.cookies) return req.cookies; // déjà fourni par le runtime Node de Vercel
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const k = part.slice(0, idx).trim();
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    out[k] = v;
  });
  return out;
}

// ---- Renvoie { uid, role, exp } ou null si absent/invalide/expiré ----
function getSession(req) {
  const cookies = parseCookies(req);
  return verifyToken(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, user) {
  const payload = { uid: user.id, role: user.role, exp: Date.now() + MAX_AGE_SECONDS * 1000 };
  const token = createToken(payload);
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_SECONDS}`
  );
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}

module.exports = { getSession, setSessionCookie, clearSessionCookie, COOKIE_NAME };
