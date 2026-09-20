// functions/src/__tests__/finishFamilyConsistency.test.ts
//
// W2-159. A finish token names exactly one family, across the whole seed.
//
// ---------------------------------------------------------------------------
// CRITICAL: WHY THIS EXISTS: W2-159 ADDED 59 ROWS BY APPLYING A RULE NOTHING ENFORCED
// ---------------------------------------------------------------------------
//
// The fifteen props' families were not chosen. They were DERIVED: every finish
// token already in the seed mapped to exactly one family across all 86 prior
// furniture rows — `caramel`→oakhouse, `charcoal`→quarry, `ivory`→dovecote,
// `sage`→meadow, `two_tone`→oakhouse, `butter`→dovecote, `mint`→meadow,
// `slate`→quarry, `terracotta`→oakhouse — with zero conflicts. The 59 new rows
// follow that mapping.
//
// KEY: UNTIL THIS FILE, THAT RULE EXISTED ONLY AS A SENTENCE IN A COMMENT. A
// derivation stated in prose and enforced by nothing is the shape this repo
// keeps rediscovering: it is true on the day it is written and silently false
// the first time somebody adds a row in a hurry. The next `caramel` row is free
// to say `quarry`, every other gate stays green, and the album grows one item
// whose family contradicts its own colour.
//
// WARNING: THIS IS NOT A RESTATEMENT OF `productRegistry`-STYLE COVERAGE. Nothing
// else compares two rows to each other: `dailyRotation.test.ts` counts
// ITEM_FAMILY, `seedGenerator.test.ts` compares the projections. Both would
// pass with `furn_bench_caramel` filed under quarry — the count is unchanged
// and both projections would carry the same wrong value.
//
// NOTE: IT READS THE GENERATED ARTIFACTS, NOT THE AUTHORED JSON, on purpose: the
// thing that ships is `SEED_ITEMS` + `ITEM_FAMILY`, and a rule proven only
// against the source would not notice a generator that dropped a family.

import { SEED_ITEMS, ITEM_FAMILY } from '../itemPool';

/**
 * Rows whose id is exactly `furn_<subject>_<token>`.
 *
 * WARNING: ELEVEN LEGACY ROWS DO NOT MATCH AND ARE SKIPPED, not forced: ids like
 * `furn_bunk_walnut` (subject `bunk_bed`) and `furn_retro_tv` predate the
 * convention. Rewriting them would be an id migration, which is a real player
 * risk — `seed-ids.lock` exists precisely to make that deliberate. The count
 * below is pinned so the skip cannot quietly grow to swallow the gate.
 */
function tokenised(): Array<{ id: string; token: string; family: string }> {
  const out: Array<{ id: string; token: string; family: string }> = [];
  for (const item of SEED_ITEMS) {
    if (item.type !== 'furniture') continue;
    const prefix = `furn_${item.subject}_`;
    if (!item.id.startsWith(prefix)) continue;
    const family = ITEM_FAMILY[item.id];
    // A family-neutral furniture row would be a different defect; this gate is
    // about disagreement, not absence, so absence is skipped and counted.
    if (family == null) continue;
    out.push({ id: item.id, token: item.id.slice(prefix.length), family });
  }
  return out;
}

describe('🔑 ANTI-VACUITY — the extraction actually found the rows', () => {
  test('the id convention matches the number of rows it did when written', () => {
    // Measured at W2-159: 134 of 145 furniture rows. If this drops, the gate is
    // silently examining less than it did and the `toEqual([])` below starts
    // passing for the wrong reason.
    const rows = tokenised();
    expect(`tokenised furniture rows >= 134: ${rows.length >= 134}`).toBe(
      'tokenised furniture rows >= 134: true',
    );
  });

  test('the tokens that carry the rule are present', () => {
    const tokens = new Set(tokenised().map((r) => r.token));
    // Named individually rather than by count: a count is satisfied by any 24
    // tokens, including 24 wrong ones.
    for (const t of ['caramel', 'charcoal', 'ivory', 'sage', 'two_tone',
                     'butter', 'mint', 'slate', 'terracotta']) {
      expect(`${t} present: ${tokens.has(t)}`).toBe(`${t} present: true`);
    }
  });
});

describe('🔴 a finish token names exactly one family', () => {
  test('no token is filed under two different families', () => {
    const byToken = new Map<string, Map<string, string[]>>();
    for (const { id, token, family } of tokenised()) {
      const fams = byToken.get(token) ?? new Map<string, string[]>();
      fams.set(family, [...(fams.get(family) ?? []), id]);
      byToken.set(token, fams);
    }

    // Reported as `token: family(ids) | family(ids)` so a red names the rows to
    // look at, not just the token — the same reason productRegistry names the
    // source of every believed id.
    const conflicts: string[] = [];
    for (const [token, fams] of [...byToken.entries()].sort()) {
      if (fams.size <= 1) continue;
      const detail = [...fams.entries()]
        .sort()
        .map(([f, ids]) => `${f}(${ids.sort().join(',')})`)
        .join(' | ');
      conflicts.push(`${token}: ${detail}`);
    }

    expect(conflicts).toEqual([]);
  });
});
