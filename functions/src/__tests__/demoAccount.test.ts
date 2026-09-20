// ---------------------------------------------------------------------------
// demoAccount — the seeded screenshot account
// ---------------------------------------------------------------------------
//
// KEY: THESE TESTS ASSERT THE TWO THINGS THAT FAIL QUIET.
//
// Everything this module can get wrong degrades silently rather than throwing:
// an unknown task id is dropped by the renderer, a schedule on the wrong week
// key returns null rather than stale data, and a house document missing
// `schemaVersion` is read as v1 and DOUBLED. None of those produce an error
// anywhere — they produce a screenshot that looks like the seeder was never
// run. So the assertions here are about values a human would not re-check.
//
// WARNING: AND A LESSON FROM #390, WHICH IS WHY THE FIXTURES BELOW LOOK PARANOID: a
// control is only real if the WRONG code returns the WRONG answer. Each control
// here is built so that deleting the line it guards changes its result — noted
// per test where the choice is not obvious.

import {
  DEMO_FIXTURE,
  anchorNoonUtc,
  dateKey,
  houseLayoutDoc,
  planDemoAccount,
  scheduleDoc,
  streakDoc,
  weekStartKey,
} from '../demoAccount';
import {DEFAULT_HOUSES, defaultHouseById} from '../defaultHouses';

// A Wednesday, fixed. Every date assertion below is relative to this and
// nothing in the module reads a clock, which is the property that makes the
// suite stable across the midnight it will eventually run over.
const WED_2026_08_12 = Date.UTC(2026, 7, 12, 15, 0, 0);
const DAY_MS = 24 * 60 * 60 * 1000;
const UID = 'uid-demo';

const plan = (over: Parameters<typeof planDemoAccount>[0] | null = null) =>
  planDemoAccount(over ?? {uid: UID, nowMs: WED_2026_08_12});

const pathsOf = (writes: {path: string}[]) => writes.map((w) => w.path);
const at = (writes: {path: string; data: Record<string, unknown>}[], p: string) =>
  writes.find((w) => w.path === p)?.data;

// ---------------------------------------------------------------------------
// CRITICAL: THE MIRROR — every id this fixture names must exist upstream
// ---------------------------------------------------------------------------
//
// This is the hazard defaultHouses.ts documents for furniture, one level up and
// already proven live: `lib_living_0` was written here first and is not a task.
// The room enum is `living` and the house catalogue's room is `living_room`, so
// two wrong spellings both read as correct. An unknown id is dropped in
// silence.
//
// WARNING: TRANSCRIBED COPY, WITH THE SAME TRADE defaultHouses.ts ACCEPTS: the server
// cannot import from lib/. An unchecked id is strictly worse than a checked
// copy, and the anti-vacuity assertion below is what stops a copy that silently
// emptied from passing everything.
const TASK_LIBRARY_IDS = [
  'lib_kitchen_0', 'lib_kitchen_1', 'lib_kitchen_2', 'lib_kitchen_3', 'lib_kitchen_4',
  'lib_bedroom_0', 'lib_bedroom_1', 'lib_bedroom_2', 'lib_bedroom_3', 'lib_bedroom_4',
  'lib_bathroom_0', 'lib_bathroom_1', 'lib_bathroom_2', 'lib_bathroom_3', 'lib_bathroom_4',
  'lib_livingroom_0', 'lib_livingroom_1', 'lib_livingroom_2', 'lib_livingroom_3', 'lib_livingroom_4',
  'lib_laundry_0', 'lib_laundry_1', 'lib_laundry_2', 'lib_laundry_3', 'lib_laundry_4',
  'lib_office_0', 'lib_office_1', 'lib_office_2', 'lib_office_3', 'lib_office_4',
];

