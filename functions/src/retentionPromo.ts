// ---------------------------------------------------------------------------
// The 5-of-7 retention promo — one free month, once per account
//
// Brendan: a player who cleans "5 of 7 days for 3 weeks" gets a free month of
// Pro. This module is the whole decision; index.ts supplies the data and
// performs the write, and does no deciding.
//
// 🔴 THE WINDOW DEFINITION IS NOT SETTLED AND IS NOT MINE TO SETTLE. "5 of 7
// days, after 3 weeks" has two honest readings:
//
//   consecutive-windows  three consecutive 7-day windows, each with >= 5
//                        distinct active days
//   total-days           >= 15 distinct active days across a rolling 21
//
// Both are implemented, both are tested, and {@link ACTIVE_RULE} selects one in
// a single line. The default is `consecutive-windows` because it is STRICTLY
// STRICTER — every schedule it accepts, `total-days` also accepts (three
// windows of >= 5 sum to >= 15), and the converse fails: 7+7+1 satisfies
// `total-days` at 15 days and is a fortnight of cleaning followed by a week off,
// which is not the habit the promo is paying for. For a GRANT the fail-closed
// direction is to grant less readily, so the stricter reading is the safe
// default to sit on while the question is open. `promoRuleIsStricter` in the
// suite asserts that containment rather than trusting this paragraph.
//
// ⚠️ WHAT IS NOT AMBIGUOUS: a CALENDAR-week bucket is wrong under BOTH readings.
// Bucketing by ISO week lets someone qualify with days that never formed a
// 7-day run — Thu-Sun then Mon-Wed reads as two "weeks" and is one unbroken
// stretch — and it also refuses a genuine 5-of-7 that straddles a Sunday. Every
// window here is ROLLING and anchored to the moment of the call.
// ---------------------------------------------------------------------------

/** Distinct active days required inside each 7-day window. */
export const PROMO_ACTIVE_DAYS_PER_WINDOW = 5;

/** The length of one window, in days. */
export const PROMO_WINDOW_DAYS = 7;

/** How many consecutive windows must qualify. "3 weeks". */
export const PROMO_WINDOW_COUNT = 3;

/** The whole observation period — 21 days, ending today. */
export const PROMO_OBSERVATION_DAYS = PROMO_WINDOW_DAYS * PROMO_WINDOW_COUNT;

/** Distinct active days required under the `total-days` reading. */
export const PROMO_TOTAL_ACTIVE_DAYS = PROMO_ACTIVE_DAYS_PER_WINDOW * PROMO_WINDOW_COUNT;

/** Length of the granted entitlement. "One free month." */
export const PROMO_GRANT_DAYS = 30;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type QualifyingRule = 'consecutive-windows' | 'total-days';

/**
 * Which reading is live.
 *
 * 🔴 UNCONFIRMED — see the header. Changing this line changes who is paid, so
 * it is deliberately a single named constant rather than a parameter threaded
 * through the callable: there is exactly one place to look and one place to
 * edit when Brendan answers.
 */
export const ACTIVE_RULE: QualifyingRule = 'consecutive-windows';

/**
 * The UTC day a timestamp falls in, as a day number.
 *
 * ⚠️ UTC, NOT THE PLAYER'S LOCAL DAY, and that is a real tradeoff rather than an
 * oversight. The obvious alternative is `dayKey`, which the completion record
 * already carries and which IS the player's local day — but `dayKey` is
 * CLIENT-SUPPLIED (`index.ts` builds it as `clientNowIso.slice(0, 10)`), so a
 * device clock moved forward and back manufactures a three-week habit in one
 * evening. That is tolerable for a quest tally and not for a free month.
 *
 * `loggedAt` is a real server Timestamp and cannot be forged, so the promo is
 * counted in UTC days. The cost is at the edges: a player well west of UTC
 * cleaning late in the evening lands on the next UTC day, so two consecutive
 * local nights can collapse into one UTC day or split across two. It makes the
 * measure slightly noisy near midnight and it makes it HONEST, and only one of
 * those two properties can be had.
 */
export function utcDayIndex(ms: number): number {
  return Math.floor(ms / MS_PER_DAY);
}

/**
 * The distinct UTC days on which anything was completed.
 *
 * A day counts once no matter how many tasks it holds — the promo is about
 * showing up, not volume, and a player who does eight tasks on Monday has not
 * thereby cleaned on Tuesday.
 */
