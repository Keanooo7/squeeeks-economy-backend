// functions/src/__tests__/quests.test.ts
//
// W2-10 / Q1. The quest evaluator.
//
// 🔑 THIS FILE CARRIES MORE WEIGHT THAN A USUAL SUITE, and the reason is in the
// header of quests.ts: there is NO completion history in Firestore, so quest
// progress is accumulated forward and CANNOT BE RECOMPUTED. A bug here cannot be
// repaired by re-running the evaluator over the past — there is no past to run
// it over. Every mis-award is permanent, or an apology.
//
// So the evaluator is pure and tested without a Firestore mock, and the cases
// below are chosen for the failures that would actually reach a player: double
// counting under replay, a streak that counts "three times" as "three days in a
// row", and a sweep that completes itself when a room is empty.

import {
  evaluateQuests,
  QUEST_CATALOGUE,
  QUEST_REWARDS,
  QUEST_CHEST_XP,
  QUESTS_NOT_BUILDABLE,
  QuestStateMap,
  QuestDef,
  CompletedTask,
  dayGap,
} from '../quests';
import {CHEST_PRICE} from '../itemPool';

const BED: CompletedTask = {id: 't_bed', room: 'RoomType.bedroom', title: 'Make your bed'};
const DISH: CompletedTask = {id: 't_dish', room: 'RoomType.kitchen', title: 'Wash the dishes'};
const DISH2: CompletedTask = {id: 't_dish2', room: 'RoomType.kitchen', title: 'Dry the dishes'};

/** No room has any tasks unless a test says so — sweeps stay inert by default. */
const NO_ROOMS: Record<string, number> = {};

function run(
  prior: QuestStateMap,
  tasks: CompletedTask[],
  dayKey: string,
  rooms = NO_ROOMS,
  catalogue?: QuestDef[],
) {
  return evaluateQuests(prior, tasks, dayKey, rooms, catalogue);
}

describe('the evaluator is idempotent — the property replay depends on', () => {
  // recordTaskCompletion fires on EVERY completion and hands the evaluator the
  // whole day's completed set, not a delta. This is the failure that would have
  // shipped: five dishes read as fifteen because the callable fired three times.
  test('re-running the same day does not advance a tally', () => {
    const first = run({}, [DISH, DISH2], '2026-08-12');
    const second = run(first.state, [DISH, DISH2], '2026-08-12');
    const third = run(second.state, [DISH, DISH2], '2026-08-12');
    expect(first.state.no_dish_left_standing.value).toBe(2);
    expect(second.state.no_dish_left_standing.value).toBe(2);
    expect(third.state.no_dish_left_standing.value).toBe(2);
  });

  test('a second dish later the same day still counts, once', () => {
    const first = run({}, [DISH], '2026-08-12');
    expect(first.state.no_dish_left_standing.value).toBe(1);
    const second = run(first.state, [DISH, DISH2], '2026-08-12');
    expect(second.state.no_dish_left_standing.value).toBe(2);
    const replay = run(second.state, [DISH, DISH2], '2026-08-12');
    expect(replay.state.no_dish_left_standing.value).toBe(2);
  });

  test('a tier pays exactly once, however many times the day is replayed', () => {
    let state: QuestStateMap = {};
    const payouts = [];
    for (let day = 1; day <= 6; day++) {
      const key = `2026-08-${String(day).padStart(2, '0')}`;
      for (let replay = 0; replay < 3; replay++) {
        const r = run(state, [DISH], key);
        state = r.state;
        payouts.push(...r.payouts);
      }
    }
    const dishPayouts = payouts.filter((p) => p.questId === 'no_dish_left_standing');
    expect(dishPayouts).toHaveLength(1);
    expect(dishPayouts[0].sponges).toBe(QUEST_REWARDS.easy.sponges);
  });
});

