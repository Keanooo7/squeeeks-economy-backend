// Force module scope. Without a top-level import/export a .ts file is a SCRIPT,
// so its top-level consts land in the GLOBAL scope and collide with the
// identically-named ones in sibling test files (TS2451). See W3-09.
export {};

// functions/src/__tests__/accountDeletion.test.ts
//
// W2-112. The settings dialog said "All your data will be deleted" and the code
// ran `FirebaseAuth.instance.currentUser?.delete()` — the Auth record and
// nothing else. This file covers the planner that decides what a deletion
// touches, and the applier that carries it out.
//
// CRITICAL: THE VACUITY TRAP THIS FILE IS WRITTEN AGAINST, NAMED EXPLICITLY.
// A deletion test is unusually easy to write so that it proves nothing: an
// assertion that a document is ABSENT passes when the fixture never created it,
// so a test with a broken seed and a broken cascade is green. Every absence
// assertion below is therefore preceded by `expectPresent(...)` over the SAME
// key — seed, assert present, delete, assert absent. `expectPresent` is not
// decoration; delete it and the applier tests pass against an empty store.
//
// The planner half has the mirrored defence: every "this is included" assertion
// is paired with a CONTROL where the same field must come back empty, so a
// planner that returned its inputs unconditionally would fail.

// ---------------------------------------------------------------------------
// Fake Firestore — a Map keyed by document path.
//
// NOTE: PATH-KEYED RATHER THAN TREE-SHAPED ON PURPOSE. The bug this cascade exists
// to prevent is an orphaned SUBCOLLECTION: `users/{uid}` deleted while
// `users/{uid}/inventory/*` survives, invisible under a parent that no longer
// exists. A tree-shaped fake would delete children with their parent and would
// make that bug unreachable in tests — it would model the Firestore we wish we
// had. A flat map reproduces the real semantics: deleting a key removes exactly
// that one key.
// ---------------------------------------------------------------------------

const _store = new Map<string, Record<string, unknown>>();

/** Firestore's hard limit on operations in a single WriteBatch. */
const FIRESTORE_BATCH_LIMIT = 500;

/** Every write the fake performed, in order — the ordering assertions read this. */
const _opLog: string[] = [];

function childCollectionIds(docPath: string): string[] {
  const ids = new Set<string>();
  for (const key of _store.keys()) {
    if (!key.startsWith(`${docPath}/`)) continue;
    const rest = key.slice(docPath.length + 1).split('/');
    if (rest.length >= 2) ids.add(rest[0]);
  }
  return [...ids];
}

function collectionDocIds(colPath: string): string[] {
  const ids = new Set<string>();
  for (const key of _store.keys()) {
    if (!key.startsWith(`${colPath}/`)) continue;
    // The first segment after the collection. A deeper key contributes its
    // ancestor id here even when that ancestor holds no data of its own —
    // which is exactly how listDocuments() behaves, and exactly how an orphan
    // hides.
    ids.add(key.slice(colPath.length + 1).split('/')[0]);
  }
  return [...ids];
}

function applyMerge(path: string, data: Record<string, unknown>): void {
  const current = {...(_store.get(path) ?? {})};
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && (v as any)._type === 'arrayRemove') {
      const existing = Array.isArray(current[k]) ? (current[k] as unknown[]) : [];
      current[k] = existing.filter((x) => !(v as any).values.includes(x));
    } else {
      current[k] = v;
    }
  }
  _store.set(path, current);
}

function makeDoc(path: string): any {
  return {
    path,
    id: path.split('/').pop(),
    get: jest.fn(async () => ({
      exists: _store.has(path),
      id: path.split('/').pop(),
      data: () => _store.get(path),
    })),
    set: jest.fn(async (data: Record<string, unknown>, opts?: {merge?: boolean}) => {
      _opLog.push(`set ${path}`);
      if (opts?.merge) applyMerge(path, data);
      else _store.set(path, {...data});
    }),
    update: jest.fn(async (data: Record<string, unknown>) => {
      _opLog.push(`update ${path}`);
      applyMerge(path, data);
    }),
    delete: jest.fn(async () => {
      _opLog.push(`delete ${path}`);
      _store.delete(path);
    }),
    listCollections: jest.fn(async () =>
      childCollectionIds(path).map((id) => makeCollection(`${path}/${id}`)),
    ),
  };
}

