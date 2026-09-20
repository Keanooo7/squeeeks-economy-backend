/**
 * `adminGrant`, driven end to end against a REAL Firestore. (W2-124)
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: WHY THIS FILE EXISTS: THE HANDLER HAD NEVER BEEN RUN BY ANYTHING
 * ---------------------------------------------------------------------------
 *
 * `adminGrant.test.ts` exists and is a good suite — but it tests
 * `planAdminGrant`, the PURE PLANNER. It does not match `*Emulator.test.ts`, so
 * it never runs under the emulator, and **it never invokes the handler at all.**
 * Everything between the plan and the documents — the two 403s, the dry-run
 * default, the transaction, the idempotency ledger, the minted chests — was
 * asserted by nothing. Measured at `origin/main` 2cb4d07: grepping all five
 * pre-existing emulator suites for `adminGrant|pendingChests` returned ZERO.
 *
 * That gap matters more than usual for this endpoint, because it is the one
 * path in the codebase where **a retried curl could become a second thousand
 * sponges.** `index.ts` names the guard itself — *"the ledger document is
 * created INSIDE the transaction, so a retry or a concurrent call returns the
 * ORIGINAL grant rather than applying a second one"* — and a fake
 * `runTransaction` in the unit suite cannot re-run on contention, so that
 * sentence was untestable where it was written.
 *
 * ---------------------------------------------------------------------------
 * KEY: `onRequest`, NOT `onCall` — AND IT CHANGES HOW THIS IS DRIVEN
 * ---------------------------------------------------------------------------
 *
 * Every other emulator suite here reaches its callable through
 * firebase-functions' own `.run()` test hook, which takes a `CallableRequest`.
 * `adminGrant` is an `onRequest`, so there is no `.run()`: the export IS the
 * Express handler and it is invoked as `fn(req, res)`. This file therefore
 * carries a small req/res double, and the ASSERTIONS MOVE WITH IT — an
 * `HttpsError` code becomes an HTTP status plus a body, so the refusals are
 * checked as `{status, body.refusal}` rather than as a thrown code.
 *
 * WARNING: THE DOUBLE IS AN INSTRUMENT, SO IT IS KEPT AS THIN AS POSSIBLE: it records
 * `status`, `json` and `send` and does nothing else. Anything it smoothed over
 * would be a behaviour this suite claims to prove and does not.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: WHAT THIS FILE CANNOT PROVE
 * ---------------------------------------------------------------------------
 *
 *   · IT IS NOT PRODUCTION, AND NO AMOUNT OF GREEN HERE EVER WILL BE. It runs
 *     `index.ts` and `firestore.rules` from this working tree.
 *     `check-rules-deployed.cjs` and `check-deployed-revision.cjs` are the
 *     gates that ask production; this is not a third one. **A deployment state
 *     written into this comment would be false within hours — run the checks.**
 * WARNING: On 2026-08-19 the deploy split: functions at 04:43Z, rules at 04:49Z.
 *     For those six minutes `adminGrant` was live in production with its rules
 *     path unenforced, and **nothing in this repo could have distinguished
 *     that from the fully-deployed state.** A working callable is not evidence
 *     that the path is guarded.
 *   · IT DOES NOT PROVE THE SECRET IS BOUND ANYWHERE REAL. `SEED_SECRET` is set
 *     into `process.env` by this file. The Gen2 binding trap that `SEED_OPTS`
 *     documents — a deployment where the secret was never bound — is a deploy
 *     property and is invisible from here. That is exactly the failure the
 *     "not bound" 403 message exists for, and this suite can only prove the
 *     MESSAGE, not the condition.
 *   · IT DOES NOT EXERCISE HTTP. No Express, no routing, no CORS, no body
 *     parsing — `req.body` is handed over already parsed, as the emulator would
 *     have parsed it. A malformed JSON body is outside this file.
 */
