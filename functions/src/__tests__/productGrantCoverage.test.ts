// functions/src/__tests__/productGrantCoverage.test.ts
//
// W2-158. EVERY product id a player can buy must actually GRANT something, and
// the proof has to run the real verifier.
//
// ---------------------------------------------------------------------------
// 🔴 WHY THIS FILE EXISTS: THE THING NOBODY HAD MEASURED WAS COVERAGE
// ---------------------------------------------------------------------------
//
// `appleJws.ts` verifies StoreKit 2 transactions offline against the Apple root
// certificates embedded in `appleRootCerts.ts` — that path is built, covered by
// `appleJws.test.ts`, and is NOT what this file re-tests.
// `productRegistry.test.ts` proves every id the backend BELIEVES in is
// registered somewhere it can be bought. Between them sat an unmeasured gap:
// nothing anywhere asserted that a signed transaction for a given product id,
// pushed through the verifier the callables actually call, ends with that
// product's entitlement written to Firestore.
//
// 🔑 A PURCHASE THAT VERIFIES AND DOES NOT GRANT IS INDISTINGUISHABLE, FROM
// EVERY GATE THIS REPO HAD, FROM ONE THAT WORKS. The client sees success. The
// ledger doc is written. `processedReceipts` fills up. Only the entitlement is
// missing, and no test read it per product.
//
// ---------------------------------------------------------------------------
// THE REAL VERIFIER, NOT A STUB — AND THE ONE INPUT THAT CHANGES
// ---------------------------------------------------------------------------
//
// ⚠️ Every other callable test replaces `appleJws.verify` with a function that
// returns a canned object. That is correct for THOSE tests — they are about the
// ledger and the account boundary, not about Apple — but it means the string
// the client sends has never been parsed on the way into a grant.
//
// Here `appleJws.verify` is replaced with `makeVerify([chain.rootDer],
// BUNDLE_ID)`: the SHIPPED verifier, constructed with a test trust anchor
// instead of Apple's roots. The JWS is really signed, the x5c chain is really
// walked, the Apple extension OIDs are really required, the environment retry
// really runs, and `normaliseTransaction` really maps the payload. One input
// differs from production — which certificates are trusted — and nothing else.
//
// ---------------------------------------------------------------------------
// 🔑 THE EXPECTED VALUES ARE HARD-CODED, AND THAT IS THE OPPOSITE OF THE USUAL
// "NEVER RETYPE A CONSTANT" RULE. IT IS DELIBERATE.
// ---------------------------------------------------------------------------
//
// `productRegistry.test.ts` derives its believed set from the code because it
// is asking "do these two lists agree". This file is asking "did the grant
// happen", and an expectation READ FROM the table under test cannot fail:
// deleting `sponge_pack_550: 550` from `SPONGE_PACKS` would delete it from a
// derived expectation too, and the assertion would pass over a product that
// grants nothing. So the numbers below are typed out, on purpose, and the
// COMPLETENESS of the id set — the part that must never be retyped — is what
// gets derived, from `ios/Configuration.storekit`.

// ---------------------------------------------------------------------------
// Path-keyed Firestore mock (declared before imports — Jest hoists the factory)
//
// 📌 The same fake as verifyIapAndGrant.test.ts, kept local rather than shared:
// it is a fixture, and a fixture two suites can change out from under each
// other is how a control stops controlling.
// ---------------------------------------------------------------------------

interface DocState {
  data: Record<string, unknown> | null;
}
const docStore: Record<string, DocState> = {};

function resetStore() {
  for (const k of Object.keys(docStore)) delete docStore[k];
}

function docMock(path: string) {
  return {
    path,
    get: jest.fn(async () => {
      const st = docStore[path] ?? {data: null};
      return {
        exists: st.data !== null,
        data: () => st.data,
        id: path.split('/').pop(),
      };
    }),
    set: jest.fn(
      async (val: Record<string, unknown>, opts?: {merge?: boolean}) => {
        const st = docStore[path] ?? (docStore[path] = {data: null});
        st.data = opts?.merge ? {...(st.data ?? {}), ...val} : {...val};
      },
    ),
    update: jest.fn(async (val: Record<string, unknown>) => {
      const st = docStore[path];
      if (!st || st.data === null) {
        throw new Error(`update on a missing document: ${path}`);
      }
      st.data = {...st.data, ...val};
    }),
    delete: jest.fn(async () => {
      delete docStore[path];
    }),
  };
}

