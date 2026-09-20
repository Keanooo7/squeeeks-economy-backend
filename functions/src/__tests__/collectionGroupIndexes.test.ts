import * as fs from 'fs';
import * as path from 'path';
import { stripComments } from './support/stripComments';

const REPO = path.resolve(__dirname, '..', '..', '..');

/**
 * W2-138 · Every filtered collection-group query needs a COLLECTION_GROUP index.
 *
 * CRITICAL: THE DEFECT THIS EXISTS FOR RAN IN PRODUCTION FOR 23 CONSECUTIVE NIGHTS WITH
 * EVERY TEST GREEN. `sendStreakReminder` (index.ts:424) queries
 * `collectionGroup('streaks').where('currentStreak','>',0)`. A single-field index
 * is automatic at COLLECTION scope and NOT at COLLECTION_GROUP scope, so the
 * query needs a `fieldOverrides` entry — and `firestore.indexes.json` had none.
 * Cloud Scheduler reported `Failed` and Cloud Logging carried an HTTP 500 with
 * `9 FAILED_PRECONDITION: The query requires a COLLECTION_GROUP_ASC index for
 * collection streaks and field currentStreak` on EVERY run from 2026-08-01 (its
 * first ever scheduled run) through 2026-08-23. It never once succeeded.
 *
 * KEY: WHY 1474 PASSING TESTS SAID NOTHING, AND WHY THIS GATE IS STATIC.
 * Nothing in this repo executes the query against a real Firestore: the unit
 * suite mocks the Admin SDK, and the emulator does not enforce composite or
 * collection-group index requirements — it answers the query the production
 * backend refuses. So no runtime test CAN catch this class of bug, however many
 * we add. The only checkable relationship is between the SOURCE and the INDEX
 * FILE, and that is what this asserts.
 *
 * WARNING: AN UNFILTERED `collectionGroup(c).get()` NEEDS NO INDEX and must not be
 * flagged — `index.ts:457` does exactly that against 'shop' and succeeds nightly.
 * The parser therefore keys on a `.where(...)` in the same call chain, not on the
 * presence of `collectionGroup` alone.
 */

interface FilteredQuery {
  file: string;
  collection: string;
  field: string;
}

/**
 * Every `collectionGroup('c')` whose call chain carries a `.where('f', …)`.
 *
 * The chain is taken as the text up to the next `;`, which is what separates
 * `collectionGroup('streaks').where('currentStreak','>',0).get();` from a bare
 * `collectionGroup('shop').get();` following it.
 */
