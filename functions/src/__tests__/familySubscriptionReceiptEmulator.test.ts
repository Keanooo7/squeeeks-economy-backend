/**
 * A REAL `sub_family_monthly` receipt, driven through to a family document.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: W2-178 · REGISTER ITEM #26 — "sub_family_monthly has no receipt"
 * ---------------------------------------------------------------------------
 *
 * The register's claim was stale as written: the price entry exists
 * (`proReceipt.ts` SUBSCRIPTION_PRICES), the tier mapping exists
 * (`appStoreNotifications.ts` SUBSCRIPTION_PRODUCT_TIERS), and a unit test
 * already pins both. What did NOT exist was any run in which a receipt for that
 * product went in one end and a family came out the other. Brendan's ruling on
 * the item was "I don't know the answer — you figure it out", so it was settled
 * by measurement rather than by argument, and this file is the measurement.
 *
 * KEY: THE MEASUREMENT THAT PRODUCED THIS FILE, AND ITS POSITIVE CONTROL.
 *
 *     grep -ln sub_family_monthly src/__tests__/*Emulator.test.ts
 *         → familyEmulator.test.ts, and ONLY inside two comments
 *     grep -ln productId          src/__tests__/*Emulator.test.ts
 *         → familyEmulator, iapGrantEmulator, renewalNotificationEmulator
 *
 * The second is the control that proves the glob reaches the emulator
 * population rather than mistyping it. And the executable version of the same
 * question, run before a line of this file was written:
 *
 *     jest --config jest.e2e.config.js --runInBand -t sub_family_monthly
 *         → Tests: 139 skipped, 139 total
 *
 * WARNING: AN EXIT CODE IS NOT THAT MEASUREMENT. The first attempt at that command
 * exited 127 — `jest: command not found`, because `emulators:exec` runs the
 * script through `/bin/sh` without npm's `node_modules/.bin` on PATH. A reader
 * grepping for "Tests:" saw nothing and could reasonably have called that "no
 * tests matched". It was a missing binary. The number above is from a run that
 * actually started jest.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE EXISTING SUITES COULD NOT SHOW, AND WHY
 * ---------------------------------------------------------------------------
 *
 *   · `familyEmulator.test.ts` drives the whole family lifecycle against a real
 *     Firestore, but its owner's subscription is written by `seedSubscriber()`.
 *     Its own header says so: "the owner's subscription here is a seeded
 *     document, not a verified receipt." A seed can spell the product id
 *     however the test wants it spelled. The grant path is not exercised at all.
 *   · `verifyIapAndGrant.test.ts` references this product heavily, including a
 *     case named "THE FIXTURE: sub_family_monthly with ZERO families still
 *     grants Pro" — but every one of those runs against the hand-written
 *     `jest.mock('firebase-admin')` fake. It proves what a planner returns; it
 *     cannot prove what lands in Firestore, which is the whole reason
 *     `iapGrantEmulator.test.ts` exists beside it.
 *   · `proReceipt.test.ts` asserts the PRICE TABLE has a row for the product.
 *     A row is not a receipt.
 *
 * KEY: SO THE GAP WAS NEVER "IS THE ENTRY THERE". It was: does a receipt for this
 * product, carried through the shipped callable, write an entitlement that the
 * create gate then accepts — and does the resulting family actually entitle
 * anybody. Three separate writers have to agree on one string
 * (`FAMILY_PRODUCT_ID`) for that to be true, and until this file nothing had
 * ever made all three agree in one run.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: NOTHING HERE SEEDS `users/{BUYER}`. GREP THE FILE.
 * ---------------------------------------------------------------------------
 *
 * There is no `seedSubscriber` equivalent below and no write to the buyer's
 * user document anywhere in this suite — every field the create gate reads was
 * put there by `verifySubscriptionReceipt` itself. The first test asserts the
 * document does not exist yet, which is the executable form of that claim: if a
 * fixture ever starts writing it, that test goes red rather than the suite
 * quietly going back to proving what `familyEmulator` already proved.
 *
 * ---------------------------------------------------------------------------
 * APPLE IS STUBBED AT THE VERIFIER SEAM — the same seam, for the same reason
 * ---------------------------------------------------------------------------
 *
 * `appleJws.verify` is replaced by assignment, exactly as
 * `iapGrantEmulator.test.ts` and `verifyIapAndGrant.test.ts` do. Offline JWS
 * verification makes no HTTP call, so there is no transport to intercept and
 * nothing here talks to Apple.
 *
 * WARNING: THIS FILE THEREFORE PROVES NOTHING ABOUT SIGNATURE VERIFICATION. That is
 * covered once, against a generated certificate chain, in `appleJws.test.ts`.
 * What is real here is everything downstream of the signature: the account
 * boundary, the three Firestore writes, the create gate's read of them, and the
 * entitlement a member ends up holding.
 *
 * OK: THE TRANSACTION CARRIES A REAL `appAccountToken`, not the `null` the
 * compatibility branch admits. `iapGrantEmulator` passes `null`, which is legal
 * only because `accountTokenRollout.epochMs` still ships disabled — so that file
 * exercises the escape hatch rather than the boundary. Here the token is
 * `purchaseTokenForUid(BUYER)`, so `assertAccountBoundary` does the comparison
 * it was written to do, and this suite keeps passing on the day somebody sets
 * the epoch.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: WHAT THIS STILL CANNOT PROVE
 * ---------------------------------------------------------------------------
 *
 *   · Nothing about Apple's servers, sandbox, or a genuinely signed receipt.
 *   · `.run()` skips the callable transport — App Check, the ID-token
 *     verification that populates `request.auth`, CORS, region, timeout.
 *   · It runs THIS working tree, never production (`make check-deployed`).
 *   · IT DOES NOT PROVE A RECEIPT IS EVER SENT. `receiptFor` has no caller in
 *     `functions/src` — there is no mail provider in this project at all, which
 *     `proReceipt.ts` opens by saying. The last test below proves the receipt is
 *     COMPOSABLE for this product, which is the half that was broken before
 *     W2-157 and the half a sender would depend on. Delivery is a different
 *     brief and needs a DNS record only Brendan can create.
 *   · It says nothing about the NEGATIVE case — a personal Pro subscriber
 *     refused a family. That is W2-177, register item #25, and it is asserted in
 *     `familyEmulator.test.ts`. Deliberately not duplicated here.
 */