function makeCollection(colPath: string): any {
  return {
    id: colPath.split('/').pop(),
    path: colPath,
    doc: (id: string) => makeDoc(`${colPath}/${id}`),
    listDocuments: jest.fn(async () =>
      collectionDocIds(colPath).map((id) => makeDoc(`${colPath}/${id}`)),
    ),
    where: (field: string, op: string, value: unknown) => ({
      get: jest.fn(async () => {
        if (op !== '==') throw new Error(`fake supports only ==, got ${op}`);
        const docs = collectionDocIds(colPath)
          .map((id) => ({id, data: _store.get(`${colPath}/${id}`)}))
          .filter((d) => d.data !== undefined && d.data[field] === value)
          .map((d) => ({id: d.id, data: () => d.data}));
        return {docs, size: docs.length, empty: docs.length === 0};
      }),
    }),
  };
}

function makeBatch() {
  const ops: Array<() => void> = [];
  return {
    delete: (ref: {path: string}) => {
      ops.push(() => {
        _opLog.push(`delete ${ref.path}`);
        _store.delete(ref.path);
      });
    },
    set: (ref: {path: string}, data: Record<string, unknown>, opts?: {merge?: boolean}) => {
      ops.push(() => {
        _opLog.push(`set ${ref.path}`);
        if (opts?.merge) applyMerge(ref.path, data);
        else _store.set(ref.path, {...data});
      });
    },
    commit: jest.fn(async () => {
      if (ops.length > FIRESTORE_BATCH_LIMIT) {
        // The real server rejects the WHOLE commit — nothing in it is written.
        const err = new Error(
          `3 INVALID_ARGUMENT: maximum ${FIRESTORE_BATCH_LIMIT} writes allowed per request`,
        );
        (err as unknown as {code: number}).code = 3;
        throw err;
      }
      for (const op of ops) op();
    }),
  };
}

const _db = {
  doc: jest.fn((path: string) => makeDoc(path)),
  collection: jest.fn((path: string) => makeCollection(path)),
  batch: jest.fn(() => makeBatch()),
  runTransaction: jest.fn(async (fn: (tx: any) => Promise<any>) => {
    const tx = {
      get: async (ref: any) => ref.get(),
      set: (ref: any, data: any, opts?: any) => {
        _opLog.push(`set ${ref.path}`);
        if (opts?.merge) applyMerge(ref.path, data);
        else _store.set(ref.path, {...data});
      },
      update: (ref: any, data: any) => {
        _opLog.push(`update ${ref.path}`);
        applyMerge(ref.path, data);
      },
      delete: (ref: any) => {
        _opLog.push(`delete ${ref.path}`);
        _store.delete(ref.path);
      },
    };
    return fn(tx);
  }),
};

const _deleteUser = jest.fn(async (_uid: string) => {
  _opLog.push(`auth.deleteUser ${_uid}`);
});

jest.mock('firebase-admin', () => {
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = {
    increment: (n: number) => ({_type: 'increment', n}),
    arrayRemove: (...values: unknown[]) => ({_type: 'arrayRemove', values}),
  };
  firestoreFn.Timestamp = {now: () => ({seconds: 0, nanoseconds: 0})};
  return {
    initializeApp: jest.fn(),
    firestore: firestoreFn,
    auth: jest.fn(() => ({
      deleteUser: (uid: string) => _deleteUser(uid),
      getUser: jest.fn(async (uid: string) => ({displayName: `Name ${uid}`})),
      createUser: jest.fn(),
    })),
    messaging: jest.fn(() => ({send: jest.fn()})),
  };
});

jest.mock('firebase-admin/firestore', () => {
  const admin = jest.requireMock('firebase-admin') as any;
  return {
    FieldValue: admin.firestore.FieldValue,
    Timestamp: {...admin.firestore.Timestamp, fromDate: (d: Date) => ({_date: d})},
  };
});

jest.mock('firebase-functions/v2/https', () => ({
  onCall: (...args: any[]) => ({_handler: args[args.length - 1]}),
  onRequest: (...args: any[]) => ({_handler: args[args.length - 1]}),
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: (...args: any[]) => ({_handler: args[args.length - 1]}),
}));
jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (...args: any[]) => ({_handler: args[args.length - 1]}),
}));
jest.mock('firebase-functions/v1/auth', () => ({
  user: () => ({onCreate: (handler: any) => ({_handler: handler})}),
}));

// ---------------------------------------------------------------------------
// Imports after the mocks
// ---------------------------------------------------------------------------

