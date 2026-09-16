// Force module scope. Without a top-level import/export a .ts file is a SCRIPT,
// so its top-level `const _db` lands in the GLOBAL scope and collides with the
// identically-named one in nine sibling test files (TS2451). Which pair collides
// depends on how ts-jest groups files into a worker, which is why the suite failed
// non-deterministically on a different file each run. Pre-existing; see W3-09.
export {};

// functions/src/__tests__/backfillPublicProfiles.test.ts
//
// Unit tests for the backfillPublicProfiles HTTP endpoint. Mocks
// firebase-admin so no emulator is required.
//
// Two defects are pinned here, both found by running the backfill in
// production rather than reading it:
//
//   1. The endpoint reads process.env.SEED_SECRET but was declared as a bare
//      onRequest with no `secrets: [...]` option. Gen2 does not populate the
//      env var without that binding, so `functions:secrets:set SEED_SECRET`
//      creates a Secret Manager entry that never reaches the runtime and every
//      request stays 403 forever.
//   2. The write was a single unchunked db.batch(). Firestore caps a
//      WriteBatch at 500 operations, so above 500 users the commit throws
//      INVALID_ARGUMENT and NOTHING is written — a silent, total failure of
//      the exact recovery operation you would be running because search is
//      broken. Production holds two user documents, which is precisely why
//      this could not be caught at current scale.

// ---------------------------------------------------------------------------
// Firestore batch fake — enforces the real 500-operation cap.
// ---------------------------------------------------------------------------

/** Every batch handed out by the fake db, in creation order. */
const _batches: Array<{
  ops: Array<{ path: string; data: Record<string, unknown> }>;
  committed: boolean;
  set: jest.Mock;
  commit: jest.Mock;
}> = [];

/** Firestore's hard limit on operations in a single WriteBatch. */
const FIRESTORE_BATCH_LIMIT = 500;

function makeBatch() {
  const batch = {
    ops: [] as Array<{ path: string; data: Record<string, unknown> }>,
    committed: false,
    set: jest.fn((ref: { path: string }, data: Record<string, unknown>) => {
      batch.ops.push({ path: ref.path, data });
    }),
    commit: jest.fn(async () => {
      if (batch.ops.length > FIRESTORE_BATCH_LIMIT) {
        // Mirrors the real server error: the whole commit is rejected and no
        // document in it is written.
        const err = new Error(
          `3 INVALID_ARGUMENT: maximum ${FIRESTORE_BATCH_LIMIT} writes allowed per request`
        );
        (err as unknown as { code: number }).code = 3;
        throw err;
      }
      batch.committed = true;
    }),
  };
  _batches.push(batch);
  return batch;
}

const _users: Array<{ id: string; data: () => Record<string, unknown> }> = [];

const _db = {
  collection: jest.fn((name: string) => {
    if (name !== 'users') throw new Error(`unexpected collection ${name}`);
    return { get: jest.fn(async () => ({ docs: _users, size: _users.length })) };
  }),
  doc: jest.fn((path: string) => ({ path })),
  batch: jest.fn(() => makeBatch()),
  runTransaction: jest.fn(),
};

const _getUser = jest.fn(async (uid: string) => ({ displayName: `Name ${uid}` }));

jest.mock('firebase-admin', () => {
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = { increment: (n: number) => ({ _type: 'increment', n }) };
  firestoreFn.Timestamp = { now: () => ({ seconds: 0, nanoseconds: 0 }) };
  return {
    initializeApp: jest.fn(),
    firestore: firestoreFn,
    auth: jest.fn(() => ({ getUser: (uid: string) => _getUser(uid) })),
    messaging: jest.fn(() => ({ send: jest.fn() })),
  };
});

// index.ts imports Timestamp/FieldValue from 'firebase-admin/firestore', not
// off the admin.firestore namespace — the Functions emulator's admin proxy
// drops those statics. Re-export the same sentinels so both styles resolve to
// one fake.
jest.mock('firebase-admin/firestore', () => {
  const admin = jest.requireMock('firebase-admin') as any;
  return {
    FieldValue: admin.firestore.FieldValue,
    Timestamp: { ...admin.firestore.Timestamp, fromDate: (d: Date) => ({ _date: d }) },
  };
});

