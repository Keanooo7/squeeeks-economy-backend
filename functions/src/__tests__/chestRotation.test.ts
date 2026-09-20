// functions/src/__tests__/chestRotation.test.ts
//
// W2-08. The shop's STOCK rotates: which chests are OFFERED varies by day, with
// the character egg rare and furniture/styles common.
//
// KEY: THE DELIVERABLE IS THE DISTRIBUTION, NOT A DAY. A rarity rule asserted on
// one date is a coincidence with a green tick next to it. Everything below runs
// a multi-year span and asserts frequencies and — the part that actually matters
// — the CAP, over every rolling window rather than every aligned week.
//
// WARNING: Nothing here stubs Math.random. The scheduler is seeded internally, so
// there is no global to stub; and stubbing it under Jest returns a constant
// pivot into Jest's own quicksort, which recurses to death before a single test
// runs. `makeRng` is exported so a caller injects instead.

import {
  offeredChestCategories,
  scheduleForBlock,
  makeRng,
  dayIndexFromDateStr,
  ROTATION_BLOCK_DAYS,
  CHARACTER_BLOCK_OFFSETS,
  FURNITURE_DAYS_PER_BLOCK,
  STYLES_DAYS_PER_BLOCK,
  CHEST_PRICE,
} from '../itemPool';
import {codeOf} from './helpers/sourceText';

/// Five years of consecutive days, as `YYYYMMDD`, starting at the epoch.
/// Long enough that a per-block bug cannot hide in a lucky span.
const SPAN_DAYS = 365 * 5;

function dateStrForOffset(offset: number): string {
  const d = new Date(Date.UTC(2026, 0, 1) + offset * 86400000);
  return d.toISOString().split('T')[0].replace(/-/g, '');
}

const SPAN: string[] = Array.from({length: SPAN_DAYS}, (_, i) => dateStrForOffset(i));
const OFFERED: string[][] = SPAN.map((d) => offeredChestCategories(d));

function countDaysWith(category: string): number {
  return OFFERED.filter((day) => day.includes(category)).length;
}

describe('the day index and the span fixture are sound', () => {
  // A distribution test over a broken calendar proves nothing, so the fixture
  // itself is checked before anything is measured against it.
  test('consecutive date strings map to consecutive day indices across month and year ends', () => {
    for (let i = 1; i < SPAN.length; i++) {
      expect(dayIndexFromDateStr(SPAN[i])).toBe(dayIndexFromDateStr(SPAN[i - 1]) + 1);
    }
  });

  test('the span really does cross leap day and several year boundaries', () => {
    expect(SPAN).toContain('20280229');
    expect(SPAN.filter((d) => d.endsWith('0101')).length).toBeGreaterThanOrEqual(5);
  });
});

