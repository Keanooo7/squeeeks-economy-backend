// Force module scope. Without a top-level import/export a .ts file is a SCRIPT,
// so its top-level `const _db` lands in the GLOBAL scope and collides with the
// identically-named one in its sibling test files (TS2451). See W3-09.
export {};

// functions/src/__tests__/gibbyFunctions.test.ts
//
// Gibby wired into the deployed functions:
//   onNewUserBefriendGibby   — the per-account creation trigger that did not exist
//   backfillGibbyFriendship  — the same edges for accounts that predate it
//   claimDailyGift           — re-skinned as "a gift from Gibby"
//   syncPublicProfile        — must NOT wipe Gibby's name back to ''
//
// Why claimDailyGift is re-skinned rather than duplicated: a second daily
// sponge faucet would roughly double free income, an economy change nobody
// asked for. The user specified the gift's CONTENTS, not a new source.

const _db: {
  doc: jest.Mock;
  collection: jest.Mock;
  batch: jest.Mock;
  runTransaction: jest.Mock;
} = {
  doc: jest.fn(),
  collection: jest.fn(),
  batch: jest.fn(),
  runTransaction: jest.fn(),
};

const _auth: {
  createUser: jest.Mock;
  updateUser: jest.Mock;
  getUser: jest.Mock;
} = {
  createUser: jest.fn(),
  updateUser: jest.fn(),
  getUser: jest.fn(),
};

jest.mock('firebase-admin', () => {
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = {
    increment: (n: number) => ({ _type: 'increment', n }),
    delete: () => ({ _type: 'delete' }),
  };
  firestoreFn.Timestamp = {
    now: () => ({ seconds: 0, nanoseconds: 0 }),
    fromDate: (d: Date) => ({ _date: d, toMillis: () => d.getTime() }),
  };
  return {
    initializeApp: jest.fn(),
    firestore: firestoreFn,
    auth: jest.fn(() => _auth),
    messaging: jest.fn(() => ({ send: jest.fn() })),
  };
});

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

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_spec: any, handler: (event: any) => any) => ({
    _handler: handler,
  }),
}));

