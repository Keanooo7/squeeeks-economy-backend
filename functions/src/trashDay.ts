// ---------------------------------------------------------------------------
// One person takes the bins out and it clears for everyone — the pure half
// ---------------------------------------------------------------------------
//
// W2-77, item 7 of `Projects/Cleaning/spec-2026-08-15-family-plan.md`, in
// Brendan's words: "in the family plan once 1 person does it it should clear
// the notification for all."
//
// ---------------------------------------------------------------------------
// CRITICAL: WHAT "CLEARS THE NOTIFICATION" CAN AND CANNOT MEAN — MEASURED, AND THE
// ANSWER IS NARROWER THAN THE SENTENCE
// ---------------------------------------------------------------------------
//
// The brief's hypothesis was that shared completion is a WRITE rather than a
// notification cancellation, and that a scheduled LOCAL notification already
// handed to another member's OS could not be recalled by a server write. Both
// are right. Two measurements sharpen them, and the second changes the scope:
//
//   1. THE ACKNOWLEDGEMENT IS ALREADY APP STATE, NOT NOTIFICATION STATE.
//      `lib/features/trash_day/domain/trash_day_reminder.dart` says so in its
//      own header: iOS cannot pin a notification, so "stays until OK is
//      pressed" lives entirely in the in-app takeover, and `acknowledgedFor` is
//      a DATE the takeover reads. So "clears for all" is exactly: a shared,
//      dated fact that every member's takeover can consult.
//
//   2. CRITICAL: THE SCHEDULED NOTIFICATION NOW EXISTS, AND IT IS ON-DEVICE.
//      `lib/core/services/trash_notification_service.dart:113` calls
//      `zonedSchedule`, title 'Bins go out tonight' (:115).
//
//      NOTE: REPLACED 2026-08-24 (W2-138). This item used to read "there is no
//      scheduled notification to recall, because nothing schedules one yet —
//      `zonedSchedule` is never called, anywhere". That was true when written
//      and is now the exact opposite of the truth. What follows was written as
//      a forecast; it is now simply the case.
//
//      Scheduling is ON-DEVICE and timezone-local, by a deliberate decision
//      recorded in that same file (the deployed crons fire at fixed UTC hours,
//      which is the wrong local hour for most of the world). A server write
//      cannot reach into another member's OS scheduler. Therefore, today:
//
//        THE TAKEOVER CLEARS FOR EVERYONE. AN ALREADY-SCHEDULED OS
//        NOTIFICATION MAY STILL FIRE ON A DEVICE THAT HAS NOT OPENED THE APP.
//
//      That is not a defect to be fixed here and it is not a cancellation being
//      claimed. Closing it would need a push that wakes each device to cancel
//      its own local notification — a different mechanism, a different brief,
//      and one that still cannot promise delivery.
//
//      WARNING: AND IT IS WHY A DELIVERED TRASH NOTIFICATION SAYS NOTHING ABOUT FCM.
//      W2-138 was briefed on the premise "trash arrived tonight and the daily
//      reminder did not, so the transport is healthy". It does not follow: this
//      path never touches FCM, the push token, or APNs. The two share only the
//      OS display layer, so the pairing exonerates exactly one thing — that iOS
//      will display a notification for this app.
//
//   NOTE: AND A THIRD THING NOBODY HAS WRITTEN DOWN: today `acknowledgedFor` lives
//      in SharedPreferences (`trash_day_provider.dart`, `_kAckKey`), on-device
//      only. It never reaches a server at all. So this module is not making a
//      private fact shared — it is the FIRST server-side trash-day state that
//      has ever existed. W1 will have to reconcile the two, and the local copy
//      should be treated as a cache of this, never the reverse: a device that
//      has not synced must not be able to un-clear what a housemate cleared.
//
// ---------------------------------------------------------------------------
// KEY: WHY THIS NEEDS THE GROUP DOCUMENT, AND COULD NOT HAVE BEEN BUILT BEFORE IT
// ---------------------------------------------------------------------------
//
// "Clears for all" needs to know who ALL is, and to record the answer in one
// place. `users/{uid}.housemates` cannot supply either — the rosters need not
// agree (see family.ts), so "the family" has no single membership, and there is
// no document that is nobody's user record to hang a shared fact on. Writing
// the completion onto each member's own document instead would be a fan-out
// with no owner and no way to tell a stale copy from a current one.
//
// WARNING: This module DECIDES NO MEMBERSHIP POLICY. It consumes `memberUids` and has
// no opinion on how anyone got there — the five open questions from W2-76 are
// still with Brendan and none of them change anything below.