import * as admin from 'firebase-admin';

import {appleJws} from '../appleJws';
import {FAMILY_PRODUCT_ID, FamilyDoc} from '../family';
import {ProReceipt, receiptFor} from '../proReceipt';
import {purchaseTokenForUid} from '../purchaseAccountToken';
import {resolveEffectiveTier, resolveOwnPaidTier} from '../taskRewards';

// KEY: IMPORTED FOR ITS SIDE EFFECT, AFTER the pure modules above. `index.ts`
// calls `admin.initializeApp()` at module scope; none of the imports above do,
// so this is the first and only initialisation in this file's registry.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const idx = require('../index') as Record<string, {run: (req: unknown) => Promise<any>}>;

const PROJECT_ID = process.env.GCLOUD_PROJECT;

/**
 * Uids unique to this file.
 *
 * WARNING: `familyEmulator.test.ts` calls `testEnv.clearFirestore()` in its own
 * `beforeAll`, and the e2e suites share one emulator. `--runInBand` (pinned in
 * the `test:e2e` script) means files never overlap in time, so that wipe can
 * only ever land before or after this file, never during it — but these uids do
 * not collide with any other suite's either way, and nothing here depends on
 * the database being empty.
 */
const BUYER = 'e2e-family-receipt-buyer';
const MEMBER = 'e2e-family-receipt-member';
const BUYER_EMAIL = 'family-buyer@squeeeks.test';

/** A personal Pro product. Used ONLY as a composer control, never granted. */
const PERSONAL_PRO_PRODUCT_ID = 'sub_pro_monthly';

const FAMILY_TXN = 'txn-family-monthly-1';
const FAMILY_ORIGINAL_TXN = 'otxn-family-monthly-1';

