// Force module scope. Without a top-level import/export a .ts file is a SCRIPT,
// so its top-level `const _db` lands in the GLOBAL scope and collides with the
// identically-named one in nine sibling test files (TS2451). Which pair collides
// depends on how ts-jest groups files into a worker, which is why the suite failed
// non-deterministically on a different file each run. Pre-existing; see W3-09.
export {};

// functions/src/__tests__/sendGiftInvite.test.ts
//
// Unit tests for the sendGiftInvite callable CF.
// Mocks firebase-admin so no emulator is required.

// ---------------------------------------------------------------------------
// firebase-admin mock — must be declared before any imports that trigger it.
// The factory is hoisted by Jest; we expose _db so tests can configure it.
// ---------------------------------------------------------------------------

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

// firebase-functions/v2 mock — avoids gRPC / env setup
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

// ---------------------------------------------------------------------------
// Import after mocks are in place
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sendGiftInvite } = require('../index') as {
  sendGiftInvite: { _handler: (req: any) => Promise<any> };
};

// Helper: call the underlying handler directly
async function callHandler(data: Record<string, unknown>, uid?: string) {
  const request = {
    auth: uid ? { uid } : null,
    data,
  };
  return sendGiftInvite._handler(request);
}

// ---------------------------------------------------------------------------
// Helpers for configuring mock Firestore
// ---------------------------------------------------------------------------

function makeDocRef(snapData: Record<string, unknown> | null, exists = true) {
  return {
    exists: snapData !== null && exists,
    data: () => snapData,
    id: 'mock-doc-id',
  };
}

