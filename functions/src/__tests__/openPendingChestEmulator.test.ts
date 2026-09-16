/**
 * `openPendingChest`, driven end to end against a REAL Firestore. (W2-124)
 *
 * ---------------------------------------------------------------------------
 * 🔴 WHY THIS FILE EXISTS: A VALUE-MOVING CALLABLE WITH A LIVE CLIENT AND NO
 *    END-TO-END TEST AT ALL
 * ---------------------------------------------------------------------------
 *
 * Measured at `origin/main` 2cb4d07, before this file: `test:e2e` matches
 * `**\/*Emulator.test.ts`, there were FIVE such suites — familyEmulator,
 * iapGrantEmulator, publicProfileTriggerEmulator, renewalNotificationEmulator,
 * taskCompletionEmulator — and grepping all five for
 * `openPendingChest|adminGrant|pendingChests` returned ZERO hits. `#538`
 * shipped the reveal client the same day. So the transaction semantics of the
 * path that moves an item into an inventory were asserted by nothing.
 *
 * The unit suite cannot stand in for this, and familyEmulator's header already
 * says why: `npm test` drives the callables against a HAND-WRITTEN FAKE
 * firestore, and **a fake `runTransaction` cannot re-run on contention.** The
 * replay guard below is precisely a re-run-on-contention behaviour, so it is
 * the one thing the unit suite is structurally incapable of observing.
 *
 * ---------------------------------------------------------------------------
 * 🔑 THE POINT OF THE FILE IS ONE ASSERTION, AND THE BRIEF PREDICTED IT MIGHT
 *    BE VACUOUS
 * ---------------------------------------------------------------------------
 *
 * `index.ts` names its own guard:
 *
 *   > 🔴 THE RE-READ IS THE REPLAY GUARD. Two taps in flight at once both pass
 *   > the pre-flight check above; only one can pass this one.
 *
 * ⚠️ But there is a `chestRef.get()` pre-flight OUTSIDE the transaction that
 * throws `already-exists` on its own. If two calls do not genuinely overlap,
 * the second one fails at THAT check, never reaching the transaction — and the
 * test passes identically with the transactional re-read deleted. That is a
 * known shape in this codebase: a concurrency test that passed under its own
 * mutation because an earlier lock had closed the race window.
 *
 * ✅ SO THE OVERLAP MECHANISM IS PART OF THE TEST, NOT A DETAIL.
 * `--runInBand` serialises jest FILES; it does not serialise promises. Both
 * invocations are started in the SAME TICK and neither is awaited until both
 * are in flight, so call B issues its pre-flight `get()` while call A is still
 * doing its own `get()` → `rollRarity` → `pickChestItem` query — three round
 * trips before A's transaction can commit. Both therefore pass the pre-flight
 * with `openedAt == null`, which is exactly the state the transactional
 * re-read exists to resolve.
 *
 * 🔑 THE MUTATION RESULT IS RECORDED IN THE RETURN BLOCK AND IN THE PR, not
 * inferred here. The gate on this file is not "does it pass" — it is "delete
 * the transactional re-read in index.ts and watch THIS test go red".
 *
 * ---------------------------------------------------------------------------
 * 🔴 WHAT THIS FILE STILL CANNOT PROVE
 * ---------------------------------------------------------------------------
 *
 *   · IT SAYS NOTHING ABOUT PRODUCTION, STRUCTURALLY AND PERMANENTLY. It runs
 *     `index.ts` from this working tree and loads `firestore.rules` from this
 *     working tree. **A green run proves the rules FILE. `check-rules-deployed.cjs`
 *     is the only gate that can speak about production, and this is not a
 *     second one.** Do not restate a deployment STATE here — it rots within
 *     hours; run the check.
 *
 *     🔑 THAT CAVEAT STOPPED BEING PEDANTIC ON THE DAY IT WAS WRITTEN.
 *     2026-08-19: the deploy went through in halves. The functions deployed at
 *     04:43Z and the rules did not, so for six minutes `adminGrant` responded
 *     in production while the rules guarding its output were not running —
 *     and **no gate in this repo can tell those two states apart.** The rules
 *     landed at 04:49:41Z (ruleset `983e7652`, digests matching, verified
 *     `IN SYNC`), which then exposed a second failure the first had been
 *     masking: the chests became readable and still would not open. The two
 *     defects had been hiding each other.
 *   · IT DOES NOT EXERCISE THE CALLABLE TRANSPORT. `.run()` hands the handler a
 *     `CallableRequest` directly: App Check, ID-token verification, CORS and
 *     region are all skipped, so `unauthenticated` is proven only for a null
 *     `auth`.
 *   · IT DOES NOT TOUCH THE DART CLIENT. #538's reveal UI is unproven here.
 *   · THE ODDS ARE NOT TESTED. `rollRarity` is random by design; this file
 *     seeds one item per rarity precisely so the ITEM is deterministic while
 *     the roll is not. Drop-rate correctness is `itemPool`'s unit suite.
 *
 * ---------------------------------------------------------------------------
 * 📌 THE FIXTURE USED TO BE A LIE, AND W2-125 REPAIRED IT — history kept
 * ---------------------------------------------------------------------------
 *
 * When W2-124 wrote this file, `openPendingChest` passed a chest CATEGORY into
 * `pickChestItem`'s SUBJECT parameter, and the only way to get a deterministic
 * item was to seed `items` with `subject: 'furniture'` — a category in the
 * subject field, **which no production writer ever produced.** That fixture
 * manufactured a world in which the defect did not exist, and the file said so
 * in this position rather than letting the suite read as proof the path worked.
 *
 * ✅ IT IS NOW A REAL SUBJECT. `subjectForDay('furniture', …)` resolves to
 * `sofa` (DAILY_SUBJECT_POOLS), which is what `seedShopData` writes and what
 * the mint now freezes, so the seeded rows below are shaped exactly like
 * production rows. The note survives its own fix because the reason the
 * fixture was wrong is the reason the bug existed, and a future reader
 * shortening this to "seed some items" would remove the only account of why
 * these particular values.
 *
 * 🔑 AND THE TWO CHARACTERISATION TESTS THAT ASSERTED THE BROKEN BEHAVIOUR ARE
 * NOW ASSERTIONS OF THE FIXED ONE. They were written to go RED the day it was
 * fixed, and they did exactly that — which is how the fix knew it had landed.
 */
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {doc, getDoc} from 'firebase/firestore';
import {readFileSync} from 'fs';
import {resolve} from 'path';
import * as admin from 'firebase-admin';

