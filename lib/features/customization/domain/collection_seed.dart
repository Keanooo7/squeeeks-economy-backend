// 🔴 HALF OF THIS FILE IS GENERATED AND HALF IS HAND-AUTHORED. READ WHICH
// BEFORE YOU EDIT — THE TWO HALVES FAIL IN OPPOSITE DIRECTIONS.
//
// GENERATED from `functions/seed/collection_seed.json` by
// `functions/scripts/gen-seed.cjs` (`emitDart`). **Do not hand-edit these four;
// change the JSON and regenerate.** They are machine-compared in W2's `npm
// test`, which `make test` does not run — so a hand edit here goes red in a
// suite this lane never sees:
//
//   kCollectionSeed      seedGenerator.test.ts, exact modulo whitespace
//   kItemFamily          seedGenerator.test.ts, exact modulo whitespace
//   kFamilyNeutral       seedGenerator.test.ts, exact modulo whitespace
//   kSkinDescriptions    compared key-for-key in BOTH directions, plus a pin
//                        that `char_pyjama` stays hoisted to index 0 — the
//                        generator emits it in seed order, so this one table is
//                        deliberately NOT a verbatim paste
//
// HAND-AUTHORED here, emitted by nothing, gated by nothing in `functions/`
// (`grep kSkinSpriteStems functions/` returns zero hits). **These are yours:**
//
//   kSkinSpriteStems             seed id -> sprite stem
//   kSkinSpriteRooms             seed id -> room directory
//   kFurnSeedCategoryToBasePiece seed category -> FurnitureDef.id
//
// 🔑 `skinAssetPathFor` needs BOTH sprite maps and returns null if either
// misses, and null means "draw the base piece" — so a row in one and not the
// other is silent. That is the W1-162 bug; the note on `kSkinSpriteRooms` has
// the full account.
//
// ⚠️ THE LINE THAT STOOD HERE SAID "Keep this list in sync manually when the
// backend seed changes." It was true when written and became actively harmful
// at W2-135, when the generator took over: it instructed a reader to
// hand-maintain a machine-checked file, and unlike `itemPool.generated.ts` this
// file carries no DO-NOT-EDIT banner to contradict it. W1-171 was dispatched to
// hand-author fifteen props' rows on the strength of it and got one message from
// starting. **A blanket "GENERATED — DO NOT EDIT" would be the opposite lie**,
// sending the next reader away from three maps they are supposed to author,
// which is why this header names both halves instead.
//
// Rarity strings must match SEED_ITEMS.rarity; 'legendary' is allowed (mapped
// to Rarity.exclusive by rarityFromSeed).

import 'rarity.dart';

/// A single row mirrored from SEED_ITEMS.
class SeedItem {
  final String id;
  final String type; // 'furniture' | 'character' | 'style'
  final String category; // backend sub-category string
  final String name;
  final String rarity; // raw seed string — pass through rarityFromSeed()
  const SeedItem({
    required this.id,
    required this.type,
    required this.category,
    required this.name,
    required this.rarity,
  });
}

/// The three kinds of thing the album collects — the type axis of the Style
/// page's tab row.
///
/// Exactly the three values [SeedItem.type] holds. There is deliberately no
/// `decor`: inventing a fourth would not create a fourth tab, it would create
/// rows that [baseFurnitureIdFor] cannot place and `SkinCatalog.buildSlots`
/// silently drops.
enum ItemType { furniture, character, style }

/// [item]'s type axis, or null when the backend has grown a type this client
/// does not know.
///
/// ⚠️ **NEVER THROW FROM HERE.** This runs inside
/// `StyleCollectionNotifier.build()`. Throwing on an unmapped string would not
/// make one row loud — it would kill the provider and render the *entire*
/// album as its error state. A backend that adds a type must degrade to "one
/// item is missing", never to "the collection is gone".
///
/// The loudness belongs in CI instead:
/// `test/features/customization/domain/item_type_test.dart` asserts that every
/// row of [kCollectionSeed] maps, so an unmapped row fails the suite rather
/// than the player's app.
ItemType? itemTypeOf(SeedItem item) => switch (item.type) {
      'furniture' => ItemType.furniture,
      'character' => ItemType.character,
      'style' => ItemType.style,
      _ => null,
    };

