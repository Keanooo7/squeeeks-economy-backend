#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-deployed-revision — is production running the code on this branch?
// ---------------------------------------------------------------------------
//
// W2-106. `check-deployed.cjs` asks WHICH functions exist in production.
// `check-rules-deployed.cjs` asks whether the live ruleset matches the file.
// Neither asks whether the deployed functions are built from THIS COMMIT — so
// a merged fix could be reported "declared, and live" while production ran the
// revision from before it.
//
// 🔴 THAT WAS NOT HYPOTHETICAL WHEN THIS WAS WRITTEN. On 2026-08-16, #472 fixed
// a restore path that could move a paid subscriber's expiry BACKWARDS. It
// merged at 09:57:56Z. The deployed functions were built at 07:17:18Z. For
// nearly three hours the fix was on `main`, green, and doing nothing for a
// single live subscriber — and every existing gate said the callable was
// deployed, because it was. Just not this one.
//
//     make check-deployed-revision
//
// EXIT CODES — the same three-way split as its two siblings, for the same
// reason: "could not ask" must never read as "asked, and fine".
//   0  EVERY measured function is at or ahead of the last commit that changed
//      functions/src
//   1  STALE — at least one measured function predates it
//   3  ENVIRONMENT — could not ask, or could not tell
//
// ---------------------------------------------------------------------------
// 🔴 THE VERDICT WAS SET BY `max()` UNTIL 2026-08-25, AND THAT WAS WRONG IN BOTH
// DIRECTIONS. (W2-154.)
// ---------------------------------------------------------------------------
//
// This script used to compute `newest` and `oldest`, print both, and then decide
// on `newest` alone. A single function redeployed on its own moves `newest` and
// tells you nothing about the other forty-four.
//
// 🔴 IT UNDER-REPORTED BY NINETY-FOLD, MEASURED. On 2026-08-24 the fleet was
// uploaded at 07:19Z, `sendStreakReminder` alone at 15:13Z, and the last
// functions/src commit landed 15:19Z. `newest` gave "STALE by 5 minutes". The
// true staleness for 44 of 45 functions was 7 h 59 min.
//
// 🔴 AND THE ALL-CLEAR IS THE MORE DANGEROUS HALF. Two hours later, after a real
// full deploy, the same script printed `UP TO DATE` and was quoted as proof the
// fleet was current. The verdict was right and the reasoning was worthless — a
// `max()` cannot tell "everything moved" from "one thing moved" EITHER WAY, and
// nobody re-checks a green. **When a gate's verdict logic is found broken, its
// PASS is void too, not just its failure.**
//
// ⚠️ `oldest` IS NOT THE FIX AND IS DELIBERATELY NOT USED AS THE VERDICT. One
// rarely-touched function would pin this red forever, and a gate that cries wolf
// gets relaxed rather than debugged — which is how this project loses gates.
//
// ✅ THE VERDICT IS NOW PER-FUNCTION: every measured function is compared against
// the commit, and the output states COUNTS — how many are behind, by how much,
// and how many could not be measured at all. `newest` and `oldest` are still
// printed, because they are the diagnostic that exposed this.
//
//     node functions/scripts/check-deployed-revision.cjs --self-test
//
// replays both historical states from fixtures captured out of production and
// asserts the verdicts. It asks production for nothing.
//
// ---------------------------------------------------------------------------
// 🔴 WHAT A PER-FUNCTION VERDICT STILL CANNOT SEE — asked deliberately, because
// the max() defect was found by asking what an aggregate could not see.
// ---------------------------------------------------------------------------
//
// 1. A DEPLOY LATER THAN A COMMIT DOES NOT PROVE THE DEPLOY CONTAINED IT.
//    `generation` is when the source zip was UPLOADED, never what was inside it.
//    Deploy from a stale checkout and all 45 read "at or ahead" while production
//    runs anything at all. This script fixed the AGGREGATION, not the semantics.
//    The content instrument is `labels["firebase-functions-hash"]`, which is not
//    reproducible off this machine — see the 2026-08-25 deployment-drift review,
//    §7. **Nothing here can answer "which sha is live".**
//
// 2. THE COMMIT COMES FROM `HEAD` IN THE DIRECTORY THIS RUNS FROM. Run it in a
//    worktree behind `main` and the commit it compares against is older, so
//    production looks current. That is BY DESIGN — the question is "is production
//    running the code on THIS branch" — but it means A STALE CHECKOUT PRODUCES A
//    GREEN, and the green looks identical to a real one.
//
// ⚠️ Both are false-GREEN modes, and the lesson of the bug this replaced is that
// a green nobody re-checks is worse than a red nobody believes.
//
// ⚠️ `make` COLLAPSES 1 AND 3 TO 2. Run the script directly and read $? when you
// need to tell "production is behind" from "I could not find out".
//
// ---------------------------------------------------------------------------
// WHAT `generation` ACTUALLY IS, BECAUSE THE ANSWER DECIDED THE DESIGN
// ---------------------------------------------------------------------------
//
// 🔑 IT IS A MICROSECOND EPOCH TIMESTAMP, NOT AN OPAQUE OBJECT ID. Every gen2
// function carries `source.storageSource.generation` — the GCS object
// generation of the uploaded source zip — and dividing by 1000 gives a real
// deploy time:
//
//     1786864638597972  ->  2026-08-16T07:17:18.597Z
//
// That is the whole reason this checker can exist WITHOUT A STORED BASELINE. It
// is not "did this change since I last looked", which would need a committed
// value that nobody updates and that rots into a permanent pass. It is an
// absolute time, comparable directly against a commit date. Nothing to keep in
// step, nothing to forget.
//
// ⚠️ IT IS NOT A GIT SHA, and this script never pretends otherwise. It cannot
// tell you WHICH commit was deployed — only whether the deploy happened before
// or after the last commit that could have changed the deployed behaviour. That
// is strictly weaker and it is enough for the question being asked.
//
// ⚠️ AND THE TWO TIMESTAMPS COME FROM DIFFERENT CLOCKS — a commit date is
// stamped by the committer's machine, a generation by Google. Skew of seconds
// is possible and this comparison does not try to be exact; the gap that
// matters in practice is hours, and SKEW_TOLERANCE_MS makes a near-tie report
// ENVIRONMENT rather than guessing.

