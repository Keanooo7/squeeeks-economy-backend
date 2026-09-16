// functions/src/__tests__/bonusHistory.test.ts
//
// W2-16. Which task paid double on a past day.
//
// 🔴 THE BUG IS INVISIBLE UNTIL SOMEONE UNRELATED EDITS A LIST. `bonusTaskIdFor`
// returns `TASK_LIBRARY_IDS[hash(dayKey) % length]` — an INDEX into a mutable
// list. Reorder it or extend it and the answer changes for EVERY PAST DAY, and
// the historical list is stored nowhere, so the old answer is not recoverable.
//
// ⚠️ WHAT MAKES THIS WORSE THAN THE CENSUS: the trigger is an ordinary edit. The
// census needed someone to change a room. This needs someone to ADD A TASK or
// SORT THE LIST — obviously safe, well tested, and silently rewrites the past.
//
// 🔑 So the tests below reorder and extend a FIXTURE list, never the real one.
// A fixture that cannot express the bug's shape proves nothing, so each block
// runs the CONTROL first — the recomputed answer moving — and only then shows
// the recorded answer holding still.

import {CompletionRecord} from '../completionLog';
import {codeOf} from './helpers/sourceText';

/**
 * The selection rule, reproduced over an injectable list so a test can reorder
 * it. Mirrors `bonusTaskIdFor` in dailyBonusTask.ts:89-92, and the assertion
 * `the fixture rule matches the source` below pins it against the source text —
 * otherwise this is a private copy of the rules that agrees with itself.
 */
function pickFrom(ids: string[], dayKey: string, hash: (s: string) => number): string | null {
  if (ids.length === 0) return null;
  return ids[hash(dayKey) % ids.length];
}

