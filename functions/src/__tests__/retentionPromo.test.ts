// functions/src/__tests__/retentionPromo.test.ts
//
// The 5-of-7 promo decision, tested as pure data — no Firestore, no emulator,
// no fake clock. `nowMs` is a parameter, so a history can be placed anywhere.
//
// CRITICAL: THE WINDOW DEFINITION IS UNSETTLED. Both honest readings of "5 of 7 days
// for 3 weeks" are implemented and both are tested here, because the thing that
// must not happen is a rule change arriving with no test of the reading it
// replaces. `ACTIVE_RULE` selects one; these tests pass whichever it is, and
// the block at the bottom asserts the containment that makes the current
// default the fail-closed one.

import {
  ACTIVE_RULE,
  PROMO_ACTIVE_DAYS_PER_WINDOW,
  PROMO_GRANT_DAYS,
  PROMO_OBSERVATION_DAYS,
  PROMO_TOTAL_ACTIVE_DAYS,
  activeDayIndices,
  evaluatePromo,
  observationStartMs,
  promoExpiryMs,
  utcDayIndex,
} from '../retentionPromo';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 7, 14, 12, 0, 0);
const TODAY = utcDayIndex(NOW);

/** A completion timestamp `daysAgo` before today, at midday UTC. */
function at(daysAgo: number, hourUtc = 12): number {
  return (TODAY - daysAgo) * MS_PER_DAY + hourUtc * 60 * 60 * 1000;
}

/** Completions on each of the given day-offsets. */
function onDays(daysAgo: readonly number[]): number[] {
  return daysAgo.map((d) => at(d));
}

/** Every day-offset in [from, to] inclusive. */
function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let d = from; d <= to; d++) out.push(d);
  return out;
}

/**
 * A history that qualifies under BOTH readings: 5 of every 7 days, three
 * windows. Days 0-4, 7-11, 14-18 — the first five of each window.
 */
const QUALIFYING = onDays([...range(0, 4), ...range(7, 11), ...range(14, 18)]);

describe('utcDayIndex + activeDayIndices', () => {
  test('many completions on one day count as one active day', () => {
    // The promo pays for showing up, not for volume. Eight tasks on Monday is
    // not also Tuesday.
    const eight = Array.from({ length: 8 }, (_, i) => at(3, i + 1));
    expect(activeDayIndices(eight).size).toBe(1);
  });

  test('completions either side of UTC midnight are two days', () => {
    const days = activeDayIndices([at(3, 23), at(2, 0)]);
    expect(days.size).toBe(2);
  });

  test('a non-finite timestamp is dropped, not counted as day zero', () => {
    // A record written before `loggedAt` existed, or a corrupt one, must not
    // silently land on 1970-01-01 and inflate the tally.
    expect(activeDayIndices([NaN, Infinity, at(1)]).size).toBe(1);
  });
});

describe('evaluatePromo — consecutive-windows (the current default)', () => {
  const RULE = 'consecutive-windows' as const;

  test('5 of 7 in each of three windows qualifies', () => {
    const r = evaluatePromo(QUALIFYING, NOW, RULE);
    expect(r.eligible).toBe(true);
    expect(r.windows).toEqual([5, 5, 5]);
    expect(r.shortfall).toBe(0);
  });

  test('cleaning every day obviously qualifies', () => {
    const r = evaluatePromo(onDays(range(0, 20)), NOW, RULE);
    expect(r.eligible).toBe(true);
    expect(r.windows).toEqual([7, 7, 7]);
  });

  test('🔴 one weak window disqualifies even at 15+ total days', () => {
    // THE CASE THAT SEPARATES THE TWO READINGS, and the reason the default is
    // the stricter one. 7 + 7 + 1 = 15 distinct active days — enough under
    // `total-days` — but it is a fortnight of cleaning followed by a week off.
    // That is not the habit the promo is paying for.
    const lapsed = onDays([...range(14, 20), ...range(7, 13), 0]);
    const r = evaluatePromo(lapsed, NOW, RULE);

    expect(r.activeDays).toBe(15);
    expect(r.windows).toEqual([7, 7, 1]);
    expect(r.eligible).toBe(false);
    expect(r.shortfall).toBe(4);

    // …and the other reading would have paid it.
    expect(evaluatePromo(lapsed, NOW, 'total-days').eligible).toBe(true);
  });

  test('4 of 7 in the middle window disqualifies', () => {
    const r = evaluatePromo(
      onDays([...range(0, 4), ...range(7, 10), ...range(14, 18)]),
      NOW,
      RULE,
    );
    expect(r.windows).toEqual([5, 4, 5]);
    expect(r.eligible).toBe(false);
    expect(r.shortfall).toBe(1);
  });

  test('the windows are reported OLDEST FIRST', () => {
    // A progress bar that drew them backwards would tell someone their best
    // week was their most recent one. Oldest-first is asserted, not assumed.
    const r = evaluatePromo(onDays([...range(14, 20), 0]), NOW, RULE);
    expect(r.windows).toEqual([7, 0, 1]);
  });

  test('an empty history is not eligible and does not throw', () => {
    const r = evaluatePromo([], NOW, RULE);
    expect(r.eligible).toBe(false);
    expect(r.activeDays).toBe(0);
    expect(r.windows).toEqual([0, 0, 0]);
  });
});

