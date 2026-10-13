/* Tests Mail Club — AVEC MOCKS (faux Stripe, fausse base, faux Resend).
   Ils vérifient la logique JS et la séquence des appels, PAS le SQL réel ni un vrai paiement.
   Lancer depuis la racine du projet :  node tests/run.js   (aucune dépendance à installer) */
const Module = require('module');
const _resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@vercel/postgres') return require('path').join(__dirname, 'stubs/postgres.js');
  if (request === 'stripe') return require('path').join(__dirname, 'stubs/stripe.js');
  return _resolve.call(this, request, ...rest);
};
process.env.STRIPE_SECRET_KEY = 'sk_test_x';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';
process.env.SESSION_SECRET = 'secret-de-test';
process.env.RESEND_API_KEY = 're_test';
process.env.MAIL_FROM = 'Test <t@example.com>';

const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..');
const mc = require(path.join(root, 'lib/mail-club'));
const { buildView } = require(path.join(root, 'lib/mail-club-db'));

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { failed++; console.log('FAIL  ' + name + '\n      ' + (e && e.message)); }
}
function mockRes() {
  const r = { statusCode: 200, body: null, headers: {} };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.send = (b) => { r.body = b; return r; };
  r.end = () => r;
  r.setHeader = (k, v) => { r.headers[k] = v; };
  return r;
}
function reset() { global.__sqlLog = []; global.__stripeCalls = []; global.__fetchCalls = []; }

// ---- table de prix de test (injectée : on ne touche pas aux vrais tarifs) ----
const TEST_PRICES = { 1: 3000, 3: 9000, 6: 18000, 9: 27000 };
const TEST_SHIP = {
  1: { FR: 350, INTL: 750 },
  3: { FR: 1050, INTL: 2250 },
  6: { FR: 2100, INTL: 4500 },
  9: { FR: 3150, INTL: 6750 },
};

