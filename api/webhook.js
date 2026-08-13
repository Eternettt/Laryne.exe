// api/webhook.js
// Point d'entrée Stripe Webhook. C'est la SEULE source fiable pour savoir
// si un paiement a réellement abouti : contrairement à success.html (qui
// s'affiche dès que le navigateur revient sur le site, y compris si
// quelqu'un visite l'URL "à la main" sans avoir payé), ce endpoint est
// appelé directement par les serveurs de Stripe et sa signature est
// vérifiée cryptographiquement.
//
// Variables d'environnement Vercel à définir :
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET  (fourni par Stripe lors de la création du
//                           webhook, section Développeurs > Webhooks)
//
// ⚠️ TODO IMPORTANT : ce fichier vérifie la signature et vous confirme donc
// de façon fiable qu'un paiement a réussi, mais il ne peut pas, à lui seul,
// écrire dans une vraie base de données puisque ce projet n'en a pas
// (voir shared-data.js). Pour un vrai suivi de commandes/stock, il faut
// brancher ici l'écriture vers une base de données (ex: Vercel Postgres,
// Supabase...) au lieu du simple `console.log` ci-dessous.

const Stripe = require('stripe');

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
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

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // Confirmation fiable et vérifiée côté serveur qu'un paiement a réussi.
    console.log('Paiement confirmé par Stripe:', session.id, session.amount_total, session.customer_details?.email);
    // TODO : enregistrer la commande dans une vraie base de données ici
    // (au lieu du localStorage géré côté client dans success.html), et
    // décrémenter le stock réel du produit correspondant.
  }

  res.status(200).json({ received: true });
};

// Nécessaire pour recevoir le corps BRUT de la requête (obligatoire pour
// vérifier la signature Stripe) plutôt que le JSON déjà parsé.
module.exports.config = { api: { bodyParser: false } };