import {
  ALWAYS_RETAINED,
  KNOWN_USER_SUBCOLLECTIONS,
  planAccountDeletion,
  thirdPartyWrites,
} from '../accountDeletion';
import type {FamilyDoc} from '../family';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {deleteAccount} = require('../index') as {
  deleteAccount: {_handler: (req: any) => Promise<any>};
};

// ---------------------------------------------------------------------------
// Planner
// ---------------------------------------------------------------------------

const NOW = 1_760_000_000_000;
const ME = 'uid-me';
const FRIEND = 'uid-friend';
const OWNER = 'uid-owner';

const familyOwnedByOther: FamilyDoc = {
  ownerUid: OWNER,
  memberUids: [OWNER, ME],
  memberNames: {[OWNER]: 'Owner', [ME]: 'Me'},
  memberAvatars: {[OWNER]: 'fox', [ME]: 'duck'},
  createdAtMs: NOW - 1000,
};

const familyOwnedByMe: FamilyDoc = {
  ownerUid: ME,
  memberUids: [ME, FRIEND],
  memberNames: {[ME]: 'Me', [FRIEND]: 'Friend'},
  memberAvatars: {},
  createdAtMs: NOW - 1000,
};

const plan = (over: Record<string, unknown> = {}) =>
  planAccountDeletion({
    uid: ME,
    user: {housemates: []},
    ownDocPaths: [],
    friendEdges: [],
    family: null,
    sentGiftInvites: [],
    choreIds: [],
    messageIds: [],
    foreignHits: [],
    nowMs: NOW,
    ...over,
  } as Parameters<typeof planAccountDeletion>[0]);

describe('🔴 W2-112 planAccountDeletion — own documents', () => {
  it('keeps every discovered path under users/{uid}/', () => {
    const p = plan({
      ownDocPaths: [`users/${ME}/house/layout`, `users/${ME}/inventory/sofa`],
    });
    expect(p.ownDocPaths).toEqual([
      `users/${ME}/house/layout`,
      `users/${ME}/inventory/sofa`,
    ]);
    expect(p.rootPath).toBe(`users/${ME}`);
  });

  it('🔴 CONTROL — drops any path outside users/{uid}/, whatever discovery handed it', () => {
    // The blast radius. These paths reach an Admin SDK batch delete, which
    // bypasses every rule, so a discovery bug must not be able to name them.
    const p = plan({
      ownDocPaths: [
        `users/${ME}/house/layout`,
        `users/${FRIEND}/house/layout`,
        'families/fam-1',
        `users/${ME}`,
      ],
    });
    expect(p.ownDocPaths).toEqual([`users/${ME}/house/layout`]);
  });

  it('📌 the root document is not in ownDocPaths — it is deleted separately, last', () => {
    const p = plan({ownDocPaths: [`users/${ME}`]});
    expect(p.ownDocPaths).toEqual([]);
  });
});

describe('🔴 W2-112 planAccountDeletion — the mirror edge', () => {
  it('names users/{friend}/friends/{uid} for every edge this user holds', () => {
    const p = plan({friendEdges: [{id: FRIEND}, {id: 'gibby'}]});
    expect(p.mirrorEdgePaths).toEqual([
      `users/${FRIEND}/friends/${ME}`,
      `users/gibby/friends/${ME}`,
    ]);
  });

  it('🔴 CONTROL — no friends means no third-party edge writes at all', () => {
    expect(plan({friendEdges: []}).mirrorEdgePaths).toEqual([]);
  });

  it('🔑 excludes a self-edge, which ownDocPaths already covers', () => {
    expect(plan({friendEdges: [{id: ME}]}).mirrorEdgePaths).toEqual([]);
  });
});

describe('🔴 W2-112 planAccountDeletion — housemates', () => {
  it("reads the reverse index off this user's own housemates array", () => {
    const p = plan({user: {housemates: [FRIEND, OWNER]}});
    expect(p.housemateArrayUids).toEqual([FRIEND, OWNER]);
  });

  it('🔴 CONTROL — an empty roster writes to nobody', () => {
    expect(plan({user: {housemates: []}}).housemateArrayUids).toEqual([]);
    expect(plan({user: undefined}).housemateArrayUids).toEqual([]);
  });
});

