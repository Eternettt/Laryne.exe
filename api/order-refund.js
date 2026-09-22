/* ==========================================================================
   lib/order-refund.js — Enregistre un remboursement sur une commande.

   Utilisé par :
   - api/orders.js  (remboursement lancé depuis l'admin)
   - api/webhook.js (événement Stripe "charge.refunded", ex. remboursement
     fait directement dans le Dashboard Stripe)

   On travaille avec le TOTAL remboursé (valeur absolue, comme Stripe le donne
   dans charge.amount_refunded) et on ne fait que le faire monter (greatest) :
   si les deux chemins ci-dessus se croisent, le résultat reste correct.
   ========================================================================== */

const { sql } = require('./db');

async function applyRefundToOrder(orderId, refundedTotalCents) {
  const refunded = Math.max(0, Math.round(Number(refundedTotalCents) || 0));
  const { rows } = await sql`
    update orders
    set refunded_cents = greatest(coalesce(refunded_cents, 0), ${refunded}),
        status = case
          when greatest(coalesce(refunded_cents, 0), ${refunded}) >= total_cents then 'refunded'
          else 'partially_refunded'
        end,
        refunded_at = now(),
        updated_at = now()
    where id = ${orderId} and status in ('paid', 'partially_refunded', 'refunded')
    returning id, status, refunded_cents
  `;
  return rows[0] || null;
}

module.exports = { applyRefundToOrder };
