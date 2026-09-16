import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gen = require('../../scripts/gen-seed.cjs') as {
  loadRows: () => Array<Record<string, string | null>>;
  emitDart: (rows: unknown[]) => Record<string, string>;
  lockContent: (rows: unknown[]) => string;
};

const REPO = path.resolve(__dirname, '../../..');
const DART_MIRROR = 'lib/features/customization/domain/collection_seed.dart';

/**
 * W2-135 · The authored seed, and the proof that both projections are exact.
 *
 * 🔴 THE VACUITY GUARD COMES FIRST AND IS NOT DECORATION. A generator that emits
 * nothing, diffed against an equally empty committed file, DIFFS CLEAN. Every
 * assertion below is worthless unless the parse found real rows first — the same
 * reasoning dailyRotation.test.ts:590 gives about its own parse.
 */
describe('the authored seed source', () => {
  const rows = gen.loadRows();

  test('the parse itself found a plausible number of rows', () => {
    // Derived at this tree, not transcribed: the spec's "40" was measured at
    // e2bb973 and #561/#566 have landed since. A literal here rots in days.
    expect(rows.length).toBeGreaterThanOrEqual(52);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every row carries every field the projections need', () => {
    const REQUIRED = ['id', 'type', 'category', 'subject', 'name', 'rarity', 'description'];
    const bad: string[] = [];
    for (const r of rows) {
      for (const k of REQUIRED) {
        if (typeof r[k] !== 'string' || (r[k] as string).length === 0) {
          bad.push(`${r.id ?? '«no id»'}.${k}`);
        }
      }
      // `family` is nullable BY DESIGN — null means neutral — so it is checked
      // for presence of the KEY, not for truthiness. `artUrl` is '' on every
      // row today and must be allowed to stay empty.
      if (!('family' in r)) bad.push(`${r.id}.family missing`);
      if (typeof r.artUrl !== 'string') bad.push(`${r.id}.artUrl not a string`);
    }
    expect(`rows with missing fields: ${JSON.stringify(bad)}`).toBe(
      'rows with missing fields: []',
    );
  });

  test('subject is still not derivable from (type, category)', () => {
    // The reason the JSON carries `subject` at all. The spec measured exactly
    // one ambiguity; if a second appears, a projection that dropped the field
    // could no longer be reconstructed and the schema needs revisiting.
    const bySig: Record<string, Set<string>> = {};
    for (const r of rows) {
      const sig = `${r.type}|${r.category}`;
      (bySig[sig] ??= new Set()).add(r.subject as string);
    }
    const ambiguous = Object.entries(bySig)
      .filter(([, s]) => s.size > 1)
      .map(([sig, s]) => `${sig} -> ${[...s].sort().join(',')}`);
    expect(ambiguous).toEqual(['character|character -> character,fox_outfit']);
  });
});

describe('the id lock — the only risk that reaches a real player', () => {
  const rows = gen.loadRows();

  test('every locked id is still present in the authored source', () => {
    // firestore.rules:481 makes a player's inventory document id the seed id,
    // and adminGrant/demoAccount refuse an id absent from the catalogue. A
    // generator makes a bulk id edit cheap; this is what makes it expensive
    // again. New ids append freely — only a DISAPPEARANCE is a failure.
    const lockPath = path.join(REPO, 'functions', 'seed', 'seed-ids.lock');
    const locked = fs.readFileSync(lockPath, 'utf8').split('\n').filter(Boolean);
    expect(locked.length).toBeGreaterThanOrEqual(52); // anti-vacuity on the lock itself

    const present = new Set(rows.map((r) => r.id));
    const orphaned = locked.filter((id) => !present.has(id)).sort();
    expect(
      `locked ids missing from the seed (would orphan player inventory): ${JSON.stringify(orphaned)}`,
    ).toBe('locked ids missing from the seed (would orphan player inventory): []');
  });

  test('the lock is sorted and free of duplicates, so a diff on it is readable', () => {
    const lockPath = path.join(REPO, 'functions', 'seed', 'seed-ids.lock');
    const locked = fs.readFileSync(lockPath, 'utf8').split('\n').filter(Boolean);
    expect(locked).toEqual([...new Set(locked)].sort());
  });
});

/**
 * §4 · The Dart projection is proven HERE and wired by W1-149.
 *
 * 🔑 This is what makes the two-window split work. `lib/` is W1's lane and its
 * gate is `make test`, so this brief may READ that file — dailyRotation.test.ts
 * already does — but not write it. Proving the projection now means the
 * whitespace-only commit lands in W1's half with the result already established
 * instead of W1 discovering it mid-brief.
 *
 * ⚠️ THIS COMPARISON IS `diff -w`, NOT BYTE-EXACT, AND THE DIFFERENCE MATTERS.
 * The committed file aligns its columns PER BLOCK; a generator aligns globally.
 * So the values agree exactly and the whitespace does not. W1-149 flips this to
 * byte-exact in the same commit that wires the generated file — at which point
 * the generator is byte-exact by construction forever.
 */
