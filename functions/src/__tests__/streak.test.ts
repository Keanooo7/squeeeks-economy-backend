// Force module scope. Without a top-level import/export a .ts file is a SCRIPT,
// so its top-level `const _db` lands in the GLOBAL scope and collides with the
// identically-named one in nine sibling test files (TS2451). Which pair collides
// depends on how ts-jest groups files into a worker, which is why the suite failed
// non-deterministically on a different file each run. Pre-existing; see W3-09.
export {};

// functions/src/__tests__/streak.test.ts
//
// Unit tests for the Streak callables + naive-local date helpers. Mirrors the
// path-keyed Firestore mock from verifyIapAndGrant.test.ts. The focus is the
// economy invariants (no partial commits, shield caps, idempotent milestone
// payouts) and the 4 AM naive-date cutoff math.

// ---------------------------------------------------------------------------
// Path-keyed Firestore mock (declared before imports — Jest hoists the factory)
// ---------------------------------------------------------------------------

interface DocState {
  data: Record<string, unknown> | null;
}
const docStore: Record<string, DocState> = {};
let autoIdCounter = 0;

function resetStore() {
  for (const k of Object.keys(docStore)) delete docStore[k];
  autoIdCounter = 0;
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
  };
}

const _db = {
  doc: jest.fn((p: string) => docMock(p)),
  collection: jest.fn((p: string) => ({
    doc: jest.fn((id?: string) => docMock(`${p}/${id ?? `auto_${autoIdCounter++}`}`)),
    // recordTaskCompletion also pays the completion now, and grantTaskRewards
    // counts task docs via collection().where('completedDate','==',day). These
    // tests seed no tasks, so the query is empty and no reward is granted —
    // which is what this file wants: it asserts STREAK semantics only. The
    // reward path has its own coverage in xp.test.ts.
    where: jest.fn((field: string, _op: string, value: unknown) => ({
      get: jest.fn(async () => {
        const docs = Object.keys(docStore)
          .filter(
            (k) =>
              k.startsWith(`${p}/`) &&
              docStore[k].data !== null &&
              docStore[k].data?.[field] === value,
          )
          .map((k) => ({
            id: k.split('/').pop(),
            ref: docMock(k),
            data: () => docStore[k].data,
          }));
        return { empty: docs.length === 0, size: docs.length, docs };
      }),
    })),
  })),
  runTransaction: jest.fn(),
};

