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
  let res;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
  } catch (e) {
    // API injoignable (pas de backend, coupure réseau...) : on renvoie un
    // échec propre plutôt que de laisser planter tout le code appelant.
    return { ok: false, status: 0, data: { error: 'Serveur injoignable.' } };
  }
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
// includeAll = false : file d'attente "à expédier" (payées, pas encore expédiées).
// includeAll = true  : tout l'historique payé / remboursé, expédié ou non
//                      (sert à retrouver une commande à rembourser).
async function stringzAdminListOrders(includeAll = false) {
  const path = includeAll ? '/api/orders?mode=admin&scope=all' : '/api/admin/orders';
  const { ok, data } = await stringzApiFetch(path);
  return ok ? (data.orders || []) : null;
}
// ---- Rembourse une commande via Stripe (admin). amount en euros ; absent = tout ce qui reste ----
async function stringzAdminRefundOrder(id, amount) {
  return stringzApiFetch('/api/orders?mode=refund', { method: 'POST', body: { id, amount } });
}
// ---- Marque une commande comme expédiée (elle sort alors de la liste ci-dessus) ----
// Appelle directement /api/orders (le vrai fichier de la fonction) plutôt que
// /api/admin/orders : si la réécriture vercel.json pour cette URL n'a été
// écrite que pour GET (ou si un vieux fichier api/admin/orders.js GET-only
// traîne encore), passer par le chemin réel évite l'erreur 405.
async function stringzAdminMarkOrderShipped(id) {
  return stringzApiFetch('/api/orders?mode=admin', { method: 'PUT', body: { id } });
}


/* ==========================================================================
   Diaporama de la page d'accueil (carré photo qui défile + lightbox)
   ==========================================================================
   La liste des photos est enregistrée SUR LE SERVEUR (base de données, via
   /api/products?diapo=...) : c'est la même pour tous les visiteurs, et l'admin
   la modifie depuis admin.html. Rien n'est plus stocké dans le localStorage
   (ça ne fonctionnait que dans le navigateur qui avait fait la modification).
   ========================================================================== */

// Ancienne clé localStorage (avant le passage au serveur). Gardée uniquement
// pour nettoyer les navigateurs et récupérer d'éventuelles photos de l'admin.
const STRINGZ_DIAPO_LEGACY_KEY = 'stringzDiapoV1';

// Photos utilisées tant que l'admin n'a rien enregistré (fichiers à la racine du site).
const STRINGZ_DEFAULT_DIAPO = ['photo1.jpg', 'photo2.jpg', 'photo3.jpg'];

// ---- Récupère la liste depuis le serveur (public) ----
// Renvoie { photos, configured } : configured = false tant que l'admin n'a rien
// enregistré (ou si le serveur est injoignable) → photos par défaut.
async function stringzFetchDiapo() {
  const { ok, data } = await stringzApiFetch('/api/products?diapo=1', { cache: 'no-store' });
  if (ok && Array.isArray(data.photos) && data.photos.length) {
    return { photos: data.photos, configured: true };
  }
  return { photos: STRINGZ_DEFAULT_DIAPO.slice(), configured: false };
}

// ---- Admin : enregistre la liste (remplace la précédente pour tous les visiteurs) ----
async function stringzAdminSaveDiapo(photos) {
  return stringzApiFetch('/api/products?diapo=1', { method: 'PUT', body: { photos } });
}

// ---- Admin : envoie une photo (data URL) au serveur, renvoie { ok, url } ----
async function stringzAdminUploadDiapoImage(dataUrl) {
  const { ok, data } = await stringzApiFetch('/api/products?diapo=upload', { method: 'POST', body: { dataUrl } });
  return ok ? { ok: true, url: data.url } : { ok: false, error: data.error || "Échec de l'envoi de la photo." };
}

// ---- Prépare une photo avant envoi : réduite à 1600 px max et recompressée en JPEG ----
// (une photo de téléphone de plusieurs Mo dépasserait la limite de taille d'une
// requête ; 1600 px suffit largement pour un carré de 250 px et son agrandissement).
function stringzReadFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Lecture du fichier impossible.'));
    reader.readAsDataURL(file);
  });
}

async function stringzCompressDataUrl(dataUrl, maxSide = 1600, quality = 0.85) {
  // GIF : on garde le fichier tel quel (une recompression supprimerait l'animation).
  if (/^data:image\/gif/.test(dataUrl) && dataUrl.length <= 3000000) return dataUrl;
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('decode'));
      i.src = dataUrl;
    });
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff'; // fond blanc pour les PNG transparents
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } catch (e) {
    // Format que le navigateur ne sait pas lire (ex. HEIC hors Safari) : envoi tel quel
    // seulement s'il est déjà léger et dans un format accepté par le serveur.
    if (dataUrl.length <= 3000000 && /^data:image\/(jpeg|png|webp)/.test(dataUrl)) return dataUrl;
    throw new Error("Impossible de lire cette photo (format non pris en charge ou trop lourde). Utilise un JPG ou un PNG.");
  }
}

async function stringzPrepareImageFile(file) {
  return stringzCompressDataUrl(await stringzReadFileAsDataUrl(file));
}

// ---- Ancien stockage localStorage : lecture, nettoyage, récupération ----
function stringzReadLegacyDiapo() {
  try {
    const raw = localStorage.getItem(STRINGZ_DIAPO_LEGACY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) { return null; }
}

function stringzClearLegacyDiapo() {
  try { localStorage.removeItem(STRINGZ_DIAPO_LEGACY_KEY); } catch (e) { /* localStorage indisponible */ }
}

// Pages publiques : supprime l'ancienne liste "figée" des navigateurs (photos par
// défaut copiées dans le localStorage de chaque visiteur). On la CONSERVE si elle
// contient de vraies photos (data:) : ce sont peut-être celles de l'admin, qui les
// récupère depuis admin.html (voir stringzMigrateLegacyDiapo).
function stringzCleanupLegacyDiapo() {
  const legacy = stringzReadLegacyDiapo();
  if (legacy && !legacy.some((p) => typeof p === 'string' && p.startsWith('data:'))) stringzClearLegacyDiapo();
}

// Admin : envoie au serveur les photos qu'il avait ajoutées avant ce changement
// (elles n'existaient que dans ce navigateur), puis supprime l'ancien stockage.
// Renvoie le nombre de photos récupérées, ou 0 s'il n'y avait rien à faire.
async function stringzMigrateLegacyDiapo() {
  const legacy = stringzReadLegacyDiapo();
  if (!legacy) return 0;
  if (!legacy.some((p) => typeof p === 'string' && p.startsWith('data:'))) {
    stringzClearLegacyDiapo();
    return 0;
  }
  const photos = [];
  let uploaded = 0;
  for (const src of legacy) {
    if (typeof src !== 'string') continue;
    if (src.startsWith('data:')) {
      const up = await stringzAdminUploadDiapoImage(await stringzCompressDataUrl(src));
      if (!up.ok) throw new Error(up.error);
      photos.push(up.url);
      uploaded++;
    } else {
      photos.push(src);
    }
  }
  const saved = await stringzAdminSaveDiapo(photos);
  if (!saved.ok) throw new Error((saved.data && saved.data.error) || 'Enregistrement impossible.');
  stringzClearLegacyDiapo();
  return uploaded;
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
