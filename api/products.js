/* ==========================================================================
   api/products.js — Liste publique des produits ET gestion admin (CRUD)
   regroupées dans une seule fonction serverless.

   - GET  /api/products               → liste publique (tout le monde)
   - GET/POST/PUT/DELETE /api/admin/products
       → réécrit vers /api/products?admin=1 (voir vercel.json), rôle admin
         revérifié EN BASE à chaque appel avant toute opération.
   ========================================================================== */

const { sql } = require('../lib/db');
const { getSession } = require('../lib/session');

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

function toClientProduct(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    description: r.description || '',
    price: r.price_cents / 100,
    stock: r.stock,
    icon: r.icon,
    images: r.images || [],
  };
}

module.exports = async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const isAdmin = url.searchParams.get('admin') === '1';

  try {
    // ---- Route publique : GET simple, pas de vérification ----
    if (!isAdmin) {
      if (req.method !== 'GET') {
        res.status(405).json({ error: 'Méthode non autorisée.' });
        return;
      }
      const { rows } = await sql`
        select id, name, category, description, price_cents, stock, icon, images from products order by id asc
      `;
      res.status(200).json({ products: rows.map(toClientProduct) });
      return;
    }

    // ---- Routes admin : rôle revérifié en base avant toute action ----
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    if (req.method === 'GET') {
      const { rows } = await sql`
        select id, name, category, description, price_cents, stock, icon, images from products order by id asc
      `;
      res.status(200).json({ products: rows.map(toClientProduct) });
      return;
    }

    if (req.method === 'POST') {
      const { name, category, description, price, stock, icon, images } = req.body || {};
      if (!name) {
        res.status(400).json({ error: 'Nom requis.' });
        return;
      }
      const priceCents = Math.round((Number(price) || 0) * 100);
      const { rows } = await sql`
        insert into products (name, category, description, price_cents, stock, icon, images)
        values (${name}, ${category || ''}, ${description || ''}, ${priceCents}, ${Number(stock) || 0}, ${icon || ''}, ${JSON.stringify(images || [])})
        returning id, name, category, description, price_cents, stock, icon, images
      `;
      res.status(200).json({ product: toClientProduct(rows[0]) });
      return;
    }

    if (req.method === 'PUT') {
      const { id, name, category, description, price, stock, icon, images } = req.body || {};
      if (!id) {
        res.status(400).json({ error: 'id requis.' });
        return;
      }

      const { rows: existingRows } = await sql`select id from products where id = ${id}`;
      if (!existingRows.length) {
        res.status(404).json({ error: 'Produit introuvable.' });
        return;
      }

      if (name !== undefined) await sql`update products set name = ${name}, updated_at = now() where id = ${id}`;
      if (category !== undefined) await sql`update products set category = ${category}, updated_at = now() where id = ${id}`;
      if (description !== undefined) await sql`update products set description = ${description}, updated_at = now() where id = ${id}`;
      if (price !== undefined) await sql`update products set price_cents = ${Math.round(Number(price) * 100)}, updated_at = now() where id = ${id}`;
      if (stock !== undefined) await sql`update products set stock = ${Number(stock)}, updated_at = now() where id = ${id}`;
      if (icon !== undefined) await sql`update products set icon = ${icon}, updated_at = now() where id = ${id}`;
      if (images !== undefined) await sql`update products set images = ${JSON.stringify(images)}, updated_at = now() where id = ${id}`;

      const { rows } = await sql`
        select id, name, category, description, price_cents, stock, icon, images from products where id = ${id}
      `;
      res.status(200).json({ product: toClientProduct(rows[0]) });
      return;
    }

    if (req.method === 'DELETE') {
      const { id } = req.body || {};
      if (!id) {
        res.status(400).json({ error: 'id requis.' });
        return;
      }
      await sql`delete from products where id = ${id}`;
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Méthode non autorisée.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erreur serveur.' });
  }
};
