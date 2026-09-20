// ---------------------------------------------------------------------------
// Per-task completion rewards — config + server-side grant helper
// ---------------------------------------------------------------------------
//
// Completing a cleaning task is the core verb of the app, and until this
// module existed it paid almost nothing: recordTaskCompletion wrote no sponges
// at all, and gated XP behind `if (dayAdvanced)` so only the FIRST task of a
// day earned anything. Tasks two through eight paid literally zero, which is
// the opposite incentive a habit app wants.
//
// WHY THE GRANT IS DERIVED FROM TASK DOCS, NOT FROM CALL COUNT
//
// recordTaskCompletion's payload is `{ clientNowIso }` — it carries NO taskId.
// The client can also un-complete a task (`markPending` in task_provider.dart)
// with no server call whatsoever. So complete → uncomplete → complete re-fires
// the callable, and counting invocations cannot tell eight distinct tasks from
// one task toggled eight times. Paying per invocation would make a single task
// an unbounded sponge faucet.
//
// Instead the server reads users/{uid}/tasks itself and counts DISTINCT task
// documents completed today. Re-toggling one task never raises that count, so
// the exploit collapses without needing a client change or a new callable
// argument. A daily cap bounds the remaining surface (mass-creating task docs)
// to the same ceiling as legitimate play.
//
// The ledger at users/{uid}/economy/taskRewards records how many completions
// have already been paid for the day; each call pays only the delta. That is
// the idempotency guard — the equivalent of the streak's `gap == 0` no-op.

import * as admin from 'firebase-admin';
// Modular import — see the note in index.ts: the emulator's admin proxy drops
// the statics off `admin.firestore`.
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { XP_TASK } from './xp';
import { BONUS_TASK_MULTIPLIER, bonusTaskIdFor } from './dailyBonusTask';

/** Sponges granted per distinct task completed, up to the daily cap. */
export const TASK_SPONGE_REWARD = 5;

/**
 * Maximum task completions that PAY OUT in one calendar day, by tier.
 *
 * KEY: THE TIER LEVER MOVED HERE ON 2026-08-10, and the product reason matters.
 * The subscription used to sell `dailyTaskSlots` — how many tasks you were
 * ALLOWED to do. NOTE: Those numbers were free 1 / pro 5 / premium 10, and they
 * describe the RETIRED lever, not this table — they are past tense on purpose
 * and are NOT stale. `PAID_TASK_CAP_BY_TIER` below is the live one, and the two
 * are different quantities: slots you may USE versus completions that PAY.
 * Brendan's direction: a player
 * should be able to clean as much as they like, and simply stop earning once
 * the day's allowance is spent. So the cap moved from *doing* to *earning*.
 *
 * That keeps the subscription meaningful (it now sells sponges per day rather
 * than permission to tidy) and removes the strange incentive to stop cleaning,
 * which is the opposite of what a habit app wants.
 *
 * WARNING: FOR SCALE, AND DELIBERATELY WITHOUT ARITHMETIC. A player's daily earning
 * is `PAID_TASK_CAP_BY_TIER[tier] × TASK_SPONGE_REWARD`; a chest is 100 sponges
 * and a streak shield 150. Work it out from the constants — do not restate it
 * here.
 *
 * CRITICAL: THE LINE THAT USED TO SIT HERE SAID "Free tops out at 40/day, so an active
 * free player affords a chest in ~2.5 days" AND HAD BEEN WRONG BY 8× FOR TWO
 * RELEASES. It was written in #128 when the free cap was 8 (8 × 5 = 40), and it
 * survived #318 lowering that cap to 4 and #341 lowering it to 1 — because a
 * comment restating a DERIVED number has nothing tying it to the numbers it was
 * derived from. Free actually earns 5/day now, so that chest is 20 days, not
 * 2.5.
 *
 * KEY: SO THE FIX IS NOT A NEW NUMBER — a new number goes stale the next time a
 * cap moves. It is to name the CONSTANTS and let the reader compute, which is
 * the only form of this sentence that cannot silently drift. Nothing reads
 * prose, so prose must not carry values that can be checked.
 */
export const PAID_TASK_CAP_BY_TIER: Record<string, number> = {
  free: 1,
  pro: 4,
};