/// Mirror of functions/src/itemPool.ts SEED_ITEMS.
///
/// The `epic` tier was retired on 2026-08-05 (W3-08) — the backend now emits
/// only common/rare/legendary, matching the design sheet. The three rows that
/// were epic are legendary here for the same reason.
const List<SeedItem> kCollectionSeed = [
  // DROPPED 2026-08-29 by Brendan: house roof styles are shelved. These three rows
  // (straw, tile, tile_gold) stay wired and stay in the album — dropped, not deleted —
  // and no roof art is commissioned.
  // They ship with zero art. Re-check rather than trust this sentence:
  //   find assets -iname "*roof*"   ->  0 files (2026-08-29)
  // so the gap is the decision, not a bug.
  // Scope and reasoning: Projects/Cleaning/decisions-2026-08-29-roof-styles-dropped.md.
  // This note points at that record rather than restating it, because a second copy
  // drifts from the first. Un-dropping is an art commission, not a wiring job.
  SeedItem(id: 'style_roof_straw',            type: 'style',     category: 'roof',         name: 'Straw Roof',             rarity: 'common'),
  SeedItem(id: 'style_roof_tile',             type: 'style',     category: 'roof',         name: 'Terracotta Tile Roof',   rarity: 'rare'),
  SeedItem(id: 'style_roof_tile_gold',        type: 'style',     category: 'roof',         name: 'Golden Tile Roof',       rarity: 'legendary'),
  SeedItem(id: 'style_wall_whitewash',        type: 'style',     category: 'wall',         name: 'Whitewash Wall',         rarity: 'common'),
  SeedItem(id: 'style_wall_stone',            type: 'style',     category: 'wall',         name: 'Stone Wall',             rarity: 'rare'),
  SeedItem(id: 'furn_cozy_sofa',              type: 'furniture', category: 'sofa',         name: 'Cozy Sofa',              rarity: 'common'),
  SeedItem(id: 'furn_bear_chair',             type: 'furniture', category: 'chair',        name: 'Bear Armchair',          rarity: 'rare'),
  SeedItem(id: 'furn_neon_lamp',              type: 'furniture', category: 'lamp',         name: 'Neon Lamp',              rarity: 'legendary'),
  SeedItem(id: 'furn_retro_tv',               type: 'furniture', category: 'tv',           name: 'Retro TV',               rarity: 'common'),
  SeedItem(id: 'furn_bunk_bed',               type: 'furniture', category: 'bed',          name: 'Bunk Bed',               rarity: 'rare'),
  SeedItem(id: 'furn_bunk_walnut',            type: 'furniture', category: 'bed',          name: 'Walnut Bunk Bed',        rarity: 'common'),
  SeedItem(id: 'furn_bunk_charcoal',          type: 'furniture', category: 'bed',          name: 'Charcoal Bunk Bed',      rarity: 'common'),
  SeedItem(id: 'furn_bunk_pine',              type: 'furniture', category: 'bed',          name: 'Pine Bunk Bed',          rarity: 'common'),
  SeedItem(id: 'furn_bunk_sage',              type: 'furniture', category: 'bed',          name: 'Sage Bunk Bed',          rarity: 'common'),
  SeedItem(id: 'furn_bunk_princess',          type: 'furniture', category: 'bed',          name: 'Princess Bunk Bed',      rarity: 'legendary'),
  SeedItem(id: 'furn_bunk_race_car',          type: 'furniture', category: 'bed',          name: 'Race Car Bunk Bed',      rarity: 'legendary'),
  SeedItem(id: 'char_cleaner',                type: 'character', category: 'character',    name: 'Pro Cleaner',            rarity: 'common'),
  SeedItem(id: 'char_gardener',               type: 'character', category: 'character',    name: 'Gardener',               rarity: 'rare'),
  SeedItem(id: 'char_chef',                   type: 'character', category: 'character',    name: 'Chef',                   rarity: 'common'),
  SeedItem(id: 'char_knight',                 type: 'character', category: 'character',    name: 'Knight',                 rarity: 'legendary'),
  SeedItem(id: 'char_astronaut',              type: 'character', category: 'character',    name: 'Astronaut',              rarity: 'legendary'),
  // Mirrors collection_seed.dart, which placed it here for the same reason: it
  // is a character look, not a fox outfit, so `subject` is 'character' and the
  // kFoxOutfitIdPrefix convention deliberately does not apply. Grant-only until
  // now — #240's validator refuses any offer naming an id absent from this
  // list, so the guard that makes the shop safe is what kept it out of one.
  SeedItem(id: 'char_pyjama',                 type: 'character', category: 'character',    name: 'Pyjamas',                rarity: 'legendary'),
  // --- Day-one set: sofa finishes (W3-08) ---------------------------------
  // Commons are palette swaps of the shipped mesh; the rare is a two-tone of
  // the same mesh, so neither costs new geometry.
  //
  // The legendary is NOT free and was not in the original plan for this window.
  // It is here because the completeness rule above leaves furniture with no
  // eligible subject otherwise, and furniture is the MOST COMMON chest type —
  // the rotation would have shipped with a third of it dead. Of the three
  // legendaries the design sheet lists (modern+pillows, bubble, curved), only
  // modern+pillows is additive geometry on the existing mesh; bubble and
  // curved are new silhouettes needing reference sheets that do not exist.
  SeedItem(id: 'furn_sofa_brown',             type: 'furniture', category: 'sofa',         name: 'Walnut Sofa',            rarity: 'common'),
  SeedItem(id: 'furn_sofa_charcoal',          type: 'furniture', category: 'sofa',         name: 'Charcoal Sofa',          rarity: 'common'),
  SeedItem(id: 'furn_sofa_ivory',             type: 'furniture', category: 'sofa',         name: 'Ivory Sofa',             rarity: 'common'),
  SeedItem(id: 'furn_sofa_sage',              type: 'furniture', category: 'sofa',         name: 'Sage Sofa',              rarity: 'common'),
  SeedItem(id: 'furn_sofa_two_tone',          type: 'furniture', category: 'sofa',         name: 'Two-Tone Sofa',          rarity: 'rare'),
  SeedItem(id: 'furn_sofa_modern',            type: 'furniture', category: 'sofa',         name: 'Modern Sofa',            rarity: 'legendary'),
  SeedItem(id: 'furn_sofa_cream',             type: 'furniture', category: 'sofa',         name: 'Cream Sofa',             rarity: 'common'),
  // --- Day-one set: outside plants (W3-08) --------------------------------
  // Arrangements — compositions of exterior props that ALREADY EXIST, so no
  // variant costs new art. That constraint is not laziness: no `ext_*` asset
  // has ever had a `ref_index.json` entry, which means there is no reference,
  // no mask and no material tier for any exterior prop, and `verify_shape` —
  // the only blocking shape gate — cannot run on one at all. A new exterior
  // prop would have to ship ungated.
  //
  // So the set is built from the three props that are real and reviewed
  // (conifer, rock, flower cluster). The design sheet's square/round bushes,
  // desert, bamboo and Japanese garden all need props that do not exist and
  // are recorded in spec-2026-08-05-w3-08-blocked-subjects.md instead.
  SeedItem(id: 'style_ext_lawn_default',      type: 'style',     category: 'exterior',     name: 'Woodland Lawn',          rarity: 'common'),
  SeedItem(id: 'style_ext_orchard_rows',      type: 'style',     category: 'exterior',     name: 'Orchard Rows',           rarity: 'common'),
  SeedItem(id: 'style_ext_rock_garden',       type: 'style',     category: 'exterior',     name: 'Rock Garden',            rarity: 'common'),
  SeedItem(id: 'style_ext_wildflower',        type: 'style',     category: 'exterior',     name: 'Wildflower Meadow',      rarity: 'common'),
  SeedItem(id: 'style_ext_clean_lawn',        type: 'style',     category: 'exterior',     name: 'Clean Lawn',             rarity: 'rare'),
  SeedItem(id: 'style_ext_flower_bed',        type: 'style',     category: 'exterior',     name: 'Flower Beds',            rarity: 'rare'),
  SeedItem(id: 'style_ext_garden_path',       type: 'style',     category: 'exterior',     name: 'Garden Path',            rarity: 'legendary'),
  // --- Day-one set: fox outfits (W3-09) -----------------------------------
  // The first per-character outfit set, which is what `SeedItem.subject`'s
  // "'character' until per-character outfit sets land" comment anticipated.
  //
  // 🔑 THESE ARE THE ONLY CHARACTER ROWS WITH ART. The five profession rows
  // above (cleaner/gardener/chef/knight/astronaut) have never had an assetPath
  // and render as MaterialIcons glyphs; these eleven each ship an avatar and a
  // die-cut album card, and equipping one visibly changes the player's avatar.
  //
  // 🔑 golden_suit IS RARE, NOT LEGENDARY, and that is a decision not an
  // oversight. decisions-2026-08-05-legendary-tier.md rules that a legendary
  // must change the SILHOUETTE; rendered correctly per Style B (no metal, no
  // gleam, no aura) the golden suit is the black suit in a warmer colour with
  // an identical outline. `space_suit` (helmet) and `bubble_bath` (cap, towel,
  // bubbles) do change the outline and carry the tier on their own, so the
  // legendary cell stays non-empty and the coverage test cannot go red.
  //
  // ⚠️ 4 common / 5 rare / 2 legendary. The ladder is rare-heavy because the
  // golden suit moved down, not because a rare was authored to fill it.
  SeedItem(id: 'char_fox_baseball_hat',       type: 'character', category: 'character',    name: 'Baseball Cap',           rarity: 'common'),
  SeedItem(id: 'char_fox_graphic_tee',        type: 'character', category: 'character',    name: 'Graphic Tee',            rarity: 'common'),
  SeedItem(id: 'char_fox_cool_shades',        type: 'character', category: 'character',    name: 'Cool Shades',            rarity: 'common'),
  SeedItem(id: 'char_fox_chef_hat',           type: 'character', category: 'character',    name: 'Chef Hat',               rarity: 'common'),
  SeedItem(id: 'char_fox_runner',             type: 'character', category: 'character',    name: 'Runner Kit',             rarity: 'rare'),
  SeedItem(id: 'char_fox_chef',               type: 'character', category: 'character',    name: 'Chef Whites',            rarity: 'rare'),
  SeedItem(id: 'char_fox_oversized_hoodie',   type: 'character', category: 'character',    name: 'Oversized Hoodie',       rarity: 'rare'),
  SeedItem(id: 'char_fox_black_suit',         type: 'character', category: 'character',    name: 'Black Suit',             rarity: 'rare'),
  SeedItem(id: 'char_fox_golden_suit',        type: 'character', category: 'character',    name: 'Golden Suit',            rarity: 'rare'),
  SeedItem(id: 'char_fox_space_suit',         type: 'character', category: 'character',    name: 'Space Suit',             rarity: 'legendary'),
  SeedItem(id: 'char_fox_bubble_bath',        type: 'character', category: 'character',    name: 'Bubble Bath',            rarity: 'legendary'),
  // --- Finish sets: armchair and tv_stand (W3-117, #547) ------------------
  // Baked ahead of their consumer and wired here. The ladder mirrors the sofa
  // set by FINISH: four commons that are palette swaps of the shipped mesh,
  // one rare two-tone of it, one legendary.
  //
  // 📌 `furn_tv_stand_console` IS A LEGENDARY THAT DOES NOT CHANGE THE
  // OUTLINE, which decisions-2026-08-05-legendary-tier.md otherwise forbids,
  // and it is argued rather than overlooked. #547 records tv_stand as
  // `verify_shape`-WAIVED (IoU 0.778/0.779 against an 0.80 floor), so a
  // silhouette-changing legendary in this slot could not be gated on shape at
  // all; its ladder is built from material-slot count instead. Do not
  // re-derive this as a defect.
  //
  // 📌 BOTH SUBJECTS ARE NOW IN ROTATION (W2-130). Wiring the rows was not
  // unbenching them — that took the separate ruling recorded on
  // DAILY_SUBJECT_POOLS above, which Brendan gave on 2026-08-19. `furniture` is
  // ['sofa', 'armchair', 'tv_stand'], so sofa now appears one day in three.
  SeedItem(id: 'furn_armchair_walnut',        type: 'furniture', category: 'chair',        name: 'Walnut Armchair',        rarity: 'common'),
  SeedItem(id: 'furn_armchair_charcoal',      type: 'furniture', category: 'chair',        name: 'Charcoal Armchair',      rarity: 'common'),
  SeedItem(id: 'furn_armchair_ivory',         type: 'furniture', category: 'chair',        name: 'Ivory Armchair',         rarity: 'common'),
  SeedItem(id: 'furn_armchair_sage',          type: 'furniture', category: 'chair',        name: 'Sage Armchair',          rarity: 'common'),
  SeedItem(id: 'furn_armchair_two_tone',      type: 'furniture', category: 'chair',        name: 'Two-Tone Armchair',      rarity: 'rare'),
  SeedItem(id: 'furn_armchair_wing',          type: 'furniture', category: 'chair',        name: 'Wing Armchair',          rarity: 'legendary'),
  SeedItem(id: 'furn_tv_stand_walnut',        type: 'furniture', category: 'tv',           name: 'Walnut TV Stand',        rarity: 'common'),
  SeedItem(id: 'furn_tv_stand_charcoal',      type: 'furniture', category: 'tv',           name: 'Charcoal TV Stand',      rarity: 'common'),
  SeedItem(id: 'furn_tv_stand_butter',        type: 'furniture', category: 'tv',           name: 'Butter TV Stand',        rarity: 'common'),
  SeedItem(id: 'furn_tv_stand_mint',          type: 'furniture', category: 'tv',           name: 'Mint TV Stand',          rarity: 'common'),
  SeedItem(id: 'furn_tv_stand_two_tone',      type: 'furniture', category: 'tv',           name: 'Two-Tone TV Stand',      rarity: 'rare'),
  SeedItem(id: 'furn_tv_stand_console',       type: 'furniture', category: 'tv',           name: 'Console TV Stand',       rarity: 'legendary'),
  SeedItem(id: 'furn_bathtub_charcoal',       type: 'furniture', category: 'bathtub',      name: 'Charcoal Bathtub',       rarity: 'common'),
  SeedItem(id: 'furn_bathtub_sage',           type: 'furniture', category: 'bathtub',      name: 'Sage Bathtub',           rarity: 'common'),
  SeedItem(id: 'furn_bathtub_sand',           type: 'furniture', category: 'bathtub',      name: 'Sand Bathtub',           rarity: 'common'),
  SeedItem(id: 'furn_bathtub_slate',          type: 'furniture', category: 'bathtub',      name: 'Slate Bathtub',          rarity: 'common'),
  SeedItem(id: 'furn_bathtub_slipper',        type: 'furniture', category: 'bathtub',      name: 'Slipper Bathtub',        rarity: 'legendary'),
  SeedItem(id: 'furn_bathtub_two_tone',       type: 'furniture', category: 'bathtub',      name: 'Two-Tone Bathtub',       rarity: 'rare'),
  SeedItem(id: 'furn_bookshelf_caramel',      type: 'furniture', category: 'bookshelf',    name: 'Caramel Bookshelf',      rarity: 'common'),
  SeedItem(id: 'furn_bookshelf_charcoal',     type: 'furniture', category: 'bookshelf',    name: 'Charcoal Bookshelf',     rarity: 'common'),
  SeedItem(id: 'furn_bookshelf_ivory',        type: 'furniture', category: 'bookshelf',    name: 'Ivory Bookshelf',        rarity: 'common'),
  SeedItem(id: 'furn_bookshelf_library',      type: 'furniture', category: 'bookshelf',    name: 'Library Bookshelf',      rarity: 'legendary'),
  SeedItem(id: 'furn_bookshelf_sage',         type: 'furniture', category: 'bookshelf',    name: 'Sage Bookshelf',         rarity: 'common'),
  SeedItem(id: 'furn_bookshelf_two_tone',     type: 'furniture', category: 'bookshelf',    name: 'Two-Tone Bookshelf',     rarity: 'rare'),
  SeedItem(id: 'furn_coffee_table_caramel',   type: 'furniture', category: 'coffee_table', name: 'Caramel Coffee Table',   rarity: 'common'),
  SeedItem(id: 'furn_coffee_table_charcoal',  type: 'furniture', category: 'coffee_table', name: 'Charcoal Coffee Table',  rarity: 'common'),
  SeedItem(id: 'furn_coffee_table_ivory',     type: 'furniture', category: 'coffee_table', name: 'Ivory Coffee Table',     rarity: 'common'),
  SeedItem(id: 'furn_coffee_table_sage',      type: 'furniture', category: 'coffee_table', name: 'Sage Coffee Table',      rarity: 'common'),
  SeedItem(id: 'furn_counter_caramel',        type: 'furniture', category: 'counter',      name: 'Caramel Counter',        rarity: 'common'),
  SeedItem(id: 'furn_counter_charcoal',       type: 'furniture', category: 'counter',      name: 'Charcoal Counter',       rarity: 'common'),
  SeedItem(id: 'furn_counter_ivory',          type: 'furniture', category: 'counter',      name: 'Ivory Counter',          rarity: 'common'),
  SeedItem(id: 'furn_counter_open_shelf',     type: 'furniture', category: 'counter',      name: 'Open Shelf Counter',     rarity: 'legendary'),
  SeedItem(id: 'furn_counter_sage',           type: 'furniture', category: 'counter',      name: 'Sage Counter',           rarity: 'common'),
  SeedItem(id: 'furn_counter_two_tone',       type: 'furniture', category: 'counter',      name: 'Two-Tone Counter',       rarity: 'rare'),
  SeedItem(id: 'furn_desk_caramel',           type: 'furniture', category: 'desk',         name: 'Caramel Desk',           rarity: 'common'),
  SeedItem(id: 'furn_desk_charcoal',          type: 'furniture', category: 'desk',         name: 'Charcoal Desk',          rarity: 'common'),
  SeedItem(id: 'furn_desk_ivory',             type: 'furniture', category: 'desk',         name: 'Ivory Desk',             rarity: 'common'),
  SeedItem(id: 'furn_desk_sage',              type: 'furniture', category: 'desk',         name: 'Sage Desk',              rarity: 'common'),
  SeedItem(id: 'furn_desk_two_tone',          type: 'furniture', category: 'desk',         name: 'Two-Tone Desk',          rarity: 'rare'),
  SeedItem(id: 'furn_dining_table_caramel',   type: 'furniture', category: 'dining_table', name: 'Caramel Dining Table',   rarity: 'common'),
  SeedItem(id: 'furn_dining_table_charcoal',  type: 'furniture', category: 'dining_table', name: 'Charcoal Dining Table',  rarity: 'common'),
  SeedItem(id: 'furn_dining_table_ivory',     type: 'furniture', category: 'dining_table', name: 'Ivory Dining Table',     rarity: 'common'),
  SeedItem(id: 'furn_dining_table_sage',      type: 'furniture', category: 'dining_table', name: 'Sage Dining Table',      rarity: 'common'),
  SeedItem(id: 'furn_dining_table_trestle',   type: 'furniture', category: 'dining_table', name: 'Trestle Dining Table',   rarity: 'legendary'),
  SeedItem(id: 'furn_dining_table_two_tone',  type: 'furniture', category: 'dining_table', name: 'Two-Tone Dining Table',  rarity: 'rare'),
  SeedItem(id: 'furn_dresser_caramel',        type: 'furniture', category: 'dresser',      name: 'Caramel Dresser',        rarity: 'common'),
  SeedItem(id: 'furn_dresser_charcoal',       type: 'furniture', category: 'dresser',      name: 'Charcoal Dresser',       rarity: 'common'),
  SeedItem(id: 'furn_dresser_ivory',          type: 'furniture', category: 'dresser',      name: 'Ivory Dresser',          rarity: 'common'),
  SeedItem(id: 'furn_dresser_sage',           type: 'furniture', category: 'dresser',      name: 'Sage Dresser',           rarity: 'common'),
  SeedItem(id: 'furn_dresser_two_tone',       type: 'furniture', category: 'dresser',      name: 'Two-Tone Dresser',       rarity: 'rare'),
  SeedItem(id: 'furn_fridge_butter',          type: 'furniture', category: 'fridge',       name: 'Butter Fridge',          rarity: 'common'),
  SeedItem(id: 'furn_fridge_charcoal',        type: 'furniture', category: 'fridge',       name: 'Charcoal Fridge',        rarity: 'common'),
  SeedItem(id: 'furn_fridge_mint',            type: 'furniture', category: 'fridge',       name: 'Mint Fridge',            rarity: 'common'),
  SeedItem(id: 'furn_fridge_retro',           type: 'furniture', category: 'fridge',       name: 'Retro Fridge',           rarity: 'legendary'),
  SeedItem(id: 'furn_fridge_terracotta',      type: 'furniture', category: 'fridge',       name: 'Terracotta Fridge',      rarity: 'common'),
  SeedItem(id: 'furn_fridge_two_tone',        type: 'furniture', category: 'fridge',       name: 'Two-Tone Fridge',        rarity: 'rare'),
  SeedItem(id: 'furn_shower_charcoal',        type: 'furniture', category: 'shower',       name: 'Charcoal Shower',        rarity: 'common'),
  SeedItem(id: 'furn_shower_glass',           type: 'furniture', category: 'shower',       name: 'Glass Shower',           rarity: 'legendary'),
  SeedItem(id: 'furn_shower_sage',            type: 'furniture', category: 'shower',       name: 'Sage Shower',            rarity: 'common'),
  SeedItem(id: 'furn_shower_sand',            type: 'furniture', category: 'shower',       name: 'Sand Shower',            rarity: 'common'),
  SeedItem(id: 'furn_shower_slate',           type: 'furniture', category: 'shower',       name: 'Slate Shower',           rarity: 'common'),
  SeedItem(id: 'furn_shower_two_tone',        type: 'furniture', category: 'shower',       name: 'Two-Tone Shower',        rarity: 'rare'),
  SeedItem(id: 'furn_sink_caramel',           type: 'furniture', category: 'sink',         name: 'Caramel Sink',           rarity: 'common'),
  SeedItem(id: 'furn_sink_charcoal',          type: 'furniture', category: 'sink',         name: 'Charcoal Sink',          rarity: 'common'),
  SeedItem(id: 'furn_sink_farmhouse',         type: 'furniture', category: 'sink',         name: 'Farmhouse Sink',         rarity: 'legendary'),
  SeedItem(id: 'furn_sink_sage',              type: 'furniture', category: 'sink',         name: 'Sage Sink',              rarity: 'common'),
  SeedItem(id: 'furn_sink_stone',             type: 'furniture', category: 'sink',         name: 'Stone Sink',             rarity: 'common'),
  SeedItem(id: 'furn_sink_two_tone',          type: 'furniture', category: 'sink',         name: 'Two-Tone Sink',          rarity: 'rare'),
  // --- Finish ladders: twelve props (W2-159) ------------------------------
  // Twelve props whose finish sprites were baked and unreferenced. category is 1:1 with the prop rather than grouped: kFurnSeedCategoryToBasePiece already maps chair->armchair and bed->bunk_bed, so reusing those categories would silently resolve to the wrong base piece. family and rarity are derived from the committed rows, where each finish token maps to exactly one family with zero conflicts. prop_washer_01_spin and _spin_rot90 are deliberately absent: they are 4096x512 eight-frame animation strips, not finishes. bed_double, lamp_table and stove_hood are held back because they have no FurnitureCatalogue entry.
  SeedItem(id: 'furn_bed_single_caramel',     type: 'furniture', category: 'bed_single',   name: 'Caramel Single Bed',     rarity: 'common'),
  SeedItem(id: 'furn_bed_single_charcoal',    type: 'furniture', category: 'bed_single',   name: 'Charcoal Single Bed',    rarity: 'common'),
  SeedItem(id: 'furn_bed_single_ivory',       type: 'furniture', category: 'bed_single',   name: 'Ivory Single Bed',       rarity: 'common'),
  SeedItem(id: 'furn_bed_single_sage',        type: 'furniture', category: 'bed_single',   name: 'Sage Single Bed',        rarity: 'common'),
  SeedItem(id: 'furn_bed_single_two_tone',    type: 'furniture', category: 'bed_single',   name: 'Two-Tone Single Bed',    rarity: 'rare'),
  // 🔴 RARITY AND FAMILY ARE PROVISIONAL - W1-201, pending Brendan's confirmation.
  // They are the MECHANICAL derivation, not a ruling, and the two rules agree:
  //   . furn_bunk_race_car, the only other `race_car` token in the seed, is committed
  //     at legendary/oakhouse - one precedent, zero conflicts.
  //   . 15 of the 16 furniture legendaries carry family `oakhouse`; the 16th,
  //     furn_neon_lamp, is a pre-ladder row with no family at all.
  // This gives the single its FIRST legendary and the double a SECOND beside
  // four_poster - which is the part that is Brendan's to accept, not the tier itself.
  // Changing it costs these two fields plus `npm --prefix functions run seed:gen`.
  // DELETE THIS NOTE ON CONFIRMATION.
  SeedItem(id: 'furn_bed_single_race_car',    type: 'furniture', category: 'bed_single',   name: 'Race Car Single Bed',    rarity: 'legendary'),
  SeedItem(id: 'furn_bench_caramel',          type: 'furniture', category: 'bench',        name: 'Caramel Bench',          rarity: 'common'),
  SeedItem(id: 'furn_bench_charcoal',         type: 'furniture', category: 'bench',        name: 'Charcoal Bench',         rarity: 'common'),
  SeedItem(id: 'furn_bench_ivory',            type: 'furniture', category: 'bench',        name: 'Ivory Bench',            rarity: 'common'),
  SeedItem(id: 'furn_bench_sage',             type: 'furniture', category: 'bench',        name: 'Sage Bench',             rarity: 'common'),
  SeedItem(id: 'furn_bench_two_tone',         type: 'furniture', category: 'bench',        name: 'Two-Tone Bench',         rarity: 'rare'),
  SeedItem(id: 'furn_cabinet_caramel',        type: 'furniture', category: 'cabinet',      name: 'Caramel Cabinet',        rarity: 'common'),
  SeedItem(id: 'furn_cabinet_charcoal',       type: 'furniture', category: 'cabinet',      name: 'Charcoal Cabinet',       rarity: 'common'),
  SeedItem(id: 'furn_cabinet_ivory',          type: 'furniture', category: 'cabinet',      name: 'Ivory Cabinet',          rarity: 'common'),
  SeedItem(id: 'furn_cabinet_sage',           type: 'furniture', category: 'cabinet',      name: 'Sage Cabinet',           rarity: 'common'),
  SeedItem(id: 'furn_cabinet_two_tone',       type: 'furniture', category: 'cabinet',      name: 'Two-Tone Cabinet',       rarity: 'rare'),
  SeedItem(id: 'furn_dining_chair_caramel',   type: 'furniture', category: 'dining_chair', name: 'Caramel Dining Chair',   rarity: 'common'),
  SeedItem(id: 'furn_dining_chair_charcoal',  type: 'furniture', category: 'dining_chair', name: 'Charcoal Dining Chair',  rarity: 'common'),
  SeedItem(id: 'furn_dining_chair_ivory',     type: 'furniture', category: 'dining_chair', name: 'Ivory Dining Chair',     rarity: 'common'),
  SeedItem(id: 'furn_dining_chair_sage',      type: 'furniture', category: 'dining_chair', name: 'Sage Dining Chair',      rarity: 'common'),
  SeedItem(id: 'furn_dryer_butter',           type: 'furniture', category: 'dryer',        name: 'Butter Dryer',           rarity: 'common'),
  SeedItem(id: 'furn_dryer_mint',             type: 'furniture', category: 'dryer',        name: 'Mint Dryer',             rarity: 'common'),
  SeedItem(id: 'furn_dryer_slate',            type: 'furniture', category: 'dryer',        name: 'Slate Dryer',            rarity: 'common'),
  SeedItem(id: 'furn_dryer_terracotta',       type: 'furniture', category: 'dryer',        name: 'Terracotta Dryer',       rarity: 'common'),
  SeedItem(id: 'furn_dryer_two_tone',         type: 'furniture', category: 'dryer',        name: 'Two-Tone Dryer',         rarity: 'rare'),
  SeedItem(id: 'furn_microwave_butter',       type: 'furniture', category: 'microwave',    name: 'Butter Microwave',       rarity: 'common'),
  SeedItem(id: 'furn_microwave_mint',         type: 'furniture', category: 'microwave',    name: 'Mint Microwave',         rarity: 'common'),
  SeedItem(id: 'furn_microwave_slate',        type: 'furniture', category: 'microwave',    name: 'Slate Microwave',        rarity: 'common'),
  SeedItem(id: 'furn_microwave_terracotta',   type: 'furniture', category: 'microwave',    name: 'Terracotta Microwave',   rarity: 'common'),
  SeedItem(id: 'furn_microwave_two_tone',     type: 'furniture', category: 'microwave',    name: 'Two-Tone Microwave',     rarity: 'rare'),
  SeedItem(id: 'furn_nightstand_caramel',     type: 'furniture', category: 'nightstand',   name: 'Caramel Nightstand',     rarity: 'common'),
  SeedItem(id: 'furn_nightstand_charcoal',    type: 'furniture', category: 'nightstand',   name: 'Charcoal Nightstand',    rarity: 'common'),
  SeedItem(id: 'furn_nightstand_ivory',       type: 'furniture', category: 'nightstand',   name: 'Ivory Nightstand',       rarity: 'common'),
  SeedItem(id: 'furn_nightstand_sage',        type: 'furniture', category: 'nightstand',   name: 'Sage Nightstand',        rarity: 'common'),
  SeedItem(id: 'furn_nightstand_two_tone',    type: 'furniture', category: 'nightstand',   name: 'Two-Tone Nightstand',    rarity: 'rare'),
  SeedItem(id: 'furn_office_chair_caramel',   type: 'furniture', category: 'office_chair', name: 'Caramel Office Chair',   rarity: 'common'),
  SeedItem(id: 'furn_office_chair_charcoal',  type: 'furniture', category: 'office_chair', name: 'Charcoal Office Chair',  rarity: 'common'),
  SeedItem(id: 'furn_office_chair_ivory',     type: 'furniture', category: 'office_chair', name: 'Ivory Office Chair',     rarity: 'common'),
  SeedItem(id: 'furn_office_chair_sage',      type: 'furniture', category: 'office_chair', name: 'Sage Office Chair',      rarity: 'common'),
  SeedItem(id: 'furn_office_chair_two_tone',  type: 'furniture', category: 'office_chair', name: 'Two-Tone Office Chair',  rarity: 'rare'),
  SeedItem(id: 'furn_side_table_caramel',     type: 'furniture', category: 'side_table',   name: 'Caramel Side Table',     rarity: 'common'),
  SeedItem(id: 'furn_side_table_charcoal',    type: 'furniture', category: 'side_table',   name: 'Charcoal Side Table',    rarity: 'common'),
  SeedItem(id: 'furn_side_table_ivory',       type: 'furniture', category: 'side_table',   name: 'Ivory Side Table',       rarity: 'common'),
  SeedItem(id: 'furn_side_table_sage',        type: 'furniture', category: 'side_table',   name: 'Sage Side Table',        rarity: 'common'),
  SeedItem(id: 'furn_side_table_two_tone',    type: 'furniture', category: 'side_table',   name: 'Two-Tone Side Table',    rarity: 'rare'),
  SeedItem(id: 'furn_stool_caramel',          type: 'furniture', category: 'stool',        name: 'Caramel Stool',          rarity: 'common'),
  SeedItem(id: 'furn_stool_charcoal',         type: 'furniture', category: 'stool',        name: 'Charcoal Stool',         rarity: 'common'),
  SeedItem(id: 'furn_stool_ivory',            type: 'furniture', category: 'stool',        name: 'Ivory Stool',            rarity: 'common'),
  SeedItem(id: 'furn_stool_sage',             type: 'furniture', category: 'stool',        name: 'Sage Stool',             rarity: 'common'),
  SeedItem(id: 'furn_stool_two_tone',         type: 'furniture', category: 'stool',        name: 'Two-Tone Stool',         rarity: 'rare'),
  SeedItem(id: 'furn_wardrobe_caramel',       type: 'furniture', category: 'wardrobe',     name: 'Caramel Wardrobe',       rarity: 'common'),
  SeedItem(id: 'furn_wardrobe_charcoal',      type: 'furniture', category: 'wardrobe',     name: 'Charcoal Wardrobe',      rarity: 'common'),
  SeedItem(id: 'furn_wardrobe_ivory',         type: 'furniture', category: 'wardrobe',     name: 'Ivory Wardrobe',         rarity: 'common'),
  SeedItem(id: 'furn_wardrobe_sage',          type: 'furniture', category: 'wardrobe',     name: 'Sage Wardrobe',          rarity: 'common'),
  SeedItem(id: 'furn_wardrobe_two_tone',      type: 'furniture', category: 'wardrobe',     name: 'Two-Tone Wardrobe',      rarity: 'rare'),
  SeedItem(id: 'furn_washer_butter',          type: 'furniture', category: 'washer',       name: 'Butter Washer',          rarity: 'common'),
  SeedItem(id: 'furn_washer_mint',            type: 'furniture', category: 'washer',       name: 'Mint Washer',            rarity: 'common'),
  SeedItem(id: 'furn_washer_slate',           type: 'furniture', category: 'washer',       name: 'Slate Washer',           rarity: 'common'),
  SeedItem(id: 'furn_washer_terracotta',      type: 'furniture', category: 'washer',       name: 'Terracotta Washer',      rarity: 'common'),
  SeedItem(id: 'furn_washer_two_tone',        type: 'furniture', category: 'washer',       name: 'Two-Tone Washer',        rarity: 'rare'),
  // --- Finish ladders: the last three props (W2-160) ----------------------
  // The last three finish ladders, and all three carried a trap worth recording.
  //
  // 1. bed_double is `furn_bed_double_*`, NOT `furn_bed_*`. The latter is a prefix of
  //    every furn_bed_single_* id and would make each match two expectedSlot entries;
  //    furniture_skin_sprite_test.dart warned about it. These diverge at char 10, so
  //    the existing row is left alone and a sibling is added beside it.
  // 2. category is `bed_double`, and its kFurnSeedCategoryToBasePiece entry is
  //    ASYMMETRIC: bed_double -> bed. The seed category `bed` already means the BUNK
  //    bed while the CATALOGUE slot `bed` is the DOUBLE bed. Using `bed` here would
  //    silently draw the wrong prop.
  // 3. The lamp rows are subject `lamp`, not `lamp_table`. Catalogue slot `lamp` is
  //    drawn by prop_lamp_table_01.png and furn_neon_lamp already sits there, so
  //    these join an existing subject rather than opening a new one.
  //
  // four_poster, lantern and range are FORMS with no token precedent; their
  // legendary/oakhouse is DERIVED from the 11-of-11 form rule, not looked up.
  SeedItem(id: 'furn_bed_double_caramel',     type: 'furniture', category: 'bed_double',   name: 'Caramel Double Bed',     rarity: 'common'),
  SeedItem(id: 'furn_bed_double_charcoal',    type: 'furniture', category: 'bed_double',   name: 'Charcoal Double Bed',    rarity: 'common'),
  SeedItem(id: 'furn_bed_double_four_poster', type: 'furniture', category: 'bed_double',   name: 'Four-Poster Double Bed', rarity: 'legendary'),
  SeedItem(id: 'furn_bed_double_ivory',       type: 'furniture', category: 'bed_double',   name: 'Ivory Double Bed',       rarity: 'common'),
  SeedItem(id: 'furn_bed_double_sage',        type: 'furniture', category: 'bed_double',   name: 'Sage Double Bed',        rarity: 'common'),
  SeedItem(id: 'furn_bed_double_two_tone',    type: 'furniture', category: 'bed_double',   name: 'Two-Tone Double Bed',    rarity: 'rare'),
  // 🔴 RARITY AND FAMILY ARE PROVISIONAL - W1-201, pending Brendan's confirmation.
  // They are the MECHANICAL derivation, not a ruling, and the two rules agree:
  //   . furn_bunk_race_car, the only other `race_car` token in the seed, is committed
  //     at legendary/oakhouse - one precedent, zero conflicts.
  //   . 15 of the 16 furniture legendaries carry family `oakhouse`; the 16th,
  //     furn_neon_lamp, is a pre-ladder row with no family at all.
  // This gives the single its FIRST legendary and the double a SECOND beside
  // four_poster - which is the part that is Brendan's to accept, not the tier itself.
  // Changing it costs these two fields plus `npm --prefix functions run seed:gen`.
  // DELETE THIS NOTE ON CONFIRMATION.
  SeedItem(id: 'furn_bed_double_race_car',    type: 'furniture', category: 'bed_double',   name: 'Race Car Double Bed',    rarity: 'legendary'),
  SeedItem(id: 'furn_lamp_charcoal',          type: 'furniture', category: 'lamp',         name: 'Charcoal Lamp',          rarity: 'common'),
  SeedItem(id: 'furn_lamp_ivory',             type: 'furniture', category: 'lamp',         name: 'Ivory Lamp',             rarity: 'common'),
  SeedItem(id: 'furn_lamp_lantern',           type: 'furniture', category: 'lamp',         name: 'Lantern Lamp',           rarity: 'legendary'),
  SeedItem(id: 'furn_lamp_sage',              type: 'furniture', category: 'lamp',         name: 'Sage Lamp',              rarity: 'common'),
  SeedItem(id: 'furn_lamp_two_tone',          type: 'furniture', category: 'lamp',         name: 'Two-Tone Lamp',          rarity: 'rare'),
  SeedItem(id: 'furn_lamp_walnut',            type: 'furniture', category: 'lamp',         name: 'Walnut Lamp',            rarity: 'common'),
  SeedItem(id: 'furn_stove_hood_caramel',     type: 'furniture', category: 'stove_hood',   name: 'Caramel Stove Hood',     rarity: 'common'),
  SeedItem(id: 'furn_stove_hood_charcoal',    type: 'furniture', category: 'stove_hood',   name: 'Charcoal Stove Hood',    rarity: 'common'),
  SeedItem(id: 'furn_stove_hood_ivory',       type: 'furniture', category: 'stove_hood',   name: 'Ivory Stove Hood',       rarity: 'common'),
  SeedItem(id: 'furn_stove_hood_range',       type: 'furniture', category: 'stove_hood',   name: 'Range Stove Hood',       rarity: 'legendary'),
  SeedItem(id: 'furn_stove_hood_sage',        type: 'furniture', category: 'stove_hood',   name: 'Sage Stove Hood',        rarity: 'common'),
  SeedItem(id: 'furn_stove_hood_two_tone',    type: 'furniture', category: 'stove_hood',   name: 'Two-Tone Stove Hood',    rarity: 'rare'),

];

