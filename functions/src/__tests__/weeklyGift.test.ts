// Force module scope. Without a top-level import/export a .ts file is a SCRIPT,
// so its top-level `const _db` lands in the GLOBAL scope and collides with the
// identically-named one in its sibling test files (TS2451). See W3-09.
export {};

// functions/src/__tests__/weeklyGift.test.ts
//
// claimWeeklyGift — the free tier's 20 sponges, once per calendar week.
//
// Brendan, 2026-08-14: "The free get 20 sponges a week on sunday as a gift,
// pro gets 80 when you buy the premium". The pro half is a BILLING-EVENT grant
// and is not this callable; the tests below say so out loud, because a pro
// account silently receiving the free tier's 20 is the failure mode and a
// silence in the suite is how that ships.

const _db: {
  doc: jest.Mock;
  runTransaction: jest.Mock;
} = {
  doc: jest.fn(),
  runTransaction: jest.fn(),
};

jest.mock('firebase-admin', () => {
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = {
    increment: (n: number) => ({ _type: 'increment', n }),
  };
  firestoreFn.Timestamp = {
    now: () => ({ seconds: 0, nanoseconds: 0 }),
    fromDate: (d: Date) => ({ _date: d }),
  };
  return {
    initializeApp: jest.fn(),
    firestore: firestoreFn,
    auth: jest.fn(() => ({ getUser: jest.fn(), createUser: jest.fn(), updateUser: jest.fn() })),
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
  onSchedule: (_s: string, handler: () => any) => ({ _handler: handler }),
}));

jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_s: any, handler: (e: any) => any) => ({ _handler: handler }),
}));

