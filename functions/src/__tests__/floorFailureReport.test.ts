// functions/src/__tests__/floorFailureReport.test.ts
//
// W2-78. The floor checker can now say WHICH test failed, and — the part that
// was not in the brief — it can now see a suite that failed to RUN at all.
//
// ---------------------------------------------------------------------------
// 🔴 THE DEFECT THIS EXISTS FOR WAS MEASURED, NOT SUSPECTED
// ---------------------------------------------------------------------------
//
// Reproduced by adding one test file that cannot compile, then running both:
//
//   jest                        Test Suites: 1 failed, 46 passed, 47 total
//                               Tests:       933 passed, 933 total
//                               exit 1
//   check-test-floor.cjs unit   floor: unit OK — 933, at the floor.
//                               exit 0                      <- GREEN. WRONG.
//
// 🔑 A SUITE THAT FAILS TO RUN CONTRIBUTES ZERO TESTS. It is not a failure
// added to the `Tests:` line — it is a whole file removed from the run. The
// count does not drop, so the FLOOR cannot see it either: those tests were
// never in the total to compare against.
//
// This is the shape of the W2-76 SIGSEGV. `Test Suites: 1 failed` with
// `Tests: 908 passed, 908 total` against a floor of 906 would have printed
// `unit OK — 908 (floor 906, +2)` and exited 0 while 25 tests never ran.
//
// ---------------------------------------------------------------------------
// ⚠️ EVERY FIXTURE BELOW IS LITERAL CAPTURED OUTPUT, NOT WRITTEN FROM MEMORY
// ---------------------------------------------------------------------------
//
// Each was produced by deliberately breaking something and saving what jest
// actually printed. That matters here specifically: three extractor bugs
// reached main in #364/#365, and every one of them was a guess about a format
// that turned out to be wrong in a way that made the gate PASS.
//
// 📌 The first thing these fixtures proved is that a guess would have been
// wrong again: jest's default reporter emits NO `✕` lines. Per-test names
// appear only as `● describe › test` bullets. An extractor built around `✕`
// would have found nothing and reported every red run as unattributable.

// 🔴 FORCE MODULE SCOPE — LOAD-BEARING, NOT STYLISTIC. Without one top-level
// `import`/`export` this file is a SCRIPT and its top-level `const checker`
// lands in the GLOBAL scope, where it can collide with another script test and
// take THIS ENTIRE SUITE out of the run with no failure reported. The long
// version of the argument is in `deployedRevision.test.ts`; the guard that
// makes it impossible to reintroduce is `testFilesAreModules.test.ts`.
// Do not delete this as an unused export.
export {};

// Required rather than imported: the checker is a plain .cjs with no
// declaration file, and `import` would need one. The shape is asserted by the
// smoke test below rather than by a type — a hand-written .d.ts here would be a
// second description of the module that nothing keeps in step with the first.
interface FailureReport {
  status: number;
  testsLine: string;
  suitesLine: string;
  failedTestCount: number;
  failedSuiteCount: number;
  failedSuites: string[];
  failedTests: string[];
  suiteFailedToRun: boolean;
  workerCrash: boolean;
  isRed: boolean;
}

/* eslint-disable @typescript-eslint/no-var-requires */
const checker: {
  describeFailure: (output: string, status: number) => FailureReport;
  renderFailure: (key: string, report: FailureReport, logPath: string | null) => string;
} = require('../../scripts/check-test-floor.cjs');

const {describeFailure, renderFailure} = checker;

