// api/account/delete.js
// Suppression de compte RGPD. Ce qui est réellement effacé vs anonymisé :
//
//   - Compte (users) : email remplacé par une valeur anonymisée unique, nom
//     vidé, mot de passe rendu inutilisable, deleted_at renseigné, session
//     invalidée. Le compte ne peut plus être utilisé pour se connecter.
//   - Commandes NON abouties (pending/failed) : aucune obligation légale de
//     conservation → supprimées entièrement (lignes de commande incluses,
//     ON DELETE CASCADE).
//   - Commandes PAYÉES (paid/refunded) : conservées, mais détachées du
//     compte (user_id -> NULL) et l'email de contact de la commande est
//     anonymisé. Ce n'est PAS un choix arbitraire : l'article 17.3.b du
//     RGPD prévoit une exception au droit à l'effacement lorsque le
//     traitement est nécessaire au respect d'une obligation légale (en
//     France, conservation des pièces comptables ~10 ans, art. L123-22 du
//     Code de commerce). Les lignes de commande (produits/prix achetés)
//     sont des données comptables, pas des données personnelles à
//     proprement parler, et restent donc inchangées.
//
// Toute cette procédure est expliquée en clair à la personne dans la
// réponse, et dans confidentialite.html.

const { getClient } = require('../../lib/db');
const { requireUser, clearSessionCookie } = require('../../lib/session');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const user = await requireUser(req, res);
  if (!user) return;

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // 1) Commandes non abouties : suppression complète (pas d'obligation de
    //    conservation), lignes de commande supprimées via ON DELETE CASCADE.
    await client.query(
      `DELETE FROM orders WHERE user_id = $1 AND status IN ('pending', 'failed')`,
      [user.id]
    );

    // 2) Commandes payées : détachées du compte + email anonymisé, mais
    //    conservées pour l'obligation comptable légale.
    const anonymizedOrderEmail = `commande-anonyme-${user.id}@supprime.invalid`;
    await client.query(
      `UPDATE orders SET user_id = NULL, email = $2 WHERE user_id = $1`,
      [user.id, anonymizedOrderEmail]
    );

    // 3) Compte : anonymisation (pas de suppression physique de la ligne,
    //    pour ne pas casser l'historique comptable qui pointait dessus avant
    //    l'étape 2, et pour empêcher la réutilisation immédiate du même id).
    const anonymizedEmail = `compte-supprime-${user.id}-${Date.now()}@supprime.invalid`;
    await client.query(
      `UPDATE users SET email = $2, name = '', password_hash = 'DELETED', deleted_at = now() WHERE id = $1`,
      [user.id, anonymizedEmail]
    );

    await client.query('COMMIT');
    clearSessionCookie(res);

    res.status(200).json({
      ok: true,
      message: "Compte supprimé. Les commandes déjà payées sont conservées de façon anonymisée pour la durée légale de conservation des documents comptables, conformément à l'article 17.3.b du RGPD.",
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erreur suppression compte:', err.message);
    res.status(500).json({ error: 'Erreur serveur, réessaie plus tard.' });
  } finally {
    client.release();
  }
};