import {
  assertFails,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {doc, getDoc} from 'firebase/firestore';
import {readFileSync} from 'fs';
import {resolve} from 'path';
import * as admin from 'firebase-admin';

import {ADMIN_GRANT_REFUSALS, catalogueIds} from '../adminGrant';
import {CHEST_CATEGORY_DROP_TABLE, subjectForDay} from '../itemPool';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const idx = require('../index') as Record<string, any>;

const RULES_PATH = resolve(__dirname, '../../../firestore.rules');
const PROJECT_ID = process.env.GCLOUD_PROJECT;

const SECRET = 'e2e-admin-grant-secret';
const RECIPIENT = 'e2e-grant-recipient';

let testEnv: RulesTestEnvironment;
let db: admin.firestore.Firestore;

/** What the handler said: the status, plus whichever body shape it used. */
interface Captured {
  status: number;
  body: any;
  text: string;
}

/**
 * Invoke the `onRequest` handler with a minimal Express double.
 *
 * KEY: `get()` IS CASE-INSENSITIVE HERE ON PURPOSE. Express's own `req.get` is,
 * and the handler reads `req.get('x-seed-secret')`. A case-SENSITIVE double
 * would let a header-casing bug pass this suite and fail in production — the
 * double would be kinder than the thing it stands in for, which is the one
 * property a test double must never have.
 */
function invoke(args: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}): Promise<Captured> {
  const headers = Object.fromEntries(
    Object.entries(args.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const captured: Captured = {status: 0, body: undefined, text: ''};
  const res = {
    status(code: number) {
      captured.status = code;
      return this;
    },
    json(payload: unknown) {
      captured.body = payload;
      return this;
    },
    send(payload: unknown) {
      captured.text = String(payload);
      return this;
    },
  };
  const req = {
    method: args.method ?? 'POST',
    body: args.body ?? {},
    get: (name: string) => headers[name.toLowerCase()],
  };
  return Promise.resolve(idx.adminGrant(req, res)).then(() => captured);
}

/** A well-formed apply request, overridable per test. */
function grantBody(over: Record<string, unknown> = {}) {
  return {uid: RECIPIENT, grantId: 'grant-1', sponges: 100, apply: true, ...over};
}

/** The grant date in the mint's own format — `YYYYMMDD`, per subjectForDay. */
function todayStr(): string {
  return new Date().toISOString().split('T')[0].replace(/-/g, '');
}

async function spongeBalanceOf(uid: string): Promise<number> {
  const snap = await db.doc(`users/${uid}/profile/data`).get();
  return (snap.data()?.spongeBalance as number) ?? 0;
}

beforeAll(async () => {
  if (!PROJECT_ID) {
    throw new Error('GCLOUD_PROJECT is unset — run this through `npm run test:e2e`.');
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are unset — the Admin ' +
        'SDK would try to reach REAL Firestore, and these tests write freely.',
    );
  }

  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {rules: readFileSync(RULES_PATH, 'utf8')},
  });
  await testEnv.clearFirestore();
  db = admin.firestore();

  process.env.SEED_SECRET = SECRET;

  // CRITICAL: clearFirestore() DOES NOT CLEAR AUTH, so this file could not be run
  // twice inside one emulator session: the second beforeAll threw "The user
  // with the provided uid already exists", every test in the file reported as
  // failed, and the suite-level failure looked exactly like a broken test.
  //
  // KEY: THAT IS NOT A COSMETIC FIX — it is what makes this file INVESTIGABLE.
  // W2-136 needed to run the concurrency test in a loop to measure a flake
  // rate, and the first harness reported "19 of 20 failed" when what it had
  // actually measured was this collision. Anyone chasing the same flake would
  // hit the same wall and could easily read it as the race failing.
  await admin.auth().deleteUser(RECIPIENT).catch(() => {
    // Absent on the first run of a fresh emulator, which is the normal case.
  });
  await admin.auth().createUser({uid: RECIPIENT, displayName: 'Grant Recipient'});
  await db.doc(`users/${RECIPIENT}`).set({avatarUrl: 'avatar-of-recipient'});
  await db.doc(`users/${RECIPIENT}/profile/data`).set({spongeBalance: 0});
}, 120_000);

afterAll(async () => {
  await testEnv?.cleanup();
  await Promise.all(admin.apps.map((app) => app?.delete()));
});

// ---------------------------------------------------------------------------
// The door
// ---------------------------------------------------------------------------

