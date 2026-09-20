#!/usr/bin/env node
/**
 * W2-135 · Generate both projections of the collection seed from ONE authored source.
 *
 * `functions/seed/collection_seed.json` is the single source of truth. This script
 * projects it into:
 *
 *   • functions/src/itemPool.generated.ts   — SEED_ITEMS, ITEM_FAMILY, FAMILY_NEUTRAL
 *   • the Dart tables of collection_seed.dart — kCollectionSeed, kItemFamily,
 *     kFamilyNeutral, kSkinDescriptions
 *
 * CRITICAL: THE DART HALF IS EMITTED BUT NOT WRITTEN INTO `lib/`. That is W1-149's commit,
 * and `lib/` is a different window's lane with a different gate. What this script
 * buys now is the PROOF: seedGenerator.test.ts asserts the emitted Dart matches the
 * committed tables modulo whitespace, so the wiring commit lands with the projection
 * already established rather than discovering it.
 *
 * KEY: WHY A PLAIN NODE SCRIPT AND NOT build_runner. build_runner cannot emit
 * TypeScript, so it could only ever be HALF the mechanism, with a second generator
 * for the TS side — two generators over one source, which is a second way for the
 * halves to drift. That is the disease this exists to cure. It is also why nothing
 * sweeps this output: no `git checkout -- $(git ls-files -d)` ritual applies.
 *
 * Not a runtime loader either: kCollectionSeed is a `const List` read synchronously
 * by four lib/ call sites and kSeedRarities derives at class-init. rootBundle is
 * async. Nothing reads this JSON at run time — only this script, at author time.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const JSON_PATH = path.join(ROOT, 'functions', 'seed', 'collection_seed.json');
const LOCK_PATH = path.join(ROOT, 'functions', 'seed', 'seed-ids.lock');
const TS_OUT = path.join(ROOT, 'functions', 'src', 'itemPool.generated.ts');

const BANNER = (src) => `// GENERATED FILE — DO NOT EDIT BY HAND.
//
// Source:    ${src}
// Generator: functions/scripts/gen-seed.cjs
// Regenerate: npm --prefix functions run seed:gen
//
// Edits here are destroyed on the next run, and \`npm run seed:check\` fails the
// suite when this file disagrees with the source — which is the point: the two
// language projections cannot drift because neither is authored.
`;

/** Read and validate the authored source. Throws rather than emitting nonsense. */
function loadRows() {
  const raw = fs.readFileSync(JSON_PATH, 'utf8');
  const rows = JSON.parse(raw);
  if (!Array.isArray(rows)) throw new Error('collection_seed.json is not an array');
  return rows;
}

/**
 * Render a row's `section` banner and `note` as comment lines.
 *
 * KEY: THIS IS WHY THE SCHEMA HAS 11 FIELDS AND NOT 9. Generating these tables
 * from a 9-field source would have destroyed 71 comment lines / ~775 words of
 * institutional reasoning in itemPool.ts — the style_roof_tile_gold pricing bug,
 * the "measured dusty rose, not cream" correction, the day-one-set provenance.
 *
 * WARNING: A note lives in the AUTHORED SOURCE, never merged back from this file's own
 * previous output. That distinction is the whole design: merging prose back would
 * mean parsing our own emission, and then `seed:check`'s byte-diff would no longer
 * prove the output is a pure function of the input. Authoring keeps the gate intact.
 */
function proseLines(row, indent, banner) {
  const out = [];
  if (row.section) {
    const bar = '-'.repeat(Math.max(3, banner - row.section.length - 5));
    out.push(`${indent}// --- ${row.section} ${bar}`);
  }
  if (row.note) {
    for (const line of row.note.split('\n')) {
      out.push(line.length ? `${indent}// ${line}` : `${indent}//`);
    }
  }
  return out;
}

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Pad to the widest value in the column, so a column stays readable as it grows. */
function widths(rows, keys) {
  const w = {};
  for (const k of keys) w[k] = Math.max(...rows.map((r) => q(r[k]).length));
  return w;
}

// --------------------------------------------------------------------------
// TypeScript emitter
// --------------------------------------------------------------------------
function emitTs(rows) {
  const w = widths(rows, ['id', 'type', 'category', 'subject', 'name']);
  const items = rows
    .map((r) => {
      const prose = proseLines(r, '  ', 74);
      const cells = [
        `id: ${q(r.id)},`.padEnd(w.id + 5),
        `type: ${q(r.type)},`.padEnd(w.type + 7),
        `category: ${q(r.category)},`.padEnd(w.category + 11),
        `subject: ${q(r.subject)},`.padEnd(w.subject + 10),
        `name: ${q(r.name)},`.padEnd(w.name + 7),
        `rarity: ${q(r.rarity)},`,
        `artUrl: ${q(r.artUrl)}`,
      ].join(' ');
      return [...prose, `  { ${cells} },`].join('\n');
    })
    .join('\n');

  const assigned = rows.filter((r) => r.family !== null);
  const famW = Math.max(...assigned.map((r) => (r.id + ':').length));
  const family = assigned
    .map((r) => `  ${(r.id + ':').padEnd(famW)} ${q(r.family)},`)
    .join('\n');

  const neutral = rows
    .filter((r) => r.family === null)
    .map((r) => `  ${q(r.id)},`)
    .join('\n');

  return `${BANNER('functions/seed/collection_seed.json')}
import type { SeedItem } from './itemPool';

export const SEED_ITEMS_GENERATED: SeedItem[] = [
${items}
];

export const ITEM_FAMILY_GENERATED: Record<string, string> = {
${family}
};

export const FAMILY_NEUTRAL_GENERATED: string[] = [
${neutral}
];
`;
}

