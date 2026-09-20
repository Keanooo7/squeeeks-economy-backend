// functions/src/__tests__/offerIntegrity.test.ts
//
// W2-39. An offer that names an item nobody can grant.
//
// CRITICAL: THE DEFECT: `verifyIapAndGrant` validates NOTHING about
// `contents[].itemId`. It pushes the string into `grantedItems` and writes
// `users/{uid}/inventory/{itemId}`. SEED_ITEMS appears zero times in the grant
// path. So an offer naming a nonexistent item does not FAIL — it SUCCEEDS, and
// the player pays real money for an inventory row pointing at nothing.
//
// WARNING: An unknown id in a LAYOUT is silently SKIPPED — an emptier house. An
// unknown id in a GRANT is silently WRITTEN — a paid-for nothing. Only one of
// them takes money.
//
// KEY: THESE MUST FAIL ON THE PRE-FIX CODE. Several guards this session could not
// have failed; this one was checked by running it against the previous commit,
// where `validateOfferContents` does not exist — the suite fails to compile,
// which is a red this file cannot fake.

import {
  WEEKLY_OFFERS,
  validateOfferContents,
  WeeklyOfferConfig,
} from '../weeklyOffers';
import {SEED_ITEMS} from '../itemPool';
import {codeOf} from './helpers/sourceText';

const REAL_IDS: ReadonlySet<string> = new Set(SEED_ITEMS.map((i) => i.id));

const offer = (over: Partial<WeeklyOfferConfig> = {}): WeeklyOfferConfig => ({
  id: 'offer_test',
  title: 'Test',
  // CRITICAL: NO `price` — W2-176 removed it from WeeklyOfferConfig, and this literal
  // is type-checked against that interface, so a reintroduction here fails to
  // COMPILE rather than failing an assertion. That is the stronger guard: the
  // suite cannot report `Tests: 0 total` green.
  currency: 'USD',
  iapProductId: 'test_product',
  contents: [{type: 'sponges', amount: 100}],
  heroImageUrl: '',
  ...over,
});

