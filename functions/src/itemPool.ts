// ---------------------------------------------------------------------------
// Drop tables, rarity tiers, and the day's subject pools
// ---------------------------------------------------------------------------
//
// RARITY DECISION (W3-08, 2026-08-05) — three tiers, not four.
//
// Four vocabularies were in the tree at once: rollRarity emitted
// common/rare/epic/legendary, DROP_TABLES was keyed common/rare/epic, the Dart
// `Rarity` enum had five values, `ShopItemRarity` a different four, and
// Brendan's design sheet ("Design sheet for chests.md") three:
// common / rare / legendary.
//
// The design sheet wins, because it is the contract the ART is being built to.
// Every variant list in it — fox outfits, sofa finishes, exterior plant
// arrangements — is written in three tiers. `epic` was never a designed tier:
// it existed only as a middle row in a drop table and on three seed rows
// (style_roof_tile_gold, furn_neon_lamp, char_knight), all of which are now
// `legendary`. Shipping a fourth tier would mean inventing a tier of art
// nobody specced, so it is collapsed rather than filled.
//
// The Dart `Rarity` enum keeps five values — `RarityColors` switches on it
// exhaustively and removing values has a wide blast radius for no gain. The
// real guarantee is a test asserting no seed row ever maps to `Rarity.epic`
// or `Rarity.uncommon`: a tier with no art must be unreachable, not absent.
//
// ---------------------------------------------------------------------------
//
// SECOND DECISION — `chest.rarity` was doing two jobs, and one of them backwards.
//
// It was simultaneously the chest's own display tier AND the DROP_TABLES key,
// so `chest_epic` (the Styles chest) drew from the most generous table while
// `chest_common` (Characters) drew from the least. Part C of
// spec-2026-08-05-device-review-and-chest-rotation.md states the opposite
// ordering: characters = RAREST, styles = middle, furniture = MOST COMMON.
//
// The field is now split. `rarity` stays the chest's display tier for the shop
// card; `dropTable` names the generosity of the table it rolls against. The
// tables are keyed lean/mid/rich so a table name can never again be mistaken
// for a rarity.
//
// Everything below is a named exported const with no inline literals, per the
// device-review standing rule (A6): "make sure these features are built in
// agile so variables are not locked."

/// The three content rarities. This is the whole vocabulary — see the header.
import {
  SEED_ITEMS_GENERATED,
  ITEM_FAMILY_GENERATED,
  FAMILY_NEUTRAL_GENERATED,
} from './itemPool.generated';

export const RARITIES = ['common', 'rare', 'legendary'] as const;
export type Rarity = (typeof RARITIES)[number];

/// How generous a chest's roll is. Named for the generosity, not for a rarity,
/// because this used to be keyed by rarity strings and read as one.
export const DROP_TABLE_TIERS = ['lean', 'mid', 'rich'] as const;
export type DropTableTier = (typeof DROP_TABLE_TIERS)[number];

/// Cumulative thresholds against a uniform [0,1) roll: [P(common), P(<=rare)].
/// Anything at or above the second threshold is legendary. Two thresholds for
/// three outcomes — a third entry would be dead weight pinned at 1.00.
///
/// 🔴 RE-CENTRED 2026-09-03 ON BRENDAN'S RULING. He asked for legendary 22% ·
/// rare 33% · common 45%, server-authoritative. That is ONE set of numbers and
/// there are THREE tables keyed by generosity, so it could not simply replace
/// them; his ruling was to make it `mid` and rebuild `lean` and `rich` around
/// the new centre.
///
///                 common  rare  legendary        was
///   lean  furniture   75    14     11        80 / 18 /  2
///   mid   styles      45    33     22        50 / 44 /  6   <- Brendan's number
///   rich  characters  15    52     33        20 / 60 / 20
///
/// 🔑 THE RULE, NOT THE DIGITS. `common` steps by 30 centred on 45 — the ladder
/// already stepped by 30 (80/50/20) — and `legendary` steps by 11 centred on his
/// 22; `rare` is the remainder. Both free dimensions are arithmetic progressions
/// and `mid` is exactly what he asked for, so the numbers are derived rather
/// than picked. It was put to him as a rule he could reject, not nine digits to
/// argue. Monotone in all three tiers, as before.
///
/// 📌 WHY `lean` MOVES SO LITTLE AND WHY THAT IS NOT TIMIDITY. Only six subjects
/// are in rotation (`DAILY_SUBJECT_POOLS`), and `sofa` and `tv_stand` hold
/// exactly ONE item at rare AND at legendary — so on those subjects every roll
/// outside `common` is a forced duplicate once owned. Dropping lean's rare 18→14
/// removes more forced-duplicate mass than raising legendary 2→11 adds: measured
/// over 6,000 trials against the real cells, first-legendary moves from chest 21
/// to chest 6 (46% → 97% of players seeing one in 30 chests) while the duplicate
/// rate goes DOWN 1.3 points. A flat 45/33/22 on all three would instead cost
/// +10 points of duplicate rate on furniture.
///
/// ⚠️ MIRRORED IN `lib/features/shop/domain/chest_drop_rates.dart` AND THAT
/// MIRROR IS NOW GATED: `__tests__/dropTableMirror.test.ts` reads the Dart file
/// off disk and compares it to this table. Before it existed (#693, 2026-09-03)
/// a one-threshold change here reddened nothing — 1652 passed, exit 0 — while
/// the app advertised odds the server did not roll. Move both sides in ONE
/// commit; there is no order in which they land separately with `main` green.
export const DROP_TABLES: Record<DropTableTier, [number, number]> = {
  lean: [0.75, 0.89],
  mid:  [0.45, 0.78],
  rich: [0.15, 0.67],
};

/// The chest-type rarity ordering from Part C: characters are the rarest chest
/// type and so roll the richest table; furniture is the most common and rolls
/// the leanest.
export const CHEST_CATEGORY_DROP_TABLE: Record<string, DropTableTier> = {
  characters: 'rich',
  styles:     'mid',
  furniture:  'lean',
};

/**
 * Sponge price per chest category. **One source, deliberately.**
 *
 * These were written twice — inline in `rotateMarket` and again in
 * `seedShopData` — as hand-maintained copies of each other. That was invisible
 * while all three cost 100 and would have surfaced only after the first
 * midnight rotation, as a seeded environment disagreeing with a rotated one.
 * The repo has been bitten by this shape before; `chest_drop_rates.dart:8-12`
 * says so about itself.
 *
 * A test asserting the two copies agree would leave the duplication in place.
 * Removing the second copy is the stronger fix: they cannot drift because
 * there is only one of them.
 *
 * Prices set 2026-08-11 on Brendan's instruction: characters 500, styles 250.
 * Furniture was not named and stays at 100.
 */
export const CHEST_PRICE: Record<string, number> = {
  characters: 500,
  styles: 250,
  furniture: 100,
};

export function rollRarity(dropTable: string): Rarity {
  const roll = Math.random();
  const thresholds =
    DROP_TABLES[dropTable as DropTableTier] ?? DROP_TABLES['lean'];
  if (roll < thresholds[0]) return 'common';
  if (roll < thresholds[1]) return 'rare';
  return 'legendary';
}

/**
 * What a duplicate pays back, as a fraction of what the chest cost.
 *
 * Brendan, 2026-08-29: *"should give you 75% of the sponges it cost to open the
 * chest."* Written as a fraction over `CHEST_PRICE` rather than as a second
 * table of numbers, for the reason `CHEST_PRICE`'s own docblock gives above:
 * two hand-maintained copies of the same economy drift, and the drift stays
 * invisible until someone changes a price.
 */
export const DUPLICATE_REFUND_FRACTION = 0.75;

/**
 * Sponges paid back when a chest grants an item the player already owns.
 *
 * 🔴 KEYED BY CATEGORY, NOT BY RARITY. This replaced a `Record<Rarity, number>`
 * of flat values (common 10 / rare 25 / legendary 100), and the re-key is the
 * point rather than a tidy-up: a refund keyed on rarity **cannot** express "75%
 * of what it cost", because rarity is what the chest ROLLED and price is what
 * the player PAID. The same legendary costs 500 out of a characters chest and
 * 100 out of a furniture one; the old table paid 100 for both — 20% of one
 * purchase and a 100% rebate on the other.
 *
 * 📌 `Math.floor`, deliberately. 250 * 0.75 = 187.5 and a sponge balance is an
 * integer. Flooring loses at most one sponge per duplicate, in the house's
 * favour; rounding up would let a repeated duplicate drift the economy in the
 * player's favour without anyone choosing that. Pinned in chestPricing.test.ts.
 */
