// functions/src/__tests__/duplicateBias.test.ts
//
// W2-161. Before this brief there was NO duplicate probability anywhere in the
// codebase to test: `pickChestItem` filtered SEED_ITEMS on (rarity, subject) and
// picked uniformly with no ownership filter, so the duplicate rate was whatever
// the player's collection happened to make it.
//
// 🔑 THE CENTRAL CLAIM THIS FILE GUARDS: the duplicate rate is a property of the
// DRAW, not of the drop table. The drop table chooses a rarity and knows nothing
// about what the player owns, so it cannot move a duplicate rate in either
// direction. `the drop table cannot move the duplicate rate` below is the CONTROL
// that proves this file is measuring the bias rather than the table — if
// mutating DROP_TABLES reddens these tests, they are not measuring what they
// claim to.
import {
  DROP_TABLES,
  DUPLICATE_REFUNDS,
  DUPLICATE_REFUND_FRACTION,
  CHEST_PRICE,
  DROP_TABLE_CATEGORY,
  CHEST_CATEGORY_DROP_TABLE,
  TARGET_DUPLICATE_RATE,
  partitionByOwnership,
  pickWithDuplicateBias,
  refundForCategory,
  refundForDropTable,
  refundForPrice,
  sumDuplicateRefunds,
  SEED_ITEMS,
} from '../itemPool';

type Item = {id: string};
const cell = (...ids: string[]): Item[] => ids.map((id) => ({id}));
const idOf = (i: Item) => i.id;

