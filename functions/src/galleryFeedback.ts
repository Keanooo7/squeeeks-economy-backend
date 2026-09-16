// ---------------------------------------------------------------------------
// Tester feedback on gallery specimens — storage and export
// ---------------------------------------------------------------------------
//
// W2-23. A tester on TestFlight lassoes a region of a gallery screen and types
// what is wrong with it. This is the server half: where that lands and how a
// human reads it back. The lasso, the per-page colour cycling and the hide
// button are lib/ and W1's.
//
// ---------------------------------------------------------------------------
// 🔴 THE DISPROOF, ANSWERED — AND THE BRIEF'S PREMISE NEEDED CORRECTING
// ---------------------------------------------------------------------------
//
// The question was: must a lasso be stored against a RENDERED FRAME, or is a
// specimen reference plus normalised coordinates enough?
//
// ENOUGH — no image storage, so this is one collection and two callables rather
// than a much larger brief. The gallery is deterministic: a Specimen carries its
// own `build:` and `overrides:`, so any specimen can be re-rendered on demand.
// A stored pixel copy of what the tester saw would be a cache of something
// reproducible.
//
// ⚠️ BUT "gallerySpecimens() RETURNS ~50 STABLE IDS" IS NOT TRUE, AND THE PART
// THAT IS FALSE IS "IDS". `Specimen` (lib/gallery/specimen.dart:10) HAS NO id
// FIELD. Its identity is the composite (group, label, state) — three
// human-authored display strings. Renaming `label: 'Login'` to `'Sign in'`
// silently orphans every comment ever filed against it, and nothing anywhere
// would notice.
//
// 🔑 That is the THIRD instance of one defect class in this codebase, and by now
// it should be named rather than rediscovered:
//   · task documents have no stable key, so quests match on title text (W2-10)
//   · bonusTaskIdFor indexes into a mutable list, so a reorder rewrites history
//     for every past day (W2-16)
//   · specimens have no id, so feedback is keyed on renamable display text
// Each time the durable fix is the same: give the thing a key that is not its
// label. Adding one to Specimen is a lib/ change and therefore W1's — specified
// in the return, not invented here.
//
// ⚠️ AND A SECOND CONDITION THE BRIEF DID NOT NAME: a specimen key alone does
// not say WHAT THE TESTER SAW. A comment on `Home/Dashboard/default` filed
// against build 42 points at a screen build 60 may have redesigned. So every
// record stores the BUILD IT WAS FILED FROM. Without that the coordinates are
// precise about a screen that no longer exists — which is exactly the "an old
// render is not a stale render" trap, one layer up.
//
// ---------------------------------------------------------------------------
// ⚠️ COST — AND IT IS A DIFFERENT SHAPE FROM EVERY OTHER BRIEF THIS SESSION
// ---------------------------------------------------------------------------
//
// This takes writes from strangers. A feedback item is NOT currency, so the
// exposure is not double-granting and a replay key is the wrong tool — two
// identical comments are a tester tapping twice, which is noise, not theft.
//
// The exposure is UNBOUNDED WRITE VOLUME. What bounds it today:
//   · authentication — only a signed-in user can write at all;
//   · MAX_COMMENT_LENGTH, so one document cannot be enormous;
//   · a rect must be four finite numbers in [0,1], so junk is rejected early;
//   · Firestore's own per-document write ceiling.
//   · MAX_SUBMISSIONS_PER_DAY, added in W2-26 — the document count is now
//     bounded per tester per calendar day, enforced in the same transaction
//     that increments it.
//
// 🔴 WHAT STILL DOES NOT BOUND IT, stated so the cap is not mistaken for
// airtight:
//   · NOTHING RATE-LIMITS THE CALLABLE ITSELF. A caller can burn the day's 100
//     in a second, and can keep calling after that — each refused call is a
//     transactional read, which is cheap but not free. The cap bounds STORED
//     DOCUMENTS, not REQUESTS. Closing that needs App Check or a real limiter,
//     which is W2-18's finding and out of scope here.
//   · THE CAP IS PER UID. Someone able to create accounts multiplies it by the
//     number of accounts they create. For an invite-only TestFlight cohort that
//     is not a threat; on a public build it is the first thing to reconsider.
//   · A DAY IS THE SERVER'S CALENDAR DAY (UTC), not the tester's. Someone
//     filing across midnight UTC gets two allowances. Deliberate: the
//     alternative is a per-tester timezone the server does not store, and the
//     failure mode of getting it wrong is refusing a real tester.

