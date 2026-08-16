// api/create-checkout-session.js
// Crée une commande en base (statut 'pending') PUIS la session de paiement
// Stripe, dans une transaction : soit la commande et ses lignes sont créées
// ensemble, soit rien n'est créé. Le prix vient TOUJOURS de la base
// (products.price_cents) ou du barème serveur du configurateur — jamais du
// panier envoyé par le navigateur.
//
// Anti-survente : le stock est RÉSERVÉ (décrémenté) ici, de façon atomique,
// au moment même de la création de la session — pas au webhook. Voir le
// commentaire détaillé plus bas sur la requête UPDATE ... WHERE stock >= qty.
// Si le paiement n'aboutit pas (session expirée ou paiement échoué), le
// webhook (api/webhook.js) relâche cette réservation.
//
// L'achat sans compte (invité) reste possible : si la personne est
// connectée (cookie de session), la commande est rattachée à son user_id ;
// sinon user_id reste NULL et seul l'e-mail Stripe (collecté par Stripe
// lui-même) permet de la retrouver.

const Stripe = require('stripe');
const { getClient } = require('../lib/db');
const { getSessionUser } = require('../lib/session');

const MAX_QTY_PER_ITEM = 20;

// ---- Tarifs du configurateur "Commande perso" (commande_perso.html) ----
const CUSTOM_BASE_PRICE = { string: 24.9, culotte: 29.9, boxer: 32.9, bresilienne: 27.9, 'taille-haute': 31.9 };
const CUSTOM_SHAPE_NAMES = { string: 'String', culotte: 'Culotte classique', boxer: 'Boxer', bresilienne: 'Brésilienne', 'taille-haute': 'Taille haute' };
const CUSTOM_MOTIF_PRICE = 3;
const CUSTOM_DECOR_PRICES = { fleur: 4, noeud: 3, etoile: 3, coeur: 3, initiales: 6, dentelle: 5, papillon: 4, lune: 3 };
const CUSTOM_EXTRA_PRICES = { piercing: 5, sequins: 4, rubans: 3, clous: 5 };
const CUSTOM_SPECIAL_REQUEST_PRICE = 8;
const CUSTOM_MAX_ITEMS = 20;

