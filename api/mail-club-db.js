/* ==========================================================================
   lib/mail-club-db.js — Tout le SQL du Mail Club (requêtes paramétrées)
   ==========================================================================
   Règle des dates (une seule règle, appliquée ici) :
   - date de début  = jour (heure de Paris) où le webhook Stripe confirme le paiement ;
   - envoi n°k      = date de début + (k-1) mois, calculé À PARTIR DE LA DATE DE DÉBUT
                      (pas de dérive) ; si le mois n'a pas ce jour, c'est le dernier jour
                      du mois (31 janv. + 1 mois = 28/29 févr., + 2 mois = 31 mars) ;
   - date de fin    = dernier jour couvert = début + durée - 1 jour ;
   - nombre d'envois = nombre de mois payés (1 envoi par mois).
   Les N lignes d'envoi sont créées UNE fois à l'activation (unique (abonnement, n°)) :
   rien n'est créé à l'ouverture de l'admin, aucun doublon possible.
   Statuts : calculés à partir des données (commande + envois), jamais stockés,
   donc jamais incohérents avec un remboursement.
   ========================================================================== */

const { sql } = require('./db');
const { findMailClubItem, parseMonths, DELIVERY_MODES } = require('./mail-club');

// ---- Activation (appelée par le webhook APRÈS confirmation du paiement) ----
// Idempotente : rejouer le même événement ne crée ni 2e abonnement ni 2e série d'envois.
// Renvoie l'id d'abonnement, ou null si la commande n'est pas une commande Mail Club.
async function activateMailClubSubscription(orderId, checkoutSession) {
  const { rows } = await sql`
    select id, status, items, customer_email, shipping_name, shipping_address
    from orders where id = ${orderId}
  `;
  const order = rows[0];
  if (!order) return null;
  const item = findMailClubItem(order.items);
  if (!item) return null; // commande normale : on ne touche à rien

  const mc = item.mailClub;
  const months = parseMonths(mc.months);
  const delivery = typeof mc.delivery === 'string' && DELIVERY_MODES.includes(mc.delivery) ? mc.delivery : null;
  const priceCents = Number(mc.priceCents);
  const shippingCents = Number(mc.shippingCents);
  if (months === null || !delivery || !Number.isInteger(priceCents) || !Number.isInteger(shippingCents)) {
    throw new Error('Commande Mail Club corrompue (fiche invalide) : ' + orderId);
  }

  // Un abonnement n'existe que pour un paiement confirmé et non remboursé en totalité.
  if (order.status !== 'paid' && order.status !== 'partially_refunded') {
    const { rows: existing } = await sql`select id from mail_club_subscriptions where order_id = ${orderId}`;
    if (!existing.length) {
      console.warn('[mail-club] Abonnement non créé, commande au statut', order.status, ':', orderId);
    }
    return existing.length ? existing[0].id : null;
  }

  const details = (checkoutSession && checkoutSession.customer_details) || {};
  const customerName = typeof details.name === 'string' ? details.name.slice(0, 200) : null;
  const phone = typeof details.phone === 'string' ? details.phone.slice(0, 40) : null;
  const contactNote = typeof mc.contactNote === 'string' ? mc.contactNote.slice(0, 100) : null;
  const addr = order.shipping_address;
  const addrJson = addr == null ? null : (typeof addr === 'string' ? addr : JSON.stringify(addr));

  const { rows: created } = await sql`
    insert into mail_club_subscriptions
      (order_id, customer_name, customer_email, contact_note, phone, delivery,
       shipping_name, shipping_address, months, total_shipments, price_cents, shipping_cents,
       start_date, end_date)
    values
      (${orderId}, ${customerName}, ${order.customer_email}, ${contactNote}, ${phone}, ${delivery},
       ${order.shipping_name}, ${addrJson}, ${months}, ${months}, ${priceCents}, ${shippingCents},
       (now() at time zone 'Europe/Paris')::date,
       ((now() at time zone 'Europe/Paris')::date + (${months}::int * interval '1 month'))::date - 1)
    on conflict (order_id) do nothing
    returning id
  `;

  let subId;
  if (created.length) {
    subId = created[0].id;
  } else {
    const { rows: existing } = await sql`select id from mail_club_subscriptions where order_id = ${orderId}`;
    subId = existing[0].id;
  }

  // Envois prévus : N lignes, créées une seule fois (on conflict do nothing).
  await sql`
    insert into mail_club_shipments (subscription_id, seq, due_date)
    select s.id, g, (s.start_date + ((g - 1) * interval '1 month'))::date
    from mail_club_subscriptions s, generate_series(1, ${months}::int) g
    where s.id = ${subId}::bigint
    on conflict (subscription_id, seq) do nothing
  `;
  return subId;
}

