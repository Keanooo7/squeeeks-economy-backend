// functions/src/__tests__/verifyIapAndGrant.test.ts
//
// Unit tests for the IAP grant + subscription callables, focused on the
// security fixes: the server must confirm the claimed productId is actually the
// verified transaction, read the REAL subscription expiry (never fabricate it),
// refuse a transaction stamped for a different account, and apply the grant
// atomically/idempotently.

// ---------------------------------------------------------------------------
// Path-keyed Firestore mock (declared before imports — Jest hoists the factory)
// ---------------------------------------------------------------------------

interface DocState {
  data: Record<string, unknown> | null;
}
const docStore: Record<string, DocState> = {};

function resetStore() {
  for (const k of Object.keys(docStore)) delete docStore[k];
}

function docMock(path: string) {
  return {
    path,
    get: jest.fn(async () => {
      const st = docStore[path] ?? { data: null };
      return {
        exists: st.data !== null,
        data: () => st.data,
        id: path.split('/').pop(),
      };
    }),
    set: jest.fn(async (val: Record<string, unknown>, opts?: { merge?: boolean }) => {
      const st = docStore[path] ?? (docStore[path] = { data: null });
      st.data = opts?.merge ? { ...(st.data ?? {}), ...val } : { ...val };
    }),
    // 2026-08-15 (W2-86) — `update` and `delete` added. joinFamily uses both,
    // and the tx fake could only get/set, so the callable could not be driven
    // here at all. WARNING: `update` MERGES and requires the document to exist, which
    // is the real Firestore contract and NOT the same as set+merge: a test that
    // updates a missing document should fail rather than quietly create one.
    update: jest.fn(async (val: Record<string, unknown>) => {
      const st = docStore[path];
      if (!st || st.data === null) {
        throw new Error(`update on a missing document: ${path}`);
      }
      st.data = { ...st.data, ...val };
    }),
    delete: jest.fn(async () => {
      delete docStore[path];
    }),
  };
}

const _db = {
  doc: jest.fn((p: string) => docMock(p)),
  collection: jest.fn(),
  runTransaction: jest.fn(),
};

jest.mock('firebase-admin', () => {
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = { increment: (n: number) => ({ _type: 'increment', n }) };
  // 2026-08-14 — `toMillis()` added. The real Firestore Timestamp has it and
  // this fake did not, so any code that READ a stored timestamp back (rather
  // than only writing one) threw `toMillis is not a function`. The ordering
  // guard in appStoreNotificationsV2 is the first such reader; it is a gap in
  // the fake, not a difference from Firestore.
  const stamp = (ms: number) => ({ _type: 'ts', ms, toMillis: () => ms });
  firestoreFn.Timestamp = {
    now: () => stamp(0),
    fromDate: (d: Date) => stamp(d.getTime()),
    fromMillis: (ms: number) => stamp(ms),
  };
  return {
    initializeApp: jest.fn(),
    firestore: firestoreFn,
    messaging: jest.fn(() => ({
      // A BatchResponse-shaped return, not bare undefined: the reminder crons
      // now READ this to prune permanently-dead tokens, so an undefined here
      // would make a future cron test silently no-op instead of failing.
      sendEach: jest.fn(async () => ({ responses: [], successCount: 0, failureCount: 0 })),
    })),
  };
});

// index.ts/xp.ts/notifications.ts import Timestamp and FieldValue from
// 'firebase-admin/firestore' rather than off the `admin.firestore` namespace,
// because the Functions emulator's admin proxy drops those statics. Re-export
// the same sentinels the 'firebase-admin' mock above installs so both import
// styles resolve to one fake.
jest.mock('firebase-admin/firestore', () => {
  const admin = jest.requireMock('firebase-admin') as any;
  return {
    FieldValue: admin.firestore.FieldValue,
    Timestamp: admin.firestore.Timestamp,
  };
});