import {FamilyDoc, isValidFamily} from './family';

/** `YYYY-MM-DD`. The bin DATE, never a timestamp. */
export const BIN_DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * How far from the server's own date a submitted bin date may sit.
 *
 * CRITICAL: THE BIN DATE IS CLIENT-SUPPLIED, AND THAT IS THE OPPOSITE OF WHAT THE
 * PROMO PATH DOES. `retentionPromo` counts days in UTC precisely BECAUSE
 * `dayKey` is client-supplied and a moved device clock could manufacture three
 * weeks of habit in one evening. The reasoning inverts here, and the reason it
 * inverts is worth stating rather than looking like an oversight:
 *
 *   - A BIN DAY IS INHERENTLY A LOCAL CALENDAR DAY about a physical event. UTC
 *     would put it on the wrong day for a large part of the world — the same
 *     argument trash_day_reminder.dart already makes for scheduling locally,
 *     where "a bin reminder at the wrong hour is worse than no bin reminder".
 *     The server does not know the family's timezone and this brief is not the
 *     place to start storing one.
 *   - NOTHING IS GRANTED. A promo day buys a free month; a bin-day completion
 *     buys the absence of a takeover. There is no economic incentive to forge
 *     it, and the worst case is a family member clearing their own household's
 *     reminder early — which they could also do by tapping OK.
 *
 * WARNING: So the clock is trusted only as far as it is cheap to be wrong about. This
 * window bounds it: a forged key cannot pre-clear a bin day weeks out, which is
 * the one abuse that would be invisible until the bins were missed. ±2 days
 * covers every real timezone offset (max ±14h) plus a day either side of
 * midnight, and nothing beyond that is a timezone.
 */
export const BIN_DATE_MAX_SKEW_DAYS = 2;

/** The shared fact, as stored at `families/{familyId}/trashDay/{binDateKey}`. */
export interface TrashDayCompletion {
  /** `YYYY-MM-DD`, and also the document id. Dated for the same reason
   * `acknowledgedFor` is: a bool cannot tell this week from three weeks ago,
   * so next week's reminder would arrive pre-dismissed. */
  binDateKey: string;
  /** Who actually took the bins out. */
  completedByUid: string;
  /** Server clock, milliseconds. */
  completedAtMs: number;
}

export type TrashDayRefusal =
  | 'not-a-member'
  | 'invalid-family'
  | 'malformed-bin-date'
  | 'bin-date-out-of-range';

export type TrashDayPlan =
  | {
      ok: true;
      /** True when this call is what completed it; false when it already was. */
      wrote: boolean;
      completion: TrashDayCompletion;
      /**
       * Everyone the completion clears it for — this family's members, and
       * nobody else.
       *
 * KEY: RETURNED EXPLICITLY RATHER THAN LEFT IMPLICIT, so that "clears for
       * all" and "clears for anyone" are different assertions. A test can name
       * the set; it cannot name an absence.
       */
      clearsFor: string[];
    }
  | {ok: false; refusal: TrashDayRefusal};

/** `YYYY-MM-DD` for a UTC date. Used to bound a submitted key, never to set one. */
export function utcBinDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days between two `YYYY-MM-DD` keys, or null if either is unparseable. */
export function binDateKeySkewDays(a: string, b: string): number | null {
  const pa = Date.parse(`${a}T00:00:00Z`);
  const pb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(pa) || !Number.isFinite(pb)) return null;
  return Math.abs(pa - pb) / 86_400_000;
}

