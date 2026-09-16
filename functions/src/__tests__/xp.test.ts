// Force module scope. Without a top-level import/export a .ts file is a SCRIPT,
// so its top-level `const _db` lands in the GLOBAL scope and collides with the
// identically-named one in nine sibling test files (TS2451). Which pair collides
// depends on how ts-jest groups files into a worker, which is why the suite failed
// non-deterministically on a different file each run. Pre-existing; see W3-09.
export {};

// functions/src/__tests__/xp.test.ts
//
// Unit tests for the XP progression subsystem: the awardXp helper plus its
// wiring into recordTaskCompletion (same-day replay guard), purchaseChest and
// claimGift. Mirrors the path-keyed Firestore mock from streak.test.ts, but
// RESOLVES FieldValue.increment / arrayUnion sentinels against the stored
// value so double-award bugs show up as a wrong number, not a swallowed
// sentinel overwrite.

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

/** Applies a write, resolving increment/arrayUnion sentinels numerically. */
function applyWrite(
  path: string,
  val: Record<string, unknown>,
  opts?: { merge?: boolean },
) {
  const st = docStore[path] ?? (docStore[path] = { data: null });
  const base: Record<string, unknown> = opts?.merge ? { ...(st.data ?? {}) } : {};
  for (const [k, v] of Object.entries(val)) {
    const sentinel = v as { _type?: string; n?: number; vals?: unknown[] } | null;
    if (sentinel && typeof sentinel === 'object' && sentinel._type === 'increment') {
      base[k] = ((base[k] as number) ?? 0) + (sentinel.n ?? 0);
    } else if (sentinel && typeof sentinel === 'object' && sentinel._type === 'arrayUnion') {
      base[k] = [...((base[k] as unknown[]) ?? []), ...(sentinel.vals ?? [])];
    } else if (sentinel && typeof sentinel === 'object' && sentinel._type === 'delete') {
      delete base[k];
    } else {
      base[k] = v;
    }
  }
  st.data = base;
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
      applyWrite(path, val, opts);
    }),
  };
}

// collection().where().get() returns every doc under the collection prefix —
// enough for purchaseChest's items-by-rarity query (rarity is irrelevant when
// the pool has one item, and rollRarity is random, so filtering there would
// make the chest tests depend on the dice).
//
// EXCEPTION: users/{uid}/tasks IS filtered for real. grantTaskRewards counts
// distinct task docs whose completedDate matches today, and the day boundary
// is the entire point of the per-day cap — a mock that returned yesterday's
// completions too would pass a test that production fails.
function collectionMock(prefix: string) {
  const filtersFor = (field: string, op: string, value: unknown) =>
    prefix.endsWith('/tasks') && op === '=='
      ? (data: Record<string, unknown> | null) => data?.[field] === value
      : () => true;

  return {
    doc: jest.fn((id?: string) => docMock(`${prefix}/${id ?? `auto_${autoIdCounter++}`}`)),
    where: jest.fn((field: string, op: string, value: unknown) => {
      const matches = filtersFor(field, op, value);
      return {
        get: jest.fn(async () => {
          const docs = Object.keys(docStore)
            .filter(
              (k) =>
                k.startsWith(`${prefix}/`) &&
                docStore[k].data !== null &&
                matches(docStore[k].data),
            )
            .map((k) => ({
              id: k.split('/').pop(),
              ref: docMock(k),
              data: () => docStore[k].data,
            }));
          return { empty: docs.length === 0, size: docs.length, docs };
        }),
      };
    }),
  };
}

const _db = {
  doc: jest.fn((p: string) => docMock(p)),
  collection: jest.fn((p: string) => collectionMock(p)),
  runTransaction: jest.fn(),
  /**
   * Admin SDK `getAll` — one round trip for many documents.
   *
   * Added for W2-161: purchaseChest now reads the whole (subject, rarity) cell's
   * ownership before drawing, so the duplicate rate can be biased. These XP tests
   * do not care about the bias, but they drive purchaseChest end to end and so
   * traverse the read.
   */
  getAll: jest.fn(async (...refs: any[]) => Promise.all(refs.map((r) => r.get()))),
};

