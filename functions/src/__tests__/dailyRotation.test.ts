// functions/src/__tests__/dailyRotation.test.ts
//
// Build-time guards on the day-one rotation model (W3-08). Pure — no Firestore
// mock, because everything here is a property of the bundled constants and a
// pure function. The callable-level behaviour lives in purchaseChest.test.ts.
//
// KEY: The point of this file is that a tier or a subject with no content must be
// UNREACHABLE, not merely absent. Four rarity vocabularies coexisted before
// W3-08 and the mismatch was invisible precisely because nothing asserted that
// what the roller emits and what the pool holds are the same set.

import * as fs from 'fs';
import * as path from 'path';

import {
  RARITIES,
  DROP_TABLES,
  DROP_TABLE_TIERS,
  CHEST_CATEGORY_DROP_TABLE,
  CHEST_PRICE,
  DAILY_SUBJECT_POOLS,
  DUPLICATE_REFUNDS,
  BENCHED_SUBJECTS,
  SEED_ITEMS,
  STYLE_FAMILIES,
  ITEM_FAMILY,
  FAMILY_NEUTRAL,
  RETIRED_VOCABULARY,
  rollRarity,
  subjectForDay,
} from '../itemPool';

const ROLLS = 4000;

describe('the rarity vocabulary is exactly three tiers', () => {
  test('rollRarity never emits a tier outside RARITIES — in particular never "epic"', () => {
    const emitted = new Set<string>();
    for (const tier of DROP_TABLE_TIERS) {
      for (let i = 0; i < ROLLS; i++) emitted.add(rollRarity(tier));
    }
    // Sanity: the loop must actually reach both ends, or it proves nothing.
    expect(emitted.has('common')).toBe(true);
    expect(emitted.has('legendary')).toBe(true);

    expect(emitted.has('epic')).toBe(false);
    expect([...emitted].sort()).toEqual([...RARITIES].sort());
  });

  test('no bundled item carries a retired tier', () => {
    for (const item of SEED_ITEMS) {
      expect(RARITIES).toContain(item.rarity);
    }
  });

  // CRITICAL: RE-DERIVED IN W2-161, NOT PATCHED. This asserted
  //
  //     expect(Object.keys(DUPLICATE_REFUNDS).sort()).toEqual([...RARITIES].sort());
  //
  // and it was right until the refund stopped being a function of rarity. A
  // refund keyed on rarity cannot express "75% of what the chest cost", because
  // rarity is what the chest ROLLED and price is what the player PAID: the old
  // table paid a flat 100 for a legendary out of a 500-sponge characters chest
  // AND out of a 100-sponge furniture one. The table is now keyed by CATEGORY,
  // so the population this test guards is CHEST_PRICE's keys — and it still
  // guards the same property, that the table covers its whole population and
  // nothing beyond it.
  test('the refund table covers every priced category and nothing else', () => {
    expect(Object.keys(DUPLICATE_REFUNDS).sort()).toEqual(Object.keys(CHEST_PRICE).sort());
  });

  test('the refund table is no longer keyed by rarity — the old shape must not come back', () => {
    // Belt and braces on the re-key: a table that answers to a rarity is the
    // bug this change removed, and `Record<string, number>` would let it back in
    // silently because every key type-checks.
    for (const rarity of RARITIES) {
      expect(DUPLICATE_REFUNDS[rarity]).toBeUndefined();
    }
  });

  test('an unknown drop table falls back to a covered one rather than dead-ending', () => {
    const emitted = new Set<string>();
    for (let i = 0; i < ROLLS; i++) emitted.add(rollRarity('no_such_table'));
    for (const rarity of emitted) {
      expect(SEED_ITEMS.filter((i) => i.rarity === rarity).length).toBeGreaterThan(0);
    }
  });
});

describe('chest types are ordered characters > styles > furniture', () => {
  // Part C of spec-2026-08-05-device-review-and-chest-rotation.md:
  //   characters = RAREST, styles = middle, furniture = MOST COMMON.
  // Before W3-08 this was inverted — the Styles chest rolled the most generous
  // table and the Characters chest the least — because one field was both the
  // chest's display tier and the drop-table key.

  /** P(legendary) for a table = 1 - its second cumulative threshold. */
  const pLegendary = (tier: keyof typeof DROP_TABLES) => 1 - DROP_TABLES[tier][1];

  test('a rarer chest type rolls a strictly more generous table', () => {
    const characters = pLegendary(CHEST_CATEGORY_DROP_TABLE.characters);
    const styles = pLegendary(CHEST_CATEGORY_DROP_TABLE.styles);
    const furniture = pLegendary(CHEST_CATEGORY_DROP_TABLE.furniture);

    expect(characters).toBeGreaterThan(styles);
    expect(styles).toBeGreaterThan(furniture);
  });

  test('every drop table is a valid ascending cumulative distribution', () => {
    for (const tier of DROP_TABLE_TIERS) {
      const [pCommon, pUpToRare] = DROP_TABLES[tier];
      expect(pCommon).toBeGreaterThan(0);
      expect(pUpToRare).toBeGreaterThan(pCommon);
      expect(pUpToRare).toBeLessThan(1);
    }
  });

  test('every chest category maps to a real drop table', () => {
    for (const [category, tier] of Object.entries(CHEST_CATEGORY_DROP_TABLE)) {
      expect(DAILY_SUBJECT_POOLS[category]).toBeDefined();
      expect(DROP_TABLE_TIERS).toContain(tier);
    }
  });
});

