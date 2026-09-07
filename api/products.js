const { sql } = require('../lib/db');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Méthode non autorisée.' });
    return;
  }

  try {
    const { rows } = await sql`
      select id, name, category, price_cents, stock, icon, images
      from products
      order by id asc
    `;
    const products = rows.map((r) => ({
      id: r.id,
      name: r.name,
      category: r.category,
      price: r.price_cents / 100,
      stock: r.stock,
      icon: r.icon,
      images: r.images || [],
    }));
    res.status(200).json({ products });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
