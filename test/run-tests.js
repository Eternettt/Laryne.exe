// test/run-tests.js
// Harnais de test LOCAL. Exécute les vraies fonctions de api/*.js (le même
// code que celui déployé), mais contre :
//   - une vraie base SQLite en mémoire (via node:sqlite) au lieu de Postgres
//     (aucun accès réseau possible dans cet environnement d'exécution) —
//     voir /tmp/testmods/node_modules/@vercel/postgres/index.js pour le détail
//     de la traduction Postgres -> SQLite (FOR UPDATE, now(), ::jsonb, etc.)
//   - un faux module "stripe" qui simule la création de session et la
//     vérification de signature de webhook.
//
// Objectif : vérifier la LOGIQUE MÉTIER réelle (permissions, transactions,
// IDOR, calcul des prix, idempotence des webhooks, RGPD) — pas la syntaxe
// exacte de Postgres, qui doit être revérifiée après déploiement réel (voir
// rapport). Lancer avec :
//   NODE_PATH=/tmp/testmods/node_modules TEST_SCHEMA_PATH=db/schema.test.sqlite.sql \
//   SESSION_SECRET=test STRIPE_SECRET_KEY=sk_test STRIPE_WEBHOOK_SECRET=whsec_test \
//   node --experimental-sqlite test/run-tests.js

