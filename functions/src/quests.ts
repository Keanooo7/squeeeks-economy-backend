// ---------------------------------------------------------------------------
// Quest lines — server-authoritative progress and rewards
// ---------------------------------------------------------------------------
//
// Spec: Projects/Cleaning/spec-2026-08-12-quest-lines.md (W2-10 / Q1).
//
// 🔴 QUESTS ARE SERVER-AUTHORITATIVE, and that is settled by existing code
// rather than by preference. level_page.dart says of itself: "Read-only by
// construction: every figure comes from playerLevelProvider, which derives from
// the server-authoritative totalXp awarded by awardXp." Quests grant sponges,
// chests and skins; a rewards system evaluated on the client is a gift to
// anyone with a debugger. This is awardXp's shape a second time — the client
// reports task completions, the server decides what they add up to.
//
// ---------------------------------------------------------------------------
// 🔑 HISTORY EXISTS NOW — THIS SECTION WAS REWRITTEN BY W2-11, READ IT AGAIN.
// ---------------------------------------------------------------------------
//
// ⚠️ THE PREVIOUS VERSION OF THIS HEADER SAID "THERE IS NO HISTORY" AND BUILT A
// LONG ARGUMENT ON IT. That was true when this file landed and is now FALSE.
// It is rewritten rather than amended because a stale doctrine comment is worse
// than none: the next window would have inherited a constraint that no longer
// binds and designed around it.
//
// What was true: a task document carries a single `completedDate` scalar that
// the client overwrites on completion and NULLS on un-completion. On its own
// that made a completion RETRACTABLE and left no record of the past.
//
// What changed (W2-11, on Brendan's ruling "they are done then document — work
// started during that day still counts towards it"): every completion now
// writes a durable record to `users/{uid}/completions`, server-side, and
// un-completion writes nothing. See completionLog.ts.
//
// Two consequences, both the inverse of what this header used to warn about:
//
//   1. A COMPLETION IS A FACT, NOT A FLAG. Quest progress is evaluated from the
//      log unioned with the current flags, so un-completing cannot walk progress
//      backwards and re-completing cannot advance it twice. That closed D94-4,
//      and completionLog.test.ts reproduces the exploit to prove it.
//
//   2. PROGRESS CAN NOW BE RECOMPUTED. The old warning — that a mis-evaluating
//      quest could only be fixed by a migration that guesses — no longer holds
//      for any period the log covers. It still holds for anything that happened
//      BEFORE the log shipped, and for any window a future retention policy
//      prunes. No recompute path is built yet; the data to build one now exists.
//
// 📌 Progress is still ACCUMULATED FORWARD at completion time rather than
// derived by scanning history, and that is now a performance choice rather than
// a necessity: every read filters on `dayKey`, so a completion costs O(tasks
// today), never O(all completions). Keep it that way — see the growth note in
// completionLog.ts.
//
// The evaluator below remains PURE, which is still the right call: it is the
// piece whose mistakes reach a player's balance.

import {streakDate, parseNaiveDate} from './streak';

