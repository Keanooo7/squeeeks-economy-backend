// Force module scope. Without a top-level import/export a .ts file is a SCRIPT,
// so its top-level `const _db` lands in the GLOBAL scope and collides with the
// identically-named one in nine sibling test files (TS2451). See W3-09.
export {};

// functions/src/__tests__/housemateToken.test.ts
//
// W4-36. The token that is supposed to prove two people met.
//
// KEY: THE THREE PROPERTIES ARE THE FEATURE, AND EACH IS TESTED AS A BEHAVIOUR
// RATHER THAN AS A FIELD:
//   SHORT-LIVED   — a token past its expiry is REFUSED and writes nothing.
//   SINGLE-USE    — the SAME token redeemed twice against the SAME store fails
//                   the second time, and two CONCURRENT redemptions grant once.
//   NOT SELF-SERVED — the client never writes the roster; the host cannot
//                   redeem their own code; a full house refuses.
// Asserting `redeemedAtMs` exists would pass on a server that ignores it. Every
// assertion below is on what the store contains afterwards.

// ---------------------------------------------------------------------------
// firebase-admin mock — hoisted, so it must be declared before the imports.
// ---------------------------------------------------------------------------

interface DocState {
  data: Record<string, unknown> | null;
}
const docStore: Record<string, DocState> = {};
/** Bumped on every committed write — models Firestore's optimistic locking. */
const docVersions: Record<string, number> = {};

function resetStore() {
  for (const k of Object.keys(docStore)) delete docStore[k];
  for (const k of Object.keys(docVersions)) delete docVersions[k];
}

function seed(path: string, data: Record<string, unknown>) {
  docStore[path] = { data };
  docVersions[path] = (docVersions[path] ?? 0) + 1;
}

function readRaw(path: string): Record<string, unknown> | null {
  return docStore[path]?.data ?? null;
}

function applyWrite(path: string, val: Record<string, unknown>, merge?: boolean) {
  const st = docStore[path] ?? (docStore[path] = { data: null });
  const prev = (st.data ?? {}) as Record<string, unknown>;
  st.data = merge ? { ...prev, ...val } : { ...val };
  docVersions[path] = (docVersions[path] ?? 0) + 1;
}

function snapOf(path: string) {
  const data = readRaw(path);
  return {
    exists: data !== null,
    data: () => data ?? undefined,
    id: path.split('/').pop(),
  };
}

function docMock(path: string): any {
  return {
    path,
    id: path.split('/').pop(),
    get: jest.fn(async () => snapOf(path)),
    set: jest.fn(async (val: Record<string, unknown>, opts?: { merge?: boolean }) => {
      applyWrite(path, val, opts?.merge);
    }),
    // Mirrors Admin SDK `create`: rejects when the document already exists.
    // That is what makes a code collision fail loudly instead of overwriting a
    // live token with a different host on it.
    create: jest.fn(async (val: Record<string, unknown>) => {
      if (readRaw(path) !== null) {
        const err = new Error(`ALREADY_EXISTS: ${path}`) as Error & { code: number };
        err.code = 6;
        throw err;
      }
      applyWrite(path, val);
    }),
  };
}

/**
 * A transaction that actually models contention.
 *
 * Every `tx.get` records the version of the document it read; writes are
 * buffered and, at commit, the recorded versions are re-checked. If anything
 * moved, the whole body re-runs against fresh data — which is exactly what
 * Firestore does, and the only reason the "two phones redeem at once" test
 * means anything. `beforeCommit` lets a test interleave the other phone.
 */
let beforeCommit: (() => void) | null = null;

async function runTransactionImpl(fn: (tx: any) => any): Promise<any> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const readVersions: Record<string, number> = {};
    const writes: { path: string; val: Record<string, unknown>; merge?: boolean }[] = [];
    const tx = {
      get: jest.fn(async (ref: any) => {
        readVersions[ref.path] = docVersions[ref.path] ?? 0;
        return snapOf(ref.path);
      }),
      set: jest.fn((ref: any, val: Record<string, unknown>, opts?: { merge?: boolean }) => {
        writes.push({ path: ref.path, val, merge: opts?.merge });
      }),
    };
    const result = await fn(tx);

    const hook = beforeCommit;
    beforeCommit = null;
    if (hook) hook();

    const stale = Object.entries(readVersions).some(
      ([p, v]) => (docVersions[p] ?? 0) !== v,
    );
    if (stale) continue;
    for (const w of writes) applyWrite(w.path, w.val, w.merge);
    return result;
  }
  throw new Error('transaction exceeded retries');
}