function filteredCollectionGroupQueries(file: string): FilteredQuery[] {
  const src = stripComments(fs.readFileSync(path.join(REPO, file), 'utf8'));
  const out: FilteredQuery[] = [];
  const re = /collectionGroup\(\s*'([A-Za-z0-9_]+)'\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const end = src.indexOf(';', m.index);
    const chain = src.slice(m.index, end === -1 ? src.length : end);
    const whereRe = /\.where\(\s*'([A-Za-z0-9_.]+)'/g;
    let w: RegExpExecArray | null;
    while ((w = whereRe.exec(chain)) !== null) {
      out.push({ file, collection: m[1], field: w[1] });
    }
  }
  return out;
}

interface IndexFile {
  indexes?: Array<{
    collectionGroup?: string;
    queryScope?: string;
    fields?: Array<{ fieldPath?: string }>;
  }>;
  fieldOverrides?: Array<{
    collectionGroup?: string;
    fieldPath?: string;
    indexes?: Array<{ queryScope?: string }>;
  }>;
}

function readIndexFile(): IndexFile {
  return JSON.parse(
    fs.readFileSync(path.join(REPO, 'firestore.indexes.json'), 'utf8'),
  ) as IndexFile;
}

/** Is (collection, field) queryable at COLLECTION_GROUP scope? */
function isCoveredAtGroupScope(idx: IndexFile, collection: string, field: string): boolean {
  const overridden = (idx.fieldOverrides ?? []).some(
    o =>
      o.collectionGroup === collection &&
      o.fieldPath === field &&
      (o.indexes ?? []).some(i => i.queryScope === 'COLLECTION_GROUP'),
  );
  if (overridden) return true;
  return (idx.indexes ?? []).some(
    i =>
      i.collectionGroup === collection &&
      i.queryScope === 'COLLECTION_GROUP' &&
      (i.fields ?? []).some(f => f.fieldPath === field),
  );
}

// `notifications.ts` is a dead second copy (index.ts:165 declares it so, and
// `firebase functions:list` confirms only index.ts's exports are deployed). It
// is NOT swept: an index is only owed for a query that actually runs, and
// listing it here would make this gate demand indexes for dead code.
const LIVE_SOURCES = ['functions/src/index.ts'];

describe('every filtered collection-group query has a COLLECTION_GROUP index', () => {
  const queries = LIVE_SOURCES.flatMap(filteredCollectionGroupQueries);

  test('the parse found filtered collection-group queries at all', () => {
    // Anti-vacuity. A parser that matched nothing would make the assertion
    // below iterate an empty list and pass on a repo with no indexes at all —
    // which is exactly the state that shipped the defect.
    expect(
      `filtered collectionGroup queries found: ${queries.length > 0}`,
    ).toBe('filtered collectionGroup queries found: true');
  });

  test('an unfiltered collectionGroup().get() is not treated as needing an index', () => {
    // The discriminator. `index.ts:457` runs collectionGroup('shop').get() with
    // no filter and succeeds in production; if the parser flagged it, this gate
    // would demand an index that Firestore does not want and would be wrong in
    // the expensive direction — a gate that cries wolf gets relaxed.
    expect(queries.map(q => q.collection)).not.toContain('shop');
  });

  test('every filtered collection-group query is covered by firestore.indexes.json', () => {
    const idx = readIndexFile();
    const missing = queries
      .filter(q => !isCoveredAtGroupScope(idx, q.collection, q.field))
      .map(q => `${q.file}: collectionGroup('${q.collection}').where('${q.field}', …)`)
      .sort();
    expect(
      `collection-group queries with no COLLECTION_GROUP index: ${JSON.stringify(missing)}`,
    ).toBe('collection-group queries with no COLLECTION_GROUP index: []');
  });
});

/**
 * W2-142 · A queried collection group must be one something actually WRITES.
 *
 * CRITICAL: THIS FILE ALREADY EXISTED AND DID NOT CATCH THE WORST BUG IT WAS NEAR.
 * `#584` swept every `collectionGroup(c).where(f, …)` and demanded an index for
 * it. `sendStreakReminder` queried `collectionGroup('streaks')` — a collection
 * group that has NEVER EXISTED, since every writer in the codebase uses the
 * singular `streak` — and this suite happily confirmed the plural had an index
 * and went green. It pinned the WRONG NAME and passed.
 *
 * KEY: WHAT IT WOULD HAVE TAKEN, WHICH IS THE POINT OF THIS BLOCK. The original
 * asked "does this query have an index?" The question it could not answer is
 * "does this query have a SUBJECT?" — and no runtime test can answer it either,
 * because a collection-group query against a name nothing has ever written is
 * not an error. It returns an empty result, successfully, forever. The emulator
 * agrees. Firestore agrees. Only the ABSENCE of a matching writer betrays it.
 *
 * So the check is static and structural: every collection group the live source
 * QUERIES must appear as a path segment the live source WRITES. `streak` is
 * written at index.ts:3589/3695/3754 as `users/${uid}/streak/main`; `shop` at
 * `users/${uid}/shop/data`. `streaks` was written nowhere, by anyone, ever —
 * which is exactly the signal this asserts on.
 *
 * WARNING: THE LIMIT, STATED SO IT IS NOT MISTAKEN FOR MORE. This proves a name is
 * SPELLED the same way somewhere else in `functions/src`. It cannot prove the
 * collection has documents, and it would raise a false alarm for a collection
 * written only by the Dart client and never by a function. Neither live query
 * has that shape today; if one ever does, exempt it here WITH ITS REASON rather
 * than deleting the check.
 */
describe('every queried collection group is one the code also writes', () => {
  /** Path segments that appear in any string or template literal in a file. */
  const writtenSegments = (file: string): Set<string> => {
    const src = stripComments(fs.readFileSync(path.join(REPO, file), 'utf8'));
    const out = new Set<string>();
    // Both quoted strings and template literals; `${…}` interpolations are
    // dropped so `users/${uid}/streak/main` yields users, streak, main.
    for (const m of src.matchAll(/['"`]([^'"`]*\/[^'"`]*)['"`]/g)) {
      for (const seg of m[1].split('/')) {
        const clean = seg.replace(/\$\{[^}]*\}/g, '').trim();
        if (/^[A-Za-z][A-Za-z0-9_]*$/.test(clean)) out.add(clean);
      }
    }
    return out;
  };

  const written = new Set<string>();
  for (const f of LIVE_SOURCES) for (const s of writtenSegments(f)) written.add(s);

  const queried = LIVE_SOURCES.flatMap((file) => {
    const src = stripComments(fs.readFileSync(path.join(REPO, file), 'utf8'));
    return [...src.matchAll(/collectionGroup\(\s*'([A-Za-z0-9_]+)'\s*\)/g)].map((m) => ({
      file,
      collection: m[1],
    }));
  });

  test('the parse found both queried names and written path segments', () => {
    // Anti-vacuity on BOTH sides. An empty `queried` passes the assertion below
    // vacuously; an empty `written` fails it for everything, which would be a
    // broken gate rather than a finding.
    expect(
      `queried: ${queried.length > 0}, written segments: ${written.size > 5}`,
    ).toBe('queried: true, written segments: true');
  });

  test('no live query names a collection group nothing writes', () => {
    const orphans = queried
      .filter((q) => !written.has(q.collection))
      .map((q) => `${q.file}: collectionGroup('${q.collection}') — nothing writes this`)
      .sort();
    expect(
      `queried collection groups with no writer: ${JSON.stringify(orphans)}`,
    ).toBe('queried collection groups with no writer: []');
  });
});