/**
 * Whether [key] is a real `YYYY-MM-DD` date and not merely shaped like one.
 *
 * WARNING: THE PATTERN ALONE IS NOT ENOUGH, and the gap is not theoretical:
 * `2026-02-31` and `2026-13-01` both match `\d{4}-\d{2}-\d{2}`. `Date.parse`
 * accepts the first and rolls it to March 3rd, so a document id that never
 * names a real day would be created and every later lookup for the real date
 * would miss it. Round-tripping is what catches that.
 */
export function isValidBinDateKey(key: unknown): key is string {
  if (typeof key !== 'string' || !BIN_DATE_KEY_PATTERN.test(key)) return false;
  const parsed = Date.parse(`${key}T00:00:00Z`);
  if (!Number.isFinite(parsed)) return false;
  return utcBinDateKey(parsed) === key;
}

/**
 * What one member's "I did it" should do, for the family they are in.
 *
 * CRITICAL: THE NON-MEMBER CHECK IS THE WHOLE FEATURE, NOT A VALIDATION. Without it
 * "clears for all" and "clears for anyone" are the same function — any
 * authenticated account could clear any household's bin day, and the failure
 * would be invisible until someone's bins were not put out. It is checked
 * against `memberUids` on the ONE group document, which is the only place a
 * membership question has a single answer (see family.ts).
 *
 * WARNING: Fails CLOSED on an invalid family. A malformed roster is not a reason to
 * treat the caller as a member of it.
 *
 * IDEMPOTENT, AND IT PRESERVES THE FIRST COMPLETER. A second call for the same
 * bin date succeeds with `wrote: false` and returns the ORIGINAL completion
 * rather than overwriting it. Two reasons: the shared fact is "the bins are
 * out", which a second person cannot make more true; and "who did it" is the
 * half a family will actually argue about, so the record should say who was
 * first rather than who tapped last.
 *
 * Pure: the clock is a parameter and nothing is read or written here.
 */
export function planTrashDayCompletion(args: {
  family: FamilyDoc;
  actorUid: string;
  binDateKey: unknown;
  nowMs: number;
  existing: TrashDayCompletion | null;
}): TrashDayPlan {
  const {family, actorUid, binDateKey, nowMs, existing} = args;

  if (!isValidFamily(family)) return {ok: false, refusal: 'invalid-family'};

  // Membership BEFORE the date checks, deliberately: a non-member should not be
  // able to learn whether a date was well-formed, and the cheaper refusal is
  // the less informative one.
  if (!family.memberUids.includes(actorUid)) {
    return {ok: false, refusal: 'not-a-member'};
  }

  if (!isValidBinDateKey(binDateKey)) {
    return {ok: false, refusal: 'malformed-bin-date'};
  }

  const skew = binDateKeySkewDays(binDateKey, utcBinDateKey(nowMs));
  if (skew === null || skew > BIN_DATE_MAX_SKEW_DAYS) {
    return {ok: false, refusal: 'bin-date-out-of-range'};
  }

  // Scoped to THIS family's roster. The document is keyed under the family too,
  // so another family's record is unreachable from here by construction rather
  // than by filtering — but the set is returned so a test can assert it.
  const clearsFor = [...family.memberUids];

  if (existing && existing.binDateKey === binDateKey) {
    return {ok: true, wrote: false, completion: existing, clearsFor};
  }

  return {
    ok: true,
    wrote: true,
    completion: {binDateKey, completedByUid: actorUid, completedAtMs: nowMs},
    clearsFor,
  };
}

/** Human-facing refusal text, and the callable's error code for each. */
export const TRASH_DAY_REFUSALS: Record<
  TrashDayRefusal,
  {code: 'permission-denied' | 'invalid-argument' | 'failed-precondition'; message: string}
