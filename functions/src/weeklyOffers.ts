// ---------------------------------------------------------------------------
// Bundled weekly offer pool
//
// rotateWeeklyOffer reads `shopConfig/weeklyOffers` every Monday at 00:00 UTC
// and writes the selected offer to `shop/current.weeklyOffer`. That config
// document is hand-seeded, and in production it was never seeded at all:
//
//   2026-08-03T00:00:03Z  rotateWeeklyOffer: no offers configured in
//                         shopConfig/weeklyOffers
//
// so `shop/current` has only the dailyChests rotateMarket writes, and the
// premium offer card renders WeeklyOffer.fromJson({}) — $0.00, no contents, and
// an endsAt of DateTime.now() that reads as expired on arrival ("Refreshing...").
//
// This is the same defect class as the unseeded `items` collection that
// dead-ended orientation, and it gets the same remedy: the offers ship inside
// the function bundle, so a deploy is sufficient and no manual seeding step is
// load-bearing. `shopConfig/weeklyOffers` still wins when it is populated, so
// offers can be rotated or hot-fixed without a deploy.
//
// Adding entries here rotates them: rotateWeeklyOffer picks
// `offers[weekNumber % offers.length]`, so N entries cycle on an N-week loop.
// A single entry means one recurring offer, which is still buyable once per
// weekly window — the purchase key combines the id with `startsAt`
// (weeklyOfferPurchaseKey, index.ts:209).
//
// `startsAt` / `endsAt` are deliberately absent: rotateWeeklyOffer generates
// them server-side and overrides anything supplied here.
// ---------------------------------------------------------------------------

export interface WeeklyOfferContent {
  /// One of 'sponges' | 'style' | 'furniture' | 'character'.
  /// premium_offer_card.dart switches on this to pick an icon.
  type: string;
  /// Set for `sponges` rows — the number granted.
  amount?: number;
  /// Set for item rows — must be a real id from SEED_ITEMS in itemPool.ts,
  /// because verifyIapAndGrant writes it straight into the user's inventory.
  itemId?: string;
}

export interface WeeklyOfferConfig {
  /// Dedup key for purchases. Required — rotateWeeklyOffer throws without it.
  id: string;
  title: string;
  /// 🔴 THERE IS DELIBERATELY NO PRICE FIELD ON THIS INTERFACE. W2-176, on
  /// Brendan's ruling 2026-09-13: "Read the real price from the store. Stop
  /// carrying a written-in 2.99."
  ///
  /// The server has no authority over what Apple charges. A number here and a
  /// number in App Store Connect are two values in two systems with nothing
  /// making them one, and that is not a drift to be guarded — it is a second
  /// number that should not exist. The client reads `displayPrice` off the
  /// resolved StoreKit product (premium_offer_card.dart `_priceLabel`), which
  /// is also the only source that is right for a player charged in GBP.
  ///
  /// ⚠️ THE GUARD THAT USED TO LIVE HERE WAS THE DEFECT'S OWN ALIBI.
  /// `offerIntegrity.test.ts` compared this number against
  /// ios/Configuration.storekit and passed, which made a believed price look
  /// verified. Both the field and that comparison are gone; two tests in that
  /// file now fail if either comes back.
  ///
  /// 📌 A hand-seeded `shopConfig/weeklyOffers` document can STILL smuggle one
  /// through: `rotateWeeklyOffer` spreads `{...offer}` and that path is typed
  /// `DocumentData`, so this interface does not police it. Surfaced in the
  /// W2-176 return, deliberately not fixed here — index.ts was out of scope.
  currency: string;
  /// 🔴 MUST EXIST IN APP STORE CONNECT, or the client throws
  /// `Product not found: <id>` (shop_purchase_provider.dart:76) before any
  /// callable is reached. StoreKit resolves by EXACT id.
  ///
  /// ⚠️ THE PREVIOUS VERSION OF THIS LINE SAID "as a NON-CONSUMABLE" AND THAT
  /// WAS WRONG IN BOTH HALVES. The real product is a CONSUMABLE — and a
  /// consumable is CORRECT, because this offer ROTATES: a non-consumable can be
  /// bought once ever, so a player could never buy a second week's bundle. The
  /// old comment encoded an assumption that was never true of a rotating offer.
  ///
  /// 📌 AND THE TYPE WAS NEVER THE THING THAT THREW. On iOS `buyConsumable`
  /// DELEGATES to `buyNonConsumable` (recorded at shop_purchase_provider.dart
  /// :203), so the two calls are identical there; the throw is the id not
  /// resolving. The type still matters for repeat purchases and for Android,
  /// which is why the caller now asks for a consumable.
  iapProductId: string;
  contents: WeeklyOfferContent[];
  heroImageUrl: string;
}