import {
  DUPLICATE_REFUNDS,
  DUPLICATE_REFUND_FRACTION,
  CHEST_PRICE,
  RARITIES,
  SEED_ITEMS,
  subjectForDay,
} from '../itemPool';

// Imported for its side effect and BEFORE any `admin.*` call — `index.ts` runs
// `admin.initializeApp()` at module scope. Same ordering note as
// familyEmulator.test.ts, and for the same reason.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const idx = require('../index') as Record<string, {run: (req: unknown) => Promise<any>}>;

const RULES_PATH = resolve(__dirname, '../../../firestore.rules');

/**
 * 🔴 READ FROM THE ENVIRONMENT, NEVER A LITERAL. `emulators:exec` sets it. A
 * different id here would point the rules-test client at a different database,
 * and every `assertFails` would pass against an empty project.
 */
const PROJECT_ID = process.env.GCLOUD_PROJECT;

const PLAYER = 'e2e-chest-player';
const OTHER = 'e2e-chest-other';

/**
 * The chest category under test, and the subject it actually rolls on.
 *
 * 🔑 `furniture` has a SINGLE-ENTRY subject pool (`DAILY_SUBJECT_POOLS`:
 * `furniture: ['sofa']`), so `subjectForDay` returns `sofa` on every date. That
 * makes this fixture stable without pinning a clock — deliberately chosen over
 * `characters`, whose pool is `['character', 'fox_outfit']` and therefore
 * alternates by the parity of the date number. The date-sensitive case is
 * covered explicitly further down instead of being smuggled into every test.
 */
const CATEGORY = 'furniture';
const SUBJECT = subjectForDay(CATEGORY, todayStr());

/** The grant date in the mint's own format — `YYYYMMDD`, per subjectForDay. */
function todayStr(): string {
  return new Date().toISOString().split('T')[0].replace(/-/g, '');
}

let testEnv: RulesTestEnvironment;
let db: admin.firestore.Firestore;

