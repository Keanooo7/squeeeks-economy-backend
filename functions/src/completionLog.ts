// ---------------------------------------------------------------------------
// The completion log — a completion is a FACT, not a FLAG
// ---------------------------------------------------------------------------
//
// W2-11. Brendan's ruling: "they are done then document — work started during
// that day still counts towards it."
//
// KEY: WHAT THIS CHANGES, AND WHY IT IS A DESIGN FIX RATHER THAN A GUARD.
//
// Before this, the only trace of a completion was `completedDate` on the task
// document itself — a single scalar the client sets on completion and NULLS on
// un-completion. That made a completion RETRACTABLE, and two separate defects
// fell out of it:
//
//   D94-4  Un-completing and re-completing a task across days advanced a tally
//          twice for one task. The day guard stopped same-day double counting;
//          nothing stopped it across days.
//   D92    There was no history at all, so quest progress could never be
//          backfilled or recomputed — a mis-evaluating quest could only be
//          fixed by a migration that guesses.
//
// Writing a durable record kills BOTH. A completion becomes a fact with a
// timestamp: un-completion cannot retract it, and the record is the history that
// recomputation needs.
//
// WARNING: UN-COMPLETION WRITES NOTHING. It is not an event, it is the absence of one.
// Do NOT add retraction records — that reintroduces exactly the retractability
// this removes, one level up, and it would be harder to see the second time.
//
// 🔒 WRITTEN SERVER-SIDE ONLY. This log bears rewards, so a client-written one
// would not be tamper-proof. firestore.rules puts `users/{uid}/completions` at
// owner-read / deny-write for the same reason quests/state is.
//
// ---------------------------------------------------------------------------
// GROWTH — stated, not discovered in a year's billing
// ---------------------------------------------------------------------------
//
// One document per (task, day). It is NOT one per callable invocation: the id is
// derived from the day and the task, so the fifth call of the same day is a
// no-op rather than a fifth row.
//
//   a daily-active player completing 5 tasks/day
//     = 5 docs/day = ~1,825 docs/player/year
//   payload ~90 bytes; with Firestore's per-document overhead and the single
//   `dayKey` index, budget ~0.5-1 KB/doc
//     = ~1-2 MB per player per year
//   at 10,000 daily-active players: ~10-20 GB/year of accumulated log
//     ~= $2-4/month at $0.18/GiB-month, rising by that much again each year.
//
// READ cost is bounded and does NOT grow with history: every query here filters
// on `dayKey`, so a completion reads O(tasks completed today), never O(all
// completions). WARNING: That is the property to protect. A future `orderBy` over the
// whole collection, or a quest that scans all history on the hot path, converts
// a fixed cost into one that grows forever.
//
// WARNING: W2-14 ADDED A FIELD, AND HERE IS WHAT IT COSTS — computed, not waved
// through, because "a small number times a large one" is exactly the shape that
// gets nodded past. Firestore charges the field NAME on every document:
//
//   "roomTaskCount" = 13 bytes + 1 terminator, plus an 8-byte integer = 22 B
//   x ~1,825 records/player/year   = ~39 KB per player per year
//   x 10,000 daily-active players  = ~0.39 GB/year  (~$0.07/month per cohort)
//
// Against the ~10-20 GB/year the log already accrues that is roughly 2-4%. It
// carries NO index — nothing queries on it — so it adds storage only, and the
// bounded-read property below is untouched. The field is cheap; it is worth
// knowing that it is cheap rather than assuming it.
//
// WARNING: NOTHING PRUNES THIS COLLECTION TODAY. That is a deliberate, stated choice,
// not an oversight: the recompute ability the log exists to provide is exactly
// the thing a prune destroys, so the retention window is a product decision
// about how far back a quest may be recomputed. `loggedAt` is written as a real
// Timestamp so a Firestore TTL policy can be pointed at it later WITHOUT a
// migration — but no such policy is configured, and configuring one needs
// console/gcloud access this window does not have. See the return.

import {Timestamp} from 'firebase-admin/firestore';

