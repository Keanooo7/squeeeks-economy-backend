// functions/src/__tests__/defaultHouses.test.ts
//
// W2-36. The four default houses.
//
// 🔴 THE ASSERTION THIS FILE EXISTS FOR IS `every furnitureId is real`. The
// renderer SILENTLY SKIPS an id the catalogue does not know — no error, no
// warning — so one typo produces an emptier house than was authored and it
// looks like a design choice rather than a bug. Nothing else here matters as
// much as that.

import {DEFAULT_HOUSES, defaultHouseById, HouseLayout} from '../defaultHouses';

/**
 * Transcribed from `RoomCatalogue.items` / `.rooms`
 * (lib/features/house_builder/domain/room_catalogue.dart).
 *
 * 📌 THIS IS A MIRROR, and this codebase has been bitten by mirrors repeatedly —
 * chest_drop_rates.dart, TASK_LIBRARY_IDS, the twice-written FNV-1a. It is
 * accepted here for one reason: the server cannot import from lib/, and an
 * UNCHECKED id is strictly worse than a checked copy. The non-vacuity tests
 * below are what stop a copy that silently emptied from passing everything.
 */
const CATALOGUE_FURNITURE = new Set([
  'sofa', 'armchair', 'dining_chair', 'office_chair', 'stool', 'bench',
  'dining_table', 'coffee_table', 'side_table', 'desk', 'counter',
  'bed', 'bed_single', 'bunk_bed', 'wardrobe', 'dresser', 'bookshelf',
  'cabinet', 'fridge', 'stove', 'tv_stand', 'toilet', 'sink', 'bathtub',
  'shower', 'lamp', 'nightstand', 'plant', 'stairs', 'prop_cutting_board_01',
]);

const CATALOGUE_ROOMS = new Set([
  'bedroom', 'kitchen', 'bathroom', 'living_room', 'dining_room', 'office',
  'hallway', 'staircase',
]);

/** `bedroom-1` → `bedroom`. Room ids are `<type>-<n>`. */
const roomType = (roomId: string): string => roomId.split('-')[0];

const allFurniture = (h: HouseLayout) => h.floors.flatMap((fl) => fl.furniture);
const allRooms = (h: HouseLayout) => h.floors.flatMap((fl) => fl.rooms);

describe('the mirror is not vacuously empty', () => {
  // A guard whose reference set is empty passes every id ever written.
  test('the transcribed catalogue has the expected size and known anchors', () => {
    expect(CATALOGUE_FURNITURE.size).toBe(30);
    expect(CATALOGUE_ROOMS.size).toBe(8);
    for (const anchor of ['bed', 'toilet', 'sofa', 'dining_table', 'fridge']) {
      expect(CATALOGUE_FURNITURE.has(anchor)).toBe(true);
    }
    // And something plausible that does NOT exist, so the set is discriminating.
    for (const absent of ['rug', 'microwave', 'washer', 'mirror', 'television']) {
      expect(CATALOGUE_FURNITURE.has(absent)).toBe(false);
    }
  });

  test('there are four houses and they are the four that were asked for', () => {
    expect(DEFAULT_HOUSES).toHaveLength(4);
    expect(DEFAULT_HOUSES.map((h) => `${h.bedrooms}/${h.bathrooms}`)).toEqual([
      '1/1', '2/1', '2/2', '3/3',
    ]);
  });
});

describe('🔴 every id is real — the silent-skip trap', () => {
  test.each(DEFAULT_HOUSES.map((h) => [h.id, h] as const))(
    '%s uses only catalogue furniture',
    (_id, house) => {
      const unknown = allFurniture(house)
        .map((f) => f.furnitureId)
        .filter((fid) => !CATALOGUE_FURNITURE.has(fid));
      // Named in the failure so a typo is identifiable from the output alone.
      expect(unknown).toEqual([]);
    },
  );

  test.each(DEFAULT_HOUSES.map((h) => [h.id, h] as const))(
    '%s uses only catalogue room types',
    (_id, house) => {
      const unknown = allRooms(house)
        .map((r) => roomType(r.roomId))
        .filter((t) => !CATALOGUE_ROOMS.has(t));
      expect(unknown).toEqual([]);
    },
  );

  test('the check is not passing vacuously — there is furniture to check', () => {
    for (const house of DEFAULT_HOUSES) {
      expect(allFurniture(house).length).toBeGreaterThan(15);
    }
  });
});

describe('the room counts match the labels', () => {
  // A house advertised as 3 bed that contains two bedrooms is a data bug that
  // no renderer would catch.
  test.each(DEFAULT_HOUSES.map((h) => [h.id, h] as const))(
    '%s has the bedrooms and bathrooms it claims',
    (_id, house) => {
      const types = allRooms(house).map((r) => roomType(r.roomId));
      expect(types.filter((t) => t === 'bedroom')).toHaveLength(house.bedrooms);
      expect(types.filter((t) => t === 'bathroom')).toHaveLength(house.bathrooms);
    },
  );
});

