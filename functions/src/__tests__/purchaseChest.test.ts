// Force module scope. Without a top-level import/export a .ts file is a SCRIPT,
// so its top-level `const _db` lands in the GLOBAL scope and collides with the
// identically-named one in nine sibling test files (TS2451). Which pair collides
// depends on how ts-jest groups files into a worker, which is why the suite failed
// non-deterministically on a different file each run. Pre-existing; see W3-09.
export {};

// functions/src/__tests__/purchaseChest.test.ts
//
// purchaseChest had NO test file at all until 2026-08-05, which is how it kept
// the defect #67 fixed for its twin: the callable draws from the Firestore
// `items` collection, `items` is written only by seedShopData (a manual
// secret-gated POST that nothing enforces), and on 2026-08-05 the production
// collection was observed in the Firebase console to not exist at all — root
// collections were publicProfiles, shop, users. Every chest purchase in
// production was throwing 'No items available for rarity …' while shop/current
// was selling three chests a day at 100 sponges each.
//
// KEY: These tests assert on the DATA PATH — the payload handed to the inventory
// write and the item returned to the client — never on SEED_ITEMS. Asserting
// against the seed constant is exactly how index.ts:833 documented this flaw
// for days while the suite stayed green. The one place a constant IS the right
// target is the build-time pool guard at the bottom, mirroring
// welcomeChestPool.test.ts.

// ---------------------------------------------------------------------------
// Path-keyed Firestore mock (declared before imports — Jest hoists the factory)
// ---------------------------------------------------------------------------

interface DocState {
  data: Record<string, unknown> | null;
}
const docStore: Record<string, DocState> = {};

function resetStore() {
  for (const k of Object.keys(docStore)) delete docStore[k];
  for (const k of Object.keys(docVersions)) delete docVersions[k];
}

/**
 * Write version per document path, bumped on every committed write.
 *
 * This is what lets `contendedTransaction()` model Firestore's optimistic
 * locking: a transaction that READ a document whose version has since moved
 * must re-run. Without it two concurrent purchases both pass one affordability
 * check and the balance goes negative — the exact failure removing the
 * per-chest uniqueness guard could have introduced.
 */
const docVersions: Record<string, number> = {};

/**
 * Applies one write to the store, resolving the FieldValue sentinels the
 * callable actually uses.
 *
 * `increment` is resolved against the STORED NUMBER, not left as a sentinel.
 * It used to be left alone, which made "the balance was debited twice" and
 * "the balance ran out" unassertable: every purchase overwrote the field with
 * a fresh `{_type:'increment'}` object, so a second debit looked identical to
 * a first. Every balance assertion in this file is now on the real number.
 */
function applyWrite(
  path: string,
  val: Record<string, unknown>,
  opts?: { merge?: boolean },
) {
  const st = docStore[path] ?? (docStore[path] = { data: null });
  const prev = (st.data ?? {}) as Record<string, unknown>;
  const applied: Record<string, unknown> = {};
  const deleted: string[] = [];
  for (const [k, v] of Object.entries(val)) {
    const sentinel = v as { _type?: string; values?: unknown[]; n?: number };
    if (sentinel && sentinel._type === 'arrayUnion') {
      const existing = Array.isArray(prev[k]) ? (prev[k] as unknown[]) : [];
      applied[k] = [...new Set([...existing, ...(sentinel.values ?? [])])];
    } else if (sentinel && sentinel._type === 'increment') {
      const existing = typeof prev[k] === 'number' ? (prev[k] as number) : 0;
      applied[k] = existing + (sentinel.n ?? 0);
    } else if (sentinel && sentinel._type === 'delete') {
      deleted.push(k);
    } else {
      applied[k] = v;
    }
  }
  const next = opts?.merge ? { ...prev, ...applied } : { ...applied };
  for (const k of deleted) delete next[k];
  st.data = next;
  docVersions[path] = (docVersions[path] ?? 0) + 1;
}