describe('the character egg is the rarest, and the cap is structural', () => {
  // CRITICAL: The headline assertion. Not "at most 2 per ISO week" — at most 2 in EVERY
  // 7-day window, including the ones that straddle a week boundary. A per-week
  // count would pass while the player saw four eggs in six days.
  test('no rolling 7-day window ever contains more than 2 character days', () => {
    let worst = 0;
    let worstAt = '';
    for (let i = 0; i + 7 <= OFFERED.length; i++) {
      const inWindow = OFFERED.slice(i, i + 7).filter((day) => day.includes('characters')).length;
      if (inWindow > worst) {
        worst = inWindow;
        worstAt = SPAN[i];
      }
    }
    expect({worst, worstAt}).toEqual({worst: 2, worstAt: expect.any(String)});
  });

  test('consecutive character days are never closer than 5 days apart', () => {
    const days = OFFERED.map((day, i) => (day.includes('characters') ? i : -1)).filter((i) => i >= 0);
    expect(days.length).toBeGreaterThan(200);
    const gaps = days.slice(1).map((d, i) => d - days[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(9);
  });

  test('the egg averages about one appearance per week — rare, but not absent', () => {
    // Exactly one per 7-day block by construction, so the measured rate is 1.0
    // plus a partial-block rounding term: a 1825-day span is 260.7 blocks and
    // contributes 261 character days. The band is not slack — it is the width
    // of that one truncated block, and a real regression leaves it entirely.
    const perWeek = (countDaysWith('characters') / SPAN_DAYS) * 7;
    expect(perWeek).toBeGreaterThan(0.99);
    expect(perWeek).toBeLessThan(1.01);
  });

  test('it is strictly rarer than both common categories', () => {
    expect(countDaysWith('characters')).toBeLessThan(countDaysWith('styles'));
    expect(countDaysWith('styles')).toBeLessThan(countDaysWith('furniture'));
  });
});

describe('furniture is very common and styles are common', () => {
  test('furniture is stocked on ~6 days in 7', () => {
    const rate = countDaysWith('furniture') / SPAN_DAYS;
    expect(rate).toBeCloseTo(FURNITURE_DAYS_PER_BLOCK / ROTATION_BLOCK_DAYS, 2);
  });

  test('styles are stocked on ~4 days in 7 — the repair day can only raise this', () => {
    const rate = countDaysWith('styles') / SPAN_DAYS;
    expect(rate).toBeGreaterThanOrEqual(STYLES_DAYS_PER_BLOCK / ROTATION_BLOCK_DAYS);
    expect(rate).toBeLessThan(0.75);
  });
});

describe('the shop is never empty and never lies about its stock', () => {
  test('every single day offers at least one chest', () => {
    const empty = SPAN.filter((_, i) => OFFERED[i].length === 0);
    expect(empty).toEqual([]);
  });

  test('a day never lists the same category twice', () => {
    for (const day of OFFERED) {
      expect(new Set(day).size).toBe(day.length);
    }
  });

  test('every category named is a real priced category', () => {
    for (const day of OFFERED) {
      for (const category of day) {
        expect(Object.keys(CHEST_PRICE)).toContain(category);
      }
    }
  });

  test('the line-up genuinely varies — it is a rotation, not a constant', () => {
    const distinct = new Set(OFFERED.map((day) => [...day].sort().join('+')));
    expect(distinct.size).toBeGreaterThanOrEqual(4);
  });

  test('two consecutive blocks do not share an identical schedule', () => {
    // Guards the salt: one PRNG shared across categories, or a seed that ignores
    // the block index, both show up here as a repeating week.
    const a = JSON.stringify(scheduleForBlock(10));
    const b = JSON.stringify(scheduleForBlock(11));
    expect(a).not.toEqual(b);
  });
});

describe('the schedule is deterministic and reproducible', () => {
  test('the same date always yields the same line-up', () => {
    for (const d of ['20260115', '20260812', '20301231']) {
      expect(offeredChestCategories(d)).toEqual(offeredChestCategories(d));
      expect(offeredChestCategories(d)).toEqual([...offeredChestCategories(d)]);
    }
  });

  test('a block schedule places exactly one character day at a permitted offset', () => {
    for (let block = 0; block < 200; block++) {
      const schedule = scheduleForBlock(block);
      const at = schedule
        .map((day, i) => (day.includes('characters') ? i : -1))
        .filter((i) => i >= 0);
      expect(at).toHaveLength(1);
      expect(CHARACTER_BLOCK_OFFSETS).toContain(at[0]);
    }
  });

  test('dates before the epoch do not break the block maths', () => {
    // Math.floor on a negative index, and a modulo that must not go negative.
    const before = offeredChestCategories('20250704');
    expect(before.length).toBeGreaterThan(0);
  });
});

describe('the seeded generator is a generator, not a constant', () => {
  test('makeRng returns varied values in [0,1) and is reproducible from its seed', () => {
    const a = makeRng(12345);
    const b = makeRng(12345);
    const first = Array.from({length: 50}, () => a());
    const second = Array.from({length: 50}, () => b());
    expect(first).toEqual(second);
    expect(new Set(first).size).toBeGreaterThan(40);
    for (const v of first) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('different seeds diverge', () => {
    expect(makeRng(1)()).not.toEqual(makeRng(2)());
  });
});

describe('rotation does not disturb price', () => {
  // The brief's explicit trap: a chest that appears less often must not also
  // acquire a different price by accident. Rotation is an availability axis.
  test('CHEST_PRICE is untouched by this change', () => {
    expect(CHEST_PRICE).toEqual({characters: 500, styles: 250, furniture: 100});
  });

  test('rotateMarket filters the chest list rather than rebuilding it', () => {
    // Source-level, deliberately: the six literal chest-writer lines are what
    // chestPricing.test.ts guards, and a conditional rebuild would remove them.
    // CODE — the filter expression must be in the code, not merely described.
    const code = codeOf(
      require('fs').readFileSync(
        require('path').join(__dirname, '..', 'index.ts'),
        'utf8',
      ),
    );
    expect(code).toMatch(/\.filter\(\(chest\) => offeredChestCategories\(dateStr\)\.includes\(chest\.category\)\)/);
  });
});