export const DUPLICATE_REFUNDS: Record<string, number> = Object.fromEntries(
  Object.entries(CHEST_PRICE).map(([category, price]) => [
    category,
    Math.floor(price * DUPLICATE_REFUND_FRACTION),
  ]),
);

/**
 * `CHEST_CATEGORY_DROP_TABLE` inverted: which category a drop-table tier belongs
 * to.
 *
 * Needed because two chests that pay a refund carry no category at all. The
 * Gibby daily gift is drawn against `GIBBY_CHEST_DROP_TABLE` ('mid'), and a
 * pending chest freezes `dropTable` at mint time. The mapping is 1:1 today —
 * rich/mid/lean against characters/styles/furniture — so inverting it derives a
 * price rather than inventing one.
 *
 * ⚠️ IT IS ONLY 1:1 WHILE NO TWO CATEGORIES SHARE A TIER. If a fourth category
 * ever reuses a tier, this silently keeps whichever category was declared last
 * and the other one's refund becomes wrong. `chestPricing.test.ts` asserts the
 * inversion is total and lossless so that day is a red test, not a quiet
 * mispayment.
 */
export const DROP_TABLE_CATEGORY: Record<string, string> = Object.fromEntries(
  Object.entries(CHEST_CATEGORY_DROP_TABLE).map(([category, tier]) => [tier, category]),
);

/**
 * The refund for a chest whose actual price is known — 75% of what was paid.
 *
 * 🔑 THIS IS THE PRIMARY FORM, AND THE PURCHASE PATH USES IT. Brendan asked for
 * "75% of the sponges it cost to open the chest", and a bought chest knows
 * exactly what it cost: the price is read off the shop document inside the
 * transaction. Deriving from the CATEGORY there would be a second lookup of a
 * number already in hand, and it would pay the LIST price back on a chest sold
 * at some other price — a discount or a promo would refund more than it charged.
 *
 * `DUPLICATE_REFUNDS` below is the fallback for the chests that genuinely have
 * no price: quest payouts, the daily gift, and admin grants. Both go through
 * `DUPLICATE_REFUND_FRACTION`, so the two forms cannot drift apart.
 */
export function refundForPrice(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 0;
  return Math.floor(price * DUPLICATE_REFUND_FRACTION);
}

/** The refund for a chest of `category`, or 0 when the category is unknown. */
export function refundForCategory(category: string | undefined | null): number {
  if (typeof category !== 'string') return 0;
  return DUPLICATE_REFUNDS[category] ?? 0;
}

/**
 * The refund for a chest that knows only which drop table it rolled against.
 *
 * Returns 0 rather than guessing when the tier does not invert — a chest whose
 * price cannot be derived is an unpriced chest, the same stance the purchase
 * path takes when `txChest.price` is missing.
 */
export function refundForDropTable(tier: string | undefined | null): number {
  if (typeof tier !== 'string') return 0;
  return refundForCategory(DROP_TABLE_CATEGORY[tier]);
}

/**
 * Total sponges owed for the duplicates in a batch of unpriced chest grants.
 *
 * Extracted as a pure function so the wiring has a gate. Inline in the quest
 * transaction it was reachable only through the emulator suite, which meant a
 * mutation to it reddened nothing in `npm test` — and a gate nothing can turn
 * red is not a gate.
 *
 * A grant with no category, or one naming a category with no price, pays 0
 * rather than a guessed amount — the same stance the purchase path takes on a
 * chest with no price.
 */
export function sumDuplicateRefunds(
  grants: readonly {category?: string | null; itemId?: string | null}[],
  ownedIds: ReadonlySet<string>,
): number {
  return grants.reduce((sum, grant) => {
    if (typeof grant.itemId !== 'string' || !ownedIds.has(grant.itemId)) return sum;
    return sum + refundForCategory(grant.category);
  }, 0);
}

// ---------------------------------------------------------------------------
// The duplicate rate is a property of the DRAW, not of the drop table
// ---------------------------------------------------------------------------
//
// Before W2-161 there was no duplicate probability anywhere in this codebase.
// `pickChestItem` filtered SEED_ITEMS on (rarity, subject) and picked uniformly
// with NO ownership filter, so the duplicate rate was whatever the player's
// collection happened to make it — structurally common, and approaching 100%
// for anyone engaged enough to have finished a cell.
//
// 🔑 SO THE TARGET CANNOT BE REACHED BY TUNING `DROP_TABLES`. The drop table
// chooses a RARITY; it has no idea what the player owns. The bias has to live in
// the pick itself, which is what `pickWithDuplicateBias` is.
//
// 🔴 AND IT CANNOT BE REACHED AT ALL IN MOST CELLS. Measured 2026-08-29 over the
// bundled pool: 192 items in 84 (subject, rarity) cells, sizes min 1 / max 6,
// histogram {1:45, 2:6, 3:1, 4:29, 5:2, 6:1}. **45 of 84 cells hold exactly one
// item.** In those the rate is binary — 0% until the player owns it, 100% every
// roll after — and no weighting can move it, because there is nothing else in
// the cell to move it to.
//
// What is therefore implemented, and what the player-facing copy must say, is
// NOT "5% of chests are duplicates". It is: **when a chest could go either way,
// it goes duplicate 5% of the time.** When the cell is exhausted the duplicate
// is unavoidable, and it is paid for instead of prevented.

/**
 * The duplicate rate to aim for when the draw actually has a choice.
 *
 * 5% sits between the Styles legendary rate (6%) and Furniture's (2%), so a
 * duplicate is about as rare as the rarest thing a chest can hand you — which
 * is what "as rare as a legendary skin" was asking for.
 */
export const TARGET_DUPLICATE_RATE = 0.05;

/** Split a candidate cell into what the player does and does not already hold. */
export function partitionByOwnership<T>(
  cell: readonly T[],
  ownedIds: ReadonlySet<string>,
  idOf: (item: T) => string,
): { unowned: T[]; owned: T[] } {
  const unowned: T[] = [];
  const owned: T[] = [];
  for (const item of cell) {
    (ownedIds.has(idOf(item)) ? owned : unowned).push(item);
  }
  return { unowned, owned };
}

/**
 * Pick from a partitioned cell, biased so a duplicate lands at
 * `TARGET_DUPLICATE_RATE` whenever both outcomes are actually available.
 *
 * `forcedDuplicate` distinguishes the two ways a duplicate can happen, and the
 * distinction is the honest half of this feature: `false` means the draw CHOSE a
 * duplicate at the target rate, `true` means the cell was exhausted and there was
 * nothing else to hand over. Only the second one makes the odds copy a lie, so
 * only the second one is worth surfacing.
 *
 * ⚠️ `rng` is injected so a test can pin the boundary rather than sample it. A
 * test that only samples cannot tell 5% from 4% without tens of thousands of
 * draws, and one that samples at that size is slow enough to get deleted.
 */
export function pickWithDuplicateBias<T>(
  unowned: readonly T[],
  owned: readonly T[],
  rng: () => number = Math.random,
): { item: T; isDuplicate: boolean; forcedDuplicate: boolean } {
  if (unowned.length === 0 && owned.length === 0) {
    // The callers all throw `not-found` on an empty cell before reaching here.
    // This is the assertion that says so out loud rather than returning
    // `undefined` as a T and failing somewhere further downstream.
    throw new Error('pickWithDuplicateBias called with an empty cell');
  }
  if (owned.length === 0) {
    return { item: uniform(unowned, rng), isDuplicate: false, forcedDuplicate: false };
  }
  if (unowned.length === 0) {
    // 🔴 THE EXHAUSTED CELL — 45 of 84 cells reach this the moment their single
    // item is owned. The duplicate is unavoidable, so it is paid, not prevented.
    return { item: uniform(owned, rng), isDuplicate: true, forcedDuplicate: true };
  }
  const drawsDuplicate = rng() < TARGET_DUPLICATE_RATE;
  return drawsDuplicate
    ? { item: uniform(owned, rng), isDuplicate: true, forcedDuplicate: false }
    : { item: uniform(unowned, rng), isDuplicate: false, forcedDuplicate: false };
}

