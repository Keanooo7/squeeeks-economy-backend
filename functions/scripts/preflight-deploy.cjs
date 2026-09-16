#!/usr/bin/env node
// ---------------------------------------------------------------------------
// preflight-deploy — refuse a deploy whose identity cannot be established
// ---------------------------------------------------------------------------
//
// W2-155. The sibling of `preflight:rules`, for the functions half.
//
// 🔴 IT REFUSES TWO STATES, AND THE SECOND IS THE ONE EVERY OTHER GATE MISSES:
//   1. a DIRTY tree — the stamp would name a commit that does not describe what
//      is being compiled;
//   2. a tree whose HEAD IS NOT AN ANCESTOR OF `origin/main` — the stale-checkout
//      case. `check-deployed-revision.cjs` names it in its own header: deploy
//      from a stale checkout and all 45 functions read "at or ahead" while
//      production runs week-old code. A dirty-only check cannot see it: the
//      tree is perfectly clean, just old.
//
// 🔴 WHY THIS IS NOT IN `npm run build`, WHICH IS WHERE IT LOOKS LIKE IT BELONGS.
// `build` is `tsc`, and it is called from THREE places: this predeploy hook,
// `npm run serve`, and `npm run test:e2e`. A dirty-tree refusal inside `build`
// would fail every e2e run on a working branch — on a tree that is dirty BY
// DEFINITION, because you are working on it. The gate belongs to the deploy and
// nowhere else. `serve` and `test:e2e` still call `build` and are untouched.
//
// 🔴 BRENDAN DEPLOYS, AND A GATE THAT STRANDS HIM GETS DELETED WITHIN A DAY AND
// THEN PROTECTS NOTHING. So the refusal prints the exact command to proceed, and
// the override is a loud env var in the `CLAIM_OVERRIDE=1` shape — deliberate,
// greppable in a shell transcript afterwards, and it says so in its own output.
//
//   DEPLOY_UNIDENTIFIED=1 firebase deploy --only functions
//
// EXIT CODES
//   0  identity established — the stamp was written
//   1  REFUSED — dirty tree, or HEAD is not an ancestor of origin/main
//   2  could not tell (no git, no origin/main) — NOT a pass
//
// ⚠️ EXIT 2 IS NOT A PASS, for the same reason `check-deployed*.cjs` splits 1
// from 3: "could not ask" must never read as "asked, and fine".

'use strict';

const {execFileSync, spawnSync} = require('child_process');
const path = require('path');

const REPO = path.join(__dirname, '..', '..');
const OK = 0;
const REFUSED = 1;
const CANNOT_TELL = 2;

/**
 * The one path a deploy is ALLOWED to have dirtied.
 *
 * 🔴 WITHOUT THIS THE GATE BREAKS ON ITS OWN SUCCESS. The stamp is a committed
 * generated module (see gen-build-info.cjs), so a completed deploy leaves the
 * tree dirty in exactly this file — and the next deploy would refuse, pointing
 * at a change this very script caused. Excluded by exact path, never by pattern.
 */
const STAMP_PATH = 'functions/src/buildInfo.generated.ts';

const OVERRIDE = 'DEPLOY_UNIDENTIFIED';

function git(args) {
  return execFileSync('git', args, {cwd: REPO, encoding: 'utf8'}).trim();
}

/**
 * `git status --porcelain`, parsed. NOT via `git()` — and that is not fussiness.
 *
 * 🔴 `.trim()` ON THE WHOLE OUTPUT CORRUPTS THE FIRST LINE ONLY. Porcelain
 * format is `XY<space>path`, and an unstaged modification is ` M path` — a
 * LEADING SPACE. Trimming the multi-line blob strips it from the first entry and
 * nothing else, so `slice(3)` then eats the first character of that one path.
 * Observed: ` M firebase.json` was reported as `irebase.json`.
 *
 * ⚠️ IT IS INTERMITTENT BY CONSTRUCTION — harmless when the first entry is `??`
 * or a staged change, wrong when it is an unstaged modification. A refusal that
 * misnames the file it is refusing over is worse than no refusal.
 */
function porcelain() {
  const raw = execFileSync('git', ['status', '--porcelain'], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return raw
    .split('\n')
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3).trim());
}

function refuse(reasonLines) {
  console.error(
    '\n🔴 preflight:deploy REFUSED — this deploy could not be identified.\n\n' +
      reasonLines.map((l) => `  ${l}`).join('\n') +
      '\n\n' +
      '  WHY IT MATTERS: every other deployment check in this repo reads an\n' +
      '  UPLOAD TIME, never content. If the sha stamped into the bundle does not\n' +
      '  describe what is being compiled, `check-deployed-revision.cjs` will\n' +
      '  report production current while it runs something else entirely.\n\n' +
      '  TO PROCEED ANYWAY, deliberately:\n\n' +
      `      ${OVERRIDE}=1 firebase deploy --only functions\n\n` +
      '  That is greppable in your shell history afterwards, which is the point.\n',
  );
  process.exit(REFUSED);
}

