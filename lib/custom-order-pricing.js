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

// ---- Recalcule le prix total (en centimes) d'une création perso à partir
// des identifiants choisis. Lève une erreur si la forme est invalide.
function computeCustomOrderPrice(customOrder) {
  const shapeId = customOrder && customOrder.shapeId;
  const basePrice = BASE_PRICE[shapeId];
  if (!basePrice) {
    throw new Error('Forme de sous-vêtement invalide.');
  }

  let total = basePrice;
  const parts = [`${SHAPE_NAMES[shapeId]} (taille ${customOrder.size || '-'})`];

  if (customOrder.motifId) {
    total += MOTIF_PRICE;
    parts.push('motif');
  }

  (customOrder.decorIds || []).forEach((id) => {
    const price = DECOR_PRICES[id];
    if (price) {
      total += price;
      parts.push(id);
    }
  });

  (customOrder.extraIds || []).forEach((id) => {
    const price = EXTRA_PRICES[id];
    if (price) {
      total += price;
      parts.push(id);
    }
  });

  const totalCents = Math.round(total * 100);
  const name = `Création perso — ${parts.join(', ')}`;
  return { totalCents, name };
}

module.exports = {
  computeCustomOrderPrice,
  BASE_PRICE,
  SHAPE_NAMES,
  MOTIF_PRICE,
  DECOR_PRICES,
  EXTRA_PRICES,
};
