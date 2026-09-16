/**
 * The legacy fallback, and the census that reads it, driven against a REAL
 * Firestore.
 *
 * ---------------------------------------------------------------------------
 * 🔴 WHY A FAKE CANNOT ANSWER THIS
 * ---------------------------------------------------------------------------
 *
 * Two claims hold up this whole brief, and both are claims about the WORLD
 * rather than about the source:
 *
 *   1. THE LEGACY FALLBACK ACTUALLY FIRES. `pushTokens.test.ts` proves
 *      `resolvePushToken` returns `source: 'legacy'` for an entry a test author
 *      built by hand. It does NOT prove that the production read path produces
 *      that entry — that a MISSING `users/{uid}/private/push` yields `undefined`
 *      from `data()` rather than an empty object, a truthy stub, or a throw. If
 *      the real SDK behaved differently, push for un-migrated installs would be
 *      broken already and the whole premise of not sweeping would be wrong.
 *
 *   2. THE CENSUS READS THE REAL SHAPE. It finds private tokens through
 *      `collectionGroup('private')` and recovers the uid from the document's
 *      ref chain. A fake proves only that the fake was built to match the code.
 *      🔴 IF THAT SCAN SILENTLY RETURNED NOTHING, every migrated user would be
 *      counted legacy-only; if the ref walk were wrong the other way, the count
 *      would read ZERO LEGACY-ONLY USERS AND GREEN-LIGHT THE SWEEP THAT STOPS
 *      PUSH FOR EVERY UN-MIGRATED INSTALL. The census's failure mode is not a
 *      wrong report, it is a destructive action taken on a wrong report.
 *
 * ⚠️ THIS SUITE IS INVISIBLE TO `npm test`. `jest.config.js` excludes every
 * `*Emulator.test.ts`; `npm run test:e2e` is the gate that runs it, and its
 * `Tests:` line is quoted separately in the return. A gate that cannot see its
 * subject is green for the same reason it is useless.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT STILL DOES NOT PROVE
 * ---------------------------------------------------------------------------
 *
 *   · It asks PRODUCTION nothing. The counts below are of documents this file
 *     seeded seconds earlier. The real population is unknown and stays unknown
 *     until someone with credentials runs the script; see its header.
 *   · The emulator does not enforce index requirements, so a collection-group
 *     query that would need one in production succeeds here. The scan is
 *     UNFILTERED, which needs no index (collectionGroupIndexes.test.ts states
 *     the same rule from the static side), but this suite is not the evidence
 *     for that.
 *   · It does not run the cron. It drives the same two-document read those
 *     crons perform, through the exported path helpers they use.
 */
import * as admin from 'firebase-admin';

import {
  buildPushBatch,
  legacyPushTokenDocPath,
  pushTokenDocPath,
  pushTokenOwnerUid,
  readPushTokenCensus,
  resolvePushToken,
  type PushTokenCensus,
  type PushTokenEntry,
} from '../pushTokens';

const PROJECT_ID = process.env.GCLOUD_PROJECT;

// Distinct per user AND per document, so a read of the wrong document is
// visible in the value rather than hidden behind a shared fixture string.
const UNMIGRATED = 'e2e-pushcensus-unmigrated';
const UNMIGRATED_TOKEN = 'tok-e2e-legacy-only-aaaa';
const MIGRATED = 'e2e-pushcensus-migrated';
const MIGRATED_TOKEN = 'tok-e2e-private-only-bbbb';
const MIDWAY = 'e2e-pushcensus-midway';
const MIDWAY_PRIVATE_TOKEN = 'tok-e2e-both-private-cccc';
const MIDWAY_LEGACY_TOKEN = 'tok-e2e-both-legacy-dddd';

let db: admin.firestore.Firestore;

/**
 * The read `readPushTokenEntries` (index.ts) performs, through the same two
 * exported path helpers: both homes of one uid's token, in parallel.
 */
async function readEntry(uid: string): Promise<PushTokenEntry> {
  const [privateSnap, legacySnap] = await Promise.all([
    db.doc(pushTokenDocPath(uid)).get(),
    db.doc(legacyPushTokenDocPath(uid)).get(),
  ]);
  return {uid, privateData: privateSnap.data(), legacyData: legacySnap.data()};
}

beforeAll(async () => {
  if (!PROJECT_ID) {
    throw new Error(
      'GCLOUD_PROJECT is unset — run this through `npm run test:e2e`, which boots ' +
        'the emulators and sets it. Under plain jest the Admin SDK would point at ' +
        'a project this test cannot see, and every assertion would pass against ' +
        'an empty database.',
    );
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST is unset. Without it the Admin SDK would try to ' +
        'reach REAL Firestore, and this test writes freely.',
    );
  }
  if (admin.apps.length === 0) admin.initializeApp({projectId: PROJECT_ID});
  db = admin.firestore();
}, 120_000);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app?.delete()));
});

