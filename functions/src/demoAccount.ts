// ---------------------------------------------------------------------------
// demoAccount — a seeded account with enough history to photograph
// ---------------------------------------------------------------------------
//
// W2-80. A store screenshot set CANNOT be captured from a fresh install by
// anyone. `docs/store-screenshots/CAPTURE-NOTE.md` measured why: a fresh
// account renders `DayOnePrompt` (the empty lot) and `StreakDayZero`, which W4
// rejected as "an advertisement for having achieved nothing". 🔑 The frames
// worth showing are exactly the frames that require history.
//
// This module is the STATE half. W4 has already proven the capture half end to
// end — debug build, `simctl io screenshot`, exactly 1320×2868, no DEBUG
// ribbon. Nothing here touches capture.
//
// ---------------------------------------------------------------------------
// 🔴 WHAT THIS CAN AND CANNOT PRODUCE — read before reporting the set covered
// ---------------------------------------------------------------------------
//
// W4's set is three frames. Seeding produces TWO of them outright. The third
// is not a seeding problem and no amount of Firestore will fix it:
//
//   1. the furnished house   ✅ SEEDABLE. `DayOnePrompt` is gated on
//                               `currentFloor.rooms.isEmpty`
//                               (home_dashboard.dart:531). A layout with rooms
//                               clears it.
//   2. the running timer     ❌ NOT SEEDABLE — see below.
//   3. the 7-day streak      ✅ SEEDABLE. `isDayZero` is `state.currentStreak
//                               == 0` (streak_page.dart:178). A streak doc with
//                               a non-zero count clears it.
//
// ⚠️ FRAME 2 IS EPHEMERAL WIDGET STATE, NOT PERSISTED STATE. `CountdownTimer`
// (countdown_timer.dart) is a bare `Timer.periodic` initialised from
// `task.estimatedTime` when the widget MOUNTS, at
// `task_completion_page.dart:284`. It is written to no document, no
// SharedPreferences key, and no provider that outlives the page. There is no
// value this seeder could write that makes a timer be running.
//
// 🔑 SO THE HONEST SPLIT IS: seeding makes frame 2 REACHABLE AND DETERMINISTIC,
// and a driver makes it RENDER. The seeded schedule puts `lib_kitchen_0`
// ("Wipe down counters", `estimatedMinutes: 10`) in the current week, which is
// precisely W4's "Wipe down counters · 10:00 left" — so the tap sequence has a
// known target and lands on a known duration instead of whatever a fresh
// account happened to plan. Driving the taps is `integration_test`'s job
// (CAPTURE-NOTE Wall 3), not this module's.
//
// 📌 That matters more than it looks: W4 wrote "if the set shrinks, #2 stays" —
// it is the only frame showing a real timer on a real chore. A harness reported
// as complete while covering 1 and 3 would be reporting the easy two-thirds.
//
// ---------------------------------------------------------------------------
// ⚠️ TWO CLOCKS, AND BOTH OF THEM BITE
// ---------------------------------------------------------------------------
//
// A fixture anchored to a simulated day is silently expired the next real day.
// Two independent places where that is not theoretical here:
//
//   1. THE SCHEDULE HAS A WEEK KEY. `getScheduleForWeek` returns **null** when
//      `weekStartDate` does not equal `currentWeekStart()`
//      (weekly_schedule_repository_impl.dart:53). A schedule seeded last week
//      is not a stale schedule, it is NO schedule, and the task vanishes.
//   2. THE STREAK HAS A LAST-COMPLETION DATE. A `lastCompletionDate` older than
//      yesterday reads as broken, and the page falls back to day zero — the
//      exact frame this exists to avoid.
//
// 🔑 SO EVERY DATE HERE IS DERIVED FROM ONE `nowMs` ARGUMENT AND NOTHING CALLS
// `Date.now()` BELOW THIS COMMENT. The caller pins the clock; this module never
// reads it. That is also what makes the plan testable at a fixed instant.
//
// ⚠️ AND THE TWO CLOCKS ARE ON DIFFERENT MACHINES. `currentWeekStart()` runs on
// the DEVICE in the device's LOCAL timezone; this seeder runs in the functions
// runtime, which is UTC. Near a Monday boundary those disagree and the schedule
// silently does not load. `seedDemoAccount` therefore accepts an explicit
// `weekStartDate` (`YYYY-MM-DD`) in the POST body so the caller can pass the
// DEVICE's week — `make seed-demo-account` sends the Mac's local Monday, which
// is the simulator's too. The server-computed week is only a default, and a
// wrong default here fails quiet.
//
// ---------------------------------------------------------------------------
// The shape follows family.ts and trashDay.ts: decide, then write. Everything
// below returns a PLAN — a list of documents — and touches no database. The
// endpoint applies it. That is what lets the fixture be asserted directly.
// ---------------------------------------------------------------------------

