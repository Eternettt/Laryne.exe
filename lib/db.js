// lib/db.js
// Petit point d'entrée unique vers la base de données, pour ne pas répéter
// l'import de @vercel/postgres dans chaque fonction serverless.
//
// @vercel/postgres lit automatiquement les variables d'environnement
// injectées par l'intégration "Storage > Postgres" de Vercel
// (POSTGRES_URL, etc.) — rien à configurer manuellement en local si tu
// utilises `vercel dev` avec `vercel env pull`.

const { sql, db } = require('@vercel/postgres');

// `sql` : pour les requêtes simples (une instruction).
// `getClient()` : pour les opérations qui doivent être atomiques
// (plusieurs INSERT/UPDATE liés, ex. créer une commande + ses lignes) —
// toujours utiliser BEGIN / COMMIT / ROLLBACK avec le client obtenu, et le
// relâcher avec client.release() dans un `finally`.
async function getClient() {
  return db.connect();
}

module.exports = { sql, getClient };
