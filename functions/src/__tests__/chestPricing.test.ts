// functions/src/__tests__/chestPricing.test.ts
//
// Chest prices stopped being uniform on 2026-08-11: characters 500, styles 250,
// furniture 100. Two things had been hiding behind the uniformity — a second
// hand-maintained copy of the numbers, and a `?? 100` fallback in the purchase
// path that was indistinguishable from a correct price while every chest cost
// 100.
//
// The source-reading assertions below follow the precedent already shipped in
// dailyRotation.test.ts, which reads a Dart file off disk for the same reason:
// it is the cheapest thing that actually fails when someone reintroduces the
// duplication.
import * as fs from 'fs';
import * as path from 'path';

import {CHEST_PRICE} from '../itemPool';

const INDEX_TS = fs.readFileSync(path.resolve(__dirname, '..', 'index.ts'), 'utf8');

/**
 * `index.ts` with comment lines removed.
 *
 * The comment explaining the removed `?? 100` fallback quotes the old code, so
 * a naive search for it matches the warning about itself and reports the bug as
 * still present. The design floor has been raised by exactly this before:
 * naming a banned construct inside a warning about that construct counts as a
 * use of it.
 */
const INDEX_CODE = INDEX_TS.split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
  .join('\n');

/** The chest array literals in rotateMarket and seedShopData. */
function chestWriterLines(): string[] {
  return INDEX_CODE.split('\n').filter(
    (line) => /\{\s*id:\s*[`']chest_/.test(line) && line.includes('price:'),
  );
}

describe('chest prices', () => {
  test('are the values Brendan set', () => {
    expect(CHEST_PRICE.characters).toBe(500);
    expect(CHEST_PRICE.styles).toBe(250);
    expect(CHEST_PRICE.furniture).toBe(100);
  });

  test('are differentiated — a uniform table would restore the bug this guards', () => {
    const distinct = new Set(Object.values(CHEST_PRICE));
    expect(distinct.size).toBeGreaterThan(1);
  });
});

// The durable half of W2-06. The two writers were copies of each other by hand,
// which is the shape that drifts — and the drift would have surfaced only after
// the first midnight rotation, as a seeded environment disagreeing with a
// rotated one. They cannot disagree now because there is one source; these
// assertions fail if someone puts the second copy back.
describe('the two chest writers cannot disagree', () => {
  test('both writers exist and there are exactly two of them', () => {
    // Six lines: three chests each in rotateMarket and seedShopData. If this
    // changes, the assertions below are covering less than they claim to.
    expect(chestWriterLines()).toHaveLength(6);
  });

  test('every chest writer takes its price from CHEST_PRICE', () => {
    for (const line of chestWriterLines()) {
      expect(line).toMatch(/price:\s*CHEST_PRICE\.\w+/);
    }
  });

  test('no chest writer hardcodes a numeric price', () => {
    const hardcoded = chestWriterLines().filter((line) => /price:\s*\d/.test(line));
    expect(hardcoded).toEqual([]);
  });

  test('each writer covers all three categories', () => {
    const used = chestWriterLines().map((l) => (l.match(/price:\s*CHEST_PRICE\.(\w+)/) as string[])[1]);
    for (const category of Object.keys(CHEST_PRICE)) {
      // Twice each: once in rotateMarket, once in seedShopData.
      expect(used.filter((u) => u === category)).toHaveLength(2);
    }
  });
});

// The purchase path reads price off a persisted document written by another
// process. There is no schema behind it, so the absence of a price is a state
// the code must handle rather than assume away.
describe('the purchase path refuses an unpriced chest', () => {
  test('does not fall back to a guessed price', () => {
    // Against code only — the comment above the fix quotes the old expression.
    expect(INDEX_CODE).not.toMatch(/txChest\.price\s*\?\?/);
  });

  test('throws rather than charging when price is missing or not a number', () => {
    expect(INDEX_CODE).toMatch(/refusing to charge a guessed amount/);
    expect(INDEX_CODE).toMatch(/typeof rawChestPrice !== 'number'/);
  });
});
