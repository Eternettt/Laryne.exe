/* ==========================================================================
   api/products.js — Liste publique des produits ET gestion admin (CRUD)
   regroupées dans une seule fonction serverless.

   - GET  /api/products               → liste publique (tout le monde)
   - GET/POST/PUT/DELETE /api/admin/products
       → réécrit vers /api/products?admin=1 (voir vercel.json), rôle admin
         revérifié EN BASE à chaque appel avant toute opération.

   - Ateliers (workshops) de workshop.html, gérés depuis admin.html (mêmes
     fonction serverless) :
       GET /api/products?workshops=1  → liste des ateliers (public)
       PUT /api/products?workshops=1  → enregistre la liste (admin)
     Stockée dans site_settings comme le diaporama (voir migration-workshops.sql).

   - Diaporama de la page d'accueil (mêmes fonction serverless, pour rester sous
     la limite de fonctions du plan Hobby) :
       GET  /api/products?diapo=1          → liste des photos (public)
       PUT  /api/products?diapo=1          → enregistre la liste (admin)
       POST /api/products?diapo=upload     → envoie une photo (admin)
       GET  /api/products?diapo=img&id=N   → sert la photo N (public, cache long)
     La liste est stockée dans la table site_settings (voir
     migration-diaporama.sql) : c'est la même pour tous les visiteurs.

   Types disponibles (tanga, string, culotte...) : aucune colonne dédiée en
   base. Ils sont stockés dans "category" sous la forme "Tanga / String" et
   renvoyés au front sous forme de tableau "types" (voir typesFromCategory).
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

// "Tanga / String" -> ["Tanga", "String"]
function typesFromCategory(category) {
  return [...new Set(
    String(category || '')
      .split(/[\/,]/)
      .map((t) => t.trim())
      .filter(Boolean)
  )];
}

// ["Tanga", "String"] -> "Tanga / String"
function categoryFromTypes(types) {
  return [...new Set(
    (Array.isArray(types) ? types : [])
      .map((t) => String(t == null ? '' : t).replace(/[\/,]/g, ' ').trim())
      .filter(Boolean)
  )].join(' / ');
}

function toClientProduct(r) {
  return {
    id: r.id,
    name: r.name,
    category: r.category,
    types: typesFromCategory(r.category),
    description: r.description || '',
    price: r.price_cents / 100,
    stock: r.stock,
    icon: r.icon,
    images: r.images || [],
  };
}

// ==========================================================================
// Ateliers (workshops), affichés sur workshop.html, gérés depuis admin.html
// ==========================================================================
const WORKSHOPS_SETTING_KEY = 'workshops';
const MAX_WORKSHOPS = 100;
const MAX_WORKSHOP_TEXT = 300;       // titre, lieu, horaire, phrase courte, note...
const MAX_WORKSHOP_PARAGRAPH = 3000; // un paragraphe de description
const MAX_WORKSHOP_PARAGRAPHS = 40;

function isPlainString(v, maxLen) {
  return typeof v === 'string' && v.length <= maxLen;
}

function isValidWorkshop(w) {
  if (!w || typeof w !== 'object') return false;
  if (!/^[a-z0-9-]{1,120}$/.test(w.id || '')) return false;
  if (!isPlainString(w.icon, 20)) return false;
  if (!isPlainString(w.title, MAX_WORKSHOP_TEXT) || !w.title.trim()) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w.date || '')) return false;
  if (!isPlainString(w.dateLabel, MAX_WORKSHOP_TEXT)) return false;
  if (!isPlainString(w.whenLabel, MAX_WORKSHOP_TEXT)) return false;
  if (!isPlainString(w.location, MAX_WORKSHOP_TEXT)) return false;
  if (typeof w.price !== 'number' || !(w.price >= 0) || w.price > 100000) return false;
  if (typeof w.deposit !== 'number' || !(w.deposit >= 0) || w.deposit > 100000) return false;
  if (!Number.isInteger(w.places) || w.places < 0 || w.places > 100000) return false;
  if (!isPlainString(w.shortDescription, MAX_WORKSHOP_TEXT)) return false;
  if (!isPlainString(w.note, MAX_WORKSHOP_TEXT)) return false;
  if (!Array.isArray(w.description) || w.description.length > MAX_WORKSHOP_PARAGRAPHS) return false;
  if (!w.description.every((p) => isPlainString(p, MAX_WORKSHOP_PARAGRAPH))) return false;
  return true;
}

async function handleWorkshops(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const { rows } = await sql`select value from site_settings where key = ${WORKSHOPS_SETTING_KEY}`;
    // null tant que l'admin n'a rien enregistré : le site utilise alors les ateliers par défaut.
    res.status(200).json({ workshops: rows.length ? rows[0].value : null });
    return;
  }

  if (req.method === 'PUT') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const { workshops } = req.body || {};
    if (!Array.isArray(workshops) || workshops.length > MAX_WORKSHOPS || !workshops.every(isValidWorkshop)) {
      res.status(400).json({ error: 'Liste d\'ateliers invalide.' });
      return;
    }
    const ids = workshops.map((w) => w.id);
    if (new Set(ids).size !== ids.length) {
      res.status(400).json({ error: 'Deux ateliers ne peuvent pas avoir le même identifiant.' });
      return;
    }

    await sql`
      insert into site_settings (key, value, updated_at)
      values (${WORKSHOPS_SETTING_KEY}, ${JSON.stringify(workshops)}::jsonb, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;
    res.status(200).json({ ok: true, workshops });
    return;
  }

  res.status(405).json({ error: 'Méthode non autorisée.' });
}

// ==========================================================================
// Diaporama de la page d'accueil
// ==========================================================================
const DIAPO_SETTING_KEY = 'diaporama';
const MAX_DIAPO_PHOTOS = 20;
// Limite d'une requête sur Vercel : ~4,5 Mo. Le navigateur compresse déjà les
// photos (voir shared-data.js) ; ce plafond n'est qu'une protection.
const MAX_DIAPO_IMAGE_B64_LENGTH = 3500000;
const DIAPO_ALLOWED_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

// Une entrée du diaporama est soit une photo envoyée depuis l'admin
// ("/api/products?diapo=img&id=12"), soit un fichier du site ("photo1.jpg").
function isValidDiapoSrc(src) {
  if (typeof src !== 'string' || src.length === 0 || src.length > 300) return false;
  if (/^\/api\/products\?diapo=img&id=\d+$/.test(src)) return true;
  return (
    /^[A-Za-z0-9_-][A-Za-z0-9_\-. \/]*\.(jpe?g|png|webp|gif|avif)$/i.test(src) &&
    !src.includes('..') &&
    !src.includes('//')
  );
}

// Vérifie que le contenu correspond bien au type annoncé (pas de fichier
// quelconque déguisé en image).
function looksLikeImage(mime, buffer) {
  if (buffer.length < 12) return false;
  if (mime === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === 'image/png') return buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/gif') return buffer.slice(0, 4).toString('latin1') === 'GIF8';
  if (mime === 'image/webp') return buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP';
  return false;
}

async function handleDiapo(req, res, mode, url) {
  // ---- Une photo envoyée depuis l'admin (public) ----
  // Une photo n'est jamais modifiée : la remplacer en crée une nouvelle (autre id),
  // on peut donc la mettre en cache très longtemps.
  if (mode === 'img') {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'Méthode non autorisée.' });
      return;
    }
    const id = parseInt(url.searchParams.get('id'), 10);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'id invalide.' });
      return;
    }
    const { rows } = await sql`select mime, data from diaporama_images where id = ${id}`;
    if (!rows.length) {
      res.status(404).json({ error: 'Image introuvable.' });
      return;
    }
    res.setHeader('Content-Type', rows[0].mime);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.statusCode = 200;
    res.end(Buffer.from(rows[0].data, 'base64'));
    return;
  }

  // ---- Envoi d'une photo (admin) : renvoie l'adresse à mettre dans la liste ----
  if (mode === 'upload') {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Méthode non autorisée.' });
      return;
    }
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const dataUrl = (req.body && req.body.dataUrl) || '';
    const marker = ';base64,';
    const cut = typeof dataUrl === 'string' ? dataUrl.indexOf(marker) : -1;
    const mime = cut > 5 ? dataUrl.slice(5, cut) : '';
    if (!dataUrl.startsWith('data:') || !DIAPO_ALLOWED_MIMES.includes(mime)) {
      res.status(400).json({ error: 'Format non pris en charge (JPG, PNG, WebP ou GIF).' });
      return;
    }
    const b64 = dataUrl.slice(cut + marker.length);
    if (b64.length > MAX_DIAPO_IMAGE_B64_LENGTH) {
      res.status(413).json({ error: 'Photo trop lourde.' });
      return;
    }
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || !looksLikeImage(mime, Buffer.from(b64, 'base64'))) {
      res.status(400).json({ error: 'Ce fichier n\'est pas une image valide.' });
      return;
    }
    const { rows } = await sql`
      insert into diaporama_images (mime, data) values (${mime}, ${b64}) returning id
    `;
    res.status(200).json({ url: `/api/products?diapo=img&id=${rows[0].id}` });
    return;
  }

  // ---- Liste des photos (lecture publique / écriture admin) ----
  if (mode !== 'list') {
    res.status(404).json({ error: 'Action inconnue.' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const { rows } = await sql`select value from site_settings where key = ${DIAPO_SETTING_KEY}`;
    // photos = null tant que l'admin n'a rien enregistré : le site utilise alors ses photos par défaut.
    res.status(200).json({ photos: rows.length ? rows[0].value : null });
    return;
  }

  if (req.method === 'PUT') {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const { photos } = req.body || {};
    if (!Array.isArray(photos) || photos.length < 1 || photos.length > MAX_DIAPO_PHOTOS || !photos.every(isValidDiapoSrc)) {
      res.status(400).json({ error: 'Liste de photos invalide (1 à ' + MAX_DIAPO_PHOTOS + ' photos).' });
      return;
    }

    await sql`
      insert into site_settings (key, value, updated_at)
      values (${DIAPO_SETTING_KEY}, ${JSON.stringify(photos)}::jsonb, now())
      on conflict (key) do update set value = excluded.value, updated_at = now()
    `;

    // Ménage : supprime les photos envoyées qui ne sont plus dans la liste.
    // (On garde celles de moins de 10 minutes : une photo tout juste envoyée
    // n'est pas encore dans la liste pendant quelques instants.)
    const keptIds = photos
      .map((src) => { const m = /diapo=img&id=(\d+)$/.exec(src); return m ? parseInt(m[1], 10) : null; })
      .filter((id) => id !== null);
    await sql`
      delete from diaporama_images
      where id <> all(${keptIds}) and created_at < now() - interval '10 minutes'
    `;

    res.status(200).json({ ok: true, photos });
    return;
  }

  res.status(405).json({ error: 'Méthode non autorisée.' });
}

module.exports = async (req, res) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const isAdmin = url.searchParams.get('admin') === '1';
  const diapoMode = url.searchParams.get('diapo');
  const workshopsMode = url.searchParams.get('workshops');

  try {
    // ---- Ateliers (voir handleWorkshops) ----
    if (workshopsMode) {
      await handleWorkshops(req, res);
      return;
    }

    // ---- Diaporama de l'accueil (voir handleDiapo) ----
    if (diapoMode) {
      await handleDiapo(req, res, diapoMode === '1' ? 'list' : diapoMode, url);
      return;
    }

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
      const { name, category, types, description, price, stock, icon, images } = req.body || {};
      if (!name) {
        res.status(400).json({ error: 'Nom requis.' });
        return;
      }
      const priceCents = Math.round((Number(price) || 0) * 100);
      const finalCategory = Array.isArray(types) ? categoryFromTypes(types) : (category || '');
      const { rows } = await sql`
        insert into products (name, category, description, price_cents, stock, icon, images)
        values (${name}, ${finalCategory}, ${description || ''}, ${priceCents}, ${Number(stock) || 0}, ${icon || ''}, ${JSON.stringify(images || [])})
        returning id, name, category, description, price_cents, stock, icon, images
      `;
      res.status(200).json({ product: toClientProduct(rows[0]) });
      return;
    }

    if (req.method === 'PUT') {
      const { id, name, category, types, description, price, stock, icon, images } = req.body || {};
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
      // "types" (tableau) prime sur "category" : c'est ce qu'envoie admin.html
      // quand on coche/décoche un type.
      if (Array.isArray(types)) {
        const cat = categoryFromTypes(types);
        await sql`update products set category = ${cat}, updated_at = now() where id = ${id}`;
      } else if (category !== undefined) {
        await sql`update products set category = ${category}, updated_at = now() where id = ${id}`;
      }
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
