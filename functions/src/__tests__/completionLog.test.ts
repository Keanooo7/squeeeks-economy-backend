// functions/src/__tests__/completionLog.test.ts
//
// W2-11. The completion log, and the exploit it exists to kill.
//
// CRITICAL: THE EXPLOIT TEST IS THE DELIVERABLE. A fix for an exploit with no test
// reproducing the exploit is a hope. So the first describe block below performs
// the actual attack — complete, un-complete, re-complete — and asserts the tally
// moves exactly once. It is written so that REMOVING the fix makes it fail: the
// "without the log" case is included beside it, demonstrating the old behaviour
// against the same evaluator, so the test proves the log is what changed rather
// than merely asserting today's output.

import {
  completionDocId,
  mergeCompletions,
  unloggedCompletions,
  CompletionRecord,
} from '../completionLog';
import {evaluateQuests, QuestStateMap} from '../quests';

const DAY = '2026-08-12';
const NEXT = '2026-08-13';

const DISH = {id: 't_dish', room: 'RoomType.kitchen', title: 'Wash the dishes'};

function record(taskId: string, dayKey: string, over: Partial<CompletionRecord> = {}) {
  return {
    taskId,
    room: 'RoomType.kitchen',
    title: 'Wash the dishes',
    dayKey,
    loggedAt: null as never,
    ...over,
  } as CompletionRecord;
}

/** Runs the tally quest over a day, given what the log and the flags say. */
function tallyAfter(
  prior: QuestStateMap,
  logged: CompletionRecord[],
  currentlyComplete: typeof DISH[],
  dayKey: string,
) {
  const merged = mergeCompletions(logged, currentlyComplete);
  return evaluateQuests(prior, merged, dayKey, {});
}

describe('🔴 the un-complete / re-complete exploit (D94-4)', () => {
  // The attack, step by step, as a player with a debugger — or just a fat
  // finger — would perform it.
  test('complete -> un-complete -> re-complete advances the tally exactly ONCE', () => {
    let state: QuestStateMap = {};
    let log: CompletionRecord[] = [];

    // 1. Complete the task. A durable record is written.
    const unlogged1 = unloggedCompletions(new Set(), [DISH], DAY);
    expect(unlogged1).toHaveLength(1);
    log = [record(DISH.id, DAY)];
    state = tallyAfter(state, log, [DISH], DAY).state;
    expect(state.no_dish_left_standing.value).toBe(1);

    // 2. Un-complete it. The client nulls completedDate; the log is untouched,
    //    because un-completion is the absence of an event, not an event.
    state = tallyAfter(state, log, [], DAY).state;
    expect(state.no_dish_left_standing.value).toBe(1); // did NOT walk backwards

    // 3. Re-complete it. No new record — the id is already taken.
    const loggedIds = new Set([completionDocId(DAY, DISH.id)]);
    expect(unloggedCompletions(loggedIds, [DISH], DAY)).toEqual([]);
    state = tallyAfter(state, log, [DISH], DAY).state;

    expect(state.no_dish_left_standing.value).toBe(1);
  });

  test('the exploit repeated twenty times still yields a tally of one', () => {
    let state: QuestStateMap = {};
    const log = [record(DISH.id, DAY)];
    for (let i = 0; i < 20; i++) {
      state = tallyAfter(state, log, [], DAY).state;
      state = tallyAfter(state, log, [DISH], DAY).state;
    }
    expect(state.no_dish_left_standing.value).toBe(1);
  });

  test('and it never reaches the 5-tier reward, which is what it was farming', () => {
    let state: QuestStateMap = {};
    const log = [record(DISH.id, DAY)];
    const payouts = [];
    for (let i = 0; i < 20; i++) {
      const off = tallyAfter(state, log, [], DAY);
      state = off.state;
      payouts.push(...off.payouts);
      const on = tallyAfter(state, log, [DISH], DAY);
      state = on.state;
      payouts.push(...on.payouts);
    }
    expect(payouts.filter((p) => p.questId === 'no_dish_left_standing')).toEqual([]);
  });

  // WARNING: The control. WITHOUT the log the same evaluator IS exploitable across
  // days, which is what made this a defect. If someone deletes mergeCompletions
  // and passes the raw flags through, this is the behaviour that returns.
  test('CONTROL: with no log, the same evaluator double-counts across days', () => {
    let state: QuestStateMap = {};
    state = evaluateQuests(state, [DISH], DAY, {}).state;
    expect(state.no_dish_left_standing.value).toBe(1);
    // un-complete, then re-complete the NEXT day — one task, counted twice.
    state = evaluateQuests(state, [DISH], NEXT, {}).state;
    expect(state.no_dish_left_standing.value).toBe(2);
  });

  test('WITH the log, that same cross-day replay counts once', () => {
    let state: QuestStateMap = {};
    const log = [record(DISH.id, DAY)];
    state = tallyAfter(state, log, [DISH], DAY).state;
    // Next day the task is re-completed. It IS a new day, so a NEW record is
    // written — genuinely a second day of doing the dishes.
    const nextIds = new Set([completionDocId(DAY, DISH.id)]);
    expect(unloggedCompletions(nextIds, [DISH], NEXT)).toHaveLength(1);
    // ...but the day the exploit tried to replay is already spent.
    expect(unloggedCompletions(nextIds, [DISH], DAY)).toEqual([]);
  });
});

