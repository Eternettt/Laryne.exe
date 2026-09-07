const crypto = require('crypto');
const { sql } = require('../../lib/db');
const { getSession, clearSessionCookie } = require('../../lib/session');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Non connecté.' });
    return;
  }

  try {
    // Anonymisation plutôt que suppression physique : garde l'historique des
    // commandes cohérent (obligations comptables), rend le compte inutilisable.
    const anonEmail = `deleted-${session.uid}-${crypto.randomBytes(4).toString('hex')}@deleted.local`;
    await sql`
      update users
      set email = ${anonEmail}, name = '', password_hash = '', password_salt = '', deleted_at = now()
      where id = ${session.uid}
    `;
    clearSessionCookie(res);
    res.status(200).json({ ok: true, message: 'Compte supprimé.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