// ---------------------------------------------------------------------------
// Style families — mirror of functions/src/itemPool.ts
// ---------------------------------------------------------------------------
//
// SYNC: functions/src/itemPool.ts  STYLE_FAMILIES / ITEM_FAMILY / FAMILY_NEUTRAL
//
// #111 shipped the ledger in TypeScript only and left a test in
// dailyRotation.test.ts PINNING the gap — it asserted this file contained
// neither `kItemFamily` nor `kFamilyNeutral`, so writing them turned it red on
// purpose. That pin is deleted in the same change that adds these, and the
// real both-directions cross-mirror assertion replaces it.
//
// 🟡 WHAT IS DELIBERATELY NOT MIRRORED: `forbidden`, `material` and
// `silhouette`. Those are authoring constraints for whoever writes a bake
// prompt — nothing in `lib/` renders them, and copying them here would make a
// third copy of the same prose (the style-families wiki page and itemPool.ts
// being the first two). The client's use of a family is album grouping, which
// needs exactly three things: the key, a label, and a colour.

/// The four style families, in the order the album should present them.
///
/// Mirror of the keys of `STYLE_FAMILIES` in functions/src/itemPool.ts.
const List<String> kStyleFamilyIds = [
  'oakhouse',
  'quarry',
  'dovecote',
  'meadow',
];

