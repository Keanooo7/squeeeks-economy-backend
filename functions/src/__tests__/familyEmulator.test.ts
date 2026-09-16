/**
 * The family feature, driven end to end against a REAL Firestore.
 *
 * ---------------------------------------------------------------------------
 * 🔴 WHY THIS FILE EXISTS: EVERY GATE WAS GREEN AND NOTHING HAD ASKED A REAL
 *    QUESTION
 * ---------------------------------------------------------------------------
 *
 * As of 2026-08-15 the family feature had: nine deployed callables, a deployed
 * ruleset, a landed client (#429), a 1179-test unit suite and a 188-test rules
 * suite. Not one of those gates exercised the feature.
 *
 *   · `npm test` drives the callables in `index.ts` against a HAND-WRITTEN FAKE
 *     firestore (see the `jest.mock('firebase-admin', ...)` header in
 *     housemateToken.test.ts and its siblings). A fake `runTransaction` cannot
 *     re-run on contention, a fake `where()` cannot need an index, and a fake
 *     `set(..., {merge:true})` merges however the fake was written to merge.
 *   · `npm run test:rules` loads `firestore.rules` into a real emulator, but
 *     every document it judges was SEEDED BY THE TEST. It proves the rules are
 *     correct about documents the test invented — never about the documents the
 *     callables actually write.
 *   · `make test` (Flutter) drives the client against fakes.
 *
 * 🔴 AND ONE OF THOSE FAKES IS WRONG IN THE REASSURING DIRECTION.
 * `fake_cloud_firestore` (4.1.0+1) calls `maybeThrowSecurityException` from
 * `mock_document_reference.dart` and from NOWHERE in the collection or query
 * classes. A DENIED COLLECTION READ RETURNS EMPTY THERE INSTEAD OF THROWING —
 * so on the client side an empty family and a forbidden family are the same
 * observation, and no widget test can tell them apart. Found by W4.
 *
 * ⚠️ THAT IS A CLAIM ABOUT AN INSTRUMENT, SO IT IS TESTED RATHER THAN TRUSTED:
 * `the emulator THROWS on a denied COLLECTION read` below asserts the real
 * behaviour on a NON-EMPTY collection, which is the only version of that
 * assertion that distinguishes "denied" from "nothing there".
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DOES
 * ---------------------------------------------------------------------------
 *
 * 1. Boots the Firestore AND Auth emulators (`npm run test:e2e`).
 * 2. Imports `../index` UNMOCKED, so the Admin SDK inside every callable talks
 *    to that real Firestore. `.run()` is firebase-functions' own test hook, so
 *    the handler, its transactions, its queries and its `HttpsError`s are the
 *    shipped ones.
 * 3. Walks the whole feature in order — createFamily → mintFamilyInvite →
 *    joinFamily → assignFamilyChore → completeFamilyChore → postFamilyMessage →
 *    completeTrashDay — asserting the DOCUMENTS THAT LAND, not the return
 *    values.
 * 4. Then reads that produced data back through `@firebase/rules-unit-testing`
 *    as a MEMBER and as a NON-MEMBER, so the rules are judged against the real
 *    output of the real writers.
 * 5. Ends with a MUTATION CONTROL: the same reads under a ruleset with the
 *    membership clauses removed, which must SUCCEED. Without it, every
 *    `assertFails` above is compatible with the reads failing for some reason
 *    that has nothing to do with the rule under test.
 *
 * ---------------------------------------------------------------------------
 * 🔴 WHAT THIS STILL CANNOT PROVE — READ THIS BEFORE CALLING THE FEATURE DONE
 * ---------------------------------------------------------------------------
 *
 *   · IT DOES NOT ASK PRODUCTION ANYTHING. This runs `index.ts` FROM THIS
 *     WORKING TREE. The deployed revision can be older, and was for weeks.
 *     `make check-deployed` (#431) is the gate for that question and this is
 *     not a second one.
 *   · IT DOES NOT EXERCISE THE CALLABLE TRANSPORT. `.run()` hands the handler a
 *     `CallableRequest` directly. App Check, the ID-token verification that
 *     populates `request.auth`, CORS, region and timeout are all skipped. A
 *     caller who is NOT who they say they are is outside this file entirely —
 *     every `unauthenticated` branch here is proven only for a null `auth`.
 *   · IT DOES NOT TOUCH THE DART CLIENT. Nothing here proves the app calls
 *     these callables with the right arguments, renders their responses, or
 *     handles their errors. The client's own suite still runs against fakes,
 *     and the fake's denied-collection-read behaviour is still wrong.
 *   · IT DOES NOT PROVE THE ENTITLEMENT REACHES A USER-FACING SURFACE. It
 *     asserts `resolveEffectiveTier` says `pro` for the joiner's stored
 *     document — the real classifier over the real document — and stops there.
 *   · IT PROVES NOTHING ABOUT APPLE. No StoreKit product exists for
 *     `sub_family_monthly` (#382 reverted it), so the owner's subscription here
 *     is a seeded document, not a verified receipt. The renewal and refund
 *     fan-outs are unit-tested pure functions and are not driven here.
 *   · ROUTING AND AUTH REJECTION ARE NOT THE FEATURE WORKING. A denial proves a
 *     door is shut. Only the happy path proves there is a room behind it, and
 *     only a human on a device proves the room is worth entering.
 */
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import {readFileSync} from 'fs';
import {resolve} from 'path';
import * as admin from 'firebase-admin';

import {
  FAMILY_CAP,
  FAMILY_DEPARTURE_REFUSALS,
  FAMILY_PRODUCT_ID,
  FamilyDoc,
} from '../family';
import {CHORE_REFUSALS, FamilyChoreDoc, TASK_LIBRARY_IDS} from '../familyChores';
import {FamilyMessageDoc} from '../familyMessages';
import {resolveEffectiveTier, resolveOwnPaidTier} from '../taskRewards';
import {
  BIN_DATE_MAX_SKEW_DAYS,
  TRASH_DAY_REFUSALS,
  TrashDayCompletion,
  utcBinDateKey,
} from '../trashDay';

// 🔑 IMPORTED FOR ITS SIDE EFFECT, AND THE ORDER MATTERS. `index.ts` calls
// `admin.initializeApp()` at module scope; doing it here first would throw
// "The default Firebase app already exists". Every `admin.*` call below runs
// inside a test, i.e. after this line.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const idx = require('../index') as Record<string, {run: (req: unknown) => Promise<any>}>;

const RULES_PATH = resolve(__dirname, '../../../firestore.rules');

/**
 * 🔴 READ FROM THE ENVIRONMENT, NEVER WRITTEN AS A LITERAL. The Admin SDK picks
 * its project up from `GCLOUD_PROJECT`, which `emulators:exec` sets. If the
 * rules-test environment used a DIFFERENT id it would look at a different
 * database — every `assertFails` would pass against an empty project, and the
 * suite would be green while asserting nothing. Same project, or refuse.
 */
const PROJECT_ID = process.env.GCLOUD_PROJECT;

const OWNER = 'e2e-owner';
const KID = 'e2e-kid';
/** In a family of their OWN — see the decoy note in `beforeAll`. */
const OUTSIDER = 'e2e-outsider';
const OUTSIDER_KID = 'e2e-outsider-kid';
// W2-120: two fresh founders, because createFamily refuses a second family per
// owner — the seeding cases each need an owner who has never made one.
const FOUNDER = 'e2e-founder-binday';
const FOUNDER_TWO = 'e2e-founder-binday-2';
// W2-177: an account that PAYS, for the wrong product. Not a second pauper —
// see the case itself for why that distinction is the entire test.
const PRO_ONLY = 'e2e-pro-only';
/** A real personal Pro product. `SUBSCRIPTION_PRODUCT_TIERS` maps it to `pro`. */
const PERSONAL_PRO_PRODUCT_ID = 'sub_pro_monthly';

/** Far enough out that the real clock inside the callables cannot lapse it. */
const OWNER_EXPIRY_MS = Date.parse('2099-01-01T00:00:00Z');
const CHORE_TASK_ID = TASK_LIBRARY_IDS[0];

/**
 * Today's bin date, in the server's own vocabulary.
 *
 * 🔴 DERIVED FROM `utcBinDateKey(Date.now())`, NEVER WRITTEN AS A LITERAL, and
 * that is not fussiness. `planTrashDayCompletion` refuses any key more than
 * `BIN_DATE_MAX_SKEW_DAYS` from the server's today, so a hard-coded date would
 * pass on the day it was written and then fail forever afterwards for a reason
 * having nothing to do with the feature — a suite that rots on a calendar.
 * Using the module's own function also means a change to the key FORMAT cannot
 * make this file disagree with the code it tests.
 */
const BIN_DATE_KEY = utcBinDateKey(Date.now());

let testEnv: RulesTestEnvironment;
let db: admin.firestore.Firestore;

/** State produced by the lifecycle tests, consumed by the rules tests. */
let familyId = '';
let choreId = '';
let decoyFamilyId = '';

/** Invoke a callable the way firebase-functions itself does for tests. */
function call(name: string, uid: string | null, data: unknown): Promise<any> {
  const fn = idx[name];
  if (!fn || typeof fn.run !== 'function') {
    throw new Error(`index.ts exports no callable named "${name}"`);
  }
  return fn.run({
    data,
    auth: uid ? {uid, token: {}} : undefined,
    rawRequest: {},
  });
}

/** The HttpsError code a call rejects with, or null if it resolved. */
async function refusalCodeOf(p: Promise<unknown>): Promise<string | null> {
  return (await refusalOf(p))?.code ?? null;
}

/**
 * The code AND message a call rejects with, or null if it resolved.
 *
 * ⚠️ THE MESSAGE IS NOT DECORATION. `CHORE_REFUSALS` maps THREE different
 * refusals — `not-a-member`, `unknown-task` and `due-in-the-past` — onto the
 * single code `invalid-argument`. A test asserting only the code cannot tell
 * "you tried to assign a chore to somebody outside the family" from "you sent a
 * taskId with a typo", so it would pass for the wrong reason exactly when the
 * membership check was the thing that broke.
 */
async function refusalOf(
  p: Promise<unknown>,
): Promise<{code: string; message: string} | null> {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as {code?: unknown; message?: unknown};
    return {code: String(e.code ?? ''), message: String(e.message ?? '')};
  }
}

/**
 * A user who pays for [productId], written the way `verifySubscriptionReceipt`
 * writes it — a real `Timestamp`, not a number, because `expiryMillis` decodes
 * several shapes and the stored one is the shape that matters.
 */
async function seedSubscriber(uid: string, productId: string) {
  await db.doc(`users/${uid}`).set({
    subscriptionTier: 'pro',
    subscriptionProductId: productId,
    subscriptionExpiresAt: admin.firestore.Timestamp.fromMillis(OWNER_EXPIRY_MS),
    avatarUrl: `avatar-of-${uid}`,
  });
}

/** create → mint → join, with no assertions. Used only for the decoy. */
async function buildFamily(ownerUid: string, joinerUid: string): Promise<string> {
  const created = await call('createFamily', ownerUid, {});
  const minted = await call('mintFamilyInvite', ownerUid, {});
  await call('joinFamily', joinerUid, {code: minted.code});
  return created.familyId as string;
}

