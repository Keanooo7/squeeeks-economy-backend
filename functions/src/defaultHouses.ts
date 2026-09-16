// ---------------------------------------------------------------------------
// The four default houses — furnished as if someone lived in them
// ---------------------------------------------------------------------------
//
// W2-36. Brendan: four starting homes — 1bed/1bath, 2/1, 2/2, 3/3 — varying in
// size and "furnished as if it were a real home".
//
// ⚠️ GIBBY_HOUSE_LAYOUT IS THE CAUTIONARY EXAMPLE, NOT THE TEMPLATE. One room,
// three pieces, a sofa and a coffee table and an armchair floating in a 4x4 box.
// That is a furniture list. A home is a bed against a wall with a nightstand
// beside it, seating that faces something, a table with chairs actually pulled
// up to it, and floor you can walk across without climbing over the furniture.
// These layouts are authored to that bar and the tests below check the parts of
// it a machine can see.
//
// ---------------------------------------------------------------------------
// 🔴 A furnitureId THE CATALOGUE DOES NOT KNOW IS SILENTLY SKIPPED
// ---------------------------------------------------------------------------
//
// The renderer drops an unknown id without an error, so a single typo produces
// an emptier house than was authored and nothing anywhere says so. That is the
// worst failure mode available here — it degrades quietly and looks like a
// design choice.
//
// `defaultHouses.test.ts` pins every id against a transcribed copy of
// RoomCatalogue's `items` and `rooms`. 📌 That copy is a MIRROR, and this
// codebase has been bitten by mirrors repeatedly (chest_drop_rates.dart,
// TASK_LIBRARY_IDS, the twice-written FNV-1a). It is accepted here for one
// reason: the alternative is the server importing from lib/, which it cannot,
// and an unchecked id is strictly worse than a checked copy. The test asserts
// the mirror is non-empty and contains known-good anchors, so a copy that
// silently emptied would fail rather than pass everything.
//
// ---------------------------------------------------------------------------
// 📌 THE CATALOGUE IS SUFFICIENT — the disproof did not fire
// ---------------------------------------------------------------------------
//
// 30 furniture entries, and `RoomCatalogue.awaitingArt` is EMPTY, so every one
// of them renders. Room by room:
//
//   bedroom   bed · bed_single · bunk_bed · wardrobe · dresser · nightstand · lamp
//   bathroom  toilet · sink · bathtub · shower
//   kitchen   counter · stove · fridge · cabinet · sink · prop_cutting_board_01
//   living    sofa · armchair · coffee_table · side_table · tv_stand · bookshelf · plant
//   dining    dining_table · dining_chair · bench · stool
//   office    desk · office_chair · bookshelf
//
// ⚠️ W1's finding that ~15 of 30 TASKS name furniture that does not exist is a
// DIFFERENT QUESTION and does not block this. Those are things you CLEAN —
// microwave, rug, washer, bin — not things you PLACE. Furnishing a room and
// mapping a task to a prop draw on different sets, and only the second is short.
//
// What I wanted and could not have, all of it garnish rather than structure:
// rug, mirror, television (only `tv_stand` exists — the stand with nothing on
// it), washer/dryer, bin, curtains, wall art, towel rail.
//
// ---------------------------------------------------------------------------
// GRID AND ORIGIN — stated, because the constant is moving
// ---------------------------------------------------------------------------
//
// The grid is 24x24 today and Brendan wants ~34. These layouts are authored
// from an ORIGIN OF (0,0) at the top-left, with every room starting at x>=1,y>=1
// so there is a one-tile margin, and NOTHING EXCEEDS x=17 or y=17 even in the
// largest house. So they fit 24 with room to spare and fit 34 unchanged, sitting
// in the top-left rather than centred.
//
// 🔑 I did not touch the grid constant — it is lib/ and W1's. If it grows and
// someone wants these centred rather than corner-anchored, that is an offset
// applied at read time, not a re-authoring.
//
// Coordinates are tile units. A room's x/y is its top-left corner; furniture
// x/y is the tile it occupies. `rotation` is quarter-turns (0=north, 1=east,
// 2=south, 3=west) matching GIBBY_HOUSE_LAYOUT's convention.

