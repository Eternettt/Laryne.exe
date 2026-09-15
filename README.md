# Stringz.exe

Boutique en ligne de lingerie artisanale, dans une interface façon vieux
bureau Windows : les produits sont des post-its épinglés sur un tableau, et
chaque fiche produit s'ouvre en petites fenêtres déplaçables.

Le site vend des modèles en stock, des créations sur mesure et des places
d'ateliers upcycling.

---

## Sommaire

- [Aperçu technique](#aperçu-technique)
- [Structure du projet](#structure-du-projet)
- [Installation et lancement](#installation-et-lancement)
- [Configuration](#configuration)
- [Créer un compte administrateur](#créer-un-compte-administrateur)
- [Le panneau d'administration](#le-panneau-dadministration)
- [Routes de l'API](#routes-de-lapi)
- [Base de données](#base-de-données)
- [Paiement Stripe](#paiement-stripe)
- [Sécurité](#sécurité)
- [Points connus / à faire](#points-connus--à-faire)

---

## Aperçu technique

| | |
|---|---|
| **Front-end** | HTML / CSS / JavaScript natifs, une page par section, aucun framework |
| **Back-end** | Fonctions serverless Node.js (dossier `api/`), déployées sur Vercel |
| **Base de données** | Postgres (Vercel Postgres / Neon) |
| **Authentification** | Session en cookie `httpOnly` signé, rôle revérifié en base à chaque requête |
| **Paiement** | Stripe Checkout + webhook de confirmation |
| **Hébergement** | Vercel |

Aucune étape de build : les pages HTML sont servies telles quelles, et
Vercel transforme automatiquement chaque fichier `.js` du dossier `api/` en
route serverless.

---

## Structure du projet

```
stringz/
├── index.html                  Page d'accueil (diaporama photo + présentation)
├── boutique.html               Boutique : post-its produits, fiches détail, panier
├── workshop.html               Ateliers upcycling et inscription
├── connexion.html              Création de compte / connexion
├── admin.html                  Panneau d'administration
├── success.html                Page de retour après paiement Stripe
├── shared-data.js              Fonctions partagées entre toutes les pages
│
├── api/                        Routes serverless (voir « Routes de l'API »)
│   ├── products.js
│   ├── auth/                   signup, login, logout, me
│   ├── account/delete.js
│   ├── orders/                 index.js, by-session.js
│   ├── admin/                  products.js, orders.js
│   ├── create-checkout-session.js
│   └── webhook.js
│
├── lib/
│   ├── db.js                   Connexion Postgres
│   └── session.js              Cookie de session, vérification du rôle
│
├── db/
│   └── schema.sql              Tables users, products, orders
│
├── scripts/
│   └── create-admin.js         Crée ou promeut un compte administrateur
│
├── _env.example                Modèle de variables d'environnement
├── package.json
└── vercel.json
```

### `shared-data.js`

Inclus **avant** le script principal de chaque page :

```html
<script src="shared-data.js"></script>
```

Il expose les fonctions communes à tout le site :

- `stringzEscapeHtml(value)` — échappement HTML (protection XSS)
- `stringzApiFetch(path, options)` — wrapper `fetch` JSON qui envoie toujours le cookie de session
- `stringzMe()`, `stringzSignup()`, `stringzLogin()`, `stringzLogout()`, `stringzDeleteAccount()`
- `stringzFetchProducts()` et les fonctions admin `stringzAdminListProducts()`, `stringzAdminCreateProduct()`, `stringzAdminUpdateProduct()`, `stringzAdminDeleteProduct()`
- `stringzFetchMyOrders()`, `stringzFetchOrderBySession()`, `stringzAdminListOrders()`
- Diaporama et ateliers : `stringzLoadDiapo()`, `stringzSaveDiapo()`, `stringzLoadWorkshops()`, `stringzSaveWorkshops()` (stockés en `localStorage`)

---

## Installation et lancement

### Prérequis

- Node.js 18 ou plus
- Un compte Vercel
- Un compte Stripe

### En local

```bash
git clone <url-du-depot>
cd stringz
npm install

vercel link              # relie le dossier au projet Vercel (une seule fois)
vercel env pull .env.local   # récupère les variables d'environnement
vercel dev               # démarre le site + les routes /api sur localhost:3000
```

### Déploiement

```bash
git push        # déploiement automatique via l'intégration Git
# ou
vercel --prod
```

---

## Configuration

Variables à définir dans **Project Settings → Environment Variables** sur
Vercel (un modèle se trouve dans `_env.example`) :

| Variable | Rôle |
|---|---|
| `POSTGRES_URL` et autres `POSTGRES_*` | Remplies automatiquement en connectant la base au projet |
| `SESSION_SECRET` | Clé de signature des cookies de session — `openssl rand -hex 32` |
| `STRIPE_SECRET_KEY` | Clé secrète Stripe (`sk_...`) |
| `STRIPE_WEBHOOK_SECRET` | Signing secret du webhook (`whsec_...`), obtenu à la création du webhook |

Après ajout ou modification d'une variable, **redéployer** pour qu'elle soit
prise en compte.

---

## Créer un compte administrateur

Une fois les tables créées et le projet déployé :

```bash
vercel env pull .env.local
node scripts/create-admin.js toi@exemple.com "mot-de-passe-solide" "Ton nom"
```

Le script crée le compte avec `role = 'admin'`. Il peut être relancé sur un
e-mail existant pour promouvoir ce compte ou réinitialiser son mot de passe.

Connexion ensuite sur `connexion.html` avec ces identifiants : `admin.html`
laisse alors entrer, après revérification du rôle côté serveur.

---

## Le panneau d'administration

`admin.html` est organisé en trois sections :

**Diaporama** — Les photos de la page d'accueil (ajout, remplacement,
suppression). Stockées en `localStorage`.

**Boutique** — Les modèles : nom, prix, stock, description, types
disponibles (string, tanga, culotte, shorty, boxer, brésilienne…), icône ou
photo de vignette, et galerie d'images. Toute modification part
immédiatement en base via `/api/admin/products` et se répercute sur la
boutique.

**Ateliers** — Les ateliers upcycling affichés sur `workshop.html` : date,
lieu, prix, acompte, nombre de places, description. Stockés en
`localStorage`.

Certaines actions d'administration (remplacer, ajouter ou supprimer une
image d'un modèle) sont aussi accessibles directement depuis la fiche
produit de `boutique.html` quand on est connecté en admin.

---

## Routes de l'API

| Route | Rôle |
|---|---|
| `GET /api/products` | Liste publique des produits |
| `GET/POST/PUT/DELETE /api/admin/products` | CRUD produits — admin uniquement |
| `POST /api/auth/signup` | Créer un compte |
| `POST /api/auth/login` | Se connecter |
| `POST /api/auth/logout` | Se déconnecter |
| `GET /api/auth/me` | Session actuelle, revérifiée en base |
| `POST /api/account/delete` | Supprimer / anonymiser son compte |
| `GET /api/orders` | Mes commandes — connecté |
| `GET /api/orders/by-session?session_id=...` | Commande liée à une session Stripe (page de succès) |
| `GET /api/admin/orders` | Toutes les commandes — admin uniquement |
| `POST /api/create-checkout-session` | Démarre un paiement Stripe (panier, création perso, acompte atelier) |
| `POST /api/webhook` | Reçoit la confirmation de paiement Stripe |

---

## Base de données

Le schéma (`db/schema.sql`) définit trois tables :

- **`users`** — comptes clients et administrateurs (`role` vaut `user` ou `admin`), mots de passe hachés
- **`products`** — modèles de la boutique : nom, prix, stock, description, types, images
- **`orders`** — commandes, avec leur statut et la référence de session Stripe

Pour créer les tables : onglet **Storage** du projet Vercel → ouvrir la base
→ **Query** → coller le contenu de `db/schema.sql` → exécuter.

En local, si `psql` est installé :

```bash
psql "$POSTGRES_URL_NON_POOLING" -f db/schema.sql
```

---

## Paiement Stripe

C'est le **webhook** qui confirme réellement un paiement, jamais le
navigateur. Sans lui, les commandes restent bloquées en `pending` et le
stock ne descend jamais.

Configuration, sur le [dashboard Stripe](https://dashboard.stripe.com/webhooks) :

1. **Add endpoint**
2. URL : `https://ton-domaine.vercel.app/api/webhook`
3. Événements : `checkout.session.completed`, `checkout.session.expired`,
   `checkout.session.async_payment_failed`
4. Copier le **Signing secret** (`whsec_...`) dans la variable
   `STRIPE_WEBHOOK_SECRET`, puis redéployer

Pour tester en local avec la Stripe CLI :

```bash
stripe listen --forward-to localhost:3000/api/webhook
```

Carte de test : `4242 4242 4242 4242`, n'importe quelle date future,
n'importe quel CVC.

---

## Sécurité

- La session vit dans un cookie `httpOnly` signé : illisible et non
  falsifiable depuis le JavaScript de la page.
- Le rôle administrateur est revérifié **en base**, côté serveur, à chaque
  appel — jamais sur la foi d'un drapeau envoyé par le navigateur.
- Les prix, le stock et les commandes ne sont lus que depuis la base : le
  montant d'un paiement n'est jamais calculé par le navigateur.
- Tout texte venant d'un utilisateur ou de la base passe par
  `stringzEscapeHtml()` avant d'être inséré dans la page.
- L'accès admin est fermé par défaut (*fail-closed*) tant que la
  vérification serveur n'a pas répondu.

---

## Points connus / à faire

- **Diaporama et ateliers en `localStorage`** — ce ne sont pas des données
  financières critiques, mais tant qu'ils ne sont pas en base, ils ne sont
  visibles que sur le navigateur qui les a enregistrés, et le prix d'un
  acompte reste modifiable côté client. À migrer sur le même modèle que
  `products`.
- **Images en base64** — les photos de produits sont stockées directement en
  base, ce qui alourdit la table et les réponses de `/api/products`. Mieux
  vaudrait les envoyer sur un service de stockage et ne garder que les URL.
- **Produits de démonstration** — si `/api/products` ne renvoie rien,
  `boutique.html` affiche cinq modèles d'exemple pour prévisualiser le
  rendu. Ils ne sont pas enregistrables et disparaissent dès que la base
  contient de vrais produits.

---

## Checklist après déploiement

- [ ] `boutique.html` affiche les produits venant de la base
- [ ] Créer un compte, se déconnecter, se reconnecter depuis `connexion.html`
- [ ] Paiement test → `success.html` affiche la commande confirmée
- [ ] `admin.html` accessible avec le compte admin, modifications répercutées sur la boutique
- [ ] Le stock descend après un paiement confirmé
