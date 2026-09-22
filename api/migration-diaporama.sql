-- À exécuter UNE SEULE FOIS dans la base (Vercel > Storage > ta base Postgres > Query),
-- AVANT de déployer les nouveaux fichiers (api/products.js, admin.html, index.html, shared-data.js).
-- Sans ces tables, le diaporama de l'accueil retombe sur les photos par défaut
-- (photo1.jpg, photo2.jpg, photo3.jpg) et l'admin affichera une erreur à l'enregistrement.
-- Sans danger si tu le relances : "if not exists" ignore ce qui existe déjà.

-- Réglages du site (clé -> valeur JSON). Sert ici à mémoriser la liste ordonnée
-- des photos du diaporama, partagée par TOUS les visiteurs.
create table if not exists site_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

-- Photos envoyées depuis l'admin (compressées côté navigateur, ~200-600 Ko chacune).
-- "data" = contenu de l'image en base64 ; servie ensuite par /api/products?diapo=img&id=...
create table if not exists diaporama_images (
  id         serial primary key,
  mime       text not null,
  data       text not null,
  created_at timestamptz not null default now()
);