describe('a streak counts days, not completions', () => {
  test('three consecutive days pays the 3-tier', () => {
    let state: QuestStateMap = {};
    const all = [];
    for (const d of ['2026-08-10', '2026-08-11', '2026-08-12']) {
      const r = run(state, [BED], d);
      state = r.state;
      all.push(...r.payouts);
    }
    expect(state.bed_head.value).toBe(3);
    expect(all.filter((p) => p.questId === 'bed_head')).toHaveLength(1);
  });

  test('🔴 three completions on ONE day is a run of one, not three', () => {
    let state: QuestStateMap = {};
    for (let i = 0; i < 3; i++) state = run(state, [BED], '2026-08-12').state;
    expect(state.bed_head.value).toBe(1);
  });

  test('a missed day resets the run to 1 rather than continuing it', () => {
    let state: QuestStateMap = {};
    state = run(state, [BED], '2026-08-10').state;
    state = run(state, [BED], '2026-08-11').state;
    expect(state.bed_head.value).toBe(2);
    state = run(state, [BED], '2026-08-13').state; // 12th missed
    expect(state.bed_head.value).toBe(1);
  });

  test('a broken run does not re-pay a tier it already earned', () => {
    let state: QuestStateMap = {};
    const all = [];
    for (const d of ['2026-08-01', '2026-08-02', '2026-08-03']) {
      const r = run(state, [BED], d);
      state = r.state;
      all.push(...r.payouts);
    }
    // Break it, then climb back to 3.
    for (const d of ['2026-08-10', '2026-08-11', '2026-08-12']) {
      const r = run(state, [BED], d);
      state = r.state;
      all.push(...r.payouts);
    }
    expect(all.filter((p) => p.questId === 'bed_head' && p.threshold === 3)).toHaveLength(1);
  });

  test('tiers pay along the way, one each, at 3 / 5 / 8', () => {
    let state: QuestStateMap = {};
    const all = [];
    for (let day = 1; day <= 8; day++) {
      const r = run(state, [BED], `2026-08-${String(day).padStart(2, '0')}`);
      state = r.state;
      all.push(...r.payouts);
    }
    const bed = all.filter((p) => p.questId === 'bed_head');
    expect(bed.map((p) => p.threshold)).toEqual([3, 5, 8]);
    expect(bed.map((p) => p.sponges)).toEqual([
      QUEST_REWARDS.easy.sponges,
      QUEST_REWARDS.mid.sponges,
      QUEST_REWARDS.long.sponges,
    ]);
    expect(bed.map((p) => p.xp)).toEqual([
      QUEST_REWARDS.easy.xp,
      QUEST_REWARDS.mid.xp,
      QUEST_REWARDS.long.xp,
    ]);
  });

  test('a non-matching task does not advance the streak', () => {
    const r = run({}, [DISH], '2026-08-12');
    expect(r.state.bed_head?.value ?? 0).toBe(0);
  });

  test('the day rule comes from the streak feature, not from local date maths', () => {
    // dayGap routes through streakDate/parseNaiveDate. If someone replaces it
    // with a naive subtraction this still passes — but if they change the
    // SIGNATURE or drop the import, it fails to compile, which is the point.
    expect(dayGap('2026-08-11', '2026-08-12')).toBe(1);
    expect(dayGap('2026-08-12', '2026-08-12')).toBe(0);
    expect(dayGap('2026-02-28', '2026-03-01')).toBe(1); // 2026 is not a leap year
  });
});