beforeAll(async () => {
  // Refuses rather than guessing: an unset project id here is the silent
  // two-databases failure described on PROJECT_ID.
  if (!PROJECT_ID) {
    throw new Error(
      'GCLOUD_PROJECT is unset — run this through `npm run test:e2e`, which ' +
        'boots the emulators and sets it. Running it under plain `jest` would ' +
        'point the Admin SDK at a project the rules tests cannot see.',
    );
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are unset. Without ' +
        'them the Admin SDK would try to reach REAL Firestore, and these tests ' +
        'write freely.',
    );
  }

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {rules: readFileSync(RULES_PATH, 'utf8')},
  });
  await testEnv.clearFirestore();

  db = admin.firestore();

  // Auth records, because `createFamily` and `joinFamily` stamp
  // `memberNames` from `admin.auth().getUser()`. Without the Auth emulator
  // those calls degrade to `undefined` — deliberately, so a missing Auth
  // record cannot fail a join — and the name-stamping path would go untested
  // while looking tested.
  for (const [uid, name] of [
    [OWNER, 'Owner Parent'],
    [KID, 'Kid Member'],
    [OUTSIDER, 'Outsider Parent'],
    [OUTSIDER_KID, 'Outsider Kid'],
  ]) {
    await admin.auth().createUser({uid, displayName: name});
  }

  await seedSubscriber(OWNER, FAMILY_PRODUCT_ID);
  await seedSubscriber(OUTSIDER, FAMILY_PRODUCT_ID);
  await db.doc(`users/${KID}`).set({avatarUrl: 'avatar-of-kid'});
  await db.doc(`users/${OUTSIDER_KID}`).set({avatarUrl: 'avatar-of-outsider-kid'});

  // ---------------------------------------------------------------------
  // 🔴 THE DECOY, BUILT FIRST AND ON PURPOSE.
  //
  // A control over a query passes on seed order. If the only family in the
  // database were the one under test, then `a non-member cannot read it`
  // would also pass for a database with no families, for credentials that
  // authenticate nobody, and for a rules file that denied everything — and
  // `a client cannot LIST families` would pass over an empty collection,
  // which is not a denial at all.
  //
  // So the OUTSIDER gets a complete family of their own — roster, chore,
  // message — BEFORE the family under test exists. Every denial below is
  // then paired with the same read succeeding against the decoy from the
  // same credentials, which is the only shape that isolates membership as
  // the cause.
  // ---------------------------------------------------------------------
  decoyFamilyId = await buildFamily(OUTSIDER, OUTSIDER_KID);
  const decoyChore = await call('assignFamilyChore', OUTSIDER, {
    familyId: decoyFamilyId,
    uid: OUTSIDER_KID,
    taskId: CHORE_TASK_ID,
    dueAtMs: Date.now() + 86_400_000,
  });
  await call('completeFamilyChore', OUTSIDER_KID, {
    familyId: decoyFamilyId,
    choreId: decoyChore.choreId,
  });
  await call('postFamilyMessage', OUTSIDER, {
    familyId: decoyFamilyId,
    text: 'a decoy message in a family the outsider really is in',
  });
  // 🔑 THE DECOY'S BINS GO OUT TOO (W2-94). Without this, "a non-member cannot
  // read our trash day" would be paired with nothing — and the outsider having
  // NO trash day of their own makes a denial and an empty household look the
  // same from outside, which is the exact confusion this suite exists to end.
  await call('completeTrashDay', OUTSIDER, {
    familyId: decoyFamilyId,
    binDateKey: BIN_DATE_KEY,
  });
}, 120_000);

afterAll(async () => {
  await testEnv?.cleanup();
  await Promise.all(admin.apps.map((app) => app?.delete()));
});

// ---------------------------------------------------------------------------
// The lifecycle, in order, through the real callables
// ---------------------------------------------------------------------------
//
// These run in declaration order and each depends on the last, because the
// feature does. A failure part-way cascades — which is the honest report: the
// steps after a broken create genuinely were not proven.