// firebase-functions/v2 mocks — avoid gRPC / env setup. onRequest is captured
// with its options so the secret binding itself is assertable: that binding is
// the difference between a working endpoint and a permanent 403.
jest.mock('firebase-functions/v2/https', () => ({
  onCall: (...args: any[]) => ({ _handler: args[args.length - 1] }),
  onRequest: (...args: any[]) => ({
    _handler: args[args.length - 1],
    _opts: args.length > 1 ? args[0] : undefined,
  }),
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: (...args: any[]) => ({ _handler: args[args.length - 1] }),
}));

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (...args: any[]) => ({ _handler: args[args.length - 1] }),
}));

// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------

type HttpFn = {
  _handler: (req: any, res: any) => Promise<void>;
  _opts?: { secrets?: string[] };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { backfillPublicProfiles, seedShopData, adminGrant } = require('../index') as {
  backfillPublicProfiles: HttpFn;
  seedShopData: HttpFn;
  adminGrant: HttpFn;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECRET = 'test-seed-secret';

type FakeRes = {
  statusCode: number;
  body: unknown;
  status: jest.Mock;
  send: jest.Mock;
  json: jest.Mock;
};

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 0,
    body: undefined,
    status: jest.fn(),
    send: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockImplementation((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.send.mockImplementation((body: unknown) => {
    res.body = body;
    return res;
  });
  res.json.mockImplementation((body: unknown) => {
    res.statusCode = res.statusCode || 200;
    res.body = body;
    return res;
  });
  return res;
}

function makeReq(headers: Record<string, string> = { 'x-seed-secret': SECRET }) {
  return {
    method: 'POST',
    get: (name: string) => headers[name.toLowerCase()],
  };
}

function seedUsers(count: number) {
  _users.length = 0;
  for (let i = 0; i < count; i++) {
    const id = `user-${String(i).padStart(4, '0')}`;
    _users.push({ id, data: () => ({ isPublic: true, level: i }) });
  }
}

beforeEach(() => {
  _batches.length = 0;
  _users.length = 0;
  _getUser.mockClear();
  _getUser.mockImplementation(async (uid: string) => ({ displayName: `Name ${uid}` }));
  process.env.SEED_SECRET = SECRET;
});

afterEach(() => {
  delete process.env.SEED_SECRET;
});

/** Every write that actually reached Firestore, across all committed batches. */
function committedPaths(): string[] {
  return _batches.filter((b) => b.committed).flatMap((b) => b.ops.map((o) => o.path));
}

// ---------------------------------------------------------------------------
// 1. Secret binding — a stored secret that is never bound is a permanent 403
// ---------------------------------------------------------------------------

describe('SEED_SECRET binding', () => {
  it('backfillPublicProfiles declares secrets: [SEED_SECRET]', () => {
    expect(backfillPublicProfiles._opts?.secrets).toContain('SEED_SECRET');
  });

  it('seedShopData declares secrets: [SEED_SECRET] — it shares the same secret', () => {
    expect(seedShopData._opts?.secrets).toContain('SEED_SECRET');
  });
});

// ---------------------------------------------------------------------------
// 2. Auth gate — fails closed. Regression guard on the binding change.
// ---------------------------------------------------------------------------

describe('backfillPublicProfiles auth gate', () => {
  it('rejects a non-POST method', async () => {
    const res = makeRes();
    await backfillPublicProfiles._handler({ method: 'GET', get: () => undefined }, res);
    expect(res.statusCode).toBe(405);
  });

  it('rejects a request with the wrong secret', async () => {
    seedUsers(3);
    const res = makeRes();
    await backfillPublicProfiles._handler(makeReq({ 'x-seed-secret': 'wrong' }), res);
    expect(res.statusCode).toBe(403);
    expect(committedPaths()).toHaveLength(0);
  });

  it('fails closed when SEED_SECRET is unset', async () => {
    delete process.env.SEED_SECRET;
    seedUsers(3);
    const res = makeRes();
    await backfillPublicProfiles._handler(makeReq(), res);
    expect(res.statusCode).toBe(403);
    expect(committedPaths()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Batch chunking — the 500-op cap
// ---------------------------------------------------------------------------

describe('backfillPublicProfiles batching', () => {
  it('projects every user when there are more than 500 of them', async () => {
    seedUsers(600);
    const res = makeRes();

    await backfillPublicProfiles._handler(makeReq(), res);

    const paths = committedPaths();
    expect(paths).toHaveLength(600);
    expect(new Set(paths).size).toBe(600);
    expect(paths).toContain('publicProfiles/user-0000');
    expect(paths).toContain('publicProfiles/user-0599');
    expect(res.body).toEqual({ success: true, profilesBackfilled: 600 });
  });

  it('never puts more than 500 operations in one batch', async () => {
    seedUsers(600);

    await backfillPublicProfiles._handler(makeReq(), makeRes());

    expect(_batches.length).toBeGreaterThan(1);
    for (const batch of _batches) {
      expect(batch.ops.length).toBeLessThanOrEqual(FIRESTORE_BATCH_LIMIT);
    }
  });

  it('still works below the cap, in a single batch', async () => {
    seedUsers(2);
    const res = makeRes();

    await backfillPublicProfiles._handler(makeReq(), res);

    expect(_batches).toHaveLength(1);
    expect(committedPaths()).toEqual([
      'publicProfiles/user-0000',
      'publicProfiles/user-0001',
    ]);
    expect(res.body).toEqual({ success: true, profilesBackfilled: 2 });
  });

  it('writes nothing and reports zero when there are no users', async () => {
    seedUsers(0);
    const res = makeRes();

    await backfillPublicProfiles._handler(makeReq(), res);

    expect(committedPaths()).toHaveLength(0);
    expect(res.body).toEqual({ success: true, profilesBackfilled: 0 });
  });
});

// ---------------------------------------------------------------------------
// 4. Auth lookups — orphan tolerance survives the concurrency change
// ---------------------------------------------------------------------------

describe('backfillPublicProfiles Auth lookups', () => {
  it('projects an orphaned user document rather than aborting the backfill', async () => {
    seedUsers(600);
    _getUser.mockImplementation(async (uid: string) => {
      if (uid === 'user-0300') throw new Error('no such user');
      return { displayName: `Name ${uid}` };
    });

    const res = makeRes();
    await backfillPublicProfiles._handler(makeReq(), res);

    expect(committedPaths()).toHaveLength(600);
    expect(res.body).toEqual({ success: true, profilesBackfilled: 600 });
  });

  it('looks each user up exactly once', async () => {
    seedUsers(600);

    await backfillPublicProfiles._handler(makeReq(), makeRes());

    expect(_getUser).toHaveBeenCalledTimes(600);
    expect(new Set(_getUser.mock.calls.map((c) => c[0])).size).toBe(600);
  });

  it('does not serialise the Auth lookups', async () => {
    seedUsers(600);
    let inFlight = 0;
    let peak = 0;
    _getUser.mockImplementation(async (uid: string) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      return { displayName: `Name ${uid}` };
    });

    await backfillPublicProfiles._handler(makeReq(), makeRes());

    // Serial lookups peak at 1. Unbounded fan-out at 600 would be a 600-way
    // stampede against the Auth API; the point is a bounded pool between.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(50);
  });
});


// ---------------------------------------------------------------------------
// W2-122 — adminGrant's gate
// ---------------------------------------------------------------------------
//
// 🔴 THE MUTATION THIS BLOCK EXISTS FOR: prove the gate FAILS CLOSED when the
// secret is unset, and that a WRONG secret and a MISSING one are
// distinguishable to the operator without either message leaking the value.
//
// This endpoint writes to real player accounts. Its gate is the entire security
// boundary — Admin SDK writes bypass firestore.rules, so there is no second
// line of defence behind it.

describe('🔴 W2-122 adminGrant — the secret gate', () => {
  // 🔑 THE ASSERTION THAT CATCHES THE TRAP THAT ALREADY BIT THIS PROJECT.
  // SEED_OPTS' own docstring records it: both sibling endpoints were declared
  // as bare `onRequest`, so `firebase functions:secrets:set SEED_SECRET`
  // created a Secret Manager entry that NEVER REACHED THE RUNTIME.
  // `process.env.SEED_SECRET` stayed undefined, the fail-closed gate did
  // exactly what it should, and every request 403'd forever — "which reads as
  // a wrong secret rather than an unbound one".
  //
  // Deleting `SEED_OPTS` from the onRequest call is a mutation that TYPECHECKS,
  // deploys, and passes every other test in this file. This is the only thing
  // that catches it before production does.
  test('🔴 it DECLARES the secret, or the deployment 403s forever', () => {
    expect(adminGrant._opts?.secrets).toContain('SEED_SECRET');
  });

  test('a GET is refused before any secret is considered', async () => {
    const res = makeRes();
    await adminGrant._handler({ method: 'GET', get: () => undefined }, res);
    expect(res.statusCode).toBe(405);
  });

  test('🔴 FAILS CLOSED when SEED_SECRET is unset — and says which problem it is', async () => {
    delete process.env.SEED_SECRET;
    const res = makeRes();
    await adminGrant._handler(makeReq({ 'x-seed-secret': 'anything' }), res);

    expect(res.statusCode).toBe(403);
    // An unbound secret is a SERVER CONFIGURATION problem with a different fix
    // from a wrong header, and the person reading this is holding a string
    // wondering which of the two they have.
    expect(String(res.body)).toMatch(/not bound/i);
    expect(String(res.body)).toMatch(/functions:secrets:set/);
  });

  test('a wrong secret is a DIFFERENT 403 from an unbound one', async () => {
    process.env.SEED_SECRET = SECRET;
    const unbound = makeRes();
    delete process.env.SEED_SECRET;
    await adminGrant._handler(makeReq({ 'x-seed-secret': 'wrong' }), unbound);

    process.env.SEED_SECRET = SECRET;
    const wrong = makeRes();
    await adminGrant._handler(makeReq({ 'x-seed-secret': 'wrong' }), wrong);

    expect(unbound.statusCode).toBe(403);
    expect(wrong.statusCode).toBe(403);
    // Same status, different diagnosis. seedShopData collapses both into a bare
    // 'Forbidden' and that is the shape that cost real time.
    expect(String(unbound.body)).not.toBe(String(wrong.body));
  });

  test('🔴 NEITHER message leaks the secret — they name the failure, not the value', async () => {
    process.env.SEED_SECRET = SECRET;
    const wrong = makeRes();
    await adminGrant._handler(makeReq({ 'x-seed-secret': 'wrong' }), wrong);
    expect(String(wrong.body)).not.toContain(SECRET);

    delete process.env.SEED_SECRET;
    const unbound = makeRes();
    await adminGrant._handler(makeReq({ 'x-seed-secret': 'wrong' }), unbound);
    expect(String(unbound.body)).not.toContain(SECRET);
  });

  test('a missing header is refused exactly like a wrong one', async () => {
    process.env.SEED_SECRET = SECRET;
    const res = makeRes();
    await adminGrant._handler(makeReq({}), res);
    expect(res.statusCode).toBe(403);
  });
});

describe('🔴 W2-122 adminGrant — dry run is the default', () => {
  beforeEach(() => {
    process.env.SEED_SECRET = SECRET;
  });

  /** A request with a body, past the gate. */
  function grantReq(body: Record<string, unknown>) {
    return {
      method: 'POST',
      body,
      get: (name: string) =>
        name.toLowerCase() === 'x-seed-secret' ? SECRET : undefined,
    };
  }

  test('a valid grant with no `apply` writes NOTHING and says so', async () => {
    const res = makeRes();
    await adminGrant._handler(
      grantReq({ uid: 'uid-1', grantId: 'g1', sponges: 1000 }),
      res,
    );

    expect(res.statusCode).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body.dryRun).toBe(true);
    expect(body.wouldGrant).toMatchObject({ uid: 'uid-1', sponges: 1000 });
    // The transaction is the only thing that writes, and it was never entered.
    expect(_db.runTransaction).not.toHaveBeenCalled();
  });

  // 🔴 `apply` MUST BE THE BOOLEAN. A stray `"apply": "false"` is a STRING and
  // therefore truthy — under a truthiness check that request would issue a real
  // grant while the operator believed they had disabled it. This is the one
  // that turns a preview into a production write.
  test('🔴 a STRING "false" does not apply — truthiness is not the test', async () => {
    const res = makeRes();
    await adminGrant._handler(
      grantReq({ uid: 'uid-1', grantId: 'g2', sponges: 1000, apply: 'false' }),
      res,
    );
    expect((res.body as Record<string, unknown>).dryRun).toBe(true);
    expect(_db.runTransaction).not.toHaveBeenCalled();
  });

  test('a refused grant is a 400 that names the refusal, and still writes nothing', async () => {
    const res = makeRes();
    await adminGrant._handler(
      grantReq({ uid: 'uid-1', grantId: 'g3', itemIds: ['char_not_real'], apply: true }),
      res,
    );
    expect(res.statusCode).toBe(400);
    const body = res.body as Record<string, unknown>;
    expect(body.refusal).toBe('unknown-item');
    expect(body.detail).toBe('char_not_real');
    expect(_db.runTransaction).not.toHaveBeenCalled();
  });
});
