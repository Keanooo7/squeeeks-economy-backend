/**
 * `appStoreNotificationsV2` under contention — the only race Apple creates for us.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: EVERY OTHER CONTENTION TEST IN THIS REPO MANUFACTURES THE COLLISION
 * ---------------------------------------------------------------------------
 *
 * This one is the production case. It is a server-to-server webhook, **Apple
 * RETRIES it**, and Apple **does not guarantee delivery order** — both are
 * documented behaviour, not a race someone had to construct.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE KILLING QUESTION TURNED UP, BEFORE THIS FILE WAS WRITTEN
 * ---------------------------------------------------------------------------
 *
 * KEY: THE DUPLICATE CASE IS NEARLY UNTESTABLE, AND THAT IS THE INTERESTING PART.
 * Applying an `entitle` effect twice writes the SAME tier, product id and
 * expiry — it is idempotent by value. So hoisting the lock read out of the
 * transaction produces almost no observable difference on a redelivery, and a
 * test built around "Apple retried, was it applied once?" would be weak
 * evidence dressed as a strong claim.
 *
 * CRITICAL: THE PROPERTY THAT IS *NOT* IDEMPOTENT IS THE STALENESS GUARD, and it is
 * the one that costs a subscription. `subscriptionNotifiedAt` is read INSIDE
 * the transaction and compared against `signedDateMs`. Two notifications of
 * DIFFERENT ages arriving together — an older EXPIRED redelivered after a newer
 * DID_RENEW, exactly the case Apple's own ordering caveat describes — both read
 * the same `lastMs` if that read is not inside the transaction, both pass the
 * guard, and the LAST WRITER WINS. If that is the EXPIRED, a live, paid-for
 * entitlement is wiped.
 *
 * The handler's comment states the intent:
 *
 *     "Apple does NOT guarantee delivery order, and retries can arrive days
 *      late. Without this an EXPIRED redelivered after the DID_RENEW that
 *      followed it would wipe a live entitlement."
 *
 * That is the sentence under test. It had never been driven against a database
 * that can actually make two writers collide.
 *
 * NOTE: AND THE RACE WINDOW IS REACHABLE — TRACED FIRST, NOT DISCOVERED AFTER.
 * Before `runTransaction` the handler does: `verifyNotification` (local, no
 * Firestore), `effectOf` (pure), and `subscriptionOwnerRef(...).get()` (a
 * READ). **There is no write**, so nothing serialises the two deliveries
 * upstream of the lock — the mistake that made the first version of W2-101's
 * concurrency test pass under its own mutation.
 *
 * ---------------------------------------------------------------------------
 * THREE KEYS, THREE MEANINGS — none of them shared with verifyIapAndGrant
 * ---------------------------------------------------------------------------
 *
 *   processedReceipts/{productId}_{transactionId}   verifyIapAndGrant's lock
 *   processedNotifications/{notificationUUID}       THIS handler's lock
 *   subscriptionOwners/{originalTransactionId}      the account index
 *
 * KEY: The notification lock is keyed on the NOTIFICATION, never the transaction —
 * `DID_FAIL_TO_RENEW` and `EXPIRED` both carry the same renewal transaction, so
 * a transaction-keyed ledger would swallow the second and never revoke.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: WHAT THIS STILL CANNOT PROVE
 * ---------------------------------------------------------------------------
 *
 *   · NOTHING ABOUT APPLE'S SIGNATURES. `verifyNotification` is stubbed by
 *     assignment; the real chain is covered in appleJws.test.ts. There is no
 *     HTTP call to intercept because verification is offline.
 *   · Nothing about Apple's actual retry cadence or ordering — those are
 *     simulated here, faithfully to the documented behaviour but simulated.
 *   · It runs THIS working tree, never production (`make check-deployed`).
 *   · Two overlapping in-process invocations are not two Apple deliveries; they
 *     are enough to make Firestore transactions collide and no wider.
 */
import * as admin from 'firebase-admin';

import {appleJws} from '../appleJws';
import type {AppleNotification} from '../appleJws';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const idx = require('../index') as Record<string, any>;

