/* ==========================================================================
   lib/email.js — Envoi de l'e-mail de confirmation de commande.

   Aucun système d'e-mail n'existait dans le projet : ce module utilise
   l'API REST de Resend (https://resend.com) via fetch (Node 18+, déjà
   disponible sur Vercel) → aucune dépendance npm à ajouter.

   Variables d'environnement (Vercel > Settings > Environment Variables) :
     RESEND_API_KEY   clé API Resend (commence par "re_")           OBLIGATOIRE
     MAIL_FROM        expéditeur, ex. "Ma Boutique <commandes@mondomaine.fr>"
                      (le domaine doit être vérifié dans Resend)    OBLIGATOIRE
     SHOP_NAME        nom affiché dans le mail (défaut : "La boutique")
     MAIL_REPLY_TO    adresse de réponse (optionnel)

   Si RESEND_API_KEY ou MAIL_FROM manque, isEmailConfigured() renvoie false
   et aucun mail n'est tenté : le paiement et la commande ne sont pas affectés.

   Pour utiliser un autre fournisseur (Brevo, Postmark, SMTP...), seule la
   fonction sendEmail() ci-dessous est à remplacer.
   ========================================================================== */

function isEmailConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

function escapeHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatEuros(cents) {
  return (Number(cents || 0) / 100).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}

function orderReference(order) {
  const id = String(order.id);
  return id.length > 8 ? id.slice(0, 8).toUpperCase() : id;
}

function formatAddress(order) {
  const a = order.shipping_address;
  if (!a) return [];
  const address = typeof a === 'string' ? JSON.parse(a) : a;
  return [
    order.shipping_name,
    address.line1,
    address.line2,
    [address.postal_code, address.city].filter(Boolean).join(' '),
    address.country,
  ].filter(Boolean);
}

function buildOrderEmail(order) {
  const shopName = process.env.SHOP_NAME || 'La boutique';
  const items = Array.isArray(order.items) ? order.items : [];
  const ref = orderReference(order);
  const shippingCents = order.shipping_cents || 0;
  const subtotalCents = (order.total_cents || 0) - shippingCents;
  const addressLines = formatAddress(order);

  const itemLabel = (it) => {
    const details = [it.type, it.size ? `Taille ${it.size}` : null].filter(Boolean).join(' - ');
    return details ? `${it.name} (${details})` : it.name;
  };
  const itemTotalCents = (it) => Math.round(Number(it.unitPrice || 0) * 100) * (Number(it.qty) || 1);

  const rowsHtml = items
    .map(
      (it) => `
        <tr>
          <td style="padding:8px 0;border-bottom:1px solid #eee;">${escapeHtml(itemLabel(it))} × ${escapeHtml(it.qty || 1)}</td>
          <td style="padding:8px 0;border-bottom:1px solid #eee;text-align:right;white-space:nowrap;">${formatEuros(itemTotalCents(it))}</td>
        </tr>`
    )
    .join('');

  const html = `<!doctype html>
<html lang="fr"><body style="margin:0;padding:24px;background:#f6f6f6;font-family:Arial,Helvetica,sans-serif;color:#222;">
  <div style="max-width:560px;margin:0 auto;background:#fff;padding:28px;border-radius:8px;">
    <h1 style="font-size:20px;margin:0 0 12px;">Merci pour votre commande !</h1>
    <p style="margin:0 0 16px;line-height:1.5;">Nous avons bien reçu votre paiement : votre commande <strong>n°${escapeHtml(ref)}</strong> est confirmée.</p>
    <table style="width:100%;border-collapse:collapse;font-size:14px;">${rowsHtml}
      <tr><td style="padding:8px 0;">Sous-total</td><td style="padding:8px 0;text-align:right;">${formatEuros(subtotalCents)}</td></tr>
      <tr><td style="padding:8px 0;">Livraison</td><td style="padding:8px 0;text-align:right;">${formatEuros(shippingCents)}</td></tr>
      <tr><td style="padding:8px 0;font-weight:bold;">Total payé</td><td style="padding:8px 0;text-align:right;font-weight:bold;">${formatEuros(order.total_cents)}</td></tr>
    </table>
    ${
      addressLines.length
        ? `<p style="margin:20px 0 4px;font-weight:bold;">Adresse de livraison</p>
    <p style="margin:0;line-height:1.5;font-size:14px;">${addressLines.map(escapeHtml).join('<br>')}</p>`
        : ''
    }
    <p style="margin:24px 0 0;font-size:13px;color:#666;line-height:1.5;">Une question sur votre commande ? Répondez simplement à ce message en indiquant le numéro ${escapeHtml(ref)}.</p>
    <p style="margin:16px 0 0;font-size:13px;color:#666;">— ${escapeHtml(shopName)}</p>
  </div>
</body></html>`;

  const text = [
    'Merci pour votre commande !',
    '',
    `Nous avons bien reçu votre paiement : votre commande n°${ref} est confirmée.`,
    '',
    ...items.map((it) => `- ${itemLabel(it)} x ${it.qty || 1} : ${formatEuros(itemTotalCents(it))}`),
    '',
    `Sous-total : ${formatEuros(subtotalCents)}`,
    `Livraison : ${formatEuros(shippingCents)}`,
    `Total payé : ${formatEuros(order.total_cents)}`,
    ...(addressLines.length ? ['', 'Adresse de livraison :', ...addressLines] : []),
    '',
    `Une question ? Répondez à ce message en indiquant le numéro ${ref}.`,
    `— ${shopName}`,
  ].join('\n');

  return { subject: `Confirmation de votre commande n°${ref}`, html, text };
}

async function sendEmail({ to, subject, html, text, idempotencyKey }) {
  const payload = { from: process.env.MAIL_FROM, to: [to], subject, html, text };
  if (process.env.MAIL_REPLY_TO) payload.reply_to = process.env.MAIL_REPLY_TO;

  const headers = {
    Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend ${response.status} : ${detail}`);
  }
}

// order = ligne de la table orders (id, items, total_cents, shipping_cents,
// customer_email, shipping_name, shipping_address).
async function sendOrderConfirmation(order) {
  if (!order.customer_email) throw new Error('Pas d\'e-mail client sur la commande ' + order.id);
  const { subject, html, text } = buildOrderEmail(order);
  await sendEmail({
    to: order.customer_email,
    subject,
    html,
    text,
    idempotencyKey: `order-confirmation-${order.id}`,
  });
}

module.exports = { isEmailConfigured, sendOrderConfirmation, buildOrderEmail };
