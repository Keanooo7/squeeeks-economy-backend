// functions/src/__tests__/productRegistry.test.ts
//
// W2-89. EVERY product id the backend believes in must exist somewhere it can
// be bought.
//
// ---------------------------------------------------------------------------
// CRITICAL: WHY THIS EXISTS: THE SAME BUG, TWICE, ONE FLOOR APART
// ---------------------------------------------------------------------------
//
// #415 found `premium_offer_spring` — a weekly-offer product id that existed
// NOWHERE. StoreKit resolves by exact id, so `queryProductDetails` returned it
// in `notFoundIDs` and the client threw `Product not found` before reaching any
// callable. The fix added a check that every WEEKLY_OFFERS id is registered.
//
// That check was too narrow, and the narrowness had a cost that was already
// being paid: `FAMILY_PRODUCT_ID` is `sub_family_monthly`, which this gate found
// registered NOWHERE the repo could see.
//
// NOTE: CORRECTED 2026-08-24. This paragraph used to end "and App Store Connect has
// never had it … the level the family plan would occupy is EMPTY". That was
// wrong, and wrong in the direction that costs the most work: the product had
// existed in ASC the whole time — Apple ID 6801924400, sitting at level 4 and
// left unconfigured (Projects/Cleaning/appstore-connect-facts.md:37,39). The
// repo could not see it, and every brief built on "only Brendan can create it"
// was reasoning from this comment. A gate may say "I cannot find this"; it may
// not promote that into "it does not exist."
//
// KEY: AND THE FAMILY FAILURE IS QUIETER THAN THE SHOP ONE, WHICH IS WHY IT
// SURVIVED LONGER. A missing shop product THROWS at the client. A missing
// subscription product throws nothing: `planFamilyFanOutForEffect` returns `[]`
// unless `effect.productId === FAMILY_PRODUCT_ID`, so no notification for that
// product ever arrives, the fan-out never runs, and NOBODY IS EVER GRANTED
// ANYTHING. Every family callable succeeds. Every test passes. The entitlement
// simply never happens.
//
// ---------------------------------------------------------------------------
// THE BELIEVED SET IS DERIVED FROM THE CODE, NEVER RETYPED
// ---------------------------------------------------------------------------
//
// WARNING: A HAND-WRITTEN LIST OF "ids the backend uses" RECREATES THE BUG INSIDE THE
// GATE: the same typo, the same omission, and a green suite either way. So the
// importable constants are IMPORTED — a rename that breaks the import fails to
// compile rather than silently parsing to an empty set — and the one table that
// is function-local is parsed from source under an anchor, with a count assert
// so a moved literal cannot quietly contribute nothing.

import * as fs from 'fs';
import * as path from 'path';

import {SUBSCRIPTION_PRODUCT_TIERS} from '../appStoreNotifications';
import {FAMILY_PRODUCT_ID} from '../family';
import {WEEKLY_OFFERS} from '../weeklyOffers';

const REPO = path.resolve(__dirname, '../../..');

/**
 * Products the app can actually buy, from the one machine-readable registry
 * this repo has.
 *
 * NOTE: `ios/Configuration.storekit` is a proxy for App Store Connect, not a copy
 * of it — it is what the SIMULATOR serves. It is the best available registry
 * and its limits are stated in the ledger below rather than assumed away.
 */
function registryIds(): Set<string> {
  const cfg = JSON.parse(
    fs.readFileSync(path.join(REPO, 'ios', 'Configuration.storekit'), 'utf8'),
  ) as {
    products: {productID: string}[];
    subscriptionGroups: {subscriptions: {productID: string}[]}[];
  };
  return new Set([
    ...cfg.products.map((p) => p.productID),
    ...cfg.subscriptionGroups.flatMap((g) => g.subscriptions.map((s) => s.productID)),
  ]);
}

/**
 * The sponge packs, parsed from `index.ts`.
 *
 * WARNING: PARSED RATHER THAN IMPORTED BECAUSE `SPONGE_PACKS` IS FUNCTION-LOCAL. That
 * is a weaker link than the imports above and is fenced accordingly: anchored
 * to the declaration, and asserted to find exactly three, so a moved or renamed
 * table fails LOUD instead of contributing an empty set to a check about
 * completeness.
 */
function spongePackIds(): string[] {
  const source = fs.readFileSync(path.join(REPO, 'functions', 'src', 'index.ts'), 'utf8');
  const anchor = 'const SPONGE_PACKS: Record<string, number> = {';
  const start = source.indexOf(anchor);
  expect(`SPONGE_PACKS anchor found in index.ts: ${start >= 0}`).toBe(
    'SPONGE_PACKS anchor found in index.ts: true',
  );
  const end = source.indexOf('};', start);
  const ids = [...source.slice(start, end).matchAll(/(\w+):\s*\d+/g)].map((m) => m[1]);
  expect(`sponge packs parsed: ${ids.length}`).toBe('sponge packs parsed: 3');
  return ids;
}

/**
 * Every product id the backend believes a player can buy, mapped to EVERY place
 * that believes it.
 *
 * KEY: ALL SOURCES, NOT THE LAST ONE. An earlier draft used a last-wins map and
 * the live red named only `SUBSCRIPTION_PRODUCT_TIERS` for `sub_family_monthly`
 * — while `FAMILY_PRODUCT_ID` believes in it too, and fixing the product means
 * touching BOTH. A gate that names one of two sites sends the reader to do half
 * the work and call it done.
 */
