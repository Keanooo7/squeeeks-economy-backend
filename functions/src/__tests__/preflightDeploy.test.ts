/**
 * The decision table behind `preflight:deploy` (W2-155).
 *
 * 🔴 WHAT THIS PINS AND WHY IT IS NOT A SOURCE-STRING ASSERTION. The gate's own
 * proof was a shell transcript — dirty refuses, clean passes, behind refuses —
 * and a transcript disappears. `decide()` is the function those three runs
 * actually exercised, so pinning it here is pinning the behaviour, not the text.
 *
 * 🔑 THE CASE THAT EARNS THE FILE IS `behind`. A dirty-tree check is the obvious
 * one and every reviewer would think of it; the stale-checkout case — a
 * PERFECTLY CLEAN tree that is simply old — is the one
 * `check-deployed-revision.cjs` names in its own header as invisible to every
 * timestamp instrument, and it is the one a `dirty`-only gate silently misses.
 *
 * ⚠️ The git-touching half is deliberately NOT tested. It shells out to
 * `git status` and `git rev-list` against the real repo, which a unit test
 * cannot do honestly — the same split as `classify` in check-deployed-revision.
*/

// 🔴 REQUIRED, NOT DECORATION. A test file with no import/export is a GLOBAL
// SCRIPT to TypeScript, so its top-level `const`s collide with every sibling
// that does the same and the failure surfaces as an unrelated suite going red
// depending on worker scheduling. `testFilesAreModules.test.ts` guards it, and
// it caught this file on its first full run.
export {};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const gate = require('../../scripts/preflight-deploy.cjs') as {
  decide: (f: {dirty: string[]; behind: number; override: boolean}) => {
    code: number;
    reason: string;
  };
  STAMP_PATH: string;
  OVERRIDE: string;
  OK: number;
  REFUSED: number;
  CANNOT_TELL: number;
};

const {decide, STAMP_PATH, OVERRIDE, OK, REFUSED} = gate;

describe('preflight:deploy — the decision table', () => {
  it('passes a clean tree that is level with origin/main', () => {
    expect(decide({dirty: [], behind: 0, override: false})).toEqual({
      code: OK,
      reason: 'clean',
    });
  });

  it('REFUSES a dirty tree — the stamp would name the wrong commit', () => {
    const r = decide({dirty: ['functions/src/index.ts'], behind: 0, override: false});
    expect(r.reason).toBe('dirty');
    expect(r.code).toBe(REFUSED);
  });

  it('REFUSES a CLEAN tree that is behind origin/main — the stale-checkout case', () => {
    // 🔑 The case a dirty-only gate cannot see. `dirty` is empty here on
    // purpose: if this ever passes because the implementation started keying
    // off `dirty`, the gate has lost the half that matters.
    const r = decide({dirty: [], behind: 3, override: false});
    expect(r.reason).toBe('behind');
    expect(r.code).toBe(REFUSED);
  });

  it('lets the override through BOTH refusals, not just one', () => {
    // A hatch that only escapes the easy case is not an escape hatch. Brendan
    // deploys; a gate that can strand him gets deleted and then protects
    // nothing.
    expect(decide({dirty: ['a'], behind: 9, override: true})).toEqual({
      code: OK,
      reason: 'override',
    });
  });

  it('is decided by dirty BEFORE behind when both are true', () => {
    // Ordering is contract, not accident: `git status` is the thing the
    // developer can already see, so it is the one they are told about first.
    expect(decide({dirty: ['a'], behind: 5, override: false}).reason).toBe('dirty');
  });

  it('names the stamp path exactly, because the caller excludes it by equality', () => {
    // 🔴 If this path drifts from where gen-build-info.cjs writes, the exclusion
    // stops matching and the FIRST deploy makes the SECOND one refuse over a
    // file the gate itself caused. Equality, never a pattern.
    expect(STAMP_PATH).toBe('functions/src/buildInfo.generated.ts');
  });

  it('keeps the override greppable — a quiet hatch is one nobody remembers using', () => {
    expect(OVERRIDE).toBe('DEPLOY_UNIDENTIFIED');
  });
});
