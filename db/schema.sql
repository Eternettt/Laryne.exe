-- ==========================================================================
-- db/schema.sql — Schéma de la base Postgres de Stringz.exe
-- ==========================================================================
-- À exécuter UNE FOIS sur ta base Vercel Postgres (voir LISEZ-MOI.md pour
-- comment lancer ce script). Utilise "if not exists" partout, donc peut
-- être relancé sans danger.
-- ==========================================================================

create table if not exists users (
  id serial primary key,
  email text unique not null,
  password_hash text not null default '',
  password_salt text not null default '',
  name text not null default '',
  role text not null default 'user',           -- 'user' ou 'admin'
  created_at timestamptz not null default now(),
  deleted_at timestamptz                        -- rempli = compte supprimé/anonymisé
);

create table if not exists products (
  id serial primary key,
  name text not null,
  category text not null default '',
  price_cents integer not null default 0,
  stock integer not null default 0,
  icon text not null default '',                -- emoji OU data:image;base64 (upload admin)
  images jsonb not null default '[]'::jsonb,     -- tableau d'URLs / data-uri
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  id serial primary key,
  stripe_session_id text unique,
  user_id integer references users(id),
  customer_email text,
  status text not null default 'pending',       -- pending / paid / failed
  items jsonb not null default '[]'::jsonb,
  total_cents integer not null default 0,
  linked_to_account boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_orders_user on orders(user_id);
create index if not exists idx_orders_stripe_session on orders(stripe_session_id);
create index if not exists idx_users_email on users(email);

-- ---- Quelques produits de départ (facultatif, à adapter ou supprimer) ----
insert into products (name, category, price_cents, stock, icon, images)
select * from (values
  ('String dentelle rose', 'String', 2490, 12, '🩲', '["https://placehold.co/300x200?text=String"]'::jsonb),
  ('Culotte classique noire', 'Culotte', 2990, 8, '🎀', '["https://placehold.co/300x200?text=Culotte"]'::jsonb)
) as seed(name, category, price_cents, stock, icon, images)
where not exists (select 1 from products);