/** Cap for an unknown or missing tier string — treat as free, never as paid. */
export const DEFAULT_PAID_TASK_CAP = PAID_TASK_CAP_BY_TIER.free;

/**
 * Retired tier strings that may still be stored on a user document.
 *
 * WARNING: DECODED, NOT DELETED, and the distinction is the whole point. `premium`
 * retired in #314, but documents written before then still carry it, and
 * nothing migrates them. Deleting the string without decoding it would send
 * those users through the fail-closed default below and drop them to the FREE
 * cap — that is a downgrade for someone who paid, not a retirement.
 *
 * Mapping it to `pro` matches what the client already does, so the two halves
 * agree about a stored `premium` instead of disagreeing silently.
 */
export const LEGACY_TIER_ALIASES: Record<string, string> = {
  premium: 'pro',
};

/**
 * The current tier string for a possibly-legacy stored value.
 *
 * WARNING: Fails CLOSED for a non-string, and passes an UNRECOGNISED string through
 * unchanged so the caller's own fail-closed default decides. It resolves
 * history; it does not grant anything.
 */
export function normalizeTier(tier: unknown): string {
  if (typeof tier !== 'string') return 'free';
  return LEGACY_TIER_ALIASES[tier] ?? tier;
}

/**
 * `subscriptionExpiresAt` in milliseconds, or null if it cannot be read.
 *
 * WARNING: RETURNING NULL IS THE FAIL-CLOSED PATH, and every branch that cannot
 * produce a finite number takes it. The field arrives in more than one shape:
 * `verifySubscriptionReceipt` writes a Firestore `Timestamp`, this suite's
 * hand-rolled admin mock writes `{ _type: 'ts', ms }`, and the Dart `User`
 * entity serialises the SAME field name as an ISO8601 string
 * (`lib/domain/entities/user.g.dart`). A resolver that understood only one of
 * them would silently lapse everyone whose document used another.
 */
function expiryMillis(value: unknown): number | null {
  const finite = (n: unknown): number | null =>
    typeof n === 'number' && Number.isFinite(n) ? n : null;

  if (value == null) return null;
  if (typeof value === 'number') return finite(value);
  if (value instanceof Date) return finite(value.getTime());
  if (typeof value === 'string') {
    return finite(Date.parse(value));
  }
  if (typeof value === 'object') {
    const obj = value as { toMillis?: unknown; ms?: unknown };
    if (typeof obj.toMillis === 'function') {
      return finite((obj.toMillis as () => unknown)());
    }
    // The `{ _type: 'ts', ms }` sentinel the unit suite's admin mock produces.
    if ('ms' in obj) return finite(obj.ms);
  }
  return null;
}

/**
 * The tier a user is entitled to RIGHT NOW, from their `users/{uid}` document.
 *
 * KEY: THIS IS THE ONLY AUTHORITY ON ENTITLEMENT. The stored `subscriptionTier`
 * is an audit record of what was last granted; it is not a permission, because
 * nothing rewrites it when a subscription ends. Before W2-67 every consumer
 * read that field directly and `subscriptionExpiresAt` was written by
 * `verifySubscriptionReceipt` and read by NOTHING — so a subscriber who
 * cancelled months ago kept the paid task cap and the paid invite allowance
 * indefinitely, and was still refused the free tier's weekly gift.
 *
 * WARNING: Fails CLOSED, and that includes a MISSING or unreadable expiry: a paid
 * tier the server cannot date is not a paid tier. The one thing failing closed
 * does NOT mean is refusing a benefit — see `claimWeeklyGift`, where free is
 * the tier that gets paid, and resolving to free correctly pays it.
 *
 * Decoding runs BEFORE the clock ([normalizeTier]), so a legacy `premium`
 * document is dated as the `pro` it means rather than falling to free for the
 * wrong reason.
 *
 * The clock is a parameter, not `Date.now()` inside. An expiry boundary tested
 * against the real clock is a test that passes for a different reason on every
 * run, and the `<=` boundary below is the one thing here worth pinning exactly.
 * It matches the grant-time check in `verifySubscriptionReceipt`: an
 * entitlement that is exactly used up is used up.
 */
