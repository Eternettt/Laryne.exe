// api/auth/me.js
// Retourne l'utilisateur·rice actuellement connecté·e (lu depuis le cookie de
// session httpOnly, revérifié en base — voir lib/session.js). Ne renvoie
// jamais le hash de mot de passe.

const { getSessionUser } = require('../../lib/session');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }
  const user = await getSessionUser(req);
  res.status(200).json({ user: user || null });
};
