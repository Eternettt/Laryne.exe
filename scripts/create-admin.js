// scripts/create-admin.js
// Crée (ou promeut) un compte admin directement en base — à lancer en local
// sur ton ordinateur, jamais depuis une route du site.
//
// Utilisation (après avoir configuré la variable d'environnement
// POSTGRES_URL en local, ex. via `vercel env pull .env.local` puis
// `node -r dotenv/config scripts/create-admin.js ...` ou en export-ant la
// variable manuellement) :
//
//   node scripts/create-admin.js "toi@exemple.com" "TonMotDePasse" "TonPseudo"
//
// Si le compte existe déjà (même email), il est simplement promu admin et
// son mot de passe mis à jour. Sinon un nouveau compte admin est créé.

const { sql } = require('../lib/db');
const { hashPassword } = require('../lib/crypto');

async function main() {
  const [, , email, password, name] = process.argv;
  if (!email || !password) {
    console.error('Usage : node scripts/create-admin.js "email@exemple.com" "MotDePasse" "Pseudo (optionnel)"');
    process.exit(1);
  }
  if (password.length < 8) {
    console.error('Choisis un mot de passe admin d\'au moins 8 caractères.');
    process.exit(1);
  }

  const passwordHash = hashPassword(password);
  const normalizedEmail = email.trim().toLowerCase();

  const existing = await sql`SELECT id FROM users WHERE email = ${normalizedEmail} LIMIT 1`;

  if (existing.rows.length) {
    await sql`
      UPDATE users SET password_hash = ${passwordHash}, role = 'admin', deleted_at = NULL,
             name = COALESCE(NULLIF(${name || ''}, ''), name)
      WHERE id = ${existing.rows[0].id}
    `;
    console.log(`Compte existant ${normalizedEmail} promu admin et mot de passe mis à jour.`);
  } else {
    await sql`
      INSERT INTO users (email, password_hash, name, role)
      VALUES (${normalizedEmail}, ${passwordHash}, ${name || 'Administrateur'}, 'admin')
    `;
    console.log(`Compte admin créé : ${normalizedEmail}`);
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Erreur:', err.message);
  process.exit(1);
});
