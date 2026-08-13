// scripts/hash-password.js
// Génère la valeur à mettre dans la variable d'environnement Vercel
// ADMIN_PASSWORD_HASH, à partir de ton futur mot de passe admin.
//
// Utilisation (en local, sur ton ordinateur — jamais sur le site) :
//   node scripts/hash-password.js "TonNouveauMotDePasse"
//
// Copie la ligne "salt:hash" affichée dans Vercel > Project Settings >
// Environment Variables > ADMIN_PASSWORD_HASH. Le mot de passe en clair
// n'a pas besoin d'être conservé ailleurs.

const crypto = require('crypto');

const password = process.argv[2];
if (!password) {
  console.error('Usage : node scripts/hash-password.js "TonMotDePasse"');
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, salt, 64).toString('hex');

console.log('\nAjoute cette valeur dans Vercel comme ADMIN_PASSWORD_HASH :\n');
console.log(`${salt}:${hash}`);
console.log('\n(Choisis aussi un mot de passe différent de "123456" !)\n');