const PROJECT_ID = process.env.GCLOUD_PROJECT;
const SUBSCRIBER = 'e2e-renewal-subscriber';
const ORIGINAL_TXN = 'e2e-original-txn-1';
const PRODUCT = 'sub_pro_monthly';

const T0 = Date.UTC(2026, 7, 14);
const MONTH = 30 * 24 * 3600 * 1000;

let db: admin.firestore.Firestore;

function notificationOf(
  notificationType: string,
  notificationUUID: string,
  signedDateMs: number,
  expiresDateMs: number,
): AppleNotification {
  return {
    notificationType,
    subtype: null,
    notificationUUID,
    signedDateMs,
    transaction: {
      transactionId: `txn-${notificationUUID}`,
      productId: PRODUCT,
      originalTransactionId: ORIGINAL_TXN,
      purchaseDateMs: T0,
      expiresDateMs,
      revocationDateMs: null,
      appAccountToken: null,
    },
  } as AppleNotification;
}

/**
 * Apple will verify whatever `signedPayload` string it is handed, as [n].
 *
 * Assignment rather than `jest.mock` — this suite imports `index.ts` UNMOCKED so
 * the Admin SDK inside it reaches the emulator, and a module-factory mock would
 * take firebase-admin down with it.
 */
function appleWillSend(byPayload: Record<string, AppleNotification>) {
  appleJws.verifyNotification = (async (signedPayload: string) => {
    const n = byPayload[signedPayload];
    if (!n) throw new Error(`test stub has no notification for payload "${signedPayload}"`);
    return n;
  }) as unknown as typeof appleJws.verifyNotification;
}

/** POST a signedPayload at the webhook and resolve with its HTTP status. */
function deliver(signedPayload: string): Promise<number> {
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      send() {
        resolve(status);
        return this;
      },
    };
    try {
      const handler = idx.appStoreNotificationsV2;
      const maybe = handler({method: 'POST', body: {signedPayload}}, res);
      if (maybe && typeof maybe.catch === 'function') maybe.catch(reject);
    } catch (e) {
      reject(e);
    }
  });
}

const userOf = async () => (await db.doc(`users/${SUBSCRIBER}`).get()).data();

beforeAll(async () => {
  if (!PROJECT_ID) {
    throw new Error(
      'GCLOUD_PROJECT is unset — run this through `npm run test:e2e`. Under plain ' +
        'jest the Admin SDK would point at a project this test cannot see, and ' +
        'every assertion would pass against an empty database.',
    );
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error('FIRESTORE_EMULATOR_HOST is unset — this test writes freely.');
  }
  db = admin.firestore();
  // The account index the handler needs to attribute a notification at all.
  await db.doc(`subscriptionOwners/${ORIGINAL_TXN}`).set({uid: SUBSCRIBER});
  await db.doc(`users/${SUBSCRIBER}`).set({subscriptionTier: 'free'});
}, 120_000);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app?.delete()));
});