/**
 * Apple's own dates, and the reason they are derived rather than written.
 *
 * `verifySubscriptionReceipt` refuses a subscription whose expiry is not in the
 * future, so a literal date would pass on the day it was typed and then fail
 * forever for a reason having nothing to do with families — the calendar-rot
 * failure `familyEmulator`'s BIN_DATE_KEY comment already names.
 */
const PURCHASE_MS = Date.now();
const EXPIRES_MS = PURCHASE_MS + 30 * 24 * 60 * 60 * 1000;

let db: admin.firestore.Firestore;

/** The receipt ledger key the callable writes. Derived, never retyped. */
const ledgerPath = (productId: string, transactionId: string) =>
  `processedReceipts/${productId}_${transactionId}`;

/**
 * Apple signs [productId] as a genuine purchase by [uid].
 *
 * Assignment, not `jest.mock` — this suite imports `index.ts` UNMOCKED so the
 * Admin SDK inside it reaches the emulator, and a module-factory mock would take
 * firebase-admin with it.
 */
function appleWillSign(args: {
  productId: string;
  transactionId: string;
  originalTransactionId: string;
  uid: string;
}) {
  appleJws.verify = (async () => ({
    productId: args.productId,
    transactionId: args.transactionId,
    originalTransactionId: args.originalTransactionId,
    purchaseDateMs: PURCHASE_MS,
    expiresDateMs: EXPIRES_MS,
    revocationDateMs: null,
    // See the header: the REAL token, so the account boundary is exercised
    // rather than skipped through the null-compatibility branch.
    appAccountToken: purchaseTokenForUid(args.uid),
  })) as unknown as typeof appleJws.verify;
}

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

const userDoc = async (uid: string) => (await db.doc(`users/${uid}`).get()).data();

/**
 * Asserts the receipt composed and narrows the type.
 *
 * `receiptFor` returns null for "cannot be stated truthfully" — no address, or
 * no price. Which of the two it was is answered by the controls at the bottom.
 */
function composed(r: ProReceipt | null): ProReceipt {
  expect(r).not.toBeNull();
  return r as ProReceipt;
}

beforeAll(async () => {
  if (!PROJECT_ID) {
    throw new Error(
      'GCLOUD_PROJECT is unset — run this through `npm run test:e2e`. Under plain ' +
        'jest the Admin SDK would point at a project this test cannot see, and ' +
        'every assertion would pass against an empty database.',
    );
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST are unset. Without ' +
        'them the Admin SDK would try to reach REAL Firestore, and this test ' +
        'writes freely.',
    );
  }

  db = admin.firestore();

  // KEY: AUTH RECORDS ONLY. The email is here because it is where a real buyer's
  // address lives and where a sender would have to read it from — `receiptFor`
  // takes an address, and no Firestore document in this project stores one.
  // `createFamily` and `joinFamily` also stamp `memberNames` from the Auth
  // record, so a missing displayName would silently leave that path untested.
  await admin.auth().createUser({uid: BUYER, email: BUYER_EMAIL, displayName: 'Family Buyer'});
  await admin.auth().createUser({uid: MEMBER, displayName: 'Family Member'});
}, 120_000);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app?.delete()));
});

// ---------------------------------------------------------------------------
// In order, because the path is in order. A failure part-way cascades, which is
// the honest report: the steps after a broken grant genuinely were not proven.
// ---------------------------------------------------------------------------