describe('adminGrant — the gate, before any planning happens', () => {
  test('GET is 405 — this endpoint is POST-only', async () => {
    const res = await invoke({method: 'GET'});
    expect(res.status).toBe(405);
  });

  test('🔴 the two 403s are DIFFERENT, and the difference is the whole point', async () => {
    // An UNSET secret and a WRONG one are different problems with different
    // fixes — a deployment that never bound it versus a person holding the
    // wrong string. `index.ts` says so and copied the shape from
    // exportGalleryFeedback deliberately. A test asserting only `403` would
    // pass for a handler that collapsed them back into a bare 'Forbidden',
    // which is the regression this assertion exists to catch.
    const saved = process.env.SEED_SECRET;
    delete process.env.SEED_SECRET;
    const unbound = await invoke({headers: {'x-seed-secret': 'anything'}, body: grantBody()});
    process.env.SEED_SECRET = saved;

    const wrong = await invoke({headers: {'x-seed-secret': 'not-the-secret'}, body: grantBody()});

    expect(unbound.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(unbound.text).not.toBe(wrong.text);
    expect(unbound.text).toMatch(/not bound on this deployment/);
    expect(wrong.text).toMatch(/missing or does not match/);
    // Neither message leaks the value — they name the FAILURE.
    expect(unbound.text).not.toContain(SECRET);
    expect(wrong.text).not.toContain(SECRET);
  });

  test('a missing header is refused as "missing or does not match", not as unbound', async () => {
    const res = await invoke({body: grantBody()});
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/missing or does not match/);
  });

  test('🔴 NOTHING WAS WRITTEN BY ANY OF THE ABOVE', async () => {
    // A denial needs a before-state to mean anything. Every refusal so far
    // carried a well-formed 100-sponge grant body, so if the gate leaked, the
    // recipient would be richer.
    expect(await spongeBalanceOf(RECIPIENT)).toBe(0);
    expect((await db.doc('adminGrants/grant-1').get()).exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The planner's refusals, reaching the wire
// ---------------------------------------------------------------------------

describe('adminGrant — a refused plan is a 400 that names itself', () => {
  test('an unknown item id refuses the WHOLE request, and grants nothing', async () => {
    const res = await invoke({
      headers: {'x-seed-secret': SECRET},
      body: grantBody({itemIds: ['no-such-item-anywhere'], sponges: 100}),
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    // KEY: THE REFUSAL KEY, NOT JUST THE STATUS. `planAdminGrant` has several
    // refusals that all surface as 400; asserting only the status cannot tell
    // "your item id is a typo" from "your grantId has a slash in it", so it
    // would pass for the wrong reason exactly when the wrong check fired.
    expect(typeof res.body.refusal).toBe('string');
    expect(res.body.message).toBe(ADMIN_GRANT_REFUSALS[res.body.refusal as never]);
    expect(await spongeBalanceOf(RECIPIENT)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: The dry run — the default, and the reason this endpoint is safe to hold
// ---------------------------------------------------------------------------

describe('🔴 adminGrant — dry run is the DEFAULT and writes nothing', () => {
  test('no `apply` key at all is a dry run', async () => {
    const res = await invoke({
      headers: {'x-seed-secret': SECRET},
      body: {uid: RECIPIENT, grantId: 'grant-dry', sponges: 250},
    });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.wouldGrant.sponges).toBe(250);
    expect(await spongeBalanceOf(RECIPIENT)).toBe(0);
    expect((await db.doc('adminGrants/grant-dry').get()).exists).toBe(false);
  });

  test('🔴 `apply` as the STRING "true" is still a dry run', async () => {
    // The literal boolean is required precisely so a stray quoted value — which
    // is truthy in JavaScript — cannot apply a grant. This is the assertion
    // that makes that decision real rather than a comment.
    const res = await invoke({
      headers: {'x-seed-secret': SECRET},
      body: {uid: RECIPIENT, grantId: 'grant-stringy', sponges: 999, apply: 'true'},
    });
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(await spongeBalanceOf(RECIPIENT)).toBe(0);
    expect((await db.doc('adminGrants/grant-stringy').get()).exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The grant itself, as documents
// ---------------------------------------------------------------------------

describe('adminGrant — apply writes sponges, items, chests and a ledger row', () => {
  test('🔴 CONTROL — a full grant lands every part of itself', async () => {
    const res = await invoke({
      headers: {'x-seed-secret': SECRET},
      body: grantBody({
        grantId: 'grant-full',
        sponges: 100,
        chestCategories: ['furniture', 'characters'],
      }),
    });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.dryRun).toBe(false);
    expect(res.body.alreadyProcessed).toBe(false);

    expect(await spongeBalanceOf(RECIPIENT)).toBe(100);

    const ledger = (await db.doc('adminGrants/grant-full').get()).data()!;
    expect(ledger.uid).toBe(RECIPIENT);
    expect(ledger.granted.sponges).toBe(100);
    expect(ledger.granted.pendingChestIds).toEqual(['grant-full_0', 'grant-full_1']);

    // KEY: THE CHESTS ARE MINTED UNOPENED AND THEIR ODDS ARE FROZEN AT MINT TIME.
    // Asserted against CHEST_CATEGORY_DROP_TABLE rather than re-derived from
    // the live rotation: the rotation may move between grant and open, and the
    // recipient is owed the odds they were granted.
    for (const [i, category] of ['furniture', 'characters'].entries()) {
      const chest = (
        await db.doc(`users/${RECIPIENT}/pendingChests/grant-full_${i}`).get()
      ).data()!;
      expect(chest.category).toBe(category);
      expect(chest.dropTable).toBe(CHEST_CATEGORY_DROP_TABLE[category]);
      expect(chest.openedAt).toBeNull();
      expect(chest.grantId).toBe('grant-full');
    }
  });

  test('🔴 an already-owned item is NOT re-written, so `equipped` survives', async () => {
    // Re-granting an owned item would reset `equipped` and silently un-equip
    // something the player is wearing. The grant still reports success — they
    // own it, which is what was asked — and says so via `alreadyOwned`.
    // KEY: A REAL CATALOGUE ID, NOT AN INVENTED ONE. `planAdminGrant` validates
    // every itemId against CATALOGUE_IDS (the shipped SEED_ITEMS), so an
    // invented id is refused 400 before the handler ever reaches Firestore —
    // this test failed exactly that way on its first run, and an invented id
    // would have made it a test of the validator wearing an inventory costume.
    const owned = catalogueIds()[0];
    await db.doc(`users/${RECIPIENT}/inventory/${owned}`).set({
      itemId: owned,
      ownedAt: admin.firestore.Timestamp.now(),
      equipped: true,
    });

    const res = await invoke({
      headers: {'x-seed-secret': SECRET},
      body: grantBody({grantId: 'grant-owned', sponges: 0, itemIds: [owned]}),
    });

    expect(res.status).toBe(200);
    expect(res.body.granted.alreadyOwned).toEqual([owned]);
    const after = (await db.doc(`users/${RECIPIENT}/inventory/${owned}`).get()).data()!;
    expect(after.equipped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: THE IDEMPOTENCY LOCK — a retried curl must not be a second grant
// ---------------------------------------------------------------------------

describe('🔴 W2-124 the ledger document is the idempotency lock', () => {
  test('replaying the SAME grantId returns the original and does not pay twice', async () => {
    const before = await spongeBalanceOf(RECIPIENT);
    const first = await invoke({
      headers: {'x-seed-secret': SECRET},
      body: grantBody({grantId: 'grant-replay', sponges: 500}),
    });
    expect(first.body.alreadyProcessed).toBe(false);
    expect(await spongeBalanceOf(RECIPIENT)).toBe(before + 500);

    const replay = await invoke({
      headers: {'x-seed-secret': SECRET},
      body: grantBody({grantId: 'grant-replay', sponges: 500}),
    });
    expect(replay.status).toBe(200);
    expect(replay.body.alreadyProcessed).toBe(true);
    // CRITICAL: THE LINE A DELETED LOCK MOVES: without the ledger check the balance
    // would be `before + 1000`.
    expect(await spongeBalanceOf(RECIPIENT)).toBe(before + 500);
    // And the replay returns the ORIGINAL grant rather than a fresh one.
    expect(replay.body.granted.sponges).toBe(500);
  });

  test('🔴 TWO CONCURRENT applies of one grantId pay exactly once', async () => {
    // KEY: THIS IS THE CLEANER RACE OF THE TWO IN W2-124. `openPendingChest` has
    // a pre-flight `get()` outside its transaction that can close the window on
    // its own; `adminGrant` has NO check outside the transaction at all, so the
    // ledger read and the commit are the only serialisation there is. Both
    // promises are started in the same tick and neither is awaited until both
    // are in flight.
    const before = await spongeBalanceOf(RECIPIENT);
    const a = invoke({
      headers: {'x-seed-secret': SECRET},
      body: grantBody({grantId: 'grant-race', sponges: 700}),
    });
    const b = invoke({
      headers: {'x-seed-secret': SECRET},
      body: grantBody({grantId: 'grant-race', sponges: 700}),
    });
    const [ra, rb] = await Promise.all([a, b]);

    // CRITICAL: THE FAILURE MUST NAME ITSELF. This test went red once on an integrated
    // tip and green on two immediate re-runs of the identical tree, and the only
    // thing recorded was the test's NAME — which was not enough to classify it.
    // W2-136 then failed to reproduce it in 24 consecutive runs, so the one red
    // this project has ever seen is also the only evidence, and it said nothing.
    //
    // KEY: So every assertion below carries the whole observation. A recurrence
    // now records WHICH of the three ways it failed:
    //   both false          -> the lock did not fire: a real double-pay
    //   both true           -> neither applied: the grant silently did nothing
    //   a non-200 status    -> the transaction gave up rather than raced
    // WARNING: This is diagnostics, NOT a retry, a sleep or a longer timeout. Those
    // would each turn the symptom green and hide the double-pay case entirely.
    const after = await spongeBalanceOf(RECIPIENT);
    const observed =
      `statuses=[${ra.status},${rb.status}] ` +
      `alreadyProcessed=[${ra.body.alreadyProcessed},${rb.body.alreadyProcessed}] ` +
      `balance ${before}->${after} (delta ${after - before}, expected 700)`;

    expect(`${observed} | statuses both 200: ${ra.status === 200 && rb.status === 200}`).toBe(
      `${observed} | statuses both 200: true`,
    );
    // Exactly one of them did the work; which one is a race and is not asserted.
    expect(
      `${observed} | exactly one applied: ${JSON.stringify(
        [ra.body.alreadyProcessed, rb.body.alreadyProcessed].sort(),
      )}`,
    ).toBe(`${observed} | exactly one applied: [false,true]`);
    // CRITICAL: 700 ONCE, NOT 1400. This is the sentence the endpoint exists to make true.
    expect(`${observed} | delta: ${after - before}`).toBe(`${observed} | delta: 700`);
  });
});

// ---------------------------------------------------------------------------
// The handoff — the chain nothing had ever walked
// ---------------------------------------------------------------------------

describe('✅ W2-125 a granted chest opens, end to end — the finding, now fixed', () => {
  test('adminGrant mints a frozen subject and openPendingChest rolls on it', async () => {
    // -----------------------------------------------------------------------
    // NOTE: THIS TEST USED TO ASSERT A DEFECT. It is kept, rewritten, rather than
    // replaced, because the account of WHY it existed is the most useful thing
    // in this file.
    // -----------------------------------------------------------------------
    //
    // W2-124 was a test-only brief: find a defect, stop and report. It found
    // that `openPendingChest` passed a chest CATEGORY into `pickChestItem`,
    // whose first parameter filters `items` on SUBJECT —
    //
    //   index.ts   pickChestItem(chestSubject, itemRarity)            ← shop
    //   index.ts   pickChestItem(subjectForDay(category, …), rarity)  ← quests
    //   index.ts   pickChestItem((chest.category as string) ?? '', …) ← HERE
    //
    // — and that categories (characters|styles|furniture) and subjects
    // (sofa|character|roof|wall|lamp|armchair …) are disjoint sets, with
    // `character` not being `characters`. So the query matched nothing, the
    // bundled SEED_ITEMS fallback matched nothing, and EVERY chest adminGrant
    // had ever minted threw `not-found` on open. `adminGrant` was deployed at
    // that point and #538 had shipped the reveal client the same day.
    //
    // The characterisation test was written to GO RED the day it was fixed, so
    // whoever fixed it had to come and read this. W2-125 is that fix: Brendan
    // chose to freeze the subject at mint, which is not a new concept but the
    // grant path finally writing the field the SHOP path has always written
    // beside `dropTable`. `dropTable` froze the rarity axis; nobody had ever
    // frozen the subject axis.
    const granted = await invoke({
      headers: {'x-seed-secret': SECRET},
      body: grantBody({grantId: 'grant-chain', sponges: 0, chestCategories: ['furniture']}),
    });
    const chestId = granted.body.granted.pendingChestIds[0];
    expect(chestId).toBe('grant-chain_0');

    // KEY: THE MINT NOW WRITES BOTH FROZEN AXES. Asserted against `subjectForDay`
    // rather than a literal: a literal would pass today and rot the moment
    // DAILY_SUBJECT_POOLS changes, which is exactly the class of bug this whole
    // episode came from.
    const minted = (await db.doc(`users/${RECIPIENT}/pendingChests/${chestId}`).get()).data()!;
    expect(minted.category).toBe('furniture');
    expect(minted.dropTable).toBe(CHEST_CATEGORY_DROP_TABLE.furniture);
    expect(minted.subject).toBe(subjectForDay('furniture', todayStr()));
    expect(minted.openedAt).toBeNull();

    // And the half that used to throw.
    const opened = await idx.openPendingChest.run({
      data: {pendingChestId: chestId},
      auth: {uid: RECIPIENT, token: {}},
      rawRequest: {},
    });

    expect(typeof opened.itemId).toBe('string');
    expect(['common', 'rare', 'legendary']).toContain(opened.rarity);
    const after = (await db.doc(`users/${RECIPIENT}/pendingChests/${chestId}`).get()).data()!;
    expect(after.openedAt).not.toBeNull();
  });

  test('🔴 every chest in ONE grant shares ONE date, so a retry cannot split them', async () => {
    // The date is resolved ONCE, before `db.runTransaction` opens. That matters
    // because the transaction RE-RUNS on contention: a date computed inside it
    // would differ per attempt, and a grant retrying across UTC midnight could
    // stamp `grantedAt` from one day and a `subject` from the next — a document
    // disagreeing with itself, discoverable only by a player whose chest rolled
    // the wrong theme.
    //
    // WARNING: THIS CANNOT FORCE A MIDNIGHT RETRY, and says so rather than implying
    // it did. What it pins is the observable consequence: all chests minted by
    // one grant agree, and they agree with `subjectForDay` for the same day.
    const res = await invoke({
      headers: {'x-seed-secret': SECRET},
      body: grantBody({
        grantId: 'grant-multi',
        sponges: 0,
        chestCategories: ['characters', 'characters', 'furniture'],
      }),
    });
    const ids = res.body.granted.pendingChestIds as string[];
    expect(ids).toHaveLength(3);

    const chests = await Promise.all(
      ids.map(async (id) =>
        (await db.doc(`users/${RECIPIENT}/pendingChests/${id}`).get()).data()!,
      ),
    );
    const day = todayStr();
    for (const chest of chests) {
      expect(chest.subject).toBe(subjectForDay(chest.category as string, day));
    }
    // The two `characters` chests resolved identically — which is the property
    // a per-chest date would break first, since that pool alternates by date.
    expect(chests[0].subject).toBe(chests[1].subject);
  });
});

// ---------------------------------------------------------------------------
// The rules over the ledger the callable wrote
// ---------------------------------------------------------------------------

describe('the rules over adminGrants, judged on a document the handler wrote', () => {
  test('🔴 no client may read an adminGrants row, not even the recipient', async () => {
    // The ledger names other people's uids and grant contents. `grant-full`
    // exists and was written by the real handler, so this denial is over a real
    // document rather than over an absence — a read of a missing path would
    // pass against a ruleset that denied nothing.
    const recipientDb = testEnv.authenticatedContext(RECIPIENT).firestore();
    await assertFails(getDoc(doc(recipientDb, 'adminGrants/grant-full')));
    const strangerDb = testEnv.authenticatedContext('e2e-stranger').firestore();
    await assertFails(getDoc(doc(strangerDb, 'adminGrants/grant-full')));
    // And it really is there, via the Admin SDK, which bypasses rules.
    expect((await db.doc('adminGrants/grant-full').get()).exists).toBe(true);
  });
});