describe('the family lifecycle, driven through the real callables', () => {
  test('createFamily writes a families/ document and stamps the owner', async () => {
    const res = await call('createFamily', OWNER, {});
    familyId = res.familyId;
    expect(typeof familyId).toBe('string');
    expect(familyId.length).toBeGreaterThan(0);

    // 🔑 THE DOCUMENT, NOT THE RESPONSE. A callable can return a familyId it
    // never persisted; that is exactly the shape a fake `set()` cannot catch.
    const snap = await db.doc(`families/${familyId}`).get();
    expect(snap.exists).toBe(true);
    const family = snap.data() as FamilyDoc;
    expect(family.ownerUid).toBe(OWNER);
    expect(family.memberUids).toEqual([OWNER]);
    // Stamped from the Auth record and from users/{uid}.avatarUrl. A family
    // page with no names is the W2-87 failure, and it renders as a bug.
    expect(family.memberNames).toEqual({[OWNER]: 'Owner Parent'});
    expect(family.memberAvatars).toEqual({[OWNER]: `avatar-of-${OWNER}`});

    const owner = await db.doc(`users/${OWNER}`).get();
    expect(owner.data()?.familyId).toBe(familyId);
    // `merge: true` really merged: the subscription is still there. A fake
    // that implemented set() as a replace would pass every other assertion
    // here and silently have wiped the thing that funds the family.
    expect(owner.data()?.subscriptionProductId).toBe(FAMILY_PRODUCT_ID);
  });

  test('a second createFamily by the same owner is refused', async () => {
    // The single-ownership invariant `appStoreNotificationsV2`'s `.limit(1)`
    // read has always assumed. This is the first time the transactional query
    // that enforces it has run against a real Firestore.
    expect(await refusalCodeOf(call('createFamily', OWNER, {}))).toBe('already-exists');
    const owned = await db.collection('families').where('ownerUid', '==', OWNER).get();
    expect(owned.size).toBe(1);
  });

  test('a free user cannot create a family', async () => {
    await admin.auth().createUser({uid: 'e2e-pauper', displayName: 'Pauper'});
    await db.doc('users/e2e-pauper').set({avatarUrl: 'x'});
    expect(await refusalCodeOf(call('createFamily', 'e2e-pauper', {}))).toBe(
      'failed-precondition',
    );
    expect((await db.collection('families').where('ownerUid', '==', 'e2e-pauper').get()).empty)
      .toBe(true);
  });

  // ---------------------------------------------------------------------
  // 🔴 W2-177 — A PERSONAL PRO SUBSCRIPTION DOES NOT FUND A FAMILY
  // ---------------------------------------------------------------------
  //
  // Ruled 2026-09-04: only `sub_family_monthly` may create a family. Before
  // this, the create gate asked only "is this account on a paid tier", and
  // BOTH products resolve to the tier `pro` on purpose
  // (`SUBSCRIPTION_PRODUCT_TIERS`: "family is a SOURCE of pro, not a third
  // tier"). So the gate was structurally blind to the product, and a personal
  // Pro subscriber could found a family that `planFamilyFanOutForEffect` can
  // never grant anybody anything — it returns `[]` unless the effect's product
  // is FAMILY_PRODUCT_ID.
  //
  // 🔑 THIS IS NOT THE FREE-USER CASE ABOVE UNDER A NEW NAME, AND THE
  // ASSERTION THAT KEEPS IT HONEST IS THE FIRST ONE. This account IS paying:
  // `resolveOwnPaidTier` — the exact resolver the gate consumes — returns
  // `pro` for it. It therefore PASSES the old gate in full. If that assertion
  // ever goes red the refusal below has stopped being about the product and
  // has become about the tier, at which point this test proves nothing that
  // the pauper case did not already prove.
  test('🔴 a PERSONAL Pro subscriber cannot create a family', async () => {
    await admin.auth().createUser({uid: PRO_ONLY, displayName: 'Pro Only'});
    await seedSubscriber(PRO_ONLY, PERSONAL_PRO_PRODUCT_ID);

    // The control: paying, on a paid tier, unexpired — everything the old gate
    // asked for. Read back from Firestore rather than asserted about the
    // fixture, so a seed that silently failed to write cannot look like a pass.
    const seeded = (await db.doc(`users/${PRO_ONLY}`).get()).data();
    expect(seeded?.subscriptionProductId).toBe(PERSONAL_PRO_PRODUCT_ID);
    expect(seeded?.subscriptionProductId).not.toBe(FAMILY_PRODUCT_ID);
    expect(resolveOwnPaidTier(seeded, Date.now())).toBe('pro');

    expect(await refusalCodeOf(call('createFamily', PRO_ONLY, {}))).toBe(
      'failed-precondition',
    );

    // 🔑 THE ABSENCE IS THE POINT. A refusal that still wrote the document
    // would be the empty shell this rule exists to prevent, and the code
    // assertion alone cannot see it.
    expect((await db.collection('families').where('ownerUid', '==', PRO_ONLY).get()).empty)
      .toBe(true);
  });

  test('mintFamilyInvite writes a familyInvites/ document naming this family', async () => {
    const res = await call('mintFamilyInvite', OWNER, {});
    expect(typeof res.code).toBe('string');
    const invite = await db.doc(`familyInvites/${res.code}`).get();
    expect(invite.exists).toBe(true);
    expect(invite.data()?.familyId).toBe(familyId);
    expect(invite.data()?.ownerUid).toBe(OWNER);
    // Spent immediately below by the join test; minting a second one here
    // would leave a live capability lying in the database.
    await db.doc(`familyInvites/${res.code}`).delete();
  });

  test('a non-owner cannot mint an invite into a family', async () => {
    expect(await refusalCodeOf(call('mintFamilyInvite', KID, {}))).toBe(
      'failed-precondition',
    );
  });

  test('joinFamily adds the member, grants Pro, and spends the invite', async () => {
    const {code} = await call('mintFamilyInvite', OWNER, {});
    const res = await call('joinFamily', KID, {code});
    expect(res.familyId).toBe(familyId);

    const family = (await db.doc(`families/${familyId}`).get()).data() as FamilyDoc;
    expect(family.memberUids).toEqual([OWNER, KID]);
    expect(family.memberNames).toEqual({[OWNER]: 'Owner Parent', [KID]: 'Kid Member'});

    const kid = (await db.doc(`users/${KID}`).get()).data();
    expect(kid?.familyId).toBe(familyId);

    // 🔴 THE GRANT IS THE FEATURE. `familyProExpiresAt` is the owner's own
    // expiry COPIED — never extended — so a member cannot outlive the period
    // somebody paid for. Asserted as the exact millisecond, because "some
    // timestamp got written" is what a bespoke second grant path would also
    // satisfy.
    expect((kid?.familyProExpiresAt as admin.firestore.Timestamp).toMillis()).toBe(
      OWNER_EXPIRY_MS,
    );

    // 🔑 DRIVEN THROUGH THE REAL CLASSIFIER OVER THE REAL STORED DOCUMENT, not
    // a hand-built one. W2-79: every test that constructed the input by hand
    // passed against a broken table; only the ones going through the real
    // classifier went red.
    const now = Date.now();
    expect(resolveEffectiveTier(kid, now)).toBe('pro');
    // …and they are entitled without paying, which is the whole point and also
    // the thing that must NOT let them start a family of their own.
    expect(resolveOwnPaidTier(kid, now)).toBe('free');

    expect((await db.doc(`familyInvites/${code}`).get()).exists).toBe(false);
    expect(await refusalCodeOf(call('joinFamily', OUTSIDER_KID, {code}))).toBe('not-found');
  });

  test('a member of another family cannot join this one', async () => {
    // Only meaningful because the decoy exists: OUTSIDER_KID is genuinely in
    // a different family, not merely absent from this one.
    const {code} = await call('mintFamilyInvite', OWNER, {});
    expect(await refusalCodeOf(call('joinFamily', OUTSIDER_KID, {code}))).toBe(
      'failed-precondition',
    );
    const family = (await db.doc(`families/${familyId}`).get()).data() as FamilyDoc;
    expect(family.memberUids).toEqual([OWNER, KID]);
    await db.doc(`familyInvites/${code}`).delete();
  });

  test('a family member entitled by the grant cannot create their own family', async () => {
    // The empty-shell case `resolveOwnPaidTier` exists to reject, arriving
    // through a real stored `familyProExpiresAt` rather than a fixture.
    expect(await refusalCodeOf(call('createFamily', KID, {}))).toBe('failed-precondition');
  });

  test('assignFamilyChore writes a chore under the family', async () => {
    const dueAtMs = Date.now() + 86_400_000;
    const res = await call('assignFamilyChore', OWNER, {
      familyId,
      uid: KID,
      taskId: CHORE_TASK_ID,
      dueAtMs,
    });
    choreId = res.choreId;

    const chore = (
      await db.doc(`families/${familyId}/chores/${choreId}`).get()
    ).data() as FamilyChoreDoc;
    expect(chore.taskId).toBe(CHORE_TASK_ID);
    expect(chore.assignedToUid).toBe(KID);
    expect(chore.assignedByUid).toBe(OWNER);
    // Explicitly null, not absent — "outstanding" is a value the document
    // asserts rather than one a reader infers.
    expect(chore.completedAtMs).toBeNull();
  });

  test('only the owner assigns, and only to a member', async () => {
    const dueAtMs = Date.now() + 86_400_000;
    expect(
      await refusalCodeOf(
        call('assignFamilyChore', KID, {familyId, uid: KID, taskId: CHORE_TASK_ID, dueAtMs}),
      ),
    ).toBe('permission-denied');
    // Code AND message: `invalid-argument` is also what an unknown taskId and
    // a past due date earn, so the code alone would not name the roster check.
    expect(
      await refusalOf(
        call('assignFamilyChore', OWNER, {
          familyId,
          uid: OUTSIDER_KID,
          taskId: CHORE_TASK_ID,
          dueAtMs,
        }),
      ),
    ).toEqual({
      code: 'invalid-argument',
      message: CHORE_REFUSALS['not-a-member'].message,
    });
    // Neither refusal left a document behind.
    expect((await db.collection(`families/${familyId}/chores`).get()).size).toBe(1);
  });

  test('completeFamilyChore stamps the assignee’s completion, once', async () => {
    const res = await call('completeFamilyChore', KID, {familyId, choreId});
    const chore = (
      await db.doc(`families/${familyId}/chores/${choreId}`).get()
    ).data() as FamilyChoreDoc;
    expect(chore.completedAtMs).toBe(res.completedAtMs);
    expect(typeof chore.completedAtMs).toBe('number');

    // A second completion is refused, and the FIRST time survives — the thing
    // a real transaction gives that a fake read-then-write does not.
    const first = chore.completedAtMs;
    expect(await refusalOf(call('completeFamilyChore', KID, {familyId, choreId}))).toEqual({
      code: 'already-exists',
      message: CHORE_REFUSALS['already-done'].message,
    });
    const after = (
      await db.doc(`families/${familyId}/chores/${choreId}`).get()
    ).data() as FamilyChoreDoc;
    expect(after.completedAtMs).toBe(first);
  });

  test('a non-assignee cannot complete somebody else’s chore', async () => {
    const dueAtMs = Date.now() + 86_400_000;
    const {choreId: kidsChore} = await call('assignFamilyChore', OWNER, {
      familyId,
      uid: KID,
      taskId: CHORE_TASK_ID,
      dueAtMs,
    });
    // The OWNER is not the assignee. Completion is the member's own act.
    expect(
      await refusalCodeOf(call('completeFamilyChore', OWNER, {familyId, choreId: kidsChore})),
    ).toBe('permission-denied');
    const chore = (
      await db.doc(`families/${familyId}/chores/${kidsChore}`).get()
    ).data() as FamilyChoreDoc;
    expect(chore.completedAtMs).toBeNull();
  });

  test('postFamilyMessage writes the message with the sender stamped on it', async () => {
    const res = await call('postFamilyMessage', KID, {
      familyId,
      text: 'bins are out',
    });
    const msg = (
      await db.doc(`families/${familyId}/messages/${res.messageId}`).get()
    ).data() as FamilyMessageDoc;
    expect(msg.text).toBe('bins are out');
    expect(msg.senderUid).toBe(KID);
    // Denormalised onto the message because a client cannot read another
    // member's publicProfiles document. An empty name here renders as an
    // unnamed bubble, which is why it is asserted as the name.
    expect(msg.senderName).toBe('Kid Member');
    expect(msg.senderAvatarId).toBe('avatar-of-kid');
  });

  test('a non-member cannot post to the board', async () => {
    expect(
      await refusalCodeOf(call('postFamilyMessage', OUTSIDER, {familyId, text: 'hello'})),
    ).toBe('permission-denied');
    expect((await db.collection(`families/${familyId}/messages`).get()).size).toBe(1);
  });

  test('the message filter runs server-side, not only in the client', async () => {
    expect(
      await refusalCodeOf(
        call('postFamilyMessage', KID, {familyId, text: 'go to example dot com slash x'}),
      ),
    ).not.toBeNull();
    expect(
      await refusalCodeOf(call('postFamilyMessage', KID, {familyId, text: '   '})),
    ).not.toBeNull();
    expect((await db.collection(`families/${familyId}/messages`).get()).size).toBe(1);
  });

  test('the cap is enforced at the join, against a real roster', async () => {
    // Exactly the seats that remain: the family already holds OWNER + KID, so
    // there are FAMILY_CAP - 2 of them, and filling them EXACTLY is what makes
    // the next mint refuse. Derived rather than written out, because a literal
    // roster here silently stops testing the boundary the day the cap moves —
    // which is precisely what W2-123 found it doing at 4.
    const extras = Array.from(
      {length: FAMILY_CAP - 2},
      (_, i) => `e2e-extra-${i + 1}`,
    );
    for (const uid of extras) {
      await admin.auth().createUser({uid, displayName: uid});
      await db.doc(`users/${uid}`).set({avatarUrl: 'x'});
    }
    for (const uid of extras) {
      const {code} = await call('mintFamilyInvite', OWNER, {});
      await call('joinFamily', uid, {code});
    }
    // The mint itself now refuses, before a code is even spent.
    expect(await refusalCodeOf(call('mintFamilyInvite', OWNER, {}))).toBe(
      'resource-exhausted',
    );
    const family = (await db.doc(`families/${familyId}`).get()).data() as FamilyDoc;
    expect(family.memberUids).toHaveLength(FAMILY_CAP);
  });
});

// ---------------------------------------------------------------------------
// Trash day (W2-94) — the seventh callable, and the one #436 left out
// ---------------------------------------------------------------------------
//
// `TrashDayTakeover` is mounted at `main.dart:291` as of #434, so the shared
// completion is now a surface a person can reach. Before this describe it was
// in exactly the state the family feature was in before #436: shipped,
// deployed, and proven by nothing that asked a real question.
//
// 📌 THE HYPOTHESIS UNDER TEST WAS "THIS IS COVERAGE, NOT REPAIR" — W2-81
// established from the SOURCE that the writes are safe. Source-reading is what
// missed nine undeployed callables, so the emulator is asked directly. Where it
// agrees, that is worth exactly as much as the disagreement would have been.