export interface HouseFurniture {
  id: string;
  furnitureId: string;
  x: number;
  y: number;
  rotation: number;
  heightLevel: number;
}

export interface HouseRoom {
  roomId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HouseLayout {
  /** Stable key. Used to pick a starting house; never shown to a player. */
  id: string;
  /** What Brendan asked for, so the set is legible without counting rooms. */
  label: string;
  bedrooms: number;
  bathrooms: number;
  floors: {
    id: string;
    index: number;
    rooms: HouseRoom[];
    furniture: HouseFurniture[];
  }[];
}

/** Terse constructor — the layouts below are long enough without ceremony. */
const f = (
  id: string,
  furnitureId: string,
  x: number,
  y: number,
  rotation = 0,
): HouseFurniture => ({id, furnitureId, x, y, rotation, heightLevel: 0});

// ---------------------------------------------------------------------------
// 1 bed / 1 bath — a small flat
// ---------------------------------------------------------------------------
//
// Bed head against the north wall with a nightstand and lamp beside it; sofa
// facing the tv_stand across a coffee table; the dining table pulled up to two
// chairs rather than floating. The corridor column at x=6 is deliberately empty.
const HOUSE_1B1B: HouseLayout = {
  id: 'default_1bed_1bath',
  label: '1 bed · 1 bath',
  bedrooms: 1,
  bathrooms: 1,
  floors: [
    {
      id: 'floor-0',
      index: 0,
      rooms: [
        {roomId: 'bedroom-1', x: 1, y: 1, width: 5, height: 5},
        {roomId: 'bathroom-1', x: 7, y: 1, width: 3, height: 3},
        {roomId: 'living_room-1', x: 1, y: 7, width: 6, height: 5},
        {roomId: 'kitchen-1', x: 8, y: 7, width: 4, height: 5},
      ],
      furniture: [
        // Bedroom — bed against the north wall, nightstand within reach.
        f('h1_bed', 'bed', 2, 2, 2),
        f('h1_night', 'nightstand', 4, 2),
        f('h1_lamp', 'lamp', 4, 1),
        f('h1_wardrobe', 'wardrobe', 1, 4, 1),
        f('h1_dresser', 'dresser', 3, 5, 0),
        // Bathroom — fixtures on the walls, floor left clear.
        f('h1_toilet', 'toilet', 7, 1, 1),
        f('h1_sink', 'sink', 9, 1, 3),
        f('h1_bath', 'bathtub', 8, 3, 2),
        // Living — sofa faces the tv_stand across the coffee table.
        f('h1_sofa', 'sofa', 2, 8, 2),
        f('h1_coffee', 'coffee_table', 3, 9),
        f('h1_tv', 'tv_stand', 3, 11, 0),
        f('h1_arm', 'armchair', 5, 9, 3),
        f('h1_plant', 'plant', 1, 11),
        // Kitchen — counter run, appliances flanking, table pulled up to chairs.
        f('h1_counter', 'counter', 8, 7, 2),
        f('h1_stove', 'stove', 9, 7, 2),
        f('h1_fridge', 'fridge', 11, 7, 2),
        f('h1_ksink', 'sink', 10, 7, 2),
        f('h1_dine', 'dining_table', 9, 10),
        f('h1_chair1', 'dining_chair', 8, 10, 1),
        f('h1_chair2', 'dining_chair', 10, 10, 3),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 2 bed / 1 bath — a family starter
// ---------------------------------------------------------------------------
//
// Second bedroom is a child's room: bed_single and a desk, not a shrunken copy
// of the main one. The bathroom sits between the two bedrooms, which is where
// it belongs in a real plan.
const HOUSE_2B1B: HouseLayout = {
  id: 'default_2bed_1bath',
  label: '2 bed · 1 bath',
  bedrooms: 2,
  bathrooms: 1,
  floors: [
    {
      id: 'floor-0',
      index: 0,
      rooms: [
        {roomId: 'bedroom-1', x: 1, y: 1, width: 5, height: 5},
        {roomId: 'bathroom-1', x: 7, y: 1, width: 3, height: 4},
        {roomId: 'bedroom-2', x: 11, y: 1, width: 4, height: 5},
        {roomId: 'living_room-1', x: 1, y: 7, width: 7, height: 6},
        {roomId: 'kitchen-1', x: 9, y: 7, width: 6, height: 6},
      ],
      furniture: [
        f('h2_bed', 'bed', 2, 2, 2),
        f('h2_night', 'nightstand', 4, 2),
        f('h2_lamp', 'lamp', 4, 1),
        f('h2_wardrobe', 'wardrobe', 1, 5, 1),
        f('h2_dresser', 'dresser', 4, 5),
        f('h2_toilet', 'toilet', 7, 1, 1),
        f('h2_sink', 'sink', 9, 1, 3),
        f('h2_bath', 'bathtub', 8, 4, 2),
        // Child's room — single bed, a desk to work at, storage.
        f('h2_bed2', 'bed_single', 12, 2, 2),
        f('h2_night2', 'nightstand', 14, 2),
        f('h2_desk', 'desk', 11, 5, 0),
        f('h2_chair', 'office_chair', 12, 4),
        f('h2_shelf', 'bookshelf', 14, 5, 3),
        // Living — a longer sofa run with a side table and a reading lamp.
        f('h2_sofa', 'sofa', 2, 8, 2),
        f('h2_side', 'side_table', 1, 8),
        f('h2_lamp2', 'lamp', 1, 9),
        f('h2_coffee', 'coffee_table', 3, 10),
        f('h2_tv', 'tv_stand', 3, 12),
        f('h2_arm', 'armchair', 6, 10, 3),
        f('h2_shelf2', 'bookshelf', 7, 8, 3),
        f('h2_plant', 'plant', 1, 12),
        // Kitchen — a four-seat table, because two adults and a child eat here.
        f('h2_counter', 'counter', 9, 7, 2),
        f('h2_stove', 'stove', 10, 7, 2),
        f('h2_ksink', 'sink', 11, 7, 2),
        f('h2_fridge', 'fridge', 13, 7, 2),
        f('h2_board', 'prop_cutting_board_01', 12, 7, 2),
        f('h2_dine', 'dining_table', 11, 10),
        f('h2_c1', 'dining_chair', 10, 10, 1),
        f('h2_c2', 'dining_chair', 12, 10, 3),
        f('h2_c3', 'dining_chair', 11, 9, 2),
        f('h2_c4', 'dining_chair', 11, 11, 0),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 2 bed / 2 bath — an en-suite
// ---------------------------------------------------------------------------
//
// The second bathroom is an EN-SUITE off the main bedroom, which is what a 2/2
// actually means; a second identical bathroom across the hall would be a
// floorplan nobody builds. Main bath gets the bathtub, en-suite gets a shower.
const HOUSE_2B2B: HouseLayout = {
  id: 'default_2bed_2bath',
  label: '2 bed · 2 bath',
  bedrooms: 2,
  bathrooms: 2,
  floors: [
    {
      id: 'floor-0',
      index: 0,
      rooms: [
        {roomId: 'bedroom-1', x: 1, y: 1, width: 6, height: 5},
        {roomId: 'bathroom-1', x: 8, y: 1, width: 3, height: 3},
        {roomId: 'bedroom-2', x: 12, y: 1, width: 5, height: 5},
        {roomId: 'bathroom-2', x: 8, y: 5, width: 3, height: 3},
        {roomId: 'living_room-1', x: 1, y: 9, width: 7, height: 6},
        {roomId: 'kitchen-1', x: 9, y: 9, width: 5, height: 4},
        {roomId: 'dining_room-1', x: 15, y: 9, width: 4, height: 5},
      ],
      furniture: [
        f('h3_bed', 'bed', 2, 2, 2),
        f('h3_n1', 'nightstand', 1, 2),
        f('h3_n2', 'nightstand', 4, 2),
        f('h3_lamp', 'lamp', 4, 1),
        f('h3_wardrobe', 'wardrobe', 6, 4, 3),
        f('h3_dresser', 'dresser', 2, 5),
        // En-suite off the main bedroom — shower, no tub.
        f('h3_esink', 'sink', 8, 5, 1),
        f('h3_etoilet', 'toilet', 10, 5, 3),
        f('h3_shower', 'shower', 9, 7, 2),
        // Main bathroom — the tub.
        f('h3_toilet', 'toilet', 8, 1, 1),
        f('h3_sink', 'sink', 10, 1, 3),
        f('h3_bath', 'bathtub', 9, 3, 2),
        // Guest bedroom.
        f('h3_bed2', 'bed_single', 13, 2, 2),
        f('h3_n3', 'nightstand', 15, 2),
        f('h3_wardrobe2', 'wardrobe', 12, 4, 1),
        f('h3_shelf', 'bookshelf', 16, 4, 3),
        // Living.
        f('h3_sofa', 'sofa', 2, 10, 2),
        f('h3_side', 'side_table', 1, 10),
        f('h3_coffee', 'coffee_table', 3, 12),
        f('h3_tv', 'tv_stand', 3, 14),
        f('h3_arm1', 'armchair', 6, 11, 3),
        f('h3_arm2', 'armchair', 6, 13, 3),
        f('h3_plant', 'plant', 1, 14),
        // Kitchen — a working galley, no table (the dining room has it).
        f('h3_counter', 'counter', 9, 9, 2),
        f('h3_stove', 'stove', 10, 9, 2),
        f('h3_ksink', 'sink', 11, 9, 2),
        f('h3_fridge', 'fridge', 13, 9, 2),
        f('h3_cab', 'cabinet', 9, 12),
        f('h3_board', 'prop_cutting_board_01', 12, 9, 2),
        // Dining room — a proper table with a bench on one side.
        f('h3_dine', 'dining_table', 16, 11),
        f('h3_bench', 'bench', 16, 10, 2),
        f('h3_c1', 'dining_chair', 15, 11, 1),
        f('h3_c2', 'dining_chair', 17, 11, 3),
        f('h3_c3', 'dining_chair', 16, 12, 0),
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// 3 bed / 3 bath — the largest
// ---------------------------------------------------------------------------
//
// Main with en-suite, two more bedrooms sharing a family bath, an office, and a
// dining room separate from the kitchen. The third bedroom is a bunk room —
// a different room rather than a third variation on the same one.
const HOUSE_3B3B: HouseLayout = {
  id: 'default_3bed_3bath',
  label: '3 bed · 3 bath',
  bedrooms: 3,
  bathrooms: 3,
  floors: [
    {
      id: 'floor-0',
      index: 0,
      rooms: [
        {roomId: 'bedroom-1', x: 1, y: 1, width: 6, height: 5},
        {roomId: 'bathroom-1', x: 8, y: 1, width: 3, height: 3},
        {roomId: 'bedroom-2', x: 12, y: 1, width: 5, height: 5},
        {roomId: 'bathroom-2', x: 8, y: 5, width: 3, height: 3},
        {roomId: 'bedroom-3', x: 1, y: 7, width: 5, height: 4},
        {roomId: 'bathroom-3', x: 12, y: 7, width: 3, height: 3},
        {roomId: 'office-1', x: 16, y: 7, width: 4, height: 4},
        {roomId: 'living_room-1', x: 1, y: 12, width: 8, height: 6},
        {roomId: 'kitchen-1', x: 10, y: 12, width: 5, height: 4},
        {roomId: 'dining_room-1', x: 16, y: 12, width: 5, height: 5},
      ],
      furniture: [
        // Main bedroom.
        f('h4_bed', 'bed', 2, 2, 2),
        f('h4_n1', 'nightstand', 1, 2),
        f('h4_n2', 'nightstand', 4, 2),
        f('h4_lamp', 'lamp', 4, 1),
        f('h4_wardrobe', 'wardrobe', 6, 4, 3),
        f('h4_dresser', 'dresser', 2, 5),
        // En-suite.
        f('h4_esink', 'sink', 8, 5, 1),
        f('h4_etoilet', 'toilet', 10, 5, 3),
        f('h4_shower', 'shower', 9, 7, 2),
        // Family bath.
        f('h4_toilet', 'toilet', 8, 1, 1),
        f('h4_sink', 'sink', 10, 1, 3),
        f('h4_bath', 'bathtub', 9, 3, 2),
        // Second bedroom.
        f('h4_bed2', 'bed_single', 13, 2, 2),
        f('h4_n3', 'nightstand', 15, 2),
        f('h4_desk2', 'desk', 12, 4),
        f('h4_chair2', 'office_chair', 13, 4),
        f('h4_wardrobe2', 'wardrobe', 16, 4, 3),
        // Third bedroom — bunks for two.
        f('h4_bunk', 'bunk_bed', 2, 8, 2),
        f('h4_n4', 'nightstand', 4, 8),
        f('h4_shelf3', 'bookshelf', 1, 10, 1),
        // Third bathroom — compact, shower only.
        f('h4_toilet3', 'toilet', 12, 7, 1),
        f('h4_sink3', 'sink', 14, 7, 3),
        f('h4_shower3', 'shower', 13, 9, 2),
        // Office.
        f('h4_desk', 'desk', 17, 8),
        f('h4_ochair', 'office_chair', 17, 9),
        f('h4_shelf', 'bookshelf', 19, 8, 3),
        f('h4_plant2', 'plant', 16, 10),
        // Living — two sofas facing each other across the table.
        f('h4_sofa', 'sofa', 2, 13, 2),
        f('h4_sofa2', 'sofa', 2, 16, 0),
        f('h4_coffee', 'coffee_table', 3, 15),
        f('h4_tv', 'tv_stand', 7, 15, 3),
        f('h4_side', 'side_table', 1, 13),
        f('h4_lamp2', 'lamp', 1, 14),
        f('h4_arm', 'armchair', 6, 13, 3),
        f('h4_plant', 'plant', 1, 17),
        // Kitchen.
        f('h4_counter', 'counter', 10, 12, 2),
        f('h4_stove', 'stove', 11, 12, 2),
        f('h4_ksink', 'sink', 12, 12, 2),
        f('h4_fridge', 'fridge', 14, 12, 2),
        f('h4_board', 'prop_cutting_board_01', 13, 12, 2),
        f('h4_cab', 'cabinet', 10, 15),
        f('h4_stool', 'stool', 12, 14),
        // Dining.
        f('h4_dine', 'dining_table', 18, 14),
        f('h4_bench', 'bench', 18, 13, 2),
        f('h4_c1', 'dining_chair', 17, 14, 1),
        f('h4_c2', 'dining_chair', 19, 14, 3),
        f('h4_c3', 'dining_chair', 18, 15, 0),
      ],
    },
  ],
};

/** The four, in the order Brendan listed them. */
export const DEFAULT_HOUSES: HouseLayout[] = [
  HOUSE_1B1B,
  HOUSE_2B1B,
  HOUSE_2B2B,
  HOUSE_3B3B,
];

/** Lookup by id, for a seeder that is told which house to write. */
export function defaultHouseById(id: string): HouseLayout | undefined {
  return DEFAULT_HOUSES.find((h) => h.id === id);
}
