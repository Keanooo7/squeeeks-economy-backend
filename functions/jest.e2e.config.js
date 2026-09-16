const base = require('./jest.config.js');

/**
 * W2-140 · The emulator suite runs on a STATED fuse, not an inherited default.
 *
 * 🔴 THE MEASUREMENT THAT PRODUCED THIS FILE. Nobody had ever looked at the
 * per-test distribution. Three suites share `jest.config.js`, and they are not
 * remotely alike:
 *
 *     suite  tests  slowest test   % of the 5000 ms default   margin
 *     unit    1492        155 ms                      3.1%      32x
 *     rules    227        446 ms                      8.9%      11x
 *     e2e      116       3430 ms                     68.6%    1.46x
 *
 * ⚠️ ONLY THE E2E SUITE IS ANYWHERE NEAR THE FUSE, and the six tests that are
 * near it are all the CONCURRENCY tests — two racing calls proving a write
 * happens exactly once (renewalNotification 3430/3269, iapGrant 3357,
 * taskCompletion 3186, adminGrant 2939, openPendingChest 2765). Those are the
 * most valuable tests in the repo and structurally the slowest: each one really
 * does fire concurrent calls at a real emulator and wait for both.
 *
 * 🔑 WHY 1.46x IS THE ACTUAL DEFECT, AND WHY RAISING IT IS NOT THE FIX #579
 * REFUSED. Nothing here is failing. #579 refused a bump that made a FAILING
 * test pass — a diagnosis deleted. This is the opposite: a passing test 46%
 * away from a fuse nobody chose. If a concurrency test drifts from 3430 ms to
 * 5000 ms — well within what a loaded machine does — jest reports "Exceeded
 * timeout of 5000 ms", and the honest reading of that, on a test whose whole
 * subject is two calls racing, is A DEADLOCK. It is not a deadlock. It is a
 * slow test wearing a hang's error message, which is precisely the state #579
 * was created to end.
 *
 * ✅ 15000 ms is 4.4x the measured worst case. The unit and rules suites are
 * DELIBERATELY LEFT on the inherited default: at 32x and 11x their premise is
 * disproven, and tightening them would buy about two seconds on a hang while
 * risking a cry-wolf failure on a slow machine. Measured, considered, unchanged.
 *
 * 📌 `E2E_WORST_CASE_MS` is pinned here rather than in prose because
 * `jestTimeouts.test.ts` asserts the ratio against it. A new e2e test slower
 * than this number must move it, and moving it is what re-checks the margin.
 * [[derived-numbers-in-prose-rot-silently]]
 */
const E2E_WORST_CASE_MS = 3430;
const E2E_TIMEOUT_MS = 15000;

module.exports = {
  ...base,
  testMatch: ['**/__tests__/**/*Emulator.test.ts'],
  // The base config EXCLUDES *Emulator suites from `npm test`; this config
  // exists to run exactly those, so that exclusion must not be inherited.
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: E2E_TIMEOUT_MS,
};

module.exports.E2E_WORST_CASE_MS = E2E_WORST_CASE_MS;
module.exports.E2E_TIMEOUT_MS = E2E_TIMEOUT_MS;