/// Display name for each family — what an album section header reads.
///
/// Mirror of `STYLE_FAMILIES[key].label`.
const Map<String, String> kStyleFamilyLabel = {
  'oakhouse': 'Oakhouse',
  'quarry': 'Quarry',
  'dovecote': 'Dovecote',
  'meadow': 'Meadow',
};

/// The measured anchor colour of each family, as a 6-digit RRGGBB hex string.
///
/// Mirror of `STYLE_FAMILIES[key].palette.anchor`. These are MEASURED values
/// off the shipped proof assets, not picked — `oakhouse` #9C7358 is the walnut
/// swatch of the shipped brown sofa. Changing one here without a re-measure
/// makes the album disagree with the art.
///
/// Stored as a hex string rather than a `Color` so this file stays free of
/// `dart:ui` — it is pure-domain and imported by domain code, and a `Color`
/// literal would drag Flutter in.
///
/// ⚠️ UNCONSUMED AS OF THIS PR, and called out rather than dressed up. Nothing
/// in `lib/` paints these yet: the album (`customization_page.dart`) groups by
/// rarity and slot, not by family. They are written down now because the ledger
/// they belong to is being mirrored now, and splitting a four-row table across
/// two PRs is how mirrors drift. The intended consumer is album grouping — a
/// section per family, headed by the label and keyed by this swatch. Until that
/// lands, these two maps are asserted for self-consistency only, which is
/// strictly weaker than a real consumer.
const Map<String, String> kStyleFamilyAnchorHex = {
  'oakhouse': '9C7358',
  'quarry': '5F5A57',
  'dovecote': 'E3D6C7',
  'meadow': '9AA88E',
};

/// Seed id -> style family key, for the 26 rows that carry a family.
///
/// Mirror of `ITEM_FAMILY`. Order follows [kCollectionSeed] so the two can be
/// read side by side, and matches the TypeScript row order for the same reason.
///
/// Asserted in both directions against [kCollectionSeed] by
/// `test/features/customization/domain/style_family_ledger_test.dart`, and
/// against the TypeScript table itself by the cross-mirror gate in
/// `functions/src/__tests__/dailyRotation.test.ts` — ids AND family values, so
/// an item cannot be Oakhouse on one side and Quarry on the other.
const Map<String, String> kItemFamily = {
  'style_roof_straw':            'oakhouse',
  'style_roof_tile':             'oakhouse',
  'style_roof_tile_gold':        'oakhouse',
  'style_wall_whitewash':        'dovecote',
  'style_wall_stone':            'quarry',
  'furn_retro_tv':               'oakhouse',
  'furn_bunk_bed':               'oakhouse',
  'furn_bunk_walnut':            'oakhouse',
  'furn_bunk_charcoal':          'quarry',
  'furn_bunk_pine':              'oakhouse',
  'furn_bunk_sage':              'meadow',
  'furn_bunk_princess':          'oakhouse',
  'furn_bunk_race_car':          'oakhouse',
  'char_gardener':               'meadow',
  'furn_sofa_brown':             'oakhouse',
  'furn_sofa_charcoal':          'quarry',
  'furn_sofa_ivory':             'dovecote',
  'furn_sofa_sage':              'meadow',
  'furn_sofa_two_tone':          'oakhouse',
  'furn_sofa_modern':            'oakhouse',
  'furn_sofa_cream':             'dovecote',
  'style_ext_orchard_rows':      'oakhouse',
  'style_ext_rock_garden':       'quarry',
  'style_ext_wildflower':        'meadow',
  'style_ext_clean_lawn':        'dovecote',
  'style_ext_flower_bed':        'meadow',
  'style_ext_garden_path':       'quarry',
  'char_fox_runner':             'quarry',
  'char_fox_chef':               'dovecote',
  'char_fox_oversized_hoodie':   'quarry',
  'char_fox_black_suit':         'quarry',
  'char_fox_space_suit':         'dovecote',
  'char_fox_bubble_bath':        'dovecote',
  'furn_armchair_walnut':        'oakhouse',
  'furn_armchair_charcoal':      'quarry',
  'furn_armchair_ivory':         'dovecote',
  'furn_armchair_sage':          'meadow',
  'furn_armchair_two_tone':      'oakhouse',
  'furn_armchair_wing':          'oakhouse',
  'furn_tv_stand_walnut':        'oakhouse',
  'furn_tv_stand_charcoal':      'quarry',
  'furn_tv_stand_butter':        'dovecote',
  'furn_tv_stand_mint':          'meadow',
  'furn_tv_stand_two_tone':      'oakhouse',
  'furn_tv_stand_console':       'oakhouse',
  'furn_bathtub_charcoal':       'quarry',
  'furn_bathtub_sage':           'meadow',
  'furn_bathtub_sand':           'dovecote',
  'furn_bathtub_slate':          'quarry',
  'furn_bathtub_slipper':        'oakhouse',
  'furn_bathtub_two_tone':       'oakhouse',
  'furn_bookshelf_caramel':      'oakhouse',
  'furn_bookshelf_charcoal':     'quarry',
  'furn_bookshelf_ivory':        'dovecote',
  'furn_bookshelf_library':      'oakhouse',
  'furn_bookshelf_sage':         'meadow',
  'furn_bookshelf_two_tone':     'oakhouse',
  'furn_coffee_table_caramel':   'oakhouse',
  'furn_coffee_table_charcoal':  'quarry',
  'furn_coffee_table_ivory':     'dovecote',
  'furn_coffee_table_sage':      'meadow',
  'furn_counter_caramel':        'oakhouse',
  'furn_counter_charcoal':       'quarry',
  'furn_counter_ivory':          'dovecote',
  'furn_counter_open_shelf':     'oakhouse',
  'furn_counter_sage':           'meadow',
  'furn_counter_two_tone':       'oakhouse',
  'furn_desk_caramel':           'oakhouse',
  'furn_desk_charcoal':          'quarry',
  'furn_desk_ivory':             'dovecote',
  'furn_desk_sage':              'meadow',
  'furn_desk_two_tone':          'oakhouse',
  'furn_dining_table_caramel':   'oakhouse',
  'furn_dining_table_charcoal':  'quarry',
  'furn_dining_table_ivory':     'dovecote',
  'furn_dining_table_sage':      'meadow',
  'furn_dining_table_trestle':   'oakhouse',
  'furn_dining_table_two_tone':  'oakhouse',
  'furn_dresser_caramel':        'oakhouse',
  'furn_dresser_charcoal':       'quarry',
  'furn_dresser_ivory':          'dovecote',
  'furn_dresser_sage':           'meadow',
  'furn_dresser_two_tone':       'oakhouse',
  'furn_fridge_butter':          'dovecote',
  'furn_fridge_charcoal':        'quarry',
  'furn_fridge_mint':            'meadow',
  'furn_fridge_retro':           'oakhouse',
  'furn_fridge_terracotta':      'oakhouse',
  'furn_fridge_two_tone':        'oakhouse',
  'furn_shower_charcoal':        'quarry',
  'furn_shower_glass':           'oakhouse',
  'furn_shower_sage':            'meadow',
  'furn_shower_sand':            'dovecote',
  'furn_shower_slate':           'quarry',
  'furn_shower_two_tone':        'oakhouse',
  'furn_sink_caramel':           'oakhouse',
  'furn_sink_charcoal':          'quarry',
  'furn_sink_farmhouse':         'oakhouse',
  'furn_sink_sage':              'meadow',
  'furn_sink_stone':             'quarry',
  'furn_sink_two_tone':          'oakhouse',
  'furn_bed_single_caramel':     'oakhouse',
  'furn_bed_single_charcoal':    'quarry',
  'furn_bed_single_ivory':       'dovecote',
  'furn_bed_single_sage':        'meadow',
  'furn_bed_single_two_tone':    'oakhouse',
  'furn_bed_single_race_car':    'oakhouse',
  'furn_bench_caramel':          'oakhouse',
  'furn_bench_charcoal':         'quarry',
  'furn_bench_ivory':            'dovecote',
  'furn_bench_sage':             'meadow',
  'furn_bench_two_tone':         'oakhouse',
  'furn_cabinet_caramel':        'oakhouse',
  'furn_cabinet_charcoal':       'quarry',
  'furn_cabinet_ivory':          'dovecote',
  'furn_cabinet_sage':           'meadow',
  'furn_cabinet_two_tone':       'oakhouse',
  'furn_dining_chair_caramel':   'oakhouse',
  'furn_dining_chair_charcoal':  'quarry',
  'furn_dining_chair_ivory':     'dovecote',
  'furn_dining_chair_sage':      'meadow',
  'furn_dryer_butter':           'dovecote',
  'furn_dryer_mint':             'meadow',
  'furn_dryer_slate':            'quarry',
  'furn_dryer_terracotta':       'oakhouse',
  'furn_dryer_two_tone':         'oakhouse',
  'furn_microwave_butter':       'dovecote',
  'furn_microwave_mint':         'meadow',
  'furn_microwave_slate':        'quarry',
  'furn_microwave_terracotta':   'oakhouse',
  'furn_microwave_two_tone':     'oakhouse',
  'furn_nightstand_caramel':     'oakhouse',
  'furn_nightstand_charcoal':    'quarry',
  'furn_nightstand_ivory':       'dovecote',
  'furn_nightstand_sage':        'meadow',
  'furn_nightstand_two_tone':    'oakhouse',
  'furn_office_chair_caramel':   'oakhouse',
  'furn_office_chair_charcoal':  'quarry',
  'furn_office_chair_ivory':     'dovecote',
  'furn_office_chair_sage':      'meadow',
  'furn_office_chair_two_tone':  'oakhouse',
  'furn_side_table_caramel':     'oakhouse',
  'furn_side_table_charcoal':    'quarry',
  'furn_side_table_ivory':       'dovecote',
  'furn_side_table_sage':        'meadow',
  'furn_side_table_two_tone':    'oakhouse',
  'furn_stool_caramel':          'oakhouse',
  'furn_stool_charcoal':         'quarry',
  'furn_stool_ivory':            'dovecote',
  'furn_stool_sage':             'meadow',
  'furn_stool_two_tone':         'oakhouse',
  'furn_wardrobe_caramel':       'oakhouse',
  'furn_wardrobe_charcoal':      'quarry',
  'furn_wardrobe_ivory':         'dovecote',
  'furn_wardrobe_sage':          'meadow',
  'furn_wardrobe_two_tone':      'oakhouse',
  'furn_washer_butter':          'dovecote',
  'furn_washer_mint':            'meadow',
  'furn_washer_slate':           'quarry',
  'furn_washer_terracotta':      'oakhouse',
  'furn_washer_two_tone':        'oakhouse',
  'furn_bed_double_caramel':     'oakhouse',
  'furn_bed_double_charcoal':    'quarry',
  'furn_bed_double_four_poster': 'oakhouse',
  'furn_bed_double_ivory':       'dovecote',
  'furn_bed_double_sage':        'meadow',
  'furn_bed_double_two_tone':    'oakhouse',
  'furn_bed_double_race_car':    'oakhouse',
  'furn_lamp_charcoal':          'quarry',
  'furn_lamp_ivory':             'dovecote',
  'furn_lamp_lantern':           'oakhouse',
  'furn_lamp_sage':              'meadow',
  'furn_lamp_two_tone':          'oakhouse',
  'furn_lamp_walnut':            'oakhouse',
  'furn_stove_hood_caramel':     'oakhouse',
  'furn_stove_hood_charcoal':    'quarry',
  'furn_stove_hood_ivory':       'dovecote',
  'furn_stove_hood_range':       'oakhouse',
  'furn_stove_hood_sage':        'meadow',
  'furn_stove_hood_two_tone':    'oakhouse',

};

/// Seed ids that are deliberately family-LESS.
///
/// Mirror of `FAMILY_NEUTRAL`. The free tier is deliberately plain and
/// family-neutral: a free item carrying a family would make the free house read
/// as an incomplete purchase. The rest are roles and novelties whose shape is
/// the product.
///
/// 🔑 NEUTRAL IS A DECISION, AND THIS LIST IS WHERE IT IS RECORDED. That is why
/// family is a table and not an id-prefix convention — [kFoxOutfitIdPrefix]
/// below is the in-tree precedent for prefixes, and a prefix cannot express
/// "deliberately neutral" because a missing prefix is indistinguishable from a
/// forgotten one.
// 🔴 THE BODY BELOW IS GENERATED — KEEP PROSE ABOVE THIS LINE, NEVER INSIDE IT.
// `char_pyjama` is neutral BY DECISION, like the other four roles:
// `char_gardener` is the only character row with a family ('meadow') and earns
// it by being a gardener; sleepwear belongs to no house style, and giving it one
// would make the album group it with roofs and walls it has nothing to do with.
//
// ⚠️ THAT REASONING USED TO SIT INSIDE THE LIST AND W1-171 REGENERATED OVER IT.
// It survived only because nobody had re-emitted this table since it was
// written — `emitDartNeutral` returns ids and nothing else, so the first
// regeneration was always going to delete it. Moved out here, where the body
// swap cannot reach it.
const List<String> kFamilyNeutral = [
  'furn_cozy_sofa',
  'furn_bear_chair',
  'furn_neon_lamp',
  'char_cleaner',
  'char_chef',
  'char_knight',
  'char_astronaut',
  'char_pyjama',
  'style_ext_lawn_default',
  'char_fox_baseball_hat',
  'char_fox_graphic_tee',
  'char_fox_cool_shades',
  'char_fox_chef_hat',
  'char_fox_golden_suit',

];

/// Id prefix that marks a character row as a fox outfit.
///
/// The backend distinguishes these with `subject: 'fox_outfit'`, but [SeedItem]
/// deliberately does not mirror `subject` — so on this side the prefix is the
/// discriminator, and it is the single place that decision is written down.
const String kFoxOutfitIdPrefix = 'char_fox_';

