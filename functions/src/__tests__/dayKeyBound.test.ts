/**
 * `boundedDayKey` — the pure half of W2-174's repair.
 *
 * ---------------------------------------------------------------------------
 * 🔴 WHY THIS LIVES IN THE UNIT SUITE AS WELL AS THE EMULATOR ONE
 * ---------------------------------------------------------------------------
 *
 * The behavioural proof that the mint is closed is in
 * `taskCompletionEmulator.test.ts`, driving the real callable against a real
 * Firestore, and it is the stronger test. But that suite is
 * `*Emulator.test.ts` — excluded from `npm test` by jest.config.js and run only
 * by `npm run test:e2e`, which needs a JDK and three emulators. A gate on a
 * currency mint must not live ONLY behind a run that can be
 * environment-skipped.
 *
 * This half needs nothing: the function is pure in both its arguments, so the
 * server clock is a parameter rather than `Date.now()` read inside. A boundary
 * tested against the real clock is a test that passes for a different reason on
 * every run.
 */
import {HttpsError} from 'firebase-functions/v2/https';

import {
  MAX_DAY_KEY_DRIFT_DAYS,
  boundedDayKey,
  serverDayKey,
} from '../taskRewards';

/** Noon UTC on a fixed day, so nothing here depends on when it runs. */
const SERVER_NOW = Date.parse('2026-09-13T12:00:00.000Z');
const DAY_MS = 86_400_000;

/** [n] days from the server's own UTC date, as a `YYYY-MM-DD` key. */
function offsetKey(n: number): string {
  return new Date(SERVER_NOW + n * DAY_MS).toISOString().slice(0, 10);
}

/** The thrown code, or null if the call was admitted. */
function codeFor(clientNowIso: unknown): string | null {
  try {
    boundedDayKey(clientNowIso, SERVER_NOW);
    return null;
  } catch (err) {
    return (err as HttpsError).code;
  }
}

describe('the fixture is what this file thinks it is', () => {
  test('the server day is the one every case is measured against', () => {
    // A drifting anchor would make every offset below mean something else.
    expect(serverDayKey(SERVER_NOW)).toBe('2026-09-13');
    expect(offsetKey(0)).toBe('2026-09-13');
    expect(offsetKey(-1)).toBe('2026-09-12');
    expect(offsetKey(1)).toBe('2026-09-14');
  });

  test('the drift allowance is one day', () => {
    // Pinned as a literal as well as by name: a constant compared only against
    // itself cannot fail. Widening it is an economy decision, not a tidy-up.
    expect(MAX_DAY_KEY_DRIFT_DAYS).toBe(1);
  });
});

describe('🔑 the bound admits every real timezone — the disproof clause, kept', () => {
  // W2-173 stopped rather than ship a server-derived UTC key, because
  // `dayKey` is also the query key over client-stamped `completedDate`
  // values: a UTC key pays a Los Angeles player NOTHING after 17:00 local,
  // every day. These three cases are why the client still names its own day.
  test('the server`s own UTC date is admitted', () => {
    expect(boundedDayKey(`${offsetKey(0)}T09:00:00`, SERVER_NOW)).toBe(offsetKey(0));
  });

  test('one day BEHIND UTC is admitted — Los Angeles at 17:00 local', () => {
    expect(boundedDayKey(`${offsetKey(-1)}T17:00:00`, SERVER_NOW)).toBe(offsetKey(-1));
  });

  test('one day AHEAD of UTC is admitted — Auckland at 10:00 local', () => {
    expect(boundedDayKey(`${offsetKey(1)}T10:00:00`, SERVER_NOW)).toBe(offsetKey(1));
  });

  test('the widest inhabited offsets, UTC-12 and UTC+14, both land inside', () => {
    // The reason the allowance is one and not two. A local calendar date can
    // differ from UTC's by at most a day at either extreme, so these are the
    // real edges rather than chosen ones.
    for (const offsetHours of [-12, 14]) {
      const localIso = new Date(SERVER_NOW + offsetHours * 3_600_000)
        .toISOString()
        .replace('Z', '');
      expect(codeFor(localIso)).toBeNull();
    }
  });
});

describe('🔴 the bound refuses a fabricated day', () => {
  test('two days ahead is refused', () => {
    expect(codeFor(`${offsetKey(2)}T09:00:00`)).toBe('invalid-argument');
  });

  test('two days behind is refused', () => {
    expect(codeFor(`${offsetKey(-2)}T09:00:00`)).toBe('invalid-argument');
  });

  test('a year ahead is refused', () => {
    // The shape a wrong device clock produces, and the shape that poisons a
    // naive ratchet permanently if it is ever let through.
    expect(codeFor('2027-09-13T09:00:00')).toBe('invalid-argument');
  });

  test('the refusal names the drift, so a support ticket is answerable', () => {
    let message = '';
    try {
      boundedDayKey(`${offsetKey(5)}T09:00:00`, SERVER_NOW);
    } catch (err) {
      message = (err as HttpsError).message;
    }
    expect(message).toContain(offsetKey(5));
    expect(message).toContain('5 day(s)');
  });
});

describe('⚠️ a string that merely looks like a date is refused, not parsed', () => {
  // `Date.parse` is permissive and returns NaN for the rest; either way a key
  // that reaches Firestore matches no task document and pays zero, silently.
  test.each<[string, string]>([
    ['2026-13-45T09:00:00', 'an impossible month and day'],
    ['not-a-date-at-all', 'free text'],
    ['2026-9-13T09:00:00', 'an unpadded month'],
    ['', 'the empty string'],
  ])('%s (%s) is refused', (iso) => {
    expect(codeFor(iso)).toBe('invalid-argument');
  });

  test.each<[unknown, string]>([
    [null, 'null'],
    [undefined, 'undefined'],
    [20260913, 'a number'],
    [{toString: () => '2026-09-13'}, 'an object that stringifies to a valid key'],
  ])('a non-string (%s) is refused', (value) => {
    // The last case matters: the handler types `clientNowIso` as a string and
    // the wire does not enforce that, so a caller can send anything JSON can
    // carry. Refusing on the TYPE rather than on `String(value)` is what stops
    // an object being coerced into a key nobody wrote.
    expect(codeFor(value)).toBe('invalid-argument');
  });
});

describe('the day key is the DATE half only', () => {
  test('the time of day is discarded, not rounded', () => {
    // 23:59 local is still that local date. A bound that rounded to the nearest
    // UTC day would move the boundary the `completedDate` query depends on.
    expect(boundedDayKey(`${offsetKey(0)}T23:59:59.999999`, SERVER_NOW))
      .toBe(offsetKey(0));
    expect(boundedDayKey(`${offsetKey(0)}T00:00:00.000000`, SERVER_NOW))
      .toBe(offsetKey(0));
  });

  test('a trailing Z does not change the key', () => {
    // The client sends a NAIVE ISO string (streak.ts:toNaiveIso strips the Z),
    // but nothing stops a caller adding one, and the first ten characters are
    // the same either way.
    expect(boundedDayKey(`${offsetKey(0)}T09:00:00Z`, SERVER_NOW)).toBe(offsetKey(0));
  });
});