// ---- Vue calculée d'un abonnement (statuts dérivés) ----
function buildView(row, shipments, events, today) {
  const sent = shipments.filter((s) => s.sentAt);
  const pending = shipments.filter((s) => !s.sentAt);
  const orderStatus = row.order_status;
  let status = 'active';
  if (orderStatus === 'refunded') status = 'refunded';
  else if (sent.length >= row.total_shipments) status = 'completed';

  const active = status === 'active';
  const dueNow = active ? pending.filter((s) => s.dueDate <= today) : [];
  return {
    id: String(row.id),
    orderId: row.order_id,
    sessionId: row.stripe_session_id,
    customerName: row.customer_name || row.shipping_name || null,
    customerEmail: row.customer_email || null,
    contactNote: row.contact_note || null,
    phone: row.phone || null,
    delivery: row.delivery,
    shippingName: row.shipping_name || null,
    shippingAddress: row.shipping_address || null,
    months: row.months,
    totalShipments: row.total_shipments,
    sentCount: sent.length,
    priceCents: row.price_cents,
    shippingCents: row.shipping_cents,
    totalCents: row.total_cents,
    refundedCents: row.refunded_cents || 0,
    startDate: row.start_date,
    endDate: row.end_date,
    nextDueDate: active && pending.length ? pending[0].dueDate : null,
    dueNowCount: dueNow.length,
    paymentStatus: orderStatus, // paid | partially_refunded | refunded
    status, // active | completed | refunded
    shipments,
    events,
  };
}

// ---- Liste admin (filtre appliqué ici, à partir des données persistées) ----
async function listSubscriptions(filter) {
  const { rows } = await sql`
    select sub.id, sub.order_id, sub.customer_name, sub.customer_email, sub.contact_note, sub.phone,
           sub.delivery, sub.shipping_name, sub.shipping_address, sub.months, sub.total_shipments,
           sub.price_cents, sub.shipping_cents,
           sub.start_date::text as start_date, sub.end_date::text as end_date,
           o.status as order_status, o.total_cents, o.refunded_cents, o.stripe_session_id,
           (now() at time zone 'Europe/Paris')::date::text as today
    from mail_club_subscriptions sub
    join orders o on o.id = sub.order_id
    order by sub.created_at desc
    limit 500
  `;
  if (!rows.length) {
    return { today: null, subscriptions: [] };
  }
  const today = rows[0].today;
  const ids = rows.map((r) => String(r.id));

  const { rows: shipRows } = await sql`
    select id, subscription_id, seq, due_date::text as due_date, sent_at
    from mail_club_shipments
    where subscription_id = any(${ids}::bigint[])
    order by subscription_id, seq
  `;
  const { rows: eventRows } = await sql`
    select subscription_id, seq, action, admin_user_id, created_at
    from mail_club_events
    where subscription_id = any(${ids}::bigint[])
    order by created_at asc
  `;

  const shipBySub = {};
  for (const s of shipRows) {
    (shipBySub[String(s.subscription_id)] = shipBySub[String(s.subscription_id)] || []).push({
      id: String(s.id),
      seq: s.seq,
      dueDate: s.due_date,
      sentAt: s.sent_at || null,
    });
  }
  const evBySub = {};
  for (const e of eventRows) {
    (evBySub[String(e.subscription_id)] = evBySub[String(e.subscription_id)] || []).push({
      seq: e.seq,
      action: e.action,
      adminUserId: e.admin_user_id,
      at: e.created_at,
    });
  }

  let views = rows.map((r) => buildView(r, shipBySub[String(r.id)] || [], evBySub[String(r.id)] || [], today));

  if (filter === 'active') views = views.filter((v) => v.status === 'active');
  else if (filter === 'due') views = views.filter((v) => v.status === 'active' && v.dueNowCount > 0);
  else if (filter === 'completed') views = views.filter((v) => v.status === 'completed');
  else if (filter === 'refunded') views = views.filter((v) => v.paymentStatus === 'refunded' || v.paymentStatus === 'partially_refunded');
  // 'all' ou inconnu : tout

  return { today, subscriptions: views };
}

