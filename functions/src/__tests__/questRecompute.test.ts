// functions/src/__tests__/questRecompute.test.ts
//
// W2-13. Replaying the completion log through the live evaluator.
//
// 🔴 The gate the brief asked for by name is the third block: A RECOMPUTE
// CANNOT RE-GRANT A CLAIMED TIER, tested by attempting exactly that rather than
// by asserting the happy path.

import {recomputeFromLog, recomputeDelta, censusForDay} from '../questRecompute';
import {CompletionRecord} from '../completionLog';
import {evaluateQuests, QuestStateMap, QUEST_REWARDS} from '../quests';
import {codeOf, handlerBody} from './helpers/sourceText';

function rec(taskId: string, dayKey: string, over: Partial<CompletionRecord> = {}): CompletionRecord {
  return {
    taskId,
    room: 'RoomType.bedroom',
    title: 'Make your bed',
    dayKey,
    loggedAt: null as never,
    ...over,
  } as CompletionRecord;
}

const day = (n: number) => `2026-08-${String(n).padStart(2, '0')}`;
/** Eight consecutive days of making the bed — enough to clear all three tiers. */
const BED_RUN = Array.from({length: 8}, (_, i) => rec('t_bed', day(i + 1)));

describe('the log replays through the SAME evaluator, not a second one', () => {
  test('a recompute of a streak reproduces what the live path produced', () => {
    // Live: eight days of completions, evaluated one day at a time.
    let live: QuestStateMap = {};
    const livePayouts = [];
    for (let i = 1; i <= 8; i++) {
      const r = evaluateQuests(live, [{id: 't_bed', room: 'RoomType.bedroom', title: 'Make your bed'}], day(i), {});
      live = r.state;
      livePayouts.push(...r.payouts);
    }

    const replayed = recomputeFromLog(BED_RUN);

    expect(replayed.state.bed_head.value).toBe(live.bed_head.value);
    expect(replayed.state.bed_head.claimedTiers.sort()).toEqual(
      live.bed_head.claimedTiers.sort(),
    );
    expect(replayed.payouts.map((p) => p.threshold)).toEqual(
      livePayouts.map((p) => p.threshold),
    );
    expect(replayed.payouts.map((p) => p.xp)).toEqual(livePayouts.map((p) => p.xp));
  });

  test('days are replayed in chronological order regardless of record order', () => {
    // A streak is a statement about day SEQUENCE. Out-of-order replay does not
    // merely mis-count, it computes a different quantity.
    const shuffled = [...BED_RUN].reverse();
    expect(recomputeFromLog(shuffled).state.bed_head.value).toBe(8);
  });

  test('a gap in the log breaks the streak exactly as the live path would', () => {
    const withGap = [rec('t_bed', day(1)), rec('t_bed', day(2)), rec('t_bed', day(9))];
    expect(recomputeFromLog(withGap).state.bed_head.value).toBe(1);
  });

  test('an empty log reports blind, not zero', () => {
    const r = recomputeFromLog([]);
    expect(r.payouts).toEqual([]);
    expect(r.blindBefore).toBeNull();
    expect(r.approximations.join(' ')).toMatch(/blind/i);
  });
});

describe('the window is an argument, never a default', () => {
  test('with no window, everything the log holds is replayed', () => {
    const r = recomputeFromLog(BED_RUN);
    expect(r.recordsReplayed).toBe(8);
    expect(r.daysWithRecords).toBe(8);
  });

  test('a from/to window restricts the replay', () => {
    const r = recomputeFromLog(BED_RUN, {from: day(3), to: day(5)});
    expect(r.recordsReplayed).toBe(3);
    expect(r.state.bed_head.value).toBe(3);
  });

  test('earliest and latest come from the WHOLE log, not the window', () => {
    // Otherwise a narrow window would misreport how far back data exists.
    const r = recomputeFromLog(BED_RUN, {from: day(5), to: day(6)});
    expect(r.earliestRecord).toBe(day(1));
    expect(r.latestRecord).toBe(day(8));
  });
});