/// The album slot fox outfits occupy — their own, not the generic character one.
const String kCharacterSlotPrefix = 'character:';

/// The slot the five profession skins occupy.
///
/// ⚠️ NOT A PREFIX OF [kCharacterSlotPrefix] BY ACCIDENT — `'character'` and
/// `'character:'` are different slots and the missing colon is the whole
/// distinction. `isCharacterSlot` tests the prefix WITH the colon, so this slot
/// is deliberately not one: it names no species, because a profession dresses
/// every species. `equippedCharacterSkinsProvider` is where that fans out.
///
/// It was a bare `'character'` literal inside `baseFurnitureIdFor` and a second
/// bare literal in the album catalogue, which is how it stayed invisible to the
/// provider that had to read it.
const String kUnscopedCharacterSlotId = 'character';

/// The album slot for a given species' outfits.
///
/// Species-scoped so N species can each carry their own wardrobe — the whole
/// point of the character engine. The generic `'character'` slot stays
/// UNSCOPED and is a different thing: it holds the profession skins
/// (`char_cleaner`, `char_chef`, …), which dress whatever animal you are rather
/// than belonging to one species.
String characterSlotFor(String speciesId) =>
    '$kCharacterSlotPrefix$speciesId';

/// The fox wardrobe slot.
///
/// ⚠️ Renamed from the bare `'fox'` when the character engine landed. Safe
/// because **slot ids are computed, never persisted**: `StyleCollectionNotifier`
/// derives them from `baseFurnitureIdFor` at runtime, and persistence is the
/// per-inventory-document `isEquipped` flag. So this is a Dart-local rename with
/// no Firestore migration and no `functions/src/itemPool.ts` edit — the
/// Dart↔TS contract is on id/type/category/rarity/name, not on slots.
///
/// 🔴 DO NOT find-and-replace `'fox'` across this feature. The literal at
/// `style_collection_provider.dart:178` is an **AvatarPreset id**
/// (`avatar_catalog.dart`), not a slot id, and it is what writes
/// `users/{uid}.avatarUrl`. Renaming it breaks the top bar, the settings page
/// and every friend card at once.
const String kFoxSlotId = '${kCharacterSlotPrefix}fox';

/// Whether [slotId] is a species-scoped character wardrobe.
bool isCharacterSlot(String slotId) =>
    slotId.startsWith(kCharacterSlotPrefix);

/// The species a character wardrobe slot dresses, or null if it is not one.
String? speciesForCharacterSlot(String slotId) =>
    isCharacterSlot(slotId)
        ? slotId.substring(kCharacterSlotPrefix.length)
        : null;

bool isFoxOutfitId(String seedId) => seedId.startsWith(kFoxOutfitIdPrefix);

/// Avatar asset path for a fox outfit, or null for any other id.
///
/// `char_fox_<slug>` → `assets/images/avatars/fox_<slug>.webp`. Generated by
/// `3d-source/build_fox_outfit_art.py`; `3d-source/verify_avatar.py` gates the
/// files themselves and a manifest test gates this mapping.
String? foxOutfitAvatarAssetFor(String seedId) {
  if (!isFoxOutfitId(seedId)) return null;
  return 'assets/images/avatars/fox_'
      '${seedId.substring(kFoxOutfitIdPrefix.length)}.webp';
}

/// Die-cut card art for a fox outfit, or null for any other id.
///
/// `char_fox_<slug>` → `assets/images/skins/character/char_fox_<slug>.png`.
///
/// Distinct from [foxOutfitAvatarAssetFor], and the difference matters: the
/// die-cut is a transparent full-body figure authored for a card, the avatar is
/// an opaque crop for the top bar. `skin_catalog.dart` says exactly this at the
/// album call site, which used to build this path as an inline string literal —
/// so the album and the reveal could drift. Both now route through here.
String? foxOutfitCardAssetFor(String seedId) {
  if (!isFoxOutfitId(seedId)) return null;
  return 'assets/images/skins/character/$seedId.png';
}

/// Id prefix shared by every character row — professions and fox outfits both.
///
/// ⚠️ NOT A DISCRIMINATOR ON ITS OWN. [kFoxOutfitIdPrefix] is `char_fox_`, so
/// every fox outfit id starts with this one too. Anything deriving a slug from
/// it has to exclude the fox rows first, which is what [kProfessionSeedIds]
/// does and why [roleCardAssetFor] asks that set rather than this prefix.
const String kCharacterIdPrefix = 'char_';

/// The profession rows — character rows that belong to no single species.
///
/// 🔑 DERIVED FROM THE SEED, NEVER LISTED BY HAND. A profession is exactly "a
/// character row that is not a species' own wardrobe", which is already what
/// [baseFurnitureIdFor] means when it files these under
/// [kUnscopedCharacterSlotId] and the fox outfits under [kFoxSlotId]. Writing
/// the six ids out again would be a second place the set could be wrong, and
/// the first symptom would be a card quietly drawing a glyph rather than a
/// failure — the defect this whole file is currently repairing.
final Set<String> kProfessionSeedIds = {
  for (final item in kCollectionSeed)
    if (item.type == 'character' && !isFoxOutfitId(item.id)) item.id,
};

/// Die-cut album card for profession [seedId] worn by [speciesId], or null.
///
/// `(char_chef, bear)` → `assets/images/skins/character/role_bear_chef.png`.
///
/// 🔑 TWO KEYS, AND THE SECOND ONE IS WHY THIS FUNCTION HAD TO EXIST. Every
/// other resolver in this file takes a seed id alone, and a seed id alone
/// cannot name a profession card: `char_chef` is species-agnostic BY
/// CONSTRUCTION — the species is a key inside `kCharacterSkins[skinId]`,
/// because a `replace` skin is a full figure and a full figure is
/// species-specific. Six profession rows therefore back TWELVE cards, and
/// `foxOutfitCardAssetFor('char_chef')` returning null is precisely the
/// `Icons.*` glyph the album shipped on a device.
///
/// ⚠️ A PATH BUILDER, NOT AN EXISTENCE CHECK — deliberately the same shape as
/// [foxOutfitCardAssetFor], which likewise returns a path for any `char_fox_*`
/// id and leaves the file question to a both-directions manifest test. Which
/// (row, species) pairs are actually baked lives in `kCharacterSkins`, and this
/// file cannot read that table without a cycle: `character_skin_data.dart`
/// imports this one. `role_card_art_manifest_test.dart` walks that table and
/// asserts both directions against the directory on disk.
String? roleCardAssetFor(String seedId, String speciesId) {
  if (speciesId.isEmpty) return null;
  if (!kProfessionSeedIds.contains(seedId)) return null;
  return 'assets/images/skins/character/role_${speciesId}_'
      '${seedId.substring(kCharacterIdPrefix.length)}.png';
}

/// The bundled art to show for a won [seedId], or null when the row has no art
/// of its own and the surface should fall back to a type glyph.
///
/// One resolver, three backing sets — 11 fox outfits, the 12 profession cards
/// and the baked furniture finishes. Everything else is deliberately null:
///
/// - The 7 exterior arrangements will never have a sprite. They are
///   code-defined layouts (`kExteriorArrangements`) and `skin_catalog.dart`
///   keeps them glyph-backed on the record that "there is no one PNG that
///   represents a whole lawn layout".
/// - The roof styles have no art baked yet. They stay glyph-backed until they
///   do; that is a bake track, not a wiring gap.
///
/// 🔑 [speciesId] IS OPTIONAL, AND SHARING THIS FUNCTION RATHER THAN FORKING IT
/// IS THE WHOLE DECISION. The drift this resolver was written to close is the
/// album and the chest reveal disagreeing about ONE question — what art
/// represents this item. A profession card answers a DIFFERENT question: what
/// art represents this item **on this animal**. Two questions is not drift, so
/// the fix is a second argument, not a second function. The album knows the
/// species (Brendan's by-species sectioning is what makes that true) and passes
/// it; the chest reveal does not know it, passes nothing, and keeps its glyph.
///
/// ⚠️ SO THE REVEAL STILL DRAWS A GLYPH FOR A WON PROFESSION, and that is the
/// honest answer rather than an oversight: a chest grants `char_chef`, which
/// dresses whatever animal you have, and picking one of the twelve cards to
/// represent it would be inventing a species the grant never named. When a
/// surface can name one, it passes `speciesId:` and this resolver already
/// serves it — one edit, at the call site, with no second resolution order.
///
/// ⚠️ Do **not** reach for [DroppedItem.artUrl] to do this job. Every row of
/// `SEED_ITEMS` carries `artUrl: ''` and `index.ts:633` writes
/// `itemData.artUrl ?? ''`, so the field is unpopulated at the source, not
/// merely unread. Cosmetics resolve client-side by seed id and ship in the
/// bundle — `Image.network` and `CachedNetworkImage` appear nowhere in `lib/`.
String? rewardArtFor(String seedId, {String? speciesId}) =>
    foxOutfitCardAssetFor(seedId) ??
    (speciesId == null ? null : roleCardAssetFor(seedId, speciesId)) ??
    skinAssetPathFor(seedId);

/// Explicit 5-row mapping: furniture SEED category → FurnitureDef.id.
///
/// SEED_ITEMS.category bridges some directly (sofa→sofa, lamp→lamp) but not
/// all (chair→armchair, tv→tv_stand, bed→bunk_bed).  Rather than a heuristic,
/// this is a fully-enumerated, tested table.
const Map<String, String> kFurnSeedCategoryToBasePiece = {
  'sofa':  'sofa',
  'chair': 'armchair',
  'lamp':  'lamp',
  'tv':    'tv_stand',
  'bed':   'bunk_bed',
  'bathtub':       'bathtub',
  'bookshelf':     'bookshelf',
  'coffee_table':  'coffee_table',
  'counter':       'counter',
  'desk':          'desk',
  'dining_table':  'dining_table',
  'dresser':       'dresser',
  'fridge':        'fridge',
  'shower':        'shower',
  'sink':          'sink',
  'bed_single':     'bed_single',
  'bench':          'bench',
  'cabinet':        'cabinet',
  'dining_chair':   'dining_chair',
  'dryer':          'dryer',
  'microwave':      'microwave',
  'nightstand':     'nightstand',
  'office_chair':   'office_chair',
  'side_table':     'side_table',
  'stool':          'stool',
  'wardrobe':       'wardrobe',
  'washer':         'washer',
  // ⚠️ ASYMMETRIC ON PURPOSE — the only two entries in this map whose value is
  // not its key, because the seed category and the catalogue slot use the same
  // words for different things: seed category `bed` already means the BUNK bed,
  // while catalogue slot `bed` is the DOUBLE bed, and slot `stove` is the stove
  // HOOD. The value here is always the CATALOGUE SLOT id.
  // 🔴 DO NOT "TIDY" THESE to 'bed_double': 'bed_double' / 'stove_hood':
  // 'stove_hood'. The row stops resolving and `baseFurnitureIdFor` drops it
  // without a word — no crash, no analyze error, just a finish that never
  // appears. 📌 `lamp` needs no entry: 'lamp': 'lamp' already exists above and
  // already points at prop_lamp_table_01.png, so the six new lamp rows join
  // that existing subject rather than making a new one.
  'bed_double':     'bed',
  'stove_hood':     'stove',
};