export function resolveEffectiveTier(data: unknown, nowMs: number): string {
  const doc = (data ?? undefined) as Record<string, unknown> | undefined;

  // A live family grant is a SOURCE of pro, not a tier — see family.ts. It is
  // checked FIRST and independently of the stored tier, because the whole
  // point is that a member with no subscription of their own is entitled.
  // Dated by the same clock and the same `<=` boundary as the paid path, so a
  // family grant lapses on its own without anything having to run.
  if (familyProActive(doc, nowMs)) return 'pro';

  const tier = normalizeTier(doc?.subscriptionTier);
  if (tier === 'free') return 'free';

  const expiresMs = expiryMillis(doc?.subscriptionExpiresAt);
  if (expiresMs === null || expiresMs <= nowMs) return 'free';
  return tier;
}

/**
 * The tier this account pays for ITSELF, ignoring any family grant.
 *
 * CRITICAL: THIS IS NOT `resolveEffectiveTier` AND THE DIFFERENCE IS A HOLE IF YOU USE
 * THE WRONG ONE. `resolveEffectiveTier` answers "is this account entitled",
 * which is correct for granting a feature and WRONG for asking "can this
 * account fund a family". A member of someone else's family has
 * `familyProExpiresAt` copied onto them, so they resolve to `pro` while paying
 * nothing.
 *
 * Gate `createFamily` on the effective tier and the failure is exactly the one
 * the gate exists to prevent: a member of family A passes the check, creates
 * family B, and B is an EMPTY SHELL that grants nobody anything — the fan-out
 * only ever runs on a notification for the owner's OWN family product, and B's
 * owner has none. The check would admit the case it was written to reject.
 *
 * NOTE: It is deliberately the same code as `resolveEffectiveTier` with the family
 * branch removed, and it sits here rather than in family.ts so the two are
 * visibly siblings. A reader comparing them sees one difference, which is the
 * whole point.
 */
export function resolveOwnPaidTier(data: unknown, nowMs: number): string {
  const doc = (data ?? undefined) as Record<string, unknown> | undefined;

  const tier = normalizeTier(doc?.subscriptionTier);
  if (tier === 'free') return 'free';

  const expiresMs = expiryMillis(doc?.subscriptionExpiresAt);
  if (expiresMs === null || expiresMs <= nowMs) return 'free';
  return tier;
}

/**
 * The owner's OWN paid expiry in milliseconds, or null when they are not paying.
 *
 * CRITICAL: THE COMPANION TO `resolveOwnPaidTier`, AND IT EXISTS FOR THE SAME REASON.
 * A family grant is the owner's expiry COPIED, so the copy must come from what
 * the owner PAYS FOR. Reading `familyProExpiresAt` here instead would let a
 * family whose owner is themselves a member of another family grant off a
 * COPIED GRANT — entitlement chaining one family off another's subscription,
 * with no payer anywhere in the chain beyond the first.
 *
 * NOTE: Returns null rather than 0 for "not paying", so a caller cannot
 * accidentally treat it as an expiry in 1970 that merely looks lapsed. The
 * fan-out's `entitled` check tests `!== null` explicitly.
 */
export function resolveOwnPaidExpiryMs(data: unknown, nowMs: number): number | null {
  const doc = (data ?? undefined) as Record<string, unknown> | undefined;

  if (resolveOwnPaidTier(doc, nowMs) === 'free') return null;
  return expiryMillis(doc?.subscriptionExpiresAt);
}

/**
 * Whether this user document carries a family Pro grant that is live at
 * [nowMs].
 *
 * KEY: THE FIELD IS A DATE, NEVER A FLAG, AND THAT IS THE SAFETY ARGUMENT. It is
 * written by the family fan-out (`planFamilyFanOut` in family.ts) as a COPY of
 * the family owner's own `subscriptionExpiresAt`, so a member can never be
 * entitled past the period the owner actually paid for — even if no revoke
 * ever runs. A boolean would fail OPEN forever and would need code to execute
 * in order to revoke, which is precisely the assumption a refund cannot make.
 *
 * WARNING: Fails CLOSED on an unreadable value, via the same `expiryMillis` decoder
 * as the paid path — not a second one. `familyProExpiresAt` is CF-owned in
 * firestore.rules for the same reason `subscriptionExpiresAt` is: a client
 * that could write it would grant itself Pro indefinitely, and would not even
 * need a family to do it.
 */