function uniform<T>(pool: readonly T[], rng: () => number): T {
  return pool[Math.floor(rng() * pool.length)];
}

// ---------------------------------------------------------------------------
// Daily subject pools
// ---------------------------------------------------------------------------
//
// A chest is themed on ONE subject per day and drops a variant of it. Before
// W3-08, pickChestItem filtered by rarity alone, so a Character chest could
// grant a sofa. `subject` is the filter that makes a themed rotation possible;
// every SeedItem carries one.
//
// The pools are the subjects a category is allowed to draw on for a given day.
// Adding a subject here is how a new day-one set enters the rotation.
//
// 🔑 A SUBJECT ONLY ENTERS THE POOL WHEN IT IS STOCKED AT EVERY RARITY.
// This is enforced by dailyRotation.test.ts and it is not a nicety: once a
// chest is themed, `pickChestItem` filters on (subject, rarity), so a subject
// missing its legendary throws `not-found` on every roll that reaches the tail
// — 20% of purchases on the characters chest — and the player is refused a
// chest they can see and afford. Theming turned a pool that was dense by
// rarity alone into a sparse grid, and this rule is what keeps the grid full.
//
// ⚠️ ADDING A SUBJECT DIVIDES THE EXISTING ONES' ROTATION. subjectForDay
// picks `pool[dayNumber % pool.length]`, so `character` went from every day to
// every other day when `fox_outfit` landed (W3-09). That is deliberate — the
// generic profession skins are five glyph-only rows with no art, and the fox
// outfits are eleven with art — but it is a live behaviour change, not a
// data-only one.
//
// 🔑 THE RULING THAT AUTHORISES THAT COST, Brendan 2026-08-19: THE SHOP
// TAKES TURNS. Asked in plain terms — "sofa finishes show up less often, but
// every piece gets a turn" — and accepted explicitly. So the dilution is the
// INTENDED behaviour, not a regression to be tuned away: W2-130 moved
// `furniture` from ['sofa'] to ['sofa', 'armchair', 'tv_stand'] on it, taking
// sofa from every day to one day in three. Do NOT "fix" a subject's frequency
// by trimming this pool.
//
// ⚠️ What the ruling does NOT license is unbenching a subject that is not
// stocked at all three rarities. That check is independent and still binds —
// it is why lamp, bunk_bed and wall stay on the bench.
export const DAILY_SUBJECT_POOLS: Record<string, string[]> = {
  characters: ['character', 'fox_outfit'],
  furniture:  ['sofa', 'armchair', 'tv_stand'],
  styles:     ['outside_plants'],
};

