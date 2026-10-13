/* ==========================================================================
   api/mail-club.js — Mail Club : tarifs publics + gestion admin des envois
   (une seule fonction serverless, pour rester sous la limite du plan Hobby).

   - GET  /api/mail-club?mode=prices                  → public : durées + tarifs
                                                        (null = tarif pas encore défini)
   - GET  /api/mail-club?mode=admin&filter=...        → ADMIN : abonnements + envois
        filter = all | active | due | completed | refunded
   - POST /api/mail-club?mode=admin
        { action: 'mark-sent',   shipmentId }         → ADMIN : marque l'envoi comme envoyé
        { action: 'unmark-sent', shipmentId }         → ADMIN : corrige une erreur
   Même authentification admin que /api/orders (cookie signé + rôle relu en base).
   ========================================================================== */

const { sql } = require('../lib/db');
const { getSession } = require('../lib/session');
const { getPublicPrices } = require('../lib/mail-club');
const { listSubscriptions, markShipmentSent, unmarkShipmentSent } = require('../lib/mail-club-db');

const FILTERS = ['all', 'active', 'due', 'completed', 'refunded'];

async function requireAdmin(req, res) {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Non connecté.' });
    return null;
  }
  const { rows } = await sql`select id, role, deleted_at from users where id = ${session.uid}`;
  const user = rows[0];
  if (!user || user.deleted_at || user.role !== 'admin') {
    res.status(403).json({ error: 'Accès refusé.' });
    return null;
  }
  return user;
}

module.exports = async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const mode = url.searchParams.get('mode');

  try {
    // ---- Public : tarifs (aucune donnée sensible) ----
    if (req.method === 'GET' && mode === 'prices') {
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).json({ durations: getPublicPrices() });
      return;
    }

    if (mode !== 'admin') {
      res.status(404).json({ error: 'Route inconnue.' });
      return;
    }

    // ---- Tout ce qui suit : ADMIN uniquement ----
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    res.setHeader('Cache-Control', 'no-store');

    if (req.method === 'GET') {
      const raw = url.searchParams.get('filter') || 'all';
      const filter = FILTERS.includes(raw) ? raw : 'all';
      const data = await listSubscriptions(filter);
      res.status(200).json(data);
      return;
    }

    if (req.method === 'POST') {
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const { action } = body;
      const shipmentId = typeof body.shipmentId === 'string' || typeof body.shipmentId === 'number'
        ? String(body.shipmentId)
        : '';
      // Identifiant d'envoi : entier positif strict (bigint), jamais du texte libre.
      if (!/^[1-9]\d{0,17}$/.test(shipmentId)) {
        res.status(400).json({ error: "Identifiant d'envoi invalide." });
        return;
      }

      let result;
      if (action === 'mark-sent') result = await markShipmentSent(shipmentId, admin.id);
      else if (action === 'unmark-sent') result = await unmarkShipmentSent(shipmentId, admin.id);
      else {
        res.status(400).json({ error: 'Action inconnue.' });
        return;
      }

      if (!result.ok) {
        res.status(result.status || 409).json({ error: result.error || 'Modification refusée.' });
        return;
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Méthode non autorisée.' });
  } catch (err) {
    console.error('[mail-club] erreur :', err);
    // 42P01 = table inexistante : la migration SQL n'a pas encore été exécutée.
    if (err && err.code === '42P01') {
      res.status(503).json({ error: "Mail Club pas encore initialisé en base (migration-mail-club.sql à exécuter)." });
      return;
    }
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