describe('🔴 the fixture names only ids that exist', () => {
  test('the mirror is non-empty and has known-good anchors', () => {
    // KEY: ANTI-VACUITY. Without this, a mirror that was emptied by a bad edit
    // would make every `toContain` below pass against nothing.
    expect(TASK_LIBRARY_IDS.length).toBe(30);
    expect(TASK_LIBRARY_IDS).toContain('lib_kitchen_0');
    expect(TASK_LIBRARY_IDS).toContain('lib_livingroom_0');
    expect(TASK_LIBRARY_IDS).not.toContain('lib_living_0');
  });

  test('every scheduled task id is a real library id', () => {
    for (const id of DEMO_FIXTURE.scheduledTaskIds) {
      expect(TASK_LIBRARY_IDS).toContain(id);
    }
  });

  test('the timer task id is a real library id, and is the one W4 named', () => {
    expect(TASK_LIBRARY_IDS).toContain(DEMO_FIXTURE.timerTaskId);
    // lib_kitchen_0 is "Wipe down counters", estimatedMinutes: 10 — the literal
    // "Wipe down counters · 10:00 left" frame. If someone retargets the hero
    // screenshot this fails and asks them to mean it.
    expect(DEMO_FIXTURE.timerTaskId).toBe('lib_kitchen_0');
  });

  test('the house id is one of the four authored houses', () => {
    expect(defaultHouseById(DEMO_FIXTURE.houseId)).toBeDefined();
  });

  test('🔴 an unknown house id THROWS rather than seeding an empty lot', () => {
    // The failure this prevents is the exact frame the module exists to avoid:
    // no rooms means DayOnePrompt, which looks like the seeder never ran.
    expect(() =>
      planDemoAccount({
        uid: UID,
        nowMs: WED_2026_08_12,
        fixture: {...DEMO_FIXTURE, houseId: 'default_9bed_9bath'},
      }),
    ).toThrow(/unknown houseId/);
  });
});

// ---------------------------------------------------------------------------
// Frame 1 — the furnished house
// ---------------------------------------------------------------------------

describe('🔴 FRAME 1 — the house clears DayOnePrompt', () => {
  const house = at(plan(), `users/${UID}/house/layout`)!;

  test('the layout has rooms — the whole predicate DayOnePrompt reads', () => {
    const floors = house.floors as {rooms: unknown[]}[];
    expect(floors.length).toBeGreaterThan(0);
    expect(floors[0].rooms.length).toBeGreaterThan(0);
  });

  test('it carries furniture, not just walls', () => {
    const floors = house.floors as {furniture: unknown[]}[];
    expect(floors[0].furniture.length).toBeGreaterThan(5);
  });

  test('🔴 schemaVersion is 2 — absent, the migration DOUBLES every coordinate', () => {
    // house_model.dart:11 — "absence is not 'unknown', it is the original
    // schema". The authored layouts already span to x=12 on a 24 grid, so a
    // doubled copy puts the furniture off the grid and the frame loses the
    // rooms. This asserts the value, not merely the key's presence, because
    // writing 1 would be as wrong as omitting it.
    expect(house.schemaVersion).toBe(2);
    expect(house.gridCols).toBe(24);
    expect(house.gridRows).toBe(24);
  });

  test('the geometry is copied faithfully from the authored house', () => {
    // A control against the doc being built from something other than the
    // catalogue: compare against the source rather than restating coordinates,
    // which would just be a second copy to drift.
    const source = defaultHouseById(DEMO_FIXTURE.houseId)!;
    const doc = houseLayoutDoc(source, WED_2026_08_12);
    expect(doc.floors).toEqual(
      source.floors.map((f) => ({
        id: f.id,
        index: f.index,
        rooms: f.rooms.map((r) => ({...r})),
        furniture: f.furniture.map((i) => ({...i})),
      })),
    );
  });
});

// ---------------------------------------------------------------------------
// Frame 3 — the streak
// ---------------------------------------------------------------------------