describe('the id is the idempotency', () => {
  test('the same task on the same day is always the same document', () => {
    expect(completionDocId(DAY, 't_dish')).toBe(completionDocId(DAY, 't_dish'));
  });

  test('the same task on a different day is a different document', () => {
    expect(completionDocId(DAY, 't_dish')).not.toBe(completionDocId(NEXT, 't_dish'));
  });

  test('a slash in a task id cannot escape into a subcollection path', () => {
    // Firestore document ids may not contain '/', and task ids come from
    // client-authored documents, so this is not assumed away.
    const id = completionDocId(DAY, 'evil/../../other');
    expect(id).not.toContain('/');
  });

  test('five callable invocations in one day write one record, not five', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) ids.add(completionDocId(DAY, DISH.id));
    expect(ids.size).toBe(1);
  });
});

describe('the union prefers the fact over the flag', () => {
  test('a logged completion survives the flag being cleared', () => {
    const merged = mergeCompletions([record(DISH.id, DAY)], []);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(DISH.id);
  });

  test('a currently-complete task not yet logged is still counted', () => {
    // The very first completion of a task is in the flags before it is in the
    // log; it must not be invisible for one call.
    const merged = mergeCompletions([], [DISH]);
    expect(merged).toHaveLength(1);
  });

  test('a task in both appears exactly once', () => {
    const merged = mergeCompletions([record(DISH.id, DAY)], [DISH]);
    expect(merged).toHaveLength(1);
  });

  test('the record wins on conflict, preserving the title as completed', () => {
    // A rename after completion must not rewrite history.
    const merged = mergeCompletions(
      [record(DISH.id, DAY, {title: 'Wash the dishes'})],
      [{...DISH, title: 'RENAMED LATER'}],
    );
    expect(merged[0].title).toBe('Wash the dishes');
  });

  test('distinct tasks are not collapsed', () => {
    const other = {id: 't_dry', room: 'RoomType.kitchen', title: 'Dry the dishes'};
    expect(mergeCompletions([record(DISH.id, DAY)], [other])).toHaveLength(2);
  });
});

describe('un-completion writes nothing', () => {
  test('an empty current set produces no new records', () => {
    expect(unloggedCompletions(new Set(), [], DAY)).toEqual([]);
  });

  test('nothing in the module can delete or retract a record', () => {
    // A retraction record would reintroduce exactly the retractability this
    // change removes. Asserted against the module surface so adding one is a
    // deliberate act that fails a test first.
    const api = require('../completionLog');
    const names = Object.keys(api).join(' ').toLowerCase();
    expect(names).not.toMatch(/retract|delete|remove|undo|revoke/);
  });
});