export const WEEKLY_OFFERS: WeeklyOfferConfig[] = [
  {
    id: 'offer_seed_001',
    title: 'Spring Bundle',
    // 🔴 NO PRICE. Removed 2026-09-13 (W2-176) rather than corrected.
    //
    // The history is worth keeping because it is the argument for the removal:
    // this seed said 9.99 while the reference art drew 2.99, for months, and
    // nothing compared them. #415 changed the number to 2.99 so the data agreed
    // with the art — and the file's own comment still had to admit, in capitals,
    // that it was "STILL UNCONFIRMED AGAINST THE PRICE APPLE CHARGES."
    //
    // Two corrections in, the number was still a belief. The class of defect is
    // not a wrong value, it is a second copy of a value we do not own, so the
    // copy is gone. `iapProductId` below is the whole contract: it names the
    // product, and StoreKit answers for what it costs.
    currency: 'USD',
    // 🔴 THE REAL APP STORE CONNECT ID. `premium_offer_spring` was a
    // placeholder that existed NOWHERE — 0 hits outside this repo's own
    // references — so `queryProductDetails` returned it in `notFoundIDs` and
    // the client threw before reaching any callable. A Product ID is IMMUTABLE
    // once created and this one is already In Review, so the code moves.
    iapProductId: 'PremiumOffer_3',
    contents: [
      { type: 'sponges', amount: 500 },
      { type: 'style', itemId: 'style_roof_tile_gold' },
      { type: 'character', itemId: 'char_gardener' },
    ],
    heroImageUrl: '',
  },
];

// ---------------------------------------------------------------------------
// Offer content validation — W2-39
// ---------------------------------------------------------------------------
//
// 🔴 THE DEFECT THIS CLOSES: `verifyIapAndGrant` validates NOTHING about
// `contents[].itemId`. index.ts pushes the string straight into
// `grantedItems` and writes `users/{uid}/inventory/{itemId}`. SEED_ITEMS
// appears zero times in the whole grant path.
//
// So an offer naming an item that does not exist does not FAIL — it SUCCEEDS.
// The player pays real money and receives an inventory row pointing at nothing.
// No throw, no log, no refund path.
//
// ⚠️ An unknown id in a LAYOUT is silently SKIPPED — an emptier house. An
// unknown id in a GRANT is silently WRITTEN — a paid-for nothing. Same class of
// bug, and only one of them takes money.
//
// 🔑 VALIDATED AT WRITE TIME, NOT AT GRANT TIME, and the difference is the whole
// design: catching it at rotation is free, catching it at purchase is a refund.
// A grant-side throw would also punish the wrong person — it cannot distinguish
// "this offer is malformed" from "this player owns something the pool no longer
// lists", and a purchase that succeeded yesterday must not start failing today.
//
// ⚠️ VALIDATING AT ROTATION IS NECESSARY BUT NOT SUFFICIENT. `shop/current` has
// THREE writers: rotateMarket (dailyChests only), rotateWeeklyOffer, and
// seedShopData — which wrote its own hardcoded copy of the offer, bypassing
// rotation entirely. That copy is now deleted and both paths import WEEKLY_OFFERS
// and call this function, which is why the duplicate had to go rather than
// merely be gated.

