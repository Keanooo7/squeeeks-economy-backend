/**
 * `syncPublicProfile` — the one hop of the deletion cascade that is a TRIGGER.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: NO FIRESTORE TRIGGER HAD EVER FIRED IN THIS PROJECT'S TEST SUITES
 * ---------------------------------------------------------------------------
 *
 * `test:e2e` booted `--only firestore,auth`. `firebase.e2e.json` had no
 * `functions` block at all — deliberately, per its own comment, because nothing
 * deploys from it. So the functions emulator never started, and every
 * `onDocumentWritten` / auth trigger in `index.ts` was inert in every gate this
 * repo has.
 *
 * That mattered to exactly one claim. `#489` made account deletion cascade, and
 * its LAST hop is not code the callable runs — it is a trigger:
 *
 *     // index.ts, syncPublicProfile
 *     const after = event.data?.after.data();
 *     // The user document was deleted — the projection must not outlive it.
 *     if (after === undefined) {
 *       await publicRef.delete();
 *
 * OK: The code is right, and `deleteAccount` deliberately does NOT delete
 * `publicProfiles/{uid}` itself — it leaves it to this trigger, and
 * `accountDeletion.test.ts` says so in a test that asserts the projection
 * SURVIVES in its fake, precisely because that fake runs no triggers.
 *
 * CRITICAL: SO THE WHOLE HOP RESTED ON A DOUBLE. `publicProfile.test.ts` proves the
 * handler calls `.delete()` when handed a synthetic event with `after`
 * undefined. Nothing had ever observed the platform DELIVER that event. A fake
 * cannot be wrong the way a trigger REGISTRATION can: a handler exported under
 * the wrong name, a path pattern that does not match, a trigger that loads but
 * never fires — every one of those is green in a unit test and silent in
 * production.
 *
 * KEY: AND IT IS THE 5.1.1(v) HALF A REVIEWER COULD CATCH. A public profile
 * outliving a deleted account is "the associated data" surviving, in a
 * collection whose whole purpose is being discoverable by other people.
 *
 * ---------------------------------------------------------------------------
 * WHAT BOOTING THE FUNCTIONS EMULATOR COST — MEASURED, NOT ESTIMATED
 * ---------------------------------------------------------------------------
 *
 *   before:  35 s wall clock, `Tests: 77 passed`, `Time: 24.45 s`
 *   after:   42 s wall clock, `Tests: 77 passed`, `Time: 22.01 s`
 *
 * +7 s wall clock (+20%), all of it emulator boot and the `tsc` build the
 * functions emulator needs to load `lib/index.js`. Jest's own time did not
 * rise. WARNING: AND ALL 77 PRE-EXISTING TESTS STILL PASS with `syncPublicProfile`
 * AND `onNewUserBefriendGibby` now live — which was the real risk, not speed:
 * turning triggers on changes the state every other e2e test asserts against.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: WHAT THIS STILL CANNOT PROVE
 * ---------------------------------------------------------------------------
 *
 *   · NOT PRODUCTION. This loads `lib/index.js` built from THIS working tree.
 *     The deployed revision can be older; `make check-deployed` is that gate.
 *   · The emulator's trigger delivery is not Google's. It proves the handler is
 *     reachable by a real event over a real path pattern, not that Cloud
 *     Functions will schedule it identically.
 *   · Nothing here proves the projection is CORRECT — `publicProfile.test.ts`
 *     owns `buildPublicProfile`. This file only asks whether the hop happens.
 */
import * as admin from 'firebase-admin';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const idx = require('../index') as Record<string, {run: (req: unknown) => Promise<any>}>;

const PROJECT_ID = process.env.GCLOUD_PROJECT;

const SUBJECT = 'e2e-trigger-subject';
/** Never deleted. The control that bounds every absence assertion below. */
const BYSTANDER = 'e2e-trigger-bystander';

let db: admin.firestore.Firestore;

function call(name: string, uid: string | null, data: unknown): Promise<any> {
  const fn = idx[name];
  if (!fn || typeof fn.run !== 'function') {
    throw new Error(`index.ts exports no callable named "${name}"`);
  }
  return fn.run({data, auth: uid ? {uid, token: {}} : undefined, rawRequest: {}});
}