/** Invoke a callable the way firebase-functions itself does for tests. */
function call(name: string, uid: string | null, data: unknown): Promise<any> {
  const fn = idx[name];
  if (!fn || typeof fn.run !== 'function') {
    throw new Error(`index.ts exports no callable named "${name}"`);
  }
  return fn.run({data, auth: uid ? {uid, token: {}} : undefined, rawRequest: {}});
}

/** The HttpsError code a call rejects with, or null if it resolved. */
async function refusalCodeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    return String((err as {code?: unknown}).code ?? '');
  }
}

/**
 * Mint a pending chest the way `adminGrant` mints one.
 *
 * ⚠️ BOTH FROZEN AXES, because a fixture that writes only one of them tests a
 * document shape the mint no longer produces. `dropTable` freezes the rarity
 * odds and `subject` freezes the theme; W2-125 added the second after every
 * chest minted without it turned out to be unopenable.
 */
async function mintChest(uid: string, id: string, over: Record<string, unknown> = {}) {
  const category = (over.category as string) ?? CATEGORY;
  await db.doc(`users/${uid}/pendingChests/${id}`).set({
    category,
    dropTable: 'lean',
    subject: subjectForDay(category, todayStr()),
    grantedAt: admin.firestore.Timestamp.now(),
    grantId: `grant-for-${id}`,
    openedAt: null,
    ...over,
  });
}

async function spongeBalanceOf(uid: string): Promise<number> {
  const snap = await db.doc(`users/${uid}/profile/data`).get();
  return (snap.data()?.spongeBalance as number) ?? 0;
}

async function inventoryIdsOf(uid: string): Promise<string[]> {
  const snap = await db.collection(`users/${uid}/inventory`).get();
  return snap.docs.map((d) => d.id).sort();
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
        'them the Admin SDK would try to reach REAL Firestore, and these tests write freely.',
    );
  }

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {rules: readFileSync(RULES_PATH, 'utf8')},
  });
  await testEnv.clearFirestore();

  db = admin.firestore();

  for (const uid of [PLAYER, OTHER]) {
    await admin.auth().createUser({uid, displayName: uid});
    await db.doc(`users/${uid}`).set({avatarUrl: `avatar-of-${uid}`});
    await db.doc(`users/${uid}/profile/data`).set({spongeBalance: 0});
  }

  // 🔴 THE `items` SEEDING THAT STOOD HERE IS GONE — W2-134 retired the read.
  //
  // It seeded one row per rarity so `pickChestItem` was deterministic in WHICH
  // item it returned while `rollRarity` stayed random, and it seeded both
  // `characters` subjects so the theme assertions below could look the granted
  // id up. Both techniques depended on the collection being read, and it is not:
  // production held ZERO documents (COUNT http 200, and an independent document
  // list http 200 with 0 documents and no further pages, as the owning account),
  // so the Firestore branch had never been taken in production and the three
  // reads were deleted.
  //
  // 🔑 WHAT REPLACES EACH, because neither property was dropped:
  //   • determinism — the assertions no longer name an id at all. They check the
  //     granted id against SEED_ITEMS for the right subject and rarity, which is
  //     the property the pinned id was standing in for.
  //   • the theme lookup — resolved through `seedRowFor` below instead of a
  //     document read. It is UNCONDITIONAL for the same reason the old one was:
  //     an `if (row)` guard is exactly how the first draft of these tests
  //     asserted nothing while passing.
}, 120_000);

/**
 * The bundled row behind a granted id.
 *
 * Throws rather than returning undefined: a miss means the callable granted an
 * id that is in no source at all, which is a louder failure than a skipped
 * assertion — and a skipped assertion is the recorded way these tests once
 * passed while testing nothing.
 */
function seedRowFor(id: string): {id: string; subject: string; rarity: string} {
  const row = SEED_ITEMS.find((i: {id: string}) => i.id === id);
  if (!row) {
    throw new Error(
      `granted id "${id}" is not in SEED_ITEMS. Since W2-134 that is the only ` +
        'source a chest can draw from, so this means the pick came from nowhere.',
    );
  }
  return row;
}

/** Every bundled id on [subject], which is the whole pool a themed chest can roll. */
function bundledIdsFor(subject: string): string[] {
  return SEED_ITEMS.filter((i: {subject: string}) => i.subject === subject).map(
    (i: {id: string}) => i.id,
  );
}