/// Short flavour descriptions shown in the detail sheet, keyed by SEED id.
const Map<String, String> kSkinDescriptions = {
  'char_pyjama': 'Striped pyjamas and a nightcap. Cleaning can wait.',
  'style_roof_straw':     'A cosy thatched roof, straight from the countryside.',
  // ⚠️ Was "Classic clay tiles" after the item was renamed to Terracotta, and
  // `clay` is a RETIRED WORD in this project (user directive 2026-08-02) — it
  // is a generative-model trigger for a texture this library does not have, so
  // it must not survive in player-facing copy either. Logged as an open
  // residual in audit-2026-08-08-premise-check.md:23.
  'style_roof_tile':      'Terracotta tiles — warm and timeless.',
  'style_roof_tile_gold': 'Golden tiles that catch the morning light.',
  'style_wall_whitewash': 'Crisp whitewash walls, cool and clean.',
  'style_wall_stone':     'Rugged stone walls with real character.',
  'furn_cozy_sofa':       'Sink in after a long day of scrubbing.',
  'furn_bear_chair':      'A bear-shaped armchair for maximum coziness.',
  'furn_neon_lamp':       'Casts a retro glow on late-night cleaning.',
  'furn_retro_tv':        'Old-school vibes, high-definition dust.',
  'furn_bunk_bed':        'Sleep stacked — saves floor space for mopping.',
  'furn_bunk_walnut':      'Warm walnut rails. The bed a treehouse would grow up to be.',
  'furn_bunk_charcoal':    'Charcoal frame, no fuss. Lights out means lights out.',
  'furn_bunk_pine':        'Pale pine that still smells faintly of the forest.',
  'furn_bunk_sage':        'Soft sage rails, for a room that wants to be a garden.',
  'furn_bunk_princess':    'Turned posts and a canopy. Bedtime, but make it a coronation.',
  'furn_bunk_race_car':    'Wheels that go nowhere at tremendous speed. Nobody has ever slept in early.',
  'char_cleaner':         'A seasoned pro with a mop for every mess.',
  'char_gardener':        'Keeps the garden and the living room spotless.',
  'char_chef':            'Cooks and cleans — the perfect housemate.',
  'char_knight':          'Sworn to protect all clean surfaces.',
  'char_astronaut':       'Zero gravity, zero dust. Allegedly.',
  // Day-one sofa finishes
  'furn_sofa_brown':      'Deep walnut upholstery that hides a multitude of crumbs.',
  'furn_sofa_charcoal':   'Smart charcoal — the one that always looks freshly vacuumed.',
  'furn_sofa_ivory':      'Ivory, for the brave. Coasters strongly advised.',
  'furn_sofa_sage':       'Soft sage green, like a houseplant you cannot kill.',
  'furn_sofa_two_tone':   'Contrast cushions on a warm oat body. Quietly expensive.',
  'furn_sofa_modern':     'A low modern frame piled with pillows. Peak sink-in.',
  'furn_sofa_cream':      'Warm cream that forgives a lot and hides nothing.',
  // Day-one exterior arrangements
  'style_ext_lawn_default': 'Conifers, rocks and wildflowers — the lawn you started with.',
  'style_ext_orchard_rows': 'Conifers planted in orderly rows. Very put-together.',
  'style_ext_rock_garden':  'Boulders and a few sentinel trees. Low maintenance.',
  'style_ext_wildflower':   'Wildflowers taking over the edges, in the best way.',
  'style_ext_clean_lawn':   'An open lawn with a tidy border. Room to breathe.',
  'style_ext_flower_bed':   'Flower beds massed along the borders.',
  'style_ext_garden_path':  'A planted path leading right up to your front door.',
  // Fox outfits (W3-09)
  'char_fox_baseball_hat':     'Cap on, sleeves up. Ready for the weekly sweep.',
  'char_fox_graphic_tee':      'A soft oat tee with a little printed badge.',
  'char_fox_cool_shades':      'Chunky tan shades. The mess never sees it coming.',
  'char_fox_chef_hat':         'Tall, pleated and slightly too big. Perfect.',
  'char_fox_runner':           'Zip jacket, shorts, tiny trainers. Lap of the house?',
  'char_fox_chef':             'The full whites, with a patch pocket for the good spoon.',
  'char_fox_oversized_hoodie': 'Two sizes too big, which is the correct size.',
  'char_fox_black_suit':       'Sharp charcoal and a warm brown tie. Very professional.',
  'char_fox_golden_suit':      'Soft honey tailoring. Understated, and quietly expensive.',
  'char_fox_space_suit':       'Padded, helmeted and ready for a zero-gravity tidy.',
  'char_fox_bubble_bath':      'Shower cap, towel and a shoulderful of soap bubbles.',
  // Finish sets: armchair and tv_stand (W3-117)
  'furn_armchair_walnut':   'Deep walnut, worn in exactly where it should be.',
  'furn_armchair_charcoal': 'Smart charcoal that never looks like it needs a brush.',
  'furn_armchair_ivory':    'Ivory upholstery. Magnificent, and a little nerve-wracking.',
  'furn_armchair_sage':     'Soft sage, the colour of a very calm afternoon.',
  'furn_armchair_two_tone': 'An oat body with contrast cushions. Quietly smug about it.',
  'furn_armchair_wing':     'High wings on either side. Built for hiding from the hoover.',
  'furn_tv_stand_walnut':   'Warm walnut with an open front. The remote goes in the middle.',
  'furn_tv_stand_charcoal': 'Charcoal and low-slung. Very cinema.',
  'furn_tv_stand_butter':   'Soft butter yellow \u2014 sunshine, even on a grey day.',
  'furn_tv_stand_mint':     'Pale mint, fresh as a just-mopped floor.',
  'furn_tv_stand_two_tone': 'Oat panels on a darker frame. Two woods, one shelf.',
  'furn_tv_stand_console':  'A long console with extra shelves. Room for every box set.',
  'furn_bathtub_charcoal':     'A deep charcoal soak. Somehow makes the water look warmer.',
  'furn_bathtub_sage':         'Pale sage, for baths that go on slightly too long.',
  'furn_bathtub_sand':         'Soft sand-coloured enamel. Beach holiday, indoors.',
  'furn_bathtub_slate':        'Cool slate with a matte finish. Very spa, very quiet.',
  'furn_bathtub_slipper':      'A high-backed slipper tub on little feet. Absurd and perfect.',
  'furn_bathtub_two_tone':     'Dark outside, cream within. The good kind of surprise.',
  'furn_bookshelf_caramel':    'Warm caramel shelves that make paperbacks look expensive.',
  'furn_bookshelf_charcoal':   'Charcoal shelving. The spines do the talking.',
  'furn_bookshelf_ivory':      'Ivory shelves, for a room that wants more light in it.',
  'furn_bookshelf_library':    'Floor to ceiling, with a ladder. Nobody has read all of them.',
  'furn_bookshelf_sage':       'Sage green shelves. Half plants, half novels, no regrets.',
  'furn_bookshelf_two_tone':   'Dark frame, pale backing — every shelf reads like a display.',
  'furn_coffee_table_caramel': 'Warm caramel wood with one honest ring stain.',
  'furn_coffee_table_charcoal': 'Low, dark and unbothered by mugs.',
  'furn_coffee_table_ivory':   'Ivory top. Optimistic, given the coffee.',
  'furn_coffee_table_sage':    'Sage green, the shade that makes a room exhale.',
  'furn_counter_caramel':      'Warm caramel worktop. Everything gets chopped here.',
  'furn_counter_charcoal':     'Charcoal counters. Crumbs have nowhere to hide, sadly.',
  'furn_counter_ivory':        'Bright ivory, the kitchen equivalent of a clean shirt.',
  'furn_counter_open_shelf':   'Shelves instead of doors. Now the mugs have to match.',
  'furn_counter_sage':         'Soft sage cabinetry, quietly pleased with itself.',
  'furn_counter_two_tone':     'Pale top, dark base. The layout every kitchen magazine ran.',
  'furn_desk_caramel':         'Warm caramel wood. Good for pretending to work.',
  'furn_desk_charcoal':        'Charcoal desk, no distractions built in.',
  'furn_desk_ivory':           'Ivory surface. Shows every pen mark and forgives none.',
  'furn_desk_sage':            'Sage green, for deadlines that need softening.',
  'furn_desk_two_tone':        'Pale top on a dark frame. Looks like a decision.',
  'furn_dining_table_caramel': 'Warm caramel boards. Built for long lunches.',
  'furn_dining_table_charcoal': 'Charcoal table. Candles look extremely good on it.',
  'furn_dining_table_ivory':   'Ivory top, brave in a house that eats pasta.',
  'furn_dining_table_sage':    'Sage green, halfway between kitchen and garden.',
  'furn_dining_table_trestle': 'Two trestles and a plank, done properly. Seats everyone.',
  'furn_dining_table_two_tone': 'Pale top, dark legs. Steady in every sense.',
  'furn_dresser_caramel':      'Warm caramel drawers that always stick a little.',
  'furn_dresser_charcoal':     'Charcoal drawers. Whatever is in there stays in there.',
  'furn_dresser_ivory':        'Ivory dresser, brass handles, no clutter allowed.',
  'furn_dresser_sage':         'Sage green with a plant on top. Obviously.',
  'furn_dresser_two_tone':     'Pale drawers in a dark frame. Tidier than its owner.',
  'furn_fridge_butter':        'Soft butter yellow. Hums a little, means well.',
  'furn_fridge_charcoal':      'Charcoal fridge. Fingerprints are part of the finish now.',
  'furn_fridge_mint':          'Mint green and cheerful about it.',
  'furn_fridge_retro':         'Round shoulders, chrome handle. Older than the house.',
  'furn_fridge_terracotta':    'Warm terracotta. The one thing in the kitchen with a tan.',
  'furn_fridge_two_tone':      'Pale door on a dark body. Deliberate, not a repair.',
  'furn_shower_charcoal':      'Charcoal tiling and very good water pressure.',
  'furn_shower_glass':         'Frameless glass. Beautiful, and it shows every splash.',
  'furn_shower_sage':          'Sage tiles. Steamy mornings, gentler about it.',
  'furn_shower_sand':          'Sand-toned tile, warm underfoot even when it is not.',
  'furn_shower_slate':         'Slate walls. Feels like showering in good weather.',
  'furn_shower_two_tone':      'Dark below, pale above. Hides the splashes that matter.',
  'furn_sink_caramel':         'Warm caramel surround with a well-used look.',
  'furn_sink_charcoal':        'Charcoal basin. Dramatic about washing up.',
  'furn_sink_farmhouse':       'A deep apron-front basin. Fits an entire roasting tin.',
  'furn_sink_sage':            'Sage green, for a window box view.',
  'furn_sink_stone':           'Solid stone, cold to the touch, older than everyone.',
  'furn_sink_two_tone':        'Pale basin, dark surround. Reads as considered.',
  'furn_bed_single_caramel'   : 'Caramel frame, single width. Room for one and a very smug cat.',
  'furn_bed_single_charcoal'  : 'Charcoal rails that disappear at lights out.',
  'furn_bed_single_ivory'     : 'Ivory frame, bright and plain. The bed equivalent of a clean slate.',
  'furn_bed_single_sage'      : 'Soft sage posts. Sleeps like a garden nap.',
  'furn_bed_single_two_tone'  : 'Two tones, one bed. The frame and the rails disagree politely.',
  'furn_bed_single_race_car'   : 'Racing stripes, one seat, no brakes. Bedtime is now a pit stop.',
  'furn_bench_caramel'        : 'Caramel slats worn smooth by sitting.',
  'furn_bench_charcoal'       : 'Charcoal bench, all business. Sit down, lace up, go.',
  'furn_bench_ivory'          : 'Ivory slats. Looks best under a window.',
  'furn_bench_sage'           : 'Sage green bench that thinks it lives outdoors.',
  'furn_bench_two_tone'       : 'Two tones across the slats. Somebody could not choose.',
  'furn_cabinet_caramel'      : 'Caramel doors hiding whatever you shoved in there.',
  'furn_cabinet_charcoal'     : 'Charcoal cabinet. Closed, and keeping its secrets.',
  'furn_cabinet_ivory'        : 'Ivory doors that show every fingerprint. Worth it.',
  'furn_cabinet_sage'         : 'Sage panels, soft as a herb garden.',
  'furn_cabinet_two_tone'     : 'Two-tone doors. The top half is dressed up and the bottom half is not.',
  'furn_dining_chair_caramel' : 'Caramel seat. Pulls up to any table without complaint.',
  'furn_dining_chair_charcoal': 'Charcoal chair. Formal enough for guests, sturdy enough for children.',
  'furn_dining_chair_ivory'   : 'Ivory frame that makes the table look tidier than it is.',
  'furn_dining_chair_sage'    : 'Sage chair. Dinner tastes better in this one.',
  'furn_dryer_butter'         : 'Butter yellow drum. Warm towels are a whole personality.',
  'furn_dryer_mint'           : 'Mint dryer humming its one note.',
  'furn_dryer_slate'          : 'Slate grey and quiet about it.',
  'furn_dryer_terracotta'     : 'Warm terracotta panel. The laundry corner finally has a colour.',
  'furn_dryer_two_tone'       : 'Two tones, one tumble. The door disagrees with the body.',
  'furn_microwave_butter'     : 'Butter yellow front. Thirty seconds, and then thirty more.',
  'furn_microwave_mint'       : 'Mint casing with a very confident beep.',
  'furn_microwave_slate'      : 'Slate finish. Reheats without opinions.',
  'furn_microwave_terracotta' : 'Terracotta shell that makes leftovers feel intentional.',
  'furn_microwave_two_tone'   : 'Two-tone front. The door and the body were bought separately.',
  'furn_nightstand_caramel'   : 'Caramel top for a glass of water and one hopeful book.',
  'furn_nightstand_charcoal'  : 'Charcoal nightstand. Holds a lamp and your entire evening.',
  'furn_nightstand_ivory'     : 'Ivory drawers, bright beside a dark bed.',
  'furn_nightstand_sage'      : 'Sage finish. Calm at arms length.',
  'furn_nightstand_two_tone'  : 'Two tones stacked. The drawer front went its own way.',
  'furn_office_chair_caramel' : 'Caramel seat that makes the deadline slightly softer.',
  'furn_office_chair_charcoal': 'Charcoal chair. Spins exactly as much as you need it to.',
  'furn_office_chair_ivory'   : 'Ivory frame, bright under a monitor.',
  'furn_office_chair_sage'    : 'Sage upholstery. Calmer than the inbox.',
  'furn_office_chair_two_tone': 'Two tones and five wheels. Fully committed to neither colour.',
  'furn_side_table_caramel'   : 'Caramel top, exactly one mug wide.',
  'furn_side_table_charcoal'  : 'Charcoal side table. Small, dark, always in the way of a toe.',
  'furn_side_table_ivory'     : 'Ivory surface that shows the ring from every cup.',
  'furn_side_table_sage'      : 'Sage table for the corner that needed something.',
  'furn_side_table_two_tone'  : 'Two-tone top and legs. Small furniture, big opinions.',
  'furn_stool_caramel'        : 'Caramel seat, no back, no nonsense.',
  'furn_stool_charcoal'       : 'Charcoal stool. Tucks under the counter and waits.',
  'furn_stool_ivory'          : 'Ivory stool that doubles as a step when nobody is looking.',
  'furn_stool_sage'           : 'Sage seat. Perches nicely at a breakfast bar.',
  'furn_stool_two_tone'       : 'Two tones, three legs. Balanced in every sense.',
  'furn_wardrobe_caramel'     : 'Caramel doors with a whole season behind them.',
  'furn_wardrobe_charcoal'    : 'Charcoal wardrobe. Deep enough to lose a coat in.',
  'furn_wardrobe_ivory'       : 'Ivory doors, bright against a dim bedroom wall.',
  'furn_wardrobe_sage'        : 'Sage panels. The calmest place to keep your clothes.',
  'furn_wardrobe_two_tone'    : 'Two-tone doors. Opens onto a much less organised story.',
  'furn_washer_butter'        : 'Butter yellow drum, spinning through the weekend.',
  'furn_washer_mint'          : 'Mint washer. Makes laundry day almost cheerful.',
  'furn_washer_slate'         : 'Slate grey, gets on with it.',
  'furn_washer_terracotta'    : 'Terracotta front that warms up the whole laundry corner.',
  'furn_washer_two_tone'      : 'Two tones, one very long cycle.',
  'furn_bed_double_caramel'    : 'Caramel frame with room for two. And a cat, diagonally.',
  'furn_bed_double_charcoal'   : 'Charcoal posts that vanish once the light goes out.',
  'furn_bed_double_four_poster': 'Four posts and a canopy. Sleeping, but make it an occasion.',
  'furn_bed_double_ivory'      : 'Ivory frame, wide and bright. Makes the whole room look made.',
  'furn_bed_double_sage'       : 'Sage green headboard. Half bedroom, half greenhouse.',
  'furn_bed_double_two_tone'   : 'Two tones across the frame. The headboard and the base were never introduced.',
  'furn_bed_double_race_car'   : 'A race car built for two. Nobody can agree on who is driving.',
  'furn_lamp_charcoal'         : 'Charcoal shade, low and warm. Reading light, nothing more.',
  'furn_lamp_ivory'            : 'Ivory shade that makes every corner look softer.',
  'furn_lamp_lantern'          : 'A lantern on a stand. Looks like it should hiss, and does not.',
  'furn_lamp_sage'             : 'Sage shade. Green enough to notice, calm enough to ignore.',
  'furn_lamp_two_tone'         : 'Two tones, one bulb. Base and shade in polite disagreement.',
  'furn_lamp_walnut'           : 'Warm walnut base. The lamp that came with the house, in a good way.',
  'furn_stove_hood_caramel'    : 'Caramel hood over the hob. Catches steam and compliments.',
  'furn_stove_hood_charcoal'   : 'Charcoal hood, quietly extracting the evidence of dinner.',
  'furn_stove_hood_ivory'      : 'Ivory hood, bright above the cooking. Shows every splash.',
  'furn_stove_hood_range'      : 'A full range hood, wide as the wall. For cooking that gets ambitious.',
  'furn_stove_hood_sage'       : 'Sage hood. The kitchen equivalent of a deep breath.',
  'furn_stove_hood_two_tone'   : 'Two tones above the hob. The trim disagrees with the canopy.',
};

