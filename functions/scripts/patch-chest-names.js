/**
 * patch-chest-names.js
 *
 * Patches the chest records in Firestore shop/current so that each chest has the
 * correct canonical name, category, and artUrl.
 *
 * Canonical values (client + server both agree on these):
 *   Wooden Chest / old characters  →  name:'Character',  category:'characters', artUrl:'assets/images/shop/chest_characters.png'
 *   Silver Chest / old furniture   →  name:'Furniture',  category:'furniture',  artUrl:'assets/images/shop/chest_furniture.png'
 *   Gold Chest   / old styles      →  name:'Styles',     category:'styles',     artUrl:'assets/images/shop/chest_styles.png'
 *
 * This is idempotent — running it multiple times is safe.
 *
 * Prerequisites:
 *   1. Download a service account key:
 *        Firebase console → Project Settings → Service Accounts
 *                         → Generate new private key
 *      Store the file OUTSIDE the repo (never commit it).
 *   2. export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
 *   3. Run from the functions/ folder:
 *        node scripts/patch-chest-names.js
 */

const admin = require('firebase-admin');

const CRED_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!CRED_PATH) {
  console.error('ERROR: set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(CRED_PATH)),
  projectId: 'cleaning-f5656',
});

const db = admin.firestore();

// Keyed by legacy name (or any stale name) → full canonical record patch.
// A chest matching a key gets name + category + artUrl replaced.
// Chests not matching any key are left unchanged.
const CHEST_MAP = {
  // Legacy names (pre-sprint shop-logic-fixes)
  'Wooden Chest': { name: 'Character', category: 'characters', artUrl: 'assets/images/shop/chest_characters.png' },
  'Silver Chest': { name: 'Furniture', category: 'furniture',  artUrl: 'assets/images/shop/chest_furniture.png'  },
  'Gold Chest':   { name: 'Styles',    category: 'styles',     artUrl: 'assets/images/shop/chest_styles.png'     },
  // Plural → singular migration (sprint 2026-05-31)
  'Characters':   { name: 'Character', category: 'characters', artUrl: 'assets/images/shop/chest_characters.png' },
};

async function main() {
  const ref = db.doc('shop/current');
  const snap = await ref.get();

  if (!snap.exists) {
    console.error('shop/current does not exist — nothing to patch');
    process.exit(1);
  }

  const data = snap.data();
  const chests = data.dailyChests ?? [];

  if (chests.length === 0) {
    console.log('No dailyChests field found in shop/current — nothing to patch');
    process.exit(0);
  }

  let changed = false;
  const patched = chests.map((chest) => {
    const fix = CHEST_MAP[chest.name];
    if (fix) {
      console.log(`  "${chest.name}" (category:${chest.category}) → name:"${fix.name}", category:${fix.category}`);
      changed = true;
      return { ...chest, ...fix };
    }
    return chest;
  });

  if (!changed) {
    console.log('All chests already canonical — nothing to patch');
    process.exit(0);
  }

  await ref.update({ dailyChests: patched });
  console.log('Done — shop/current.dailyChests patched.');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