/// Subjects that exist on seed rows but are deliberately NOT in rotation, with
/// the reason each is benched.
///
/// This is a ledger, not a filter — dailyRotation.test.ts asserts it in both
/// directions, so a subject can neither be benched silently nor typo'd into
/// existence. Same shape, and for the same reason, as
/// `RoomCatalogue.awaitingArt`: the previous gap was invisible because nothing
/// asserted that the set of authored subjects and the set of reachable ones
/// agree.
export const BENCHED_SUBJECTS: Record<string, string> = {
  lamp:
    '\ud83d\udd34 REWRITTEN BY W2-160 BECAUSE THIS ENTRY\u2019S OWN PREMISE EXPIRED. It read "One legacy seed row, legendary only \u2014 a single item is not a variant set and cannot fill three tiers", and that is now false of this subject: it carries SEVEN rows spanning all three tiers \u2014 4 common (charcoal, ivory, sage, walnut), 1 rare (two_tone) and 2 legendary (lantern, plus the legacy furn_neon_lamp). \u26a0\ufe0f THE SIX NEW ROWS ARE THE lamp_table PROP AND THAT IS NOT A SECOND SUBJECT: catalogue slot `lamp` is drawn by prop_lamp_table_01.png, so furn_neon_lamp was ALREADY being drawn by that sprite and the finishes join it rather than opening a stem of their own. \ud83d\udd11 SO IT IS NOW BENCHED ON THE BALANCE DECISION ALONE, not on an inability \u2014 the distinction the bunk_bed entry insists on, for the same reason: the old wording made it look impossible when it is merely undecided. Widening the daily furniture pool past sofa/armchair/tv_stand is a product call and divides the existing subjects\u2019 rotation. Stated in full rather than cross-referencing a sibling: armchair once carried the old reason and is now unbenched entirely, so a pointer at it would dangle. Say the reason, do not borrow it.',
  bunk_bed:
    'ROTATION-ELIGIBLE FOR THE FIRST TIME, AND HELD ANYWAY \u2014 this reason was rewritten by W1-162 because that brief made the previous one false. It used to read "one legacy seed row \u2014 a single item is not a variant set and cannot fill three tiers", and that is no longer true of anything: bunk_bed now carries seven rows spanning all three rarities (4 common, 1 rare, 2 legendary), so it CAN fill three tiers. It is therefore benched on a balance decision nobody has taken, not on an inability \u2014 a distinction worth keeping, because the old wording made it look impossible when it is merely undecided. \u26a0\ufe0f Its shape is unusual and that is the rarity rule working, not a bug to tidy: the two legendaries are princess and race_car (both distinct FORMS, not colours) and its only rare is the legacy `furn_bunk_bed` row itself. \ud83d\udd11 UNBENCHING IS A HUMAN CALL AND IT IS WAITING ON ONE \u2014 unlike roof below, nothing needs to be baked and no gate is missing; someone has to decide the daily furniture pool should be wider than sofa/armchair/tv_stand. Flagged for Brendan as a live decision, not a chore. dailyRotation.test.ts re-checks the premise either way.',
  bathtub:
    'Art-complete, never balanced. W1-162 wired 6 seed rows (4 common, 1 rare, 1 legendary) that were baked and unreachable; that made them visible in the album, which is all it was asked for. Entering the daily market is a separate, unmade balance decision. Unbench it when someone decides the furniture pool should be wider than sofa/armchair/tv_stand — a product call, not a code gap. dailyRotation.test.ts re-checks the premise either way.',
  bookshelf:
    'Art-complete, never balanced. W1-162 wired 6 seed rows (4 common, 1 rare, 1 legendary) that were baked and unreachable; that made them visible in the album, which is all it was asked for. Entering the daily market is a separate, unmade balance decision. Unbench it when someone decides the furniture pool should be wider than sofa/armchair/tv_stand — a product call, not a code gap. dailyRotation.test.ts re-checks the premise either way.',
  coffee_table:
    'Art-complete, never balanced. W1-162 wired 4 seed rows (4 common, 0 rare, 0 legendary) that were baked and unreachable; that made them visible in the album, which is all it was asked for. Entering the daily market is a separate, unmade balance decision. It also cannot fill three tiers as authored, so unbenching would need a rung invented — W3 reported the short ladder instead (the material slots are not there), and that decision stands. Unbench it when someone decides the furniture pool should be wider than sofa/armchair/tv_stand — a product call, not a code gap. dailyRotation.test.ts re-checks the premise either way.',
  counter:
    'Art-complete, never balanced. W1-162 wired 6 seed rows (4 common, 1 rare, 1 legendary) that were baked and unreachable; that made them visible in the album, which is all it was asked for. Entering the daily market is a separate, unmade balance decision. Unbench it when someone decides the furniture pool should be wider than sofa/armchair/tv_stand — a product call, not a code gap. dailyRotation.test.ts re-checks the premise either way.',
  desk:
    'Art-complete, never balanced. W1-162 wired 5 seed rows (4 common, 1 rare, 0 legendary) that were baked and unreachable; that made them visible in the album, which is all it was asked for. Entering the daily market is a separate, unmade balance decision. It also cannot fill three tiers as authored, so unbenching would need a rung invented — W3 reported the short ladder instead (the material slots are not there), and that decision stands. Unbench it when someone decides the furniture pool should be wider than sofa/armchair/tv_stand — a product call, not a code gap. dailyRotation.test.ts re-checks the premise either way.',
  dining_table:
    'Art-complete, never balanced. W1-162 wired 6 seed rows (4 common, 1 rare, 1 legendary) that were baked and unreachable; that made them visible in the album, which is all it was asked for. Entering the daily market is a separate, unmade balance decision. Unbench it when someone decides the furniture pool should be wider than sofa/armchair/tv_stand — a product call, not a code gap. dailyRotation.test.ts re-checks the premise either way.',
  dresser:
    'Art-complete, never balanced. W1-162 wired 5 seed rows (4 common, 1 rare, 0 legendary) that were baked and unreachable; that made them visible in the album, which is all it was asked for. Entering the daily market is a separate, unmade balance decision. It also cannot fill three tiers as authored, so unbenching would need a rung invented — W3 reported the short ladder instead (the material slots are not there), and that decision stands. Unbench it when someone decides the furniture pool should be wider than sofa/armchair/tv_stand — a product call, not a code gap. dailyRotation.test.ts re-checks the premise either way.',
  fridge:
    'Art-complete, never balanced. W1-162 wired 6 seed rows (4 common, 1 rare, 1 legendary) that were baked and unreachable; that made them visible in the album, which is all it was asked for. Entering the daily market is a separate, unmade balance decision. Unbench it when someone decides the furniture pool should be wider than sofa/armchair/tv_stand — a product call, not a code gap. dailyRotation.test.ts re-checks the premise either way.',
  shower:
    'Art-complete, never balanced. W1-162 wired 6 seed rows (4 common, 1 rare, 1 legendary) that were baked and unreachable; that made them visible in the album, which is all it was asked for. Entering the daily market is a separate, unmade balance decision. Unbench it when someone decides the furniture pool should be wider than sofa/armchair/tv_stand — a product call, not a code gap. dailyRotation.test.ts re-checks the premise either way.',
  sink:
    'Art-complete, never balanced. W1-162 wired 6 seed rows (4 common, 1 rare, 1 legendary) that were baked and unreachable; that made them visible in the album, which is all it was asked for. Entering the daily market is a separate, unmade balance decision. Unbench it when someone decides the furniture pool should be wider than sofa/armchair/tv_stand — a product call, not a code gap. dailyRotation.test.ts re-checks the premise either way.',
  bed_single:
    'Art-complete, never balanced, and blocked on TWO INDEPENDENT COUNTS. W2-159 wired 5 seed rows (4 common, 1 rare, 0 legendary) whose finish sprites were baked and unreferenced; that makes them visible in the album, which is what the brief asked for. (1) IT CANNOT FILL THREE TIERS — there is no legendary rung and no material slot to bake one into, so the all-three-rarities check refuses to unbench it regardless of any product decision. W3 reported the same short ladder for coffee_table, desk and dresser, and that decision stands. (2) Entering the daily market is a separate, unmade balance decision — a product call, not a code gap, and the same one bathtub through sink have been waiting on since W1-162. ⚠️ WIDENING IS NOT FREE, WHICH IS WHY IT IS NOT DONE QUIETLY HERE: DAILY_SUBJECT_POOLS.furniture holds three subjects, so admitting all twelve of W2-159’s would take sofa, armchair and tv_stand from every third day to every fifteenth — see the warning on DAILY_SUBJECT_POOLS that adding a subject divides the existing ones’ rotation. dailyRotation.test.ts re-checks the premise either way.',
  bench:
    'Art-complete, never balanced, and blocked on TWO INDEPENDENT COUNTS. W2-159 wired 5 seed rows (4 common, 1 rare, 0 legendary) whose finish sprites were baked and unreferenced; that makes them visible in the album, which is what the brief asked for. (1) IT CANNOT FILL THREE TIERS — there is no legendary rung and no material slot to bake one into, so the all-three-rarities check refuses to unbench it regardless of any product decision. W3 reported the same short ladder for coffee_table, desk and dresser, and that decision stands. (2) Entering the daily market is a separate, unmade balance decision — a product call, not a code gap, and the same one bathtub through sink have been waiting on since W1-162. ⚠️ WIDENING IS NOT FREE, WHICH IS WHY IT IS NOT DONE QUIETLY HERE: DAILY_SUBJECT_POOLS.furniture holds three subjects, so admitting all twelve of W2-159’s would take sofa, armchair and tv_stand from every third day to every fifteenth — see the warning on DAILY_SUBJECT_POOLS that adding a subject divides the existing ones’ rotation. dailyRotation.test.ts re-checks the premise either way.',
  cabinet:
    'Art-complete, never balanced, and blocked on TWO INDEPENDENT COUNTS. W2-159 wired 5 seed rows (4 common, 1 rare, 0 legendary) whose finish sprites were baked and unreferenced; that makes them visible in the album, which is what the brief asked for. (1) IT CANNOT FILL THREE TIERS — there is no legendary rung and no material slot to bake one into, so the all-three-rarities check refuses to unbench it regardless of any product decision. W3 reported the same short ladder for coffee_table, desk and dresser, and that decision stands. (2) Entering the daily market is a separate, unmade balance decision — a product call, not a code gap, and the same one bathtub through sink have been waiting on since W1-162. ⚠️ WIDENING IS NOT FREE, WHICH IS WHY IT IS NOT DONE QUIETLY HERE: DAILY_SUBJECT_POOLS.furniture holds three subjects, so admitting all twelve of W2-159’s would take sofa, armchair and tv_stand from every third day to every fifteenth — see the warning on DAILY_SUBJECT_POOLS that adding a subject divides the existing ones’ rotation. dailyRotation.test.ts re-checks the premise either way.',
  dining_chair:
    'Art-complete, never balanced, and blocked on TWO INDEPENDENT COUNTS. W2-159 wired 4 seed rows (4 common, 0 rare, 0 legendary) whose finish sprites were baked and unreferenced; that makes them visible in the album, which is what the brief asked for. (1) IT CANNOT FILL THREE TIERS — there is no legendary rung and no material slot to bake one into, so the all-three-rarities check refuses to unbench it regardless of any product decision. W3 reported the same short ladder for coffee_table, desk and dresser, and that decision stands. (2) Entering the daily market is a separate, unmade balance decision — a product call, not a code gap, and the same one bathtub through sink have been waiting on since W1-162. ⚠️ WIDENING IS NOT FREE, WHICH IS WHY IT IS NOT DONE QUIETLY HERE: DAILY_SUBJECT_POOLS.furniture holds three subjects, so admitting all twelve of W2-159’s would take sofa, armchair and tv_stand from every third day to every fifteenth — see the warning on DAILY_SUBJECT_POOLS that adding a subject divides the existing ones’ rotation. Its ladder is FOUR rows rather than five because the prop has a single material slot, so there is no two_tone rung to bake — the shape is the modelling constraint showing through, not a missing bake. dailyRotation.test.ts re-checks the premise either way.',
  dryer:
    'Art-complete, never balanced, and blocked on TWO INDEPENDENT COUNTS. W2-159 wired 5 seed rows (4 common, 1 rare, 0 legendary) whose finish sprites were baked and unreferenced; that makes them visible in the album, which is what the brief asked for. (1) IT CANNOT FILL THREE TIERS — there is no legendary rung and no material slot to bake one into, so the all-three-rarities check refuses to unbench it regardless of any product decision. W3 reported the same short ladder for coffee_table, desk and dresser, and that decision stands. (2) Entering the daily market is a separate, unmade balance decision — a product call, not a code gap, and the same one bathtub through sink have been waiting on since W1-162. ⚠️ WIDENING IS NOT FREE, WHICH IS WHY IT IS NOT DONE QUIETLY HERE: DAILY_SUBJECT_POOLS.furniture holds three subjects, so admitting all twelve of W2-159’s would take sofa, armchair and tv_stand from every third day to every fifteenth — see the warning on DAILY_SUBJECT_POOLS that adding a subject divides the existing ones’ rotation. dailyRotation.test.ts re-checks the premise either way.',
  microwave:
    'Art-complete, never balanced, and blocked on TWO INDEPENDENT COUNTS. W2-159 wired 5 seed rows (4 common, 1 rare, 0 legendary) whose finish sprites were baked and unreferenced; that makes them visible in the album, which is what the brief asked for. (1) IT CANNOT FILL THREE TIERS — there is no legendary rung and no material slot to bake one into, so the all-three-rarities check refuses to unbench it regardless of any product decision. W3 reported the same short ladder for coffee_table, desk and dresser, and that decision stands. (2) Entering the daily market is a separate, unmade balance decision — a product call, not a code gap, and the same one bathtub through sink have been waiting on since W1-162. ⚠️ WIDENING IS NOT FREE, WHICH IS WHY IT IS NOT DONE QUIETLY HERE: DAILY_SUBJECT_POOLS.furniture holds three subjects, so admitting all twelve of W2-159’s would take sofa, armchair and tv_stand from every third day to every fifteenth — see the warning on DAILY_SUBJECT_POOLS that adding a subject divides the existing ones’ rotation. dailyRotation.test.ts re-checks the premise either way.',
  nightstand:
    'Art-complete, never balanced, and blocked on TWO INDEPENDENT COUNTS. W2-159 wired 5 seed rows (4 common, 1 rare, 0 legendary) whose finish sprites were baked and unreferenced; that makes them visible in the album, which is what the brief asked for. (1) IT CANNOT FILL THREE TIERS — there is no legendary rung and no material slot to bake one into, so the all-three-rarities check refuses to unbench it regardless of any product decision. W3 reported the same short ladder for coffee_table, desk and dresser, and that decision stands. (2) Entering the daily market is a separate, unmade balance decision — a product call, not a code gap, and the same one bathtub through sink have been waiting on since W1-162. ⚠️ WIDENING IS NOT FREE, WHICH IS WHY IT IS NOT DONE QUIETLY HERE: DAILY_SUBJECT_POOLS.furniture holds three subjects, so admitting all twelve of W2-159’s would take sofa, armchair and tv_stand from every third day to every fifteenth — see the warning on DAILY_SUBJECT_POOLS that adding a subject divides the existing ones’ rotation. dailyRotation.test.ts re-checks the premise either way.',
  office_chair:
    'Art-complete, never balanced, and blocked on TWO INDEPENDENT COUNTS. W2-159 wired 5 seed rows (4 common, 1 rare, 0 legendary) whose finish sprites were baked and unreferenced; that makes them visible in the album, which is what the brief asked for. (1) IT CANNOT FILL THREE TIERS — there is no legendary rung and no material slot to bake one into, so the all-three-rarities check refuses to unbench it regardless of any product decision. W3 reported the same short ladder for coffee_table, desk and dresser, and that decision stands. (2) Entering the daily market is a separate, unmade balance decision — a product call, not a code gap, and the same one bathtub through sink have been waiting on since W1-162. ⚠️ WIDENING IS NOT FREE, WHICH IS WHY IT IS NOT DONE QUIETLY HERE: DAILY_SUBJECT_POOLS.furniture holds three subjects, so admitting all twelve of W2-159’s would take sofa, armchair and tv_stand from every third day to every fifteenth — see the warning on DAILY_SUBJECT_POOLS that adding a subject divides the existing ones’ rotation. dailyRotation.test.ts re-checks the premise either way.',
  side_table:
    'Art-complete, never balanced, and blocked on TWO INDEPENDENT COUNTS. W2-159 wired 5 seed rows (4 common, 1 rare, 0 legendary) whose finish sprites were baked and unreferenced; that makes them visible in the album, which is what the brief asked for. (1) IT CANNOT FILL THREE TIERS — there is no legendary rung and no material slot to bake one into, so the all-three-rarities check refuses to unbench it regardless of any product decision. W3 reported the same short ladder for coffee_table, desk and dresser, and that decision stands. (2) Entering the daily market is a separate, unmade balance decision — a product call, not a code gap, and the same one bathtub through sink have been waiting on since W1-162. ⚠️ WIDENING IS NOT FREE, WHICH IS WHY IT IS NOT DONE QUIETLY HERE: DAILY_SUBJECT_POOLS.furniture holds three subjects, so admitting all twelve of W2-159’s would take sofa, armchair and tv_stand from every third day to every fifteenth — see the warning on DAILY_SUBJECT_POOLS that adding a subject divides the existing ones’ rotation. dailyRotation.test.ts re-checks the premise either way.',
  stool:
    'Art-complete, never balanced, and blocked on TWO INDEPENDENT COUNTS. W2-159 wired 5 seed rows (4 common, 1 rare, 0 legendary) whose finish sprites were baked and unreferenced; that makes them visible in the album, which is what the brief asked for. (1) IT CANNOT FILL THREE TIERS — there is no legendary rung and no material slot to bake one into, so the all-three-rarities check refuses to unbench it regardless of any product decision. W3 reported the same short ladder for coffee_table, desk and dresser, and that decision stands. (2) Entering the daily market is a separate, unmade balance decision — a product call, not a code gap, and the same one bathtub through sink have been waiting on since W1-162. ⚠️ WIDENING IS NOT FREE, WHICH IS WHY IT IS NOT DONE QUIETLY HERE: DAILY_SUBJECT_POOLS.furniture holds three subjects, so admitting all twelve of W2-159’s would take sofa, armchair and tv_stand from every third day to every fifteenth — see the warning on DAILY_SUBJECT_POOLS that adding a subject divides the existing ones’ rotation. dailyRotation.test.ts re-checks the premise either way.',
  wardrobe:
    'Art-complete, never balanced, and blocked on TWO INDEPENDENT COUNTS. W2-159 wired 5 seed rows (4 common, 1 rare, 0 legendary) whose finish sprites were baked and unreferenced; that makes them visible in the album, which is what the brief asked for. (1) IT CANNOT FILL THREE TIERS — there is no legendary rung and no material slot to bake one into, so the all-three-rarities check refuses to unbench it regardless of any product decision. W3 reported the same short ladder for coffee_table, desk and dresser, and that decision stands. (2) Entering the daily market is a separate, unmade balance decision — a product call, not a code gap, and the same one bathtub through sink have been waiting on since W1-162. ⚠️ WIDENING IS NOT FREE, WHICH IS WHY IT IS NOT DONE QUIETLY HERE: DAILY_SUBJECT_POOLS.furniture holds three subjects, so admitting all twelve of W2-159’s would take sofa, armchair and tv_stand from every third day to every fifteenth — see the warning on DAILY_SUBJECT_POOLS that adding a subject divides the existing ones’ rotation. dailyRotation.test.ts re-checks the premise either way.',
  washer:
    'Art-complete, never balanced, and blocked on TWO INDEPENDENT COUNTS. W2-159 wired 5 seed rows (4 common, 1 rare, 0 legendary) whose finish sprites were baked and unreferenced; that makes them visible in the album, which is what the brief asked for. (1) IT CANNOT FILL THREE TIERS — there is no legendary rung and no material slot to bake one into, so the all-three-rarities check refuses to unbench it regardless of any product decision. W3 reported the same short ladder for coffee_table, desk and dresser, and that decision stands. (2) Entering the daily market is a separate, unmade balance decision — a product call, not a code gap, and the same one bathtub through sink have been waiting on since W1-162. ⚠️ WIDENING IS NOT FREE, WHICH IS WHY IT IS NOT DONE QUIETLY HERE: DAILY_SUBJECT_POOLS.furniture holds three subjects, so admitting all twelve of W2-159’s would take sofa, armchair and tv_stand from every third day to every fifteenth — see the warning on DAILY_SUBJECT_POOLS that adding a subject divides the existing ones’ rotation. ⚠️ prop_washer_01_spin and prop_washer_01_spin_rot90 are deliberately NOT seeded: they are 4096x512 eight-frame animation strips, and a seed row pointing at one would draw eight washers side by side in a 512x512 slot. dailyRotation.test.ts re-checks the premise either way.',
  bed_double:
    'ROTATION-ELIGIBLE AND HELD ANYWAY, WHICH IS A DIFFERENT STATEMENT FROM THE TWELVE ABOVE AND MUST NOT BE COLLAPSED INTO IT. W2-160 wired 6 seed rows — 4 common, 1 rare (two_tone) and 1 LEGENDARY (four_poster, a distinct FORM rather than a colour) — so this subject CAN fill three tiers. The all-three-rarities check does not block it. It is benched purely on the balance decision nobody has taken: the daily furniture pool is sofa/armchair/tv_stand, and widening it is a product call, not a code gap. \u26a0\ufe0f AND WIDENING IS NOT FREE — DAILY_SUBJECT_POOLS.furniture holds three subjects, so every subject admitted divides the existing ones\u2019 rotation; see the warning on that table. \ud83d\udd11 UNBENCHING IS A HUMAN CALL AND NOTHING IS MISSING FOR IT — unlike the twelve, no rung needs baking and no gate is absent. Same position as bunk_bed. dailyRotation.test.ts re-checks the premise either way.',
  stove_hood:
    'ROTATION-ELIGIBLE AND HELD ANYWAY, WHICH IS A DIFFERENT STATEMENT FROM THE TWELVE ABOVE AND MUST NOT BE COLLAPSED INTO IT. W2-160 wired 6 seed rows — 4 common, 1 rare (two_tone) and 1 LEGENDARY (range, a distinct FORM rather than a colour) — so this subject CAN fill three tiers. The all-three-rarities check does not block it. It is benched purely on the balance decision nobody has taken: the daily furniture pool is sofa/armchair/tv_stand, and widening it is a product call, not a code gap. \u26a0\ufe0f AND WIDENING IS NOT FREE — DAILY_SUBJECT_POOLS.furniture holds three subjects, so every subject admitted divides the existing ones\u2019 rotation; see the warning on that table. \ud83d\udd11 UNBENCHING IS A HUMAN CALL AND NOTHING IS MISSING FOR IT — unlike the twelve, no rung needs baking and no gate is absent. Same position as bunk_bed. dailyRotation.test.ts re-checks the premise either way.',
  wall:
    'Has common and rare but no legendary. Wall art is blocked on the interior-style renderer, which does not exist — see spec-2026-08-05-w3-08-blocked-subjects.md.',
  roof:
    'Stocked at all three rarities, and every one of them is invisible: there is no roof art in the repository (`find assets -iname "*roof*"` -> 0 files) and no bake script for one. It was half the styles pool, so on every even date the styles chest granted a 100-sponge prize the player could not see. \u{1F534} CORRECTED 2026-08-29 (W2-159): this entry used to end "Unbench it when W3 bakes the art, not before", which reads as PENDING. The feature is DROPPED — Brendan\'s decision, recorded in Projects/Cleaning/decisions-2026-08-29-roof-styles-dropped.md. The rows stay, the nav icon stays, and no roof art is commissioned, so there is no bake to wait for. Un-dropping is a product decision followed by an art commission, not a chore anyone is queued to do. The absence above is stated as a COMMAND rather than an assertion for exactly this reason: it was still 0 files when re-run on 2026-08-29. dailyRotation.test.ts re-checks the premise either way.',
};

