/* ==========================================================================
   shared-data.js — Source de données PARTAGÉE entre toutes les pages du site
   ==========================================================================
   Utilise localStorage : dans le même navigateur, toute modification faite
   depuis admin.html (ou le panneau Gestion de boutique.html) est visible
   immédiatement sur toutes les autres pages qui incluent ce script,
   dès qu'elles se (re)chargent.

   ⚠️ IMPORTANT (lire LISEZ-MOI.md) : comme il n'y a pas de vraie base de
   données partagée, les "produits" restent stockés uniquement dans le
   localStorage de CHAQUE navigateur. Une modification faite dans le panneau
   Gestion n'est donc visible que sur l'appareil qui l'a faite, pas pour vos
   client·es. C'est suffisant pour une démo, mais PAS pour un vrai site
   marchand multi-utilisateur : il faudra à terme une vraie base de données
   côté serveur pour les produits, les comptes et les commandes.

   Inclure AVANT le script principal de chaque page :
   <script src="shared-data.js"></script>
   ========================================================================== */

const STRINGZ_PRODUCTS_KEY = 'stringzProductsV1';
const STRINGZ_ADMIN_KEY = 'stringzAdmin';
const STRINGZ_ADMIN_TOKEN_KEY = 'stringzAdminToken';

const STRINGZ_DEFAULT_PRODUCTS = [
  { id: 1, name: "String 1", category: "String", price: 89.99, stock: 12, icon: "🩲", images: ["https://placehold.co/300x200?text=String+1"] },
  { id: 2, name: "Culotte 1", category: "Culotte", price: 149.00, stock: 5, icon: "🎀", images: ["https://placehold.co/300x200?text=Culotte+1"] },
  { id: 3, name: "String 2", category: "String", price: 65.50, stock: 0, icon: "🩲", images: ["https://placehold.co/300x200?text=String+2"] },
  { id: 4, name: "Caleçon 1", category: "Caleçon", price: 210.00, stock: 8, icon: "🩳", images: ["https://placehold.co/300x200?text=Caleçon+1"] },
  { id: 5, name: "Culotte 2", category: "Culotte", price: 34.90, stock: 20, icon: "🎀", images: ["https://placehold.co/300x200?text=Culotte+2"] },
  { id: 6, name: "String 3", category: "String", price: 79.00, stock: 3, icon: "🩲", images: ["https://placehold.co/300x200?text=String+3"] },
  { id: 7, name: "String 4", category: "String", price: 29.90, stock: 15, icon: "🩲", images: ["https://placehold.co/300x200?text=String+4"] },
  { id: 8, name: "String 5", category: "String", price: 249.00, stock: 6, icon: "🩲", images: ["https://placehold.co/300x200?text=String+5"] },
];

// ---- Échappe du texte avant de l'insérer en HTML (protection XSS) ----
// À utiliser systématiquement pour tout texte modifiable depuis le panneau
// Gestion (nom produit, catégorie, etc.) avant de l'injecter via innerHTML.
function stringzEscapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Charge les produits (localStorage si présent, sinon valeurs par défaut) ----
function stringzLoadProducts() {
  try {
    const raw = localStorage.getItem(STRINGZ_PRODUCTS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (e) { /* localStorage indisponible ou données corrompues */ }

  const defaults = JSON.parse(JSON.stringify(STRINGZ_DEFAULT_PRODUCTS));
  stringzSaveProducts(defaults);
  return defaults;
}

// ---- Sauvegarde les produits : visible instantanément sur les autres pages ----
function stringzSaveProducts(products) {
  try {
    localStorage.setItem(STRINGZ_PRODUCTS_KEY, JSON.stringify(products));
  } catch (e) { /* quota dépassé, images trop lourdes en base64, etc. */ }
}

// ==========================================================================
// ---- Mode admin ----
// ==========================================================================
// Sécurité : le statut admin affiché côté client (sessionStorage) ne sert
// qu'à AFFICHER ou MASQUER les boutons de gestion. Il n'est plus la source
// de vérité : il est posé UNIQUEMENT après une vérification réussie auprès
// de /api/login (voir connexion.html et index.html), qui compare le mot de
// passe à un hash stocké côté serveur (variables d'environnement Vercel) et
// renvoie un jeton signé (stringzAdminToken). Ce jeton n'est jamais un mot
// de passe : il ne prouve rien de plus que "le serveur a validé une
// connexion admin récente", et toute route serveur sensible doit le
// revérifier elle-même via /api/verify-session plutôt que de faire
// confiance à sessionStorage seul.
//
// Ancienne implémentation (retirée) : un mot de passe admin en clair vivait
// directement dans ce fichier JS, visible par n'importe qui ouvrant les
// outils de développement, et n'importe qui pouvait aussi s'auto-attribuer
// le rôle admin en tapant sessionStorage.setItem('stringzAdmin','true').
// Ce n'est plus possible pour les actions protégées côté serveur (paiement,
// vérification de session) ; ça reste techniquement possible pour
// l'affichage local du panneau Gestion tant que les produits eux-mêmes ne
// sont pas stockés côté serveur (voir avertissement en haut de ce fichier).
function stringzIsAdmin() {
  return sessionStorage.getItem(STRINGZ_ADMIN_KEY) === 'true';
}
function stringzSetAdmin(value) {
  if (value) sessionStorage.setItem(STRINGZ_ADMIN_KEY, 'true');
  else sessionStorage.removeItem(STRINGZ_ADMIN_KEY);
}
function stringzSetAdminToken(token) {
  if (token) sessionStorage.setItem(STRINGZ_ADMIN_TOKEN_KEY, token);
  else sessionStorage.removeItem(STRINGZ_ADMIN_TOKEN_KEY);
}
function stringzGetAdminToken() {
  return sessionStorage.getItem(STRINGZ_ADMIN_TOKEN_KEY) || '';
}

// ---- Tente une connexion admin auprès du serveur (jamais en local) ----
// Retourne { ok: true, name } ou { ok: false, error }.
async function stringzApiLogin(email, password) {
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.token) {
      stringzSetAdminToken(data.token);
      stringzSetAdmin(true);
      stringzMarkWasAdmin();
      return { ok: true, name: data.name || STRINGZ_ADMIN_NAME };
    }
    return { ok: false, error: data.error || 'Identifiants incorrects.' };
  } catch (e) {
    return { ok: false, error: "Impossible de contacter le serveur d'authentification." };
  }
}

