// SYNC: lib/features/weekly_schedule/domain/data_sources/task_library.dart
// ---------------------------------------------------------------------------
// The daily 2x bonus task
// ---------------------------------------------------------------------------
//
// One task a day pays double. It is picked SERVER-SIDE and seeded on the
// calendar date, which is what makes it stable and unfarmable:
//
//   * stable — the same task all day, across app restarts and reinstalls,
//     because nothing is stored; it is recomputed from the date every time.
//   * unfarmable — a client cannot re-roll it. Deriving it on device would let
//     anyone move the system clock, get a new bonus, and collect 2x repeatedly;
//     `recordTaskCompletion` already pays against a server-side ledger for
//     exactly this class of reason.
//
// ⚠️ THE ID LIST IS A MIRROR, and mirrors rot. It is the ids only — no titles,
// no rooms, no durations — because the server never renders a task and every
// extra field is another thing to drift. `daily_bonus_task_test.dart` on the
// Dart side reads THIS FILE and asserts the list matches `taskLibrary`
// element-for-element, so adding a task to the library without adding it here
// fails the Dart suite rather than silently shrinking the bonus pool.

/** Every id in `task_library.dart`, in declaration order. */
export const TASK_LIBRARY_IDS: readonly string[] = [
  'lib_kitchen_0',
  'lib_kitchen_1',
  'lib_kitchen_2',
  'lib_kitchen_3',
  'lib_kitchen_4',
  'lib_bedroom_0',
  'lib_bedroom_1',
  'lib_bedroom_2',
  'lib_bedroom_3',
  'lib_bedroom_4',
  'lib_bathroom_0',
  'lib_bathroom_1',
  'lib_bathroom_2',
  'lib_bathroom_3',
  'lib_bathroom_4',
  'lib_livingroom_0',
  'lib_livingroom_1',
  'lib_livingroom_2',
  'lib_livingroom_3',
  'lib_livingroom_4',
  'lib_laundry_0',
  'lib_laundry_1',
  'lib_laundry_2',
  'lib_laundry_3',
  'lib_laundry_4',
  'lib_office_0',
  'lib_office_1',
  'lib_office_2',
  'lib_office_3',
  'lib_office_4',
];

/** How much more the bonus task pays. 2 = double. */
export const BONUS_TASK_MULTIPLIER = 2;

/**
 * FNV-1a over the day key.
 *
 * Chosen over `Math.random` (not reproducible), over `Date.now() % n` (drifts
 * within the day) and over a stored roll (a write per user per day for a value
 * that is a pure function of the date). Any stable hash would do; this one is
 * six lines and has no dependency.
 */
function hashDayKey(dayKey: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < dayKey.length; i++) {
    h ^= dayKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * The task id that pays double on [dayKey] (`YYYY-MM-DD`).
 *
 * Deterministic and total: every date maps to exactly one id, and the same date
 * always maps to the same id. Returns null only if the mirror is empty, which
 * the Dart cross-mirror test makes impossible in practice.
 *
 * 📌 [dayKey] is the same plain calendar date `grantTaskRewards` uses — NOT the
 * streak system's 4 AM cutoff. The bonus has to agree with the `completedDate`
 * the client stamps on a task doc, or a completion between midnight and 4 AM
 * would be checked against the wrong day's bonus.
 */
export function bonusTaskIdFor(dayKey: string): string | null {
  if (TASK_LIBRARY_IDS.length === 0) return null;
  return TASK_LIBRARY_IDS[hashDayKey(dayKey) % TASK_LIBRARY_IDS.length];
}
