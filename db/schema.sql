-- db/schema.sql
-- Schéma pour Vercel Postgres. À exécuter une fois (Vercel Dashboard > Storage
-- > ton projet Postgres > "Query" ou via `psql "$POSTGRES_URL" -f db/schema.sql`).
--
-- Principes de conception (voir rapport d'audit) :
--   - Les mots de passe ne sont jamais stockés en clair (colonne password_hash,
--     format "salt:hash" scrypt, voir lib/auth.js).
--   - Le rôle admin est une colonne en base (role), jamais une valeur envoyée
--     par le navigateur : toute route admin revérifie ce rôle en base à
--     chaque requête (voir lib/session.js -> requireAdmin).
--   - Les prix sont stockés en centimes (entiers) pour éviter les erreurs
--     d'arrondi des nombres flottants sur de l'argent réel.
--   - orders.status ne passe à 'paid' QUE depuis le webhook Stripe
--     (api/webhook.js), jamais depuis une route appelée par le navigateur.

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ -- rempli lors d'une suppression RGPD (voir api/account/delete.js) : compte anonymisé, pas de ligne physiquement supprimée pour préserver l'intégrité des commandes déjà passées
);

CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  icon TEXT DEFAULT '',
  images JSONB NOT NULL DEFAULT '[]',
  active BOOLEAN NOT NULL DEFAULT true, -- permet de "retirer" un produit sans casser les anciennes commandes qui le référencent
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL, -- NULL = achat sans compte (invité)
  email TEXT, -- copie figée au moment de la commande (utile même si le compte est supprimé ensuite)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  kind TEXT NOT NULL DEFAULT 'cart' CHECK (kind IN ('cart', 'custom')),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  stripe_session_id TEXT UNIQUE, -- empêche qu'une même session Stripe crée deux commandes
  shipping_address JSONB,
  custom_order_config JSONB, -- choix du configurateur "Commande perso", si kind = 'custom'
  stock_decremented BOOLEAN NOT NULL DEFAULT false, -- garde-fou anti double-décrément (voir webhook)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name_snapshot TEXT NOT NULL, -- copie du nom au moment de l'achat (même si le produit est renommé/supprimé après)
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

-- Empêche qu'un événement webhook Stripe reçu deux fois (Stripe garantit
-- "au moins une fois", pas "exactement une fois") ne fasse deux fois le
-- même effet de bord (ex. décrémenter le stock deux fois).
CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active);

-- ---- Données de départ (reprend les 8 produits par défaut du site) ----
INSERT INTO products (name, category, price_cents, stock, icon, images)
SELECT * FROM (VALUES
  ('String 1', 'String', 8999, 12, '🩲', '["https://placehold.co/300x200?text=String+1"]'::jsonb),
  ('Culotte 1', 'Culotte', 14900, 5, '🎀', '["https://placehold.co/300x200?text=Culotte+1"]'::jsonb),
  ('String 2', 'String', 6550, 0, '🩲', '["https://placehold.co/300x200?text=String+2"]'::jsonb),
  ('Caleçon 1', 'Caleçon', 21000, 8, '🩳', '["https://placehold.co/300x200?text=Caleçon+1"]'::jsonb),
  ('Culotte 2', 'Culotte', 3490, 20, '🎀', '["https://placehold.co/300x200?text=Culotte+2"]'::jsonb),
  ('String 3', 'String', 7900, 3, '🩲', '["https://placehold.co/300x200?text=String+3"]'::jsonb),
  ('String 4', 'String', 2990, 15, '🩲', '["https://placehold.co/300x200?text=String+4"]'::jsonb),
  ('String 5', 'String', 24900, 6, '🩲', '["https://placehold.co/300x200?text=String+5"]'::jsonb)
) AS v(name, category, price_cents, stock, icon, images)
WHERE NOT EXISTS (SELECT 1 FROM products);

-- ---- Ton compte admin ----
-- Ne crée PAS de compte admin ici avec un mot de passe en dur : lance plutôt
-- `node scripts/create-admin.js "toi@exemple.com" "TonMotDePasse"` une fois
-- la base connectée (voir LISEZ-MOI.md). Ça évite qu'un mot de passe admin,
-- même hashé, traîne dans l'historique Git de ce fichier.