function docMock(path: string): any {
  return {
    path,
    id: path.split('/').pop(),
    get: jest.fn(async () => {
      const st = docStore[path] ?? { data: null };
      return {
        exists: st.data !== null,
        data: () => st.data,
        id: path.split('/').pop(),
        ref: docMock(path),
      };
    }),
    set: jest.fn(async (val: Record<string, unknown>, opts?: { merge?: boolean }) => {
      applyWrite(path, val, opts);
    }),
    // Mirrors Admin SDK `create`: rejects if the document already exists. This
    // is what makes the replay ledger atomic rather than advisory — a check
    // followed by a write can interleave; a create cannot.
    create: jest.fn(async (val: Record<string, unknown>) => {
      if ((docStore[path]?.data ?? null) !== null) {
        const err = new Error(`ALREADY_EXISTS: ${path}`) as Error & { code: number };
        err.code = 6;
        throw err;
      }
      applyWrite(path, val);
    }),
  };
}

/**
 * W2-134 retired the `items` collection read, so purchaseChest must make NO
 * collection() call at all. This is a guard, not a stub: it is the assertion
 * that the third mirror stays retired.
 *
 * KEY: It fails LOUDLY rather than returning an empty result. An empty-result
 * stub would let a reintroduced `.collection('items')` read pass silently —
 * the query would return nothing, the SEED_ITEMS fallback would run, every
 * test would stay green, and the round-trip this brief deleted would be back
 * in the hot path with nothing to notice it.
 */
function collectionMock(name: string): any {
  throw new Error(
    `purchaseChest read collection('${name}'). The \`items\` mirror was retired ` +
      'in W2-134 (production count: 0 documents) — SEED_ITEMS is the only source. ' +
      'If this is a deliberate new read, it needs its own brief.',
  );
}

const _db = {
  doc: jest.fn((p: string) => docMock(p)),
  collection: jest.fn((n: string) => collectionMock(n)),
  runTransaction: jest.fn(),
  /**
   * Admin SDK `getAll` — one round trip for many documents.
   *
   * Added for W2-161: the ownership-biased draw reads every candidate in the
   * (subject, rarity) cell before picking, and does it as a single `getAll`
   * rather than a `get` per item. Note this is still a DOCUMENT read, so
   * `collectionMock` above stays armed — the `items` mirror is retired and this
   * did not bring a collection query back.
   */
  getAll: jest.fn(async (...refs: any[]) => Promise.all(refs.map((r) => r.get()))),
};

jest.mock('firebase-admin', () => {
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = {
    increment: (n: number) => ({ _type: 'increment', n }),
    arrayUnion: (...values: unknown[]) => ({ _type: 'arrayUnion', values }),
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

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { purchaseChest } = require('../index') as {
  purchaseChest: { _handler: (req: any) => Promise<any> };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {
  SEED_ITEMS,
  DROP_TABLES,
  rollRarity,
  RARITIES: ITEM_RARITIES,
} = require('../itemPool');

function seedDoc(path: string, data: Record<string, unknown> | null) {
  docStore[path] = { data };
}

function realisticTransaction() {
  _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
    const tx = {
      get: (ref: any) => ref.get(),
      set: (ref: any, val: any, opts: any) => ref.set(val, opts),
      // `create`, not `set`: the replay ledger's whole value is that a second
      // write to the same id FAILS. Routing it to `set` here would have made
      // the replay test pass against a guard that does nothing.
      create: (ref: any, val: any) => ref.create(val),
    };
    return fn(tx);
  });
}

/**
 * A transaction that actually contends.
 *
 * `realisticTransaction` runs the body straight through and applies writes as
 * they are issued, so two overlapping calls never conflict — under it, two
 * concurrent purchases would both "succeed" no matter what the callable does.
 * This variant models the two properties that make a Firestore transaction a
 * transaction:
 *
 *   1. Writes are BUFFERED and applied only at commit, so a half-finished
 *      body is never visible to the other call.
 *   2. Commit FAILS and the body re-runs if any document the body READ has
 *      been written since it was read (optimistic locking), bounded by a
 *      retry limit so a livelock surfaces as a failure rather than a hang.
 *
 * Errors thrown by the body (HttpsError) propagate immediately and are not
 * retried — a `failed-precondition` is an answer, not a conflict.
 */
function contendedTransaction(maxAttempts = 5) {
  _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const readVersions: Record<string, number> = {};
      const writes: Array<() => Promise<void>> = [];
      const tx = {
        get: async (ref: any) => {
          readVersions[ref.path] = docVersions[ref.path] ?? 0;
          return ref.get();
        },
        set: (ref: any, val: any, opts: any) => {
          writes.push(() => ref.set(val, opts));
        },
        create: (ref: any, val: any) => {
          writes.push(() => ref.create(val));
        },
      };
      const result = await fn(tx);

      const conflicted = Object.entries(readVersions).some(
        ([path, v]) => (docVersions[path] ?? 0) !== v,
      );
      if (conflicted) continue;

      for (const w of writes) await w();
      return result;
    }
    throw new Error(`transaction exceeded ${maxAttempts} attempts`);
  });
}

