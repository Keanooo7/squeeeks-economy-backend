import * as fs from 'fs';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const e2eConfig = require('../../jest.e2e.config.js') as {
  testTimeout: number;
  testMatch: string[];
  testPathIgnorePatterns: string[];
  E2E_WORST_CASE_MS: number;
  E2E_TIMEOUT_MS: number;
};

const REPO_FUNCTIONS = path.resolve(__dirname, '..', '..');

/**
 * W2-140 · The emulator suite's fuse must stay a stated multiple of what it
 * actually takes.
 *
 * 🔴 WHAT THIS EXISTS TO STOP, and it is a specific future edit. The six e2e
 * concurrency tests run at 2765–3430 ms. Against the inherited 5000 ms default
 * that is a 1.46x margin, and the failure it eventually produces —
 * "Exceeded timeout of 5000 ms" on a test whose subject is two calls racing —
 * reads as a DEADLOCK rather than as slowness. Someone will one day tidy the
 * "redundant" timeout out of jest.e2e.config.js, or trim it back toward the
 * default, and nothing would notice until a concurrency test failed at 3am
 * looking exactly like the bug it was written to catch.
 *
 * 🔑 THE RATIO IS THE POLICY, NOT THE NUMBER. Pinning `testTimeout === 15000`
 * would pass just as well and mean nothing: it could not tell a healthy 4.4x
 * from a 1.1x, because it never looks at what the tests cost. Asserting
 * `timeout >= 4 * worst case` is the thing actually worth keeping true, and it
 * makes adding a slower e2e test re-open the question by construction — the
 * new worst case has to be recorded, and recording it re-checks the margin.
 *
 * ⚠️ WHAT IT CANNOT DO, stated so it is not mistaken for more. It reads a
 * RECORDED worst case, not a live one; a test that silently gets slower without
 * anyone re-measuring is invisible to it. There is no cheap fix for that — a
 * gate that timed the suite from inside the suite would be measuring the
 * machine it happens to run on, and would cry wolf on a loaded laptop. This is
 * a pinned threshold, deliberately, and re-measuring is a human act.
 */
describe('W2-140 the emulator suite runs on a stated fuse', () => {
  const MIN_RATIO = 4;

  test('🔑 the e2e timeout is at least 4x the measured worst case', () => {
    const ratio = e2eConfig.testTimeout / e2eConfig.E2E_WORST_CASE_MS;
    expect(
      `e2e timeout ${e2eConfig.testTimeout}ms vs worst case ` +
        `${e2eConfig.E2E_WORST_CASE_MS}ms — ratio ${ratio.toFixed(2)}x, ` +
        `at least ${MIN_RATIO}x: ${ratio >= MIN_RATIO}`,
    ).toBe(
      `e2e timeout ${e2eConfig.testTimeout}ms vs worst case ` +
        `${e2eConfig.E2E_WORST_CASE_MS}ms — ratio ${ratio.toFixed(2)}x, ` +
        `at least ${MIN_RATIO}x: true`,
    );
  });

  test('🔴 ANTI-VACUITY — the recorded worst case is a real measurement', () => {
    // A worst case of 0, or of 1, would satisfy any ratio forever. This pins it
    // to the order of magnitude the emulator concurrency tests actually cost,
    // so the gate cannot be defused by shrinking the denominator instead of
    // raising the numerator.
    expect(
      `worst case in the 1000..10000ms band: ` +
        `${e2eConfig.E2E_WORST_CASE_MS >= 1000 && e2eConfig.E2E_WORST_CASE_MS <= 10000}`,
    ).toBe('worst case in the 1000..10000ms band: true');
  });

  test('the e2e script actually uses this config', () => {
    // The config could be perfect and unreferenced. This is the link: if the
    // script stops passing --config, the timeout above governs nothing and the
    // suite silently returns to the inherited 5000 ms default.
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_FUNCTIONS, 'package.json'), 'utf8'),
    ) as {scripts: Record<string, string>};
    expect(
      `test:e2e passes --config jest.e2e.config.js: ` +
        `${pkg.scripts['test:e2e'].includes('--config jest.e2e.config.js')}`,
    ).toBe('test:e2e passes --config jest.e2e.config.js: true');
  });

  test('📌 the unit suite is deliberately NOT given a timeout', () => {
    // Recorded as a decision rather than an omission. unit's slowest test is
    // 155 ms and rules' is 446 ms — 32x and 11x under the default. Tightening
    // them would save about two seconds on a hang and risk a cry-wolf failure
    // on a slow machine. If someone later adds one, this red is the prompt to
    // re-measure first rather than to pick a number.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const base = require('../../jest.config.js') as {testTimeout?: number};
    expect(`base config sets testTimeout: ${base.testTimeout !== undefined}`).toBe(
      'base config sets testTimeout: false',
    );
  });
});