describe('appStoreNotificationsV2 against a real Firestore', () => {
  test('a DID_RENEW entitles the subscriber and stamps the ordering clock', async () => {
    const renew = notificationOf('DID_RENEW', 'uuid-renew-1', T0, T0 + MONTH);
    appleWillSend({'payload-renew-1': renew});

    expect(await deliver('payload-renew-1')).toBe(200);

    const user = await userOf();
    expect(user?.subscriptionTier).toBe('pro');
    expect(
      (user?.subscriptionExpiresAt as admin.firestore.Timestamp).toMillis(),
    ).toBe(T0 + MONTH);
    // The ordering stamp is what every staleness decision below reads.
    expect(
      (user?.subscriptionNotifiedAt as admin.firestore.Timestamp).toMillis(),
    ).toBe(T0);

    expect((await db.doc('processedNotifications/uuid-renew-1').get()).exists).toBe(true);
  });

  test('🔑 a LATER notification DOES apply — the guard is ordering, not a freeze', async () => {
    // WARNING: THE CONTROL WITHOUT WHICH EVERY REFUSAL BELOW IS MEANINGLESS. A handler
    // that ignored everything after the first notification would satisfy the
    // stale test and the concurrency test both — and would also mean a
    // subscription could never be renewed, cancelled or refunded again.
    const later = notificationOf('DID_RENEW', 'uuid-renew-2', T0 + MONTH, T0 + 2 * MONTH);
    appleWillSend({'payload-renew-2': later});

    expect(await deliver('payload-renew-2')).toBe(200);

    const user = await userOf();
    expect(user?.subscriptionTier).toBe('pro');
    expect(
      (user?.subscriptionExpiresAt as admin.firestore.Timestamp).toMillis(),
    ).toBe(T0 + 2 * MONTH);
  });

  test('🔴 an OLDER notification racing a NEWER one cannot wipe the entitlement', async () => {
    // WARNING: THE ASSERTION NO OTHER TEST IN THIS REPO CAN MAKE, and the reason this
    // file exists. Apple retries and does not guarantee order, so an EXPIRED
    // signed BEFORE a DID_RENEW can arrive AFTER it — or, as here, at the same
    // moment. The staleness guard reads `subscriptionNotifiedAt` INSIDE the
    // transaction; move that read outside and both deliveries see the same
    // `lastMs`, both pass, and the last writer wins. If that is the EXPIRED, a
    // live paid-for entitlement is wiped.
    //
    // NOTE: The duplicate case is deliberately NOT the headline here: applying an
    // `entitle` twice writes identical values and is idempotent, so it is weak
    // evidence. Ordering is where the money is.
    const base = T0 + 2 * MONTH;
    const stale = notificationOf('EXPIRED', 'uuid-expired-stale', base - 1, base);
    const fresh = notificationOf('DID_RENEW', 'uuid-renew-3', base + 1, base + MONTH);
    appleWillSend({'payload-stale': stale, 'payload-fresh': fresh});

    const [s, f] = await Promise.all([deliver('payload-stale'), deliver('payload-fresh')]);
    // Both are ACKNOWLEDGED — a stale notification is settled, not an error, and
    // 200 is what stops Apple retrying it forever.
    expect(s).toBe(200);
    expect(f).toBe(200);

    // CRITICAL: THE STORED DOCUMENT IS THE ASSERTION. Whichever order they committed
    // in, the NEWER notification's effect is the one that survives.
    const user = await userOf();
    expect(user?.subscriptionTier).toBe('pro');
    expect(
      (user?.subscriptionExpiresAt as admin.firestore.Timestamp).toMillis(),
    ).toBe(base + MONTH);
    expect(
      (user?.subscriptionNotifiedAt as admin.firestore.Timestamp).toMillis(),
    ).toBe(base + 1);
  }, 30_000);

  test('🔴 the SAME notificationUUID delivered twice concurrently applies once', async () => {
    // Apple's documented retry, as a genuine collision. The lock is keyed on the
    // notification, and both deliveries carry the same UUID.
    const base = T0 + 4 * MONTH;
    const dup = notificationOf('DID_RENEW', 'uuid-dup', base, base + MONTH);
    appleWillSend({'payload-dup': dup});

    const [a, b] = await Promise.all([deliver('payload-dup'), deliver('payload-dup')]);
    expect(a).toBe(200);
    expect(b).toBe(200);

    const user = await userOf();
    expect(
      (user?.subscriptionExpiresAt as admin.firestore.Timestamp).toMillis(),
    ).toBe(base + MONTH);
    expect((await db.doc('processedNotifications/uuid-dup').get()).exists).toBe(true);
  }, 30_000);

  test('an unattributable notification is refused and takes NO lock', async () => {
    // No `subscriptionOwners` entry — Apple is asked to retry (503) and the
    // lock is deliberately NOT written, so the redelivery can still land once
    // the client's own call creates the index.
    const orphan = notificationOf('DID_RENEW', 'uuid-orphan', T0 + 5 * MONTH, T0 + 6 * MONTH);
    orphan.transaction!.originalTransactionId = 'no-such-original-txn';
    appleWillSend({'payload-orphan': orphan});

    expect(await deliver('payload-orphan')).toBe(503);
    // KEY: Taking the lock here would make the retry a no-op and strand a real
    // subscriber — so its ABSENCE is the assertion.
    expect((await db.doc('processedNotifications/uuid-orphan').get()).exists).toBe(false);
  });
});