describe('a sweep needs the room to actually have tasks', () => {
  const BATH: CompletedTask = {id: 'b1', room: 'RoomType.bathroom', title: 'Scrub sink'};
  const BATH2: CompletedTask = {id: 'b2', room: 'RoomType.bathroom', title: 'Clean toilet'};

  test('🔴 an empty room does not complete a sweep by vacuous truth', () => {
    // Without the total === 0 guard, 0 completed >= 0 existing is TRUE and a
    // player with no bathroom tasks wins a furniture chest for doing nothing.
    const r = run({}, [], '2026-08-12', {'RoomType.bathroom': 0});
    expect(r.payouts.filter((p) => p.questId === 'bathroom_warrior')).toEqual([]);
  });

  test('a partial room is not a sweep', () => {
    const r = run({}, [BATH], '2026-08-12', {'RoomType.bathroom': 2});
    expect(r.payouts.filter((p) => p.questId === 'bathroom_warrior')).toEqual([]);
  });

  test('every task in the room, in one day, pays the matching chest', () => {
    const r = run({}, [BATH, BATH2], '2026-08-12', {'RoomType.bathroom': 2});
    const won = r.payouts.filter((p) => p.questId === 'bathroom_warrior');
    expect(won).toHaveLength(1);
    expect(won[0].reward.kind).toBe('chest');
    expect(won[0].reward.chestCategory).toBe('furniture');
    expect(won[0].sponges).toBe(0);
  });

  test('a sweep pays once, not again the next day', () => {
    const first = run({}, [BATH, BATH2], '2026-08-12', {'RoomType.bathroom': 2});
    const second = run(first.state, [BATH, BATH2], '2026-08-13', {'RoomType.bathroom': 2});
    expect(second.payouts.filter((p) => p.questId === 'bathroom_warrior')).toEqual([]);
  });
});

describe('breadth counts distinct rooms, not tasks', () => {
  const rooms = ['kitchen', 'bathroom', 'bedroom', 'living'].map((r, i) => ({
    id: `r${i}`,
    room: `RoomType.${r}`,
    title: 'Tidy',
  }));

  test('🔴 five tasks in one room is a breadth of one', () => {
    const many = Array.from({length: 5}, (_, i) => ({
      id: `k${i}`,
      room: 'RoomType.kitchen',
      title: 'Tidy',
    }));
    const r = run({}, many, '2026-08-12');
    expect(r.state.grand_tour.value).toBe(1);
    expect(r.payouts.filter((p) => p.questId === 'grand_tour')).toEqual([]);
  });

  test('four distinct rooms in one day pays Grand Tour', () => {
    const r = run({}, rooms, '2026-08-12');
    expect(r.state.grand_tour.value).toBe(4);
    const won = r.payouts.filter((p) => p.questId === 'grand_tour');
    expect(won).toHaveLength(1);
    expect(won[0].sponges).toBe(QUEST_REWARDS.long.sponges);
  });
});