// --------------------------------------------------------------------------
// Dart emitter — emitted and proven here, wired by W1-149
// --------------------------------------------------------------------------
function emitDartRows(rows) {
  const w = widths(rows, ['id', 'type', 'category', 'name']);
  return rows
    .map((r) => {
      const cells = [
        `id: ${q(r.id)},`.padEnd(w.id + 5),
        `type: ${q(r.type)},`.padEnd(w.type + 7),
        `category: ${q(r.category)},`.padEnd(w.category + 11),
        `name: ${q(r.name)},`.padEnd(w.name + 7),
        `rarity: ${q(r.rarity)}`,
      ].join(' ');
      return [...proseLines(r, '  ', 72), `  SeedItem(${cells}),`].join('\n');
    })
    .join('\n');
}

function emitDartFamily(rows) {
  const assigned = rows.filter((r) => r.family !== null);
  // CRITICAL: THE COLON IS PART OF THE PADDED TOKEN, NOT SEPARATE FROM IT (W2-159).
  //
  // This used to read `q(r.id).padEnd(w) + ': '`, which pads BEFORE the colon
  // and emits `'furn_sofa_sage'      : 'meadow',`. The committed Dart writes
  // `'furn_sofa_sage': 'meadow',` — colon tight against the key — and TWO
  // GATES IN THIS REPO DISAGREED ABOUT WHETHER THAT MATTERS:
  //
  //   · seedGenerator.test.ts normalises the space before `:` away on purpose
  //     (its `normalise` comment says so), so it accepted either form.
  //   · dailyRotation.test.ts parses kItemFamily with a regex that requires
  //     `'key':`, and read the padded form as SIX entries out of 160.
  //
  // WARNING: AND THE FAILURE LIED ABOUT ITS CAUSE. The unparsed rows surfaced as
  // "add these to collection_seed.dart kItemFamily: [154 ids]" — a list of
  // items that were all present, none missing, and simply unreadable to that
  // parser. Anyone pasting the emission verbatim would have gone looking for
  // 154 absent rows that were sitting in front of them.
  //
  // NOTE: The TypeScript half of this same generator already padded correctly —
  // `(r.id + ':').padEnd(famW)` at emitTs — so the two projections of one
  // source formatted their identical table two different ways. Matched here.
  const w = Math.max(...assigned.map((r) => q(r.id).length + 1));
  return assigned
    .map((r) => `  ${(q(r.id) + ':').padEnd(w)} ${q(r.family)},`)
    .join('\n');
}

function emitDartNeutral(rows) {
  return rows
    .filter((r) => r.family === null)
    .map((r) => `  ${q(r.id)},`)
    .join('\n');
}

function emitDartDescriptions(rows) {
  const w = Math.max(...rows.map((r) => q(r.id).length));
  return rows
    .map((r) => `  ${q(r.id).padEnd(w)}: ${q(r.description)},`)
    .join('\n');
}

/** The four Dart tables, keyed by the declaration each belongs to. */
function emitDart(rows) {
  return {
    kCollectionSeed: emitDartRows(rows),
    kItemFamily: emitDartFamily(rows),
    kFamilyNeutral: emitDartNeutral(rows),
    kSkinDescriptions: emitDartDescriptions(rows),
  };
}

function lockContent(rows) {
  return [...new Set(rows.map((r) => r.id))].sort().join('\n') + '\n';
}

module.exports = { loadRows, emitTs, emitDart, lockContent, JSON_PATH, LOCK_PATH, TS_OUT };

// --------------------------------------------------------------------------
// CLI — guarded so importing the emitters never writes a file.
// --------------------------------------------------------------------------
if (require.main === module) {
  const rows = loadRows();
  fs.writeFileSync(TS_OUT, emitTs(rows));

  // The lock only ever GROWS. A generator makes a bulk id edit cheap, and
  // firestore.rules:481 makes a player's inventory document id the seed id —
  // so a dropped id orphans a document a real player owns. New ids append.
  const existing = fs.existsSync(LOCK_PATH)
    ? fs.readFileSync(LOCK_PATH, 'utf8').split('\n').filter(Boolean)
    : [];
  const merged = [...new Set([...existing, ...rows.map((r) => r.id)])].sort();
  fs.writeFileSync(LOCK_PATH, merged.join('\n') + '\n');

  console.log(`gen-seed: ${rows.length} rows -> itemPool.generated.ts`);
  console.log(`gen-seed: lock holds ${merged.length} ids`);
}