describe('📌 blind-before is reported, so "no data" cannot read as "no progress"', () => {
  test('blindBefore is the earliest record the log holds', () => {
    expect(recomputeFromLog(BED_RUN).blindBefore).toBe(day(1));
  });

  test('a window starting before the log says so, loudly', () => {
    const r = recomputeFromLog(BED_RUN, {from: '2026-01-01'});
    expect(r.windowPrecedesLog).toBe(true);
    expect(r.approximations.join(' ')).toMatch(/UNOBSERVED, not empty/);
  });

  test('a window inside the log is not flagged', () => {
    const r = recomputeFromLog(BED_RUN, {from: day(2)});
    expect(r.windowPrecedesLog).toBe(false);
  });

  test('the two indistinguishable cases are distinguishable in the output', () => {
    // This is the whole point of the field: a player with genuinely no progress
    // and a player the log never saw produce the same zero.
    const noProgress = recomputeFromLog([rec('t_other', day(1), {title: 'Something else'})]);
    const noData = recomputeFromLog([]);
    expect(noProgress.payouts).toEqual([]);
    expect(noData.payouts).toEqual([]);
    // ...and yet:
    expect(noProgress.blindBefore).toBe(day(1));
    expect(noData.blindBefore).toBeNull();
  });
});

describe('🔴 a recompute cannot re-grant a claimed tier', () => {
  // The attack: a player has already been paid. Run an audit over the same log
  // and hand its payouts to a granter. If the payouts include tiers already
  // claimed, the audit tool has become a level-up farm.
  test('replaying the same log against live state emits NO payouts', () => {
    const live = recomputeFromLog(BED_RUN).state; // as if already paid
    const delta = recomputeDelta(BED_RUN, live);
    expect(delta.payouts).toEqual([]);
  });

  test('the attack repeated ten times still emits nothing', () => {
    let live = recomputeFromLog(BED_RUN).state;
    for (let i = 0; i < 10; i++) {
      const delta = recomputeDelta(BED_RUN, live);
      expect(delta.payouts).toEqual([]);
      live = delta.state;
    }
  });

  test('no XP is emitted by a repeat recompute — the permanent half', () => {
    const live = recomputeFromLog(BED_RUN).state;
    const totalXp = recomputeDelta(BED_RUN, live).payouts.reduce((s, p) => s + p.xp, 0);
    expect(totalXp).toBe(0);
  });

  test('but a GENUINELY new day still produces its payout', () => {
    // The guard must not be so blunt that it makes recompute useless: a tier
    // never paid should still be reported.
    const partial = BED_RUN.slice(0, 3); // reaches the 3-tier only
    const live = recomputeFromLog(partial).state;
    const delta = recomputeDelta(BED_RUN, live);
    expect(delta.payouts.map((p) => p.threshold)).toEqual([5, 8]);
    expect(delta.payouts.map((p) => p.xp)).toEqual([
      QUEST_REWARDS.mid.xp,
      QUEST_REWARDS.long.xp,
    ]);
  });

  test('⚠️ CONTROL: from-scratch replay DOES re-emit already-paid tiers', () => {
    // This is why recomputeDelta exists and why a granter must never be handed
    // a from-scratch report. Without priorState the same log re-reports all
    // three tiers — the exact double-pay this block guards against.
    const fromScratch = recomputeFromLog(BED_RUN);
    expect(fromScratch.payouts.map((p) => p.threshold)).toEqual([3, 5, 8]);
  });
});