describe('the legacy fallback fires against a real Firestore', () => {
  test('a user with ONLY the legacy field resolves to source legacy', async () => {
    // 🔴 The world premise. No users/{uid}/private/push document is written for
    // this uid at all — this is the shape of every install that has not yet
    // launched under the client from #663.
    await db.doc(legacyPushTokenDocPath(UNMIGRATED)).set({
      fcmToken: UNMIGRATED_TOKEN,
      subscriptionTier: 'free',
    });

    const entry = await readEntry(UNMIGRATED);
    // The SDK behaviour the fallback depends on: a missing document reads as
    // undefined, not as an empty object standing in for a token.
    expect(entry.privateData).toBeUndefined();

    expect(resolvePushToken(entry)).toEqual({
      token: UNMIGRATED_TOKEN,
      source: 'legacy',
    });
  });

  test('the reminder batch really carries that legacy token', async () => {
    // One step further than the resolver: the array a cron hands to FCM. If the
    // fallback stopped firing, this user would silently drop out of the batch
    // rather than fail — which is the failure the sweep would cause.
    const entry = await readEntry(UNMIGRATED);
    const {recipients, messages} = buildPushBatch([entry], (token) => ({token}));
    expect(recipients).toEqual([
      {uid: UNMIGRATED, token: UNMIGRATED_TOKEN, source: 'legacy'},
    ]);
    expect(messages).toEqual([{token: UNMIGRATED_TOKEN}]);
  });

  test('the private document still wins when a real user carries both', async () => {
    await db.doc(legacyPushTokenDocPath(MIDWAY)).set({fcmToken: MIDWAY_LEGACY_TOKEN});
    await db.doc(pushTokenDocPath(MIDWAY)).set({fcmToken: MIDWAY_PRIVATE_TOKEN});

    expect(resolvePushToken(await readEntry(MIDWAY))).toEqual({
      token: MIDWAY_PRIVATE_TOKEN,
      source: 'private',
    });
  });
});

describe('the census reads the real document shape', () => {
  test('a real users/{uid}/private/push is reachable from the collection group', async () => {
    await db.doc(pushTokenDocPath(MIGRATED)).set({fcmToken: MIGRATED_TOKEN});

    const group = await db.collectionGroup('private').get();
    const owners = group.docs
      .map((doc) => pushTokenOwnerUid(doc))
      .filter((uid): uid is string => uid !== null);

    // 🔑 The scan finds it, and the uid recovered from the ref chain is the
    // owner — the two things a fake cannot establish.
    expect(owners).toContain(MIGRATED);
    expect(owners).toContain(MIDWAY);
  });

  test('the census counts the three seeded users into three different buckets', async () => {
    // A DELTA, not an absolute: this emulator is shared with every other e2e
    // suite in the run, and their users are in the same collection. Bracketing
    // the seed is what makes the assertion independent of what else is there.
    const before = await readPushTokenCensus(db);

    const A = 'e2e-pushcensus-delta-legacy';
    const B = 'e2e-pushcensus-delta-private';
    const C = 'e2e-pushcensus-delta-both';
    await db.doc(legacyPushTokenDocPath(A)).set({fcmToken: 'tok-e2e-delta-legacy-eeee'});
    await db.doc(pushTokenDocPath(B)).set({fcmToken: 'tok-e2e-delta-private-ffff'});
    await db.doc(legacyPushTokenDocPath(B)).set({displayName: 'no token here'});
    await db.doc(legacyPushTokenDocPath(C)).set({fcmToken: 'tok-e2e-delta-both-legacy-gggg'});
    await db.doc(pushTokenDocPath(C)).set({fcmToken: 'tok-e2e-delta-both-private-hhhh'});

    const after = await readPushTokenCensus(db);
    const delta = (key: keyof PushTokenCensus) => after[key] - before[key];

    expect({
      legacyOnly: delta('legacyOnly'),
      privateOnly: delta('privateOnly'),
      both: delta('both'),
      neither: delta('neither'),
      total: delta('total'),
    }).toEqual({legacyOnly: 1, privateOnly: 1, both: 1, neither: 0, total: 3});
  });

  test('every seeded state is visible in the absolute counts too', async () => {
    // The delta above cannot distinguish "counted correctly" from "counted
    // nothing and the arithmetic cancelled". These are floors on the real
    // numbers, which only this suite's own seeds guarantee.
    const census = await readPushTokenCensus(db);
    expect(census.legacyOnly).toBeGreaterThanOrEqual(2);
    expect(census.privateOnly).toBeGreaterThanOrEqual(2);
    expect(census.both).toBeGreaterThanOrEqual(2);
    expect(census.total).toBeGreaterThanOrEqual(6);
  });
});