describe('the catalogue and the reward table are coherent', () => {
  test('every quest id is unique', () => {
    const ids = QUEST_CATALOGUE.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every sponge reward names a tier key rather than a literal amount', () => {
    // 🔑 The economy must be a ONE-FILE edit when Brendan sets it. A quest that
    // carried its own number would be a second place to change.
    for (const quest of QUEST_CATALOGUE) {
      for (const tier of quest.tiers) {
        if (tier.reward.kind !== 'sponges') continue;
        expect(Object.keys(QUEST_REWARDS)).toContain(tier.reward.tier);
        expect(tier.reward).not.toHaveProperty('sponges');
      }
    }
  });

  // The same guarantee, extended to XP. This test is the only reason the sponge
  // economy stayed a one-file edit, and XP is the value that CANNOT be walked
  // back once banked — so it needs the guarantee more, not less.
  test('NO quest carries its own XP number either', () => {
    for (const quest of QUEST_CATALOGUE) {
      for (const tier of quest.tiers) {
        expect(tier.reward).not.toHaveProperty('xp');
        expect(tier.reward).not.toHaveProperty('experience');
      }
    }
  });

  test('every resolved XP value traces back to the reward table', () => {
    const permitted = new Set<number>([
      ...Object.values(QUEST_REWARDS).map((r) => r.xp),
      QUEST_CHEST_XP,
    ]);
    let state: QuestStateMap = {};
    const seen: number[] = [];
    for (let day = 1; day <= 20; day++) {
      const r = evaluateQuests(
        state,
        [BED, DISH, {id: 'b1', room: 'RoomType.bathroom', title: 'Scrub sink'}],
        `2026-08-${String(day).padStart(2, '0')}`,
        {'RoomType.bathroom': 1},
      );
      state = r.state;
      seen.push(...r.payouts.map((p) => p.xp));
    }
    expect(seen.length).toBeGreaterThan(4);
    for (const xp of seen) expect(permitted.has(xp)).toBe(true);
  });

  test('every tier grants XP, including the chest tiers', () => {
    // A chest tier granting no XP would make the hardest quests the only ones
    // that do not advance the level, which is backwards.
    const r = evaluateQuests(
      {},
      [{id: 'b1', room: 'RoomType.bathroom', title: 'Scrub sink'}],
      '2026-08-12',
      {'RoomType.bathroom': 1},
    );
    const chest = r.payouts.filter((p) => p.reward.kind === 'chest');
    expect(chest.length).toBeGreaterThan(0);
    for (const p of chest) expect(p.xp).toBe(QUEST_CHEST_XP);
  });

  test('every chest reward names a real priced chest category', () => {
    for (const quest of QUEST_CATALOGUE) {
      for (const tier of quest.tiers) {
        if (tier.reward.kind !== 'chest') continue;
        expect(Object.keys(CHEST_PRICE)).toContain(tier.reward.chestCategory);
      }
    }
  });

  test('tiers within a quest ascend, so they pay in order', () => {
    for (const quest of QUEST_CATALOGUE) {
      const thresholds = quest.tiers.map((t) => t.threshold);
      expect([...thresholds].sort((a, b) => a - b)).toEqual(thresholds);
    }
  });

  test('every unbuilt spec quest carries a stated reason', () => {
    // A ledger, not an oversight — same shape as BENCHED_SUBJECTS.
    for (const [id, reason] of Object.entries(QUESTS_NOT_BUILDABLE)) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(40);
      expect(QUEST_CATALOGUE.map((q) => q.id)).not.toContain(id);
    }
  });

  test('a room value looks like the enum string the client actually persists', () => {
    // task.toJson() writes `room: room.toString()`, i.e. "RoomType.kitchen".
    // A bare "kitchen" here yields a quest that can never progress and never
    // errors, which is the worst failure mode available.
    for (const quest of QUEST_CATALOGUE) {
      if (!quest.match.room) continue;
      expect(quest.match.room).toMatch(/^RoomType\./);
    }
  });
});

