// Force module scope. Without a top-level import/export a .ts file is a SCRIPT,
// so its top-level `const _db` lands in the GLOBAL scope and collides with the
// identically-named one in nine sibling test files (TS2451). Which pair collides
// depends on how ts-jest groups files into a worker, which is why the suite failed
// non-deterministically on a different file each run. Pre-existing; see W3-09.
export {};

// functions/src/__tests__/rotateWeeklyOffer.test.ts
//
// Unit tests for the rotateWeeklyOffer scheduled CF. There were none before.
//
// The device symptom on 2026-08-04 was a premium offer card reading $0.00, x 0
// and "Refreshing...". That is one cause, not three: `shop/current.weeklyOffer`
// is absent, so WeeklyOffer.fromJson({}) defaults price to 0.0, contents to []
// and — because parseDate(null) returns DateTime.now() — makes endsAt "past"
// the instant it renders (weekly_offer.dart:20-38).
//
// Measured in production on 2026-08-03T00:00:03Z:
//   rotateweeklyoffer: rotateWeeklyOffer: no offers configured in shopConfig/weeklyOffers
//
// `shopConfig/weeklyOffers` is a hand-seeded document nobody is holding — the
// same defect class as the unseeded `items` collection that dead-ended
// orientation (see claimWelcomeChest.test.ts). The remedy is the same one that
// worked there: a committed, bundled pool that ships inside the function.
//
// These tests assert on the payload actually handed to shop/current.set(), NOT
// on WEEKLY_OFFERS. A test that compares a constant to itself stays green while
// production writes nothing, which is exactly how the welcome-chest outage
// survived. The one deliberate exception is the bundle-validity block at the
// bottom, which is a build-time guard on the source that can drift.

const _db: {
  doc: jest.Mock;
} = {
  doc: jest.fn(),
};

jest.mock('firebase-admin', () => {
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = {
    increment: (n: number) => ({ _type: 'increment', n }),
  };
  firestoreFn.Timestamp = {
    now: () => ({ seconds: 0, nanoseconds: 0 }),
    fromDate: (d: Date) => ({
      toDate: () => d,
      toMillis: () => d.getTime(),
    }),
  };
  return {
    initializeApp: jest.fn(),
    firestore: firestoreFn,
    messaging: jest.fn(() => ({ send: jest.fn() })),
  };
});

