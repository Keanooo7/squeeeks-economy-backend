import * as fs from 'fs';
import * as path from 'path';
import { stripComments } from './stripComments';

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const INDEX_TS = path.join(REPO, 'functions', 'src', 'index.ts');

/**
 * W2-142 · The control for the shared comment stripper.
 *
 * 🔑 WHICH MUTATION TURNS ONLY THIS FILE RED. Restoring the old two-regex
 * stripper. The fixtures below are synthetic and carry the hostile sequences on
 * purpose, so they fail on that mutation no matter what `index.ts` currently
 * contains — whereas the two gates that consume this helper only go red while
 * `index.ts` itself happens to hold such a sequence, which is precisely the
 * accident that made the bug visible and could stop being true tomorrow.
 * That is the property this file buys: it does not depend on prose elsewhere.
 */
describe('stripComments — the sequences that broke two gates', () => {
  test('a slash-asterisk inside a LINE comment does not open a block comment', () => {
    // The exact defect. `users/` + glob star + `/streak/` + glob star appeared
    // in a line comment above the streak query; the old stripper read it as an
    // opening delimiter and deleted everything to the next closing one.
    const star = '*';
    const src = [
      `// prose mentioning users/${star}/streak/${star} in passing`,
      `const kept = db.collectionGroup('streak');`,
      `/${star} a genuine block comment ${star}/`,
      `const alsoKept = 2;`,
    ].join('\n');

    const out = stripComments(src);
    expect({
      keptTheQuery: out.includes("collectionGroup('streak')"),
      keptTheCodeBelow: out.includes('alsoKept'),
      droppedTheRealBlockComment: !out.includes('a genuine block comment'),
      droppedTheLineComment: !out.includes('in passing'),
    }).toEqual({
      keptTheQuery: true,
      keptTheCodeBelow: true,
      droppedTheRealBlockComment: true,
      droppedTheLineComment: true,
    });
  });

  test('a double slash inside a STRING does not start a line comment', () => {
    // The wound the "obvious" fix (line-comments-first) moves rather than heals.
    const src = `const u = 'https://example.com/x'; const after = 3;`;
    const out = stripComments(src);
    expect({
      keptWholeUrl: out.includes("'https://example.com/x'"),
      keptCodeAfter: out.includes('after'),
    }).toEqual({ keptWholeUrl: true, keptCodeAfter: true });
  });

  test('it still removes the comments it exists to remove', () => {
    // Anti-vacuity in the other direction: a stripper that returned its input
    // unchanged would pass both tests above and defeat the whole point, which
    // is that prose NAMING a query must not be parsed as one.
    const src = [
      `// const commented = db.collectionGroup('ghost');`,
      `/* const blocked = db.collectionGroup('phantom'); */`,
      `const real = db.collectionGroup('streak');`,
    ].join('\n');

    const names = [...stripComments(src).matchAll(/collectionGroup\('(\w+)'\)/g)].map(
      (m) => m[1],
    );
    expect(names).toEqual(['streak']);
  });

  test('an escaped quote does not end the string early', () => {
    const src = `const s = 'it\\'s fine'; const after = 4;`;
    expect(stripComments(src).includes('after')).toBe(true);
  });
});

describe('stripComments — the assumption it makes about index.ts', () => {
  test('index.ts survives the scanner with both live queries still visible', () => {
    // 📌 The documented limit of a scanner that is not a lexer: a regex literal
    // containing an unpaired quote would be misread as opening a string, and
    // everything after it would be garbage. `index.ts` has none today. This
    // pins that — if someone adds one, this goes red and names the reason
    // rather than letting the two consuming gates silently parse rubble.
    //
    // ⚠️ IT COUNTS THE QUERIES AND DOES NOT NAME THEM, ON PURPOSE. Asserting
    // `['streak','shop']` here would make this file go red for a collection
    // RENAME — someone else's finding, already covered next door in
    // collectionGroupIndexes.test.ts — and a test that fails for two unrelated
    // reasons cannot tell you which one happened. This one owns exactly one
    // question: did the scanner survive the file?
    const raw = fs.readFileSync(INDEX_TS, 'utf8');
    const out = stripComments(raw);
    const live = [...out.matchAll(/collectionGroup\(\s*'[A-Za-z0-9_]+'\s*\)/g)].length;
    const inProse = [...raw.matchAll(/collectionGroup\(\s*'[A-Za-z0-9_]+'\s*\)/g)].length - live;

    expect(`live: ${live}, stripped as prose: ${inProse > 0}`).toBe(
      'live: 2, stripped as prose: true',
    );
  });
});