jest.mock('firebase-functions/v1/auth', () => ({
  user: () => ({ onCreate: (handler: (u: any) => any) => ({ _handler: handler }) }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { claimWeeklyGift, mostRecentSundayUtc, WEEKLY_FREE_GIFT_SPONGES } =
  require('../index') as {
    claimWeeklyGift: { _handler: (req: any) => Promise<any> };
    mostRecentSundayUtc: (now: Date) => string;
    WEEKLY_FREE_GIFT_SPONGES: number;
  };

// ---------------------------------------------------------------------------
// Harness — a docStore the transaction reads and writes through real refs.
// ---------------------------------------------------------------------------

const docStore: Record<string, Record<string, unknown> | undefined> = {};

function seed(path: string, data: Record<string, unknown> | undefined) {
  docStore[path] = data;
}

function makeRef(path: string) {
  return {
    path,
    get: jest.fn(async () => ({
      exists: docStore[path] !== undefined,
      data: () => docStore[path],
    })),
    set: jest.fn(async (val: Record<string, unknown>) => {
      const prev = docStore[path] ?? {};
      const next: Record<string, unknown> = { ...prev };
      for (const [k, v] of Object.entries(val)) {
        const inc = v as { _type?: string; n?: number };
        next[k] =
          inc && inc._type === 'increment'
            ? ((prev[k] as number) ?? 0) + (inc.n ?? 0)
            : v;
      }
      docStore[path] = next;
    }),
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of Object.keys(docStore)) delete docStore[k];
  _db.doc.mockImplementation((path: string) => makeRef(path));
  _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
    const tx = {
      get: (ref: any) => ref.get(),
      set: (ref: any, val: any, opts: any) => ref.set(val, opts),
    };
    return fn(tx);
  });
});

const call = (uid: string | null = 'uid-a') =>
  claimWeeklyGift._handler({ auth: uid ? { uid } : null, data: {} });

const balance = (uid = 'uid-a') =>
  docStore[`users/${uid}/profile/data`]?.spongeBalance;

// ---------------------------------------------------------------------------
// W2-67 — "a pro account" now means a pro account whose subscription is LIVE.
//
// Before this, the refusals below seeded a tier string and no expiry, because
// `subscriptionExpiresAt` was written by verifySubscriptionReceipt and read by
// nothing. `resolveEffectiveTier` reads it, and fails closed: a paid tier with
// no readable expiry is not a paid tier. So a bare `{ subscriptionTier: 'pro' }`
// document no longer describes a subscriber at all — it describes someone whose
// entitlement cannot be established, which resolves to free.
//
// 🔑 The refusal cases therefore seed a live expiry. Their subject is unchanged
// and they still fail if the free-only gate is removed; what changed is that
// stating "this user is a pro" now requires saying until when. The lapsed
// counterparts added beneath each one are the new behaviour, and they are a
// change in the GENEROUS direction: a former subscriber is a free user, and the
// free tier's gift is theirs.
// ---------------------------------------------------------------------------

/** The `{ _type: 'ts', ms }` sentinel this file's admin mock produces. */
const ts = (ms: number) => ({ _type: 'ts', ms });
const DAY = 86_400_000;
const liveExpiry = () => ts(Date.now() + 30 * DAY);
const lapsedExpiry = () => ts(Date.now() - 30 * DAY);

// ---------------------------------------------------------------------------
// The Sunday key — a date, never a duration
// ---------------------------------------------------------------------------

describe('mostRecentSundayUtc', () => {
  test('a Sunday is its own week', () => {
    // 2026-08-16 is a Sunday.
    expect(mostRecentSundayUtc(new Date('2026-08-16T12:00:00Z'))).toBe('2026-08-16');
  });

  test('every day of a week maps to the same Sunday', () => {
    const days = [
      '2026-08-16T00:00:00Z', // Sun
      '2026-08-17T09:00:00Z', // Mon
      '2026-08-20T23:59:59Z', // Thu
      '2026-08-22T23:59:59Z', // Sat
    ];
    for (const d of days) {
      expect(mostRecentSundayUtc(new Date(d))).toBe('2026-08-16');
    }
  });

  test('the next Sunday starts a new week', () => {
    expect(mostRecentSundayUtc(new Date('2026-08-23T00:00:00Z'))).toBe('2026-08-23');
  });

  test('it is UTC, not local — an hour before UTC midnight is still the old week', () => {
    // 23:00Z Saturday is Sunday in +02:00. The key must not follow the viewer.
    expect(mostRecentSundayUtc(new Date('2026-08-22T23:00:00Z'))).toBe('2026-08-16');
  });
});

// ---------------------------------------------------------------------------
// claimWeeklyGift
// ---------------------------------------------------------------------------

describe('claimWeeklyGift', () => {
  test('rejects an unauthenticated caller', async () => {
    await expect(call(null)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  test('a free account is paid the weekly sponges', async () => {
    seed('users/uid-a', { subscriptionTier: 'free' });
    seed('users/uid-a/profile/data', { spongeBalance: 5 });

    const res = await call();

    expect(res.amount).toBe(WEEKLY_FREE_GIFT_SPONGES);
    expect(balance()).toBe(5 + WEEKLY_FREE_GIFT_SPONGES);
  });

  test('an account with no tier field is free, and is paid', async () => {
    // Absent means free everywhere else in this codebase; it must here too, or
    // every account created before the field existed is silently excluded.
    seed('users/uid-a', {});
    seed('users/uid-a/profile/data', { spongeBalance: 0 });

    await call();

    expect(balance()).toBe(WEEKLY_FREE_GIFT_SPONGES);
  });

  test('a second claim in the same week is refused', async () => {
    seed('users/uid-a', { subscriptionTier: 'free' });
    seed('users/uid-a/profile/data', { spongeBalance: 0 });

    await call();
    await expect(call()).rejects.toMatchObject({ code: 'already-exists' });
    expect(balance()).toBe(WEEKLY_FREE_GIFT_SPONGES);
  });

  test('🔴 a LIVE PRO account is refused — the 80 is a billing grant, not this', async () => {
    seed('users/uid-a', {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: liveExpiry(),
    });
    seed('users/uid-a/profile/data', { spongeBalance: 0 });

    await expect(call()).rejects.toMatchObject({ code: 'failed-precondition' });
    // Nothing written at all, not merely a smaller amount.
    expect(balance()).toBe(0);
    expect(docStore['users/uid-a/shop/data']).toBeUndefined();
  });

  test('a LAPSED pro account is paid — they are a free user now', async () => {
    // The W2-67 change, and the one case in this file that moves in the
    // generous direction. Same document as the refusal above, expiry behind us.
    seed('users/uid-a', {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: lapsedExpiry(),
    });
    seed('users/uid-a/profile/data', { spongeBalance: 0 });

    const res = await call();

    expect(res.amount).toBe(WEEKLY_FREE_GIFT_SPONGES);
    expect(balance()).toBe(WEEKLY_FREE_GIFT_SPONGES);
  });

  test('a pro account with NO expiry is paid — fails closed to free', async () => {
    // ⚠️ THE DIRECTION IS THE OPPOSITE OF EVERY OTHER FAIL-CLOSED CASE HERE, and
    // it is still fail-closed. Failing closed means refusing to certify a PAID
    // entitlement, not refusing to pay. An unreadable expiry means "not proven
    // to be a subscriber", and someone who is not a subscriber gets the free
    // tier's gift. Refusing here would deny a benefit on the strength of a claim
    // the server just declined to believe.
    seed('users/uid-a', { subscriptionTier: 'pro' });
    seed('users/uid-a/profile/data', { spongeBalance: 0 });

    await call();

    expect(balance()).toBe(WEEKLY_FREE_GIFT_SPONGES);
  });

  test('🔴 a stored LIVE PREMIUM decodes to pro and is refused, not paid as free', async () => {
    // The fail-closed case. `premium` retired in #314 but documents still carry
    // it; normalizeTier resolves it to `pro`. If it fell through to free instead,
    // a paying user would collect the free tier's gift on top of what they buy.
    seed('users/uid-a', {
      subscriptionTier: 'premium',
      subscriptionExpiresAt: liveExpiry(),
    });
    seed('users/uid-a/profile/data', { spongeBalance: 0 });

    await expect(call()).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(balance()).toBe(0);
  });

  test('a stored LAPSED premium is paid — decode first, then check the clock', async () => {
    // Order matters and this pins it. Decoding `premium` to `pro` and THEN
    // lapsing it reaches free; lapsing first would too, but for the wrong
    // reason — and the live case above would then also read as free.
    seed('users/uid-a', {
      subscriptionTier: 'premium',
      subscriptionExpiresAt: lapsedExpiry(),
    });
    seed('users/uid-a/profile/data', { spongeBalance: 0 });

    await call();

    expect(balance()).toBe(WEEKLY_FREE_GIFT_SPONGES);
  });

  test('🔴 an UNRECOGNISED LIVE tier is refused, not paid', async () => {
    // normalizeTier passes an unknown string through unchanged, so it is not
    // exactly 'free' and is refused. For a CAP, failing closed means resolving
    // to free; for a GRANT that only free receives, it means not paying.
    seed('users/uid-a', {
      subscriptionTier: 'platinum',
      subscriptionExpiresAt: liveExpiry(),
    });
    seed('users/uid-a/profile/data', { spongeBalance: 0 });

    await expect(call()).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(balance()).toBe(0);
  });

  test('the claim is keyed on the Sunday, so a new week pays again', async () => {
    seed('users/uid-a', { subscriptionTier: 'free' });
    seed('users/uid-a/profile/data', { spongeBalance: 0 });

    await call();
    const claimed = docStore['users/uid-a/shop/data']?.lastWeeklyGiftSunday;
    expect(typeof claimed).toBe('string');

    // Simulate the week rolling over by ageing the stored key, which is exactly
    // what a real week does to it.
    seed('users/uid-a/shop/data', { lastWeeklyGiftSunday: '2020-01-05' });

    await call();
    expect(balance()).toBe(2 * WEEKLY_FREE_GIFT_SPONGES);
  });
});
