# Stringz.exe — Brancher la base de données et Stripe

Ce dossier `backend/` contient tout le code serveur qui manquait : les
routes `/api/*`, la connexion à la base Postgres, l'authentification et le
paiement Stripe. Voici comment tout assembler et configurer, étape par
étape.

## 0. Où placer ces fichiers

À la racine de ton projet Vercel (là où sont déjà `index.html`,
`vercel.json`, `package.json`...), copie les dossiers/fichiers de ce
`backend/` tels quels :

```
ton-projet/
├── api/                  ← copié depuis backend/api/
├── lib/                  ← copié depuis backend/lib/
├── db/                   ← copié depuis backend/db/
├── scripts/              ← copié depuis backend/scripts/
├── _env.example          ← remplace l'ancien
├── index.html, boutique.html, ... (déjà existants)
├── package.json (déjà existant)
└── vercel.json (déjà existant)
```

Vercel détecte automatiquement tout fichier `.js` dans `api/` (et ses
sous-dossiers) comme une route serverless. Aucune configuration
supplémentaire n'est nécessaire pour ça.

## 1. Créer la base de données Postgres sur Vercel

1. Sur [vercel.com](https://vercel.com), ouvre ton projet.
2. Onglet **Storage** → **Create Database** → choisis **Postgres** (propulsé
   par Neon).
3. Donne-lui un nom, valide. Vercel te propose de la **connecter au
   projet** → accepte : ça remplit automatiquement les variables
   `POSTGRES_URL`, `POSTGRES_HOST`, etc. dans les Environment Variables du
   projet (Production **et** Preview). Tu n'as rien à copier toi-même.

## 2. Créer les tables (schéma)

Le fichier `db/schema.sql` crée les tables `users`, `products`, `orders`.

Le plus simple : dans l'onglet **Storage** de ton projet Vercel, ouvre ta
base → bouton **Query** (éditeur SQL intégré) → colle le contenu de
`db/schema.sql` → exécute.

(Alternative en local : `vercel env pull .env.local` puis
`psql "$POSTGRES_URL_NON_POOLING" -f db/schema.sql` si tu as `psql`
installé.)

## 3. Variables d'environnement à ajouter sur Vercel

Project Settings → **Environment Variables**, ajoute (en plus de
`STRIPE_SECRET_KEY` qui existe déjà) :

| Variable | Valeur |
|---|---|
| `SESSION_SECRET` | une longue chaîne aléatoire (génère-la avec `openssl rand -hex 32` dans un terminal, ou n'importe quel générateur de mot de passe long) |
| `STRIPE_WEBHOOK_SECRET` | voir étape 5 ci-dessous, tu l'obtiens après avoir créé le webhook |

Les variables `POSTGRES_*` sont déjà là depuis l'étape 1 — ne les touche pas.

## 4. Créer ton premier compte administrateur

Une fois les tables créées et le projet déployé :

```bash
vercel link                       # une fois, relie ton dossier local au projet Vercel
vercel env pull .env.local        # récupère les vraies variables (POSTGRES_*, etc.)
node scripts/create-admin.js toi@exemple.com "un-mot-de-passe-solide" "Ton nom"
```

Ça crée un compte avec `role = 'admin'`. Connecte-toi ensuite normalement
sur `connexion.html` avec ces identifiants : `admin.html` te laissera
entrer (il revérifie le rôle côté serveur via `/api/auth/me`).

Tu peux relancer ce script plus tard sur un e-mail existant pour le
promouvoir admin ou réinitialiser son mot de passe.

## 5. Configurer le webhook Stripe

Le webhook est ce qui confirme *réellement* qu'un paiement a réussi (jamais
le navigateur seul) — indispensable, sinon les commandes resteront
éternellement "pending" et le stock ne descendra jamais.

1. Sur le [dashboard Stripe](https://dashboard.stripe.com/webhooks) →
   **Add endpoint**.
2. URL à renseigner : `https://ton-domaine.vercel.app/api/webhook`
3. Événements à écouter : `checkout.session.completed`,
   `checkout.session.expired`, `checkout.session.async_payment_failed`.
4. Une fois créé, Stripe affiche un **Signing secret** (`whsec_...`) →
   copie-le dans la variable Vercel `STRIPE_WEBHOOK_SECRET` (étape 3).
5. Redéploie le projet pour que la nouvelle variable soit prise en compte.

En mode test, tu peux aussi utiliser `stripe listen --forward-to
localhost:3000/api/webhook` avec la Stripe CLI pour tester en local.

## 6. Redéployer

Une fois les fichiers copiés et les variables ajoutées, un simple push /
redeploy sur Vercel suffit. Vérifie ensuite :

- `boutique.html` → le panier doit afficher les produits venant de la base
  (ceux insérés par `db/schema.sql`, modifiables depuis `admin.html`).
- `connexion.html` → créer un compte, se déconnecter, se reconnecter.
- Un vrai paiement test avec une carte Stripe de test (`4242 4242 4242
  4242`, n'importe quelle date future, n'importe quel CVC) → `success.html`
  doit afficher la commande confirmée après quelques secondes (le temps que
  le webhook arrive).
- `admin.html` avec ton compte admin → gestion des produits.

## Ce qui reste volontairement en localStorage

Le diaporama de la page d'accueil et les **ateliers** (`workshop.html`)
restent en localStorage, comme avant — ce ne sont pas des données
financières critiques. Si tu veux un jour les migrer en base aussi (pour
que le stock d'ateliers soit fiable et que le prix de l'acompte ne puisse
plus être modifié côté navigateur), dis-le-moi, c'est un ajout raisonnable
à faire ensuite sur le même modèle que `products`.

## Récap des routes créées

| Route | Rôle |
|---|---|
| `GET /api/products` | Liste publique des produits |
| `GET/POST/PUT/DELETE /api/admin/products` | CRUD produits (admin uniquement) |
| `POST /api/auth/signup` | Créer un compte |
| `POST /api/auth/login` | Se connecter |
| `POST /api/auth/logout` | Se déconnecter |
| `GET /api/auth/me` | Session actuelle (revérifiée en base) |
| `POST /api/account/delete` | Supprimer/anonymiser son compte |
| `GET /api/orders` | Mes commandes (connecté) |
| `GET /api/orders/by-session?session_id=...` | Commande par session Stripe (page succès) |
| `GET /api/admin/orders` | Toutes les commandes (admin uniquement) |
| `POST /api/create-checkout-session` | Démarre un paiement Stripe (panier / création perso / acompte atelier) |
| `POST /api/webhook` | Reçoit la confirmation de paiement Stripe |