// index.ts imports Timestamp/FieldValue from 'firebase-admin/firestore' because
// the Functions emulator's admin proxy drops those statics. Point both import
// styles at one fake.
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { rotateWeeklyOffer } = require('../index') as {
  rotateWeeklyOffer: { _handler: () => Promise<void> };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { WEEKLY_OFFERS } = require('../weeklyOffers') as {
  WEEKLY_OFFERS: Array<{
    id: string;
    title: string;
    // CRITICAL: NO `price` — W2-176. This is a hand-written mirror of
    // WeeklyOfferConfig behind an UNCHECKED `require` cast, so a stale field
    // here does not fail to compile; it silently licenses assertions about a
    // field that no longer exists. That is how `offer.price` type-checked
    // while resolving to `undefined` at runtime.
    currency: string;
    iapProductId: string;
    contents: Array<Record<string, unknown>>;
    heroImageUrl: string;
  }>;
};

interface CapturedWrite {
  path: string;
  data: Record<string, any>;
  options: Record<string, unknown>;
}

/// Stubs shopConfig/weeklyOffers reads and captures every shop/current write.
/// `config` is what the config document's data() resolves to — `undefined`
/// models a document that does not exist, which is what data() returns then.
function stubShop(config: Record<string, unknown> | undefined) {
  const writes: CapturedWrite[] = [];

  _db.doc.mockImplementation((path: string) => ({
    path,
    get: jest.fn(async () => ({
      exists: config !== undefined,
      data: () => config,
    })),
    set: jest.fn(
      async (data: Record<string, any>, options: Record<string, unknown>) => {
        writes.push({ path, data, options });
      },
    ),
  }));

  return writes;
}

function offerWrites(writes: CapturedWrite[]): CapturedWrite[] {
  return writes.filter((w) => w.path === 'shop/current');
}

describe('rotateWeeklyOffer', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---- the production state -----------------------------------------------

  test('writes an offer when shopConfig/weeklyOffers does not exist', async () => {
    const writes = stubShop(undefined);

    await rotateWeeklyOffer._handler();

    // Today this is 0: the function warns and returns, so shop/current keeps
    // only the dailyChests rotateMarket writes, and the card renders defaults.
    expect(offerWrites(writes)).toHaveLength(1);
    expect(offerWrites(writes)[0].data.weeklyOffer).toBeDefined();
  });

  test('writes an offer when the config exists with an empty offers array', async () => {
    const writes = stubShop({ offers: [] });

    await rotateWeeklyOffer._handler();

    expect(offerWrites(writes)).toHaveLength(1);
  });

  test('the written offer has a future endsAt', async () => {
    const writes = stubShop(undefined);

    await rotateWeeklyOffer._handler();

    const { weeklyOffer, weeklyOfferRefreshAt } = offerWrites(writes)[0].data;
    expect(weeklyOffer.endsAt.toMillis()).toBeGreaterThan(Date.now());
    expect(weeklyOffer.startsAt.toMillis()).toBeLessThanOrEqual(Date.now());
    expect(weeklyOfferRefreshAt.toMillis()).toBe(weeklyOffer.endsAt.toMillis());
  });

  test('the written offer ships NO price, and has contents', async () => {
    const writes = stubShop(undefined);

    await rotateWeeklyOffer._handler();

    const { weeklyOffer } = offerWrites(writes)[0].data;
    // CRITICAL: W2-176 INVERTED THE PRICE HALF OF THIS. It read
    // `expect(weeklyOffer.price).toBeGreaterThan(0)` — the $0.00 symptom
    // asserted on the write. The server no longer asserts a price at all, so
    // the assertion that matters now is that the write does not carry one:
    // a bundled offer that grew a price back would reach the client through
    // this exact spread.
    expect(
      `the written offer ships a price: ${'price' in weeklyOffer ? String(weeklyOffer.price) : 'no'}`,
    ).toBe('the written offer ships a price: no');
    expect(weeklyOffer.currency).toBeTruthy();
    expect(Array.isArray(weeklyOffer.contents)).toBe(true);
    expect(weeklyOffer.contents.length).toBeGreaterThan(0);
    // Required by verifyIapAndGrant (index.ts:552-570) and the card's title.
    expect(weeklyOffer.id).toBeTruthy();
    expect(weeklyOffer.iapProductId).toBeTruthy();
    expect(weeklyOffer.title).toBeTruthy();
  });

  // ---- Firestore stays authoritative when it is populated ------------------

  test('a seeded config wins over the bundled pool', async () => {
    const writes = stubShop({
      offers: [
        {
          id: 'offer_from_firestore',
          title: 'Seeded Bundle',
          price: 4.99,
          currency: 'USD',
          iapProductId: 'premium_offer_seeded',
          contents: [{ type: 'sponges', amount: 100 }],
          heroImageUrl: '',
        },
      ],
    });

    await rotateWeeklyOffer._handler();

    const { weeklyOffer } = offerWrites(writes)[0].data;
    expect(weeklyOffer.id).toBe('offer_from_firestore');
    expect(weeklyOffer.price).toBe(4.99);
    expect(WEEKLY_OFFERS.some((o) => o.id === 'offer_from_firestore')).toBe(
      false,
    );
  });

  test('server-generated dates override anything in the config', async () => {
    const stale = new Date('2020-01-01T00:00:00Z');
    const writes = stubShop({
      offers: [
        {
          id: 'offer_stale_dates',
          title: 'Stale',
          price: 9.99,
          currency: 'USD',
          iapProductId: 'premium_offer_stale',
          contents: [{ type: 'sponges', amount: 100 }],
          heroImageUrl: '',
          startsAt: stale,
          endsAt: stale,
        },
      ],
    });

    await rotateWeeklyOffer._handler();

    const { weeklyOffer } = offerWrites(writes)[0].data;
    expect(weeklyOffer.endsAt.toMillis()).toBeGreaterThan(Date.now());
  });

  test('replaces the weeklyOffer map without clobbering dailyChests', async () => {
    const writes = stubShop(undefined);

    await rotateWeeklyOffer._handler();

    // mergeFields, NOT merge:true — a deep merge would leave stale fields from
    // a previous offer shape, and a bare set would destroy dailyChests.
    // WARNING: W2-40 added 'weeklyOfferError' to the allowlist. mergeFields is an
    // ALLOWLIST: the success path clears a stale diagnostic, and a clear for a
    // field absent from this array is SILENTLY IGNORED — the clear would read
    // correctly and do nothing, leaving last week's refusal beside a working
    // offer. Asserted here so the two lists cannot drift apart.
    expect(offerWrites(writes)[0].options).toEqual({
      mergeFields: ['weeklyOffer', 'weeklyOfferRefreshAt', 'weeklyOfferError'],
    });
  });

  // ---- the fallback must not swallow a real misconfiguration ---------------

  test('still throws on a malformed seeded offer', async () => {
    stubShop({ offers: [{ title: 'No id, no iapProductId, no contents' }] });

    await expect(rotateWeeklyOffer._handler()).rejects.toThrow(
      /Malformed weekly offer config/,
    );
  });

  // WARNING: UPDATED BY W2-40, and the assertion it replaces was correct until now.
  // It asserted ZERO writes on refusal. A refusal now writes ONE — the
  // weeklyOfferError diagnostic — because the old behaviour was loud only in
  // Cloud Functions logs, which nobody here reads. The test's INTENT (do not
  // publish a bad offer) is preserved and sharpened: it now checks that no
  // OFFER is written, rather than that nothing at all is.
  test('does not fall back to the bundle when the config is malformed', async () => {
    const writes = stubShop({ offers: [{ id: 'has_id_only' }] });

    await expect(rotateWeeklyOffer._handler()).rejects.toThrow();

    // No offer published — the point of the test.
    const published = offerWrites(writes).filter(
      (w) => (w.data as Record<string, unknown>).weeklyOffer !== undefined,
    );
    expect(published).toHaveLength(0);

    // And the reason landed where a human looks, not only in a log.
    const diagnostics = offerWrites(writes).filter(
      (w) => (w.data as Record<string, unknown>).weeklyOfferError !== undefined,
    );
    expect(diagnostics).toHaveLength(1);
    const err = (diagnostics[0].data as Record<string, any>).weeklyOfferError;
    expect(err.offerId).toBe('has_id_only');
    expect(err.problems.length).toBeGreaterThan(0);
    expect(err.source).toBe('shopConfig/weeklyOffers');
  });
});