/**
 * Poll until [path] exists (or stops existing), or give up.
 *
 * CRITICAL: POLLING IS NOT A CODE SMELL HERE, IT IS THE SUBJECT. A trigger is
 * asynchronous by definition: the write returns before the platform has
 * delivered anything. A test that read once immediately after the write would
 * be a race, and it would fail in the direction that looks like "the trigger is
 * broken" — the most expensive false negative available.
 *
 * WARNING: IT RETURNS A BOOLEAN RATHER THAN THROWING, so the CALLER owns the
 * assertion and the failure message names the property rather than the helper.
 * A helper that threw "timed out" would report a timeout where the finding is
 * "the projection was never created".
 */
async function settles(
  path: string,
  want: 'exists' | 'gone',
  timeoutMs = 15_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snap = await db.doc(path).get();
    if (snap.exists === (want === 'exists')) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
}

beforeAll(async () => {
  if (!PROJECT_ID) {
    throw new Error(
      'GCLOUD_PROJECT is unset — run this through `npm run test:e2e`, which ' +
        'boots the emulators and sets it.',
    );
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are unset. Without ' +
        'them the Admin SDK would reach REAL Firestore, and this suite deletes.',
    );
  }

  db = admin.firestore();

  for (const [uid, name] of [
    [SUBJECT, 'Trigger Subject'],
    [BYSTANDER, 'Trigger Bystander'],
  ]) {
    await admin.auth().createUser({uid, displayName: name});
  }
}, 60_000);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app?.delete()));
});

describe('syncPublicProfile fires for real (W2-114)', () => {
  test('🔴 THE TRIGGER IS LIVE — writing users/{uid} CREATES the projection', async () => {
    // KEY: THIS IS THE ANTI-VACUITY SEED, AND IT IS STRONGER THAN SEEDING.
    // The brief's warning is that "the profile is gone" passes against a store
    // where it never existed. The usual fix is to seed the profile and assert
    // it is present first. Better: DO NOT SEED IT AT ALL and let the trigger
    // create it. Then its existence is itself evidence the trigger fires, and
    // the deletion assertion below cannot be satisfied by an absence that was
    // always there.
    //
    // WARNING: It is also the only assertion in this file that can fail because the
    // functions emulator did not boot — which is exactly the failure that
    // should be loud.
    await db.doc(`users/${SUBJECT}`).set({avatarUrl: 'fox', isPublic: true});

    expect(await settles(`publicProfiles/${SUBJECT}`, 'exists')).toBe(true);

    const proj = (await db.doc(`publicProfiles/${SUBJECT}`).get()).data();
    // The name comes from the AUTH record, not the document — nothing has ever
    // written displayName to Firestore. So this also proves the handler reached
    // admin.auth() inside the emulator rather than degrading to an empty name.
    expect(proj?.displayName).toBe('Trigger Subject');
  }, 30_000);

  test('the bystander gets one too, so the collection is not a single row', async () => {
    await db.doc(`users/${BYSTANDER}`).set({avatarUrl: 'duck', isPublic: true});
    expect(await settles(`publicProfiles/${BYSTANDER}`, 'exists')).toBe(true);
  }, 30_000);

  test('🔴 deleteAccount removes the projection — #489\'s last hop, observed', async () => {
    // The precondition, asserted rather than assumed. If this is ever false the
    // test below proves nothing, and the brief names that as the default
    // failure mode of every absence assertion.
    expect((await db.doc(`publicProfiles/${SUBJECT}`).get()).exists).toBe(true);
    expect((await db.doc(`users/${SUBJECT}`).get()).exists).toBe(true);

    const res = await call('deleteAccount', SUBJECT, {});
    expect(res.deleted).toBe(true);

    // The callable deletes users/{uid} and deliberately does NOT touch the
    // projection. Everything after this line is the trigger's doing.
    expect(await settles(`users/${SUBJECT}`, 'gone')).toBe(true);
    expect(await settles(`publicProfiles/${SUBJECT}`, 'gone')).toBe(true);
  }, 60_000);

  test('🔴 CONTROL — the bystander\'s profile survived the whole thing', async () => {
    // Without this, "the projection is gone" is compatible with the trigger —
    // or the cascade — having emptied the collection. It also fails if the
    // path pattern users/{uid} were ever widened to something that matches
    // more documents than it should.
    expect((await db.doc(`publicProfiles/${BYSTANDER}`).get()).exists).toBe(true);
    expect((await db.doc(`users/${BYSTANDER}`).get()).exists).toBe(true);
  });
});