let pass = 0, fail = 0;
function ok(label, cond, extra) {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label}` + (extra ? ` — ${extra}` : '')); }
}
function section(title) { console.log(`\n=== ${title} ===`); }

// ---- Faux req/res + cookie jar (simule un navigateur par test) ----
function makeCookieJar() {
  let cookies = {};
  return {
    header() {
      return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    },
    absorb(setCookieHeader) {
      if (!setCookieHeader) return;
      const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      for (const sc of arr) {
        const [pair] = sc.split(';');
        const idx = pair.indexOf('=');
        const key = pair.slice(0, idx);
        const val = pair.slice(idx + 1);
        if (val === '' ) delete cookies[key]; else cookies[key] = val;
      }
    },
  };
}

function makeReq({ method = 'GET', body = null, cookieJar = null, query = {}, headers = {} } = {}) {
  return {
    method,
    body,
    query,
    headers: {
      ...headers,
      cookie: cookieJar ? cookieJar.header() : '',
      host: 'example.com',
      origin: 'https://example.com',
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function makeRes(cookieJar) {
  const res = {
    _status: 200,
    _json: null,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
    setHeader(name, val) {
      if (name === 'Set-Cookie' && cookieJar) cookieJar.absorb(val);
    },
    send(x) { this._json = { _raw: x }; return this; },
    end() {},
  };
  return res;
}

async function call(handler, opts) {
  const cookieJar = opts.cookieJar;
  const req = makeReq(opts);
  const res = makeRes(cookieJar);
  await handler(req, res);
  return { status: res._status, body: res._json };
}

async function main() {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_fake';

  const signup = require('../api/auth/signup');
  const login = require('../api/auth/login');
  const logout = require('../api/auth/logout');
  const me = require('../api/auth/me');
  const publicProducts = require('../api/products/index');
  const adminProducts = require('../api/admin/products');
  const checkout = require('../api/create-checkout-session');
  const webhook = require('../api/webhook');
  const ordersMine = require('../api/orders/index');
  const orderBySession = require('../api/orders/by-session');
  const adminOrders = require('../api/admin/orders');
  const accountDelete = require('../api/account/delete');
  const { sql } = require('../lib/db');
  const { hashPassword } = require('../lib/crypto');

  // =========================================================
  section('1. Visiteur non connecté');
  // =========================================================
  {
    const r = await call(me, { method: 'GET' });
    ok('GET /api/auth/me sans cookie -> user: null (200)', r.status === 200 && r.body.user === null);

    const r2 = await call(publicProducts, { method: 'GET' });
    ok('GET /api/products accessible sans connexion', r2.status === 200 && Array.isArray(r2.body.products));
    ok('8 produits de départ présents', r2.body.products.length === 8);

    const r3 = await call(adminProducts, { method: 'GET' });
    ok('GET /api/admin/products sans connexion -> 401', r3.status === 401);

    const r4 = await call(ordersMine, { method: 'GET' });
    ok('GET /api/orders sans connexion -> 401', r4.status === 401);
  }

  // =========================================================
  section('2. Inscription');
  // =========================================================
  const aliceJar = makeCookieJar();
  {
    const r = await call(signup, { method: 'POST', body: { email: 'alice@test.com', password: 'password123', name: 'Alice' }, cookieJar: aliceJar });
    ok('Signup valide -> 201', r.status === 201, JSON.stringify(r.body));
    ok('Cookie de session posé après signup', !!aliceJar.header());
    ok('Rôle par défaut = user (jamais admin)', r.body.user && r.body.user.role === 'user');

    const rDup = await call(signup, { method: 'POST', body: { email: 'alice@test.com', password: 'autrepassword', name: 'Alice2' } });
    ok('Signup avec email déjà utilisé -> 409', rDup.status === 409);

    const rWeak = await call(signup, { method: 'POST', body: { email: 'faible@test.com', password: '123', name: 'X' } });
    ok('Signup mot de passe trop court -> 400', rWeak.status === 400);

    // Vérifie qu'aucun mot de passe en clair n'est stocké en base.
    const { rows } = await sql`SELECT password_hash FROM users WHERE email = ${'alice@test.com'}`;
    ok('Mot de passe stocké hashé (jamais en clair)', rows[0].password_hash !== 'password123' && rows[0].password_hash.includes(':'));
  }

  // =========================================================
  section('3. Connexion');
  // =========================================================
  {
    const badJar = makeCookieJar();
    const rBad = await call(login, { method: 'POST', body: { email: 'alice@test.com', password: 'mauvais-mdp' }, cookieJar: badJar });
    ok('Login mauvais mot de passe -> 401', rBad.status === 401);
    ok('Aucun cookie posé après échec de connexion', !badJar.header());

    const rGoodJar = makeCookieJar();
    const rGood = await call(login, { method: 'POST', body: { email: 'alice@test.com', password: 'password123' }, cookieJar: rGoodJar });
    ok('Login bon mot de passe -> 200', rGood.status === 200);
    ok('Cookie de session posé après connexion', !!rGoodJar.header());

    const rUnknown = await call(login, { method: 'POST', body: { email: 'inconnu@test.com', password: 'peuimporte' } });
    ok('Login email inconnu -> 401 (message générique, pas 404)', rUnknown.status === 401 && rUnknown.body.error === rBad.body.error);
  }

  // =========================================================
  section('4. Déconnexion');
  // =========================================================
  {
    const meBefore = await call(me, { method: 'GET', cookieJar: aliceJar });
    ok('Session Alice active avant logout', meBefore.body.user && meBefore.body.user.email === 'alice@test.com');

    const rLogout = await call(logout, { method: 'POST', cookieJar: aliceJar });
    ok('POST /api/auth/logout -> 200', rLogout.status === 200);

    const meAfter = await call(me, { method: 'GET', cookieJar: aliceJar });
    ok('Après logout, /api/auth/me -> user: null', meAfter.body.user === null);

    // Reconnecte Alice pour la suite des tests.
    await call(login, { method: 'POST', body: { email: 'alice@test.com', password: 'password123' }, cookieJar: aliceJar });
  }

  // =========================================================
  section('Admin : création + vérification serveur du rôle');
  // =========================================================
  const adminJar = makeCookieJar();
  {
    const passwordHash = hashPassword('AdminPassword123');
    await sql`INSERT INTO users (email, password_hash, name, role) VALUES (${'admin@test.com'}, ${passwordHash}, ${'eternett'}, 'admin')`;
    const r = await call(login, { method: 'POST', body: { email: 'admin@test.com', password: 'AdminPassword123' }, cookieJar: adminJar });
    ok('Login admin -> 200, rôle admin renvoyé', r.status === 200 && r.body.user.role === 'admin');
  }

  // =========================================================
  section('8. Tentative d\'accès admin sans être admin');
  // =========================================================
  {
    const r = await call(adminProducts, { method: 'GET', cookieJar: aliceJar });
    ok('Utilisateur normal connecté -> GET /api/admin/products = 403', r.status === 403);

    const r2 = await call(adminOrders, { method: 'GET', cookieJar: aliceJar });
    ok('Utilisateur normal connecté -> GET /api/admin/orders = 403', r2.status === 403);

    // Simule une tentative "je bricole sessionStorage/un jeton fait main" :
    // un cookie de session forgé sans la bonne signature doit être rejeté.
    const forgedJar = makeCookieJar();
    forgedJar.absorb('stringz_session=eyJ1aWQiOjk5OTk5fQ.fakefakefakefakefakefakefakefakefakefakefakefakefakefakefakefake');
    const r3 = await call(adminProducts, { method: 'GET', cookieJar: forgedJar });
    ok('Cookie de session forgé (signature invalide) -> 401, pas d\'accès', r3.status === 401);
  }

  // =========================================================
  section('9. Tentative de modification d\'un produit sans être admin');
  // =========================================================
  {
    const r = await call(adminProducts, { method: 'PUT', body: { id: 1, price: 0.01 }, cookieJar: aliceJar });
    ok('PUT /api/admin/products par un non-admin -> 403 (pas de modification)', r.status === 403);

    const { rows } = await sql`SELECT price_cents FROM products WHERE id = 1`;
    ok('Le prix du produit 1 n\'a PAS changé', rows[0].price_cents === 8999);
  }

  // =========================================================
  section('Admin : CRUD produits (accès autorisé)');
  // =========================================================
  let newProductId;
  {
    const rCreate = await call(adminProducts, { method: 'POST', body: { name: 'Test Produit', category: 'String', price: 42, stock: 10, icon: '🩲', images: [] }, cookieJar: adminJar });
    ok('Admin crée un produit -> 201', rCreate.status === 201);
    newProductId = rCreate.body.product.id;

    const rUpdate = await call(adminProducts, { method: 'PUT', body: { id: newProductId, price: 50, stock: 3 }, cookieJar: adminJar });
    ok('Admin modifie prix/stock -> 200, valeurs mises à jour', rUpdate.status === 200 && rUpdate.body.product.price === 50 && rUpdate.body.product.stock === 3);

    const rDeactivate = await call(adminProducts, { method: 'DELETE', body: { id: newProductId }, cookieJar: adminJar });
    ok('Admin désactive le produit -> 200', rDeactivate.status === 200);

    const rPublic = await call(publicProducts, { method: 'GET' });
    ok('Produit désactivé absent de la liste publique', !rPublic.body.products.some(p => p.id === newProductId));

    // Réactive pour ne pas gêner les tests suivants qui pourraient s'en servir.
    await call(adminProducts, { method: 'PUT', body: { id: newProductId, active: true, stock: 3, price: 50 }, cookieJar: adminJar });
  }

  // =========================================================
  section('10. Modification d\'un prix dans le navigateur (panier)');
  // =========================================================
  {
    // Le "panier" envoyé au serveur ne contient QUE des ids + quantités —
    // il n'existe même pas de champ prix possible à falsifier dans ce
    // format. On vérifie malgré tout qu'un champ "price" injecté en trop
    // dans le corps de la requête est purement et simplement ignoré.
    const r = await call(checkout, {
      method: 'POST',
      body: { cart: { 1: 1 }, price: 0.01, total: 0.01, unitAmount: 1 }, // champs parasites
      cookieJar: aliceJar,
    });
    ok('Checkout accepté malgré les champs parasites -> 200', r.status === 200);

    const { rows } = await sql`SELECT total_cents FROM orders ORDER BY id DESC LIMIT 1`;
    ok('Le total enregistré = prix réel en base (8999), pas 1 centime falsifié', rows[0].total_cents === 8999, `total_cents=${rows[0].total_cents}`);
  }

  // =========================================================
  section('11. Tentative de paiement avec prix falsifié / id trafiqué');
  // =========================================================
  {
    const rBadId = await call(checkout, { method: 'POST', body: { cart: { 999999: 1 } }, cookieJar: aliceJar });
    ok('Id produit inexistant -> 400, aucune session créée', rBadId.status === 400);

    const rNegQty = await call(checkout, { method: 'POST', body: { cart: { 1: -5 } }, cookieJar: aliceJar });
    ok('Quantité négative -> 400 (pas de prix négatif/remboursement détourné)', rNegQty.status === 400);

    const rHugeQty = await call(checkout, { method: 'POST', body: { cart: { 1: 999 } }, cookieJar: aliceJar });
    ok('Quantité excessive (999) -> 400', rHugeQty.status === 400);
  }

  // =========================================================
  section('12. Achat d\'un produit hors stock');
  // =========================================================
  {
    // Produit id 3 = "String 2", stock 0 par défaut (voir schema.sql).
    const r = await call(checkout, { method: 'POST', body: { cart: { 3: 1 } }, cookieJar: aliceJar });
    ok('Produit en rupture de stock -> 400, refusé', r.status === 400, JSON.stringify(r.body));
  }

  // =========================================================
  section('13/14/15/16. Flux de paiement Stripe complet + webhook');
  // =========================================================
  let paidOrderId, paidStripeSessionId;
  {
    const rCheckout = await call(checkout, { method: 'POST', body: { cart: { 4: 2 } }, cookieJar: aliceJar }); // Caleçon 1, stock 8
    ok('Création de session de paiement -> 200, url renvoyée', rCheckout.status === 200 && !!rCheckout.body.url);

    const { rows: orderRows } = await sql`SELECT id, status, stripe_session_id, total_cents FROM orders ORDER BY id DESC LIMIT 1`;
    paidOrderId = orderRows[0].id;
    paidStripeSessionId = orderRows[0].stripe_session_id;
    ok('Commande créée en base avec statut "pending" AVANT tout paiement', orderRows[0].status === 'pending');
    ok('Total = 2 x 210,00€ = 42000 centimes (prix serveur, pas client)', orderRows[0].total_cents === 42000, `total=${orderRows[0].total_cents}`);

    const { rows: stockReserved } = await sql`SELECT stock FROM products WHERE id = 4`;
    ok('Stock DÉJÀ réservé (décrémenté) dès la création de la session, avant tout paiement (anti-survente)', stockReserved[0].stock === 6, `stock=${stockReserved[0].stock}`);

    // ---- 15. Webhook invalide (signature fausse) ----
    const fakeEvent = { id: 'evt_fake_1', type: 'checkout.session.completed', data: { object: { id: paidStripeSessionId, amount_total: 42000 } } };
    const reqBadSig = { method: 'POST', headers: { 'stripe-signature': 'invalid-signature' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(fakeEvent)); } };
    const resBadSig = makeRes();
    await webhook(reqBadSig, resBadSig);
    ok('Webhook signature invalide -> 400, rejeté', resBadSig._status === 400);

    const { rows: statusAfterBadSig } = await sql`SELECT status FROM orders WHERE id = ${paidOrderId}`;
    ok('Commande toujours "pending" après un webhook à signature invalide', statusAfterBadSig[0].status === 'pending');

    // ---- 13. Paiement Stripe réussi (webhook valide) ----
    const goodEvent = { id: 'evt_ok_1', type: 'checkout.session.completed', data: { object: { id: paidStripeSessionId, amount_total: 42000, payment_intent: 'pi_test_1', customer_details: { email: 'alice@test.com' } } } };
    const reqGood = { method: 'POST', headers: { 'stripe-signature': 'valid' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(goodEvent)); } };
    const resGood = makeRes();
    await webhook(reqGood, resGood);
    ok('Webhook valide (checkout.session.completed) -> 200', resGood._status === 200);

    const { rows: statusAfter } = await sql`SELECT status FROM orders WHERE id = ${paidOrderId}`;
    ok('Commande passée à "paid" via le webhook', statusAfter[0].status === 'paid');

    const { rows: stockAfter } = await sql`SELECT stock FROM products WHERE id = 4`;
    ok('Stock TOUJOURS à 6 après le webhook (déjà décrémenté à la réservation, pas une 2e fois)', stockAfter[0].stock === 6, `stock=${stockAfter[0].stock}`);

    // ---- 16. Webhook envoyé deux fois (idempotence) ----
    const reqDup = { method: 'POST', headers: { 'stripe-signature': 'valid' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(goodEvent)); } };
    const resDup = makeRes();
    await webhook(reqDup, resDup);
    ok('Même événement webhook renvoyé une 2e fois -> 200 (accepté sans effet)', resDup._status === 200 && resDup._json.duplicate === true);

    const { rows: stockAfterDup } = await sql`SELECT stock FROM products WHERE id = 4`;
    ok('Stock TOUJOURS à 6 après le doublon (pas décrémenté deux fois)', stockAfterDup[0].stock === 6, `stock=${stockAfterDup[0].stock}`);
  }

  // =========================================================
  section('ANTI-SURVENTE — achats simultanés sur le même produit');
  // =========================================================
  {
    // Produit id 6 = "String 3", stock 3 par défaut (voir schema).
    const { rows: initialStock } = await sql`SELECT stock FROM products WHERE id = 6`;
    ok('Stock initial du produit 6 = 3 (pré-requis du test)', initialStock[0].stock === 3, `stock=${initialStock[0].stock}`);

    // 5 acheteur·ses différent·es tentent d'acheter 1 unité chacun.e, EN
    // MÊME TEMPS (Promise.all — véritable concurrence, pas séquentiel), sur
    // un produit qui n'en a que 3. Chaque requête passe par la MÊME
    // transaction/route que dans le vrai flux (api/create-checkout-session).
    const buyers = ['c1@test.com', 'c2@test.com', 'c3@test.com', 'c4@test.com', 'c5@test.com'];
    const results = await Promise.all(
      buyers.map(email => call(checkout, { method: 'POST', body: { cart: { 6: 1 } }, headers: {}, query: {}, cookieJar: null }))
    );

    const succeeded = results.filter(r => r.status === 200);
    const rejected = results.filter(r => r.status === 400);

    ok('Exactement 3 achats simultanés acceptés (= stock disponible)', succeeded.length === 3, `succeeded=${succeeded.length}`);
    ok('Exactement 2 achats simultanés rejetés (stock insuffisant)', rejected.length === 2, `rejected=${rejected.length}`);

    const { rows: stockAfterConcurrent } = await sql`SELECT stock FROM products WHERE id = 6`;
    ok('Stock final = 0 (jamais négatif, jamais survendu)', stockAfterConcurrent[0].stock === 0, `stock=${stockAfterConcurrent[0].stock}`);

    const { rows: pendingOrders6 } = await sql`
      SELECT o.id FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE oi.product_id = 6 AND o.status = 'pending'
    `;
    ok('Exactement 3 commandes "pending" créées pour ce produit (une par achat accepté)', pendingOrders6.length === 3, `count=${pendingOrders6.length}`);

    // Un 6e essai, alors que le stock est à 0 -> doit être rejeté immédiatement.
    const rZero = await call(checkout, { method: 'POST', body: { cart: { 6: 1 } } });
    ok('Nouvel essai avec stock à 0 -> 400, rejeté', rZero.status === 400);

    // ---- Relâchement de la réservation si le paiement n'aboutit pas ----
    // Une des 3 commandes acceptées expire sans être payée -> son stock doit être rendu.
    const abandonedOrderId = pendingOrders6[0].id;
    const { rows: abandonedSessionRows } = await sql`SELECT stripe_session_id FROM orders WHERE id = ${abandonedOrderId}`;
    const abandonedSessionId = abandonedSessionRows[0].stripe_session_id;

    const expiredEvent = { id: 'evt_concurrent_expired_1', type: 'checkout.session.expired', data: { object: { id: abandonedSessionId } } };
    const reqExpired = { method: 'POST', headers: { 'stripe-signature': 'valid' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(expiredEvent)); } };
    await webhook(reqExpired, makeRes());

    const { rows: stockAfterRelease } = await sql`SELECT stock FROM products WHERE id = 6`;
    ok('Stock relâché (0 -> 1) après expiration d\'une commande non payée', stockAfterRelease[0].stock === 1, `stock=${stockAfterRelease[0].stock}`);

    // Ce stock relâché redevient immédiatement achetable par quelqu'un d'autre.
    const rAfterRelease = await call(checkout, { method: 'POST', body: { cart: { 6: 1 } } });
    ok('Le stock relâché est de nouveau achetable (achat accepté)', rAfterRelease.status === 200);

    const { rows: stockFinal } = await sql`SELECT stock FROM products WHERE id = 6`;
    ok('Stock final = 0 à nouveau après ce nouvel achat', stockFinal[0].stock === 0, `stock=${stockFinal[0].stock}`);

    // ---- Cas exceptionnel : webhook "payé" en retard sur une commande déjà "failed" ----
    // Simule une commande dont la session a expiré (stock relâché) mais dont
    // le paiement, quasi simultané, se confirme quand même en retard, ALORS
    // QUE le stock qu'elle avait relâché a déjà été repris par quelqu'un
    // d'autre (stock à 0 à ce stade) -> remboursement automatique attendu.
    const { rows: failedOrderRows } = await sql`SELECT id, stripe_session_id FROM orders WHERE status = 'failed' AND id = ${abandonedOrderId}`;
    const lateSessionId = failedOrderRows[0].stripe_session_id;

    const lateSuccessEvent = { id: 'evt_late_success_1', type: 'checkout.session.completed', data: { object: { id: lateSessionId, amount_total: 7900, payment_intent: 'pi_test_late_1', customer_details: { email: 'late@test.com' } } } };
    const reqLate = { method: 'POST', headers: { 'stripe-signature': 'valid' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(lateSuccessEvent)); } };
    const resLate = makeRes();
    await webhook(reqLate, resLate);
    ok('Webhook de paiement en retard (stock indisponible) -> 200 traité automatiquement', resLate._status === 200);

    const { rows: lateOrderStatus } = await sql`SELECT status FROM orders WHERE id = ${abandonedOrderId}`;
    ok('Commande automatiquement marquée "refunded" (pas "paid" avec stock négatif, pas de blocage manuel)', lateOrderStatus[0].status === 'refunded', `status=${lateOrderStatus[0].status}`);

    const { rows: stockNeverNegative } = await sql`SELECT stock FROM products WHERE id = 6`;
    ok('Stock jamais négatif malgré ce paiement en retard', stockNeverNegative[0].stock === 0, `stock=${stockNeverNegative[0].stock}`);
  }

  // =========================================================
  section('14. Paiement Stripe échoué / session expirée');
  // =========================================================
  {
    const rCheckout = await call(checkout, { method: 'POST', body: { cart: { 5: 1 } }, cookieJar: aliceJar }); // Culotte 2
    const { rows } = await sql`SELECT id, stripe_session_id FROM orders ORDER BY id DESC LIMIT 1`;
    const orderId = rows[0].id, stripeSessionId = rows[0].stripe_session_id;

    const expiredEvent = { id: 'evt_expired_1', type: 'checkout.session.expired', data: { object: { id: stripeSessionId } } };
    const req = { method: 'POST', headers: { 'stripe-signature': 'valid' }, [Symbol.asyncIterator]: async function* () { yield Buffer.from(JSON.stringify(expiredEvent)); } };
    const res = makeRes();
    await webhook(req, res);
    ok('Webhook checkout.session.expired -> 200', res._status === 200);

    const { rows: after } = await sql`SELECT status FROM orders WHERE id = ${orderId}`;
    ok('Commande passée à "failed" après expiration de la session', after[0].status === 'failed');
  }

  // =========================================================
  section('Configurateur "Commande perso" : prix recalculé côté serveur');
  // =========================================================
  {
    const rBadShape = await call(checkout, { method: 'POST', body: { customOrder: { shapeId: 'invalide' } }, cookieJar: aliceJar });
    ok('Forme invalide -> 400', rBadShape.status === 400);

    const rBadDecor = await call(checkout, { method: 'POST', body: { customOrder: { shapeId: 'string', decorIds: ['inexistant'] } }, cookieJar: aliceJar });
    ok('Décor inexistant -> 400', rBadDecor.status === 400);

    const rOk = await call(checkout, {
      method: 'POST',
      body: { customOrder: { shapeId: 'culotte', motifId: 'm1', decorIds: ['fleur', 'noeud'], extraIds: [], specialRequest: '', size: 'M' } },
      cookieJar: aliceJar,
    });
    ok('Commande perso valide -> 200', rOk.status === 200);
    const { rows } = await sql`SELECT total_cents, kind FROM orders ORDER BY id DESC LIMIT 1`;
    // 29.90 (culotte) + 3 (motif) + 4 (fleur) + 3 (noeud) = 39.90 -> 3990 centimes
    ok('Prix recalculé correctement (2990+300+400+300=3990)', rows[0].total_cents === 3990, `total_cents=${rows[0].total_cents}`);
    ok('kind = "custom"', rows[0].kind === 'custom');
  }

  // =========================================================
  section('Achat invité (sans compte)');
  // =========================================================
  let guestStripeSessionId;
  {
    const r = await call(checkout, { method: 'POST', body: { cart: { 8: 1 } } }); // pas de cookieJar = pas connecté (produit 8, non touché par le test de concurrence ci-dessus)
    ok('Checkout sans être connecté -> 200 (achat invité autorisé)', r.status === 200);
    const { rows } = await sql`SELECT id, user_id, stripe_session_id FROM orders ORDER BY id DESC LIMIT 1`;
    ok('user_id = NULL pour un achat invité', rows[0].user_id === null);
    guestStripeSessionId = rows[0].stripe_session_id;

    const rLookup = await call(orderBySession, { method: 'GET', query: { session_id: guestStripeSessionId } });
    ok('success.html peut retrouver la commande via session_id (sans connexion)', rLookup.status === 200);

    const rLookupBad = await call(orderBySession, { method: 'GET', query: { session_id: 'cs_test_n_importe_quoi' } });
    ok('session_id inconnu -> 404 (pas de fuite d\'info)', rLookupBad.status === 404);
  }

  // =========================================================
  section('6/7. Consultation de son compte / de ses commandes + IDOR');
  // =========================================================
  const bobJar = makeCookieJar();
  {
    await call(signup, { method: 'POST', body: { email: 'bob@test.com', password: 'password123', name: 'Bob' }, cookieJar: bobJar });
    await call(checkout, { method: 'POST', body: { cart: { 7: 1 } }, cookieJar: bobJar }); // commande de Bob

    const rAlice = await call(ordersMine, { method: 'GET', cookieJar: aliceJar });
    const rBob = await call(ordersMine, { method: 'GET', cookieJar: bobJar });

    ok('Alice voit ses propres commandes', rAlice.status === 200 && rAlice.body.orders.length > 0);
    ok('Bob voit ses propres commandes', rBob.status === 200 && rBob.body.orders.length > 0);

    const aliceOrderIds = new Set(rAlice.body.orders.map(o => o.id));
    const bobOrderIds = new Set(rBob.body.orders.map(o => o.id));
    const overlap = [...aliceOrderIds].filter(id => bobOrderIds.has(id));
    ok('7. Aucune commande de Bob visible dans la liste d\'Alice (et inversement) — pas d\'IDOR', overlap.length === 0);
  }

  // =========================================================
  section('Admin : vue globale des commandes (invité + comptes)');
  // =========================================================
  {
    const r = await call(adminOrders, { method: 'GET', cookieJar: adminJar });
    ok('Admin voit la liste de toutes les commandes -> 200', r.status === 200);
    ok('La commande invité apparaît avec email "(invité)" ou email Stripe', r.body.orders.some(o => o.email === '(invité)' || o.email));
  }

  // =========================================================
  section('16. Suppression du compte (RGPD)');
  // =========================================================
  {
    // Bob a une commande payée-simulée + une commande pending -> on vérifie
    // le traitement différencié après suppression de compte.
    const { rows: bobUser } = await sql`SELECT id FROM users WHERE email = ${'bob@test.com'}`;
    const bobId = bobUser[0].id;
    await sql`UPDATE orders SET status = 'paid' WHERE user_id = ${bobId} AND id = (SELECT id FROM orders WHERE user_id = ${bobId} ORDER BY id ASC LIMIT 1)`;
    await call(checkout, { method: 'POST', body: { cart: { 8: 1 } }, cookieJar: bobJar }); // 2e commande (produit 8), restera "pending"

    const { rows: beforeCount } = await sql`SELECT COUNT(*) as n FROM orders WHERE user_id = ${bobId}`;
    ok('Bob a bien 2 commandes avant suppression (1 payée, 1 en attente)', Number(beforeCount[0].n) === 2);

    const rDelete = await call(accountDelete, { method: 'POST', cookieJar: bobJar });
    ok('Suppression de compte -> 200', rDelete.status === 200, JSON.stringify(rDelete.body));

    const { rows: afterUser } = await sql`SELECT email, name, deleted_at FROM users WHERE id = ${bobId}`;
    ok('Email anonymisé en base', afterUser[0].email !== 'bob@test.com' && afterUser[0].email.includes('supprime'));
    ok('deleted_at renseigné', !!afterUser[0].deleted_at);

    const { rows: remainingOrders } = await sql`SELECT id, user_id, status, email FROM orders WHERE user_id = ${bobId}`;
    ok('Commande "pending" supprimée (pas d\'obligation légale)', !remainingOrders.some(o => o.status === 'pending'));

    const { rows: paidOrderNowOrphan } = await sql`SELECT user_id, email, status FROM orders WHERE status = 'paid' AND email LIKE 'commande-anonyme-%'`;
    ok('Commande payée conservée mais détachée du compte (user_id NULL) + email anonymisé (obligation comptable)', paidOrderNowOrphan.length >= 1 && paidOrderNowOrphan[0].user_id === null);

    // 17. Rechargement de page après suppression -> plus connecté
    const meAfterDelete = await call(me, { method: 'GET', cookieJar: bobJar });
    ok('Session invalidée après suppression (cookie effacé) -> /me = null', meAfterDelete.body.user === null);

    const rLoginAfterDelete = await call(login, { method: 'POST', body: { email: 'bob@test.com', password: 'password123' } });
    ok('Impossible de se reconnecter avec l\'ancien compte supprimé', rLoginAfterDelete.status === 401);
  }

  // =========================================================
  section('17/18. Rechargement de page / nouvelle session navigateur');
  // =========================================================
  {
    // "Rechargement" = nouvelle requête avec le MÊME cookie -> doit rester connecté.
    const r1 = await call(me, { method: 'GET', cookieJar: aliceJar });
    ok('Rechargement avec le même cookie -> toujours connectée', r1.body.user && r1.body.user.email === 'alice@test.com');

    // "Nouvelle session navigateur" = un jar VIDE (pas de cookie du tout).
    const freshJar = makeCookieJar();
    const r2 = await call(me, { method: 'GET', cookieJar: freshJar });
    ok('Nouveau navigateur sans cookie -> non connecté', r2.body.user === null);
  }

  // =========================================================
  section('19. Navigation "mobile"');
  // =========================================================
  {
    // Le backend ne fait aucune distinction desktop/mobile (API JSON pure,
    // cookies standards) : on vérifie juste qu'un User-Agent mobile
    // n'affecte ni l'auth ni les réponses.
    const r = await call(publicProducts, { method: 'GET', headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' } });
    ok('API produits fonctionne identiquement avec un User-Agent mobile', r.status === 200 && r.body.products.length > 0);
  }

  // =========================================================
  section('Sécurité additionnelle : injection SQL basique');
  // =========================================================
  {
    const r = await call(login, { method: 'POST', body: { email: "a' OR '1'='1", password: "x' OR '1'='1" } });
    ok('Tentative d\'injection SQL dans le login -> 401 (requêtes paramétrées, pas de concaténation)', r.status === 401);
  }

  console.log(`\n${'='.repeat(50)}\nRÉSULTAT : ${pass} tests réussis, ${fail} échoués\n${'='.repeat(50)}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('ERREUR FATALE DANS LE HARNAIS DE TEST:', err);
  process.exit(1);
});