'use strict';

const {execFileSync} = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');

const OK = 0;
const STALE = 1;
const ENVIRONMENT = 3;

/**
 * A deploy within this of the commit is TOO CLOSE TO CALL.
 *
 * Two clocks, and a deploy that legitimately followed a commit by a few seconds
 * is indistinguishable from one that preceded it. Reporting either verdict
 * confidently there would be inventing precision the inputs do not have.
 */
const SKEW_TOLERANCE_MS = 120_000;

function fail(code, message) {
  console.error(`\n${code === ENVIRONMENT ? 'ENVIRONMENT' : 'STALE'}: ${message}\n`);
  process.exit(code);
}

/**
 * The last commit reachable from HEAD that touched DEPLOYED function source.
 *
 * 🔴 `__tests__` IS EXCLUDED, AND THE FIRST VERSION OF THIS SCRIPT PROVED WHY
 * WITHIN A MINUTE OF LANDING. It compared against all of `functions/src`, so
 * the commit that ADDED THIS SCRIPT'S OWN TEST FILE became the newest "change
 * to functions/src" and production was reported 190 minutes stale — when the
 * last change to anything deployable was 30 minutes older than that and the
 * real staleness was 160.
 *
 * ⚠️ THE VERDICT HAPPENED TO BE RIGHT, WHICH IS WHAT MAKES IT DANGEROUS. Both
 * numbers said STALE, so nothing looked wrong. Left alone, every test-only
 * commit would report a deployment problem that does not exist — and a gate
 * that cries wolf gets relaxed rather than debugged, which is the specific
 * failure this brief was told to avoid.
 *
 * Jest never ships: `functions/src/__tests__` is not in the deployed bundle, so
 * a change there cannot make production stale by definition.
 */
