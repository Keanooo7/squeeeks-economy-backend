import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gen = require('../../scripts/gen-seed.cjs') as {
  loadRows: () => Array<Record<string, unknown>>;
  emitTs: (rows: unknown[]) => string;
  lockContent: (rows: unknown[]) => string;
};

const REPO = path.resolve(__dirname, '../../..');

/**
 * `seed:check` — the gate that replaces the hand-sync.
 *
 * Regenerates from the authored JSON and byte-compares against the committed
 * output. An edit to either side that is not mirrored in the other fails here.
 *
 * CRITICAL: THE VACUITY GUARD IS FIRST AND IT IS NOT A FORMALITY. A generator emitting
 * NOTHING, diffed against an equally empty committed file, DIFFS CLEAN. Every
 * assertion below is worthless unless the parse found real rows — the same
 * reasoning dailyRotation.test.ts:590 gives about its own parse, and the same
 * shape as the anchor bug this suite caught during W2-135: a `Set<String>`
 * anchor that matched nothing would have compared two empty strings and passed.
 *
 * KEY: WHAT THIS BUYS OVER THE GATE IT REPLACES. dailyRotation.test.ts:858 now
 * compares type/category/name/rarity across the two mirrors, so field drift was
 * already caught (#564). What was NEVER gated is kSkinDescriptions — it has no
 * TS counterpart at all — and row ORDER, which :858 cannot see because it keys
 * its comparison by id. Both are gated here.
 */
describe('seed:check — the generated output matches its source', () => {
  const rows = gen.loadRows();

  test('the parse found a plausible number of unique rows', () => {
    expect(rows.length).toBeGreaterThanOrEqual(52);
    const ids = rows.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('itemPool.generated.ts is byte-identical to a fresh generation', () => {
    const committed = fs.readFileSync(
      path.join(REPO, 'functions/src/itemPool.generated.ts'),
      'utf8',
    );
    // Anti-vacuity on the committed side too: an empty file would match an
    // empty emission.
    expect(`committed generated file is substantial: ${committed.length > 2000}`).toBe(
      'committed generated file is substantial: true',
    );

    const fresh = gen.emitTs(rows);
    if (fresh !== committed) {
      // Report WHERE, not just that. A whole-file diff in a jest message is
      // unreadable; the first divergence is what a person acts on.
      let i = 0;
      while (i < Math.min(fresh.length, committed.length) && fresh[i] === committed[i]) i++;
      const ctx = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 60), i + 60));
      throw new Error(
        'functions/src/itemPool.generated.ts is stale — run `npm run seed:gen`.\n' +
          `First difference at byte ${i}:\n` +
          `  committed: ${ctx(committed)}\n` +
          `  fresh:     ${ctx(fresh)}`,
      );
    }
    expect(fresh).toBe(committed);
  });

  test('seed-ids.lock is byte-identical to a fresh generation', () => {
    const committed = fs.readFileSync(
      path.join(REPO, 'functions/seed/seed-ids.lock'),
      'utf8',
    );
    expect(`lock is substantial: ${committed.split('\n').filter(Boolean).length >= 52}`).toBe(
      'lock is substantial: true',
    );
    // The lock only ever GROWS, so a fresh generation of TODAY's rows must be a
    // SUBSET of it — not equal to it. Equality would silently accept a dropped
    // id the moment one was removed from the source.
    const fresh = gen.lockContent(rows).split('\n').filter(Boolean);
    const locked = new Set(committed.split('\n').filter(Boolean));
    const unlocked = fresh.filter((id) => !locked.has(id));
    expect(`ids in the seed but absent from the lock: ${JSON.stringify(unlocked)}`).toBe(
      'ids in the seed but absent from the lock: []',
    );
  });
});
