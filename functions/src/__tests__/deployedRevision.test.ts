/**
 * The credential-free half of `check-deployed-revision.cjs` (W2-106).
 *
 * CRITICAL: THE FAILURE THAT MATTERS HERE IS FAILING OPEN. The script answers "is
 * production older than the last commit that changed functions/src?" by
 * comparing two numbers. If the deploy summary ever produced a garbage-but-
 * finite value — or produced nothing and the comparison ran against
 * `undefined` — the script would print UP TO DATE for a production running
 * anything at all. That is the same false reassurance the checker exists to
 * end, reproduced inside the instrument, and it is invisible from running it
 * because the broken version looks green.
 *
 * WARNING: THE gcfv1 TRAP IS THE CONCRETE VERSION OF IT. `onNewUserBefriendGibby` is
 * a gen1 function and exposes no `source.storageSource`, so a naive reduce over
 * the whole list yields a generation of 0 → 1970-01-01, and every comparison
 * against it reports catastrophic staleness forever. Skipping it silently is
 * the opposite error: a v1 function could then never be reported stale and
 * nobody would know it was unwatched. It is excluded AND named.
 */
// CRITICAL: FORCE MODULE SCOPE, AND IT IS LOAD-BEARING RATHER THAN STYLISTIC.
// Without a single top-level `import` or `export`, TypeScript treats this file
// as a SCRIPT, so the `const checker` below lands in the GLOBAL scope — and
// `floorFailureReport.test.ts` declares a top-level `const checker` too. When
// jest's worker scheduling happens to put both into one ts-jest program the
// compile fails TS2451 and THIS SUITE DOES NOT RUN.
//
// WARNING: THE FAILURE IS SILENT IN THE DIRECTION THAT MATTERS: a suite that never
// ran contributes no failures, so the report reads `Tests: 1243 passed, 1243
// total` — zero red, nine short — and a floor check comparing PASSING counts
// sees green. Which of the nine sibling files collide depends on worker
// scheduling, which is why it moved around and looked like flake.
//
// NOTE: `check-test-floor.cjs` already detects the symptom ("a suite FAILED TO RUN
// and reported no failing test"). This line removes the CAUSE. Do not treat it
// as a substitute for that detector, and do not delete it as an unused export.
export {};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const checker = require('../../scripts/check-deployed-revision.cjs') as {
  summariseDeploys: (json: unknown) => {
    error?: string;
    newest?: {id: string; ms: number};
    oldest?: {id: string; ms: number};
    counted?: number;
    untimed?: string[];
  };
  SKEW_TOLERANCE_MS: number;
};

const {summariseDeploys, SKEW_TOLERANCE_MS} = checker;

/** A function as `firebase functions:list --json` reports it. */
function gen2(id: string, generation: string) {
  return {id, platform: 'gcfv2', source: {storageSource: {generation}}};
}

/** 2026-08-16T07:17:18.597Z, the real deploy this checker was written after. */
const REAL_GEN = '1786864638597972';
const REAL_MS = 1786864638597.972;

describe('summariseDeploys — the half that decides UP TO DATE', () => {
  it('reads a generation as MICROSECONDS, which is the whole design', () => {
    // If this is ever read as milliseconds the answer is off by a factor of
    // 1000 — a 2026 deploy would parse as the year 58,600 and every production
    // would look permanently up to date. The exact value is pinned.
    const r = summariseDeploys({result: [gen2('verifySubscriptionReceipt', REAL_GEN)]});
    expect(r.error).toBeUndefined();
    expect(r.newest!.ms).toBeCloseTo(REAL_MS, 0);
    expect(new Date(r.newest!.ms).toISOString()).toBe('2026-08-16T07:17:18.597Z');
  });

  it('🔴 EXCLUDES a gen1 function rather than reading it as epoch zero', () => {
    // The trap that made a first look report `oldest deploy: 1970-01-01`.
    const r = summariseDeploys({
      result: [
        gen2('verifyIapAndGrant', REAL_GEN),
        {id: 'onNewUserBefriendGibby', platform: 'gcfv1'},
      ],
    });
    expect(r.counted).toBe(1);
    expect(r.oldest!.ms).toBeCloseTo(REAL_MS, 0);
    // KEY: AND IT IS NAMED. Excluding silently would mean a gen1 function could
    // never be reported stale and nobody would know it was unwatched.
    expect(r.untimed).toEqual(['onNewUserBefriendGibby']);
  });

  it('picks the NEWEST and OLDEST across many functions', () => {
    const r = summariseDeploys({
      result: [
        gen2('a', '1786864638000000'),
        gen2('b', '1786864999000000'),
        gen2('c', '1786864111000000'),
      ],
    });
    expect(r.newest!.id).toBe('b');
    expect(r.oldest!.id).toBe('c');
    expect(r.counted).toBe(3);
  });

  describe('🔴 refuses rather than failing open', () => {
    it('an empty function list is an ERROR, not "up to date"', () => {
      // A project that returned nothing would otherwise compare against a
      // newest of -Infinity and pass forever.
      expect(summariseDeploys({result: []}).error).toBeTruthy();
    });

    it('a missing result array is an ERROR', () => {
      expect(summariseDeploys({}).error).toBeTruthy();
      expect(summariseDeploys(null).error).toBeTruthy();
    });

    it('a list where NOTHING has a generation is an ERROR', () => {
      // Not "counted: 0, newest: undefined" — that is the shape that would let
      // the caller compare against undefined and print UP TO DATE.
      const r = summariseDeploys({result: [{id: 'v1only', platform: 'gcfv1'}]});
      expect(r.error).toBeTruthy();
      expect(r.newest).toBeUndefined();
    });

    it('a non-numeric or zero generation does not become a valid time', () => {
      expect(summariseDeploys({result: [gen2('x', 'not-a-number')]}).error).toBeTruthy();
      expect(summariseDeploys({result: [gen2('x', '0')]}).error).toBeTruthy();
    });
  });

  it('the skew tolerance is a real, non-zero window', () => {
    // Two different clocks — a commit date from the committer's machine, a
    // generation from Google. A zero tolerance would make a near-tie report a
    // confident verdict it has no basis for.
    expect(SKEW_TOLERANCE_MS).toBeGreaterThan(0);
    expect(typeof SKEW_TOLERANCE_MS).toBe('number');
  });

  it('🔴 requiring the script does not RUN it', () => {
    // Without `require.main === module` this import would shell out to
    // `firebase functions:list` on every `npm test` — a credentialled network
    // call inside the suite that exists because the comparison cannot be one.
    // Reaching this assertion proves main() did not fire on import.
    expect(typeof summariseDeploys).toBe('function');
  });
});
