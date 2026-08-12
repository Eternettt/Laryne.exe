/* ==========================================================================
   shared-data.js — Source de données PARTAGÉE entre toutes les pages du site
   ==========================================================================
   Utilise localStorage : dans le même navigateur, toute modification faite
   depuis admin.html (ou le panneau Gestion de boutique.html) est visible
   immédiatement sur toutes les autres pages qui incluent ce script,
   dès qu'elles se (re)chargent.

   Inclure AVANT le script principal de chaque page :
   <script src="shared-data.js"></script>
   ========================================================================== */

const STRINGZ_PRODUCTS_KEY = 'stringzProductsV1';
const STRINGZ_ADMIN_KEY = 'stringzAdmin';

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

// ---- Mode admin (posé par connexion.html) ----
// Sécurité : le statut admin n'est JAMAIS mémorisé de façon permanente dans
// localStorage. Il est stocké dans sessionStorage, qui est propre à l'onglet
// et vidé automatiquement à la fermeture du navigateur/onglet. Résultat :
// même si on reste "connecté" (stringzUser en localStorage) d'une visite à
// l'autre, il faut TOUJOURS se reconnecter avec l'email/mot de passe admin
// à chaque nouvelle session pour retrouver les droits admin.
function stringzIsAdmin() {
  return sessionStorage.getItem(STRINGZ_ADMIN_KEY) === 'true';
}
function stringzSetAdmin(value) {
  if (value) sessionStorage.setItem(STRINGZ_ADMIN_KEY, 'true');
  else sessionStorage.removeItem(STRINGZ_ADMIN_KEY);
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