/// Picks the day's subject for [category] deterministically from [dateStr]
/// (`YYYYMMDD`). Deterministic on purpose: a reproducible day is a testable
/// day, and rotateMarket must not depend on Math.random().
export function subjectForDay(category: string, dateStr: string): string {
  const pool = DAILY_SUBJECT_POOLS[category] ?? [];
  if (pool.length === 0) return '';
  const dayNumber = Number(dateStr.replace(/\D/g, '')) || 0;
  return pool[dayNumber % pool.length];
}

// ---------------------------------------------------------------------------
// Which chests are OFFERED today — the stock rotation
// ---------------------------------------------------------------------------
//
// Brendan, 2026-08-12: "make sure they rotate at random with a different set of
// them moving each time with the character egg being the most rare (not common
// to see more than 2x a week). furnature is very common and styles are too."
//
// 🔑 THIS IS A DIFFERENT AXIS FROM `rarity` AND FROM `dropTable`, despite the
// vocabulary collision. `rarity` is the chest card's colour/tier label and
// `dropTable` is what it rolls against once bought; both are correct and
// untouched here. This controls only how often a chest is STOCKED — whether the
// player sees it at all on a given day. A chest that appears less often does not
// thereby cost more: price still comes from CHEST_PRICE.
//
// 🔴 THE HARD PART IS THE CAP, NOT THE RANDOMNESS. "Not more than 2x a week" is
// a constraint ACROSS days, and the writer that needs it (`rotateMarket`) is a
// scheduled function with no memory of yesterday. Independent weighted rolls
// cannot honour it — they will happily produce the egg four days running, which
// is the exact outcome the instruction rules out.
//
// ⚠️ AND BUCKETING BY CALENDAR WEEK DOES NOT FIX IT. "At most 2 per ISO week"
// still permits Thu+Fri of one week followed by Mon+Tue of the next — four
// appearances inside six days, every one of them legal under a per-week count.
// A player does not experience ISO weeks. So the cap here is enforced on a
// ROLLING window, by construction:
//
//   Character days are placed one per 7-day block, at an offset drawn from
//   {2,3,4}. Consecutive offsets therefore differ by 7 + (2-4) = 5 at minimum
//   and 7 + (4-2) = 9 at maximum. A minimum gap of 5 means any 7-day window can
//   contain at most two character days (d and d+5 fit; d+10 cannot), for EVERY
//   window, not merely the aligned ones. The cap is structural — there is no
//   roll that can breach it and therefore no rejection path to get wrong.
//
// The randomness is real but SEEDED: the offsets come from a per-block PRNG, so
// the line-up differs week to week while any given date is reproducible from its
// own date string. That is what makes the distribution testable at all, and it
// is why nothing here calls Math.random() — a scheduled writer that rolls
// unseeded cannot be asserted about, and stubbing Math.random under Jest kills
// the runner before any test executes (a constant pivot recurses its quicksort).