/**
 * The `families` collection query, served from `docStore`.
 *
 * 🔴 ADDED FOR W2-163, AND IT RETURNS REAL ROWS RATHER THAN AN EMPTY STUB.
 * `verifySubscriptionReceipt` now asks which family the buyer owns, so it reads
 * `families where ownerUid == uid limit 1`. `collection` was a bare `jest.fn()`
 * returning `undefined`, which crashed on `.where`.
 *
 * ⚠️ An empty-result stub would have been the cheap fix and the wrong one: every
 * test here would go green, and they would go green for a subscriber who owns no
 * family — which is every fixture in this file — so the fan-out could break
 * completely without any of them noticing. Serving the real store means a test
 * that seeds a family sees the fan-out, and one that seeds none sees nothing,
 * and the difference is visible.
 */
function familiesQuery(): any {
  const filters: Array<[string, unknown]> = [];
  let cap = Infinity;
  const q: any = {
    where: (field: string, op: string, value: unknown) => {
      if (op !== '==') throw new Error(`families query: unsupported operator ${op}`);
      filters.push([field, value]);
      return q;
    },
    limit: (n: number) => {
      cap = n;
      return q;
    },
    get: async () => {
      const docs = Object.entries(docStore)
        .filter(([path, st]) => path.startsWith('families/') && st.data !== null)
        .filter(([, st]) =>
          filters.every(([field, value]) => (st.data as any)?.[field] === value),
        )
        .slice(0, cap)
        .map(([path, st]) => ({
          id: path.split('/').pop(),
          data: () => st.data,
        }));
      return {docs, empty: docs.length === 0};
    },
  };
  return q;
}

const _db = {
  doc: jest.fn((p: string) => docMock(p)),
  collection: jest.fn((name: string) => {
    if (name === 'families') return familiesQuery();
    // Loud rather than empty: an unexpected collection read is a new dependency
    // this file has not decided about, and a stub returning nothing would hide it.
    throw new Error(`productGrantCoverage: unexpected collection('${name}')`);
  }),
  runTransaction: jest.fn(),
};

jest.mock('firebase-admin', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = {
    increment: (n: number) => ({_type: 'increment', n}),
  };
  const stamp = (ms: number) => ({_type: 'ts', ms, toMillis: () => ms});
  firestoreFn.Timestamp = {
    now: () => stamp(0),
    fromDate: (d: Date) => stamp(d.getTime()),
    fromMillis: (ms: number) => stamp(ms),
  };
  return {
    initializeApp: jest.fn(),
    firestore: firestoreFn,
    messaging: jest.fn(() => ({
      sendEach: jest.fn(async () => ({
        responses: [],
        successCount: 0,
        failureCount: 0,
      })),
    })),
  };
});

jest.mock('firebase-admin/firestore', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = jest.requireMock('firebase-admin') as any;
  return {
    FieldValue: admin.firestore.FieldValue,
    Timestamp: admin.firestore.Timestamp,
  };
});

jest.mock('firebase-functions/v2/https', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onCall: (...args: any[]) => ({_handler: args[args.length - 1]}),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onSchedule: (_s: string, handler: () => any) => ({_handler: handler}),
}));

// ---------------------------------------------------------------------------
// Imports after mocks
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {verifyIapAndGrant, verifySubscriptionReceipt} = require('../index') as {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verifyIapAndGrant: {_handler: (req: any) => Promise<any>};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verifySubscriptionReceipt: {_handler: (req: any) => Promise<any>};
};

import * as fs from 'fs';
import * as path from 'path';

import {appleJws, makeVerify, BUNDLE_ID} from '../appleJws';
import {assertPricedSubscriptions} from '../proReceipt';
import {accountTokenRollout, purchaseTokenForUid} from '../purchaseAccountToken';
import {WEEKLY_OFFERS} from '../weeklyOffers';
import {buildChain, signTransactionJws} from './helpers/appleChain';

const REPO = path.resolve(__dirname, '../../..');

const UID = 'buyer-uid';
const NOW = Date.UTC(2026, 7, 29);
const THIRTY_DAYS_MS = 30 * 24 * 3600 * 1000;

// ---------------------------------------------------------------------------
// The registry — parsed, never retyped
// ---------------------------------------------------------------------------

interface Registry {
  consumables: string[];
  subscriptions: string[];
  all: string[];
}

/**
 * Every product id the simulator can serve, split by the section it lives in.
 *
 * 📌 `ios/Configuration.storekit` is a proxy for App Store Connect, not a copy
 * of it — the same source and the same caveat as `productRegistry.test.ts`,
 * which is the file that established it as the one machine-readable registry
 * this repo has. Read-only here; `ios/**` belongs to W4.
 */