import {DEFAULT_HOUSES, HouseLayout, defaultHouseById} from './defaultHouses';
import {SEED_ITEMS} from './itemPool';

/** One document the seeder intends to write. Path is relative to the root. */
export interface SeedWrite {
  path: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// THE FIXTURE — "enough history", as DATA
// ---------------------------------------------------------------------------
//
// 🔑 CHANGING THE STREAK LENGTH IS EDITING ONE NUMBER HERE. That is the point
// of this block existing: the next person tuning the screenshot set should not
// have to read the builder below, and nothing downstream hard-codes 7.

export interface DemoFixture {
  /** Which of the four authored houses to install. See defaultHouses.ts. */
  houseId: string;
  /** Days of unbroken streak. W4's frame 3 asks for seven. */
  streakDays: number;
  /** Longest streak ever — the badge shelf reads this, not currentStreak. */
  longestStreakDays: number;
  /**
   * Days of heat-map history to fill. Larger than `streakDays` on purpose: a
   * calendar with exactly seven marked days and nothing before it looks like a
   * new account that got lucky, not like someone who lives here.
   */
  historyDays: number;
  /** Cleanliness score written for each history day, 0..1. */
  dailyScore: number;
  /** Tasks completed per history day — the heat map reads the score, the
   *  profile totals read these. */
  tasksPerDay: number;
  /** The task the timer frame is captured on. MUST be a `taskLibrary` id. */
  timerTaskId: string;
  /** The rest of the week's plan, so the schedule looks lived-in. */
  scheduledTaskIds: string[];
  /** 1 = Monday. The app stores `cleaningDayOfWeek` this way. */
  cleaningDayOfWeek: number;
  /**
   * Owned collection items, as SEED_ITEMS ids.
   *
   * 🔑 SEED_ITEMS IS THE RIGHT SOURCE AND THAT IS NOT AN ACCIDENT OF
   * CONVENIENCE. The collection grid is computed from the DART catalog
   * (`collection_seed.dart`) plus the player's inventory, so an id the catalog
   * does not know is dropped in silence — the same failure `lib_living_0` was.
   * `dailyRotation.test.ts` already READS THAT DART FILE off disk and asserts
   * it has not drifted from SEED_ITEMS, so every id below is gated against the
   * catalog by a test that exists, in a language this file cannot import.
   * Naming ids by hand here would have re-opened exactly that hole.
   */
  inventoryItemIds: string[];
  /** Which of the above render as worn. Must be a subset of inventoryItemIds. */
  equippedItemIds: string[];
  /** Coins/XP, so the shell chrome is not all zeroes in frame 1. */
  coins: number;
  xp: number;
  level: number;
  displayName: string;
}

/**
 * 🔴 `timerTaskId` IS W4'S FRAME, SPELLED OUT.
 *
 * `lib_kitchen_0` is "Wipe down counters", `estimatedMinutes: 10`
 * (task_library.dart:33-39) — the literal "Wipe down counters · 10:00 left"
 * from the store listing. Changing this id changes which chore the hero
 * screenshot shows, and the duration follows the library, not this file.
 */
export const DEMO_FIXTURE: DemoFixture = {
  houseId: 'default_2bed_2bath',
  streakDays: 7,
  longestStreakDays: 12,
  historyDays: 21,
  dailyScore: 0.86,
  tasksPerDay: 3,
  timerTaskId: 'lib_kitchen_0',
  scheduledTaskIds: [
    'lib_kitchen_0',
    'lib_kitchen_1',
    'lib_bathroom_0',
    // ⚠️ `lib_livingroom_0`, NOT `lib_living_0`. The room enum is `living` and
    // the house catalogue's room is `living_room`, so both shorter spellings
    // read as correct; the library's is neither. I wrote `lib_living_0` here
    // first and only a check against the real file caught it — an unknown id
    // is dropped in silence, exactly as defaultHouses.ts records for furniture.
    // `demoAccount.test.ts` now pins every id in this list.
    'lib_livingroom_0',
    'lib_bedroom_0',
  ],
  cleaningDayOfWeek: 6,
  // A spread across type and rarity, so the grid reads as a collection someone
  // built rather than a starter pack: styles, furniture and characters, with
  // legendaries present but not dominant.
  inventoryItemIds: [
    'style_roof_tile',
    'style_wall_whitewash',
    'style_ext_lawn_default',
    'furn_cozy_sofa',
    'furn_bear_chair',
    'furn_retro_tv',
    'furn_neon_lamp',
    'char_cleaner',
    'char_chef',
    'char_gardener',
    'char_knight',
    'char_pyjama',
  ],
  // One character and one style worn. Not more: the customize screen shows
  // equipped state per slot, and everything equipped tells you nothing about
  // which slots exist.
  equippedItemIds: ['char_cleaner', 'style_roof_tile'],
  coins: 1250,
  xp: 4200,
  level: 7,
  displayName: 'Sam',
};

// ---------------------------------------------------------------------------
// Date helpers — all of them take the instant, none of them read the clock
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant to seed "today" at, given the DEVICE's local date.
 *
 * 🔴 THIS EXISTS BECAUSE THE FIRST END-TO-END RUN CAUGHT THE HALF I MISSED.
 * `weekStartOverride` pinned the WEEK against UTC drift, but every day key still
 * came from `Date.now()` in the runtime's UTC. Seeded at 22:00 Pacific on
 * 2026-08-14 the newest `dailyScores` key came back **2026-08-15** — a cell the
 * device considers TOMORROW — and `lastCompletionDate` was likewise a day in the
 * device's future. Unit tests could not see it: they pass a fixed `nowMs` and
 * assert self-consistency, which is exactly what a wrong anchor also satisfies.
 *
 * 🔑 NOON UTC, NOT MIDNIGHT, for 12 hours of margin on both sides. Midnight —
 * the obvious alternative — puts every negative offset on the day BEFORE, which
 * is the bug this replaced.
 *
 * 📌 AND THE BOUND IS ±12, NOT "every timezone". Real offsets span UTC-12..
 * UTC+14, which is 26 hours, so NO single instant preserves the date
 * everywhere; UTC+13/+14 read the next day. That does not matter here, and the
 * reason is the part worth keeping: the contract is
 * `dateKey(anchorNoonUtc(d)) === d` EXACTLY, for any d — the anchor is pinned
 * to the caller's date, not to a viewer's timezone, and the keys are what the
 * app reads. `demoAccount.test.ts` pins the limit so the claim is not widened
 * later.
 */
export function anchorNoonUtc(todayLocal: string): number {
  const ms = Date.parse(`${todayLocal}T12:00:00Z`);
  if (Number.isNaN(ms)) {
    // Loud, because a silently ignored anchor reverts to the exact UTC drift
    // this function exists to remove, and the symptom is a calendar that is
    // subtly wrong rather than an error.
    throw new Error(
      `demoAccount: todayLocal must be YYYY-MM-DD, got "${todayLocal}"`,
    );
  }
  return ms;
}

/** `YYYY-MM-DD` in UTC. The app's own key format for dailyScores. */
export function dateKey(ms: number): string {
  return new Date(ms).toISOString().split('T')[0];
}

/**
 * Monday of the week containing `ms`, as `YYYY-MM-DD`.
 *
 * ⚠️ MIRRORS `currentWeekStart()` (weekly_schedule_repository_impl.dart:8) AND
 * IS A MIRROR, with the same hazard defaultHouses.ts records about its
 * catalogue copy: the app computes this in DEVICE-LOCAL time and this computes
 * it in UTC. They agree except near a Monday boundary, which is exactly when a
 * screenshot session at 5pm Sunday Pacific would silently get no schedule.
 * `seedDemoAccount` takes `todayLocal` so the caller can remove the guess.
 */
export function weekStartKey(ms: number): string {
  const d = new Date(ms);
  // getUTCDay(): 0 = Sunday. The app uses `weekday` where Monday = 1, so
  // Sunday must go BACK six days, not forward one.
  const dow = d.getUTCDay();
  const daysSinceMonday = dow === 0 ? 6 : dow - 1;
  return dateKey(ms - daysSinceMonday * DAY_MS);
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

/**
 * Every document needed to make the seeded account photographable.
 *
 * Pure: no database, no clock, no randomness. `nowMs` is the only instant in
 * play and every derived date hangs off it.
 *
 * @param weekStartOverride `YYYY-MM-DD` from the DEVICE, when the caller knows
 *        it. Absent, the week is computed from `nowMs` in UTC — correct most of
 *        the time and wrong in a way that fails quiet, which is why the
 *        endpoint surfaces which one it used.
 */
export function planDemoAccount(args: {
  uid: string;
  nowMs: number;
  fixture?: DemoFixture;
  weekStartOverride?: string;
}): SeedWrite[] {
  const {uid, nowMs} = args;
  const fx = args.fixture ?? DEMO_FIXTURE;

  const house = defaultHouseById(fx.houseId);
  if (!house) {
    // 🔴 LOUD, NOT QUIET. defaultHouses.ts records that an unknown furnitureId
    // is silently dropped by the renderer, producing an emptier house than was
    // authored with nothing anywhere saying so. An unknown HOUSE id would do
    // the same thing one level up — a seeded account with no rooms is
    // DayOnePrompt, the precise frame this module exists to avoid, and it
    // would look like the seeder had not been run.
    throw new Error(
      `demoAccount: unknown houseId "${fx.houseId}". Known: ` +
        DEFAULT_HOUSES.map((h) => h.id).join(', '),
    );
  }

  const writes: SeedWrite[] = [];

  writes.push({
    path: `users/${uid}`,
    data: {
      displayName: fx.displayName,
      coins: fx.coins,
      xp: fx.xp,
      level: fx.level,
      onboardingComplete: true,
      createdAt: new Date(nowMs - fx.historyDays * DAY_MS).toISOString(),
    },
  });

  writes.push({
    path: `users/${uid}/house/layout`,
    data: houseLayoutDoc(house, nowMs),
  });

  writes.push({
    path: `users/${uid}/streak/main`,
    data: streakDoc(fx, nowMs),
  });

  for (const write of dailyScoreDocs(uid, fx, nowMs)) writes.push(write);

  writes.push({
    path: `users/${uid}/weeklySchedule/current`,
    data: scheduleDoc(fx, args.weekStartOverride ?? weekStartKey(nowMs)),
  });

  for (const write of inventoryDocs(uid, fx)) writes.push(write);

  return writes;
}

/**
 * The house document, in the shape `HouseLayoutModel.fromJson` reads.
 *
 * 🔴 `schemaVersion` IS LOAD-BEARING AND ITS ABSENCE IS NOT NEUTRAL. Absent,
 * the model reads the document as **v1** by design — "the field was added with
 * v2, so its absence is not 'unknown', it is the original schema"
 * (house_model.dart:11) — and `HouseLayoutMigrations.migrate` then DOUBLES
 * every coordinate on the way in. The authored layouts already span up to x=12
 * on a 24 grid, so a doubled copy puts most of the furniture off the grid and
 * the frame loses the rooms it was seeded for. Writing the version explicitly
 * is what stops a silent second doubling.
 */
export function houseLayoutDoc(
  house: HouseLayout,
  nowMs: number,
): Record<string, unknown> {
  return {
    floors: house.floors.map((f) => ({
      id: f.id,
      index: f.index,
      rooms: f.rooms.map((r) => ({...r})),
      furniture: f.furniture.map((item) => ({...item})),
    })),
    equippedCharacters: [],
    savedAt: new Date(nowMs).toISOString(),
    gridCols: 24,
    gridRows: 24,
    schemaVersion: 2,
  };
}

/**
 * The streak document, in the shape `Streak.fromJson` reads.
 *
 * ⚠️ `lastCompletionDate` IS TODAY, NOT `today - 1`. A streak whose last
 * completion is older than yesterday resolves as broken and the page falls back
 * to `StreakDayZero`. Today is the only value that is unambiguously live on the
 * day the screenshot is taken.
 */
export function streakDoc(
  fx: DemoFixture,
  nowMs: number,
): Record<string, unknown> {
  return {
    habitId: 'main',
    currentStreak: fx.streakDays,
    longestStreak: fx.longestStreakDays,
    lastCompletionDate: new Date(nowMs).toISOString(),
    streakStartDate: new Date(nowMs - (fx.streakDays - 1) * DAY_MS).toISOString(),
    isBroken: false,
    awardedMilestones: [],
  };
}

/**
 * Heat-map history, one document per day, keyed `YYYY-MM-DD`.
 *
 * Day 0 is today and the run goes BACKWARDS, so the newest day is always the
 * day the seeder ran — a calendar whose filled cells stop three days short
 * reads as an abandoned account.
 */
export function dailyScoreDocs(
  uid: string,
  fx: DemoFixture,
  nowMs: number,
): SeedWrite[] {
  const writes: SeedWrite[] = [];
  for (let i = 0; i < fx.historyDays; i++) {
    const dayMs = nowMs - i * DAY_MS;
    writes.push({
      path: `users/${uid}/dailyScores/${dateKey(dayMs)}`,
      data: {
        userId: uid,
        date: new Date(dayMs).toISOString(),
        score: fx.dailyScore,
        tasksCompleted: fx.tasksPerDay,
        tasksScheduled: fx.tasksPerDay,
      },
    });
  }
  return writes;
}

/**
 * The week's plan, in the shape `WeeklySchedule.fromJson` reads.
 *
 * 🔴 `weekStartDate` IS AN EQUALITY KEY, NOT A LABEL.
 * `getScheduleForWeek` compares it and returns null on mismatch — so a schedule
 * seeded for the wrong week does not render as stale, it does not render.
 *
 * ⚠️ `tasksByDay` KEYS ARE STRINGS HERE AND `Map<int, …>` IN DART. Firestore
 * has no integer map keys; JSON objects are string-keyed, and freezed's
 * generated `fromJson` parses them back. Writing numbers would not survive the
 * round trip.
 */
export function scheduleDoc(
  fx: DemoFixture,
  weekStartDate: string,
): Record<string, unknown> {
  const [first, ...rest] = fx.scheduledTaskIds;
  return {
    weekStartDate,
    cleaningDayOfWeek: fx.cleaningDayOfWeek,
    selectedTaskIds: fx.scheduledTaskIds,
    tasksByDay: {
      // The timer task sits alone on the cleaning day, so the tap sequence that
      // drives frame 2 has one unambiguous target rather than a list to
      // disambiguate by position — see identity-by-display-text hazards.
      [String(fx.cleaningDayOfWeek)]: [first],
      [String(((fx.cleaningDayOfWeek + 1) % 7) || 7)]: rest,
    },
  };
}

// ---------------------------------------------------------------------------
// The collection — owned inventory, so the grid reads as a collection
// ---------------------------------------------------------------------------
//
// W2-85. W4 excluded the collection frame because the inventory seeding cost
// was uncosted. It is cheap, and the reason it is cheap is that the dangerous
// part is already gated: `users/{uid}/inventory` is keyed by SEED_ITEMS ids,
// and `dailyRotation.test.ts` already reads `collection_seed.dart` OFF DISK to
// assert the two have not drifted. So the cross-language mirror that would
// otherwise have to be hand-built for this — and that bit this file once, as
// `lib_living_0` — already exists and already fails loudly.
//
// 🔴 THE SHOP IS DELIBERATELY NOT HERE, AND THAT IS THE FINDING. `shop/current`
// already has THREE writers (rotateMarket, rotateWeeklyOffer, seedShopData) and
// weeklyOffers.ts records that seedShopData ONCE SHIPPED ITS OWN HARDCODED COPY
// of the offer, bypassing rotation — "that copy is now deleted and both paths
// import WEEKLY_OFFERS, which is why the duplicate had to go rather than merely
// be gated". A fourth writer here would repeat precisely that mistake for
// precisely that convenience. The shop is seeded by CALLING seedShopData, which
// `make seed-demo-account` now does; see the Makefile.

/**
 * The player's owned items, one document per id.
 *
 * ⚠️ `type` IS LOOKED UP FROM SEED_ITEMS RATHER THAN RESTATED. The inventory
 * document carries a type the client reads, and a second hand-written copy of
 * "which item is a character" is a second thing to drift. An id absent from
 * SEED_ITEMS throws rather than defaulting — a silently mistyped item renders
 * in the wrong grid section, which looks like a layout bug and is not one.
 */
export function inventoryDocs(uid: string, fx: DemoFixture): SeedWrite[] {
  const equipped = new Set(fx.equippedItemIds);

  for (const id of fx.equippedItemIds) {
    if (!fx.inventoryItemIds.includes(id)) {
      // Equipping something unowned is not a state the app can reach, and
      // seeding it would put the customize screen into one no player could.
      throw new Error(`demoAccount: equipped id "${id}" is not in inventoryItemIds`);
    }
  }

  return fx.inventoryItemIds.map((itemId) => {
    const seed = SEED_ITEMS.find((s) => s.id === itemId);
    if (!seed) {
      throw new Error(
        `demoAccount: inventory id "${itemId}" is not a SEED_ITEMS id — ` +
          'the collection grid would drop it in silence.',
      );
    }
    return {
      // The document id IS the item id. `user_inventory_provider.dart` falls
      // back to `doc.id` when the field is absent, so the two agreeing is what
      // makes a hand-inspected document readable.
      path: `users/${uid}/inventory/${itemId}`,
      data: {itemId, type: seed.type, isEquipped: equipped.has(itemId)},
    };
  });
}