jest.mock('firebase-admin', () => {
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = {
    increment: (n: number) => ({ _type: 'increment', n }),
    arrayUnion: (...vals: unknown[]) => ({ _type: 'arrayUnion', vals }),
  };
  firestoreFn.Timestamp = {
    now: () => ({ _type: 'ts', ms: 0 }),
    fromDate: (d: Date) => ({ _type: 'ts', ms: d.getTime() }),
    fromMillis: (ms: number) => ({ _type: 'ts', ms }),
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
    details?: unknown;
    constructor(code: string, message: string, details?: unknown) {
      super(message);
      this.code = code;
      this.details = details;
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
  purchaseStreakShield,
  recordTaskCompletion,
  resolveStreak,
  awardStreakReward,
} = require('../index') as {
  purchaseStreakShield: { _handler: (req: any) => Promise<any> };
  recordTaskCompletion: { _handler: (req: any) => Promise<any> };
  resolveStreak: { _handler: (req: any) => Promise<any> };
  awardStreakReward: { _handler: (req: any) => Promise<any> };
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseNaiveDate, streakDate, toNaiveIso } = require('../streak') as {
  parseNaiveDate: (s: string) => Date;
  streakDate: (d: Date) => Date;
  toNaiveIso: (d: Date) => string;
};

function seedDoc(path: string, data: Record<string, unknown> | null) {
  docStore[path] = { data };
}

// Transaction that reads/writes the shared docStore through the doc refs.
function realisticTransaction() {
  _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
    const tx = {
      get: (ref: any) => ref.get(),
      set: (ref: any, val: any, opts: any) => ref.set(val, opts),
      create: (ref: any, val: any) => ref.set(val),
    };
    return fn(tx);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  realisticTransaction();
});

// ---------------------------------------------------------------------------
// WARNING: THE SERVER CLOCK IS PINNED TO THE SIMULATED DAY (W2-174)
// ---------------------------------------------------------------------------
//
// `recordTaskCompletion` now BOUNDS the client's day key against the server's
// own UTC date and refuses anything more than a day away — which is the whole
// point of the fix, and which makes every `2026-06-29` call below an
// `invalid-argument` when the real clock is some other month.
//
// KEY: PINNING THE CLOCK IS THE HONEST REPAIR, NOT FLOATING THE DATES. These
// cases assert day-boundary behaviour — the cap resetting on the next day,
// yesterday's completions not paying again — and a floating date would make
// them assert it against a moving target. The simulated day is the fixture;
// the server clock simply has to agree with it.
//
// NOTE: Declared AFTER the hook above so it runs after `jest.clearAllMocks()`,
// which would otherwise wipe the spy on the first test of every file.
const SIMULATED_SERVER_NOW = Date.parse('2026-06-29T12:00:00.000Z');
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(SIMULATED_SERVER_NOW);
});
afterAll(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// streak.ts helpers
// ---------------------------------------------------------------------------

describe('streak date helpers', () => {
  // streakDate floors (ts - 4h) to a calendar day. Compare via toNaiveIso so we
  // assert on the same naive frame the helpers operate in.
  test('streakDate: 3 AM belongs to the previous calendar day', () => {
    expect(toNaiveIso(streakDate(parseNaiveDate('2026-06-29T03:00:00.000000')))).toBe(
      '2026-06-28T00:00:00.000',
    );
  });

  test('streakDate: 5 AM belongs to the same calendar day', () => {
    expect(toNaiveIso(streakDate(parseNaiveDate('2026-06-29T05:00:00.000000')))).toBe(
      '2026-06-29T00:00:00.000',
    );
  });

  test('streakDate: midnight belongs to the previous day (00:00 < 04:00)', () => {
    expect(toNaiveIso(streakDate(parseNaiveDate('2026-06-29T00:00:00.000000')))).toBe(
      '2026-06-28T00:00:00.000',
    );
  });

  test('toNaiveIso produces no Z suffix', () => {
    expect(toNaiveIso(parseNaiveDate('2026-06-29T14:32:05.000000'))).not.toContain('Z');
  });

  test('parseNaiveDate + toNaiveIso round-trip stays naive', () => {
    const s = '2026-06-29T14:32:05.000000';
    const round = toNaiveIso(parseNaiveDate(s));
    expect(round).not.toContain('Z');
    expect(round.startsWith('2026-06-29T14:32:05')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// purchaseStreakShield
// ---------------------------------------------------------------------------

describe('purchaseStreakShield', () => {
  const call = (uid?: string) =>
    purchaseStreakShield._handler({ auth: uid ? { uid } : null, data: {} });

  test('throws unauthenticated without auth', async () => {
    await expect(call()).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  test('happy path: balance 200 + shields 0 → balance 50, shields 1', async () => {
    seedDoc('users/uid-a', { streakShields: 0 });
    seedDoc('users/uid-a/profile/data', { spongeBalance: 200 });

    const res = await call('uid-a');

    expect(res).toEqual({ shields: 1, spent: 150, balance: 50 });
    expect(docStore['users/uid-a'].data?.streakShields).toEqual({ _type: 'increment', n: 1 });
    expect(docStore['users/uid-a/profile/data'].data?.spongeBalance).toEqual({
      _type: 'increment',
      n: -150,
    });
  });

  test('shield cap (shields == 2) → failed-precondition, no mutation', async () => {
    seedDoc('users/uid-a', { streakShields: 2 });
    seedDoc('users/uid-a/profile/data', { spongeBalance: 500 });

    await expect(call('uid-a')).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(docStore['users/uid-a'].data).toEqual({ streakShields: 2 });
    expect(docStore['users/uid-a/profile/data'].data).toEqual({ spongeBalance: 500 });
  });

  test('insufficient balance (100 < 150) → failed-precondition, no mutation', async () => {
    seedDoc('users/uid-a', { streakShields: 0 });
    seedDoc('users/uid-a/profile/data', { spongeBalance: 100 });

    await expect(call('uid-a')).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(docStore['users/uid-a'].data).toEqual({ streakShields: 0 });
    expect(docStore['users/uid-a/profile/data'].data).toEqual({ spongeBalance: 100 });
  });

  test('allows a second purchase (shields 1 → 2)', async () => {
    seedDoc('users/uid-a', { streakShields: 1 });
    seedDoc('users/uid-a/profile/data', { spongeBalance: 300 });

    const res = await call('uid-a');
    expect(res.shields).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// recordTaskCompletion
// ---------------------------------------------------------------------------

describe('recordTaskCompletion', () => {
  const streakPath = 'users/uid-a/streak/main';
  const call = (clientNowIso: string, uid: string | null = 'uid-a') =>
    recordTaskCompletion._handler({ auth: uid ? { uid } : null, data: { clientNowIso } });

  test('throws unauthenticated without auth', async () => {
    await expect(call('2026-06-29T10:00:00.000000', null)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  test('rejects a missing clientNowIso', async () => {
    await expect(
      recordTaskCompletion._handler({ auth: { uid: 'uid-a' }, data: {} }),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('no existing streak doc → creates streak=1, longest=1, not broken', async () => {
    await call('2026-06-29T10:00:00.000000');

    const data = docStore[streakPath].data as Record<string, any>;
    expect(data.currentStreak).toBe(1);
    expect(data.longestStreak).toBe(1);
    expect(data.isBroken).toBe(false);
    expect(data.lastCompletionDate).toBe('2026-06-29T10:00:00.000000');
    expect(data.streakStartDate.startsWith('2026-06-29')).toBe(true);
  });

  test('same streak-day second call → no-op (currentStreak unchanged)', async () => {
    seedDoc(streakPath, {
      habitId: 'main',
      currentStreak: 3,
      longestStreak: 5,
      lastCompletionDate: '2026-06-29T08:00:00.000000',
      streakStartDate: '2026-06-27T00:00:00.000',
      isBroken: false,
    });

    // 08:00 and 20:00 both map to streak-day 2026-06-29 (>= 04:00 cutoff).
    await call('2026-06-29T20:00:00.000000');

    expect((docStore[streakPath].data as Record<string, any>).currentStreak).toBe(3);
    expect((docStore[streakPath].data as Record<string, any>).lastCompletionDate).toBe(
      '2026-06-29T08:00:00.000000',
    );
  });

  test('gap == 1 (consecutive) → currentStreak+1, longest tracks, naive date written', async () => {
    seedDoc(streakPath, {
      currentStreak: 3,
      longestStreak: 5,
      lastCompletionDate: '2026-06-28T10:00:00.000000',
      streakStartDate: '2026-06-26T00:00:00.000',
      isBroken: false,
    });

    await call('2026-06-29T10:00:00.000000');

    const data = docStore[streakPath].data as Record<string, any>;
    expect(data.currentStreak).toBe(4);
    expect(data.longestStreak).toBe(5);
    expect(data.isBroken).toBe(false);
    expect(data.lastCompletionDate).toBe('2026-06-29T10:00:00.000000');
    expect(data.lastCompletionDate).not.toContain('Z');
  });

  test('gap > 1 with shields > 0 → consumes 1 shield, keeps streak alive', async () => {
    seedDoc('users/uid-a', { streakShields: 1 });
    seedDoc(streakPath, {
      currentStreak: 5,
      longestStreak: 7,
      lastCompletionDate: '2026-06-25T10:00:00.000000',
      streakStartDate: '2026-06-21T00:00:00.000',
      isBroken: false,
    });

    await call('2026-06-29T10:00:00.000000'); // gap of 4 days

    expect(docStore['users/uid-a'].data?.streakShields).toEqual({ _type: 'increment', n: -1 });
    const data = docStore[streakPath].data as Record<string, any>;
    expect(data.currentStreak).toBe(6);
    expect(data.isBroken).toBe(false);
  });

  test('gap > 1 with shields == 0 → reset to 1, isBroken, streakStartDate = today', async () => {
    seedDoc('users/uid-a', { streakShields: 0 });
    seedDoc(streakPath, {
      currentStreak: 5,
      longestStreak: 7,
      lastCompletionDate: '2026-06-25T10:00:00.000000',
      streakStartDate: '2026-06-21T00:00:00.000',
      isBroken: false,
    });

    await call('2026-06-29T10:00:00.000000');

    const data = docStore[streakPath].data as Record<string, any>;
    expect(data.currentStreak).toBe(1);
    expect(data.isBroken).toBe(true);
    expect(data.streakStartDate.startsWith('2026-06-29')).toBe(true);
  });

  test('longestStreak does not decrease when currentStreak resets', async () => {
    seedDoc('users/uid-a', { streakShields: 0 });
    seedDoc(streakPath, {
      currentStreak: 5,
      longestStreak: 10,
      lastCompletionDate: '2026-06-25T10:00:00.000000',
      streakStartDate: '2026-06-21T00:00:00.000',
      isBroken: false,
    });

    await call('2026-06-29T10:00:00.000000'); // gap of 4 → reset (no shields)

    const data = docStore[streakPath].data as Record<string, any>;
    expect(data.currentStreak).toBe(1);
    expect(data.longestStreak).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// resolveStreak
// ---------------------------------------------------------------------------

describe('resolveStreak', () => {
  const streakPath = 'users/uid-a/streak/main';
  const call = (clientNowIso: string, uid: string | null = 'uid-a') =>
    resolveStreak._handler({ auth: uid ? { uid } : null, data: { clientNowIso } });

  test('throws unauthenticated without auth', async () => {
    await expect(call('2026-06-29T10:00:00.000000', null)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
  });

  test('no streak doc → { changed: false }', async () => {
    expect(await call('2026-06-29T10:00:00.000000')).toEqual({ changed: false });
  });

  test('gap <= 1 → { changed: false } (still active)', async () => {
    seedDoc(streakPath, {
      currentStreak: 3,
      isBroken: false,
      lastCompletionDate: '2026-06-28T10:00:00.000000',
    });
    expect(await call('2026-06-29T10:00:00.000000')).toEqual({ changed: false });
  });

  test('already broken → { changed: false } (idempotent)', async () => {
    seedDoc(streakPath, {
      currentStreak: 5,
      isBroken: true,
      lastCompletionDate: '2026-06-20T10:00:00.000000',
    });
    expect(await call('2026-06-29T10:00:00.000000')).toEqual({ changed: false });
  });

  test('gap == 2 (1 missed) with shields == 1 → shield consumed, re-anchored', async () => {
    seedDoc('users/uid-a', { streakShields: 1 });
    seedDoc(streakPath, {
      currentStreak: 4,
      isBroken: false,
      lastCompletionDate: '2026-06-27T10:00:00.000000',
    });

    const res = await call('2026-06-29T10:00:00.000000');

    expect(res).toEqual({ changed: true, shieldConsumed: 1, currentStreak: 4, shields: 0 });
    expect(docStore['users/uid-a'].data?.streakShields).toEqual({ _type: 'increment', n: -1 });
    const data = docStore[streakPath].data as Record<string, any>;
    expect(data.isBroken).toBe(false);
    // Re-anchored so the next completion sees gap == 1 (lastCompletion = yesterday).
    expect(toNaiveIso(streakDate(parseNaiveDate(data.lastCompletionDate)))).toBe(
      '2026-06-28T00:00:00.000',
    );
  });

  test('gap == 2 (1 missed) with shields == 0 → streak broken', async () => {
    seedDoc('users/uid-a', { streakShields: 0 });
    seedDoc(streakPath, {
      currentStreak: 4,
      isBroken: false,
      lastCompletionDate: '2026-06-27T10:00:00.000000',
    });

    const res = await call('2026-06-29T10:00:00.000000');

    expect(res).toEqual({ changed: true, shieldConsumed: 0, currentStreak: 0, shields: 0 });
    const data = docStore[streakPath].data as Record<string, any>;
    expect(data.currentStreak).toBe(0);
    expect(data.isBroken).toBe(true);
  });

  test('gap == 4 (3 missed) with shields == 3 → all consumed, re-anchored', async () => {
    seedDoc('users/uid-a', { streakShields: 3 });
    seedDoc(streakPath, {
      currentStreak: 10,
      isBroken: false,
      lastCompletionDate: '2026-06-25T10:00:00.000000',
    });

    const res = await call('2026-06-29T10:00:00.000000');

    expect(res).toEqual({ changed: true, shieldConsumed: 3, currentStreak: 10, shields: 0 });
    expect(docStore['users/uid-a'].data?.streakShields).toEqual({ _type: 'increment', n: -3 });
    const data = docStore[streakPath].data as Record<string, any>;
    expect(data.isBroken).toBe(false);
    expect(toNaiveIso(streakDate(parseNaiveDate(data.lastCompletionDate)))).toBe(
      '2026-06-28T00:00:00.000',
    );
  });

  test('gap == 4 (3 missed) with shields == 2 → not enough, broken', async () => {
    seedDoc('users/uid-a', { streakShields: 2 });
    seedDoc(streakPath, {
      currentStreak: 10,
      isBroken: false,
      lastCompletionDate: '2026-06-25T10:00:00.000000',
    });

    const res = await call('2026-06-29T10:00:00.000000');

    expect(res).toEqual({ changed: true, shieldConsumed: 0, currentStreak: 0, shields: 2 });
    const data = docStore[streakPath].data as Record<string, any>;
    expect(data.currentStreak).toBe(0);
    expect(data.isBroken).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// awardStreakReward
// ---------------------------------------------------------------------------

describe('awardStreakReward', () => {
  const streakPath = 'users/uid-a/streak/main';
  const profilePath = 'users/uid-a/profile/data';
  const call = (rewardId: string, uid: string | null = 'uid-a') =>
    awardStreakReward._handler({ auth: uid ? { uid } : null, data: { rewardId } });

  test('throws unauthenticated without auth', async () => {
    await expect(call('streak_7', null)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  test('unknown rewardId → invalid-argument', async () => {
    await expect(call('streak_999')).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('streak below threshold → failed-precondition', async () => {
    seedDoc(streakPath, { currentStreak: 5, longestStreak: 5, awardedMilestones: [] });
    await expect(call('streak_7')).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('uses longestStreak when current < threshold but longest >= threshold', async () => {
    seedDoc(streakPath, { currentStreak: 3, longestStreak: 10, awardedMilestones: [] });
    seedDoc(profilePath, { spongeBalance: 0 });

    const res = await call('streak_7');

    expect(res).toEqual({ rewardId: 'streak_7', sponges: 50, label: '7-Day Streak' });
    expect(docStore[profilePath].data?.spongeBalance).toEqual({ _type: 'increment', n: 50 });
  });

  test('happy path (streak_7, best = 7) → pays +50, arrayUnion, writes rewardHistory', async () => {
    seedDoc(streakPath, { currentStreak: 7, longestStreak: 7, awardedMilestones: [] });
    seedDoc(profilePath, { spongeBalance: 0 });

    const res = await call('streak_7');

    expect(res).toEqual({ rewardId: 'streak_7', sponges: 50, label: '7-Day Streak' });
    expect(docStore[profilePath].data?.spongeBalance).toEqual({ _type: 'increment', n: 50 });
    expect(docStore[streakPath].data?.awardedMilestones).toEqual({
      _type: 'arrayUnion',
      vals: ['streak_7'],
    });
    const historyKey = Object.keys(docStore).find((k) =>
      k.startsWith('users/uid-a/rewardHistory/'),
    );
    expect(historyKey).toBeDefined();
    expect((docStore[historyKey!].data as Record<string, any>).sponges).toBe(50);
  });

  test('replay same rewardId → already-exists, no double-pay', async () => {
    seedDoc(streakPath, { currentStreak: 7, longestStreak: 7, awardedMilestones: ['streak_7'] });
    seedDoc(profilePath, { spongeBalance: 0 });

    await expect(call('streak_7')).rejects.toMatchObject({ code: 'already-exists' });
    // Balance untouched.
    expect(docStore[profilePath].data).toEqual({ spongeBalance: 0 });
  });
});
