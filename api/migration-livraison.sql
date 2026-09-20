-- À exécuter UNE FOIS dans la base (Vercel > Storage > ta base Postgres > Query)
-- AVANT de déployer les nouveaux fichiers api/. Sans ces colonnes, la liste
-- des commandes admin et le webhook Stripe renverraient une erreur 500.
-- Sans danger si tu le relances : "if not exists" ignore ce qui existe déjà.

alter table orders add column if not exists shipping_name    text;
alter table orders add column if not exists shipping_address jsonb;
alter table orders add column if not exists shipping_cents   integer;
alter table orders add column if not exists shipped_at       timestamptz;