function lastFunctionSourceCommit() {
  let out;
  try {
    out = execFileSync(
      'git',
      [
        'log',
        '-1',
        '--format=%H %cI',
        'HEAD',
        '--',
        'functions/src',
        ':!functions/src/__tests__',
      ],
      {cwd: REPO, encoding: 'utf8'},
    ).trim();
  } catch (e) {
    return {error: `git log failed — ${e.message}`};
  }
  if (!out) return {error: 'no commit in history touches functions/src'};
  const [sha, iso] = out.split(' ');
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return {error: `unparseable commit date "${iso}"`};
  return {sha, iso, ms};
}

/** Uncommitted work under functions/src — the commit is not the whole story. */
function dirtyFunctionSource() {
  try {
    // Same exclusion as the commit lookup, for the same reason: an edited test
    // file is not an undeployed behaviour change, and warning about one trains
    // the reader to skim past the warning that matters.
    const out = execFileSync(
      'git',
      ['status', '--porcelain', '--', 'functions/src', ':!functions/src/__tests__'],
      {cwd: REPO, encoding: 'utf8'},
    ).trim();
    return out ? out.split('\n').length : 0;
  } catch {
    return 0;
  }
}

function listDeployed() {
  let out;
  try {
    out = execFileSync('npx', ['firebase', 'functions:list', '--json'], {
      cwd: REPO,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (e) {
    fail(
      ENVIRONMENT,
      `could not ask production — \`npx firebase functions:list\` failed.\n\n` +
        '  🔴 THE LIKELIEST CAUSE IS THIS DIRECTORY, NOT YOUR LOGIN.\n' +
        '  firebase-tools binds an account PER ABSOLUTE DIRECTORY. The root\n' +
        '  checkout is bound to the account that owns the project; A FRESH\n' +
        '  WORKTREE IS NOT, and every call 403s in a way that reads like a\n' +
        '  revoked login.\n\n' +
        '  Fix, in THIS directory:  npx firebase login:use <the owning account>\n' +
        '  Or run it from the root checkout, which is already bound.\n\n' +
        `  (${e.message})`,
    );
  }
  try {
    return JSON.parse(out);
  } catch (e) {
    fail(ENVIRONMENT, `functions:list returned unparseable JSON — ${e.message}`);
  }
}

/**
 * Sort every deployed function into behind / current / too-close / unmeasured.
 *
 * 🔴 PURE ON PURPOSE. Everything above this line talks to git or to production;
 * this does not, which is what lets `--self-test` replay two real historical
 * states without a network call or a credential.
 *
 * ⚠️ A FUNCTION WITH NO `generation` IS `unmeasured` AND IS NEVER A MEMBER OF
 * ANY OTHER BUCKET. `onNewUserBefriendGibby` is gcfv1 and exposes no
 * `storageSource`, so this script has never been able to speak for it — before
 * a deploy or after one. It must not be folded into an "N of N current" line:
 * a thing you could not measure is not a thing you found clean.
 */
function classify(fns, commitMs) {
  const behind = [];
  const current = [];
  const tooClose = [];
  const unmeasured = [];

  for (const f of fns) {
    const gen = f?.source?.storageSource?.generation ?? f?.generation;
    const ms = gen == null ? NaN : Number(gen) / 1000;
    if (!Number.isFinite(ms) || ms <= 0) {
      unmeasured.push({id: f.id, platform: f.platform});
      continue;
    }
    const entry = {id: f.id, ms, delta: ms - commitMs};
    // Two clocks — a commit date is the committer's machine, a generation is
    // Google's. A near-tie is not a verdict, it is the absence of one.
    if (Math.abs(entry.delta) < SKEW_TOLERANCE_MS) tooClose.push(entry);
    else if (entry.delta < 0) behind.push(entry);
    else current.push(entry);
  }
  return {behind, current, tooClose, unmeasured};
}

/** `1h 04m` / `7h 59m` / `42s` — a duration a person can read at a glance. */
function human(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * ⚠️ SUPERSEDED AS THE VERDICT, KEPT AS A DIAGNOSTIC AND AN EXPORT (W2-154).
 *
 * Until 2026-08-25 `main()` decided on this function's `newest` alone, which is
 * the defect documented in the header. `classify()` below is what decides now.
 *
 * 🔴 IT IS NOT DEAD CODE AND MUST NOT BE DELETED: `deployedRevision.test.ts`
 * imports it and pins the two fail-open cases — a garbage-but-finite `newest`,
 * and a `counted` that ignores gen1. Those properties are still worth pinning;
 * only the CALLER was wrong. Removing it turns nine jest suites red for a
 * reason that has nothing to do with what they test.
 */
/**
 * The newest deploy time across all gen2 functions, plus what was skipped.
 *
 * 🔴 FUNCTIONS WITHOUT A GENERATION ARE EXCLUDED AND NAMED, NEVER TREATED AS
 * ZERO. `onNewUserBefriendGibby` is gcfv1 and exposes no `storageSource`, so a
 * naive `Math.min` over the whole list reports 1970-01-01 and any comparison
 * against it screams "catastrophically stale" forever. Skipping silently would
 * be worse: it would mean a v1 function could never be reported stale and
 * nobody would know it was unwatched.
 */
function summariseDeploys(listJson) {
  const fns = Array.isArray(listJson?.result) ? listJson.result : null;
  if (!fns) return {error: 'functions:list returned no result array'};
  if (fns.length === 0) return {error: 'functions:list returned zero functions'};

  const timed = [];
  const untimed = [];
  for (const f of fns) {
    const gen = f?.source?.storageSource?.generation;
    const ms = gen == null ? NaN : Number(gen) / 1000;
    if (Number.isFinite(ms) && ms > 0) timed.push({id: f.id, ms});
    else untimed.push(f.id);
  }
  if (timed.length === 0) {
    return {error: 'no function reported a usable source generation'};
  }
  const newest = timed.reduce((a, b) => (a.ms >= b.ms ? a : b));
  const oldest = timed.reduce((a, b) => (a.ms <= b.ms ? a : b));
  return {newest, oldest, counted: timed.length, untimed};
}


/**
 * Render the report and return the exit code. Pure — see `classify`.
 *
 * 🔑 THE SPREAD IS A DIAGNOSTIC, NOT A VERDICT INPUT, AND THE DISTINCTION IS THE
 * WHOLE CRYING-WOLF BOUNDARY. A wide spread means several deploy events, which
 * is perfectly normal when nothing has changed since; it is only alarming when
 * something IS behind, and that is already its own line. Making a wide spread
 * fail would turn every surgical `--only functions:<name>` deploy red.
 */
function report(commit, c) {
  const measured = c.behind.length + c.current.length + c.tooClose.length;
  const timed = [...c.behind, ...c.current, ...c.tooClose].sort((a, b) => a.ms - b.ms);

  console.log(`last functions/src commit:  ${commit.sha.slice(0, 7)}  ${commit.iso}`);
  console.log(
    `deployed functions:         ${measured} measured` +
      (c.unmeasured.length ? ` · ${c.unmeasured.length} UNMEASURED` : ''),
  );

  if (timed.length) {
    // Kept from the pre-2026-08-25 script on purpose: these two lines are the
    // diagnostic that exposed the max() defect, and deleting them would remove
    // the evidence along with the bug.
    const oldest = timed[0];
    const newest = timed[timed.length - 1];
    console.log(`  oldest deploy:            ${oldest.id}  ${iso(oldest.ms)}`);
    console.log(`  newest deploy:            ${newest.id}  ${iso(newest.ms)}`);
    const spread = newest.ms - oldest.ms;
    console.log(
      `  generation spread:        ${human(spread)}` +
        (spread > SKEW_TOLERANCE_MS
          ? '   (several deploy events — diagnostic only, not a failure)'
          : '   (one deploy event)'),
    );
  }

  console.log(`  at or ahead of commit:    ${c.current.length}`);
  console.log(`  BEHIND the commit:        ${c.behind.length}`);
  console.log(`  too close to call:        ${c.tooClose.length}`);

  if (c.unmeasured.length) {
    // 🔴 Named, every run, never counted. See classify().
    for (const u of c.unmeasured) {
      console.log(
        `  NOT MEASURED:             ${u.id}  — ${u.platform || 'gcfv1'} exposes no ` +
          'storageSource, so this script cannot date it. Not a clean result.',
      );
    }
  }

  if (c.behind.length) {
    const worst = c.behind.reduce((a, b) => (a.delta <= b.delta ? a : b));
    const least = c.behind.reduce((a, b) => (a.delta >= b.delta ? a : b));
    console.error(
      `\nSTALE: ${c.behind.length} of ${measured} measured function(s) predate the last ` +
        `change to functions/src.\n\n` +
        `  furthest behind:  ${worst.id}  ${iso(worst.ms)}  (${human(worst.delta)} behind)\n` +
        `  least behind:     ${least.id}  ${iso(least.ms)}  (${human(least.delta)} behind)\n` +
        `  Committed:        ${commit.iso}  (${commit.sha.slice(0, 7)})\n\n` +
        '  🔴 READ THE COUNT, NOT THE SMALLEST GAP. A single function redeployed\n' +
        '  on its own says nothing about the rest — that is exactly the reading\n' +
        '  this script used to print, and it under-reported by ninety-fold.\n\n' +
        '      npx firebase deploy --only functions\n\n' +
        '  ⚠️ Deploying is a human act and this script deliberately does not do it.',
    );
    return STALE;
  }

  if (c.tooClose.length) {
    console.error(
      `\nENVIRONMENT: ${c.tooClose.length} function(s) are within the ` +
        `${SKEW_TOLERANCE_MS / 1000}s skew tolerance of the commit.\n` +
        '  Two different clocks. Too close to call, and guessing here would\n' +
        '  invent precision the inputs do not have. Re-run once the gap is\n' +
        '  unambiguous.',
    );
    return ENVIRONMENT;
  }

  console.log(
    `\nfunctions: UP TO DATE — all ${measured} measured function(s) were deployed after ` +
      `the last change to functions/src.` +
      (c.unmeasured.length
        ? `\n⚠️ ${c.unmeasured.length} function(s) above could NOT be measured and are not covered ` +
          'by that sentence.'
        : ''),
  );
  return OK;
}

// ---------------------------------------------------------------------------
// --self-test — the two historical states, replayed
// ---------------------------------------------------------------------------
//
// 🔑 THESE ARE CAPTURED FROM PRODUCTION, NOT INVENTED. Both arrays are the real
// `firebase functions:list --json` output reduced to the three fields the
// verdict reads. DRIFT is 2026-08-25T01:54Z, CLEAN is 2026-08-25T04:02Z.
//
// 🔴 THE THIRD CASE IS THE ONE THAT MATTERS AND IT IS DRIFT SHIFTED BY SIX
// MINUTES. In the real DRIFT state every function predates the commit, so the
// old `newest` reading was merely WRONG ABOUT THE MAGNITUDE. Move
// `sendStreakReminder` six minutes later — which is where it nearly landed — and
// the old script prints `UP TO DATE` over 44 functions that are eight hours
// stale. That is the false GREEN, and a fix that does not catch it has not
// earned the change.

const FIXTURE_DRIFT = [
  {id: 'adminGrant', platform: 'gcfv2', generation: '1787555993788315'},
  {id: 'appStoreNotificationsV2', platform: 'gcfv2', generation: '1787555976110086'},
  {id: 'assignFamilyChore', platform: 'gcfv2', generation: '1787555976120220'},
  {id: 'awardStreakReward', platform: 'gcfv2', generation: '1787555975943478'},
  {id: 'backfillGibbyFriendship', platform: 'gcfv2', generation: '1787555975823497'},
  {id: 'backfillPublicProfiles', platform: 'gcfv2', generation: '1787555975811823'},
  {id: 'claimDailyGift', platform: 'gcfv2', generation: '1787555976012471'},
  {id: 'claimGift', platform: 'gcfv2', generation: '1787555976031763'},
  {id: 'claimMinigamePrize', platform: 'gcfv2', generation: '1787555975727817'},
  {id: 'claimRetentionPromo', platform: 'gcfv2', generation: '1787555975881137'},
  {id: 'claimWeeklyGift', platform: 'gcfv2', generation: '1787555976004608'},
  {id: 'claimWelcomeChest', platform: 'gcfv2', generation: '1787555975776233'},
  {id: 'completeFamilyChore', platform: 'gcfv2', generation: '1787555975746332'},
  {id: 'completeTrashDay', platform: 'gcfv2', generation: '1787555993782977'},
  {id: 'createFamily', platform: 'gcfv2', generation: '1787555986328654'},
  {id: 'deleteAccount', platform: 'gcfv2', generation: '1787555975766074'},
  {id: 'disbandFamily', platform: 'gcfv2', generation: '1787555975880080'},
  {id: 'exportGalleryFeedback', platform: 'gcfv2', generation: '1787555975643425'},
  {id: 'getHousemateView', platform: 'gcfv2', generation: '1787555976227264'},
  {id: 'getPlantDirectory', platform: 'gcfv2', generation: '1787555975958397'},
  {id: 'joinFamily', platform: 'gcfv2', generation: '1787555986167242'},
  {id: 'leaveFamily', platform: 'gcfv2', generation: '1787555975989380'},
  {id: 'mintFamilyInvite', platform: 'gcfv2', generation: '1787555985703875'},
  {id: 'mintHousemateToken', platform: 'gcfv2', generation: '1787555975869834'},
  {id: 'onNewUserBefriendGibby', platform: 'gcfv1', generation: null},
  {id: 'openPendingChest', platform: 'gcfv2', generation: '1787555993958376'},
  {id: 'postFamilyMessage', platform: 'gcfv2', generation: '1787555975947146'},
  {id: 'purchaseChest', platform: 'gcfv2', generation: '1787555975880442'},
  {id: 'purchaseStreakShield', platform: 'gcfv2', generation: '1787555976193098'},
  {id: 'recomputeQuestReport', platform: 'gcfv2', generation: '1787555975736868'},
  {id: 'recordTaskCompletion', platform: 'gcfv2', generation: '1787555976147318'},
  {id: 'redeemHousemateToken', platform: 'gcfv2', generation: '1787555976093470'},
  {id: 'removeMember', platform: 'gcfv2', generation: '1787555976090772'},
  {id: 'resolveStreak', platform: 'gcfv2', generation: '1787555976109332'},
  {id: 'rotateMarket', platform: 'gcfv2', generation: '1787555976217210'},
  {id: 'rotateWeeklyOffer', platform: 'gcfv2', generation: '1787555976189958'},
  {id: 'seedDemoAccount', platform: 'gcfv2', generation: '1787555976069013'},
  {id: 'seedShopData', platform: 'gcfv2', generation: '1787555976134362'},
  {id: 'sendDailyGiftReminder', platform: 'gcfv2', generation: '1787555975806602'},
  {id: 'sendGiftInvite', platform: 'gcfv2', generation: '1787555975722961'},
  {id: 'sendStreakReminder', platform: 'gcfv2', generation: '1787584413948191'},
  {id: 'setFamilyBinDay', platform: 'gcfv2', generation: '1787555975845243'},
  {id: 'submitGalleryFeedback', platform: 'gcfv2', generation: '1787555975833067'},
  {id: 'syncPublicProfile', platform: 'gcfv2', generation: '1787555976079990'},
  {id: 'verifyIapAndGrant', platform: 'gcfv2', generation: '1787555975926810'},
  {id: 'verifySubscriptionReceipt', platform: 'gcfv2', generation: '1787555975774952'},
];

const FIXTURE_CLEAN = [
  {id: 'adminGrant', platform: 'gcfv2', generation: '1787625258779814'},
  {id: 'appStoreNotificationsV2', platform: 'gcfv2', generation: '1787625230625907'},
  {id: 'assignFamilyChore', platform: 'gcfv2', generation: '1787625230451460'},
  {id: 'awardStreakReward', platform: 'gcfv2', generation: '1787625230773411'},
  {id: 'backfillGibbyFriendship', platform: 'gcfv2', generation: '1787625230409438'},
  {id: 'backfillPublicProfiles', platform: 'gcfv2', generation: '1787625230614573'},
  {id: 'claimDailyGift', platform: 'gcfv2', generation: '1787625230567361'},
  {id: 'claimGift', platform: 'gcfv2', generation: '1787625230470888'},
  {id: 'claimMinigamePrize', platform: 'gcfv2', generation: '1787625230495788'},
  {id: 'claimRetentionPromo', platform: 'gcfv2', generation: '1787625230473257'},
  {id: 'claimWeeklyGift', platform: 'gcfv2', generation: '1787625230418021'},
  {id: 'claimWelcomeChest', platform: 'gcfv2', generation: '1787625230545286'},
  {id: 'completeFamilyChore', platform: 'gcfv2', generation: '1787625230563768'},
  {id: 'completeTrashDay', platform: 'gcfv2', generation: '1787625258806397'},
  {id: 'createFamily', platform: 'gcfv2', generation: '1787625258714989'},
  {id: 'deleteAccount', platform: 'gcfv2', generation: '1787625230657999'},
  {id: 'disbandFamily', platform: 'gcfv2', generation: '1787625230639867'},
  {id: 'exportGalleryFeedback', platform: 'gcfv2', generation: '1787625230434893'},
  {id: 'getHousemateView', platform: 'gcfv2', generation: '1787625230706289'},
  {id: 'getPlantDirectory', platform: 'gcfv2', generation: '1787625230589379'},
  {id: 'joinFamily', platform: 'gcfv2', generation: '1787625258815668'},
  {id: 'leaveFamily', platform: 'gcfv2', generation: '1787625230488768'},
  {id: 'mintFamilyInvite', platform: 'gcfv2', generation: '1787625258667855'},
  {id: 'mintHousemateToken', platform: 'gcfv2', generation: '1787625230499396'},
  {id: 'onNewUserBefriendGibby', platform: 'gcfv1', generation: null},
  {id: 'openPendingChest', platform: 'gcfv2', generation: '1787625258845119'},
  {id: 'postFamilyMessage', platform: 'gcfv2', generation: '1787625230605743'},
  {id: 'purchaseChest', platform: 'gcfv2', generation: '1787625230435635'},
  {id: 'purchaseStreakShield', platform: 'gcfv2', generation: '1787625230420632'},
  {id: 'recomputeQuestReport', platform: 'gcfv2', generation: '1787625230410421'},
  {id: 'recordTaskCompletion', platform: 'gcfv2', generation: '1787625230406278'},
  {id: 'redeemHousemateToken', platform: 'gcfv2', generation: '1787625230572093'},
  {id: 'removeMember', platform: 'gcfv2', generation: '1787625230508874'},
  {id: 'resolveStreak', platform: 'gcfv2', generation: '1787625230501556'},
  {id: 'rotateMarket', platform: 'gcfv2', generation: '1787625230635961'},
  {id: 'rotateWeeklyOffer', platform: 'gcfv2', generation: '1787625230468910'},
  {id: 'seedDemoAccount', platform: 'gcfv2', generation: '1787625230455483'},
  {id: 'seedShopData', platform: 'gcfv2', generation: '1787625230703319'},
  {id: 'sendDailyGiftReminder', platform: 'gcfv2', generation: '1787625230406116'},
  {id: 'sendGiftInvite', platform: 'gcfv2', generation: '1787625230469708'},
  {id: 'sendStreakReminder', platform: 'gcfv2', generation: '1787625181662374'},
  {id: 'setFamilyBinDay', platform: 'gcfv2', generation: '1787625230651266'},
  {id: 'submitGalleryFeedback', platform: 'gcfv2', generation: '1787625230638553'},
  {id: 'syncPublicProfile', platform: 'gcfv2', generation: '1787625230703340'},
  {id: 'verifyIapAndGrant', platform: 'gcfv2', generation: '1787625230481935'},
  {id: 'verifySubscriptionReceipt', platform: 'gcfv2', generation: '1787625230463326'},
];

/** `b3a8985`, the last functions/src commit at the time of both captures. */
const FIXTURE_COMMIT_MS = Date.parse('2026-08-24T15:19:01.000Z');

function selfTest() {
  let failures = 0;
  const chk = (label, got, want) => {
    const ok = got === want;
    if (!ok) failures++;
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}  (got ${got}, want ${want})`);
  };

  console.log('\n[1] DRIFT — the real 2026-08-24 state. Old script said "STALE by 5 minutes".');
  const d = classify(FIXTURE_DRIFT, FIXTURE_COMMIT_MS);
  chk('behind', d.behind.length, 45);
  chk('at or ahead', d.current.length, 0);
  chk('unmeasured', d.unmeasured.length, 1);
  chk('unmeasured is onNewUserBefriendGibby', d.unmeasured[0]?.id, 'onNewUserBefriendGibby');
  const worst = d.behind.reduce((a, b) => (a.delta <= b.delta ? a : b));
  chk('furthest behind is > 7h', human(worst.delta).startsWith('7h'), true);

  console.log('\n[2] THE FALSE GREEN — same fleet, sendStreakReminder six minutes later.');
  const shifted = FIXTURE_DRIFT.map((f) =>
    f.id === 'sendStreakReminder'
      ? {...f, generation: String((FIXTURE_COMMIT_MS + 10 * 60 * 1000) * 1000)}
      : f,
  );
  const g = classify(shifted, FIXTURE_COMMIT_MS);
  // The old verdict was `newest - commit`, which is now positive => UP TO DATE.
  const oldVerdictWouldBe =
    Math.max(...shifted.map((f) => (f.generation ? Number(f.generation) / 1000 : -Infinity))) -
      FIXTURE_COMMIT_MS >
    0
      ? 'UP TO DATE'
      : 'STALE';
  chk('the OLD max() reading would have said UP TO DATE', oldVerdictWouldBe, 'UP TO DATE');
  chk('new verdict finds them behind', g.behind.length, 44);
  chk('and one genuinely current', g.current.length, 1);

  console.log('\n[3] CLEAN — the real 2026-08-25T02:33Z state. Must NOT cry wolf.');
  const c = classify(FIXTURE_CLEAN, FIXTURE_COMMIT_MS);
  chk('behind', c.behind.length, 0);
  chk('at or ahead', c.current.length, 45);
  chk('too close to call', c.tooClose.length, 0);
  chk('unmeasured still 1, still not counted', c.unmeasured.length, 1);

  console.log(
    failures === 0
      ? '\nself-test: OK — the false green is caught and the clean state stays clean.\n'
      : `\nself-test: ${failures} FAILURE(S)\n`,
  );
  return failures === 0 ? OK : STALE;
}

function main() {
  if (process.argv.includes('--self-test')) process.exit(selfTest());

  const commit = lastFunctionSourceCommit();
  if (commit.error) fail(ENVIRONMENT, commit.error);

  const listed = listDeployed();
  const fns = Array.isArray(listed?.result) ? listed.result : null;
  if (!fns) fail(ENVIRONMENT, 'functions:list returned no result array');
  if (fns.length === 0) fail(ENVIRONMENT, 'functions:list returned zero functions');

  const c = classify(fns, commit.ms);
  if (c.behind.length + c.current.length + c.tooClose.length === 0) {
    fail(ENVIRONMENT, 'no function reported a usable source generation');
  }

  const dirty = dirtyFunctionSource();
  if (dirty) {
    console.log(
      `⚠️  ${dirty} uncommitted change(s) under functions/src — even the commit above ` +
        'is not what you are running locally.',
    );
  }

  process.exit(report(commit, c));
}

// 🔑 THE PURE HALF IS EXPORTED AND TESTED, the credentialled half cannot be —
// same split as check-deployed.cjs and check-rules-deployed.cjs. And the
// failure that matters here is FAILING OPEN: if `summariseDeploys` ever
// returned a garbage-but-finite newest, or `lastFunctionSourceCommit` returned
// nothing and the comparison ran against `undefined`, the script would report
// UP TO DATE for a production running anything at all. Both refuse instead, and
// deployedRevision.test.ts pins that.
//
// 📌 `classify` joins them (W2-154). It is the function the verdict now reads,
// and `--self-test` is its reader; exporting it means a later brief can pin it
// from jest without reshaping the file first.
module.exports = {summariseDeploys, classify, SKEW_TOLERANCE_MS};

// 🔴 GUARDED. deployedRevision.test.ts `require`s this file, and an unguarded
// main() would run git, call production and process.exit() inside the jest
// worker. This guard is load-bearing, not idiom.
if (require.main === module) {
  main();
}
