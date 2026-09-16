// functions/src/__tests__/floorExitCodes.test.ts
//
// W2-21. The floor checker's exit codes are its contract, and nothing asserted
// them until now.
//
// ---------------------------------------------------------------------------
// 🔴 THE BRIEF'S PREMISE WAS FALSE, AND IT WAS MY CLAIM
// ---------------------------------------------------------------------------
//
// W2-20's return said: "a skipped run is indistinguishable from a green one at a
// glance." That is WRONG, and this brief was built on it. Measured with the
// default JVM (java 19, JDK 21 installed but unlinked):
//
//   npm run test:rules   -> EXIT 1   "firebase-tools no longer supports Java
//                                     version before 21."
//   npm run floor:rules  -> EXIT 3   "the emulator refused to start ... This is
//                                     an ENVIRONMENT failure, not a floor drop.
//                                     The suite did not run."
//   npm run floor        -> EXIT 3   (unit line still prints OK; the process
//                                     still exits non-zero)
//
// NOTHING SILENTLY PASSES. A skipped run and a passing run differ in exit code
// AND in text, and the text names the fix. The instrument was already correct;
// I asserted a hole from a glance instead of measuring, which is the exact error
// this session has spent all day cataloguing in other people's instruments.
//
// ---------------------------------------------------------------------------
// 🔑 SO WHAT IS WORTH BUILDING IS THE THING THAT MAKES THAT TRUE
// ---------------------------------------------------------------------------
//
// The safety property is: ENVIRONMENT IS NOT SUCCESS. Exit 3 rather than 0 is
// what stops "the suite did not run" being read as "the suite passed". It is a
// deliberate design — check-test-floor.cjs documents four distinct codes and
// says "an unmeasured suite must never be reported as a passing one" — and
// NOTHING ASSERTED IT.
//
// ⚠️ That absence is the real exposure, and it is one careless edit wide. A
// future someone unblocking CI, reasonably enough, makes the environment case
// exit 0 so a machine without a JDK stops failing the build. The comment stays,
// the message stays, and the hole the brief imagined becomes real. These tests
// make that edit fail here first.
//
// They read the source rather than spawning the checker: spawning it needs the
// emulator absent to reach the environment branch, which is a state a test
// cannot arrange without breaking the machine it runs on.

import * as fs from 'fs';
import * as path from 'path';
import {codeOf} from './helpers/sourceText';

const CHECKER_PATH = path.join(__dirname, '..', '..', 'scripts', 'check-test-floor.cjs');
const CHECKER = fs.readFileSync(CHECKER_PATH, 'utf8');

/**
 * 🔑 W2-29. CHECKER is the raw file and STAYS raw, because most of this suite
 * deliberately asserts DOCUMENTATION — that the exit-code contract is written
 * down, that the environment failure names its cause. Those must read comments.
 *
 * CHECKER_CODE is for the assertions about BEHAVIOUR: which exit codes the file
 * actually calls. Those must not be satisfiable by a comment mentioning a code.
 * Getting this split wrong in either direction is a lie: stripping the doc
 * assertions makes them vacuous, and not stripping the code ones makes them
 * satisfiable by prose. Each assertion below says which it is.
 */
const CHECKER_CODE = codeOf(CHECKER);

describe('the checker is the file we think it is', () => {
  test('it exists and is non-trivial', () => {
    // A guard that read the wrong path would pass everything — the same
    // vacuous-success failure claim.cjs warns about for zero paths.
    expect(CHECKER.length).toBeGreaterThan(1000);
    expect(CHECKER).toContain('check-test-floor');
  });

  test('package.json routes both floor scripts through it', () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
    );
    expect(pkg.scripts.floor).toContain('check-test-floor.cjs');
    expect(pkg.scripts['floor:rules']).toContain('check-test-floor.cjs');
  });
});