describe('🔴 an offer naming a phantom item is refused', () => {
  test('an unknown itemId is a problem, and the message says why it matters', () => {
    const problems = validateOfferContents(
      offer({contents: [{type: 'style', itemId: 'style_does_not_exist'}]}),
      REAL_IDS,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('style_does_not_exist');
    expect(problems[0]).toMatch(/pointing at nothing/);
  });

  test('a character-type phantom is refused, not just a style one', () => {
    // Was `char_pyjama` under W2-38, when no pyjama row existed in either seed
    // pool. W2-48 seeded it, so that id is now REAL and asserting it phantom
    // would assert the opposite of the truth. Retargeted rather than deleted:
    // the property under test is that the character branch is guarded too, and
    // that property did not change when one character stopped being missing.
    const problems = validateOfferContents(
      offer({contents: [{type: 'character', itemId: 'char_no_such_skin'}]}),
      REAL_IDS,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('char_no_such_skin');
  });

  test('EVERY problem is reported, not just the first', () => {
    // An offer with two bad ids must not need two deploys to discover.
    const problems = validateOfferContents(
      offer({
        contents: [
          {type: 'style', itemId: 'nope_one'},
          {type: 'character', itemId: 'nope_two'},
        ],
      }),
      REAL_IDS,
    );
    expect(problems).toHaveLength(2);
  });

  test('a content row with no itemId at all is caught', () => {
    const problems = validateOfferContents(
      offer({contents: [{type: 'style'} as never]}),
      REAL_IDS,
    );
    expect(problems[0]).toMatch(/no itemId/);
  });

  test('sponges with no amount is the same class of bug', () => {
    // Succeeds, grants nothing. Cheaper than a phantom item but the same shape.
    for (const amount of [0, undefined, -5]) {
      const problems = validateOfferContents(
        offer({contents: [{type: 'sponges', amount} as never]}),
        REAL_IDS,
      );
      expect(problems.length).toBeGreaterThan(0);
    }
  });

  test('an empty contents array is a purchase that grants nothing', () => {
    expect(validateOfferContents(offer({contents: []}), REAL_IDS).length).toBeGreaterThan(0);
  });

  test('missing id or iapProductId are still caught — the old shape check survives', () => {
    expect(validateOfferContents(offer({id: ''}), REAL_IDS)[0]).toMatch(/id/);
    expect(validateOfferContents(offer({iapProductId: ''}), REAL_IDS)[0]).toMatch(/iapProductId/);
  });

  test('the validator is total over a malformed shape rather than throwing', () => {
    // rotateWeeklyOffer casts DocumentData into this. A bad cast must surface
    // as a problem string, not a crash inside a scheduled function.
    expect(() =>
      validateOfferContents({} as unknown as WeeklyOfferConfig, REAL_IDS),
    ).not.toThrow();
    expect(
      validateOfferContents({} as unknown as WeeklyOfferConfig, REAL_IDS).length,
    ).toBeGreaterThan(0);
  });
});

describe('🟢 the SHIPPED offer is sound — this must not be red', () => {
  // If this ever fails, the live rotation is about to start throwing and the
  // premium offer disappears from the shop. It is the reason validation was
  // added at rotate time and not merely asserted in a test.
  test.each(WEEKLY_OFFERS.map((o) => [o.id, o] as const))(
    '%s names only real items',
    (_id, o) => {
      expect(validateOfferContents(o, REAL_IDS)).toEqual([]);
    },
  );

  test('the reference set is not vacuously empty', () => {
    // A guard whose known-id set was empty would call every offer phantom.
    expect(REAL_IDS.size).toBeGreaterThan(20);
    expect(REAL_IDS.has('char_gardener')).toBe(true);
    expect(REAL_IDS.has('style_roof_tile_gold')).toBe(true);
    // Flipped by W2-48 — it was the recorded proof that the skin was missing,
    // and it is now the recorded proof that it landed.
    expect(REAL_IDS.has('char_pyjama')).toBe(true);
    // Something still has to be absent, or "not vacuously empty" would pass
    // against a set containing literally everything.
    expect(REAL_IDS.has('char_no_such_skin')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // CRITICAL: W2-89 — the product exists after all, and the code was pointing at a
  // placeholder that existed nowhere.
  // -------------------------------------------------------------------------

  test('🔴 the offer names the REAL App Store Connect id', () => {
    const spring = WEEKLY_OFFERS.find((o) => o.id === 'offer_seed_001');
    expect(spring!.iapProductId).toBe('PremiumOffer_3');
  });

  test('🔴 the placeholder id is GONE — it resolved NOWHERE and threw', () => {
    // `queryProductDetails` returned it in notFoundIDs, so
    // shop_purchase_provider.dart:76 threw `Product not found` before any
    // callable was reached. A Product ID is immutable once created, so the code
    // moves and never the other way.
    for (const offer of WEEKLY_OFFERS) {
      expect(offer.iapProductId).not.toBe('premium_offer_spring');
    }
  });

  test('🔴 every offer id is REGISTERED IN ios/Configuration.storekit', () => {
    // KEY: THE CHECK THAT DID NOT EXIST, and its absence is why a placeholder id
    // survived: nothing compared the believed id to a registered one. The
    // simulator config is the only registry this repo can read.
    const cfg = JSON.parse(
      require('fs').readFileSync(
        require('path').join(__dirname, '..', '..', '..', 'ios', 'Configuration.storekit'),
        'utf8',
      ),
    ) as {products: {productID: string; type: string}[]};

    // Anti-vacuity: an empty or unparsed config would make every check below
    // pass against nothing.
    expect(cfg.products.length).toBeGreaterThanOrEqual(4);
    expect(cfg.products.map((p) => p.productID)).toContain('sponge_pack_100');

    for (const offer of WEEKLY_OFFERS) {
      const product = cfg.products.find((p) => p.productID === offer.iapProductId);
      expect(
        `${offer.iapProductId} registered in Configuration.storekit: ${product !== undefined}`,
      ).toBe(`${offer.iapProductId} registered in Configuration.storekit: true`);
      // WARNING: CONSUMABLE, because the offer ROTATES. A non-consumable can be
      // bought once EVER, so a player could never buy a second week's bundle.
      expect(product!.type).toBe('Consumable');
    }
  });

  test('the Spring Bundle still declares the currency it is sold in', () => {
    // NOTE: WHAT THIS USED TO BE. It pinned `price` to 2.99 — the assertion
    // W2-176 removed. The currency survives the removal on purpose and the
    // reasoning is in weeklyOffers.ts: it is the same unfounded claim in
    // kind, but it is INERT, because nothing reads it. `_priceLabel` renders
    // its fallback with a hardcoded `$` and never consults this field.
    // Surfaced in the W2-176 return as the next item rather than folded in.
    const spring = WEEKLY_OFFERS.find((o) => o.id === 'offer_seed_001');
    expect(spring).toBeDefined();
    expect(spring!.currency).toBe('USD');
  });

  // -------------------------------------------------------------------------
  // W2-176 — THE SERVER STOPS ASSERTING A PRICE
  //
  // CRITICAL: Brendan, 2026-09-13: "Read the real price from the store. Stop carrying
  // a written-in 2.99." The two tests below are the enforcement, and they are
  // the REPLACEMENT for the pin above and the storekit comparison beside it —
  // both of which are deleted in the same change that removes the field.
  //
  // KEY: WHY THE PIN AND THE DRIFT GUARD BOTH GO. A drift guard asks "does the
  // number we send still equal the number Apple charges". That question only
  // has to be asked because we send a number. The believed price and the
  // charged price were two numbers in two systems; the fix is not to compare
  // them more carefully, it is to stop having the second one. A test that
  // checks a value you should not be sending protects the defect.
  //
  // WARNING: AND THE CURRENCY IS THE SAME CLASS OF ASSERTION, LEFT STANDING ON
  // PURPOSE. `currency: 'USD'` is as unfounded as the amount was — Apple
  // charges a UK player in GBP — but it is INERT: `_priceLabel` renders the
  // fallback with a hardcoded `$` and reads `currency` nowhere. Surfaced, not
  // folded in. See the return for W2-176.
  // -------------------------------------------------------------------------

  test('🔴 NO offer ships a price — the store is the only price authority', () => {
    // Anti-vacuity: a `for` over an empty array reports success, which this
    // repo has now watched happen more than once.
    expect(WEEKLY_OFFERS.length).toBeGreaterThan(0);

    let checked = 0;
    for (const offer of WEEKLY_OFFERS) {
      // Read through a Record rather than the interface, so this test keeps
      // testing after `price` is gone from the TYPE. A typed read would become
      // a compile error — and a compile error is not a red assertion, it is a
      // suite that reports `Tests: 0 total`.
      const raw = offer as unknown as Record<string, unknown>;
      const shipped = 'price' in raw ? String(raw.price) : 'no';
      // KEY: THE RENDERED SENTENCE IS THE PIN, not a constant either side could
      // share. The failure NAMES the smuggled value, so "2.99 came back" and
      // "some other number came back" are different failures rather than the
      // same `true !== false`.
      expect(`${offer.id} ships a price: ${shipped}`).toBe(
        `${offer.id} ships a price: no`,
      );
      checked++;
    }
    expect(checked).toBe(WEEKLY_OFFERS.length);
  });

  test('🔴 weeklyOffers.ts declares no price IN THE CODE, comments aside', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'weeklyOffers.ts'),
      'utf8',
    ) as string;
    const code = codeOf(src);

    // CRITICAL: THE POSITIVE CONTROL. A `.not.toMatch` over a file that failed to load,
    // or a `codeOf` that stripped everything, passes against nothing. This
    // proves the same `<field>:` shape DOES fire on a field that is still
    // declared, in this exact text, before the absence below is believed.
    expect(code).toMatch(/\biapProductId\s*:/);

    // `\b` before `price` keeps `displayPrice` out of it; the field is gone
    // from the interface AND from the seed, so neither declaration survives.
    expect(code).not.toMatch(/\bprice\s*:/);
  });

  test('🔴 the STORE can price every offer product — it is now the only source', () => {
    // CRITICAL: THE PREMISE OF THIS TEST INVERTED, AND THAT IS THE POINT.
    //
    // It used to assert "the price we send equals the price Configuration
    // .storekit charges". That comparison was withdrawn with the field: a
    // drift guard on a number the server should not be sending protects the
    // defect rather than the player. Deleting it outright would have left a
    // hole, though — once the offer carries no price, the STORE having one
    // stops being a nicety and becomes the entire contract. So the question
    // changed from "do our two numbers agree" to "does the one remaining
    // authority actually answer".
    //
    // WARNING: Configuration.storekit is the LOCAL test configuration, not App Store
    // Connect. It proves the id is priceable in the harness a simulator run
    // uses; it cannot prove what Apple charges, and nothing in this repo can.
    // That is exactly why the server no longer claims to know.
    const cfg = JSON.parse(
      require('fs').readFileSync(
        require('path').join(__dirname, '..', '..', '..', 'ios', 'Configuration.storekit'),
        'utf8',
      ),
    ) as {products: {productID: string; displayPrice?: string}[]};

    // Anti-vacuity: an unparsed or empty config makes the loop below assert
    // nothing at all, and a `find` that never matches would too.
    expect(cfg.products.length).toBeGreaterThanOrEqual(4);
    expect(WEEKLY_OFFERS.length).toBeGreaterThan(0);

    let priced = 0;
    for (const offer of WEEKLY_OFFERS) {
      const product = cfg.products.find((p) => p.productID === offer.iapProductId);
      expect(
        `${offer.iapProductId} is registered: ${product !== undefined}`,
      ).toBe(`${offer.iapProductId} is registered: true`);
      // A registered product with no usable displayPrice leaves the card with
      // NO price to show from any source, which is the state the removal would
      // be indefensible in.
      expect(typeof product!.displayPrice).toBe('string');
      expect(
        `${offer.iapProductId} store price > 0: ${Number(product!.displayPrice) > 0}`,
      ).toBe(`${offer.iapProductId} store price > 0: true`);
      priced++;
    }
    // CRITICAL: THE LOOP RAN. A `for` over an empty array reports success, which is
    // four sightings of "a control that passed while testing nothing" in this
    // repo and counting.
    expect(priced).toBe(WEEKLY_OFFERS.length);
  });
});

describe('⚠️ BOTH writers of shop/current validate — rotation is not sufficient alone', () => {
  const index = (): string =>
    codeOf(require('fs').readFileSync(require('path').join(__dirname, '..', 'index.ts'), 'utf8'));

  test('rotateWeeklyOffer validates before writing', () => {
    const code = index();
    const call = code.indexOf('validateOfferContents');
    const write = code.indexOf("db.doc('shop/current').set");
    expect(call).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(call);
  });

  test('seedShopData validates too — it bypasses rotation entirely', () => {
    // The disproof of this brief: shop/current has THREE writers, and
    // seedShopData wrote its own copy of the offer without passing through
    // rotateWeeklyOffer. Validating only the rotation would have left it open.
    expect(index()).toContain('seedShopData: refusing to seed malformed offer');
  });

  test('🔑 the duplicated offer literal is GONE, not merely gated', () => {
    // weeklyOffers.ts:55 and index.ts:1480 were byte-identical copies with
    // nothing keeping them in step. A divergence test would have caught drift;
    // deleting the copy makes drift impossible.
    const code = index();
    expect(code).not.toContain("iapProductId: 'premium_offer_spring'");
    expect(code).toContain('WEEKLY_OFFERS[0]');
  });

  test('the grant path is deliberately UNCHANGED', () => {
    // A grant-side throw would punish the wrong person: it cannot distinguish
    // "this offer is malformed" from "this player owns something the pool no
    // longer lists", and a purchase that succeeded yesterday must not start
    // failing today.
    const code = index();
    const grantStart = code.indexOf('for (const content of');
    const grantEnd = code.indexOf('const granted =', grantStart);
    const grant = code.slice(grantStart, grantEnd);
    expect(grant).not.toContain('validateOfferContents');
    expect(grant).not.toContain('throw');
  });
});

// ---------------------------------------------------------------------------
// W2-40 — the refusal has to land where a human looks
// ---------------------------------------------------------------------------
//
// CRITICAL: W2-39 traded a SILENT bad outcome (a purchase granting a phantom) for a
// LOUD one (the rotation refuses) — but loud only in Cloud Functions logs, which
// nobody on this project has ever opened. A Monday with no offer, explained
// somewhere nobody reads, is barely better than a Monday with a bad one.
//
// WARNING: AND PREVENTION IS IMPOSSIBLE. `shopConfig/weeklyOffers` is READ at :460 and
// WRITTEN BY NOTHING — no callable, no endpoint, no rules block, so it is
// console-only. There is no write path to hook a check onto, which is why this
// is detection rather than prevention.

describe('a refused rotation explains itself next to the data', () => {
  const index = (): string =>
    codeOf(require('fs').readFileSync(require('path').join(__dirname, '..', 'index.ts'), 'utf8'));

  test('the refusal writes weeklyOfferError to shop/current', () => {
    // shop/current is the first place anyone looks when the offer is missing.
    expect(index()).toContain('weeklyOfferError');
  });

  test('it records the problems, the offer id AND which source it came from', () => {
    // "bundled" vs "shopConfig" is the difference between a deploy and a
    // console edit, and therefore between two completely different fixes.
    const code = index();
    expect(code).toContain('shopConfig/weeklyOffers');
    expect(code).toContain('bundled WEEKLY_OFFERS');
  });

  test('the refusal does NOT take the daily chests down with it', () => {
    // mergeFields, not merge — a bad weekly offer must not empty the shop.
    const code = index();
    const at = code.indexOf('weeklyOfferError: {');
    const after = code.slice(at, at + 900);
    expect(after).toContain("mergeFields: ['weeklyOfferError']");
  });

  test('the diagnostic write cannot become the failure', () => {
    // If recording the reason throws, the throw below it is what matters.
    const code = index();
    const at = code.indexOf('weeklyOfferError: {');
    expect(code.slice(at - 400, at + 1200)).toContain('could not record weeklyOfferError');
  });

  test('🔑 a stale error is CLEARED on the next success', () => {
    // A diagnostic that outlives its fault is its own lie.
    expect(index()).toContain('weeklyOfferError: null');
    // NOT FieldValue.delete() — undefined under the emulator's admin proxy.
    expect(index()).not.toContain('weeklyOfferError: FieldValue.delete()');
  });

  test('🔴 and weeklyOfferError is in the mergeFields ALLOWLIST', () => {
    // mergeFields is an allowlist: a FieldValue.delete() for a field absent
    // from the array is SILENTLY IGNORED. Without this the clear above would
    // compile, read correctly, and do nothing — a stale refusal sitting beside
    // a working offer forever. Found in review of the diff that introduced it.
    const code = index();
    const at = code.indexOf("mergeFields: ['weeklyOffer',");
    expect(at).toBeGreaterThan(-1);
    expect(code.slice(at, at + 120)).toContain('weeklyOfferError');
  });
});

describe('the content type is a closed set', () => {
  test("a typo'd type is rejected rather than falling through to itemId", () => {
    // 'stlye' would previously reach the itemId branch and grant whatever it
    // named. Narrow now that ids are checked, but it is one character from a
    // real bug and the fix is a list.
    const problems = validateOfferContents(
      offer({contents: [{type: 'stlye', itemId: 'style_roof_tile_gold'} as never]}),
      REAL_IDS,
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/stlye/);
  });

  test('the three real types are all accepted', () => {
    for (const [type, itemId] of [
      ['style', 'style_roof_tile_gold'],
      ['character', 'char_gardener'],
    ] as const) {
      expect(validateOfferContents(offer({contents: [{type, itemId}]}), REAL_IDS)).toEqual([]);
    }
    expect(validateOfferContents(offer({contents: [{type: 'sponges', amount: 1}]}), REAL_IDS)).toEqual([]);
  });

  // W2-48. The pyjama duck was wearable, ownable and PROVEN WORN on a device
  // (#249, #256) while still absent from SEED_ITEMS — so this very validator,
  // the thing that makes the shop safe, was the only reason the launch offer
  // could not name it. Adding the row is what makes it nameable.
  //
  // KEY: Both halves, because only the pair is evidence: accepting the new id
  // proves the row landed, and refusing a fabricated one proves the guard was
  // not loosened to get there. A test that only asserted the first would pass
  // just as well against a validator that accepted everything.
  describe('char_pyjama is offerable now that it is seeded', () => {
    test('an offer naming char_pyjama validates clean', () => {
      expect(
        validateOfferContents(
          offer({contents: [{type: 'character', itemId: 'char_pyjama'}]}),
          REAL_IDS,
        ),
      ).toEqual([]);
    });

    test('a fabricated id is still refused', () => {
      const problems = validateOfferContents(
        offer({contents: [{type: 'character', itemId: 'char_pyjamas'}]}),
        REAL_IDS,
      );
      expect(problems.length).toBeGreaterThan(0);
      expect(problems[0]).toMatch(/char_pyjamas/);
    });
  });
});
