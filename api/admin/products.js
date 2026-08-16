// api/admin/products.js
// CRUD produits, réservé aux administrateur·rices — vérifié à chaque appel
// via requireAdmin() (relit le rôle en base, jamais depuis un jeton ou
// localStorage envoyé par le client). GET renvoie aussi les produits
// désactivés (active=false), utile pour le panneau Gestion.
//
// Actions :
//   GET                          -> liste tous les produits
//   POST   { name, category, price, stock, icon, images }        -> crée
//   PUT    { id, ...champs à modifier }                          -> modifie
//   DELETE { id }                                                -> désactive (active=false), ne supprime jamais physiquement une ligne référencée par des commandes existantes

const { sql } = require('../../lib/db');
const { requireAdmin } = require('../../lib/session');

function toCents(euros) {
  return Math.round(Number(euros) * 100);
}

module.exports = async (req, res) => {
  const admin = await requireAdmin(req, res);
  if (!admin) return; // requireAdmin a déjà envoyé la réponse 401/403

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }

  try {
    if (req.method === 'GET') {
      const { rows } = await sql`
        SELECT id, name, category, price_cents, stock, icon, images, active
        FROM products ORDER BY id ASC
      `;
      res.status(200).json({
        products: rows.map(p => ({ ...p, price: p.price_cents / 100 })),
      });
      return;
    }

    if (req.method === 'POST') {
      const { name, category, price, stock, icon, images } = body || {};
      if (!name || typeof name !== 'string' || !name.trim()) {
        res.status(400).json({ error: 'Nom de produit requis.' });
        return;
      }
      const priceCents = toCents(price);
      const stockInt = Math.max(0, Math.floor(Number(stock) || 0));
      if (!Number.isFinite(priceCents) || priceCents < 0) {
        res.status(400).json({ error: 'Prix invalide.' });
        return;
      }
      const { rows } = await sql`
        INSERT INTO products (name, category, price_cents, stock, icon, images)
        VALUES (${name.trim().slice(0, 120)}, ${(category || '').trim().slice(0, 60)}, ${priceCents}, ${stockInt}, ${icon || ''}, ${JSON.stringify(images || [])}::jsonb)
        RETURNING id, name, category, price_cents, stock, icon, images, active
      `;
      res.status(201).json({ product: { ...rows[0], price: rows[0].price_cents / 100 } });
      return;
    }

    if (req.method === 'PUT') {
      const { id } = body || {};
      const productId = Number(id);
      if (!Number.isInteger(productId)) {
        res.status(400).json({ error: 'Identifiant produit invalide.' });
        return;
      }

      // On ne met à jour QUE les champs fournis, sans jamais faire
      // confiance à un champ non attendu du corps de la requête. On met à
      // jour les colonnes une par une (nombre de colonnes limité, coût
      // négligeable) avec des requêtes paramétrées, plutôt que de composer
      // du SQL dynamique à la main (ce qui ouvrirait une injection SQL).
      let updated = false;
      if (body.name !== undefined) { await sql`UPDATE products SET name = ${String(body.name).trim().slice(0, 120)}, updated_at = now() WHERE id = ${productId}`; updated = true; }
      if (body.category !== undefined) { await sql`UPDATE products SET category = ${String(body.category).trim().slice(0, 60)}, updated_at = now() WHERE id = ${productId}`; updated = true; }
      if (body.price !== undefined) { await sql`UPDATE products SET price_cents = ${toCents(body.price)}, updated_at = now() WHERE id = ${productId}`; updated = true; }
      if (body.stock !== undefined) { await sql`UPDATE products SET stock = ${Math.max(0, Math.floor(Number(body.stock) || 0))}, updated_at = now() WHERE id = ${productId}`; updated = true; }
      if (body.icon !== undefined) { await sql`UPDATE products SET icon = ${String(body.icon)}, updated_at = now() WHERE id = ${productId}`; updated = true; }
      if (body.images !== undefined) { await sql`UPDATE products SET images = ${JSON.stringify(body.images)}::jsonb, updated_at = now() WHERE id = ${productId}`; updated = true; }
      if (body.active !== undefined) { await sql`UPDATE products SET active = ${!!body.active}, updated_at = now() WHERE id = ${productId}`; updated = true; }

      if (!updated) {
        res.status(400).json({ error: 'Aucun champ à mettre à jour.' });
        return;
      }

      const { rows } = await sql`SELECT id, name, category, price_cents, stock, icon, images, active FROM products WHERE id = ${productId}`;
      if (!rows.length) {
        res.status(404).json({ error: 'Produit introuvable.' });
        return;
      }
      res.status(200).json({ product: { ...rows[0], price: rows[0].price_cents / 100 } });
      return;
    }

    if (req.method === 'DELETE') {
      const productId = Number(body && body.id);
      if (!Number.isInteger(productId)) {
        res.status(400).json({ error: 'Identifiant produit invalide.' });
        return;
      }
      await sql`UPDATE products SET active = false, updated_at = now() WHERE id = ${productId}`;
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Méthode non autorisée.' });
  } catch (err) {
    console.error('Erreur /api/admin/products:', err.message);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