// ---- Marque un envoi comme envoyé ----
// UNE seule instruction SQL (atomique) : met à jour l'envoi ET écrit l'historique.
// Conditions vérifiées dans la base elle-même :
//  - l'envoi n'est pas déjà marqué (anti double clic / requêtes répétées) ;
//  - tous les envois précédents sont déjà marqués (les envois restent dans l'ordre) ;
//  - la commande est payée (pas totalement remboursée).
async function markShipmentSent(shipmentId, adminUserId) {
  const admin = String(adminUserId);
  const { rows } = await sql`
    with upd as (
      update mail_club_shipments s
      set sent_at = now()
      from mail_club_subscriptions sub
      join orders o on o.id = sub.order_id
      where s.id = ${shipmentId}::bigint
        and s.subscription_id = sub.id
        and s.sent_at is null
        and o.status in ('paid', 'partially_refunded')
        and not exists (
          select 1 from mail_club_shipments p
          where p.subscription_id = s.subscription_id and p.seq < s.seq and p.sent_at is null
        )
      returning s.id, s.subscription_id, s.seq
    )
    insert into mail_club_events (subscription_id, shipment_id, seq, action, admin_user_id)
    select subscription_id, id, seq, 'sent', ${admin}::text from upd
    returning shipment_id
  `;
  if (rows.length) return { ok: true };
  return { ok: false, ...(await explainRefusal(shipmentId, 'mark')) };
}

// ---- Corrige une erreur : annule le marquage « envoyé » (le dernier envoyé seulement) ----
async function unmarkShipmentSent(shipmentId, adminUserId) {
  const admin = String(adminUserId);
  const { rows } = await sql`
    with upd as (
      update mail_club_shipments s
      set sent_at = null
      where s.id = ${shipmentId}::bigint
        and s.sent_at is not null
        and not exists (
          select 1 from mail_club_shipments n
          where n.subscription_id = s.subscription_id and n.seq > s.seq and n.sent_at is not null
        )
      returning s.id, s.subscription_id, s.seq
    )
    insert into mail_club_events (subscription_id, shipment_id, seq, action, admin_user_id)
    select subscription_id, id, seq, 'unsent', ${admin}::text from upd
    returning shipment_id
  `;
  if (rows.length) return { ok: true };
  return { ok: false, ...(await explainRefusal(shipmentId, 'unmark')) };
}

// Explique POURQUOI une modification a été refusée (message pour l'admin).
async function explainRefusal(shipmentId, kind) {
  const { rows } = await sql`
    select s.seq, s.sent_at, s.subscription_id, o.status as order_status,
      exists (select 1 from mail_club_shipments p
              where p.subscription_id = s.subscription_id and p.seq < s.seq and p.sent_at is null) as previous_pending,
      exists (select 1 from mail_club_shipments n
              where n.subscription_id = s.subscription_id and n.seq > s.seq and n.sent_at is not null) as next_sent
    from mail_club_shipments s
    join mail_club_subscriptions sub on sub.id = s.subscription_id
    join orders o on o.id = sub.order_id
    where s.id = ${shipmentId}::bigint
  `;
  const r = rows[0];
  if (!r) return { status: 404, error: 'Envoi introuvable.' };
  if (kind === 'mark') {
    if (r.sent_at) return { status: 409, error: 'Cet envoi est déjà marqué comme envoyé.' };
    if (r.order_status !== 'paid' && r.order_status !== 'partially_refunded') {
      return { status: 409, error: 'Commande remboursée ou non payée : plus aucun envoi à effectuer.' };
    }
    if (r.previous_pending) return { status: 409, error: "Marque d'abord les envois précédents comme envoyés." };
  } else {
    if (!r.sent_at) return { status: 409, error: "Cet envoi n'est pas marqué comme envoyé." };
    if (r.next_sent) return { status: 409, error: "Annule d'abord les envois suivants (on corrige toujours le dernier envoi marqué)." };
  }
  return { status: 409, error: 'Modification refusée.' };
}

module.exports = {
  activateMailClubSubscription,
  listSubscriptions,
  markShipmentSent,
  unmarkShipmentSent,
  buildView,
};