/// Day 0 of the rotation calendar, UTC. Arbitrary but FIXED — moving it
/// reshuffles every future line-up, so it is a constant, not a tunable.
const ROTATION_EPOCH_UTC = Date.UTC(2026, 0, 1);

/// The rotation block. Seven days so a block is a week-shaped unit; the cap
/// above does not depend on it lining up with anyone's calendar.
export const ROTATION_BLOCK_DAYS = 7;

/// Offsets within a block at which the character egg may fall. The narrow band
/// is the whole mechanism: it bounds the gap between consecutive appearances to
/// [5, 9] days, which is what makes the rolling cap of 2-per-7-days provable.
/// ⚠️ Widening this to {0..6} restores the boundary-clustering bug.
export const CHARACTER_BLOCK_OFFSETS = [2, 3, 4];

/// Days per block on which each of the common categories is stocked.
/// Furniture "very common", styles "common" — Brendan's words, and the only
/// two rates he gave. There is deliberately no third tier and no pity timer.
export const FURNITURE_DAYS_PER_BLOCK = 6;
export const STYLES_DAYS_PER_BLOCK = 4;

/// mulberry32 — a small seeded PRNG. Injected rather than global on purpose:
/// see the Math.random note above.
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/// Days since ROTATION_EPOCH_UTC for a `YYYYMMDD` date string. Negative for
/// dates before the epoch, which is fine — the block maths floors correctly.
export function dayIndexFromDateStr(dateStr: string): number {
  const digits = dateStr.replace(/\D/g, '');
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  if (!year || !month || !day) return 0;
  const ms = Date.UTC(year, month - 1, day) - ROTATION_EPOCH_UTC;
  return Math.round(ms / 86400000);
}

/// Picks [count] distinct offsets in [0, ROTATION_BLOCK_DAYS) using [rng].
function pickDays(rng: () => number, count: number): number[] {
  const days = Array.from({length: ROTATION_BLOCK_DAYS}, (_, i) => i);
  // Fisher-Yates, seeded.
  for (let i = days.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [days[i], days[j]] = [days[j], days[i]];
  }
  return days.slice(0, count).sort((x, y) => x - y);
}

/// The offered-category schedule for one 7-day block, as an array of 7 category
/// lists indexed by offset within the block.
export function scheduleForBlock(blockIndex: number): string[][] {
  const schedule: string[][] = Array.from({length: ROTATION_BLOCK_DAYS}, () => []);

  // Distinct salts so the three categories do not move in lockstep — one PRNG
  // shared across all three would correlate their off-days.
  const characterRng = makeRng(blockIndex * 2654435761 + 0x0001);
  const furnitureRng = makeRng(blockIndex * 2654435761 + 0x1f35);
  const stylesRng    = makeRng(blockIndex * 2654435761 + 0x2b9d);

  const characterOffset =
    CHARACTER_BLOCK_OFFSETS[
      Math.floor(characterRng() * CHARACTER_BLOCK_OFFSETS.length)
    ];
  schedule[characterOffset].push('characters');

  for (const d of pickDays(furnitureRng, FURNITURE_DAYS_PER_BLOCK)) {
    schedule[d].push('furniture');
  }
  for (const d of pickDays(stylesRng, STYLES_DAYS_PER_BLOCK)) {
    schedule[d].push('styles');
  }

  // A day with no chests at all is a broken shop, not a rare rotation. It is
  // reachable: furniture rests one day per block and styles covers only four,
  // so roughly one block in six would otherwise render an empty grid.
  for (const day of schedule) {
    if (day.length === 0) day.push('styles');
  }

  return schedule;
}