describe('trash day, driven through the real callable', () => {
  test('completeTrashDay writes the shared fact under the family', async () => {
    const res = await call('completeTrashDay', KID, {familyId, binDateKey: BIN_DATE_KEY});
    expect(res.wrote).toBe(true);

    const snap = await db.doc(`families/${familyId}/trashDay/${BIN_DATE_KEY}`).get();
    expect(snap.exists).toBe(true);
    const completion = snap.data() as TrashDayCompletion;
    expect(completion.binDateKey).toBe(BIN_DATE_KEY);
    expect(completion.completedByUid).toBe(KID);
    expect(typeof completion.completedAtMs).toBe('number');

    // 🔑 THE DOCUMENT ID IS THE BIN DATE, so scoping is structural rather than
    // filtered. Asserted because "the record went somewhere under this family"
    // and "the record is at the key next week's reminder will look up" are
    // different facts, and only the second makes the takeover clear.
    expect(snap.id).toBe(BIN_DATE_KEY);
    // It clears for this family's roster and for nobody else. `clearsFor` is
    // returned explicitly so a test can NAME the set — an absence cannot be
    // named.
    expect(res.clearedForCount).toBe(FAMILY_CAP);
  });

  test('🔴 a SECOND completer does not displace the first', async () => {
    const before = (
      await db.doc(`families/${familyId}/trashDay/${BIN_DATE_KEY}`).get()
    ).data() as TrashDayCompletion;

    // A different real member, through the real callable, for the same day.
    const res = await call('completeTrashDay', OWNER, {familyId, binDateKey: BIN_DATE_KEY});

    // Succeeds — the end state already holds and an error would tell the second
    // tapper their bins are not out.
    expect(res.wrote).toBe(false);
    expect(res.completedByUid).toBe(KID);

    const after = (
      await db.doc(`families/${familyId}/trashDay/${BIN_DATE_KEY}`).get()
    ).data() as TrashDayCompletion;
    // 🔴 THE STORED DOCUMENT, NOT THE RESPONSE. A callable can return the first
    // completer while having overwritten the record — that is precisely what a
    // read-then-write outside a transaction would do, and the response would
    // still look right.
    expect(after).toEqual(before);
    expect(after.completedByUid).toBe(KID);
    expect(after.completedAtMs).toBe(before.completedAtMs);
  });

  test('a NON-MEMBER cannot complete another household’s bin day', async () => {
    expect(
      await refusalOf(call('completeTrashDay', OUTSIDER, {familyId, binDateKey: BIN_DATE_KEY})),
    ).toEqual({
      code: 'permission-denied',
      message: TRASH_DAY_REFUSALS['not-a-member'].message,
    });
    // The record still names the member who actually did it.
    const after = (
      await db.doc(`families/${familyId}/trashDay/${BIN_DATE_KEY}`).get()
    ).data() as TrashDayCompletion;
    expect(after.completedByUid).toBe(KID);
  });

  test('🔑 a stranger learns nothing about the DATE — membership is checked first', async () => {
    // Both of these are malformed dates. A member gets told so; a non-member
    // gets `not-a-member` for BOTH, so the refusal text cannot be used to probe
    // which keys a household would have accepted.
    const strangerNonsense = await refusalOf(
      call('completeTrashDay', OUTSIDER, {familyId, binDateKey: 'not-a-date'}),
    );
    const strangerImpossible = await refusalOf(
      call('completeTrashDay', OUTSIDER, {familyId, binDateKey: '2026-02-31'}),
    );
    expect(strangerNonsense?.message).toBe(TRASH_DAY_REFUSALS['not-a-member'].message);
    expect(strangerImpossible?.message).toBe(TRASH_DAY_REFUSALS['not-a-member'].message);

    // The control: the SAME inputs from a member DO produce the date refusal,
    // so the two above are the membership check firing and not a date check
    // that happens to answer the same way.
    expect(
      await refusalOf(call('completeTrashDay', KID, {familyId, binDateKey: 'not-a-date'})),
    ).toEqual({
      code: 'invalid-argument',
      message: TRASH_DAY_REFUSALS['malformed-bin-date'].message,
    });
    // `2026-02-31` matches /^\d{4}-\d{2}-\d{2}$/ and Date.parse rolls it to
    // March 3rd, so a pattern-only check would create a document at a key no
    // later lookup could ever find.
    expect(
      await refusalOf(call('completeTrashDay', KID, {familyId, binDateKey: '2026-02-31'})),
    ).toEqual({
      code: 'invalid-argument',
      message: TRASH_DAY_REFUSALS['malformed-bin-date'].message,
    });
  });

  test('a bin date too far from today is refused, and writes nothing', async () => {
    const farOff = utcBinDateKey(
      Date.now() + (BIN_DATE_MAX_SKEW_DAYS + 3) * 86_400_000,
    );
    expect(
      await refusalOf(call('completeTrashDay', KID, {familyId, binDateKey: farOff})),
    ).toEqual({
      code: 'invalid-argument',
      message: TRASH_DAY_REFUSALS['bin-date-out-of-range'].message,
    });
    expect((await db.doc(`families/${familyId}/trashDay/${farOff}`).get()).exists).toBe(false);
    // Exactly one completion exists for this household — the refusals above
    // left no debris, which a `size` check can see and a per-document check
    // cannot.
    expect((await db.collection(`families/${familyId}/trashDay`).get()).size).toBe(1);
  });

  test('naming a family that does not exist says nothing about who is in one', async () => {
    // Same shape a non-member gets nothing extra from.
    expect(await refusalCodeOf(call('completeTrashDay', KID, {
      familyId: 'no-such-family',
      binDateKey: BIN_DATE_KEY,
    }))).toBe('not-found');
    // A slash would escape the collection and address an arbitrary document.
    expect(await refusalCodeOf(call('completeTrashDay', KID, {
      familyId: 'families/x/trashDay',
      binDateKey: BIN_DATE_KEY,
    }))).toBe('invalid-argument');
  });
});

