# Stringz.exe — Mise en place du vrai paiement (Stripe + Vercel)

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
- Avant de cliquer "Deploy", va dans **Environment Variables** et ajoute :
  - Nom : `STRIPE_SECRET_KEY`
  - Valeur : ta clé `sk_test_...` récupérée à l'étape 2
- Clique "Deploy". Après ~1 minute, ton site est en ligne avec une URL du
  type `stringz-exe.vercel.app`.

### 6. Teste un paiement
Stripe fournit des numéros de carte de test, par exemple :
`4242 4242 4242 4242`, n'importe quelle date future, n'importe quel CVC.
Passe une commande sur ton site déployé et vérifie que ça fonctionne.

### 7. Passe en mode réel (quand tu es prêt à vendre pour de vrai)
- Dans Stripe, active ton compte (infos bancaires, société/auto-entreprise,
  etc. — Stripe te guide).
- Récupère ta clé secrète de **production** (`sk_live_...`).
- Remplace la variable d'environnement `STRIPE_SECRET_KEY` dans Vercel par
  cette clé live, puis redéploie.

## ⚠️ Points importants

- **Ne mets jamais** ta clé secrète directement dans le code HTML/JS — elle
  doit rester uniquement dans les variables d'environnement Vercel.
- La liste `PRODUCTS` dans `api/create-checkout-session.js` doit être tenue
  à jour manuellement pour l'instant (elle sert de "source de vérité" des
  prix côté serveur, pour que personne ne puisse trafiquer les prix depuis
  le navigateur). Si tu ajoutes/modifies un article dans le panneau Gestion,
  pense à répercuter le changement ici aussi.
- Pour du stock/inventaire fiable (décrémenté seulement si le paiement
  aboutit vraiment), l'étape suivante serait d'ajouter un **webhook Stripe**
  — dis-le moi quand tu en seras là, je peux te le mettre en place.