afterAll(async () => {
  await testEnv?.cleanup();
  await Promise.all(admin.apps.map((app) => app?.delete()));
});

// ---------------------------------------------------------------------------
// The happy path, and the documents it actually writes
// ---------------------------------------------------------------------------

describe('openPendingChest — the grant lands as real documents', () => {
  test('🔴 CONTROL — a first open grants an item and stamps the chest', async () => {
    await mintChest(PLAYER, 'chest-happy');

    const res = await call('openPendingChest', PLAYER, {pendingChestId: 'chest-happy'});

    // The RETURN value is what #538's reveal renders, so its shape is asserted
    // rather than assumed: the client reads these keys by name.
    // Was `toBe('e2e-<subject>-<rarity>')` against a seeded row. The id is no
    // longer pinnable, so this asserts what pinning it was PROVING: the grant
    // is a real bundled item, on the chest's subject, at the rolled rarity.
    const row = seedRowFor(res.itemId);
    expect(`${row.subject}/${row.rarity}`).toBe(`${SUBJECT}/${res.rarity}`);
    expect(res.isDuplicate).toBe(false);
    expect(res.refund).toBe(0);
    expect(typeof res.name).toBe('string');
    expect(typeof res.artUrl).toBe('string');

    // 🔑 AND THE DOCUMENTS, WHICH ARE THE PART A RETURN VALUE CANNOT FAKE.
    expect(await inventoryIdsOf(PLAYER)).toEqual([res.itemId]);
    const chest = (await db.doc(`users/${PLAYER}/pendingChests/chest-happy`).get()).data()!;
    expect(chest.openedAt).not.toBeNull();
    // Nothing paid out on a first-time item.
    expect(await spongeBalanceOf(PLAYER)).toBe(0);
  });

  test('a SECOND chest granting an item already owned refunds instead', async () => {
    // Pre-fill the inventory with the ENTIRE bundled pool for this subject, so
    // whatever is rolled is necessarily already held. This used to be three
    // seeded documents; since W2-134 the pool is SEED_ITEMS, which is wider and
    // whose size is not a constant this test should hard-code — it is derived,
    // and the assertion below is derived from the same figure.
    const owned = bundledIdsFor(SUBJECT);
    expect(owned.length).toBeGreaterThan(0); // a subject with no items would make this vacuous
    for (const id of owned) {
      await db.doc(`users/${PLAYER}/inventory/${id}`).set({
        itemId: id,
        ownedAt: admin.firestore.Timestamp.now(),
        equipped: false,
      });
    }
    const before = await spongeBalanceOf(PLAYER);

    await mintChest(PLAYER, 'chest-dupe');
    const res = await call('openPendingChest', PLAYER, {pendingChestId: 'chest-dupe'});

    expect(res.isDuplicate).toBe(true);
    // 🔴 RE-DERIVED IN W2-161, NOT LOOSENED. This asserted
    //
    //     expect(res.refund).toBe(DUPLICATE_REFUNDS[res.rarity]);
    //
    // and the reasoning in its old comment was right for the rule it was
    // written against: assert the table, not a literal, because the rarity is
    // random. What changed is the RULE. The refund is no longer a function of
    // what the chest rolled — it is 75% of what the chest cost, and a granted
    // chest's cost is the list price of the category it was minted as.
    //
    // 🔑 SO THE ASSERTION STILL REFUSES A LITERAL, on the same reasoning, and it
    // is still derived from the constants rather than transcribed: it now keys
    // on the axis that actually determines the payment. If it had been "fixed"
    // by pinning 187 here, it would stop testing the consolation the day a price
    // moves — which is precisely the failure its old comment was guarding against.
    //
    // The rarity is deliberately still read, as a control: the refund must be
    // the SAME whatever the chest rolled, which is the whole content of the
    // re-key. A refund that still varied by rarity would fail this.
    expect(RARITIES).toContain(res.rarity);
    expect(res.refund).toBe(DUPLICATE_REFUNDS[CATEGORY]);
    expect(res.refund).toBe(Math.floor(CHEST_PRICE[CATEGORY] * DUPLICATE_REFUND_FRACTION));
    expect(await spongeBalanceOf(PLAYER)).toBe(before + res.refund);
    // Nothing new entered the inventory — it already held the whole pool.
    expect(await inventoryIdsOf(PLAYER)).toHaveLength(owned.length);
  });

  test('a chest that does not exist is not-found, and an unauthenticated call is refused', async () => {
    expect(await refusalCodeOf(call('openPendingChest', PLAYER, {pendingChestId: 'nope'})))
      .toBe('not-found');
    expect(await refusalCodeOf(call('openPendingChest', null, {pendingChestId: 'nope'})))
      .toBe('unauthenticated');
  });

  test("another player's chest is not-found, because the path is scoped by the CALLER's uid", async () => {
    // 🔑 THIS IS NOT AN AUTHORISATION CHECK AND MUST NOT BE READ AS ONE. The
    // handler builds `users/${request.auth.uid}/pendingChests/${id}`, so a
    // caller cannot even ADDRESS someone else's chest — the refusal is
    // not-found rather than permission-denied. Asserting the CODE is what
    // distinguishes "structurally unreachable" from "reached and denied", and
    // only the first one is true here.
    await mintChest(OTHER, 'chest-of-other');
    expect(
      await refusalCodeOf(call('openPendingChest', PLAYER, {pendingChestId: 'chest-of-other'})),
    ).toBe('not-found');
    // And it is still shut, unopened, for its real owner.
    const stillClosed = (await db.doc(`users/${OTHER}/pendingChests/chest-of-other`).get()).data()!;
    expect(stillClosed.openedAt).toBeNull();
  });

  test('a pendingChestId containing a slash is refused before any read', async () => {
    // A '/' would address a different collection entirely. Same reasoning as
    // the grantId validation in adminGrant.ts.
    expect(
      await refusalCodeOf(call('openPendingChest', PLAYER, {pendingChestId: 'a/b'})),
    ).toBe('invalid-argument');
  });
});

