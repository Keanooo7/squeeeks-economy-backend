// ---------------------------------------------------------------------------
// Recomputing quest progress from the completion log
// ---------------------------------------------------------------------------
//
// W2-13. This is the path W2-11 made possible and did not build: "the log makes
// recomputation possible; nothing uses it."
//
// 🔑 THE PURITY PAYS OFF SOMEWHERE IT WAS NOT BUILT FOR. `evaluateQuests` was
// made pure because the design at the time permitted NO recovery — there was no
// history, so a mis-evaluating quest could never be re-run. That constraint is
// gone, and the property it forced is exactly what makes a recompute three
// dozen lines: read the log for a window, replay it through THE SAME evaluator,
// report the result. There is no second evaluator here and there must never be
// one — a recompute that disagrees with the live path is worse than no
// recompute, because it would launder a bug into an authoritative-looking fix.
//
// ---------------------------------------------------------------------------
// ⚠️ SWEEPS: WHY THIS IS EXACT NOW, AND INERT WHEN IT CANNOT BE.
// ---------------------------------------------------------------------------
//
// W2-13 found that `evaluateQuests` takes four inputs and the log carried only
// three. The fourth — `roomTaskCounts`, how many tasks a room CONTAINED — was
// missing, because a sweep is a RATIO and the log recorded only the numerator.
// Sweeps were therefore not recomputable, and were left INERT rather than
// guessed.
//
// W2-14 closed that by stamping `roomTaskCount` onto each record at write time,
// while the log was still empty and the field was free to add. A day's census
// is now RECONSTRUCTED FROM THE RECORDS THEMSELVES — see `censusForDay` — so
// all four quest kinds replay exactly.
//
// 🔴 BUT ONLY FOR RECORDS THAT CARRY IT. A record written before the field
// existed has `roomTaskCount: undefined`, and that is the honest value: nobody
// knows. Such a room is EXCLUDED from the day's census, which leaves the sweep
// inert exactly as before.
//
// ⚠️ IT MUST NEVER BE DEFAULTED. Zero would read as "the room was empty", which
// makes every partial clean a completed sweep. Today's live count would be the
// original W2-13 error: judging a three-month-old sweep by a census that has
// since changed fails in BOTH directions — a room that gained tasks
// retroactively un-completes a real sweep, and one that lost them promotes a
// partial clean into a sweep that never happened, AND THAT ONE PAYS A CHEST.
//
// A caller may still pass an explicit census, and the report still marks itself
// approximate when it does. Silence is not an option the API offers.
//
// ---------------------------------------------------------------------------
// 📌 BLIND-BEFORE, AND WHY IT IS IN THE OUTPUT RATHER THAN A COMMENT
// ---------------------------------------------------------------------------
//
// The log begins when it begins. Everything a player completed before it
// shipped is unrecorded and unrecoverable — the first cohort's window starts
// empty rather than at signup.
//
// ⚠️ A recompute reporting "0 progress" and one reporting "no data before
// 2026-08-12" are the same output unless it says which. Someone reading the
// first concludes the quest is broken; the truth is that it is BLIND. So every
// report carries `earliestRecord` and `blindBefore`, and a window that starts
// before the earliest record is flagged. The report never claims to have looked
// at a day it has no record of.

import {
  evaluateQuests,
  QuestDef,
  QuestPayout,
  QuestStateMap,
  QUEST_CATALOGUE,
} from './quests';
import {CompletionRecord} from './completionLog';

export interface RecomputeOptions {
  /**
   * Inclusive `YYYY-MM-DD` window start. Omit for "everything the log holds".
   *
   * ⚠️ DELIBERATELY AN ARGUMENT WITH NO DEFAULT WINDOW. How far back a quest may
   * be recomputed IS the retention decision, and that is a product call, not
   * this function's to make. Defaulting to a number here would silently cap a
   * feature nobody has designed.
   */
  from?: string;
  /** Inclusive window end. Omit for "up to the newest record". */
  to?: string;
  /**
   * Room task census for sweep evaluation. Omit — see the disproof note above.
   * Supplying it marks the result approximate rather than making it correct.
   */
  roomTaskCounts?: Record<string, number>;
  /** Defaults to the live catalogue. Injectable for tests. */
  catalogue?: QuestDef[];
  /**
   * State to replay ON TOP OF. Defaults to empty — a from-scratch recompute.
   * Pass the player's live state to ask "what would the log add to what they
   * already have", which is the question that must be asked before any grant.
   */
  priorState?: QuestStateMap;
}

