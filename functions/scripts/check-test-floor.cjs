#!/usr/bin/env node
/**
 * Enforce the backend test floors.
 *
 *   node scripts/check-test-floor.cjs unit      # npm test
 *   node scripts/check-test-floor.cjs rules     # npm run test:rules
 *   node scripts/check-test-floor.cjs e2e       # npm run test:e2e
 *   node scripts/check-test-floor.cjs all
 *   node scripts/check-test-floor.cjs all --ratchet   # exit 4 on an unbanked rise
 *   node scripts/check-test-floor.cjs all --record    # measure, then write the floor
 *
 * WARNING: `all` RUNS TWO EMULATOR SUITES and takes minutes.
 *
 * OK: NEITHER NEEDS A PREPARED SHELL ANY MORE (W2-95, 2026-08-16). Both suites
 * run through `scripts/with-jdk.cjs`, which finds a JDK 21+ — including an
 * UNLINKED Homebrew one, which `/usr/libexec/java_home` cannot see — and both
 * pass `--config` naming their own emulator ports: `test:e2e` uses
 * firebase.e2e.json (8181/9198) and `test:rules` uses firebase.rules.json
 * (8282). So both survive a dev `emulators:start` holding 8080/9099, and both
 * survive a default `java` older than 21.
 *
 * NOTE: The previous version of this comment said `test:rules` "still does not"
 * survive a held 8080. That was true and is now false; it is replaced rather
 * than amended, because a stale line here reads as current doctrine. Exit 3
 * (ENVIRONMENT, not a regression) is still what a missing JDK produces — it is
 * now genuinely rare rather than the normal case.
 *
 * Exit codes are the contract, because the whole point of this file is that a
 * caller can tell the outcomes apart:
 *
 *   0  measured, and at or above the floor
 *   1  measured, and BELOW the floor            — a real regression
 *   2  could not determine the floor            — refuses; never treated as 0
 *   3  could not run or read the suite          — ENVIRONMENT, not a regression
 *   4  measured, and ABOVE the floor unbanked   — ONLY under --ratchet (W2-166)
 *
 * 2 and 3 exist separately because "the gate did not run" and "the gate found
 * nothing" are different facts that a single non-zero exit would merge. An
 * unmeasured suite must never be reported as a passing one.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: W2-166. CODE 4 EXISTS BECAUSE THIS FILE WAS AN ADVISORY THAT COULD NOT FAIL
 * ---------------------------------------------------------------------------
 *
 * The rise branch below has always printed the delta, named it, and given the
 * instruction — and then exited 0:
 *
 *   floor: unit OK — 1596 (floor 1572, +24). Raise the floor in this commit
 *                                            or the gain drifts back.
 *
 * KEY: So the detector was never missing. #660, #662 and #663 each landed over
 * that line with the right number in front of them, and nothing stopped,
 * because CI reads exit 0 as success. The floor sat 24 tests and one suite
 * behind main until W2-165 measured the base and found it. A warning nobody is
 * REQUIRED to act on is a warning that will not be acted on.
 *
 * WARNING: AND THE DEFAULT STILL EXITS 0 ON A RISE, DELIBERATELY. `npm run floor`
 * runs legitimately mid-work — including inside /land, before the floor commit
 * exists — so a default that failed there would fail the correct workflow. A
 * gate that cries wolf gets RELAXED rather than debugged, which is how this
 * repo would lose the check a second time and permanently. The failing
 * behaviour is therefore opt-in: `--ratchet` is for the one place that should
 * refuse an unbanked gain, and `--record` is what fixes it in one command.
 *
 * NOTE: `--record` is modelled on 3d-source/factory_verify.py, the only ratchet in
 * this repo with a write path and correct for weeks: it SHORT-CIRCUITS the gate
 * rather than judging and writing in one pass, and it REFUSES with a non-zero
 * exit rather than writing a smaller number. Monotonicity lives in the writer.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: W2-78. THIS FILE REPORTED A CRASHED SUITE AS GREEN, AND THAT IS MEASURED
 * ---------------------------------------------------------------------------
 *
 * Reproduced on 2026-08-15 by adding one test file that cannot compile:
 *
 *   jest                        Test Suites: 1 failed, 46 passed, 47 total
 *                               Tests:       933 passed, 933 total
 *                               exit 1
 *   check-test-floor.cjs unit   floor: unit OK — 933, at the floor.
 *                               exit 0                      <- THE DEFECT
 *
 * KEY: A SUITE THAT FAILS TO *RUN* CONTRIBUTES ZERO TESTS. It does not add a
 * failure to the `Tests:` line — it removes the whole file from the run. So the
 * count does not drop, `Tests:` says `933 passed` with no `failed` in it, and
 * every check this file used to make came back clean. The floor cannot catch it
 * either: the crashed suite's tests were never in the total to begin with, so
 * there is no shortfall to detect.
 *
 * That is not a hypothetical. It is the shape of BOTH intermittents seen in
 * W2-76: a SIGSEGV in a jest worker running offerIntegrity.test.ts produced
 * `Test Suites: 1 failed` with `Tests: 908 passed, 908 total` and no failing
 * assertion. Against the then-floor of 906 this file would have printed
 * `unit OK — 908 (floor 906, +2)` and exited 0, while 25 tests never ran.
 *
 * THREE CAUSES, ALL FIXED HERE, and the first is the one that makes the rest
 * belt-and-braces:
 *
 *   1. THE CHILD'S EXIT CODE WAS NEVER READ. `spawnSync` returns `status` and
 *      this file ignored it. jest had already said 1. The gate asked jest for
 *      its summary text and threw away its verdict — a green report built on a
 *      red runner, which is the inversion of the usual mistake.
 *   2. `Test Suites:` WAS NEVER READ. Only `Tests:`. Those two lines disagree
 *      exactly when a suite fails to run, which is the case that matters.
 *   3. A RED SUITE WAS NEVER ATTRIBUTED. The failure reported jest's summary
 *      LINE and discarded the captured detail, so an intermittent red could not
 *      be traced to a test afterwards — and neither could a real regression
 *      that surfaced once. That was the reported defect; the two above were
 *      found while fixing it.
 */
