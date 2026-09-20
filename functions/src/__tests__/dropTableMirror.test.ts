import * as fs from 'fs';
import * as path from 'path';

import {DROP_TABLES, DROP_TABLE_TIERS} from '../itemPool';

// ---------------------------------------------------------------------------
// The drop tables are written TWICE, in two languages, and until this file
// nothing compared them.
// ---------------------------------------------------------------------------
//
//   functions/src/itemPool.ts:63-66              DROP_TABLES        <- the server ROLLS this
//   lib/features/shop/domain/chest_drop_rates.dart:24-28  kDropTables  <- the client DISPLAYS this
//
// CRITICAL: THE DIVERGENCE IS SILENT AND IT IS NOT COSMETIC. `rollRarity`
// (itemPool.ts:101) decides what the player actually gets; `chestOddsText`
// (chest_drop_rates.dart:88) tells them what to expect. If the two tables drift,
// the app advertises odds the server does not roll — and every existing test
// passes, because no test on either side opens the other file.
//
// NOTE: MEASURED BEFORE THIS FILE EXISTED: `grep -rl "chest_drop_rates.dart'"
// functions/src` returns ZERO. Eight files under functions/ mention the Dart
// mirror BY NAME as a known hazard — itemPool.ts:85, family.ts:223,
// housemateToken.ts:124, index.ts:3749, defaultHouses.test.ts:18 and three more
// — and not one of them reads it. Knowing a hazard by name is not a gate.
//
// KEY: WHY NOW. Candidate E is authorised (lean 75/14/11 · mid 45/33/22 · rich
// 15/52/33) and moves all six numbers. `chest_drop_rates.dart`'s own header says
// its percentages are DERIVED rather than typed, so it "can only drift if the
// thresholds themselves drift" — which is exactly what the next brief does. The
// guard lands FIRST and alone, deliberately: a guard shipped in the same commit
// as the change it guards has never been observed protecting the old state.
//
// WARNING: This is `CHEST_PRICE`'s argument one level up. itemPool.ts:110-117 already
// refuses to keep a second hand-maintained copy of the same economy, "because
// two hand-maintained copies of the same economy drift, and the drift stays
// invisible until someone changes a price". We are about to change a price.
//
// Shape borrowed from test/features/subscription/product_availability_test.dart
// — a Dart test that reads ios/Configuration.storekit, i.e. this same job in the
// opposite direction. Its discipline is copied on purpose: prove the file is
// there, prove the parse found something, and only then compare.
// ---------------------------------------------------------------------------

const REPO = path.resolve(__dirname, '../../..');
const MIRROR = path.join(REPO, 'lib/features/shop/domain/chest_drop_rates.dart');

/** Every tier the Dart file declares, and the two thresholds it gives each. */
type ParsedTables = Record<string, number[]>;

/**
 * `kDropTables`, read out of the Dart source.
 *
 * CRITICAL: THE BLOCK IS ISOLATED BEFORE THE ENTRIES ARE MATCHED, and that is not
 * tidiness. `chest_drop_rates.dart` contains other `(double, double)` records —
 * `dropThresholdsFor`'s return type and the destructuring in `dropChancesFor` —
 * so an entry regex run over the whole file would match text that is not the
 * table. Anchoring on the declaration means the parser can only ever read the
 * thing it claims to read.
 */
function parseDropTables(source: string): ParsedTables {
  const block =
    /const\s+Map<String,\s*\(double,\s*double\)>\s+kDropTables\s*=\s*\{([\s\S]*?)\};/.exec(source);
  if (!block) {
    throw new Error(
      'kDropTables not found in the Dart mirror. Either the declaration was ' +
        'renamed or its shape changed — this parser refuses to guess rather ' +
        'than silently comparing an empty table to a full one.',
    );
  }

  const entries: ParsedTables = {};
  const entry = /'([a-z_]+)'\s*:\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\)/g;
  let match: RegExpExecArray | null;
  while ((match = entry.exec(block[1])) !== null) {
    entries[match[1]] = [Number(match[2]), Number(match[3])];
  }
  return entries;
}

/**
 * Refuse a parse that found too little to be a comparison.
 *
 * CRITICAL: THIS IS THE LOAD-BEARING HALF AND IT IS SEPARATE ON PURPOSE. A parser that
 * silently extracts nothing passes every equality test it is given: the loop
 * below runs zero times and the suite goes green while comparing nothing to
 * nothing. Same failure `seedCheck.test.ts` guards against ("a generator
 * emitting NOTHING, diffed against an equally empty committed file, DIFFS
 * CLEAN") and the same one W2-135's empty-anchor bug produced.
 */