/**
 * The whole decision, as a pure function of three facts. Exported and pinned by
 * `preflightDeploy.test.ts`.
 *
 * 🔴 SPLIT OUT FOR THE SAME REASON `classify` WAS IN W2-154: the credentialled,
 * git-touching half cannot be unit-tested, so the half that DECIDES must not be
 * tangled up in it. Everything above this line runs git; this runs nothing.
 *
 * ⚠️ THE ORDER OF THE CHECKS IS PART OF THE CONTRACT. Override wins over both
 * refusals — otherwise the escape hatch does not escape — and `dirty` is
 * reported before `behind` so a developer who is both fixes the one they can
 * see in `git status` first.
 *
 * @returns {{code: number, reason: string}} `reason` is a stable token, not
 *   prose: the test pins it, and prose that reads well is edited freely.
 */
function decide({dirty, behind, override}) {
  if (override) return {code: OK, reason: 'override'};
  if (dirty.length) return {code: REFUSED, reason: 'dirty'};
  if (behind > 0) return {code: REFUSED, reason: 'behind'};
  return {code: OK, reason: 'clean'};
}

function main() {
  if (decide({dirty: [], behind: 0, override: process.env[OVERRIDE] === '1'}).reason === 'override') {
    // Loud on purpose. An override that is quiet is an override nobody
    // remembers using.
    console.log(
      `⚠️  ${OVERRIDE}=1 — identity checks SKIPPED by explicit request.\n` +
        '   The stamp is still written, so the logs will say what was compiled.',
    );
    stamp();
    process.exit(OK);
  }

  let dirty;
  try {
    dirty = porcelain().filter((p) => p !== STAMP_PATH);
  } catch (e) {
    console.error(`\nCANNOT TELL: git status failed — ${e.message}\n  This is not a pass.\n`);
    process.exit(CANNOT_TELL);
  }

  if (decide({dirty, behind: 0, override: false}).reason === 'dirty') {
    refuse([
      `THE TREE IS DIRTY — ${dirty.length} path(s) differ from HEAD:`,
      ...dirty.slice(0, 8).map((p) => `    ${p}`),
      ...(dirty.length > 8 ? [`    …and ${dirty.length - 8} more`] : []),
      '',
      'The stamp would name a commit that does not describe what is compiled.',
      `(${STAMP_PATH} is excluded — a deploy rewrites it by design.)`,
    ]);
  }

  // 🔴 THE STALE-CHECKOUT CASE. `git merge-base --is-ancestor HEAD origin/main`
  // exits 0 when HEAD is reachable from origin/main — i.e. HEAD is main or an
  // ancestor of it. Exit 1 means HEAD carries commits main does not, which is
  // ALSO fine (deploying a feature branch is legitimate), so the refusal is on
  // the OTHER direction: main has commits HEAD does not.
  let behind;
  try {
    git(['rev-parse', '--verify', 'origin/main']);
    behind = git(['rev-list', '--count', 'HEAD..origin/main']);
  } catch (e) {
    console.error(
      `\nCANNOT TELL: could not resolve origin/main — ${e.message}\n` +
        '  Run `git fetch` first. This is not a pass.\n',
    );
    process.exit(CANNOT_TELL);
  }

  if (decide({dirty: [], behind: Number(behind), override: false}).reason === 'behind') {
    const head = git(['rev-parse', '--short', 'HEAD']);
    refuse([
      `THIS CHECKOUT IS ${behind} COMMIT(S) BEHIND origin/main.`,
      `    HEAD        ${head}`,
      `    origin/main ${git(['rev-parse', '--short', 'origin/main'])}`,
      '',
      'This is the STALE-CHECKOUT case, and it is the one a dirty-tree check',
      'cannot see: the tree is perfectly clean, just old. Deploying from here',
      'ships code that is behind main while every timestamp-based check reports',
      'production "at or ahead".',
      '',
      'Fix:  git pull --ff-only     (or deploy from a tree that is up to date)',
    ]);
  }

  stamp();
  console.log(
    `preflight:deploy OK — clean tree, ${
      Number(behind) === 0 ? 'level with' : ''
    } origin/main.`,
  );
  process.exit(OK);
}

function stamp() {
  // Delegated rather than inlined so `gen-build-info.cjs` stays runnable on its
  // own — it is what a developer reaches for to see what WOULD be stamped.
  const r = spawnSync(process.execPath, [path.join(__dirname, 'gen-build-info.cjs')], {
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    console.error('\npreflight:deploy: the stamp failed. Refusing to continue.\n');
    process.exit(CANNOT_TELL);
  }
}

// 🔑 THE PURE HALF IS EXPORTED AND TESTED; the git-touching half cannot be —
// the same split as check-deployed-revision.cjs (W2-154) and its two siblings.
module.exports = {decide, STAMP_PATH, OVERRIDE, OK, REFUSED, CANNOT_TELL};

// 🔴 GUARDED. preflightDeploy.test.ts `require`s this file, and an unguarded
// main() would shell out to git and process.exit() inside a jest worker.
if (require.main === module) {
  main();
}