// The account-creation trigger. v1 is deliberate: the v2 equivalent
// (beforeUserCreated, firebase-functions/v2/identity) is a BLOCKING function
// and requires an Identity Platform upgrade this project has not had.
jest.mock('firebase-functions/v1/auth', () => ({
  user: () => ({
    onCreate: (handler: (u: any) => any) => ({ _handler: handler }),
  }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  claimDailyGift,
  onNewUserBefriendGibby,
  backfillGibbyFriendship,
  syncPublicProfile,
} = require('../index') as {
  claimDailyGift: { _handler: (req: any) => Promise<any> };
  onNewUserBefriendGibby: { _handler: (user: any) => Promise<any> };
  backfillGibbyFriendship: {
    _handler: (req: any, res: any) => Promise<any>;
  };
  syncPublicProfile: { _handler: (event: any) => Promise<any> };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { GIBBY_UID, GIBBY_DISPLAY_NAME } = require('../gibby') as {
  GIBBY_UID: string;
  GIBBY_DISPLAY_NAME: string;
};

// The bundled pool, for the W2-161 ownership tests below. `itemPool` pulls in no
// firebase surface, so requiring it here needs no mock.
const { SEED_ITEMS } = require('../itemPool') as {
  SEED_ITEMS: Array<{ id: string }>;
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Seeded, non-constant. A constant Math.random kills jest's own sort. */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Write = { path: string; data: Record<string, unknown>; merge: boolean };

/**
 * Records every write through db.doc().set, db.batch() and a transaction, so a
 * test can assert what actually reached Firestore rather than what a function
 * returned.
 */
function stubDb(opts: {
  userShop?: Record<string, unknown>;
  users?: string[];
  items?: Array<Record<string, unknown>>;
  /**
   * Friend-edge paths that ALREADY exist. Everything under `/friends/` is
   * absent unless named here.
   *
   * ⚠️ This stub used to answer `exists: true` for EVERY path, including friend
   * edges a brand-new account cannot have. That was invisible while
   * `ensureGibbyFriendship` wrote unconditionally and never read — the fixture
   * asserted a state no new user is ever in, and nothing consulted it. It
   * surfaced the moment the function started asking.
   */
  existingFriendEdges?: string[];
  /**
   * Inventory item ids the player ALREADY owns. Everything under `/inventory/`
   * is absent unless named here.
   *
   * 🔴 THE SAME DEFECT AS `existingFriendEdges`, FOUND THE SAME WAY — W2-161.
   * This stub answered `exists: true` for every inventory path, so the moment
   * claimDailyGift started ASKING whether the gifted item was already owned, the
   * fixture said yes for a brand-new account that owns nothing, and the grant
   * this suite exists to assert stopped happening. An always-exists stub is
   * invisible until something reads it, and then it is wrong in whichever
   * direction the reader cares about.
   */
  ownedItemIds?: string[];
} = {}) {
  const writes: Write[] = [];
  const existingEdges = new Set(opts.existingFriendEdges ?? []);
  const ownedItems = new Set(opts.ownedItemIds ?? []);

  const makeRef = (path: string) => ({
    path,
    get: jest.fn().mockResolvedValue({
      exists: path.includes('/friends/')
        ? existingEdges.has(path)
        : path.includes('/inventory/')
          ? ownedItems.has(path.split('/').pop() as string)
          : true,
      data: () => (path.endsWith('/shop/data') ? (opts.userShop ?? {}) : {}),
    }),
    set: jest.fn(async (data: Record<string, unknown>, options?: any) => {
      writes.push({ path, data, merge: options?.merge === true });
    }),
    delete: jest.fn(async () => {
      writes.push({ path, data: { _deleted: true }, merge: false });
    }),
  });

  _db.doc.mockImplementation((path: string) => makeRef(path));

  _db.collection.mockImplementation((name: string) => {
    if (name === 'users') {
      return {
        get: jest.fn(async () => ({
          docs: (opts.users ?? []).map((id) => ({ id, data: () => ({}) })),
        })),
      };
    }
    if (name === 'items') {
      const query: any = {
        where: jest.fn(() => query),
        get: jest.fn(async () => {
          const rows = opts.items ?? [];
          return {
            empty: rows.length === 0,
            docs: rows.map((d) => ({ id: d.id as string, data: () => d })),
          };
        }),
      };
      return query;
    }
    throw new Error(`unexpected collection ${name}`);
  });

  _db.batch.mockImplementation(() => ({
    set: jest.fn((ref: any, data: Record<string, unknown>, options?: any) => {
      writes.push({ path: ref.path, data, merge: options?.merge === true });
    }),
    commit: jest.fn(async () => undefined),
  }));

  _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
    const tx = {
      get: jest.fn(async (ref: any) => ref.get()),
      set: jest.fn((ref: any, data: Record<string, unknown>, options?: any) => {
        writes.push({ path: ref.path, data, merge: options?.merge === true });
      }),
      create: jest.fn(),
    };
    return fn(tx);
  });

  return writes;
}

function pathsOf(writes: Write[]): string[] {
  return writes.map((w) => w.path);
}

// ---------------------------------------------------------------------------
// (2) The account-creation trigger that did not exist
// ---------------------------------------------------------------------------

describe('onNewUserBefriendGibby', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _auth.createUser.mockResolvedValue({ uid: GIBBY_UID });
    _auth.updateUser.mockResolvedValue({ uid: GIBBY_UID });
    _auth.getUser.mockResolvedValue({ displayName: GIBBY_DISPLAY_NAME });
  });

  it('writes BOTH friend edges, so the friendship is not half-written', () => {
    // The client cannot seed this itself: firestore.rules pins a client create
    // to status 'pending'. Only an Admin SDK write can produce 'accepted'.
    const writes = stubDb();

    return onNewUserBefriendGibby._handler({ uid: 'newbie' }).then(() => {
      expect(pathsOf(writes)).toEqual(
        expect.arrayContaining([
          `users/newbie/friends/${GIBBY_UID}`,
          `users/${GIBBY_UID}/friends/newbie`,
        ]),
      );
    });
  });

  it('writes an edge the Flutter client can parse', async () => {
    const writes = stubDb();
    await onNewUserBefriendGibby._handler({ uid: 'newbie' });

    const edge = writes.find(
      (w) => w.path === `users/newbie/friends/${GIBBY_UID}`,
    )!;
    expect(edge.data.status).toBe('accepted');
    expect(typeof edge.data.addedAt).toBe('string');
    expect(edge.data.requesterUid).toBe(GIBBY_UID);
  });

  it('does not befriend Gibby to himself', async () => {
    // ensureGibbyAccount calls admin.auth().createUser, which fires this very
    // trigger. Without a guard Gibby gets a self-edge and appears in his own
    // friends list — and the trigger recurses into ensureGibbyAccount again.
    const writes = stubDb();
    await onNewUserBefriendGibby._handler({ uid: GIBBY_UID });

    expect(
      pathsOf(writes).filter((p) => p.includes('/friends/')),
    ).toEqual([]);
  });

  it('short-circuits entirely on its own creation, rather than re-seeding', async () => {
    // The edge guard inside ensureGibbyFriendship already stops the self-edge,
    // so asserting only on writes cannot tell whether the trigger returned
    // early. It matters that it did: ensureGibbyAccount is what created this
    // Auth record in the first place, and re-entering it from its own event is
    // the recursive case.
    const writes = stubDb();
    await onNewUserBefriendGibby._handler({ uid: GIBBY_UID });

    expect(_auth.createUser).not.toHaveBeenCalled();
    expect(_auth.updateUser).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it('gives Gibby an Auth record carrying the display name', async () => {
    // This is the whole reason the projection resolves to 'Gibby' rather than
    // ''. syncPublicProfile reads the name off the Auth record, never Firestore.
    stubDb();
    await onNewUserBefriendGibby._handler({ uid: 'newbie' });

    expect(_auth.createUser).toHaveBeenCalledWith(
      expect.objectContaining({
        uid: GIBBY_UID,
        displayName: GIBBY_DISPLAY_NAME,
      }),
    );
  });

  it('survives Gibby already existing', async () => {
    // Every signup after the first hits this path. It must not throw: an
    // unhandled rejection makes the trigger retry until backoff expires.
    stubDb();
    _auth.createUser.mockRejectedValue(
      Object.assign(new Error('uid exists'), { code: 'auth/uid-already-exists' }),
    );

    await expect(
      onNewUserBefriendGibby._handler({ uid: 'newbie' }),
    ).resolves.not.toThrow();
    expect(_auth.updateUser).toHaveBeenCalledWith(
      GIBBY_UID,
      expect.objectContaining({ displayName: GIBBY_DISPLAY_NAME }),
    );
  });

  it('leaves a projection behind, so a house visit cannot crash', async () => {
    // getFriendVisit (friends_repository_impl.dart:170) throws StateError when
    // publicProfiles/{host} is missing. A half-seeded Gibby takes down the
    // visit screen for every user at once.
    const writes = stubDb();
    await onNewUserBefriendGibby._handler({ uid: 'newbie' });

    const projection = writes.find(
      (w) => w.path === `publicProfiles/${GIBBY_UID}`,
    );
    expect(projection).toBeDefined();
    expect(projection!.data.displayName).toBe(GIBBY_DISPLAY_NAME);
  });

  it('gives Gibby a house to visit', async () => {
    const writes = stubDb();
    await onNewUserBefriendGibby._handler({ uid: 'newbie' });
    expect(pathsOf(writes)).toContain(`users/${GIBBY_UID}/house/layout`);
  });
});

// ---------------------------------------------------------------------------
// (1)+(7) The projection must survive a later write to Gibby's user doc
// ---------------------------------------------------------------------------

describe('syncPublicProfile over Gibby', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _auth.getUser.mockResolvedValue({ displayName: GIBBY_DISPLAY_NAME });
  });

  it('keeps the name when a later write touches Gibby', async () => {
    // scripts/set-gibby-avatar.js merge-wrote users/{gibby}.avatarUrl, the
    // trigger found no Auth record, and the projection name was reset to ''.
    // With an Auth record the same write is harmless — which is exactly why
    // the name has to live in Auth rather than in the projection document.
    const writes = stubDb();

    await syncPublicProfile._handler({
      params: { uid: GIBBY_UID },
      data: {
        before: { data: () => ({ avatarUrl: '' }) },
        after: { data: () => ({ avatarUrl: 'fox.webp', isPublic: true }) },
      },
    });

    const projection = writes.find(
      (w) => w.path === `publicProfiles/${GIBBY_UID}`,
    )!;
    expect(projection.data.displayName).toBe(GIBBY_DISPLAY_NAME);
  });
});

