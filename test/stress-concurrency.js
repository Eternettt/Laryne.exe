// test/stress-concurrency.js
// Test de charge dédié à la survente : N acheteur·ses différent·es tentent
// d'acheter simultanément (Promise.all) un produit dont le stock est très
// faible, plusieurs fois de suite, pour vérifier que le nombre de commandes
// acceptées est TOUJOURS exactement égal au stock disponible — jamais plus,
// jamais moins (sauf indisponibilité du service).
//
// Lancer avec :
//   NODE_PATH=/tmp/testmods/node_modules TEST_SCHEMA_PATH=db/schema.test.sqlite.sql \
//   SESSION_SECRET=test STRIPE_SECRET_KEY=sk_test STRIPE_WEBHOOK_SECRET=whsec_test \
//   node --experimental-sqlite test/stress-concurrency.js

function makeReq({ method = 'GET', body = null } = {}) {
  return { method, body, query: {}, headers: { host: 'example.com', origin: 'https://example.com', cookie: '' }, socket: { remoteAddress: '127.0.0.1' } };
}
function makeRes() {
  const res = { _status: 200, _json: null, status(c) { this._status = c; return this; }, json(o) { this._json = o; return this; } };
  return res;
}
async function call(handler, opts) {
  const req = makeReq(opts);
  const res = makeRes();
  await handler(req, res);
  return { status: res._status, body: res._json };
}

async function main() {
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret';
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || 'whsec_fake';

  const checkout = require('../api/create-checkout-session');
  const adminProducts = require('../api/admin/products');
  const { sql } = require('../lib/db');
  const { hashPassword } = require('../lib/crypto');

  // Crée un admin et un produit dédié à stock=1 pour ce test.
  const passwordHash = hashPassword('StressTest123!');
  await sql`INSERT INTO users (email, password_hash, name, role) VALUES (${'stress-admin@test.com'}, ${passwordHash}, 'Admin', 'admin')`;
  const { rows: adminRows } = await sql`SELECT id FROM users WHERE email = ${'stress-admin@test.com'}`;

  let allPassed = true;
  const ROUNDS = [
    { stock: 1, buyers: 20 },
    { stock: 5, buyers: 30 },
    { stock: 0, buyers: 10 },
  ];

  for (const { stock, buyers } of ROUNDS) {
    const { rows: prodRows } = await sql`
      INSERT INTO products (name, category, price_cents, stock, icon, images)
      VALUES (${'Produit stress ' + stock + '-' + buyers}, 'String', 1000, ${stock}, '🩲', '[]')
      RETURNING id
    `;
    const productId = prodRows[0].id;

    const results = await Promise.all(
      Array.from({ length: buyers }, () => call(checkout, { method: 'POST', body: { cart: { [productId]: 1 } } }))
    );

    const succeeded = results.filter(r => r.status === 200).length;
    const rejected = results.filter(r => r.status === 400).length;
    const other = results.length - succeeded - rejected;

    const { rows: finalStock } = await sql`SELECT stock FROM products WHERE id = ${productId}`;
    const { rows: pendingCount } = await sql`
      SELECT COUNT(*) as n FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE oi.product_id = ${productId} AND o.status = 'pending'
    `;

    const expectedSucceeded = stock;
    const pass = succeeded === expectedSucceeded
      && rejected === buyers - expectedSucceeded
      && other === 0
      && finalStock[0].stock === 0
      && Number(pendingCount[0].n) === expectedSucceeded;

    console.log(
      `Stock=${stock}, ${buyers} acheteur·ses simultané·es -> ${succeeded} acceptés / ${rejected} rejetés / ${other} autre(s). ` +
      `Stock final=${finalStock[0].stock}. Commandes créées=${pendingCount[0].n}. ` +
      (pass ? '✅ OK' : '❌ ÉCHEC')
    );
    if (!pass) allPassed = false;
  }

  console.log(allPassed ? '\n✅ Tous les scénarios de charge sont corrects : jamais de survente.' : '\n❌ Au moins un scénario a échoué.');
  process.exit(allPassed ? 0 : 1);
}

main().catch(err => { console.error('ERREUR FATALE:', err); process.exit(1); });