function familyProActive(
  doc: Record<string, unknown> | undefined,
  nowMs: number,
): boolean {
  const familyExpiresMs = expiryMillis(doc?.familyProExpiresAt);
  return familyExpiresMs !== null && familyExpiresMs > nowMs;
}

/**
 * The paid-completion cap for [tier].
 *
 * WARNING: Fails CLOSED. A missing, misspelled or future tier string resolves to the
 * free cap, never to the most generous one — the same direction
 * `subscriptionTierProvider` fails on the client, where loading and error both
 * report free.
 *
 * A retired tier is decoded first ([normalizeTier]), so `premium` resolves to
 * the `pro` cap rather than falling through to free. Fail-closed is the right
 * direction for a string nobody recognises; it is the wrong direction for one
 * this project issued and then retired.
 */
export function paidTaskCapFor(tier: unknown): number {
  if (typeof tier !== 'string') return DEFAULT_PAID_TASK_CAP;
  return PAID_TASK_CAP_BY_TIER[normalizeTier(tier)] ?? DEFAULT_PAID_TASK_CAP;
}

// ---------------------------------------------------------------------------
// CRITICAL: THE DAY KEY — BOUNDED AND RATCHETED, NOT SERVER-DERIVED
// ---------------------------------------------------------------------------
//
// `recordTaskCompletion` used to take the caller's `clientNowIso`, slice ten
// characters off it and use that as the reward day key. The caller therefore
// CHOSE which day it was being paid for, and every counter below resets when
// the key changes — so alternating two well-formed dates re-minted the day's
// pay. Measured (W2-173): 15 sponges against a free cap of 5, one account,
// three calls.
//
// KEY: WHY THE OBVIOUS FIX IS WRONG, AND THIS IS NOT AN OPINION. A server-derived
// UTC key was the prescribed repair and it was DISPROVED before it shipped.
// `dayKey` is not only a ledger key here; it is the QUERY key over
// `users/{uid}/tasks.completedDate`, and the CLIENT stamps that field from a
// bare local `DateTime.now()` (task_repository_impl.dart:40). A UTC key matches
// none of a Los Angeles player's completions after 17:00 local, nor an Auckland
// player's before 13:00 — so `distinctCompleted` reads 0 and they are paid
// NOTHING, every single day, in the peak cleaning window. The comment at the
// head of `grantTaskRewards` predicted exactly this about a four-hour version of
// the same mistake; UTC is that mistake with a sixteen-hour offset.
//
// OK: SO THE CLIENT KEEPS NAMING ITS OWN LOCAL DAY, AND THE KEY IS BOUNDED
// INSTEAD. Real UTC offsets span UTC-12 to UTC+14, so an honest local calendar
// date is always within one day of the server's UTC date. Admitting exactly
// that window changes nothing for anybody real and takes the fabricable supply
// from infinite to three.
//
// WARNING: THE RESIDUAL, STATED RATHER THAN HIDDEN. Three admitted keys plus the
// per-day ledger means a determined caller can pull forward at most TWO extra
// days of cap, ONCE — after which each real day admits exactly one new key and
// the long-run rate is the honest one. Deploy 3 of
// `Projects/Cleaning/dayKey-migration-2026-09-13.md` removes even that, by
// dropping the client key once `setTimezone` coverage is high enough to derive
// the day server-side WITHOUT the UTC defect above.

/**
 * How far from the server's own UTC date a client day key may sit.
 *
 * NOTE: ONE, AND ONE IS ENOUGH FOR EVERY INHABITED OFFSET. The widest real offsets
 * are UTC-12 (Baker Island) and UTC+14 (Line Islands), and a calendar date can
 * differ from UTC's by at most one day at either extreme. Two would admit a
 * fourth fabricable key and buy nothing.
 */
export const MAX_DAY_KEY_DRIFT_DAYS = 1;

/** Midnight UTC of the `YYYY-MM-DD` key [day], in milliseconds, or NaN. */
function dayKeyMillis(day: string): number {
  return Date.parse(`${day}T00:00:00.000Z`);
}