describe('the shared bin day, driven through the real callables', () => {
  // 🔴 THIS BLOCK EXISTS BECAUSE W2-118 SHIPPED WITH IT MISSING AND SAID SO.
  // `planFamilyBinDay` is pure and has 14 unit cases; the CALLABLE WRAPPER —
  // the transaction, the `{merge: true}`, the not-found path — had none. The
  // merge is the one worth proving: a bare `set()` there would delete the
  // roster, the member names and the avatars to change one integer, and every
  // pure test would still pass.

  test('🔴 setFamilyBinDay MERGES — it does not replace the family document', async () => {
    // The state before, so the assertion is a comparison rather than a hope.
    const before = (await db.doc(`families/${familyId}`).get()).data() as FamilyDoc;
    expect(before.memberUids.length).toBeGreaterThan(1);
    expect(before.memberNames).toBeDefined();

    await call('setFamilyBinDay', OWNER, {familyId, binWeekday: 4});

    const after = (await db.doc(`families/${familyId}`).get()).data() as FamilyDoc;
    expect(after.binWeekday).toBe(4);
    // 🔑 THE ROSTER SURVIVED. Replace `{merge: true}` with a bare set() and
    // this is the assertion that goes red — the family loses every member,
    // every name and its own owner to a one-integer write.
    expect(after.memberUids).toEqual(before.memberUids);
    expect(after.ownerUid).toBe(before.ownerUid);
    expect(after.memberNames).toEqual(before.memberNames);
    expect(after.memberAvatars).toEqual(before.memberAvatars);
    expect(after.createdAtMs).toBe(before.createdAtMs);
  });

  test('the owner can change it again, and the last write wins', async () => {
    await call('setFamilyBinDay', OWNER, {familyId, binWeekday: 6});
    const snap = await db.doc(`families/${familyId}`).get();
    expect((snap.data() as FamilyDoc).binWeekday).toBe(6);
  });

  test('a member who is not the owner is refused, against a REAL roster', async () => {
    // KID genuinely joined this family earlier in the file — the fixture that
    // W2-113's four green denials did not have.
    const family = (await db.doc(`families/${familyId}`).get()).data() as FamilyDoc;
    expect(family.memberUids).toContain(KID);

    expect(await refusalCodeOf(
      call('setFamilyBinDay', KID, {familyId, binWeekday: 1}),
    )).toBe('permission-denied');

    // And it changed nothing.
    const after = (await db.doc(`families/${familyId}`).get()).data() as FamilyDoc;
    expect(after.binWeekday).toBe(6);
  });

  test('an outsider is refused and learns nothing about the family', async () => {
    expect(await refusalCodeOf(
      call('setFamilyBinDay', OUTSIDER, {familyId, binWeekday: 1}),
    )).toBe('permission-denied');
  });

  test('a bad weekday is refused and writes nothing', async () => {
    expect(await refusalCodeOf(
      call('setFamilyBinDay', OWNER, {familyId, binWeekday: 0}),
    )).toBe('invalid-argument');
    expect(await refusalCodeOf(
      call('setFamilyBinDay', OWNER, {familyId, binWeekday: 2.5}),
    )).toBe('invalid-argument');

    const after = (await db.doc(`families/${familyId}`).get()).data() as FamilyDoc;
    expect(after.binWeekday).toBe(6);
  });

  test('naming a family that does not exist is not-found, and a slash cannot escape', async () => {
    expect(await refusalCodeOf(
      call('setFamilyBinDay', OWNER, {familyId: 'no-such-family', binWeekday: 3}),
    )).toBe('not-found');
    expect(await refusalCodeOf(
      call('setFamilyBinDay', OWNER, {familyId: 'families/x/trashDay', binWeekday: 3}),
    )).toBe('invalid-argument');
  });

  test('🔑 W2-120 a family created WITH a founder weekday carries it from birth', async () => {
    // The whole point of the creation-time seeding: no window in which the
    // family exists and disagrees.
    await seedSubscriber(FOUNDER, FAMILY_PRODUCT_ID);
    const created = await call('createFamily', FOUNDER, {binWeekday: 5});

    const snap = await db.doc(`families/${created.familyId}`).get();
    expect((snap.data() as FamilyDoc).binWeekday).toBe(5);
  });

  test('🔴 W2-120 and one created WITHOUT one has NO field — no invented default', async () => {
    await seedSubscriber(FOUNDER_TWO, FAMILY_PRODUCT_ID);
    const created = await call('createFamily', FOUNDER_TWO, {});

    const data = (await db.doc(`families/${created.familyId}`).get()).data()!;
    // Firestore does not store an absent field, so this is the real-database
    // version of the unit test's `'binWeekday' in family === false`.
    expect(Object.prototype.hasOwnProperty.call(data, 'binWeekday')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The rules, judged over the documents the callables actually wrote
// ---------------------------------------------------------------------------

describe('firestore.rules over the produced data', () => {
  const memberDb = () => testEnv.authenticatedContext(KID).firestore();
  const outsiderDb = () => testEnv.authenticatedContext(OUTSIDER).firestore();

  test('a member can read the family document', async () => {
    await assertSucceeds(getDoc(doc(memberDb(), 'families', familyId)));
  });

  test('🔴 a non-member cannot read the family — and CAN read their own', async () => {
    // The pair is the assertion. The first line alone would also pass if the
    // outsider's credentials were broken, if the document did not exist, or
    // if the whole ruleset denied everything.
    await assertFails(getDoc(doc(outsiderDb(), 'families', familyId)));
    await assertSucceeds(getDoc(doc(outsiderDb(), 'families', decoyFamilyId)));
  });

  test('🔴 nobody can LIST families, over a collection that is not empty', async () => {
    // Non-emptiness is load-bearing: `allow list: if false` over an empty
    // collection is indistinguishable from a permitted read of nothing.
    expect((await db.collection('families').get()).size).toBeGreaterThanOrEqual(2);
    await assertFails(getDocs(collection(memberDb(), 'families')));
    await assertFails(getDocs(collection(outsiderDb(), 'families')));
  });

  test('🔴 the emulator THROWS on a denied COLLECTION read — the fake returns empty', async () => {
    // ⚠️ THE ONE ASSERTION THIS WHOLE FILE WAS WRITTEN FOR.
    // `fake_cloud_firestore` never calls `maybeThrowSecurityException` from a
    // collection or query class, so a denied collection read there yields an
    // EMPTY snapshot. No client test can distinguish an empty family from a
    // forbidden one. Here the collection is proven NON-EMPTY first, and the
    // denial is proven to be an ERROR with the code `permission-denied` —
    // never a quiet empty result.
    const membersView = await getDocs(collection(memberDb(), 'families', familyId, 'messages'));
    expect(membersView.size).toBe(1);

    let code: string | null = null;
    try {
      const snap = await getDocs(
        collection(outsiderDb(), 'families', familyId, 'messages'),
      );
      code = `RESOLVED with ${snap.size} docs`;
    } catch (err) {
      code = (err as {code?: string}).code ?? 'unknown';
    }
    expect(code).toBe('permission-denied');
  });

  test('chores: a member reads them, a non-member is denied on a non-empty collection', async () => {
    const membersView = await getDocs(collection(memberDb(), 'families', familyId, 'chores'));
    expect(membersView.size).toBeGreaterThan(0);
    await assertFails(getDocs(collection(outsiderDb(), 'families', familyId, 'chores')));
    // …and the same read against the family they ARE in succeeds, so the
    // denial is about membership rather than about the subcollection.
    await assertSucceeds(
      getDocs(collection(outsiderDb(), 'families', decoyFamilyId, 'chores')),
    );
  });

  // -------------------------------------------------------------------------
  // Trash day (W2-94), over the completion `completeTrashDay` actually wrote
  // -------------------------------------------------------------------------

  test('🔴 trash day: a NON-MEMBER cannot read another household’s bin day', async () => {
    // Non-emptiness first, from a member, so "denied" and "nothing there"
    // cannot be confused — the same discipline as the messages assertion, and
    // the assertion `fake_cloud_firestore` is structurally unable to make.
    const membersView = await getDocs(
      collection(memberDb(), 'families', familyId, 'trashDay'),
    );
    expect(membersView.size).toBe(1);

    let code: string | null = null;
    try {
      const snap = await getDocs(
        collection(outsiderDb(), 'families', familyId, 'trashDay'),
      );
      code = `RESOLVED with ${snap.size} docs`;
    } catch (err) {
      code = (err as {code?: string}).code ?? 'unknown';
    }
    expect(code).toBe('permission-denied');

    // The single document, not only the query — `allow read` covers get and
    // list, and a rule can be relaxed for one and not the other.
    await assertFails(
      getDoc(doc(outsiderDb(), 'families', familyId, 'trashDay', BIN_DATE_KEY)),
    );
    await assertSucceeds(
      getDoc(doc(memberDb(), 'families', familyId, 'trashDay', BIN_DATE_KEY)),
    );

    // 🔑 THE PAIR. The outsider reads their OWN household's bin day from the
    // same credentials, so the denial above is about membership and not about
    // broken credentials, a missing document, or a ruleset that denies
    // everything.
    await assertSucceeds(
      getDocs(collection(outsiderDb(), 'families', decoyFamilyId, 'trashDay')),
    );
  });

  test('🔴 trash day is deny-write to EVERY client, the member included', async () => {
    const before = (
      await db.doc(`families/${familyId}/trashDay/${BIN_DATE_KEY}`).get()
    ).data() as TrashDayCompletion;

    // ⚠️ THE MEMBER CASE IS THE ONE THAT MATTERS HERE. "A member reads but
    // cannot write" is exactly the split a later edit relaxes quietly, on the
    // reasonable-sounding grounds that a member writing their own completion is
    // harmless. It is not: the point of the feature is that it clears for
    // OTHERS, and a client-written completion skips the roster check, the bin
    // date validation and the first-completer rule all at once.
    await assertFails(
      setDoc(doc(memberDb(), 'families', familyId, 'trashDay', BIN_DATE_KEY), {
        binDateKey: BIN_DATE_KEY,
        completedByUid: KID,
        completedAtMs: 1,
      }),
    );
    // Claiming credit for somebody else's work — the half a family argues about.
    await assertFails(
      updateDoc(doc(memberDb(), 'families', familyId, 'trashDay', BIN_DATE_KEY), {
        completedByUid: OWNER,
      }),
    );
    // Deleting re-arms next week's reminder for the whole household.
    await assertFails(
      deleteDoc(doc(memberDb(), 'families', familyId, 'trashDay', BIN_DATE_KEY)),
    );
    // A member creating a completion for a day nobody has done yet.
    await assertFails(
      setDoc(
        doc(memberDb(), 'families', familyId, 'trashDay', '2026-01-01'),
        {binDateKey: '2026-01-01', completedByUid: KID, completedAtMs: 1},
      ),
    );
    // And the owner, who is not privileged here either.
    await assertFails(
      deleteDoc(
        doc(
          testEnv.authenticatedContext(OWNER).firestore(),
          'families',
          familyId,
          'trashDay',
          BIN_DATE_KEY,
        ),
      ),
    );
    // A non-member writing into our household.
    await assertFails(
      setDoc(doc(outsiderDb(), 'families', familyId, 'trashDay', BIN_DATE_KEY), {
        binDateKey: BIN_DATE_KEY,
        completedByUid: OUTSIDER,
        completedAtMs: 1,
      }),
    );

    // 🔑 THE DOCUMENT IS BYTE-FOR-BYTE WHAT IT WAS, and the collection gained
    // nothing. Six refusals that each left a write behind would still have
    // produced six `assertFails`, because assertFails watches the promise and
    // not the database.
    const after = (
      await db.doc(`families/${familyId}/trashDay/${BIN_DATE_KEY}`).get()
    ).data() as TrashDayCompletion;
    expect(after).toEqual(before);
    expect((await db.collection(`families/${familyId}/trashDay`).get()).size).toBe(1);
  });

  test('🔴 no client may write the roster, including the owner', async () => {
    const ownerDb = testEnv.authenticatedContext(OWNER).firestore();
    await assertFails(
      updateDoc(doc(outsiderDb(), 'families', familyId), {
        memberUids: [OWNER, KID, OUTSIDER],
      }),
    );
    await assertFails(
      updateDoc(doc(ownerDb, 'families', familyId), {memberUids: [OWNER]}),
    );
    const family = (await db.doc(`families/${familyId}`).get()).data() as FamilyDoc;
    expect(family.memberUids).toHaveLength(FAMILY_CAP);
  });

  test('🔴 a member cannot extend their own grant, or re-point their familyId', async () => {
    // `familyProExpiresAt` is the entitlement. A client that could write it
    // would not even need a family to have Pro.
    await assertFails(
      updateDoc(doc(memberDb(), 'users', KID), {
        familyProExpiresAt: new Date('2100-01-01'),
      }),
    );
    await assertFails(
      updateDoc(doc(memberDb(), 'users', KID), {familyId: decoyFamilyId}),
    );
    const kid = (await db.doc(`users/${KID}`).get()).data();
    expect(kid?.familyId).toBe(familyId);
  });

  test('familyInvites are unreadable, so live codes cannot be enumerated', async () => {
    const {code} = await call('mintFamilyInvite', OUTSIDER, {});
    await assertFails(getDoc(doc(outsiderDb(), 'familyInvites', code)));
    await assertFails(getDocs(collection(outsiderDb(), 'familyInvites')));
    await db.doc(`familyInvites/${code}`).delete();
  });
});

// ---------------------------------------------------------------------------
// Teardown (W2-96) — leaveFamily, removeMember, disbandFamily
// ---------------------------------------------------------------------------
//
// #436 covered the family's CONSTRUCTION and #437 added trash day. Its
// TEARDOWN had never been driven against a real database: before this describe
// no test file in the repo so much as NAMED `leaveFamily`, `removeMember` or
// `disbandFamily`. Their planners are unit-tested — against the hand-written
// fake Firestore, which is the surface this whole file exists because it
// cannot be trusted.
//
// 🔴 AND TEARDOWN IS WHERE THE FAKE IS LEAST TRUSTWORTHY, because teardown is
// the only path that DELETES. `applyFamilyDeparture` calls `tx.delete()` on the
// family document, and Firestore DOES NOT CASCADE TO SUBCOLLECTIONS. Every
// chore, message and trash-day record outlives the family it belonged to.
// Whether those orphans are still readable is decided by `familyMemberUids()`,
// which does `get(.../families/$(familyId)).data.get('memberUids', [])` — and
// the `.get('memberUids', [])` fallback handles a MALFORMED family, not a
// MISSING one. With the parent deleted, `get()` returns null and `null.data`
// errors before the fallback is ever reached. That is a different code path,
// and nothing had ever executed it.
//
// 📌 A DEDICATED FAMILY, NOT THE ONE UNDER TEST ABOVE. These tests delete
// things, and the rules describe above depends on `familyId` still existing.
// Building a separate household here makes this block order-independent
// instead of quietly destroying the state its predecessors assert against.

const TD_OWNER = 'e2e-td-owner';
const TD_KID = 'e2e-td-kid';
const TD_KID2 = 'e2e-td-kid2';

describe('the family teardown, driven through the real callables', () => {
  let tdFamilyId = '';
  let tdChoreId = '';

  const tdKidDb = () => testEnv.authenticatedContext(TD_KID).firestore();
  const tdKid2Db = () => testEnv.authenticatedContext(TD_KID2).firestore();
  const strangerDb = () => testEnv.authenticatedContext(OUTSIDER).firestore();

  /** The code AND message, because `permission-denied` maps from TWO refusals. */
  const REFUSAL = FAMILY_DEPARTURE_REFUSALS;

  beforeAll(async () => {
    for (const [uid, name] of [
      [TD_OWNER, 'Teardown Owner'],
      [TD_KID, 'Teardown Kid'],
      [TD_KID2, 'Teardown Kid Two'],
    ]) {
      await admin.auth().createUser({uid, displayName: name});
    }
    await seedSubscriber(TD_OWNER, FAMILY_PRODUCT_ID);
    await db.doc(`users/${TD_KID}`).set({avatarUrl: 'avatar-of-td-kid'});
    await db.doc(`users/${TD_KID2}`).set({avatarUrl: 'avatar-of-td-kid2'});

    // THREE members on purpose: one leaves, and somebody other than the owner
    // must remain to read with afterwards. A two-person family would make
    // "the ex-member is denied" and "only the owner can read" the same
    // observation.
    tdFamilyId = await buildFamily(TD_OWNER, TD_KID);
    const {code} = await call('mintFamilyInvite', TD_OWNER, {});
    await call('joinFamily', TD_KID2, {code});

    const chore = await call('assignFamilyChore', TD_OWNER, {
      familyId: tdFamilyId,
      uid: TD_KID,
      taskId: CHORE_TASK_ID,
      dueAtMs: Date.now() + 86_400_000,
    });
    tdChoreId = chore.choreId;
    await call('completeFamilyChore', TD_KID, {familyId: tdFamilyId, choreId: tdChoreId});
    await call('postFamilyMessage', TD_KID, {
      familyId: tdFamilyId,
      text: 'a message that will outlive the family it was posted to',
    });
    await call('completeTrashDay', TD_KID, {familyId: tdFamilyId, binDateKey: BIN_DATE_KEY});
  }, 120_000);

  // -------------------------------------------------------------------------
  // Authority — asserted BEFORE anybody leaves, while the roster is full
  // -------------------------------------------------------------------------

  test('🔴 a plain member cannot remove ANOTHER member — that is the owner’s power', async () => {
    // ⚠️ THE REASON `removeMember` IS A SEPARATE CALLABLE FROM `leaveFamily`.
    // Leaving is authorised by BEING the person; removing is authorised by
    // OWNING the family. One callable with an optional uid would put both
    // behind a defaulted argument, and a bug in that default is exactly the bug
    // that lets one child evict another.
    expect(
      await refusalOf(call('removeMember', TD_KID, {familyId: tdFamilyId, uid: TD_KID2})),
    ).toEqual({
      code: REFUSAL['not-authorised'].code,
      message: REFUSAL['not-authorised'].message,
    });
    // The roster is untouched — a refusal that still wrote would look identical
    // from the promise alone.
    const family = (await db.doc(`families/${tdFamilyId}`).get()).data() as FamilyDoc;
    expect(family.memberUids).toEqual([TD_OWNER, TD_KID, TD_KID2]);
  });

  test('a stranger cannot remove a member of a family they are not in', async () => {
    expect(
      await refusalCodeOf(call('removeMember', OUTSIDER, {familyId: tdFamilyId, uid: TD_KID})),
    ).toBe(REFUSAL['not-authorised'].code);
    const family = (await db.doc(`families/${tdFamilyId}`).get()).data() as FamilyDoc;
    expect(family.memberUids).toHaveLength(3);
  });

  test('🔴 the OWNER cannot leave — the refusal names the alternative', async () => {
    // `owner-must-disband`. An owner who could leave would strand the members
    // whose entitlement is copied from their subscription: a family with a
    // grant and nobody funding it.
    expect(await refusalOf(call('leaveFamily', TD_OWNER, {familyId: tdFamilyId}))).toEqual({
      code: REFUSAL['owner-must-disband'].code,
      message: REFUSAL['owner-must-disband'].message,
    });
    const family = (await db.doc(`families/${tdFamilyId}`).get()).data() as FamilyDoc;
    expect(family.ownerUid).toBe(TD_OWNER);
    expect(family.memberUids).toContain(TD_OWNER);
  });

  test('the owner cannot route around it by removing THEMSELVES', async () => {
    // Same refusal through the other door — `planFamilyDeparture` checks the
    // target, not the caller, so `removeMember(self)` is not a loophole.
    expect(
      await refusalCodeOf(call('removeMember', TD_OWNER, {familyId: tdFamilyId, uid: TD_OWNER})),
    ).toBe(REFUSAL['owner-must-disband'].code);
    expect((await db.doc(`families/${tdFamilyId}`).get()).exists).toBe(true);
  });

  // -------------------------------------------------------------------------
  // leaveFamily — the roster, and the grant
  // -------------------------------------------------------------------------

  test('leaveFamily prunes the roster AND the name and avatar maps', async () => {
    const res = await call('leaveFamily', TD_KID, {familyId: tdFamilyId});
    expect(res.noop).toBe(false);

    const family = (await db.doc(`families/${tdFamilyId}`).get()).data() as FamilyDoc;
    expect(family.memberUids).toEqual([TD_OWNER, TD_KID2]);

    // 🔑 THE MAPS, NOT ONLY THE ARRAY. A departed member's name and avatar
    // lingering on the family document stay readable by everyone still in it —
    // a small leak about somebody who left, and stale by definition. The
    // planner prunes them deliberately, so the pruning is asserted deliberately.
    expect(family.memberNames).toEqual({
      [TD_OWNER]: 'Teardown Owner',
      [TD_KID2]: 'Teardown Kid Two',
    });
    expect(Object.keys(family.memberAvatars ?? {})).toEqual([TD_OWNER, TD_KID2]);
  });

  test('🔴 the grant is REVOKED in the real database — both fields, and the classifier agrees', async () => {
    const kid = (await db.doc(`users/${TD_KID}`).get()).data();

    // Both fields, because clearing one without the other leaves either a grant
    // nobody funds or a pointer at a family that no longer holds them. This is
    // a `set(..., {merge: true})` carrying explicit nulls — precisely the write
    // a hand-written fake merges however it was written to merge, which is why
    // it is asserted here against a real Firestore rather than in the unit suite.
    expect(kid?.familyProExpiresAt).toBeNull();
    expect(kid?.familyId).toBeNull();

    // 🔑 THROUGH THE REAL CLASSIFIER OVER THE REAL STORED DOCUMENT. Without the
    // revoke the leaver keeps a copied expiry worth up to a full billing
    // period, and `resolveEffectiveTier` is the function that decides whether
    // that is true — so it is asked, rather than the field being eyeballed.
    expect(resolveEffectiveTier(kid, Date.now())).toBe('free');

    // The control: a member who did NOT leave still has the grant, from the
    // same read at the same moment. Without this pair, `free` would also be the
    // answer for a fan-out that had revoked everybody.
    const stayed = (await db.doc(`users/${TD_KID2}`).get()).data();
    expect(resolveEffectiveTier(stayed, Date.now())).toBe('pro');
    expect(stayed?.familyId).toBe(tdFamilyId);
  });

  test('leaving twice succeeds and writes NOTHING', async () => {
    const before = (await db.doc(`families/${tdFamilyId}`).get()).data() as FamilyDoc;

    const res = await call('leaveFamily', TD_KID, {familyId: tdFamilyId});
    // Idempotent by design: the caller asked for an end state that already
    // holds, and an error here would tell them their first attempt failed.
    expect(res.noop).toBe(true);

    // 🔑 THE STORED DOCUMENT, BYTE FOR BYTE. A second departure that re-wrote
    // the roster with the same values would return `noop: true` and still be a
    // write — and on a document whose maps were just pruned, a re-write is how
    // a pruned name comes back.
    const after = (await db.doc(`families/${tdFamilyId}`).get()).data() as FamilyDoc;
    expect(after).toEqual(before);
  });

  test('🔴 the EX-MEMBER is locked out — and the collections are provably non-empty', async () => {
    // Every denial below is paired with the SAME read succeeding for a member
    // who stayed, on the same collection at the same moment. That pair is what
    // isolates "this person left" as the cause, rather than an empty
    // collection, broken credentials, or a ruleset that denies everything.
    for (const sub of ['chores', 'messages', 'trashDay'] as const) {
      const stillIn = await getDocs(collection(tdKid2Db(), 'families', tdFamilyId, sub));
      expect(stillIn.size).toBeGreaterThan(0);

      // ⚠️ ASSERTED AS A REJECTION, NEVER AS AN EMPTY RESULT — the assertion
      // `fake_cloud_firestore` is structurally unable to make, and the reason
      // no client test could ever have caught this.
      let code: string | null = null;
      try {
        const snap = await getDocs(collection(tdKidDb(), 'families', tdFamilyId, sub));
        code = `RESOLVED with ${snap.size} docs`;
      } catch (err) {
        code = (err as {code?: string}).code ?? 'unknown';
      }
      expect(code).toBe('permission-denied');
    }

    // The family document itself, and the single-document read separately from
    // the query: `allow read` covers get and list, and a rule can be relaxed
    // for one and not the other.
    await assertFails(getDoc(doc(tdKidDb(), 'families', tdFamilyId)));
    await assertSucceeds(getDoc(doc(tdKid2Db(), 'families', tdFamilyId)));
    await assertFails(
      getDoc(doc(tdKidDb(), 'families', tdFamilyId, 'trashDay', BIN_DATE_KEY)),
    );
    await assertSucceeds(
      getDoc(doc(tdKid2Db(), 'families', tdFamilyId, 'trashDay', BIN_DATE_KEY)),
    );
  });

  // -------------------------------------------------------------------------
  // disbandFamily — and what it leaves behind
  // -------------------------------------------------------------------------

  test('a non-owner cannot disband, and the family survives the refusal', async () => {
    expect(await refusalOf(call('disbandFamily', TD_KID2, {familyId: tdFamilyId}))).toEqual({
      code: REFUSAL['not-the-owner'].code,
      message: REFUSAL['not-the-owner'].message,
    });
    expect(await refusalCodeOf(call('disbandFamily', OUTSIDER, {familyId: tdFamilyId}))).toBe(
      REFUSAL['not-the-owner'].code,
    );
    expect((await db.doc(`families/${tdFamilyId}`).get()).exists).toBe(true);
  });

  test('🔴 disbandFamily deletes the family and revokes EVERY member, the owner included', async () => {
    // Read the pre-state through the classifier, so the assertions afterwards
    // are a change and not a coincidence.
    const ownerBefore = (await db.doc(`users/${TD_OWNER}`).get()).data();
    expect(resolveEffectiveTier(ownerBefore, Date.now())).toBe('pro');

    const res = await call('disbandFamily', TD_OWNER, {familyId: tdFamilyId});
    expect(res.disbanded).toBe(true);
    expect(res.revokedUids).toEqual(expect.arrayContaining([TD_OWNER, TD_KID2]));

    expect((await db.doc(`families/${tdFamilyId}`).get()).exists).toBe(false);

    for (const uid of [TD_OWNER, TD_KID2]) {
      const u = (await db.doc(`users/${uid}`).get()).data();
      expect(u?.familyProExpiresAt).toBeNull();
      expect(u?.familyId).toBeNull();
    }

    // 🔴 THE OWNER'S SUBSCRIPTION IS UNTOUCHED, AND THIS IS THE ONE PROPERTY
    // WHOSE FAILURE IS A DOWNGRADE FOR SOMEBODY WHO PAID. They keep what they
    // pay for; what ends is the family grant DERIVED from it. Leaving the grant
    // in place instead would make `resolveEffectiveTier` answer `pro` from a
    // family that no longer exists — so both directions are asserted.
    const ownerAfter = (await db.doc(`users/${TD_OWNER}`).get()).data();
    expect(ownerAfter?.subscriptionTier).toBe('pro');
    expect(ownerAfter?.subscriptionProductId).toBe(FAMILY_PRODUCT_ID);
    expect(
      (ownerAfter?.subscriptionExpiresAt as admin.firestore.Timestamp).toMillis(),
    ).toBe(OWNER_EXPIRY_MS);
    expect(resolveOwnPaidTier(ownerAfter, Date.now())).toBe('pro');

    // The ex-member, who was never paying, keeps nothing.
    const kid2After = (await db.doc(`users/${TD_KID2}`).get()).data();
    expect(resolveEffectiveTier(kid2After, Date.now())).toBe('free');
  });

  test('🔴 THE ORPHANS OUTLIVE THE FAMILY — and are unreadable by anyone', async () => {
    // ⚠️ FIRESTORE DOES NOT CASCADE. `tx.delete(familyRef)` removes one
    // document; the chore, the message and the bin-day record underneath it are
    // still there. Proven FIRST, because a denial over a collection that had
    // been emptied would prove nothing at all — this test needs a subject.
    const surviving: Record<string, number> = {};
    for (const sub of ['chores', 'messages', 'trashDay'] as const) {
      surviving[sub] = (await db.collection(`families/${tdFamilyId}/${sub}`).get()).size;
    }
    expect(surviving).toEqual({chores: 1, messages: 1, trashDay: 1});
    expect(
      (await db.doc(`families/${tdFamilyId}/chores/${tdChoreId}`).get()).exists,
    ).toBe(true);

    // 🔴 THE QUESTION NOTHING HAD EVER ASKED. Read access to these documents is
    // decided by `familyMemberUids()`, which does
    // `get(.../families/$(familyId)).data.get('memberUids', [])`. The
    // `.get(..., [])` fallback is documented as making a MALFORMED family deny
    // rather than error — but the parent here is MISSING, not malformed, so
    // `get()` returns null and `null.data` errors before the fallback is
    // reached. A rules expression that errors denies, which is the right answer
    // arrived at by a path no test had executed. If it ever fails open instead,
    // every disbanded family's message board — a board children post to —
    // becomes world-readable.
    for (const reader of [tdKid2Db(), strangerDb()]) {
      for (const sub of ['chores', 'messages', 'trashDay'] as const) {
        let code: string | null = null;
        try {
          const snap = await getDocs(collection(reader, 'families', tdFamilyId, sub));
          code = `RESOLVED with ${snap.size} docs`;
        } catch (err) {
          code = (err as {code?: string}).code ?? 'unknown';
        }
        expect(code).toBe('permission-denied');
      }
      await assertFails(getDoc(doc(reader, 'families', tdFamilyId)));
      await assertFails(
        getDoc(doc(reader, 'families', tdFamilyId, 'trashDay', BIN_DATE_KEY)),
      );
      await assertFails(
        getDoc(doc(reader, 'families', tdFamilyId, 'chores', tdChoreId)),
      );
    }

    // 🔑 THE WITHIN-SUBJECT CONTROL, and it is the strongest one available
    // here. TD_KID2 read every one of those collections successfully while the
    // family existed (the lock-out test above). The credentials, the ruleset,
    // the collection paths and the documents are all unchanged — the ONLY thing
    // that changed is that the parent was deleted. And a stranger reading their
    // OWN intact family from the same credentials still succeeds, so the
    // ruleset has not simply stopped permitting reads.
    await assertSucceeds(
      getDocs(collection(strangerDb(), 'families', decoyFamilyId, 'messages')),
    );
    await assertSucceeds(getDoc(doc(strangerDb(), 'families', decoyFamilyId)));
  });

  test('disbanding an already-disbanded family is a no-op, not an error', async () => {
    const res = await call('disbandFamily', TD_OWNER, {familyId: tdFamilyId});
    expect(res.noop).toBe(true);
    expect(res.revokedUids).toEqual([]);
    // Still gone, and the orphans were not disturbed by the second call.
    expect((await db.doc(`families/${tdFamilyId}`).get()).exists).toBe(false);
    expect((await db.collection(`families/${tdFamilyId}/messages`).get()).size).toBe(1);
  });

  test('leaving a family that no longer exists succeeds, and grants nothing back', async () => {
    const res = await call('leaveFamily', TD_KID2, {familyId: tdFamilyId});
    expect(res.noop).toBe(true);
    const u = (await db.doc(`users/${TD_KID2}`).get()).data();
    expect(u?.familyProExpiresAt).toBeNull();
    expect(resolveEffectiveTier(u, Date.now())).toBe('free');
  });

  test('the owner can start again after disbanding — the block was the family, not them', async () => {
    // 🔑 THE END-TO-END PROOF THAT THE REVOKE WAS CLEAN. `createFamily` refuses
    // anyone already in a family, and it reads `resolveOwnPaidTier`. If either
    // `familyId` or the grant had been left behind, this call would fail — so
    // this single assertion covers the teardown's whole job from the other side.
    const res = await call('createFamily', TD_OWNER, {});
    expect(typeof res.familyId).toBe('string');
    expect(res.familyId).not.toBe(tdFamilyId);
    const fresh = (await db.doc(`families/${res.familyId}`).get()).data() as FamilyDoc;
    expect(fresh.memberUids).toEqual([TD_OWNER]);
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE CONTROL — do those denials come from the rules under test?
// ---------------------------------------------------------------------------
//
// Every `assertFails` above is satisfied by a great many wrong worlds: a
// ruleset that failed to parse, credentials that authenticate nobody, a
// document that is not there. The only way to attribute a denial to a CLAUSE is
// to remove the clause and watch the denial disappear.
//
// A separate project id, because loading a second ruleset into the same one
// would overwrite the ruleset the tests above depend on.

describe('CONTROL: the denials are produced by the membership clauses', () => {
  let mutantEnv: RulesTestEnvironment;
  const MUTANT_FAMILY = 'mutant-family';

  const REAL_GET =
    "allow get: if isAuthenticated()\n                 && resource.data.get('memberUids', []).hasAny([request.auth.uid]);";
  const REAL_MESSAGES_READ = 'match /messages/{messageId} {\n        allow read: if isFamilyMember(familyId);';
  // ⚠️ THE `match` LINE IS PART OF THE ANCHOR AND HAS TO BE. `allow read: if
  // isFamilyMember(familyId);\n        allow write: if false;` appears
  // IDENTICALLY in the trashDay, chores and messages blocks, so an anchor
  // without it would edit whichever came first and the control would be about
  // the wrong collection while passing.
  const REAL_TRASHDAY_READ =
    'match /trashDay/{binDateKey} {\n        allow read: if isFamilyMember(familyId);';
  const REAL_TRASHDAY_WRITE =
    'match /trashDay/{binDateKey} {\n        allow read: if isFamilyMember(familyId);\n        allow write: if false;';
  const REAL_CHORES_READ =
    'match /chores/{choreId} {\n        allow read: if isFamilyMember(familyId);';

  /** An ORPHAN: a subcollection whose parent family document never existed. */
  const MUTANT_ORPHAN = 'mutant-orphan-family';

  beforeAll(async () => {
    const real = readFileSync(RULES_PATH, 'utf8');
    const mutant = real
      .replace(REAL_GET, 'allow get: if isAuthenticated();')
      .replace(
        REAL_MESSAGES_READ,
        'match /messages/{messageId} {\n        allow read: if isAuthenticated();',
      )
      // Both trashDay clauses at once, via the longer anchor: read relaxed to
      // bare authentication, write relaxed from `false` to membership.
      .replace(
        REAL_TRASHDAY_WRITE,
        'match /trashDay/{binDateKey} {\n        allow read: if isAuthenticated();\n        allow write: if isAuthenticated();',
      )
      // 🔴 THE DISCRIMINATOR (W2-96). `size() >= 0` is TRUE for any list and
      // cannot be false — so this clause allows the read if and only if
      // `familyMemberUids()` RETURNS something. Over an orphan whose parent
      // does not exist, that distinguishes the two mechanisms which produce an
      // identical denial under the real ruleset:
      //   · if `get()` returning null makes `.data` ERROR, this DENIES;
      //   · if `.get('memberUids', [])` gracefully yields `[]`, this ALLOWS.
      .replace(
        REAL_CHORES_READ,
        'match /chores/{choreId} {\n        allow read: if familyMemberUids(familyId).size() >= 0;',
      );

    // 🔴 A MUTATION THAT DID NOT APPLY IS A CONTROL THAT TESTS NOTHING. Every
    // anchor is whitespace-sensitive, so a reformat of firestore.rules would
    // silently turn this describe into a second copy of the assertions above —
    // passing, and proving nothing. Refuse instead, per anchor, so the error
    // names which one moved.
    for (const [label, anchor] of [
      ['families allow get', REAL_GET],
      ['messages allow read', REAL_MESSAGES_READ],
      ['trashDay allow read', REAL_TRASHDAY_READ],
      ['trashDay allow read+write', REAL_TRASHDAY_WRITE],
      ['chores allow read', REAL_CHORES_READ],
    ] as const) {
      if (!real.includes(anchor)) {
        throw new Error(
          `the rules mutation did not apply — firestore.rules no longer contains the ` +
            `exact text this control edits for "${label}". Re-anchor it; do not delete it.`,
        );
      }
    }
    if (mutant === real) {
      throw new Error('the rules mutation produced an identical file — it edited nothing.');
    }

    mutantEnv = await initializeTestEnvironment({
      projectId: `${PROJECT_ID}-mutant`,
      firestore: {rules: mutant},
    });
    await mutantEnv.clearFirestore();
    await mutantEnv.withSecurityRulesDisabled(async (ctx) => {
      const mdb = ctx.firestore();
      await import('firebase/firestore').then(({setDoc, doc: d}) =>
        Promise.all([
          setDoc(d(mdb, 'families', MUTANT_FAMILY), {
            ownerUid: OWNER,
            memberUids: [OWNER],
            createdAtMs: 0,
          }),
          setDoc(d(mdb, 'families', MUTANT_FAMILY, 'messages', 'm1'), {
            senderUid: OWNER,
            text: 'hi',
            postedAtMs: 0,
          }),
          setDoc(d(mdb, 'families', MUTANT_FAMILY, 'trashDay', BIN_DATE_KEY), {
            binDateKey: BIN_DATE_KEY,
            completedByUid: OWNER,
            completedAtMs: 0,
          }),
          // A chore under a family document that is NEVER created — the same
          // shape `disbandFamily` leaves behind, built directly so the
          // discriminator does not depend on the teardown block having run.
          setDoc(d(mdb, 'families', MUTANT_ORPHAN, 'chores', 'c1'), {
            uid: OWNER,
            taskId: CHORE_TASK_ID,
            assignedAtMs: 0,
          }),
          // The same document under a family that DOES exist, as the paired
          // control for the discriminator below.
          setDoc(d(mdb, 'families', MUTANT_FAMILY, 'chores', 'c1'), {
            uid: OWNER,
            taskId: CHORE_TASK_ID,
            assignedAtMs: 0,
          }),
        ]),
      );
    });
  }, 60_000);

  afterAll(async () => {
    await mutantEnv?.cleanup();
  });

  test('with the membership clause removed, a non-member CAN read the family', async () => {
    const outsider = mutantEnv.authenticatedContext(OUTSIDER).firestore();
    await assertSucceeds(getDoc(doc(outsider, 'families', MUTANT_FAMILY)));
  });

  test('with isFamilyMember removed, a non-member CAN read the message board', async () => {
    const outsider = mutantEnv.authenticatedContext(OUTSIDER).firestore();
    const snap = await getDocs(
      collection(outsider, 'families', MUTANT_FAMILY, 'messages'),
    );
    expect(snap.size).toBe(1);
  });

  test('with isFamilyMember removed, a non-member CAN read the bin day', async () => {
    const outsider = mutantEnv.authenticatedContext(OUTSIDER).firestore();
    const snap = await getDocs(
      collection(outsider, 'families', MUTANT_FAMILY, 'trashDay'),
    );
    expect(snap.size).toBe(1);
    await assertSucceeds(
      getDoc(doc(outsider, 'families', MUTANT_FAMILY, 'trashDay', BIN_DATE_KEY)),
    );
  });

  test('🔴 with `allow write: if false` relaxed, a client CAN overwrite the bin day', async () => {
    // ⚠️ WHAT THIS CONTROL DOES AND DOES NOT SHOW, stated rather than implied.
    // The deny-write assertions are PINS, not catches: Firestore default-denies,
    // so DELETING the trashDay block leaves them all passing. What this proves
    // is that they respond to RELAXATION — which is the realistic failure, and
    // the one the brief named: "a member reads but cannot write" is the split a
    // later edit loosens on the reasonable-sounding grounds that a member
    // writing their own completion is harmless.
    const outsider = mutantEnv.authenticatedContext(OUTSIDER).firestore();
    await assertSucceeds(
      updateDoc(doc(outsider, 'families', MUTANT_FAMILY, 'trashDay', BIN_DATE_KEY), {
        completedByUid: OUTSIDER,
      }),
    );
    await assertSucceeds(
      deleteDoc(doc(outsider, 'families', MUTANT_FAMILY, 'trashDay', BIN_DATE_KEY)),
    );
  });

  test('🔴 a MISSING parent ERRORS the rules expression — the [] fallback does not cover an orphan', async () => {
    // ⚠️ THIS IS WHY THE ORPHAN DENIAL IN THE TEARDOWN BLOCK IS NOT LUCK, AND
    // WHY IT IS ALSO NOT THE FALLBACK DOING ITS JOB.
    //
    // Under this mutant, `chores` reads are allowed by
    // `familyMemberUids(familyId).size() >= 0`, which no LIST can fail. So the
    // clause allows exactly when `familyMemberUids()` returns a value at all.
    //
    //   · Over MUTANT_FAMILY (parent exists) it SUCCEEDS — the clause is live,
    //     the seed is readable, and the mutation applied. Without this half the
    //     denial below would also be satisfied by a rule that broke outright.
    //   · Over MUTANT_ORPHAN (parent missing) it DENIES — so `get()` returning
    //     null makes `.data` ERROR, and the expression never reaches
    //     `.get('memberUids', [])`. The documented fallback protects a
    //     MALFORMED family; it does not protect against a MISSING one.
    //
    // 📌 THE CONSEQUENCE, since a fact without one reads as trivia: orphaned
    // chores, messages and bin days are unreachable because a rules ERROR
    // denies — not because the roster came back empty. Anyone "tidying"
    // `.data.get('memberUids', [])` into `.data.memberUids` would keep this
    // property; anyone adding a `get()`-free fast path could lose it, and no
    // existing assertion above would notice.
    const outsider = mutantEnv.authenticatedContext(OUTSIDER).firestore();

    await assertSucceeds(
      getDocs(collection(outsider, 'families', MUTANT_FAMILY, 'chores')),
    );
    await assertFails(
      getDocs(collection(outsider, 'families', MUTANT_ORPHAN, 'chores')),
    );
    await assertFails(
      getDoc(doc(outsider, 'families', MUTANT_ORPHAN, 'chores', 'c1')),
    );

    // The orphan really is there — otherwise the denial is over nothing, and
    // this test would pass against a database that simply never got seeded.
    await mutantEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDocs(
        collection(ctx.firestore(), 'families', MUTANT_ORPHAN, 'chores'),
      );
      expect(snap.size).toBe(1);
    });
  });

  test('an UNAUTHENTICATED reader is still denied, so the mutation is narrow', async () => {
    // Bounds the mutation: it removed the membership test, not authentication.
    // Without this, "the control passes" would be compatible with having
    // replaced the whole ruleset with `allow read: if true`.
    const anon = mutantEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, 'families', MUTANT_FAMILY)));
  });
});

// ---------------------------------------------------------------------------
// The VISIT journey (W2-113) — join, walk through the front door, leave, denied
// ---------------------------------------------------------------------------
//
// 🔴 EVERY PART OF THIS WAS TESTED AND THE JOURNEY HAD NEVER BEEN WALKED.
// `#483` made family membership grant house access — `sharesFamilyWith` at
// firestore.rules:172, reached from `canViewHouse` (:198) and from the
// `publicProfiles` read (:755). Before this describe, the string
// `sharesFamilyWith` did not appear ANYWHERE in this file. Its coverage was:
//
//   · `housemateView.test.ts` — the Dart-facing re-expression, a pure function
//     over arguments the test supplies.
//   · `firestore-rules.test.ts` — the rule itself, over documents THE TEST
//     SEEDED. That suite proves the rule is correct about a roster it wrote by
//     hand; it has never seen a roster `joinFamily` produced.
//
// This file exists precisely for that gap — its own header: "the rules are
// judged against the real output of the real writers". The visit was the one
// piece of the family feature that never got that treatment.
//
// 🔑 AND IT IS LIVE. Brendan deployed the ruleset at 2026-08-18T15:38:24Z
// (`check-rules-deployed.cjs` exit 0, both digests c8a0c1a6063b5030), so this
// is production behaviour with no end-to-end test behind it.
//
// ---------------------------------------------------------------------------
// 🔴 THE SHAPE IS A BRACKET, NOT A GRANT, AND THAT IS THE ANTI-VACUITY DESIGN
// ---------------------------------------------------------------------------
//
// The tempting version of this test is join → read → succeed. It would be
// worthless. A denial half proves nothing on its own either: a uid who never
// joined is denied for the ordinary reason that they are a stranger, so a
// journey whose fixture silently failed to join would show DENIED before and
// DENIED after and pass every assertion.
//
// So the read is taken THREE times over the same document, and the middle one
// is the only one that can fail for a reason worth knowing:
//
//     BEFORE join   → denied      (the state a broken fixture would leave)
//     AFTER join    → ALLOWED     ← the grant. Breaks if the join did not happen.
//     AFTER leave   → denied      (the revocation)
//
// The `before` denial is what converts the `after` denial from a tautology
// into a transition. See the W2-112 lesson in test-floor.json: for a journey
// test the informative mutation is on the FIXTURE, not the production code.

const JV_OWNER = 'e2e-visit-owner';
const JV_KID = 'e2e-visit-kid';

describe('the family VISIT journey — the door opens, then closes', () => {
  let jvFamilyId = '';

  const kidDb = () => testEnv.authenticatedContext(JV_KID).firestore();

  /** The host's house, as the CLIENT writes it — no callable does. */
  const housePath = () => doc(kidDb(), 'users', JV_OWNER, 'house', 'layout');

  beforeAll(async () => {
    for (const [uid, name] of [
      [JV_OWNER, 'Visit Owner'],
      [JV_KID, 'Visit Kid'],
    ]) {
      await admin.auth().createUser({uid, displayName: name});
    }
    await seedSubscriber(JV_OWNER, FAMILY_PRODUCT_ID);
    await db.doc(`users/${JV_KID}`).set({avatarUrl: 'avatar-of-visit-kid'});

    // ⚠️ SEEDED WITH THE ADMIN SDK, AND SAYING SO MATTERS. Unlike the family
    // documents below, `users/{uid}/house/layout` is written by the DART
    // CLIENT — no callable produces it — so there is no "real writer" here to
    // judge the rules against. What this journey proves is the READ path over
    // a roster the real callables built; the layout's own shape is out of
    // scope and is asserted by nothing here beyond its existence.
    await db.doc(`users/${JV_OWNER}/house/layout`).set({
      rooms: [{id: 'living', props: ['sofa']}],
      updatedAtMs: Date.now(),
    });
    // The `publicProfiles` read is not decoration either: `getFriendVisit`
    // reads it BEFORE the layout (friends_repository_impl.dart), so a family
    // member refused here never reaches the house the rules would have opened.
    // `syncPublicProfile` is a Firestore trigger and the functions emulator is
    // not running, so this is seeded rather than produced.
    await db.doc(`publicProfiles/${JV_OWNER}`).set({
      displayName: 'Visit Owner',
      isPublic: false,
      avatarUrl: 'avatar-of-visit-owner',
    });
  }, 60_000);

  // -------------------------------------------------------------------------
  // 1. BEFORE — the control that makes everything after it mean something
  // -------------------------------------------------------------------------

  test('🔴 BEFORE joining, the kid is DENIED the host house', async () => {
    // No friend edge, no housemate entry, no family. If this ever passes, the
    // grant tested below is not the family's doing and the whole journey is
    // measuring something else.
    await assertFails(getDoc(housePath()));
  });

  test('🔴 BEFORE joining, the kid is DENIED the host public profile', async () => {
    // `isPublic` is false, so the only disjunct that could open this is the
    // family one. Seeded that way on purpose — a public profile would make
    // this read succeed for a reason with nothing to do with the family.
    await assertFails(getDoc(doc(kidDb(), 'publicProfiles', JV_OWNER)));
  });

  // -------------------------------------------------------------------------
  // 2. THE JOIN — through the real callables, asserted on the DOCUMENT
  // -------------------------------------------------------------------------

  test('the kid joins through createFamily → mintFamilyInvite → joinFamily', async () => {
    jvFamilyId = await buildFamily(JV_OWNER, JV_KID);

    // 🔑 THE ROSTER IS READ BACK, NOT INFERRED FROM THE RETURN VALUE. The
    // rules ask `familyRoster(...).hasAny([uid])` about the STORED document,
    // so a callable that returned success while writing a different roster
    // would break the grant and satisfy any assertion made on its response.
    const fam = (await db.doc(`families/${jvFamilyId}`).get()).data() as FamilyDoc;
    expect(fam.memberUids).toEqual(expect.arrayContaining([JV_OWNER, JV_KID]));

    // Both halves of `sharesFamilyWith` come from real writes: the roster
    // above, and the pointer the joiner carries.
    const kid = (await db.doc(`users/${JV_KID}`).get()).data();
    expect(kid?.familyId).toBe(jvFamilyId);
  }, 30_000);

  // -------------------------------------------------------------------------
  // 3. THE VISIT — the grant, and the only assertion here that can fail for an
  //    interesting reason
  // -------------------------------------------------------------------------

  test('🔴 AFTER joining, the kid MAY read the host house', async () => {
    const snap = await assertSucceeds(getDoc(housePath()));
    // 📌 NOT JUST "the read was allowed". A permitted read of a document that
    // is not there returns a snapshot that does not exist, and the visit that
    // matters is the one that comes back with a house in it.
    expect(snap.exists()).toBe(true);
    expect(snap.data()?.rooms).toHaveLength(1);
  });

  test('🔴 AFTER joining, the kid MAY read the host public profile', async () => {
    await assertSucceeds(getDoc(doc(kidDb(), 'publicProfiles', JV_OWNER)));
  });

  test('🔑 the grant does not leak to a stranger in the same instant', async () => {
    // Bounds it. Without this, "the kid may read" is compatible with the
    // ruleset having opened the house to everybody.
    const stranger = testEnv.authenticatedContext(OUTSIDER).firestore();
    await assertFails(getDoc(doc(stranger, 'users', JV_OWNER, 'house', 'layout')));
  });

  // -------------------------------------------------------------------------
  // 4. THE LEAVE — and the door closing
  // -------------------------------------------------------------------------

  test('leaveFamily prunes the roster and nulls the pointer', async () => {
    await call('leaveFamily', JV_KID, {familyId: jvFamilyId});

    const fam = (await db.doc(`families/${jvFamilyId}`).get()).data() as FamilyDoc;
    expect(fam.memberUids).toEqual([JV_OWNER]);

    // 🔴 BOTH SIDES, because `sharesFamilyWith` asks the roster about BOTH
    // uids specifically so that neither one alone is a grant. Asserting only
    // the roster would leave the stale-pointer case untested from this
    // direction.
    const kid = (await db.doc(`users/${JV_KID}`).get()).data();
    expect(kid?.familyId).toBeNull();
  }, 30_000);

  test('🔴 AFTER leaving, the kid is DENIED the host house again', async () => {
    await assertFails(getDoc(housePath()));
  });

  test('🔴 AFTER leaving, the kid is DENIED the host public profile again', async () => {
    await assertFails(getDoc(doc(kidDb(), 'publicProfiles', JV_OWNER)));
  });

  // -------------------------------------------------------------------------
  // 5. The denials are over something rather than nothing
  // -------------------------------------------------------------------------

  test('🔴 the house was there the whole time — the denials are refusals, not absences', async () => {
    // This file's own header warns that a denied read and an empty one are
    // indistinguishable in the client's fake. They are distinguishable HERE,
    // and this is what proves the two `assertFails` above were refusals of a
    // real document rather than passes over a fixture that never landed or a
    // document `leaveFamily` deleted.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDoc(
        doc(ctx.firestore(), 'users', JV_OWNER, 'house', 'layout'),
      );
      expect(snap.exists()).toBe(true);
      expect(snap.data()?.rooms).toHaveLength(1);
    });
  });
});