/**
 * Most submissions one tester may file in a calendar day.
 *
 * 🔑 THE NUMBER HAS A REASON, because a number without one is a number the next
 * window changes on a hunch. The gallery has 51 specimens
 * (lib/gallery/registry.dart), so a THOROUGH PASS filing one submission per
 * screen is ~51. A hundred is therefore two complete passes in a day, which no
 * tester reaches by hand while actually typing sentences — and each submission
 * may carry up to MAX_LASSOS_PER_SUBMISSION comments, so the real ceiling is
 * 100 x 20 = 2,000 comments per tester per day.
 *
 * ⚠️ Deliberately generous. A cap that breaks a real day-three gallery pass is
 * worse than no cap: it turns a working feature into a mysterious refusal, and
 * the tester's response is to stop reporting bugs. This bounds a RUNAWAY CLIENT
 * — a retry loop, or someone with a script — not a person.
 */
export const MAX_SUBMISSIONS_PER_DAY = 100;

/** Longest comment accepted. Long enough for a paragraph, short enough to read. */
export const MAX_COMMENT_LENGTH = 2000;

/** Most lassos one submission may carry. A page of annotations, not a essay. */
export const MAX_LASSOS_PER_SUBMISSION = 20;

/**
 * A normalised region of a specimen, in [0,1] against the specimen's own
 * rendered box.
 *
 * 🔑 NORMALISED, NEVER DEVICE PIXELS. A tester on a phone and one on a tablet
 * must produce comparable regions, and a pixel rect is unreadable a week later
 * without knowing the device that made it.
 */
export interface LassoRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Lasso {
  rect: LassoRect;
  /**
   * Which colour in the page's cycle this lasso is, as an INDEX.
   *
   * 🔑 AN INDEX, NOT A HEX STRING. "Each new lasso gets a new colour for that
   * page" is a per-page sequence, and the palette belongs to the client. Storing
   * `#FF00AA` would freeze a design decision into user data and mean a palette
   * change silently reinterprets every comment ever filed.
   */
  colourIndex: number;
  /** The tester's words. Stored verbatim — see the export note. */
  comment: string;
}

