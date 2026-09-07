/* ==========================================================================
   lib/db.js — Connexion à la base Postgres (Vercel Postgres / Neon).
   Le SDK @vercel/postgres lit automatiquement POSTGRES_URL depuis les
   variables d'environnement Vercel : rien à configurer ici.
   ========================================================================== */

const { sql } = require('@vercel/postgres');

module.exports = { sql };
