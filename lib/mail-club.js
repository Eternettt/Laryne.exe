/* ==========================================================================
   lib/mail-club.js — Mail Club : durées, tarifs, validation, règle des dates
   ==========================================================================
   SOURCE DE VÉRITÉ côté serveur. Le navigateur n'envoie que { months, delivery }.
   Tout montant est recalculé ici ; un prix venant du navigateur est ignoré.

   TARIFS (décision du vendeur) : abonnement = 30 € x nombre de mois, 1 envoi par mois.
     1 mois = 30 €, 3 mois = 90 €, 6 mois = 180 €, 9 mois = 270 €.
   LIVRAISON : port d'1 envoi = grille actuelle, palier "1 pièce" (350 France / 750 étranger),
   multiplié par le nombre d'envois (= nombre de mois). Pas de remise en main propre.
   ========================================================================== */

const MONTHS_ALLOWED = [1, 3, 6, 9];
const DELIVERY_MODES = ['FR', 'INTL'];

// Prix TOTAL des lettres pour toute la durée (centimes) = 30 € x nombre de mois.
// Source de vérité : le navigateur n'envoie jamais de prix ni de nombre d'envois.
const PRICE_CENTS = {
  1: 3000,
  3: 9000,
  6: 18000,
  9: 27000,
};

// Port d'UN envoi (centimes) = palier "1 pièce" de la grille actuelle. Inchangé.
const SHIPPING_PER_SHIPMENT_CENTS = { FR: 350, INTL: 750 };

// Frais de livraison TOTAUX pour toute la durée (centimes) = port d'un envoi x nombre d'envois,
// payés en une fois avec l'abonnement :
//   1 mois 3,50 / 7,50 € ; 3 mois 10,50 / 22,50 € ; 6 mois 21,00 / 45,00 € ; 9 mois 31,50 / 67,50 €.
const SHIPPING_CENTS = {};
for (const m of MONTHS_ALLOWED) {
  SHIPPING_CENTS[m] = {
    FR: SHIPPING_PER_SHIPMENT_CENTS.FR * m,
    INTL: SHIPPING_PER_SHIPMENT_CENTS.INTL * m,
  };
}

const DURATION_LABELS = { 1: '1 mois', 3: '3 mois', 6: '6 mois', 9: '9 mois' };
const DELIVERY_LABELS = {
  FR: 'Livraison en France',
  INTL: 'Livraison internationale',
};

function invalid(message, status) {
  const err = new Error(message);
  err.isValidation = true;
  err.status = status || 400;
  return err;
}

function isCents(v) {
  return Number.isInteger(v) && v >= 0;
}

// Accepte 3 ou "3" ; refuse tout le reste (3.5, "3 mois", null, objets...).
function parseMonths(value) {
  let n = null;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d{1,2}$/.test(value)) n = Number(value);
  return Number.isInteger(n) && MONTHS_ALLOWED.includes(n) ? n : null;
}

function cleanShortText(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

// Tarifs pour l'affichage public (aucune donnée sensible). table = injectable pour les tests.
function getPublicPrices(prices = PRICE_CENTS, shipping = SHIPPING_CENTS) {
  return MONTHS_ALLOWED.map((m) => ({
    months: m,
    label: DURATION_LABELS[m],
    shipments: m,
    priceCents: isCents(prices[m]) ? prices[m] : null,
    shippingCents: {
      FR: isCents(shipping[m] && shipping[m].FR) ? shipping[m].FR : null,
      INTL: isCents(shipping[m] && shipping[m].INTL) ? shipping[m].INTL : null,
    },
  }));
}

// ---- Recalcule une commande Mail Club à partir de { months, delivery, contact } ----
// Lève une erreur de validation (message affichable) si quelque chose est faux ou
// si un tarif n'est pas défini. Ne lit JAMAIS un montant envoyé par le navigateur.
function computeMailClubOrder(input, prices = PRICE_CENTS, shipping = SHIPPING_CENTS) {
  const mc = input && typeof input === 'object' ? input : {};

  const months = parseMonths(mc.months);
  if (months === null) throw invalid('Durée invalide (1, 3, 6 ou 9 mois).');

  if (typeof mc.delivery !== 'string' || !DELIVERY_MODES.includes(mc.delivery)) {
    throw invalid('Choisis un mode de livraison (France ou étranger).');
  }
  const delivery = mc.delivery;

  const priceCents = prices[months];
  const shippingCents = shipping[months] ? shipping[months][delivery] : null;
  if (!isCents(priceCents) || !isCents(shippingCents)) {
    throw invalid("Ce tarif n'est pas encore disponible pour cette durée / ce mode de livraison.", 400);
  }

  const contactNote = cleanShortText(mc.contact, 100);
  const shipments = months; // un envoi par mois payé
  const name = `Mail Club — La lettre de la culotte légère (${DURATION_LABELS[months]}, ${shipments} envoi${shipments > 1 ? 's' : ''})`;

  return {
    months,
    shipments,
    delivery,
    priceCents,
    shippingCents,
    totalCents: priceCents + shippingCents,
    contactNote,
    name,
  };
}

// Un item de commande est un item Mail Club s'il porte la fiche "mailClub".
function findMailClubItem(items) {
  if (!Array.isArray(items)) return null;
  return items.find((it) => it && typeof it === 'object' && it.mailClub && typeof it.mailClub === 'object') || null;
}

module.exports = {
  MONTHS_ALLOWED,
  DELIVERY_MODES,
  DURATION_LABELS,
  DELIVERY_LABELS,
  PRICE_CENTS,
  SHIPPING_CENTS,
  SHIPPING_PER_SHIPMENT_CENTS,
  getPublicPrices,
  computeMailClubOrder,
  findMailClubItem,
  parseMonths,
};