// ---------------------------------------------------------------------------
// 🔴 THE REPLAY GUARD — the assertion this whole file exists for
// ---------------------------------------------------------------------------

describe('🔴 W2-124 the transactional re-read is the replay guard', () => {
  test('two overlapping opens of ONE chest yield exactly one success and one already-exists', async () => {
    await mintChest(OTHER, 'chest-race');
    const balanceBefore = await spongeBalanceOf(OTHER);
    expect(await inventoryIdsOf(OTHER)).toEqual([]);

    // 🔑 THE OVERLAP MECHANISM, STATED AS CODE. Both promises are created in
    // the same tick and NEITHER is awaited until both are in flight. Call B's
    // pre-flight `get()` is therefore issued while call A is still between its
    // own pre-flight and its transaction — A has a `rollRarity` and a
    // `pickChestItem` collection query to get through first. Both see
    // `openedAt == null`, which is the precondition the transactional re-read
    // exists to resolve. `--runInBand` serialises test FILES, not promises.
    const a = call('openPendingChest', OTHER, {pendingChestId: 'chest-race'});
    const b = call('openPendingChest', OTHER, {pendingChestId: 'chest-race'});
    const settled = await Promise.allSettled([a, b]);

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');

    // 🔴 THIS IS THE LINE THE MUTATION MOVES. With the transactional re-read
    // deleted, both calls commit and `fulfilled` is 2.
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(
      String(((rejected[0] as PromiseRejectedResult).reason as {code?: unknown}).code),
    ).toBe('already-exists');

    // ⚠️ AND THE DURABLE STATE, INDEPENDENTLY — because "one promise rejected"
    // and "value was granted once" are different facts, and only the second one
    // is what a player would notice. Exactly one item, and no refund: a second
    // successful open would either add a second item (different rarity rolled)
    // or pay a duplicate consolation (same rarity), and each of those trips a
    // different assertion here.
    expect(await inventoryIdsOf(OTHER)).toHaveLength(1);
    expect(await spongeBalanceOf(OTHER)).toBe(balanceBefore);

    const chest = (await db.doc(`users/${OTHER}/pendingChests/chest-race`).get()).data()!;
    expect(chest.openedAt).not.toBeNull();
  });

  test('a SEQUENTIAL re-open is refused too — by the pre-flight, which is a different guard', async () => {
    // 🔑 NAMED AS A DIFFERENT GUARD ON PURPOSE. This is the case the pre-flight
    // handles, and it is the case the concurrent test above must NOT be
    // measuring. Keeping both, labelled, is what makes it visible when the
    // concurrent one degrades into this one.
    await mintChest(OTHER, 'chest-sequential');
    await call('openPendingChest', OTHER, {pendingChestId: 'chest-sequential'});
    expect(
      await refusalCodeOf(call('openPendingChest', OTHER, {pendingChestId: 'chest-sequential'})),
    ).toBe('already-exists');
  });
});

