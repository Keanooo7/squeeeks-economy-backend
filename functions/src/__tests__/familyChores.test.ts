// functions/src/__tests__/familyChores.test.ts
//
// W2-88 part 3. Parents assign, members complete.
//
// 🔴 THE MIRROR TEST IS THE POINT OF THIS FILE. Everything else here is ordinary
// authority checking; the id mirror is the thing that has actually gone wrong in
// this codebase, twice, in this exact family of modules.

import * as fs from 'fs';
import * as path from 'path';

import {
  CHORE_REFUSALS,
  FamilyChoreDoc,
  planChoreAssignment,
  planChoreCompletion,
  TASK_LIBRARY_IDS,
} from '../familyChores';

const OWNER = 'uid-owner';
const KID = 'uid-kid';
const NOW = 1_760_000_000_000;
const HOUR = 60 * 60 * 1000;
const FAMILY = {ownerUid: OWNER, memberUids: [OWNER, KID]};

const assign = (over: Record<string, unknown> = {}) =>
  planChoreAssignment({
    family: FAMILY,
    actorUid: OWNER,
    assignedToUid: KID,
    taskId: 'lib_kitchen_0',
    dueAtMs: NOW + 5 * HOUR,
    nowMs: NOW,
    ...over,
  } as Parameters<typeof planChoreAssignment>[0]);

// ---------------------------------------------------------------------------
// 🔴 THE MIRROR — gated against the Dart file on disk, in BOTH directions
// ---------------------------------------------------------------------------
//
// The server cannot import from `lib/`, so a copy is unavoidable. An UNCHECKED
// copy is not. W2-80 wrote `lib_living_0` where the library says
// `lib_livingroom_0` — the room enum says `living`, the house catalogue says
// `living_room`, so two wrong spellings both read as correct — and an unknown id
// is dropped by the renderer in SILENCE.
//
// Same technique as `dailyRotation.test.ts`, which reads `collection_seed.dart`
// off disk, and which is why THAT mirror has never drifted.

describe('🔴 TASK_LIBRARY_IDS mirrors task_library.dart', () => {
  const DART = path.join(
    path.resolve(__dirname, '../../..'),
    'lib/features/weekly_schedule/domain/data_sources/task_library.dart',
  );

  /** Ids inside the `taskLibrary` declaration — anchored, never a whole-file
   *  sweep, so an unrelated const added later cannot silently join the set. */
  const idsInDart = (): string[] => {
    const source = fs.readFileSync(DART, 'utf8');
    const anchor = 'const List<LibraryTask> taskLibrary = [';
    const start = source.indexOf(anchor);
    expect(`anchor found in task_library.dart: ${start >= 0}`).toBe(
      'anchor found in task_library.dart: true',
    );
    const end = source.indexOf('\n];', start);
    expect(`terminator found after the anchor: ${end > start}`).toBe(
      'terminator found after the anchor: true',
    );
    return [...source.slice(start, end).matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
  };

  test('🔑 ANTI-VACUITY — the Dart side parses to a real, non-trivial set', () => {
    // Without this, a rename that made the regex match nothing would turn the
    // comparison below into {} === {} and pass while checking nothing.
    const ids = idsInDart();
    expect(ids.length).toBe(30);
    expect(ids).toContain('lib_kitchen_0');
    expect(ids).toContain('lib_livingroom_0');
  });

  test('🔴 every mirrored id EXISTS in the Dart library', () => {
    expect([...TASK_LIBRARY_IDS].sort()).toEqual(idsInDart().sort());
  });

  test('🔴 the WRONG spellings are absent from both sides', () => {
    // Named explicitly because they are the ones that have actually been
    // written: `living` is the room enum, `living_room` is the house
    // catalogue's room, and neither is the library's id.
    for (const wrong of ['lib_living_0', 'lib_living_room_0']) {
      expect(TASK_LIBRARY_IDS).not.toContain(wrong);
      expect(idsInDart()).not.toContain(wrong);
    }
  });
});

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

describe('🔴 planChoreAssignment — only the owner assigns', () => {
  test('🔴 CONTROL — the owner CAN assign, or every refusal below is vacuous', () => {
    const plan = assign();
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.chore.taskId).toBe('lib_kitchen_0');
    expect(plan.chore.assignedToUid).toBe(KID);
    expect(plan.chore.assignedByUid).toBe(OWNER);
    expect(plan.chore.dueAtMs).toBe(NOW + 5 * HOUR);
  });

  test('🔴 a MEMBER cannot assign — not even to themselves', () => {
    // A member who could assign could hand their own chores to a sibling, and
    // the page would show a parent's instruction no parent gave.
    const plan = assign({actorUid: KID, assignedToUid: KID});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('not-the-owner');
    expect(CHORE_REFUSALS[plan.refusal].code).toBe('permission-denied');
  });

  test('a stranger cannot assign', () => {
    const plan = assign({actorUid: 'uid-stranger'});
    expect(plan.ok).toBe(false);
  });

  test('🔴 authority is checked BEFORE the roster and the library', () => {
    // Otherwise the pair of refusals a non-owner can elicit enumerates both the
    // family's membership and the task library.
    const badTarget = assign({actorUid: KID, assignedToUid: 'uid-nobody'});
    const badTask = assign({actorUid: KID, taskId: 'lib_not_real'});
    expect(badTarget).toEqual(badTask);
  });

  test('cannot assign to somebody outside the family', () => {
    const plan = assign({assignedToUid: 'uid-nobody'});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('not-a-member');
  });

  test('the owner may assign to THEMSELVES — a parent does chores too', () => {
    const plan = assign({assignedToUid: OWNER});
    expect(plan.ok).toBe(true);
  });
});