function readRegistry(): Registry {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(REPO, 'ios', 'Configuration.storekit'), 'utf8'),
  ) as {
    products: {productID: string}[];
    subscriptionGroups: {subscriptions: {productID: string}[]}[];
  };
  const consumables = cfg.products.map((p) => p.productID);
  const subscriptions = cfg.subscriptionGroups.flatMap((g) =>
    g.subscriptions.map((s) => s.productID),
  );
  return {consumables, subscriptions, all: [...consumables, ...subscriptions]};
}

const REGISTRY = readRegistry();

// ---------------------------------------------------------------------------
// What each product is supposed to grant
// ---------------------------------------------------------------------------

type GrantCase =
  | {
      kind: 'sponges';
      /** Typed out on purpose — see the header. */
      sponges: number;
    }
  | {kind: 'offer'; sponges: number; items: string[]}
  | {kind: 'subscription'; tier: string};

/**
 * The expectation table.
 *
 * 🔴 ITS KEYS ARE CHECKED AGAINST THE REGISTRY, WHICH IS THE HALF THAT MAKES IT
 * A COVERAGE GATE RATHER THAN A LIST OF TESTS SOMEBODY FELT LIKE WRITING. Add a
 * product to `ios/Configuration.storekit` and this file goes red until somebody
 * says what that product grants. That red is the feature.
 */
const EXPECTED: Record<string, GrantCase> = {
  sponge_pack_100: {kind: 'sponges', sponges: 100},
  sponge_pack_550: {kind: 'sponges', sponges: 550},
  sponge_pack_1200: {kind: 'sponges', sponges: 1200},
  PremiumOffer_3: {
    kind: 'offer',
    sponges: 500,
    items: ['style_roof_tile_gold', 'char_gardener'],
  },
  sub_pro_monthly: {kind: 'subscription', tier: 'pro'},
  sub_pro_annual: {kind: 'subscription', tier: 'pro'},
  sub_family_monthly: {kind: 'subscription', tier: 'pro'},
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const CHAIN = buildChain();

function jwsFor(overrides: Record<string, unknown>): string {
  return signTransactionJws(
    {
      bundleId: BUNDLE_ID,
      environment: 'Sandbox',
      purchaseDate: NOW,
      signedDate: NOW,
      inAppOwnershipType: 'PURCHASED',
      // Apple stamps this from the client's `appAccountToken`; the server
      // recomputes it from the authenticated uid and refuses a mismatch. Real,
      // not skipped — otherwise the account boundary is untested here too.
      appAccountToken: purchaseTokenForUid(UID),
      ...overrides,
    },
    CHAIN,
  );
}

function realisticTransaction() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  _db.runTransaction.mockImplementation(async (fn: (tx: any) => any) => {
    const tx = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      get: (ref: any) => ref.get(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set: (ref: any, val: any, opts: any) => ref.set(val, opts),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: (ref: any, val: any) => ref.set(val),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: (ref: any, val: any) => ref.update(val),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete: (ref: any) => ref.delete(),
    };
    return fn(tx);
  });
}

/** The live weekly offer, seeded from the real config it ships with. */
function seedWeeklyOffer(productId: string) {
  const offer = WEEKLY_OFFERS.find((o) => o.iapProductId === productId);
  if (!offer) throw new Error(`no WEEKLY_OFFERS entry for ${productId}`);
  docStore['shop/current'] = {data: {weeklyOffer: {...offer}}};
}

beforeAll(() => {
  // 🔴 THE REAL VERIFIER. Everything downstream of this line parses a genuine
  // signed JWS. Module state, but jest gives each test file its own registry,
  // so nothing leaks into the suites that legitimately stub this seam.
  appleJws.verify = makeVerify([CHAIN.rootDer], BUNDLE_ID);
});

beforeEach(() => {
  jest.clearAllMocks();
  resetStore();
  realisticTransaction();
  accountTokenRollout.epochMs = null;
});

// ---------------------------------------------------------------------------
// Anti-vacuity — the half that is usually skipped
// ---------------------------------------------------------------------------