jest.mock('firebase-functions/v2/https', () => ({
  // Mirrors the real signature: onCall(handler) and onCall(opts, handler).
  onCall: (...args: any[]) => ({ _handler: args[args.length - 1] }),
  // onRequest(handler) AND onRequest(opts, handler) — the secret-bound admin
  // endpoints use the second form, and a single-arg mock silently captures the
  // options object as the handler.
  onRequest: (...args: any[]) => ({ _handler: args[args.length - 1] }),
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: (_s: string, handler: () => any) => ({ _handler: handler }),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  verifyIapAndGrant,
  verifySubscriptionReceipt,
  appStoreNotificationsV2,
  claimRetentionPromo,
  getPlantDirectory,
  joinFamily,
} = require('../index') as {
  verifyIapAndGrant: { _handler: (req: any) => Promise<any> };
  verifySubscriptionReceipt: { _handler: (req: any) => Promise<any> };
  // onRequest, not onCall — Apple calls it, so it takes (req, res) and reports
  // through the response rather than by returning or throwing.
  appStoreNotificationsV2: { _handler: (req: any, res: any) => Promise<void> };
  claimRetentionPromo: { _handler: (req: any) => Promise<any> };
  joinFamily: { _handler: (req: any) => Promise<any> };
  getPlantDirectory: { _handler: (req: any) => Promise<any> };
};


import { HttpsError } from 'firebase-functions/v2/https';
import { appleJws } from '../appleJws';
import { accountTokenRollout, purchaseTokenForUid } from '../purchaseAccountToken';

// ---------------------------------------------------------------------------
// Apple stubbed at the VERIFIER seam, not at the transport.
//
// WARNING: This replaced a `global.fetch` stub returning legacy `verifyReceipt` JSON
// (`{status: 0, receipt: {in_app: […]}}`) at 14 call sites. Offline JWS
// verification makes **no HTTP call at all**, so there is no transport left to
// intercept — every one of those fixtures became meaningless the moment the
// callables stopped talking to Apple's server.
//
// The real cryptography is covered once, separately, in appleJws.test.ts against
// a generated certificate chain. What is left here is what these tests were
// always actually about: the ledger, idempotency, the grant, and the account
// boundary — none of which are about Apple.
//
// KEY: A JWS describes exactly ONE transaction, unlike a StoreKit 1 app receipt,
// which listed every purchase ever made on the device. That is why these
// fixtures are single transactions and why the "restore batch" block below
// hands each callable its own string.
// ---------------------------------------------------------------------------
function mockJws(transaction: {
  productId: string;
  transactionId: string;
  originalTransactionId?: string | null;
  purchaseDateMs?: number;
  expiresDateMs?: number | null;
  revocationDateMs?: number | null;
  appAccountToken?: string | null;
}) {
  appleJws.verify = jest.fn(async () => ({
    purchaseDateMs: 0,
    expiresDateMs: null,
    // 2026-08-14 — defaults added with the notification endpoint, which needs
    // both fields on every transaction. `originalTransactionId` defaults to the
    // transaction's OWN id, matching Apple: on the first purchase of a
    // subscription the two are equal, and it is the renewals that diverge.
    originalTransactionId: transaction.transactionId,
    revocationDateMs: null,
    appAccountToken: null,
    ...transaction,
  }));
}

/** Apple refused to verify the signature — a forged or corrupt transaction. */
function mockJwsRejected(code = 'invalid-argument') {
  appleJws.verify = jest.fn(async () => {
    throw new HttpsError(code as never, 'Apple transaction verification failed');
  });
}

function seedDoc(path: string, data: Record<string, unknown> | null) {
  docStore[path] = { data };
}

/**
 * Collection queries over the shared docStore.
 *
 * The fake has always been doc-keyed and had NO query support — `_db.collection`
 * was a bare `jest.fn()`, because until now every callable under test read
 * documents by path. `claimRetentionPromo` is the first that queries, and it
 * queries the one collection whose size is the whole point (`completions` has
 * no TTL and is never pruned), so the RANGE FILTER is the behaviour under test
 * rather than an incidental detail — a fake that ignored `where` would report a
 * bounded query passing while the real one read a player's entire history.
 *
 * Supports exactly what is used: `.where(field, '>=', ts).get()` over immediate
 * children of the path. Timestamps compare on the fake's `ms`.
 */
/**
 * How many documents each collection query actually RETURNED, in call order.
 *
 * CRITICAL: Exists because the first version of the bounded-query test did not test
 * the bound. It seeded ancient records and asserted they did not COUNT — which
 * `evaluatePromo` guarantees on its own by filtering to the window, so the
 * assertion held whether or not the query was bounded. Reverting the `where`
 * clause left the suite green. Measuring the READ is the only thing that
 * distinguishes "bounded" from "read everything and discarded most of it", and
 * the difference is the entire cost argument for a collection that is never
 * pruned.
 */
const queryReads: number[] = [];

function realisticCollections() {
  queryReads.length = 0;
  _db.collection.mockImplementation((path: string) => {
    const childrenOf = () =>
      Object.entries(docStore)
        .filter(([k, v]) => {
          if (!k.startsWith(`${path}/`) || v.data === null) return false;
          return !k.slice(path.length + 1).includes('/');
        })
        .map(([k, v]) => ({ id: k.split('/').pop(), data: () => v.data! }));

    const query = (
      filter: (d: Record<string, unknown>) => boolean,
      cap: number | null = null,
    ): any => ({
      where: (field: string, op: string, value: any) =>
        query((d) => {
          if (!filter(d)) return false;
          // `==` on a plain value. Added in W2-79 for the family fan-out's
          // `where('ownerUid','==',uid)`. Kept separate from the `>=` branch
          // below rather than folded into it: that branch is specifically about
          // the `{ms}` timestamp sentinel this fake uses, and a shared
          // comparison would silently coerce a string against it.
          if (op === '==') return d[field] === value;
          const got = d[field] as { ms?: number } | undefined;
          if (got?.ms == null) return false;
          if (op === '>=') return got.ms >= value.ms;
          throw new Error(`fake collection: unsupported operator ${op}`);
        }, cap),
      // WARNING: TRUNCATES THE RESULT, it does not merely annotate the query. A
      // `limit` that returned everything would make a caller taking `docs[0]`
      // look correct while reading the whole collection — the same
      // "read everything and discarded most of it" the queryReads counter
      // below exists to catch.
      limit: (n: number) => query(filter, n),
      get: async () => {
        const matched = childrenOf().filter((d) => filter(d.data()));
        const docs = cap == null ? matched : matched.slice(0, cap);
        queryReads.push(docs.length);
        return { docs };
      },
    });

    return query(() => true);
  });
}

// Transaction that reads/writes the shared docStore through the doc refs.
function realisticTransaction() {
  _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
    const tx = {
      get: (ref: any) => ref.get(),
      set: (ref: any, val: any, opts: any) => ref.set(val, opts),
      create: (ref: any, val: any) => ref.set(val),
      update: (ref: any, val: any) => ref.update(val),
      delete: (ref: any) => ref.delete(),
    };
    return fn(tx);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  realisticTransaction();
  realisticCollections();
  // Ships disabled; individual tests move it to exercise the enabled branch.
  accountTokenRollout.epochMs = null;
});

// ---------------------------------------------------------------------------
// verifyIapAndGrant
// ---------------------------------------------------------------------------

describe('verifyIapAndGrant', () => {
  const call = (data: any, uid?: string) =>
    verifyIapAndGrant._handler({ auth: uid ? { uid } : null, data });

  test('throws unauthenticated without auth', async () => {
    await expect(call({ receipt: 'r', productId: 'sponge_pack_100' })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  test('SECURITY: rejects when the claimed productId is NOT the transaction', async () => {
    // Genuine transaction is for the cheap pack; client claims the expensive one.
    mockJws({ productId: 'sponge_pack_100', transactionId: 'tx-cheap' });

    await expect(
      call({ receipt: 'genuine-cheap', productId: 'sponge_pack_1200' }, 'uid-a'),
    ).rejects.toMatchObject({ code: 'invalid-argument' });

    // No sponges granted.
    expect(docStore['users/uid-a/profile/data']?.data).toBeUndefined();
  });

  test('SECURITY: a transaction Apple did not sign grants nothing', async () => {
    // Replaces the old `status != 0` case. The callable must propagate the
    // verification failure rather than swallowing it into a grant.
    mockJwsRejected();

    await expect(
      call({ receipt: 'forged', productId: 'sponge_pack_100' }, 'uid-a'),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(docStore['users/uid-a/profile/data']?.data).toBeUndefined();
    expect(Object.keys(docStore).filter((k) => k.startsWith('processedReceipts/'))).toEqual([]);
  });

  test('grants the matching sponge pack and records the transaction', async () => {
    mockJws({ productId: 'sponge_pack_1200', transactionId: 'tx-1200' });

    const res = await call({ receipt: 'genuine-1200', productId: 'sponge_pack_1200' }, 'uid-a');

    expect(res.granted.sponges).toBe(1200);
    expect(docStore['users/uid-a/profile/data']?.data?.spongeBalance).toEqual({
      _type: 'increment',
      n: 1200,
    });
    // Idempotency lock written, keyed on the Apple transaction id.
    expect(docStore['processedReceipts/sponge_pack_1200_tx-1200']?.data).toMatchObject({
      uid: 'uid-a',
      productId: 'sponge_pack_1200',
      transactionId: 'tx-1200',
    });
  });

  test('the same transaction id is still rejected as a replay', async () => {
    seedDoc('processedReceipts/sponge_pack_100_tx-dup', {
      granted: { sponges: 100, items: [] },
    });
    mockJws({ productId: 'sponge_pack_100', transactionId: 'tx-dup' });

    const res = await call({ receipt: 'dup-receipt', productId: 'sponge_pack_100' }, 'uid-a');

    expect(res).toMatchObject({ success: true, alreadyProcessed: true });
    expect(res.granted).toEqual({ sponges: 100, items: [] });
    // Nothing re-applied.
    expect(docStore['users/uid-a/profile/data']?.data).toBeUndefined();
    // CONTRACT, carried over from the fetch-era harness deliberately:
    // verification runs BEFORE the dedup check, because the ledger key is the
    // transaction id and that is only knowable from a verified transaction.
    // (Verification is now local, so this no longer costs a round trip.)
    expect(appleJws.verify).toHaveBeenCalled();
  });

  test('repeat purchases of the same consumable each grant', async () => {
    // Under StoreKit 2 each purchase is its OWN JWS with its own transaction id
    // — there is no cumulative receipt to re-scan, which is why the old
    // "newest transaction wins" tie-break no longer has anything to tie-break.
    mockJws({ productId: 'sponge_pack_100', transactionId: 'tx-first', purchaseDateMs: 1000 });
    await call({ receipt: 'r1', productId: 'sponge_pack_100' }, 'uid-a');

    mockJws({ productId: 'sponge_pack_100', transactionId: 'tx-second', purchaseDateMs: 2000 });
    const res = await call({ receipt: 'r2', productId: 'sponge_pack_100' }, 'uid-a');

    expect(res.alreadyProcessed).toBeUndefined();
    expect(res.granted.sponges).toBe(100);
    expect(docStore['processedReceipts/sponge_pack_100_tx-second']?.data).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // The account boundary — the server half of PR #78
  // -------------------------------------------------------------------------

  test('SECURITY: a transaction stamped for ANOTHER account grants nothing', async () => {
    // Apple carries appAccountToken on the transaction itself, so it survives a
    // reinstall and comes back on every restore. Only request.auth.uid is
    // trustworthy, so the server recomputes the token and compares.
    mockJws({
      productId: 'sponge_pack_100',
      transactionId: 'tx-someone-else',
      appAccountToken: purchaseTokenForUid('uid-b'),
    });

    await expect(
      call({ receipt: 'stolen', productId: 'sponge_pack_100' }, 'uid-a'),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    expect(docStore['users/uid-a/profile/data']?.data).toBeUndefined();
    // KEY: And the ledger is NOT written. Writing the lock on a rejected grant
    // would burn the transaction id, so the rightful owner could never claim it.
    expect(Object.keys(docStore).filter((k) => k.startsWith('processedReceipts/'))).toEqual([]);
  });

  test('a transaction stamped for THIS account grants', async () => {
    mockJws({
      productId: 'sponge_pack_100',
      transactionId: 'tx-mine',
      appAccountToken: purchaseTokenForUid('uid-a'),
    });

    const res = await call({ receipt: 'mine', productId: 'sponge_pack_100' }, 'uid-a');
    expect(res.granted.sponges).toBe(100);
  });

  test('an uppercase token from Apple still matches', async () => {
    // Apple round-trips the value through Swift's UUID, which renders uppercase.
    // A case-sensitive compare here would reject every honest stamped purchase —
    // the exact one-bit-drift failure mode the frozen vectors exist to prevent,
    // arriving by a different door.
    mockJws({
      productId: 'sponge_pack_100',
      transactionId: 'tx-upper',
      appAccountToken: purchaseTokenForUid('uid-a').toUpperCase(),
    });

    const res = await call({ receipt: 'upper', productId: 'sponge_pack_100' }, 'uid-a');
    expect(res.granted.sponges).toBe(100);
  });

  test('an unstamped transaction is granted while the rollout is disabled', async () => {
    // Every transaction Apple has signed to date predates the stamping build.
    // Shipping the epoch enabled would reject all of them.
    mockJws({
      productId: 'sponge_pack_100',
      transactionId: 'tx-legacy',
      purchaseDateMs: Date.now(),
    });

    const res = await call({ receipt: 'legacy', productId: 'sponge_pack_100' }, 'uid-a');
    expect(res.granted.sponges).toBe(100);
  });

  test('with the rollout enabled, an unstamped transaction from BEFORE it still grants', async () => {
    accountTokenRollout.epochMs = 2_000;
    mockJws({ productId: 'sponge_pack_100', transactionId: 'tx-old', purchaseDateMs: 1_000 });

    const res = await call({ receipt: 'old', productId: 'sponge_pack_100' }, 'uid-a');
    expect(res.granted.sponges).toBe(100);
  });

  test('with the rollout enabled, an unstamped transaction from AFTER it is refused', async () => {
    accountTokenRollout.epochMs = 2_000;
    mockJws({ productId: 'sponge_pack_100', transactionId: 'tx-new', purchaseDateMs: 3_000 });

    await expect(
      call({ receipt: 'new', productId: 'sponge_pack_100' }, 'uid-a'),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(Object.keys(docStore).filter((k) => k.startsWith('processedReceipts/'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// verifySubscriptionReceipt
// ---------------------------------------------------------------------------

describe('verifySubscriptionReceipt', () => {
  const call = (data: any, uid?: string) =>
    verifySubscriptionReceipt._handler({ auth: uid ? { uid } : null, data });

  // -------------------------------------------------------------------------
  // W2-105 — the two writers of one field, and the two owners of one index
  // -------------------------------------------------------------------------
  //
  // CRITICAL: `appStoreNotificationsV2` guards `subscriptionExpiresAt` with a staleness
  // check; this path wrote the same field with NO comparison. Measured against
  // the emulator before the fix: the webhook applied an expiry six months out,
  // a restore of an older still-valid transaction overwrote it with one month,
  // and the stored value was the older one — a paying subscriber silently
  // losing five months.
  //
  // WARNING: THE IDEMPOTENCY LEDGER CANNOT STAND IN FOR THIS. The webhook records
  // `processedNotifications/{uuid}` and this path checks
  // `processedReceipts/{productId}_{transactionId}`, so a renewal applied by
  // the webhook leaves nothing this path can see.

  test('🔴 a restore CANNOT move the expiry backwards over a newer entitlement', async () => {
    const longer = Date.now() + 180 * 24 * 3600 * 1000;
    const shorter = Date.now() + 30 * 24 * 3600 * 1000;
    // The state a webhook renewal would have left behind.
    docStore['users/uid-a'] = {
      data: {
        subscriptionTier: 'pro',
        subscriptionProductId: 'sub_pro_monthly',
        subscriptionExpiresAt: { toMillis: () => longer },
      },
    } as any;

    mockJws({ productId: 'sub_pro_monthly', transactionId: 'tx-older', expiresDateMs: shorter });
    const res = await call({ receipt: 'r', productId: 'sub_pro_monthly' }, 'uid-a');

    // The call SUCCEEDS — a restore that grants nothing new is not an error,
    // and failing it would surface to a player who did nothing wrong.
    expect(res.success).toBe(true);
    expect(
      (docStore['users/uid-a']?.data as any).subscriptionExpiresAt.toMillis(),
    ).toBe(longer);
  });

  test('🔑 a restore that grants MORE still applies — the guard is not a freeze', async () => {
    // WARNING: THE PERMIT THAT MAKES THE REFUSAL ABOVE MEAN SOMETHING. A guard that
    // rejected every restore would satisfy that test too — and would break the
    // one path a player uses when they reinstall, turning a silent loss into a
    // support ticket.
    const shorter = Date.now() + 30 * 24 * 3600 * 1000;
    const longer = Date.now() + 180 * 24 * 3600 * 1000;
    docStore['users/uid-a'] = {
      data: {
        subscriptionTier: 'pro',
        subscriptionProductId: 'sub_pro_monthly',
        subscriptionExpiresAt: { toMillis: () => shorter },
      },
    } as any;

    mockJws({ productId: 'sub_pro_monthly', transactionId: 'tx-newer', expiresDateMs: longer });
    await call({ receipt: 'r', productId: 'sub_pro_monthly' }, 'uid-a');

    expect(
      (docStore['users/uid-a']?.data as any).subscriptionExpiresAt.toMillis(),
    ).toBe(longer);
  });

  test('a FIRST restore with no stored entitlement still grants', async () => {
    // The absent-field case: `currentExpiryMs` is undefined, which must read as
    // "grant it", not as "already entitled". A `>=` against undefined would be
    // false either way, but the branch is pinned so a later refactor cannot
    // turn a missing document into a refusal.
    const future = Date.now() + 90 * 24 * 3600 * 1000;
    mockJws({ productId: 'sub_pro_monthly', transactionId: 'tx-first', expiresDateMs: future });
    await call({ receipt: 'r', productId: 'sub_pro_monthly' }, 'uid-fresh');

    expect((docStore['users/uid-fresh']?.data as any).subscriptionTier).toBe('pro');
    expect(
      (docStore['users/uid-fresh']?.data as any).subscriptionExpiresAt.toMillis(),
    ).toBe(future);
  });

  test('🔴 a restore by a DIFFERENT account does not re-point the owner index', async () => {
    // Deterministic, not a race: two app accounts restoring the same Apple
    // original transaction. Overwriting would hand every future renewal to
    // whoever restored last — the outcome the old comment named and did not
    // guard.
    const future = Date.now() + 90 * 24 * 3600 * 1000;
    docStore['subscriptionOwners/tx-original-1'] = {
      data: { uid: 'uid-first-owner', productId: 'sub_pro_monthly' },
    } as any;

    // WARNING: originalTransactionId PINNED. `mockJws` defaults it to the transaction
    // id, so without this the handler writes subscriptionOwners/tx-other-acct
    // and never touches the seeded key — the assertion below would then pass
    // while the collision branch was never reached. Caught by its sibling test
    // going red for exactly that reason.
    mockJws({
      productId: 'sub_pro_monthly',
      transactionId: 'tx-other-acct',
      originalTransactionId: 'tx-original-1',
      expiresDateMs: future,
    });
    const res = await call({ receipt: 'r', productId: 'sub_pro_monthly' }, 'uid-b');

    // The restore itself succeeds and uid-b is entitled — they may genuinely
    // have paid. What is refused is only the redirection of FUTURE renewals.
    expect(res.success).toBe(true);
    expect((docStore['users/uid-b']?.data as any).subscriptionTier).toBe('pro');
    expect((docStore['subscriptionOwners/tx-original-1']?.data as any).uid).toBe('uid-first-owner');
  });

  test('🔑 the SAME account re-restoring DOES refresh the owner index', async () => {
    // The permit for the refusal above. A reinstall is the ordinary reason to
    // restore, and it must keep the index current rather than being mistaken
    // for a collision with itself.
    const future = Date.now() + 90 * 24 * 3600 * 1000;
    docStore['subscriptionOwners/tx-original-1'] = {
      data: { uid: 'uid-a', productId: 'sub_pro_monthly', linkedAt: 'old' },
    } as any;

    mockJws({
      productId: 'sub_pro_monthly',
      transactionId: 'tx-reinstall',
      originalTransactionId: 'tx-original-1',
      expiresDateMs: future,
    });
    await call({ receipt: 'r', productId: 'sub_pro_monthly' }, 'uid-a');

    expect((docStore['subscriptionOwners/tx-original-1']?.data as any).uid).toBe('uid-a');
    expect((docStore['subscriptionOwners/tx-original-1']?.data as any).linkedAt).not.toBe('old');
  });

  // -------------------------------------------------------------------------
  // W2-108 — an anonymous buyer is RECORDED, never refused
  // -------------------------------------------------------------------------
  //
  // CRITICAL: THE SAFETY PROPERTY, AND IT IS THE OPPOSITE OF WHAT THE COMPLAINT
  // SOUNDS LIKE. "Anonymous users should not be able to buy" is right about the
  // product and wrong about where to enforce it: Apple has ALREADY CHARGED THE
  // CARD by the time this callable runs. A server that refused here produces a
  // player who HAS PAID AND RECEIVED NOTHING — unrecoverable without a manual
  // refund, and a certain App Review rejection.
  //
  // NOTE: The same shape as `accountTokenRollout.epochMs`, still null for exactly
  // this reason: a guard correct in intent and catastrophic because it fires
  // after the money moved. The account requirement belongs BEFORE the charge,
  // in the client (W1-116), or it does not exist.
  //
  // WARNING: SO THIS TEST EXISTS TO GO RED IF ANYONE EVER "TIGHTENS" THIS. It is not
  // describing today's behaviour for completeness; it is the tripwire on a
  // change that would look like an improvement in a diff.

  test('🔴 an ANONYMOUS buyer is still granted the subscription', async () => {
    const future = Date.now() + 90 * 24 * 3600 * 1000;
    mockJws({ productId: 'sub_pro_monthly', transactionId: 'tx-anon', expiresDateMs: future });

    const res = await verifySubscriptionReceipt._handler({
      auth: { uid: 'uid-anon', token: { firebase: { sign_in_provider: 'anonymous' } } },
      data: { receipt: 'r', productId: 'sub_pro_monthly' },
    });

    expect(res.success).toBe(true);
    // The ENTITLEMENT, not just the response — a refusal that still returned
    // success would be worse than one that threw.
    expect((docStore['users/uid-anon']?.data as any).subscriptionTier).toBe('pro');

    // WARNING: ASSERTED IN THE SAME TEST, not a sibling: `beforeEach` calls
    // resetStore(), so a second test reading this document finds nothing and
    // fails for a reason that has nothing to do with the property.
    //
    // Recording is the deliverable. Without it nobody can count how many
    // entitlements are stranded on a single device — the question that decides
    // whether this needs a migration or a footnote.
    const ledger = docStore['processedReceipts/sub_pro_monthly_tx-anon']?.data as any;
    expect(ledger.purchaserWasAnonymous).toBe(true);
    expect(ledger.purchaserSignInProvider).toBe('anonymous');
  });

  test('🔑 a SIGNED-IN buyer is recorded as not anonymous — the pair', () => {
    // WARNING: Without this, `purchaserWasAnonymous: true` also passes for a field
    // hard-coded to true, and the count it exists to support would be every
    // purchase ever made.
    const future = Date.now() + 90 * 24 * 3600 * 1000;
    mockJws({ productId: 'sub_pro_monthly', transactionId: 'tx-apple-signin', expiresDateMs: future });

    return verifySubscriptionReceipt._handler({
      auth: { uid: 'uid-real', token: { firebase: { sign_in_provider: 'apple.com' } } },
      data: { receipt: 'r', productId: 'sub_pro_monthly' },
    }).then(() => {
      const ledger = docStore['processedReceipts/sub_pro_monthly_tx-apple-signin']?.data as any;
      expect(ledger.purchaserWasAnonymous).toBe(false);
      expect(ledger.purchaserSignInProvider).toBe('apple.com');
    });
  });

  test('a token with NO provider claim records null, not false', () => {
    // "We never recorded it" and "it was not anonymous" must not look the same
    // to whoever counts these later — an absent field cannot be queried for.
    const future = Date.now() + 90 * 24 * 3600 * 1000;
    mockJws({ productId: 'sub_pro_monthly', transactionId: 'tx-no-claim', expiresDateMs: future });

    return verifySubscriptionReceipt._handler({
      auth: { uid: 'uid-noclaim' },
      data: { receipt: 'r', productId: 'sub_pro_monthly' },
    }).then(() => {
      const ledger = docStore['processedReceipts/sub_pro_monthly_tx-no-claim']?.data as any;
      expect(ledger.purchaserSignInProvider).toBeNull();
      expect(ledger.purchaserWasAnonymous).toBe(false);
      // …and it still granted. An unreadable token is not a reason to refuse
      // money that has already moved.
      expect((docStore['users/uid-noclaim']?.data as any).subscriptionTier).toBe('pro');
    });
  });

  test('SECURITY: rejects when the transaction is not the claimed subscription', async () => {
    mockJws({
      productId: 'sub_premium_monthly',
      transactionId: 'tx-premium',
      expiresDateMs: Date.now() + 1e9,
    });

    await expect(
      call({ receipt: 'r', productId: 'sub_pro_monthly' }, 'uid-a'),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(docStore['users/uid-a']?.data).toBeUndefined();
  });

  test('SECURITY: rejects an already-expired subscription', async () => {
    mockJws({
      productId: 'sub_pro_monthly',
      transactionId: 'tx-expired',
      expiresDateMs: Date.now() - 1000,
    });

    await expect(
      call({ receipt: 'expired', productId: 'sub_pro_monthly' }, 'uid-a'),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(docStore['users/uid-a']?.data).toBeUndefined();
  });

  test("grants the tier with Apple's real expiry (not a fabricated 30 days)", async () => {
    const realExpiry = Date.now() + 12 * 24 * 60 * 60 * 1000; // 12 days, not 30
    mockJws({
      productId: 'sub_pro_monthly',
      transactionId: 'tx-pro-1',
      expiresDateMs: realExpiry,
    });

    const res = await call({ receipt: 'good', productId: 'sub_pro_monthly' }, 'uid-a');

    expect(res).toMatchObject({ success: true });
    const userDoc = docStore['users/uid-a']?.data as Record<string, any>;
    expect(userDoc.subscriptionTier).toBe('pro');
    // toMatchObject, not toEqual: the Timestamp fake gained a `toMillis()`
    // method on 2026-08-14 and an exact-shape match now trips over it. The
    // subject of this assertion is the millisecond value, which is unchanged.
    expect(userDoc.subscriptionExpiresAt).toMatchObject({ _type: 'ts', ms: realExpiry });
  });

  test('the same subscription transaction id is still rejected as a replay', async () => {
    seedDoc('processedReceipts/sub_pro_monthly_tx-pro-1', { tier: 'pro' });
    mockJws({
      productId: 'sub_pro_monthly',
      transactionId: 'tx-pro-1',
      expiresDateMs: Date.now() + 1e9,
    });

    const res = await call({ receipt: 'replayed', productId: 'sub_pro_monthly' }, 'uid-a');

    expect(res).toMatchObject({ success: true, alreadyProcessed: true });
    // Replay protection is the reason the ledger exists — it must survive the
    // re-keying, not be traded away for it.
    expect(docStore['users/uid-a']?.data).toBeUndefined();
  });

  test('a subscription transaction with no expiry fails closed', async () => {
    mockJws({ productId: 'sub_pro_monthly', transactionId: 'tx-no-expiry' });

    await expect(
      call({ receipt: 'no-expiry', productId: 'sub_pro_monthly' }, 'uid-a'),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(docStore['users/uid-a']?.data).toBeUndefined();
  });

  test('SECURITY: a subscription stamped for another account grants no tier', async () => {
    mockJws({
      productId: 'sub_pro_monthly',
      transactionId: 'tx-not-yours',
      expiresDateMs: Date.now() + 1e9,
      appAccountToken: purchaseTokenForUid('uid-b'),
    });

    await expect(
      call({ receipt: 'stolen-sub', productId: 'sub_pro_monthly' }, 'uid-a'),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(docStore['users/uid-a']?.data).toBeUndefined();
    expect(Object.keys(docStore).filter((k) => k.startsWith('processedReceipts/'))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The restore collision — the two callables sharing one ledger key
//
// This is the defect the transaction-id re-keying exists for, so it keeps its
// own block. Both callables used to key processedReceipts on sha256(receipt),
// so whichever ran first wrote the lock and the other returned alreadyProcessed
// having granted nothing — a paying customer reinstalls and silently loses
// their subscription tier.
//
// WARNING: The note that used to sit here explained the collision via StoreKit 1,
// where `serverVerificationData` is one cumulative app receipt covering every
// purchase on the device, so the two callables were literally handed the same
// string. **That is not this app's code path** — the app runs StoreKit 2 and
// each transaction has its own JWS. The defect was real by a different route:
// all three listeners treat PurchaseStatus.restored as purchased
// (shop_purchase_provider.dart:45,146 · subscription_purchase_provider.dart:38)
// and `Transaction.currentEntitlements` redelivers past purchases on restore,
// so both callables fire in one batch — which is what this block now models.
// ---------------------------------------------------------------------------

describe('one restore batch, two products', () => {
  test('sponge pack first, then subscription — BOTH grant', async () => {
    mockJws({ productId: 'sponge_pack_550', transactionId: 'tx-pack-9', purchaseDateMs: 1000 });
    const packRes = await verifyIapAndGrant._handler({
      auth: { uid: 'uid-a' },
      data: { receipt: 'jws-pack', productId: 'sponge_pack_550' },
    });
    expect(packRes.granted.sponges).toBe(550);

    mockJws({
      productId: 'sub_pro_annual',
      transactionId: 'tx-sub-9',
      purchaseDateMs: 2000,
      expiresDateMs: Date.now() + 1e9,
    });
    const subRes = await verifySubscriptionReceipt._handler({
      auth: { uid: 'uid-a' },
      data: { receipt: 'jws-sub', productId: 'sub_pro_annual' },
    });

    expect(subRes.alreadyProcessed).toBeUndefined();
    expect((docStore['users/uid-a']?.data as any)?.subscriptionTier).toBe('pro');
  });

  test('subscription first, then sponge pack — BOTH grant, and no granted:undefined', async () => {
    mockJws({
      productId: 'sub_pro_annual',
      transactionId: 'tx-sub-9',
      purchaseDateMs: 2000,
      expiresDateMs: Date.now() + 1e9,
    });
    await verifySubscriptionReceipt._handler({
      auth: { uid: 'uid-a' },
      data: { receipt: 'jws-sub', productId: 'sub_pro_annual' },
    });
    expect((docStore['users/uid-a']?.data as any)?.subscriptionTier).toBe('pro');

    mockJws({ productId: 'sponge_pack_550', transactionId: 'tx-pack-9', purchaseDateMs: 1000 });
    const packRes = await verifyIapAndGrant._handler({
      auth: { uid: 'uid-a' },
      data: { receipt: 'jws-pack', productId: 'sponge_pack_550' },
    });

    // In the old shared namespace this returned alreadyProcessed with
    // `granted: prev.granted` — and verifySubscriptionReceipt's ledger doc has
    // no `granted` field, so the client got `granted: undefined` where it
    // expects {sponges, items}. Money taken, nothing given, wrong shape.
    expect(packRes.alreadyProcessed).toBeUndefined();
    expect(packRes.granted).toEqual({ sponges: 550, items: [] });
    expect(docStore['users/uid-a/profile/data']?.data?.spongeBalance).toEqual({
      _type: 'increment',
      n: 550,
    });
  });

  test('the two purchases occupy DIFFERENT ledger keys', async () => {
    mockJws({ productId: 'sponge_pack_550', transactionId: 'tx-pack-9', purchaseDateMs: 1000 });
    await verifyIapAndGrant._handler({
      auth: { uid: 'uid-a' },
      data: { receipt: 'jws-pack', productId: 'sponge_pack_550' },
    });
    mockJws({
      productId: 'sub_pro_annual',
      transactionId: 'tx-sub-9',
      purchaseDateMs: 2000,
      expiresDateMs: Date.now() + 1e9,
    });
    await verifySubscriptionReceipt._handler({
      auth: { uid: 'uid-a' },
      data: { receipt: 'jws-sub', productId: 'sub_pro_annual' },
    });

    const keys = Object.keys(docStore).filter((k) => k.startsWith('processedReceipts/'));
    expect(keys.sort()).toEqual([
      'processedReceipts/sponge_pack_550_tx-pack-9',
      'processedReceipts/sub_pro_annual_tx-sub-9',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Product-id → tier decoding (W2-62)
//
// #314 landed the client half of the pricing change: subscription_tier.dart:150
// maps (pro, annual) → 'sub_pro_annual' and ios/Configuration.storekit:149
// declares it, while the server allow-list still listed the retired
// 'sub_premium_monthly' and had never heard of the annual. A real annual
// purchase was rejected as "Not a subscription product".
//
// WARNING: BEFORE THIS BLOCK, NO TEST ANYWHERE EXERCISED A REJECTED PRODUCT ID.
// Every existing case fed the allow-list something it already accepted, so the
// negative half of that gate — the half that stops an arbitrary string being
// billed as a subscription — had never once been executed.
// ---------------------------------------------------------------------------

describe('verifySubscriptionReceipt — product id decoding', () => {
  const call = (data: any, uid?: string) =>
    verifySubscriptionReceipt._handler({ auth: uid ? { uid } : null, data });

  // POSITIVE CONTROL. Fails before the fix with "Not a subscription product".
  test('the annual product validates and grants PRO, not premium', async () => {
    mockJws({
      productId: 'sub_pro_annual',
      transactionId: 'tx-annual-1',
      expiresDateMs: Date.now() + 1e9,
    });

    const res = await call({ receipt: 'jws-annual', productId: 'sub_pro_annual' }, 'uid-a');

    expect(res.alreadyProcessed).toBeUndefined();
    expect((docStore['users/uid-a']?.data as any)?.subscriptionTier).toBe('pro');
    expect((docStore['users/uid-a']?.data as any)?.subscriptionProductId).toBe('sub_pro_annual');
  });

  // NEGATIVE CONTROL. A map that accepts everything is worse than the ternary
  // it replaced, so the rejecting half is asserted in the same breath as the
  // accepting half.
  test('an unknown product id is still rejected', async () => {
    mockJws({
      productId: 'sub_totally_made_up',
      transactionId: 'tx-bogus-1',
      expiresDateMs: Date.now() + 1e9,
    });

    await expect(
      call({ receipt: 'jws-bogus', productId: 'sub_totally_made_up' }, 'uid-a'),
    ).rejects.toThrow(/Not a subscription product/);
    expect(docStore['users/uid-a']).toBeUndefined();
  });

  // The retired product must not be billable any more. This is the assertion
  // that would have caught the old ternary granting 'premium' to anything that
  // got past the allow-list.
  test('the retired premium product is no longer a subscription product', async () => {
    mockJws({
      productId: 'sub_premium_monthly',
      transactionId: 'tx-retired-1',
      expiresDateMs: Date.now() + 1e9,
    });

    await expect(
      call({ receipt: 'jws-retired', productId: 'sub_premium_monthly' }, 'uid-a'),
    ).rejects.toThrow(/Not a subscription product/);
    expect(docStore['users/uid-a']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// appStoreNotificationsV2 — the renewal path
//
// CRITICAL: THE FAILURE THIS ENDPOINT EXISTS FOR. Both client purchase listeners are
// created INSIDE a buy action and cancelled when it resolves
// (`subscription_purchase_provider.dart:71`, `shop_purchase_provider.dart:81`),
// so `verifySubscriptionReceipt` is only ever reached from inside an active buy
// flow. A rebill happens with the app closed and reached nobody at all.
//
// Apple is stubbed at the `verifyNotification` seam for the same reason `verify`
// is stubbed above: the real cryptography is covered once, in appleJws.test.ts,
// against a generated chain. What is tested here is the half that is not about
// Apple — the owner lookup, the notification ledger, and delivery ORDER.
// ---------------------------------------------------------------------------

const NOTIF_NOW = Date.UTC(2026, 7, 14);
const NOTIF_MONTH = 30 * 24 * 3600 * 1000;

function mockNotification(overrides: Record<string, any> = {}) {
  const { transaction: txOverrides, ...rest } = overrides;
  appleJws.verifyNotification = jest.fn(async () => ({
    notificationType: 'DID_RENEW',
    subtype: null,
    notificationUUID: 'uuid-renew-1',
    signedDateMs: NOTIF_NOW,
    transaction:
      txOverrides === null
        ? null
        : {
            transactionId: 'tx-renewal-2',
            productId: 'sub_pro_monthly',
            originalTransactionId: 'tx-original-1',
            purchaseDateMs: NOTIF_NOW,
            expiresDateMs: NOTIF_NOW + NOTIF_MONTH,
            revocationDateMs: null,
            appAccountToken: null,
            ...(txOverrides ?? {}),
          },
    ...rest,
  }));
}

function mockNotificationRejected(code = 'invalid-argument') {
  appleJws.verifyNotification = jest.fn(async () => {
    throw new HttpsError(code as never, 'Apple notification verification failed');
  });
}

function mockRes() {
  const res: any = { statusCode: undefined, body: undefined };
  res.status = jest.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.send = jest.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

async function postNotification(body: unknown = { signedPayload: 'jws' }) {
  const res = mockRes();
  await appStoreNotificationsV2._handler({ method: 'POST', body }, res);
  return res;
}

/** The owner index entry `verifySubscriptionReceipt` writes at purchase time. */
function seedOwner(originalTransactionId = 'tx-original-1', uid = 'uid-a') {
  seedDoc(`subscriptionOwners/${originalTransactionId}`, {
    uid,
    productId: 'sub_pro_monthly',
  });
}

describe('appStoreNotificationsV2 — a renewal reaches the server', () => {
  test('DID_RENEW extends the entitlement for the owning account', async () => {
    // The headline: no client involved, no auth, app closed.
    seedOwner();
    mockNotification();

    const res = await postNotification();

    expect(res.statusCode).toBe(200);
    expect(docStore['users/uid-a']?.data).toMatchObject({
      subscriptionTier: 'pro',
      subscriptionProductId: 'sub_pro_monthly',
      subscriptionExpiresAt: { _type: 'ts', ms: NOTIF_NOW + NOTIF_MONTH },
    });
  });

  test('the renewal is found by the ORIGINAL transaction id, not the renewal id', async () => {
    // The renewal carries a transactionId this server has never seen. Looking
    // up by it would miss every rebill — which is the failure mode a naive
    // implementation reaching for `receiptLedgerRef` would ship.
    seedOwner('tx-original-1');
    seedDoc('subscriptionOwners/tx-renewal-2', null);
    mockNotification();

    const res = await postNotification();

    expect(res.statusCode).toBe(200);
    expect(docStore['users/uid-a']?.data).toMatchObject({ subscriptionTier: 'pro' });
  });

  test('the user document is MERGED, never replaced', async () => {
    // `users/{uid}` carries display name, orientation state and streak fields.
    // A bare set() would replace all of it with four subscription keys.
    seedOwner();
    seedDoc('users/uid-a', { displayName: 'Bee', orientationCompleted: true });
    mockNotification();

    await postNotification();

    expect(docStore['users/uid-a']?.data).toMatchObject({
      displayName: 'Bee',
      orientationCompleted: true,
      subscriptionTier: 'pro',
    });
  });
});

describe('appStoreNotificationsV2 — idempotency', () => {
  test('a redelivered notification is applied exactly once', async () => {
    // Apple retries until it gets a 2xx, so redelivery is routine rather than
    // exceptional.
    seedOwner();
    mockNotification();

    await postNotification();
    seedDoc('users/uid-a', { subscriptionTier: 'tampered' });
    const second = await postNotification();

    expect(second.statusCode).toBe(200);
    // Untouched by the replay — the ledger short-circuited before the write.
    expect(docStore['users/uid-a']?.data).toMatchObject({ subscriptionTier: 'tampered' });
  });

  test('the ledger is keyed on notificationUUID, so EXPIRED after DID_RENEW still lands', async () => {
    // CRITICAL: THE REGRESSION THIS KEY EXISTS TO PREVENT. Apple sends more than one
    // notification about the SAME transaction. A notification ledger keyed on
    // `transactionId` — which the brief described as already sufficient, and
    // which `receiptLedgerRef` uses correctly for PURCHASES — would classify
    // this second notification as already processed and silently drop it,
    // leaving a lapsed subscriber entitled.
    seedOwner();
    mockNotification();
    await postNotification();

    mockNotification({
      notificationType: 'EXPIRED',
      notificationUUID: 'uuid-expired-1',
      signedDateMs: NOTIF_NOW + NOTIF_MONTH,
      // Same transaction id as the DID_RENEW above.
      transaction: { transactionId: 'tx-renewal-2' },
    });
    const res = await postNotification();

    expect(res.statusCode).toBe(200);
    expect(docStore['users/uid-a']?.data).toMatchObject({ subscriptionTier: 'free' });
  });
});

describe('appStoreNotificationsV2 — delivery order', () => {
  test('a stale EXPIRED redelivered AFTER a renewal does not wipe the entitlement', async () => {
    // CRITICAL: Apple does not guarantee order and retries for ~3 days. Without the
    // signedDate guard, an EXPIRED that arrives late — after the DID_RENEW that
    // superseded it — would drop a paying subscriber to free.
    seedOwner();
    mockNotification({ signedDateMs: NOTIF_NOW + 5000 });
    await postNotification();

    mockNotification({
      notificationType: 'EXPIRED',
      notificationUUID: 'uuid-expired-late',
      signedDateMs: NOTIF_NOW, // signed BEFORE the renewal above
      transaction: { transactionId: 'tx-old' },
    });
    const res = await postNotification();

    expect(res.statusCode).toBe(200);
    expect(docStore['users/uid-a']?.data).toMatchObject({ subscriptionTier: 'pro' });
  });

  test('a NEWER notification is applied over an older one', async () => {
    // The control for the test above: the guard must reject stale deliveries
    // without also rejecting the ordinary forward case.
    seedOwner();
    mockNotification();
    await postNotification();

    mockNotification({
      notificationType: 'EXPIRED',
      notificationUUID: 'uuid-expired-later',
      signedDateMs: NOTIF_NOW + NOTIF_MONTH,
      transaction: { transactionId: 'tx-old' },
    });
    await postNotification();

    expect(docStore['users/uid-a']?.data).toMatchObject({ subscriptionTier: 'free' });
  });
});

describe('appStoreNotificationsV2 — a refund cuts access immediately', () => {
  test('REFUND drops the tier even though the paid period has weeks left', async () => {
    // CRITICAL: The one ending the clock cannot handle. #343 made every reader date
    // the stored tier against the clock, which correctly handles a cancellation
    // or a natural expiry with no server write at all — but a refund happens
    // MID-PERIOD, leaving `subscriptionExpiresAt` weeks in the future on a
    // subscription that has been paid back.
    seedOwner();
    const revokedAt = NOTIF_NOW + 3 * 24 * 3600 * 1000;
    mockNotification({
      notificationType: 'REFUND',
      notificationUUID: 'uuid-refund-1',
      transaction: {
        expiresDateMs: NOTIF_NOW + NOTIF_MONTH,
        revocationDateMs: revokedAt,
      },
    });

    await postNotification();

    expect(docStore['users/uid-a']?.data).toMatchObject({
      subscriptionTier: 'free',
      // Backdated to the revocation, not left at the unpaid-for expiry.
      subscriptionExpiresAt: { _type: 'ts', ms: revokedAt },
    });
  });
});

describe('appStoreNotificationsV2 — the signature IS the authentication', () => {
  test('an unverifiable payload grants nothing and answers 400', async () => {
    // There is no shared secret and no source-IP allow-list; Apple publishes
    // neither. If a forged body could get past this, anyone who could POST
    // could grant themselves Pro.
    seedOwner();
    mockNotificationRejected();

    const res = await postNotification();

    expect(res.statusCode).toBe(400);
    expect(docStore['users/uid-a']).toBeUndefined();
  });

  test("Apple's transient failure gets a 5xx, so the retry is useful", async () => {
    // RETRYABLE_VERIFICATION_FAILURE is Apple's own "try again" signal and
    // normalises to `unavailable`. Answering 400 to it would discard a valid
    // renewal because a key fetch blipped.
    seedOwner();
    mockNotificationRejected('unavailable');

    const res = await postNotification();

    expect(res.statusCode).toBe(503);
  });

  test('a non-POST request is refused before any verification', async () => {
    mockNotification();
    const res = mockRes();
    await appStoreNotificationsV2._handler({ method: 'GET', body: {} }, res);

    expect(res.statusCode).toBe(405);
    expect(appleJws.verifyNotification).not.toHaveBeenCalled();
  });

  test('a body with no signedPayload is refused', async () => {
    mockNotification();
    const res = await postNotification({});

    expect(res.statusCode).toBe(400);
    expect(appleJws.verifyNotification).not.toHaveBeenCalled();
  });
});

describe('appStoreNotificationsV2 — an unknown subscription', () => {
  test('an unmatched notification asks Apple to RETRY and takes no lock', async () => {
    // WARNING: 503 rather than 200, and deliberately no ledger write. Apple sends
    // SUBSCRIBED at the same moment the client calls verifySubscriptionReceipt,
    // so this is a genuine race that a retry wins once the owner index appears.
    // Taking the lock here would make that retry a no-op and strand the
    // subscriber on the free tier permanently.
    mockNotification();

    const res = await postNotification();

    expect(res.statusCode).toBe(503);
    expect(docStore['processedNotifications/uuid-renew-1']).toBeUndefined();
  });

  test('and the retry succeeds once the purchase has registered its owner', async () => {
    // The control: proving the 503 above is a deferral, not a dead end.
    mockNotification();
    expect((await postNotification()).statusCode).toBe(503);

    seedOwner();
    const retry = await postNotification();

    expect(retry.statusCode).toBe(200);
    expect(docStore['users/uid-a']?.data).toMatchObject({ subscriptionTier: 'pro' });
  });

  test('a TEST notification answers 200 so App Store Connect reports the URL wired', async () => {
    // The console's "Request a Test Notification" button, and the ONLY way to
    // confirm the wiring before a real purchase exists. It carries no
    // transaction and no owner.
    mockNotification({
      notificationType: 'TEST',
      notificationUUID: 'uuid-test-1',
      transaction: null,
    });

    const res = await postNotification();

    expect(res.statusCode).toBe(200);
  });
});

describe('verifySubscriptionReceipt — the owner index', () => {
  test('a purchase records the mapping a later renewal needs', async () => {
    // Without this write the notification endpoint has no route from Apple's
    // payload to a uid at all: `transactionId` changes every renewal and
    // `appAccountToken` is a ONE-WAY uuidv5 of the uid, computable forward and
    // not invertible.
    mockJws({
      productId: 'sub_pro_monthly',
      transactionId: 'tx-original-1',
      originalTransactionId: 'tx-original-1',
      expiresDateMs: Date.now() + NOTIF_MONTH,
    });

    await verifySubscriptionReceipt._handler({
      auth: { uid: 'uid-a' },
      data: { receipt: 'jws', productId: 'sub_pro_monthly' },
    });

    expect(docStore['subscriptionOwners/tx-original-1']?.data).toMatchObject({
      uid: 'uid-a',
      productId: 'sub_pro_monthly',
    });
  });

  test('a purchase and its later renewal resolve to the same account end to end', async () => {
    // The two halves joined: the authenticated purchase writes the index, and
    // the unauthenticated renewal reads it.
    mockJws({
      productId: 'sub_pro_monthly',
      transactionId: 'tx-original-1',
      originalTransactionId: 'tx-original-1',
      expiresDateMs: Date.now() + NOTIF_MONTH,
    });
    await verifySubscriptionReceipt._handler({
      auth: { uid: 'uid-a' },
      data: { receipt: 'jws', productId: 'sub_pro_monthly' },
    });

    mockNotification();
    const res = await postNotification();

    expect(res.statusCode).toBe(200);
    expect(docStore['users/uid-a']?.data).toMatchObject({
      subscriptionTier: 'pro',
      subscriptionExpiresAt: { _type: 'ts', ms: NOTIF_NOW + NOTIF_MONTH },
    });
  });
});

// ---------------------------------------------------------------------------
// claimRetentionPromo — the 5-of-7 free month
//
// The DECISION is tested exhaustively and without Firestore in
// retentionPromo.test.ts. What is tested here is what that file cannot see: the
// bounded query, the once-per-account lock, and the fact that the grant EXTENDS
// an entitlement rather than replacing it.
// ---------------------------------------------------------------------------

const PROMO_DAY = 24 * 60 * 60 * 1000;

/** Seeds `users/uid-a/completions` with one record per day-offset given. */
function seedCompletions(daysAgo: readonly number[], nowMs: number) {
  const today = Math.floor(nowMs / PROMO_DAY);
  for (const d of daysAgo) {
    const ms = (today - d) * PROMO_DAY + 12 * 60 * 60 * 1000;
    seedDoc(`users/uid-a/completions/day-${d}`, {
      taskId: `task-${d}`,
      dayKey: 'ignored-by-the-server',
      loggedAt: { _type: 'ts', ms, toMillis: () => ms },
    });
  }
}

function daysRange(from: number, to: number): number[] {
  const out: number[] = [];
  for (let d = from; d <= to; d++) out.push(d);
  return out;
}

/** 5 of 7 across three windows — qualifying under either reading. */
function seedQualifying(nowMs: number) {
  seedCompletions(
    [...daysRange(0, 4), ...daysRange(7, 11), ...daysRange(14, 18)],
    nowMs,
  );
}

const callPromo = (uid: string | null = 'uid-a') =>
  claimRetentionPromo._handler({ auth: uid ? { uid } : null });

describe('claimRetentionPromo', () => {
  test('a qualifying history is granted one month of pro', async () => {
    const now = Date.now();
    seedQualifying(now);

    const res = await callPromo();

    expect(res.granted).toBe(true);
    expect(res.eligible).toBe(true);
    const user = docStore['users/uid-a']?.data as Record<string, any>;
    expect(user.subscriptionTier).toBe('pro');
    expect(user.proPromoGrantedAt).toBeDefined();
    // 30 days out, give or take the second the test took.
    expect(user.subscriptionExpiresAt.ms).toBeGreaterThan(now + 29 * PROMO_DAY);
    expect(user.subscriptionExpiresAt.ms).toBeLessThan(now + 31 * PROMO_DAY);
  });

  test('🔴 it is granted ONCE PER ACCOUNT, ever', async () => {
    // Firestore rules cannot count across documents and cannot express "only if
    // this has never happened", so the uniqueness is the server's job or it is
    // nobody's. Without it the promo pays every three weeks, forever.
    const now = Date.now();
    seedQualifying(now);

    const first = await callPromo();
    expect(first.granted).toBe(true);
    const firstExpiry = (docStore['users/uid-a']!.data as any).subscriptionExpiresAt.ms;

    const second = await callPromo();

    expect(second.granted).toBe(false);
    expect(second.alreadyGranted).toBe(true);
    expect((docStore['users/uid-a']!.data as any).subscriptionExpiresAt.ms).toBe(firstExpiry);
  });

  test('🔴 a live subscriber gains a month ON TOP and is never shortened', async () => {
    // verifySubscriptionReceipt overwrites subscriptionExpiresAt
    // unconditionally — correct there, because Apple's expiry is the truth for
    // an Apple purchase. Copying that shape here would take someone with three
    // weeks left and leave them with a month.
    const now = Date.now();
    const threeWeeks = now + 21 * PROMO_DAY;
    seedDoc('users/uid-a', {
      displayName: 'Bee',
      subscriptionTier: 'pro',
      subscriptionExpiresAt: { _type: 'ts', ms: threeWeeks, toMillis: () => threeWeeks },
    });
    seedQualifying(now);

    await callPromo();

    const user = docStore['users/uid-a']!.data as Record<string, any>;
    expect(user.subscriptionExpiresAt.ms).toBeGreaterThan(threeWeeks + 29 * PROMO_DAY);
    // …and the document is MERGED, not replaced.
    expect(user.displayName).toBe('Bee');
  });

  test('a history that does not qualify grants nothing and reports progress', async () => {
    const now = Date.now();
    seedCompletions([0, 1, 2], now);

    const res = await callPromo();

    expect(res.granted).toBe(false);
    expect(res.eligible).toBe(false);
    expect(res.shortfall).toBeGreaterThan(0);
    expect(res.windows).toHaveLength(3);
    // Nothing was written at all — not even an empty user document.
    expect(docStore['users/uid-a']).toBeUndefined();
  });

  test('🔴 the query is BOUNDED — ancient records are never READ, not merely ignored', async () => {
    // The collection has NO TTL and is never pruned, so the full-collection
    // shape used elsewhere (`db.collection(...).get()`, index.ts) would read a
    // player's entire history to answer a 21-day question.
    //
    // WARNING: THIS ASSERTS THE READ, NOT THE OUTCOME, and the distinction is the
    // whole test. An earlier version checked only that ancient records did not
    // COUNT — which `evaluatePromo` guarantees by itself — so deleting the
    // `where` clause left it green. `queryReads` measures what came back.
    const now = Date.now();
    seedCompletions(daysRange(100, 130), now);

    const res = await callPromo();

    expect(queryReads).toEqual([0]);
    expect(res.activeDays).toBe(0);
    expect(res.eligible).toBe(false);
  });

  test('the bounded query still reads everything INSIDE the window', async () => {
    // The control for the test above. A `where` clause that matched nothing at
    // all would satisfy `queryReads == [0]` while breaking the feature outright.
    const now = Date.now();
    seedQualifying(now);

    await callPromo();

    expect(queryReads).toEqual([15]);
  });

  test('🔴 dayKey is ignored — a moved device clock cannot manufacture a habit', async () => {
    // Every seeded record carries `dayKey: 'ignored-by-the-server'`, which is
    // the field the client supplies and the one an entitlement must never
    // trust. Eligibility here comes from `loggedAt` alone; if the callable ever
    // read dayKey, these 21 same-day records would all collapse to one bogus
    // day and this history would stop qualifying.
    const now = Date.now();
    seedQualifying(now);

    const res = await callPromo();

    expect(res.granted).toBe(true);
    expect(res.activeDays).toBe(15);
  });

  test('an unauthenticated call is refused before anything is read', async () => {
    await expect(callPromo(null)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(_db.collection).not.toHaveBeenCalled();
  });

  test('an account with no completions at all is handled, not thrown at', async () => {
    const res = await callPromo();
    expect(res.granted).toBe(false);
    expect(res.activeDays).toBe(0);
    expect(res.windows).toEqual([0, 0, 0]);
  });
});

// ---------------------------------------------------------------------------
// getPlantDirectory — the server-side house-plant directory
//
// The directory's own invariants and the lookup are tested without Firestore in
// plantDirectory.test.ts. What is tested here is the half that file cannot see:
// which SOURCE wins, and what happens when the console override is wrong.
// ---------------------------------------------------------------------------

const callPlants = (data: any = {}, uid: string | null = 'uid-a') =>
  getPlantDirectory._handler({ auth: uid ? { uid } : null, data });

describe('getPlantDirectory', () => {
  test('serves the bundled directory when nothing is configured', async () => {
    // KEY: THE DEFAULT PATH, and the one that matters most. A hand-seeded config
    // document that nothing writes is a trap this repo has fallen into twice —
    // shopConfig/weeklyOffers was never seeded in production and rotation
    // warned and returned every Monday, and the unseeded `items` collection
    // dead-ended orientation. A deploy must be sufficient.
    const res = await callPlants();

    expect(res.source).toBe('bundled');
    expect(res.plants.length).toBeGreaterThanOrEqual(15);
  });

  test('a populated override WINS, so a wrong interval is fixable without a release', async () => {
    seedDoc('plantConfig/directory', {
      plants: [
        {
          id: 'fern',
          commonName: 'Fern',
          aliases: ['fern'],
          wateringIntervalDays: 3,
          wateringIntervalRange: [2, 5],
          light: 'medium',
          note: 'thirsty',
        },
      ],
    });

    const res = await callPlants();

    expect(res.source).toBe('plantConfig/directory');
    expect(res.plants).toHaveLength(1);
    expect(res.plants[0].id).toBe('fern');
  });

  test('🔴 an INVALID override is refused and the bundled list is served instead', async () => {
    // The override is edited in the Firebase console, so it passes through no
    // test, no review and no deploy — the moment it is read is the only moment
    // it can be judged. Two species answering to one alias would otherwise
    // reach a player as a confident number for the wrong plant.
    //
    // It falls back rather than throwing: a stale-but-sane interval is better
    // for the plant than an error screen, and the bad console edit is not the
    // player's problem.
    seedDoc('plantConfig/directory', {
      plants: [
        {
          id: 'fern',
          commonName: 'Fern',
          aliases: ['green one'],
          wateringIntervalDays: 3,
          wateringIntervalRange: [2, 5],
          light: 'medium',
          note: '',
        },
        {
          id: 'cactus',
          commonName: 'Cactus',
          aliases: ['green one'],
          wateringIntervalDays: 21,
          wateringIntervalRange: [14, 28],
          light: 'direct',
          note: '',
        },
      ],
    });

    const res = await callPlants();

    expect(res.source).toBe('bundled');
    expect(res.plants.length).toBeGreaterThanOrEqual(15);
  });

  test('resolves a spoken plant name against whichever source won', async () => {
    const res = await callPlants({ query: "Devil's Ivy" });
    expect(res.match?.id).toBe('pothos');
    expect(res.match?.wateringIntervalDays).toBeGreaterThan(0);
  });

  test('the lookup runs against the OVERRIDE, not the bundled list', async () => {
    // Otherwise a corrected interval would be served in `plants` and ignored by
    // `match` — the same number disagreeing with itself in one response.
    seedDoc('plantConfig/directory', {
      plants: [
        {
          id: 'pothos',
          commonName: 'Pothos',
          aliases: ['devils ivy'],
          wateringIntervalDays: 99,
          wateringIntervalRange: [90, 100],
          light: 'medium',
          note: 'corrected',
        },
      ],
    });

    const res = await callPlants({ query: "devil's ivy" });

    expect(res.source).toBe('plantConfig/directory');
    expect(res.match?.wateringIntervalDays).toBe(99);
  });

  test('an unknown plant returns a null match, not an error', async () => {
    const res = await callPlants({ query: 'triffid' });
    expect(res.match).toBeNull();
    expect(res.plants.length).toBeGreaterThan(0);
  });

  test('a missing or non-string query returns the directory with no match', async () => {
    expect((await callPlants({})).match).toBeNull();
    expect((await callPlants({ query: 42 })).match).toBeNull();
  });

  test('an unauthenticated call is refused', async () => {
    await expect(callPlants({}, null)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: W2-79 — the family entitlement fan-out, driven through the real handler
// ---------------------------------------------------------------------------
//
// W2-76 left the residual in its own header: `familyProExpiresAt` is the
// owner's expiry COPIED, so natural expiry lapses every member's grant on the
// clock with no writer required — but a REFUND moves the expiry BACKWARDS and a
// copy made yesterday does not know. These drive `appStoreNotificationsV2`
// end to end rather than the plan function, because the plan was already
// green while the path to it was inert.
//
// CRITICAL: AND THAT IS NOT HYPOTHETICAL. `sub_family_monthly` was missing from
// SUBSCRIPTION_PRODUCT_TIERS, so `effectOf` classified EVERY family
// notification as `ignore` — "not a subscription product" — before it ever
// looked at the type. The fan-out could not have fired once, and every test
// that built a `SubscriptionEffect` by hand passed anyway. Only the tests that
// went through the real classifier went red.
describe('appStoreNotificationsV2 — the family fan-out', () => {
  const OWNER = 'uid-family-owner';
  const KID = 'uid-family-kid';
  const OTHER_OWNER = 'uid-other-owner';
  const OTHER_KID = 'uid-other-kid';

  function seedFamilies() {
    // CRITICAL: THE DECOY IS SEEDED FIRST, AND THE ORDER IS LOAD-BEARING — it is the
    // only reason the cross-family control below can fail.
    //
    // The read is `.where('ownerUid', '==', uid).limit(1)`, and the fake
    // returns matches in insertion order. With `fam-ours` seeded first,
    // `.limit(1)` hands back the RIGHT family whether or not the `where` is
    // there at all: deleting the scoping predicate outright left the entire
    // 990-test suite green, this control included. The control was passing on
    // seeding order, not on the query being scoped — it asserted nothing about
    // the one line that makes a family selection correct.
    //
    // Seeded decoy-first, the same deletion turns this describe block red.
    // Verified by mutation both ways: scoping intact + this order → green;
    // scoping removed + this order → 4 red, including this control.
    //
    // KEY: A control over a QUERY has to be seeded so the wrong query returns the
    // wrong row. Two rows where the right one happens to be first is a fixture
    // that cannot distinguish the predicate from the ordering.
    seedDoc('families/fam-theirs', {
      ownerUid: OTHER_OWNER,
      memberUids: [OTHER_OWNER, OTHER_KID],
      createdAtMs: 1,
    });
    seedDoc('families/fam-ours', {
      ownerUid: OWNER,
      memberUids: [OWNER, KID],
      createdAtMs: 1,
    });
    // Both families are currently entitled, paid through a month out.
    for (const uid of [OWNER, KID, OTHER_OWNER, OTHER_KID]) {
      seedDoc(`users/${uid}`, {
        familyProExpiresAt: { _type: 'ts', ms: NOTIF_NOW + NOTIF_MONTH },
      });
    }
  }

  const familyTx = (over: Record<string, unknown> = {}) => ({
    productId: 'sub_family_monthly',
    ...over,
  });

  test('🔴 THE RESIDUAL, CLOSED: a family REFUND revokes every member', async () => {
    seedFamilies();
    seedDoc('subscriptionOwners/tx-original-1', {
      uid: OWNER,
      productId: 'sub_family_monthly',
    });
    mockNotification({
      notificationType: 'REFUND',
      notificationUUID: 'uuid-family-refund',
      transaction: familyTx({revocationDateMs: NOTIF_NOW}),
    });

    const res = await postNotification();
    expect(res.statusCode).toBe(200);

    // The owner AND the kid, both cleared — not merely the account Apple named.
    expect(docStore[`users/${OWNER}`]?.data?.familyProExpiresAt).toBeNull();
    expect(docStore[`users/${KID}`]?.data?.familyProExpiresAt).toBeNull();
  });

  test('🔴 CONTROL: a member of a DIFFERENT family is untouched', async () => {
    seedFamilies();
    seedDoc('subscriptionOwners/tx-original-1', {
      uid: OWNER,
      productId: 'sub_family_monthly',
    });
    mockNotification({
      notificationType: 'REFUND',
      notificationUUID: 'uuid-family-refund-2',
      transaction: familyTx({revocationDateMs: NOTIF_NOW}),
    });

    await postNotification();

    // The other family paid for their own subscription and nobody refunded it.
    for (const uid of [OTHER_OWNER, OTHER_KID]) {
      const held = docStore[`users/${uid}`]?.data?.familyProExpiresAt as
        | {ms: number}
        | null;
      expect(held?.ms).toBe(NOTIF_NOW + NOTIF_MONTH);
    }
  });

  test('🔴 CONTROL: a normal RENEWAL does not revoke — it extends', async () => {
    // Without this, "revokes on refund" and "revokes on any notification" are
    // the same test.
    seedFamilies();
    seedDoc('subscriptionOwners/tx-original-1', {
      uid: OWNER,
      productId: 'sub_family_monthly',
    });
    mockNotification({
      notificationType: 'DID_RENEW',
      notificationUUID: 'uuid-family-renew',
      transaction: familyTx({expiresDateMs: NOTIF_NOW + 2 * NOTIF_MONTH}),
    });

    await postNotification();

    // Compared by VALUE rather than by object identity: a written timestamp
    // carries the fake's `toMillis`, a seeded one does not, and asserting the
    // whole object would be testing the shape of the double.
    for (const uid of [OWNER, KID]) {
      const written = docStore[`users/${uid}`]?.data?.familyProExpiresAt as
        | {ms: number}
        | null;
      expect(written?.ms).toBe(NOTIF_NOW + 2 * NOTIF_MONTH);
    }
  });

  test('🔴 CONTROL: a refund of the owner\'s PERSONAL pro leaves the family alone', async () => {
    // Two subscriptions, one person. Sharper than "a different family": the
    // refunded account IS the family owner, and the family must survive.
    seedFamilies();
    seedDoc('subscriptionOwners/tx-original-1', {
      uid: OWNER,
      productId: 'sub_pro_monthly',
    });
    mockNotification({
      notificationType: 'REFUND',
      notificationUUID: 'uuid-personal-refund',
      transaction: {productId: 'sub_pro_monthly', revocationDateMs: NOTIF_NOW},
    });

    await postNotification();

    // Personal entitlement gone...
    expect(docStore[`users/${OWNER}`]?.data?.subscriptionTier).toBe('free');
    // ...family grant untouched, for the owner and the kid alike.
    for (const uid of [OWNER, KID]) {
      const held = docStore[`users/${uid}`]?.data?.familyProExpiresAt as
        | {ms: number}
        | null;
      expect(held?.ms).toBe(NOTIF_NOW + NOTIF_MONTH);
    }
  });

  test('a subscriber who owns NO family is handled without error', async () => {
    // The common case for every existing user, and the one that would 500 at
    // Apple if the query result were assumed non-empty.
    seedOwner();
    mockNotification();

    const res = await postNotification();

    expect(res.statusCode).toBe(200);
    expect(docStore['users/uid-a']?.data).toMatchObject({subscriptionTier: 'pro'});
    expect(docStore['users/uid-a']?.data?.familyProExpiresAt).toBeUndefined();
  });

  test('🔴 the fan-out shares the notification lock, so a retry is a no-op', async () => {
    // Deliberately NOT given its own ledger key — see the block in index.ts.
    // The lock and the fan-out commit in one transaction, so a redelivery
    // returns `duplicate` having already applied the revoke exactly once.
    seedFamilies();
    seedDoc('subscriptionOwners/tx-original-1', {
      uid: OWNER,
      productId: 'sub_family_monthly',
    });
    mockNotification({
      notificationType: 'REFUND',
      notificationUUID: 'uuid-family-retry',
      transaction: familyTx({revocationDateMs: NOTIF_NOW}),
    });

    await postNotification();
    expect(docStore[`users/${KID}`]?.data?.familyProExpiresAt).toBeNull();

    // Apple redelivers the identical notification.
    const second = await postNotification();
    expect(second.statusCode).toBe(200);
    expect(docStore[`users/${KID}`]?.data?.familyProExpiresAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: W2-156 — THE APPLE FAMILY SHARING RECIPIENT: THE FAMILY PRODUCT WITH NO
// SQUEEEKS FAMILY AT ALL
// ---------------------------------------------------------------------------
//
// TWO MEMBERSHIP GRAPHS, TWO CAPS, AND THEY ARE NOT THE SAME GRAPH. Apple
// Family Sharing is ON for `sub_family_monthly` (Apple ID 6801924400, verified
// in App Store Connect 2026-08-24), so Apple hands the subscription to everyone
// in the PURCHASER'S APPLE FAMILY — up to 6, organiser included — and each of
// them gets a transaction under their own Apple account. The Squeeeks family is
// a different set of people, capped at FAMILY_CAP (5), and it only exists if
// somebody built one in-app.
//
// KEY: SO THIS SHAPE IS NOT AN EDGE CASE, IT IS A PAYING CUSTOMER: an account
// holding `sub_family_monthly` that never purchased it and belongs to NO
// Squeeeks family. They must be Pro. Nothing about an in-app family should be
// required for that, because Apple already decided they are entitled.
//
// WARNING: WHY IT WAS UNTESTED RATHER THAN UNREACHABLE. Every pre-existing
// `sub_family_monthly` notification test calls `seedFamilies()` first
// (:1673, :1694, :1719, :1787), and the one test that constructs "subscriber
// owning NO family" (:1770) hardcodes `sub_pro_monthly` through both
// `mockNotification` (:972) and `seedOwner` (:1013). Right shape, wrong
// product — the two halves have never been held at once.
//
// KEY: THE BEHAVIOUR IS CORRECT TODAY, AND IT IS CORRECT BY ORDERING. The tier
// write (index.ts:1828) is UNCONDITIONAL and comes FIRST; the family lookup
// (index.ts:1882) is `if (ownedFamily)` — A SKIP, NOT A REFUSAL — and comes
// after. These tests buy that ordering, which no existing assertion can see.
//
// NOTE: NOT the same surface as `CRITICAL: W2-90 Family Sharing and the account boundary`
// below. That block drives `verifyIapAndGrant` over a CONSUMABLE
// (`sponge_pack_100`) and is about `appAccountToken`; this one drives
// `appStoreNotificationsV2` over the SUBSCRIPTION. Neither covers the other.

describe('🔴 W2-156 Apple Family Sharing recipient — family product, NO family', () => {
  const RECIPIENT = 'uid-shared-recipient';

  /**
   * The recipient's own owner-index entry. `verifySubscriptionReceipt` writes
   * one of these per originalTransactionId, and a family-shared subscription
   * gives the recipient their OWN original transaction — which is exactly why
   * the server can attribute the notification to them at all.
   */
  function seedSharedRecipient() {
    seedDoc('subscriptionOwners/tx-shared-original', {
      uid: RECIPIENT,
      productId: 'sub_family_monthly',
    });
  }

  const sharedNotification = (over: Record<string, unknown> = {}) =>
    mockNotification({
      notificationType: 'SUBSCRIBED',
      notificationUUID: 'uuid-shared-recipient',
      transaction: {
        productId: 'sub_family_monthly',
        originalTransactionId: 'tx-shared-original',
        transactionId: 'tx-shared-1',
        ...over,
      },
    });

  test('🔴 THE FIXTURE: sub_family_monthly with ZERO families still grants Pro', async () => {
    seedSharedRecipient();
    sharedNotification();

    const res = await postNotification();

    expect(res.statusCode).toBe(200);
    expect(docStore[`users/${RECIPIENT}`]?.data).toMatchObject({
      subscriptionTier: 'pro',
      subscriptionProductId: 'sub_family_monthly',
      subscriptionExpiresAt: {_type: 'ts', ms: NOTIF_NOW + NOTIF_MONTH},
    });
  });

  test('🔴 CONTROL: no family exists, so nothing is fanned out to anybody', async () => {
    // Without this, "the recipient is Pro" and "the recipient was granted a
    // family copy of somebody's entitlement" are the same green. The entitlement
    // here must come from `subscriptionTier`, NOT from `familyProExpiresAt` —
    // they are two different sources of Pro and only one of them is right here.
    seedSharedRecipient();
    sharedNotification();

    await postNotification();

    expect(docStore[`users/${RECIPIENT}`]?.data?.familyProExpiresAt).toBeUndefined();
    expect(
      Object.keys(docStore).filter((k) => k.startsWith('families/')),
    ).toEqual([]);
  });

  test('🔴 CONTROL: the SAME notification with a family owned DOES fan out', async () => {
    // The decoy that makes the first two tests mean something. Identical
    // product, identical notification, one difference — the recipient owns a
    // Squeeeks family — and now the fan-out runs. Without it, a mutation that
    // disabled the fan-out entirely would leave all of the above green.
    seedSharedRecipient();
    seedDoc('families/fam-shared', {
      ownerUid: RECIPIENT,
      memberUids: [RECIPIENT, 'uid-shared-kid'],
      createdAtMs: 1,
    });
    sharedNotification();

    await postNotification();

    for (const uid of [RECIPIENT, 'uid-shared-kid']) {
      const written = docStore[`users/${uid}`]?.data?.familyProExpiresAt as
        | {ms: number}
        | null;
      expect(written?.ms).toBe(NOTIF_NOW + NOTIF_MONTH);
    }
  });

  test('📌 a RENEWAL of the shared subscription with no family also lands', async () => {
    // SUBSCRIBED arrives once; DID_RENEW arrives every month for the life of
    // the subscription and is the notification this account actually depends
    // on. Same shape, different type, because ENTITLING_TYPES is a set and a
    // regression could plausibly touch one member of it.
    seedSharedRecipient();
    mockNotification({
      notificationType: 'DID_RENEW',
      notificationUUID: 'uuid-shared-renew',
      transaction: {
        productId: 'sub_family_monthly',
        originalTransactionId: 'tx-shared-original',
        transactionId: 'tx-shared-2',
        expiresDateMs: NOTIF_NOW + 2 * NOTIF_MONTH,
      },
    });

    const res = await postNotification();

    expect(res.statusCode).toBe(200);
    expect(docStore[`users/${RECIPIENT}`]?.data).toMatchObject({
      subscriptionTier: 'pro',
      subscriptionExpiresAt: {_type: 'ts', ms: NOTIF_NOW + 2 * NOTIF_MONTH},
    });
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: W2-86 — a joiner is entitled AT THE MOMENT THEY JOIN
// ---------------------------------------------------------------------------
//
// THE DEFECT THIS FILE NOW GUARDS, and it shipped green in W2-83:
// `familyProExpiresAt` had exactly two writers — the notification fan-out and
// the departure revoke — and joinFamily wrote NEITHER. A member who joined
// received nothing until the owner's next DID_RENEW, up to a full billing month
// of a paid-for member getting nothing.
//
// KEY: THESE TESTS MUST FAIL AGAINST THE CODE AS IT STOOD BEFORE THIS PR. That is
// the known-positive: a test for a missing write that passes against the
// version without the write is testing nothing. Verified by deleting the new
// tx.set and watching them go red.

describe('🔴 W2-86 joinFamily grants the entitlement immediately', () => {
  const OWNER = 'uid-fam-owner';
  const JOINER = 'uid-fam-joiner';
  const FAMILY_ID = 'fam-1';
  const CODE = 'ABCDEFGHJK';
  const NOW = Date.now();
  const MONTH = 30 * 24 * 60 * 60 * 1000;
  const OWNER_EXPIRY = NOW + MONTH;

  function seedFamilyWorld(ownerOver: Record<string, unknown> = {}) {
    seedDoc(`familyInvites/${CODE}`, {
      familyId: FAMILY_ID,
      ownerUid: OWNER,
      createdAtMs: NOW,
      expiresAtMs: NOW + 45_000,
    });
    seedDoc(`families/${FAMILY_ID}`, {
      ownerUid: OWNER,
      memberUids: [OWNER],
      createdAtMs: NOW,
    });
    seedDoc(`users/${OWNER}`, {
      subscriptionTier: 'pro',
      subscriptionProductId: 'sub_family_monthly',
      subscriptionExpiresAt: OWNER_EXPIRY,
      familyId: FAMILY_ID,
      ...ownerOver,
    });
    seedDoc(`users/${JOINER}`, {subscriptionTier: 'free'});
  }

  const join = () => joinFamily._handler({auth: {uid: JOINER}, data: {code: CODE}});

  test('🔴 THE DEFECT: the joiner has familyProExpiresAt right after joining', () => {
    seedFamilyWorld();
    return join().then(() => {
      const granted = docStore[`users/${JOINER}`]?.data?.familyProExpiresAt as
        | {ms: number}
        | undefined;
      expect(granted).toBeDefined();
      expect(granted?.ms).toBe(OWNER_EXPIRY);
    });
  });

  test('🔴 the expiry is the owner\'s COPIED, never EXTENDED', () => {
    // The property that makes the grant fail closed on the clock with no writer
    // required. A member must never outlive the period the owner paid for.
    seedFamilyWorld();
    return join().then(() => {
      const granted = docStore[`users/${JOINER}`]?.data?.familyProExpiresAt as {ms: number};
      expect(granted.ms).toBe(OWNER_EXPIRY);
      expect(granted.ms).not.toBeGreaterThan(OWNER_EXPIRY);
    });
  });

  test('the roster and familyId are still written — the grant did not replace them', () => {
    seedFamilyWorld();
    return join().then(() => {
      expect(docStore[`families/${FAMILY_ID}`]?.data?.memberUids).toEqual([OWNER, JOINER]);
      expect(docStore[`users/${JOINER}`]?.data?.familyId).toBe(FAMILY_ID);
      // Single-use: the invite is gone.
      expect(docStore[`familyInvites/${CODE}`]).toBeUndefined();
    });
  });

  test('🔴 CONTROL — a LAPSED owner grants nothing', () => {
    // Without this, writing the owner's expiry unconditionally would pass every
    // test above while entitling members of an unpaid family.
    seedFamilyWorld({subscriptionExpiresAt: NOW - 1});
    return join().then(() => {
      const granted = docStore[`users/${JOINER}`]?.data?.familyProExpiresAt;
      expect(granted).toBeNull();
    });
  });

  test('🔴 CONTROL — an owner on a PERSONAL pro grants nothing, and now so does the gate', () => {
    // NOTE: THE OPEN QUESTION THIS TEST PINNED IS CLOSED (W2-177, Brendan
    // 2026-09-04). It used to read: "planFamilyCreation ACCEPTS a personal Pro
    // owner, but the fan-out grants only for the FAMILY product, so such an
    // owner can create a family that entitles nobody. Which side moves is a
    // pricing decision and is Brendan's." The CREATE GATE moved: it now refuses
    // a personal Pro with `needs-family-subscription`.
    //
    // KEY: THE ASSERTION BELOW IS UNCHANGED AND STILL LOAD-BEARING. It is about
    // the FAN-OUT, which did not move, and it is the reason the two halves now
    // agree rather than a restatement of the gate. It also still covers the
    // families created BEFORE the ruling, whose owners hold a personal Pro and
    // must keep granting nothing.
    seedFamilyWorld({subscriptionProductId: 'sub_pro_monthly'});
    return join().then(() => {
      expect(docStore[`users/${JOINER}`]?.data?.familyProExpiresAt).toBeNull();
    });
  });

  test('🔴 CONTROL — the owner\'s OWN grant is not the source, or families chain', () => {
    // An owner who is themselves a member of ANOTHER family carries a copied
    // familyProExpiresAt. Granting off that would entitle a second family from
    // the first family's subscription, with no payer in the chain beyond the
    // first. resolveOwnPaidExpiryMs reads only what the owner PAYS for.
    seedFamilyWorld({
      subscriptionTier: 'free',
      subscriptionExpiresAt: null,
      familyProExpiresAt: OWNER_EXPIRY + MONTH,
    });
    return join().then(() => {
      expect(docStore[`users/${JOINER}`]?.data?.familyProExpiresAt).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: W2-90 — FAMILY SHARING, and the boundary that will refuse it on a date
//            somebody chooses
// ---------------------------------------------------------------------------
//
// Brendan: "the sub faimly already has family sharing on for pro in the app
// store connect. everyone in the faminly gets pro." So Apple's own sharing is a
// SECOND, live grant path — the family spec recorded it as OFF, and it is not.
//
// ---------------------------------------------------------------------------
// THE LOAD-BEARING FACT, AND WHERE IT COMES FROM
// ---------------------------------------------------------------------------
//
// Everything turns on what Apple puts in `appAccountToken` on a family-shared
// transaction, because `assertAccountBoundary` compares exactly that field.
//
// NOTE: APPLE'S DOCUMENTATION SAYS IT IS NOT THERE: "If your app supports Family
// Sharing, note that appAccountToken is not available for family shared
// transactions", and the same pages direct you to `appTransactionId` instead.
//
// WARNING: PROVENANCE, STATED BECAUSE THIS WHOLE BRIEF IS ABOUT LABELLING RELAYS:
// developer.apple.com renders its docs client-side, so a fetch of those pages
// returns the title and no body. That sentence comes from the SEARCH INDEX of
// Apple's own pages, corroborated across two independent queries — not from
// reading the page. It is Apple's wording; it is not first-hand. The tests
// below therefore do not RELY on it: they pin what OUR code does for each
// possible shape, so the behaviour is established either way.
//
// ---------------------------------------------------------------------------
// CRITICAL: THE HYPOTHESIS IN THE BRIEF IS WRONG, AND THE INVERSE IS THE FINDING
// ---------------------------------------------------------------------------
//
// The brief expected family members to be REFUSED today — Apple grants the
// household, our boundary throws `permission-denied`. That is not what happens.
// A family-shared transaction carries NO token, and a null token falls through
// `accountTokenRollout` (`epochMs: null`, shipped disabled). So the family
// member IS granted — BY THE COMPATIBILITY BRANCH, which is exactly the "it may
// already work by accident" case the brief told me to check first.
//
// CRITICAL: AND THAT IS A LANDMINE RATHER THAN A RELIEF. `purchaseAccountToken.ts:24`
// instructs the next person to "Set it to the release date of the first stamped
// build once that build is actually live". The moment somebody follows that
// written instruction, EVERY FAMILY-SHARED TRANSACTION STARTS BEING REFUSED —
// they carry no token and their purchase dates are after any such epoch. The
// third test below is that future, run today.

describe('🔴 W2-90 Family Sharing and the account boundary', () => {
  const PURCHASER = 'uid-parent';
  const MEMBER = 'uid-child';

  // WARNING: Re-declared rather than hoisted: `call` lives inside the
  // `verifyIapAndGrant` describe above and is not in scope here. Appending a
  // block that referenced it compiled under `tsc --noEmit` (which does not
  // include this file's project) and failed under ts-jest as
  // `Tests: 0 total` — a suite that does not COMPILE reports zero tests, which
  // reads exactly like green. Seventh sighting of that shape this session.
  const call = (data: unknown, uid?: string) =>
    verifyIapAndGrant._handler({auth: uid ? {uid} : null, data});

  test('🔴 TODAY: a family-shared transaction (NO token) GRANTS the member', () => {
    // The brief's hypothesis said this would be permission-denied. It is not:
    // the null-token compatibility branch grants it. Established by driving the
    // real callable, never a hand-built effect — the W2-79 lesson.
    mockJws({
      productId: 'sponge_pack_100',
      transactionId: 'tx-family-shared',
      appAccountToken: null,
    });

    return call({receipt: 'shared', productId: 'sponge_pack_100'}, MEMBER).then((res) => {
      expect(res.granted.sponges).toBe(100);
    });
  });

  test('🔴 CONTROL — the purchaser\'s token on a DIFFERENT caller IS refused', () => {
    // The brief's hypothesis, tested on its own terms. It is TRUE as a rule —
    // it is simply not the shape a family-shared transaction has, because the
    // token is absent rather than the purchaser's.
    mockJws({
      productId: 'sponge_pack_100',
      transactionId: 'tx-purchaser-token',
      appAccountToken: purchaseTokenForUid(PURCHASER),
    });

    return expect(
      call({receipt: 'shared', productId: 'sponge_pack_100'}, MEMBER),
    ).rejects.toMatchObject({code: 'permission-denied'});
  });

  test('🔴🔴 THE LANDMINE: enabling the rollout REFUSES every family-shared grant', () => {
    // `purchaseAccountToken.ts` tells the next person to set this epoch once the
    // stamped build is live. Doing so turns the compatibility hole into a
    // refusal — and takes Family Sharing with it, silently, because a shared
    // transaction has no token to present.
    //
    // KEY: THIS IS THE FINDING. It is not broken today; it breaks on a date
    // somebody chooses on purpose, for a reason unrelated to families.
    accountTokenRollout.epochMs = 1_000;
    mockJws({
      productId: 'sponge_pack_100',
      transactionId: 'tx-family-shared-after-epoch',
      appAccountToken: null,
      purchaseDateMs: 2_000,
    });

    return expect(
      call({receipt: 'shared', productId: 'sponge_pack_100'}, MEMBER),
    ).rejects.toMatchObject({code: 'permission-denied'});
  });

  test('📌 and the purchaser themselves is unaffected by that epoch', () => {
    // The control that shows the landmine is specific to SHARED transactions:
    // a stamped purchase from the buyer still grants after the cutoff, so
    // enabling the rollout looks entirely safe from the buyer's side.
    accountTokenRollout.epochMs = 1_000;
    mockJws({
      productId: 'sponge_pack_100',
      transactionId: 'tx-purchaser-after-epoch',
      appAccountToken: purchaseTokenForUid(PURCHASER),
      purchaseDateMs: 2_000,
    });

    return call({receipt: 'own', productId: 'sponge_pack_100'}, PURCHASER).then((res) => {
      expect(res.granted.sponges).toBe(100);
    });
  });

  test('📌 nothing in the backend reads inAppOwnershipType', () => {
    // Recorded as a fact rather than fixed: our code cannot currently tell a
    // family-shared transaction from a purchased one at all. Apple distinguishes
    // them with `inAppOwnershipType` (PURCHASED / FAMILY_SHARED); the only
    // occurrence in this repo is a test fixture. Any future branch — including
    // exempting shared transactions from the rollout — needs this field first.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'index.ts'),
      'utf8',
    );
    expect(src).not.toContain('inAppOwnershipType');
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: W2-163 — THE FAMILY THE BUYER ALREADY HAS
// ---------------------------------------------------------------------------
//
// A player buys `sub_family_monthly` and someone ALREADY in their family gets
// nothing. Not a race and not an edge case — the ordinary "invite your household
// first, upgrade later" path.
//
// Before this, `planFamilyFanOut` had exactly TWO callers and the purchase
// verifier was neither: `joinFamily`, which has already run for an existing
// member, and `appStoreNotificationsV2`, whose last mile is not wired — the ASC
// Server Notifications URL has never been confirmed registered. So an existing
// member got `familyProExpiresAt` from NEITHER route.
//
// OK: Brendan, 2026-08-30: fan out to existing members on purchase.
//
// KEY: THE DECOY FAMILY IS SEEDED FIRST, AND THE ORDER IS LOAD-BEARING — the same
// lesson the notification block above this file already paid for. The read is
// `.where('ownerUid','==',uid).limit(1)` and the fake returns matches in
// insertion order, so with the RIGHT family seeded first `.limit(1)` hands it
// back whether or not the `where` is there at all. Seeded decoy-first, deleting
// the scoping predicate turns these red.
describe('🔴 W2-163 the buyer already has a family', () => {
  const call = (data: any, uid?: string) =>
    verifySubscriptionReceipt._handler({auth: uid ? {uid} : null, data});

  const BUYER = 'uid-fam-buyer';
  const MEMBER = 'uid-fam-member';
  const DECOY_OWNER = 'uid-decoy-owner';
  const DECOY_MEMBER = 'uid-decoy-member';
  const MONTH = 30 * 24 * 3600 * 1000;

  /** The world in which the buyer invited their household BEFORE upgrading. */
  function seedFamilyBuiltBeforeTheUpgrade() {
    seedDoc('families/fam-decoy', {
      ownerUid: DECOY_OWNER,
      memberUids: [DECOY_OWNER, DECOY_MEMBER],
      createdAtMs: 1,
    });
    seedDoc('families/fam-buyer', {
      ownerUid: BUYER,
      memberUids: [BUYER, MEMBER],
      createdAtMs: 1,
    });
  }

  const buyFamily = (expiresDateMs: number, transactionId = 'tx-fam-1') => {
    mockJws({productId: 'sub_family_monthly', transactionId, expiresDateMs});
    return call({receipt: 'r', productId: 'sub_family_monthly'}, BUYER);
  };

  const grantedTo = (uid: string) =>
    (docStore[`users/${uid}`]?.data as any)?.familyProExpiresAt;

  test('🔴 THE DEFECT: a member already in the family when the owner buys gets Pro', async () => {
    seedFamilyBuiltBeforeTheUpgrade();
    const expiry = Date.now() + MONTH;

    const res = await buyFamily(expiry);

    expect(res.success).toBe(true);
    // The whole point: MEMBER joined before the purchase and was never touched
    // by joinFamily's grant, because joinFamily had already run.
    expect(grantedTo(MEMBER)?.ms).toBe(expiry);
  });

  test('the buyer is a member of their own family and is granted too', async () => {
    // `memberUids` includes the owner, so the fan-out plans for them as well.
    // Their Pro comes from `subscriptionTier` either way; this asserts the plan
    // is not silently skipping a subject.
    seedFamilyBuiltBeforeTheUpgrade();
    const expiry = Date.now() + MONTH;

    await buyFamily(expiry);

    expect(grantedTo(BUYER)?.ms).toBe(expiry);
  });

  test('🔴 CONTROL: a member of a DIFFERENT family is untouched', async () => {
    // Without this, a fan-out that ignored `ownerUid` and granted to every
    // family in the collection would pass every test above.
    seedFamilyBuiltBeforeTheUpgrade();

    await buyFamily(Date.now() + MONTH);

    expect(grantedTo(DECOY_MEMBER)).toBeUndefined();
    expect(grantedTo(DECOY_OWNER)).toBeUndefined();
  });

  test('🔴 CONTROL: buying a PERSONAL pro does NOT revoke the family', async () => {
    // CRITICAL: THE ONE THAT WOULD HAVE BEEN A DISASTER, and the reason this call site
    // uses `planFamilyFanOutForEffect` rather than `planFamilyFanOut` directly.
    // `planFamilyFanOut` plans a REVOKE for every subject whenever
    // `ownerHasFamilySubscription` is false — one function that both grants and
    // revokes, with that flag choosing. Called directly here, a family owner
    // renewing their personal `sub_pro_monthly` would have written
    // `familyProExpiresAt: null` for every member and stripped the family the
    // moment they bought anything else. The `ForEffect` wrapper returns `[]` for
    // any product that is not FAMILY_PRODUCT_ID, so the wrong product writes
    // NOTHING rather than a revoke.
    seedFamilyBuiltBeforeTheUpgrade();
    seedDoc(`users/${MEMBER}`, {
      familyProExpiresAt: {_type: 'ts', ms: Date.now() + MONTH, toMillis: () => 0},
    });

    mockJws({
      productId: 'sub_pro_monthly',
      transactionId: 'tx-personal-1',
      expiresDateMs: Date.now() + MONTH,
    });
    const res = await call({receipt: 'r', productId: 'sub_pro_monthly'}, BUYER);

    expect(res.success).toBe(true);
    // Untouched — NOT null. A revoke would have written null here.
    expect(grantedTo(MEMBER)).not.toBeNull();
    expect(grantedTo(MEMBER)?.ms).toBeGreaterThan(Date.now());
  });

  test('🔑 A PURCHASE NEVER PLANS A REVOKE FOR A CURRENT MEMBER', async () => {
    // The brief asked this as an open question: `family.ts:124` says a revoke
    // plan is how a lapse is handled, so a purchase producing one would be a
    // second defect. It does not — `entitled` requires a live FAMILY product and
    // a future expiry, and a purchase supplies both, so every current member is
    // planned a grant rather than a null.
    seedFamilyBuiltBeforeTheUpgrade();

    await buyFamily(Date.now() + MONTH);

    for (const uid of [BUYER, MEMBER]) {
      expect(grantedTo(uid)).not.toBeNull();
      expect(grantedTo(uid)?.ms).toBeGreaterThan(Date.now());
    }
  });

  test('🔑 IDEMPOTENT: applying the same purchase twice writes the same expiry, not a longer one', async () => {
    // The webhook may fire for the same purchase, so this path is not the only
    // caller. The grant is the owner's expiry COPIED — an absolute value, never
    // an `increment` and never an extension — so re-applying is a no-op.
    seedFamilyBuiltBeforeTheUpgrade();
    const expiry = Date.now() + MONTH;

    await buyFamily(expiry, 'tx-fam-1');
    const first = grantedTo(MEMBER)?.ms;
    await buyFamily(expiry, 'tx-fam-2');
    const second = grantedTo(MEMBER)?.ms;

    expect(first).toBe(expiry);
    expect(second).toBe(first);
  });

  test('members get the expiry the owner actually HOLDS, not the one this transaction carried', async () => {
    // When a restore grants less than the stored entitlement the owner's write
    // is skipped (`alreadyEntitledLonger`), and members must not be handed the
    // shorter figure — they would expire while the owner is still paid up.
    seedFamilyBuiltBeforeTheUpgrade();
    const longer = Date.now() + 180 * 24 * 3600 * 1000;
    const shorter = Date.now() + MONTH;
    seedDoc(`users/${BUYER}`, {
      subscriptionTier: 'pro',
      subscriptionProductId: 'sub_family_monthly',
      subscriptionExpiresAt: {toMillis: () => longer},
    });

    await buyFamily(shorter, 'tx-fam-restore');

    expect(grantedTo(MEMBER)?.ms).toBe(longer);
  });

  test('🔴 CONTROL: a buyer with NO family writes nothing and still succeeds', async () => {
    // The family lookup is a SKIP, not a refusal — the ordinary subscriber who
    // owns no family must be entitled exactly as before. Also pins that the new
    // read cannot throw on an empty collection.
    const expiry = Date.now() + MONTH;

    const res = await buyFamily(expiry);

    expect(res.success).toBe(true);
    expect((docStore[`users/${BUYER}`]?.data as any)?.subscriptionTier).toBe('pro');
    expect(grantedTo(BUYER)).toBeUndefined();
    expect(Object.keys(docStore).filter((k) => k.startsWith('families/'))).toEqual([]);
  });
});
