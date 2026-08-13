// api/create-checkout-session.js
// Crée une session de paiement Stripe. Les prix ne viennent JAMAIS du
// panier envoyé par le navigateur : ils sont recalculés ici, à partir de
// PRODUCTS (boutique) ou de CUSTOM_ORDER_PRICING (configurateur "Commande
// perso"), pour qu'il soit impossible de trafiquer un prix depuis les
// DevTools.
//
// ⚠️ À FAIRE MANUELLEMENT : ces tables doivent rester synchronisées avec
// boutique.html / shared-data.js (STRINGZ_DEFAULT_PRODUCTS) et avec les
// tableaux PANTONES / MOTIFS / SHAPES / DECOR_ITEMS / EXTRAS / BASE_PRICE de
// commande_perso.html. Tant qu'il n'y a pas de vraie base de données
// partagée, un produit créé depuis le panneau Gestion ne sera PAS achetable
// via ce paiement réel tant qu'il n'est pas ajouté ici aussi.
//
// Variable d'environnement Vercel à définir : STRIPE_SECRET_KEY

const Stripe = require('stripe');

const PRODUCTS = [
  { id: 1, name: "String 1", price: 89.99, stock: 12 },
  { id: 2, name: "Culotte 1", price: 149.00, stock: 5 },
  { id: 3, name: "String 2", price: 65.50, stock: 0 },
  { id: 4, name: "Caleçon 1", price: 210.00, stock: 8 },
  { id: 5, name: "Culotte 2", price: 34.90, stock: 20 },
  { id: 6, name: "String 3", price: 79.00, stock: 3 },
  { id: 7, name: "String 4", price: 29.90, stock: 15 },
  { id: 8, name: "String 5", price: 249.00, stock: 6 },
];

const MAX_QTY_PER_ITEM = 20;

// ---- Tarifs du configurateur "Commande perso" (commande_perso.html) ----
// Recopiés ici pour permettre un recalcul serveur fiable, à garder
// synchronisés avec les tableaux JS de commande_perso.html.
const CUSTOM_BASE_PRICE = { string: 24.9, culotte: 29.9, boxer: 32.9, bresilienne: 27.9, 'taille-haute': 31.9 };
const CUSTOM_SHAPE_NAMES = { string: 'String', culotte: 'Culotte classique', boxer: 'Boxer', bresilienne: 'Brésilienne', 'taille-haute': 'Taille haute' };
const CUSTOM_MOTIF_PRICE = 3; // flat, si un motif est choisi
const CUSTOM_DECOR_PRICES = { fleur: 4, noeud: 3, etoile: 3, coeur: 3, initiales: 6, dentelle: 5, papillon: 4, lune: 3 };
const CUSTOM_EXTRA_PRICES = { piercing: 5, sequins: 4, rubans: 3, clous: 5 };
const CUSTOM_SPECIAL_REQUEST_PRICE = 8;
const CUSTOM_MAX_ITEMS = 20; // garde-fou anti-abus sur les tableaux decor/extras

function computeCustomOrderAmount(customOrder) {
  const shapeId = customOrder && customOrder.shapeId;
  const basePrice = CUSTOM_BASE_PRICE[shapeId];
  if (!basePrice) return { error: 'Forme de vêtement invalide.' };

  let total = basePrice;
  const parts = [`${CUSTOM_SHAPE_NAMES[shapeId]}`];

  if (customOrder.motifId) {
    total += CUSTOM_MOTIF_PRICE;
    parts.push('motif');
  }

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
    unitAmount: Math.round(total * 100),
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

  const line_items = [];

  if (body && body.customOrder) {
    // ---- Commande personnalisée (commande_perso.html) ----
    const result = computeCustomOrderAmount(body.customOrder);
    if (result.error) {
      res.status(400).json({ error: result.error });
      return;
    }
    line_items.push({
      price_data: {
        currency: 'eur',
        product_data: { name: result.name },
        unit_amount: result.unitAmount,
      },
      quantity: 1,
    });
  } else {
    // ---- Panier boutique classique ----
    const cart = (body && body.cart) || {};
    const entries = Object.entries(cart).filter(([, qty]) => Number(qty) > 0);
    if (!entries.length) {
      res.status(400).json({ error: 'Panier vide.' });
      return;
    }

    for (const [idStr, qtyRaw] of entries) {
      const id = Number(idStr);
      const qty = Math.floor(Number(qtyRaw));
      const product = PRODUCTS.find(p => p.id === id);

      if (!product) {
        res.status(400).json({ error: `Produit inconnu (id ${idStr}).` });
        return;
      }
      if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY_PER_ITEM) {
        res.status(400).json({ error: `Quantité invalide pour ${product.name}.` });
        return;
      }
      if (product.stock <= 0) {
        res.status(400).json({ error: `${product.name} est en rupture de stock.` });
        return;
      }
      if (qty > product.stock) {
        res.status(400).json({ error: `Stock insuffisant pour ${product.name} (${product.stock} disponible(s)).` });
        return;
      }

      line_items.push({
        price_data: {
          currency: 'eur',
          product_data: { name: product.name },
          unit_amount: Math.round(product.price * 100), // prix serveur, en centimes
        },
        quantity: qty,
      });
    }
  }

  const origin = req.headers.origin || `https://${req.headers.host}`;

  try {
    const stripe = new Stripe(STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/boutique.html`,
      // Adresse de livraison collectée par Stripe lui-même : le site n'a
      // jamais besoin de la stocker ou de la manipuler côté client.
      shipping_address_collection: { allowed_countries: ['FR', 'BE', 'CH', 'LU', 'MC'] },
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Erreur Stripe:', err.message);
    res.status(500).json({ error: 'Erreur lors de la création du paiement.' });
  }
};

