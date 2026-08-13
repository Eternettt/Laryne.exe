// api/verify-session.js
// Revérifie côté serveur qu'un jeton de session admin est valide (signature
// correcte + non expiré). Utilisé par admin.html et boutique.html au
// chargement, pour ne jamais faire confiance à sessionStorage seul.

const { verifySessionToken } = require('./_auth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const { SESSION_SECRET } = process.env;
  if (!SESSION_SECRET) {
    res.status(500).json({ admin: false });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  const token = (body && body.token) || '';
  const payload = verifySessionToken(token, SESSION_SECRET);

  res.status(200).json({ admin: !!(payload && payload.admin === true) });
};
