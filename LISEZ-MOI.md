# Laryne.exe — Mise en place du vrai paiement (Stripe + Vercel)

Ce dossier contient tout ton site **plus** ce qu'il faut pour que le bouton
"Passer commande" déclenche un vrai paiement par carte bancaire via Stripe.

## Comment ça marche

- `boutique.html` etc. → tes pages telles qu'elles étaient, avec juste la
  fonction `checkout()` modifiée.
- `api/create-checkout-session.js` → une petite fonction serveur qui parle à
  Stripe avec ta clé secrète (jamais visible dans le navigateur).
- `success.html` → page affichée après un paiement réussi.

## Étapes de mise en place

### 1. Crée un compte Stripe
Va sur https://dashboard.stripe.com/register (gratuit, pas de frais fixes,
juste une commission par transaction réussie).

### 2. Récupère ta clé secrète de TEST
Dans le tableau de bord Stripe → **Développeurs → Clés API** → copie la
"Clé secrète" qui commence par `sk_test_...` (reste en mode Test pour
l'instant, ça ne débite pas de vraies cartes).

### 3. Crée un compte Vercel
Va sur https://vercel.com/signup (gratuit). Connecte-toi avec GitHub de
préférence (le plus simple pour déployer).

### 4. Mets ce dossier sur GitHub
- Crée un nouveau dépôt GitHub (ex: `stringz-exe`).
- Mets tous les fichiers de ce dossier dedans (`git init`, `git add .`,
  `git commit`, `git push` — ou directement en glissant les fichiers sur
  github.com si tu ne connais pas encore Git).

### 5. Importe le projet dans Vercel
- Sur vercel.com → "Add New Project" → choisis ton dépôt GitHub.
- Avant de cliquer "Deploy", va dans **Environment Variables** et ajoute
  TOUTES les variables suivantes (sinon la connexion admin et le paiement
  ne fonctionneront pas) :

  | Nom | Valeur |
  |---|---|
  | `STRIPE_SECRET_KEY` | ta clé `sk_test_...` récupérée à l'étape 2 |
  | `STRIPE_WEBHOOK_SECRET` | voir étape 6 bis ci-dessous |
  | `ADMIN_EMAIL` | l'e-mail avec lequel tu te connectes en admin |
  | `ADMIN_PASSWORD_HASH` | généré avec `node scripts/hash-password.js "TonMotDePasse"` (voir ci-dessous) — **remplace l'ancien mot de passe `123456`** |
  | `SESSION_SECRET` | une longue chaîne aléatoire secrète (ex. 64 caractères, générée avec `openssl rand -hex 32`) |
  | `ADMIN_NAME` | (optionnel) le pseudo affiché, ex. `eternett` |

- Clique "Deploy". Après ~1 minute, ton site est en ligne avec une URL du
  type `stringz-exe.vercel.app`.

### 5 bis. Génère ton mot de passe admin (en local, sur ton ordinateur)
```
node scripts/hash-password.js "TonNouveauMotDePasse"
```
Copie la valeur affichée dans la variable Vercel `ADMIN_PASSWORD_HASH`. Le
mot de passe en clair n'a besoin d'être tapé nulle part d'autre : ni dans le
code, ni dans un fichier du dépôt.

### 6. Teste un paiement
Stripe fournit des numéros de carte de test, par exemple :
`4242 4242 4242 4242`, n'importe quelle date future, n'importe quel CVC.
Passe une commande sur ton site déployé et vérifie que ça fonctionne.

### 6 bis. Configure le webhook Stripe (vérifie vraiment qu'un paiement a réussi)
- Dans Stripe → **Développeurs → Webhooks** → "Add endpoint".
- URL : `https://ton-site.vercel.app/api/webhook`
- Événement à écouter : `checkout.session.completed`
- Stripe te donne alors un "Signing secret" (`whsec_...`) : mets-le dans la
  variable d'environnement Vercel `STRIPE_WEBHOOK_SECRET`, puis redéploie.

### 7. Passe en mode réel (quand tu es prêt à vendre pour de vrai)
- Dans Stripe, active ton compte (infos bancaires, société/auto-entreprise,
  etc. — Stripe te guide).
- Récupère ta clé secrète de **production** (`sk_live_...`) et ton
  "Signing secret" de webhook en mode production.
- Remplace les variables d'environnement `STRIPE_SECRET_KEY` et
  `STRIPE_WEBHOOK_SECRET` dans Vercel par ces valeurs live, puis redéploie.
- Choisis un mot de passe admin robuste et différent de tout ce que tu as
  utilisé ailleurs, et régénère `ADMIN_PASSWORD_HASH` avec.

## ⚠️ Points importants

- **Ne mets jamais** de clé secrète, mot de passe ou "SESSION_SECRET"
  directement dans le code HTML/JS — uniquement dans les variables
  d'environnement Vercel. Ce n'est déjà plus le cas dans ce dossier (voir le
  rapport d'audit), mais reste vigilant·e si tu modifies le code toi-même.
- La liste `PRODUCTS` dans `api/create-checkout-session.js`, ainsi que les
  tables de prix `CUSTOM_*` (pour le configurateur "Commande perso"),
  doivent être tenues à jour manuellement pour l'instant (elles servent de
  "source de vérité" des prix côté serveur, pour que personne ne puisse
  trafiquer les prix depuis le navigateur). Si tu ajoutes/modifies un
  article dans le panneau Gestion, pense à répercuter le changement ici
  aussi.
- **Limite importante à connaître :** ce site n'a pas de vraie base de
  données partagée. Les produits, l'historique d'achats et les comptes
  utilisateur·rices classiques ne sont mémorisés que dans le navigateur de
  chaque personne (localStorage), pas sur un serveur central. Concrètement :
  un changement fait dans le panneau Gestion ne sera visible **que sur
  l'appareil qui l'a fait**, pas pour tes client·es, et un compte créé via
  "Inscription" est perdu au rechargement de la page. Voir le rapport
  d'audit pour le détail et les pistes pour une vraie base de données.