describe('these are homes, not furniture lists', () => {
  // The bar from the brief, in the parts a machine can see.
  test.each(DEFAULT_HOUSES.map((h) => [h.id, h] as const))(
    '%s: every bedroom has a bed and a nightstand',
    (_id, house) => {
      const ids = allFurniture(house).map((f) => f.furnitureId);
      const beds = ids.filter((i) => i === 'bed' || i === 'bed_single' || i === 'bunk_bed');
      expect(beds.length).toBeGreaterThanOrEqual(house.bedrooms);
      expect(ids.filter((i) => i === 'nightstand').length).toBeGreaterThanOrEqual(house.bedrooms);
    },
  );

  test.each(DEFAULT_HOUSES.map((h) => [h.id, h] as const))(
    '%s: every bathroom has a toilet and a sink',
    (_id, house) => {
      const ids = allFurniture(house).map((f) => f.furnitureId);
      expect(ids.filter((i) => i === 'toilet').length).toBe(house.bathrooms);
      expect(ids.filter((i) => i === 'sink').length).toBeGreaterThanOrEqual(house.bathrooms);
    },
  );

  test.each(DEFAULT_HOUSES.map((h) => [h.id, h] as const))(
    '%s: seating faces something — a sofa implies a table or a tv',
    (_id, house) => {
      const ids = new Set(allFurniture(house).map((f) => f.furnitureId));
      if (ids.has('sofa')) {
        expect(ids.has('coffee_table') || ids.has('tv_stand')).toBe(true);
      }
    },
  );

  test.each(DEFAULT_HOUSES.map((h) => [h.id, h] as const))(
    '%s: a dining table has chairs pulled up to it',
    (_id, house) => {
      const ids = allFurniture(house).map((f) => f.furnitureId);
      if (ids.includes('dining_table')) {
        const seats = ids.filter((i) => i === 'dining_chair' || i === 'bench' || i === 'stool');
        expect(seats.length).toBeGreaterThanOrEqual(2);
      }
    },
  );

  test('the largest house is genuinely larger than the smallest', () => {
    const small = allFurniture(DEFAULT_HOUSES[0]).length;
    const large = allFurniture(DEFAULT_HOUSES[3]).length;
    expect(large).toBeGreaterThan(small * 1.5);
    expect(allRooms(DEFAULT_HOUSES[3]).length).toBeGreaterThan(allRooms(DEFAULT_HOUSES[0]).length);
  });
});

describe('nothing overlaps and nothing escapes the grid', () => {
  // ⚠️ The grid is 24 today and Brendan wants ~34. These are authored from an
  // origin of (0,0) and must fit BOTH, so the bound asserted is the small one.
  const GRID_TODAY = 24;

  test.each(DEFAULT_HOUSES.map((h) => [h.id, h] as const))(
    '%s fits inside the 24x24 grid with a margin',
    (_id, house) => {
      for (const r of allRooms(house)) {
        expect(r.x).toBeGreaterThanOrEqual(1);
        expect(r.y).toBeGreaterThanOrEqual(1);
        expect(r.x + r.width).toBeLessThan(GRID_TODAY);
        expect(r.y + r.height).toBeLessThan(GRID_TODAY);
      }
      for (const fu of allFurniture(house)) {
        expect(fu.x).toBeGreaterThanOrEqual(0);
        expect(fu.y).toBeGreaterThanOrEqual(0);
        expect(fu.x).toBeLessThan(GRID_TODAY);
        expect(fu.y).toBeLessThan(GRID_TODAY);
      }
    },
  );

  test.each(DEFAULT_HOUSES.map((h) => [h.id, h] as const))(
    '%s: no two rooms overlap',
    (_id, house) => {
      const rooms = allRooms(house);
      const clashes: string[] = [];
      for (let i = 0; i < rooms.length; i++) {
        for (let j = i + 1; j < rooms.length; j++) {
          const a = rooms[i], b = rooms[j];
          const overlap =
            a.x < b.x + b.width && b.x < a.x + a.width &&
            a.y < b.y + b.height && b.y < a.y + a.height;
          if (overlap) clashes.push(`${a.roomId}/${b.roomId}`);
        }
      }
      expect(clashes).toEqual([]);
    },
  );

  test.each(DEFAULT_HOUSES.map((h) => [h.id, h] as const))(
    '%s: no two pieces of furniture share a tile',
    (_id, house) => {
      const seen = new Map<string, string>();
      const clashes: string[] = [];
      for (const fu of allFurniture(house)) {
        const key = `${fu.x},${fu.y}`;
        const prev = seen.get(key);
        if (prev) clashes.push(`${prev} and ${fu.id} both at ${key}`);
        else seen.set(key, fu.id);
      }
      expect(clashes).toEqual([]);
    },
  );

  test.each(DEFAULT_HOUSES.map((h) => [h.id, h] as const))(
    '%s: every furniture id is unique',
    (_id, house) => {
      const ids = allFurniture(house).map((f) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
    },
  );

  test('house ids are unique and resolvable', () => {
    const ids = DEFAULT_HOUSES.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(defaultHouseById(id)?.id).toBe(id);
    expect(defaultHouseById('no_such_house')).toBeUndefined();
  });
});

describe('the shape matches GIBBY_HOUSE_LAYOUT', () => {
  // The seeder that writes these will write them the way Gibby's is written.
  test('every furniture entry has the six fields the renderer reads', () => {
    for (const house of DEFAULT_HOUSES) {
      for (const fu of allFurniture(house)) {
        expect(typeof fu.id).toBe('string');
        expect(typeof fu.furnitureId).toBe('string');
        expect(Number.isFinite(fu.x)).toBe(true);
        expect(Number.isFinite(fu.y)).toBe(true);
        expect([0, 1, 2, 3]).toContain(fu.rotation);
        expect(fu.heightLevel).toBe(0);
      }
    }
  });

  test('every room entry has an id, an origin and a size', () => {
    for (const house of DEFAULT_HOUSES) {
      for (const r of allRooms(house)) {
        expect(r.roomId).toMatch(/^[a-z_]+-\d+$/);
        expect(r.width).toBeGreaterThan(0);
        expect(r.height).toBeGreaterThan(0);
      }
    }
  });
});
