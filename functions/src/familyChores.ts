// ---------------------------------------------------------------------------
// Family chores — the parent assigns, the member completes
// ---------------------------------------------------------------------------
//
// W2-88 part 3, spec item 2: "Parents choose the chores kids will do each week,
// including on the special day."
//
// 🔑 "THE SPECIAL DAY" IS TRASH DAY, RULED, AND NO SECOND CONCEPT IS INVENTED.
// It is the only special day in the product, and spec item 6 already pairs trash
// day with orientation. A chore due on trash day is an ordinary chore whose due
// time falls on it; nothing here knows the phrase.
//
// ---------------------------------------------------------------------------
// 🔴 THE TASK ID IS BORROWED, NOT MINTED — AND THIS FILE HAS ALREADY PAID FOR
// THE ALTERNATIVE
// ---------------------------------------------------------------------------
//
// A chore names a task from the app's own library (`lib_kitchen_0` …), because
// a parallel chore vocabulary would be a second list to keep in step with the
// first. This repo has been bitten by that exact shape repeatedly, and W2-80
// was bitten by it in THIS module's family: `lib_living_0` was written where the
// library says `lib_livingroom_0`, the room enum says `living` and the house
// catalogue says `living_room` — three spellings, two of them wrong, and an
// unknown id is DROPPED BY THE RENDERER IN SILENCE.
//
// ⚠️ SO THE IDS ARE MIRRORED HERE AND THE MIRROR IS GATED AGAINST THE DART FILE
// ON DISK. The server cannot import from `lib/`, so a copy is unavoidable; what
// is avoidable is an UNCHECKED copy. `familyChores.test.ts` reads
// `task_library.dart` and asserts the two agree in both directions — the same
// technique `dailyRotation.test.ts` already uses for `collection_seed.dart`, and
// the reason that one has never drifted.

/**
 * Every task id the app's library defines.
 *
 * ⚠️ A MIRROR OF `lib/features/weekly_schedule/domain/data_sources/task_library.dart`.
 * Do not edit by hand without editing that file; the test reads it off disk and
 * fails in BOTH directions, so an addition here that is not there is as loud as
 * an omission.
 */
export const TASK_LIBRARY_IDS: readonly string[] = [
  'lib_kitchen_0', 'lib_kitchen_1', 'lib_kitchen_2', 'lib_kitchen_3', 'lib_kitchen_4',
  'lib_bedroom_0', 'lib_bedroom_1', 'lib_bedroom_2', 'lib_bedroom_3', 'lib_bedroom_4',
  'lib_bathroom_0', 'lib_bathroom_1', 'lib_bathroom_2', 'lib_bathroom_3', 'lib_bathroom_4',
  'lib_livingroom_0', 'lib_livingroom_1', 'lib_livingroom_2', 'lib_livingroom_3', 'lib_livingroom_4',
  'lib_laundry_0', 'lib_laundry_1', 'lib_laundry_2', 'lib_laundry_3', 'lib_laundry_4',
  'lib_office_0', 'lib_office_1', 'lib_office_2', 'lib_office_3', 'lib_office_4',
];

const TASK_IDS = new Set(TASK_LIBRARY_IDS);

/** The shared chore, at `families/{familyId}/chores/{choreId}`. */
export interface FamilyChoreDoc {
  /** A `TASK_LIBRARY_IDS` id. Never a free-text label. */
  taskId: string;
  /** Which member owes it. Must be in the family's roster. */
  assignedToUid: string;
  /** Who assigned it — the owner, always. Kept for the message board's sake. */
  assignedByUid: string;
  /**
   * When it is due, as an ABSOLUTE INSTANT.
   *
   * 🔴 AN INSTANT, AND NOT A LOCAL WALL-CLOCK TIME — WHICH IS THE OPPOSITE OF
   * THE BIN DATE, DELIBERATELY, AND THE CONTRAST IS THE EXPLANATION.
   *
   * `trashDay.ts` stores a LOCAL CALENDAR DAY because a bin day is a physical
   * event with no instant: "Tuesday" is Tuesday wherever you stand, and UTC
   * would put it on the wrong day for much of the world.
   *
   * A due TIME is the other kind of thing. "5PM" is a MOMENT, and two devices
   * must agree on whether it has passed — the parent's card and the child's
   * card cannot disagree about whether a chore is late. An absolute instant is
   * the only value they cannot disagree about; a stored "17:00" would mean two
   * different moments to two members and neither would be wrong.
   *
   * 📌 The assigner picks it from their own local clock, so the household's
   * timezone is captured at assign time without this module ever storing one.
   */
  dueAtMs: number;
  /** Server clock at assignment. */
  assignedAtMs: number;
  /** Server clock at completion, or null while outstanding. */
  completedAtMs: number | null;
}

export type ChoreAssignRefusal =
  | 'not-the-owner'
  | 'not-a-member'
  | 'unknown-task'
  | 'due-in-the-past';

