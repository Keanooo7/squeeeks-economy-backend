// functions/src/__tests__/plantDirectory.test.ts
//
// The directory's own invariants and the lookup, as pure data.
//
// KEY: The shipped directory is checked by the SAME validator that guards a
// console override, so the bundled list cannot hold a defect the override path
// would refuse. That is the whole reason `validatePlantDirectory` takes a
// directory rather than reading the constant.

import {
  PLANT_DIRECTORY,
  type PlantSpecies,
  findPlant,
  normalisePlantName,
  validatePlantDirectory,
} from '../plantDirectory';

describe('🟢 the SHIPPED directory is sound — this must not be red', () => {
  test('it passes the same validator a console override must pass', () => {
    expect(validatePlantDirectory(PLANT_DIRECTORY)).toEqual([]);
  });

  test('it is not vacuously small', () => {
    // A validator run against an empty list would report no problems and prove
    // nothing.
    expect(PLANT_DIRECTORY.length).toBeGreaterThanOrEqual(15);
  });

  test('every advertised interval sits inside its own stated range', () => {
    // The error a hand edit actually makes: change the number, forget the span
    // that describes it. Asserted here as well as in the validator because this
    // is the list players will actually receive.
    for (const p of PLANT_DIRECTORY) {
      const [lo, hi] = p.wateringIntervalRange;
      expect(p.wateringIntervalDays).toBeGreaterThanOrEqual(lo);
      expect(p.wateringIntervalDays).toBeLessThanOrEqual(hi);
    }
  });

  test('every plant answers to at least one alias beyond its own name', () => {
    // "Say the plant" means the input is whatever a person calls it. A row
    // reachable only by its exact commonName is a row a player cannot find.
    for (const p of PLANT_DIRECTORY) {
      expect(p.aliases.length).toBeGreaterThan(0);
    }
  });

  test('the intervals span a real range — not every plant is weekly', () => {
    // A directory that answered "about a week" for everything would be a
    // constant wearing a lookup's clothes, and nobody would notice.
    const days = PLANT_DIRECTORY.map((p) => p.wateringIntervalDays);
    expect(Math.min(...days)).toBeLessThanOrEqual(4);
    expect(Math.max(...days)).toBeGreaterThanOrEqual(14);
  });
});

describe('normalisePlantName', () => {
  test.each([
    ["Devil's Ivy", 'devils ivy'],
    ['  DEVILS   IVY  ', 'devils ivy'],
    ['Monstera deliciosa', 'monstera deliciosa'],
    ['Aloe-Vera', 'aloevera'],
  ])('%j folds to %j', (input, expected) => {
    expect(normalisePlantName(input)).toBe(expected);
  });

  test('an empty or punctuation-only name folds to empty, not to a match', () => {
    expect(normalisePlantName('   ')).toBe('');
    expect(normalisePlantName('!!!')).toBe('');
  });
});

describe('findPlant', () => {
  test('finds a plant by its common name', () => {
    expect(findPlant('Snake plant')?.id).toBe('snake_plant');
  });

  test('finds a plant by an alias, including the Latin name', () => {
    expect(findPlant('sansevieria')?.id).toBe('snake_plant');
    expect(findPlant('epipremnum aureum')?.id).toBe('pothos');
  });

  test("finds a plant however the apostrophe is typed", () => {
    // The reason normalisation exists at all: a phone keyboard produces a
    // curly apostrophe and a physical one produces a straight quote.
    expect(findPlant("devil's ivy")?.id).toBe('pothos');
    expect(findPlant('devils ivy')?.id).toBe('pothos');
    expect(findPlant('DEVILS IVY')?.id).toBe('pothos');
  });

  test('finds a plant by its id, spoken as words', () => {
    expect(findPlant('fiddle leaf fig')?.id).toBe('fiddle_leaf_fig');
  });

  test('🔴 returns null rather than guessing', () => {
    // A fuzzy matcher would hand somebody a schedule for a different plant.
    // "Not found, please pick" is the honest failure; a confident wrong
    // interval kills the plant.
    expect(findPlant('triffid')).toBeNull();
    expect(findPlant('snake')).toBeNull();
    expect(findPlant('')).toBeNull();
    expect(findPlant('   ')).toBeNull();
  });
});