describe('🔴 W2-112 planAccountDeletion — the family', () => {
  it('a MEMBER departs: the roster loses them, only they are revoked', () => {
    const p = plan({family: {id: 'fam-1', data: familyOwnedByOther}});
    expect(p.family).not.toBeNull();
    if (!p.family) return;
    expect(p.family.departure.dissolved).toBe(false);
    expect(p.family.departure.memberUids).toEqual([OWNER]);
    expect(p.family.departure.revokedUids).toEqual([ME]);
    // The leaver's denormalised name and avatar are pruned with them.
    expect(p.family.departure.memberNames).toEqual({[OWNER]: 'Owner'});
    expect(p.family.departure.memberAvatars).toEqual({[OWNER]: 'fox'});
  });

  it('🔴 the OWNER disbands: the family dissolves and every member is revoked', () => {
    const p = plan({family: {id: 'fam-1', data: familyOwnedByMe}});
    expect(p.family).not.toBeNull();
    if (!p.family) return;
    expect(p.family.departure.dissolved).toBe(true);
    expect(p.family.departure.revokedUids).toEqual([ME, FRIEND]);
    expect(p.familyRefusal).toBeNull();
  });

  it('🔴 CONTROL — no family means no family effect and no refusal', () => {
    const p = plan({family: null});
    expect(p.family).toBeNull();
    expect(p.familyRefusal).toBeNull();
  });

  it('🔴 an unplannable family does NOT block the deletion — 5.1.1(v)', () => {
    // A structurally unsound family document must never trap somebody inside
    // an account they asked to delete. The refusal is recorded and stepped
    // over; the rest of the plan is unaffected.
    const broken = {ownerUid: '', memberUids: [], createdAtMs: 0} as FamilyDoc;
    const p = plan({
      family: {id: 'fam-broken', data: broken},
      ownDocPaths: [`users/${ME}/house/layout`],
    });
    expect(p.family).toBeNull();
    expect(p.familyRefusal).toEqual({familyId: 'fam-broken', refusal: 'invalid-family'});
    expect(p.ownDocPaths).toEqual([`users/${ME}/house/layout`]);
    expect(p.retained.map((r) => r.what)).toContain('families/fam-broken');
  });
});

describe('🔴 W2-112 planAccountDeletion — chores and sent gifts', () => {
  it('names a chore path only when a family was actually read', () => {
    const p = plan({family: {id: 'fam-1', data: familyOwnedByOther}, choreIds: ['c1']});
    expect(p.choreDocPaths).toEqual(['families/fam-1/chores/c1']);
  });

  it('🔴 CONTROL — no family means no chore path can be invented', () => {
    expect(plan({family: null, choreIds: ['c1']}).choreDocPaths).toEqual([]);
  });

  it("a sent gift invite is addressed in the RECIPIENT's subcollection", () => {
    const p = plan({sentGiftInvites: [{ownerUid: FRIEND, inviteId: 'g1'}]});
    expect(p.sentGiftInvitePaths).toEqual([`users/${FRIEND}/giftInvites/g1`]);
  });

  it('🔴 CONTROL — nothing sent means nothing touched', () => {
    expect(plan({sentGiftInvites: []}).sentGiftInvitePaths).toEqual([]);
  });
});

describe('🔑 W2-112 what is kept on purpose', () => {
  it('the Apple replay ledger is retained, and says why', () => {
    const kept = plan().retained.find((r) =>
      r.what.startsWith('processedReceipts/'),
    );
    expect(kept).toBeDefined();
    expect(kept?.reason).toMatch(/replay/i);
  });

  it('every retained entry carries a non-trivial reason', () => {
    // A collection nobody deleted and nobody wrote down is indistinguishable,
    // later, from one that was missed.
    for (const r of ALWAYS_RETAINED) {
      expect(r.what.length).toBeGreaterThan(0);
      expect(r.reason.length).toBeGreaterThan(40);
    }
  });
});

