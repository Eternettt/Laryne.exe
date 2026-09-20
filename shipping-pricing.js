/* ==========================================================================
   lib/shipping-pricing.js — Frais de port selon le nombre de pièces
   commandées et la destination (France ou étranger).

   Paliers donnés par la boutique. Les bornes fournies se chevauchaient
   légèrement (1-2 puis 2-5 puis 5-10) : ici on les traite comme des paliers
   qui ne se chevauchent pas (1-2 / 3-5 / 6-10). Si ce n'est pas ce que tu
   voulais pour les cas limites (une commande de 2 ou de 5 pièces
   exactement), ajuste les bornes ci-dessous.

   Au-delà de 10 pièces : aucun tarif n'a été donné. Par prudence (pour ne
   jamais sous-facturer un envoi), on applique le tarif du dernier palier
   (6-10). Donne-moi la vraie grille au-delà de 10 si tu en as une.
   ========================================================================== */

const TIERS = [
  { max: 2, franceCents: 350, abroadCents: 750 },
  { max: 5, franceCents: 570, abroadCents: 1410 },
  { max: 10, franceCents: 772, abroadCents: 1900 },
];

function getShippingRates(quantity) {
  const qty = Math.max(1, Math.round(Number(quantity) || 1));
  const tier = TIERS.find((t) => qty <= t.max) || TIERS[TIERS.length - 1];
  return { franceCents: tier.franceCents, abroadCents: tier.abroadCents };
}

module.exports = { getShippingRates };
