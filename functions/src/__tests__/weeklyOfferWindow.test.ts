// functions/src/__tests__/weeklyOfferWindow.test.ts
//
// W2-164. `patch-weekly-offer.js` decided "NOTHING TO DO" from PRICE and PRODUCT
// ID, and the two fields that decide whether a player SEES the offer are
// `startsAt` and `endsAt`. It never printed them either, so the operator running
// it to CHECK got the same blind answer as the one running it to FIX.
//
// KEY: THE WINDOW LOGIC LIVES IN TypeScript RATHER THAN IN THE SCRIPT so that this
// file can reach it. A copy inside a `.js` operator script would be untested by
// construction — `npm test` never loads it — which is the shape that let the
// original blindness sit there in the first place.
import {
  offerTimestampMillis,
  offerWindowState,
  offerIsVisible,
  offerWindowExplanation,
  WEEKLY_OFFERS,
} from '../weeklyOffers';

const NOW = Date.UTC(2026, 7, 30, 12, 0, 0);
const HOUR = 3600 * 1000;
/** A Firestore Timestamp, which is what rotateWeeklyOffer actually writes. */
const ts = (ms: number) => ({toMillis: () => ms});

describe('offerTimestampMillis decodes every shape a stored window arrives in', () => {
  test('a Firestore Timestamp', () => {
    expect(offerTimestampMillis(ts(NOW))).toBe(NOW);
  });

  test('a plain number, which is what the emulator suites store', () => {
    expect(offerTimestampMillis(NOW)).toBe(NOW);
  });

  test('an ISO string, which a hand-seeded document may carry', () => {
    expect(offerTimestampMillis('2026-08-30T12:00:00.000Z')).toBe(NOW);
  });

  test('🔴 an undecodable value is null, NOT NaN', () => {
    // NaN would compare false against everything and silently report a window as
    // closed rather than as broken — the difference between "expired" and
    // "somebody wrote garbage here" is the difference between waiting for Monday
    // and calling a human.
    expect(offerTimestampMillis('not a date')).toBeNull();
    expect(offerTimestampMillis({})).toBeNull();
    expect(offerTimestampMillis(Number.NaN)).toBeNull();
    expect(offerTimestampMillis(null)).toBeNull();
    expect(offerTimestampMillis(undefined)).toBeNull();
  });
});

describe('offerWindowState', () => {
  const openOffer = {startsAt: ts(NOW - HOUR), endsAt: ts(NOW + HOUR)};

  test('open when now is inside the window', () => {
    expect(offerWindowState(openOffer, NOW)).toBe('open');
  });

  test('🔴 THE DEFECT THIS EXISTS FOR: an expired window is not healthy', () => {
    // The live document's price and product id can be perfect and the card is
    // still on nobody's screen. This is the fact the script could not see.
    expect(offerWindowState({startsAt: ts(NOW - 2 * HOUR), endsAt: ts(NOW - HOUR)}, NOW))
      .toBe('expired');
  });

  test('not-yet-open when startsAt is in the future', () => {
    expect(offerWindowState({startsAt: ts(NOW + HOUR), endsAt: ts(NOW + 2 * HOUR)}, NOW))
      .toBe('not-yet-open');
  });

  test('absent when either bound is missing — an unrotated shop/current', () => {
    expect(offerWindowState({}, NOW)).toBe('absent');
    expect(offerWindowState({startsAt: ts(NOW)}, NOW)).toBe('absent');
    expect(offerWindowState({endsAt: ts(NOW)}, NOW)).toBe('absent');
    expect(offerWindowState(null, NOW)).toBe('absent');
    expect(offerWindowState(undefined, NOW)).toBe('absent');
  });

  test('🔑 absent and malformed are DIFFERENT, and conflating them hides the one needing a human', () => {
    // Missing → the cron has not run. Present-but-unreadable → something wrote
    // corruption. Waiting until Monday fixes the first and never fixes the second.
    expect(offerWindowState({startsAt: 'nope', endsAt: 'also nope'}, NOW)).toBe('malformed');
    expect(offerWindowState({}, NOW)).toBe('absent');
  });

  test('malformed when endsAt is not after startsAt', () => {
    expect(offerWindowState({startsAt: ts(NOW), endsAt: ts(NOW)}, NOW)).toBe('malformed');
    expect(offerWindowState({startsAt: ts(NOW + HOUR), endsAt: ts(NOW)}, NOW)).toBe('malformed');
  });

  test('the boundaries, pinned rather than sampled', () => {
    const startsAt = NOW;
    const endsAt = NOW + HOUR;
    const offer = {startsAt: ts(startsAt), endsAt: ts(endsAt)};
    // Inclusive at the start, exclusive at the end — `endsAt` is next Monday
    // midnight, which is the NEXT window's startsAt. An offer exactly used up is
    // used up, the same `<=` boundary planFamilyFanOut pins on the other side.
    expect(offerWindowState(offer, startsAt - 1)).toBe('not-yet-open');
    expect(offerWindowState(offer, startsAt)).toBe('open');
    expect(offerWindowState(offer, endsAt - 1)).toBe('open');
    expect(offerWindowState(offer, endsAt)).toBe('expired');
  });

  test('only `open` counts as visible', () => {
    for (const state of ['expired', 'not-yet-open', 'absent', 'malformed'] as const) {
      expect(offerIsVisible(state)).toBe(false);
    }
    expect(offerIsVisible('open')).toBe(true);
  });

  test('every state has an explanation, so the operator never reads a bare enum', () => {
    for (const state of ['open', 'expired', 'not-yet-open', 'absent', 'malformed'] as const) {
      expect(offerWindowExplanation(state).length).toBeGreaterThan(10);
    }
  });
});

describe('🔴 the seed carries NO window, which is why the script reports and never patches', () => {
  test('no bundled offer has startsAt or endsAt', () => {
    // If this ever goes red, someone has put a window in the seed and the
    // "report, never patch" decision in patch-weekly-offer.js needs re-deciding
    // rather than quietly inheriting — there would now be a value to patch TO.
    for (const offer of WEEKLY_OFFERS) {
      expect((offer as unknown as Record<string, unknown>).startsAt).toBeUndefined();
      expect((offer as unknown as Record<string, unknown>).endsAt).toBeUndefined();
    }
  });

  test('so a seed offer reads as `absent`, never as a window to restore', () => {
    for (const offer of WEEKLY_OFFERS) {
      expect(offerWindowState(offer as never, NOW)).toBe('absent');
    }
  });
});
