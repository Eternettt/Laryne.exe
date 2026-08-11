// Fonction serverless Vercel : /api/create-checkout-session
// Reçoit soit un panier boutique (cart), soit une création personnalisée
// (customItem, depuis commande_perso.html), crée une session de paiement
// Stripe AVEC LA CLÉ SECRÈTE (jamais exposée au client), et renvoie l'URL
// vers laquelle rediriger l'utilisateur pour payer.

const Stripe = require('stripe');
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// Source de vérité des produits, CÔTÉ SERVEUR, pour le panier boutique.
// ⚠️ Ne fais JAMAIS confiance aux prix envoyés par le navigateur.
// Idéalement, remplace cette liste par un vrai appel à ta base de données.
const PRODUCTS = {
  1: { name: "String 1", price: 89.99 },
  2: { name: "Culotte 1", price: 149.00 },
  3: { name: "String 2", price: 65.50 },
  4: { name: "Caleçon 1", price: 210.00 },
  5: { name: "Culotte 2", price: 34.90 },
  6: { name: "String 3", price: 79.00 },
  7: { name: "String 4", price: 29.90 },
  8: { name: "String 5", price: 249.00 },
};

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée' });
    return;
  }

  try {
    const { cart, customItem } = req.body;
    let line_items;

    if (customItem) {
      // ---- Création personnalisée (commande_perso.html) ----
      // ⚠️ Ici le prix vient bien du navigateur (calculé selon les choix de
      // l'utilisateur : forme, déco, extras...). Pour une vraie mise en
      // production, recalcule ce total côté serveur à partir des mêmes
      // règles de prix que commande_perso.html, plutôt que de faire
      // confiance à `unitAmount` tel quel.
      const amount = Math.round(Number(customItem.unitAmount));
      if (!amount || amount <= 0) {
        res.status(400).json({ error: 'Montant invalide' });
        return;
      }
      line_items = [{
        price_data: {
          currency: 'eur',
          product_data: { name: customItem.name || 'Création personnalisée Stringz.exe' },
          unit_amount: amount,
        },
        quantity: 1,
      }];
    } else {
      // ---- Panier boutique classique ----
      if (!cart || Object.keys(cart).length === 0) {
        res.status(400).json({ error: 'Panier vide' });
        return;
      }
      line_items = Object.entries(cart).map(([id, qty]) => {
        const product = PRODUCTS[id];
        if (!product) throw new Error(`Produit inconnu: ${id}`);
        return {
          price_data: {
            currency: 'eur',
            product_data: { name: product.name },
            unit_amount: Math.round(product.price * 100),
          },
          quantity: qty,
        };
      });
    }

    const origin = req.headers.origin || `https://${req.headers.host}`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items,
      success_url: `${origin}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/${customItem ? 'commande_perso.html' : 'boutique.html'}`,
    });

    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
};
