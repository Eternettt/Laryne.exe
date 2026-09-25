-- À exécuter UNE SEULE FOIS dans la base (Vercel > Storage > ta base Postgres > Query),
-- APRÈS migration-livraison.sql et AVANT de déployer les nouveaux fichiers api/ + lib/.
-- Sans ces colonnes, le webhook Stripe et la liste des commandes admin renverraient une erreur 500.
-- Sans danger si tu la relances : chaque instruction ci-dessous ne fait rien si elle a déjà
-- été appliquée (voir le bloc "do $$ ... $$" plus bas pour le détail du cas particulier).

-- Remboursements : on garde l'identifiant du paiement Stripe (nécessaire pour rembourser)
-- et le montant déjà remboursé (en centimes). Ces 3 colonnes ne changent aucune donnée
-- existante : elles sont ajoutées vides (NULL, ou 0 pour refunded_cents).
alter table orders add column if not exists payment_intent_id text;
alter table orders add column if not exists refunded_cents    integer not null default 0;
alter table orders add column if not exists refunded_at       timestamptz;

-- E-mail de confirmation : évite d'envoyer deux fois le même mail (Stripe peut renvoyer
-- un événement webhook plusieurs fois). La colonne s'accompagne d'un rattrapage : les
-- commandes DÉJÀ payées avant cette mise à jour sont marquées "mail déjà traité", pour ne
-- pas envoyer un mail de confirmation tardif à d'anciens clients qui ont déjà reçu leur
-- commande depuis longtemps.
--
-- Ce rattrapage doit avoir lieu UNE SEULE FOIS, à l'instant précis où la colonne est créée
-- — jamais plus tard, sinon il marquerait aussi comme "déjà envoyées" de nouvelles
-- commandes dont le mail aurait simplement échoué (elles ne recevraient alors jamais leur
-- confirmation). Le bloc ci-dessous le garantit tout seul : il vérifie que la colonne
-- n'existe pas encore avant de l'ajouter ET de faire le rattrapage dans la même opération ;
-- si tu relances cette migration (colonne déjà présente), tout le bloc est ignoré.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'orders' and column_name = 'confirmation_email_sent_at'
  ) then
    alter table orders add column confirmation_email_sent_at timestamptz;
    update orders set confirmation_email_sent_at = now() where status = 'paid';
  end if;
end $$;