describe('an unknown or empty day does not corrupt state', () => {
  test('a day with no completions leaves everything untouched and pays nothing', () => {
    const seeded = run({}, [BED], '2026-08-11').state;
    const r = run(seeded, [], '2026-08-12');
    expect(r.payouts).toEqual([]);
    expect(r.state.bed_head.value).toBe(1);
  });

  test('the evaluator does not mutate the state object it was given', () => {
    const prior = run({}, [DISH], '2026-08-11').state;
    const snapshot = JSON.parse(JSON.stringify(prior));
    run(prior, [DISH, DISH2], '2026-08-12');
    expect(prior).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// W2-12 — a tier grants XP exactly ONCE
// ---------------------------------------------------------------------------
//
// 🔴 `claimedTiers` already gated sponges. This block proves it gates XP too.
// A re-grantable XP tier is a level-up farm, and it is the same class of defect
// as the un-completion replay closed in W2-11 — except worse, because XP is
// permanent progression and cannot be walked back once banked.
describe('a tier grants XP exactly once', () => {
  test('replaying the day that earned a tier grants XP once, not once per call', () => {
    let state: QuestStateMap = {};
    let xpTotal = 0;
    for (let day = 1; day <= 3; day++) {
      const key = `2026-08-${String(day).padStart(2, '0')}`;
      // Five callable invocations on the same day, as a chatty client produces.
      for (let call = 0; call < 5; call++) {
        const r = evaluateQuests(state, [BED], key, {});
        state = r.state;
        xpTotal += r.payouts.reduce((sum, p) => sum + p.xp, 0);
      }
    }
    expect(state.bed_head.value).toBe(3);
    expect(xpTotal).toBe(QUEST_REWARDS.easy.xp);
  });

  test('a broken and re-climbed streak does not re-grant the tier XP', () => {
    let state: QuestStateMap = {};
    let xpTotal = 0;
    const climb = (days: string[]) => {
      for (const d of days) {
        const r = evaluateQuests(state, [BED], d, {});
        state = r.state;
        xpTotal += r.payouts.reduce((sum, p) => sum + p.xp, 0);
      }
    };
    climb(['2026-08-01', '2026-08-02', '2026-08-03']);
    expect(xpTotal).toBe(QUEST_REWARDS.easy.xp);
    climb(['2026-08-10', '2026-08-11', '2026-08-12']); // break, then re-earn
    expect(xpTotal).toBe(QUEST_REWARDS.easy.xp);
  });

  test('a sweep chest tier grants its XP once across repeated sweeps', () => {
    let state: QuestStateMap = {};
    let xpTotal = 0;
    const BATH = {id: 'b1', room: 'RoomType.bathroom', title: 'Scrub sink'};
    for (let day = 10; day <= 20; day++) {
      const r = evaluateQuests(state, [BATH], `2026-08-${day}`, {'RoomType.bathroom': 1});
      state = r.state;
      xpTotal += r.payouts.reduce((sum, p) => sum + p.xp, 0);
    }
    expect(xpTotal).toBe(QUEST_CHEST_XP);
  });

  test('lifetime XP across the whole catalogue is BOUNDED — the curve argument', () => {
    // The bounded-offset claim in quests.ts is load-bearing: it is why quest XP
    // does not need the level curve retuned. If a future quest becomes
    // repeatable, this test is what notices.
    let state: QuestStateMap = {};
    let xpTotal = 0;
    const ALL = [
      BED, DISH, DISH2,
      {id: 'c1', room: 'RoomType.kitchen', title: 'Wipe the counter'},
      {id: 'm1', room: 'RoomType.bathroom', title: 'Clean the mirror'},
      {id: 'b1', room: 'RoomType.bathroom', title: 'Scrub sink'},
      {id: 'r1', room: 'RoomType.bedroom', title: 'Tidy'},
      {id: 'l1', room: 'RoomType.living', title: 'Tidy'},
    ];
    for (let day = 1; day <= 200; day++) {
      const d = new Date(Date.UTC(2026, 0, 1) + day * 86400000)
        .toISOString()
        .slice(0, 10);
      const r = evaluateQuests(state, ALL, d, {
        'RoomType.bathroom': 2,
        'RoomType.bedroom': 1,
      });
      state = r.state;
      xpTotal += r.payouts.reduce((sum, p) => sum + p.xp, 0);
    }
    // Every tier in the catalogue, claimed once each — and never again over
    // 200 further days of perfect play.
    const maxPossible =
      QUEST_CATALOGUE.reduce((sum, q) => sum + q.tiers.length, 0) *
      Math.max(...Object.values(QUEST_REWARDS).map((r) => r.xp), QUEST_CHEST_XP);
    expect(xpTotal).toBeLessThanOrEqual(maxPossible);
    expect(xpTotal).toBeGreaterThan(0);

    // And it is genuinely finished: 200 more days adds nothing.
    let after = 0;
    for (let day = 400; day < 430; day++) {
      const d = new Date(Date.UTC(2026, 0, 1) + day * 86400000)
        .toISOString()
        .slice(0, 10);
      const r = evaluateQuests(state, ALL, d, {
        'RoomType.bathroom': 2,
        'RoomType.bedroom': 1,
      });
      state = r.state;
      after += r.payouts.reduce((sum, p) => sum + p.xp, 0);
    }
    expect(after).toBe(0);
  });
});