function believedIds(): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  const add = (id: string, source: string) => {
    const sources = byId.get(id) ?? [];
    sources.push(source);
    byId.set(id, sources);
  };

  add(FAMILY_PRODUCT_ID, 'FAMILY_PRODUCT_ID (family.ts)');
  for (const id of Object.keys(SUBSCRIPTION_PRODUCT_TIERS)) {
    add(id, 'SUBSCRIPTION_PRODUCT_TIERS (appStoreNotifications.ts)');
  }
  for (const offer of WEEKLY_OFFERS) {
    add(offer.iapProductId, `WEEKLY_OFFERS[${offer.id}] (weeklyOffers.ts)`);
  }
  for (const id of spongePackIds()) add(id, 'SPONGE_PACKS (index.ts)');
  return byId;
}

/**
 * Believed but NOT registered — AND THAT IS A DEFECT, kept here so the omission
 * is visible and counted rather than blessed.
 *
 * KEY: Same construction as `KNOWN_UNREACHABLE` in moduleReachability.test.ts:
 * you cannot silence this gate by pasting an id, only by writing what breaks
 * because of it. Fixing one means creating the product or changing the code, not
 * deleting the entry.
 */
const KNOWN_MISSING: Record<string, string> = {
  // KEY: EMPTY, AND THAT IS THE POINT — the one entry EXPIRED BY ITS OWN TERMS.
  //
  // `sub_family_monthly` was ledgered as "THE FAMILY SUBSCRIPTION HAS NEVER
  // EXISTED … in neither ASC nor Configuration.storekit", and both clauses are
  // now false. Brendan's own console read
  // (Projects/Cleaning/appstore-connect-facts.md:37,39) shows it in App Store
  // Connect with Apple ID 6801924400, created before 2026-08-20 and simply left
  // unconfigured; #587 added it to Configuration.storekit. Every brief that said
  // "the product does not exist and only Brendan can create it" was wrong.
  //
  // The entry named its own expiry condition — "either Brendan creates the
  // subscription … or the family plan is funded by an existing product" — and
  // the first has happened. It is removed because that condition was MET, not
  // to quiet the gate; the assertion below caught it within hours of #587.
  //
  // WARNING: ONE THING IS STILL TRUE AND DELIBERATELY NOT PARKED HERE. At status
  // "Prepare for Submission" the product will NOT be returned by StoreKit in
  // production (appstore-connect-facts.md:88) — it EXISTS but does not yet
  // RESOLVE. That is a store-readiness fact, not a missing-product one, and
  // writing it here would re-silence this gate with a ledger entry about
  // something the ledger is not for. It lives in appstore-connect-facts.md and
  // belongs to the store-readiness audit.
};

describe('🔴 every product id the backend believes in is registered', () => {
  test('🔑 ANTI-VACUITY — both sides are non-trivial', () => {
    // This gate's failure mode is finding NOTHING and passing EVERYTHING: an
    // empty believed set satisfies "all believed ids are registered", and an
    // empty registry would make every id look missing. Both are pinned.
    const believed = believedIds();
    const registry = registryIds();

    expect(believed.size).toBeGreaterThanOrEqual(6);
    expect([...believed.keys()]).toContain('sub_pro_monthly');
    expect([...believed.keys()]).toContain('sponge_pack_100');
    expect([...believed.keys()]).toContain('PremiumOffer_3');

    expect(registry.size).toBeGreaterThanOrEqual(6);
    expect([...registry]).toContain('sub_pro_annual');
  });

  test('🔴 every believed id is registered, or ledgered as missing', () => {
    const registry = registryIds();
    const missing = [...believedIds().entries()]
      .filter(([id]) => !registry.has(id))
      .map(([id, sources]) => `${id} (believed by ${sources.join(' + ')})`);

    const unledgered = missing.filter(
      (line) => !Object.keys(KNOWN_MISSING).some((id) => line.startsWith(`${id} `)),
    );

    expect(unledgered).toEqual([]);
  });

  test('🔴 the ledger has no STALE entries — a fixed product must leave it', () => {
    // The inverse direction, and the one that makes the ledger a gate rather
    // than a comment: when the product is finally created, this goes red and
    // asks for the entry to be removed. Without it the ledger would quietly
    // grant a permanent exemption to something already fixed — the same defect
    // moduleReachability catches with "does not exempt a module that is in fact
    // reachable".
    const registry = registryIds();
    const believed = believedIds();
    const stale = Object.keys(KNOWN_MISSING).filter(
      (id) => registry.has(id) || !believed.has(id),
    );
    expect(stale).toEqual([]);
  });

  test('every ledger entry states a consequence, not a shrug', () => {
    for (const [id, why] of Object.entries(KNOWN_MISSING)) {
      expect(`${id} reason length > 80: ${why.length > 80}`).toBe(
        `${id} reason length > 80: true`,
      );
    }
  });

  test('📌 the believed set names its SOURCE, so a red points at a file', () => {
    // A gate that says "sub_family_monthly is missing" without saying who
    // believes in it sends the reader hunting. Every entry carries the constant
    // and the file it came from.
    for (const [, sources] of believedIds()) {
      expect(sources.length).toBeGreaterThan(0);
      for (const source of sources) expect(source).toMatch(/\.ts\)$/);
    }
  });
});