> = {
  'not-a-member': {
    code: 'permission-denied',
    message: 'You are not in this family.',
  },
  'invalid-family': {
    code: 'failed-precondition',
    message: 'That family record is not usable.',
  },
  'malformed-bin-date': {
    code: 'invalid-argument',
    message: 'That is not a valid bin date.',
  },
  'bin-date-out-of-range': {
    code: 'invalid-argument',
    message: 'That bin date is too far from today.',
  },
};

// ---------------------------------------------------------------------------
// RECONCILIATION — the contract between the shared fact and the local cache
// ---------------------------------------------------------------------------
//
// W2-81, and it closes the residual this file's own header opened:
//
//   "today `acknowledgedFor` lives in SharedPreferences (trash_day_provider.dart,
//    `_kAckKey`), on-device only. It never reaches a server at all. […] the local
//    copy should be treated as a cache of this, never the reverse: a device that
//    has not synced must not be able to un-clear what a housemate cleared."
//
// ---------------------------------------------------------------------------
// CRITICAL: "SERVER WINS" IS THE WRONG RULE, AND THE ASYMMETRY IS THE WHOLE CONTRACT
// ---------------------------------------------------------------------------
//
// The obvious reading — the server is authoritative, so its answer replaces the
// local one — is correct in one direction and actively harmful in the other:
//
//   THE SERVER IS AUTHORITATIVE FOR **CLEARED**, AND FOR NOTHING ELSE.
//   ABSENCE OF A SERVER RECORD IS NEVER EVIDENCE THAT NOBODY DID IT.
//
// If the server were authoritative for NOT-cleared, then a member who tapped OK
// while offline — or while `familyId` is still unstamped, which is TODAY for
// every user — would have their acknowledgement overwritten by an empty read
// and be shown the takeover again. That is the same nagging failure the dated
// ack exists to prevent, arriving from the other side.
//
// KEY: SO THE RULE IS A UNION, NOT A PRECEDENCE. Both sources are POSITIVE
// evidence that the bins went out; neither one's silence is evidence that they
// did not. Cleared if EITHER says cleared. A client implements that without
// judgement, which is what the brief asked for, and it makes the un-clear
// failure structurally impossible rather than merely discouraged: there is no
// input to this function in which a local value causes a server completion to
// be ignored.
//
// NOTE: AND THE SERVER CANNOT BE MADE TO FORGET, WHICH IS WHAT MAKES THE UNION
// SAFE. Verified rather than assumed: `families/{familyId}/trashDay/{key}` is
// `allow write: if false` to every client; the ONLY writer is completeTrashDay
// (index.ts:3832); `planTrashDayCompletion` is idempotent and returns the
// EXISTING completion rather than overwriting it; and no delete path exists
// anywhere in functions/. So a completion, once written, is permanent — an
// un-clear has no server-side mechanism to travel through at all.
//
// ---------------------------------------------------------------------------
// WARNING: WHICH CLOCK — AND THE ANSWER IS "NEITHER, BY CONSTRUCTION"
// ---------------------------------------------------------------------------
//
// The bin date is a LOCAL calendar date about a physical event, deliberately
// (see BIN_DATE_MAX_SKEW_DAYS above). So the key is minted on the device in the
// device's local time, and everything here compares KEYS AS OPAQUE STRINGS and
// never re-derives an instant from one. That is not laziness — parsing a key to
// a timestamp is exactly how a comparison acquires a timezone it should not
// have, and this module has both a UTC helper and a local key in scope, which
// is precisely the confusion that produced the W2-80 anchor bug.
//
// NOTE: A STALE LOCAL ACK IS HARMLESS, AND IT IS WORTH SHOWING WHY RATHER THAN
// TRUSTING IT. `nextBinDate` (trash_day_reminder.dart) returns TODAY when today
// is bin day and otherwise a FUTURE date — it never returns a past one. So the
// only ack that can suppress anything is one for the current bin date, and an
// ack for a bygone date cannot match. This function therefore compares against
// the bin date in question rather than "recency", and needs no expiry rule.
//
// WARNING: THE COROLLARY IS A REAL LOSS AND IS NOT PAPERED OVER: a device offline
// past its bin day cannot sync that day's ack, because the ±2-day skew window
// refuses it. That is CORRECT for clearing — the takeover has already moved to
// the next bin date, so there is nothing left to clear — but the record of WHO
// took the bins out is lost for that day. The window is exactly sufficient for
// the acks that can still matter (the takeover opens the night before, so a
// live ack is at most a day out, plus one for any real UTC offset) and
// deliberately insufficient for the ones that cannot.

