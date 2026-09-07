#!/usr/bin/env node
/* ==========================================================================
   scripts/create-admin.js — Crée (ou promeut) un compte administrateur.
   ==========================================================================
   Utilisation, depuis la racine du projet :

     vercel env pull .env.local          # une seule fois, récupère POSTGRES_URL etc.
     node scripts/create-admin.js toi@exemple.com "mot-de-passe-solide" "Ton nom"

   Si tu as installé "dotenv" (npm i -D dotenv), .env.local sera chargé
   automatiquement. Sinon, exporte les variables POSTGRES_* toi-même avant
   de lancer la commande (ou utilise `npx dotenv-cli -e .env.local -- node
   scripts/create-admin.js ...`).
   ========================================================================== */

try {
  require('dotenv').config({ path: '.env.local' });
} catch (e) {
  // dotenv non installé : on suppose que les variables sont déjà exportées
  // dans l'environnement courant.
}

const crypto = require('crypto');
const { sql } = require('@vercel/postgres');

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

async function main() {
  const [, , emailArg, passwordArg, nameArg] = process.argv;

  if (!emailArg || !passwordArg) {
    console.error('Usage : node scripts/create-admin.js email@exemple.com motdepasse "Nom affiché"');
    process.exit(1);
  }
  if (passwordArg.length < 8) {
    console.error('Le mot de passe doit faire au moins 8 caractères.');
    process.exit(1);
  }

  const email = emailArg.trim().toLowerCase();
  const { hash, salt } = hashPassword(passwordArg);

  const { rows: existing } = await sql`select id from users where email = ${email}`;

  if (existing.length) {
    await sql`
      update users
      set role = 'admin', password_hash = ${hash}, password_salt = ${salt}, deleted_at = null
      where id = ${existing[0].id}
    `;
    console.log(`✔ Compte existant "${email}" promu administrateur et mot de passe mis à jour.`);
  } else {
    await sql`
      insert into users (email, password_hash, password_salt, name, role)
      values (${email}, ${hash}, ${salt}, ${nameArg || ''}, 'admin')
    `;
    console.log(`✔ Compte administrateur "${email}" créé.`);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Erreur :', err.message);
  process.exit(1);
});
