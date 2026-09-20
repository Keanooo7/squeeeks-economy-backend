// Force module scope. Without a top-level import/export a .ts file is a SCRIPT,
// so its top-level `const _db` lands in the GLOBAL scope and collides with the
// identically-named one in nine sibling test files (TS2451). Which pair collides
// depends on how ts-jest groups files into a worker, which is why the suite failed
// non-deterministically on a different file each run. Pre-existing; see W3-09.
export {};

// functions/src/__tests__/claimWelcomeChest.test.ts
//
// Unit tests for the claimWelcomeChest callable CF.
//
// The case that matters here is the EMPTY `items` collection. On 2026-08-04 the
// app ran on real hardware for the first time and orientation page 3 dead-ended
// on "Something went wrong opening your chest." Reproduced against the emulator:
//
//   {"error":{"message":"No rare furniture item in the pool",
//             "status":"FAILED_PRECONDITION"}}
//
// `items` is a seeded collection — it is populated by POSTing to seedShopData,
// which is a manual step nobody is holding. The welcome chest is a fixed,
// guaranteed, once-per-user grant, so making it depend on that manual step is
// what turned a seeding gap into "a new user cannot finish onboarding".
//
// SEED_ITEMS is the source `items` is seeded FROM and ships inside the
// function bundle, so the grant can be satisfied without touching the
// collection at all. welcomeChestPool.test.ts already guarantees SEED_ITEMS
// carries at least one rare of every drawn type.

const _db: {
  doc: jest.Mock;
  collection: jest.Mock;
  runTransaction: jest.Mock;
} = {
  doc: jest.fn(),
  collection: jest.fn(),
  runTransaction: jest.fn(),
};

jest.mock('firebase-admin', () => {
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = {
    increment: (n: number) => ({ _type: 'increment', n }),
  };
  firestoreFn.Timestamp = {
    now: () => ({ seconds: 0, nanoseconds: 0 }),
  };
  return {
    initializeApp: jest.fn(),
    firestore: firestoreFn,
    messaging: jest.fn(() => ({ send: jest.fn() })),
  };
});

// Same reason as claimGift.test.ts: index.ts imports Timestamp/FieldValue from
// 'firebase-admin/firestore', because the Functions emulator's admin proxy
// drops those statics. Point both import styles at one fake.
jest.mock('firebase-admin/firestore', () => {
  const admin = jest.requireMock('firebase-admin') as any;
  return {
    FieldValue: admin.firestore.FieldValue,
    Timestamp: admin.firestore.Timestamp,
  };
});