// ---- Revérifie auprès du serveur que le jeton admin local est toujours
// valide (appelé au chargement de admin.html / boutique.html). Empêche
// qu'un jeton expiré, ou une valeur bricolée à la main, donne accès aux
// fonctions de gestion. ----
async function stringzVerifyAdminSession() {
  const token = stringzGetAdminToken();
  if (!token) { stringzSetAdmin(false); return false; }
  try {
    const res = await fetch('/api/verify-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const data = await res.json().catch(() => ({}));
    const ok = res.ok && data.admin === true;
    stringzSetAdmin(ok);
    if (!ok) stringzSetAdminToken(null);
    return ok;
  } catch (e) {
    // Si le serveur est injoignable, on ne fait PAS confiance au localStorage :
    // par sécurité on retire l'accès admin plutôt que de le laisser passer.
    stringzSetAdmin(false);
    return false;
  }
}

// Pseudo affiché pour le compte admin (écran "Heureux de vous revoir", etc.)
// (uniquement une valeur d'affichage par défaut ; la valeur qui fait foi est
// renvoyée par /api/login)
const STRINGZ_ADMIN_NAME = 'Administrateur';

// ---- "A déjà été admin sur cet appareil" ----
// Mémorisé dans localStorage (survit à la fermeture de l'onglet) mais ne
// donne AUCUN droit admin par lui-même : sert uniquement à proposer, à
// l'ouverture du site, un ré-accès rapide (avec re-saisie du mot de passe,
// revérifié côté serveur).
const STRINGZ_WAS_ADMIN_KEY = 'stringzWasAdmin';
function stringzMarkWasAdmin() {
  localStorage.setItem(STRINGZ_WAS_ADMIN_KEY, 'true');
}
function stringzWasAdminBefore() {
  return localStorage.getItem(STRINGZ_WAS_ADMIN_KEY) === 'true';
}

// ---- Prévient les autres onglets/pages ouverts en même temps ----
// (localStorage déclenche déjà un évènement "storage" dans les AUTRES onglets ;
//  ceci permet en plus d'écouter un changement fait dans le MÊME onglet.)
function stringzOnProductsChanged(callback) {
  window.addEventListener('storage', (e) => {
    if (e.key === STRINGZ_PRODUCTS_KEY) callback();
  });
}

/* ==========================================================================
   Commande en attente / historique d'achats (démo locale)
   ==========================================================================
   ⚠️ Comme indiqué en haut de ce fichier : ceci est stocké uniquement dans
   le localStorage/sessionStorage du navigateur de la personne qui achète.
   Ça permet d'afficher un récapitulatif de commande juste après un paiement
   Stripe réussi et de retrouver ses achats précédents SUR LE MÊME APPAREIL/
   NAVIGATEUR. Ce n'est PAS un vrai historique de commandes côté serveur :
   pour ça il faut lier chaque paiement (confirmé par le webhook Stripe, voir
   /api/webhook.js) à un vrai compte utilisateur en base de données.
   ========================================================================== */

const STRINGZ_PENDING_ORDER_KEY = 'stringzPendingOrder';
const STRINGZ_PURCHASES_KEY_PREFIX = 'stringzPurchases:';

// Appelé juste avant la redirection vers Stripe, pour retrouver le panier
// après le retour sur success.html (Stripe ne renvoie pas le détail du panier).
function stringzSetPendingOrder(order) {
  try {
    sessionStorage.setItem(STRINGZ_PENDING_ORDER_KEY, JSON.stringify(order));
  } catch (e) { /* ignore */ }
}

// Lit puis efface la commande en attente (à usage unique, appelé sur success.html).
function stringzTakePendingOrder() {
  try {
    const raw = sessionStorage.getItem(STRINGZ_PENDING_ORDER_KEY);
    sessionStorage.removeItem(STRINGZ_PENDING_ORDER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function stringzAddPurchase(email, purchase) {
  if (!email) return;
  try {
    const key = STRINGZ_PURCHASES_KEY_PREFIX + email.toLowerCase();
    const raw = localStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    list.unshift(purchase);
    localStorage.setItem(key, JSON.stringify(list));
  } catch (e) { /* ignore */ }
}

function stringzGetPurchases(email) {
  if (!email) return [];
  try {
    const key = STRINGZ_PURCHASES_KEY_PREFIX + email.toLowerCase();
    const raw = localStorage.getItem(key);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

/* ==========================================================================
   Diaporama de la page d'accueil (carré photo qui défile + lightbox)
   ========================================================================== */

const STRINGZ_DIAPO_KEY = 'stringzDiapoV1';

const STRINGZ_DEFAULT_DIAPO = ['photo1.jpg', 'photo2.jpg', 'photo3.jpg'];

// ---- Charge les photos du diaporama (localStorage si présent, sinon valeurs par défaut) ----
function stringzLoadDiapo() {
  try {
    const raw = localStorage.getItem(STRINGZ_DIAPO_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (e) { /* localStorage indisponible ou données corrompues */ }

  const defaults = JSON.parse(JSON.stringify(STRINGZ_DEFAULT_DIAPO));
  stringzSaveDiapo(defaults);
  return defaults;
}

// ---- Sauvegarde les photos du diaporama : visible instantanément sur les autres pages ----
function stringzSaveDiapo(photos) {
  try {
    localStorage.setItem(STRINGZ_DIAPO_KEY, JSON.stringify(photos));
  } catch (e) { /* quota dépassé, images trop lourdes en base64, etc. */ }
}

// ---- Prévient les autres onglets/pages ouverts en même temps ----
function stringzOnDiapoChanged(callback) {
  window.addEventListener('storage', (e) => {
    if (e.key === STRINGZ_DIAPO_KEY) callback();
  });
}

/* ==========================================================================
   Ateliers (workshops) — gérés depuis admin.html, affichés sur workshop.html
   ========================================================================== */

const STRINGZ_WORKSHOPS_KEY = 'stringzWorkshopsV1';

const STRINGZ_DEFAULT_WORKSHOPS = [
  {
    id: 'upcycling-2026-09-06',
    icon: '🧵',
    title: 'Atelier upcycling',
    date: '2026-09-06', // format AAAA-MM-JJ, sert au filtrage par date
    dateLabel: '6 septembre 2026',
    whenLabel: 'le 6 septembre de 14h30 à 17h',
    location: 'Poésie café, 10 passage Thiéré, Paris, 75011',
    price: 35,
    deposit: 20,
    places: 8,
    shortDescription: "Ramène tes pièces à custom pour 2h30 d'upcycling, boisson fancy incluse.",
    description: [
      "Tu es la bienvenue dans mon premier atelier upcycling &lt;3",
      "Ramène les pièces que tu ne mets plus et prenons 2h30 de custom pour qu'elles deviennent des pièces ICONIQUES.",
      "Beaucoup de matériel sera mis à ta disposition et un accompagnement personnalisé en fonction de tes pièces et de tes idées. Ajoute à ça une boisson super fancy composée par notre host de ce jour, Poésie café !"
    ],
    note: "&lt;3 Ici tu remplis tes infos et tu me transmets un acompte de 20 euros. Des bisous !"
  }
];

// ---- Charge les ateliers (localStorage si présent, sinon valeurs par défaut) ----
// NB: contrairement aux produits, un tableau VIDE est une valeur valide ici
// (ça veut dire "l'admin a supprimé tous les ateliers"), donc pas de retour
// aux valeurs par défaut dans ce cas.
function stringzLoadWorkshops() {
  try {
    const raw = localStorage.getItem(STRINGZ_WORKSHOPS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) { /* localStorage indisponible ou données corrompues */ }

  const defaults = JSON.parse(JSON.stringify(STRINGZ_DEFAULT_WORKSHOPS));
  stringzSaveWorkshops(defaults);
  return defaults;
}

// ---- Sauvegarde les ateliers : visible instantanément sur les autres pages ----
function stringzSaveWorkshops(workshops) {
  try {
    localStorage.setItem(STRINGZ_WORKSHOPS_KEY, JSON.stringify(workshops));
  } catch (e) { /* quota dépassé, etc. */ }
}

// ---- Prévient les autres onglets/pages ouverts en même temps ----
function stringzOnWorkshopsChanged(callback) {
  window.addEventListener('storage', (e) => {
    if (e.key === STRINGZ_WORKSHOPS_KEY) callback();
  });
}