/// Sprite stems for skins that have art of their OWN, keyed by seed id.
///
/// Before W3-08 every furniture skin reused its base piece's sprite — the
/// comment in `skin_catalog.dart` read "Cosmetic art is deferred" — so all six
/// sofa entries in the album drew the identical PNG and equipping one changed
/// nothing anywhere. A stem listed here is baked art; a seed id absent from
/// this map still falls back to the base piece, which is correct for the legacy
/// rows that genuinely have no art of their own.
///
/// Stems, not full paths: the rotation atlas path is derived from the stem by
/// `resolvedAssetPath`, so storing a path here would fork that convention.
/// `test/features/house_builder/domain/furniture_catalogue_manifest_test.dart`
/// asserts every stem below has a rot0 sprite and all three rotation bakes on
/// disk. (This used to cite `skin_asset_manifest_test.dart`, which has never
/// existed under that name — the gate is real, the citation was not.)
const Map<String, String> kSkinSpriteStems = {
  'furn_sofa_brown':    'prop_sofa_3seat_brown',
  'furn_sofa_charcoal': 'prop_sofa_3seat_charcoal',
  'furn_sofa_ivory':    'prop_sofa_3seat_ivory',
  'furn_sofa_sage':     'prop_sofa_3seat_sage',
  'furn_sofa_two_tone': 'prop_sofa_3seat_two_tone',
  'furn_sofa_modern':   'prop_sofa_3seat_modern',
  'furn_sofa_cream':    'prop_sofa_3seat_cream',
  'furn_bunk_walnut':    'prop_bunk_bed_01_walnut',
  'furn_bunk_charcoal':  'prop_bunk_bed_01_charcoal',
  'furn_bunk_pine':      'prop_bunk_bed_01_pine',
  'furn_bunk_sage':      'prop_bunk_bed_01_sage',
  'furn_bunk_princess':  'prop_bunk_bed_01_princess',
  'furn_bunk_race_car':  'prop_bunk_bed_01_race_car',
  // Finish sets (W3-117). Wiring these is what makes the twelve sprites
  // REFERENCED, which is why furniture_catalogue_manifest_test's
  // known-unreferenced ledger drops them in this same commit.
  'furn_armchair_walnut':   'prop_armchair_01_walnut',
  'furn_armchair_charcoal': 'prop_armchair_01_charcoal',
  'furn_armchair_ivory':    'prop_armchair_01_ivory',
  'furn_armchair_sage':     'prop_armchair_01_sage',
  'furn_armchair_two_tone': 'prop_armchair_01_two_tone',
  'furn_armchair_wing':     'prop_armchair_01_wing',
  'furn_tv_stand_walnut':   'prop_tv_stand_01_walnut',
  'furn_tv_stand_charcoal': 'prop_tv_stand_01_charcoal',
  'furn_tv_stand_butter':   'prop_tv_stand_01_butter',
  'furn_tv_stand_mint':     'prop_tv_stand_01_mint',
  'furn_tv_stand_two_tone': 'prop_tv_stand_01_two_tone',
  'furn_tv_stand_console':  'prop_tv_stand_01_console',
  'furn_bathtub_charcoal':     'prop_bathtub_01_charcoal',
  'furn_bathtub_sage':         'prop_bathtub_01_sage',
  'furn_bathtub_sand':         'prop_bathtub_01_sand',
  'furn_bathtub_slate':        'prop_bathtub_01_slate',
  'furn_bathtub_slipper':      'prop_bathtub_01_slipper',
  'furn_bathtub_two_tone':     'prop_bathtub_01_two_tone',
  'furn_bookshelf_caramel':    'prop_bookshelf_01_caramel',
  'furn_bookshelf_charcoal':   'prop_bookshelf_01_charcoal',
  'furn_bookshelf_ivory':      'prop_bookshelf_01_ivory',
  'furn_bookshelf_library':    'prop_bookshelf_01_library',
  'furn_bookshelf_sage':       'prop_bookshelf_01_sage',
  'furn_bookshelf_two_tone':   'prop_bookshelf_01_two_tone',
  'furn_coffee_table_caramel': 'prop_coffee_table_01_caramel',
  'furn_coffee_table_charcoal': 'prop_coffee_table_01_charcoal',
  'furn_coffee_table_ivory':   'prop_coffee_table_01_ivory',
  'furn_coffee_table_sage':    'prop_coffee_table_01_sage',
  'furn_counter_caramel':      'prop_counter_01_caramel',
  'furn_counter_charcoal':     'prop_counter_01_charcoal',
  'furn_counter_ivory':        'prop_counter_01_ivory',
  'furn_counter_open_shelf':   'prop_counter_01_open_shelf',
  'furn_counter_sage':         'prop_counter_01_sage',
  'furn_counter_two_tone':     'prop_counter_01_two_tone',
  'furn_desk_caramel':         'prop_desk_01_caramel',
  'furn_desk_charcoal':        'prop_desk_01_charcoal',
  'furn_desk_ivory':           'prop_desk_01_ivory',
  'furn_desk_sage':            'prop_desk_01_sage',
  'furn_desk_two_tone':        'prop_desk_01_two_tone',
  'furn_dining_table_caramel': 'prop_dining_table_01_caramel',
  'furn_dining_table_charcoal': 'prop_dining_table_01_charcoal',
  'furn_dining_table_ivory':   'prop_dining_table_01_ivory',
  'furn_dining_table_sage':    'prop_dining_table_01_sage',
  'furn_dining_table_trestle': 'prop_dining_table_01_trestle',
  'furn_dining_table_two_tone': 'prop_dining_table_01_two_tone',
  'furn_dresser_caramel':      'prop_dresser_01_caramel',
  'furn_dresser_charcoal':     'prop_dresser_01_charcoal',
  'furn_dresser_ivory':        'prop_dresser_01_ivory',
  'furn_dresser_sage':         'prop_dresser_01_sage',
  'furn_dresser_two_tone':     'prop_dresser_01_two_tone',
  'furn_fridge_butter':        'prop_fridge_01_butter',
  'furn_fridge_charcoal':      'prop_fridge_01_charcoal',
  'furn_fridge_mint':          'prop_fridge_01_mint',
  'furn_fridge_retro':         'prop_fridge_01_retro',
  'furn_fridge_terracotta':    'prop_fridge_01_terracotta',
  'furn_fridge_two_tone':      'prop_fridge_01_two_tone',
  'furn_shower_charcoal':      'prop_shower_01_charcoal',
  'furn_shower_glass':         'prop_shower_01_glass',
  'furn_shower_sage':          'prop_shower_01_sage',
  'furn_shower_sand':          'prop_shower_01_sand',
  'furn_shower_slate':         'prop_shower_01_slate',
  'furn_shower_two_tone':      'prop_shower_01_two_tone',
  'furn_sink_caramel':         'prop_sink_01_caramel',
  'furn_sink_charcoal':        'prop_sink_01_charcoal',
  'furn_sink_farmhouse':       'prop_sink_01_farmhouse',
  'furn_sink_sage':            'prop_sink_01_sage',
  'furn_sink_stone':           'prop_sink_01_stone',
  'furn_sink_two_tone':        'prop_sink_01_two_tone',
  // W1-171 — the twelve ladders that were baked, ledgered and invisible.
  // 🔑 EVERY STEM BELOW WAS RESOLVED AGAINST THE FILE ON DISK, not derived from
  // the brief's room table: `prop_washer_01_*` lives in `kitchen/`, not
  // `laundry_room/`, and a table would have said otherwise.
  // ⚠️ prop_washer_01_spin / _spin_rot90 are NOT here and must never be. They
  // are 4096x512 eight-frame animation strips, not finishes — see
  // `collection_seed_sprite_maps_test`'s size check.
  'furn_bed_single_caramel':    'prop_bed_single_01_caramel',
  'furn_bed_single_charcoal':   'prop_bed_single_01_charcoal',
  'furn_bed_single_ivory':      'prop_bed_single_01_ivory',
  'furn_bed_single_sage':       'prop_bed_single_01_sage',
  'furn_bed_single_two_tone':   'prop_bed_single_01_two_tone',
  'furn_bed_single_race_car':   'prop_bed_single_01_race_car',
  'furn_bench_caramel':         'prop_bench_01_caramel',
  'furn_bench_charcoal':        'prop_bench_01_charcoal',
  'furn_bench_ivory':           'prop_bench_01_ivory',
  'furn_bench_sage':            'prop_bench_01_sage',
  'furn_bench_two_tone':        'prop_bench_01_two_tone',
  'furn_cabinet_caramel':       'prop_cabinet_01_caramel',
  'furn_cabinet_charcoal':      'prop_cabinet_01_charcoal',
  'furn_cabinet_ivory':         'prop_cabinet_01_ivory',
  'furn_cabinet_sage':          'prop_cabinet_01_sage',
  'furn_cabinet_two_tone':      'prop_cabinet_01_two_tone',
  'furn_dining_chair_caramel':  'prop_dining_chair_01_caramel',
  'furn_dining_chair_charcoal': 'prop_dining_chair_01_charcoal',
  'furn_dining_chair_ivory':    'prop_dining_chair_01_ivory',
  'furn_dining_chair_sage':     'prop_dining_chair_01_sage',
  'furn_dryer_butter':          'prop_dryer_01_butter',
  'furn_dryer_mint':            'prop_dryer_01_mint',
  'furn_dryer_slate':           'prop_dryer_01_slate',
  'furn_dryer_terracotta':      'prop_dryer_01_terracotta',
  'furn_dryer_two_tone':        'prop_dryer_01_two_tone',
  'furn_microwave_butter':      'prop_microwave_01_butter',
  'furn_microwave_mint':        'prop_microwave_01_mint',
  'furn_microwave_slate':       'prop_microwave_01_slate',
  'furn_microwave_terracotta':  'prop_microwave_01_terracotta',
  'furn_microwave_two_tone':    'prop_microwave_01_two_tone',
  'furn_nightstand_caramel':    'prop_nightstand_01_caramel',
  'furn_nightstand_charcoal':   'prop_nightstand_01_charcoal',
  'furn_nightstand_ivory':      'prop_nightstand_01_ivory',
  'furn_nightstand_sage':       'prop_nightstand_01_sage',
  'furn_nightstand_two_tone':   'prop_nightstand_01_two_tone',
  'furn_office_chair_caramel':  'prop_office_chair_01_caramel',
  'furn_office_chair_charcoal': 'prop_office_chair_01_charcoal',
  'furn_office_chair_ivory':    'prop_office_chair_01_ivory',
  'furn_office_chair_sage':     'prop_office_chair_01_sage',
  'furn_office_chair_two_tone': 'prop_office_chair_01_two_tone',
  'furn_side_table_caramel':    'prop_side_table_01_caramel',
  'furn_side_table_charcoal':   'prop_side_table_01_charcoal',
  'furn_side_table_ivory':      'prop_side_table_01_ivory',
  'furn_side_table_sage':       'prop_side_table_01_sage',
  'furn_side_table_two_tone':   'prop_side_table_01_two_tone',
  'furn_stool_caramel':         'prop_stool_01_caramel',
  'furn_stool_charcoal':        'prop_stool_01_charcoal',
  'furn_stool_ivory':           'prop_stool_01_ivory',
  'furn_stool_sage':            'prop_stool_01_sage',
  'furn_stool_two_tone':        'prop_stool_01_two_tone',
  'furn_wardrobe_caramel':      'prop_wardrobe_01_caramel',
  'furn_wardrobe_charcoal':     'prop_wardrobe_01_charcoal',
  'furn_wardrobe_ivory':        'prop_wardrobe_01_ivory',
  'furn_wardrobe_sage':         'prop_wardrobe_01_sage',
  'furn_wardrobe_two_tone':     'prop_wardrobe_01_two_tone',
  'furn_washer_butter':         'prop_washer_01_butter',
  'furn_washer_mint':           'prop_washer_01_mint',
  'furn_washer_slate':          'prop_washer_01_slate',
  'furn_washer_terracotta':     'prop_washer_01_terracotta',
  'furn_washer_two_tone':       'prop_washer_01_two_tone',
  // W1-172 — the last three ladders: bed_double, lamp_table, stove_hood.
  // 🔴 THE ID'S MIDDLE IS THE SEED CATEGORY, NOT THE PROP STEM, and for the
  // lamp they differ: `furn_lamp_walnut` dresses `prop_lamp_table_01_walnut`.
  // That is a THIRD asymmetry beside the two in kFurnSeedCategoryToBasePiece,
  // and deriving a stem from an id by string surgery gets it wrong.
  // 📌 furn_neon_lamp is category `lamp` and is NOT here: it is a
  // `deliberatelyBare` row with no sprite of its own, pinned by id in
  // collection_seed_sprite_maps_test.
  'furn_bed_double_caramel':     'prop_bed_double_01_caramel',
  'furn_bed_double_charcoal':    'prop_bed_double_01_charcoal',
  'furn_bed_double_four_poster': 'prop_bed_double_01_four_poster',
  'furn_bed_double_ivory':       'prop_bed_double_01_ivory',
  'furn_bed_double_sage':        'prop_bed_double_01_sage',
  'furn_bed_double_two_tone':    'prop_bed_double_01_two_tone',
  'furn_bed_double_race_car':    'prop_bed_double_01_race_car',
  'furn_lamp_charcoal':          'prop_lamp_table_01_charcoal',
  'furn_lamp_ivory':             'prop_lamp_table_01_ivory',
  'furn_lamp_lantern':           'prop_lamp_table_01_lantern',
  'furn_lamp_sage':              'prop_lamp_table_01_sage',
  'furn_lamp_two_tone':          'prop_lamp_table_01_two_tone',
  'furn_lamp_walnut':            'prop_lamp_table_01_walnut',
  'furn_stove_hood_caramel':     'prop_stove_hood_01_caramel',
  'furn_stove_hood_charcoal':    'prop_stove_hood_01_charcoal',
  'furn_stove_hood_ivory':       'prop_stove_hood_01_ivory',
  'furn_stove_hood_range':       'prop_stove_hood_01_range',
  'furn_stove_hood_sage':        'prop_stove_hood_01_sage',
  'furn_stove_hood_two_tone':    'prop_stove_hood_01_two_tone',
};

