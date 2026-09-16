// SYNC: functions/src/itemPool.ts  DROP_TABLES + CHEST_CATEGORY_DROP_TABLE
//
// Three tiers, six numbers, re-centred 2026-09-03 on Brendan's ruling:
//
//     lean [0.75, 0.89]     mid [0.45, 0.78]     rich [0.15, 0.67]
//
// ✅ THE MIRROR IS GATED NOW, AND THIS PARAGRAPH IS THE CORRECTION. It used to
// read "there is **no cross-language test** — nothing fails if TS moves and this
// does not", and that was true for as long as it stood.
// `functions/src/__tests__/dropTableMirror.test.ts` (#693, 2026-09-03) reads THIS
// FILE off disk and compares `kDropTables` to `DROP_TABLES` tier by tier, so a
// one-sided change now reddens `npm test` in `functions/`.
//
// 🔴 WHAT THAT COSTS YOU, AND IT IS THE POINT: the two sides can no longer land
// in separate PRs. A TS-only change reddens the backend suite and a Dart-only
// change reddens it too, so there is no order in which the halves land with
// `main` green in between. Move both in ONE commit, under a claim naming both
// paths. The old "treat it as a two-file change" advice was a request; this is
// the enforcement.
//
// 📌 THE LINE ABOVE IS A THIRD COPY OF THE SAME SIX NUMBERS AND THE GUARD CANNOT
// SEE IT. The test anchors on the `kDropTables` declaration before matching
// entries — measured by doctoring only this comment and watching the parse come
// back byte-identical. So it is prose, and prose goes stale silently: if you
// change the table below, change line 5 in the same edit.
//
// What removes the risk of a *silent* drift in the PERCENTAGES is that they are
// DERIVED, not typed. The previous odds line was three hand-written strings and
// every one of them was wrong; a mirror that does the arithmetic can only drift
// if the thresholds themselves drift.

import 'entities/chest_item.dart';

/// Cumulative thresholds against a uniform [0,1) roll: `[P(common), P(<=rare)]`.
/// Anything at or above the second threshold is legendary — two thresholds for
/// three outcomes, matching `DROP_TABLES` exactly.
const Map<String, (double, double)> kDropTables = {
  'lean': (0.75, 0.89),
  'mid': (0.45, 0.78),
  'rich': (0.15, 0.67),
};

/// Mirror of `CHEST_CATEGORY_DROP_TABLE`. The Part C ordering: characters are
/// the rarest chest type and roll the richest table, furniture the leanest.
///
/// `dailyGift` is deliberately absent — it is absent from the TS map too, and
/// resolves through [kFallbackDropTable] on both sides.
const Map<ChestCategory, String> kChestCategoryDropTable = {
  ChestCategory.characters: 'rich',
  ChestCategory.styles: 'mid',
  ChestCategory.furniture: 'lean',
};

/// The last resort on both sides of the wire — `?? 'lean'` in `index.ts:468`
/// and `?? DROP_TABLES['lean']` in `rollRarity`.
const String kFallbackDropTable = 'lean';

/// Which drop table [chest] rolls against, mirroring `index.ts:465-468`:
/// prefer the row's own `dropTable`, fall back to the category mapping, fall
/// back to `lean`.
///
/// ⚠️ **Empty string counts as absent.** In TS, `??` falls through only on
/// `null`/`undefined`, so the field is either a real tier or missing. In Dart
/// the freezed `@Default('')` turns a *missing* Firestore field into `''`,
/// which would win the first branch and never reach the category fallback —
/// rendering lean odds (2% legendary) on the Characters chest, which really
/// rolls rich (20%). That 10x understatement is the whole reason this function
/// exists rather than a bare `chest.dropTable`.
String resolveDropTable(ChestItem chest) {
  if (chest.dropTable.isNotEmpty) return chest.dropTable;
  return kChestCategoryDropTable[chest.category] ?? kFallbackDropTable;
}

/// The thresholds [chest] actually rolls against.
///
/// An unrecognised tier resolves to `lean`, matching `rollRarity`'s
/// `DROP_TABLES[dropTable] ?? DROP_TABLES['lean']`.
(double, double) dropThresholdsFor(ChestItem chest) =>
    kDropTables[resolveDropTable(chest)] ?? kDropTables[kFallbackDropTable]!;

/// Per-tier drop chances for [chest] as whole percentages, derived from the
/// cumulative thresholds — never hand-typed.
({int common, int rare, int legendary}) dropChancesFor(ChestItem chest) {
  final (commonCut, rareCut) = dropThresholdsFor(chest);
  return (
    common: (commonCut * 100).round(),
    rare: ((rareCut - commonCut) * 100).round(),
    legendary: ((1 - rareCut) * 100).round(),
  );
}

/// The player-facing odds line for [chest].
///
/// Tiers are worded `Common / Rare / Legendary` — the raw server strings — so
/// the line names what the prize card will actually say. `chest_reward_card`
/// renders `item.rarity.toUpperCase()`, so a legendary prize reads `LEGENDARY`.
///
/// It can never name `Epic` or `Uncommon`: `RARITIES` in `itemPool.ts` is
/// exactly `['common', 'rare', 'legendary']` and there is no fourth branch here
/// to emit one.
String chestOddsText(ChestItem chest) {
  final odds = dropChancesFor(chest);
  return 'Common ${odds.common}% · '
      'Rare ${odds.rare}% · '
      'Legendary ${odds.legendary}%';
}