const _db = {
  doc: jest.fn((path: string) => docMock(path)),
  collection: jest.fn(),
  runTransaction: jest.fn(runTransactionImpl),
};

jest.mock('firebase-admin', () => {
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = {
    increment: (n: number) => ({ _type: 'increment', n }),
    arrayUnion: (...values: unknown[]) => ({ _type: 'arrayUnion', values }),
  };
  firestoreFn.Timestamp = { now: () => ({ seconds: 0, nanoseconds: 0 }) };
  return {
    initializeApp: jest.fn(),
    firestore: firestoreFn,
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

// ---------------------------------------------------------------------------
// Imports, after the mocks
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';
import {
  HOUSEMATE_CAP,
  HOUSEMATE_TOKEN_ALPHABET,
  HOUSEMATE_TOKEN_LENGTH,
  HOUSEMATE_TOKEN_TTL_SECONDS,
  HousemateTokenDoc,
  appendHousemate,
  evaluateRedemption,
  generateHousemateTokenCode,
  isValidHousemateTokenCode,
  rosterOf,
} from '../housemateToken';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { mintHousemateToken, redeemHousemateToken } = require('../index') as {
  mintHousemateToken: { _handler: (req: any) => Promise<any> };
  redeemHousemateToken: { _handler: (req: any) => Promise<any> };
};

const HOST = 'uid-host';
const GUEST = 'uid-guest';
const T0 = 1_700_000_000_000;

function mint(uid?: string) {
  return mintHousemateToken._handler({ auth: uid ? { uid } : null, data: {} });
}
function redeem(code: unknown, uid?: string) {
  return redeemHousemateToken._handler({ auth: uid ? { uid } : null, data: { code } });
}

/** Both directions of an accepted friendship, which redemption requires. */
function seedFriendship(a: string, b: string) {
  seed(`users/${a}/friends/${b}`, { status: 'accepted' });
  seed(`users/${b}/friends/${a}`, { status: 'accepted' });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  beforeCommit = null;
  _db.doc.mockImplementation((p: string) => docMock(p));
  _db.runTransaction.mockImplementation(runTransactionImpl);
  jest.spyOn(Date, 'now').mockReturnValue(T0);
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------

describe('the minted code', () => {
  test('the alphabet is exactly 32 characters, which is what makes it unbiased', () => {
    // 256 % 32 == 0, so `byte % 32` is uniform. A 33-character alphabet would
    // bias every code ever minted and no other test could see it.
    expect(HOUSEMATE_TOKEN_ALPHABET).toHaveLength(32);
    expect(256 % HOUSEMATE_TOKEN_ALPHABET.length).toBe(0);
  });

  test('the alphabet has no ambiguous glyphs — a human reads this aloud', () => {
    for (const ch of 'ILOU') expect(HOUSEMATE_TOKEN_ALPHABET).not.toContain(ch);
    expect(new Set(HOUSEMATE_TOKEN_ALPHABET).size).toBe(HOUSEMATE_TOKEN_ALPHABET.length);
  });

  test('a generated code is the right length and only uses the alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateHousemateTokenCode();
      expect(code).toHaveLength(HOUSEMATE_TOKEN_LENGTH);
      expect(isValidHousemateTokenCode(code)).toBe(true);
    }
  });

  test('it is derived from the bytes it is given, not from Math.random', () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 32, 33, 255, 254, 10, 11]);
    expect(generateHousemateTokenCode(() => bytes)).toBe('0123' + '01' + 'ZY' + 'AB');
  });

  test('200 codes are 200 different codes', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateHousemateTokenCode());
    expect(seen.size).toBe(200);
  });
});