/** The rotation as production actually holds it (observed 2026-08-05). */
function seedShopRotation() {
  seedDoc('shop/current', {
    dailyChests: [
      { id: 'chest_common_20260805', rarity: 'common', price: 100, name: 'Character' },
    ],
  });
}

const call = (data: any, uid?: string) =>
  purchaseChest._handler({ auth: uid ? { uid } : null, data });

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  realisticTransaction();
  seedShopRotation();
  seedDoc('users/uid-a/profile/data', { spongeBalance: 1000 });
});

// ---------------------------------------------------------------------------
// The production case: `items` is empty
// ---------------------------------------------------------------------------

describe('purchaseChest with an unseeded `items` collection', () => {
  test('still grants an item instead of throwing not-found', async () => {
    const res = await call({ chestId: 'chest_common_20260805' }, 'uid-a');

    expect(res.granted).toBe(true);
    expect(res.items).toHaveLength(1);
    const drop = res.items[0];
    // The response is fully populated — not a bare id with blank fields, which
    // would render as an untitled, artless tile in the album.
    expect(typeof drop.itemId).toBe('string');
    expect(drop.itemId.length).toBeGreaterThan(0);
    expect(drop.name.length).toBeGreaterThan(0);
    expect(ITEM_RARITIES).toContain(drop.rarity);
    expect(['style', 'furniture', 'character']).toContain(drop.type);
  });

  test('writes the granted item to inventory and charges the chest price', async () => {
    const res = await call({ chestId: 'chest_common_20260805' }, 'uid-a');
    const itemId = res.items[0].itemId;

    // The inventory write is the data path — assert on where the id LANDED,
    // not on the pool it came from.
    expect(docStore[`users/uid-a/inventory/${itemId}`]?.data).toMatchObject({
      itemId,
      equipped: false,
    });
    expect(docStore['users/uid-a/profile/data']?.data?.spongeBalance).toBe(900);
  });

  test('the duplicate path refunds and does not re-grant', async () => {
    // Own every bundled item, so whatever is rolled is already a duplicate.
    for (const item of SEED_ITEMS) {
      seedDoc(`users/uid-a/inventory/${item.id}`, { itemId: item.id, equipped: true });
    }

    const res = await call({ chestId: 'chest_common_20260805' }, 'uid-a');

    expect(res.granted).toBe(false);
    expect(res.duplicateRefund).toBeGreaterThan(0);
    expect(docStore['users/uid-a/profile/data']?.data?.spongeBalance).toBe(
      1000 - (100 - res.duplicateRefund),
    );
    // The pre-existing equipped state survives — nothing was re-written.
    const owned = docStore[`users/uid-a/inventory/${res.items[0].itemId}`]?.data;
    expect(owned?.equipped).toBe(true);
  });

  test('the balance gate still holds on a bundled pick', async () => {
    seedDoc('users/uid-a/profile/data', { spongeBalance: 10 });

    await expect(call({ chestId: 'chest_common_20260805' }, 'uid-a')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(Object.keys(docStore).filter((k) => k.includes('/inventory/'))).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // W2-08 — the daily cap is gone
  //
  // The cap was `purchased.includes(chestId)` against `dailyChestsPurchased`,
  // an array of DATE-STAMPED chest ids: one purchase per chest id per day, so
  // three chests a day meant three purchases a day. It inverted here — the
  // test this block replaced asserted the second purchase was rejected.
  // -------------------------------------------------------------------------

  test('the same chest can be bought twice in one day and both grant', async () => {
    const first = await call({ chestId: 'chest_common_20260805' }, 'uid-a');
    const second = await call({ chestId: 'chest_common_20260805' }, 'uid-a');

    expect(first.granted).toBe(true);
    // `granted` is false only for a DUPLICATE ITEM, which is a different axis
    // from a repeat PURCHASE. Assert the purchase completed, not the roll.
    expect(second.items).toHaveLength(1);
    expect(second.items[0].itemId.length).toBeGreaterThan(0);
  });

  test('a repeat purchase is charged again — removing the cap is not removing the price', async () => {
    await call({ chestId: 'chest_common_20260805' }, 'uid-a');
    const second = await call({ chestId: 'chest_common_20260805' }, 'uid-a');

    // 100 twice, less whatever the duplicate path refunded on each.
    const spent = 1000 - (docStore['users/uid-a/profile/data']?.data?.spongeBalance as number);
    expect(spent).toBeGreaterThan(100);
    expect(spent).toBe(200 - second.duplicateRefund);
  });

  test('dailyChestsPurchased is never written, so the client card cannot grey out', async () => {
    // KEY: This is the assertion that makes the change VISIBLE. The client reads
    // this very array (daily_market_grid.dart -> ChestCard.isPurchased) and
    // disables the card on it. Dropping the server guard while still writing
    // the field would have left the button grey and delivered nothing.
    await call({ chestId: 'chest_common_20260805' }, 'uid-a');

    const shopState = docStore['users/uid-a/shop/data']?.data ?? {};
    expect(shopState.dailyChestsPurchased).toBeUndefined();
  });

  test('an insufficient balance still fails after the cap is gone', async () => {
    // The affordability gate and the cap were adjacent reads on the same
    // document. Pinned separately so removing one can never take the other.
    seedDoc('users/uid-a/profile/data', { spongeBalance: 150 });

    await call({ chestId: 'chest_common_20260805' }, 'uid-a');
    await expect(call({ chestId: 'chest_common_20260805' }, 'uid-a')).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });

  test('buying repeatedly never hits an empty (subject, rarity) cell', async () => {
    // The bundled pool's coverage is guarded at build time in
    // dailyRotation.test.ts ("every subject a chest can be themed on is
    // stocked at EVERY rarity"), which is independent of purchase volume. This
    // is the live counterpart: with the cap gone one uid exercises the drop
    // table far harder than three purchases a day ever did, and a not-found is
    // a hard failure on a chest the player can see and afford.
    seedDoc('users/uid-a/profile/data', { spongeBalance: 100000 });
    seedDoc('shop/current', {
      dailyChests: [
        {
          id: 'chest_hammer',
          category: 'characters',
          rarity: 'legendary',
          dropTable: 'rich',
          subject: 'character',
          price: 100,
          name: 'Character',
        },
      ],
    });

    const granted: string[] = [];
    for (let i = 0; i < 60; i++) {
      const res = await call({ chestId: 'chest_hammer' }, 'uid-a');
      granted.push(res.items[0].itemId);
    }

    expect(granted).toHaveLength(60);
    // The roll must actually have moved across the table, or 60 identical
    // draws would pass this without exercising anything.
    expect(new Set(granted).size).toBeGreaterThan(1);
  });
});

// ---------------------------------------------------------------------------
// W2-08 — what the cap was ALSO doing
//
// KEY: `dailyChestsPurchased` was the cap AND the only replay guard in the
// callable: one field, two jobs, the same shape `chest.rarity` had before #88.
// Deleting it deletes both, so the replay half is replaced rather than
// dropped — an OPTIONAL `purchaseId`, so the shipped client keeps working and
// no coordinated release is needed.
// ---------------------------------------------------------------------------

describe('replay protection via purchaseId', () => {
  test('a retried call with the same purchaseId is rejected and charges nothing', async () => {
    const first = await call(
      { chestId: 'chest_common_20260805', purchaseId: 'tap-1' },
      'uid-a',
    );
    const balanceAfterFirst = docStore['users/uid-a/profile/data']?.data?.spongeBalance;

    await expect(
      call({ chestId: 'chest_common_20260805', purchaseId: 'tap-1' }, 'uid-a'),
    ).rejects.toMatchObject({ code: 'already-exists' });

    // The debit is the thing a replay must not repeat.
    expect(docStore['users/uid-a/profile/data']?.data?.spongeBalance).toBe(balanceAfterFirst);
    expect(first.items).toHaveLength(1);
  });

  test('two DIFFERENT purchaseIds are two purchases, not a replay', async () => {
    await call({ chestId: 'chest_common_20260805', purchaseId: 'tap-1' }, 'uid-a');
    const second = await call(
      { chestId: 'chest_common_20260805', purchaseId: 'tap-2' },
      'uid-a',
    );

    expect(second.items).toHaveLength(1);
    const spent = 1000 - (docStore['users/uid-a/profile/data']?.data?.spongeBalance as number);
    expect(spent).toBe(200 - second.duplicateRefund);
  });

  test('the ledger entry is written under the caller uid', async () => {
    await call({ chestId: 'chest_common_20260805', purchaseId: 'tap-1' }, 'uid-a');
    expect(docStore['users/uid-a/chestPurchases/tap-1']?.data).toBeTruthy();
    // A different user's identical id is a different key — one player's tap
    // must never block another's.
    seedDoc('users/uid-b/profile/data', { spongeBalance: 1000 });
    await call({ chestId: 'chest_common_20260805', purchaseId: 'tap-1' }, 'uid-b');
    expect(docStore['users/uid-b/chestPurchases/tap-1']?.data).toBeTruthy();
  });

  test('omitting purchaseId keeps the pre-W2-08 contract — the shipped client still works', async () => {
    // The client sends only { chestId } today. If a missing id threw, this
    // deploy would break every purchase until a coordinated app release.
    await call({ chestId: 'chest_common_20260805' }, 'uid-a');
    const res = await call({ chestId: 'chest_common_20260805' }, 'uid-a');
    expect(res.items).toHaveLength(1);
  });

  test('a malformed purchaseId is rejected before anything is charged', async () => {
    for (const bad of [42, '', 'a/b', 'x'.repeat(200)]) {
      await expect(
        call({ chestId: 'chest_common_20260805', purchaseId: bad }, 'uid-a'),
      ).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect(docStore['users/uid-a/profile/data']?.data?.spongeBalance).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// W2-08 — concurrency
//
// WARNING: Removing a uniqueness guard must not turn one transaction into a race.
// The per-chest guard was NOT what serialised two purchases — the balance read
// is — but that had never been asserted, so it was a belief rather than a
// fact. `contendedTransaction()` models Firestore's optimistic locking so it
// can be.
// ---------------------------------------------------------------------------

describe('two concurrent purchases cannot both pass one affordability check', () => {
  beforeEach(() => {
    contendedTransaction();
  });

  test('a balance that funds ONE purchase funds exactly one', async () => {
    seedDoc('users/uid-a/profile/data', { spongeBalance: 150 });

    const results = await Promise.allSettled([
      call({ chestId: 'chest_common_20260805' }, 'uid-a'),
      call({ chestId: 'chest_common_20260805' }, 'uid-a'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'failed-precondition',
    });

    // The number that matters: 50, never -50.
    const balance = docStore['users/uid-a/profile/data']?.data?.spongeBalance as number;
    expect(balance).toBeGreaterThanOrEqual(0);
    expect(balance).toBe(150 - (100 - ((fulfilled[0] as PromiseFulfilledResult<any>).value.duplicateRefund)));
  });

  test('a balance that funds BOTH is debited twice, not once', async () => {
    // The mirror image: serialisation must not silently drop a purchase the
    // player paid for. A retry that re-ran the body but skipped the write
    // would pass the test above and fail this one.
    seedDoc('users/uid-a/profile/data', { spongeBalance: 1000 });

    const results = await Promise.all([
      call({ chestId: 'chest_common_20260805' }, 'uid-a'),
      call({ chestId: 'chest_common_20260805' }, 'uid-a'),
    ]);

    const refunded = results.reduce((sum, r) => sum + r.duplicateRefund, 0);
    expect(docStore['users/uid-a/profile/data']?.data?.spongeBalance).toBe(
      1000 - 200 + refunded,
    );
  });

  test('a concurrent replay of one purchaseId still grants exactly once', async () => {
    seedDoc('users/uid-a/profile/data', { spongeBalance: 1000 });

    const results = await Promise.allSettled([
      call({ chestId: 'chest_common_20260805', purchaseId: 'tap-1' }, 'uid-a'),
      call({ chestId: 'chest_common_20260805', purchaseId: 'tap-1' }, 'uid-a'),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const fulfilled = results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<any>;
    expect(docStore['users/uid-a/profile/data']?.data?.spongeBalance).toBe(
      1000 - (100 - fulfilled.value.duplicateRefund),
    );
  });
});

// ---------------------------------------------------------------------------
// Firestore keeps precedence
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Build-time guard on the bundled pool — the one place a constant is the
// correct assertion target. Mirrors welcomeChestPool.test.ts.
// ---------------------------------------------------------------------------

describe('the `items` mirror is retired — W2-134', () => {
  // CRITICAL: WHY A TEST AND NOT JUST THE THROWING MOCK. The mock fails any test that
  // triggers a read, which protects the tests that happen to buy a chest. It
  // cannot state the INTENT: someone reading this file needs to find the
  // sentence "purchaseChest performs zero collection reads", not infer it from
  // a helper that throws.
  //
  // Measured before anything was deleted: the production `items` collection
  // held 0 documents — COUNT aggregation http 200, and an independent document
  // list http 200 returning 0 with no further pages, read as the account that
  // owns the project. The Firestore branch had never been taken in production.

  test('a purchase performs no collection() read at all', async () => {
    const res = await call({ chestId: 'chest_common_20260805' }, 'uid-a');

    expect(_db.collection).not.toHaveBeenCalled();
    // And it still granted something. A purchase that THREW would also have
    // made no read, and would satisfy the assertion above for the wrong reason.
    expect(SEED_ITEMS.some((i: { id: string }) => i.id === res.items[0].itemId)).toBe(true);
  });

  test('every granted id comes from the bundle, over many draws', async () => {
    // The decisive property once the collection is gone: there is no other
    // source, so an id that is not a SEED_ITEMS id cannot come from anywhere.
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const uid = `uid-b${i}`;
      seedDoc(`users/${uid}/profile/data`, { spongeBalance: 1000 });
      const res = await call({ chestId: 'chest_common_20260805' }, uid);
      ids.push(res.items[0].itemId);
    }
    const strangers = ids.filter(
      (id) => !SEED_ITEMS.some((s: { id: string }) => s.id === id),
    );
    expect(`ids not in SEED_ITEMS: ${JSON.stringify(strangers)}`).toBe(
      'ids not in SEED_ITEMS: []',
    );
    // The draw must actually move, or one frozen roll would pass this trivially.
    expect(new Set(ids).size).toBeGreaterThan(1);
  });
});

describe('the bundled pool covers every rarity purchaseChest can roll', () => {
  test('every rarity rollRarity can emit has at least one SEED_ITEMS entry', () => {
    const emitted = new Set<string>();
    for (const chestRarity of Object.keys(DROP_TABLES)) {
      for (let i = 0; i < 2000; i++) emitted.add(rollRarity(chestRarity));
    }
    // Sanity: the roll actually reaches the tail, or the loop proves nothing.
    expect(emitted.has('legendary')).toBe(true);

    for (const rarity of emitted) {
      const pool = SEED_ITEMS.filter((i: any) => i.rarity === rarity);
      expect(pool.length).toBeGreaterThan(0);
    }
  });

  test('an unknown chest rarity falls back to the common table, which is covered', () => {
    // rollRarity defaults to DROP_TABLES['common'] for an unrecognised chest,
    // so a rotation writing a novel rarity cannot dead-end the fallback.
    const emitted = new Set<string>();
    for (let i = 0; i < 2000; i++) emitted.add(rollRarity('no_such_rarity'));
    for (const rarity of emitted) {
      expect(SEED_ITEMS.filter((i: any) => i.rarity === rarity).length).toBeGreaterThan(0);
    }
  });

  test('every bundled item carries the fields the drop payload needs', () => {
    for (const item of SEED_ITEMS) {
      expect(typeof item.id).toBe('string');
      expect(item.id.length).toBeGreaterThan(0);
      expect(typeof item.name).toBe('string');
      expect(item.name.length).toBeGreaterThan(0);
      expect(typeof item.type).toBe('string');
      expect(typeof item.rarity).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// Themed rotation (W3-08)
//
// A chest is themed on ONE subject per day. Before W3-08 pickChestItem
// filtered on rarity alone, so a Character chest could — and at these odds
// regularly would — grant a sofa. These assert on the payload handed to the
// inventory write, never on SEED_ITEMS.
// ---------------------------------------------------------------------------

describe('a themed chest only ever grants items of its own subject', () => {
  /** A chest row in the post-W3-08 shape. */
  function seedThemedChest(opts: {
    id: string;
    category: string;
    dropTable: string;
    subject: string;
  }) {
    seedDoc('shop/current', {
      dailyChests: [
        {
          id: opts.id,
          category: opts.category,
          rarity: 'common',
          dropTable: opts.dropTable,
          subject: opts.subject,
          price: 100,
          name: 'Themed',
        },
      ],
    });
  }

  /**
   * The two real furniture subjects this suite draws against.
   *
 * KEY: These used to be synthetic ids ('wanted'/'unwanted') seeded into a fake
   * `items` collection. W2-134 retired that read, so a synthetic subject now
   * matches nothing in SEED_ITEMS and `pickChestItem` throws not-found instead
   * of exercising the property. Real subjects are what make these tests
   * reachable at all — and the furniture pool only HAS a second and third
   * subject because W2-130 unbenched armchair and tv_stand, so an off-subject
   * leak has somewhere to leak TO. With a one-subject pool this assertion
   * could not have failed.
   */
  const WANTED_SUBJECT = 'sofa';
  const OFF_SUBJECT_PREFIXES = ['furn_armchair_', 'furn_tv_stand_'];

  test('over many purchases, not one off-subject item is ever granted', async () => {
    // Many uids rather than many calls for one uid. That used to be forced —
    // dailyChestsPurchased blocked a repeat purchase — and since W2-08 it is
    // merely kept, because a fresh uid also proves the leak is not a function
    // of accumulated inventory. 40 draws across the `rich` table exercises all
    // three rarities with margin — a subject leak would have to survive every
    // one of them to pass.
    const granted: string[] = [];
    for (let i = 0; i < 40; i++) {
      const uid = `uid-t${i}`;
      seedDoc(`users/${uid}/profile/data`, { spongeBalance: 1000 });
      seedThemedChest({
        id: 'chest_themed',
        category: 'furniture',
        dropTable: 'rich',
        subject: WANTED_SUBJECT,
      });
      const res = await call({ chestId: 'chest_themed' }, uid);
      granted.push(res.items[0].itemId);
    }

    // The sibling subjects share this chest's category and type, so nothing but
    // the subject filter separates them — which is the point.
    expect(
      granted.filter((id) => OFF_SUBJECT_PREFIXES.some((p) => id.startsWith(p))),
    ).toEqual([]);
    // The draw must actually have moved, or a frozen roll would pass trivially.
    expect(new Set(granted).size).toBeGreaterThan(1);
  });

  test('the subject filter reaches the bundled fallback too, not just Firestore', async () => {
    // `items` stays empty, so every draw comes from SEED_ITEMS. A characters
    // chest must never hand over furniture or a style.
    const granted: string[] = [];
    for (let i = 0; i < 30; i++) {
      const uid = `uid-c${i}`;
      seedDoc(`users/${uid}/profile/data`, { spongeBalance: 1000 });
      seedThemedChest({
        id: 'chest_chars',
        category: 'characters',
        dropTable: 'rich',
        subject: 'character',
      });
      const res = await call({ chestId: 'chest_chars' }, uid);
      granted.push(res.items[0].itemId);
    }
    expect(granted.every((id) => id.startsWith('char_'))).toBe(true);
    expect(new Set(granted).size).toBeGreaterThan(1);
  });

  test('a rotation that changes the drop table mid-flight aborts the purchase', async () => {
    // FIX #3b, re-pointed at the field that actually drives the roll. The
    // guard used to compare `rarity`, which is now display-only — so a
    // rotation swapping the table while leaving the display tier alone would
    // have charged the new price for a roll made at the old odds.
    seedThemedChest({
      id: 'chest_swap',
      category: 'furniture',
      dropTable: 'lean',
      subject: WANTED_SUBJECT,
    });

    // Flip the table between pre-flight and the transaction. Re-seeding inside
    // the runTransaction mock is exactly the race: pickChestItem has already
    // rolled against `lean`, and the in-tx re-read now sees `rich`.
    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      seedThemedChest({
        id: 'chest_swap',
        category: 'furniture',
        dropTable: 'rich',
        subject: WANTED_SUBJECT,
      });
      const tx = {
        get: (ref: any) => ref.get(),
        set: (ref: any, val: any, opts: any) => ref.set(val, opts),
        create: (ref: any, val: any) => ref.set(val),
      };
      return fn(tx);
    });

    await expect(call({ chestId: 'chest_swap' }, 'uid-a')).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(Object.keys(docStore).filter((k) => k.includes('/inventory/'))).toHaveLength(0);
  });

  test('a rotation that changes the day\'s subject mid-flight aborts the purchase', async () => {
    seedThemedChest({
      id: 'chest_swap2',
      category: 'furniture',
      dropTable: 'lean',
      subject: WANTED_SUBJECT,
    });

    _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
      seedThemedChest({
        id: 'chest_swap2',
        category: 'furniture',
        dropTable: 'lean',
        subject: 'armchair',
      });
      const tx = {
        get: (ref: any) => ref.get(),
        set: (ref: any, val: any, opts: any) => ref.set(val, opts),
        create: (ref: any, val: any) => ref.set(val),
      };
      return fn(tx);
    });

    await expect(call({ chestId: 'chest_swap2' }, 'uid-a')).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(Object.keys(docStore).filter((k) => k.includes('/inventory/'))).toHaveLength(0);
  });
});