jest.mock('firebase-admin', () => {
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = {
    increment: (n: number) => ({ _type: 'increment', n }),
    arrayUnion: (...vals: unknown[]) => ({ _type: 'arrayUnion', vals }),
    delete: () => ({ _type: 'delete' }),
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
const { awardXp, XP_BASE, XP_STEP, XP_TASK, XP_CHEST, XP_GIFT_CLAIM } =
  require('../xp') as {
    awardXp: (uid: string, amount: number, reason: string) => Promise<void>;
    XP_BASE: number;
    XP_STEP: number;
    XP_TASK: number;
    XP_CHEST: number;
    XP_GIFT_CLAIM: number;
  };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TASK_SPONGE_REWARD, PAID_TASK_CAP_BY_TIER } =
  require('../taskRewards') as {
    TASK_SPONGE_REWARD: number;
    PAID_TASK_CAP_BY_TIER: Record<string, number>;
  };

// These cases sign in a user with no `subscriptionTier` field, so the cap that
// applies is the free one — `paidTaskCapFor` fails closed to it. Named rather
// than hardcoded so raising a tier's ceiling retunes the test with it.
const MAX_PAID_TASKS_PER_DAY = PAID_TASK_CAP_BY_TIER.free;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { recordTaskCompletion, purchaseChest, claimGift } = require('../index') as {
  recordTaskCompletion: { _handler: (req: any) => Promise<any> };
  purchaseChest: { _handler: (req: any) => Promise<any> };
  claimGift: { _handler: (req: any) => Promise<any> };
};

function seedDoc(path: string, data: Record<string, unknown> | null) {
  docStore[path] = { data };
}

function totalXp(uid = 'uid-a'): unknown {
  return docStore[`users/${uid}/profile/data`]?.data?.totalXp;
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
// ⚠️ THE SERVER CLOCK IS PINNED TO THE SIMULATED DAY (W2-174)
// ---------------------------------------------------------------------------
//
// `recordTaskCompletion` now BOUNDS the client's day key against the server's
// own UTC date and refuses anything more than a day away — which is the whole
// point of the fix, and which makes every `2026-06-29` call below an
// `invalid-argument` when the real clock is some other month.
//
// 🔑 PINNING THE CLOCK IS THE HONEST REPAIR, NOT FLOATING THE DATES. These
// cases assert day-boundary behaviour — the cap resetting on the next day,
// yesterday's completions not paying again — and a floating date would make
// them assert it against a moving target. The simulated day is the fixture;
// the server clock simply has to agree with it.
//
// 📌 Declared AFTER the hook above so it runs after `jest.clearAllMocks()`,
// which would otherwise wipe the spy on the first test of every file.
const SIMULATED_SERVER_NOW = Date.parse('2026-06-29T12:00:00.000Z');
beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(SIMULATED_SERVER_NOW);
});
afterAll(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Constants — mirror lib/features/progression/domain/level_curve.dart
// ---------------------------------------------------------------------------

describe('xp constants', () => {
  test('curve constants mirror kXpBase/kXpStep in level_curve.dart', () => {
    expect(XP_BASE).toBe(100);
    expect(XP_STEP).toBe(50);
  });

  test('per-action awards', () => {
    expect(XP_TASK).toBe(10);
    expect(XP_CHEST).toBe(25);
    expect(XP_GIFT_CLAIM).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// awardXp
// ---------------------------------------------------------------------------

describe('awardXp', () => {
  test('increments totalXp on users/{uid}/profile/data', async () => {
    seedDoc('users/uid-a/profile/data', { spongeBalance: 200, totalXp: 40 });

    await awardXp('uid-a', 10, 'task_completion');

    expect(totalXp()).toBe(50);
    // Other profile fields untouched (merge write).
    expect(docStore['users/uid-a/profile/data'].data?.spongeBalance).toBe(200);
  });

  test('creates the profile doc when it does not exist yet (set+merge, not update)', async () => {
    await awardXp('uid-new', 25, 'chest_purchase');

    expect(totalXp('uid-new')).toBe(25);
  });

  test('accumulates across successive awards', async () => {
    await awardXp('uid-a', 10, 'task_completion');
    await awardXp('uid-a', 25, 'chest_purchase');
    await awardXp('uid-a', 15, 'gift_claim');

    expect(totalXp()).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// recordTaskCompletion — XP idempotency (same guard as the streak's gap == 0)
// ---------------------------------------------------------------------------

describe('recordTaskCompletion reward wiring', () => {
  const call = (clientNowIso: string, uid: string | null = 'uid-a') =>
    recordTaskCompletion._handler({ auth: uid ? { uid } : null, data: { clientNowIso } });

  function sponges(uid = 'uid-a'): unknown {
    return docStore[`users/${uid}/profile/data`]?.data?.spongeBalance;
  }

  /**
   * Marks [n] distinct tasks complete on [day], the way the client does:
   * markTaskComplete writes completedDate onto users/{uid}/tasks/{taskId}
   * BEFORE it calls recordTaskCompletion, so the docs are always in place by
   * the time the callable reads them.
   */
  function completeTasks(n: number, day: string, uid = 'uid-a') {
    for (let i = 0; i < n; i++) {
      seedDoc(`users/${uid}/tasks/task_${i}`, { completedDate: day });
    }
  }

  test('first ever completion awards XP_TASK and TASK_SPONGE_REWARD', async () => {
    completeTasks(1, '2026-06-29');

    await call('2026-06-29T10:00:00.000000');

    expect(totalXp()).toBe(XP_TASK);
    expect(sponges()).toBe(TASK_SPONGE_REWARD);
  });

  // The defect this module was written to fix: XP used to sit behind
  // `if (dayAdvanced)`, so this second call awarded nothing whatsoever.
  test('the SECOND task of a day pays XP but NOT sponges — the two ledgers diverge', async () => {
    // 🔑 THIS IS THE RESPEC, IN ONE ASSERTION. Brendan, 2026-08-14: "free get 1
    // task they can do a day to get sponges, INFINITE FOR XP." #339 uncapped
    // XP; W1-99 took the free sponge cap to 1. Before those two, this test read
    // `sponges() === 2 * TASK_SPONGE_REWARD` and was a statement that the
    // second task was not gated by the streak-day.
    //
    // ⚠️ The original property still holds and is still worth pinning — the
    // second task is NOT silently dropped. What changed is which ledger pays
    // it, and asserting both halves is the only way to tell "capped" from
    // "ignored".
    completeTasks(1, '2026-06-29');
    await call('2026-06-29T10:00:00.000000');

    completeTasks(2, '2026-06-29'); // a second, distinct task
    await call('2026-06-29T11:00:00.000000');

    expect(totalXp()).toBe(2 * XP_TASK);            // uncapped
    expect(sponges()).toBe(MAX_PAID_TASKS_PER_DAY * TASK_SPONGE_REWARD); // capped at 1
  });

  test('every task up to the cap pays', async () => {
    for (let i = 1; i <= MAX_PAID_TASKS_PER_DAY; i++) {
      completeTasks(i, '2026-06-29');
      await call('2026-06-29T10:00:00.000000');
    }

    expect(totalXp()).toBe(MAX_PAID_TASKS_PER_DAY * XP_TASK);
    expect(sponges()).toBe(MAX_PAID_TASKS_PER_DAY * TASK_SPONGE_REWARD);
  });

  test('completions beyond the daily cap pay nothing', async () => {
    completeTasks(MAX_PAID_TASKS_PER_DAY + 5, '2026-06-29');

    const res = await call('2026-06-29T10:00:00.000000');

    expect(res.granted.sponges).toBe(MAX_PAID_TASKS_PER_DAY * TASK_SPONGE_REWARD);
    expect(res.granted.capped).toBe(true);
    expect(sponges()).toBe(MAX_PAID_TASKS_PER_DAY * TASK_SPONGE_REWARD);
  });

  // The toggle exploit. markPending() un-completes a task with NO server call,
  // so re-completing it re-fires the callable. Because the grant counts
  // distinct task docs rather than invocations, the replay pays zero.
  test('re-completing the SAME task does not pay twice', async () => {
    completeTasks(1, '2026-06-29');
    await call('2026-06-29T10:00:00.000000');

    // markPending clears completedDate client-side, then markComplete re-sets
    // it and calls again — same doc id, so the distinct count is unchanged.
    seedDoc('users/uid-a/tasks/task_0', { completedDate: null });
    seedDoc('users/uid-a/tasks/task_0', { completedDate: '2026-06-29' });
    const res = await call('2026-06-29T12:00:00.000000');

    expect(res.granted.sponges).toBe(0);
    expect(totalXp()).toBe(XP_TASK);
    expect(sponges()).toBe(TASK_SPONGE_REWARD);
  });

  test('a plain replay with no new completions pays nothing', async () => {
    completeTasks(1, '2026-06-29');
    await call('2026-06-29T10:00:00.000000');
    await call('2026-06-29T20:00:00.000000'); // same streak-day (>= 4 AM cutoff)

    expect(totalXp()).toBe(XP_TASK); // still one award
    expect(sponges()).toBe(TASK_SPONGE_REWARD);
  });

  test('the cap resets on the next day', async () => {
    completeTasks(MAX_PAID_TASKS_PER_DAY, '2026-06-29');
    await call('2026-06-29T10:00:00.000000');

    // A fresh day's tasks. The stale ledger must not carry paidCount forward.
    // ⚠️ Derived from the cap, not from a literal: at free = 1 a hardcoded "3"
    // would silently be testing the cap rather than the RESET, and would pass
    // for the wrong reason. A second day pays exactly one more capped day.
    resetTasks();
    completeTasks(MAX_PAID_TASKS_PER_DAY + 2, '2026-06-30');
    await call('2026-06-30T10:00:00.000000');

    expect(sponges()).toBe(2 * MAX_PAID_TASKS_PER_DAY * TASK_SPONGE_REWARD);
  });

  function resetTasks(uid = 'uid-a') {
    for (const k of Object.keys(docStore)) {
      if (k.startsWith(`users/${uid}/tasks/`)) delete docStore[k];
    }
  }

  test('yesterday’s completions do not pay again today', async () => {
    completeTasks(MAX_PAID_TASKS_PER_DAY + 3, '2026-06-29');
    await call('2026-06-29T10:00:00.000000');

    // Same docs, still carrying yesterday's date. Nothing new is complete.
    const res = await call('2026-06-30T10:00:00.000000');

    expect(res.granted.sponges).toBe(0);
    // One capped day's worth, and not a sponge more on the second call.
    expect(sponges()).toBe(MAX_PAID_TASKS_PER_DAY * TASK_SPONGE_REWARD);
  });

  test('streak reset (gap > 1, no shields) still pays the completion', async () => {
    seedDoc('users/uid-a', { streakShields: 0 });
    seedDoc('users/uid-a/streak/main', {
      currentStreak: 5,
      longestStreak: 7,
      lastCompletionDate: '2026-06-25T10:00:00.000000',
      streakStartDate: '2026-06-21T00:00:00.000',
      isBroken: false,
    });
    completeTasks(1, '2026-06-29');

    await call('2026-06-29T10:00:00.000000');

    expect(totalXp()).toBe(XP_TASK);
    expect(sponges()).toBe(TASK_SPONGE_REWARD);
  });
});

// ---------------------------------------------------------------------------
// purchaseChest — XP_CHEST after a successful purchase
// ---------------------------------------------------------------------------

describe('purchaseChest XP wiring', () => {
  const chest = {
    id: 'chest_common_20260629',
    category: 'characters',
    rarity: 'common',
    name: 'Character',
    price: 100,
    artUrl: '',
  };

  const call = (chestId: string, uid: string | null = 'uid-a', purchaseId?: string) =>
    purchaseChest._handler({
      auth: uid ? { uid } : null,
      data: purchaseId ? { chestId, purchaseId } : { chestId },
    });

  beforeEach(() => {
    seedDoc('shop/current', { dailyChests: [chest] });
    seedDoc('users/uid-a/profile/data', { spongeBalance: 500 });
    // One item in the pool — returned for any rolled rarity by the where() mock.
    seedDoc('items/item_1', { name: 'Lamp', rarity: 'common', type: 'furniture', artUrl: '' });
  });

  test('successful purchase awards XP_CHEST after the sponge deduction', async () => {
    const res = await call(chest.id);

    expect(res.items).toHaveLength(1);
    expect(totalXp()).toBe(XP_CHEST);
    // Price deducted from the same profile doc XP landed on.
    expect(docStore['users/uid-a/profile/data'].data?.spongeBalance).toBe(400);
  });

  // W2-08 — this used to read "replay of the same chest → already-exists". It
  // was the daily cap, and the cap is gone: buying the same chest twice is now
  // two purchases, so it must award XP twice. The replay case it was standing
  // in for is the one below, keyed on purchaseId.
  test('buying the same chest twice awards XP twice', async () => {
    await call(chest.id);
    const second = await call(chest.id);

    expect(totalXp()).toBe(XP_CHEST * 2);
    // The pool holds one item, so the second draw is always a duplicate and
    // the refund follows the ROLLED rarity — derive it rather than hardcoding
    // a number that changes with the roll.
    expect(docStore['users/uid-a/profile/data'].data?.spongeBalance).toBe(
      500 - 200 + second.duplicateRefund,
    );
  });

  test('a replayed purchaseId → already-exists, no XP double-award', async () => {
    await call(chest.id, 'uid-a', 'tap-1');
    await expect(call(chest.id, 'uid-a', 'tap-1')).rejects.toMatchObject({
      code: 'already-exists',
    });

    expect(totalXp()).toBe(XP_CHEST);
    expect(docStore['users/uid-a/profile/data'].data?.spongeBalance).toBe(400);
  });

  test('failed purchase (insufficient balance) awards no XP', async () => {
    seedDoc('users/uid-a/profile/data', { spongeBalance: 10 });

    await expect(call(chest.id)).rejects.toMatchObject({ code: 'failed-precondition' });

    expect(totalXp()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// claimGift — XP_GIFT_CLAIM after a successful claim
// ---------------------------------------------------------------------------

describe('claimGift XP wiring', () => {
  const call = (inviteId: string, uid: string | null = 'uid-a') =>
    claimGift._handler({ auth: uid ? { uid } : null, data: { inviteId } });

  test('successful claim credits sponges AND awards XP_GIFT_CLAIM', async () => {
    seedDoc('users/uid-a/giftInvites/inv-1', {
      fromUid: 'uid-b',
      amount: 20,
      claimed: false,
    });

    const res = await call('inv-1');

    expect(res).toEqual({ amount: 20 });
    expect(docStore['users/uid-a/profile/data'].data?.spongeBalance).toBe(20);
    expect(totalXp()).toBe(XP_GIFT_CLAIM);
  });

  test('replay → already-exists, no XP double-award', async () => {
    seedDoc('users/uid-a/giftInvites/inv-1', {
      fromUid: 'uid-b',
      amount: 20,
      claimed: false,
    });

    await call('inv-1');
    await expect(call('inv-1')).rejects.toMatchObject({ code: 'already-exists' });

    expect(totalXp()).toBe(XP_GIFT_CLAIM);
  });

  test('missing invite awards no XP', async () => {
    await expect(call('inv-missing')).rejects.toMatchObject({ code: 'not-found' });

    expect(totalXp()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// XP is uncapped; sponges are not (W2-66)
//
// Brendan, 2026-08-14: "free get 1 task they can do a day to get sponges,
// infinite for xp."
//
// grantTaskRewards computed both currencies from the SAME capped numerator, so
// the completion after the cap paid 0 sponges AND 0 XP. The sponge half is
// deliberate and stays; the XP half was not a decision, it was a shared
// variable.
//
// 🔑 The ledger's `paidCount` was doing two jobs at once — how many completions
// have been paid SPONGES, and the replay guard for the whole callable. Uncapping
// XP against one counter would re-pay XP for every completion past the cap on
// every call. The second counter below is what separates them.
// ---------------------------------------------------------------------------

describe('XP is uncapped while sponges stay capped', () => {
  const call = (clientNowIso: string, uid: string | null = 'uid-a') =>
    recordTaskCompletion._handler({ auth: uid ? { uid } : null, data: { clientNowIso } });

  function sponges(uid = 'uid-a'): unknown {
    return docStore[`users/${uid}/profile/data`]?.data?.spongeBalance;
  }

  function completeTasks(n: number, day: string, uid = 'uid-a') {
    for (let i = 0; i < n; i++) {
      seedDoc(`users/${uid}/tasks/task_${i}`, { completedDate: day });
    }
  }

  const OVER = 3;

  test('past the cap, sponges stop and XP does not', async () => {
    completeTasks(MAX_PAID_TASKS_PER_DAY + OVER, '2026-06-29');

    const res = await call('2026-06-29T10:00:00.000000');

    // Unchanged, and asserted in the same test so a regression cannot trade one
    // for the other: the sponge cap is the subscription's daily lever.
    expect(sponges()).toBe(MAX_PAID_TASKS_PER_DAY * TASK_SPONGE_REWARD);
    expect(res.granted.capped).toBe(true);

    // The change. Every distinct completion pays XP.
    expect(totalXp()).toBe((MAX_PAID_TASKS_PER_DAY + OVER) * XP_TASK);
  });

  test('a replay pays no XP a second time', async () => {
    // 🔑 THE HYPOTHESIS TEST. Uncapping XP against `paidCount` alone would
    // re-pay every completion past the cap on each call, because paidCount
    // saturates at the cap and can never record them.
    completeTasks(MAX_PAID_TASKS_PER_DAY + OVER, '2026-06-29');

    await call('2026-06-29T10:00:00.000000');
    const first = totalXp();
    const second = await call('2026-06-29T10:05:00.000000');

    expect(second.granted.xp).toBe(0);
    expect(totalXp()).toBe(first);
    expect(totalXp()).toBe((MAX_PAID_TASKS_PER_DAY + OVER) * XP_TASK);
  });

  test('XP keeps paying as completions arrive past the cap, one at a time', async () => {
    // The drip case, which is how a real day actually happens. Each call must
    // pay XP for exactly the new completions and no sponges once capped.
    for (let i = 1; i <= MAX_PAID_TASKS_PER_DAY + OVER; i++) {
      completeTasks(i, '2026-06-29');
      await call('2026-06-29T10:00:00.000000');
    }

    expect(sponges()).toBe(MAX_PAID_TASKS_PER_DAY * TASK_SPONGE_REWARD);
    expect(totalXp()).toBe((MAX_PAID_TASKS_PER_DAY + OVER) * XP_TASK);
  });

  test('a new day resets both counters', async () => {
    completeTasks(MAX_PAID_TASKS_PER_DAY + OVER, '2026-06-29');
    await call('2026-06-29T10:00:00.000000');

    // Same task docs, next day: the ledger is stale, not zero.
    completeTasks(MAX_PAID_TASKS_PER_DAY + OVER, '2026-06-30');
    await call('2026-06-30T10:00:00.000000');

    expect(sponges()).toBe(2 * MAX_PAID_TASKS_PER_DAY * TASK_SPONGE_REWARD);
    expect(totalXp()).toBe(2 * (MAX_PAID_TASKS_PER_DAY + OVER) * XP_TASK);
  });
});

// ---------------------------------------------------------------------------
// W2-67 — the paid cap is an entitlement, and an entitlement can lapse.
//
// `subscriptionExpiresAt` was written by verifySubscriptionReceipt and read by
// nothing, so a subscriber who cancelled months ago kept the pro cap for ever.
// These two cases are a matched pair on purpose: the lapsed one is the fix, and
// the live one is the CONTROL that proves the fix is the expiry check rather
// than the resolver simply having stopped honouring `pro` at all.
// ---------------------------------------------------------------------------

describe('the paid task cap lapses with the subscription', () => {
  const call = (clientNowIso: string, uid: string | null = 'uid-a') =>
    recordTaskCompletion._handler({ auth: uid ? { uid } : null, data: { clientNowIso } });

  function sponges(uid = 'uid-a'): unknown {
    return docStore[`users/${uid}/profile/data`]?.data?.spongeBalance;
  }

  function completeTasks(n: number, day: string, uid = 'uid-a') {
    for (let i = 0; i < n; i++) {
      seedDoc(`users/${uid}/tasks/task_${i}`, { completedDate: day });
    }
  }

  const PRO_CAP = PAID_TASK_CAP_BY_TIER.pro;
  const FREE_CAP = PAID_TASK_CAP_BY_TIER.free;

  /** The `{ _type: 'ts', ms }` sentinel this file's admin mock produces. */
  const ts = (ms: number) => ({ _type: 'ts', ms });

  // ⚠️ TWO CLOCKS, AND THEY ARE NOT THE SAME ONE. `clientNowIso` below sets the
  // reward LEDGER's day key and nothing else; entitlement is dated against the
  // real `Date.now()` inside the callable. Anchoring these expiries to the
  // simulated June day instead would put every one of them months in the past,
  // and the live case would lapse — which is exactly what the control test
  // caught when this file first anchored them the wrong way.
  const DAY = 86_400_000;
  const liveExpiry = () => ts(Date.now() + 30 * DAY);
  const lapsedExpiry = () => ts(Date.now() - 30 * DAY);

  test('a LIVE pro subscription pays the pro cap — the control', () => {
    // Guards the pair below: if pro and free were the same number, the lapsed
    // case would pass without the expiry check ever running.
    expect(PRO_CAP).toBeGreaterThan(FREE_CAP);
  });

  test('a live pro subscriber earns up to the pro cap', async () => {
    seedDoc('users/uid-a', {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: liveExpiry(),
    });
    completeTasks(PRO_CAP + 2, '2026-06-29');

    await call('2026-06-29T10:00:00.000000');

    expect(sponges()).toBe(PRO_CAP * TASK_SPONGE_REWARD);
  });

  test('an EXPIRED pro subscriber falls to the free cap', async () => {
    // The defect, in one assertion. Same document, same tier string, expiry a
    // day in the past instead of a day ahead.
    seedDoc('users/uid-a', {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: lapsedExpiry(),
    });
    completeTasks(PRO_CAP + 2, '2026-06-29');

    await call('2026-06-29T10:00:00.000000');

    expect(sponges()).toBe(FREE_CAP * TASK_SPONGE_REWARD);
  });

  test('a pro document with NO expiry falls to the free cap', async () => {
    // Fails closed. A paid tier whose expiry cannot be read is not a paid tier.
    seedDoc('users/uid-a', { subscriptionTier: 'pro' });
    completeTasks(PRO_CAP + 2, '2026-06-29');

    await call('2026-06-29T10:00:00.000000');

    expect(sponges()).toBe(FREE_CAP * TASK_SPONGE_REWARD);
  });

  test('XP stays uncapped for a lapsed subscriber', async () => {
    // The lapse takes the SPONGE cap and nothing else. #339 uncapped XP for
    // everyone, free included, so losing a subscription must not quietly
    // reintroduce an XP ceiling.
    seedDoc('users/uid-a', {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: lapsedExpiry(),
    });
    completeTasks(PRO_CAP + 2, '2026-06-29');

    await call('2026-06-29T10:00:00.000000');

    expect(totalXp()).toBe((PRO_CAP + 2) * XP_TASK);
  });
});