// ---------------------------------------------------------------------------
// Build-time guard on the bundled pool itself.
//
// Deliberately asserts against WEEKLY_OFFERS, for the same reason
// welcomeChestPool.test.ts asserts against SEED_ITEMS: this is the source that
// can drift, and a bad entry here throws at rotation time in production —
// on a Monday at 00:00 UTC, with nobody watching.
// ---------------------------------------------------------------------------

describe('bundled weekly offer pool', () => {
  test('is not empty', () => {
    expect(WEEKLY_OFFERS.length).toBeGreaterThan(0);
  });

  test('every entry passes the rotation validation gate', () => {
    for (const offer of WEEKLY_OFFERS) {
      // Exactly the check at index.ts:271 — anything failing it throws.
      expect(typeof offer.id).toBe('string');
      expect(offer.id).toBeTruthy();
      expect(typeof offer.iapProductId).toBe('string');
      expect(offer.iapProductId).toBeTruthy();
      expect(Array.isArray(offer.contents)).toBe(true);
    }
  });

  test('every entry carries the fields the client needs to render', () => {
    for (const offer of WEEKLY_OFFERS) {
      // Unvalidated server-side, but weekly_offer.dart defaults a missing
      // string to '' — which is the $0.00 card all over again.
      //
      // CRITICAL: `price` IS NO LONGER ONE OF THESE (W2-176). It used to read
      // `expect(offer.price).toBeGreaterThan(0)`; the server has stopped
      // asserting a price, and the absence is enforced in
      // offerIntegrity.test.ts rather than restated here.
      expect(offer.title).toBeTruthy();
      expect(offer.currency).toBeTruthy();
      expect(offer.contents.length).toBeGreaterThan(0);
    }
  });

  test('every content row is a shape the shop card can render', () => {
    // premium_offer_card.dart:252-259 switches on `type`; sponges rows also
    // need `amount`, and item rows need `itemId` for verifyIapAndGrant.
    const renderable = new Set(['sponges', 'style', 'furniture', 'character']);
    for (const offer of WEEKLY_OFFERS) {
      for (const row of offer.contents) {
        expect(renderable).toContain(row.type as string);
        if (row.type === 'sponges') {
          expect(typeof row.amount).toBe('number');
        } else {
          expect(typeof row.itemId).toBe('string');
        }
      }
    }
  });

  test('every granted itemId is a real item in the seed pool', () => {
    // verifyIapAndGrant (index.ts:566) writes itemId straight into the user's
    // inventory without checking it exists, so a typo here grants a phantom
    // item that renders as a blank tile in the album.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SEED_ITEMS } = require('../itemPool') as {
      SEED_ITEMS: Array<{ id: string }>;
    };
    const known = new Set(SEED_ITEMS.map((i) => i.id));
    for (const offer of WEEKLY_OFFERS) {
      for (const row of offer.contents) {
        if (row.type === 'sponges') continue;
        expect(known).toContain(row.itemId as string);
      }
    }
  });

  test('offer ids are unique', () => {
    const ids = WEEKLY_OFFERS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