// ---------------------------------------------------------------------------
// 🔴 THE REWARD TABLE — AWAITING BRENDAN. DO NOT TREAT THESE AS DECIDED.
// ---------------------------------------------------------------------------
//
// The spec's own words: "Nobody has priced how many quests a month a player can
// realistically finish, and that number decides whether the shop still matters.
// This is a Brendan decision, and it is the one that can quietly break the
// economy."
//
// For scale: chests cost 100-500 sponges (CHEST_PRICE), and an ordinary task
// pays 5 (TASK_SPONGE_REWARD). A 100-sponge quest is therefore twenty tasks, or
// a fifth of a character chest. Every number below is PROVISIONAL, transcribed
// from the spec's suggested tiers so the machinery has something to run on.
//
// ---------------------------------------------------------------------------
// 🔴 XP — MEASURED AGAINST THE LEVEL CURVE BEFORE A VALUE WAS CHOSEN (W2-12)
// ---------------------------------------------------------------------------
//
// Brendan: "yes quests award xp." The risk was that the curve
// (level_curve.dart: kXpBase 100, kXpStep 50) was tuned against TASK-ONLY XP,
// so a second source changes time-to-level for everyone.
//
// 🔑 IT IS A BOUNDED ONE-OFF, NOT A RATE CHANGE, and that is the whole answer.
// Every tier is claimed exactly once (`claimedTiers`), so lifetime quest XP is
// a FIXED total — 11 tiers in today's catalogue — not a faster earn rate. The
// curve's shape is untouched; a player is shifted forward by a constant, and
// the relative size of that shift DECAYS as they level:
//
//   xp/tier   lifetime   faster to L10   faster to L20
//        10        110            4.1%            1.1%
//        25        275           10.2%            2.6%
//        50        550           20.4%            5.3%
//       100       1100           40.7%           10.5%
//   (free player at 5 tasks/day = 50 XP/day; L10 = 2700 XP, L20 = 10450)
//
// The provisional values below (15/25/40) total 280 XP across the catalogue:
// ~10% faster to L10, ~2.7% to L20. They are deliberately NOT a 1:1 mirror of
// the sponge values — mirroring gives 700 XP and ~26% to L10, and an XP number
// that large starts to matter for a reason sponges never do.
//
// ⚠️ THE ASYMMETRY THAT MAKES THIS WORTH CARE: a sponge is SPENT and leaves the
// economy; XP is PERMANENT and compounds into level, which gates content.
// Getting sponges wrong is a balance problem. Getting XP wrong is a progression
// problem, and it cannot be walked back once players have banked it.
//
// 🔴 THE ONE THING THAT WOULD BREAK THIS: A RECURRING QUEST LINE. The bounded
// argument above holds only because every tier is one-time. The spec's MONTHLY
// LINE repeats, and a repeating line converts this from a fixed offset into a
// permanent second earn rate — which IS the thing that would require retuning
// the curve. Price the monthly line against the curve when it is designed. Do
// not let it inherit these numbers.
//
// 📌 THIS IS THE ONLY PLACE VALUES LIVE. Setting the economy must be an edit to
// this table and nothing else — no sponge OR XP value is duplicated into a
// quest definition, and quests.test.ts asserts that for both.
export const QUEST_REWARDS = {
  /** Easy tally / short streak. */
  easy: {sponges: 50, xp: 15},
  /** Mid tier. */
  mid: {sponges: 75, xp: 25},
  /** Long streak / room sweep. */
  long: {sponges: 100, xp: 40},
} as const;

export type RewardTier = keyof typeof QUEST_REWARDS;

/**
 * XP for a tier whose reward is a chest rather than sponges.
 *
 * Separate because a chest tier has no sponge value to hang an XP number off,
 * and it must still grant XP — otherwise the hardest quests in the catalogue
 * would be the only ones that do not advance the level, which is backwards.
 * Anchored on XP_CHEST (25), what opening a chest already pays.
 */
export const QUEST_CHEST_XP = 25;

/** ⚠️ PROVISIONAL — awaiting Brendan. See the note above. */
export const QUEST_REWARDS_ARE_PROVISIONAL = true;

// ---------------------------------------------------------------------------
// Taxonomy
// ---------------------------------------------------------------------------
//
// Four kinds, kept apart because they need genuinely different state. Conflating
// them is how "3 days in a row" quietly becomes "3 times".
export type QuestKind =
  /** Do X, N times, ever. State: one counter. */
  | 'tally'
  /** Do X on N consecutive days. State: last day + run length. */
  | 'streak'
  /** Complete every task in a room, in one day. State: none between days. */
  | 'sweep'
  /** Touch N distinct rooms. State: a SET, not a count. */
  | 'breadth';

export type RewardKind = 'sponges' | 'chest';

export interface QuestReward {
  kind: RewardKind;
  /** For `sponges` — a key into QUEST_REWARDS, never a literal. */
  tier?: RewardTier;
  /** For `chest` — a CHEST_PRICE category. Thematically matched, per the spec. */
  chestCategory?: 'furniture' | 'styles' | 'characters';
}

export interface QuestTier {
  /** Progress value at which this tier pays out. */
  threshold: number;
  reward: QuestReward;
}