describe('isValidHousemateTokenCode refuses anything not minted here', () => {
  test('rejects the shapes that would become a bad document path', () => {
    expect(isValidHousemateTokenCode('AB/CDEFGHI')).toBe(false);
    expect(isValidHousemateTokenCode('')).toBe(false);
    expect(isValidHousemateTokenCode('A'.repeat(500))).toBe(false);
  });

  test('rejects wrong length, wrong case and off-alphabet glyphs', () => {
    expect(isValidHousemateTokenCode('ABCDEFGHI')).toBe(false); // 9
    expect(isValidHousemateTokenCode('ABCDEFGHIJK')).toBe(false); // 11
    expect(isValidHousemateTokenCode('abcdefghjk')).toBe(false); // lowercase
    expect(isValidHousemateTokenCode('ABCDEFGHIJ')).toBe(false); // contains I
  });

  test('rejects non-strings', () => {
    for (const v of [undefined, null, 42, {}, ['0123456789']]) {
      expect(isValidHousemateTokenCode(v)).toBe(false);
    }
  });
});

describe('🔑 the TTL is a security property, not a tuning knob', () => {
  test('it stays in the tens of seconds the spec requires', () => {
    // "Tens of seconds, not minutes." A token that outlives the moment can be
    // texted, and then it proves nothing at all.
    expect(HOUSEMATE_TOKEN_TTL_SECONDS).toBeGreaterThanOrEqual(10);
    expect(HOUSEMATE_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(60);
  });
});

describe('🔴 HOUSEMATE_CAP mirrors housemateCap() in firestore.rules', () => {
  // The Admin SDK bypasses rules, so the rules do NOT gate redemption — this
  // constant does. Two definitions of one number is the defect this repo keeps
  // filing, and this is the only thing keeping them equal.
  const RULES = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'firestore.rules'),
    'utf8',
  );

  test('the rules file really contains the function being mirrored', () => {
    expect(RULES).toContain('function housemateCap()');
  });

  test('both say the same number', () => {
    const m = RULES.match(/function housemateCap\(\)\s*\{\s*return\s+(\d+)\s*;/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(HOUSEMATE_CAP);
  });
});

describe('evaluateRedemption', () => {
  const live: HousemateTokenDoc = {
    hostUid: HOST,
    createdAtMs: T0,
    expiresAtMs: T0 + 45_000,
  };

  test('an unknown token is not-found', () => {
    expect(evaluateRedemption(null, GUEST, T0)).toMatchObject({ ok: false, code: 'not-found' });
  });

  test('a live token redeemed by someone else succeeds', () => {
    expect(evaluateRedemption(live, GUEST, T0 + 1)).toEqual({ ok: true, hostUid: HOST });
  });

  test('SHORT-LIVED: it fails at the expiry instant, not one tick later', () => {
    expect(evaluateRedemption(live, GUEST, live.expiresAtMs - 1)).toMatchObject({ ok: true });
    expect(evaluateRedemption(live, GUEST, live.expiresAtMs)).toMatchObject({
      ok: false,
      code: 'deadline-exceeded',
    });
  });

  test('SINGLE-USE: a spent token is refused', () => {
    expect(
      evaluateRedemption({ ...live, redeemedAtMs: T0 + 1, redeemedByUid: 'someone' }, GUEST, T0 + 2),
    ).toMatchObject({ ok: false, code: 'already-exists' });
  });

  test('spent beats expired, so a replay never reads as "just too slow"', () => {
    expect(
      evaluateRedemption({ ...live, redeemedAtMs: T0 + 1 }, GUEST, T0 + 999_999),
    ).toMatchObject({ ok: false, code: 'already-exists' });
  });

  test('NO SELF-GRANT: the host cannot redeem their own code', () => {
    expect(evaluateRedemption(live, HOST, T0 + 1)).toMatchObject({
      ok: false,
      code: 'failed-precondition',
    });
  });
});

describe('appendHousemate', () => {
  test('appends when there is room', () => {
    expect(appendHousemate(['a'], 'b')).toEqual({ ok: true, roster: ['a', 'b'] });
  });

  test('is idempotent — already inside does not consume a slot', () => {
    const full = ['a', 'b', 'c', 'd'];
    expect(appendHousemate(full, 'd')).toEqual({ ok: true, roster: full });
  });

  test('refuses at the cap', () => {
    expect(appendHousemate(['a', 'b', 'c', 'd'], 'e')).toMatchObject({
      ok: false,
      code: 'resource-exhausted',
    });
  });

  test('the cap is 4 and the refusal happens on the fifth, not the fourth', () => {
    expect(appendHousemate(['a', 'b', 'c'], 'd')).toMatchObject({ ok: true });
    expect(HOUSEMATE_CAP).toBe(4);
  });
});

describe('rosterOf tolerates every shape a real document has', () => {
  test('absent, null, junk and mixed arrays all read as strings only', () => {
    expect(rosterOf(undefined)).toEqual([]);
    expect(rosterOf({})).toEqual([]);
    expect(rosterOf({ housemates: null })).toEqual([]);
    expect(rosterOf({ housemates: 'nope' })).toEqual([]);
    expect(rosterOf({ housemates: ['a', 7, null, 'b'] })).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// mintHousemateToken
// ---------------------------------------------------------------------------

describe('mintHousemateToken', () => {
  test('refuses an unauthenticated caller', async () => {
    await expect(mint()).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  test('mints a code bound to the caller, with the TTL on it', async () => {
    const res = await mint(HOST);
    expect(isValidHousemateTokenCode(res.code)).toBe(true);
    expect(res.ttlSeconds).toBe(HOUSEMATE_TOKEN_TTL_SECONDS);
    expect(res.expiresAtMs).toBe(T0 + HOUSEMATE_TOKEN_TTL_SECONDS * 1000);

    const stored = readRaw(`housemateTokens/${res.code}`);
    expect(stored).toMatchObject({ hostUid: HOST, createdAtMs: T0 });
    // CRITICAL: Nothing about redemption is written at mint time. If `redeemedAtMs`
    // were seeded here the single-use check would be reading its own default.
    expect(stored).not.toHaveProperty('redeemedAtMs');
  });

  test('the code is not derivable from the caller — two mints differ', async () => {
    const a = await mint(HOST);
    const b = await mint(HOST);
    expect(a.code).not.toBe(b.code);
  });

  test('refuses when the house is already full', async () => {
    seed(`users/${HOST}`, { housemates: ['a', 'b', 'c', 'd'] });
    await expect(mint(HOST)).rejects.toMatchObject({ code: 'resource-exhausted' });
  });

  test('🔴 a code collision retries rather than overwriting a live token', async () => {
    // Forced, because at 50 bits it never happens by accident and the branch
    // would otherwise never run. The generator is made to hand out a code that
    // is already taken by a DIFFERENT host: `create` must reject it, and the
    // retry must mint a fresh one — overwriting would silently re-point
    // somebody else's live token at this caller's house.
    const taken = await mint('uid-someone-else');
    const codes = [taken.code, 'ABCDEFGHJK'];
    let i = 0;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('../housemateToken');
    const spy = jest
      .spyOn(mod, 'generateHousemateTokenCode')
      .mockImplementation(() => codes[Math.min(i++, codes.length - 1)]);

    const second = await mint(HOST);
    expect(spy).toHaveBeenCalledTimes(2); // it really did collide and retry
    expect(second.code).toBe('ABCDEFGHJK');
    expect(readRaw(`housemateTokens/${taken.code}`)).toMatchObject({
      hostUid: 'uid-someone-else',
    });
    expect(readRaw('housemateTokens/ABCDEFGHJK')).toMatchObject({ hostUid: HOST });
  });
});

// ---------------------------------------------------------------------------
// redeemHousemateToken — the three properties, as behaviour
// ---------------------------------------------------------------------------

describe('redeemHousemateToken refusals', () => {
  beforeEach(() => seedFriendship(HOST, GUEST));

  test('refuses an unauthenticated caller', async () => {
    await expect(redeem('ABCDEFGHJK')).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  test('refuses a malformed code without reading anything', async () => {
    await expect(redeem('not a code', GUEST)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect(_db.runTransaction).not.toHaveBeenCalled();
  });

  test('refuses a well-formed code that was never minted', async () => {
    await expect(redeem('ABCDEFGHJK', GUEST)).rejects.toMatchObject({ code: 'not-found' });
  });

  test('🔴 NO SELF-GRANT: the host redeeming their own code writes nothing', async () => {
    const { code } = await mint(HOST);
    await expect(redeem(code, HOST)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(rosterOf(readRaw(`users/${HOST}`) ?? undefined)).toEqual([]);
    expect(readRaw(`housemateTokens/${code}`)).not.toHaveProperty('redeemedAtMs');
  });

  test('refuses when the two are not accepted friends, and grants nothing', async () => {
    resetStore();
    const { code } = await mint(HOST);
    await expect(redeem(code, GUEST)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(readRaw(`users/${HOST}`)).toBeNull();
  });

  test('refuses when only one side of the friendship is accepted', async () => {
    resetStore();
    seed(`users/${HOST}/friends/${GUEST}`, { status: 'accepted' });
    seed(`users/${GUEST}/friends/${HOST}`, { status: 'pending' });
    const { code } = await mint(HOST);
    await expect(redeem(code, GUEST)).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});

describe('🔑 SHORT-LIVED', () => {
  beforeEach(() => seedFriendship(HOST, GUEST));

  test('a token redeemed one second before expiry still works', async () => {
    const { code } = await mint(HOST);
    (Date.now as unknown as jest.Mock).mockReturnValue(T0 + HOUSEMATE_TOKEN_TTL_SECONDS * 1000 - 1000);
    await expect(redeem(code, GUEST)).resolves.toMatchObject({ hostUid: HOST });
  });

  test('a token redeemed after expiry is refused AND writes no roster', async () => {
    const { code } = await mint(HOST);
    (Date.now as unknown as jest.Mock).mockReturnValue(T0 + HOUSEMATE_TOKEN_TTL_SECONDS * 1000 + 1);
    await expect(redeem(code, GUEST)).rejects.toMatchObject({ code: 'deadline-exceeded' });
    expect(rosterOf(readRaw(`users/${HOST}`) ?? undefined)).toEqual([]);
    expect(rosterOf(readRaw(`users/${GUEST}`) ?? undefined)).toEqual([]);
  });

  test('expiry is measured from the mint, not from the redeem attempt', async () => {
    // A token cannot be refreshed by trying it. Two failed attempts must not
    // slide the deadline forward.
    const { code } = await mint(HOST);
    (Date.now as unknown as jest.Mock).mockReturnValue(T0 + 10_000);
    await expect(redeem(code, HOST)).rejects.toMatchObject({ code: 'failed-precondition' });
    (Date.now as unknown as jest.Mock).mockReturnValue(T0 + HOUSEMATE_TOKEN_TTL_SECONDS * 1000);
    await expect(redeem(code, GUEST)).rejects.toMatchObject({ code: 'deadline-exceeded' });
  });
});

describe('🔑 SINGLE-USE', () => {
  beforeEach(() => seedFriendship(HOST, GUEST));

  test('the happy path writes BOTH rosters and marks the token spent', async () => {
    const { code } = await mint(HOST);
    const res = await redeem(code, GUEST);

    expect(res).toMatchObject({ hostUid: HOST, housemateCount: 1 });
    expect(rosterOf(readRaw(`users/${HOST}`) ?? undefined)).toEqual([GUEST]);
    expect(rosterOf(readRaw(`users/${GUEST}`) ?? undefined)).toEqual([HOST]);
    expect(readRaw(`housemateTokens/${code}`)).toMatchObject({
      redeemedAtMs: T0,
      redeemedByUid: GUEST,
    });
  });

  test('🔴 the SAME token redeemed twice fails the second time', async () => {
    const { code } = await mint(HOST);
    await redeem(code, GUEST);
    await expect(redeem(code, GUEST)).rejects.toMatchObject({ code: 'already-exists' });
  });

  test('a third party cannot replay a spent token onto themselves', async () => {
    seedFriendship(HOST, 'uid-third');
    const { code } = await mint(HOST);
    await redeem(code, GUEST);
    await expect(redeem(code, 'uid-third')).rejects.toMatchObject({ code: 'already-exists' });
    expect(rosterOf(readRaw(`users/${HOST}`) ?? undefined)).toEqual([GUEST]);
  });

  test('🔴 two CONCURRENT redemptions grant exactly once', async () => {
    // The race two phones in a room actually hit. The interleaved redemption is
    // committed after the first transaction has read the token but before it
    // commits, so the first must re-run, re-read a spent token, and refuse.
    seedFriendship(HOST, 'uid-third');
    const { code } = await mint(HOST);

    beforeCommit = () => {
      applyWrite(
        `housemateTokens/${code}`,
        { redeemedAtMs: T0, redeemedByUid: 'uid-third' },
        true,
      );
      applyWrite(`users/${HOST}`, { housemates: ['uid-third'] }, true);
      applyWrite(`users/uid-third`, { housemates: [HOST] }, true);
    };

    await expect(redeem(code, GUEST)).rejects.toMatchObject({ code: 'already-exists' });
    // One grant, not two: GUEST never made it into the house.
    expect(rosterOf(readRaw(`users/${HOST}`) ?? undefined)).toEqual(['uid-third']);
  });

  test('a fresh token still works after one was spent', async () => {
    const first = await mint(HOST);
    await redeem(first.code, GUEST);
    seedFriendship(HOST, 'uid-third');
    const second = await mint(HOST);
    await expect(redeem(second.code, 'uid-third')).resolves.toMatchObject({ hostUid: HOST });
    expect(rosterOf(readRaw(`users/${HOST}`) ?? undefined)).toEqual([GUEST, 'uid-third']);
  });

  test('redeeming twice between the SAME pair is idempotent, not a double slot', async () => {
    const first = await mint(HOST);
    await redeem(first.code, GUEST);
    const second = await mint(HOST);
    await redeem(second.code, GUEST);
    expect(rosterOf(readRaw(`users/${HOST}`) ?? undefined)).toEqual([GUEST]);
    expect(rosterOf(readRaw(`users/${GUEST}`) ?? undefined)).toEqual([HOST]);
  });
});

describe('🔑 THE CAP HOLDS AFTER REDEMPTION', () => {
  beforeEach(() => seedFriendship(HOST, GUEST));

  test("a full HOST house refuses, and does not spend the token or touch the guest", async () => {
    const { code } = await mint(HOST);
    seed(`users/${HOST}`, { housemates: ['a', 'b', 'c', 'd'] });
    await expect(redeem(code, GUEST)).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(rosterOf(readRaw(`users/${HOST}`) ?? undefined)).toEqual(['a', 'b', 'c', 'd']);
    expect(readRaw(`users/${GUEST}`)).toBeNull();
    expect(readRaw(`housemateTokens/${code}`)).not.toHaveProperty('redeemedAtMs');
  });

  test('a full GUEST house refuses too — the grant is mutual, so both caps bind', async () => {
    const { code } = await mint(HOST);
    seed(`users/${GUEST}`, { housemates: ['a', 'b', 'c', 'd'] });
    await expect(redeem(code, GUEST)).rejects.toMatchObject({ code: 'resource-exhausted' });
    // CRITICAL: Half a grant is the state no screen can describe. Neither side moved.
    expect(rosterOf(readRaw(`users/${HOST}`) ?? undefined)).toEqual([]);
    expect(rosterOf(readRaw(`users/${GUEST}`) ?? undefined)).toEqual(['a', 'b', 'c', 'd']);
  });

  test('the fourth housemate still fits — the cap is not off by one', async () => {
    const { code } = await mint(HOST);
    seed(`users/${HOST}`, { housemates: ['a', 'b', 'c'] });
    await expect(redeem(code, GUEST)).resolves.toMatchObject({ hostUid: HOST });
    expect(rosterOf(readRaw(`users/${HOST}`) ?? undefined)).toHaveLength(HOUSEMATE_CAP);
  });

  test('redemption never writes a Cloud-Function-owned field along the way', async () => {
    // The roster write is a merge on users/{uid}; a set() without merge would
    // erase subscriptionTier, fcmToken and every other field on the document.
    seed(`users/${HOST}`, { fcmToken: 'keep-me', subscriptionTier: 'premium' });
    const { code } = await mint(HOST);
    await redeem(code, GUEST);
    expect(readRaw(`users/${HOST}`)).toMatchObject({
      fcmToken: 'keep-me',
      subscriptionTier: 'premium',
      housemates: [GUEST],
    });
  });
});
