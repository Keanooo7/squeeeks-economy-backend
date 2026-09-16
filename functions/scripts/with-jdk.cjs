#!/usr/bin/env node
/**
 * Run a command with a JDK 21+ on PATH, resolving one if the default is older.
 *
 *   node scripts/with-jdk.cjs firebase emulators:exec --config ... "jest ..."
 *
 * ---------------------------------------------------------------------------
 * 🔴 WHY THIS EXISTS: TWO EMULATOR GATES WERE DOWN AND THE CAUSE WAS INVISIBLE
 * ---------------------------------------------------------------------------
 *
 * On 2026-08-16 both `npm run test:rules` and `npm run test:e2e` exited 1 in a
 * shell that had done nothing special:
 *
 *   Error: firebase-tools no longer supports Java version before 21.
 *   Please install a JDK at version 21 or above to get a compatible runtime.
 *
 * ⚠️ AND THAT MESSAGE IS WRONG ABOUT THIS MACHINE, WHICH IS THE TRAP. A JDK 21
 * WAS ALREADY INSTALLED — Homebrew, at /opt/homebrew/opt/openjdk@21, simply not
 * linked. The error says "install a JDK" about a JDK already present, so the
 * obvious response (install one) is a no-op that leaves the gate just as red.
 *
 * 🔑 `/usr/libexec/java_home -V` DOES NOT ENUMERATE HOMEBREW JDKs. It listed
 * only 19, 18 and 17 here, which is how a first reading concluded "no JDK 21 is
 * installed at all". `ls /opt/homebrew/opt` settled it. Any future diagnosis
 * that trusts java_home alone will reach the same wrong answer.
 *
 * ---------------------------------------------------------------------------
 * WHY A RESOLVER AND NOT THE TWO OBVIOUS ALTERNATIVES
 * ---------------------------------------------------------------------------
 *
 *   · `brew link openjdk@21` fixes it by changing the WHOLE MACHINE, for every
 *     tool, outside the repo and invisibly to it. Nothing in a checkout could
 *     then tell you why the gate works here and not on a fresh clone.
 *   · `JAVA_HOME=/opt/homebrew/opt/openjdk@21 …` inside the npm script fixes
 *     only this gate, but hard-codes an Apple-Silicon Homebrew path that an
 *     Intel mac (/usr/local), a Linux CI box, and a machine using SDKMAN or
 *     Temurin all lack — turning "no JDK" into "wrong path", which reports the
 *     same way.
 *
 * 🔴 THE BAR THE BRIEF SET, AND THE REASON EITHER SHORTCUT FAILS IT: a gate that
 * needs an undocumented shell tweak is the same species of defect as one that
 * needs a hand-started emulator. `npm run test:rules` must work in a shell that
 * did nothing special, on a machine nobody prepared.
 *
 * So: if the `java` already on PATH is new enough, this changes NOTHING and
 * execs straight through. Only when it is too old does it look for a newer one,
 * and it reports which JDK it chose so a passing run is never a mystery.
 */
'use strict';