describe('🔑 W2-112 thirdPartyWrites — the fields touched on other people', () => {
  it('names the exact field on each foreign document', () => {
    const p = plan({
      friendEdges: [{id: FRIEND}],
      user: {housemates: [FRIEND]},
      family: {id: 'fam-1', data: familyOwnedByOther},
    });
    const writes = thirdPartyWrites(p);
    expect(writes).toContainEqual({
      path: `users/${FRIEND}/friends/${ME}`,
      op: 'delete',
    });
    expect(writes).toContainEqual({
      path: `users/${FRIEND}`,
      op: 'update',
      fields: ['housemates'],
    });
    expect(writes).toContainEqual({
      path: 'families/fam-1',
      op: 'update',
      fields: ['memberUids', 'memberNames', 'memberAvatars'],
    });
    // KEY: The deleted user's own document is never listed as a third party —
    // it is being deleted outright, and listing it would overstate the blast
    // radius in the very report written to bound it.
    expect(writes.some((w) => w.path === `users/${ME}`)).toBe(false);
  });

  it('a disband deletes the family document and revokes the other members', () => {
    const p = plan({family: {id: 'fam-1', data: familyOwnedByMe}});
    const writes = thirdPartyWrites(p);
    expect(writes).toContainEqual({path: 'families/fam-1', op: 'delete'});
    expect(writes).toContainEqual({
      path: `users/${FRIEND}`,
      op: 'update',
      fields: ['familyProExpiresAt', 'familyId'],
    });
  });

  it('🔴 CONTROL — a plan with no relationships writes to nobody', () => {
    expect(thirdPartyWrites(plan())).toEqual([]);
  });
});

describe('📌 W2-112 KNOWN_USER_SUBCOLLECTIONS is a pin, not the mechanism', () => {
  it('is sorted and free of duplicates, so a hand edit cannot hide a name', () => {
    expect([...KNOWN_USER_SUBCOLLECTIONS].sort()).toEqual([
      ...KNOWN_USER_SUBCOLLECTIONS,
    ]);
    expect(new Set(KNOWN_USER_SUBCOLLECTIONS).size).toBe(
      KNOWN_USER_SUBCOLLECTIONS.length,
    );
  });

  it('names shieldPurchases, which has no block in firestore.rules', () => {
    // The concrete reason the runtime listCollections() leads and this follows:
    // anyone enumerating this surface from the rules file misses it.
    expect(KNOWN_USER_SUBCOLLECTIONS).toContain('shieldPurchases');
  });
});

// ---------------------------------------------------------------------------
// The applier, through the callable
// ---------------------------------------------------------------------------

/**
 * CRITICAL: THE ANTI-VACUITY ASSERTION. Every absence check below is preceded by this
 * over the same key. Without it, a broken seed and a broken cascade both look
 * like a pass.
 */
function expectPresent(...paths: string[]): void {
  for (const p of paths) {
    expect({path: p, present: _store.has(p)}).toEqual({path: p, present: true});
  }
}

function expectAbsent(...paths: string[]): void {
  for (const p of paths) {
    expect({path: p, present: _store.has(p)}).toEqual({path: p, present: false});
  }
}

function seedAccount(): void {
  _store.set(`users/${ME}`, {
    housemates: [FRIEND],
    familyId: 'fam-1',
    subscriptionTier: 'pro',
  });
  _store.set(`users/${ME}/house/layout`, {rooms: []});
  _store.set(`users/${ME}/inventory/sofa`, {equipped: true});
  _store.set(`users/${ME}/shieldPurchases/p1`, {amount: 1});
  _store.set(`users/${ME}/friends/${FRIEND}`, {status: 'accepted'});
  _store.set(`users/${ME}/friends/gibby`, {status: 'accepted'});

  _store.set(`users/${FRIEND}`, {housemates: [ME], displayName: 'Friend'});
  _store.set(`users/${FRIEND}/friends/${ME}`, {status: 'accepted'});
  _store.set(`users/${FRIEND}/giftInvites/g1`, {fromUid: ME, amount: 20});
  _store.set(`users/${FRIEND}/giftInvites/g2`, {fromUid: 'somebody-else', amount: 20});
  _store.set('users/gibby', {displayName: 'Gibby'});
  _store.set(`users/gibby/friends/${ME}`, {status: 'accepted'});

  _store.set(`users/${OWNER}`, {familyId: 'fam-1'});
  _store.set('families/fam-1', {...familyOwnedByOther});
  _store.set('families/fam-1/chores/c1', {assignedToUid: ME, title: 'Bins'});
  _store.set('families/fam-1/chores/c2', {assignedToUid: OWNER, title: 'Dishes'});
  // CRITICAL: TWO SENDERS, AND THE SECOND ONE IS THE POINT (W2-127). A test seeded
  // only with this user's messages would pass against an applier that deleted
  // the WHOLE messages subcollection — which would erase other people's words
  // to remove one person's. The decoy is what makes the assertion mean
  // "scoped by senderUid" rather than "something got deleted".
  _store.set('families/fam-1/messages/m1', {senderUid: ME, text: 'mine'});
  _store.set('families/fam-1/messages/m2', {senderUid: OWNER, text: 'theirs'});

  _store.set(`publicProfiles/${ME}`, {displayName: 'Me'});
  _store.set('subscriptionOwners/tx-1', {uid: ME, productId: 'pro_monthly'});
  _store.set('subscriptionOwners/tx-2', {uid: 'somebody-else'});
  _store.set('galleryFeedback/f1', {uid: ME, specimenKey: 'sofa'});
  _store.set('housemateTokens/TOK1', {hostUid: ME});
  _store.set('familyInvites/INV1', {ownerUid: ME, familyId: 'fam-1'});
  _store.set('processedReceipts/pro_monthly_tx-1', {uid: ME});
}