describe('the module under test is the real checker', () => {
  test('🔴 requiring it did NOT run the suites as a side effect', () => {
    // Without the `require.main === module` guard, importing this file would
    // execute main() — running both suites, one of which needs an emulator.
    // If that guard is ever removed, this file becomes a fork bomb rather than
    // a test, so the guard is asserted where it would do the damage.
    const source = require('fs').readFileSync(
      require('path').join(__dirname, '..', '..', 'scripts', 'check-test-floor.cjs'),
      'utf8',
    );
    expect(source).toContain('require.main === module');
  });

  test('it exports the two functions this file tests', () => {
    expect(typeof describeFailure).toBe('function');
    expect(typeof renderFailure).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// Fixtures — captured 2026-08-15, trimmed only of unrelated PASS lines.
// ---------------------------------------------------------------------------

/** Two assertions failing in one suite. `npx jest zzTempFail entitlement`. */
const ASSERTION_FAILURE = `FAIL src/__tests__/zzTempFail.test.ts
  ● a deliberately failing group › this assertion is meant to fail

    expect(received).toBe(expected) // Object.is equality

    Expected: 3
    Received: 2

      2 |   test('this assertion is meant to fail', () => {
    > 3 |     expect(1 + 1).toBe(3);

  ● a deliberately failing group › and so is this one

    expect(received).toBe(expected) // Object.is equality

    Expected: "beta"
    Received: "alpha"

PASS src/__tests__/entitlement.test.ts

Test Suites: 1 failed, 1 passed, 2 total
Tests:       2 failed, 32 passed, 34 total
Snapshots:   0 total
Time:        2.1 s
`;

/**
 * A suite that cannot compile. 🔴 NOTE THE `Tests:` LINE — no `failed` in it at
 * all, and the total is simply smaller. This is the fixture that proves the
 * old check could not work.
 */
const SUITE_FAILED_TO_RUN = `PASS src/__tests__/entitlement.test.ts
FAIL src/__tests__/zzTempFail.test.ts
  ● Test suite failed to run

    src/__tests__/zzTempFail.test.ts:1:7 - error TS2322: Type 'string' is not assignable to type 'number'.

    1 const broken: number = 'this does not compile';
            ~~~~~~

Test Suites: 1 failed, 1 passed, 2 total
Tests:       31 passed, 31 total
Snapshots:   0 total
Time:        1.9 s
`;

/**
 * The real W2-76 flake, copied verbatim from the captured run. Same shape as
 * above — a red suite behind a green `Tests:` line — but caused by a signal
 * rather than a type error, and so worth naming separately in the report.
 */
const WORKER_SIGSEGV = `FAIL src/__tests__/offerIntegrity.test.ts
  ● Test suite failed to run

    A jest worker process (pid=21057) was terminated by another process: signal=SIGSEGV, exitCode=null. Operating system logs may contain more information on why this occurred.

      at ChildProcessWorker._onExit (node_modules/jest-worker/build/workers/ChildProcessWorker.js:370:23)

PASS src/__tests__/defaultHouses.test.ts

Test Suites: 1 failed, 45 passed, 46 total
Tests:       908 passed, 908 total
Snapshots:   0 total
`;

/**
 * 🔴 A GREEN RUN THAT CONTAINS `● Console` BULLETS. This is not a contrived
 * case — the real suite prints five of them on a passing run, because the code
 * under test logs. Without the heading filter, every green run would be
 * reported as five failing tests named "Console".
 */
const GREEN_WITH_CONSOLE = `PASS src/__tests__/entitlement.test.ts
  ● Console

    console.warn
      some warning the code under test emits

  ● Console

    console.log
      another one

Test Suites: 46 passed, 46 total
Tests:       933 passed, 933 total
Snapshots:   0 total
`;

describe('🔴 a suite that FAILED TO RUN is red, though the Tests: line is green', () => {
  // The defect. Each of these three assertions fails against the old logic.

  test('a compile failure is detected as red', () => {
    const r = describeFailure(SUITE_FAILED_TO_RUN, 1);
    expect(r.isRed).toBe(true);
  });

  test('…even though NO test is reported as failed', () => {
    // The proof that the old `Tests: ... failed` check could not have worked.
    // If this ever reads > 0, the fixture has been edited and the test below
    // it is no longer testing what it claims.
    const r = describeFailure(SUITE_FAILED_TO_RUN, 1);
    expect(r.failedTestCount).toBe(0);
    expect(r.testsLine).toBe('Tests:       31 passed, 31 total');
    expect(r.testsLine).not.toMatch(/failed/);
  });

  test('it is caught by the SUITE line and the exit code, not the test line', () => {
    const r = describeFailure(SUITE_FAILED_TO_RUN, 1);
    expect(r.failedSuiteCount).toBe(1);
    expect(r.suiteFailedToRun).toBe(true);
    expect(r.status).toBe(1);
  });

  test('🔴 the SUMMARY LINES alone are sufficient, with the exit code GREEN', () => {
    // 🔴 THIS TEST EXISTS BECAUSE A CONTROL CAUGHT ITS ABSENCE. Deleting the
    // suite-level terms from isRed left all 17 tests GREEN, because every
    // fixture passes status = 1 and `status !== 0` already carried them. The
    // suite-level detection was redundant in every case it was supposedly
    // tested by — a vacuous test of exactly the kind this file was written to
    // stop, found in this file.
    //
    // Passing status 0 is not a jest state anyone has observed; it is the
    // point. The three terms in isRed are belt-and-braces, and a redundancy is
    // only worth having if each strand is asserted ALONE. A wrapper that
    // swallows an exit code is the realistic version — npm has done it before.
    expect(describeFailure(SUITE_FAILED_TO_RUN, 0).isRed).toBe(true);
    expect(describeFailure(ASSERTION_FAILURE, 0).isRed).toBe(true);
  });

  test('🔴 the exit code ALONE is sufficient, with both summary lines removed', () => {
    // The belt-and-braces check. If a future jest changes its summary wording,
    // the gate must still refuse — the runner's own verdict is the one thing
    // that cannot be reworded out of existence.
    const noSummaries = 'FAIL src/__tests__/x.test.ts\nsomething went wrong\n';
    expect(describeFailure(noSummaries, 1).isRed).toBe(true);
  });

  test('the real SIGSEGV flake is caught, and flagged as a worker crash', () => {
    const r = describeFailure(WORKER_SIGSEGV, 1);
    expect(r.isRed).toBe(true);
    expect(r.workerCrash).toBe(true);
    expect(r.failedSuites).toEqual(['src/__tests__/offerIntegrity.test.ts']);
    // The count that would have beaten the then-floor of 906.
    expect(r.testsLine).toContain('908 passed, 908 total');
  });

  test('the rendered report says the count reads green and is not', () => {
    const text = renderFailure('unit', describeFailure(SUITE_FAILED_TO_RUN, 1), null);
    expect(text).toContain('FAILED TO RUN');
    expect(text).toContain('reads green, and is not');
    expect(text).toContain('src/__tests__/zzTempFail.test.ts');
  });

  test('a worker crash is called out as the known intermittent shape', () => {
    const text = renderFailure('unit', describeFailure(WORKER_SIGSEGV, 1), null);
    expect(text).toMatch(/WORKER CRASHED/);
    expect(text).toMatch(/re-run before concluding a regression/);
  });
});

describe('a red run is ATTRIBUTED — the reported defect', () => {
  test('every failing test is named', () => {
    const r = describeFailure(ASSERTION_FAILURE, 1);
    expect(r.failedTests).toEqual([
      'a deliberately failing group › this assertion is meant to fail',
      'a deliberately failing group › and so is this one',
    ]);
  });

  test('the failing suite file is named', () => {
    const r = describeFailure(ASSERTION_FAILURE, 1);
    expect(r.failedSuites).toEqual(['src/__tests__/zzTempFail.test.ts']);
  });

  test('the names reach the rendered report', () => {
    const text = renderFailure('unit', describeFailure(ASSERTION_FAILURE, 1), '/tmp/x.log');
    expect(text).toContain('this assertion is meant to fail');
    expect(text).toContain('and so is this one');
    expect(text).toContain('failing tests (2)');
    expect(text).toContain('/tmp/x.log');
  });

  test('a name is not double-counted when it appears twice', () => {
    // jest prints the bullet once per failure, but a `--verbose` run adds a ✕
    // line for the same test. Both are parsed; the result must be a set.
    const both = ASSERTION_FAILURE + '\n  ✕ a deliberately failing group › and so is this one (3 ms)\n';
    const r = describeFailure(both, 1);
    expect(r.failedTests).toHaveLength(2);
  });
});

describe('🔴 the extractor does not invent failures on a GREEN run', () => {
  // The inverse control, and the one that would break the whole gate if wrong:
  // a false positive here turns every passing run red and the fix would be to
  // delete the check.

  test('a passing run is not red', () => {
    expect(describeFailure(GREEN_WITH_CONSOLE, 0).isRed).toBe(false);
  });

  test('🔴 `● Console` bullets are NOT reported as failing tests', () => {
    // Not hypothetical: the real suite prints these on a passing run.
    const r = describeFailure(GREEN_WITH_CONSOLE, 0);
    expect(r.failedTests).toEqual([]);
    expect(r.failedSuites).toEqual([]);
  });

  test('"Test suite failed to run" is a heading, not a test name', () => {
    const r = describeFailure(SUITE_FAILED_TO_RUN, 1);
    expect(r.failedTests).not.toContain('Test suite failed to run');
  });
});

describe('⚠️ the report refuses to render an empty finding as a finding', () => {
  test('an unnameable red says so, in those words', () => {
    // The anti-vacuity guard. A red run the extractor cannot parse must READ as
    // unexplained — an empty list under a "failing tests" heading reads as
    // "red, but nothing actually wrong", which is the vacuous-pass shape this
    // repo has now been bitten by in three separate gates.
    const unparseable = 'something exploded in a way jest has never printed\n';
    const text = renderFailure('unit', describeFailure(unparseable, 1), null);
    expect(text).toContain('COULD NOT NAME THE FAILURE');
    expect(text).not.toMatch(/failing tests \(0\)/);
  });
});
