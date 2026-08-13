// api/_auth.js
// Petites fonctions partagées entre les fonctions serverless pour
// l'authentification admin. Rien ici n'est exposé au navigateur : ce
// fichier ne tourne que côté serveur (Vercel), jamais côté client.
//
// Pourquoi pas une librairie externe (jsonwebtoken, bcrypt) ? Pour rester
// avec le minimum de dépendances (voir package.json) tout en utilisant
// uniquement des primitives cryptographiques standards du module Node
// "crypto" (déjà présent, pas de compilation native à gérer sur Vercel).

const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(input) {
  input = input.replace(/-/g, '+').replace(/_/g, '/');
  while (input.length % 4) input += '=';
  return Buffer.from(input, 'base64').toString('utf8');
}

// ---- Jeton de session signé (HMAC-SHA256), sans dépendance externe ----
// Format : base64url(payloadJSON) + "." + base64url(signature)
function signSessionToken(payload, secret) {
  if (!secret) throw new Error('SESSION_SECRET manquant côté serveur.');
  const payloadStr = JSON.stringify(payload);
  const payloadB64 = base64url(payloadStr);
  const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  return `${payloadB64}.${signature}`;
}

function verifySessionToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  if (!secret) return null;
  const [payloadB64, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  const sigBuf = Buffer.from(signature || '', 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(fromBase64url(payloadB64));
    if (!payload.exp || Date.now() > payload.exp) return null; // expiré
    return payload;
  } catch (e) {
    return null;
  }
}

// ---- Vérification du mot de passe admin ----
// ADMIN_PASSWORD_HASH doit être au format "salt:hash" (hex), généré avec
// scripts/hash-password.js (scrypt). Le mot de passe en clair n'est JAMAIS
// stocké, ni côté serveur ni côté client.
function verifyPassword(password, storedHash) {
  if (!password || !storedHash || !storedHash.includes(':')) return false;
  const [salt, hashHex] = storedHash.split(':');
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const stored = Buffer.from(hashHex, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

module.exports = { signSessionToken, verifySessionToken, verifyPassword };