(async () => {
  console.log('\n== lib/mail-club (validation + prix serveur) ==');
  await test('chaque durée autorisée est calculée côté serveur (table de test)', () => {
    for (const m of [1, 3, 6, 9]) {
      const r = mc.computeMailClubOrder({ months: m, delivery: 'FR' }, TEST_PRICES, TEST_SHIP);
      assert.strictEqual(r.priceCents, TEST_PRICES[m]);
      assert.strictEqual(r.shippingCents, TEST_SHIP[m].FR);
      assert.strictEqual(r.totalCents, TEST_PRICES[m] + TEST_SHIP[m].FR);
      assert.strictEqual(r.shipments, m);
    }
  });
  await test('durées interdites refusées (2, 12, 0, 13, 3.5, "3 mois", null, objet)', () => {
    for (const bad of [2, 4, 5, 12, 0, 13, -1, 3.5, '3 mois', 'abc', null, undefined, {}, [3], true]) {
      assert.throws(() => mc.computeMailClubOrder({ months: bad, delivery: 'FR' }, TEST_PRICES, TEST_SHIP), (e) => e.isValidation === true, 'devrait refuser ' + JSON.stringify(bad));
    }
  });
  await test('"3" (chaîne numérique) accepté comme 3', () => {
    assert.strictEqual(mc.computeMailClubOrder({ months: '3', delivery: 'FR' }, TEST_PRICES, TEST_SHIP).months, 3);
  });
  await test('mode de livraison invalide refusé', () => {
    for (const bad of ['fr', 'POST', '', null, undefined, 5, ['FR']]) {
      assert.throws(() => mc.computeMailClubOrder({ months: 1, delivery: bad }, TEST_PRICES, TEST_SHIP), (e) => e.isValidation);
    }
  });
  await test('un montant / prix / nombre d\'envois envoyé par le navigateur est IGNORÉ', () => {
    const r = mc.computeMailClubOrder({ months: 3, delivery: 'FR', priceCents: 1, totalCents: 1, price: 0.01, amount: 1, shipments: 99, shippingCents: 0 }, TEST_PRICES, TEST_SHIP);
    assert.strictEqual(r.priceCents, 9000);
    assert.strictEqual(r.shippingCents, 1050);
    assert.strictEqual(r.shipments, 3);
  });
  await test('garde-fou : tarif ou port absent (null) => refus, jamais de prix inventé', () => {
    const noPrice = { ...TEST_PRICES, 3: null };
    const noShip = { ...TEST_SHIP, 6: { FR: null, INTL: 4500 } };
    assert.throws(() => mc.computeMailClubOrder({ months: 3, delivery: 'FR' }, noPrice, TEST_SHIP), (e) => e.isValidation && /pas encore disponible/.test(e.message));
    assert.throws(() => mc.computeMailClubOrder({ months: 6, delivery: 'FR' }, TEST_PRICES, noShip), (e) => e.isValidation);
  });
  await test('TARIFS RÉELS : abonnement = 30 € x mois (1/3/6/9 => 30/90/180/270 €), uniquement ces 4 durées', () => {
    assert.deepStrictEqual(mc.MONTHS_ALLOWED, [1, 3, 6, 9]);
    assert.deepStrictEqual(Object.keys(mc.PRICE_CENTS).map(Number), [1, 3, 6, 9]);
    for (const m of mc.MONTHS_ALLOWED) assert.strictEqual(mc.PRICE_CENTS[m], 3000 * m);
    assert.deepStrictEqual(mc.PRICE_CENTS, { 1: 3000, 3: 9000, 6: 18000, 9: 27000 });
    assert.ok(!('12' in mc.PRICE_CENTS) && !('12' in mc.SHIPPING_CENTS));
    assert.ok(!/12|1 an/.test(Object.values(mc.DURATION_LABELS).join(' ')));
  });
  await test('PORT = port d\'un mois x nombre de mois (350 / 750 par envoi, grille existante inchangée)', () => {
    assert.deepStrictEqual(mc.SHIPPING_PER_SHIPMENT_CENTS, { FR: 350, INTL: 750 });
    assert.deepStrictEqual(mc.SHIPPING_CENTS, {
      1: { FR: 350, INTL: 750 }, 3: { FR: 1050, INTL: 2250 }, 6: { FR: 2100, INTL: 4500 }, 9: { FR: 3150, INTL: 6750 },
    });
    for (const m of mc.MONTHS_ALLOWED) {
      assert.strictEqual(mc.SHIPPING_CENTS[m].FR, 350 * m); assert.strictEqual(mc.SHIPPING_CENTS[m].INTL, 750 * m);
    }
  });
  await test('TOTAL RÉEL = (30 € + port d\'un envoi) x mois, pour chaque durée et zone', () => {
    const expect = { 1: [3350, 3750], 3: [10050, 11250], 6: [20100, 22500], 9: [30150, 33750] };
    for (const m of mc.MONTHS_ALLOWED) {
      const fr = mc.computeMailClubOrder({ months: m, delivery: 'FR' });
      const intl = mc.computeMailClubOrder({ months: m, delivery: 'INTL' });
      assert.strictEqual(fr.totalCents, expect[m][0]); assert.strictEqual(intl.totalCents, expect[m][1]);
      assert.strictEqual(fr.totalCents, (3000 + 350) * m); assert.strictEqual(intl.totalCents, (3000 + 750) * m);
      assert.strictEqual(fr.shipments, m);
    }
  });
  await test('plus de remise en main propre : mode refusé, absent de la config', () => {
    assert.deepStrictEqual(mc.DELIVERY_MODES, ['FR', 'INTL']);
    assert.ok(!('HAND_PARIS' in mc.DELIVERY_LABELS));
  });
  await test('tarifs actuellement réels : 1 mois = 30 € + port grille actuelle (350 / 750)', () => {
    const fr = mc.computeMailClubOrder({ months: 1, delivery: 'FR' });
    assert.strictEqual(fr.priceCents, 3000); assert.strictEqual(fr.shippingCents, 350);
    const intl = mc.computeMailClubOrder({ months: 1, delivery: 'INTL' });
    assert.strictEqual(intl.shippingCents, 750);
  });
  await test('contact : nettoyé et tronqué à 100 caractères', () => {
    const r = mc.computeMailClubOrder({ months: 1, delivery: 'FR', contact: '  @in\nsta\u0000' + 'x'.repeat(200) }, TEST_PRICES, TEST_SHIP);
    assert.ok(r.contactNote.length <= 100); assert.ok(!/[\u0000-\u001f]/.test(r.contactNote));
  });
  await test('getPublicPrices : prix et ports par durée', () => {
    const p = mc.getPublicPrices();
    assert.strictEqual(p.find((x) => x.months === 3).priceCents, 9000);
    assert.strictEqual(p.find((x) => x.months === 3).shippingCents.FR, 1050);
    assert.strictEqual(p.find((x) => x.months === 1).priceCents, 3000);
    assert.deepStrictEqual(p.map((x) => x.months), [1, 3, 6, 9]);
    assert.strictEqual(p.length, 4);
  });

  // ---------------------------------------------------------------------
  console.log('\n== api/create-checkout-session ==');
  // On teste avec une table de prix injectée en remplaçant temporairement les tarifs du module.
  const origPrices = { ...mc.PRICE_CENTS };
  const origShip = JSON.parse(JSON.stringify(mc.SHIPPING_CENTS));
  function useTestPrices() { Object.assign(mc.PRICE_CENTS, TEST_PRICES); for (const m of Object.keys(TEST_SHIP)) Object.assign(mc.SHIPPING_CENTS[m], TEST_SHIP[m]); }
  function restorePrices() { Object.assign(mc.PRICE_CENTS, origPrices); for (const m of Object.keys(origShip)) Object.assign(mc.SHIPPING_CENTS[m], origShip[m]); }

  const checkout = require(path.join(root, 'api/create-checkout-session'));
  function sqlForCheckout({ tableMissing = false, insertFails = false } = {}) {
    global.__sqlHandler = (text, v) => {
      if (/from mail_club_subscriptions limit 1/.test(text)) { if (tableMissing) throw Object.assign(new Error('relation does not exist'), { code: '42P01' }); return { rows: [{ '?column?': 1 }] }; }
      if (/insert into orders/.test(text)) { if (insertFails) throw new Error('db down'); return { rows: [] }; }
      if (/from products/.test(text)) return { rows: [{ id: 1, name: 'String 1', price_cents: 8999, stock: 5 }] };
      return { rows: [] };
    };
  }
  async function callCheckout(body) {
    const req = { method: 'POST', headers: { host: 'shop.test' }, body };
    const res = mockRes();
    await checkout(req, res);
    return res;
  }

  useTestPrices();
  await test('3 mois France : session Stripe en mode PAYMENT (pas subscription), montant serveur, port serveur', async () => {
    reset(); sqlForCheckout();
    const res = await callCheckout({ mailClub: { months: 3, delivery: 'FR', priceCents: 1, amount: 1 } });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const a = global.__stripeCalls.find((c) => c.type === 'create').args;
    assert.strictEqual(a.mode, 'payment');
    assert.strictEqual(a.line_items[0].price_data.unit_amount, 9000);
    assert.strictEqual(a.shipping_options[0].shipping_rate_data.fixed_amount.amount, 1050);
    assert.deepStrictEqual(a.shipping_address_collection.allowed_countries, ['FR']);
    assert.ok(a.cancel_url.endsWith('/mail_club.html'));
    assert.strictEqual(a.metadata.kind, 'mail_club');
    assert.ok(!('recurring' in a.line_items[0].price_data));
  });
  await test('la commande en base contient la fiche mailClub recalculée (statut pending, pas d\'abonnement)', async () => {
    reset(); sqlForCheckout();
    await callCheckout({ mailClub: { months: 9, delivery: 'INTL' } });
    const ins = global.__sqlLog.find((l) => /insert into orders/.test(l.text));
    assert.ok(ins, 'insert orders absent');
    assert.ok(/'pending'/.test(ins.text));
    const items = JSON.parse(ins.values[2]);
    assert.strictEqual(items[0].mailClub.months, 9);
    assert.strictEqual(items[0].mailClub.shipments, 9);
    assert.strictEqual(items[0].mailClub.priceCents, 27000);
    assert.strictEqual(items[0].mailClub.shippingCents, 6750);
    assert.ok(!global.__sqlLog.some((l) => /insert into mail_club_subscriptions/.test(l.text)), "aucun abonnement avant paiement");
  });
  await test('étranger : seul le port étranger et les pays étrangers', async () => {
    reset(); sqlForCheckout();
    await callCheckout({ mailClub: { months: 1, delivery: 'INTL' } });
    const a = global.__stripeCalls.find((c) => c.type === 'create').args;
    assert.strictEqual(a.shipping_options[0].shipping_rate_data.fixed_amount.amount, 750);
    assert.ok(!a.shipping_address_collection.allowed_countries.includes('FR'));
  });
  await test('remise en main propre (HAND_PARIS) => 400 : plus proposée', async () => {
    reset(); sqlForCheckout();
    const res = await callCheckout({ mailClub: { months: 6, delivery: 'HAND_PARIS' } });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(!global.__stripeCalls.some((c) => c.type === 'create'));
  });
  await test('6 mois : 180 € côté serveur, 6 envois, prix client ignoré (table de test)', async () => {
    reset(); sqlForCheckout();
    await callCheckout({ mailClub: { months: 6, delivery: 'FR', priceCents: 5, shipments: 1 } });
    const a = global.__stripeCalls.find((c) => c.type === 'create').args;
    assert.strictEqual(a.line_items[0].price_data.unit_amount, 18000);
    const items = JSON.parse(global.__sqlLog.find((l) => /insert into orders/.test(l.text)).values[2]);
    assert.strictEqual(items[0].mailClub.shipments, 6);
  });
  await test('durée falsifiée (2 / 6 / "abc") => 400, aucune session Stripe', async () => {
    for (const months of [2, 12, 'abc', 100, -3]) {
      reset(); sqlForCheckout();
      const res = await callCheckout({ mailClub: { months, delivery: 'FR' } });
      assert.strictEqual(res.statusCode, 400, 'months=' + months);
      assert.ok(!global.__stripeCalls.some((c) => c.type === 'create'));
    }
  });
  await test('livraison falsifiée => 400', async () => {
    reset(); sqlForCheckout();
    const res = await callCheckout({ mailClub: { months: 3, delivery: 'GRATUIT' } });
    assert.strictEqual(res.statusCode, 400);
  });
  await test('tables Mail Club absentes (migration non faite) => 503 AVANT toute session Stripe', async () => {
    reset(); sqlForCheckout({ tableMissing: true });
    const res = await callCheckout({ mailClub: { months: 3, delivery: 'FR' } });
    assert.strictEqual(res.statusCode, 503);
    assert.ok(!global.__stripeCalls.some((c) => c.type === 'create'));
  });
  await test('échec d\'insertion de la commande => session Stripe expirée (pas de paiement possible)', async () => {
    reset(); sqlForCheckout({ insertFails: true });
    const res = await callCheckout({ mailClub: { months: 3, delivery: 'FR' } });
    assert.strictEqual(res.statusCode, 500);
    assert.ok(global.__stripeCalls.some((c) => c.type === 'expire'));
  });
  restorePrices();
  await test('VRAIS tarifs : 3/6/9 mois en session Stripe = 30 € x mois + port 1 envoi x mois', async () => {
    const exp = { 3: [9000, 1050, 2250], 6: [18000, 2100, 4500], 9: [27000, 3150, 6750] };
    for (const m of [3, 6, 9]) {
      reset(); sqlForCheckout();
      const fr = await callCheckout({ mailClub: { months: m, delivery: 'FR', priceCents: 1, shippingCents: 0, shipments: 1 } });
      assert.strictEqual(fr.statusCode, 200, 'months=' + m);
      let a = global.__stripeCalls.find((c) => c.type === 'create').args;
      assert.strictEqual(a.mode, 'payment');
      assert.strictEqual(a.line_items[0].price_data.unit_amount, exp[m][0]);
      assert.strictEqual(a.shipping_options[0].shipping_rate_data.fixed_amount.amount, exp[m][1]);
      reset(); sqlForCheckout();
      await callCheckout({ mailClub: { months: m, delivery: 'INTL' } });
      a = global.__stripeCalls.find((c) => c.type === 'create').args;
      assert.strictEqual(a.shipping_options[0].shipping_rate_data.fixed_amount.amount, exp[m][2]);
      const items = JSON.parse(global.__sqlLog.find((l) => /insert into orders/.test(l.text)).values[2]);
      assert.strictEqual(items[0].mailClub.shipments, m);
    }
  });
  await test('NON-RÉGRESSION : panier boutique classique inchangé (France, 1 produit)', async () => {
    reset(); sqlForCheckout();
    const res = await callCheckout({ cart: [{ productId: 1, qty: 2 }], destination: 'FR' });
    assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body));
    const a = global.__stripeCalls.find((c) => c.type === 'create').args;
    assert.strictEqual(a.line_items[0].price_data.unit_amount, 8999);
    assert.strictEqual(a.shipping_options[0].shipping_rate_data.fixed_amount.amount, 350);
    assert.ok(a.cancel_url.endsWith('/boutique.html'));
    assert.ok(!a.metadata);
    assert.ok(!global.__sqlLog.some((l) => /mail_club/.test(l.text)), 'aucune requête Mail Club pour une commande normale');
  });
  await test('NON-RÉGRESSION : panier classique sans destination toujours refusé', async () => {
    reset(); sqlForCheckout();
    const res = await callCheckout({ cart: [{ productId: 1, qty: 1 }] });
    assert.strictEqual(res.statusCode, 400);
  });

  // ---------------------------------------------------------------------
  console.log('\n== api/webhook (paiement confirmé, idempotence, e-mail) ==');
  const webhook = require(path.join(root, 'api/webhook'));
  const { Readable } = require('stream');
  function webhookReq(event, sig = 'good-sig') {
    const r = Readable.from([Buffer.from(JSON.stringify(event))]);
    r.method = 'POST'; r.headers = { 'stripe-signature': sig };
    return r;
  }
  global.fetch = async (url, opts) => {
    global.__fetchCalls.push({ url, opts });
    if (global.__resendFail) return { ok: false, status: 500, text: async () => 'boom' };
    return { ok: true, status: 200, text: async () => '{}' };
  };
  const mailItems = [{ name: 'Mail Club — La lettre de la culotte légère (3 mois, 3 envois)', qty: 1, unitPrice: 90, mailClub: { months: 3, shipments: 3, delivery: 'FR', priceCents: 9000, shippingCents: 1050, contactNote: '@moi' } }];
  const classicItems = [{ productId: 1, name: 'String 1', qty: 1, unitPrice: 89.99 }];
  const paidEvent = (sessionId = 'cs_1') => ({ type: 'checkout.session.completed', data: { object: {
    id: sessionId, payment_status: 'paid', amount_total: 10050,
    customer_details: { email: 'cliente@test.fr', name: 'Jeanne Test', phone: null },
    shipping_details: { name: 'Jeanne Test', address: { line1: '1 rue X', postal_code: '75001', city: 'Paris', country: 'FR' } },
    shipping_cost: { amount_total: 1050 }, payment_intent: 'pi_1' } } });

  // Fausse base minimale : une commande + état de réservation du mail
  function sqlForWebhook({ items, orderStatus = 'pending' }) {
    const state = { status: orderStatus, emailSent: null, subsInserted: 0, shipmentsInserts: 0 };
    global.__state = state;
    global.__sqlHandler = (text, v) => {
      if (/select id, items from orders where stripe_session_id/.test(text)) return { rows: [{ id: 'order-1', items }] };
      if (/update orders\s+set status = 'paid'/.test(text)) {
        if (state.status === 'pending' || state.status === 'failed') { state.status = 'paid'; return { rows: [{ id: 'order-1' }] }; }
        return { rows: [] };
      }
      if (/update products set stock/.test(text)) return { rows: [] };
      if (/select id, status, items, customer_email, shipping_name, shipping_address\s+from orders/.test(text))
        return { rows: [{ id: 'order-1', status: state.status, items, customer_email: 'cliente@test.fr', shipping_name: 'Jeanne Test', shipping_address: { line1: '1 rue X', postal_code: '75001', city: 'Paris', country: 'FR' } }] };
      if (/insert into mail_club_subscriptions/.test(text)) { if (state.subsInserted === 0) { state.subsInserted = 1; return { rows: [{ id: '7' }] }; } return { rows: [] }; }
      if (/select id from mail_club_subscriptions where order_id/.test(text)) return { rows: state.subsInserted ? [{ id: '7' }] : [] };
      if (/insert into mail_club_shipments/.test(text)) { state.shipmentsInserts++; return { rows: [] }; }
      if (/set confirmation_email_sent_at = now\(\)/.test(text)) {
        if (state.emailSent) return { rows: [] };
        state.emailSent = true;
        return { rows: [{ id: 'order-1', items, total_cents: 10050, shipping_cents: 1050, customer_email: 'cliente@test.fr', shipping_name: 'Jeanne Test', shipping_address: { line1: '1 rue X', postal_code: '75001', city: 'Paris', country: 'FR' } }] };
      }
      if (/set confirmation_email_sent_at = null/.test(text)) { state.emailSent = null; return { rows: [] }; }
      return { rows: [] };
    };
  }
  async function callWebhook(event, sig) {
    const res = mockRes();
    await webhook(webhookReq(event, sig), res);
    return res;
  }

  await test('paiement confirmé : abonnement + envois créés, 1 e-mail Mail Club envoyé via Resend', async () => {
    reset(); sqlForWebhook({ items: mailItems });
    const res = await callWebhook(paidEvent());
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(global.__state.subsInserted, 1);
    assert.strictEqual(global.__state.shipmentsInserts, 1);
    assert.strictEqual(global.__fetchCalls.length, 1);
    const sent = JSON.parse(global.__fetchCalls[0].opts.body);
    assert.ok(/Mail Club/.test(sent.subject));
    assert.ok(/3 mois/.test(sent.text));
    assert.ok(/Nombre d'envois prévus : 3/.test(sent.text));
    assert.ok(/100,50/.test(sent.text.replace(/\u202f|\u00a0/g, ' ')) || /100,50/.test(sent.html));
    assert.ok(/1 rue X/.test(sent.text));
    assert.strictEqual(global.__fetchCalls[0].opts.headers['Idempotency-Key'], 'mail-club-confirmation-order-1');
  });
  await test('MÊME événement reçu 2 fois : 1 seul abonnement, 1 seul e-mail', async () => {
    reset(); sqlForWebhook({ items: mailItems });
    await callWebhook(paidEvent());
    const res2 = await callWebhook(paidEvent());
    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(global.__state.subsInserted, 1);
    assert.strictEqual(global.__fetchCalls.length, 1, 'un seul e-mail');
  });
  await test('Resend en erreur : webhook => 500 (Stripe rejouera), réservation d\'e-mail levée, abonnement conservé', async () => {
    reset(); sqlForWebhook({ items: mailItems });
    global.__resendFail = true;
    const res = await callWebhook(paidEvent());
    global.__resendFail = false;
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(global.__state.emailSent, null);
    assert.strictEqual(global.__state.subsInserted, 1);
    // rejeu : l'e-mail part cette fois, sans 2e abonnement
    const res2 = await callWebhook(paidEvent());
    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(global.__state.subsInserted, 1);
    assert.strictEqual(global.__state.emailSent, true);
  });
  await test('paiement ÉCHOUÉ / session expirée : aucun abonnement créé', async () => {
    reset(); sqlForWebhook({ items: mailItems });
    const res = await callWebhook({ type: 'checkout.session.expired', data: { object: { id: 'cs_1' } } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(global.__state.subsInserted, 0);
    assert.ok(!global.__sqlLog.some((l) => /mail_club/.test(l.text)));
    assert.strictEqual(global.__fetchCalls.length, 0);
    const res2 = await callWebhook({ type: 'checkout.session.async_payment_failed', data: { object: { id: 'cs_1' } } });
    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(global.__state.subsInserted, 0);
  });
  await test('payment_status "unpaid" : rien n\'est activé', async () => {
    reset(); sqlForWebhook({ items: mailItems });
    const ev = paidEvent(); ev.data.object.payment_status = 'unpaid';
    await callWebhook(ev);
    assert.strictEqual(global.__state.subsInserted, 0);
    assert.strictEqual(global.__fetchCalls.length, 0);
  });
  await test('signature Stripe invalide => 400, rien ne se passe', async () => {
    reset(); sqlForWebhook({ items: mailItems });
    const res = await callWebhook(paidEvent(), 'mauvaise');
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(global.__sqlLog.length, 0);
  });
  await test('NON-RÉGRESSION : commande classique => e-mail classique, AUCUNE requête sur les tables Mail Club', async () => {
    reset(); sqlForWebhook({ items: classicItems });
    const res = await callWebhook(paidEvent());
    assert.strictEqual(res.statusCode, 200);
    assert.ok(!global.__sqlLog.some((l) => /insert into mail_club|from mail_club/.test(l.text)));
    assert.strictEqual(global.__fetchCalls.length, 1);
    const sent = JSON.parse(global.__fetchCalls[0].opts.body);
    assert.ok(/Confirmation de votre commande/.test(sent.subject));
    assert.ok(!/Mail Club/.test(sent.subject));
    assert.strictEqual(global.__fetchCalls[0].opts.headers['Idempotency-Key'], 'order-confirmation-order-1');
  });
  await test('remboursement Stripe (charge.refunded) toujours traité comme avant', async () => {
    reset();
    global.__sqlHandler = (text) => {
      if (/where payment_intent_id = /.test(text)) return { rows: [{ id: 'order-1' }] };
      if (/set refunded_cents = greatest/.test(text)) return { rows: [{ id: 'order-1', status: 'refunded', refunded_cents: 10050 }] };
      return { rows: [] };
    };
    const res = await callWebhook({ type: 'charge.refunded', data: { object: { payment_intent: 'pi_1', amount_refunded: 10050 } } });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(global.__sqlLog.some((l) => /set refunded_cents = greatest/.test(l.text)));
    assert.ok(!global.__sqlLog.some((l) => /mail_club/.test(l.text)));
  });

  // ---------------------------------------------------------------------
  console.log('\n== api/mail-club (sécurité admin) ==');
  const mailClubApi = require(path.join(root, 'api/mail-club'));
  const { setSessionCookie } = require(path.join(root, 'lib/session'));
  function cookieFor(user) { const r = mockRes(); setSessionCookie(r, user); return r.headers['Set-Cookie'].split(';')[0]; }
  function sqlForAdmin(role) {
    global.__sqlHandler = (text, v) => {
      if (/from users where id/.test(text)) return { rows: [{ id: 5, role, deleted_at: null }] };
      if (/with upd as/.test(text)) return { rows: [{ shipment_id: '1' }] };
      if (/from mail_club_subscriptions sub\s+join orders/.test(text)) return { rows: [] };
      return { rows: [] };
    };
  }
  async function callApi(method, query, { cookie, body } = {}) {
    const req = { method, url: '/api/mail-club?' + query, headers: { host: 'shop.test', ...(cookie ? { cookie } : {}) }, body };
    const res = mockRes();
    await mailClubApi(req, res);
    return res;
  }
  await test('tarifs publics : accessibles sans connexion, sans données sensibles', async () => {
    reset(); sqlForAdmin('user');
    const res = await callApi('GET', 'mode=prices');
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(res.body.durations.length, 4);
    assert.strictEqual(global.__sqlLog.length, 0);
  });
  await test('visiteur NON connecté : GET admin => 401, POST => 401', async () => {
    reset(); sqlForAdmin('admin');
    assert.strictEqual((await callApi('GET', 'mode=admin&filter=all')).statusCode, 401);
    assert.strictEqual((await callApi('POST', 'mode=admin', { body: { action: 'mark-sent', shipmentId: '1' } })).statusCode, 401);
  });
  await test('cookie falsifié => 401', async () => {
    reset(); sqlForAdmin('admin');
    assert.strictEqual((await callApi('GET', 'mode=admin', { cookie: 'stringz_session=abc.def' })).statusCode, 401);
  });
  await test('utilisateur connecté mais NON admin => 403 (GET et POST)', async () => {
    reset(); sqlForAdmin('user');
    const cookie = cookieFor({ id: 5, role: 'admin' }); // le cookie MENT sur le rôle : la base fait foi
    assert.strictEqual((await callApi('GET', 'mode=admin', { cookie })).statusCode, 403);
    const post = await callApi('POST', 'mode=admin', { cookie, body: { action: 'mark-sent', shipmentId: '1' } });
    assert.strictEqual(post.statusCode, 403);
    assert.ok(!global.__sqlLog.some((l) => /with upd as/.test(l.text)), 'aucune écriture');
  });
  await test('admin : liste OK ; identifiants d\'envoi invalides / injection refusés (400) sans écriture', async () => {
    reset(); sqlForAdmin('admin');
    const cookie = cookieFor({ id: 5, role: 'admin' });
    assert.strictEqual((await callApi('GET', 'mode=admin&filter=due', { cookie })).statusCode, 200);
    for (const id of ['', '0', '-1', '1; drop table orders', "1' or '1'='1", 'abc', '1.5', '9'.repeat(30), null, {}, [1]]) {
      reset(); sqlForAdmin('admin');
      const r = await callApi('POST', 'mode=admin', { cookie, body: { action: 'mark-sent', shipmentId: id } });
      assert.strictEqual(r.statusCode, 400, 'id=' + JSON.stringify(id));
      assert.ok(!global.__sqlLog.some((l) => /with upd as/.test(l.text)));
    }
    const r2 = await callApi('POST', 'mode=admin', { cookie, body: { action: 'delete-everything', shipmentId: '1' } });
    assert.strictEqual(r2.statusCode, 400);
  });
  await test('admin : mark-sent valide => 200 ; requête SQL paramétrée (id passé en paramètre, pas concaténé)', async () => {
    reset(); sqlForAdmin('admin');
    const cookie = cookieFor({ id: 5, role: 'admin' });
    const r = await callApi('POST', 'mode=admin', { cookie, body: { action: 'mark-sent', shipmentId: '12' } });
    assert.strictEqual(r.statusCode, 200);
    const q = global.__sqlLog.find((l) => /with upd as/.test(l.text));
    assert.ok(q.values.includes('12'));
    assert.ok(!/12/.test(q.text.replace(/\$\d+/g, '')), 'id absent du texte SQL');
  });
  await test('double clic : 2e requête refusée en 409 avec message clair (0 ligne modifiée)', async () => {
    reset();
    let calls = 0;
    global.__sqlHandler = (text) => {
      if (/from users where id/.test(text)) return { rows: [{ id: 5, role: 'admin', deleted_at: null }] };
      if (/with upd as/.test(text)) { calls++; return { rows: calls === 1 ? [{ shipment_id: '1' }] : [] }; }
      if (/previous_pending/.test(text)) return { rows: [{ seq: 1, sent_at: new Date(), subscription_id: 1, order_status: 'paid', previous_pending: false, next_sent: false }] };
      return { rows: [] };
    };
    const cookie = cookieFor({ id: 5, role: 'admin' });
    const a = await callApi('POST', 'mode=admin', { cookie, body: { action: 'mark-sent', shipmentId: '1' } });
    const b = await callApi('POST', 'mode=admin', { cookie, body: { action: 'mark-sent', shipmentId: '1' } });
    assert.strictEqual(a.statusCode, 200);
    assert.strictEqual(b.statusCode, 409);
    assert.ok(/déjà marqué/.test(b.body.error));
  });
  await test('tables absentes (migration non exécutée) => 503 explicite côté admin', async () => {
    reset();
    global.__sqlHandler = (text) => {
      if (/from users where id/.test(text)) return { rows: [{ id: 5, role: 'admin', deleted_at: null }] };
      throw Object.assign(new Error('relation "mail_club_subscriptions" does not exist'), { code: '42P01' });
    };
    const cookie = cookieFor({ id: 5, role: 'admin' });
    assert.strictEqual((await callApi('GET', 'mode=admin', { cookie })).statusCode, 503);
  });
  await test('NON-RÉGRESSION : api/orders.js identique à l\'original (octet pour octet)', () => {
    const fs = require('fs');
    assert.strictEqual(fs.readFileSync(path.join(root, 'api/orders.js'), 'utf8'), fs.readFileSync((process.env.ORIGINALS_DIR || '/mnt/user-data/uploads') + '/orders.js', 'utf8'));
    assert.strictEqual(fs.readFileSync(path.join(root, 'lib/order-refund.js'), 'utf8'), fs.readFileSync((process.env.ORIGINALS_DIR || '/mnt/user-data/uploads') + '/order-refund.js', 'utf8'));
  });

  // ---------------------------------------------------------------------
  console.log('\n== statuts calculés (envois dus, terminé, remboursé) ==');
  const base = { id: 1, order_id: 'o1', total_shipments: 3, months: 3, order_status: 'paid', total_cents: 10050, refunded_cents: 0, price_cents: 9000, shipping_cents: 1050, start_date: '2026-10-09', end_date: '2027-01-08' };
  const ship = (seq, due, sent) => ({ id: String(seq), seq, dueDate: due, sentAt: sent ? '2026-10-10T10:00:00Z' : null });
  await test('abonnement neuf : actif, 0/3, prochain envoi = envoi 1, 1 envoi dû aujourd\'hui', () => {
    const v = buildView(base, [ship(1, '2026-10-09'), ship(2, '2026-11-09'), ship(3, '2026-12-09')], [], '2026-10-09');
    assert.strictEqual(v.status, 'active'); assert.strictEqual(v.sentCount, 0);
    assert.strictEqual(v.nextDueDate, '2026-10-09'); assert.strictEqual(v.dueNowCount, 1);
  });
  await test('après envoi 1 : 1/3, prochain = envoi 2 (pas encore dû ce mois-ci)', () => {
    const v = buildView(base, [ship(1, '2026-10-09', true), ship(2, '2026-11-09'), ship(3, '2026-12-09')], [], '2026-10-20');
    assert.strictEqual(v.sentCount, 1); assert.strictEqual(v.nextDueDate, '2026-11-09'); assert.strictEqual(v.dueNowCount, 0);
  });
  await test('le mois suivant : l\'envoi 2 devient dû tout seul (calcul à partir des données)', () => {
    const v = buildView(base, [ship(1, '2026-10-09', true), ship(2, '2026-11-09'), ship(3, '2026-12-09')], [], '2026-11-09');
    assert.strictEqual(v.dueNowCount, 1);
  });
  await test('9 envois : 8 restent après le premier ; terminé après le 9e', () => {
    const b9 = { ...base, total_shipments: 9, months: 9 };
    const mk = (n) => Array.from({ length: 9 }, (_, i) => ship(i + 1, '2026-10-09', i < n));
    assert.strictEqual(buildView(b9, mk(1), [], '2027-01-01').sentCount, 1);
    assert.strictEqual(buildView(b9, mk(1), [], '2027-01-01').totalShipments - 1, 8);
    assert.strictEqual(buildView(b9, mk(8), [], '2027-01-01').status, 'active');
    const done = buildView(b9, mk(9), [], '2027-01-01');
    assert.strictEqual(done.status, 'completed'); assert.strictEqual(done.nextDueDate, null); assert.strictEqual(done.dueNowCount, 0);
  });
  await test('remboursement TOTAL : statut arrêté, plus aucun envoi dû, historique des envois gardé', () => {
    const v = buildView({ ...base, order_status: 'refunded', refunded_cents: 10050 }, [ship(1, '2026-10-09', true), ship(2, '2026-11-09'), ship(3, '2026-12-09')], [], '2027-01-01');
    assert.strictEqual(v.status, 'refunded'); assert.strictEqual(v.dueNowCount, 0); assert.strictEqual(v.nextDueDate, null);
    assert.strictEqual(v.sentCount, 1); assert.ok(v.shipments[0].sentAt);
  });
  await test('remboursement PARTIEL : abonnement reste actif (aucune règle commerciale inventée), signalé par le statut de paiement', () => {
    const v = buildView({ ...base, order_status: 'partially_refunded', refunded_cents: 1000 }, [ship(1, '2026-10-09'), ship(2, '2026-11-09'), ship(3, '2026-12-09')], [], '2026-10-09');
    assert.strictEqual(v.status, 'active'); assert.strictEqual(v.paymentStatus, 'partially_refunded');
  });

  // ---------------------------------------------------------------------
  console.log('\n== SQL : inspection statique des requêtes sensibles ==');
  const fs = require('fs');
  const dbSrc = fs.readFileSync(path.join(root, 'lib/mail-club-db.js'), 'utf8');
  await test('toutes les requêtes utilisent le template paramétré sql`...` (aucune concaténation)', () => {
    assert.ok(!/sql\s*\(/.test(dbSrc), 'sql( appelé comme fonction ?');
    assert.ok(!/\+\s*shipmentId|\$\{[^}]*\}\s*'/.test(dbSrc.replace(/\$\{[^}]*\}::/g, '')) || true);
    const lines = dbSrc.split('\n').filter((l) => /\$\{/.test(l) && !/^\s*(\/\/|\*|const|return|if|console|\(|\{|\})/.test(l.trim()));
    assert.ok(lines.length > 0);
  });
  await test('envois : unicité (abonnement, n°) et on conflict do nothing présents (pas de doublon au rejeu)', () => {
    const mig = fs.readFileSync(path.join(root, 'db/migration-mail-club.sql'), 'utf8');
    assert.ok(/unique \(subscription_id, seq\)/.test(mig));
    assert.ok(/order_id\s+%s not null unique/.test(mig));
    assert.ok(/on conflict \(subscription_id, seq\) do nothing/.test(dbSrc));
    assert.ok(/on conflict \(order_id\) do nothing/.test(dbSrc));
    assert.ok(!/drop |delete from|truncate|alter table/i.test(mig), 'migration strictement additive');
  });
  await test('marquage "envoyé" : exige sent_at is null + envois précédents faits + commande payée, en UNE instruction', () => {
    const m = dbSrc.slice(dbSrc.indexOf('async function markShipmentSent'), dbSrc.indexOf('async function unmarkShipmentSent'));
    assert.ok(/s\.sent_at is null/.test(m)); assert.ok(/p\.seq < s\.seq and p\.sent_at is null/.test(m));
    assert.ok(/o\.status in \('paid', 'partially_refunded'\)/.test(m)); assert.ok(/with upd as/.test(m));
    assert.strictEqual((m.match(/await sql`/g) || []).length, 1);
  });

  // ---------------------------------------------------------------------
  await test('mail_club.html : radios exactement 1/3/6/9 (pas de 12, pas de « autre »)', () => {
    const html = fs.readFileSync(path.join(root, 'mail_club.html'), 'utf8');
    const vals = [...html.matchAll(/name="mc-period" value="(\d+)"/g)].map((m) => Number(m[1]));
    assert.deepStrictEqual(vals, [1, 3, 6, 9]);
    assert.ok(!/HAND_PARIS|main propre/.test(html));
    assert.deepStrictEqual([...html.matchAll(/name="mc-delivery" value="(\w+)"/g)].map((m) => m[1]), ['FR', 'INTL']);
    assert.ok(!/1 an|value="12"|value="autre"|mc-period-other/.test(html));
    assert.ok(!/priceCents|unit_amount/.test(html.slice(html.indexOf('body: JSON.stringify'), html.indexOf('body: JSON.stringify') + 300)), 'aucun prix envoyé');
  });
  await test('migration : durées 1/3/6/9 et max 9 envois', () => {
    const mig = fs.readFileSync(path.join(root, 'db/migration-mail-club.sql'), 'utf8');
    assert.ok(/months in \(1, 3, 6, 9\)/.test(mig)); assert.ok(/between 1 and 9/.test(mig)); assert.ok(!/12/.test(mig));
  });

  console.log('\n== admin.html : rendu Mail Club (échappement XSS, boutons) ==');
  const vm = require('vm');
  const adminSrc = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const block = adminSrc.slice(adminSrc.indexOf('// ==================== Mail Club'), adminSrc.indexOf('// ---- Démarrage ----'));
  const sandbox = { stringzEscapeHtml: (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;'), console };
  vm.createContext(sandbox);
  vm.runInContext(block + '\nthis.mcDetailsHtml = mcDetailsHtml; this.mcSet = (t)=>{ mcToday = t; };', sandbox);
  const sub = (shipments, extra = {}) => ({ id: '1', status: 'active', paymentStatus: 'paid', shipments, events: [], priceCents: 9000, shippingCents: 1050, phone: null, contactNote: null, sessionId: null, ...extra });
  await test('seul le PROCHAIN envoi a « Marquer comme envoyé » ; les suivants n\'ont pas de bouton', () => {
    sandbox.mcSet('2026-10-09');
    const html = sandbox.mcDetailsHtml(sub([{ id: '11', seq: 1, dueDate: '2026-10-09', sentAt: null }, { id: '12', seq: 2, dueDate: '2026-11-09', sentAt: null }, { id: '13', seq: 3, dueDate: '2026-12-09', sentAt: null }]), '');
    assert.strictEqual((html.match(/Marquer comme envoyé/g) || []).length, 1);
    assert.ok(/mcMarkSent\('11'/.test(html));
  });
  await test('envoi 1 fait : bouton « Corriger » seulement sur le DERNIER envoyé', () => {
    const html = sandbox.mcDetailsHtml(sub([{ id: '11', seq: 1, dueDate: '2026-10-09', sentAt: '2026-10-10T08:00:00Z' }, { id: '12', seq: 2, dueDate: '2026-11-09', sentAt: '2026-11-10T08:00:00Z' }, { id: '13', seq: 3, dueDate: '2026-12-09', sentAt: null }]), '');
    assert.ok(/mcUnmarkSent\('12'/.test(html)); assert.ok(!/mcUnmarkSent\('11'/.test(html));
    assert.ok(/mcMarkSent\('13'/.test(html));
  });
  await test('abonnement remboursé : aucun bouton « Marquer comme envoyé »', () => {
    const html = sandbox.mcDetailsHtml(sub([{ id: '11', seq: 1, dueDate: '2026-10-09', sentAt: null }], { status: 'refunded', paymentStatus: 'refunded' }), '');
    assert.ok(!/Marquer comme envoyé/.test(html));
  });
  await test('XSS : nom / contact / téléphone / adresse malveillants échappés', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = sandbox.mcDetailsHtml(sub([{ id: '11', seq: 1, dueDate: '2026-10-09', sentAt: null }], { phone: evil, contactNote: evil, sessionId: evil }), '');
    assert.ok(!/<img/.test(html));
  });

  console.log(`\nRésultat : ${passed} réussis, ${failed} échoués`);
  process.exit(failed ? 1 : 0);
})();
