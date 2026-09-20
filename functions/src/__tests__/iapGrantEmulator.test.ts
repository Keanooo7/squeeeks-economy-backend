/**
 * `verifyIapAndGrant` — the money path — against a REAL Firestore.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: EIGHT UNIT FILES REFERENCE THIS CALLABLE AND NONE OF THEM CAN SEE THE BUG
 * ---------------------------------------------------------------------------
 *
 * That is the question this file had to answer before it was worth writing, and
 * the answer is one property: **the dedup lock is only a lock if two calls can
 * actually race for it.**
 *
 *   · `verifyIapAndGrant.test.ts` and its seven siblings drive the handler
 * against the hand-written fake `firebase-admin`. WARNING: A fake
 *     `runTransaction` RUNS THE CALLBACK ONCE AND NEVER RETRIES — so the
 *     re-check inside the transaction is dead code there, and the fast-path
 *     read before it is indistinguishable from it.
 *   · `economyIdempotency.test.ts` is a SOURCE GREP: it asserts the handler
 *     CONTAINS `runTransaction`. Hoisting the dedup read OUT of that
 *     transaction leaves the word in place and the grep satisfied.
 *
 * The handler's own comment makes the claim this file tests:
 *
 *     "The processedReceipts doc is created INSIDE the transaction as the
 *      idempotency lock, so concurrent calls / retries can never double-apply
 *      the consumable sponge increment."
 *
 * KEY: THAT SENTENCE HAD NEVER BEEN TESTED. A double grant is a player receiving
 * twice what they paid for; the same race losing the other way is a player
 * paying and receiving nothing.
 *
 * NOTE: AND THE RACE WINDOW IS GENUINELY OPEN HERE, which is not automatic — on
 * W2-101 the equivalent test proved nothing because both calls contended on
 * CREATING a streak document first and Firestore serialised them upstream of
 * the code under test. For a sponge pack there is NO WRITE before the
 * transaction: `validateAppleTransaction` is local, and the fast-path
 * `processedRef.get()` is a read. Nothing serialises the two calls before they
 * reach the lock.
 *
 * ---------------------------------------------------------------------------
 * APPLE IS STUBBED AT THE VERIFIER SEAM, AND THAT IS NOT A GAP THIS FILE HIDES
 * ---------------------------------------------------------------------------
 *
 * `appleJws.verify` is replaced by assignment, exactly as
 * `verifyIapAndGrant.test.ts` does. Offline JWS verification makes NO HTTP call,
 * so there is no transport to intercept and nothing here talks to Apple.
 *
 * WARNING: SO THIS FILE PROVES NOTHING ABOUT SIGNATURE VERIFICATION. That is covered
 * once, against a generated certificate chain, in `appleJws.test.ts`. What is
 * real here is Firestore: the ledger document, the transaction, the increment
 * and the contention. Stating it because "an IAP e2e test" sounds like it
 * checks Apple, and it does not.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: WHAT THIS STILL CANNOT PROVE
 * ---------------------------------------------------------------------------
 *
 *   · Nothing about Apple's servers, sandbox, or a real receipt.
 *   · `.run()` skips the callable transport — App Check, the ID-token
 *     verification that populates `request.auth`, CORS, region, timeout.
 *   · It runs THIS working tree, never production (`make check-deployed`).
 *   · Two overlapping `.run()` calls in one process are not two devices; they
 *     are enough to force a transaction retry and no wider than that.
 */
import * as admin from 'firebase-admin';

import {appleJws} from '../appleJws';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const idx = require('../index') as Record<string, {run: (req: unknown) => Promise<any>}>;

const PROJECT_ID = process.env.GCLOUD_PROJECT;
const BUYER = 'e2e-iap-buyer';
const RACER = 'e2e-iap-racer';

const PACK = 'sponge_pack_550';
const PACK_SPONGES = 550;

let db: admin.firestore.Firestore;

/**
 * Apple verifies [transactionId] as a genuine purchase of [productId].
 *
 * Assignment, not `jest.mock` — this suite imports `index.ts` UNMOCKED so the
 * Admin SDK inside it reaches the emulator, and a module-factory mock would
 * take firebase-admin with it.
 */
function appleWillVerify(productId: string, transactionId: string) {
  appleJws.verify = (async () => ({
    productId,
    transactionId,
    originalTransactionId: transactionId,
    purchaseDateMs: 0,
    expiresDateMs: null,
    revocationDateMs: null,
    appAccountToken: null,
  })) as unknown as typeof appleJws.verify;
}

function call(name: string, uid: string | null, data: unknown): Promise<any> {
  const fn = idx[name];
  if (!fn || typeof fn.run !== 'function') {
    throw new Error(`index.ts exports no callable named "${name}"`);
  }
  return fn.run({data, auth: uid ? {uid, token: {}} : undefined, rawRequest: {}});
}

const spongesOf = async (uid: string) =>
  (await db.doc(`users/${uid}/profile/data`).get()).data()?.spongeBalance ?? 0;