/** FNV-1a, as both languages implement it. Only its determinism matters here. */
function hashDayKey(dayKey: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < dayKey.length; i++) {
    h ^= dayKey.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const LIBRARY = [
  'lib_kitchen_0',
  'lib_kitchen_1',
  'lib_bathroom_0',
  'lib_bedroom_0',
  'lib_living_0',
];

const DAY = '2026-08-12';

/** A record as the log now writes it. */
function record(taskId: string, dayKey: string, wasBonusTask: boolean): CompletionRecord {
  return {
    taskId,
    room: 'RoomType.kitchen',
    title: 'Wash the dishes',
    dayKey,
    roomTaskCount: 1,
    wasBonusTask,
    loggedAt: null as never,
  } as CompletionRecord;
}

/** What the log says paid double that day — history, not recomputation. */
function recordedBonus(records: CompletionRecord[]): string | null {
  const hit = records.find((r) => r.wasBonusTask === true);
  return hit ? hit.taskId : null;
}

describe('🔴 CONTROL — recomputing a past bonus is NOT stable', () => {
  // These are the failures the recorded field exists to prevent. If any of them
  // ever starts passing, the selection rule changed and this file is the reason
  // someone will notice.
  test('REORDERING the library changes which task was the bonus', () => {
    const before = pickFrom(LIBRARY, DAY, hashDayKey);
    const sorted = [...LIBRARY].sort();
    const after = pickFrom(sorted, DAY, hashDayKey);
    expect(sorted).not.toEqual(LIBRARY); // the fixture really is reordered
    expect(after).not.toBe(before);
  });

  test('EXTENDING the library changes it too, and by a different mechanism', () => {
    // Reorder moves elements; extend changes the modulus. Only one of the two
    // is obvious, which is why the brief asked for both.
    const before = pickFrom(LIBRARY, DAY, hashDayKey);
    const extended = [...LIBRARY, 'lib_hallway_0'];
    const after = pickFrom(extended, DAY, hashDayKey);
    expect(after).not.toBe(before);
  });

  test('a reorder shifts many days at once, not an unlucky one', () => {
    const sorted = [...LIBRARY].sort();
    const days = Array.from({length: 28}, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}`);
    const moved = days.filter((d) => pickFrom(LIBRARY, d, hashDayKey) !== pickFrom(sorted, d, hashDayKey));
    expect(moved.length).toBeGreaterThan(5);
  });
});

describe('🔑 the RECORDED bonus survives both operations', () => {
  // The whole point: history comes from the log, not from running the rule
  // again against a list that has since changed.
  const log = [
    record('lib_kitchen_0', DAY, false),
    record(pickFrom(LIBRARY, DAY, hashDayKey)!, DAY, true),
  ];

  test('reordering the library does not move the recorded answer', () => {
    const answer = recordedBonus(log);
    // Simulate the library being sorted afterwards. The records are untouched,
    // because nothing rewrites a completion record.
    const sorted = [...LIBRARY].sort();
    expect(pickFrom(sorted, DAY, hashDayKey)).not.toBe(answer); // recompute moved
    expect(recordedBonus(log)).toBe(answer);                     // history did not
  });

  test('extending the library does not move it either', () => {
    const answer = recordedBonus(log);
    const extended = [...LIBRARY, 'lib_hallway_0'];
    expect(pickFrom(extended, DAY, hashDayKey)).not.toBe(answer);
    expect(recordedBonus(log)).toBe(answer);
  });

  test('exactly one record per day carries the flag', () => {
    expect(log.filter((r) => r.wasBonusTask === true)).toHaveLength(1);
  });

  test('a day whose bonus task was never completed records no true flag', () => {
    // Correct, and distinguishable from "unknown" below: the player simply did
    // not do that task, so nothing paid double.
    const missed = [record('lib_kitchen_0', DAY, false), record('lib_bedroom_0', DAY, false)];
    expect(recordedBonus(missed)).toBeNull();
    expect(missed.every((r) => r.wasBonusTask === false)).toBe(true);
  });
});

describe('⚠️ three states, because false and unknown are different claims', () => {
  test('undefined means UNKNOWABLE — written before the field existed', () => {
    const legacy = {
      taskId: 'lib_kitchen_0',
      room: 'RoomType.kitchen',
      title: 'Wash the dishes',
      dayKey: DAY,
    } as CompletionRecord;
    expect(legacy.wasBonusTask).toBeUndefined();
    // Not null, not false. A caller must be able to tell "nobody looked" from
    // "looked, and it was not the bonus" — the same discipline as roomTaskCount.
    expect(recordedBonus([legacy])).toBeNull();
  });

  test('a legacy record is not silently treated as "not the bonus"', () => {
    const legacy = {taskId: 'x', room: 'r', title: 't', dayKey: DAY} as CompletionRecord;
    expect(legacy.wasBonusTask === false).toBe(false);
  });
});

describe('the fixture rule matches the source', () => {
  // A fixture that reimplements the rule can drift into testing itself. These
  // read the real files, so the fixture cannot quietly diverge.
  const readRaw = (f: string): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', f), 'utf8');

  /**
   * 🔑 W2-29. CODE, not prose. `bonusPaid is deliberately NOT recorded` asserts
   * `not.toMatch(/bonusPaid:\s/)` — and the comment RIGHT ABOVE that code
   * explains at length why bonusPaid is not recorded. Unstripped, adding the
   * words `bonusPaid: ` to that explanation would turn the guard RED for a
   * change that never happened. The doc half of that test reads raw.
   */
  const read = (f: string): string => codeOf(readRaw(f));

  test('bonusTaskIdFor still indexes into the list — the premise of this file', () => {
    expect(read('dailyBonusTask.ts')).toContain(
      'TASK_LIBRARY_IDS[hashDayKey(dayKey) % TASK_LIBRARY_IDS.length]',
    );
  });

  test('the writer stamps wasBonusTask from the payer\'s id, not a recomputation', () => {
    const code = read('index.ts');
    expect(code).toContain('wasBonusTask: bonusTaskId != null && task.id === bonusTaskId');
    expect(code).toContain('applyQuestProgress(uid, dayKey, granted.bonusTaskId)');
  });

  test('bonusPaid is deliberately NOT recorded, and the reason is written down', () => {
    // Recording a write-once snapshot of a flag that mutates within the day
    // would look authoritative and be wrong.
    expect(read('index.ts')).not.toMatch(/bonusPaid:\s/);          // CODE
    expect(readRaw('index.ts')).toContain('DELIBERATELY NOT RECORDED'); // DOC
  });
});