/** A generator that yields the given values in order, then repeats the last. */
function scriptedRng(...values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe('partitionByOwnership', () => {
  test('splits a cell into what is and is not already held', () => {
    const {unowned, owned} = partitionByOwnership(
      cell('a', 'b', 'c'),
      new Set(['b']),
      idOf,
    );
    expect(unowned.map(idOf)).toEqual(['a', 'c']);
    expect(owned.map(idOf)).toEqual(['b']);
  });

  test('an empty ownership set leaves everything unowned', () => {
    const {unowned, owned} = partitionByOwnership(cell('a', 'b'), new Set(), idOf);
    expect(unowned).toHaveLength(2);
    expect(owned).toHaveLength(0);
  });

  test('ownership of ids outside the cell does not leak in', () => {
    // A player owns most of the collection; only the ids IN this cell may
    // partition it. Without this, a wide ownership set would empty every cell.
    const {unowned, owned} = partitionByOwnership(
      cell('a'),
      new Set(['x', 'y', 'z']),
      idOf,
    );
    expect(unowned.map(idOf)).toEqual(['a']);
    expect(owned).toHaveLength(0);
  });
});

describe('the biased draw', () => {
  // 🔴 THE LITERAL, PINNED AGAINST A NUMBER RATHER THAN AGAINST ITSELF.
  //
  // Every other assertion in this file spells the target as
  // `TARGET_DUPLICATE_RATE`, which is right for expressing the RELATIONSHIP but
  // useless for pinning the VALUE: change the constant and each of them moves
  // with it. Measured — setting TARGET_DUPLICATE_RATE to 0.5 and running the
  // whole suite turned NOTHING red until this test existed. That is internal
  // consistency mistaken for correctness, and it is the exact shape the brief
  // warned about when it asked which mutation reddens only the new gate.
  test('the target rate is 5%, and this is the assertion that says so', () => {
    expect(TARGET_DUPLICATE_RATE).toBe(0.05);
  });

  test('the realised rate is 5% measured against the literal, not against the constant', () => {
    // The sampled companion to the line above: this one would still fail if the
    // constant were re-pointed AND the boundary logic rewritten to match it.
    const unowned = cell('a', 'b', 'c');
    const owned = cell('x', 'y');
    let duplicates = 0;
    const N = 40000;
    for (let i = 0; i < N; i++) {
      if (pickWithDuplicateBias(unowned, owned).isDuplicate) duplicates++;
    }
    expect(duplicates / N).toBeGreaterThan(0.04);
    expect(duplicates / N).toBeLessThan(0.06);
  });

  test('picks a duplicate strictly below the target rate and a fresh item at or above it', () => {
    // 🔴 THE BOUNDARY IS PINNED, NOT SAMPLED. A test that only samples cannot
    // tell 5% from 4% without tens of thousands of draws, and one that samples
    // at that size is slow enough that someone deletes it.
    const unowned = cell('fresh');
    const owned = cell('dupe');

    const justBelow = pickWithDuplicateBias(unowned, owned, scriptedRng(TARGET_DUPLICATE_RATE - 0.001, 0));
    expect(justBelow.isDuplicate).toBe(true);
    expect(justBelow.item.id).toBe('dupe');

    const exactly = pickWithDuplicateBias(unowned, owned, scriptedRng(TARGET_DUPLICATE_RATE, 0));
    expect(exactly.isDuplicate).toBe(false);
    expect(exactly.item.id).toBe('fresh');

    const justAbove = pickWithDuplicateBias(unowned, owned, scriptedRng(TARGET_DUPLICATE_RATE + 0.001, 0));
    expect(justAbove.isDuplicate).toBe(false);
    expect(justAbove.item.id).toBe('fresh');
  });

  test('a duplicate drawn by choice is not marked forced', () => {
    const res = pickWithDuplicateBias(cell('fresh'), cell('dupe'), scriptedRng(0, 0));
    expect(res.isDuplicate).toBe(true);
    expect(res.forcedDuplicate).toBe(false);
  });

  test('owning nothing in the cell can never yield a duplicate, whatever the roll', () => {
    for (const roll of [0, 0.0001, TARGET_DUPLICATE_RATE - 0.001, 0.5, 0.999]) {
      const res = pickWithDuplicateBias(cell('a', 'b'), [], scriptedRng(roll, 0));
      expect(res.isDuplicate).toBe(false);
      expect(res.forcedDuplicate).toBe(false);
    }
  });

  test('an exhausted cell forces a duplicate and says it was forced', () => {
    // 🔴 THE CASE THAT IS THE MAJORITY, NOT THE EDGE — see the measurement test
    // at the bottom of this file. 45 of 84 cells hold ONE item, so this branch
    // is what most cells do for the whole rest of a player's life.
    for (const roll of [0, 0.5, 0.999]) {
      const res = pickWithDuplicateBias([], cell('only'), scriptedRng(roll, 0));
      expect(res.isDuplicate).toBe(true);
      expect(res.forcedDuplicate).toBe(true);
      expect(res.item.id).toBe('only');
    }
  });

  test('an empty cell throws rather than returning undefined as an item', () => {
    expect(() => pickWithDuplicateBias([], [], scriptedRng(0))).toThrow(/empty cell/);
  });

  test('the realised rate over many draws lands on the target when both outcomes exist', () => {
    // A sampled check to back the pinned boundary above: the boundary proves the
    // comparison, this proves the comparison is actually reached on each draw.
    const unowned = cell('a', 'b', 'c');
    const owned = cell('x', 'y');
    let duplicates = 0;
    const N = 40000;
    for (let i = 0; i < N; i++) {
      if (pickWithDuplicateBias(unowned, owned).isDuplicate) duplicates++;
    }
    expect(duplicates / N).toBeGreaterThan(TARGET_DUPLICATE_RATE - 0.01);
    expect(duplicates / N).toBeLessThan(TARGET_DUPLICATE_RATE + 0.01);
  });

  test('every item in the chosen half stays reachable — the bias picks a half, not a favourite', () => {
    // Without this, `pool[0]` would satisfy every assertion above while
    // silently making 3 of every 4 items in a cell unobtainable.
    const unowned = cell('a', 'b', 'c', 'd');
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      seen.add(pickWithDuplicateBias(unowned, cell('x')).item.id);
    }
    expect([...seen].sort()).toEqual(['a', 'b', 'c', 'd', 'x']);
  });

  test('THE CONTROL: the drop table cannot move the duplicate rate', () => {
    // 🔑 The brief's central finding, asserted rather than asserted-about: the
    // 5% target CANNOT be reached by tuning DROP_TABLES, because the draw's
    // ownership bias does not consult them. If a future change makes the rate
    // depend on the table, this goes red and the tests above become suspect —
    // they would then be measuring the table, not the bias.
    const before = JSON.parse(JSON.stringify(DROP_TABLES));
    const rateWith = (): number => {
      let dupes = 0;
      for (let i = 0; i < 20000; i++) {
        if (pickWithDuplicateBias(cell('a', 'b'), cell('x')).isDuplicate) dupes++;
      }
      return dupes / 20000;
    };
    const baseline = rateWith();
    // Mutate every table to the most extreme legal shape and re-measure.
    for (const tier of Object.keys(DROP_TABLES)) {
      (DROP_TABLES as Record<string, [number, number]>)[tier] = [0.0, 0.0];
    }
    const mutated = rateWith();
    Object.assign(DROP_TABLES, before);

    expect(Math.abs(mutated - baseline)).toBeLessThan(0.01);
    expect(DROP_TABLES).toEqual(before); // the mutation was undone
  });
});