beforeAll(async () => {
  if (!PROJECT_ID) {
    throw new Error(
      'GCLOUD_PROJECT is unset — run this through `npm run test:e2e`. Under plain ' +
        'jest the Admin SDK would point at a project this test cannot see, and ' +
        'every assertion would pass against an empty database.',
    );
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST is unset. Without it the Admin SDK would try to ' +
        'reach REAL Firestore, and this test writes freely.',
    );
  }
  db = admin.firestore();
}, 120_000);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app?.delete()));
});

describe('verifyIapAndGrant against a real Firestore', () => {
  test('a sponge pack grants once and writes the ledger', async () => {
    appleWillVerify(PACK, 'txn-first');
    const res = await call('verifyIapAndGrant', BUYER, {receipt: 'jws', productId: PACK});

    expect(res.success).toBe(true);
    expect(res.granted.sponges).toBe(PACK_SPONGES);

    // KEY: THE STORED DOCUMENTS, NOT THE RESPONSE — a handler can return the right
    // numbers while writing nothing, and the response is what the fake-driven
    // unit tests already check.
    expect(await spongesOf(BUYER)).toBe(PACK_SPONGES);

    const ledger = (await db.doc(`processedReceipts/${PACK}_txn-first`).get()).data();
    expect(ledger?.uid).toBe(BUYER);
    expect(ledger?.transactionId).toBe('txn-first');
    expect(ledger?.granted?.sponges).toBe(PACK_SPONGES);
  });

  test('replaying the SAME transaction id grants nothing further', async () => {
    appleWillVerify(PACK, 'txn-first');
    const res = await call('verifyIapAndGrant', BUYER, {receipt: 'jws', productId: PACK});

    expect(res.alreadyProcessed).toBe(true);
    expect(await spongesOf(BUYER)).toBe(PACK_SPONGES);
  });

  test('🔑 a DIFFERENT transaction id DOES grant — the lock is keyed, not blanket', async () => {
    // WARNING: THE CONTROL WITHOUT WHICH "granted once" IS MEANINGLESS. A callable
    // that refused every second purchase for any reason would satisfy the
    // replay test and the concurrency test both, and would also mean a player
    // could never buy the same pack twice.
    appleWillVerify(PACK, 'txn-second');
    const res = await call('verifyIapAndGrant', BUYER, {receipt: 'jws', productId: PACK});

    expect(res.alreadyProcessed).toBeFalsy();
    expect(res.granted.sponges).toBe(PACK_SPONGES);
    expect(await spongesOf(BUYER)).toBe(PACK_SPONGES * 2);
  });

  test('🔴 CONCURRENT calls with the same transaction id grant ONCE', async () => {
    // WARNING: THE ASSERTION NO OTHER TEST IN THIS REPO CAN MAKE, and the reason this
    // file exists. The dedup is a `tx.get(processedRef)` INSIDE the transaction;
    // move it outside and both calls read "not processed", both grant, and the
    // player receives twice what they paid for. The fake firestore cannot
    // produce that — its `runTransaction` never retries — and
    // `economyIdempotency`'s grep still sees the word `runTransaction`.
    //
    // NOTE: Nothing serialises these two calls before the lock: Apple verification
    // is local and stubbed, and the fast-path read is a read. That is what makes
    // the window real here and did not hold on W2-101.
    appleWillVerify(PACK, 'txn-race');

    const [a, b] = await Promise.all([
      call('verifyIapAndGrant', RACER, {receipt: 'jws', productId: PACK}),
      call('verifyIapAndGrant', RACER, {receipt: 'jws', productId: PACK}),
    ]);

    // Both calls SUCCEED — the loser reports the winner's grant rather than an
    // error, which is what makes a retry safe for the client.
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    // Exactly one did the granting. Which one is genuinely nondeterministic and
    // is deliberately not asserted.
    expect([a.alreadyProcessed, b.alreadyProcessed].filter(Boolean)).toHaveLength(1);

    // CRITICAL: AND THE BALANCE IS THE REAL ASSERTION. Two responses both reporting
    // 550 while the increment ran twice is exactly what a lost update looks
    // like from the outside.
    expect(await spongesOf(RACER)).toBe(PACK_SPONGES);

    const ledger = (await db.doc(`processedReceipts/${PACK}_txn-race`).get()).data();
    expect(ledger?.uid).toBe(RACER);
    expect(ledger?.granted?.sponges).toBe(PACK_SPONGES);
  }, 30_000);

  test('an unauthenticated call is refused and grants nothing', async () => {
    appleWillVerify(PACK, 'txn-anon');
    let code: string | null = null;
    try {
      await call('verifyIapAndGrant', null, {receipt: 'jws', productId: PACK});
    } catch (err) {
      code = String((err as {code?: unknown}).code ?? '');
    }
    expect(code).toBe('unauthenticated');
    expect((await db.doc(`processedReceipts/${PACK}_txn-anon`).get()).exists).toBe(false);
  });
});