function assertParseIsSubstantive(tables: ParsedTables): void {
  const tiers = Object.keys(tables);
  if (tiers.length !== 3) {
    throw new Error(
      `expected 3 tiers in kDropTables, parsed ${tiers.length} (${tiers.join(', ') || 'none'})`,
    );
  }
  const numbers = tiers.flatMap((t) => tables[t]);
  if (numbers.length !== 6 || !numbers.every((n) => Number.isFinite(n))) {
    throw new Error(
      `expected 6 finite thresholds in kDropTables, parsed ${numbers.length} (${numbers.join(', ')})`,
    );
  }
}

describe('the Dart drop-table mirror agrees with DROP_TABLES', () => {
  test('the mirror file is on disk where the server expects it', () => {
    expect(fs.existsSync(MIRROR)).toBe(true);
  });

  const source = fs.readFileSync(MIRROR, 'utf8');
  const parsed = parseDropTables(source);

  // WARNING: CONTROL, NOT CEREMONY. Everything below is a per-tier comparison; if the
  // parse returned nothing, all of it would pass vacuously.
  test('the parse found three tiers and six finite thresholds', () => {
    expect(() => assertParseIsSubstantive(parsed)).not.toThrow();
    expect(Object.keys(parsed).sort()).toEqual([...DROP_TABLE_TIERS].sort());
  });

  // WARNING: CONTROL OVER THE DETECTOR ITSELF. `assertParseIsSubstantive` returning
  // quietly on a short parse would make the control above worthless, and
  // `parseDropTables` matching anything at all would make the anchor pointless.
  // Both answers are pinned, against sources crafted here rather than by
  // touching the real file.
  //
  // CRITICAL: EVERY DOCTORED SOURCE IS ASSERTED TO DIFFER FROM THE ORIGINAL FIRST, AND
  // THAT LINE WAS BOUGHT WITH A FAILURE. W2-170 moved all six thresholds and
  // this test went red — not on a tier comparison, which passed, but here: the
  // `oneThreshold` fixture doctored the source by substituting the LITERAL
  // string `'lean': (0.80, 0.98)`, so it was a FOURTH hand-written copy of the
  // very numbers this file exists to stop being copied, hidden inside the guard
  // against copying them. `String.replace` on a pattern that matches nothing
  // returns the input unchanged and doctors NOTHING, so the shape of that bug is
  // a control that silently stops controlling. The fixtures are now derived from
  // the file's structure, never its values, and each proves it actually changed
  // something before asserting what that change does.
  test('a short parse and a missing declaration both refuse', () => {
    const twoTiers = source.replace(/^\s*'rich':.*$/m, '');
    expect(twoTiers).not.toEqual(source);
    expect(Object.keys(parseDropTables(twoTiers))).toHaveLength(2);
    expect(() => assertParseIsSubstantive(parseDropTables(twoTiers))).toThrow(
      /expected 3 tiers/,
    );

    // The lean row with its second threshold removed — matched structurally, so
    // it survives any future re-centring of the tables.
    const oneThreshold = source.replace(
      /('lean':\s*)\(\s*([0-9.]+)\s*,\s*[0-9.]+\s*\)/,
      '$1($2)',
    );
    expect(oneThreshold).not.toEqual(source);
    expect(() => assertParseIsSubstantive(parseDropTables(oneThreshold))).toThrow(
      /expected 3 tiers/,
    );

    // CRITICAL: THE DECLARATION, NOT THE FIRST OCCURRENCE OF THE WORD. This was
    // `source.replace('kDropTables', …)`, and a string pattern replaces only the
    // FIRST match — which W2-170 turned into the file's header comment the
    // moment that comment started naming `kDropTables`. The declaration survived
    // untouched, the parse succeeded, and the control failed. Note that
    // `not.toEqual(source)` passed throughout: the doctoring DID change the
    // file, just not the thing under test. A fixture must prove it moved the
    // construct it names, not merely that it moved something.
    const renamed = source.replace(
      /(const\s+Map<String,\s*\(double,\s*double\)>\s+)kDropTables/,
      '$1kSomethingElse',
    );
    expect(renamed).not.toEqual(source);
    expect(renamed).not.toMatch(/>\s+kDropTables\s*=/);
    expect(() => parseDropTables(renamed)).toThrow(/kDropTables not found/);
  });

  // KEY: THE ASSERTION THE BRIEF EXISTS FOR. Keyed by tier so a failure names the
  // tier and prints both thresholds, rather than reporting that two anonymous
  // arrays differ.
  test.each([...DROP_TABLE_TIERS])('%s has the same thresholds on both sides', (tier) => {
    expect({tier, thresholds: parsed[tier]}).toEqual({
      tier,
      thresholds: [...DROP_TABLES[tier]],
    });
  });
});