/** The server's own UTC calendar date at [nowMs], as `YYYY-MM-DD`. */
export function serverDayKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * The reward day key for [clientNowIso], refused if it is not near [serverNowMs].
 *
 * CRITICAL: PURE, AND CALLED BEFORE ANYTHING IS WRITTEN. Every rejection here must cost
 * the caller nothing at all — no streak write, no ledger write, no partial
 * anything — which is only true while this stays a function of its two
 * arguments and runs first. See `recordTaskCompletion`.
 *
 * WARNING: The shape check is not decoration. `Date.parse` accepts a great deal and
 * returns NaN for the rest, and `'2026-13-45'.slice(0, 10)` looks exactly like a
 * date; both paths below refuse rather than reaching Firestore with a key that
 * would silently match no task document and pay zero.
 */
export function boundedDayKey(clientNowIso: unknown, serverNowMs: number): string {
  if (typeof clientNowIso !== 'string') {
    throw new HttpsError('invalid-argument', 'clientNowIso required');
  }
  const dayKey = clientNowIso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey)) {
    throw new HttpsError(
      'invalid-argument',
      `clientNowIso must start with a YYYY-MM-DD date; got "${dayKey}"`,
    );
  }

  const keyMs = dayKeyMillis(dayKey);
  const serverMs = dayKeyMillis(serverDayKey(serverNowMs));
  if (!Number.isFinite(keyMs) || !Number.isFinite(serverMs)) {
    throw new HttpsError('invalid-argument', `unparseable day key "${dayKey}"`);
  }

  const driftDays = Math.round((keyMs - serverMs) / 86_400_000);
  if (Math.abs(driftDays) > MAX_DAY_KEY_DRIFT_DAYS) {
    throw new HttpsError(
      'invalid-argument',
      `day key "${dayKey}" is ${driftDays} day(s) from the server date; ` +
        `at most ${MAX_DAY_KEY_DRIFT_DAYS} is accepted`,
    );
  }
  return dayKey;
}

/**
 * How long a per-day ledger document is kept, for the `expireAt` TTL policy.
 *
 * NOTE: THE FIELD IS WRITTEN HERE; THE POLICY IS AN OPS ACTION AND IS NOT APPLIED.
 * Firestore TTL is enabled per field from the console or
 * `gcloud firestore fields ttls update expireAt --collection-group=days
 * --enable-ttl`. Writing the field costs one property and makes that command a
 * one-liner later; without it, enabling TTL would need a code change AND a
 * backfill.
 *
 * WARNING: 400 DAYS, NOT 90, AND THE REASON IS DEPLOY 2. The migration's next step
 * points the streak page at these documents, and a streak is a year-scale
 * object — reaping at 90 days would silently truncate the history the feature
 * is being moved onto. Over a year of days is ~365 documents per player, each a
 * handful of integers.
 */
export const DAY_LEDGER_TTL_DAYS = 400;

/** The stored shape of `users/{uid}/days/{dayKey}` — all three counters. */
interface DayLedger {
  paidCount: number;
  xpPaidCount: number;
  bonusPaid: boolean;
}

/**
 * The three counters already settled for [dayKey].
 *
 * KEY: THE MIGRATION LIVES HERE, AND OMITTING IT WOULD PAY THE ENTIRE ACTIVE
 * POPULATION TWICE. Before this change the counters lived on ONE document,
 * `users/{uid}/economy/taskRewards`, stamped with a `date` field. Every player
 * mid-day at deploy time has that document and no `days/{dayKey}` document at
 * all, so reading only the new path would read them as unpaid and re-grant the
 * whole day — a one-off mint caused by the fix itself. The legacy document is
 * therefore read as the fallback baseline, and ONLY when its `date` is the day
 * being settled.
 *
 * NOTE: The legacy document is never written again after this: the day document is
 * the authority, and once it exists the fallback is unreachable for that day.
 * Its old fields are left in place rather than deleted — a delete would be a
 * second write on every completion to tidy a value nothing reads.
 */
