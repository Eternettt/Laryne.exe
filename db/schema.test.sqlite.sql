-- db/schema.test.sqlite.sql
-- ⚠️ FICHIER DE TEST UNIQUEMENT — traduction SQLite du vrai schéma Postgres
-- (db/schema.sql), utilisée uniquement par le harnais de test local
-- (test/run-tests.js) pour exécuter du VRAI SQL sans dépendre d'un accès
-- réseau à une vraie base Postgres (indisponible dans cet environnement).
-- Ce n'est PAS le schéma utilisé en production — voir db/schema.sql pour la
-- version Postgres réelle à exécuter sur Vercel Postgres.

PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  deleted_at TEXT
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  icon TEXT DEFAULT '',
  images TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'failed', 'refunded')),
  kind TEXT NOT NULL DEFAULT 'cart' CHECK (kind IN ('cart', 'custom')),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  stripe_session_id TEXT UNIQUE,
  shipping_address TEXT,
  custom_order_config TEXT,
  stock_decremented INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER REFERENCES products(id) ON DELETE SET NULL,
  name_snapshot TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  quantity INTEGER NOT NULL CHECK (quantity > 0)
);

CREATE TABLE processed_webhook_events (
  event_id TEXT PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ---- Données de départ (reprend les 8 produits par défaut, comme db/schema.sql) ----
INSERT INTO products (name, category, price_cents, stock, icon, images) VALUES
  ('String 1', 'String', 8999, 12, '🩲', '["https://placehold.co/300x200?text=String+1"]'),
  ('Culotte 1', 'Culotte', 14900, 5, '🎀', '["https://placehold.co/300x200?text=Culotte+1"]'),
  ('String 2', 'String', 6550, 0, '🩲', '["https://placehold.co/300x200?text=String+2"]'),
  ('Caleçon 1', 'Caleçon', 21000, 8, '🩳', '["https://placehold.co/300x200?text=Caleçon+1"]'),
  ('Culotte 2', 'Culotte', 3490, 20, '🎀', '["https://placehold.co/300x200?text=Culotte+2"]'),
  ('String 3', 'String', 7900, 3, '🩲', '["https://placehold.co/300x200?text=String+3"]'),
  ('String 4', 'String', 2990, 15, '🩲', '["https://placehold.co/300x200?text=String+4"]'),
  ('String 5', 'String', 24900, 6, '🩲', '["https://placehold.co/300x200?text=String+5"]');

