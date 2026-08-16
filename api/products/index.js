// api/products/index.js
// Liste publique des produits actifs — accessible sans connexion (c'est la
// vitrine de la boutique). C'est désormais la SEULE source de vérité pour
// les prix/stock affichés : avant, chaque navigateur avait sa propre copie
// dans localStorage, non synchronisée entre client·es (voir rapport d'audit
// initial). Les montants sont convertis de centimes (stockage) en euros
// (affichage) ici, pour ne pas exposer de logique de conversion côté client.

const { sql } = require('../../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  try {
    const { rows } = await sql`
      SELECT id, name, category, price_cents, stock, icon, images
      FROM products
      WHERE active = true
      ORDER BY id ASC
    `;
    const products = rows.map(p => ({
      id: p.id,
      name: p.name,
      category: p.category,
      price: p.price_cents / 100,
      stock: p.stock,
      icon: p.icon,
      images: p.images,
    }));
    res.status(200).json({ products });
  } catch (err) {
    console.error('Erreur GET /api/products:', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
