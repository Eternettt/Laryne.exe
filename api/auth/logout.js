// api/auth/logout.js
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }
  const { clearSessionCookie } = require('../../lib/session');
  clearSessionCookie(res);
  res.status(200).json({ ok: true });
};