describe("the day's subject is deterministic and always stocked", () => {
  const DAYS = ['20260805', '20260806', '20260807', '20260101', '20261231'];

  test('subjectForDay is a pure function of the date', () => {
    for (const day of DAYS) {
      for (const category of Object.keys(DAILY_SUBJECT_POOLS)) {
        expect(subjectForDay(category, day)).toBe(subjectForDay(category, day));
      }
    }
  });

  test('subjectForDay only ever returns a subject from that category pool', () => {
    for (const day of DAYS) {
      for (const [category, pool] of Object.entries(DAILY_SUBJECT_POOLS)) {
        expect(pool).toContain(subjectForDay(category, day));
      }
    }
  });

  test('an unknown category yields the empty subject, which means "any"', () => {
    // Empty is the back-compat path for a chest row written before W3-08.
    // It must not throw and must not invent a subject.
    expect(subjectForDay('no_such_category', '20260805')).toBe('');
  });

  test('every subject a chest can be themed on is stocked at EVERY rarity', () => {
    // This is the invariant that makes the not-found throw in pickChestItem
    // unreachable. A subject stocked at common and rare but not legendary
    // hard-fails a purchase the moment the tail of the table is hit — which
    // for the characters chest is 20% of the time.
    const missing: string[] = [];
    for (const [category, pool] of Object.entries(DAILY_SUBJECT_POOLS)) {
      for (const subject of pool) {
        for (const rarity of RARITIES) {
          const stocked = SEED_ITEMS.filter(
            (i) => i.subject === subject && i.rarity === rarity,
          );
          if (stocked.length === 0) {
            missing.push(`${category}/${subject} has no ${rarity}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('every bundled item declares a subject that is either drawable or benched', () => {
    const drawable = new Set(Object.values(DAILY_SUBJECT_POOLS).flat());
    for (const item of SEED_ITEMS) {
      expect(typeof item.subject).toBe('string');
      expect(item.subject.length).toBeGreaterThan(0);
      const known =
        drawable.has(item.subject) || item.subject in BENCHED_SUBJECTS;
      expect(known ? '' : `${item.id} has unknown subject "${item.subject}"`).toBe('');
    }
  });

  test('the benched ledger is exact in both directions', () => {
    // Forward: nothing is benched and drawable at once — that would be a
    // reason recorded for a subject that is in fact live.
    const drawable = new Set(Object.values(DAILY_SUBJECT_POOLS).flat());
    for (const subject of Object.keys(BENCHED_SUBJECTS)) {
      expect(drawable.has(subject)).toBe(false);
    }

    // Reverse: every authored subject is accounted for by exactly one of the
    // two lists. This is the half that catches a subject quietly dropped from
    // a pool without a reason being written down.
    const authored = new Set(SEED_ITEMS.map((i) => i.subject));
    const accounted = new Set([...drawable, ...Object.keys(BENCHED_SUBJECTS)]);
    expect([...authored].filter((s) => !accounted.has(s))).toEqual([]);
    expect([...accounted].filter((s) => !authored.has(s))).toEqual([]);
  });

  test('every benched subject carries a non-empty reason', () => {
    for (const [subject, reason] of Object.entries(BENCHED_SUBJECTS)) {
      expect(`${subject}: ${reason.trim().length > 0}`).toBe(`${subject}: true`);
    }
  });

  // --- fox outfits (W3-09) -------------------------------------------------

  // NOTE: A general "every drawable subject has art" test was tried here and
  // removed. Subject names are not filename stems: `fox_outfit`'s art ships as
  // `char_fox_<slug>.png`, so a substring sweep reports it artless, while
  // `character` — five glyph-only profession rows with no art at all —
  // incidentally matches an unrelated path and passes. It was wrong in both
  // directions, which is worse than absent. What is asserted instead is the one
  // subject whose absence is unambiguous, plus reachability per category.

  test('roof is benched', () => {
    expect(Object.keys(BENCHED_SUBJECTS)).toContain('roof');
    for (const pool of Object.values(DAILY_SUBJECT_POOLS)) {
      expect(pool).not.toContain('roof');
    }
  });

  // The art tree is not part of this extract. A premise that cannot be read did
  // not fail -- and it did not pass either. Skip loudly rather than let an
  // absent directory read as "no roof art exists": a gate cannot promote
  // "cannot find" into "does not exist" (the same refusal as the asset
  // pipeline's verify_no_getbbox_diff.py, which will not report clean on zero
  // files scanned).
  const repoRoot = path.resolve(__dirname, '../../..');
  const assetsDir = path.join(repoRoot, 'assets');
  const hasAssets = fs.existsSync(assetsDir);
  (hasAssets ? test : test.skip)(
    'the reason roof is benched still holds: no roof art exists under assets/',
    () => {
      // The bench reason is "no art exists". Verify the premise rather than
      // trusting the comment — unbenching without baking would put the invisible
      // prize straight back into rotation.
      const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
          const full = path.join(dir, e.name);
          return e.isDirectory() ? walk(full) : [full];
        });
      const roofArt = walk(assetsDir).filter((p) =>
        path.basename(p).toLowerCase().includes('roof'),
      );
      expect(roofArt).toEqual([]);
    },
  );

  test('the styles chest actually reaches its subject', () => {
    // The mirror of the characters test below. There was NO reachability test
    // for styles or furniture — only for characters — and that gap is exactly
    // why a subject with no art sat in the styles pool unnoticed.
    const pool = DAILY_SUBJECT_POOLS.styles;
    expect(pool.length).toBeGreaterThan(0);

    const seen = new Set(DAYS.map((d) => subjectForDay('styles', d)));
    expect([...seen].sort()).toEqual([...pool].sort());

    // And every subject it can reach is stocked at all three rarities.
    for (const subject of seen) {
      for (const rarity of RARITIES) {
        const stocked = SEED_ITEMS.filter(
          (i) => i.subject === subject && i.rarity === rarity,
        );
        expect(`${subject}/${rarity}: ${stocked.length > 0}`).toBe(
          `${subject}/${rarity}: true`,
        );
      }
    }
  });

  test('the furniture chest actually reaches its subject', () => {
    const pool = DAILY_SUBJECT_POOLS.furniture;
    expect(pool.length).toBeGreaterThan(0);
    const seen = new Set(DAYS.map((d) => subjectForDay('furniture', d)));
    expect([...seen].sort()).toEqual([...pool].sort());
  });

  test('a given date selects a specific furniture subject — the pool ORDER is live behaviour', () => {
    // KEY: WHY THIS EXISTS AND THE TEST ABOVE IS NOT ENOUGH. Every other
    // assertion in this file reads the pool as a SET: the reachability test
    // above sorts both sides before comparing, the bench ledger builds a Set,
    // and the stocking sweep iterates without caring about position. So all of
    // them are invariant under a REORDERING of DAILY_SUBJECT_POOLS.furniture —
    // and a reordering is not cosmetic. `subjectForDay` is
    // `pool[dayNumber % pool.length]`, so moving an entry changes which chest
    // every player in the world is offered on a given day, while the whole
    // suite stays green.
    //
    // These pairs are computed from that formula, not guessed: 20260806 % 3 is
    // 0, 20260807 % 3 is 1, 20260805 % 3 is 2. They pin all three slots, so no
    // permutation of the pool survives them.
    const BY_DATE: Array<[string, string]> = [
      ['20260806', 'sofa'],     // index 0
      ['20260807', 'armchair'], // index 1
      ['20260805', 'tv_stand'], // index 2
    ];
    for (const [date, subject] of BY_DATE) {
      expect(`${date} -> ${subjectForDay('furniture', date)}`).toBe(
        `${date} -> ${subject}`,
      );
    }
  });

  test('the furniture pool gives every piece a turn, one day in three', () => {
    // Brendan's ruling, 2026-08-19: "sofa finishes show up less often, but
    // every piece gets a turn." This is the assertion that records it as a
    // decision rather than an accident — sofa's DROP in frequency is the
    // intended outcome of W2-130, so a future window that "fixes" sofa by
    // trimming the pool should have to delete a test that says the ruling out
    // loud, not quietly restore a number.
    expect(DAILY_SUBJECT_POOLS.furniture).toEqual([
      'sofa',
      'armchair',
      'tv_stand',
    ]);

    // Over a full 3-day cycle each subject is selected exactly once. Consecutive
    // dates are used deliberately: dayNumber increments by 1 per day, so this
    // walks the modulus through every residue.
    const cycle = ['20260806', '20260807', '20260808'].map((d) =>
      subjectForDay('furniture', d),
    );
    expect([...cycle].sort()).toEqual(['armchair', 'sofa', 'tv_stand']);

    // And each of the three is stocked at every rarity, which is the condition
    // the ruling did NOT waive.
    for (const subject of DAILY_SUBJECT_POOLS.furniture) {
      for (const rarity of RARITIES) {
        const stocked = SEED_ITEMS.filter(
          (i) => i.subject === subject && i.rarity === rarity,
        );
        expect(`${subject}/${rarity}: ${stocked.length > 0}`).toBe(
          `${subject}/${rarity}: true`,
        );
      }
    }
  });

  test('armchair and tv_stand are unbenched — the ledger no longer names them', () => {
    // The mirror of the roof test above. The bench ledger is asserted exact in
    // both directions, but "exact" is symmetric: it cannot tell you WHICH side
    // a subject is supposed to be on. This names the intended side.
    expect(Object.keys(BENCHED_SUBJECTS)).not.toContain('armchair');
    expect(Object.keys(BENCHED_SUBJECTS)).not.toContain('tv_stand');
    expect(DAILY_SUBJECT_POOLS.furniture).toContain('armchair');
    expect(DAILY_SUBJECT_POOLS.furniture).toContain('tv_stand');

    // The three that stay benched, and are not collateral of this change.
    for (const still of ['lamp', 'bunk_bed', 'wall', 'roof']) {
      expect(`${still} benched: ${still in BENCHED_SUBJECTS}`).toBe(
        `${still} benched: true`,
      );
    }
  });

  test('the characters chest actually reaches BOTH of its subjects', () => {
    // The coverage test above proves fox_outfit is STOCKED; it does not prove
    // it is REACHABLE. subjectForDay is `pool[dayNumber % pool.length]`, so a
    // subject appended to a pool whose rotation never advances would be
    // stocked, benched-free, and still never drawn — invisible to every other
    // assertion in this file.
    const seen = new Set(DAYS.map((d) => subjectForDay('characters', d)));
    expect([...seen].sort()).toEqual(['character', 'fox_outfit']);
  });

  test('fox outfit ids are prefixed, unique, and match their subject', () => {
    // The id prefix is load-bearing beyond tidiness: the Dart side derives the
    // avatar asset path from it (`char_fox_<slug>` -> `fox_<slug>.webp`), so an
    // id that does not carry the prefix ships a skin whose art cannot resolve.
    const fox = SEED_ITEMS.filter((i) => i.subject === 'fox_outfit');
    expect(fox.length).toBe(11);
    for (const item of fox) {
      expect(`${item.id} prefixed`).toBe(
        `${item.id.startsWith('char_fox_') ? item.id : 'BAD'} prefixed`,
      );
      expect(item.type).toBe('character');
      expect(item.category).toBe('character');
    }
    expect(new Set(fox.map((i) => i.id)).size).toBe(fox.length);
  });

  test('the golden suit is RARE — the legendary tier is silhouette-only', () => {
    // decisions-2026-08-05-legendary-tier.md: a legendary must change the
    // OUTLINE. Rendered per Style B with no metal and no aura, the golden suit
    // is the black suit in a warmer colour and its silhouette is identical, so
    // it was deliberately dropped a tier. Pinned because the obvious "fix" for
    // a rare-heavy ladder is to promote it back, which would silently reinstate
    // a legendary that does not read as one.
    const byId = Object.fromEntries(SEED_ITEMS.map((i) => [i.id, i]));
    expect(byId['char_fox_golden_suit'].rarity).toBe('rare');

    // And the tier it left behind is still carried by the two that DO change
    // the outline — a helmet and a shower cap. If either is ever retired the
    // cell empties and pickChestItem throws not-found on a purchase.
    const legendary = SEED_ITEMS.filter(
      (i) => i.subject === 'fox_outfit' && i.rarity === 'legendary',
    ).map((i) => i.id).sort();
    expect(legendary).toEqual(['char_fox_bubble_bath', 'char_fox_space_suit']);
  });
});

// ---------------------------------------------------------------------------
// Style families (W2-09)
// ---------------------------------------------------------------------------
//
// Same shape, and for the same reason, as `the benched ledger is exact in both
// directions` above: family is a LEDGER beside the seed list, never a field on
// SeedItem and never a filter in pickChestItem. A ledger is only worth having
// if it is asserted in BOTH directions — otherwise a row can be assigned
// silently, or typo'd into existence, and nothing goes red.
//
// KEY: Family is deliberately NOT a drop key. pickChestItem filters on
// (subject, rarity) and picks uniformly; adding family would turn the mandatory
// coverage grid from 3 x 3 = 9 cells into 3 x 3 x 4 = 36, and an empty cell
// throws not-found on a purchase the player can see and afford. Nothing in this
// block reads DAILY_SUBJECT_POOLS or the items query, and that is the point.

describe('the style-family ledger is exact in both directions', () => {
  const seedIds = new Set(SEED_ITEMS.map((i) => i.id));
  const familyKeys = new Set(Object.keys(STYLE_FAMILIES));

  // Stated, not derived. These are the counts the wiki page tallies
  // (Oakhouse 9 + Quarry 7 + Dovecote 6 + Meadow 4 = 26, NEUTRAL 14, sum 40).
  // 26 -> 38 when W1-142 wired the twelve armchair/tv_stand finishes (W3-117,
  // #547). Every one of the twelve carries a family, so NEUTRAL is untouched
  // and the sum moves 40 -> 52 with SEED_ITEMS.
  // NEUTRAL went 13 -> 14 when char_pyjama joined SEED_ITEMS; the assigned
  // count is untouched because sleepwear is family-neutral by decision.
  // A derived count would agree with itself no matter how far the ledger had
  // drifted from SEED_ITEMS — the same reasoning collection_seed_resolve_test
  // records for the Dart mirror counts.
  const EXPECTED_FAMILIES = 4;
  // 38 -> 101 (W1-162): sixty-three furniture finish rows that were baked and
  // unreachable. Every one carries a family, so EXPECTED_NEUTRAL is unmoved.
  // 101 -> 160 (W2-159): fifty-nine more, the finish ladders of twelve props.
  // Every one carries a family too — the family is DERIVED from the finish
  // token against the committed rows (caramel->oakhouse, charcoal->quarry,
  // ivory->dovecote, sage->meadow, two_tone->oakhouse, butter->dovecote,
  // mint->meadow, slate->quarry, terracotta->oakhouse), where each token maps
  // to exactly one family across all 86 prior furniture rows with zero
  // conflicts. So EXPECTED_NEUTRAL is unmoved again, and the sum tracks
  // SEED_ITEMS at 174.
  // 160 -> 178 (W2-160): the last three finish ladders, 18 rows, every one with a
  // family. The six lamp rows join the EXISTING `lamp` subject rather than opening a
  // new one, so the subject count moves by two while the assigned count moves by 18.
  // 178 -> 180 (W1-201): the two race-car beds, the last finish-ladder sprites on
  // disk that no seed row reached. Both carry a family, so EXPECTED_NEUTRAL is
  // unmoved a fourth time and the sum tracks SEED_ITEMS at 194. WARNING: Their family
  // (oakhouse) is PROVISIONAL pending Brendan — see the note on the two rows in
  // functions/seed/collection_seed.json. If it changes, this count does not.
  const EXPECTED_ASSIGNED = 180;
  const EXPECTED_NEUTRAL = 14;

  test('the ledger is the size the design page tallies', () => {
    expect(Object.keys(STYLE_FAMILIES).length).toBe(EXPECTED_FAMILIES);
    expect(Object.keys(ITEM_FAMILY).length).toBe(EXPECTED_ASSIGNED);
    expect(FAMILY_NEUTRAL.length).toBe(EXPECTED_NEUTRAL);
    expect(EXPECTED_ASSIGNED + EXPECTED_NEUTRAL).toBe(SEED_ITEMS.length);
  });

  test('1 — every ITEM_FAMILY key is a real SEED_ITEMS id', () => {
    // Catches a typo'd or renamed id. Edit functions/src/itemPool.ts ITEM_FAMILY.
    const ghosts = Object.keys(ITEM_FAMILY).filter((id) => !seedIds.has(id));
    expect(ghosts).toEqual([]);
  });

  test('2 — every FAMILY_NEUTRAL entry is a real SEED_ITEMS id', () => {
    // Edit functions/src/itemPool.ts FAMILY_NEUTRAL.
    const ghosts = FAMILY_NEUTRAL.filter((id) => !seedIds.has(id));
    expect(ghosts).toEqual([]);
  });

  test('3 — every ITEM_FAMILY value is a real STYLE_FAMILIES key', () => {
    // Catches an assignment to a family that was renamed or never declared.
    const dangling = Object.entries(ITEM_FAMILY)
      .filter(([, family]) => !familyKeys.has(family))
      .map(([id, family]) => `${id} -> "${family}"`);
    expect(dangling).toEqual([]);
  });

  test('4 — every seed id is in exactly one of ITEM_FAMILY or FAMILY_NEUTRAL', () => {
    // The half that catches a NEW seed row landing with no family decision
    // taken. Neutral is a decision and FAMILY_NEUTRAL is where it is recorded,
    // so "not yet decided" must be impossible to express.
    const assigned = new Set(Object.keys(ITEM_FAMILY));
    const neutral = new Set(FAMILY_NEUTRAL);
    const undecided = SEED_ITEMS
      .map((i) => i.id)
      .filter((id) => !assigned.has(id) && !neutral.has(id));
    expect(undecided).toEqual([]);
  });

  test('5 — nothing is both assigned and neutral', () => {
    const neutral = new Set(FAMILY_NEUTRAL);
    const both = Object.keys(ITEM_FAMILY).filter((id) => neutral.has(id));
    expect(both).toEqual([]);
  });

  test('every declared family actually carries at least one row', () => {
    // The reverse of assertion 3: a family declared with no members is a
    // vocabulary entry nothing can reach, which is how `epic` survived.
    const used = new Set(Object.values(ITEM_FAMILY));
    const empty = Object.keys(STYLE_FAMILIES).filter((k) => !used.has(k));
    expect(empty).toEqual([]);
  });

  test('FAMILY_NEUTRAL has no duplicates', () => {
    expect(FAMILY_NEUTRAL.length).toBe(new Set(FAMILY_NEUTRAL).size);
  });
});

describe('a family brief cannot speak retired vocabulary or its own name', () => {
  test('the retired words are forbidden in EVERY family, from one shared const', () => {
    // `claymation` / `clay` / `plasticine` are retired repo-wide (user directive
    // 2026-08-02) and `low-poly` / `faceted` are the same failure recorded at
    // cleaning-app-art-direction.md:56 — generative-model triggers producing a
    // texture and gloss this library does not have.
    //
    // WARNING: This asserts the CONST, not the repo. `lighting='clay'` and
    // `add_clay_box` in 3d-source/ are internal Blender identifiers that never
    // reach a prompt, and nothing here greps for them.
    expect(RETIRED_VOCABULARY).toEqual(
      expect.arrayContaining(['claymation', 'clay', 'plasticine', 'low-poly']),
    );

    const gaps: string[] = [];
    for (const [key, family] of Object.entries(STYLE_FAMILIES)) {
      for (const word of RETIRED_VOCABULARY) {
        if (!family.forbidden.prompt.includes(word)) {
          gaps.push(`${key}.forbidden.prompt is missing "${word}"`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  test('the family name is never prompt text — Global Rule 1', () => {
    // The family name is a grain/weave/surface trigger and Style A is
    // untextured. Author from the HEXES.
    const gaps: string[] = [];
    for (const [key, family] of Object.entries(STYLE_FAMILIES)) {
      const spoken = family.forbidden.prompt.map((w) => w.toLowerCase());
      if (!spoken.includes(key.toLowerCase())) {
        gaps.push(`${key}.forbidden.prompt does not forbid its own name`);
      }
    }
    expect(gaps).toEqual([]);
  });

  test('every family declares all five forbidden levels, non-empty', () => {
    const gaps: string[] = [];
    for (const [key, family] of Object.entries(STYLE_FAMILIES)) {
      // Enumerated rather than indexed by a string so the compiler checks the
      // level names too — a renamed field fails to build, not just to run.
      const levels: Array<[string, string[]]> = [
        ['prompt', family.forbidden.prompt],
        ['palette', family.forbidden.palette],
        ['material', family.forbidden.material],
        ['silhouette', family.forbidden.silhouette],
        ['crossFamily', family.forbidden.crossFamily],
      ];
      for (const [level, list] of levels) {
        if (!Array.isArray(list) || list.length === 0) {
          gaps.push(`${key}.forbidden.${level} is missing or empty`);
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  test('every family carries an anchor hex and a binary base line', () => {
    // The two fields the Dart album mirror will need — a key, a label and a
    // colour. Base line is BINARY (Global Rule 4): on a 4-8 px feature you get
    // gapped or grounded and nothing finer.
    const gaps: string[] = [];
    for (const [key, family] of Object.entries(STYLE_FAMILIES)) {
      const anchor = family.palette.anchor;
      if (typeof anchor !== 'string' || !/^#[0-9A-F]{6}$/.test(anchor)) {
        gaps.push(`${key}.palette.anchor is not an uppercase #RRGGBB hex`);
      }
      const baseLine = family.silhouette.baseLine;
      if (baseLine !== 'gapped' && baseLine !== 'grounded') {
        gaps.push(`${key}.silhouette.baseLine is not gapped|grounded`);
      }
    }
    expect(gaps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cross-mirror gate — SEED_ITEMS (TS) vs kCollectionSeed (Dart)
// ---------------------------------------------------------------------------
//
// CRITICAL: THE HAZARD THIS CLOSES. `SEED_ITEMS` and `kCollectionSeed` are
// hand-maintained 39-row mirrors in two languages with NOTHING cross-checking
// them. collection_seed.dart:1-2 says so outright — "SYNC:
// functions/src/itemPool.ts SEED_ITEMS / Keep this list in sync manually".
// They agree today by discipline, not by gate.
//
// Precedent for a source-level assertion like this is already shipped:
// test/orientation_lock_test.dart:44 reads ios/Runner/Info.plist off disk, and
// test/core/services/fcm_service_test.dart:363 reads a Dart source file and
// calls itself "the cheapest thing that actually fails if someone moves the
// prompt back". This is the jest-side equivalent.
//
// NOTE: Deviation from the brief, deliberate: the brief specified regexing ids out
// of BOTH files. From jest the TypeScript side can simply be IMPORTED, which is
// strictly stronger than parsing it — a rename that breaks the import fails to
// compile rather than silently parsing to an empty set. Only the Dart side is
// parsed. The Dart-side test that must parse both is still owed (see below).

describe('the Dart mirror has not drifted from SEED_ITEMS', () => {
  const DART_MIRROR = 'lib/features/customization/domain/collection_seed.dart';
  const KCOLLECTION_SEED_ANCHOR = 'const List<SeedItem> kCollectionSeed = [';

  const readDartMirror = (): string =>
    fs.readFileSync(
      path.join(path.resolve(__dirname, '../../..'), DART_MIRROR),
      'utf8',
    );

  /** Ids inside ONE named Dart declaration — anchored, never a whole-file sweep,
   *  so an unrelated const added later cannot silently join the set. */
  const idsInDeclaration = (source: string, anchor: string): string[] => {
    const start = source.indexOf(anchor);
    expect(`"${anchor}" found in ${DART_MIRROR}: ${start >= 0}`).toBe(
      `"${anchor}" found in ${DART_MIRROR}: true`,
    );
    const end = source.indexOf('\n];', start);
    expect(`terminator "\\n];" found after the anchor: ${end > start}`).toBe(
      'terminator "\\n];" found after the anchor: true',
    );

    const ids: string[] = [];
    const re = /id: '([^']+)'/g;
    let match: RegExpExecArray | null;
    const slice = source.slice(start, end);
    while ((match = re.exec(slice)) !== null) ids.push(match[1]);
    return ids;
  };

  test('the parse itself found a plausible number of rows', () => {
    // A regex that silently matches nothing would make every assertion below
    // vacuously pass. Prove the parser worked before trusting what it returned.
    const ids = idsInDeclaration(readDartMirror(), KCOLLECTION_SEED_ANCHOR);
    expect(ids.length).toBe(SEED_ITEMS.length);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every SEED_ITEMS id is in kCollectionSeed, and vice versa', () => {
    const dartIds = new Set(
      idsInDeclaration(readDartMirror(), KCOLLECTION_SEED_ANCHOR),
    );
    const tsIds = new Set(SEED_ITEMS.map((i) => i.id));

    // Forward: the backend authored a row the client cannot show.
    const missingFromDart = [...tsIds].filter((id) => !dartIds.has(id)).sort();
    expect(
      `add these to ${DART_MIRROR}: ${JSON.stringify(missingFromDart)}`,
    ).toBe(`add these to ${DART_MIRROR}: []`);

    // Reverse: the client offers a row the backend can never grant.
    const missingFromTs = [...dartIds].filter((id) => !tsIds.has(id)).sort();
    expect(
      `add these to functions/src/itemPool.ts SEED_ITEMS: ${JSON.stringify(missingFromTs)}`,
    ).toBe('add these to functions/src/itemPool.ts SEED_ITEMS: []');
  });

  // The pinning test that used to sit here ('WARNING: the Dart family mirror is OWED')
  // asserted this file contained NEITHER kItemFamily NOR kFamilyNeutral, so
  // that writing the Dart mirror would turn it red rather than let the handoff
  // be silently dropped. It fired on 2026-08-08 and was replaced by the three
  // tests below, which are what it asked for: ids both ways, values both ways,
  // and the neutral list both ways.

  /** Drop `//` comment tails before matching quoted strings.
   *
 * CRITICAL: W2-48. Without this the parsers below match quoted text inside COMMENTS
   * as if it were a list entry. It was not hypothetical: #256 added the note
   * "char_gardener is the only character row with a family ('meadow')" inside
   * kFamilyNeutral, and `'meadow'` was counted as a 15th neutral id. The parse
   * guard then compared 15 against FAMILY_NEUTRAL's 13 and dailyRotation.test
   * went RED ON MAIN — verified by running it against an untouched checkout:
   * `Expected: 13, Received: 15`.
   *
 * WARNING: The guard was doing its job; it just could not distinguish "the mirror
   * drifted" from "someone wrote a quote in a comment", and it reports both as
   * drift. A prose edit could redden a backend suite, which is the surprising
   * part and the reason this is stripped rather than worked around.
   *
   * Line comments only. Dart doc comments (`///`) start with `//` so they go
   * too, and no declaration in the mirror puts an id inside a block comment.
   */
  const stripComments = (s: string): string =>
    s.replace(/\/\/[^\n]*/g, '');

  /** `key: 'value',` pairs inside ONE named Dart map declaration. Same anchored
   *  approach as idsInDeclaration — never a whole-file sweep. */
  const pairsInMap = (
    source: string,
    anchor: string,
  ): Record<string, string> => {
    const start = source.indexOf(anchor);
    expect(`"${anchor}" found in ${DART_MIRROR}: ${start >= 0}`).toBe(
      `"${anchor}" found in ${DART_MIRROR}: true`,
    );
    const end = source.indexOf('\n};', start);
    expect(`terminator "\\n};" found after the anchor: ${end > start}`).toBe(
      'terminator "\\n};" found after the anchor: true',
    );

    const out: Record<string, string> = {};
    const re = /'([^']+)':\s*'([^']+)'/g;
    let match: RegExpExecArray | null;
    const slice = stripComments(source.slice(start + anchor.length, end));
    while ((match = re.exec(slice)) !== null) out[match[1]] = match[2];
    return out;
  };

  /** Bare `'value',` entries inside ONE named Dart list declaration. */
  const entriesInList = (source: string, anchor: string): string[] => {
    const start = source.indexOf(anchor);
    expect(`"${anchor}" found in ${DART_MIRROR}: ${start >= 0}`).toBe(
      `"${anchor}" found in ${DART_MIRROR}: true`,
    );
    const end = source.indexOf('\n];', start);
    expect(`terminator "\\n];" found after the anchor: ${end > start}`).toBe(
      'terminator "\\n];" found after the anchor: true',
    );

    const out: string[] = [];
    const re = /'([^']+)'/g;
    let match: RegExpExecArray | null;
    const slice = stripComments(source.slice(start + anchor.length, end));
    while ((match = re.exec(slice)) !== null) out.push(match[1]);
    return out;
  };

  const K_ITEM_FAMILY_ANCHOR = 'const Map<String, String> kItemFamily = {';
  const K_FAMILY_NEUTRAL_ANCHOR = 'const List<String> kFamilyNeutral = [';

  test('the family parse itself found a plausible number of rows', () => {
    // Same guard as the kCollectionSeed parse above: a regex that silently
    // matched nothing would make every assertion below vacuously pass. Prove
    // the parser worked before trusting what it returned.
    const source = readDartMirror();
    const family = pairsInMap(source, K_ITEM_FAMILY_ANCHOR);
    const neutral = entriesInList(source, K_FAMILY_NEUTRAL_ANCHOR);

    expect(Object.keys(family).length).toBe(Object.keys(ITEM_FAMILY).length);
    expect(neutral.length).toBe(FAMILY_NEUTRAL.length);
    expect(new Set(neutral).size).toBe(neutral.length);
  });

  test('kItemFamily agrees with ITEM_FAMILY on ids AND on family', () => {
    const dartFamily = pairsInMap(readDartMirror(), K_ITEM_FAMILY_ANCHOR);

    const missingFromDart = Object.keys(ITEM_FAMILY)
      .filter((id) => !(id in dartFamily))
      .sort();
    expect(
      `add these to ${DART_MIRROR} kItemFamily: ${JSON.stringify(missingFromDart)}`,
    ).toBe(`add these to ${DART_MIRROR} kItemFamily: []`);

    const missingFromTs = Object.keys(dartFamily)
      .filter((id) => !(id in ITEM_FAMILY))
      .sort();
    expect(
      `add these to itemPool.ts ITEM_FAMILY: ${JSON.stringify(missingFromTs)}`,
    ).toBe('add these to itemPool.ts ITEM_FAMILY: []');

    // Value equality, not just key coverage — an item must not be Oakhouse on
    // one side and Quarry on the other. Key-only coverage would pass that.
    const disagree = Object.keys(ITEM_FAMILY)
      .filter((id) => id in dartFamily && dartFamily[id] !== ITEM_FAMILY[id])
      .map((id) => `${id}: ts=${ITEM_FAMILY[id]} dart=${dartFamily[id]}`)
      .sort();
    expect(`families that disagree: ${JSON.stringify(disagree)}`).toBe(
      'families that disagree: []',
    );
  });

  test('kFamilyNeutral agrees with FAMILY_NEUTRAL both ways', () => {
    const dartNeutral = new Set(
      entriesInList(readDartMirror(), K_FAMILY_NEUTRAL_ANCHOR),
    );
    const tsNeutral = new Set(FAMILY_NEUTRAL);

    const missingFromDart = [...tsNeutral]
      .filter((id) => !dartNeutral.has(id))
      .sort();
    expect(
      `add these to ${DART_MIRROR} kFamilyNeutral: ${JSON.stringify(missingFromDart)}`,
    ).toBe(`add these to ${DART_MIRROR} kFamilyNeutral: []`);

    const missingFromTs = [...dartNeutral]
      .filter((id) => !tsNeutral.has(id))
      .sort();
    expect(
      `add these to itemPool.ts FAMILY_NEUTRAL: ${JSON.stringify(missingFromTs)}`,
    ).toBe('add these to itemPool.ts FAMILY_NEUTRAL: []');
  });

  // -------------------------------------------------------------------------
  // Field-level drift — the hole the id-set gate above leaves open
  // -------------------------------------------------------------------------
  //
  // CRITICAL: THE HOLE, STATED. The two tests at the top of this block build id SETS
  // and diff them both ways. Nothing anywhere compared `rarity`, `name`,
  // `category` or `type`. So a row could carry the right id on both sides and
  // be LEGENDARY on the server and COMMON in the player's album, and every
  // gate in the repo stayed green. Verified before writing this: flipping
  // char_knight to 'common' in the Dart mirror was green on main.
  //
  // NOTE: WHY THESE FOUR FIELDS AND NOT SIX. The TypeScript row carries `subject`
  // and `artUrl`; the Dart row deliberately does not (collection_seed.dart's
  // SeedItem has five members). Asserting those two would assert a mirror that
  // was never claimed. The claimed mirror is id + type + category + name +
  // rarity, and that is exactly what this compares.
  //
  // WARNING: THE PARSER HAZARD, AND IT IS REAL. collection_seed.dart:78-94 is 17
  // lines of client-side prose sitting INSIDE the list, and it contains a
  // quoted string: "IT GOES IN THE UNSCOPED 'character' SLOT". A whole-slice
  // sweep for `'...'` — the shape entriesInList uses — reads that prose as
  // data: measured, the raw slice yields 262 quoted strings and 260 after
  // comment-stripping, so the block injects exactly 2 phantoms.
  // OK: TWO INDEPENDENT DEFENCES, because one would be a single point of
  // failure: (a) stripComments removes the prose, and (b) every field is read
  // from inside a matched `SeedItem(...)` constructor, which no comment in the
  // list contains. Either alone parses all 52 rows correctly today; both are
  // kept so that a future comment defeating one still meets the other.

  /** Every `SeedItem(...)` row of ONE named Dart list, as id -> its fields.
   *
   *  Anchored and comment-stripped for the reasons above. A row that does not
   *  yield all five fields is returned with nulls rather than skipped, so the
   *  parse guard below can SEE it — silently dropping an unparseable row is
   *  how a mirror gate goes vacuously green.
   */
  const rowsInDeclaration = (
    source: string,
    anchor: string,
  ): Record<string, Record<string, string | null>> => {
    const start = source.indexOf(anchor);
    expect(`"${anchor}" found in ${DART_MIRROR}: ${start >= 0}`).toBe(
      `"${anchor}" found in ${DART_MIRROR}: true`,
    );
    const end = source.indexOf('\n];', start);
    expect(`terminator "\\n];" found after the anchor: ${end > start}`).toBe(
      'terminator "\\n];" found after the anchor: true',
    );

    const slice = stripComments(source.slice(start + anchor.length, end));
    const out: Record<string, Record<string, string | null>> = {};
    const field = (body: string, key: string): string | null => {
      const m = body.match(new RegExp(`\\b${key}:\\s*'([^']*)'`));
      return m ? m[1] : null;
    };

    let match: RegExpExecArray | null;
    const rowRe = /SeedItem\(([^)]*)\)/g;
    while ((match = rowRe.exec(slice)) !== null) {
      const body = match[1];
      const id = field(body, 'id');
      // An id-less row would collide on the key `null` and hide its siblings.
      // Give it a unique key so the count guard below reports it.
      const key = id ?? `«unparsed row ${Object.keys(out).length}»`;
      out[key] = {
        type: field(body, 'type'),
        category: field(body, 'category'),
        name: field(body, 'name'),
        rarity: field(body, 'rarity'),
      };
    }
    return out;
  };

  test('the field parse itself read every row and every field', () => {
    // Same guard as the id parse above, one level deeper: a regex that matched
    // the rows but not their fields would make the comparison below vacuously
    // pass on a pile of nulls.
    const rows = rowsInDeclaration(readDartMirror(), KCOLLECTION_SEED_ANCHOR);

    expect(Object.keys(rows).length).toBe(SEED_ITEMS.length);

    const incomplete = Object.entries(rows)
      .filter(([, f]) => Object.values(f).some((v) => v === null))
      .map(([id, f]) =>
        `${id}: ${Object.entries(f)
          .filter(([, v]) => v === null)
          .map(([k]) => k)
          .join(',')}`,
      )
      .sort();
    expect(`rows with an unparsed field: ${JSON.stringify(incomplete)}`).toBe(
      'rows with an unparsed field: []',
    );

    // The 17-line prose block at collection_seed.dart:78-94 sits between
    // char_astronaut and char_pyjama. If comment handling ever regresses, the
    // rows either side of it are where it shows first.
    expect(`char_astronaut rarity: ${rows['char_astronaut']?.rarity}`).toBe(
      'char_astronaut rarity: legendary',
    );
    expect(`char_pyjama name: ${rows['char_pyjama']?.name}`).toBe(
      'char_pyjama name: Pyjamas',
    );
  });

  test('kCollectionSeed agrees with SEED_ITEMS on type, category, name AND rarity', () => {
    const dartRows = rowsInDeclaration(readDartMirror(), KCOLLECTION_SEED_ANCHOR);

    // Both directions are already covered by the id-set test above, so this
    // compares the rows present on both sides and reports every disagreeing
    // field at once — a one-field-at-a-time gate makes a six-row drift take
    // six runs to see.
    const disagree: string[] = [];
    for (const ts of SEED_ITEMS) {
      const dart = dartRows[ts.id];
      if (!dart) continue; // absence is the id test's job, not this one.
      for (const key of ['type', 'category', 'name', 'rarity'] as const) {
        if (dart[key] !== ts[key]) {
          disagree.push(`${ts.id}.${key}: ts='${ts[key]}' dart='${dart[key]}'`);
        }
      }
    }
    disagree.sort();

    expect(`fields that disagree: ${JSON.stringify(disagree, null, 0)}`).toBe(
      'fields that disagree: []',
    );
  });
});