describe('the refund is 75% of what the chest cost', () => {
  test('the fraction is the one Brendan set', () => {
    expect(DUPLICATE_REFUND_FRACTION).toBe(0.75);
  });

  test('a priced chest refunds 75% of its own price, floored', () => {
    expect(refundForPrice(500)).toBe(375);
    expect(refundForPrice(100)).toBe(75);
  });

  test('📌 187.5 IS NOT AN INTEGER — the styles chest floors to 187, it does not round to 188', () => {
    // A sponge balance is an integer. Rounding UP would let a player farm half a
    // sponge per duplicate, which is an economy change nobody chose; flooring
    // loses at most one sponge per duplicate, in the house's favour.
    expect(250 * DUPLICATE_REFUND_FRACTION).toBe(187.5);
    expect(refundForPrice(250)).toBe(187);
    expect(DUPLICATE_REFUNDS.styles).toBe(187);
  });

  test('a nonsense price refunds nothing rather than a negative or a NaN', () => {
    expect(refundForPrice(0)).toBe(0);
    expect(refundForPrice(-100)).toBe(0);
    expect(refundForPrice(Number.NaN)).toBe(0);
    expect(refundForPrice(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test('the category table is exactly 75% of CHEST_PRICE, floored, for every category', () => {
    // Derived, not transcribed: a hand-written second table is the shape that
    // drifts, which is the whole argument in CHEST_PRICE's own docblock.
    for (const [category, price] of Object.entries(CHEST_PRICE)) {
      expect(DUPLICATE_REFUNDS[category]).toBe(Math.floor(price * DUPLICATE_REFUND_FRACTION));
    }
    expect(DUPLICATE_REFUNDS).toEqual({characters: 375, styles: 187, furniture: 75});
  });

  test('a refund never exceeds what the chest cost', () => {
    for (const [category, price] of Object.entries(CHEST_PRICE)) {
      expect(refundForCategory(category)).toBeLessThan(price);
    }
  });

  test('an unpriced chest derives its refund from the drop table it froze', () => {
    // The Gibby daily gift and pending chests carry no price. GIBBY_CHEST_DROP_TABLE
    // is 'mid', which inverts to styles.
    expect(refundForDropTable('mid')).toBe(DUPLICATE_REFUNDS.styles);
    expect(refundForDropTable('rich')).toBe(DUPLICATE_REFUNDS.characters);
    expect(refundForDropTable('lean')).toBe(DUPLICATE_REFUNDS.furniture);
  });

  test('an underivable category or tier pays nothing rather than a guessed amount', () => {
    expect(refundForCategory('no_such_category')).toBe(0);
    expect(refundForCategory(undefined)).toBe(0);
    expect(refundForDropTable('no_such_tier')).toBe(0);
    expect(refundForDropTable(undefined)).toBe(0);
  });

  test('the tier→category inversion is total and lossless', () => {
    // ⚠️ The inversion is only 1:1 while no two categories share a tier. If a
    // fourth category ever reuses one, DROP_TABLE_CATEGORY silently keeps
    // whichever was declared last and the other category's refund goes wrong.
    // That day should be a red test, not a quiet mispayment.
    const tiers = Object.values(CHEST_CATEGORY_DROP_TABLE);
    expect(new Set(tiers).size).toBe(tiers.length);
    for (const [category, tier] of Object.entries(CHEST_CATEGORY_DROP_TABLE)) {
      expect(DROP_TABLE_CATEGORY[tier]).toBe(category);
    }
  });
});

// ---------------------------------------------------------------------------
// The measurement that moved the product decision
// ---------------------------------------------------------------------------
//
// 🔴 THIS IS THE FINDING, NOT THE FIX, AND IT IS A TEST SO THE NEXT PERSON CAN
// RE-RUN IT RATHER THAN TRUST IT.
//
// The brief asked for "5% flat across all chests". That is not implementable
// against this pool, and the reason is the pool's SHAPE rather than anything in
// the draw: most (subject, rarity) cells hold exactly one item, so the moment a
// player owns it every subsequent roll into that cell is a forced duplicate and
// no weighting can move the rate off 100%.
//
// Brendan ruled on 2026-08-29, given these numbers: conditional 5% with honest
// copy — "Duplicates are rare while new items remain. Once you own everything in
// a set, duplicates refund 75%." The copy names no percentage, because the true
// rate is conditional on which sets a player is deep into.
//
// The assertions below are deliberately loose where the content is expected to
// grow (the art factory is still adding rows) and exact only on the property
// the decision rests on: that single-item cells are a large fraction of the
// pool, not a rounding error.
describe('the pool shape that makes a flat rate impossible', () => {
  const cells = new Map<string, number>();
  for (const item of SEED_ITEMS) {
    const key = `${item.subject}|${item.rarity}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
  }
  const sizes = [...cells.values()];
  const singletons = sizes.filter((n) => n === 1).length;

  test('the measurement as taken on 2026-08-29', () => {
    // The figures in the W2-161 return. Loose bounds, because these move as the
    // factory ships rows; the SHAPE is what the decision rests on.
    expect(SEED_ITEMS.length).toBeGreaterThanOrEqual(192);
    expect(cells.size).toBeGreaterThanOrEqual(84);
    expect(Math.min(...sizes)).toBe(1);
  });

  test('🔑 single-item cells are a large minority of the pool, so a forced duplicate is ordinary', () => {
    // 45 of 84 when measured. If this ever drops below a quarter the pool has
    // been padded enough to revisit the flat-rate question — which is a reason
    // to re-read this test, not to delete it.
    expect(singletons).toBeGreaterThan(cells.size / 4);
  });

  test('a single-item cell cannot honour the target rate, and that is arithmetic not policy', () => {
    // Pick any real singleton cell and show the rate is binary: 0% while unowned,
    // 100% once owned. No argument to pickWithDuplicateBias changes either.
    const singletonKey = [...cells.entries()].find(([, n]) => n === 1)![0];
    const [subject, rarity] = singletonKey.split('|');
    const only = SEED_ITEMS.filter((i) => i.subject === subject && i.rarity === rarity);
    expect(only).toHaveLength(1);

    const fresh = partitionByOwnership(only, new Set<string>(), (i) => i.id);
    expect(pickWithDuplicateBias(fresh.unowned, fresh.owned).isDuplicate).toBe(false);

    const exhausted = partitionByOwnership(only, new Set([only[0].id]), (i) => i.id);
    for (let i = 0; i < 100; i++) {
      const res = pickWithDuplicateBias(exhausted.unowned, exhausted.owned);
      expect(res.isDuplicate).toBe(true);
      expect(res.forcedDuplicate).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// What an unpriced chest owes for its duplicates
// ---------------------------------------------------------------------------
//
// Quest and admin-granted chests have no purchase price, so a duplicate pays 75%
// of the LIST price of the category they were granted as. Before W2-161 they paid
// nothing at all AND wrote over the item the player already had, so the reward
// evaporated twice over.
//
// 📌 The daily gift is deliberately NOT in this set. Brendan, 2026-08-29: "The
// daily gift only gives sponges so it would be a waste to add anything as the
// duplicate is just for items, the daily gift is also free so it would make no
// sense." It is a sponge faucet and a duplicate is an item concept — see the
// comment at the gift's grant site in index.ts.
describe('sumDuplicateRefunds', () => {
  const owned = new Set(['owned-1', 'owned-2']);

  test('pays nothing when nothing granted is already owned', () => {
    expect(sumDuplicateRefunds([{category: 'characters', itemId: 'fresh'}], owned)).toBe(0);
  });

  test('pays the category list refund for each owned grant', () => {
    expect(sumDuplicateRefunds([{category: 'characters', itemId: 'owned-1'}], owned)).toBe(375);
    expect(sumDuplicateRefunds([{category: 'styles', itemId: 'owned-1'}], owned)).toBe(187);
    expect(sumDuplicateRefunds([{category: 'furniture', itemId: 'owned-1'}], owned)).toBe(75);
  });

  test('sums across a batch, paying only for the duplicates in it', () => {
    expect(
      sumDuplicateRefunds(
        [
          {category: 'characters', itemId: 'owned-1'},
          {category: 'furniture', itemId: 'owned-2'},
          {category: 'characters', itemId: 'fresh'},
        ],
        owned,
      ),
    ).toBe(375 + 75);
  });

  test('an unpriced or missing category pays nothing rather than a guess', () => {
    expect(sumDuplicateRefunds([{category: 'no_such', itemId: 'owned-1'}], owned)).toBe(0);
    expect(sumDuplicateRefunds([{itemId: 'owned-1'}], owned)).toBe(0);
    expect(sumDuplicateRefunds([{category: 'styles'}], owned)).toBe(0);
  });

  test('an empty batch pays nothing', () => {
    expect(sumDuplicateRefunds([], owned)).toBe(0);
  });
});