describe('🔴 W2-112 deleteAccount — the cascade', () => {
  beforeEach(() => {
    _store.clear();
    _opLog.length = 0;
    _deleteUser.mockClear();
    seedAccount();
  });

  it('refuses an unauthenticated call', async () => {
    await expect(deleteAccount._handler({})).rejects.toThrow(
      'Authentication required',
    );
    // And nothing was touched.
    expectPresent(`users/${ME}`, `users/${ME}/house/layout`);
  });

  it("🔴 removes every one of this account's own documents, root last", async () => {
    expectPresent(
      `users/${ME}`,
      `users/${ME}/house/layout`,
      `users/${ME}/inventory/sofa`,
      `users/${ME}/shieldPurchases/p1`,
      `users/${ME}/friends/${FRIEND}`,
      `users/${ME}/friends/gibby`,
    );

    await deleteAccount._handler({auth: {uid: ME}});

    expectAbsent(
      `users/${ME}`,
      `users/${ME}/house/layout`,
      `users/${ME}/inventory/sofa`,
      `users/${ME}/shieldPurchases/p1`,
      `users/${ME}/friends/${FRIEND}`,
      `users/${ME}/friends/gibby`,
    );
  });

  it('🔴 removes the MIRROR edge on every friend, including Gibby', async () => {
    expectPresent(`users/${FRIEND}/friends/${ME}`, `users/gibby/friends/${ME}`);
    await deleteAccount._handler({auth: {uid: ME}});
    expectAbsent(`users/${FRIEND}/friends/${ME}`, `users/gibby/friends/${ME}`);
    // CRITICAL: CONTROL — the friends themselves survive. This is the assertion that
    // separates "cleaned a dangling reference" from "deleted somebody else".
    expectPresent(`users/${FRIEND}`, 'users/gibby');
  });

  it('🔴 removes only this uid from a friend\'s housemates array', async () => {
    expect(_store.get(`users/${FRIEND}`)?.housemates).toEqual([ME]);
    await deleteAccount._handler({auth: {uid: ME}});
    expect(_store.get(`users/${FRIEND}`)?.housemates).toEqual([]);
    // Every other field on that third-party document is untouched.
    expect(_store.get(`users/${FRIEND}`)?.displayName).toBe('Friend');
  });

  it('🔴 leaves the family standing and drops the seat, when a member goes', async () => {
    expectPresent('families/fam-1');
    await deleteAccount._handler({auth: {uid: ME}});
    expectPresent('families/fam-1');
    expect(_store.get('families/fam-1')?.memberUids).toEqual([OWNER]);
    expect(_store.get('families/fam-1')?.memberNames).toEqual({[OWNER]: 'Owner'});
    // CRITICAL: The seat AND the grant. FAMILY_CAP counts memberUids, and
    // sharesFamilyWith resolves off it — a retained uid consumes both.
    expect(_store.get(`users/${ME}`)).toBeUndefined();
  });

  it('🔴 deletes the chore assigned to this user, and no other chore', async () => {
    expectPresent('families/fam-1/chores/c1', 'families/fam-1/chores/c2');
    await deleteAccount._handler({auth: {uid: ME}});
    expectAbsent('families/fam-1/chores/c1');
    expectPresent('families/fam-1/chores/c2');
  });

  it('🔴 deletes the gift invites this user SENT, and nobody else\'s', async () => {
    expectPresent(`users/${FRIEND}/giftInvites/g1`, `users/${FRIEND}/giftInvites/g2`);
    await deleteAccount._handler({auth: {uid: ME}});
    expectAbsent(`users/${FRIEND}/giftInvites/g1`);
    expectPresent(`users/${FRIEND}/giftInvites/g2`);
  });

  it('🔴 deletes the foreign documents naming this uid, and no near-miss', async () => {
    expectPresent(
      'subscriptionOwners/tx-1',
      'subscriptionOwners/tx-2',
      'galleryFeedback/f1',
      'housemateTokens/TOK1',
      'familyInvites/INV1',
    );
    await deleteAccount._handler({auth: {uid: ME}});
    expectAbsent(
      'subscriptionOwners/tx-1',
      'galleryFeedback/f1',
      'housemateTokens/TOK1',
      'familyInvites/INV1',
    );
    // CRITICAL: CONTROL — the row belonging to somebody else survives. Without it,
    // "delete everything in the collection" passes every assertion above.
    expectPresent('subscriptionOwners/tx-2');
  });

  it('🔑 keeps the Apple replay ledger', async () => {
    expectPresent('processedReceipts/pro_monthly_tx-1');
    await deleteAccount._handler({auth: {uid: ME}});
    expectPresent('processedReceipts/pro_monthly_tx-1');
  });

  it('🔴 deletes the Auth record LAST, after every Firestore write', async () => {
    await deleteAccount._handler({auth: {uid: ME}});
    expect(_deleteUser).toHaveBeenCalledWith(ME);
    const authIndex = _opLog.indexOf(`auth.deleteUser ${ME}`);
    expect(authIndex).toBeGreaterThan(-1);
    // Nothing follows it. A failure before this point leaves an account that
    // can still sign in and retry; a failure after it would be unrecoverable.
    expect(authIndex).toBe(_opLog.length - 1);
    expect(_opLog[authIndex - 1]).toBe(`delete users/${ME}`);
  });

  it('🔑 the root document is deleted after every one of its descendants', async () => {
    await deleteAccount._handler({auth: {uid: ME}});
    const root = _opLog.indexOf(`delete users/${ME}`);
    const child = _opLog.indexOf(`delete users/${ME}/house/layout`);
    expect(child).toBeGreaterThan(-1);
    expect(root).toBeGreaterThan(child);
  });

  it('📌 leaves publicProfiles/{uid} to syncPublicProfile, which is not run here', async () => {
    // The projection is deleted by the onDocumentWritten trigger when the root
    // document disappears (index.ts syncPublicProfile, `after === undefined`),
    // covered by publicProfile.test.ts "deletes the projection when the user
    // document is deleted". This fake does not run triggers, so the projection
    // survives HERE — asserted so the gap is stated rather than assumed away.
    await deleteAccount._handler({auth: {uid: ME}});
    expectPresent(`publicProfiles/${ME}`);
  });

  it('⚠️ is idempotent — a second call succeeds and changes nothing further', async () => {
    await deleteAccount._handler({auth: {uid: ME}});
    const after = [..._store.keys()].sort();
    const result = await deleteAccount._handler({auth: {uid: ME}});
    expect(result.deleted).toBe(true);
    expect([..._store.keys()].sort()).toEqual(after);
  });

  it('🔴 an OWNER dissolves the family and revokes every member', async () => {
    _store.set(`users/${ME}`, {familyId: 'fam-2'});
    _store.set('families/fam-2', {...familyOwnedByMe});
    _store.set(`users/${FRIEND}`, {
      housemates: [],
      familyId: 'fam-2',
      familyProExpiresAt: 999,
      subscriptionTier: 'free',
    });
    expectPresent('families/fam-2');

    await deleteAccount._handler({auth: {uid: ME}});

    expectAbsent('families/fam-2');
    expect(_store.get(`users/${FRIEND}`)?.familyProExpiresAt).toBeNull();
    expect(_store.get(`users/${FRIEND}`)?.familyId).toBeNull();
    // CRITICAL: CONTROL — their own paid tier is untouched. What ends is the family
    // grant, not a subscription somebody is paying for.
    expect(_store.get(`users/${FRIEND}`)?.subscriptionTier).toBe('free');
  });

  it('🔴 deletes the account even when the family record is unusable', async () => {
    _store.set('families/fam-1', {ownerUid: '', memberUids: [], createdAtMs: 0});
    expectPresent(`users/${ME}`, `users/${ME}/house/layout`);

    const result = await deleteAccount._handler({auth: {uid: ME}});

    expect(result.deleted).toBe(true);
    expectAbsent(`users/${ME}`, `users/${ME}/house/layout`);
    expect(_deleteUser).toHaveBeenCalledWith(ME);
    // The unplannable family is left whole rather than half-rewritten.
    expectPresent('families/fam-1');
  });

  it('🔑 an account with nothing but an Auth record still deletes', async () => {
    _store.clear();
    const result = await deleteAccount._handler({auth: {uid: ME}});
    expect(result.deleted).toBe(true);
    expect(_deleteUser).toHaveBeenCalledWith(ME);
  });

  // -------------------------------------------------------------------------
  // CRITICAL: W2-127 — the user's own messages, and nobody else's
  // -------------------------------------------------------------------------
  it("deletes this user's family messages and leaves other members' standing", async () => {
    // KEY: THE BEFORE-STATE IS LOAD-BEARING. Without `expectPresent` first, the
    // absence of m1 afterwards is compatible with m1 never having existed —
    // which is the exact failure shape this file's header was written about.
    expectPresent('families/fam-1/messages/m1', 'families/fam-1/messages/m2');

    await deleteAccount._handler({auth: {uid: ME}});

    expectAbsent('families/fam-1/messages/m1');
    // CRITICAL: THE DECOY, AND IT IS WHAT MAKES THE ASSERTION MEAN "SCOPED BY
    // senderUid" RATHER THAN "SOMETHING GOT DELETED". A suite seeded only with
    // this user's messages would pass against an applier that dropped the whole
    // subcollection — erasing other people's words to remove one person's.
    expectPresent('families/fam-1/messages/m2');
    expect(_store.get('families/fam-1/messages/m2')?.text).toBe('theirs');
  });

});