/// The room directory a skin's sprite lives in, keyed by seed id. Mirrors the
/// bake output layout `assets/images/furniture/<room>/<stem>.png`.
///
/// 🔴 THIS MAP MUST HOLD EXACTLY THE SAME KEYS AS [kSkinSpriteStems], AND A
/// MISSING KEY HERE IS SILENT. [skinAssetPathFor] returns null when EITHER
/// lookup misses, and null means "draw the base piece" — so a stem wired here
/// but not there does not crash, does not analyze red, and does not fail a
/// parity suite. It renders the wrong sprite, forever.
///
/// 🔑 W1-162 SHIPPED THAT STATE: a session added 63 stems and 0 rooms, so `main`
/// was 18/18 while the branch was 81/18 and all 63 new finishes fell back to
/// their base piece — six fridge finishes drawing one fridge.
///
/// 🔴 THE SUITE WAS NOT GREEN. It was UNRUN. `furniture_catalogue_manifest_test`
/// carries `every skin sprite stem has a room, and both tables cover the same
/// ids` and had for months; that branch was red on it, on the rot-sprite check
/// beside it, and on furniture_skin_sprite_test, plus two jest tests. The
/// session that authored the rows ran a subset and never the whole gate.
/// **A missing test was never the problem here.**
///
/// ⚠️ TWO gates genuinely were fooled, and they share one cause worth knowing:
/// the known-unreferenced ledger and the 29-row bar in
/// chest_reward_card_art_test both read their answer THROUGH [skinAssetPathFor].
/// `_skinBaseSprites()` maps stems through it and drops the nulls, and
/// `rewardArtFor` is `foxOutfitCardAssetFor(id) ?? skinAssetPathFor(id)`. A
/// gate downstream of a soft failure measures the failure and looks correct
/// doing it. That is the narrow, real lesson — not that the suite passed.
///
/// ⚠️ SO THE UNIT OF WORK FOR ONE FINISH IS FIVE EDITS, NOT FOUR: a row in
/// collection_seed.json, a [kSkinSpriteStems] entry, a [kSkinSpriteRooms]
/// entry, a base piece in skin_catalog.dart's roster, and a subject-ledger
/// entry in functions/src/itemPool.ts. Two write-ups of this trap named only
/// the stem, which is how it was missed twice.
///
/// ✅ TWO tests assert this now: `furniture_catalogue_manifest_test` (which
/// always did) and `collection_seed_sprite_maps_test`, whose own header records
/// which of its cases are redundant with the first and which are not.
const Map<String, String> kSkinSpriteRooms = {
  // prop_sofa_3seat
  'furn_sofa_brown':            'living_room',
  'furn_sofa_charcoal':         'living_room',
  'furn_sofa_ivory':            'living_room',
  'furn_sofa_sage':             'living_room',
  'furn_sofa_two_tone':         'living_room',
  'furn_sofa_modern':           'living_room',
  'furn_sofa_cream':            'living_room',

  // prop_bunk_bed_01
  'furn_bunk_walnut':           'bedroom',
  'furn_bunk_charcoal':         'bedroom',
  'furn_bunk_pine':             'bedroom',
  'furn_bunk_sage':             'bedroom',
  'furn_bunk_princess':         'bedroom',
  'furn_bunk_race_car':         'bedroom',

  // prop_armchair_01
  'furn_armchair_walnut':       'living_room',
  'furn_armchair_charcoal':     'living_room',
  'furn_armchair_ivory':        'living_room',
  'furn_armchair_sage':         'living_room',
  'furn_armchair_two_tone':     'living_room',
  'furn_armchair_wing':         'living_room',

  // prop_tv_stand_01
  'furn_tv_stand_walnut':       'living_room',
  'furn_tv_stand_charcoal':     'living_room',
  'furn_tv_stand_butter':       'living_room',
  'furn_tv_stand_mint':         'living_room',
  'furn_tv_stand_two_tone':     'living_room',
  'furn_tv_stand_console':      'living_room',

  // prop_bathtub_01
  'furn_bathtub_charcoal':      'bathroom',
  'furn_bathtub_sage':          'bathroom',
  'furn_bathtub_sand':          'bathroom',
  'furn_bathtub_slate':         'bathroom',
  'furn_bathtub_slipper':       'bathroom',
  'furn_bathtub_two_tone':      'bathroom',

  // prop_bookshelf_01
  'furn_bookshelf_caramel':     'office',
  'furn_bookshelf_charcoal':    'office',
  'furn_bookshelf_ivory':       'office',
  'furn_bookshelf_library':     'office',
  'furn_bookshelf_sage':        'office',
  'furn_bookshelf_two_tone':    'office',

  // prop_coffee_table_01
  'furn_coffee_table_caramel':  'living_room',
  'furn_coffee_table_charcoal': 'living_room',
  'furn_coffee_table_ivory':    'living_room',
  'furn_coffee_table_sage':     'living_room',

  // prop_counter_01
  'furn_counter_caramel':       'kitchen',
  'furn_counter_charcoal':      'kitchen',
  'furn_counter_ivory':         'kitchen',
  'furn_counter_open_shelf':    'kitchen',
  'furn_counter_sage':          'kitchen',
  'furn_counter_two_tone':      'kitchen',

  // prop_desk_01
  'furn_desk_caramel':          'office',
  'furn_desk_charcoal':         'office',
  'furn_desk_ivory':            'office',
  'furn_desk_sage':             'office',
  'furn_desk_two_tone':         'office',

  // prop_dining_table_01
  'furn_dining_table_caramel':  'dining_room',
  'furn_dining_table_charcoal': 'dining_room',
  'furn_dining_table_ivory':    'dining_room',
  'furn_dining_table_sage':     'dining_room',
  'furn_dining_table_trestle':  'dining_room',
  'furn_dining_table_two_tone': 'dining_room',

  // prop_dresser_01
  'furn_dresser_caramel':       'bedroom',
  'furn_dresser_charcoal':      'bedroom',
  'furn_dresser_ivory':         'bedroom',
  'furn_dresser_sage':          'bedroom',
  'furn_dresser_two_tone':      'bedroom',

  // prop_fridge_01
  'furn_fridge_butter':         'kitchen',
  'furn_fridge_charcoal':       'kitchen',
  'furn_fridge_mint':           'kitchen',
  'furn_fridge_retro':          'kitchen',
  'furn_fridge_terracotta':     'kitchen',
  'furn_fridge_two_tone':       'kitchen',

  // prop_shower_01
  'furn_shower_charcoal':       'bathroom',
  'furn_shower_glass':          'bathroom',
  'furn_shower_sage':           'bathroom',
  'furn_shower_sand':           'bathroom',
  'furn_shower_slate':          'bathroom',
  'furn_shower_two_tone':       'bathroom',

  // prop_sink_01
  'furn_sink_caramel':          'kitchen',
  'furn_sink_charcoal':         'kitchen',
  'furn_sink_farmhouse':        'kitchen',
  'furn_sink_sage':             'kitchen',
  'furn_sink_stone':            'kitchen',
  'furn_sink_two_tone':         'kitchen',
  // W1-171 — rooms for the twelve, read off the sprite paths.
  // 🔴 THIS MAP MUST HOLD EXACTLY THE SAME KEYS AS kSkinSpriteStems. A stem
  // wired without a room resolves to null, which means "draw the base piece" —
  // silent, and the W1-162 bug.

  // prop_bed_single_01
  'furn_bed_single_caramel':    'bedroom',
  'furn_bed_single_charcoal':   'bedroom',
  'furn_bed_single_ivory':      'bedroom',
  'furn_bed_single_sage':       'bedroom',
  'furn_bed_single_two_tone':   'bedroom',
  'furn_bed_single_race_car':   'bedroom',

  // prop_bench_01
  'furn_bench_caramel':         'dining_room',
  'furn_bench_charcoal':        'dining_room',
  'furn_bench_ivory':           'dining_room',
  'furn_bench_sage':            'dining_room',
  'furn_bench_two_tone':        'dining_room',

  // prop_cabinet_01
  'furn_cabinet_caramel':       'kitchen',
  'furn_cabinet_charcoal':      'kitchen',
  'furn_cabinet_ivory':         'kitchen',
  'furn_cabinet_sage':          'kitchen',
  'furn_cabinet_two_tone':      'kitchen',

  // prop_dining_chair_01
  'furn_dining_chair_caramel':  'dining_room',
  'furn_dining_chair_charcoal': 'dining_room',
  'furn_dining_chair_ivory':    'dining_room',
  'furn_dining_chair_sage':     'dining_room',

  // prop_dryer_01
  'furn_dryer_butter':          'laundry_room',
  'furn_dryer_mint':            'laundry_room',
  'furn_dryer_slate':           'laundry_room',
  'furn_dryer_terracotta':      'laundry_room',
  'furn_dryer_two_tone':        'laundry_room',

  // prop_microwave_01
  'furn_microwave_butter':      'kitchen',
  'furn_microwave_mint':        'kitchen',
  'furn_microwave_slate':       'kitchen',
  'furn_microwave_terracotta':  'kitchen',
  'furn_microwave_two_tone':    'kitchen',

  // prop_nightstand_01
  'furn_nightstand_caramel':    'bedroom',
  'furn_nightstand_charcoal':   'bedroom',
  'furn_nightstand_ivory':      'bedroom',
  'furn_nightstand_sage':       'bedroom',
  'furn_nightstand_two_tone':   'bedroom',

  // prop_office_chair_01
  'furn_office_chair_caramel':  'office',
  'furn_office_chair_charcoal': 'office',
  'furn_office_chair_ivory':    'office',
  'furn_office_chair_sage':     'office',
  'furn_office_chair_two_tone': 'office',

  // prop_side_table_01
  'furn_side_table_caramel':    'living_room',
  'furn_side_table_charcoal':   'living_room',
  'furn_side_table_ivory':      'living_room',
  'furn_side_table_sage':       'living_room',
  'furn_side_table_two_tone':   'living_room',

  // prop_stool_01
  'furn_stool_caramel':         'dining_room',
  'furn_stool_charcoal':        'dining_room',
  'furn_stool_ivory':           'dining_room',
  'furn_stool_sage':            'dining_room',
  'furn_stool_two_tone':        'dining_room',

  // prop_wardrobe_01
  'furn_wardrobe_caramel':      'bedroom',
  'furn_wardrobe_charcoal':     'bedroom',
  'furn_wardrobe_ivory':        'bedroom',
  'furn_wardrobe_sage':         'bedroom',
  'furn_wardrobe_two_tone':     'bedroom',

  // prop_washer_01
  'furn_washer_butter':         'kitchen',
  'furn_washer_mint':           'kitchen',
  'furn_washer_slate':          'kitchen',
  'furn_washer_terracotta':     'kitchen',
  'furn_washer_two_tone':       'kitchen',
  // W1-172 — rooms for the last three, read off the sprite paths.

  // prop_bed_double_01
  'furn_bed_double_caramel':     'bedroom',
  'furn_bed_double_charcoal':    'bedroom',
  'furn_bed_double_four_poster': 'bedroom',
  'furn_bed_double_ivory':       'bedroom',
  'furn_bed_double_sage':        'bedroom',
  'furn_bed_double_two_tone':    'bedroom',
  'furn_bed_double_race_car':    'bedroom',

  // prop_lamp_table_01
  'furn_lamp_charcoal':          'bedroom',
  'furn_lamp_ivory':             'bedroom',
  'furn_lamp_lantern':           'bedroom',
  'furn_lamp_sage':              'bedroom',
  'furn_lamp_two_tone':          'bedroom',
  'furn_lamp_walnut':            'bedroom',

  // prop_stove_hood_01
  'furn_stove_hood_caramel':     'kitchen',
  'furn_stove_hood_charcoal':    'kitchen',
  'furn_stove_hood_ivory':       'kitchen',
  'furn_stove_hood_range':       'kitchen',
  'furn_stove_hood_sage':        'kitchen',
  'furn_stove_hood_two_tone':    'kitchen',
};

/// Full rot0 asset path for [seedId], or null when the skin has no art of its
/// own and should fall back to its base piece.
String? skinAssetPathFor(String seedId) {
  final stem = kSkinSpriteStems[seedId];
  final room = kSkinSpriteRooms[seedId];
  if (stem == null || room == null) return null;
  return 'assets/images/furniture/$room/$stem.png';
}

/// The equip slot [seedId] belongs to, resolved through the seed list.
///
/// The games need this to key a skin's sprite against the base piece it dresses
/// — [spriteCacheKey] takes both. Returns null for an id that is not in the
/// seed, which is what a stale inventory row from a removed skin looks like.
String? skinBaseFurnitureIdFor(String seedId) {
  for (final item in kCollectionSeed) {
    if (item.id == seedId) return baseFurnitureIdFor(item);
  }
  return null;
}

/// Returns the [baseFurnitureId] slot for a given [SeedItem].
///
/// - furniture → looked up via [kFurnSeedCategoryToBasePiece]; null if unknown.
/// - character → 'character'.
/// - style, category 'roof' → 'houseStyle_roof'.
/// - style, category 'wall' → 'houseStyle_wall'.
/// - style, category 'exterior' → 'houseStyle_exterior'.
/// - unknown → null.
///
/// ⚠️ A category with no case here returns null and the row is **silently
/// dropped** from the album by `SkinCatalog.buildSlots` — no error, no log.
/// That is why the exterior arrangements needed a case added here as well as
/// a slot in [SkinCatalog]; without it they would have been authored,
/// grantable by the backend, and invisible.
String? baseFurnitureIdFor(SeedItem item) {
  switch (item.type) {
    case 'furniture':
      return kFurnSeedCategoryToBasePiece[item.category];
    case 'character':
      // Fox outfits get their own slot. Folding eleven of them into the generic
      // character slot would make that row sixteen long and make its "Default
      // Character" default ambiguous between a profession and a species.
      return isFoxOutfitId(item.id) ? kFoxSlotId : kUnscopedCharacterSlotId;
    case 'style':
      if (item.category == 'roof') return 'houseStyle_roof';
      if (item.category == 'wall') return 'houseStyle_wall';
      if (item.category == 'exterior') return 'houseStyle_exterior';
      return null;
    default:
      return null;
  }
}

/// Convenience: the full set of rarity values that exist in the seed.
/// Useful for documentation; [rarityFromSeed] is the runtime converter.
final Set<String> kSeedRarities = kCollectionSeed.map((s) => s.rarity).toSet();
