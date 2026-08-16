# Laryne.exe — Mise en place (base de données + Stripe + Vercel)

Ce dossier contient tout ton site, **plus** une vraie architecture serveur :
base de données Postgres (comptes, produits, stock, commandes), paiement
Stripe réel, sessions sécurisées par cookie. Il n'y a plus de mot de passe
ni de données produits/commandes stockées uniquement dans le navigateur.

## Comment ça marche maintenant

- **Base de données (Vercel Postgres / Neon)** : stocke les comptes, les
  produits/stock, et les commandes. C'est la seule source de vérité — voir
  `db/schema.sql`.
- **`api/*.js`** : fonctions serverless Vercel. Toutes les actions sensibles
  (prix, stock, statut de paiement, droits admin) sont calculées/vérifiées
  ici, jamais dans le navigateur.
- **Sessions** : cookie `httpOnly` posé par le serveur (`lib/session.js`) —
  ni `localStorage` ni `sessionStorage` ne contiennent d'information de
  connexion.
- **`success.html`** : affiche le statut réel de la commande (interrogé côté
  serveur), pas un statut que la page elle-même déclarerait.

## Étapes de mise en place

### 1. Crée un compte Stripe
https://dashboard.stripe.com/register (gratuit, commission par transaction).

### 2. Récupère ta clé secrète de TEST
Stripe → **Développeurs → Clés API** → copie la clé qui commence par
`sk_test_...` (reste en mode Test pour l'instant).

### 3. Crée un compte Vercel et mets le projet sur GitHub
- https://vercel.com/signup (connecte-toi avec GitHub, le plus simple).
- Crée un dépôt GitHub (ex. `stringz-exe`), mets-y tous les fichiers de ce
  dossier (`git init`, `git add .`, `git commit`, `git push`).

### 4. Crée la base de données Postgres
- Dans ton projet Vercel → onglet **Storage** → "Create Database" →
  **Postgres** (propulsé par Neon). Suis l'assistant.
- Une fois créée, Vercel connecte automatiquement la base à ton projet et
  injecte les variables d'environnement nécessaires (`POSTGRES_URL`, etc.)
  — tu n'as rien à copier-coller toi-même.

### 5. Exécute le schéma SQL (une seule fois)
Dans Vercel → **Storage** → ta base → onglet **Query** (ou "Data"), colle le
contenu de `db/schema.sql` et exécute-le. Ça crée les tables et insère les 8
produits de départ.

Alternative en ligne de commande, si tu préfères :
```
psql "$POSTGRES_URL" -f db/schema.sql
```
(la valeur de `$POSTGRES_URL` se trouve dans Vercel → Storage → ta base →
onglet ".env.local" / "Quickstart")

### 6. Récupère les variables d'environnement en local (pour créer ton compte admin)
```
npm install -g vercel      # si pas déjà fait
vercel link                # relie ce dossier à ton projet Vercel
vercel env pull .env.local # télécharge les variables (dont POSTGRES_URL)
```

### 7. Crée ton compte admin
```
npm install
node -r dotenv/config scripts/create-admin.js "toi@exemple.com" "TonMotDePasse" "TonPseudo"
```
(si `dotenv` n'est pas installé : `npm install dotenv --save-dev`, ou exporte
manuellement les variables de `.env.local` dans ton terminal avant de lancer
la commande).

Ce mot de passe n'est stocké NULLE PART en clair — ni dans le code, ni dans
un fichier du dépôt : uniquement son hash, en base de données.

### 8. Configure les variables d'environnement sur Vercel
Vercel → ton projet → **Settings → Environment Variables** — les variables
`POSTGRES_*` sont déjà là (étape 4). Ajoute en plus :

| Nom | Valeur |
|---|---|
| `STRIPE_SECRET_KEY` | ta clé `sk_test_...` de l'étape 2 |
| `STRIPE_WEBHOOK_SECRET` | voir étape 10 ci-dessous |
| `SESSION_SECRET` | une longue chaîne aléatoire secrète (ex. `openssl rand -hex 32`) |

Puis **redéploie** (Vercel → Deployments → "Redeploy") pour que les nouvelles
variables soient prises en compte.

### 9. Teste un paiement
Numéro de carte de test Stripe : `4242 4242 4242 4242`, date future, CVC
quelconque. Passe une commande sur ton site déployé.

### 10. Configure le webhook Stripe (obligatoire pour que les commandes passent "payées")
- Stripe → **Développeurs → Webhooks** → "Add endpoint".
- URL : `https://ton-site.vercel.app/api/webhook`
- Événements à écouter : `checkout.session.completed`,
  `checkout.session.async_payment_succeeded`, `checkout.session.expired`,
  `checkout.session.async_payment_failed`.
- Stripe te donne un "Signing secret" (`whsec_...`) → mets-le dans
  `STRIPE_WEBHOOK_SECRET` (étape 8), puis redéploie.
- **Sans cette étape**, les commandes restent bloquées au statut "pending"
  pour toujours, même après un paiement réussi.

### 11. Passe en mode réel
- Active ton compte Stripe (infos bancaires, etc.).
- Récupère tes clés/secrets de **production** (`sk_live_...`, webhook en
  mode live) et remplace les variables Vercel correspondantes.
- Redéploie.

## Tables créées (voir db/schema.sql)

| Table | Contenu |
|---|---|
| `users` | comptes, mot de passe hashé (scrypt), rôle (`user`/`admin`) |
| `products` | catalogue, prix en centimes, stock |
| `orders` | une commande (panier ou création perso), statut, montant total |
| `order_items` | le détail (produits + quantités + prix figé) d'une commande |
| `processed_webhook_events` | anti-doublon des événements Stripe déjà traités |

## ⚠️ Points importants

- **Ne mets jamais** de clé secrète, mot de passe ou `SESSION_SECRET`
  directement dans le code HTML/JS — uniquement dans les variables
  d'environnement Vercel.
- Les tables de prix `CUSTOM_*` du configurateur "Commande perso" (dans
  `api/create-checkout-session.js`) doivent être tenues à jour manuellement
  si tu changes les tarifs affichés sur `commande_perso.html`.
- Un produit désactivé depuis le panneau Gestion (bouton "Supprimer")
  n'est pas effacé de la base — il passe juste `active = false`, pour ne
  jamais casser l'historique des commandes qui le référencent. Tu peux le
  réactiver en base si besoin.
- **Anti-survente :** le stock est réservé (décrémenté) dès la création de
  la session de paiement — pas au webhook — via une requête SQL atomique
  (`UPDATE ... WHERE stock >= quantité`). Sous PostgreSQL, deux achats
  simultanés sur le même dernier exemplaire se sérialisent automatiquement :
  il est structurellement impossible d'en vendre plus que le stock
  disponible, même en cas de forte concurrence (testé avec jusqu'à 30
  acheteur·ses simultané·es sur un stock de 5 — voir `test/stress-concurrency.js`).
  Si le paiement n'aboutit pas (session expirée après 30 minutes, ou paiement
  échoué), le stock réservé est automatiquement relâché par le webhook. Dans
  le cas exceptionnel où un paiement se confirme en retard alors que le
  stock libéré a déjà été repris par quelqu'un d'autre, la commande est
  **remboursée automatiquement** via l'API Stripe (aucune intervention
  manuelle nécessaire).
- Voir le rapport d'audit pour le détail des tests effectués et les points
  encore à vérifier après déploiement réel (le code a été testé contre une
  vraie base SQLite locale, faute d'accès réseau à Postgres/Stripe pendant
  son développement — une vérification en conditions réelles après mise en
  ligne reste recommandée).
