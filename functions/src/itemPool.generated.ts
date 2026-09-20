// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source:    functions/seed/collection_seed.json
// Generator: functions/scripts/gen-seed.cjs
// Regenerate: npm --prefix functions run seed:gen
//
// Edits here are destroyed on the next run, and `npm run seed:check` fails the
// suite when this file disagrees with the source — which is the point: the two
// language projections cannot drift because neither is authored.

import type { SeedItem } from './itemPool';

export const SEED_ITEMS_GENERATED: SeedItem[] = [
  // DROPPED 2026-08-29 by Brendan: house roof styles are shelved. These three rows
  // (straw, tile, tile_gold) stay wired and stay in the album — dropped, not deleted —
  // and no roof art is commissioned.
  // They ship with zero art. Re-check rather than trust this sentence:
  //   find assets -iname "*roof*"   ->  0 files (2026-08-29)
  // so the gap is the decision, not a bug.
  // Scope and reasoning: Projects/Cleaning/decisions-2026-08-29-roof-styles-dropped.md.
  // This note points at that record rather than restating it, because a second copy
  // drifts from the first. Un-dropping is an art commission, not a wiring job.
  { id: 'style_roof_straw',            type: 'style',     category: 'roof',         subject: 'roof',           name: 'Straw Roof',             rarity: 'common', artUrl: '' },
  { id: 'style_roof_tile',             type: 'style',     category: 'roof',         subject: 'roof',           name: 'Terracotta Tile Roof',   rarity: 'rare', artUrl: '' },
  { id: 'style_roof_tile_gold',        type: 'style',     category: 'roof',         subject: 'roof',           name: 'Golden Tile Roof',       rarity: 'legendary', artUrl: '' },
  { id: 'style_wall_whitewash',        type: 'style',     category: 'wall',         subject: 'wall',           name: 'Whitewash Wall',         rarity: 'common', artUrl: '' },
  { id: 'style_wall_stone',            type: 'style',     category: 'wall',         subject: 'wall',           name: 'Stone Wall',             rarity: 'rare', artUrl: '' },
  { id: 'furn_cozy_sofa',              type: 'furniture', category: 'sofa',         subject: 'sofa',           name: 'Cozy Sofa',              rarity: 'common', artUrl: '' },
  { id: 'furn_bear_chair',             type: 'furniture', category: 'chair',        subject: 'armchair',       name: 'Bear Armchair',          rarity: 'rare', artUrl: '' },
  { id: 'furn_neon_lamp',              type: 'furniture', category: 'lamp',         subject: 'lamp',           name: 'Neon Lamp',              rarity: 'legendary', artUrl: '' },
  { id: 'furn_retro_tv',               type: 'furniture', category: 'tv',           subject: 'tv_stand',       name: 'Retro TV',               rarity: 'common', artUrl: '' },
  { id: 'furn_bunk_bed',               type: 'furniture', category: 'bed',          subject: 'bunk_bed',       name: 'Bunk Bed',               rarity: 'rare', artUrl: '' },
  { id: 'furn_bunk_walnut',            type: 'furniture', category: 'bed',          subject: 'bunk_bed',       name: 'Walnut Bunk Bed',        rarity: 'common', artUrl: '' },
  { id: 'furn_bunk_charcoal',          type: 'furniture', category: 'bed',          subject: 'bunk_bed',       name: 'Charcoal Bunk Bed',      rarity: 'common', artUrl: '' },
  { id: 'furn_bunk_pine',              type: 'furniture', category: 'bed',          subject: 'bunk_bed',       name: 'Pine Bunk Bed',          rarity: 'common', artUrl: '' },
  { id: 'furn_bunk_sage',              type: 'furniture', category: 'bed',          subject: 'bunk_bed',       name: 'Sage Bunk Bed',          rarity: 'common', artUrl: '' },
  { id: 'furn_bunk_princess',          type: 'furniture', category: 'bed',          subject: 'bunk_bed',       name: 'Princess Bunk Bed',      rarity: 'legendary', artUrl: '' },
  { id: 'furn_bunk_race_car',          type: 'furniture', category: 'bed',          subject: 'bunk_bed',       name: 'Race Car Bunk Bed',      rarity: 'legendary', artUrl: '' },
  { id: 'char_cleaner',                type: 'character', category: 'character',    subject: 'character',      name: 'Pro Cleaner',            rarity: 'common', artUrl: '' },
  { id: 'char_gardener',               type: 'character', category: 'character',    subject: 'character',      name: 'Gardener',               rarity: 'rare', artUrl: '' },
  { id: 'char_chef',                   type: 'character', category: 'character',    subject: 'character',      name: 'Chef',                   rarity: 'common', artUrl: '' },
  { id: 'char_knight',                 type: 'character', category: 'character',    subject: 'character',      name: 'Knight',                 rarity: 'legendary', artUrl: '' },
  { id: 'char_astronaut',              type: 'character', category: 'character',    subject: 'character',      name: 'Astronaut',              rarity: 'legendary', artUrl: '' },
  // Mirrors collection_seed.dart, which placed it here for the same reason: it
  // is a character look, not a fox outfit, so `subject` is 'character' and the
  // kFoxOutfitIdPrefix convention deliberately does not apply. Grant-only until
  // now — #240's validator refuses any offer naming an id absent from this
  // list, so the guard that makes the shop safe is what kept it out of one.
  { id: 'char_pyjama',                 type: 'character', category: 'character',    subject: 'character',      name: 'Pyjamas',                rarity: 'legendary', artUrl: '' },
  // --- Day-one set: sofa finishes (W3-08) -----------------------------------
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
  { id: 'furn_sofa_brown',             type: 'furniture', category: 'sofa',         subject: 'sofa',           name: 'Walnut Sofa',            rarity: 'common', artUrl: '' },
  { id: 'furn_sofa_charcoal',          type: 'furniture', category: 'sofa',         subject: 'sofa',           name: 'Charcoal Sofa',          rarity: 'common', artUrl: '' },
  { id: 'furn_sofa_ivory',             type: 'furniture', category: 'sofa',         subject: 'sofa',           name: 'Ivory Sofa',             rarity: 'common', artUrl: '' },
  { id: 'furn_sofa_sage',              type: 'furniture', category: 'sofa',         subject: 'sofa',           name: 'Sage Sofa',              rarity: 'common', artUrl: '' },
  { id: 'furn_sofa_two_tone',          type: 'furniture', category: 'sofa',         subject: 'sofa',           name: 'Two-Tone Sofa',          rarity: 'rare', artUrl: '' },
  { id: 'furn_sofa_modern',            type: 'furniture', category: 'sofa',         subject: 'sofa',           name: 'Modern Sofa',            rarity: 'legendary', artUrl: '' },
  { id: 'furn_sofa_cream',             type: 'furniture', category: 'sofa',         subject: 'sofa',           name: 'Cream Sofa',             rarity: 'common', artUrl: '' },
  // --- Day-one set: outside plants (W3-08) ----------------------------------
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
  { id: 'style_ext_lawn_default',      type: 'style',     category: 'exterior',     subject: 'outside_plants', name: 'Woodland Lawn',          rarity: 'common', artUrl: '' },
  { id: 'style_ext_orchard_rows',      type: 'style',     category: 'exterior',     subject: 'outside_plants', name: 'Orchard Rows',           rarity: 'common', artUrl: '' },
  { id: 'style_ext_rock_garden',       type: 'style',     category: 'exterior',     subject: 'outside_plants', name: 'Rock Garden',            rarity: 'common', artUrl: '' },
  { id: 'style_ext_wildflower',        type: 'style',     category: 'exterior',     subject: 'outside_plants', name: 'Wildflower Meadow',      rarity: 'common', artUrl: '' },
  { id: 'style_ext_clean_lawn',        type: 'style',     category: 'exterior',     subject: 'outside_plants', name: 'Clean Lawn',             rarity: 'rare', artUrl: '' },
  { id: 'style_ext_flower_bed',        type: 'style',     category: 'exterior',     subject: 'outside_plants', name: 'Flower Beds',            rarity: 'rare', artUrl: '' },
  { id: 'style_ext_garden_path',       type: 'style',     category: 'exterior',     subject: 'outside_plants', name: 'Garden Path',            rarity: 'legendary', artUrl: '' },
  // --- Day-one set: fox outfits (W3-09) -------------------------------------
  // The first per-character outfit set, which is what `SeedItem.subject`'s
  // "'character' until per-character outfit sets land" comment anticipated.
  //
  // KEY: THESE ARE THE ONLY CHARACTER ROWS WITH ART. The five profession rows
  // above (cleaner/gardener/chef/knight/astronaut) have never had an assetPath
  // and render as MaterialIcons glyphs; these eleven each ship an avatar and a
  // die-cut album card, and equipping one visibly changes the player's avatar.
  //
  // KEY: golden_suit IS RARE, NOT LEGENDARY, and that is a decision not an
  // oversight. decisions-2026-08-05-legendary-tier.md rules that a legendary
  // must change the SILHOUETTE; rendered correctly per Style B (no metal, no
  // gleam, no aura) the golden suit is the black suit in a warmer colour with
  // an identical outline. `space_suit` (helmet) and `bubble_bath` (cap, towel,
  // bubbles) do change the outline and carry the tier on their own, so the
  // legendary cell stays non-empty and the coverage test cannot go red.
  //
  // WARNING: 4 common / 5 rare / 2 legendary. The ladder is rare-heavy because the
  // golden suit moved down, not because a rare was authored to fill it.
  { id: 'char_fox_baseball_hat',       type: 'character', category: 'character',    subject: 'fox_outfit',     name: 'Baseball Cap',           rarity: 'common', artUrl: '' },
  { id: 'char_fox_graphic_tee',        type: 'character', category: 'character',    subject: 'fox_outfit',     name: 'Graphic Tee',            rarity: 'common', artUrl: '' },
  { id: 'char_fox_cool_shades',        type: 'character', category: 'character',    subject: 'fox_outfit',     name: 'Cool Shades',            rarity: 'common', artUrl: '' },
  { id: 'char_fox_chef_hat',           type: 'character', category: 'character',    subject: 'fox_outfit',     name: 'Chef Hat',               rarity: 'common', artUrl: '' },
  { id: 'char_fox_runner',             type: 'character', category: 'character',    subject: 'fox_outfit',     name: 'Runner Kit',             rarity: 'rare', artUrl: '' },
  { id: 'char_fox_chef',               type: 'character', category: 'character',    subject: 'fox_outfit',     name: 'Chef Whites',            rarity: 'rare', artUrl: '' },
  { id: 'char_fox_oversized_hoodie',   type: 'character', category: 'character',    subject: 'fox_outfit',     name: 'Oversized Hoodie',       rarity: 'rare', artUrl: '' },
  { id: 'char_fox_black_suit',         type: 'character', category: 'character',    subject: 'fox_outfit',     name: 'Black Suit',             rarity: 'rare', artUrl: '' },
  { id: 'char_fox_golden_suit',        type: 'character', category: 'character',    subject: 'fox_outfit',     name: 'Golden Suit',            rarity: 'rare', artUrl: '' },
  { id: 'char_fox_space_suit',         type: 'character', category: 'character',    subject: 'fox_outfit',     name: 'Space Suit',             rarity: 'legendary', artUrl: '' },
  { id: 'char_fox_bubble_bath',        type: 'character', category: 'character',    subject: 'fox_outfit',     name: 'Bubble Bath',            rarity: 'legendary', artUrl: '' },
  // --- Finish sets: armchair and tv_stand (W3-117, #547) --------------------
  // Baked ahead of their consumer and wired here. The ladder mirrors the sofa
  // set by FINISH: four commons that are palette swaps of the shipped mesh,
  // one rare two-tone of it, one legendary.
  //
  // NOTE: `furn_tv_stand_console` IS A LEGENDARY THAT DOES NOT CHANGE THE
  // OUTLINE, which decisions-2026-08-05-legendary-tier.md otherwise forbids,
  // and it is argued rather than overlooked. #547 records tv_stand as
  // `verify_shape`-WAIVED (IoU 0.778/0.779 against an 0.80 floor), so a
  // silhouette-changing legendary in this slot could not be gated on shape at
  // all; its ladder is built from material-slot count instead. Do not
  // re-derive this as a defect.
  //
  // NOTE: BOTH SUBJECTS ARE NOW IN ROTATION (W2-130). Wiring the rows was not
  // unbenching them — that took the separate ruling recorded on
  // DAILY_SUBJECT_POOLS above, which Brendan gave on 2026-08-19. `furniture` is
  // ['sofa', 'armchair', 'tv_stand'], so sofa now appears one day in three.
  { id: 'furn_armchair_walnut',        type: 'furniture', category: 'chair',        subject: 'armchair',       name: 'Walnut Armchair',        rarity: 'common', artUrl: '' },
  { id: 'furn_armchair_charcoal',      type: 'furniture', category: 'chair',        subject: 'armchair',       name: 'Charcoal Armchair',      rarity: 'common', artUrl: '' },
  { id: 'furn_armchair_ivory',         type: 'furniture', category: 'chair',        subject: 'armchair',       name: 'Ivory Armchair',         rarity: 'common', artUrl: '' },
  { id: 'furn_armchair_sage',          type: 'furniture', category: 'chair',        subject: 'armchair',       name: 'Sage Armchair',          rarity: 'common', artUrl: '' },
  { id: 'furn_armchair_two_tone',      type: 'furniture', category: 'chair',        subject: 'armchair',       name: 'Two-Tone Armchair',      rarity: 'rare', artUrl: '' },
  { id: 'furn_armchair_wing',          type: 'furniture', category: 'chair',        subject: 'armchair',       name: 'Wing Armchair',          rarity: 'legendary', artUrl: '' },
  { id: 'furn_tv_stand_walnut',        type: 'furniture', category: 'tv',           subject: 'tv_stand',       name: 'Walnut TV Stand',        rarity: 'common', artUrl: '' },
  { id: 'furn_tv_stand_charcoal',      type: 'furniture', category: 'tv',           subject: 'tv_stand',       name: 'Charcoal TV Stand',      rarity: 'common', artUrl: '' },
  { id: 'furn_tv_stand_butter',        type: 'furniture', category: 'tv',           subject: 'tv_stand',       name: 'Butter TV Stand',        rarity: 'common', artUrl: '' },
  { id: 'furn_tv_stand_mint',          type: 'furniture', category: 'tv',           subject: 'tv_stand',       name: 'Mint TV Stand',          rarity: 'common', artUrl: '' },
  { id: 'furn_tv_stand_two_tone',      type: 'furniture', category: 'tv',           subject: 'tv_stand',       name: 'Two-Tone TV Stand',      rarity: 'rare', artUrl: '' },
  { id: 'furn_tv_stand_console',       type: 'furniture', category: 'tv',           subject: 'tv_stand',       name: 'Console TV Stand',       rarity: 'legendary', artUrl: '' },
  { id: 'furn_bathtub_charcoal',       type: 'furniture', category: 'bathtub',      subject: 'bathtub',        name: 'Charcoal Bathtub',       rarity: 'common', artUrl: '' },
  { id: 'furn_bathtub_sage',           type: 'furniture', category: 'bathtub',      subject: 'bathtub',        name: 'Sage Bathtub',           rarity: 'common', artUrl: '' },
  { id: 'furn_bathtub_sand',           type: 'furniture', category: 'bathtub',      subject: 'bathtub',        name: 'Sand Bathtub',           rarity: 'common', artUrl: '' },
  { id: 'furn_bathtub_slate',          type: 'furniture', category: 'bathtub',      subject: 'bathtub',        name: 'Slate Bathtub',          rarity: 'common', artUrl: '' },
  { id: 'furn_bathtub_slipper',        type: 'furniture', category: 'bathtub',      subject: 'bathtub',        name: 'Slipper Bathtub',        rarity: 'legendary', artUrl: '' },
  { id: 'furn_bathtub_two_tone',       type: 'furniture', category: 'bathtub',      subject: 'bathtub',        name: 'Two-Tone Bathtub',       rarity: 'rare', artUrl: '' },
  { id: 'furn_bookshelf_caramel',      type: 'furniture', category: 'bookshelf',    subject: 'bookshelf',      name: 'Caramel Bookshelf',      rarity: 'common', artUrl: '' },
  { id: 'furn_bookshelf_charcoal',     type: 'furniture', category: 'bookshelf',    subject: 'bookshelf',      name: 'Charcoal Bookshelf',     rarity: 'common', artUrl: '' },
  { id: 'furn_bookshelf_ivory',        type: 'furniture', category: 'bookshelf',    subject: 'bookshelf',      name: 'Ivory Bookshelf',        rarity: 'common', artUrl: '' },
  { id: 'furn_bookshelf_library',      type: 'furniture', category: 'bookshelf',    subject: 'bookshelf',      name: 'Library Bookshelf',      rarity: 'legendary', artUrl: '' },
  { id: 'furn_bookshelf_sage',         type: 'furniture', category: 'bookshelf',    subject: 'bookshelf',      name: 'Sage Bookshelf',         rarity: 'common', artUrl: '' },
  { id: 'furn_bookshelf_two_tone',     type: 'furniture', category: 'bookshelf',    subject: 'bookshelf',      name: 'Two-Tone Bookshelf',     rarity: 'rare', artUrl: '' },
  { id: 'furn_coffee_table_caramel',   type: 'furniture', category: 'coffee_table', subject: 'coffee_table',   name: 'Caramel Coffee Table',   rarity: 'common', artUrl: '' },
  { id: 'furn_coffee_table_charcoal',  type: 'furniture', category: 'coffee_table', subject: 'coffee_table',   name: 'Charcoal Coffee Table',  rarity: 'common', artUrl: '' },
  { id: 'furn_coffee_table_ivory',     type: 'furniture', category: 'coffee_table', subject: 'coffee_table',   name: 'Ivory Coffee Table',     rarity: 'common', artUrl: '' },
  { id: 'furn_coffee_table_sage',      type: 'furniture', category: 'coffee_table', subject: 'coffee_table',   name: 'Sage Coffee Table',      rarity: 'common', artUrl: '' },
  { id: 'furn_counter_caramel',        type: 'furniture', category: 'counter',      subject: 'counter',        name: 'Caramel Counter',        rarity: 'common', artUrl: '' },
  { id: 'furn_counter_charcoal',       type: 'furniture', category: 'counter',      subject: 'counter',        name: 'Charcoal Counter',       rarity: 'common', artUrl: '' },
  { id: 'furn_counter_ivory',          type: 'furniture', category: 'counter',      subject: 'counter',        name: 'Ivory Counter',          rarity: 'common', artUrl: '' },
  { id: 'furn_counter_open_shelf',     type: 'furniture', category: 'counter',      subject: 'counter',        name: 'Open Shelf Counter',     rarity: 'legendary', artUrl: '' },
  { id: 'furn_counter_sage',           type: 'furniture', category: 'counter',      subject: 'counter',        name: 'Sage Counter',           rarity: 'common', artUrl: '' },
  { id: 'furn_counter_two_tone',       type: 'furniture', category: 'counter',      subject: 'counter',        name: 'Two-Tone Counter',       rarity: 'rare', artUrl: '' },
  { id: 'furn_desk_caramel',           type: 'furniture', category: 'desk',         subject: 'desk',           name: 'Caramel Desk',           rarity: 'common', artUrl: '' },
  { id: 'furn_desk_charcoal',          type: 'furniture', category: 'desk',         subject: 'desk',           name: 'Charcoal Desk',          rarity: 'common', artUrl: '' },
  { id: 'furn_desk_ivory',             type: 'furniture', category: 'desk',         subject: 'desk',           name: 'Ivory Desk',             rarity: 'common', artUrl: '' },
  { id: 'furn_desk_sage',              type: 'furniture', category: 'desk',         subject: 'desk',           name: 'Sage Desk',              rarity: 'common', artUrl: '' },
  { id: 'furn_desk_two_tone',          type: 'furniture', category: 'desk',         subject: 'desk',           name: 'Two-Tone Desk',          rarity: 'rare', artUrl: '' },
  { id: 'furn_dining_table_caramel',   type: 'furniture', category: 'dining_table', subject: 'dining_table',   name: 'Caramel Dining Table',   rarity: 'common', artUrl: '' },
  { id: 'furn_dining_table_charcoal',  type: 'furniture', category: 'dining_table', subject: 'dining_table',   name: 'Charcoal Dining Table',  rarity: 'common', artUrl: '' },
  { id: 'furn_dining_table_ivory',     type: 'furniture', category: 'dining_table', subject: 'dining_table',   name: 'Ivory Dining Table',     rarity: 'common', artUrl: '' },
  { id: 'furn_dining_table_sage',      type: 'furniture', category: 'dining_table', subject: 'dining_table',   name: 'Sage Dining Table',      rarity: 'common', artUrl: '' },
  { id: 'furn_dining_table_trestle',   type: 'furniture', category: 'dining_table', subject: 'dining_table',   name: 'Trestle Dining Table',   rarity: 'legendary', artUrl: '' },
  { id: 'furn_dining_table_two_tone',  type: 'furniture', category: 'dining_table', subject: 'dining_table',   name: 'Two-Tone Dining Table',  rarity: 'rare', artUrl: '' },
  { id: 'furn_dresser_caramel',        type: 'furniture', category: 'dresser',      subject: 'dresser',        name: 'Caramel Dresser',        rarity: 'common', artUrl: '' },
  { id: 'furn_dresser_charcoal',       type: 'furniture', category: 'dresser',      subject: 'dresser',        name: 'Charcoal Dresser',       rarity: 'common', artUrl: '' },
  { id: 'furn_dresser_ivory',          type: 'furniture', category: 'dresser',      subject: 'dresser',        name: 'Ivory Dresser',          rarity: 'common', artUrl: '' },
  { id: 'furn_dresser_sage',           type: 'furniture', category: 'dresser',      subject: 'dresser',        name: 'Sage Dresser',           rarity: 'common', artUrl: '' },
  { id: 'furn_dresser_two_tone',       type: 'furniture', category: 'dresser',      subject: 'dresser',        name: 'Two-Tone Dresser',       rarity: 'rare', artUrl: '' },
  { id: 'furn_fridge_butter',          type: 'furniture', category: 'fridge',       subject: 'fridge',         name: 'Butter Fridge',          rarity: 'common', artUrl: '' },
  { id: 'furn_fridge_charcoal',        type: 'furniture', category: 'fridge',       subject: 'fridge',         name: 'Charcoal Fridge',        rarity: 'common', artUrl: '' },
  { id: 'furn_fridge_mint',            type: 'furniture', category: 'fridge',       subject: 'fridge',         name: 'Mint Fridge',            rarity: 'common', artUrl: '' },
  { id: 'furn_fridge_retro',           type: 'furniture', category: 'fridge',       subject: 'fridge',         name: 'Retro Fridge',           rarity: 'legendary', artUrl: '' },
  { id: 'furn_fridge_terracotta',      type: 'furniture', category: 'fridge',       subject: 'fridge',         name: 'Terracotta Fridge',      rarity: 'common', artUrl: '' },
  { id: 'furn_fridge_two_tone',        type: 'furniture', category: 'fridge',       subject: 'fridge',         name: 'Two-Tone Fridge',        rarity: 'rare', artUrl: '' },
  { id: 'furn_shower_charcoal',        type: 'furniture', category: 'shower',       subject: 'shower',         name: 'Charcoal Shower',        rarity: 'common', artUrl: '' },
  { id: 'furn_shower_glass',           type: 'furniture', category: 'shower',       subject: 'shower',         name: 'Glass Shower',           rarity: 'legendary', artUrl: '' },
  { id: 'furn_shower_sage',            type: 'furniture', category: 'shower',       subject: 'shower',         name: 'Sage Shower',            rarity: 'common', artUrl: '' },
  { id: 'furn_shower_sand',            type: 'furniture', category: 'shower',       subject: 'shower',         name: 'Sand Shower',            rarity: 'common', artUrl: '' },
  { id: 'furn_shower_slate',           type: 'furniture', category: 'shower',       subject: 'shower',         name: 'Slate Shower',           rarity: 'common', artUrl: '' },
  { id: 'furn_shower_two_tone',        type: 'furniture', category: 'shower',       subject: 'shower',         name: 'Two-Tone Shower',        rarity: 'rare', artUrl: '' },
  { id: 'furn_sink_caramel',           type: 'furniture', category: 'sink',         subject: 'sink',           name: 'Caramel Sink',           rarity: 'common', artUrl: '' },
  { id: 'furn_sink_charcoal',          type: 'furniture', category: 'sink',         subject: 'sink',           name: 'Charcoal Sink',          rarity: 'common', artUrl: '' },
  { id: 'furn_sink_farmhouse',         type: 'furniture', category: 'sink',         subject: 'sink',           name: 'Farmhouse Sink',         rarity: 'legendary', artUrl: '' },
  { id: 'furn_sink_sage',              type: 'furniture', category: 'sink',         subject: 'sink',           name: 'Sage Sink',              rarity: 'common', artUrl: '' },
  { id: 'furn_sink_stone',             type: 'furniture', category: 'sink',         subject: 'sink',           name: 'Stone Sink',             rarity: 'common', artUrl: '' },
  { id: 'furn_sink_two_tone',          type: 'furniture', category: 'sink',         subject: 'sink',           name: 'Two-Tone Sink',          rarity: 'rare', artUrl: '' },
  // --- Finish ladders: twelve props (W2-159) --------------------------------
  // Twelve props whose finish sprites were baked and unreferenced. category is 1:1 with the prop rather than grouped: kFurnSeedCategoryToBasePiece already maps chair->armchair and bed->bunk_bed, so reusing those categories would silently resolve to the wrong base piece. family and rarity are derived from the committed rows, where each finish token maps to exactly one family with zero conflicts. prop_washer_01_spin and _spin_rot90 are deliberately absent: they are 4096x512 eight-frame animation strips, not finishes. bed_double, lamp_table and stove_hood are held back because they have no FurnitureCatalogue entry.
  { id: 'furn_bed_single_caramel',     type: 'furniture', category: 'bed_single',   subject: 'bed_single',     name: 'Caramel Single Bed',     rarity: 'common', artUrl: '' },
  { id: 'furn_bed_single_charcoal',    type: 'furniture', category: 'bed_single',   subject: 'bed_single',     name: 'Charcoal Single Bed',    rarity: 'common', artUrl: '' },
  { id: 'furn_bed_single_ivory',       type: 'furniture', category: 'bed_single',   subject: 'bed_single',     name: 'Ivory Single Bed',       rarity: 'common', artUrl: '' },
  { id: 'furn_bed_single_sage',        type: 'furniture', category: 'bed_single',   subject: 'bed_single',     name: 'Sage Single Bed',        rarity: 'common', artUrl: '' },
  { id: 'furn_bed_single_two_tone',    type: 'furniture', category: 'bed_single',   subject: 'bed_single',     name: 'Two-Tone Single Bed',    rarity: 'rare', artUrl: '' },
  // CRITICAL: RARITY AND FAMILY ARE PROVISIONAL - W1-201, pending Brendan's confirmation.
  // They are the MECHANICAL derivation, not a ruling, and the two rules agree:
  //   . furn_bunk_race_car, the only other `race_car` token in the seed, is committed
  //     at legendary/oakhouse - one precedent, zero conflicts.
  //   . 15 of the 16 furniture legendaries carry family `oakhouse`; the 16th,
  //     furn_neon_lamp, is a pre-ladder row with no family at all.
  // This gives the single its FIRST legendary and the double a SECOND beside
  // four_poster - which is the part that is Brendan's to accept, not the tier itself.
  // Changing it costs these two fields plus `npm --prefix functions run seed:gen`.
  // DELETE THIS NOTE ON CONFIRMATION.
  { id: 'furn_bed_single_race_car',    type: 'furniture', category: 'bed_single',   subject: 'bed_single',     name: 'Race Car Single Bed',    rarity: 'legendary', artUrl: '' },
  { id: 'furn_bench_caramel',          type: 'furniture', category: 'bench',        subject: 'bench',          name: 'Caramel Bench',          rarity: 'common', artUrl: '' },
  { id: 'furn_bench_charcoal',         type: 'furniture', category: 'bench',        subject: 'bench',          name: 'Charcoal Bench',         rarity: 'common', artUrl: '' },
  { id: 'furn_bench_ivory',            type: 'furniture', category: 'bench',        subject: 'bench',          name: 'Ivory Bench',            rarity: 'common', artUrl: '' },
  { id: 'furn_bench_sage',             type: 'furniture', category: 'bench',        subject: 'bench',          name: 'Sage Bench',             rarity: 'common', artUrl: '' },
  { id: 'furn_bench_two_tone',         type: 'furniture', category: 'bench',        subject: 'bench',          name: 'Two-Tone Bench',         rarity: 'rare', artUrl: '' },
  { id: 'furn_cabinet_caramel',        type: 'furniture', category: 'cabinet',      subject: 'cabinet',        name: 'Caramel Cabinet',        rarity: 'common', artUrl: '' },
  { id: 'furn_cabinet_charcoal',       type: 'furniture', category: 'cabinet',      subject: 'cabinet',        name: 'Charcoal Cabinet',       rarity: 'common', artUrl: '' },
  { id: 'furn_cabinet_ivory',          type: 'furniture', category: 'cabinet',      subject: 'cabinet',        name: 'Ivory Cabinet',          rarity: 'common', artUrl: '' },
  { id: 'furn_cabinet_sage',           type: 'furniture', category: 'cabinet',      subject: 'cabinet',        name: 'Sage Cabinet',           rarity: 'common', artUrl: '' },
  { id: 'furn_cabinet_two_tone',       type: 'furniture', category: 'cabinet',      subject: 'cabinet',        name: 'Two-Tone Cabinet',       rarity: 'rare', artUrl: '' },
  { id: 'furn_dining_chair_caramel',   type: 'furniture', category: 'dining_chair', subject: 'dining_chair',   name: 'Caramel Dining Chair',   rarity: 'common', artUrl: '' },
  { id: 'furn_dining_chair_charcoal',  type: 'furniture', category: 'dining_chair', subject: 'dining_chair',   name: 'Charcoal Dining Chair',  rarity: 'common', artUrl: '' },
  { id: 'furn_dining_chair_ivory',     type: 'furniture', category: 'dining_chair', subject: 'dining_chair',   name: 'Ivory Dining Chair',     rarity: 'common', artUrl: '' },
  { id: 'furn_dining_chair_sage',      type: 'furniture', category: 'dining_chair', subject: 'dining_chair',   name: 'Sage Dining Chair',      rarity: 'common', artUrl: '' },
  { id: 'furn_dryer_butter',           type: 'furniture', category: 'dryer',        subject: 'dryer',          name: 'Butter Dryer',           rarity: 'common', artUrl: '' },
  { id: 'furn_dryer_mint',             type: 'furniture', category: 'dryer',        subject: 'dryer',          name: 'Mint Dryer',             rarity: 'common', artUrl: '' },
  { id: 'furn_dryer_slate',            type: 'furniture', category: 'dryer',        subject: 'dryer',          name: 'Slate Dryer',            rarity: 'common', artUrl: '' },
  { id: 'furn_dryer_terracotta',       type: 'furniture', category: 'dryer',        subject: 'dryer',          name: 'Terracotta Dryer',       rarity: 'common', artUrl: '' },
  { id: 'furn_dryer_two_tone',         type: 'furniture', category: 'dryer',        subject: 'dryer',          name: 'Two-Tone Dryer',         rarity: 'rare', artUrl: '' },
  { id: 'furn_microwave_butter',       type: 'furniture', category: 'microwave',    subject: 'microwave',      name: 'Butter Microwave',       rarity: 'common', artUrl: '' },
  { id: 'furn_microwave_mint',         type: 'furniture', category: 'microwave',    subject: 'microwave',      name: 'Mint Microwave',         rarity: 'common', artUrl: '' },
  { id: 'furn_microwave_slate',        type: 'furniture', category: 'microwave',    subject: 'microwave',      name: 'Slate Microwave',        rarity: 'common', artUrl: '' },
  { id: 'furn_microwave_terracotta',   type: 'furniture', category: 'microwave',    subject: 'microwave',      name: 'Terracotta Microwave',   rarity: 'common', artUrl: '' },
  { id: 'furn_microwave_two_tone',     type: 'furniture', category: 'microwave',    subject: 'microwave',      name: 'Two-Tone Microwave',     rarity: 'rare', artUrl: '' },
  { id: 'furn_nightstand_caramel',     type: 'furniture', category: 'nightstand',   subject: 'nightstand',     name: 'Caramel Nightstand',     rarity: 'common', artUrl: '' },
  { id: 'furn_nightstand_charcoal',    type: 'furniture', category: 'nightstand',   subject: 'nightstand',     name: 'Charcoal Nightstand',    rarity: 'common', artUrl: '' },
  { id: 'furn_nightstand_ivory',       type: 'furniture', category: 'nightstand',   subject: 'nightstand',     name: 'Ivory Nightstand',       rarity: 'common', artUrl: '' },
  { id: 'furn_nightstand_sage',        type: 'furniture', category: 'nightstand',   subject: 'nightstand',     name: 'Sage Nightstand',        rarity: 'common', artUrl: '' },
  { id: 'furn_nightstand_two_tone',    type: 'furniture', category: 'nightstand',   subject: 'nightstand',     name: 'Two-Tone Nightstand',    rarity: 'rare', artUrl: '' },
  { id: 'furn_office_chair_caramel',   type: 'furniture', category: 'office_chair', subject: 'office_chair',   name: 'Caramel Office Chair',   rarity: 'common', artUrl: '' },
  { id: 'furn_office_chair_charcoal',  type: 'furniture', category: 'office_chair', subject: 'office_chair',   name: 'Charcoal Office Chair',  rarity: 'common', artUrl: '' },
  { id: 'furn_office_chair_ivory',     type: 'furniture', category: 'office_chair', subject: 'office_chair',   name: 'Ivory Office Chair',     rarity: 'common', artUrl: '' },
  { id: 'furn_office_chair_sage',      type: 'furniture', category: 'office_chair', subject: 'office_chair',   name: 'Sage Office Chair',      rarity: 'common', artUrl: '' },
  { id: 'furn_office_chair_two_tone',  type: 'furniture', category: 'office_chair', subject: 'office_chair',   name: 'Two-Tone Office Chair',  rarity: 'rare', artUrl: '' },
  { id: 'furn_side_table_caramel',     type: 'furniture', category: 'side_table',   subject: 'side_table',     name: 'Caramel Side Table',     rarity: 'common', artUrl: '' },
  { id: 'furn_side_table_charcoal',    type: 'furniture', category: 'side_table',   subject: 'side_table',     name: 'Charcoal Side Table',    rarity: 'common', artUrl: '' },
  { id: 'furn_side_table_ivory',       type: 'furniture', category: 'side_table',   subject: 'side_table',     name: 'Ivory Side Table',       rarity: 'common', artUrl: '' },
  { id: 'furn_side_table_sage',        type: 'furniture', category: 'side_table',   subject: 'side_table',     name: 'Sage Side Table',        rarity: 'common', artUrl: '' },
  { id: 'furn_side_table_two_tone',    type: 'furniture', category: 'side_table',   subject: 'side_table',     name: 'Two-Tone Side Table',    rarity: 'rare', artUrl: '' },
  { id: 'furn_stool_caramel',          type: 'furniture', category: 'stool',        subject: 'stool',          name: 'Caramel Stool',          rarity: 'common', artUrl: '' },
  { id: 'furn_stool_charcoal',         type: 'furniture', category: 'stool',        subject: 'stool',          name: 'Charcoal Stool',         rarity: 'common', artUrl: '' },
  { id: 'furn_stool_ivory',            type: 'furniture', category: 'stool',        subject: 'stool',          name: 'Ivory Stool',            rarity: 'common', artUrl: '' },
  { id: 'furn_stool_sage',             type: 'furniture', category: 'stool',        subject: 'stool',          name: 'Sage Stool',             rarity: 'common', artUrl: '' },
  { id: 'furn_stool_two_tone',         type: 'furniture', category: 'stool',        subject: 'stool',          name: 'Two-Tone Stool',         rarity: 'rare', artUrl: '' },
  { id: 'furn_wardrobe_caramel',       type: 'furniture', category: 'wardrobe',     subject: 'wardrobe',       name: 'Caramel Wardrobe',       rarity: 'common', artUrl: '' },
  { id: 'furn_wardrobe_charcoal',      type: 'furniture', category: 'wardrobe',     subject: 'wardrobe',       name: 'Charcoal Wardrobe',      rarity: 'common', artUrl: '' },
  { id: 'furn_wardrobe_ivory',         type: 'furniture', category: 'wardrobe',     subject: 'wardrobe',       name: 'Ivory Wardrobe',         rarity: 'common', artUrl: '' },
  { id: 'furn_wardrobe_sage',          type: 'furniture', category: 'wardrobe',     subject: 'wardrobe',       name: 'Sage Wardrobe',          rarity: 'common', artUrl: '' },
  { id: 'furn_wardrobe_two_tone',      type: 'furniture', category: 'wardrobe',     subject: 'wardrobe',       name: 'Two-Tone Wardrobe',      rarity: 'rare', artUrl: '' },
  { id: 'furn_washer_butter',          type: 'furniture', category: 'washer',       subject: 'washer',         name: 'Butter Washer',          rarity: 'common', artUrl: '' },
  { id: 'furn_washer_mint',            type: 'furniture', category: 'washer',       subject: 'washer',         name: 'Mint Washer',            rarity: 'common', artUrl: '' },
  { id: 'furn_washer_slate',           type: 'furniture', category: 'washer',       subject: 'washer',         name: 'Slate Washer',           rarity: 'common', artUrl: '' },
  { id: 'furn_washer_terracotta',      type: 'furniture', category: 'washer',       subject: 'washer',         name: 'Terracotta Washer',      rarity: 'common', artUrl: '' },
  { id: 'furn_washer_two_tone',        type: 'furniture', category: 'washer',       subject: 'washer',         name: 'Two-Tone Washer',        rarity: 'rare', artUrl: '' },
  // --- Finish ladders: the last three props (W2-160) ------------------------
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
  { id: 'furn_bed_double_caramel',     type: 'furniture', category: 'bed_double',   subject: 'bed_double',     name: 'Caramel Double Bed',     rarity: 'common', artUrl: '' },
  { id: 'furn_bed_double_charcoal',    type: 'furniture', category: 'bed_double',   subject: 'bed_double',     name: 'Charcoal Double Bed',    rarity: 'common', artUrl: '' },
  { id: 'furn_bed_double_four_poster', type: 'furniture', category: 'bed_double',   subject: 'bed_double',     name: 'Four-Poster Double Bed', rarity: 'legendary', artUrl: '' },
  { id: 'furn_bed_double_ivory',       type: 'furniture', category: 'bed_double',   subject: 'bed_double',     name: 'Ivory Double Bed',       rarity: 'common', artUrl: '' },
  { id: 'furn_bed_double_sage',        type: 'furniture', category: 'bed_double',   subject: 'bed_double',     name: 'Sage Double Bed',        rarity: 'common', artUrl: '' },
  { id: 'furn_bed_double_two_tone',    type: 'furniture', category: 'bed_double',   subject: 'bed_double',     name: 'Two-Tone Double Bed',    rarity: 'rare', artUrl: '' },
  // CRITICAL: RARITY AND FAMILY ARE PROVISIONAL - W1-201, pending Brendan's confirmation.
  // They are the MECHANICAL derivation, not a ruling, and the two rules agree:
  //   . furn_bunk_race_car, the only other `race_car` token in the seed, is committed
  //     at legendary/oakhouse - one precedent, zero conflicts.
  //   . 15 of the 16 furniture legendaries carry family `oakhouse`; the 16th,
  //     furn_neon_lamp, is a pre-ladder row with no family at all.
  // This gives the single its FIRST legendary and the double a SECOND beside
  // four_poster - which is the part that is Brendan's to accept, not the tier itself.
  // Changing it costs these two fields plus `npm --prefix functions run seed:gen`.
  // DELETE THIS NOTE ON CONFIRMATION.
  { id: 'furn_bed_double_race_car',    type: 'furniture', category: 'bed_double',   subject: 'bed_double',     name: 'Race Car Double Bed',    rarity: 'legendary', artUrl: '' },
  { id: 'furn_lamp_charcoal',          type: 'furniture', category: 'lamp',         subject: 'lamp',           name: 'Charcoal Lamp',          rarity: 'common', artUrl: '' },
  { id: 'furn_lamp_ivory',             type: 'furniture', category: 'lamp',         subject: 'lamp',           name: 'Ivory Lamp',             rarity: 'common', artUrl: '' },
  { id: 'furn_lamp_lantern',           type: 'furniture', category: 'lamp',         subject: 'lamp',           name: 'Lantern Lamp',           rarity: 'legendary', artUrl: '' },
  { id: 'furn_lamp_sage',              type: 'furniture', category: 'lamp',         subject: 'lamp',           name: 'Sage Lamp',              rarity: 'common', artUrl: '' },
  { id: 'furn_lamp_two_tone',          type: 'furniture', category: 'lamp',         subject: 'lamp',           name: 'Two-Tone Lamp',          rarity: 'rare', artUrl: '' },
  { id: 'furn_lamp_walnut',            type: 'furniture', category: 'lamp',         subject: 'lamp',           name: 'Walnut Lamp',            rarity: 'common', artUrl: '' },
  { id: 'furn_stove_hood_caramel',     type: 'furniture', category: 'stove_hood',   subject: 'stove_hood',     name: 'Caramel Stove Hood',     rarity: 'common', artUrl: '' },
  { id: 'furn_stove_hood_charcoal',    type: 'furniture', category: 'stove_hood',   subject: 'stove_hood',     name: 'Charcoal Stove Hood',    rarity: 'common', artUrl: '' },
  { id: 'furn_stove_hood_ivory',       type: 'furniture', category: 'stove_hood',   subject: 'stove_hood',     name: 'Ivory Stove Hood',       rarity: 'common', artUrl: '' },
  { id: 'furn_stove_hood_range',       type: 'furniture', category: 'stove_hood',   subject: 'stove_hood',     name: 'Range Stove Hood',       rarity: 'legendary', artUrl: '' },
  { id: 'furn_stove_hood_sage',        type: 'furniture', category: 'stove_hood',   subject: 'stove_hood',     name: 'Sage Stove Hood',        rarity: 'common', artUrl: '' },
  { id: 'furn_stove_hood_two_tone',    type: 'furniture', category: 'stove_hood',   subject: 'stove_hood',     name: 'Two-Tone Stove Hood',    rarity: 'rare', artUrl: '' },
];