// ---------------------------------------------------------------------------
// (3) Backfill — a creation trigger reaches nobody who already signed up
// ---------------------------------------------------------------------------

function mockRes() {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status: jest.fn((c: number) => {
      res.statusCode = c;
      return res;
    }),
    send: jest.fn((b: any) => {
      res.body = b;
      return res;
    }),
    json: jest.fn((b: any) => {
      res.body = b;
      return res;
    }),
  };
  return res;
}

describe('backfillGibbyFriendship', () => {
  const OLD_SECRET = process.env.SEED_SECRET;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SEED_SECRET = 'shhh';
    _auth.createUser.mockResolvedValue({ uid: GIBBY_UID });
    _auth.updateUser.mockResolvedValue({ uid: GIBBY_UID });
    _auth.getUser.mockResolvedValue({ displayName: GIBBY_DISPLAY_NAME });
  });

  afterAll(() => {
    process.env.SEED_SECRET = OLD_SECRET;
  });

  it('befriends every pre-existing account', async () => {
    const writes = stubDb({ users: ['alice', 'bob'] });
    const res = mockRes();

    await backfillGibbyFriendship._handler(
      { method: 'POST', get: () => 'shhh' },
      res,
    );

    expect(res.body).toMatchObject({ success: true, usersBefriended: 2 });
    expect(pathsOf(writes)).toEqual(
      expect.arrayContaining([
        `users/alice/friends/${GIBBY_UID}`,
        `users/bob/friends/${GIBBY_UID}`,
        `users/${GIBBY_UID}/friends/alice`,
        `users/${GIBBY_UID}/friends/bob`,
      ]),
    );
  });

  it('does not befriend Gibby to himself during a backfill', async () => {
    // Gibby's own users/{uid} doc is in the collection the backfill walks.
    const writes = stubDb({ users: ['alice', GIBBY_UID] });
    const res = mockRes();

    await backfillGibbyFriendship._handler(
      { method: 'POST', get: () => 'shhh' },
      res,
    );

    expect(pathsOf(writes)).not.toContain(
      `users/${GIBBY_UID}/friends/${GIBBY_UID}`,
    );
    expect(res.body).toMatchObject({ usersBefriended: 1 });
  });

  it('refuses without the shared secret', async () => {
    stubDb({ users: ['alice'] });
    const res = mockRes();

    await backfillGibbyFriendship._handler(
      { method: 'POST', get: () => 'wrong' },
      res,
    );

    expect(res.statusCode).toBe(403);
  });

  it('refuses a GET', async () => {
    stubDb({ users: ['alice'] });
    const res = mockRes();

    await backfillGibbyFriendship._handler(
      { method: 'GET', get: () => 'shhh' },
      res,
    );

    expect(res.statusCode).toBe(405);
  });

  it('fails closed when the secret is unset', async () => {
    delete process.env.SEED_SECRET;
    stubDb({ users: ['alice'] });
    const res = mockRes();

    await backfillGibbyFriendship._handler(
      { method: 'POST', get: () => undefined },
      res,
    );

    expect(res.statusCode).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// (5) claimDailyGift, re-skinned
// ---------------------------------------------------------------------------

describe('claimDailyGift as a gift from Gibby', () => {
  let randomSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    // Seeded and non-constant — see the header of gibby.test.ts.
    randomSpy = jest
      .spyOn(Math, 'random')
      .mockImplementation(seededRng(31337));
  });

  afterEach(() => {
    randomSpy.mockRestore();
  });

  function claim(data: Record<string, unknown> = {}) {
    return claimDailyGift._handler({ auth: { uid: 'uid-a' }, data });
  }

  it('keeps the response shape the shipped client parses', async () => {
    // shop_repository_impl.dart:112-113 hard-casts data['amount'] as int and
    // DateTime.parse(data['nextClaimableAt']). Either one missing is a crash,
    // not a degraded screen.
    stubDb();
    const result = await claim();

    expect(Number.isInteger(result.amount)).toBe(true);
    expect(typeof result.nextClaimableAt).toBe('string');
    expect(() => new Date(result.nextClaimableAt).toISOString()).not.toThrow();
  });

  it('grants 5–15 sponges, not the old 2–10', async () => {
    for (let i = 0; i < 200; i++) {
      stubDb();
      const result = await claim();
      if (result.kind === 'chest') continue;
      expect(result.amount).toBeGreaterThanOrEqual(5);
      expect(result.amount).toBeLessThanOrEqual(15);
    }
  });

  it('credits the sponges it reports', async () => {
    const writes = stubDb();
    const result = await claim();

    const credit = writes.find((w) => w.path === 'users/uid-a/profile/data')!;
    expect(credit.data.spongeBalance).toEqual({
      _type: 'increment',
      n: result.amount,
    });
  });

  it('names Gibby as the sender', async () => {
    stubDb();
    const result = await claim();
    expect(result.from).toBe(GIBBY_DISPLAY_NAME);
    expect(result.fromUid).toBe(GIBBY_UID);
  });

  it('never sends a chest to the shipped client', async () => {
    // The live app has no chest reveal on this path; it would render a chest as
    // "0 sponges". Sponges-only until a client opts in, so the deploy needs no
    // coordinated app release — same contract as purchaseChest's purchaseId.
    for (let i = 0; i < 400; i++) {
      stubDb();
      const result = await claim();
      expect(result.kind).toBe('sponges');
      expect(result.amount).toBeGreaterThan(0);
    }
  });

  it('can send a chest to a client that opts in, and grants the item', async () => {
    let sawChest = false;
    for (let i = 0; i < 600 && !sawChest; i++) {
      const writes = stubDb();
      const result = await claim({ supportsChest: true });
      if (result.kind !== 'chest') continue;
      sawChest = true;

      expect(result.amount).toBe(0);
      expect(result.items).toHaveLength(1);
      const inventory = writes.find((w) =>
        w.path.startsWith('users/uid-a/inventory/'),
      );
      expect(inventory).toBeDefined();
      expect(inventory!.data.source).toBe('gibby_daily_gift');
    }
    expect(sawChest).toBe(true);
  });

  // -------------------------------------------------------------------------
  // W2-161 — the bare `tx.set` that replaced the document
  // -------------------------------------------------------------------------
  //
  // 🔴 RED ON `main` AT ed008c0. The write this guards was
  //
  //     tx.set(db.doc(`users/${uid}/inventory/${chestItem.itemId}`), {
  //       itemId, ownedAt: Timestamp.now(), equipped: false, source: QUEST_SOURCE,
  //     });
  //
  // with no merge option and no ownership check. A bare `tx.set` REPLACES the
  // document, so gifting a player an item they already owned reset `ownedAt` to
  // today, silently UNEQUIPPED an item they were wearing, and destroyed any
  // field this write does not name.
  //
  // ⚠️ THE ASSERTION IS THE ABSENCE OF A WRITE, AND THAT IS DELIBERATE. A
  // blanket `merge: true` — the fix the brief explicitly rules out — would
  // preserve `equipped` and still move `ownedAt` forward, and it would pass any
  // test that only checked `equipped`. Asserting that NOTHING is written to an
  // owned item's path is the assertion a merge cannot satisfy.
  it('does not touch the inventory document of an item the player already owns', async () => {
    let sawChest = false;
    for (let i = 0; i < 600 && !sawChest; i++) {
      // Own the whole bundled pool, so whatever is drawn is already held.
      const writes = stubDb({ownedItemIds: SEED_ITEMS.map((it) => it.id)});
      const result = await claim({supportsChest: true});
      if (result.kind !== 'chest') continue;
      sawChest = true;

      const inventoryWrites = writes.filter((w) =>
        w.path.startsWith('users/uid-a/inventory/'),
      );
      expect(inventoryWrites).toEqual([]);
    }
    expect(sawChest).toBe(true);
  });

  it('THE CONTROL: an unowned gift is still written, so the guard is not a blanket refusal', async () => {
    // 🔑 Without this, `if (false)` around the write would pass the test above.
    // The guard has to be selective, not a stop.
    let sawChest = false;
    for (let i = 0; i < 600 && !sawChest; i++) {
      const writes = stubDb({ownedItemIds: []});
      const result = await claim({supportsChest: true});
      if (result.kind !== 'chest') continue;
      sawChest = true;

      const inventory = writes.find((w) =>
        w.path.startsWith('users/uid-a/inventory/'),
      );
      expect(inventory).toBeDefined();
      expect(inventory!.data.source).toBe('gibby_daily_gift');
      expect(inventory!.data.equipped).toBe(false);
      // And it is a full write, not a merge — a NEW document is created outright.
      expect(inventory!.merge).toBe(false);
    }
    expect(sawChest).toBe(true);
  });

  it('still enforces the 24h cooldown', async () => {
    stubDb({
      userShop: {
        lastDailyGiftClaimedAt: {
          toDate: () => new Date(Date.now() - 60 * 1000),
        },
      },
    });

    await expect(claim()).rejects.toMatchObject({ code: 'already-exists' });
  });

  it('lets the gift through once a day has passed', async () => {
    stubDb({
      userShop: {
        lastDailyGiftClaimedAt: {
          toDate: () => new Date(Date.now() - 25 * 60 * 60 * 1000),
        },
      },
    });

    await expect(claim()).resolves.toMatchObject({ kind: 'sponges' });
  });

  it('rejects an unauthenticated caller', async () => {
    stubDb();
    await expect(
      claimDailyGift._handler({ auth: undefined, data: {} }),
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

// ---------------------------------------------------------------------------
// ensureGibbyFriendship is idempotent, and its boolean means something (W2-65)
//
// It used to `set` both edges unconditionally and `return true` for every real
// uid. Two consequences, both invisible until something asked:
//
//   1. `set` without merge REPLACES. Re-running reset `addedAt` and cleared
//      `housePendingFrom` to [] — live state that firestore.rules:112 reads to
//      decide house access, and that the client mutates with arrayUnion.
//   2. The return value was a CONSTANT, so onNewUserBefriendGibby's
//      `friendship=${wrote ? 'written' : 'skipped'}` could never say 'skipped',
//      and backfillGibbyFriendship's `befriended N/M` always had N === M.
//
// 🔑 That second point is why this matters for an INVESTIGATION and not only
// for correctness: both instruments reported the same answer no matter what was
// true, so a green run of either could never tell anyone how many accounts were
// actually missing Gibby.
// ---------------------------------------------------------------------------

describe('ensureGibbyFriendship — idempotence and a truthful count', () => {
  // The backfill is secret-gated; without this it answers 403 Forbidden and a
  // body assertion below fails on the string rather than on the count.
  const OLD_SECRET = process.env.SEED_SECRET;
  beforeEach(() => {
    process.env.SEED_SECRET = 'shhh';
  });
  afterAll(() => {
    process.env.SEED_SECRET = OLD_SECRET;
  });

  it('writes nothing and reports skipped when both edges already exist', async () => {
    const writes = stubDb({
      existingFriendEdges: [
        `users/veteran/friends/${GIBBY_UID}`,
        `users/${GIBBY_UID}/friends/veteran`,
      ],
    });

    await onNewUserBefriendGibby._handler({ uid: 'veteran' });

    // The edges are untouched — which is the whole point. An overwrite here
    // would silently clear housePendingFrom on an existing friendship.
    expect(pathsOf(writes)).not.toContain(`users/veteran/friends/${GIBBY_UID}`);
    expect(pathsOf(writes)).not.toContain(`users/${GIBBY_UID}/friends/veteran`);
  });

  it('heals a half-written friendship by writing only the missing side', async () => {
    // The state the old code could produce if a batch half-failed, and the
    // state its own test name — "so the friendship is not half-written" —
    // worried about. Skipping on one edge would leave it half-written forever.
    const writes = stubDb({
      existingFriendEdges: [`users/halfling/friends/${GIBBY_UID}`],
    });

    await onNewUserBefriendGibby._handler({ uid: 'halfling' });

    expect(pathsOf(writes)).toContain(`users/${GIBBY_UID}/friends/halfling`);
    expect(pathsOf(writes)).not.toContain(`users/halfling/friends/${GIBBY_UID}`);
  });

  it('the backfill count reports accounts CHANGED, not accounts walked', async () => {
    // alice already has Gibby; bob does not. The old code answered 2 here for
    // any two users, which is the same answer it gave when nothing was wrong.
    const writes = stubDb({
      users: ['alice', 'bob'],
      existingFriendEdges: [
        `users/alice/friends/${GIBBY_UID}`,
        `users/${GIBBY_UID}/friends/alice`,
      ],
    });
    const res = mockRes();

    await backfillGibbyFriendship._handler(
      { method: 'POST', get: () => 'shhh' },
      res,
    );

    expect(res.body).toMatchObject({ success: true, usersBefriended: 1 });
    expect(pathsOf(writes)).toContain(`users/bob/friends/${GIBBY_UID}`);
    expect(pathsOf(writes)).not.toContain(`users/alice/friends/${GIBBY_UID}`);
  });
});