// ---------------------------------------------------------------------------
// The rules, judged against documents the CALLABLE wrote
// ---------------------------------------------------------------------------
//
// This is the half `test:rules` cannot do: every document it judges was seeded
// by the test itself, so it proves the rules are right about documents the test
// invented. Here the chests were minted and stamped by the real handler.
//
// 🔴 AND IT PROVES THE FILE, NOT PRODUCTION — see the header. Whether the
// deployed ruleset matches this file is `check-rules-deployed.cjs`'s question
// and is deliberately not restated here as a value that would go stale.

describe('the rules over a chest the callable actually wrote', () => {
  test('a player may read their OWN pending chest', async () => {
    const playerDb = testEnv.authenticatedContext(PLAYER).firestore();
    await assertSucceeds(
      getDoc(doc(playerDb, `users/${PLAYER}/pendingChests/chest-happy`)),
    );
  });

  test("🔴 a player may NOT read someone else's pending chest", async () => {
    // The decoy is the chest OTHER owns, which exists and is unopened — so this
    // denial is over a real document rather than over an absence. A test that
    // read a missing path would pass against a ruleset that denied nothing.
    const playerDb = testEnv.authenticatedContext(PLAYER).firestore();
    await assertFails(getDoc(doc(playerDb, `users/${OTHER}/pendingChests/chest-of-other`)));
  });

  test('🔴 MUTATION CONTROL — the same read succeeds under a ruleset without the owner clause', async () => {
    // Without this, the denial above is compatible with the read failing for
    // ANY reason: a typo in the path, an unauthenticated context, a ruleset
    // that denies everything. Same control familyEmulator.test.ts ends on.
    const permissive = await initializeTestEnvironment({
      projectId: `${PROJECT_ID}-permissive`,
      firestore: {
        rules:
          'rules_version = "2";\n' +
          'service cloud.firestore {\n' +
          '  match /databases/{db}/documents {\n' +
          '    match /{document=**} { allow read, write: if true; }\n' +
          '  }\n' +
          '}\n',
      },
    });
    try {
      await permissive.withSecurityRulesDisabled(async (ctx) => {
        await ctx
          .firestore()
          .doc(`users/${OTHER}/pendingChests/chest-of-other`)
          .set({category: CATEGORY, openedAt: null});
      });
      const asPlayer = permissive.authenticatedContext(PLAYER).firestore();
      await assertSucceeds(
        getDoc(doc(asPlayer, `users/${OTHER}/pendingChests/chest-of-other`)),
      );
    } finally {
      await permissive.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// ✅ W2-125 — the finding W2-124 recorded, now asserted as FIXED
// ---------------------------------------------------------------------------
//
// 📌 THIS BLOCK USED TO ASSERT THE DEFECT. W2-124 was a test-only brief and
// wrote two characterisation tests that pinned the broken behaviour — a real
// category threw `not-found` — deliberately built to GO RED the day somebody
// fixed it, so the fixer had to come here and read the note. That is exactly
// what happened, and this is that note being answered rather than deleted.
//
// THE DEFECT, for anyone reading this in a year: `openPendingChest` passed the
// chest CATEGORY into `pickChestItem`, whose first parameter filters `items` on
// SUBJECT. Categories are characters|styles|furniture; subjects are
// sofa|character|roof|wall|lamp|armchair and siblings. Disjoint — `character`
// is not `characters` — so the query matched nothing, the bundled SEED_ITEMS
// fallback matched nothing, and every chest `adminGrant` ever minted threw.
//
// THE FIX: the mint freezes `subject: subjectForDay(category, grantDateStr)`
// beside `dropTable`, and the open reads it. `dropTable` had frozen the rarity
// axis since the mint was written; nobody had ever frozen the subject axis.

describe('✅ W2-125 a chest with a REAL category opens, on its FROZEN subject', () => {
  test('a `characters` chest opens and grants an item from the characters pool', async () => {
    // 🔴 `characters`, NOT `furniture`, ON PURPOSE. It is the only category
    // whose subject pool has more than one entry — `['character', 'fox_outfit']`
    // — so it is the only one where "which day did we resolve this on" is
    // observable at all. `furniture: ['sofa']` and `styles: ['outside_plants']`
    // are single-entry pools and would pass this test even if the date were
    // resolved wrongly, which would make them a control that tests nothing.
    //
    // Since W2-134 there is no other branch: SEED_ITEMS is the only pool
    // `pickChestItem` draws from, for this chest and every other.
    await mintChest(PLAYER, 'chest-characters', {category: 'characters'});

    const res = await call('openPendingChest', PLAYER, {pendingChestId: 'chest-characters'});

    expect(typeof res.itemId).toBe('string');
    expect(['common', 'rare', 'legendary']).toContain(res.rarity);

    // 🔑 THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL BUG, and it is about
    // the THEME rather than about success: the granted item must belong to the
    // subject the chest froze. A chest that opened but paid out a sofa would
    // satisfy every other line here.
    const chest = (await db.doc(`users/${PLAYER}/pendingChests/chest-characters`).get()).data()!;
    // 🔴 STILL UNCONDITIONAL, and now it cannot be otherwise: `seedRowFor`
    // THROWS on a miss rather than returning undefined. The document lookup it
    // replaces could be guarded into silence, which is how the first draft of
    // this test asserted nothing at all while passing.
    expect(seedRowFor(res.itemId).subject).toBe(chest.subject);
    expect(chest.openedAt).not.toBeNull();
  });

  test('🔴 the frozen subject is the one the MINT resolved, not the one today resolves', async () => {
    // The freeze only means something if the open path reads the document
    // instead of re-deriving. So the chest is minted with a subject that is
    // VALID but is NOT what `subjectForDay` would return for this category
    // today — the other entry in the pool. If the open re-derived, it would
    // roll on today's subject and this would fail.
    const today = subjectForDay('characters', todayStr());
    const other = today === 'character' ? 'fox_outfit' : 'character';
    await mintChest(PLAYER, 'chest-frozen-other', {category: 'characters', subject: other});

    const res = await call('openPendingChest', PLAYER, {pendingChestId: 'chest-frozen-other'});

    const grantedSubject = seedRowFor(res.itemId).subject;
    expect(grantedSubject).toBe(other);
    expect(grantedSubject).not.toBe(today);
  });

  test('🔴 a chest with NO subject is REFUSED rather than rolled on any subject', async () => {
    // ⚠️ THE FAILURE HERE IS INVERTED AND THAT IS THE WHOLE REASON THIS TEST
    // EXISTS. `pickChestItem` treats an empty subject as "any subject" by
    // skipping the `where`, so the obvious fallback — `chest.subject ?? ''` —
    // would make a legacy chest OPEN SUCCESSFULLY while ignoring its category
    // entirely: a furniture chest paying out a character, with no error to
    // surface it. A refusal is visible; a wrong prize is not.
    //
    // 📌 WHETHER ANY SUCH CHEST EXISTS IN PRODUCTION IS AN OPEN QUESTION AT THE
    // TIME OF WRITING — it needs a collection-group count that no credential
    // available to this window can perform, and it was escalated rather than
    // guessed. If the answer is non-zero, the intended remedy is to derive the
    // missing subject from the chest's own `grantedAt` (which the mint has
    // always written), reconstructing the frozen answer from the document
    // rather than approximating it from today. This test then becomes the
    // negative control for that path instead of the whole story.
    await db.doc(`users/${PLAYER}/pendingChests/chest-legacy`).set({
      category: 'furniture',
      dropTable: 'lean',
      grantedAt: admin.firestore.Timestamp.now(),
      grantId: 'grant-legacy',
      openedAt: null,
    });

    expect(
      await refusalCodeOf(call('openPendingChest', PLAYER, {pendingChestId: 'chest-legacy'})),
    ).toBe('failed-precondition');

    // 🔑 AND IT IS NOT CONSUMED. The refusal precedes the transaction, so the
    // chest opens the moment a subject can be resolved for it — which is what
    // makes the strict branch safe to ship ahead of that decision.
    const after = (await db.doc(`users/${PLAYER}/pendingChests/chest-legacy`).get()).data()!;
    expect(after.openedAt).toBeNull();
  });
});