export const ITEM_FAMILY_GENERATED: Record<string, string> = {
  style_roof_straw:            'oakhouse',
  style_roof_tile:             'oakhouse',
  style_roof_tile_gold:        'oakhouse',
  style_wall_whitewash:        'dovecote',
  style_wall_stone:            'quarry',
  furn_retro_tv:               'oakhouse',
  furn_bunk_bed:               'oakhouse',
  furn_bunk_walnut:            'oakhouse',
  furn_bunk_charcoal:          'quarry',
  furn_bunk_pine:              'oakhouse',
  furn_bunk_sage:              'meadow',
  furn_bunk_princess:          'oakhouse',
  furn_bunk_race_car:          'oakhouse',
  char_gardener:               'meadow',
  furn_sofa_brown:             'oakhouse',
  furn_sofa_charcoal:          'quarry',
  furn_sofa_ivory:             'dovecote',
  furn_sofa_sage:              'meadow',
  furn_sofa_two_tone:          'oakhouse',
  furn_sofa_modern:            'oakhouse',
  furn_sofa_cream:             'dovecote',
  style_ext_orchard_rows:      'oakhouse',
  style_ext_rock_garden:       'quarry',
  style_ext_wildflower:        'meadow',
  style_ext_clean_lawn:        'dovecote',
  style_ext_flower_bed:        'meadow',
  style_ext_garden_path:       'quarry',
  char_fox_runner:             'quarry',
  char_fox_chef:               'dovecote',
  char_fox_oversized_hoodie:   'quarry',
  char_fox_black_suit:         'quarry',
  char_fox_space_suit:         'dovecote',
  char_fox_bubble_bath:        'dovecote',
  furn_armchair_walnut:        'oakhouse',
  furn_armchair_charcoal:      'quarry',
  furn_armchair_ivory:         'dovecote',
  furn_armchair_sage:          'meadow',
  furn_armchair_two_tone:      'oakhouse',
  furn_armchair_wing:          'oakhouse',
  furn_tv_stand_walnut:        'oakhouse',
  furn_tv_stand_charcoal:      'quarry',
  furn_tv_stand_butter:        'dovecote',
  furn_tv_stand_mint:          'meadow',
  furn_tv_stand_two_tone:      'oakhouse',
  furn_tv_stand_console:       'oakhouse',
  furn_bathtub_charcoal:       'quarry',
  furn_bathtub_sage:           'meadow',
  furn_bathtub_sand:           'dovecote',
  furn_bathtub_slate:          'quarry',
  furn_bathtub_slipper:        'oakhouse',
  furn_bathtub_two_tone:       'oakhouse',
  furn_bookshelf_caramel:      'oakhouse',
  furn_bookshelf_charcoal:     'quarry',
  furn_bookshelf_ivory:        'dovecote',
  furn_bookshelf_library:      'oakhouse',
  furn_bookshelf_sage:         'meadow',
  furn_bookshelf_two_tone:     'oakhouse',
  furn_coffee_table_caramel:   'oakhouse',
  furn_coffee_table_charcoal:  'quarry',
  furn_coffee_table_ivory:     'dovecote',
  furn_coffee_table_sage:      'meadow',
  furn_counter_caramel:        'oakhouse',
  furn_counter_charcoal:       'quarry',
  furn_counter_ivory:          'dovecote',
  furn_counter_open_shelf:     'oakhouse',
  furn_counter_sage:           'meadow',
  furn_counter_two_tone:       'oakhouse',
  furn_desk_caramel:           'oakhouse',
  furn_desk_charcoal:          'quarry',
  furn_desk_ivory:             'dovecote',
  furn_desk_sage:              'meadow',
  furn_desk_two_tone:          'oakhouse',
  furn_dining_table_caramel:   'oakhouse',
  furn_dining_table_charcoal:  'quarry',
  furn_dining_table_ivory:     'dovecote',
  furn_dining_table_sage:      'meadow',
  furn_dining_table_trestle:   'oakhouse',
  furn_dining_table_two_tone:  'oakhouse',
  furn_dresser_caramel:        'oakhouse',
  furn_dresser_charcoal:       'quarry',
  furn_dresser_ivory:          'dovecote',
  furn_dresser_sage:           'meadow',
  furn_dresser_two_tone:       'oakhouse',
  furn_fridge_butter:          'dovecote',
  furn_fridge_charcoal:        'quarry',
  furn_fridge_mint:            'meadow',
  furn_fridge_retro:           'oakhouse',
  furn_fridge_terracotta:      'oakhouse',
  furn_fridge_two_tone:        'oakhouse',
  furn_shower_charcoal:        'quarry',
  furn_shower_glass:           'oakhouse',
  furn_shower_sage:            'meadow',
  furn_shower_sand:            'dovecote',
  furn_shower_slate:           'quarry',
  furn_shower_two_tone:        'oakhouse',
  furn_sink_caramel:           'oakhouse',
  furn_sink_charcoal:          'quarry',
  furn_sink_farmhouse:         'oakhouse',
  furn_sink_sage:              'meadow',
  furn_sink_stone:             'quarry',
  furn_sink_two_tone:          'oakhouse',
  furn_bed_single_caramel:     'oakhouse',
  furn_bed_single_charcoal:    'quarry',
  furn_bed_single_ivory:       'dovecote',
  furn_bed_single_sage:        'meadow',
  furn_bed_single_two_tone:    'oakhouse',
  furn_bed_single_race_car:    'oakhouse',
  furn_bench_caramel:          'oakhouse',
  furn_bench_charcoal:         'quarry',
  furn_bench_ivory:            'dovecote',
  furn_bench_sage:             'meadow',
  furn_bench_two_tone:         'oakhouse',
  furn_cabinet_caramel:        'oakhouse',
  furn_cabinet_charcoal:       'quarry',
  furn_cabinet_ivory:          'dovecote',
  furn_cabinet_sage:           'meadow',
  furn_cabinet_two_tone:       'oakhouse',
  furn_dining_chair_caramel:   'oakhouse',
  furn_dining_chair_charcoal:  'quarry',
  furn_dining_chair_ivory:     'dovecote',
  furn_dining_chair_sage:      'meadow',
  furn_dryer_butter:           'dovecote',
  furn_dryer_mint:             'meadow',
  furn_dryer_slate:            'quarry',
  furn_dryer_terracotta:       'oakhouse',
  furn_dryer_two_tone:         'oakhouse',
  furn_microwave_butter:       'dovecote',
  furn_microwave_mint:         'meadow',
  furn_microwave_slate:        'quarry',
  furn_microwave_terracotta:   'oakhouse',
  furn_microwave_two_tone:     'oakhouse',
  furn_nightstand_caramel:     'oakhouse',
  furn_nightstand_charcoal:    'quarry',
  furn_nightstand_ivory:       'dovecote',
  furn_nightstand_sage:        'meadow',
  furn_nightstand_two_tone:    'oakhouse',
  furn_office_chair_caramel:   'oakhouse',
  furn_office_chair_charcoal:  'quarry',
  furn_office_chair_ivory:     'dovecote',
  furn_office_chair_sage:      'meadow',
  furn_office_chair_two_tone:  'oakhouse',
  furn_side_table_caramel:     'oakhouse',
  furn_side_table_charcoal:    'quarry',
  furn_side_table_ivory:       'dovecote',
  furn_side_table_sage:        'meadow',
  furn_side_table_two_tone:    'oakhouse',
  furn_stool_caramel:          'oakhouse',
  furn_stool_charcoal:         'quarry',
  furn_stool_ivory:            'dovecote',
  furn_stool_sage:             'meadow',
  furn_stool_two_tone:         'oakhouse',
  furn_wardrobe_caramel:       'oakhouse',
  furn_wardrobe_charcoal:      'quarry',
  furn_wardrobe_ivory:         'dovecote',
  furn_wardrobe_sage:          'meadow',
  furn_wardrobe_two_tone:      'oakhouse',
  furn_washer_butter:          'dovecote',
  furn_washer_mint:            'meadow',
  furn_washer_slate:           'quarry',
  furn_washer_terracotta:      'oakhouse',
  furn_washer_two_tone:        'oakhouse',
  furn_bed_double_caramel:     'oakhouse',
  furn_bed_double_charcoal:    'quarry',
  furn_bed_double_four_poster: 'oakhouse',
  furn_bed_double_ivory:       'dovecote',
  furn_bed_double_sage:        'meadow',
  furn_bed_double_two_tone:    'oakhouse',
  furn_bed_double_race_car:    'oakhouse',
  furn_lamp_charcoal:          'quarry',
  furn_lamp_ivory:             'dovecote',
  furn_lamp_lantern:           'oakhouse',
  furn_lamp_sage:              'meadow',
  furn_lamp_two_tone:          'oakhouse',
  furn_lamp_walnut:            'oakhouse',
  furn_stove_hood_caramel:     'oakhouse',
  furn_stove_hood_charcoal:    'quarry',
  furn_stove_hood_ivory:       'dovecote',
  furn_stove_hood_range:       'oakhouse',
  furn_stove_hood_sage:        'meadow',
  furn_stove_hood_two_tone:    'oakhouse',
};

export const FAMILY_NEUTRAL_GENERATED: string[] = [
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
