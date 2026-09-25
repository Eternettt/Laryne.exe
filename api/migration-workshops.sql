-- À exécuter UNE SEULE FOIS dans la base (Vercel > Storage > ta base Postgres > Query),
-- AVANT de déployer les nouveaux fichiers (api/products.js, admin.html, workshop.html,
-- shared-data.js). Sans cette table, la liste des ateliers retombe sur l'atelier par
-- défaut et l'admin affichera une erreur à l'enregistrement.
-- Sans danger si tu la relances : "if not exists" ignore ce qui existe déjà, sans toucher
-- aux lignes déjà présentes.
--
-- Peut être exécutée avant OU après migration-diaporama.sql : les deux créent la même
-- table "site_settings" (avec exactement la même définition — les ateliers y sont stockés
-- sous la clé "workshops", le diaporama sous la clé "diaporama", sans conflit entre les
-- deux). Quel que soit l'ordre, la deuxième des deux migrations trouve la table déjà créée
-- et ignore cette instruction sans erreur. Ce fichier est volontairement autonome (il
-- fonctionne même si tu ne l'exécutes pas juste après migration-diaporama.sql).

create table if not exists site_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