function settledCounters(
  day: FirebaseFirestore.DocumentData | undefined,
  legacy: FirebaseFirestore.DocumentData | undefined,
  dayKey: string,
): DayLedger {
  const base = day ?? (legacy?.date === dayKey ? legacy : undefined);
  return {
    paidCount: (base?.paidCount as number) ?? 0,
    xpPaidCount: (base?.xpPaidCount as number) ?? 0,
    bonusPaid: (base?.bonusPaid as boolean) ?? false,
  };
}

export interface TaskRewardGrant {
  /** Sponges credited by THIS call (0 when already paid or capped out). */
  sponges: number;
  /** XP credited by THIS call. */
  xp: number;
  /** Distinct completions paid for so far today, after this call. */
  paidCount: number;
  /** True when the day's cap is now reached — the client may say "all done". */
  capped: boolean;
  /** Today's 2x task, so the client can gild the right row without guessing. */
  bonusTaskId: string | null;
  /** Whether the 2x extra has been collected today. */
  bonusPaid: boolean;
}

/**
 * Server-only. Grants sponges and XP for any task completions on [dayKey] that
 * have not been paid for yet, up to the tier's cap ([paidTaskCapFor]).
 *
 * One task a day is the BONUS task ([bonusTaskIdFor]) and pays
 * [BONUS_TASK_MULTIPLIER]x. It is paid at most once per day, tracked by
 * `bonusPaid` on the same ledger, and it counts as one ordinary paid
 * completion as well — so it does not raise the day's ceiling, it enriches one
 * slot inside it.
 *
 * [dayKey] is a plain `YYYY-MM-DD` calendar date. It deliberately does NOT use
 * the streak system's 4 AM cutoff (`streakDate`): it has to match the
 * `completedDate` field the client writes onto task docs, which comes from a
 * bare `DateTime.now()` with no cutoff. Keying the reward ledger off a
 * different day boundary than the documents it counts would mis-pay every
 * completion between midnight and 4 AM.
 *
 * Reads and writes run in one transaction so two rapid completions cannot both
 * observe the same `paidCount` and double-pay.
 */