describe('🔴 FRAME 3 — the streak clears StreakDayZero', () => {
  test('currentStreak is non-zero — the entire isDayZero predicate', () => {
    const s = streakDoc(DEMO_FIXTURE, WED_2026_08_12);
    expect(s.currentStreak).toBe(DEMO_FIXTURE.streakDays);
    expect(s.currentStreak).not.toBe(0);
  });

  test('🔴 lastCompletionDate is TODAY, so the streak is not resolved as broken', () => {
    const s = streakDoc(DEMO_FIXTURE, WED_2026_08_12);
    expect(dateKey(Date.parse(s.lastCompletionDate as string))).toBe(
      dateKey(WED_2026_08_12),
    );
  });

  test('streakStartDate is streakDays-1 back, so the count and the span agree', () => {
    // A control on the arithmetic: a doc claiming a 7-day streak that started
    // 7 days ago is internally inconsistent by one and would render an
    // off-by-one calendar next to a correct hero number.
    const s = streakDoc(DEMO_FIXTURE, WED_2026_08_12);
    const spanDays =
      (WED_2026_08_12 - Date.parse(s.streakStartDate as string)) / DAY_MS;
    expect(spanDays).toBe(DEMO_FIXTURE.streakDays - 1);
  });

  test('the heat map runs BACK from today and has no gap at the newest end', () => {
    const writes = plan();
    const scores = writes.filter((w) => w.path.includes('/dailyScores/'));
    expect(scores).toHaveLength(DEMO_FIXTURE.historyDays);
    expect(pathsOf(scores)).toContain(
      `users/${UID}/dailyScores/${dateKey(WED_2026_08_12)}`,
    );
    expect(pathsOf(scores)).toContain(
      `users/${UID}/dailyScores/${dateKey(WED_2026_08_12 - DAY_MS)}`,
    );
  });

  test('history is longer than the streak, so the calendar is not all-or-nothing', () => {
    expect(DEMO_FIXTURE.historyDays).toBeGreaterThan(DEMO_FIXTURE.streakDays);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: THE WEEK KEY — the two-clocks failure, which is silent
// ---------------------------------------------------------------------------

describe('🔴 the schedule week key', () => {
  test('a Wednesday resolves to the Monday of its own week', () => {
    expect(weekStartKey(WED_2026_08_12)).toBe('2026-08-10');
  });

  test('🔴 SUNDAY GOES BACK SIX DAYS, NOT FORWARD ONE', () => {
    // getUTCDay() is 0 on Sunday while the app's `weekday` is 7. Treating 0 as
    // the start of the week would put Sunday's schedule on the NEXT Monday —
    // a week key in the future, which is not stale, it is invisible.
    // 2026-08-16 is the Sunday of the same week as 2026-08-10.
    const sunday = Date.UTC(2026, 7, 16, 15, 0, 0);
    expect(weekStartKey(sunday)).toBe('2026-08-10');
  });

  test('a Monday is its own week start', () => {
    expect(weekStartKey(Date.UTC(2026, 7, 10, 0, 30, 0))).toBe('2026-08-10');
  });

  test('the seeded schedule carries the computed week', () => {
    expect(at(plan(), `users/${UID}/weeklySchedule/current`)!.weekStartDate).toBe(
      '2026-08-10',
    );
  });

  test('🔴 an explicit override WINS over the server clock', () => {
    // The device computes its week in LOCAL time and this runtime is UTC. The
    // override is the only way a caller near a Monday boundary can be right,
    // so it must not be advisory.
    const writes = planDemoAccount({
      uid: UID,
      nowMs: WED_2026_08_12,
      weekStartOverride: '2026-08-03',
    });
    expect(
      at(writes, `users/${UID}/weeklySchedule/current`)!.weekStartDate,
    ).toBe('2026-08-03');
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: THE ANCHOR — found by running it, not by reading it
// ---------------------------------------------------------------------------
//
// The first real emulator run seeded at 22:00 Pacific and the newest dailyScores
// key came back 2026-08-15 while the device's today was 2026-08-14: a calendar
// cell in the device's future, and a lastCompletionDate to match. The unit tests
// at the time could not have caught it — they pass a fixed nowMs and assert
// self-consistency, which a wrong anchor satisfies perfectly.

describe('🔴 anchorNoonUtc', () => {
  test('a local date becomes that same date, read back as a key', () => {
    expect(dateKey(anchorNoonUtc('2026-08-14'))).toBe('2026-08-14');
  });

  test('🔴 NOON, NOT MIDNIGHT — 12h of margin on both sides', () => {
    const ms = anchorNoonUtc('2026-08-14');
    expect((ms - Date.parse('2026-08-14T00:00:00Z')) / 3600000).toBe(12);

    // Every offset the screenshot machine could plausibly sit at reads back as
    // the same calendar day. Midnight UTC — the obvious alternative — would put
    // every negative offset on the day BEFORE, which is the bug this replaced.
    for (const offset of [-11, -8, -5, 0, 1, 5.5, 9, 11]) {
      expect(dateKey(ms + offset * 3600000)).toBe('2026-08-14');
    }
  });

  test('📌 and the limit is REAL — ±12 is the bound, not "every timezone"', () => {
    // Honest bound rather than a comfortable one. Real offsets span UTC-12..
    // UTC+14 — 26 hours — so NO single instant preserves the date everywhere,
    // and claiming otherwise would be the kind of over-confident comment this
    // repo keeps getting bitten by. UTC+13/+14 (Kiribati, Samoa, Tonga) read
    // the next day.
    //
    // It does not matter here, and the reason is worth stating: the KEYS are
    // what the app reads, and dateKey(anchorNoonUtc(d)) === d exactly, for any
    // d. The anchor's contract is with the caller's date, not with a viewer's
    // timezone. This test pins the limit so nobody widens the claim later.
    const ms = anchorNoonUtc('2026-08-14');
    expect(dateKey(ms + 14 * 3600000)).toBe('2026-08-15');
    expect(dateKey(ms - 13 * 3600000)).toBe('2026-08-13');
    // The contract that actually holds, for a year of dates:
    for (const d of ['2026-01-01', '2026-02-28', '2026-06-15', '2026-12-31']) {
      expect(dateKey(anchorNoonUtc(d))).toBe(d);
    }
  });

  test('the whole plan follows the anchor, not the runtime clock', () => {
    const writes = planDemoAccount({uid: UID, nowMs: anchorNoonUtc('2026-08-14')});
    const scores = pathsOf(writes).filter((p) => p.includes('/dailyScores/'));
    // Newest cell is the anchored day — never the day after it.
    expect(scores).toContain(`users/${UID}/dailyScores/2026-08-14`);
    expect(scores).not.toContain(`users/${UID}/dailyScores/2026-08-15`);
    const streak = at(writes, `users/${UID}/streak/main`)!;
    expect(dateKey(Date.parse(streak.lastCompletionDate as string))).toBe('2026-08-14');
  });

  test('a malformed date throws rather than silently reverting to UTC drift', () => {
    expect(() => anchorNoonUtc('14-08-2026')).toThrow(/YYYY-MM-DD/);
    expect(() => anchorNoonUtc('not-a-date')).toThrow(/YYYY-MM-DD/);
  });
});

describe('the schedule shape the app reads', () => {
  test('🔴 tasksByDay keys are STRINGS — Firestore has no integer map keys', () => {
    const doc = scheduleDoc(DEMO_FIXTURE, '2026-08-10');
    for (const key of Object.keys(doc.tasksByDay as object)) {
      expect(typeof key).toBe('string');
      // And parseable back to the int the Dart side expects.
      expect(Number.isNaN(Number(key))).toBe(false);
    }
  });

  test('🔴 the timer task sits ALONE on the cleaning day', () => {
    // Frame 2's tap sequence needs one unambiguous target. A list would have to
    // be disambiguated by position or label, which is how a driver silently
    // starts the wrong chore and photographs the wrong duration.
    const doc = scheduleDoc(DEMO_FIXTURE, '2026-08-10');
    const onCleaningDay = (doc.tasksByDay as Record<string, string[]>)[
      String(DEMO_FIXTURE.cleaningDayOfWeek)
    ];
    expect(onCleaningDay).toEqual([DEMO_FIXTURE.timerTaskId]);
  });

  test('every scheduled id appears somewhere in the week', () => {
    const doc = scheduleDoc(DEMO_FIXTURE, '2026-08-10');
    const placed = Object.values(doc.tasksByDay as Record<string, string[]>).flat();
    expect(placed.sort()).toEqual([...DEMO_FIXTURE.scheduledTaskIds].sort());
  });
});

// ---------------------------------------------------------------------------
// The plan as a whole
// ---------------------------------------------------------------------------

describe('planDemoAccount', () => {
  test('writes every document the three frames read', () => {
    const paths = pathsOf(plan());
    expect(paths).toContain(`users/${UID}`);
    expect(paths).toContain(`users/${UID}/house/layout`);
    expect(paths).toContain(`users/${UID}/streak/main`);
    expect(paths).toContain(`users/${UID}/weeklySchedule/current`);
  });

  test('🔴 it is PURE — the same instant produces byte-identical writes', () => {
    // The property that makes a screenshot set reproducible rather than merely
    // repeatable. If anything below reached for Date.now() or a random id this
    // fails, and it is the only test that would notice.
    expect(plan()).toEqual(plan());
  });

  test('no write escapes the seeded user', () => {
    // A blast-radius control: this endpoint runs with admin credentials, so a
    // path built from the wrong variable would happily overwrite a real
    // account's house. Every path must be under users/<uid>.
    for (const w of plan()) {
      expect(w.path.startsWith(`users/${UID}`)).toBe(true);
    }
  });

  test('the fixture drives the output — changing streakDays changes the doc', () => {
    // KEY: THE ANTI-HARD-CODING CONTROL. The brief asks that the next person be
    // able to change a streak length without reading the builder; if any of
    // this were hard-coded to 7 the assertion below would fail.
    const writes = planDemoAccount({
      uid: UID,
      nowMs: WED_2026_08_12,
      fixture: {...DEMO_FIXTURE, streakDays: 30, historyDays: 45},
    });
    expect(at(writes, `users/${UID}/streak/main`)!.currentStreak).toBe(30);
    expect(writes.filter((w) => w.path.includes('/dailyScores/'))).toHaveLength(45);
  });

  test('all four authored houses can be seeded', () => {
    for (const h of DEFAULT_HOUSES) {
      const writes = planDemoAccount({
        uid: UID,
        nowMs: WED_2026_08_12,
        fixture: {...DEMO_FIXTURE, houseId: h.id},
      });
      const floors = at(writes, `users/${UID}/house/layout`)!.floors as {
        rooms: unknown[];
      }[];
      expect(floors[0].rooms.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: W2-85 — the collection grid
// ---------------------------------------------------------------------------
//
// W4 excluded the collection frame because the inventory seeding cost was
// uncosted. It is cheap, and the reason is that the dangerous half is ALREADY
// gated: inventory is keyed by SEED_ITEMS ids, and dailyRotation.test.ts reads
// `collection_seed.dart` OFF DISK to assert the two have not drifted. So the
// cross-language mirror that bit this file once as `lib_living_0` already
// exists here and already fails loudly — which is why no second hand-written
// mirror is added below.

import {inventoryDocs} from '../demoAccount';
import {SEED_ITEMS} from '../itemPool';

describe('🔴 W2-85 inventory — the collection reads as a collection', () => {
  const docs = () => inventoryDocs(UID, DEMO_FIXTURE);

  test('one document per owned id, keyed BY the item id', () => {
    // user_inventory_provider.dart falls back to doc.id when the itemId field
    // is absent, so the two agreeing is what makes a document readable by hand.
    const written = docs();
    expect(written).toHaveLength(DEMO_FIXTURE.inventoryItemIds.length);
    for (const w of written) {
      expect(w.path).toBe(`users/${UID}/inventory/${w.data.itemId}`);
    }
  });

  test('🔴 every owned id is a REAL SEED_ITEMS id', () => {
    // The silent-skip class. An id the catalogue does not know is dropped by
    // the grid with no error — an emptier screen than authored, and nothing
    // anywhere saying so.
    const ids = SEED_ITEMS.map((s) => s.id);
    for (const id of DEMO_FIXTURE.inventoryItemIds) {
      expect(ids).toContain(id);
    }
  });

  test('🔑 ANTI-VACUITY — SEED_ITEMS is non-empty and has known anchors', () => {
    // Without this, an empty or broken SEED_ITEMS would make the toContain
    // above pass against nothing.
    expect(SEED_ITEMS.length).toBeGreaterThan(20);
    expect(SEED_ITEMS.map((s) => s.id)).toContain('char_cleaner');
    expect(SEED_ITEMS.map((s) => s.id)).not.toContain('char_does_not_exist');
  });

  test('🔴 an unknown id THROWS rather than seeding an invisible item', () => {
    // WARNING: `equippedItemIds: []` IS LOAD-BEARING IN THIS FIXTURE, not tidiness.
    // Without it the default equipped ids are no longer owned, so the EQUIPPED
    // check throws first — with a different message — and the assertion passes
    // for the wrong reason. Caught by reading the failure rather than the
    // status: it was red, but red at the wrong line.
    expect(() =>
      inventoryDocs(UID, {
        ...DEMO_FIXTURE,
        inventoryItemIds: ['furn_not_real'],
        equippedItemIds: [],
      }),
    ).toThrow(/not a SEED_ITEMS id/);
  });

  test('🔴 `type` is LOOKED UP, not restated — it matches SEED_ITEMS exactly', () => {
    // A hand-written second copy of "which item is a character" would drift,
    // and a mistyped item renders in the wrong grid section — which looks like
    // a layout bug and is not one.
    for (const w of docs()) {
      const seed = SEED_ITEMS.find((s) => s.id === w.data.itemId);
      expect(w.data.type).toBe(seed!.type);
    }
  });

  test('the collection spans more than one type', () => {
    // A grid of twelve characters is not a collection, it is a character list.
    const types = new Set(docs().map((w) => w.data.type));
    expect(types.size).toBeGreaterThan(1);
  });

  test('🔴 equipped items are a SUBSET of owned, and equipping the unowned throws', () => {
    // Equipping something unowned is not a state the app can reach, and seeding
    // it would put the customize screen into one no player could.
    for (const id of DEMO_FIXTURE.equippedItemIds) {
      expect(DEMO_FIXTURE.inventoryItemIds).toContain(id);
    }
    expect(() =>
      inventoryDocs(UID, {
        ...DEMO_FIXTURE,
        equippedItemIds: ['char_astronaut'],
      }),
    ).toThrow(/not in inventoryItemIds/);
  });

  test('🔴 CONTROL — SOME items are equipped and SOME are not', () => {
    // Everything equipped tells you nothing about which slots exist; nothing
    // equipped makes the customize screen look unused. Both would pass a test
    // that only counted documents.
    const flags = docs().map((w) => w.data.isEquipped);
    expect(flags).toContain(true);
    expect(flags).toContain(false);
  });

  test('the plan carries the inventory', () => {
    const paths = plan().map((w) => w.path);
    for (const id of DEMO_FIXTURE.inventoryItemIds) {
      expect(paths).toContain(`users/${UID}/inventory/${id}`);
    }
  });
});