describe('🔑 ANTI-VACUITY — this file cannot pass by finding nothing', () => {
  test('the registry parses to the seven products that are actually sold', () => {
    // A parse that returned `[]` would satisfy every "for each product" loop
    // below by running zero of them, and the suite would go green having
    // asserted nothing at all. This is the pin that makes that impossible, and
    // it names the ids so a silent rename is a red rather than a smaller set.
    expect([...REGISTRY.all].sort()).toEqual(
      [
        'PremiumOffer_3',
        'sponge_pack_100',
        'sponge_pack_1200',
        'sponge_pack_550',
        'sub_family_monthly',
        'sub_pro_annual',
        'sub_pro_monthly',
      ].sort(),
    );
  });

  test('🔴 every registered product has a stated grant, and vice versa', () => {
    // The coverage assertion itself. A product added to Configuration.storekit
    // with no entry in EXPECTED fails HERE, naming the id, rather than being
    // quietly skipped by a loop that iterates EXPECTED instead of the registry.
    expect([...Object.keys(EXPECTED)].sort()).toEqual([...REGISTRY.all].sort());
  });

  test('the signing chain really signs — a JWS is produced and is not the payload', () => {
    // If `buildChain` ever degraded to returning something inert, every grant
    // test below would fail at verification rather than pass vacuously — but
    // this says so directly instead of leaving it to be inferred from a wall of
    // unrelated reds.
    const jws = jwsFor({transactionId: 't', productId: 'sponge_pack_100'});
    expect(jws.split('.')).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Consumables — verifyIapAndGrant
// ---------------------------------------------------------------------------

describe('🔴 consumables grant through the REAL verifier', () => {
  const spongeIds = Object.entries(EXPECTED)
    .filter(([, c]) => c.kind === 'sponges')
    .map(([id]) => id);

  test.each(spongeIds)(
    '%s: a signed JWS is verified and the sponges are written',
    async (productId) => {
      const expected = EXPECTED[productId] as {kind: 'sponges'; sponges: number};
      const transactionId = `tx-${productId}`;

      const result = await verifyIapAndGrant._handler({
        auth: {uid: UID, token: {}},
        data: {receipt: jwsFor({transactionId, productId}), productId},
      });

      expect(`${productId} granted ${result.granted.sponges} sponges`).toBe(
        `${productId} granted ${expected.sponges} sponges`,
      );

      // The grant is not what the callable RETURNS, it is what it WROTE. A
      // handler that returned the right number and wrote nothing is exactly the
      // failure this file exists for.
      expect(docStore[`users/${UID}/profile/data`].data).toEqual({
        spongeBalance: {_type: 'increment', n: expected.sponges},
      });
      expect(
        docStore[`processedReceipts/${productId}_${transactionId}`].data,
      ).toMatchObject({uid: UID, productId, transactionId});
    },
  );

  test('PremiumOffer_3: the weekly offer grants its sponges AND its items', async () => {
    const productId = 'PremiumOffer_3';
    const expected = EXPECTED[productId] as {
      kind: 'offer';
      sponges: number;
      items: string[];
    };
    seedWeeklyOffer(productId);
    const transactionId = 'tx-premium-offer';

    const result = await verifyIapAndGrant._handler({
      auth: {uid: UID, token: {}},
      data: {receipt: jwsFor({transactionId, productId}), productId},
    });

    expect(result.granted.sponges).toBe(expected.sponges);
    expect(result.granted.items).toEqual(expected.items);
    for (const itemId of expected.items) {
      expect(docStore[`users/${UID}/inventory/${itemId}`].data).toMatchObject({
        itemId,
        equipped: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Subscriptions — verifySubscriptionReceipt
// ---------------------------------------------------------------------------

describe('🔴 subscriptions grant through the REAL verifier', () => {
  const subIds = Object.entries(EXPECTED)
    .filter(([, c]) => c.kind === 'subscription')
    .map(([id]) => id);

  test.each(subIds)(
    '%s: a signed JWS is verified and the entitlement is written',
    async (productId) => {
      const expected = EXPECTED[productId] as {
        kind: 'subscription';
        tier: string;
      };
      const transactionId = `tx-${productId}`;
      const expiresDate = Date.now() + THIRTY_DAYS_MS;

      await verifySubscriptionReceipt._handler({
        auth: {uid: UID, token: {}},
        data: {
          receipt: jwsFor({
            transactionId,
            productId,
            expiresDate,
            originalTransactionId: `orig-${productId}`,
            type: 'Auto-Renewable Subscription',
          }),
          productId,
        },
      });

      // 🔑 THE EXPIRY IS ASSERTED AGAINST THE SIGNED VALUE, not against a
      // recomputed "about a month from now". The defect this callable was
      // written to close was a fabricated expiry, and an assertion that
      // recomputed the date would have accepted one.
      expect(docStore[`users/${UID}`].data).toEqual({
        subscriptionTier: expected.tier,
        subscriptionProductId: productId,
        subscriptionExpiresAt: {
          _type: 'ts',
          ms: expiresDate,
          toMillis: expect.any(Function),
        },
      });

      // The renewal index — without it no future rebill can find this account.
      expect(docStore[`subscriptionOwners/orig-${productId}`].data).toMatchObject(
        {uid: UID, productId},
      );
    },
  );

  test('a subscription id the tier table does not know is REFUSED, not silently granted', async () => {
    // The control for the two tests above: they would pass just as well if
    // `verifySubscriptionReceipt` granted `pro` to anything at all. This is the
    // assertion that says the tier table is load-bearing.
    await expect(
      verifySubscriptionReceipt._handler({
        auth: {uid: UID, token: {}},
        data: {
          receipt: jwsFor({
            transactionId: 'tx-unknown',
            productId: 'sub_not_a_product',
            expiresDate: Date.now() + THIRTY_DAYS_MS,
          }),
          productId: 'sub_not_a_product',
        },
      }),
    ).rejects.toThrow('Not a subscription product: sub_not_a_product');

    expect(docStore[`users/${UID}`]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The price table — a missing entry must be LOUD
// ---------------------------------------------------------------------------

describe('🔴 SUBSCRIPTION_PRICES covers every subscription that is sold', () => {
  test('every registered subscription is priced', () => {
    // The whole reason W2-158 was written: `sub_family_monthly` shipped in
    // Configuration.storekit and App Store Connect while this table had no
    // entry for it, and `receiptFor` answered `null` — a charged buyer with no
    // receipt, and nothing anywhere that noticed. W2-157 added the entry. This
    // is the thing that would have caught it.
    expect(() => assertPricedSubscriptions(REGISTRY.subscriptions)).not.toThrow();
  });

  test('a missing entry names the product id AND the file', () => {
    let message = '';
    try {
      assertPricedSubscriptions(['sub_pro_monthly', 'sub_invented_monthly']);
    } catch (e) {
      message = (e as Error).message;
    }
    // Asserted on the MESSAGE, not merely on the throw: "fails loudly" is a
    // claim about what the reader is told, and a throw carrying "Error" tells
    // them nothing. The priced id must not appear — a report that names every
    // product is a report that names none.
    expect(message).toContain('sub_invented_monthly');
    expect(message).toContain('functions/src/proReceipt.ts');
    expect(message).not.toContain('sub_pro_monthly');
  });
});

// ---------------------------------------------------------------------------
// OBSERVED, NOT DECIDED — the family interaction
// ---------------------------------------------------------------------------

describe('📌 what a family purchase does and does not reach', () => {
  test('sub_family_monthly entitles the OWNER and writes nothing for members', async () => {
    // ⚠️ THIS IS A CHARACTERISATION TEST. It pins observed behaviour so a change
    // is visible; it does NOT assert that the behaviour is correct, and the
    // brief that produced it explicitly declined to settle the question.
    //
    // WHAT IS OBSERVED: `verifySubscriptionReceipt` has no family fan-out. The
    // two call sites of `planFamilyFanOut*` are `appStoreNotificationsV2`
    // (index.ts:1884) and `joinFamily` (index.ts:4837) — the webhook and the
    // grant-on-join. So a member who was already in the family when the owner
    // bought the family product receives `familyProExpiresAt` from NEITHER: the
    // join already happened, and the webhook URL is not yet pasted into App
    // Store Connect. This is reachable because the create gate accepts a
    // personal-Pro owner (family.ts:630) while the fan-out requires the FAMILY
    // product, so "upgrade to Family after inviting" is an ordinary path.
    const memberUid = 'member-uid';
    docStore[`users/${memberUid}`] = {data: {familyId: 'fam-1'}};

    await verifySubscriptionReceipt._handler({
      auth: {uid: UID, token: {}},
      data: {
        receipt: jwsFor({
          transactionId: 'tx-family',
          productId: 'sub_family_monthly',
          expiresDate: Date.now() + THIRTY_DAYS_MS,
          originalTransactionId: 'orig-family',
          type: 'Auto-Renewable Subscription',
        }),
        productId: 'sub_family_monthly',
      },
    });

    expect(docStore[`users/${UID}`].data).toMatchObject({
      subscriptionTier: 'pro',
      subscriptionProductId: 'sub_family_monthly',
    });
    expect(docStore[`users/${memberUid}`].data).toEqual({familyId: 'fam-1'});
  });
});