describe('the Dart projection is exact, modulo whitespace', () => {
  const rows = gen.loadRows();
  const emitted = gen.emitDart(rows);
  const source = fs.readFileSync(path.join(REPO, DART_MIRROR), 'utf8');

  /**
   * Strip Dart line comments, collapse whitespace runs, then drop the space a
   * column-aligner leaves BEFORE `:` and `,`.
   *
   * ⚠️ That last step is load-bearing and it is why this is `diff -w` rather
   * than a byte compare: the committed file pads per block and the emitter pads
   * globally, so padding lands in different places on the KEY side —
   * `'id' : 'v'` against `'id': 'v'`. Collapsing runs alone leaves that single
   * space and reports a whitespace difference as a VALUE difference, which is
   * the false alarm this comparison exists to avoid.
   *
   * The assumption, stated because it is one: no seed value contains a space
   * immediately before a colon or comma. English prose does not, and the
   * descriptions are English prose.
   */
  const normalise = (s: string): string =>
    s
      .replace(/\/\/[^\n]*/g, '')
      .replace(/\s+/g, ' ')
      .replace(/ +([:,])/g, '$1')
      .trim();

  const committedBlock = (anchor: string, terminator: string): string => {
    const start = source.indexOf(anchor);
    expect(`"${anchor}" found in ${DART_MIRROR}: ${start >= 0}`).toBe(
      `"${anchor}" found in ${DART_MIRROR}: true`,
    );
    const end = source.indexOf(terminator, start);
    expect(`terminator found after "${anchor}": ${end > start}`).toBe(
      `terminator found after "${anchor}": true`,
    );
    return source.slice(start + anchor.length, end);
  };

  // 🔴 kSkinDescriptions is NOT in this list, and that is a measured finding
  // rather than an omission — see the describe block below.
  const CASES: Array<[string, string, string]> = [
    ['kCollectionSeed', 'const List<SeedItem> kCollectionSeed = [', '\n];'],
    ['kItemFamily', 'const Map<String, String> kItemFamily = {', '\n};'],
    ['kFamilyNeutral', 'const List<String> kFamilyNeutral = [', '\n];'],
  ];

  for (const [table, anchor, terminator] of CASES) {
    test(`${table} matches the committed table modulo whitespace`, () => {
      const committed = normalise(committedBlock(anchor, terminator));
      const generated = normalise(emitted[table]);
      // Anti-vacuity: two empty strings are equal and prove nothing.
      expect(`${table} committed length > 200: ${committed.length > 200}`).toBe(
        `${table} committed length > 200: true`,
      );
      expect(generated).toBe(committed);
    });
  }
});

/**
 * 🔴 kSkinDescriptions IS EXACT IN CONTENT AND DIFFERS IN ORDER BY EXACTLY ONE ROW.
 *
 * The other three tables match modulo whitespace. This one does not, and the
 * cause is not formatting: the committed map hoists `char_pyjama` to the top,
 * where seed order puts it at index 15. Everything else is in seed order —
 * proven below by removing that single key from both sides and comparing.
 *
 * 🔑 WHY THIS IS RECORDED RATHER THAN "FIXED" BY MATCHING THE COMMITTED ORDER.
 * A Dart `const Map` is order-independent for lookup, so emitting in seed order
 * is semantically identical and keeps ONE ordering rule across all four tables
 * instead of a special case that exists only because a row was once appended in
 * a hurry. Teaching the generator to reproduce the anomaly would preserve it
 * forever in a file nobody hand-edits again.
 *
 * ⚠️ THE CONSEQUENCE FOR W1-149, WHICH IS WHY IT IS SPELLED OUT HERE: that
 * brief's Dart diff is whitespace-only for three tables and whitespace-plus-one-
 * moved-row for this one. It is still not a data migration — no value changes,
 * and the assertion below is what proves that — but "whitespace-only" would be
 * the wrong sentence to put in its PR description.
 */