describe('🔑 W2-14 — the fourth kind replays too, from its own recorded denominator', () => {
  const bath = (id: string, dayKey: string, count: number | undefined) =>
    rec(id, dayKey, {
      room: 'RoomType.bathroom',
      title: 'Scrub sink',
      ...(count === undefined ? {} : {roomTaskCount: count}),
    });

  test('a completed sweep replays exactly — all four kinds now recompute', () => {
    // Two of two bathroom tasks, and the record says the room held two.
    const log = [bath('b1', day(1), 2), bath('b2', day(1), 2)];
    const r = recomputeFromLog(log);
    const won = r.payouts.filter((p) => p.questId === 'bathroom_warrior');
    expect(won).toHaveLength(1);
    expect(won[0].reward.chestCategory).toBe('furniture');
    expect(r.approximations).toEqual([]);
  });

  test('a PARTIAL clean does not replay as a sweep', () => {
    // One of two. The denominator is what makes this judgeable at all.
    const r = recomputeFromLog([bath('b1', day(1), 2)]);
    expect(r.payouts.filter((p) => p.questId === 'bathroom_warrior')).toEqual([]);
  });

  test('the day is judged by ITS OWN census, not by a later one', () => {
    // Day 1: room held 1 task, and it was done — a real sweep.
    // Day 2: room now holds 3, and one was done — not a sweep.
    // Judging day 1 by day 2's census would retroactively un-complete it.
    const log = [bath('b1', day(1), 1), bath('b1', day(2), 3)];
    const r = recomputeFromLog(log);
    expect(r.payouts.filter((p) => p.questId === 'bathroom_warrior')).toHaveLength(1);
  });

  test('a room that LOST tasks does not retroactively gain a sweep', () => {
    // The direction that pays a chest for a clean that never happened.
    // Day 1: 1 of 3 done. Day 5: the room is down to 1 task, all done.
    const log = [bath('b1', day(1), 3), bath('b1', day(5), 1)];
    const r = recomputeFromLog(log);
    const won = r.payouts.filter((p) => p.questId === 'bathroom_warrior');
    // Exactly one — earned on day 5, NOT retroactively on day 1.
    expect(won).toHaveLength(1);
  });

  test('where a day disagrees with itself, the LARGER denominator wins', () => {
    // Tasks added mid-day: two records, counts 2 and 3. Conservative direction —
    // an ambiguous day may fail to pay a chest, never pay an unearned one.
    const log = [bath('b1', day(1), 2), bath('b2', day(1), 3)];
    expect(censusForDay(log)['RoomType.bathroom']).toBe(3);
    expect(recomputeFromLog(log).payouts.filter((p) => p.questId === 'bathroom_warrior')).toEqual([]);
  });
});

describe('🔴 a record with no census stays INERT, never guessed', () => {
  const bathNoCensus = (id: string, dayKey: string) =>
    rec(id, dayKey, {room: 'RoomType.bathroom', title: 'Scrub sink'});

  test('a census-less record does not promote a partial clean into a sweep', () => {
    // The pre-W2-14 record shape. Defaulting the missing count to 0 would make
    // `0 completed >= 0 existing` true and pay a chest for nothing.
    const r = recomputeFromLog([bathNoCensus('b1', day(1))]);
    expect(r.payouts.filter((p) => p.questId === 'bathroom_warrior')).toEqual([]);
  });

  test('censusForDay omits the room entirely rather than defaulting it', () => {
    expect(censusForDay([bathNoCensus('b1', day(1))])).toEqual({});
  });

  test('the report COUNTS and NAMES those days rather than hiding them', () => {
    const r = recomputeFromLog([bathNoCensus('b1', day(1)), bathNoCensus('b2', day(2))]);
    expect(r.censuslessDays).toBe(2);
    expect(r.approximations.join(' ')).toMatch(/no roomTaskCount/);
    expect(r.approximations.join(' ')).toMatch(/inert, not zero/);
    expect(r.approximations.join(' ')).toMatch(/cannot be recovered/);
  });

  test('a log with censuses reports zero censusless days and no caveats', () => {
    const log = [
      rec('b1', day(1), {room: 'RoomType.bathroom', title: 'Scrub sink', roomTaskCount: 1}),
    ];
    const r = recomputeFromLog(log);
    expect(r.censuslessDays).toBe(0);
    expect(r.approximations).toEqual([]);
  });

  test('mixed days: the ones that CAN replay still do', () => {
    const log = [
      bathNoCensus('b1', day(1)),
      rec('b1', day(4), {room: 'RoomType.bathroom', title: 'Scrub sink', roomTaskCount: 1}),
    ];
    const r = recomputeFromLog(log);
    expect(r.censuslessDays).toBe(1);
    expect(r.payouts.filter((p) => p.questId === 'bathroom_warrior')).toHaveLength(1);
  });

  test('⚠️ CONTROL: defaulting a missing census to 0 WOULD pay the chest', () => {
    // Demonstrates that the omission in censusForDay is load-bearing, rather
    // than merely asserting today's behaviour. An explicit 0 census is the bug.
    const r = recomputeFromLog([bathNoCensus('b1', day(1))], {
      roomTaskCounts: {'RoomType.bathroom': 0},
    });
    // evaluateQuests' own `total === 0` guard is the second line of defence and
    // still refuses — which is why THIS is safe and a nonzero stale count is not.
    expect(r.payouts.filter((p) => p.questId === 'bathroom_warrior')).toEqual([]);
  });

  test('⚠️ CONTROL: a STALE census does pay, which is why we never supply one', () => {
    // The real failure the design refuses: today's census (1 task) applied to a
    // day when the room held three. One completion becomes a "sweep".
    const r = recomputeFromLog([bathNoCensus('b1', day(1))], {
      roomTaskCounts: {'RoomType.bathroom': 1},
    });
    expect(r.payouts.filter((p) => p.questId === 'bathroom_warrior')).toHaveLength(1);
    expect(r.approximations.join(' ')).toMatch(/CALLER-SUPPLIED census/);
  });
});