/**
 * The only content types the grant path understands.
 *
 * ⚠️ verifyIapAndGrant branches `if type === 'sponges' … else if content.itemId`,
 * so an UNKNOWN type does not error — it falls through to the itemId branch and
 * grants whatever that names. `'stlye'` is one keystroke from `'style'` and
 * would have granted silently. Narrow now that ids are checked, but it costs a
 * list to close.
 */
export const OFFER_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'sponges',
  'style',
  'character',
]);

/** A problem found in an offer, phrased for a log a human reads. */
export type OfferProblem = string;

/**
 * Returns every problem with [offer], or an empty array when it is sound.
 *
 * Returns rather than throws so a caller can log ALL the problems at once —
 * an offer with two bad ids should not need two deploys to discover.
 *
 * @param knownItemIds every id the grant could resolve. Pass the real
 *   SEED_ITEMS ids; the parameter exists so a test can inject a pool and so
 *   this module does not import the item pool (which imports nothing, but the
 *   dependency would be the wrong direction).
 */
export function validateOfferContents(
  offer: WeeklyOfferConfig,
  knownItemIds: ReadonlySet<string>,
): OfferProblem[] {
  const problems: OfferProblem[] = [];

  if (!offer.id) problems.push('missing id — the dedup key');
  if (!offer.iapProductId) problems.push('missing iapProductId');
  if (!Array.isArray(offer.contents)) {
    problems.push('contents is not an array');
    return problems;
  }
  if (offer.contents.length === 0) {
    problems.push('contents is empty — a purchase that grants nothing');
  }

  for (const [i, content] of offer.contents.entries()) {
    if (!OFFER_CONTENT_TYPES.has(content.type)) {
      problems.push(
        `contents[${i}]: unknown type '${content.type}' — the grant would fall ` +
          'through to the itemId branch and grant it anyway',
      );
      continue;
    }
    if (content.type === 'sponges') {
      // A sponge grant with no amount is the same class of bug: it succeeds
      // and gives nothing.
      if (!content.amount || content.amount <= 0) {
        problems.push(`contents[${i}]: sponges with no positive amount`);
      }
      continue;
    }
    if (!content.itemId) {
      problems.push(`contents[${i}]: type '${content.type}' with no itemId`);
      continue;
    }
    if (!knownItemIds.has(content.itemId)) {
      // 🔴 THE ONE THAT TAKES MONEY.
      problems.push(
        `contents[${i}]: itemId '${content.itemId}' is in no seed pool — ` +
          'a purchase would grant an inventory row pointing at nothing',
      );
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// W2-164 — THE WINDOW THE PATCH SCRIPT COULD NOT SEE
// ---------------------------------------------------------------------------
//
// `patch-weekly-offer.js` decided "NOTHING TO DO" by comparing PRICE and
// PRODUCT ID, and the two fields that decide whether a player SEES the offer are
// `startsAt` and `endsAt`. Its dry run never printed them either, so the operator
// running it to CHECK got the same blind answer as the operator running it to FIX.
//
// 🔴 AND THE WINDOW CANNOT BE PATCHED FROM THE SEED, WHICH IS WHY THIS IS A
// REPORT AND NOT A REPAIR. `WEEKLY_OFFERS` carries no `startsAt`/`endsAt` at all
// — deliberately, per the header above: `rotateWeeklyOffer` generates them
// server-side and overrides anything supplied here. So there is no seed value to
// patch a live window TO, and inventing one in the script would put a third
// author on a field the cron owns.
//
// 🔑 THE HAZARD RUNS THE OPPOSITE WAY FROM THE OBVIOUS ONE, AND IT IS MEASURED
// RATHER THAN REASONED. The worry was that a patch would stomp a live window
// back to a stale seed value. It cannot: Firestore's `{merge: true}` DEEP-MERGES
// a nested map, so writing `{weeklyOffer: seed}` leaves `startsAt`/`endsAt`
// exactly as they were. Measured against the Firestore emulator on 2026-08-30:
//
//     before  {id:'live', price:9.99, startsAt:'LIVE-START', endsAt:'LIVE-END'}
//     write   set({weeklyOffer:{id:'seed', price:2.99}}, {merge:true})
//     after   {startsAt:'LIVE-START', endsAt:'LIVE-END', price:2.99, id:'seed'}
//
// ⚠️ WHICH MEANS A SUCCESSFUL PATCH CAN LEAVE THE OFFER INVISIBLE. The price and
// the product id are corrected, the old window survives the merge, and if that
// window has closed the player still sees nothing — while the script prints "OK
// — the live offer now matches the seed". A green that is silent about a field
// it never looked at is the defect this exists to remove.

/** Where a live offer's window sits relative to now. */
export type OfferWindowState =
  /** Both bounds present and `startsAt <= now < endsAt` — a player can see it. */
  | 'open'
  /** `endsAt` has passed. The card is invisible however correct its price is. */
  | 'expired'
  /** `startsAt` is in the future. Also invisible, for the opposite reason. */
  | 'not-yet-open'
  /** One or both bounds missing — what an unrotated `shop/current` looks like. */
  | 'absent'
  /** Present but undecodable, or `endsAt <= startsAt`. Never assumed benign. */
  | 'malformed';

/**
 * Milliseconds from the several shapes a stored timestamp arrives in.
 *
 * 📌 The same subset `weeklyOfferPurchaseKey` already decodes (index.ts:610):
 * a Firestore `Timestamp` exposes `toMillis()`, the emulator suites use a plain
 * number, and a hand-seeded document may carry an ISO string. Returns null
 * rather than NaN, so an undecodable value reports as `malformed` instead of
 * silently comparing false.
 */
export function offerTimestampMillis(value: unknown): number | null {
  if (value == null) return null;
  if (typeof (value as {toMillis?: unknown}).toMillis === 'function') {
    const ms = (value as {toMillis: () => number}).toMillis();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Whether a player can see [offer] at [nowMs].
 *
 * Pure, and takes the clock as a parameter — the same shape `planFamilyFanOut`
 * uses, and for the same reason: a test can pin every boundary without waiting.
 */
export function offerWindowState(
  offer: {startsAt?: unknown; endsAt?: unknown} | null | undefined,
  nowMs: number,
): OfferWindowState {
  if (offer == null) return 'absent';
  const startsAt = offerTimestampMillis(offer.startsAt);
  const endsAt = offerTimestampMillis(offer.endsAt);
  // Distinguishes "the field is not there" from "the field is there and
  // unreadable". The first is an unrotated document; the second is corruption,
  // and reporting them the same way would hide the one that needs a human.
  const missing = offer.startsAt == null || offer.endsAt == null;
  if (missing) return 'absent';
  if (startsAt === null || endsAt === null) return 'malformed';
  if (endsAt <= startsAt) return 'malformed';
  if (nowMs < startsAt) return 'not-yet-open';
  // `<` on the upper bound, matching the cron: `endsAt` is next Monday midnight,
  // which is the NEXT window's `startsAt`. An offer that is exactly used up is
  // used up — the same `<=` boundary planFamilyFanOut pins on the other side.
  if (nowMs >= endsAt) return 'expired';
  return 'open';
}

/** True only for a state in which a player can actually see the offer. */
export function offerIsVisible(state: OfferWindowState): boolean {
  return state === 'open';
}

/** One line of operator-facing English for [state]. */
export function offerWindowExplanation(state: OfferWindowState): string {
  switch (state) {
    case 'open':
      return 'the window is open — a player can see this offer now';
    case 'expired':
      return 'the window has CLOSED — the card is invisible however correct its price is';
    case 'not-yet-open':
      return 'the window has NOT OPENED yet — the card is invisible until startsAt';
    case 'absent':
      return 'there is NO window on the live document — this is what an unrotated shop/current looks like';
    case 'malformed':
      return 'the window is PRESENT BUT UNREADABLE (undecodable, or endsAt <= startsAt)';
  }
}