export interface RecomputeReport {
  /** The state the log implies. NOT written anywhere by this function. */
  state: QuestStateMap;
  /**
   * Tiers that WOULD be claimed by this replay.
   *
   * 🔴 "Would". Nothing here grants. See the note on the function.
   */
  payouts: QuestPayout[];
  /** Distinct days that had at least one record inside the window. */
  daysWithRecords: number;
  /** Total records replayed. */
  recordsReplayed: number;
  /** Earliest dayKey present in the supplied log, or null if it is empty. */
  earliestRecord: string | null;
  /** Latest dayKey present, or null. */
  latestRecord: string | null;
  /**
   * The date before which this report knows NOTHING — not "nothing happened".
   * Equal to `earliestRecord`. Null when the log is empty, which means the
   * report is blind everywhere and its zeroes mean nothing at all.
   */
  blindBefore: string | null;
  /**
   * True when the requested window starts before the log's earliest record, so
   * part of the asked-for period is unobserved rather than empty.
   */
  windowPrecedesLog: boolean;
  /** Machine-readable caveats. Empty means the report is exact. */
  approximations: string[];
  /**
   * Days holding at least one record with no `roomTaskCount`, i.e. written
   * before the census field existed. Sweeps on those days are inert and
   * unrecoverable — the denominator was never written down.
   */
  censuslessDays: number;
}

/**
 * PURE. Replays the completion log through the live evaluator and reports what
 * quest state it implies.
 *
 * 🔴 THIS FUNCTION NEVER GRANTS AND NEVER WRITES. It computes and reports, and
 * that is the entire contract. A recompute that silently pays out is a
 * migration that guesses — and with sweeps unverifiable (above) some of what it
 * would pay is guessed by construction. Granting is a separate, deliberate act
 * that needs a human decision this function must not be able to make.
 */
/**
 * The room census for one day, reconstructed from that day's own records.
 *
 * 🔑 THE DENOMINATOR COMES FROM THE DATA, NOT FROM NOW. Each record carries the
 * count that was true when it was written, so a day judges itself by its own
 * census rather than by a room that has since changed.
 *
 * ⚠️ Two rules, both load-bearing:
 *
 *  - A record with NO `roomTaskCount` contributes nothing. Its room is absent
 *    from the census, `total === 0`, and the sweep stays inert. Defaulting to 0
 *    would mean "the room was empty" and would promote every partial clean.
 *  - Where a room appears more than once in a day with DIFFERENT counts (tasks
 *    were added mid-day), the MAXIMUM wins. That is the conservative direction:
 *    a larger denominator makes a sweep harder to complete, so an ambiguous day
 *    can fail to pay a chest but can never pay one that was not earned.
 */
export function censusForDay(records: CompletionRecord[]): Record<string, number> {
  const census: Record<string, number> = {};
  for (const record of records) {
    if (typeof record.roomTaskCount !== 'number') continue;
    const seen = census[record.room];
    census[record.room] = seen === undefined
      ? record.roomTaskCount
      : Math.max(seen, record.roomTaskCount);
  }
  return census;
}