/// Which chest categories are stocked on [dateStr] (`YYYYMMDD`).
///
/// Deterministic: the same date always yields the same line-up, on any machine,
/// with no read of yesterday's document. That is the property that let this
/// honour a cross-day cap from inside a stateless scheduled write.
export function offeredChestCategories(dateStr: string): string[] {
  const dayIndex = dayIndexFromDateStr(dateStr);
  const blockIndex = Math.floor(dayIndex / ROTATION_BLOCK_DAYS);
  const offset = ((dayIndex % ROTATION_BLOCK_DAYS) + ROTATION_BLOCK_DAYS) % ROTATION_BLOCK_DAYS;
  return scheduleForBlock(blockIndex)[offset];
}

// ---------------------------------------------------------------------------
// Bundled seed pool
// ---------------------------------------------------------------------------

export interface SeedItem {
  id: string;
  type: string;
  category: string;
  /// The chest subject this item belongs to — the themed-drop filter key.
  /// For furniture and styles it is the equip slot; for characters it is
  /// 'character' until per-character outfit sets land.
  subject: string;
  name: string;
  rarity: Rarity;
  artUrl: string;
}

// ---------------------------------------------------------------------------
// Style families — the look layer, as a ledger beside the list
// ---------------------------------------------------------------------------
//
// Transcribed from wiki/cleaning-app-style-families.md, which is Phase 0 of the
// cosmetic program and is DONE. Two windows derived the same four partitions
// from opposite methods — one clustering the tuned `warm_strength` values in the
// shipped bake scripts, one clustering mean-Lab colour against the pipeline's
// own dE ceiling — and agreed 4-for-4. This file is the machine-readable half of
// that page, not a place to re-argue it.
//
// 🔴 IN v1 FAMILY IS A LEDGER, AN ART-BRIEF AXIS, AND AN ALBUM GROUPING.
// NOTHING ELSE. It must not become a drop key. `pickChestItem` filters on
// (subject, rarity) and then picks uniformly; adding `family` as a third filter
// turns the mandatory coverage grid from 3 x 3 = 9 cells into 3 x 3 x 4 = 36,
// and the comment on DAILY_SUBJECT_POOLS above states exactly what an empty cell
// costs — not-found on every roll that reaches the tail, and a player refused a
// chest they can see and afford. Family as a drop key demands roughly 4x the
// content the rotation currently has. Do NOT add family to DAILY_SUBJECT_POOLS,
// to the items query, to SeedItem, or to a `familyForDay` function. The cheap
// path, later, is to theme the DAY across all three chests, which leaves the
// grid at 9 — and that is a future brief.
//
// 🔑 WHY A LEDGER AND NOT A FIELD ON SeedItem. A field would also change what
// the seeder writes to Firestore (index.ts enumerates the fields explicitly), so
// a separate const is invisible to it: zero migration, zero deploy coupling. It
// is also the answer this repo has already reached three times — BENCHED_SUBJECTS
// above, RoomCatalogue.awaitingArt, FurnitureCatalogue.tapMaterials — and
// room_catalogue.dart argues it explicitly: "a lookup you can read top to bottom
// is far easier to audit than the same data smeared across thirty long
// constructor calls."
//
// ⚠️ NAMING THE FAMILIES IS FREE; THE SURFACES ARE THE BILL. Three of the four
// families can only be SEEN on a sofa today — there is no roof renderer, floors
// are keyed by room type, and walls are keyed by geometry. Nothing here is
// permission to commission a family's worth of art.

/// Words that must never appear in a prompt, in any family.
///
/// `claymation` / `clay` / `plasticine` are retired repo-wide (user directive
/// 2026-08-02): they are generative-model triggers producing a texture and gloss
/// this library does not have. `low-poly` and `faceted` are the same failure
/// recorded at cleaning-app-art-direction.md:56 — "the sheets are right, the
/// caption is wrong."
///
/// Shared, not copied four times, so retiring a fifth word is one edit.
///
/// ⚠️ This governs PROMPT TEXT only. `lighting='clay'` and `add_clay_box` in
/// `3d-source/` are internal Blender identifiers that never reach a prompt and
/// are deliberately left alone.
export const RETIRED_VOCABULARY: string[] = [
  'claymation',
  'clay',
  'plasticine',
  'low-poly',
  'faceted',
];

export interface StyleFamilyPalette {
  /// The measured anchor hex. Every other rule in the family hangs off it, and
  /// Global Rule 1 is that a family is authored from its HEXES, never its name.
  anchor: string;
  /// Named swatches, in the order the page lists them.
  swatches: Record<string, string>;
  /// The Lab body band, verbatim. Prose rather than numbers because it is a
  /// range in three channels read by a bake author, not by the client.
  bodyBand: string;
}

export interface StyleFamilyMaterial {
  /// Permitted `ref_index.json` material tiers. Global Rule 2: a family needing
  /// a sixth tier is a family that cannot be gated.
  tiers: string[];
  propClass: string;
  /// Inclusive [min, max]. Equal endpoints where the page states one number —
  /// and that number IS the family boundary: charcoal at 0.55 "rendered espresso
  /// BROWN and was indistinguishable in kind from the walnut common", i.e. two
  /// families collapsed into one by a single float.
  warmStrength: [number, number];
  roughness: number;
  subsurface: number;
  /// Only where the page states one.
  specular?: number;
}

export interface StyleFamilySilhouette {
  /// The page's three-word rule.
  rule: string;
  /// BINARY, not four-way (Global Rule 4). Measured on contiguous trailing rows
  /// under 25% of peak coverage: on a 4-8 px feature you get gapped or grounded
  /// and nothing finer. Oakhouse + Meadow gapped, Quarry + Dovecote grounded;
  /// inside each pair colour alone separates.
  baseLine: 'gapped' | 'grounded';
}

export interface StyleFamilyForbidden {
  /// Always includes RETIRED_VOCABULARY and the family's OWN name.
  prompt: string[];
  palette: string[];
  material: string[];
  silhouette: string[];
  crossFamily: string[];
  /// Only where the page states an extra row.
  specific?: string[];
}

export interface StyleFamily {
  label: string;
  territory: string;
  palette: StyleFamilyPalette;
  material: StyleFamilyMaterial;
  silhouette: StyleFamilySilhouette;
  forbidden: StyleFamilyForbidden;
}

