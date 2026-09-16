// ---------------------------------------------------------------------------
// Streak config + naive-local date helpers
// ---------------------------------------------------------------------------
//
// Dates flowing through the streak system are NAIVE-LOCAL ISO strings: no `Z`,
// no offset (e.g. "2026-06-29T14:32:00.000000", from Dart's
// DateTime.toIso8601String()). The server runs in UTC and CANNOT recover the
// user's timezone, so we never anchor these to an absolute instant. Instead we
// treat the wall-clock components as a fixed reference frame and do all
// arithmetic on that frame's UTC accessors. This keeps the math deterministic
// regardless of the machine's local timezone or DST. Never call .toISOString()
// (it appends `Z` and re-anchors to UTC).

export const STREAK_SHIELD_PRICE = 150;
export const MAX_STREAK_SHIELDS = 2;

export interface MilestoneConfig {
  threshold: number;
  payout: number;
  label: string;
}

export const STREAK_MILESTONES: Record<string, MilestoneConfig> = {
  streak_7:   { threshold: 7,   payout: 50,   label: '7-Day Streak' },
  streak_30:  { threshold: 30,  payout: 150,  label: '30-Day Streak' },
  streak_100: { threshold: 100, payout: 400,  label: '100-Day Streak' },
  streak_365: { threshold: 365, payout: 1000, label: '1-Year Streak' },
};

/**
 * Parses a naive-local ISO string (no Z, no offset) into a Date whose UTC
 * components equal the string's wall-clock components. We parse the fields
 * explicitly rather than via `new Date(str)` so 6-digit Dart microseconds and
 * runtime-dependent local-vs-UTC parsing can't shift the result.
 */
export function parseNaiveDate(naiveIso: string): Date {
  const m = naiveIso.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/,
  );
  if (!m) {
    // Fall back to native parsing for unexpected shapes (e.g. date-only).
    return new Date(naiveIso);
  }
  const [, y, mo, d, h, mi, s, frac] = m;
  const ms = frac ? Number(frac.slice(0, 3).padEnd(3, '0')) : 0;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms));
}

/**
 * Returns the streak-day a timestamp belongs to, using a 4 AM cutoff. Mirrors
 * Dart: streakDate(ts) = floor((ts - 4h) to calendar day). A 3 AM timestamp
 * belongs to the *previous* day; 5 AM belongs to the same day. Returns a Date
 * at midnight of that day (in the naive/UTC reference frame).
 */
export function streakDate(d: Date): Date {
  const shifted = new Date(d.getTime() - 4 * 3600 * 1000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/**
 * Formats a Date as a naive ISO string (no Z) from its UTC components. Use this
 * for ALL date writes back to Firestore so the stored value stays in the naive
 * frame the client reads.
 */
export function toNaiveIso(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `.${pad(d.getUTCMilliseconds(), 3)}`
  );
}