describe('evaluatePromo — total-days', () => {
  const RULE = 'total-days' as const;

  test('15 distinct days in the 21 qualifies however they fall', () => {
    expect(evaluatePromo(QUALIFYING, NOW, RULE).eligible).toBe(true);
    expect(
      evaluatePromo(onDays([...range(6, 20)]), NOW, RULE).eligible,
    ).toBe(true);
  });

  test('14 days does not, and the shortfall names the gap', () => {
    const r = evaluatePromo(onDays(range(7, 20)), NOW, RULE);
    expect(r.activeDays).toBe(14);
    expect(r.eligible).toBe(false);
    expect(r.shortfall).toBe(1);
  });
});

describe('the observation window is ROLLING, not calendar', () => {
  test('⚠️ a day older than the period does not count', () => {
    // KEY: The one thing that is unambiguous under BOTH readings. A calendar-week
    // bucket would let days that never formed a 7-day run qualify, and would
    // refuse a genuine 5-of-7 that straddles a Sunday. Everything here is
    // anchored to the moment of the call.
    const tooOld = onDays([...range(0, 4), ...range(7, 11), ...range(21, 25)]);
    const r = evaluatePromo(tooOld, NOW, 'consecutive-windows');
    expect(r.windows[0]).toBe(0);
    expect(r.eligible).toBe(false);
  });

  test('the same history evaluated a week later has aged out of the oldest window', () => {
    // The rolling property stated as a change, not as a boundary: a history
    // that qualifies today must stop qualifying once its oldest week falls off.
    expect(evaluatePromo(QUALIFYING, NOW, 'consecutive-windows').eligible).toBe(true);
    const weekLater = NOW + 7 * MS_PER_DAY;
    expect(evaluatePromo(QUALIFYING, weekLater, 'consecutive-windows').eligible).toBe(false);
  });

  test('observationStartMs bounds the query to the period, not the account age', () => {
    const start = observationStartMs(NOW);
    expect(utcDayIndex(start)).toBe(TODAY - PROMO_OBSERVATION_DAYS + 1);
    // It must be a midnight, or a query would clip the earliest day in half.
    expect(start % MS_PER_DAY).toBe(0);
  });
});

describe('🔑 the default rule is the STRICTLY STRICTER one', () => {
  test('every history consecutive-windows accepts, total-days also accepts', () => {
    // The containment the fail-closed default rests on, asserted rather than
    // argued in a comment: three windows of >= 5 sum to >= 15, so
    // consecutive-windows implies total-days. The converse fails — proved by
    // the 7/7/1 case above.
    //
    // Enumerated over a spread of shapes rather than proved symbolically; what
    // matters is that a future edit to either branch cannot quietly invert the
    // relationship that makes the current default safe.
    const shapes: number[][] = [
      range(0, 20),
      [...range(0, 4), ...range(7, 11), ...range(14, 18)],
      [...range(0, 5), ...range(7, 12), ...range(14, 19)],
      [...range(1, 5), ...range(8, 12), ...range(15, 19)],
      [...range(0, 4), ...range(7, 10), ...range(14, 18)],
      [...range(14, 20), ...range(7, 13), 0],
      [0, 1, 2],
      [],
    ];

    for (const shape of shapes) {
      const log = onDays(shape);
      const strict = evaluatePromo(log, NOW, 'consecutive-windows').eligible;
      const loose = evaluatePromo(log, NOW, 'total-days').eligible;
      if (strict) expect(loose).toBe(true);
    }
  });

  test('ACTIVE_RULE is the strict one while the question is open', () => {
    // NOTE: This is a PIN on an UNDECIDED policy, and it is meant to go red when
    // Brendan answers. Its failure is the reminder to update the header, the
    // PR that changes it, and whatever UI quotes the requirement.
    expect(ACTIVE_RULE).toBe('consecutive-windows');
    expect(PROMO_ACTIVE_DAYS_PER_WINDOW).toBe(5);
    expect(PROMO_OBSERVATION_DAYS).toBe(21);
    expect(PROMO_TOTAL_ACTIVE_DAYS).toBe(15);
  });
});

describe('promoExpiryMs — extends, never overwrites', () => {
  test('a lapsed account starts its free month from today', () => {
    const past = NOW - 40 * MS_PER_DAY;
    expect(promoExpiryMs(NOW, past)).toBe(NOW + PROMO_GRANT_DAYS * MS_PER_DAY);
  });

  test('an account with no entitlement starts from today', () => {
    expect(promoExpiryMs(NOW, null)).toBe(NOW + PROMO_GRANT_DAYS * MS_PER_DAY);
  });

  test('🔴 a live subscriber gains a month ON TOP, and is never shortened', () => {
    // The defect this exists to prevent. verifySubscriptionReceipt writes
    // subscriptionExpiresAt unconditionally — correct there, because Apple's
    // expiry is the truth for an Apple purchase. Copying that here would take
    // someone with three weeks left and leave them with a month.
    const threeWeeksLeft = NOW + 21 * MS_PER_DAY;
    const after = promoExpiryMs(NOW, threeWeeksLeft);

    expect(after).toBe(threeWeeksLeft + PROMO_GRANT_DAYS * MS_PER_DAY);
    expect(after).toBeGreaterThan(threeWeeksLeft);
  });
});