/** Which source, if any, says the bins went out for the bin date in question. */
export type TrashDayClearedBy = 'server' | 'local' | null;

export interface TrashDayReconciliation {
  /** Whether the takeover should be suppressed for this bin date. */
  cleared: boolean;
  /**
 * KEY: `'server'` WINS THE LABEL WHENEVER THE SERVER HAS A RECORD, even if the
   * local ack agrees. The label is what a client shows ("Sam took them out"),
   * and the server copy is the one that names a person.
   */
  clearedBy: TrashDayClearedBy;
  /** Present only when the server has the record — who, and when. */
  completion: TrashDayCompletion | null;
  /**
   * The client holds an ack the server has never heard of, so it should call
   * `completeTrashDay`. False when the server already knows: re-pushing a known
   * completion is a wasted call that cannot change the record anyway, since the
   * first completer is preserved.
   */
  mustPush: boolean;
  /**
   * The local cache should be updated to this bin date because the SERVER says
   * cleared and the device does not yet know. This is the "cache of the server"
   * direction, and it is the only direction in which a local value is replaced.
   */
  mustCacheLocally: boolean;
}

/**
 * Reconcile the shared completion with a device's local acknowledgement.
 *
 * CRITICAL: THIS IS A NORMATIVE SPECIFICATION, NOT A CALLABLE THE CLIENT INVOKES. Dart
 * cannot call it; W1 ports the rule. It lives here, in the same module as the
 * writer it reconciles with, so the contract and its tests sit beside the thing
 * that has to honour them — and so a change to one shows up as a red test on
 * the other rather than as drift between a doc and an implementation.
 *
 * Pure, and it reads no clock: the caller supplies the bin date under
 * consideration, which is `nextBinDate(now)` on the device.
 *
 * @param binDateKey the bin date being asked about — `YYYY-MM-DD`, local.
 * @param serverCompletion what `families/{familyId}/trashDay/{binDateKey}` holds,
 *        or null when the document is absent OR THE READ FAILED. Those two are
 *        deliberately the same input: an unreachable server and an empty one
 *        must behave identically, or offline becomes a distinct code path that
 *        nobody tests.
 * @param localAckBinDateKey the device's `acknowledgedFor`, as a local date key,
 *        or null.
 */
export function reconcileTrashDay(args: {
  binDateKey: string;
  serverCompletion: TrashDayCompletion | null;
  localAckBinDateKey: string | null;
}): TrashDayReconciliation {
  const {binDateKey, serverCompletion, localAckBinDateKey} = args;

  // A completion for a DIFFERENT date says nothing about this one. Guarding it
  // here means a caller that hands over last week's document cannot accidentally
  // clear this week — the same reason the ack is dated at all.
  const serverSaysCleared =
    serverCompletion != null && serverCompletion.binDateKey === binDateKey;
  const localSaysCleared =
    localAckBinDateKey != null && localAckBinDateKey === binDateKey;

  return {
    // The union. Note there is no branch in which `localSaysCleared` can make
    // this false — that is the un-clear failure, and it is unreachable by
    // construction rather than by a check.
    cleared: serverSaysCleared || localSaysCleared,
    clearedBy: serverSaysCleared ? 'server' : localSaysCleared ? 'local' : null,
    completion: serverSaysCleared ? serverCompletion : null,
    mustPush: localSaysCleared && !serverSaysCleared,
    mustCacheLocally: serverSaysCleared && !localSaysCleared,
  };
}