function setupDocSequence(snaps: Array<Record<string, unknown> | null>) {
  let call = 0;
  _db.doc.mockImplementation(() => {
    const snap = snaps[call] ?? null;
    call++;
    return {
      get: jest.fn().mockResolvedValue(makeDocRef(snap, snap !== null)),
      set: jest.fn().mockResolvedValue(undefined),
      id: `doc-${call}`,
    };
  });
  _db.collection.mockImplementation(() => ({
    doc: jest.fn(() => ({
      get: jest.fn().mockResolvedValue(makeDocRef(null, false)),
      set: jest.fn().mockResolvedValue(undefined),
      id: 'new-invite',
    })),
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sendGiftInvite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      const tx = {
        get: jest.fn(async (ref: any) => ref.get()),
        set: jest.fn().mockResolvedValue(undefined),
      };
      return fn(tx);
    });
  });

  test('throws unauthenticated when called without auth', async () => {
    await expect(callHandler({ recipientUid: 'uid-b' })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  test('throws invalid-argument when sender and recipient are the same', async () => {
    await expect(
      callHandler({ recipientUid: 'uid-a' }, 'uid-a'),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('throws invalid-argument when recipientUid is missing', async () => {
    await expect(callHandler({}, 'uid-a')).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  test('throws failed-precondition when recipient is not an accepted friend', async () => {
    // friend doc doesn't exist → non-friend
    setupDocSequence([null]);

    await expect(
      callHandler({ recipientUid: 'uid-b' }, 'uid-a'),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('throws resource-exhausted when free-tier daily limit is reached', async () => {
    // friend doc exists + accepted, profile, user doc (free), inviteCount (count=1 = limit)
    setupDocSequence([
      { status: 'accepted' },             // friend doc
      { displayName: 'Alice' },           // sender profile
      { subscriptionTier: 'free' },       // user (tier)
    ]);
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      const countRef = {
        get: jest.fn().mockResolvedValue(makeDocRef({ count: 1 })),
        set: jest.fn().mockResolvedValue(undefined),
        id: 'today',
      };
      const tx = {
        get: jest.fn().mockResolvedValue(makeDocRef({ count: 1 })),
        set: jest.fn().mockResolvedValue(undefined),
      };
      return fn({ ...tx, _countRef: countRef });
    });

    await expect(
      callHandler({ recipientUid: 'uid-b' }, 'uid-a'),
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  test('returns remaining=0 for free-tier first successful send', async () => {
    setupDocSequence([
      { status: 'accepted' },       // friend
      { displayName: 'Alice' },     // profile
      { subscriptionTier: 'free' }, // user
    ]);
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      const tx = {
        get: jest.fn().mockResolvedValue(makeDocRef({ count: 0 })),
        set: jest.fn().mockResolvedValue(undefined),
      };
      return fn(tx);
    });

    const result = await callHandler({ recipientUid: 'uid-b' }, 'uid-a');
    expect(result).toEqual({ remaining: 0 });
  });

  test('reads the sender name from publicProfiles, not profile/data', async () => {
    // The name used to be read from users/{uid}/profile/data, which nothing
    // has ever written — so every invite arrived as 'A friend'. It now comes
    // from the projection, which sources displayName off the Firebase Auth
    // record. Asserting the PATH is the point of this test; the other cases
    // in this file drive _db.doc positionally and would not notice a move.
    const invite = { set: jest.fn().mockResolvedValue(undefined), id: 'inv-1' };
    const paths: string[] = [];
    _db.doc.mockImplementation((path: string) => {
      paths.push(path);
      const snap = path === `users/uid-a/friends/uid-b`
        ? { status: 'accepted' }
        : path === 'publicProfiles/uid-a'
          ? { displayName: 'Alice' }
          : { subscriptionTier: 'free' };
      return {
        get: jest.fn().mockResolvedValue(makeDocRef(snap)),
        set: jest.fn().mockResolvedValue(undefined),
        id: 'mock-doc-id',
      };
    });
    _db.collection.mockImplementation(() => ({ doc: jest.fn(() => invite) }));
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      const tx = {
        get: jest.fn().mockResolvedValue(makeDocRef({ count: 0 })),
        set: jest.fn().mockResolvedValue(undefined),
      };
      return fn(tx);
    });

    await callHandler({ recipientUid: 'uid-b' }, 'uid-a');

    expect(paths).toContain('publicProfiles/uid-a');
    expect(paths).not.toContain('users/uid-a/profile/data');
  });

  test("falls back to 'A friend' when the projection has an empty name", async () => {
    // buildPublicProfile writes displayName: '' for a user with no Auth name,
    // so the fallback has to be || and not ?? — '' is not nullish and would
    // otherwise be sent as the sender's name.
    setupDocSequence([
      { status: 'accepted' },
      { displayName: '' },          // projection, no Auth display name
      { subscriptionTier: 'free' },
    ]);
    const invite = { set: jest.fn().mockResolvedValue(undefined), id: 'inv-1' };
    _db.collection.mockImplementation(() => ({ doc: jest.fn(() => invite) }));
    let written: Record<string, unknown> = {};
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      const tx = {
        get: jest.fn().mockResolvedValue(makeDocRef({ count: 0 })),
        set: jest.fn((_ref: unknown, data: Record<string, unknown>) => {
          if (data?.fromDisplayName !== undefined) written = data;
        }),
      };
      return fn(tx);
    });

    await callHandler({ recipientUid: 'uid-b' }, 'uid-a');

    expect(written.fromDisplayName).toBe('A friend');
  });
});

// ---------------------------------------------------------------------------
// remaining is a count, never a sentinel (W2-64)
//
// The return used to be:
//   const remaining = limit === Infinity ? Infinity : limit - currentCount - 1;
//   return { remaining: remaining === Infinity ? -1 : remaining };
//
// `-1` meant UNLIMITED — a sentinel riding the same channel as a real count, so
// a client had to know that one value of a number meant "not a number". It went
// dead when #315 removed `premium: Infinity`, the only unbounded entry, but the
// encoding outlived the value it existed to carry.
//
// 🔑 The obvious misreading is that a negative meant an at-cap user. It never
// did: `currentCount >= limit` THROWS resource-exhausted before the return is
// reached, so being at the cap leaves by a different door. These cases pin both
// ends of the real range so the sentinel cannot come back as an interpretation.
// ---------------------------------------------------------------------------

// W2-67 — a tier string alone no longer describes a subscriber. The pro
// allowance is an entitlement and `resolveEffectiveTier` checks it against the
// clock, failing closed, so these cases must say until when.
const DAY = 86_400_000;
/** The `{ _type: 'ts', ms }` sentinel this file's admin mock produces. */
const liveExpiry = () => ({ _type: 'ts', ms: Date.now() + 30 * DAY });
const lapsedExpiry = () => ({ _type: 'ts', ms: Date.now() - 30 * DAY });

describe('sendGiftInvite — remaining is a count, never a sentinel', () => {
  test('a live pro tier reports a real count, not unlimited', async () => {
    setupDocSequence([
      { status: 'accepted' },
      { displayName: 'Alice' },
      { subscriptionTier: 'pro', subscriptionExpiresAt: liveExpiry() },
    ]);
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      const tx = {
        get: jest.fn().mockResolvedValue(makeDocRef({ count: 0 })),
        set: jest.fn().mockResolvedValue(undefined),
      };
      return fn(tx);
    });

    // 5 - 0 - 1. Nothing on this path can report an unbounded allowance, and
    // pro is the most generous tier that exists — so if any tier could still
    // return the sentinel it would be this one.
    const result = await callHandler({ recipientUid: 'uid-b' }, 'uid-a');
    expect(result).toEqual({ remaining: 4 });
  });

  test('the last send in a tier returns 0, never a negative', async () => {
    // The boundary the sentinel used to sit next to: one below the cap. The
    // send succeeds and reports zero left. One more would throw, which the
    // resource-exhausted case above already covers.
    setupDocSequence([
      { status: 'accepted' },
      { displayName: 'Alice' },
      { subscriptionTier: 'pro', subscriptionExpiresAt: liveExpiry() },
    ]);
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      const tx = {
        get: jest.fn().mockResolvedValue(makeDocRef({ count: 4 })),
        set: jest.fn().mockResolvedValue(undefined),
      };
      return fn(tx);
    });

    const result = await callHandler({ recipientUid: 'uid-b' }, 'uid-a');
    expect(result).toEqual({ remaining: 0 });
    expect((result as { remaining: number }).remaining).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// W2-67 — the paid invite allowance lapses with the subscription.
//
// `sendGiftInvite` gives pro 5 invites a day and free 1. It read the stored
// tier string and nothing else, so a subscriber who cancelled months ago kept
// the 5 for ever. The pair below is matched deliberately: the lapsed case is
// the fix and the live case is the control that proves it is the CLOCK doing
// the work, not `pro` having quietly stopped meaning anything.
// ---------------------------------------------------------------------------

describe('sendGiftInvite — the paid allowance lapses', () => {
  const firstSendOfTheDay = () => {
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      const tx = {
        get: jest.fn().mockResolvedValue(makeDocRef({ count: 0 })),
        set: jest.fn().mockResolvedValue(undefined),
      };
      return fn(tx);
    });
  };

  test('an EXPIRED pro falls to the free allowance of 1', async () => {
    setupDocSequence([
      { status: 'accepted' },
      { displayName: 'Alice' },
      { subscriptionTier: 'pro', subscriptionExpiresAt: lapsedExpiry() },
    ]);
    firstSendOfTheDay();

    // 1 - 0 - 1 = 0. A live pro reports 4 here; the only difference between the
    // two documents is which side of now the expiry falls on.
    const result = await callHandler({ recipientUid: 'uid-b' }, 'uid-a');
    expect(result).toEqual({ remaining: 0 });
  });

  test('a pro with NO expiry falls to the free allowance of 1', async () => {
    // Fails closed. Until W2-67 this document was indistinguishable from a paid
    // one, and it is exactly what a partial or hand-edited write produces.
    setupDocSequence([
      { status: 'accepted' },
      { displayName: 'Alice' },
      { subscriptionTier: 'pro' },
    ]);
    firstSendOfTheDay();

    const result = await callHandler({ recipientUid: 'uid-b' }, 'uid-a');
    expect(result).toEqual({ remaining: 0 });
  });

  test('an expired pro is refused a SECOND invite the same day', async () => {
    // The count assertion above could pass while the cap itself still let a
    // sixth send through. This one exercises the refusal directly: at the free
    // cap of 1, a second send throws rather than reporting a negative.
    setupDocSequence([
      { status: 'accepted' },
      { displayName: 'Alice' },
      { subscriptionTier: 'pro', subscriptionExpiresAt: lapsedExpiry() },
    ]);
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      const tx = {
        get: jest.fn().mockResolvedValue(makeDocRef({ count: 1 })),
        set: jest.fn().mockResolvedValue(undefined),
      };
      return fn(tx);
    });

    await expect(
      callHandler({ recipientUid: 'uid-b' }, 'uid-a'),
    ).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  test('a LIVE pro is still allowed that second invite — the control', async () => {
    // Same count, same code path, live expiry. If this one also threw, the
    // test above would be pinning a broken cap rather than a lapsed one.
    setupDocSequence([
      { status: 'accepted' },
      { displayName: 'Alice' },
      { subscriptionTier: 'pro', subscriptionExpiresAt: liveExpiry() },
    ]);
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      const tx = {
        get: jest.fn().mockResolvedValue(makeDocRef({ count: 1 })),
        set: jest.fn().mockResolvedValue(undefined),
      };
      return fn(tx);
    });

    const result = await callHandler({ recipientUid: 'uid-b' }, 'uid-a');
    expect(result).toEqual({ remaining: 3 });
  });
});