describe('🔴 an unmeasured suite must never exit 0', () => {
  test('the environment branch fails with 3, not 0', () => {
    // The single most important line in the file. If this becomes fail(0, ...)
    // or a bare return, a machine with the wrong JVM reports a green gate.
    // CODE assertion — a comment mentioning fail(3) must not satisfy it.
    expect(CHECKER_CODE).toMatch(/fail\(\s*3\s*,/);
    const envBranch = CHECKER_CODE.slice(
      CHECKER_CODE.indexOf('refused to start') - 400,
      CHECKER_CODE.indexOf('refused to start') + 400,
    );
    expect(envBranch).not.toMatch(/exit\(0\)/);
  });

  test('no fail() call passes 0 — fail must always be non-zero', () => {
    // CODE assertion.
    const codes = [...CHECKER_CODE.matchAll(/fail\(\s*(\d+)\s*,/g)].map((m) => Number(m[1]));
    expect(codes.length).toBeGreaterThan(4); // must not pass vacuously
    for (const c of codes) expect(c).toBeGreaterThan(0);
  });

  test('the four documented codes are all distinct and still used', () => {
    // 0 measured-and-ok · 1 below floor · 2 floor unknown · 3 suite did not run.
    // 2 and 3 exist separately because "the gate did not run" and "the gate
    // found nothing" are different facts a single non-zero exit would merge.
    // CODE assertion.
    const codes = new Set([...CHECKER_CODE.matchAll(/fail\(\s*(\d+)\s*,/g)].map((m) => m[1]));
    expect(codes.has('1')).toBe(true);
    expect(codes.has('2')).toBe(true);
    expect(codes.has('3')).toBe(true);
  });

  test('an absent or zero floor is UNKNOWN, never treated as passing', () => {
    // The other way a floor check can silently succeed: no floor file, or a
    // count of 0, read as "nothing to beat".
    expect(CHECKER).toMatch(/An absent floor is UNKNOWN, not zero/);
    expect(CHECKER).toMatch(/A count of 0 is not a floor/);
  });

  test('the exit-code contract is documented at the top of the file', () => {
    expect(CHECKER).toMatch(/Exit codes are the contract/);
    // Matched across the comment wrap — the sentence breaks after "An" and
    // resumes behind a " * " prefix, so a literal regex misses it.
    const unwrapped = CHECKER.split('\n').map((l) => l.replace(/^\s*\*\s?/, '')).join(' ');
    expect(unwrapped).toMatch(/an unmeasured suite must never be reported as a passing one/i);
  });
});

describe('the environment failure tells a human what to do', () => {
  test('it names the cause rather than only failing', () => {
    expect(CHECKER).toMatch(/needs JDK 21\+/);
    expect(CHECKER).toMatch(/ENVIRONMENT failure, not a floor drop/);
    expect(CHECKER).toMatch(/The suite did not run/);
  });

  test('⚠️ it currently hard-codes a Homebrew path, which is machine-specific', () => {
    // Recorded rather than fixed: the retry hint works here and reads as a
    // dead end on any machine without Homebrew, or with the JDK elsewhere. A
    // portable route (`/usr/libexec/java_home -v 21` on macOS) is the better
    // hint and is proposed in the W2-21 return rather than changed under a
    // brief whose disproof fired.
    expect(CHECKER).toContain('/opt/homebrew/opt/openjdk@21');
  });
});

// ---------------------------------------------------------------------------
// W2-166 · The advisory that cannot fail
// ---------------------------------------------------------------------------
//
// 🔴 THE DEFECT, MEASURED RATHER THAN ARGUED. On every run over a rise this
// checker printed the delta, named it, and gave the instruction:
//
//   floor: unit OK — 1596 (floor 1572, +24). Raise the floor in this commit
//                                            or the gain drifts back.
//
// …and exited 0. Three landings walked past it (#660, #662, #663) and the floor
// stopped protecting 24 tests. So this was never a missing detector — it is an
// ADVISORY THAT CANNOT FAIL, and CI reads exit 0 as success.
//
// ⚠️ AND THE FIX CANNOT BE "MAKE THE DEFAULT NON-ZERO". `npm run floor` runs
// legitimately mid-work, including inside /land, before anything is banked. A
// default that fails on the correct workflow is a gate that cries wolf and then
// gets RELAXED rather than debugged. So the failing behaviour is opt-in, and
// the tests below pin BOTH halves — that --ratchet fails, and that the default
// still does not.
//
// 🔑 WHY THESE ARE BEHAVIOURAL AND NOT SOURCE GREPS, unlike everything above.
// The decision is extracted into pure exported functions, so a test can drive
// the real logic without running two emulator suites for minutes. A grep for
// `fail(4` would pass against a branch that computes the wrong outcome.
//
// 📌 THE HOLE THIS CLOSES BEHIND ITSELF. Before this brief, a fifth exit code
// would have been guarded by NOTHING: the suite asserted membership of 1, 2 and
// 3, and the adjacent `codes.length` assertion counts `fail(` CALL SITES, not
// distinct codes — 7 of them, so deleting a new one leaves 6 and stays green.
// Verified before writing this, not assumed. `the set of exit codes is exactly
// these four` is the assertion that makes code 4 deletable-with-a-red-suite.

/* eslint-disable @typescript-eslint/no-var-requires */
const ratchet: {
  parseArgs: (argv: string[]) => {which: string; ratchet: boolean; record: boolean};
  classifyFloor: (
    measured: number,
    floorCount: number,
    opts: {ratchet: boolean},
  ) => {outcome: 'drop' | 'rise' | 'at'; exitCode: number};
  planFloorUpdate: (
    entry: Record<string, unknown>,
    measurement: {
      count: number;
      suites: number;
      commit: string;
      date: string;
      isAncestor: boolean;
    },
  ) => {refused: string} | {entry: Record<string, unknown>};
} = require('../../scripts/check-test-floor.cjs');

const {parseArgs, classifyFloor, planFloorUpdate} = ratchet;

describe('🔴 the advisory can fail now — but only when asked', () => {
  test('a rise exits 0 by DEFAULT, because /land runs this before banking', () => {
    // Done-when 2. The single most likely way to get this change reverted is a
    // default that reddens the correct workflow.
    const r = classifyFloor(1634, 1600, {ratchet: false});
    expect(r.outcome).toBe('rise');
    expect(r.exitCode).toBe(0);
  });

  test('🔴 the same rise under --ratchet exits 4', () => {
    // The whole point of the brief. Same inputs, same detection, different
    // consequence — the mode changes what happens, not what is seen.
    const r = classifyFloor(1634, 1600, {ratchet: true});
    expect(r.outcome).toBe('rise');
    expect(r.exitCode).toBe(4);
  });

  test('at the floor is 0 in both modes', () => {
    expect(classifyFloor(1634, 1634, {ratchet: false}).exitCode).toBe(0);
    expect(classifyFloor(1634, 1634, {ratchet: true}).exitCode).toBe(0);
    expect(classifyFloor(1634, 1634, {ratchet: true}).outcome).toBe('at');
  });

  test('a DROP is still 1 in both modes — --ratchet must not soften it', () => {
    // A mode that made the drop path conditional would trade one silent
    // failure for a worse one.
    expect(classifyFloor(1600, 1634, {ratchet: false})).toEqual({outcome: 'drop', exitCode: 1});
    expect(classifyFloor(1600, 1634, {ratchet: true})).toEqual({outcome: 'drop', exitCode: 1});
  });

  test('the rise code is DISTINCT from the drop code', () => {
    // 4 and 1 must not merge: "you gained tests and did not record them" and
    // "you lost tests" are different facts, and a caller branching on the exit
    // code has to tell them apart. Same reasoning that separated 2 from 3.
    const rise = classifyFloor(1700, 1634, {ratchet: true}).exitCode;
    const drop = classifyFloor(1600, 1634, {ratchet: true}).exitCode;
    expect(rise).not.toBe(drop);
    expect(rise).toBeGreaterThan(0);
  });
});

describe('a flag must not be read as a suite name', () => {
  // main() took argv[2] as the suite, so a bare `--ratchet` would have become
  // an unknown suite and exited 2 — refusing, which looks like a broken gate
  // rather than a misused flag.
  test('a bare flag leaves the suite as "all"', () => {
    expect(parseArgs(['node', 'f', '--ratchet'])).toEqual({
      which: 'all', ratchet: true, record: false,
    });
  });

  test('suite and flag together, in either order', () => {
    expect(parseArgs(['node', 'f', 'unit', '--ratchet']).which).toBe('unit');
    expect(parseArgs(['node', 'f', '--ratchet', 'unit']).which).toBe('unit');
    expect(parseArgs(['node', 'f', '--ratchet', 'unit']).ratchet).toBe(true);
  });

  test('no arguments is the unchanged default', () => {
    expect(parseArgs(['node', 'f'])).toEqual({which: 'all', ratchet: false, record: false});
  });

  test('--record parses independently of --ratchet', () => {
    expect(parseArgs(['node', 'f', '--record']).record).toBe(true);
    expect(parseArgs(['node', 'f', '--record']).ratchet).toBe(false);
  });
});

describe('🔴 the writer must not destroy the provenance it is editing', () => {
  // test-floor.json is ~190KB and almost all of it is history: dozens of
  // underscore-prefixed keys recording how every previous number was measured.
  // A writer that serialised the three suite entries would delete all of it,
  // and nothing downstream would notice — the shape test only checks the four
  // live fields.
  const entry = {
    count: 1634,
    suites: 73,
    measured_at: '2026-08-30',
    commit: 'e66181f',
    commit_is_pre_squash: true,
    command: 'npm test',
    note: 'the outgoing note, which is 40-odd characters long at least',
    _previous_1572: 'history that must survive',
    _provenance_w2_165: 'more history that must survive',
  };
  const measurement = {
    count: 1700, suites: 74, commit: '87c793f', date: '2026-08-31', isAncestor: true,
  };

  test('every underscore-prefixed key survives', () => {
    const result = planFloorUpdate(entry, measurement);
    expect('entry' in result).toBe(true);
    const next = (result as {entry: Record<string, unknown>}).entry;
    expect(next._previous_1572).toBe('history that must survive');
    expect(next._provenance_w2_165).toBe('more history that must survive');
  });

  test('the outgoing note is archived, not overwritten', () => {
    const next = (planFloorUpdate(entry, measurement) as {entry: Record<string, unknown>}).entry;
    expect(Object.values(next)).toContain(entry.note);
    expect(next.note).not.toBe(entry.note);
  });

  test('it refuses to lower a floor rather than writing the smaller number', () => {
    // factory_verify.py --record is the reference: monotonicity lives in the
    // WRITER, so there is no path that records a drop at all.
    const result = planFloorUpdate(entry, {...measurement, count: 1600});
    expect('refused' in result).toBe(true);
    expect((result as {refused: string}).refused).toMatch(/DROP|lower/i);
  });

  test('an unchanged count is allowed — a re-stamp is not a rise', () => {
    const result = planFloorUpdate(entry, {...measurement, count: 1634});
    expect('entry' in result).toBe(true);
  });

  test('🔑 commit_is_pre_squash is COMPUTED, not asked for', () => {
    // The field four landings got wrong by hand. An ancestor of main is
    // reachable, so it is not pre-squash; a branch tip is.
    const onMain = (planFloorUpdate(entry, {...measurement, isAncestor: true}) as
      {entry: Record<string, unknown>}).entry;
    const onBranch = (planFloorUpdate(entry, {...measurement, isAncestor: false}) as
      {entry: Record<string, unknown>}).entry;
    expect(onMain.commit_is_pre_squash).toBe(false);
    expect(onBranch.commit_is_pre_squash).toBe(true);
  });

  test('what it writes satisfies the shape testFloor.test.ts enforces', () => {
    // Otherwise the writer produces a file that fails the suite it just ran.
    const next = (planFloorUpdate(entry, measurement) as {entry: Record<string, unknown>}).entry;
    expect(typeof next.count).toBe('number');
    expect(next.count as number).toBeGreaterThan(0);
    expect(next.commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(next.measured_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(next.note).length).toBeGreaterThan(40);
  });
});

describe('the new code is documented and pinned', () => {
  test('🔴 the set of distinct exit codes is EXACTLY these four', () => {
    // The hole this closes: the assertion above counts `fail(` CALL SITES, so
    // deleting code 4 leaves 7 sites and stays green. This one goes red.
    const codes = new Set(
      [...CHECKER_CODE.matchAll(/fail\(\s*(\d+)\s*,/g)].map((m) => m[1]),
    );
    expect([...codes].sort()).toEqual(['1', '2', '3', '4']);
  });

  test('exit 4 is documented in the contract block, not just used', () => {
    // DOC assertion, raw on purpose: a caller reads the header to learn what
    // to branch on, and an undocumented code is one nobody can rely on.
    const unwrapped = CHECKER.split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, ''))
      .join(' ');
    expect(unwrapped).toMatch(/4\s+measured, and ABOVE the floor/i);
  });

  test('the default-stays-zero decision is written down, not just coded', () => {
    // The reason is the load-bearing part: the next person to "tidy" this by
    // making the default fail needs to meet the argument first.
    expect(CHECKER).toMatch(/cries wolf|would fail the correct workflow/i);
  });
});