export interface QuestDef {
  id: string;
  title: string;
  kind: QuestKind;
  /** Display grouping — the spec splits the list by area of the house. */
  area: string;
  /**
   * Which task completions count. A task matches when its room equals `room`
   * (when set) AND any of `titleAny` appears in its lowercased title (when set).
   *
   * ⚠️ MATCHING ON TITLE TEXT IS A KNOWN WEAKNESS, recorded rather than hidden:
   * task docs carry no stable semantic key — only an id, a free-text title, a
   * room and optional tags. "Make your bed" is identified by the word "bed".
   * A retitled task silently stops counting, and no test can catch that because
   * the titles live in the client's task library. The durable fix is a `tag` or
   * `taskKey` on the task document, which is a W1 change and is flagged in the
   * return rather than invented here.
   */
  match: {room?: string; titleAny?: string[]};
  /** Tiered quests pay at each tier, per the spec's 3/5/8 shape. */
  tiers: QuestTier[];
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------
//
// Deliberately a SUBSET of the spec's list. Included here are the quests whose
// progress is derivable from what a task document actually carries. The rest are
// listed in QUESTS_NOT_BUILDABLE below, with the reason each is blocked, so the
// gap is a ledger rather than a silent omission — the same shape as
// BENCHED_SUBJECTS in itemPool.ts, and for the same reason.
//
// `RoomType.toString()` is what the client persists, so room values are the
// literal enum strings, not bare names. Getting this wrong yields a quest that
// can never progress and never errors.
export const QUEST_CATALOGUE: QuestDef[] = [
  {
    id: 'bed_head',
    title: 'Bed Head',
    kind: 'streak',
    area: 'Bedroom',
    match: {room: 'RoomType.bedroom', titleAny: ['bed']},
    tiers: [
      {threshold: 3, reward: {kind: 'sponges', tier: 'easy'}},
      {threshold: 5, reward: {kind: 'sponges', tier: 'mid'}},
      {threshold: 8, reward: {kind: 'sponges', tier: 'long'}},
    ],
  },
  {
    id: 'no_dish_left_standing',
    title: 'No Dish Left Standing',
    kind: 'tally',
    area: 'Kitchen',
    match: {room: 'RoomType.kitchen', titleAny: ['dish']},
    tiers: [{threshold: 5, reward: {kind: 'sponges', tier: 'easy'}}],
  },
  {
    id: 'counter_culture',
    title: 'Counter Culture',
    kind: 'streak',
    area: 'Kitchen',
    match: {room: 'RoomType.kitchen', titleAny: ['counter']},
    tiers: [
      {threshold: 3, reward: {kind: 'sponges', tier: 'easy'}},
      {threshold: 7, reward: {kind: 'sponges', tier: 'mid'}},
      {threshold: 14, reward: {kind: 'sponges', tier: 'long'}},
    ],
  },
  {
    id: 'mirror_mirror',
    title: 'Mirror Mirror',
    kind: 'tally',
    area: 'Bathroom',
    match: {room: 'RoomType.bathroom', titleAny: ['mirror', 'glass']},
    tiers: [{threshold: 5, reward: {kind: 'sponges', tier: 'easy'}}],
  },
  {
    id: 'bathroom_warrior',
    title: 'Bathroom Warrior',
    kind: 'sweep',
    area: 'Bathroom',
    match: {room: 'RoomType.bathroom'},
    tiers: [{threshold: 1, reward: {kind: 'chest', chestCategory: 'furniture'}}],
  },
  {
    id: 'turn_it_over',
    title: 'Turn It Over',
    kind: 'sweep',
    area: 'Bedroom',
    match: {room: 'RoomType.bedroom'},
    tiers: [{threshold: 1, reward: {kind: 'chest', chestCategory: 'furniture'}}],
  },
  {
    id: 'grand_tour',
    title: 'Grand Tour',
    kind: 'breadth',
    area: 'Whole house',
    match: {},
    tiers: [{threshold: 4, reward: {kind: 'sponges', tier: 'long'}}],
  },
];

/**
 * Spec quests deliberately NOT built, and why. A ledger, not an oversight —
 * questCatalogue.test.ts asserts every entry names a real blocker so this
 * cannot rot into a list of things nobody rechecked.
 */
export const QUESTS_NOT_BUILDABLE: Record<string, string> = {
  empty_by_nine:
    'Needs the clock time of a completion. Task docs carry `completedDate` (a date string) and `completedAt`, but only `completedDate` is queryable and it has no time component. A "before 09:00" rule would also need the user timezone, which the server does not store.',
  porcelain_standard:
    'Needs two sweeps two weeks apart, i.e. the DATE of a past sweep. There is no completion history — see the header. Buildable only by persisting a sweep date into quest state, which is a design decision about what quest state may remember, not a mechanical addition.',
  rug_burn:
    'Four WEEKS running, not four days. The streak evaluator here counts consecutive days; a weekly cadence needs its own resolution rule and would be a second definition of "consecutive", which is the exact bug the spec warns against.',
  weekend_warrior:
    'Needs day-of-week and a per-day count across two specific days. Derivable, but it rewards volume on a schedule and wants its own state shape; held rather than bolted onto tally.',
  back_on_the_horse:
    'Needs to observe a BROKEN streak, which lives in users/{uid}/streak/main.isBroken and is mutated by recordTaskCompletion in the same call. Sequencing this correctly against the streak transaction is a real design question, not a catalogue entry.',
  clean_sweep:
    'Every task in the house in one day. Mechanically the same as a sweep with no room filter, but it requires reading the entire tasks collection inside the completion path — an unbounded read on the hot path. Wants a cached task census first.',
  surface_tension:
    'Depends on "every surface" being an identifiable set of tasks. Task docs have no such grouping; see the titleAny weakness above.',
  behind_the_fridge:
    'Same: "the tasks people skip" is not a property any task document carries.',
  nothing_under_there:
    'Needs a "clear the floor" task identity. Same missing-semantic-key problem as the above, and unlike `bed` there is no single reliable word.',
  receipts:
    'Photo verification. The camera in the task screen does not exist yet — the spec flags it as an open question for Brendan.',
  before_and_after:
    'Photo-verify a full room sweep — the camera dependency above, plus it needs BOTH a before and an after photo bound to the same sweep, which is a stronger requirement than Receipts and has no data model at all.',
  monthly_line:
    'The monthly skin capstone. Blocked on TWO undecided rules, both flagged in the spec: what happens to an unfinished line (expire / carry over / return), and the economy. A skin grant must also reuse collection_seed, which is a separate seam.',
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Per-quest persisted progress. Only the fields a kind needs are written. */
export interface QuestProgress {
  /** tally: cumulative count. streak: current run length. */
  value: number;
  /** streak/tally: the day key this quest last advanced on. */
  lastDay?: string;
  /**
   * tally only: how many matching tasks have already been counted on `lastDay`.
   * Without it a tally cannot tell "the day's second dish" from "the same dish
   * reported twice", because `completedToday` is the whole day's set on every
   * call, not a delta.
   */
  dayCount?: number;
  /** Thresholds already paid, so a replay cannot pay twice. */
  claimedTiers: number[];
}

export type QuestStateMap = Record<string, QuestProgress>;

/** A payout the caller must actually grant. */
export interface QuestPayout {
  questId: string;
  title: string;
  threshold: number;
  reward: QuestReward;
  /** Resolved sponge amount, 0 for a chest reward. */
  sponges: number;
  /**
   * Resolved XP. Every tier grants XP, including chest tiers — otherwise the
   * hardest quests would be the only ones that do not advance the level.
   *
   * 🔑 Resolved HERE, from the reward table, so no quest definition and no
   * caller ever carries an XP number of its own. That single property is why
   * the sponge economy stayed a one-file edit, and it now covers XP too.
   */
  xp: number;
}

export interface QuestEvaluation {
  state: QuestStateMap;
  payouts: QuestPayout[];
}

/** One completed task, as the evaluator needs it. */
export interface CompletedTask {
  id: string;
  room: string;
  title: string;
}

function matches(def: QuestDef, task: CompletedTask): boolean {
  if (def.match.room && task.room !== def.match.room) return false;
  if (def.match.titleAny && def.match.titleAny.length > 0) {
    const title = (task.title ?? '').toLowerCase();
    if (!def.match.titleAny.some((word) => title.includes(word))) return false;
  }
  return true;
}

/**
 * Days between two day keys (`YYYY-MM-DD`), using the STREAK feature's own
 * day rule.
 *
 * ⚠️ This deliberately routes through `streakDate`/`parseNaiveDate` from
 * streak.ts rather than doing its own date maths. Two definitions of
 * "consecutive day" in one app is a bug with a delay fuse that does not surface
 * until a tester crosses midnight in the wrong timezone — the spec says so, and
 * the server half of that logic already exists, so there is no excuse to write
 * a second one. If the streak rule changes (grace periods, rollover hour), quest
 * streaks change with it, which is the point.
 */
export function dayGap(fromDayKey: string, toDayKey: string): number {
  const from = streakDate(parseNaiveDate(fromDayKey));
  const to = streakDate(parseNaiveDate(toDayKey));
  return Math.round((to.getTime() - from.getTime()) / 86400000);
}

/**
 * PURE. Advances quest state given the tasks completed on [dayKey] and, for
 * sweep quests, the full per-room task census.
 *
 * Pure on purpose: this is the instrument whose mistakes cannot be repaired by
 * recomputation (see the header), so it must be exhaustively testable without a
 * Firestore mock.
 *
 * @param roomTaskCounts total tasks that EXIST per room, for sweep completion.
 */
export function evaluateQuests(
  prior: QuestStateMap,
  completedToday: CompletedTask[],
  dayKey: string,
  roomTaskCounts: Record<string, number>,
  catalogue: QuestDef[] = QUEST_CATALOGUE,
): QuestEvaluation {
  const state: QuestStateMap = {};
  for (const [id, p] of Object.entries(prior)) {
    state[id] = {...p, claimedTiers: [...(p.claimedTiers ?? [])]};
  }
  const payouts: QuestPayout[] = [];

  for (const def of catalogue) {
    const current: QuestProgress = state[def.id] ?? {value: 0, claimedTiers: []};
    const matched = completedToday.filter((t) => matches(def, t));

    switch (def.kind) {
      case 'tally': {
        // 🔑 IDEMPOTENCY LIVES HERE. recordTaskCompletion fires on EVERY
        // completion and hands us the whole day's completed set, not a delta.
        // Adding `matched.length` per call would count the day's first dish
        // once, then again, then again — five dishes would read as fifteen.
        // So: count only the increase over what this day has already
        // contributed. Replaying the same call adds nothing.
        if (matched.length === 0) break;
        const countedToday = current.lastDay === dayKey ? (current.dayCount ?? 0) : 0;
        if (matched.length > countedToday) {
          current.value += matched.length - countedToday;
        }
        current.lastDay = dayKey;
        current.dayCount = matched.length;
        break;
      }

      case 'streak': {
        if (matched.length === 0) break;
        if (current.lastDay === dayKey) break; // already counted today
        const gap = current.lastDay ? dayGap(current.lastDay, dayKey) : null;
        current.value = gap === 1 ? current.value + 1 : 1;
        current.lastDay = dayKey;
        break;
      }

      case 'sweep': {
        const room = def.match.room;
        if (!room) break;
        const total = roomTaskCounts[room] ?? 0;
        // A room with no tasks is not a completed sweep. Without this guard a
        // player who owns no bathroom tasks completes Bathroom Warrior by
        // doing nothing, because 0 >= 0.
        if (total === 0) break;
        const doneInRoom = completedToday.filter((t) => t.room === room).length;
        if (doneInRoom >= total) {
          current.value = Math.max(current.value, 1);
          current.lastDay = dayKey;
        }
        break;
      }

      case 'breadth': {
        // A SET, not a count — five kitchen tasks are one room. Evaluated
        // within the day only; the spec's Grand Tour is "one task in every
        // room, one day".
        const rooms = new Set(completedToday.map((t) => t.room));
        current.value = Math.max(current.value, rooms.size);
        current.lastDay = dayKey;
        break;
      }
    }

    for (const tier of def.tiers) {
      if (current.value >= tier.threshold && !current.claimedTiers.includes(tier.threshold)) {
        current.claimedTiers.push(tier.threshold);
        payouts.push({
          questId: def.id,
          title: def.title,
          threshold: tier.threshold,
          reward: tier.reward,
          sponges: tier.reward.kind === 'sponges' && tier.reward.tier
            ? QUEST_REWARDS[tier.reward.tier].sponges
            : 0,
          xp: tier.reward.kind === 'sponges' && tier.reward.tier
            ? QUEST_REWARDS[tier.reward.tier].xp
            : QUEST_CHEST_XP,
        });
      }
    }

    state[def.id] = current;
  }

  return {state, payouts};
}