describe('a sub_family_monthly receipt, from Apple to a family document', () => {
  test('BASELINE — the buyer holds nothing, and cannot create a family', async () => {
    // CRITICAL: THE FALSIFIER, AND THE REASON EVERY ASSERTION BELOW IS ATTRIBUTABLE.
    // Without this, a green suite would be compatible with the buyer having been
    // entitled by something other than the receipt — a leftover document, an
    // earlier suite, a fixture somebody adds later. The measurement this brief
    // was sent to make is "the receipt is what funded the family", and that is a
    // BEFORE and an AFTER, not an AFTER on its own.
    //
    // NOTE: NOT W2-177's CASE. That one is an account that PAYS, refused for
    // holding the wrong product. This one pays nothing at all and is refused by
    // the tier gate that has existed since #389. It is here as the zero mark,
    // not as a second copy of somebody else's test.
    expect((await db.doc(`users/${BUYER}`).get()).exists).toBe(false);
    expect(resolveOwnPaidTier(await userDoc(BUYER), Date.now())).toBe('free');

    expect(await refusalCodeOf(call('createFamily', BUYER, {}))).toBe('failed-precondition');

    // The absence is the point: a refusal that still wrote the document would be
    // the empty shell the gate exists to prevent, and the code alone cannot see
    // it. It also keeps the next test's claim true — the receipt is the FIRST
    // writer of this document.
    expect((await db.collection('families').where('ownerUid', '==', BUYER).get()).empty).toBe(
      true,
    );
    expect((await db.doc(`users/${BUYER}`).get()).exists).toBe(false);
  });

  test('🔴 a sub_family_monthly receipt grants, and the STORED product is the family one', async () => {
    appleWillSign({
      productId: FAMILY_PRODUCT_ID,
      transactionId: FAMILY_TXN,
      originalTransactionId: FAMILY_ORIGINAL_TXN,
      uid: BUYER,
    });

    const res = await call('verifySubscriptionReceipt', BUYER, {
      receipt: 'jws',
      productId: FAMILY_PRODUCT_ID,
    });
    expect(res.success).toBe(true);
    expect(res.alreadyProcessed).toBeFalsy();

    // KEY: THE STORED DOCUMENT, NOT THE RESPONSE. This callable returns
    // `{success: true}` and nothing else — it could write the wrong product, the
    // wrong tier or nothing at all and return exactly the same object. The
    // fake-driven unit suites check the response; only this can check the write.
    const buyer = await userDoc(BUYER);
    expect(buyer?.subscriptionTier).toBe('pro');
    // Compared against the module's own constant rather than a retyped string:
    // a test that spells the product id itself cannot catch the two halves
    // disagreeing, which is the entire failure mode this file is about.
    expect(buyer?.subscriptionProductId).toBe(FAMILY_PRODUCT_ID);

    // CRITICAL: APPLE'S EXPIRY, TO THE MILLISECOND, NEVER FABRICATED. "some timestamp
    // got written" is what a server-side `Date.now() + a month` would also
    // satisfy, and that is a real bug shape: it would keep entitling a
    // subscriber whose subscription Apple had already ended.
    expect((buyer?.subscriptionExpiresAt as admin.firestore.Timestamp).toMillis()).toBe(
      EXPIRES_MS,
    );

    // The idempotency ledger — the row whose emptiness in production was the
    // evidence that no purchase had ever completed (`proReceipt.ts` header).
    const ledger = (await db.doc(ledgerPath(FAMILY_PRODUCT_ID, FAMILY_TXN)).get()).data();
    expect(ledger?.uid).toBe(BUYER);
    expect(ledger?.productId).toBe(FAMILY_PRODUCT_ID);
    expect(ledger?.transactionId).toBe(FAMILY_TXN);
    expect(ledger?.tier).toBe('pro');

    // KEY: THE OWNER INDEX, WHICH IS THE ONLY WAY A RENEWAL EVER FINDS THIS
    // ACCOUNT. A family subscription that grants once and can never rebill is
    // the same defect as one that never granted, discovered a month later.
    const owner = (await db.doc(`subscriptionOwners/${FAMILY_ORIGINAL_TXN}`).get()).data();
    expect(owner?.uid).toBe(BUYER);
    expect(owner?.productId).toBe(FAMILY_PRODUCT_ID);
  });

  test('🔴 the receipt FUNDS THE FAMILY — createFamily now writes families/{id}', async () => {
    // The same call that was refused in the baseline, by the same account, with
    // exactly one thing changed in between: a verified receipt.
    const res = await call('createFamily', BUYER, {});
    const familyId = res.familyId as string;
    expect(typeof familyId).toBe('string');
    expect(familyId.length).toBeGreaterThan(0);

    // KEY: THE DOCUMENT, NOT THE RESPONSE — a callable can return a familyId it
    // never persisted, which is the shape a fake `set()` cannot catch.
    const snap = await db.doc(`families/${familyId}`).get();
    expect(snap.exists).toBe(true);
    const family = snap.data() as FamilyDoc;
    expect(family.ownerUid).toBe(BUYER);
    expect(family.memberUids).toEqual([BUYER]);
    expect(family.memberNames).toEqual({[BUYER]: 'Family Buyer'});

    const buyer = await userDoc(BUYER);
    expect(buyer?.familyId).toBe(familyId);
    // `merge: true` really merged: the entitlement that funded this family is
    // still there. A `set()` that replaced would pass every assertion above and
    // have wiped the subscription in the same breath.
    expect(buyer?.subscriptionProductId).toBe(FAMILY_PRODUCT_ID);

    // CRITICAL: THE STRUCTURAL CONTROL. `avatarUrl` is the field `familyEmulator`'s
    // `seedSubscriber` writes and this file never does. Its absence is the
    // machine-checkable form of the header's claim that NOTHING here seeds the
    // buyer's document — if a fixture ever starts doing so, this goes red before
    // the suite can quietly regress into a second copy of `familyEmulator`.
    expect(buyer?.avatarUrl).toBeUndefined();
  });

  test('🔴 the entitlement REACHES A MEMBER, carrying the receipt’s own expiry', async () => {
    // What a family plan IS. A family document whose members are not entitled is
    // the empty shell W2-156 and W2-177 are both about, and the create gate
    // passing is not evidence against it — the fan-out applies its own rule
    // (`ownerHasFamilySubscription`), read from the owner's stored product.
    const {code} = await call('mintFamilyInvite', BUYER, {});
    const joined = await call('joinFamily', MEMBER, {code});
    const familyId = joined.familyId as string;

    const family = (await db.doc(`families/${familyId}`).get()).data() as FamilyDoc;
    expect(family.memberUids).toEqual([BUYER, MEMBER]);

    const member = await userDoc(MEMBER);
    expect(member?.familyId).toBe(familyId);

    // CRITICAL: THE EXACT MILLISECOND APPLE PUT ON THE RECEIPT, copied — never
    // extended. Asserted as an equality because "some timestamp got written" is
    // what a bespoke second grant path would also satisfy, and because this is
    // the number that ties the member's entitlement back to the purchase rather
    // than to a clock.
    expect((member?.familyProExpiresAt as admin.firestore.Timestamp).toMillis()).toBe(
      EXPIRES_MS,
    );

    // Through the REAL classifier over the REAL stored document, not a
    // hand-built one: W2-79 recorded that every test constructing its own input
    // passed against a broken table, and only the ones going through the
    // classifier went red.
    expect(resolveEffectiveTier(member, Date.now())).toBe('pro');
    // The member pays for nothing of their own. Without this, `pro` above would
    // also be satisfied by a member who had somehow been given a subscription,
    // which is not the thing the family plan is supposed to do.
    expect(resolveOwnPaidTier(member, Date.now())).toBe('free');
  });

  test('🔴 receiptFor COMPOSES a Family receipt from the documents that landed', async () => {
    // Composed from what is in Firestore and Auth after the run above — not from
    // the literals this file typed. If the grant had stored `sub_pro_monthly`,
    // this would compose a $5.99 Pro receipt and every assertion below would
    // fail, which is the point of reading it back rather than passing it in.
    const authUser = await admin.auth().getUser(BUYER);
    const ledger = (await db.doc(ledgerPath(FAMILY_PRODUCT_ID, FAMILY_TXN)).get()).data();
    const buyer = await userDoc(BUYER);
    const storedExpiryMs = (
      buyer?.subscriptionExpiresAt as admin.firestore.Timestamp
    ).toMillis();

    // CRITICAL: THE TWO RECORDS MUST NAME THE SAME PRODUCT, and nothing else in this
    // repo asserts that they do. `processedReceipts` says what was CHARGED;
    // `users/{uid}` says what is ENTITLED. A receipt is composed from the first
    // and the family gate reads the second, so a divergence bills for one plan
    // and entitles another — while each document, read on its own, looks
    // perfectly fine. Two writers, one transaction, one string.
    expect(ledger?.productId).toBe(buyer?.subscriptionProductId);

    const receipt = composed(
      receiptFor({
        email: authUser.email,
        productId: String(ledger?.productId),
        transactionId: String(ledger?.transactionId),
        purchaseDateMs: PURCHASE_MS,
        expiresDateMs: storedExpiryMs,
      }),
    );

    expect(receipt.to).toBe(BUYER_EMAIL);
    expect(receipt.productId).toBe(FAMILY_PRODUCT_ID);
    expect(receipt.transactionId).toBe(FAMILY_TXN);
    expect(receipt.period).toBe('monthly');

    // CRITICAL: THE LITERAL PRICE, PINNED HERE AS WELL AS DERIVED IN proReceipt.test.ts.
    // A gate spelled only in the constant it is checking cannot fail. $12.99 is
    // also what distinguishes a Family receipt from a Pro one at a glance, which
    // is exactly the defect W2-157 fixed: a Family buyer charged $12.99 used to
    // receive a receipt naming a $5.99 product.
    expect(receipt.displayPrice).toBe('12.99');
    expect(receipt.subject).toBe('Your Squeeeks Family receipt — $12.99');

    expect(receipt.body).toContain('Thanks for subscribing to Squeeeks Family.');
    expect(receipt.body).toContain('Everyone in your Squeeeks family');
    expect(receipt.body).toContain(`Transaction ID: ${FAMILY_TXN}`);
    // Apple is the merchant of record. A receipt implying we can cancel it
    // generates a support ticket nobody here can resolve.
    expect(receipt.body).toContain('Billed by Apple.');
  });

  test('🔑 CONTROL — the same composer yields a PRO receipt for the Pro product', async () => {
    // Without this, every assertion above is compatible with `receiptFor`
    // returning one hard-coded Family receipt for any input at all. Same email,
    // same dates, one field different.
    const receipt = composed(
      receiptFor({
        email: BUYER_EMAIL,
        productId: PERSONAL_PRO_PRODUCT_ID,
        transactionId: FAMILY_TXN,
        purchaseDateMs: PURCHASE_MS,
        expiresDateMs: EXPIRES_MS,
      }),
    );

    expect(receipt.displayPrice).toBe('5.99');
    expect(receipt.subject).toBe('Your Squeeeks Pro receipt — $5.99');
    // CRITICAL: THE ABSENCE IS THE ASSERTION. Every receipt used to end with a family
    // promise unconditionally, including the $5.99 one — a false statement on a
    // billing document, since `planFamilyFanOutForEffect` returns `[]` for any
    // product that is not the family one. The line belongs on exactly one of
    // these two receipts, and a test that only checked the Family one could not
    // tell whether it was on both.
    expect(receipt.body).not.toContain('Everyone in your Squeeeks family');
  });

  test('🔑 CONTROL — receiptFor returns NULL when it cannot state the truth', async () => {
    // The discriminator behind `expect(receipt).not.toBeNull()`. If `receiptFor`
    // could never return null, that assertion would be decoration — and null for
    // an unpriced product is precisely the state `sub_family_monthly` was in
    // before W2-157, when a family subscriber was charged and received nothing.
    expect(
      receiptFor({
        email: BUYER_EMAIL,
        productId: 'sub_not_a_real_product',
        transactionId: FAMILY_TXN,
        purchaseDateMs: PURCHASE_MS,
        expiresDateMs: EXPIRES_MS,
      }),
    ).toBeNull();

    // The other null branch: the real family product, no address. 65% of today's
    // accounts are anonymous, so this is the branch `proReceipt.ts` calls a
    // fallback that should never fire — and "should never fire" is a prediction.
    expect(
      receiptFor({
        email: null,
        productId: FAMILY_PRODUCT_ID,
        transactionId: FAMILY_TXN,
        purchaseDateMs: PURCHASE_MS,
        expiresDateMs: EXPIRES_MS,
      }),
    ).toBeNull();
  });
});