jest.mock('firebase-functions/v2/https', () => ({
  onCall: (...args: any[]) => ({ _handler: args[args.length - 1] }),
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
  onSchedule: (_schedule: string, handler: () => any) => ({ _handler: handler }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { claimWelcomeChest } = require('../index') as {
  claimWelcomeChest: { _handler: (req: any) => Promise<any> };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { SEED_ITEMS } = require('../itemPool') as {
  SEED_ITEMS: Array<{
    id: string;
    type: string;
    name: string;
    rarity: string;
    artUrl: string;
  }>;
};

const DRAWN_TYPES = ['furniture', 'character', 'style'];

function callClaim(uid: string | null = 'uid-a') {
  return claimWelcomeChest._handler({
    auth: uid === null ? undefined : { uid },
    data: {},
  });
}

/// Stubs the `items` collection query. `docs` is what every
/// `.where().where().get()` resolves to, regardless of type — the callable
/// filters by running one query per type, so per-type stubbing happens by
/// keying off the recorded `where` calls.
function stubItems(_byType: Record<string, Array<Record<string, unknown>>> = {}) {
  _db.collection.mockImplementation((name: string) => {
    throw new Error(
      `claimWelcomeChest read collection('${name}'). The \`items\` mirror was ` +
        'retired in W2-134 (production count: 0 documents) — SEED_ITEMS is the ' +
        'only source. A stub returning an empty result would hide a ' +
        'reintroduced read behind the fallback; this fails instead.',
    );
  });
}

/// Wires users/{uid} reads and captures every tx.set so a test can assert what
/// was actually written. `orientationCompleted` drives the idempotency guards.
///
/// WARNING: `tx.get` USED TO ANSWER WITH THE USER SNAPSHOT FOR EVERY REF, whatever was
/// asked for. That was harmless while the only in-transaction read was the user
/// document, and it stopped being harmless in W2-161 when the grant loop started
/// asking whether each item was already owned: the user snapshot carries no
/// `exists`, so every item read as absent and the ownership guard could not be
/// tested in either direction. The stub now routes by path — a fake that answers
/// one question for every question cannot test a function that asks two.
function stubUser(orientationCompleted: boolean, ownedItemIds: string[] = []) {
  const writes: Array<{ path: string; data: Record<string, unknown> }> = [];
  const owned = new Set(ownedItemIds);
  const userSnap = { exists: true, data: () => ({ orientationCompleted }) };
  const snapFor = (path: string) =>
    path.includes('/inventory/')
      ? { exists: owned.has(path.split('/').pop() as string), data: () => ({}) }
      : userSnap;

  _db.doc.mockImplementation((path: string) => ({
    get: jest.fn().mockResolvedValue(snapFor(path)),
    path,
  }));

  _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
    const tx = {
      get: jest.fn(async (ref: any) => snapFor(ref.path)),
      set: jest.fn((ref: any, data: Record<string, unknown>) => {
        writes.push({ path: ref.path, data });
      }),
    };
    return fn(tx);
  });

  return writes;
}

describe('claimWelcomeChest', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects an unauthenticated caller', async () => {
    await expect(callClaim(null)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  test('throws already-exists once orientation is completed', async () => {
    stubUser(true);
    stubItems({});

    await expect(callClaim()).rejects.toMatchObject({
      code: 'already-exists',
    });
  });

  // ---- the device dead end -------------------------------------------------

  test('grants three rares, one per type, entirely from the bundled pool', async () => {
    // Renamed in W2-134 rather than left: it used to say "when the items
    // collection is EMPTY", which described a PRECEDENCE that no longer exists.
    // Production was measured at 0 documents and the read was retired, so the
    // bundled pool is not the fallback any more — it is the only source, and a
    // name implying a condition invites someone to restore the branch.
    const writes = stubUser(false);
    stubItems();

    const result = await callClaim();

    expect(result.items).toHaveLength(3);
    expect(result.items.map((i: any) => i.type)).toEqual(DRAWN_TYPES);
    for (const item of result.items) {
      expect(item.rarity).toBe('rare');
      // Falls back to the bundled pool, so every id must be a real seed id.
      expect(SEED_ITEMS.some((s) => s.id === item.itemId)).toBe(true);
    }
    expect(writes).toHaveLength(4);
    expect(writes[3].data).toMatchObject({ orientationCompleted: true });
  });

  // -------------------------------------------------------------------------
  // W2-161 — the bare `tx.set` that replaced the document
  // -------------------------------------------------------------------------
  //
  // CRITICAL: RED ON `main` AT ed008c0 — verified by restoring index.ts to that sha and
  // re-running this test alone. The grant loop wrote every pick unconditionally
  // with a bare `tx.set`, which REPLACES the document rather than updating it,
  // so an item the player already held had its `ownedAt` reset to today, its
  // `equipped` forced back to false, and any field this write does not name
  // destroyed outright.
  //
  // This path is much narrower than the daily gift's and the quest payout's —
  // it sits behind the once-per-account `orientationCompleted` throw — but
  // "narrow" describes today's callers, not the write, and it is the same defect.
  //
  // WARNING: THE ASSERTION IS THE ABSENCE OF A WRITE. A blanket `merge: true` would
  // preserve `equipped` and STILL move `ownedAt` forward; only "no write at all"
  // is an assertion a merge cannot satisfy.
  test('does not touch the inventory document of an item the player already owns', async () => {
    const everything = SEED_ITEMS.map((s: {id: string}) => s.id);
    const writes = stubUser(false, everything);
    stubItems();

    await callClaim();

    expect(writes.filter((w) => w.path.includes('/inventory/'))).toEqual([]);
    // Orientation is still completed — the guard skips the GRANT, not the claim.
    expect(writes.map((w) => w.data)).toContainEqual(
      expect.objectContaining({orientationCompleted: true}),
    );
  });

  test('THE CONTROL: an unowned welcome item is still written', async () => {
    // KEY: Without this, `if (false)` around the grant would satisfy the test
    // above. The guard has to be selective rather than a stop — and this control
    // passes on `main` too, which is what makes the pair meaningful: one test
    // changed behaviour, the other pins behaviour that must NOT change.
    const writes = stubUser(false, []);
    stubItems();

    await callClaim();

    const inventory = writes.filter((w) => w.path.includes('/inventory/'));
    expect(inventory).toHaveLength(3);
    for (const w of inventory) {
      expect(w.data).toMatchObject({equipped: false, source: 'welcome_chest'});
    }
  });

  test('the welcome chest performs no collection() read at all', async () => {
    // The symmetric guard to purchaseChest's. `stubItems` throws on any
    // collection() call, which protects the tests that happen to claim — this
    // states the intent, and keeps speaking if a future refactor stops routing
    // through that helper.
    stubUser(false);
    stubItems();

    await callClaim();

    expect(_db.collection).not.toHaveBeenCalled();
  });

  test('writes inventory entries tagged as welcome_chest', async () => {
    const writes = stubUser(false);
    stubItems({});

    await callClaim();

    for (const write of writes.slice(0, 3)) {
      expect(write.data).toMatchObject({
        source: 'welcome_chest',
        equipped: false,
      });
    }
  });
});