/** A durable record that a task was completed on a given day. */
export interface CompletionRecord {
  taskId: string;
  /** `RoomType.x`, copied from the task document at completion time. */
  room: string;
  /**
   * The task's title AS IT WAS WHEN COMPLETED.
   *
 * NOTE: D93 (task documents have no stable semantic key) is NOT fixed here and
   * this does not pretend to fix it. But recording the title at completion time
   * preserves what the task was CALLED when it was done, which is strictly more
   * than the mutable task document retains — rename a task and its own doc
   * forgets the old name, while these records do not. That is precisely the
   * input a later `taskKey` migration would need to map history onto real keys.
   */
  title: string;
  /** `YYYY-MM-DD`. Indexed; every read filters on it. */
  dayKey: string;
  loggedAt: Timestamp;
  /**
   * How many tasks EXISTED in `room` at the moment this completion was recorded.
   *
 * KEY: W2-14. THE ONLY FIELD HERE THAT IS NOT A FACT ABOUT THE TASK — it is a
   * fact about the room, and it is on the record because a SWEEP IS A RATIO,
   * not a count. "Every task in the bathroom" cannot be judged from a list of
   * completions alone; it needs the denominator, and the denominator is the one
   * thing that is unrecoverable after the fact. A room's task list changes, and
   * nothing anywhere records what it used to be.
   *
 * WARNING: THIS FIELD EXISTS BECAUSE IT WAS FREE TO ADD AND IMPOSSIBLE TO ADD LATER.
   * W2-13 found sweeps unrecomputable and the log already a year cheaper to fix
   * than it would ever be again: it was EMPTY. Backfilling it would mean
   * stamping today's census onto old records, which is exactly the guess that
   * promotes a partial clean into a sweep that never happened — and that pays a
   * chest. So old records must stay INERT, never guessed. See the recompute.
   *
   * OPTIONAL ON PURPOSE. A record written before this field existed has no
   * census, and `undefined` is the honest value for "nobody knows". It must
   * never be defaulted to 0 (which would read as "the room was empty", making
   * every partial clean a sweep) nor to a live count.
   */
  roomTaskCount?: number;
  /**
   * Whether THIS task was the day's 2x bonus task, as the server determined it
   * at the moment of writing.
   *
 * KEY: W2-16. `bonusTaskIdFor` picks `TASK_LIBRARY_IDS[hash(dayKey) % length]` —
   * AN INDEX INTO A MUTABLE LIST. Reordering or extending that list changes
   * which task was the bonus on EVERY PAST DAY, and the historical list is
   * stored nowhere and cannot be reconstructed. Recording the answer here makes
   * history immune to both operations.
   *
 * WARNING: THE TRIGGER IS AN ORDINARY EDIT, WHICH IS WHAT MAKES IT WORSE THAN THE
   * CENSUS. The census needed someone to change a room. This needs someone to
   * add a task to the library, or sort it — an obviously-safe, well-tested
   * change that silently rewrites the past. Nothing else in the repo warns them.
   *
   * OPTIONAL, and three-state exactly like `roomTaskCount`: `true` = was the
   * bonus, `false` = known not to be, `undefined` = written before this field
   * existed and therefore UNKNOWABLE. Never default it — `false` would assert
   * that a day had no bonus when nobody looked.
   */
  wasBonusTask?: boolean;
}

/**
 * The document id for a completion.
 *
 * KEY: THE IDEMPOTENCY IS THE ID. One id per (day, task) means re-completing the
 * same task on the same day cannot create a second record, and the callable
 * firing five times in a day cannot create five. There is no counter to get
 * wrong and no read-modify-write to race.
 *
 * Firestore document ids may not contain `/`, and a `__x__` id is reserved.
 * Task ids come from client-authored documents, so neither is assumed away.
 */
export function completionDocId(dayKey: string, taskId: string): string {
  const safeTask = taskId.replace(/\//g, '_');
  return `${dayKey}_${safeTask}`;
}

/**
 * Merges the durable log with what the task documents currently claim.
 *
 * CRITICAL: THIS UNION IS THE EXPLOIT FIX. `logged` is what actually happened today and
 * cannot be retracted; `currentlyComplete` is the mutable view the client can
 * toggle. Taking the union means:
 *
 *   - un-completing a task does NOT remove it from today's set, so progress
 *     cannot be walked backwards;
 *   - re-completing it adds nothing new, because it is already in the union
 *     under the same id.
 *
 * Complete -> un-complete -> re-complete therefore advances a tally exactly
 * once, which is the behaviour completionLog.test.ts reproduces the exploit
 * against.
 *
 * Records win on conflict: the log is the fact, the task document is the flag.
 */
export function mergeCompletions(
  logged: CompletionRecord[],
  currentlyComplete: {id: string; room: string; title: string}[],
): {id: string; room: string; title: string}[] {
  const byId = new Map<string, {id: string; room: string; title: string}>();
  for (const task of currentlyComplete) {
    byId.set(task.id, task);
  }
  for (const record of logged) {
    byId.set(record.taskId, {
      id: record.taskId,
      room: record.room,
      title: record.title,
    });
  }
  return [...byId.values()];
}

/**
 * Which of today's completions are not yet in the log.
 *
 * Pure so the write set is testable without a Firestore mock — the same reason
 * evaluateQuests is pure.
 */
export function unloggedCompletions(
  loggedIds: Set<string>,
  currentlyComplete: {id: string; room: string; title: string}[],
  dayKey: string,
): {id: string; room: string; title: string}[] {
  return currentlyComplete.filter(
    (task) => !loggedIds.has(completionDocId(dayKey, task.id)),
  );
}