// ---------------------------------------------------------------------------
// CRITICAL: W2-127 — a deleted account's own messages go too
// ---------------------------------------------------------------------------
//
// NOTE: THIS REVERSES A DOCUMENTED DECISION, AND THE REVERSAL IS THE TEST'S
// SUBJECT. `ALWAYS_RETAINED` used to carry
// `families/{familyId}/messages where senderUid == uid` with the reasoning
// "they are this user's own words, but they sit inside other people's
// conversation and removing them rewrites a chat everyone else can still
// read." That argument is about conversational integrity and it was not wrong
// — it was outranked. Brendan's decision, 2026-08-19, after the Guideline 1.3
// (Kids Category) rejection: an account deletion that leaves a child's own
// words readable by other accounts is not a deletion, and "we delete
// everything on request" has to be TRUE AS WRITTEN before it is written to
// Apple.
//
// WARNING: THE OLD COMMENT ALSO CLAIMED THE FLIP WAS "A ONE-LINE CHANGE". The index
// half was right — a single-field equality query inside one known
// subcollection is auto-indexed — and the cost half was wrong: the planner is
// pure over already-fetched data, so it took an argument, a field, a mapping,
// a query in the caller and a delete in the applier.

describe('🔴 W2-127 planAccountDeletion — the user\'s own family messages', () => {
  it('maps message ids to paths under the family it was given', () => {
    const p = plan({
      family: {id: 'fam-1', data: familyOwnedByOther},
      messageIds: ['m1', 'm7'],
    });
    expect(p.messageDocPaths).toEqual([
      'families/fam-1/messages/m1',
      'families/fam-1/messages/m7',
    ]);
  });

  it('🔴 invents no path when there is no family, even if ids are passed', () => {
    // The same guard the chores mapping has: a planner that built a path from a
    // familyId it was not given would address `families/undefined/messages/...`
    // — a real document path, deleted with the Admin SDK, which bypasses rules.
    const p = plan({family: null, messageIds: ['m1']});
    expect(p.messageDocPaths).toEqual([]);
  });

  it('declares them in thirdPartyWrites, because they are somebody else\'s document', () => {
    // The subcollection belongs to the family, not to this user. The brief that
    // created `thirdPartyWrites` asked for exactly this: never touch another
    // party's document without naming it.
    const p = plan({
      family: {id: 'fam-1', data: familyOwnedByOther},
      messageIds: ['m1'],
    });
    expect(thirdPartyWrites(p)).toContainEqual({
      path: 'families/fam-1/messages/m1',
      op: 'delete',
    });
  });

  it('🔴 is no longer listed as retained', () => {
    // The list is the disclosure. Deleting the data and leaving the "kept on
    // purpose" entry behind would make the file claim the opposite of what it
    // does — and that file is what the Apple answer is written from.
    expect(ALWAYS_RETAINED.map((r) => r.what).join(' ')).not.toMatch(/messages/);
  });
});
