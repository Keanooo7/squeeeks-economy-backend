// Force module scope. Without a top-level import/export a .ts file is a SCRIPT,
// so its top-level `const _db` lands in the GLOBAL scope and collides with the
// identically-named one in nine sibling test files (TS2451). Which pair collides
// depends on how ts-jest groups files into a worker, which is why the suite failed
// non-deterministically on a different file each run. Pre-existing; see W3-09.
export {};

// functions/src/__tests__/claimGift.test.ts
//
// Unit tests for the claimGift callable CF.

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
  onSchedule: (_schedule: string, handler: () => any) => ({ _handler: handler }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { claimGift } = require('../index') as {
  claimGift: { _handler: (req: any) => Promise<any> };
};

async function callClaim(inviteId: string | undefined, uid = 'uid-a') {
  return claimGift._handler({
    auth: { uid },
    data: inviteId !== undefined ? { inviteId } : {},
  });
}

function makeRef(snapData: Record<string, unknown> | null) {
  return {
    get: jest.fn().mockResolvedValue({
      exists: snapData !== null,
      data: () => snapData,
    }),
    set: jest.fn().mockResolvedValue(undefined),
    id: 'inv-1',
  };
}

describe('claimGift', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('throws not-found when invite does not exist', async () => {
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      const ref = makeRef(null);
      _db.doc.mockReturnValue(ref);
      const tx = {
        get: jest.fn().mockResolvedValue({ exists: false, data: () => null }),
        set: jest.fn(),
      };
      return fn(tx);
    });

    await expect(callClaim('inv-missing')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  test('throws already-exists when invite is already claimed', async () => {
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      const tx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({ claimed: true, amount: 10 }),
        }),
        set: jest.fn(),
      };
      return fn(tx);
    });

    await expect(callClaim('inv-1')).rejects.toMatchObject({
      code: 'already-exists',
    });
  });

  test('returns amount on successful claim', async () => {
    _db.doc.mockImplementation(() => ({
      get: jest.fn(),
      set: jest.fn(),
      id: 'inv-1',
    }));
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      const tx = {
        get: jest.fn().mockResolvedValue({
          exists: true,
          data: () => ({ claimed: false, amount: 20 }),
        }),
        set: jest.fn().mockResolvedValue(undefined),
      };
      return fn(tx);
    });

    const result = await callClaim('inv-1');
    expect(result).toEqual({ amount: 20 });
  });
});
