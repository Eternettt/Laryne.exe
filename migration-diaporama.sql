-- À exécuter UNE SEULE FOIS dans la base (Vercel > Storage > ta base Postgres > Query),
-- AVANT de déployer les nouveaux fichiers (api/products.js, admin.html, index.html, shared-data.js).
-- Sans ces tables, le diaporama de l'accueil retombe sur les photos par défaut
-- (photo1.jpg, photo2.jpg, photo3.jpg) et l'admin affichera une erreur à l'enregistrement.
-- Sans danger si tu la relances : "if not exists" ignore ce qui existe déjà, sans toucher
-- aux lignes déjà présentes.
--
-- Peut être exécutée avant OU après migration-workshops.sql : les deux créent la même
-- table "site_settings" (avec exactement la même définition), pour partager les réglages
-- du site entre plusieurs fonctionnalités. Quel que soit l'ordre, la deuxième des deux
-- migrations trouve la table déjà créée et ignore cette instruction sans erreur.

-- Réglages du site (clé -> valeur JSON). Sert ici à mémoriser la liste ordonnée
-- des photos du diaporama, partagée par TOUS les visiteurs. Partagée avec les ateliers
-- (voir migration-workshops.sql), sous une autre clé ("diaporama" vs "workshops").
create table if not exists site_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Photos envoyées depuis l'admin (compressées côté navigateur, ~200-600 Ko chacune).
-- "data" = contenu de l'image en base64 ; servie ensuite par /api/products?diapo=img&id=...
-- Propre au diaporama : aucune autre migration n'y touche.
create table if not exists diaporama_images (
  id         serial primary key,
  mime       text not null,
  data       text not null,
  created_at timestamptz not null default now()
);