describe('validatePlantDirectory — what it refuses', () => {
  const ok = (over: Partial<PlantSpecies> = {}): PlantSpecies => ({
    id: 'a_plant',
    commonName: 'A plant',
    aliases: ['a plant'],
    wateringIntervalDays: 7,
    wateringIntervalRange: [5, 10],
    light: 'medium',
    note: 'fine',
    ...over,
  });

  test('an empty directory is a problem, not a pass', () => {
    // KEY: The vacuous case. A validator that returned [] for an empty list would
    // wave through a console edit that deleted every row.
    expect(validatePlantDirectory([])).toEqual(['directory is empty']);
  });

  test('🔴 the same alias on two species is refused', () => {
    // THE ONE THAT MAKES A LOOKUP LIE. Whichever row is listed first silently
    // wins, and the other plant is unreachable while appearing to be present.
    const problems = validatePlantDirectory([
      ok({ id: 'fern', aliases: ['green one'] }),
      ok({ id: 'cactus', aliases: ['green one'] }),
    ]);
    expect(problems.some((p) => p.includes("alias 'green one'"))).toBe(true);
  });

  test('a species repeating its OWN alias is fine', () => {
    // The control for the rule above — otherwise the check would refuse a
    // perfectly good row that lists a synonym twice.
    expect(validatePlantDirectory([ok({ aliases: ['a plant', 'a plant'] })])).toEqual([]);
  });

  test('a duplicate id is refused', () => {
    const problems = validatePlantDirectory([ok(), ok()]);
    expect(problems.some((p) => p.includes("duplicate id 'a_plant'"))).toBe(true);
  });

  test('an interval outside its own range is refused', () => {
    const problems = validatePlantDirectory([
      ok({ wateringIntervalDays: 30, wateringIntervalRange: [5, 10] }),
    ]);
    expect(problems.some((p) => p.includes('outside its range'))).toBe(true);
  });

  test('an inverted range is refused', () => {
    const problems = validatePlantDirectory([
      ok({ wateringIntervalDays: 7, wateringIntervalRange: [10, 5] }),
    ]);
    expect(problems.some((p) => p.includes('inverted'))).toBe(true);
  });

  test.each([
    ['no id', { id: undefined }, 'has no id'],
    ['no commonName', { commonName: undefined }, 'has no commonName'],
    ['a zero interval', { wateringIntervalDays: 0 }, 'wateringIntervalDays'],
    ['a negative interval', { wateringIntervalDays: -3 }, 'wateringIntervalDays'],
  ])('%s is refused', (_label, over, expected) => {
    const problems = validatePlantDirectory([ok(over as Partial<PlantSpecies>)]);
    expect(problems.some((p) => p.includes(expected))).toBe(true);
  });

  test('a malformed entry is REPORTED, never thrown at', () => {
    // Total over a bad shape, because the override comes from a Firebase
    // console edit — a crash there would take the callable down for everyone,
    // including the players whose directory was fine.
    expect(() => validatePlantDirectory([null, 'not a plant', 42])).not.toThrow();
    expect(validatePlantDirectory([null]).length).toBeGreaterThan(0);
  });

  test('every problem is reported at once, not just the first', () => {
    // An override with two bad rows must not need two console edits to
    // discover — the same reason rotateWeeklyOffer reports all of them.
    const problems = validatePlantDirectory([
      ok({ id: undefined }),
      ok({ id: 'b', wateringIntervalDays: 99, wateringIntervalRange: [1, 2] }),
    ]);
    expect(problems.length).toBeGreaterThanOrEqual(2);
  });
});
