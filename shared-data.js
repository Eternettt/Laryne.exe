/* ==========================================================================
   shared-data.js — Fonctions partagées entre toutes les pages du site
   ==========================================================================
   Depuis la migration vers une vraie base de données (voir db/schema.sql et
   LISEZ-MOI.md), les PRODUITS, COMPTES et COMMANDES ne vivent plus dans
   localStorage : ce sont désormais /api/products, /api/auth/*,
   /api/orders/* et /api/admin/* qui font foi, avec permissions vérifiées
   côté serveur à chaque appel (voir lib/session.js). Ce fichier ne garde du
   stockage local que pour le diaporama et les ateliers (fonctionnalités non
   critiques, non financières, volontairement laissées telles quelles).

   Inclure AVANT le script principal de chaque page :
   <script src="shared-data.js"></script>
   ========================================================================== */

// ---- Échappe du texte avant de l'insérer en HTML (protection XSS) ----
function stringzEscapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- Petit wrapper fetch JSON, envoie toujours le cookie de session ----
async function stringzApiFetch(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* réponse vide */ }
  return { ok: res.ok, status: res.status, data };
}

// ==========================================================================
// ---- Compte / session (cookie httpOnly signé, posé par le serveur) ----
// ==========================================================================
// Il n'y a plus de "jeton admin" ni de drapeau à gérer soi-même côté
// navigateur : la session vit dans un cookie httpOnly (illisible et
// non falsifiable depuis ce fichier JS), et /api/auth/me revérifie
// toujours le rôle en base à chaque appel.

async function stringzMe() {
  const { data } = await stringzApiFetch('/api/auth/me');
  return data.user || null;
}

async function stringzSignup(email, password, name) {
  const { ok, data } = await stringzApiFetch('/api/auth/signup', { method: 'POST', body: { email, password, name } });
  return ok ? { ok: true, user: data.user } : { ok: false, error: data.error || 'Erreur lors de la création du compte.' };
}

async function stringzLogin(email, password) {
  const { ok, data } = await stringzApiFetch('/api/auth/login', { method: 'POST', body: { email, password } });
  return ok ? { ok: true, user: data.user } : { ok: false, error: data.error || 'Identifiants incorrects.' };
}

async function stringzLogout() {
  await stringzApiFetch('/api/auth/logout', { method: 'POST' });
}

async function stringzDeleteAccount() {
  const { ok, data } = await stringzApiFetch('/api/account/delete', { method: 'POST' });
  return ok ? { ok: true, message: data.message } : { ok: false, error: data.error || 'Erreur lors de la suppression.' };
}

// ==========================================================================
// ---- Produits (source de vérité : base de données, via /api/products) ----
// ==========================================================================

async function stringzFetchProducts() {
  const { ok, data } = await stringzApiFetch('/api/products');
  return ok ? (data.products || []) : [];
}

// ---- CRUD produits admin (permissions revérifiées côté serveur à chaque appel) ----
async function stringzAdminListProducts() {
  const { ok, data } = await stringzApiFetch('/api/admin/products');
  return ok ? (data.products || []) : null; // null = pas admin / erreur
}
async function stringzAdminCreateProduct(product) {
  return stringzApiFetch('/api/admin/products', { method: 'POST', body: product });
}
async function stringzAdminUpdateProduct(id, fields) {
  return stringzApiFetch('/api/admin/products', { method: 'PUT', body: { id, ...fields } });
}
async function stringzAdminDeleteProduct(id) {
  return stringzApiFetch('/api/admin/products', { method: 'DELETE', body: { id } });
}

// ==========================================================================
// ---- Commandes (source de vérité : base de données) ----
// ==========================================================================

async function stringzFetchMyOrders() {
  const { ok, data } = await stringzApiFetch('/api/orders');
  return ok ? (data.orders || []) : [];
}
async function stringzFetchOrderBySession(sessionId) {
  const { ok, data } = await stringzApiFetch('/api/orders/by-session?session_id=' + encodeURIComponent(sessionId));
  return ok ? data.order : null;
}
async function stringzAdminListOrders() {
  const { ok, data } = await stringzApiFetch('/api/admin/orders');
  return ok ? (data.orders || []) : null;
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