function computeCustomOrderCents(customOrder) {
  const shapeId = customOrder && customOrder.shapeId;
  const basePrice = CUSTOM_BASE_PRICE[shapeId];
  if (!basePrice) return { error: 'Forme de vêtement invalide.' };

  let total = basePrice;
  const parts = [CUSTOM_SHAPE_NAMES[shapeId]];

  if (customOrder.motifId) { total += CUSTOM_MOTIF_PRICE; parts.push('motif'); }

  const decorIds = Array.isArray(customOrder.decorIds) ? customOrder.decorIds.slice(0, CUSTOM_MAX_ITEMS) : [];
  for (const id of decorIds) {
    const price = CUSTOM_DECOR_PRICES[id];
    if (price === undefined) return { error: `Décoration inconnue (${id}).` };
    total += price;
  }
  if (decorIds.length) parts.push(`${decorIds.length} décor(s)`);

  const extraIds = Array.isArray(customOrder.extraIds) ? customOrder.extraIds.slice(0, CUSTOM_MAX_ITEMS) : [];
  for (const id of extraIds) {
    const price = CUSTOM_EXTRA_PRICES[id];
    if (price === undefined) return { error: `Option inconnue (${id}).` };
    total += price;
  }
  if (extraIds.length) parts.push(`${extraIds.length} option(s)`);

  if (customOrder.specialRequest && String(customOrder.specialRequest).trim()) {
    total += CUSTOM_SPECIAL_REQUEST_PRICE;
    parts.push('demande spéciale');
  }

  return {
    name: `Création sur mesure — ${parts.join(', ')} (taille ${customOrder.size || '-'})`,
    unitAmountCents: Math.round(total * 100),
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  const { STRIPE_SECRET_KEY } = process.env;
  if (!STRIPE_SECRET_KEY) {
    console.error('STRIPE_SECRET_KEY manquante côté serveur.');
    res.status(500).json({ error: 'Paiement indisponible pour le moment.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  // Utilisateur connecté (optionnel — achat invité autorisé).
  const sessionUser = await getSessionUser(req);

  const client = await getClient();
  let orderId;
  let line_items = [];
  let totalCents = 0;
  let kind = 'cart';
  let customOrderConfig = null;

  try {
    await client.query('BEGIN');

    if (body && body.customOrder) {
      kind = 'custom';
      const result = computeCustomOrderCents(body.customOrder);
      if (result.error) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: result.error });
        return;
      }
      totalCents = result.unitAmountCents;
      customOrderConfig = body.customOrder;
      line_items = [{
        price_data: { currency: 'eur', product_data: { name: result.name }, unit_amount: result.unitAmountCents },
        quantity: 1,
      }];

      const orderInsert = await client.query(
        `INSERT INTO orders (user_id, email, status, kind, total_cents, custom_order_config)
         VALUES ($1, $2, 'pending', 'custom', $3, $4)
         RETURNING id`,
        [sessionUser ? sessionUser.id : null, sessionUser ? sessionUser.email : null, totalCents, JSON.stringify(customOrderConfig)]
      );
      orderId = orderInsert.rows[0].id;

      await client.query(
        `INSERT INTO order_items (order_id, product_id, name_snapshot, unit_price_cents, quantity)
         VALUES ($1, NULL, $2, $3, 1)`,
        [orderId, result.name, result.unitAmountCents]
      );
    } else {
      // ---- Panier boutique classique ----
      const cart = (body && body.cart) || {};
      const entries = Object.entries(cart).filter(([, qty]) => Number(qty) > 0);
      if (!entries.length) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: 'Panier vide.' });
        return;
      }

      const orderInsert = await client.query(
        `INSERT INTO orders (user_id, email, status, kind, total_cents)
         VALUES ($1, $2, 'pending', 'cart', 0)
         RETURNING id`,
        [sessionUser ? sessionUser.id : null, sessionUser ? sessionUser.email : null]
      );
      orderId = orderInsert.rows[0].id;

      for (const [idStr, qtyRaw] of entries) {
        const id = Number(idStr);
        const qty = Math.floor(Number(qtyRaw));
        if (!Number.isInteger(id) || !Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY_PER_ITEM) {
          await client.query('ROLLBACK');
          res.status(400).json({ error: 'Quantité invalide.' });
          return;
        }

        // ---- Réservation atomique du stock (corrige la survente) ----
        // Le stock est décrémenté ICI, au moment de la création de la
        // session de paiement — pas au webhook. C'est un UPDATE conditionnel
        // unique (vérifier ET décrémenter en une seule instruction) : sous
        // PostgreSQL, deux requêtes concurrentes sur la même ligne
        // "products" se sérialisent automatiquement (verrou de ligne
        // implicite pendant la durée de l'UPDATE). Si deux acheteur·ses
        // visent le même dernier exemplaire en même temps, l'un des deux
        // UPDATE s'exécute en premier et fait passer stock à 0 ; le second,
        // dont la clause WHERE stock >= qty n'est alors plus satisfaite, ne
        // met à jour aucune ligne (RETURNING vide) et est rejeté avant même
        // qu'une session Stripe ne soit créée pour lui. Il ne peut donc pas
        // y avoir deux réservations simultanées pour la même unité.
        const reserveRes = await client.query(
          `UPDATE products SET stock = stock - $1, updated_at = now()
           WHERE id = $2 AND active = true AND stock >= $1
           RETURNING id, name, price_cents, stock`,
          [qty, id]
        );
        const product = reserveRes.rows[0];

        if (!product) {
          // Soit le produit n'existe pas/est désactivé, soit le stock est
          // insuffisant (autre acheteur·se plus rapide) : on annule tout —
          // rien n'a encore été débité, aucune session Stripe n'existe.
          await client.query('ROLLBACK');
          res.status(400).json({ error: `Stock insuffisant ou produit indisponible (id ${idStr}).` });
          return;
        }

        totalCents += product.price_cents * qty;
        line_items.push({
          price_data: { currency: 'eur', product_data: { name: product.name }, unit_amount: product.price_cents },
          quantity: qty,
        });

        await client.query(
          `INSERT INTO order_items (order_id, product_id, name_snapshot, unit_price_cents, quantity)
           VALUES ($1, $2, $3, $4, $5)`,
          [orderId, product.id, product.name, product.price_cents, qty]
        );
      }

      // Le stock de tous les articles du panier vient d'être réservé
      // (décrémenté) ci-dessus, dans la même transaction que la commande.
      await client.query(`UPDATE orders SET total_cents = $1, stock_decremented = true WHERE id = $2`, [totalCents, orderId]);
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const stripeSession = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/${kind === 'custom' ? 'commande_perso.html' : 'boutique.html'}`,
      shipping_address_collection: { allowed_countries: ['FR', 'BE', 'CH', 'LU', 'MC'] },
      customer_email: sessionUser ? sessionUser.email : undefined,
      metadata: { order_id: String(orderId) },
      // Réservation limitée dans le temps : si la personne ne paie pas dans
      // ce délai, le webhook `checkout.session.expired` relâche le stock
      // réservé (voir api/webhook.js) pour qu'il redevienne disponible pour
      // d'autres client·es plutôt que de rester bloqué jusqu'à 24h (valeur
      // par défaut de Stripe).
      expires_at: Math.floor(Date.now() / 1000) + 30 * 60, // 30 minutes
    });

    await client.query(`UPDATE orders SET stripe_session_id = $1 WHERE id = $2`, [stripeSession.id, orderId]);
    await client.query('COMMIT');

    res.status(200).json({ url: stripeSession.url });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erreur create-checkout-session:', err.message);
    res.status(500).json({ error: 'Erreur lors de la création du paiement.' });
  } finally {
    client.release();
  }
};