const {spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const FUNCTIONS_DIR = path.resolve(__dirname, '..');
const FLOOR_FILE = path.join(FUNCTIONS_DIR, 'test-floor.json');

const SUITES = {
  unit: {script: 'test', label: 'npm test'},
  rules: {script: 'test:rules', label: 'npm run test:rules'},
  // CRITICAL: A THIRD NUMBER, FOR A THIRD SURFACE. `unit` reads source against a fake
  // Firestore and `rules` judges a ruleset over documents the test invented;
  // neither ever ran a callable against a real database. That gap is how nine
  // family callables passed every gate while nothing had proven the feature
  // worked. Separate for the same reason unit and rules are separate: one
  // combined number lets a drop in one hide behind a rise in another.
  e2e: {script: 'test:e2e', label: 'npm run test:e2e'},
};

/** How many names to print inline before deferring to the saved log. */
const MAX_NAMED = 15;

/** Exit 2 rather than invent a number. A floor we cannot read is not a floor of 0. */
function readFloor(key) {
  if (!fs.existsSync(FLOOR_FILE)) {
    fail(2, `no floor file at ${FLOOR_FILE}. An absent floor is UNKNOWN, not zero.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(FLOOR_FILE, 'utf8'));
  } catch (e) {
    fail(2, `${FLOOR_FILE} is not valid JSON — ${e.message}`);
  }
  const entry = parsed[key];
  if (!entry || typeof entry.count !== 'number' || !Number.isFinite(entry.count)) {
    fail(2, `floor file has no usable "${key}.count". An absent floor is UNKNOWN, not zero.`);
  }
  // A recorded 0 is the bug this guard exists for: a literal zero in the file
  // defeats a `?? 0` fallback, and every run beats it.
  if (entry.count <= 0) {
    fail(2, `"${key}.count" is ${entry.count}. A count of 0 is not a floor — it is an unmeasured one.`);
  }
  return entry;
}

function fail(code, message) {
  console.error(`floor: ${message}`);
  process.exit(code);
}

/** Run the suite and hand back its combined output, or classify why it could not run. */
function runSuite(key) {
  const {script} = SUITES[key];
  const run = spawnSync('npm', ['run', '--silent', script], {
    cwd: FUNCTIONS_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: process.env,
  });
  const status = run.status;

  // BOTH streams, always. jest writes its `Tests:` summary to stderr, so
  // reading stdout alone finds no count and reports a suite that ran perfectly
  // as unmeasured. Caught by testing the pass path, which failed closed.
  const output = `${run.stdout || ''}${run.stderr || ''}`;

  if (/Java version before 21|no longer supports Java/i.test(output)) {
    fail(
      3,
      `${key}: the emulator refused to start — firebase-tools needs JDK 21+.\n` +
        `       Homebrew's openjdk@21 is installed but not linked, so the default java is older.\n` +
        `       Retry with: JAVA_HOME=/opt/homebrew/opt/openjdk@21 npm run floor:${key}\n` +
        `       This is an ENVIRONMENT failure, not a floor drop. The suite did not run.`,
    );
  }

  if (run.error) {
    fail(3, `${key}: could not run ${SUITES[key].label} — ${run.error.message}`);
  }

  return {output, status};
}

/**
 * Everything known about why a run is red, extracted from jest's own output.
 *
 * KEY: PURE, AND EXPORTED, SO IT CAN BE TESTED AGAINST REAL CAPTURED OUTPUT. The
 * fixtures in floorFailureReport.test.ts are literal jest output from runs made
 * on purpose — an assertion failure, a suite that could not compile, and the
 * actual SIGSEGV text from the W2-76 flake. An extractor tested against invented
 * output tests the author's memory of a format, which is exactly how three
 * extractor bugs reached main in #364/#365.
 *
 * WARNING: MEASURED, NOT ASSUMED: jest's default (non-verbose) reporter prints NO `✕`
 * lines. The per-test names appear only as `● describe › test` bullets in the
 * detail blocks. `✕` is still parsed below because `--verbose` emits it and a
 * future config change is cheap to survive, but it is not the primary source and
 * nothing depends on it.
 */
function describeFailure(output, status) {
  const testsLine = (output.match(/^Tests:.*$/m) || [''])[0].trim();
  const suitesLine = (output.match(/^Test Suites:.*$/m) || [''])[0].trim();

  const failedTestCount = Number(
    (output.match(/^Tests:.*?(\d+)\s+failed/m) || [0, 0])[1],
  );
  const failedSuiteCount = Number(
    (output.match(/^Test Suites:.*?(\d+)\s+failed/m) || [0, 0])[1],
  );

  const failedSuites = unique(
    [...output.matchAll(/^FAIL\s+(\S+)/gm)].map((m) => m[1]),
  );

  // `● Console` is jest's heading for captured console output and appears in
  // PASSING runs. `● Test suite failed to run` is a heading, not a test name.
  // Both would otherwise be reported as failing tests, and the first would make
  // this function claim failures on a green run.
  const BULLET_HEADINGS = new Set(['Console', 'Test suite failed to run']);
  const bullets = [...output.matchAll(/^\s*●\s+(.+?)\s*$/gm)].map((m) => m[1]);
  const ticks = [...output.matchAll(/^\s*✕\s+(.+?)(?:\s+\(\d+\s*m?s\))?\s*$/gm)]
    .map((m) => m[1]);

  const failedTests = unique(
    [...bullets, ...ticks].filter((name) => !BULLET_HEADINGS.has(name)),
  );

  const suiteFailedToRun = bullets.includes('Test suite failed to run');
  const workerCrash = /jest worker process.*terminated|signal=SIG/i.test(output);

  return {
    status,
    testsLine,
    suitesLine,
    failedTestCount,
    failedSuiteCount,
    failedSuites,
    failedTests,
    suiteFailedToRun,
    workerCrash,
    // CRITICAL: THE WHOLE POINT. `Tests:` can read perfectly green while the run is
    // red, because a suite that fails to RUN contributes zero tests. Any one of
    // these three is sufficient; the exit code alone would do, and the other two
    // are what let the report SAY something rather than only refuse.
    isRed:
      status !== 0 || failedTestCount > 0 || failedSuiteCount > 0 || suiteFailedToRun,
  };
}

function unique(items) {
  return [...new Set(items)];
}

/**
 * Turn a failure into something a human can act on without re-running anything.
 *
 * CRITICAL: IT MUST NEVER RENDER AN EMPTY FINDING AS A FINDING. If the run is red and
 * nothing could be named, this says so in those words and points at the saved
 * log. An extractor that quietly produces an empty list reads as "red, but
 * nothing wrong" — the vacuous-pass shape this repo has now been bitten by in
 * three separate gates.
 */
function renderFailure(key, report, logPath) {
  const lines = [];

  if (report.suiteFailedToRun || (report.failedSuiteCount > 0 && report.failedTestCount === 0)) {
    lines.push(
      `${key}: suite is RED — a suite FAILED TO RUN and reported no failing test.`,
    );
    lines.push(`       ${report.suitesLine}`);
    lines.push(`       ${report.testsLine}   <- reads green, and is not`);
    lines.push(
      '       ⚠️ A suite that fails to RUN contributes zero tests, so the count',
    );
    lines.push(
      '          does not drop and the floor cannot see it. jest exited ' +
        `${report.status}.`,
    );
  } else {
    lines.push(`${key}: suite is RED — ${report.testsLine}`);
    if (report.suitesLine) lines.push(`       ${report.suitesLine}`);
  }

  if (report.workerCrash) {
    lines.push(
      '       ⚠️ A jest WORKER CRASHED (signal, not an assertion). This is the',
    );
    lines.push(
      '          known intermittent shape — re-run before concluding a regression,',
    );
    lines.push('          and record it either way.');
  }

  if (report.failedTests.length > 0) {
    lines.push(`       failing tests (${report.failedTests.length}):`);
    for (const name of report.failedTests.slice(0, MAX_NAMED)) {
      lines.push(`         • ${name}`);
    }
    if (report.failedTests.length > MAX_NAMED) {
      lines.push(
        `         … and ${report.failedTests.length - MAX_NAMED} more — full list in the log.`,
      );
    }
  }

  if (report.failedSuites.length > 0) {
    lines.push(`       in ${report.failedSuites.length} suite(s):`);
    for (const file of report.failedSuites.slice(0, MAX_NAMED)) {
      lines.push(`         • ${file}`);
    }
  }

  if (report.failedTests.length === 0 && report.failedSuites.length === 0) {
    lines.push(
      '       🔴 THIS SCRIPT COULD NOT NAME THE FAILURE. The run is red and the',
    );
    lines.push(
      '          output matched no known jest failure shape. Do NOT read that as',
    );
    lines.push('          minor — read the log, and teach the extractor.');
  }

  if (logPath) {
    lines.push(`       full output: ${logPath}`);
  }

  return lines.join('\n');
}

function logPathFor(key) {
  return path.join(FUNCTIONS_DIR, `.floor-failure-${key}.log`);
}

/** Save the whole run so an intermittent can be diagnosed after the fact. */
function saveLog(key, output) {
  const logPath = logPathFor(key);
  try {
    fs.writeFileSync(logPath, output, 'utf8');
    return logPath;
  } catch {
    // Never let the diagnostic aid become the reason the gate cannot report.
    return null;
  }
}

/**
 * Delete this key's log once it passes.
 *
 * WARNING: A LOG THAT OUTLIVES ITS FAILURE IS WORSE THAN NO LOG. Whoever finds
 * `.floor-failure-unit.log` on disk has no way to tell whether it describes the
 * current tree or a run from three days ago, and its mtime says when it was
 * WRITTEN, not what it was written about. Given this file exists to make an
 * INTERMITTENT diagnosable, a stale copy is precisely the thing that would send
 * the next person after a failure that is already fixed.
 *
 * Per-key, so a green unit run never deletes the rules failure sitting next to
 * it.
 */
function clearLog(key) {
  try {
    fs.rmSync(logPathFor(key), {force: true});
  } catch {
    // Nothing to report: a leftover log is a nuisance, not a gate failure.
  }
}

/**
 * Read the count off jest's own summary line. Returns null when absent — which
 * means the suite did not report, NOT that it reported zero.
 */
function parseCount(output) {
  const match = output.match(/^Tests:.*?(\d+)\s+total/m);
  return match ? Number(match[1]) : null;
}

/**
 * The SUITE count off jest's other summary line.
 *
 * WARNING: Recorded alongside the test count because the two disagree exactly when a
 * suite fails to run — the defect in W2-78 — and because `suites` is a field in
 * every floor entry that was, until now, only ever typed in by hand.
 */
function parseSuiteCount(output) {
  const match = output.match(/^Test Suites:.*?(\d+)\s+total/m);
  return match ? Number(match[1]) : null;
}

/**
 * Argument parsing, so a FLAG CANNOT BECOME A SUITE NAME.
 *
 * WARNING: `main` read `argv[2]` as the suite. A bare `--ratchet` would therefore
 * have been looked up in SUITES, missed, and exited 2 — refusing, which reads
 * as a broken gate rather than as a misused flag. Flags are stripped first and
 * the first remaining token is the suite, so order does not matter.
 */
function parseArgs(argv) {
  const rest = argv.slice(2);
  const flags = new Set(rest.filter((a) => a.startsWith('--')));
  const positional = rest.filter((a) => !a.startsWith('--'));
  return {
    which: positional[0] || 'all',
    ratchet: flags.has('--ratchet'),
    record: flags.has('--record'),
  };
}

/**
 * What a measurement means, and what it should cost. Pure, and exported so the
 * decision can be driven in a unit test rather than by running two emulator
 * suites for minutes.
 *
 * KEY: THE MODE CHANGES THE CONSEQUENCE, NEVER THE DETECTION. A rise is a rise in
 * both modes and is reported identically in both; only `exitCode` differs. A
 * mode that also changed what was *seen* would give two operators two different
 * accounts of the same tree.
 *
 * CRITICAL: A DROP IS 1 IN BOTH MODES. Making the regression path conditional on a
 * flag would trade one silent failure for a worse one.
 */
function classifyFloor(measured, floorCount, opts) {
  if (measured < floorCount) return {outcome: 'drop', exitCode: 1};
  if (measured > floorCount) {
    return {outcome: 'rise', exitCode: opts && opts.ratchet ? 4 : 0};
  }
  return {outcome: 'at', exitCode: 0};
}

/**
 * The floor entry `--record` would write, or a refusal. Pure: no disk, no git.
 *
 * CRITICAL: IT SPREADS THE EXISTING ENTRY RATHER THAN BUILDING A NEW ONE, AND THAT IS
 * THE WHOLE SAFETY PROPERTY. test-floor.json is ~190KB and almost all of it is
 * provenance — dozens of underscore-prefixed keys recording how every previous
 * number was measured, including the reasoning that produced them. A writer
 * that serialised the four live fields would delete all of it, and NOTHING
 * downstream would notice: testFloor.test.ts checks only count, commit,
 * measured_at and note.
 *
 * KEY: `commit_is_pre_squash` IS COMPUTED, NOT ASKED FOR. It is the field four
 * consecutive landings recorded by hand and got wrong, and it is derivable: a
 * commit reachable from origin/main is not pre-squash, and a branch tip is.
 * Deriving it is most of the reason this write path is worth having at all.
 */
function planFloorUpdate(entry, measurement) {
  const {count, suites, commit, date, isAncestor} = measurement;
  if (count < entry.count) {
    return {
      refused:
        `would DROP ${entry.count} -> ${count}. A floor may rise and must never ` +
        'be lowered to make a red suite pass.',
    };
  }
  const archiveKey = `_previous_${entry.count}_at_${entry.commit}`;
  const next = {
    ...entry,
    count,
    suites,
    measured_at: date,
    commit,
    commit_is_pre_squash: !isAncestor,
    note:
      `Written by check-test-floor.cjs --record on ${date}. ` +
      `${entry.count}/${entry.suites} -> ${count}/${suites}, measured by ` +
      `\`${entry.command || 'the suite'}\` on ${commit}, which is ` +
      `${isAncestor ? 'an ANCESTOR of origin/main — git show reproduces it' :
        'NOT an ancestor of origin/main yet, so commit_is_pre_squash is true and ' +
        'this entry must be re-stamped on the integrated tip after the squash'}. ` +
      'A floor may RISE and may never be lowered; this writer refuses a drop ' +
      'rather than recording one.',
  };
  if (!(archiveKey in next)) next[archiveKey] = entry.note;
  return {entry: next};
}

/**
 * Run one suite and return what it measured, or exit.
 *
 * KEY: SHARED BY THE GATE AND THE WRITER ON PURPOSE. `--record` must refuse for
 * exactly the reasons the gate refuses — an unmeasured suite and a red suite
 * are both disqualifying, and a writer with its own copy of those checks is a
 * writer that will eventually disagree with the gate about what a valid
 * measurement is. Recording a number off a red run is the worst outcome
 * available here: it would bank a count that never passed.
 */
function measureOne(key) {
  const {output, status} = runSuite(key);
  const measured = parseCount(output);

  if (measured === null) {
    fail(
      3,
      `${key}: no "Tests: ... total" line in the output of ${SUITES[key].label}. ` +
        `The suite did not report a count, so it was NOT measured — this is not a count of 0.`,
    );
  }

  // CRITICAL: BEFORE the floor comparison, and deliberately. A red run's count is not
  // a measurement of anything: a crashed suite's tests are simply absent from
  // the total, so comparing that total to the floor asks the wrong question and
  // answers it reassuringly.
  const report = describeFailure(output, status);
  if (report.isRed) {
    fail(1, renderFailure(key, report, saveLog(key, output)));
  }

  return {count: measured, suites: parseSuiteCount(output)};
}

function checkOne(key, opts) {
  const floor = readFloor(key);
  const {count: measured} = measureOne(key);

  if (measured < floor.count) {
    fail(
      1,
      `${key}: FLOOR DROP — ${floor.count} → ${measured}, ${measured - floor.count}\n` +
        `       floor measured at ${floor.commit} on ${floor.measured_at}.\n` +
        `       Tests were removed or stopped running. Do not lower the floor to make this pass.`,
    );
  }

  clearLog(key);

  const decision = classifyFloor(measured, floor.count, opts || {});

  if (decision.outcome === 'rise') {
    // Printed in BOTH modes, identically. --ratchet changes what it costs, not
    // what you are told.
    console.log(
      `floor: ${key} OK — ${measured} (floor ${floor.count}, +${measured - floor.count}). ` +
        `Raise the floor in this commit or the gain drifts back.`,
    );
    if (decision.exitCode === 4) {
      fail(
        4,
        `${key}: UNBANKED RISE — ${floor.count} -> ${measured}. The gain is real and ` +
          'not recorded.\n' +
          `       floor last measured at ${floor.commit} on ${floor.measured_at}.\n` +
          `       Bank it: npm run floor:record\n` +
          '       This is exit 4, not 1 — nothing regressed. The tests exist and the\n' +
          '       floor does not protect them.',
      );
    }
    return;
  }

  console.log(`floor: ${key} OK — ${measured}, at the floor.`);
}

/** `git` in the repo, or null when it cannot answer. */
function git(args) {
  const run = spawnSync('git', args, {cwd: FUNCTIONS_DIR, encoding: 'utf8'});
  return run.status === 0 ? (run.stdout || '').trim() : null;
}

/**
 * Measure every named suite and write the floor.
 *
 * CRITICAL: IT SHORT-CIRCUITS THE GATE rather than judging and writing in one pass —
 * the shape factory_verify.py --record has had right for weeks. Judging and
 * recording in the same run would mean the only way to bank a gain is a
 * command that also has to pass, which is precisely the deadlock that makes
 * people hand-edit the file instead.
 *
 * WARNING: IT REFUSES A DROP RATHER THAN WRITING IT. There is no path here that
 * lowers a floor, so `--record` cannot be used to make a red suite pass.
 *
 * KEY: THE FILE IS READ, MUTATED KEY BY KEY, AND RE-SERIALISED — never rebuilt.
 * `JSON.stringify(parsed, null, 2)` round-trips this file byte-identically
 * (verified before this was written), so the ~190KB of provenance survives a
 * write untouched and the diff shows only the fields that moved.
 */
function recordAll(keys) {
  const commit = git(['rev-parse', '--short', 'HEAD']);
  if (!commit || !/^[0-9a-f]{7,40}$/.test(commit)) {
    fail(2, 'could not read HEAD — a floor entry must name a commit that reproduces it.');
  }
  // Exit 0 from `merge-base --is-ancestor` means reachable from main, so the
  // recorded commit is one `git show` can still resolve after the squash.
  const isAncestor =
    spawnSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main'], {
      cwd: FUNCTIONS_DIR,
    }).status === 0;
  const date = new Date().toISOString().slice(0, 10);

  const raw = fs.readFileSync(FLOOR_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  const written = [];

  for (const key of keys) {
    const entry = readFloor(key);
    const {count, suites} = measureOne(key);
    if (suites === null) {
      fail(3, `${key}: no "Test Suites: ... total" line — the suite count was not measured.`);
    }
    const plan = planFloorUpdate(entry, {count, suites, commit, date, isAncestor});
    if (plan.refused) {
      fail(1, `${key}: REFUSING to record — ${plan.refused}`);
    }
    parsed[key] = plan.entry;
    written.push(`${key}: ${entry.count}/${entry.suites} -> ${count}/${suites}`);
  }

  fs.writeFileSync(FLOOR_FILE, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  for (const line of written) console.log(`floor: recorded ${line}`);
  console.log(
    `floor: written at ${commit}, commit_is_pre_squash=${!isAncestor}` +
      (isAncestor
        ? ''
        : ' — this sha is NOT reachable from origin/main, so re-record on the ' +
          'integrated tip after the squash or the anchor is orphaned.'),
  );
}

function main(argv) {
  const opts = parseArgs(argv);
  const keys = opts.which === 'all' ? Object.keys(SUITES) : [opts.which];
  for (const key of keys) {
    if (!SUITES[key]) {
      fail(2, `unknown suite "${opts.which}". Use: ${Object.keys(SUITES).join(' | ')} | all`);
    }
  }
  if (opts.record) {
    recordAll(keys);
    return;
  }
  for (const key of keys) checkOne(key, opts);
}

/**
 * WARNING: GUARDED. Without this, `require`-ing the file to test `describeFailure`
 * would RUN BOTH SUITES as a side effect of the import — and the rules suite
 * needs an emulator, so the test would fail for a reason having nothing to do
 * with what it asserts.
 */
if (require.main === module) {
  main(process.argv);
}

module.exports = {
  describeFailure,
  renderFailure,
  parseCount,
  parseSuiteCount,
  parseArgs,
  classifyFloor,
  planFloorUpdate,
};