describe('the recompute does not mutate what it is given', () => {
  test('the live state passed in is untouched', () => {
    const live = recomputeFromLog(BED_RUN.slice(0, 3)).state;
    const snapshot = JSON.parse(JSON.stringify(live));
    recomputeDelta(BED_RUN, live);
    expect(live).toEqual(snapshot);
  });

  test('the record array is untouched', () => {
    const records = [...BED_RUN];
    const snapshot = records.map((r) => r.dayKey);
    recomputeFromLog(records);
    expect(records.map((r) => r.dayKey)).toEqual(snapshot);
  });

  test('nothing in the module writes or grants', () => {
    // Compute-and-report is the entire contract; a write here would make an
    // audit tool into a migration that guesses.
    const api = require('../questRecompute');
    const names = Object.keys(api).join(' ').toLowerCase();
    expect(names).not.toMatch(/grant|write|commit|apply|persist/);
  });
});

// ---------------------------------------------------------------------------
// The callable's read-only contract, gated rather than asserted
// ---------------------------------------------------------------------------
//
// 🔴 EVERY SAFETY CLAIM IN THIS FEATURE RESTS ON "IT GRANTS NOTHING". Prose
// saying so is not a gate — the reachability suite in this repo exists because
// a prose warning at index.ts:60 did not prevent anything. So the handler body
// is checked against the source.
describe('recomputeQuestReport writes nothing, by gate not by promise', () => {
  /**
   * CODE view of the handler, via the shared helper (W2-30).
   *
   * 🔑 Measured before changing: every forbidden token — `.set(`, `awardXp`,
   * `runTransaction`, `recomputeFromLog(` — was absent RAW and STRIPPED, so
   * this guard was never lying. But `recomputeFromLog` DOES appear in a comment
   * inside the slice; it escaped only because the assertion includes the
   * opening paren and the prose does not. A spelling coincidence, not a
   * property, and now it does not have to be either.
   *
   * handlerBody() also carries the slice rule that was got wrong twice this
   * session: an onCall handler ends at the first column-0 `});`, and slicing to
   * the next `export const` runs past it into applyQuestProgress, which DOES
   * write — asserting about the wrong function while passing.
   */
  const handler = (): string =>
    codeOf(
      handlerBody(
        require('fs').readFileSync(
          require('path').join(__dirname, '..', 'index.ts'),
          'utf8',
        ),
        'recomputeQuestReport',
      ),
    );

  test('the handler contains no write of any kind', () => {
    const body = handler();
    for (const forbidden of ['.set(', '.update(', '.delete(', '.create(', 'batch(', 'runTransaction', 'FieldValue.increment']) {
      expect(body).not.toContain(forbidden);
    }
  });

  test('the handler never calls a granter', () => {
    const body = handler();
    for (const forbidden of ['awardXp', 'grantTaskRewards', 'applyQuestProgress', 'pickChestItem', 'rollRarity']) {
      expect(body).not.toContain(forbidden);
    }
  });

  test('it uses recomputeDelta, not the from-scratch replay', () => {
    // From-scratch re-reports already-paid tiers; handing those to a granter
    // later would double-pay. The CONTROL test above shows that happening.
    const body = handler();
    expect(body).toContain('recomputeDelta(');
    expect(body).not.toContain('recomputeFromLog(');
  });

  test('it reports the blind-before date', () => {
    expect(handler()).toContain('blindBefore');
  });

  test('questRecompute.ts imports no Firestore at all', () => {
    const fs = require('fs');
    const path = require('path');
    const src: string = fs.readFileSync(path.join(__dirname, '..', 'questRecompute.ts'), 'utf8');
    expect(src).not.toMatch(/from 'firebase-admin/);
    expect(src).not.toMatch(/require\('firebase-admin/);
  });
});
