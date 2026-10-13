-- ============================================================================
-- migration-mail-club.sql
-- Mail Club : abonnements, envois mensuels, historique des modifications.
--
-- 100 % ADDITIVE : crée 3 tables, ne modifie AUCUNE table existante
-- (orders, users, products... restent telles quelles).
-- Rejouable sans risque (create table if not exists).
--
-- La table "orders" est la seule référence utilisée : la colonne order_id
-- prend automatiquement le MÊME TYPE que orders.id (uuid, integer, bigint...),
-- lu dans le catalogue Postgres, pour ne pas dépendre d'un schéma que je n'ai
-- pas sous les yeux.
--
-- À exécuter UNE fois, sur la base choisie, quand tu l'as décidé
-- (voir les instructions dans le rapport).
-- ============================================================================

do $$
declare
  orders_id_type text;
begin
  select format_type(a.atttypid, a.atttypmod)
    into orders_id_type
  from pg_attribute a
  where a.attrelid = 'public.orders'::regclass
    and a.attname = 'id'
    and not a.attisdropped;

  if orders_id_type is null then
    raise exception 'Table orders.id introuvable : migration annulée.';
  end if;

  -- Un abonnement = une commande payée (order_id unique => jamais 2 abonnements pour 1 paiement).
  execute format($f$
    create table if not exists mail_club_subscriptions (
      id               bigint generated always as identity primary key,
      order_id         %s not null unique references orders(id),
      customer_name    text,
      customer_email   text,
      contact_note     text,
      phone            text,
      delivery         text not null check (delivery in ('FR', 'INTL')),
      shipping_name    text,
      shipping_address jsonb,
      months           integer not null check (months in (1, 3, 6, 9)),
      total_shipments  integer not null check (total_shipments between 1 and 9),
      price_cents      integer not null check (price_cents >= 0),
      shipping_cents   integer not null check (shipping_cents >= 0),
      start_date       date not null,
      end_date         date not null,
      created_at       timestamptz not null default now()
    )
  $f$, orders_id_type);
end $$;

-- Un envoi par mois payé. (abonnement, n°) unique => aucun doublon possible,
-- même si le webhook Stripe est rejoué. sent_at null = à envoyer.
create table if not exists mail_club_shipments (
  id              bigint generated always as identity primary key,
  subscription_id bigint not null references mail_club_subscriptions(id),
  seq             integer not null check (seq >= 1),
  due_date        date not null,
  sent_at         timestamptz,
  unique (subscription_id, seq)
);

create index if not exists mail_club_shipments_due_idx
  on mail_club_shipments (subscription_id, sent_at);

-- Historique des changements (marqué envoyé / correction), jamais supprimé.
create table if not exists mail_club_events (
  id              bigint generated always as identity primary key,
  subscription_id bigint not null references mail_club_subscriptions(id),
  shipment_id     bigint not null references mail_club_shipments(id),
  seq             integer not null,
  action          text not null check (action in ('sent', 'unsent')),
  admin_user_id   text,
  created_at      timestamptz not null default now()
);

create index if not exists mail_club_events_sub_idx
  on mail_club_events (subscription_id, created_at);