export type ChoreCompleteRefusal = 'not-yours' | 'already-done';

export type ChoreAssignPlan =
  | {ok: true; chore: FamilyChoreDoc}
  | {ok: false; refusal: ChoreAssignRefusal};

export type ChoreCompletePlan =
  | {ok: true; completedAtMs: number}
  | {ok: false; refusal: ChoreCompleteRefusal};

/**
 * Whether [actorUid] may assign [taskId] to [assignedToUid].
 *
 * 🔴 ONLY THE OWNER ASSIGNS — the same authority split `removeMember` draws.
 * A member who could assign could hand their own chores to a sibling, and the
 * page would show a parent's instruction that no parent gave.
 *
 * Pure: the clock is a parameter and nothing is read or written.
 */
export function planChoreAssignment(args: {
  family: {ownerUid: string; memberUids: string[]};
  actorUid: string;
  assignedToUid: string;
  taskId: unknown;
  dueAtMs: unknown;
  nowMs: number;
}): ChoreAssignPlan {
  const {family, actorUid, assignedToUid, taskId, dueAtMs, nowMs} = args;

  // Authority first, so a non-owner cannot probe the roster or the library by
  // reading which inputs produce which refusal.
  if (family.ownerUid !== actorUid) return {ok: false, refusal: 'not-the-owner'};

  if (!family.memberUids.includes(assignedToUid)) {
    return {ok: false, refusal: 'not-a-member'};
  }

  // 🔴 THE SILENT-SKIP GUARD. An id the library does not define renders as
  // nothing — an emptier card than was assigned, with no error anywhere. This
  // is the check `lib_living_0` needed and did not have.
  if (typeof taskId !== 'string' || !TASK_IDS.has(taskId)) {
    return {ok: false, refusal: 'unknown-task'};
  }

  if (typeof dueAtMs !== 'number' || !Number.isFinite(dueAtMs)) {
    return {ok: false, refusal: 'due-in-the-past'};
  }
  // A chore assigned already-late is almost certainly a client bug or a moved
  // clock, and it arrives on the child's card pre-failed. Refuse rather than
  // store something nobody can satisfy.
  if (dueAtMs <= nowMs) return {ok: false, refusal: 'due-in-the-past'};

  return {
    ok: true,
    chore: {
      taskId,
      assignedToUid,
      assignedByUid: actorUid,
      dueAtMs,
      assignedAtMs: nowMs,
      // 🔑 EXPLICITLY NULL RATHER THAN ABSENT. An absent field and a null one
      // read the same from Dart, but only one of them is a value the writer
      // chose — and `completedAtMs: null` is what makes "outstanding" a state
      // the document asserts rather than one a reader infers.
      completedAtMs: null,
    },
  };
}

/**
 * Whether [actorUid] may mark [chore] done.
 *
 * 🔑 COMPLETION IS THE MEMBER'S OWN ACT, so the authority here is BEING the
 * assignee — not owning the family. A parent marking a child's chore done is a
 * different feature (and a different message on the board); this is the child
 * saying they did it.
 *
 * ⚠️ IDEMPOTENT IN THE REFUSAL SENSE, NOT THE SUCCESS SENSE. A second
 * completion is refused rather than silently re-stamped, because the FIRST
 * completion time is the one the family will argue about — the same reason
 * `planTrashDayCompletion` preserves its first completer.
 */
export function planChoreCompletion(args: {
  chore: Pick<FamilyChoreDoc, 'assignedToUid' | 'completedAtMs'>;
  actorUid: string;
  nowMs: number;
}): ChoreCompletePlan {
  const {chore, actorUid, nowMs} = args;

  if (chore.assignedToUid !== actorUid) return {ok: false, refusal: 'not-yours'};
  if (chore.completedAtMs !== null) return {ok: false, refusal: 'already-done'};

  return {ok: true, completedAtMs: nowMs};
}

/** Human-facing refusal text, and the callable's error code for each. */
export const CHORE_REFUSALS: Record<
  ChoreAssignRefusal | ChoreCompleteRefusal,
  {code: 'permission-denied' | 'invalid-argument' | 'already-exists'; message: string}
> = {
  'not-the-owner': {
    code: 'permission-denied',
    message: 'Only the person who started the family can set chores.',
  },
  'not-a-member': {
    code: 'invalid-argument',
    message: 'That person is not in this family.',
  },
  'unknown-task': {
    code: 'invalid-argument',
    message: 'That is not a task this app knows.',
  },
  'due-in-the-past': {
    code: 'invalid-argument',
    message: 'Pick a time in the future.',
  },
  'not-yours': {
    code: 'permission-denied',
    message: 'That is somebody else\'s chore.',
  },
  'already-done': {
    code: 'already-exists',
    message: 'That one is already done.',
  },
};