export function recomputeFromLog(
  records: CompletionRecord[],
  options: RecomputeOptions = {},
): RecomputeReport {
  const catalogue = options.catalogue ?? QUEST_CATALOGUE;
  const suppliedCensus = options.roomTaskCounts;
  const approximations: string[] = [];

  const allDays = records.map((r) => r.dayKey).sort();
  const earliestRecord = allDays.length > 0 ? allDays[0] : null;
  const latestRecord = allDays.length > 0 ? allDays[allDays.length - 1] : null;

  const inWindow = records.filter(
    (r) =>
      (!options.from || r.dayKey >= options.from) &&
      (!options.to || r.dayKey <= options.to),
  );

  // Group by day, then replay in chronological order. Order is not optional:
  // a streak is a statement about day SEQUENCE, so replaying days out of order
  // does not merely mis-count, it computes a different quantity.
  const byDay = new Map<string, CompletionRecord[]>();
  for (const record of inWindow) {
    const bucket = byDay.get(record.dayKey);
    if (bucket) bucket.push(record);
    else byDay.set(record.dayKey, [record]);
  }
  const days = [...byDay.keys()].sort();

  let state: QuestStateMap = options.priorState
    ? JSON.parse(JSON.stringify(options.priorState))
    : {};
  const payouts: QuestPayout[] = [];
  let censuslessDays = 0;

  for (const dayKey of days) {
    const completed = (byDay.get(dayKey) ?? []).map((r) => ({
      id: r.taskId,
      room: r.room,
      title: r.title,
    }));
    // An explicitly supplied census overrides, and is flagged approximate
    // below. Otherwise the day is judged by its OWN recorded denominator.
    const dayRecords = byDay.get(dayKey) ?? [];
    const derived = censusForDay(dayRecords);
    if (!suppliedCensus && Object.keys(derived).length < new Set(dayRecords.map((r) => r.room)).size) {
      censuslessDays++;
    }
    const census = suppliedCensus ?? derived;
    const result = evaluateQuests(state, completed, dayKey, census, catalogue);
    state = result.state;
    payouts.push(...result.payouts);
  }

  const sweepQuests = catalogue.filter((q) => q.kind === 'sweep');
  if (sweepQuests.length > 0) {
    if (suppliedCensus) {
      approximations.push(
        `${sweepQuests.length} sweep quest(s) were evaluated against a CALLER-SUPPLIED census, which is not the census that existed on those days. Sweep results are approximate and can be wrong in both directions.`,
      );
    } else if (censuslessDays > 0) {
      approximations.push(
        `${censuslessDays} day(s) carry records with no roomTaskCount — written before the census field existed. Sweeps on those days were NOT evaluated: they are inert, not zero, and cannot be recovered because nobody recorded the room's task count at the time.`,
      );
    }
  }

  const windowPrecedesLog =
    !!options.from && !!earliestRecord && options.from < earliestRecord;
  if (windowPrecedesLog) {
    approximations.push(
      `The requested window starts ${options.from} but the log begins ${earliestRecord}. That period is UNOBSERVED, not empty.`,
    );
  }
  if (records.length === 0) {
    approximations.push(
      'The log is empty. Every figure in this report is blind, and a zero here means "no data", never "no progress".',
    );
  }

  return {
    state,
    payouts,
    daysWithRecords: days.length,
    recordsReplayed: inWindow.length,
    earliestRecord,
    latestRecord,
    blindBefore: earliestRecord,
    windowPrecedesLog,
    approximations,
    censuslessDays,
  };
}

/**
 * What a recompute would ADD to a player's existing state.
 *
 * 🔑 THIS IS THE ONLY SAFE QUESTION TO ASK BEFORE A GRANT, and the reason is
 * `claimedTiers`. Replaying from scratch reports every tier the log implies,
 * INCLUDING the ones already paid. Handing that list to a granter would pay
 * them all a second time — a level-up farm assembled out of an audit tool.
 *
 * Passing the live state as `priorState` makes the evaluator's own idempotency
 * do the work: a tier already in `claimedTiers` is not re-emitted, so the
 * payouts returned here are exactly the ones never yet paid.
 */
export function recomputeDelta(
  records: CompletionRecord[],
  liveState: QuestStateMap,
  options: Omit<RecomputeOptions, 'priorState'> = {},
): RecomputeReport {
  return recomputeFromLog(records, {...options, priorState: liveState});
}