describe('🔴 planChoreAssignment — the task id is the silent-skip guard', () => {
  test('🔴 an id the library does not define is REFUSED', () => {
    const plan = assign({taskId: 'lib_living_0'});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('unknown-task');
  });

  test('a free-text label is refused — this is not a chore vocabulary', () => {
    const plan = assign({taskId: 'Sort the darks'});
    expect(plan.ok).toBe(false);
  });

  test('a non-string is refused without throwing', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(assign({taskId: bad}).ok).toBe(false);
    }
  });

  test('every library id is assignable — the guard is not a denylist of one', () => {
    // Without this, a guard that accepted only `lib_kitchen_0` would pass every
    // test above.
    for (const id of TASK_LIBRARY_IDS) {
      expect(assign({taskId: id}).ok).toBe(true);
    }
  });
});

describe('🔴 planChoreAssignment — the due time is an INSTANT', () => {
  test('a chore due in the past is refused', () => {
    // It arrives on the child's card pre-failed, which is a client bug or a
    // moved clock rather than an instruction.
    const plan = assign({dueAtMs: NOW - 1});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('due-in-the-past');
  });

  test('due exactly NOW is refused — the boundary is closed', () => {
    expect(assign({dueAtMs: NOW}).ok).toBe(false);
  });

  test('a non-finite due time is refused without throwing', () => {
    for (const bad of [NaN, Infinity, null, '5PM', {}]) {
      expect(assign({dueAtMs: bad}).ok).toBe(false);
    }
  });

  test('📌 the stored value is the instant VERBATIM — no rounding to a day', () => {
    // The contrast with trashDay is the whole design note: a bin DATE is a
    // local calendar day, a due TIME is a moment two devices must agree on.
    const odd = NOW + 5 * HOUR + 37 * 60 * 1000 + 12_345;
    const plan = assign({dueAtMs: odd});
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.chore.dueAtMs).toBe(odd);
  });

  test('a new chore is explicitly OUTSTANDING, not merely missing a field', () => {
    const plan = assign();
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.chore.completedAtMs).toBeNull();
    expect('completedAtMs' in plan.chore).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

describe('🔴 planChoreCompletion — completion is the member\'s own act', () => {
  const outstanding: Pick<FamilyChoreDoc, 'assignedToUid' | 'completedAtMs'> = {
    assignedToUid: KID,
    completedAtMs: null,
  };

  test('🔴 CONTROL — the assignee CAN complete it', () => {
    const plan = planChoreCompletion({chore: outstanding, actorUid: KID, nowMs: NOW});
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.completedAtMs).toBe(NOW);
  });

  test('🔴 somebody else cannot complete it — INCLUDING THE OWNER', () => {
    // A parent marking a child's chore done is a different feature with a
    // different meaning on the board. This is the child saying they did it.
    const plan = planChoreCompletion({chore: outstanding, actorUid: OWNER, nowMs: NOW});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('not-yours');
  });

  test('🔴 a second completion is REFUSED, preserving the first time', () => {
    // The first completion time is the one a family will argue about — the same
    // reason planTrashDayCompletion preserves its first completer.
    const done = {assignedToUid: KID, completedAtMs: NOW - HOUR};
    const plan = planChoreCompletion({chore: done, actorUid: KID, nowMs: NOW});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('already-done');
    expect(CHORE_REFUSALS[plan.refusal].code).toBe('already-exists');
  });

  test('ownership is checked BEFORE doneness', () => {
    // A stranger must not learn whether somebody else's chore is finished.
    const done = {assignedToUid: KID, completedAtMs: NOW - HOUR};
    const plan = planChoreCompletion({chore: done, actorUid: 'uid-stranger', nowMs: NOW});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('not-yours');
  });

  test('completing late is still completing', () => {
    // Nothing here reads dueAtMs. "Late" is a display concern, and refusing a
    // late completion would leave the chore outstanding forever.
    const plan = planChoreCompletion({chore: outstanding, actorUid: KID, nowMs: NOW + 99 * HOUR});
    expect(plan.ok).toBe(true);
  });
});
