// lib/crypto.js
// Primitives cryptographiques partagées : hash de mot de passe (scrypt) et
// jetons signés (HMAC-SHA256). Ne tourne que côté serveur.

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

// ---- Mot de passe ----
// Format stocké en base : "salt:hash" (hex). Jamais de mot de passe en clair.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  if (!password || !storedHash || !storedHash.includes(':')) return false;
  const [salt, hashHex] = storedHash.split(':');
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const stored = Buffer.from(hashHex, 'hex');
  if (candidate.length !== stored.length) return false;
  return crypto.timingSafeEqual(candidate, stored);
}

// ---- Jeton de session signé ----
function signToken(payload, secret) {
  if (!secret) throw new Error('Secret manquant côté serveur.');
  const payloadB64 = base64url(JSON.stringify(payload));
  const signature = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  return `${payloadB64}.${signature}`;
}

function verifyToken(token, secret) {
  if (!token || typeof token !== 'string' || !token.includes('.') || !secret) return null;
  const [payloadB64, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  const sigBuf = Buffer.from(signature || '', 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(fromBase64url(payloadB64));
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken };
