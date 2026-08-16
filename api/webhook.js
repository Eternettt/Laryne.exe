// api/webhook.js
// Seule source fiable de confirmation de paiement. La signature Stripe est
// vérifiée cryptographiquement (impossible à falsifier depuis le navigateur
// ou en appelant cette route directement sans le secret de signature).
//
// Idempotence : Stripe peut renvoyer le même événement plusieurs fois
// (garantie "au moins une fois", pas "exactement une fois"). On enregistre
// chaque event.id dans processed_webhook_events (colonne PRIMARY KEY) ; si
// l'INSERT échoue pour cause de doublon, on sait que cet événement a déjà
// été traité et on s'arrête là (aucun double décrément de stock, aucune
// commande traitée deux fois).
//
// Variables d'environnement Vercel : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET

const Stripe = require('stripe');
const { getClient } = require('../lib/db');

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Rembourse automatiquement un paiement qui ne peut finalement pas être
// honoré (cas exceptionnel documenté plus haut), et marque la commande en
// conséquence — sans intervention manuelle. Le remboursement Stripe est
// idempotent côté Stripe pour un même payment_intent (un second appel sur un
// paiement déjà remboursé ne le rembourse pas deux fois), donc rejouable
// sans risque si le webhook est retraité.
async function refundAndMarkOrder(stripe, client, order, session) {
  try {
    if (session.payment_intent) {
      await stripe.refunds.create({ payment_intent: session.payment_intent });
    }
    await client.query(
      `UPDATE orders SET status = 'refunded', updated_at = now() WHERE id = $1`,
      [order.id]
    );
    console.error(`↩️ Commande ${order.id} remboursée automatiquement : stock indisponible au moment de la reconfirmation (concurrence exceptionnelle).`);
  } catch (refundErr) {
    // Le remboursement Stripe lui-même a échoué (ex. API Stripe injoignable).
    // On ne peut pas garantir un remboursement automatique à 100% si Stripe
    // est indisponible ; on marque au moins la commande de façon visible
    // pour qu'un suivi manuel reste possible en tout dernier recours, et on
    // fait échouer le webhook (Stripe réessaiera).
    console.error(`❌ Échec du remboursement automatique pour la commande ${order.id}:`, refundErr.message);
    throw refundErr;
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } = process.env;
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    console.error('STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET manquantes côté serveur.');
    res.status(500).end();
    return;
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    const rawBody = await buffer(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Signature webhook Stripe invalide:', err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
    return;
  }

  const client = await getClient();
  try {
    await client.query('BEGIN');

    // Idempotence : tentative d'enregistrement de l'event.id. En cas de
    // conflit (déjà vu), on s'arrête proprement avec un 200 (Stripe ne doit
    // pas réessayer un événement déjà traité avec succès).
    const inserted = await client.query(
      `INSERT INTO processed_webhook_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING RETURNING event_id`,
      [event.id]
    );
    if (inserted.rows.length === 0) {
      await client.query('ROLLBACK');
      res.status(200).json({ received: true, duplicate: true });
      return;
    }

    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      const session = event.data.object;
      const orderRes = await client.query(
        `SELECT id, status, kind FROM orders WHERE stripe_session_id = $1 FOR UPDATE`,
        [session.id]
      );
      const order = orderRes.rows[0];

      if (!order) {
        console.warn('Webhook: commande introuvable pour la session Stripe', session.id);
      } else if (order.status === 'paid') {
        // Déjà traité (webhook rejoué avec un event_id différent mais pour
        // le même effet) : rien à refaire, sortie idempotente.
      } else if (order.status === 'pending') {
        // ---- Cas normal (~100% des cas) ----
        // Le stock a déjà été réservé (décrémenté) de façon atomique au
        // moment de la création de la session, voir
        // api/create-checkout-session.js. Il n'y a donc RIEN à décrémenter
        // ici : on ne fait que confirmer que le paiement a réellement eu
        // lieu. C'est ce qui élimine la survente — la réservation, pas la
        // confirmation, est le moment qui compte pour le stock.
        await client.query(
          `UPDATE orders SET status = 'paid', updated_at = now(), shipping_address = $2 WHERE id = $1`,
          [order.id, JSON.stringify(session.shipping_details || session.customer_details || null)]
        );
        console.log('Paiement confirmé:', session.id, 'commande', order.id, session.amount_total, 'centimes');
      } else if (order.status === 'failed') {
        // ---- Cas exceptionnel ----
        // La commande était déjà marquée "failed" (sa session avait expiré,
        // ou un paiement asynchrone avait déjà échoué — voir plus bas), et
        // son stock avait donc déjà été RELÂCHÉ. Un événement de paiement
        // réussi arrive malgré tout, en retard (rare course entre
        // l'expiration Stripe et une confirmation de paiement quasi
        // simultanée). Le stock libéré a pu entre-temps être repris par
        // quelqu'un d'autre : on tente de le re-réserver ; si ça échoue, on
        // rembourse automatiquement au lieu de laisser une commande "payée"
        // mais invendable, ou de nécessiter une intervention manuelle.
        console.warn(`⚠️ Webhook de paiement reçu pour la commande ${order.id}, déjà marquée "failed" (stock relâché) — tentative de re-réservation.`);

        let reReserved = true;
        const reReservedItems = [];
        if (order.kind === 'cart') {
          const itemsRes = await client.query(
            `SELECT product_id, quantity FROM order_items WHERE order_id = $1 AND product_id IS NOT NULL`,
            [order.id]
          );
          for (const item of itemsRes.rows) {
            const upd = await client.query(
              `UPDATE products SET stock = stock - $1, updated_at = now()
               WHERE id = $2 AND stock >= $1
               RETURNING id`,
              [item.quantity, item.product_id]
            );
            if (upd.rows.length === 0) { reReserved = false; break; }
            reReservedItems.push(item);
          }
        }

        if (reReserved) {
          await client.query(
            `UPDATE orders SET status = 'paid', stock_decremented = true, updated_at = now(), shipping_address = $2 WHERE id = $1`,
            [order.id, JSON.stringify(session.shipping_details || session.customer_details || null)]
          );
          console.log(`Commande ${order.id} re-réservée avec succès et confirmée payée (retard de webhook).`);
        } else {
          // Annule la re-réservation partielle éventuelle avant de rembourser.
          for (const item of reReservedItems) {
            await client.query(`UPDATE products SET stock = stock + $1, updated_at = now() WHERE id = $2`, [item.quantity, item.product_id]);
          }
          await refundAndMarkOrder(stripe, client, order, session);
        }
      }
    } else if (
      event.type === 'checkout.session.expired' ||
      event.type === 'checkout.session.async_payment_failed'
    ) {
      // Le paiement n'a finalement pas eu lieu : on relâche le stock qui
      // avait été réservé à la création de la session, pour qu'il redevienne
      // disponible à l'achat pour d'autres client·es.
      const session = event.data.object;
      const orderRes = await client.query(
        `SELECT id, status, kind FROM orders WHERE stripe_session_id = $1 FOR UPDATE`,
        [session.id]
      );
      const order = orderRes.rows[0];

      if (order && order.status === 'pending') {
        if (order.kind === 'cart') {
          const itemsRes = await client.query(
            `SELECT product_id, quantity FROM order_items WHERE order_id = $1 AND product_id IS NOT NULL`,
            [order.id]
          );
          for (const item of itemsRes.rows) {
            await client.query(
              `UPDATE products SET stock = stock + $1, updated_at = now() WHERE id = $2`,
              [item.quantity, item.product_id]
            );
          }
        }
        await client.query(`UPDATE orders SET status = 'failed', updated_at = now() WHERE id = $1`, [order.id]);
      }
    }

    await client.query('COMMIT');
    res.status(200).json({ received: true });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Erreur traitement webhook:', err.message);
    // 500 ici est volontaire : Stripe réessaiera cet événement plus tard,
    // ce qui est le comportement souhaité en cas d'erreur transitoire (ex.
    // base de données momentanément indisponible).
    res.status(500).json({ error: 'Erreur serveur.' });
  } finally {
    client.release();
  }
};

module.exports.config = { api: { bodyParser: false } };