export interface FeedbackSubmission {
  /**
   * `group/label/state`, e.g. `Auth/Login/error`.
   *
   * ⚠️ Composite and renamable — see the header. This is the best key available
   * today, not a good one.
   */
  specimenKey: string;
  /** The build this was filed from. Without it the coordinates are unmoored. */
  appVersion: string;
  lassos: Lasso[];
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** True when [r] is a sane normalised rect that stays inside the specimen. */
export function isValidRect(r: unknown): r is LassoRect {
  if (typeof r !== 'object' || r === null) return false;
  const {x, y, width, height} = r as Record<string, unknown>;
  if (![x, y, width, height].every(isFiniteNumber)) return false;
  const rect = r as LassoRect;
  if (rect.width <= 0 || rect.height <= 0) return false;
  // Must lie within the unit box. A rect running off the edge is either a bug
  // in the client's coordinate maths or a hand-crafted payload; neither is
  // something to store and puzzle over later.
  return (
    rect.x >= 0 && rect.y >= 0 &&
    rect.x + rect.width <= 1 && rect.y + rect.height <= 1
  );
}

export interface ValidationResult {
  ok: boolean;
  /** Why it was rejected, in words a client author can act on. */
  reason?: string;
}

/**
 * PURE. Validates a submission without touching Firestore.
 *
 * Deliberately does NOT validate that `specimenKey` names a real specimen: the
 * server has no list of them (they live in lib/), and inventing a mirror here
 * would be a second copy of the registry — the defect this codebase keeps
 * filing. An unknown key exports as an unknown key, which is visible and
 * recoverable; a rejected one loses the tester's sentence.
 */
export function validateSubmission(input: unknown): ValidationResult {
  if (typeof input !== 'object' || input === null) {
    return {ok: false, reason: 'submission must be an object'};
  }
  const {specimenKey, appVersion, lassos} = input as Record<string, unknown>;

  if (typeof specimenKey !== 'string' || specimenKey.length === 0) {
    return {ok: false, reason: 'specimenKey (non-empty string) required'};
  }
  if (specimenKey.length > 200) {
    return {ok: false, reason: 'specimenKey is implausibly long'};
  }
  if (typeof appVersion !== 'string' || appVersion.length === 0) {
    return {ok: false, reason: 'appVersion required — a comment with no build is unmoored'};
  }
  if (!Array.isArray(lassos) || lassos.length === 0) {
    return {ok: false, reason: 'at least one lasso required'};
  }
  if (lassos.length > MAX_LASSOS_PER_SUBMISSION) {
    return {ok: false, reason: `at most ${MAX_LASSOS_PER_SUBMISSION} lassos per submission`};
  }

  for (const l of lassos) {
    if (typeof l !== 'object' || l === null) {
      return {ok: false, reason: 'each lasso must be an object'};
    }
    const lasso = l as Record<string, unknown>;
    if (!isValidRect(lasso.rect)) {
      return {ok: false, reason: 'each lasso needs a normalised rect inside [0,1] with positive size'};
    }
    if (!Number.isInteger(lasso.colourIndex) || (lasso.colourIndex as number) < 0) {
      return {ok: false, reason: 'colourIndex must be a non-negative integer — an index, not a hex string'};
    }
    if (typeof lasso.comment !== 'string') {
      return {ok: false, reason: 'each lasso needs a comment string'};
    }
    if ((lasso.comment as string).length > MAX_COMMENT_LENGTH) {
      return {ok: false, reason: `a comment may be at most ${MAX_COMMENT_LENGTH} characters`};
    }
  }
  return {ok: true};
}

/** A stored record, as the export reads it back. */
export interface FeedbackRecord extends FeedbackSubmission {
  uid: string;
  submittedAtIso: string;
}

/**
 * Renders every record as text a person can read.
 *
 * 🔑 THE TESTER'S SENTENCE IS REPRODUCED VERBATIM AND IS NEVER SUMMARISED,
 * TRUNCATED OR REFLOWED. A feedback tool that summarises is one that loses the
 * sentence someone typed, and the sentence is the entire product. Everything
 * else in a record — the rect, the colour index, the build — is scaffolding
 * around that one string.
 *
 * Grouped by specimen because that is how the reader works: they open a screen,
 * fix what is wrong with it, and move on. Sorting by time would scatter one
 * screen's problems across the whole file.
 */
export function formatFeedbackReport(records: FeedbackRecord[]): string {
  if (records.length === 0) {
    // Distinguishable from "the export broke" — the same reasoning as
    // blindBefore in questRecompute.ts.
    return 'No tester feedback has been submitted yet.\n';
  }

  const bySpecimen = new Map<string, FeedbackRecord[]>();
  for (const r of records) {
    const list = bySpecimen.get(r.specimenKey);
    if (list) list.push(r);
    else bySpecimen.set(r.specimenKey, [r]);
  }

  const total = records.reduce((n, r) => n + r.lassos.length, 0);
  const lines: string[] = [
    'TESTER FEEDBACK',
    `${total} comment(s) across ${bySpecimen.size} screen(s), from ${new Set(records.map((r) => r.uid)).size} tester(s).`,
    '',
  ];

  for (const key of [...bySpecimen.keys()].sort()) {
    const forSpecimen = bySpecimen.get(key)!;
    lines.push('='.repeat(72));
    lines.push(key);
    lines.push('='.repeat(72));
    for (const record of forSpecimen) {
      for (const [i, lasso] of record.lassos.entries()) {
        const pct = (n: number) => `${Math.round(n * 100)}%`;
        lines.push('');
        lines.push(
          `  [${i + 1}] colour ${lasso.colourIndex} · region ` +
            `${pct(lasso.rect.x)},${pct(lasso.rect.y)} ` +
            `${pct(lasso.rect.width)}x${pct(lasso.rect.height)} · ` +
            `build ${record.appVersion} · ${record.submittedAtIso}`,
        );
        // Verbatim. Indented for readability, and the indent is the ONLY
        // alteration — line breaks the tester typed are preserved.
        for (const line of lasso.comment.split('\n')) {
          lines.push(`      ${line}`);
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
