// api/login.js
// Vérifie les identifiants admin CÔTÉ SERVEUR — le mot de passe en clair
// n'est jamais comparé ni stocké dans le code envoyé au navigateur.
//
// Variables d'environnement Vercel à définir (Project Settings > Environment
// Variables) :
//   ADMIN_EMAIL          -> l'email admin, ex: titinoudupre@gmail.com
//   ADMIN_PASSWORD_HASH  -> généré avec `node scripts/hash-password.js`
//   ADMIN_NAME           -> (optionnel) pseudo affiché, ex: eternett
//   SESSION_SECRET       -> une longue chaîne aléatoire secrète (ex: 64
//                           caractères), différente du mot de passe
//
// Ne mets JAMAIS ces valeurs directement dans le code : uniquement dans les
// variables d'environnement Vercel.

const { signSessionToken, verifyPassword } = require('./_auth');

// Anti brute-force très simple (mémoire du process — suffisant pour limiter
// les essais automatisés basiques ; pas un vrai rate-limit distribué).
const attempts = new Map();
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function isRateLimited(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.first > WINDOW_MS) {
    attempts.set(ip, { count: 1, first: now });
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
  if (isRateLimited(ip)) {
    res.status(429).json({ error: 'Trop de tentatives, réessaie plus tard.' });
    return;
  }

  const { ADMIN_EMAIL, ADMIN_PASSWORD_HASH, ADMIN_NAME, SESSION_SECRET } = process.env;

  if (!ADMIN_EMAIL || !ADMIN_PASSWORD_HASH || !SESSION_SECRET) {
    // Configuration manquante côté serveur : on ne donne aucun détail à
    // l'appelant (pas de fuite d'info interne), juste un message générique.
    console.error('Variables d\'environnement admin manquantes (ADMIN_EMAIL / ADMIN_PASSWORD_HASH / SESSION_SECRET).');
    res.status(500).json({ error: "Connexion admin indisponible pour l'instant." });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const email = String((body && body.email) || '').trim().toLowerCase();
  const password = String((body && body.password) || '');

  if (!email || !password) {
    res.status(400).json({ error: 'Email et mot de passe requis.' });
    return;
  }

  const emailOk = email === ADMIN_EMAIL.toLowerCase();
  const passwordOk = verifyPassword(password, ADMIN_PASSWORD_HASH);

  if (!emailOk || !passwordOk) {
    res.status(401).json({ error: 'Identifiants incorrects.' });
    return;
  }

  const token = signSessionToken(
    { admin: true, exp: Date.now() + 12 * 60 * 60 * 1000 }, // 12h
    SESSION_SECRET
  );

  res.status(200).json({ token, name: ADMIN_NAME || 'Administrateur' });
};