export const STYLE_FAMILIES: Record<string, StyleFamily> = {
  oakhouse: {
    label: 'Oakhouse',
    territory: 'warm wood / fired earth',
    palette: {
      anchor: '#9C7358',
      swatches: {
        walnut:     '#9C7358', // anchor, measured
        oak:        '#C89A6E', // the shared accent, present in every Oakhouse piece
        terracotta: '#C5967C',
        frameAmber: '#CC8552',
        sand:       '#D2BC9C',
        russet:     '#B5806A', // the shipped two-tone rare
        soil:       '#6F523D',
      },
      bodyBand: 'L 45-62 · a* +12…+18 · b* +20…+28. Contrast partner is oat, never white.',
    },
    material: {
      tiers: ['fabric', 'generic', 'saturated'],
      propClass: 'box',
      warmStrength: [0.85, 1.15],
      roughness: 0.90,
      subsurface: 0.18,
      specular: 0.22,
    },
    silhouette: { rule: 'GAPPED · ROLLED · LINEAR', baseLine: 'gapped' },
    forbidden: {
      prompt: [...RETIRED_VOCABULARY, 'Oakhouse', 'oak', 'wood grain', 'timber', 'rustic'],
      palette: ['grey', 'blue', 'black', 'chrome', 'marble', 'glass', 'gold leaf', 'any a* < 0'],
      material: ['gloss', 'specular hotspot', 'rim light', 'visible weave', 'rust / patina / distress'],
      silhouette: ['plinth', 'flush-to-floor base', 'hidden legs', 'valance or skirt', 'hard 90 degree arm', 'arch or dome'],
      crossFamily: ['charcoal/pewter body (Quarry)', 'anything above L 70 (Dovecote)', 'foliage (Meadow)'],
    },
  },

  quarry: {
    label: 'Quarry',
    territory: 'warm dark neutral',
    palette: {
      anchor: '#5F5A57',
      swatches: {
        warmCharcoal:   '#5F5A57', // anchor — a warm dark grey, NEVER black
        pewter:         '#938C8B',
        pewterDeep:     '#736D6F',
        paleStone:      '#B5AFAA',
        suitBlack:      '#332D2D', // floor value
        aubergineShell: '#514646',
        bone:           '#CBC8C2', // the one permitted pale horizontal
        oakAccent:      '#C89A6E', // the ONLY warm accent, on a foot/handle/edge — never a surface
      },
      bodyBand: 'L 25-40 · |a*| <= 5. No other family goes below L 45.',
    },
    material: {
      tiers: ['fabric', 'saturated'],
      propClass: 'box',
      warmStrength: [0.15, 0.15],
      roughness: 0.88,
      subsurface: 0.10, // lower than the other three — stone is not waxy
    },
    silhouette: { rule: 'GROUNDED · SQUARED · LOW', baseLine: 'grounded' },
    forbidden: {
      prompt: [...RETIRED_VOCABULARY, 'Quarry', 'stone', 'granite', 'marble', 'concrete', 'slate'],
      palette: ['brown', 'tan', 'honey', 'terracotta', 'green', 'pure neutral grey', 'true black (#000000 appears nowhere in this library)'],
      material: ['polish', 'gloss', 'speckle', 'veining', 'metal', 'reflection', 'gold / brass / chrome / gilt'],
      silhouette: ['exposed legs', 'tapered feet', 'visible floor beneath', 'rolled arms', 'spindles', 'canopy', 'arch or dome'],
      crossFamily: ['warm-wood body (Oakhouse)', 'anything above L 45 as a body (Dovecote)', 'planted element (Meadow)'],
      specific: ['never assign a neon or emissive item here — the name will summon exactly that'],
    },
  },

  dovecote: {
    label: 'Dovecote',
    territory: 'warm near-white',
    palette: {
      anchor: '#E3D6C7',
      swatches: {
        ivory:            '#E3D6C7', // anchor
        cream:            '#E8DCC0',
        warmWhiteCeramic: '#FFFEFC',
        oat:              '#D2BC9C',
        greige:           '#B4B0A8', // the shipped env_wall_straight_01 dominant
        warmCream:        '#E5CDAD',
        warmCreamDeep:    '#D1B28E',
      },
      bodyBand: 'Value floor L 70 — nothing darker, and that floor IS the identity. Saturation ceiling S 0.20 · |a*| <= 8.',
    },
    material: {
      tiers: ['generic', 'fabric'],
      propClass: 'box',
      // ⚠️ THE TRAP THAT HAS ALREADY COST TWO REVISIONS. `make_clay_mat` defaults
      // warm_strength to 1.0, where the warm shade ramp over-darkens near-whites
      // — that is what rendered the shower salmon-pink for two revisions. Every
      // Dovecote bake must pass this EXPLICITLY and be checked on the SHADE
      // faces, not the lit ones. The argument you forget to pass is the one that
      // turns ceramic pink.
      warmStrength: [0.20, 0.30],
      roughness: 0.92, // highest of the four
      subsurface: 0.20,
    },
    silhouette: { rule: 'SOFT · SWALLOWED · CORNERLESS', baseLine: 'grounded' },
    forbidden: {
      prompt: [...RETIRED_VOCABULARY, 'Dovecote', 'linen', 'chalk', 'canvas', 'cotton', 'plaster'],
      palette: ['anything below L 70', 'any saturated hue', 'contrast trim', 'dark piping', 'outline', 'black', 'pink (the specific hazard — see the warm_strength trap)'],
      material: ['gloss', 'sheen hotspot', 'visible weave', 'quilting or stitch lines', 'a second material on one prop'],
      silhouette: ['exposed slender legs', 'hard chamfer', 'squared arm', 'visible frame or joint', 'plinth'],
      crossFamily: ['warm-wood body (Oakhouse)', 'charcoal/pewter (Quarry)', 'foliage (Meadow)'],
    },
  },

  meadow: {
    label: 'Meadow',
    territory: 'sage / growing',
    palette: {
      anchor: '#9AA88E',
      swatches: {
        sage:          '#9AA88E', // anchor — the ONLY negative-a* body colour in the furniture set
        shelfSage:     '#A8B08C',
        leaf:          '#6E8757',
        innerLeaf:     '#4F6440',
        moss:          '#749363',
        stoneGrey:     '#969694',
        warmWhitePot:  '#FFFEFC',
        soil:          '#6F523D',
      },
      bodyBand: 'L 50-68 · a* -8…-3. The shallow chroma is deliberate: this family is defined by the ABSENCE OF WARMTH, not by greenness.',
    },
    material: {
      tiers: ['fabric', 'generic', 'organic'],
      propClass: 'box',
      // Foliage-only masses may drop to 0.40; the warm-white pot to 0.25 —
      // Dovecote's number, because it IS a Dovecote surface inside a Meadow piece.
      warmStrength: [0.70, 0.70],
      roughness: 0.90,
      subsurface: 0.18,
    },
    silhouette: { rule: 'BROKEN · ASYMMETRIC · GAPPED', baseLine: 'gapped' },
    forbidden: {
      prompt: [...RETIRED_VOCABULARY, 'Meadow', 'moss', 'foliage', 'botanical', 'garden'],
      palette: ['grey / charcoal body', 'pure white', 'terracotta body (pot only)', 'neon or spring green'],
      material: ['gloss on leaves', 'wet look', 'variegation', 'printed floral pattern (the flowers are GEOMETRY, never a texture map)', 'visible veining'],
      silhouette: ['symmetry', 'clean rectangle', 'closed contour', 'hard chamfer', 'lattice / trellis / open frame / cut-out (the IoU trap)'],
      crossFamily: ['warm-wood body (Oakhouse)', 'charcoal (Quarry)', 'anything above L 70 (Dovecote)'],
    },
  },
};

/// Seed id -> STYLE_FAMILIES key, for the 38 rows that carry a family.
///
/// Order follows SEED_ITEMS so the two can be read side by side. Asserted in
/// both directions by dailyRotation.test.ts: a row can neither be assigned
/// silently nor typo'd into existence.
export const ITEM_FAMILY: Record<string, string> = ITEM_FAMILY_GENERATED;

/// Seed ids that are deliberately family-LESS.
///
/// Global Rule 7 from the style-families page: **the free tier is deliberately
/// plain and is family-NEUTRAL.** `furn_cozy_sofa` and `style_ext_lawn_default`
/// are the baseline every family departs from — a free item carrying a family
/// would make the free house read as an incomplete purchase.
///
/// 🔑 NEUTRAL IS A DECISION, AND THIS LIST IS WHERE IT IS RECORDED. That is the
/// whole reason family is not an id-prefix convention: `kFoxOutfitIdPrefix` is
/// the in-tree precedent for that approach and it cannot express "deliberately
/// neutral", because a missing prefix is indistinguishable from a forgotten one.
export const FAMILY_NEUTRAL: string[] = FAMILY_NEUTRAL_GENERATED;

// 🔴 AUTHORED IN functions/seed/collection_seed.json, NOT HERE (W2-135).
//
// The 52 rows and the ~775 words of reasoning that used to live in this block
// are in that JSON, which is the single source both language projections are
// generated from. `npm run seed:check` regenerates and byte-diffs, so this
// re-export cannot drift from the source.
//
// 🔑 THE PROSE MOVED WITH THE DATA, DELIBERATELY. Generating from a data-only
// source would have destroyed 64 comment lines in this declaration alone — the
// style_roof_tile_gold pricing bug, furn_cozy_sofa's "measured dusty rose, not
// cream", the day-one-set provenance. The schema carries `note` and `section`
// so a comment about a ROW travels with that row. Proven lossless at migration:
// 64 committed comment lines -> 64 generated, with the row values unchanged.
//
// ⚠️ A note belongs in the JSON, never merged back from the generated file. That
// is what keeps the output a pure function of its input, which is the only
// reason the byte-diff gate proves anything.
export const SEED_ITEMS: SeedItem[] = SEED_ITEMS_GENERATED;
