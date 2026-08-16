// api/orders/by-session.js
// Utilisé par success.html pour afficher le récapitulatif après retour de
// Stripe. Volontairement accessible sans connexion (achat invité possible) :
// l'identifiant de session Stripe (`session_id`, ex. `cs_test_...`) sert
// lui-même de preuve d'accès — il est long, aléatoire, généré par Stripe, et
// seul le navigateur qui vient de payer (ou quelqu'un ayant intercepté
// l'URL) peut le connaître. On ne renvoie que le strict nécessaire à
// l'affichage (jamais l'email complet si la commande appartient à un
// compte différent de la personne éventuellement connectée, pour limiter la
// fuite d'info en cas d'URL partagée par erreur).

const { sql } = require('../../lib/db');
const { getSessionUser } = require('../../lib/session');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const sessionId = String(req.query?.session_id || '');
  if (!sessionId) {
    res.status(400).json({ error: 'session_id requis.' });
    return;
  }

  try {
    const { rows } = await sql`
      SELECT id, user_id, status, kind, total_cents, created_at
      FROM orders
      WHERE stripe_session_id = ${sessionId}
      LIMIT 1
    `;
    const order = rows[0];
    if (!order) {
      res.status(404).json({ error: 'Commande introuvable.' });
      return;
    }

    const { rows: items } = await sql`
      SELECT name_snapshot, unit_price_cents, quantity
      FROM order_items WHERE order_id = ${order.id}
    `;

    // Si un compte est associé, on ne confirme le lien qu'à la personne
    // connectée sur ce compte (pour l'affichage "connecte-toi pour
    // retrouver cette commande" vs déjà rattachée).
    const currentUser = await getSessionUser(req);
    const linkedToCurrentUser = !!(order.user_id && currentUser && currentUser.id === order.user_id);

    res.status(200).json({
      order: {
        status: order.status,
        kind: order.kind,
        total: order.total_cents / 100,
        date: order.created_at,
        items: items.map(it => ({ name: it.name_snapshot, unitPrice: it.unit_price_cents / 100, qty: it.quantity })),
        linkedToAccount: !!order.user_id,
        linkedToCurrentUser,
      },
    });
  } catch (err) {
    console.error('Erreur GET /api/orders/by-session:', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
