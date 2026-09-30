/* ==========================================================================
   lib/custom-order-pricing.js
   ==========================================================================
   Recopie EXACTE des tarifs définis côté client dans commande_perso.html
   (constantes SHAPES / BASE_PRICE / DECOR_ITEMS / EXTRAS / motif à 3€).
   Le serveur recalcule toujours le prix lui-même à partir des identifiants
   choisis (shapeId, decorIds, extraIds...) et ignore tout montant envoyé
   par le navigateur : si tu modifies un tarif dans commande_perso.html,
   pense à répercuter le changement ICI aussi, sinon le paiement facturera
   l'ancien prix.
   ========================================================================== */

const BASE_PRICE = {
  string: 24.9,
  culotte: 29.9,
  boxer: 32.9,
  bresilienne: 27.9,
  'taille-haute': 31.9,
};

const SHAPE_NAMES = {
  string: 'String',
  culotte: 'Culotte classique',
  boxer: 'Boxer',
  bresilienne: 'Brésilienne',
  'taille-haute': 'Taille haute',
};

const MOTIF_PRICE = 3;

const DECOR_PRICES = {
  fleur: 4,
  noeud: 3,
  etoile: 3,
  coeur: 3,
  initiales: 6,
  dentelle: 5,
  papillon: 4,
  lune: 3,
};

const EXTRA_PRICES = {
  piercing: 5,
  sequins: 4,
  rubans: 3,
  clous: 5,
  special: 8,
};

// ---- Listes de référence côté serveur (source de vérité pour la validation) ----
const MOTIF_IDS = ['pois', 'rayures', 'leopard'];
const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
const COLOR_HEX_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_DECOR_ITEMS = 50;
const MAX_SPECIAL_REQUEST = 1000;
const MAX_COLOR_NAME = 60;

// Erreur de validation dont le message peut être montré au client (→ HTTP 400).
function invalid(message) {
  const err = new Error(message);
  err.isValidation = true;
  return err;
}

function hasOwn(obj, key) {
  return typeof key === 'string' && Object.prototype.hasOwnProperty.call(obj, key);
}

// Nettoie un texte libre : chaîne, sans caractères de contrôle, tronquée.
function cleanText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, maxLen);
}

function toPercent(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 50;
  return Math.round(Math.max(0, Math.min(100, n)) * 10) / 10;
}

// ---- Recalcule le prix total (en centimes) d'une création perso à partir
// des identifiants choisis. Lève une erreur (message affichable au client) si
// une valeur est invalide : on préfère refuser plutôt que d'ignorer en
// silence un identifiant inconnu (ce qui facturerait moins que ce qui est
// fabriqué). Ne lit JAMAIS un prix envoyé par le navigateur.
//
// Renvoie aussi "fabrication" : la fiche de fabrication reconstruite par le
// serveur, uniquement à partir de valeurs validées. C'est CET objet (et non le
// JSON brut du navigateur) qui est enregistré avec la commande.
function computeCustomOrderPrice(customOrder) {
  const co = customOrder && typeof customOrder === 'object' ? customOrder : {};

  const shapeId = co.shapeId;
  if (!hasOwn(BASE_PRICE, shapeId)) {
    throw invalid('Forme de sous-vêtement invalide.');
  }
  const size = co.size;
  if (typeof size !== 'string' || !SIZES.includes(size)) {
    throw invalid('Taille invalide.');
  }

  let total = BASE_PRICE[shapeId];
  const parts = [`${SHAPE_NAMES[shapeId]} (taille ${size})`];

  // ---- Motif ----
  let motifId = null;
  if (co.motifId !== null && co.motifId !== undefined && co.motifId !== '') {
    if (typeof co.motifId !== 'string' || !MOTIF_IDS.includes(co.motifId)) {
      throw invalid('Motif invalide.');
    }
    motifId = co.motifId;
    total += MOTIF_PRICE;
    parts.push('motif');
  }

  // ---- Décorations : une entrée = une décoration posée (doublons autorisés, chacune est facturée) ----
  const decorInput = co.decor !== undefined ? co.decor : co.decorIds;
  if (decorInput !== undefined && decorInput !== null && !Array.isArray(decorInput)) {
    throw invalid('Décorations invalides.');
  }
  const decorList = Array.isArray(decorInput) ? decorInput : [];
  if (decorList.length > MAX_DECOR_ITEMS) {
    throw invalid(`Trop de décorations (maximum ${MAX_DECOR_ITEMS}).`);
  }
  const decor = decorList.map((d) => {
    // Accepte un simple identifiant (ancien format) ou un objet { id, color, side, x, y }.
    const isObj = d && typeof d === 'object';
    const id = isObj ? d.id : d;
    if (typeof id !== 'string' || !hasOwn(DECOR_PRICES, id)) {
      throw invalid('Décoration invalide.');
    }
    total += DECOR_PRICES[id];
    parts.push(id);
    const color = isObj && typeof d.color === 'string' && COLOR_HEX_RE.test(d.color) ? d.color.toLowerCase() : null;
    const side = isObj && d.side === 'back' ? 'back' : 'front';
    return { id, color, side, x: isObj ? toPercent(d.x) : null, y: isObj ? toPercent(d.y) : null };
  });

  // ---- Extras : chaque extra ne peut être choisi qu'une fois ----
  const extraInput = co.extraIds;
  if (extraInput !== undefined && extraInput !== null && !Array.isArray(extraInput)) {
    throw invalid('Options invalides.');
  }
  const specialRequest = cleanText(co.specialRequest, MAX_SPECIAL_REQUEST);
  const extras = [];
  (Array.isArray(extraInput) ? extraInput : []).forEach((id) => {
    if (typeof id !== 'string' || !hasOwn(EXTRA_PRICES, id)) {
      throw invalid('Option invalide.');
    }
    if (extras.includes(id)) return; // doublon : ignoré, facturé une seule fois
    extras.push(id);
    // Comme sur l'écran de récapitulatif : la « demande particulière » n'est
    // facturée que si une demande a réellement été écrite.
    if (id === 'special' && !specialRequest) return;
    total += EXTRA_PRICES[id];
    parts.push(id);
  });

  // ---- Couleur (nuancier) : informative pour la fabrication, sans effet sur le prix ----
  let color = null;
  if (co.color && typeof co.color === 'object') {
    const hex = typeof co.color.hex === 'string' && COLOR_HEX_RE.test(co.color.hex) ? co.color.hex.toLowerCase() : null;
    const name = cleanText(co.color.name, MAX_COLOR_NAME);
    const code = cleanText(co.color.code, MAX_COLOR_NAME);
    if (hex || name) color = { name, code, hex };
  }

  const totalCents = Math.round(total * 100);
  const name = `Création perso — ${parts.join(', ')}`.slice(0, 250);
  const fabrication = {
    shapeId,
    size,
    motifId,
    color,
    decor,
    extraIds: extras,
    specialRequest,
  };
  return { totalCents, name, fabrication };
}

module.exports = {
  computeCustomOrderPrice,
  MOTIF_IDS,
  SIZES,
  BASE_PRICE,
  SHAPE_NAMES,
  MOTIF_PRICE,
  DECOR_PRICES,
  EXTRA_PRICES,
};