const {execFileSync, spawn, spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const MIN_MAJOR = 21;

/**
 * The major version [javaBin] reports, or null if it cannot be run.
 *
 * 🔴 `java -version` WRITES TO STDERR, NOT STDOUT, AND THIS COST A RED GATE.
 * The first version of this function used `execFileSync`, which RETURNS STDOUT
 * ONLY — so the banner went into a piped stderr that nothing ever read, every
 * candidate parsed as null, and the script reported "no JDK 21+ found, and the
 * default `java` is missing" on a machine with FOUR JDKs installed and a
 * working `java` on PATH. The message was confident, specific and wrong in
 * exactly the direction that sends you looking at your PATH instead of at the
 * reader. `spawnSync` exposes both streams; both are searched, because a JDK
 * that logs the banner to stdout would otherwise fail the same silent way.
 */
function majorVersionOf(javaBin) {
  const res = spawnSync(javaBin, ['-version'], {encoding: 'utf8'});
  if (res.error) return null;
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  if (!out) return null;
  // `openjdk version "21.0.2"` and the legacy `java version "1.8.0_292"`.
  const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
  if (!m) return null;
  const first = Number(m[1]);
  return first === 1 ? Number(m[2] ?? 0) : first;
}

/** Candidate JAVA_HOME directories, best-effort and in preference order. */
function candidateHomes() {
  const homes = [];
  if (process.env.JAVA_HOME) homes.push(process.env.JAVA_HOME);

  // macOS's own registry. Listed for completeness — it does NOT report Homebrew
  // JDKs, which is exactly the gap that made this machine look bare.
  for (const v of ['21', '22', '23', '24', '25']) {
    try {
      const home = execFileSync('/usr/libexec/java_home', ['-v', v], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (home) homes.push(home);
    } catch {
      // No JDK at that version, or not macOS. Both are ordinary.
    }
  }

  // Homebrew, both architectures. `openjdk` (current) is tried after the pinned
  // casks so an explicit @21 wins over whatever `openjdk` happens to be today.
  for (const prefix of ['/opt/homebrew/opt', '/usr/local/opt']) {
    for (const name of ['openjdk@21', 'openjdk@22', 'openjdk@23', 'openjdk']) {
      // Homebrew's JDKs sit under libexec/openjdk.jdk/Contents/Home; the plain
      // directory works too on Linux-style layouts, so both are offered.
      homes.push(path.join(prefix, name, 'libexec', 'openjdk.jdk', 'Contents', 'Home'));
      homes.push(path.join(prefix, name));
    }
  }

  // SDKMAN and Temurin, the two most common non-Homebrew installs.
  if (process.env.HOME) {
    homes.push(path.join(process.env.HOME, '.sdkman', 'candidates', 'java', 'current'));
  }
  homes.push('/Library/Java/JavaVirtualMachines/temurin-21.jdk/Contents/Home');

  return homes;
}

function resolveJavaHome() {
  for (const home of candidateHomes()) {
    const javaBin = path.join(home, 'bin', 'java');
    if (!fs.existsSync(javaBin)) continue;
    const major = majorVersionOf(javaBin);
    if (major !== null && major >= MIN_MAJOR) return {home, major};
  }
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error('with-jdk: nothing to run. Usage: node scripts/with-jdk.cjs <command> [args…]');
    process.exit(2);
  }

  const env = {...process.env};

  const onPath = majorVersionOf('java');
  if (onPath !== null && onPath >= MIN_MAJOR) {
    // Nothing to do. The common case on a correctly-set-up machine, and the
    // case where this wrapper must be invisible.
  } else {
    const found = resolveJavaHome();
    if (!found) {
      // 🔴 REFUSE WITH THE DIAGNOSIS, NOT firebase-tools' MESSAGE. Its "install
      // a JDK" is what sent the first reader of this failure to install a JDK
      // that was already there.
      console.error(
        `\nwith-jdk: no JDK ${MIN_MAJOR}+ found, and the default \`java\` is ` +
          `${onPath === null ? 'missing' : `version ${onPath}`}.\n\n` +
          'firebase-tools requires 21+ to start any emulator, so the rules and\n' +
          'e2e gates cannot run without one.\n\n' +
          '  macOS:  brew install openjdk@21     (no `brew link` needed — this\n' +
          '                                       script finds an unlinked one)\n' +
          '  other:  install any JDK 21+ and set JAVA_HOME\n\n' +
          '⚠️  `/usr/libexec/java_home -V` does NOT list Homebrew JDKs, so it is\n' +
          '   not evidence that none is installed. Check `ls /opt/homebrew/opt`.\n',
      );
      process.exit(1);
    }
    env.JAVA_HOME = found.home;
    env.PATH = `${path.join(found.home, 'bin')}${path.delimiter}${env.PATH ?? ''}`;
    // Printed so a green run is never a mystery about WHICH java ran, and so a
    // machine silently resolving something unexpected is visible in the log.
    console.log(`with-jdk: default java is ${onPath ?? 'missing'}; using JDK ${found.major} at ${found.home}`);
  }

  // 🔑 NO SHELL. argv is passed through exactly as npm parsed it, so the single
  // quoted `jest …` argument that `emulators:exec` expects survives as ONE
  // argument. Re-quoting it through a shell is how that becomes several.
  const child = spawn(argv[0], argv.slice(1), {stdio: 'inherit', env});
  child.on('error', (err) => {
    console.error(`with-jdk: could not run \`${argv[0]}\` — ${err.message}`);
    process.exit(127);
  });
  // Preserve the child's exit code exactly: this wrapper sits inside a GATE,
  // and a wrapper that exits 0 over a failed suite is a gate that reports green
  // on red.
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 1);
  });
}

main();
