/**
 * smoke-claim-welcome-chest.js
 *
 * Exercises claimWelcomeChest against the local Firebase emulator.
 *
 * Prerequisites:
 *   firebase emulators:start --only functions,firestore
 *
 * Usage:
 *   GCLOUD_PROJECT=<project-id> node scripts/smoke-claim-welcome-chest.js
 *
 * Defaults PROJECT_ID to 'demo-cleaning' if GCLOUD_PROJECT is not set (safe
 * for the emulator — the emulator accepts any project-id that starts with
 * 'demo-' without needing real credentials).
 */

'use strict';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';

const admin = require('firebase-admin');
// node-fetch v2 is CommonJS-compatible
const fetch = require('node-fetch');

const PROJECT_ID = process.env.GCLOUD_PROJECT || 'demo-cleaning';
const FUNCTIONS_EMULATOR_HOST = `http://127.0.0.1:5001`;
const CF_URL = `${FUNCTIONS_EMULATOR_HOST}/${PROJECT_ID}/us-central1/claimWelcomeChest`;
const TEST_UID = 'test-uid-smoke-welcome';

// Initialise Admin SDK pointing at the emulator
admin.initializeApp({ projectId: PROJECT_ID });
const db = admin.firestore();

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const SEED_ITEMS = [
  { id: 'item_washing_machine', type: 'furniture', category: 'Appliances', name: 'Washing Machine',  rarity: 'common' },
  { id: 'item_dining_table',    type: 'furniture', category: 'Tables',     name: 'Dining Table',      rarity: 'common' },
  { id: 'item_queen_bed',       type: 'furniture', category: 'Beds',       name: 'Queen Bed',         rarity: 'rare'   },
  { id: 'item_shelving_unit',   type: 'furniture', category: 'Storage',    name: 'Shelving Unit',     rarity: 'common' },
  { id: 'item_sofa',            type: 'furniture', category: 'Seating',    name: 'Sofa',              rarity: 'rare'   },
  { id: 'item_tap',             type: 'furniture', category: 'Plumbing',   name: 'Kitchen Tap',       rarity: 'common' },
];

async function seed() {
  const batch = db.batch();
  for (const item of SEED_ITEMS) {
    batch.set(db.doc(`items/${item.id}`), {
      type: item.type,
      category: item.category,
      name: item.name,
      rarity: item.rarity,
      artUrl: '',
    });
  }
  batch.set(db.doc(`users/${TEST_UID}/weeklySchedule/current`), {
    selectedTaskIds: ['lib_kitchen_0', 'lib_bedroom_0'],
  });
  // Ensure the user doc exists but orientationCompleted is absent
  batch.set(db.doc(`users/${TEST_UID}`), { displayName: 'Smoke Test User' }, { merge: true });
  await batch.commit();
  console.log('Seed: items and weeklySchedule written');
}

// ---------------------------------------------------------------------------
// Call the Cloud Function via HTTP (emulator endpoint)
// Firebase callable functions expect a specific JSON envelope.
// ---------------------------------------------------------------------------

async function callClaimWelcomeChest() {
  const body = {
    data: {},
  };

  // The emulator honours the x-firebase-client-auth header as a fake auth token
  // when the project is a demo project.  We encode a minimal claims object.
  const fakeToken = buildFakeIdToken(TEST_UID);

  const response = await fetch(CF_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${fakeToken}`,
    },
    body: JSON.stringify(body),
  });

  const json = await response.json();
  return { status: response.status, json };
}

/**
 * Builds a fake (unsigned) Firebase ID token that the Functions emulator
 * will accept when FIREBASE_AUTH_EMULATOR_HOST is set or the project is demo-*.
 * The emulator skips signature validation for demo projects.
 */
function buildFakeIdToken(uid) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: `https://securetoken.google.com/${PROJECT_ID}`,
    aud: PROJECT_ID,
    sub: uid,
    uid: uid,
    user_id: uid,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
  })).toString('base64url');
  return `${header}.${payload}.`;
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let passed = 0;
  let failed = 0;

  try {
    await seed();

    // --- First call: should succeed ---
    console.log('\nTest 1: first call to claimWelcomeChest...');
    const { status, json } = await callClaimWelcomeChest();

    if (status !== 200 || json.error) {
      console.error('  HTTP status:', status);
      console.error('  Response:', JSON.stringify(json, null, 2));
      console.error('  FAIL: expected 200 OK, got error');
      failed++;
    } else {
      const result = json.result;

      // 1a. Exactly 3 inventory items granted
      try {
        assert(Array.isArray(result.items), 'result.items must be an array');
        assert(result.items.length === 3, `expected 3 items, got ${result.items.length}`);
        console.log('  PASS: 3 items returned in response');
        passed++;
      } catch (e) {
        console.error(' ', e.message);
        failed++;
      }

      // 1b. Items have source:'welcome_chest' in Firestore
      try {
        const inventorySnap = await db.collection(`users/${TEST_UID}/inventory`).get();
        assert(inventorySnap.size === 3, `expected 3 inventory docs, got ${inventorySnap.size}`);
        for (const doc of inventorySnap.docs) {
          assert(doc.data().source === 'welcome_chest', `item ${doc.id} missing source:'welcome_chest'`);
        }
        console.log('  PASS: 3 inventory docs with source:welcome_chest in Firestore');
        passed++;
      } catch (e) {
        console.error(' ', e.message);
        failed++;
      }

      // 1c. orientationCompleted=true on user doc
      try {
        const userSnap = await db.doc(`users/${TEST_UID}`).get();
        assert(userSnap.data()?.orientationCompleted === true, 'orientationCompleted not set to true');
        assert(userSnap.data()?.orientationCompletedAt != null, 'orientationCompletedAt not set');
        console.log('  PASS: orientationCompleted=true on user doc');
        passed++;
      } catch (e) {
        console.error(' ', e.message);
        failed++;
      }

      // 1d. goalRooms returned
      try {
        assert(Array.isArray(result.goalRooms) && result.goalRooms.length > 0, 'goalRooms must be non-empty');
        console.log('  PASS: goalRooms returned:', result.goalRooms);
        passed++;
      } catch (e) {
        console.error(' ', e.message);
        failed++;
      }
    }

    // --- Second call: should throw already-exists ---
    console.log('\nTest 2: second call to claimWelcomeChest (expect already-exists)...');
    const { status: status2, json: json2 } = await callClaimWelcomeChest();
    try {
      const errorCode = json2.error?.status;
      // Firebase callable errors map 'already-exists' -> HTTP 409 or code ALREADY_EXISTS
      const isAlreadyExists =
        status2 === 409 ||
        errorCode === 'ALREADY_EXISTS' ||
        json2.error?.message?.includes('already claimed');
      assert(isAlreadyExists, `expected already-exists error, got status=${status2} body=${JSON.stringify(json2)}`);
      console.log('  PASS: already-exists error returned on second call');
      passed++;
    } catch (e) {
      console.error(' ', e.message);
      failed++;
    }

  } catch (err) {
    console.error('\nUnexpected error during smoke test:', err);
    failed++;
  }

  console.log(`\n--- Results: ${passed} passed, ${failed} failed ---`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