export async function grantTaskRewards(
  uid: string,
  dayKey: string,
): Promise<TaskRewardGrant> {
  const db = admin.firestore();
  // The per-day ledger. A fabricated day can be settled ONCE EVER, because a new
  // day is a new document id rather than a `date` field that a different key
  // resets — which is the whole mechanism the rotation exploited.
  const dayRef = db.doc(`users/${uid}/days/${dayKey}`);
  // Kept as the ledger INDEX: the ratchet's high-water mark, and the pre-migration
  // counters. Already CF-only in firestore.rules (`match /economy/{doc=**}`).
  const indexRef = db.doc(`users/${uid}/economy/taskRewards`);
  const profileRef = db.doc(`users/${uid}/profile/data`);
  const completedToday = db
    .collection(`users/${uid}/tasks`)
    .where('completedDate', '==', dayKey);

  return db.runTransaction(async (tx) => {
    const userRef = db.doc(`users/${uid}`);
    const [daySnap, indexSnap, tasksSnap, userSnap] = await Promise.all([
      tx.get(dayRef),
      tx.get(indexRef),
      tx.get(completedToday),
      tx.get(userRef),
    ]);

    // -----------------------------------------------------------------------
    // CRITICAL: THE RATCHET. Read INSIDE the transaction, so two concurrent calls
    // cannot both observe the same high-water mark and both step backwards.
    // -----------------------------------------------------------------------
    //
    // The per-day document already makes a replayed key pay zero. This makes it
    // FAIL LOUDLY instead, which matters because a silent zero is
    // indistinguishable from an honest replay and tells nobody anything.
    //
    // WARNING: IT READS `maxDayKey` AND DELIBERATELY NOT THE LEGACY `date`. `maxDayKey`
    // is written only by the code below, which means it has already passed
    // `boundedDayKey` and can never sit more than one day ahead of the server.
    // The legacy `date` has no such guarantee — it was written by the very
    // callable that let the caller choose, so an account that rotated to 2030
    // before this shipped carries 2030 there. Seeding the ratchet from it would
    // lock that account out of earning PERMANENTLY, since the high-water would
    // stay ahead of the server clock forever. Ignoring it costs nothing: the
    // day document still bounds the money.
    //
    // NOTE: Lexicographic comparison IS chronological for `YYYY-MM-DD`, which is
    // why the format check in `boundedDayKey` is load-bearing rather than
    // cosmetic. Strictly less-than: the same key again is an ordinary replay
    // (a second task on the same day) and must be allowed.
    const maxDayKey: unknown = indexSnap.data()?.maxDayKey;
    if (typeof maxDayKey === 'string' && dayKey < maxDayKey) {
      throw new HttpsError(
        'failed-precondition',
        `day key "${dayKey}" is earlier than this account's last settled day ` +
          `"${maxDayKey}"`,
      );
    }

    // The EFFECTIVE tier, not the stored one: a lapsed subscription pays the
    // free cap. See resolveEffectiveTier — the stored string is an audit record.
    const cap = paidTaskCapFor(resolveEffectiveTier(userSnap.data(), Date.now()));

    // Distinct task documents marked complete today. Toggling one task off and
    // on again leaves this number unchanged, which is the whole point.
    const distinctCompleted = tasksSnap.size;

    // KEY: ONE RESOLUTION FOR ALL THREE COUNTERS, WHICH IS THE FIX. Each of them
    // used to carry its own `ledger?.date === dayKey ? … : 0`, so each was
    // independently re-mintable by a rotated key — and the XP one silently, since
    // nobody counts XP the way they count sponges. They now come from one
    // document whose IDENTITY is the day, so there is no comparison left to get
    // wrong and no way to close one and miss the others.
    const settled = settledCounters(daySnap.data(), indexSnap.data(), dayKey);
    const alreadyPaid: number = settled.paidCount;

    const eligible = Math.min(distinctCompleted, cap);
    const newlyPaid = Math.max(0, eligible - alreadyPaid);

    // ---------------------------------------------------------------------
    // XP IS UNCAPPED. SPONGES ARE NOT. THEY NEED SEPARATE COUNTERS.
    // ---------------------------------------------------------------------
    //
    // Brendan, 2026-08-14: "free get 1 task they can do a day to get sponges,
    // infinite for xp." The sponge cap is the subscription's daily lever; XP is
    // not sold and should not stop.
    //
    // WARNING: `paidCount` was doing TWO jobs — how many completions have been paid
    // sponges, AND the replay guard for the whole callable. Those were the same
    // number only because both currencies shared one capped numerator. Uncapping
    // XP against `paidCount` alone would re-pay XP for every completion past the
    // cap on EVERY call, because paidCount saturates at `cap` and can never
    // record them. A second counter on the same document, keyed on the same
    // dayKey, is what separates the two jobs.
    //
    // Same-document and same-key on purpose: a second doc would need its own
    // staleness rule, and a duration would drift from the day boundary that
    // `dayKey` already defines.
    const alreadyXpPaid: number = settled.xpPaidCount;
    const newlyXp = Math.max(0, distinctCompleted - alreadyXpPaid);

    // The bonus is settled independently of `newlyPaid`: a player can complete
    // seven ordinary tasks first and the bonus eighth, or the bonus first and
    // six more after. Either way it pays its extra exactly once, and only while
    // the day still has paid capacity left.
    const bonusId = bonusTaskIdFor(dayKey);
    const bonusCompleted =
      bonusId != null && tasksSnap.docs.some((d) => d.id === bonusId);
    const bonusAlreadyPaid: boolean = settled.bonusPaid;
    const payBonus =
      bonusCompleted && !bonusAlreadyPaid && alreadyPaid + newlyPaid > 0;
    const bonusSponges = payBonus
      ? TASK_SPONGE_REWARD * (BONUS_TASK_MULTIPLIER - 1)
      : 0;

    // `newlyXp` joins the guard: past the sponge cap `newlyPaid` is 0 while XP
    // is still owed, and returning here would swallow it silently.
    if (newlyPaid === 0 && newlyXp === 0 && !payBonus) {
      // Replay, or the cap is already spent. Report the settled state so the
      // reward moment can show an honest "nothing further" rather than a zero
      // it has to guess the meaning of.
      return {
        sponges: 0,
        xp: 0,
        paidCount: alreadyPaid,
        capped: alreadyPaid >= cap,
        bonusTaskId: bonusId,
        bonusPaid: bonusAlreadyPaid,
      };
    }

    const sponges = newlyPaid * TASK_SPONGE_REWARD + bonusSponges;

    // ---------------------------------------------------------------------
    // CRITICAL: THE 2x BONUS DOUBLES SPONGES AND NOT XP. THIS IS UNDECIDED, NOT
    // DELIBERATE — AND IT IS AWAITING BRENDAN. DO NOT "FIX" IT EITHER WAY.
    // ---------------------------------------------------------------------
    //
    // `bonusSponges` above applies BONUS_TASK_MULTIPLIER; this line does not.
    // W2-15 went to the history to establish whether that was a choice, and it
    // was not:
    //
    //   · XP entered this file 2026-08-03 (#52). BONUS_TASK_MULTIPLIER arrived
    //     2026-08-09 (#128) — SIX DAYS LATER. So this is not the usual shape of
    //     "the multiplier predates XP and XP was added past it". XP was already
    //     here and in front of the author.
    //   · #128's message is ~50 lines and exhaustive — tier caps, two mirrors,
    //     two gates, even a leap-day bug in one of its own tests. It mentions XP
    //     ZERO times.
    //   · KEY: And #128 DELETED the only sentence in this file that documented XP
    //     ("8 x 10 = 80 XP") while rewriting this very comment block to add
    //     tiers, replacing it with prose that discusses sponges alone.
    //
    // So XP was not weighed and excluded. It fell out of the prose while a
    // feature was built beside it. There IS a good argument for the asymmetry —
    // a sponge is spent and leaves the economy, XP is permanent and compounds
    // into level, which gates content — but nobody made it, and a rationale
    // invented afterwards is not the same as a decision.
    //
    // WARNING: WHY IT MATTERS MORE NOW THAN WHEN IT WAS WRITTEN: quests award XP
    // (W2-12), so XP has more than one source for the first time, and the level
    // curve was tuned against task-only XP.
    //
    // The behaviour below is PINNED BY TEST (taskRewardsBonus.test.ts) in both
    // directions, so neither multiplying it nor leaving it flat can happen
    // silently. Changing it is an economy decision and it is Brendan's.
    // WARNING: `newlyXp`, not `newlyPaid` — the one-word change this brief is about.
    // The BONUS_TASK_MULTIPLIER question above is untouched: this line still
    // does not apply it, and that decision remains Brendan's.
    const xp = newlyXp * XP_TASK;
    const paidCount = alreadyPaid + newlyPaid;
    const xpPaidCount = alreadyXpPaid + newlyXp;

    tx.set(
      dayRef,
      {
        // The day key is the document ID as well, so this field is for a human
        // reading a console row and for the client's live cap mirror — not for
        // any comparison. Nothing here reads it back.
        dayKey,
        paidCount,
        xpPaidCount,
        bonusPaid: bonusAlreadyPaid || payBonus,
        expireAt: Timestamp.fromMillis(
          Date.now() + DAY_LEDGER_TTL_DAYS * 86_400_000,
        ),
      },
      { merge: true },
    );
    // The high-water mark the ratchet above reads. Written only on a settlement,
    // and only ever with a key `boundedDayKey` has already admitted.
    tx.set(indexRef, { maxDayKey: dayKey }, { merge: true });
    // set + merge (not update) so a user whose profile doc does not exist yet
    // can never fail with NOT_FOUND — same pattern as awardXp and every other
    // economy write in index.ts.
    tx.set(
      profileRef,
      {
        spongeBalance: FieldValue.increment(sponges),
        totalXp: FieldValue.increment(xp),
      },
      { merge: true },
    );

    console.log(
      `grantTaskRewards: +${sponges} sponges, +${xp} XP to ${uid} ` +
        `(${newlyPaid} new completion(s), ${paidCount}/${cap} on ${dayKey}` +
        `${payBonus ? `, incl. ${BONUS_TASK_MULTIPLIER}x bonus ${bonusId}` : ''})`,
    );

    return {
      sponges,
      xp,
      paidCount,
      capped: paidCount >= cap,
      bonusTaskId: bonusId,
      bonusPaid: bonusAlreadyPaid || payBonus,
    };
  });
}