describe('kSkinDescriptions — exact in content, one row out of order', () => {
  const rows = gen.loadRows();
  const source = fs.readFileSync(path.join(REPO, DART_MIRROR), 'utf8');
  const ANCHOR = 'const Map<String, String> kSkinDescriptions = {';

  const committedPairs = (): Array<[string, string]> => {
    const start = source.indexOf(ANCHOR);
    expect(`"${ANCHOR}" found: ${start >= 0}`).toBe(`"${ANCHOR}" found: true`);
    const end = source.indexOf('\n};', start);
    const slice = source.slice(start + ANCHOR.length, end).replace(/\/\/[^\n]*/g, '');
    const out: Array<[string, string]> = [];
    const re = /'([A-Za-z0-9_]+)'\s*:\s*'((?:[^'\\]|\\.)*)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(slice)) !== null) out.push([m[1], m[2].replace(/\\'/g, "'")]);
    return out;
  };

  test('every description agrees, key for key', () => {
    const committed = committedPairs();
    expect(committed.length).toBeGreaterThanOrEqual(52); // anti-vacuity on the parse
    const committedMap = Object.fromEntries(committed);
    const disagree = rows
      .filter((r) => committedMap[r.id as string] !== r.description)
      .map((r) => `${r.id}`)
      .sort();
    expect(`descriptions that disagree: ${JSON.stringify(disagree)}`).toBe(
      'descriptions that disagree: []',
    );
    // Both directions — a key present only in Dart would otherwise pass.
    const ids = new Set(rows.map((r) => r.id));
    const extra = committed.map(([k]) => k).filter((k) => !ids.has(k));
    expect(`keys in Dart but not in the seed: ${JSON.stringify(extra)}`).toBe(
      'keys in Dart but not in the seed: []',
    );
  });

  test('the ordering difference is exactly char_pyjama, and nothing else', () => {
    // Pinned so the anomaly cannot quietly grow. If a second row is ever
    // hoisted, this fails and the next window learns it from a test rather
    // than from a confusing diff.
    const committedKeys = committedPairs().map(([k]) => k);
    const seedKeys = rows.map((r) => r.id as string);

    expect(committedKeys.indexOf('char_pyjama')).toBe(0);
    expect(seedKeys.indexOf('char_pyjama')).toBeGreaterThan(0);

    const strip = (a: string[]) => a.filter((k) => k !== 'char_pyjama');
    expect(strip(committedKeys)).toEqual(strip(seedKeys));
  });
});

/**
 * 🔴 THE PROSE IS PART OF THE PROJECTION, NOT DECORATION.
 *
 * The schema went 9 → 11 fields because generating these tables from a data-only
 * source would have destroyed 71 comment lines / ~775 words of institutional
 * reasoning in itemPool.ts — the style_roof_tile_gold pricing bug, furn_cozy_sofa's
 * "measured dusty rose, not cream", the day-one-set provenance.
 *
 * 📌 THE MIGRATION ITSELF WAS PROVEN LOSSLESS, and the evidence is quoted rather
 * than re-run because its subject no longer exists: at the swap commit the
 * committed SEED_ITEMS block held 64 comment lines and the generated one held 64,
 * with the row values byte-identical modulo column alignment. itemPool.ts now
 * re-exports, so there is no second copy left to compare against — which is the
 * point of the change.
 *
 * ✅ WHAT REMAINS CHECKABLE FOREVER is the direction that still has two sides:
 * every note in the authored JSON must appear in the generated output. A
 * generator that silently stopped emitting prose would pass every other test in
 * this repo.
 */
describe('the projection carries the authored prose', () => {
  const rows = gen.loadRows();
  const generated = fs.readFileSync(
    path.join(REPO, 'functions/src/itemPool.generated.ts'),
    'utf8',
  );

  test('every authored note reaches the generated file', () => {
    const withNotes = rows.filter((r) => r.note);
    // Anti-vacuity: if no row carried a note, the loop below would assert
    // nothing and a generator that dropped all prose would pass green.
    expect(`rows carrying a note: ${withNotes.length > 0}`).toBe(
      'rows carrying a note: true',
    );

    const missing: string[] = [];
    for (const r of withNotes) {
      for (const line of (r.note as string).split('\n')) {
        if (line.trim() && !generated.includes(line.trim())) {
          missing.push(`${r.id}: ${line.trim().slice(0, 60)}`);
        }
      }
    }
    expect(`note lines absent from the generated file: ${JSON.stringify(missing)}`).toBe(
      'note lines absent from the generated file: []',
    );
  });

  test('every authored section banner reaches the generated file', () => {
    const withSections = rows.filter((r) => r.section);
    expect(`rows carrying a section: ${withSections.length > 0}`).toBe(
      'rows carrying a section: true',
    );
    const missing = withSections
      .filter((r) => !generated.includes(r.section as string))
      .map((r) => `${r.id}: ${r.section}`);
    expect(`section banners absent: ${JSON.stringify(missing)}`).toBe(
      'section banners absent: []',
    );
  });
});
