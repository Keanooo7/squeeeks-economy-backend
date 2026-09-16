import * as fs from 'fs';
import * as path from 'path';

/**
 * W2-134 · The `items` collection stays retired.
 *
 * 🔴 WHY A SOURCE ASSERTION, WHICH IS NORMALLY THE WEAK KIND. Two of the three
 * retired read sites have runtime guards that fail loudly if a read comes back
 * (purchaseChest.test.ts and claimWelcomeChest.test.ts both assert
 * `_db.collection` was never called). The THIRD — `drawGibbyChestItem` — has no
 * reachable runtime gate: it is not exported, and it only runs when
 * `rollGibbyGift(Math.random, …)` happens to roll a chest. Forcing that roll
 * means stubbing `Math.random` globally, which is recorded in purchaseChest.test.ts
 * as sending jest's own source-map quicksort into unbounded recursion and killing
 * the whole suite before a test runs.
 *
 * So this is deliberately the shape that CAN cover it: absence of a code pattern
 * is the one question a source assertion answers well, and it is the same
 * technique dailyRotation.test.ts already uses to read collection_seed.dart.
 *
 * ⚠️ ITS LIMIT, STATED. This proves the literal string is gone. It does NOT prove
 * no read reaches the collection by a computed name — `db.collection(NAME)` with
 * `const NAME = 'items'` passes this and is a live read. The runtime guards are
 * what cover that for the two reachable sites; for the Gibby site nothing does,
 * and that is a known gap rather than an oversight.
 *
 * THE MEASUREMENT THIS RESTS ON, so a later reader can re-check the premise
 * rather than trust the comment: on 2026-08-20 the production `items` collection
 * held ZERO documents. A COUNT aggregation returned http 200 with
 * `integerValue: 0`, and an independent document list returned http 200 with 0
 * documents and no further pages, both authenticated as the account that owns
 * <project-id>. The reads were retired on that, not on the absence of a writer.
 */
describe('the `items` collection mirror stays retired — W2-134', () => {
  const INDEX = path.join(__dirname, '..', 'index.ts');
  const source = fs.readFileSync(INDEX, 'utf8');

  test('the parse itself found the file it meant to read', () => {
    // Anti-vacuity: an empty or wrong file would make every assertion below
    // pass by reading nothing. Same guard dailyRotation.test.ts puts in front
    // of its own cross-file parse.
    expect(source.length).toBeGreaterThan(10_000);
    expect(source).toContain('SEED_ITEMS');
    expect(source).toContain('drawGibbyChestItem');
  });

  test('index.ts contains no read of the `items` collection', () => {
    const hits = source
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => /\.collection\(\s*['"`]items['"`]\s*\)/.test(line))
      .map(([n, line]) => `${n}: ${line.trim()}`);

    expect(`items reads in index.ts: ${JSON.stringify(hits)}`).toBe(
      'items reads in index.ts: []',
    );
  });
});
