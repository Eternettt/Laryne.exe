-- À exécuter UNE SEULE FOIS dans la base (Vercel > Storage > ta base Postgres > Query),
-- APRÈS migration-livraison.sql et AVANT de déployer les nouveaux fichiers api/ + lib/.
-- Sans ces colonnes, le webhook Stripe et la liste des commandes admin renverraient une erreur 500.

-- Remboursements : on garde l'identifiant du paiement Stripe (nécessaire pour rembourser)
-- et le montant déjà remboursé (en centimes).
alter table orders add column if not exists payment_intent_id text;
alter table orders add column if not exists refunded_cents    integer not null default 0;
alter table orders add column if not exists refunded_at       timestamptz;

-- E-mail de confirmation : évite d'envoyer deux fois le même mail
-- (Stripe peut renvoyer un événement webhook plusieurs fois).
alter table orders add column if not exists confirmation_email_sent_at timestamptz;

-- Les commandes DÉJÀ payées avant cette mise à jour sont marquées "mail déjà traité",
-- pour ne pas envoyer de confirmation tardive à d'anciens clients.
-- ⚠ Ne relance pas cette ligne plus tard : elle marquerait comme "envoyées"
--   de nouvelles commandes dont le mail aurait échoué.
update orders set confirmation_email_sent_at = now()
where status = 'paid' and confirmation_email_sent_at is null;