export function activeDayIndices(loggedAtMs: readonly number[]): Set<number> {
  const days = new Set<number>();
  for (const ms of loggedAtMs) {
    if (Number.isFinite(ms)) days.add(utcDayIndex(ms));
  }
  return days;
}

export interface PromoProgress {
  /** Whether the account qualifies right now, under {@link rule}. */
  eligible: boolean;
  /** The reading applied. Echoed so a caller never has to assume it. */
  rule: QualifyingRule;
  /** Distinct active days inside the whole observation period. */
  activeDays: number;
  /**
   * Active days per window, OLDEST FIRST, one entry per
   * {@link PROMO_WINDOW_COUNT}.
   *
   * Returned even under `total-days`, where it decides nothing, because it is
   * what a progress UI needs and computing it costs nothing. A caller must read
   * {@link eligible}, never re-derive it from this.
   */
  windows: number[];
  /** Days still needed. 0 once eligible. Under `consecutive-windows` this is
   *  the shortfall of the WORST window, which is what actually blocks. */
  shortfall: number;
}

/**
 * Decides whether a completion history earns the promo.
 *
 * Pure: no Firestore, no clock of its own. `nowMs` is passed so the suite can
 * place a history anywhere without a fake timer, and so two callers in the same
 * request cannot straddle midnight.
 */
export function evaluatePromo(
  loggedAtMs: readonly number[],
  nowMs: number,
  rule: QualifyingRule = ACTIVE_RULE,
): PromoProgress {
  const today = utcDayIndex(nowMs);
  const earliest = today - PROMO_OBSERVATION_DAYS + 1;
  const days = activeDayIndices(loggedAtMs);

  // Windows oldest first. Window w covers the 7 days ending
  // `today - (COUNT-1-w)*7`, so the last window ends today.
  const windows: number[] = [];
  for (let w = 0; w < PROMO_WINDOW_COUNT; w++) {
    const end = today - (PROMO_WINDOW_COUNT - 1 - w) * PROMO_WINDOW_DAYS;
    const start = end - PROMO_WINDOW_DAYS + 1;
    let count = 0;
    for (let d = start; d <= end; d++) if (days.has(d)) count++;
    windows.push(count);
  }

  let activeDays = 0;
  for (const d of days) if (d >= earliest && d <= today) activeDays++;

  if (rule === 'total-days') {
    return {
      eligible: activeDays >= PROMO_TOTAL_ACTIVE_DAYS,
      rule,
      activeDays,
      windows,
      shortfall: Math.max(0, PROMO_TOTAL_ACTIVE_DAYS - activeDays),
    };
  }

  const worst = Math.min(...windows);
  return {
    eligible: worst >= PROMO_ACTIVE_DAYS_PER_WINDOW,
    rule,
    activeDays,
    windows,
    shortfall: Math.max(0, PROMO_ACTIVE_DAYS_PER_WINDOW - worst),
  };
}

/**
 * The earliest instant the eligibility query must read.
 *
 * 🔑 THE QUERY BOUND, and the reason it exists. `users/{uid}/completions` has
 * NO TTL and is never pruned — a deliberate choice, since pruning destroys the
 * recompute the log exists for — so the collection grows without limit and the
 * existing full-collection read (`db.collection(...).get()`) would load a
 * player's entire history to answer a 21-day question. Anchoring the query here
 * makes the read proportional to the window instead of to the account's age.
 *
 * A range filter on `loggedAt` alone needs no composite index: Firestore
 * creates single-field indexes automatically, and `firestore.indexes.json`
 * carries only the giftInvites composite.
 */
export function observationStartMs(nowMs: number): number {
  return (utcDayIndex(nowMs) - PROMO_OBSERVATION_DAYS + 1) * MS_PER_DAY;
}

/**
 * When the granted entitlement should end, given any entitlement already held.
 *
 * 🔴 EXTENDS, NEVER OVERWRITES. `verifySubscriptionReceipt` writes
 * `subscriptionExpiresAt` unconditionally, which is correct there — Apple's
 * expiry is the truth for an Apple purchase. It is NOT correct here: a promo
 * landing on someone who already has three weeks left must add a month to the
 * three weeks, not replace them with a month. Anchoring to
 * `max(now, currentExpiry)` also means a promo granted to a LAPSED account
 * starts from today rather than from a date in the past, which would grant
 * nothing at all.
 */
export function promoExpiryMs(nowMs: number, currentExpiryMs: number | null): number {
  const base = currentExpiryMs != null && currentExpiryMs > nowMs ? currentExpiryMs : nowMs;
  return base + PROMO_GRANT_DAYS * MS_PER_DAY;
}
