#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-deployed — does production run what main declares?
// ---------------------------------------------------------------------------
//
// W2-92. The gate that would have caught nine undeployed family callables on
// the day they landed.
//
// CRITICAL: THIS IS THE ONE CHECK IN THE REPO THAT ASKS PRODUCTION A QUESTION. Every
// other gate reads the source, the repo's rules file, or a fake. That is why an
// entire feature sat undeployed for days with 1170 tests green.
//
// WARNING: IT NEEDS CREDENTIALS, so it cannot be a jest test while CI is out of
// billing. Run it before declaring a backend feature done:
//
//     make check-deployed
//
// The half that CAN be gated without credentials — the ledger and the parser —
// is in `deployedFunctions.test.ts`, so a silently-broken parser fails in
// `npm test` even though this comparison cannot.
//
// EXIT CODES, chosen so a caller can tell the three apart:
//   0  in sync (or every difference is ledgered)
//   1  DRIFT — something declared is not deployed, or vice versa
//   3  ENVIRONMENT — could not ask production at all
//
// KEY: 3 IS SEPARATE FROM 1 ON PURPOSE, and it is the same distinction
// check-test-floor.cjs draws: "could not measure" must never read as "measured
// and fine". A missing credential silently reported as green is how this class
// of bug survives.

const {execFileSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const {stripComments} = require('./stripComments.cjs');

const REPO = path.resolve(__dirname, '..', '..');

/** Function exports declared in index.ts, comments stripped. */
function declaredFunctions() {
  const raw = fs.readFileSync(path.join(REPO, 'functions', 'src', 'index.ts'), 'utf8');
  // Comments first: a function NAME inside prose must not count as a
  // declaration. This file's own header names nine of them.
  //
  // W2-142: this was its own copy of two chained regex replaces, identical to
  // the two in src/__tests__ and wrong the same way — block-comments-first lets
  // a slash-asterisk pair inside a LINE comment open a phantom block. Shared
  // now, so this script and the jest gate cannot disagree about what index.ts
  // declares. That mattered: this is the half that talks to production.
  const src = stripComments(raw);
  // WARNING: `functionsV1Auth` has NO trailing dot on purpose — onNewUserBefriendGibby
  // is written `= functionsV1Auth\n  .user()`, and a pattern requiring the dot
  // skipped it, producing a phantom "deployed but not declared" the first time
  // this ran.
  return [
    ...new Set(
      [...src.matchAll(/^export const (\w+)\s*=\s*(?:on[A-Z]\w*\(|functionsV1Auth)/gm)].map(
        (m) => m[1],
      ),
    ),
  ].sort();
}

function deployedFunctions() {
  const out = execFileSync(
    'npx',
    ['firebase', 'functions:list', '--json'],
    {cwd: REPO, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']},
  );
  const parsed = JSON.parse(out);
  if (!parsed || !Array.isArray(parsed.result)) {
    throw new Error('functions:list returned no result array');
  }
  return [...new Set(parsed.result.map((f) => f.id).filter(Boolean))].sort();
}

function main() {
  const {DELIBERATELY_UNDEPLOYED, DECLARED_FUNCTION_COUNT} = require(
    path.join(REPO, 'functions', 'lib', 'deployedFunctions.js'),
  );

  const declared = declaredFunctions();

  // Anti-vacuity BEFORE asking production: a parser that matched nothing would
  // find no drift and pass, which is the failure this gate exists to prevent.
  if (declared.length !== DECLARED_FUNCTION_COUNT) {
    console.error(
      `deployed: PARSER DISAGREES WITH THE PIN — found ${declared.length} exports, ` +
        `DECLARED_FUNCTION_COUNT says ${DECLARED_FUNCTION_COUNT}.\n` +
        '  If you added or removed a function, update the constant in the same commit.\n' +
        '  If you did not, the regex in this script has stopped matching and the\n' +
        '  check is blind — fix that before trusting a green run.',
    );
    process.exit(1);
  }

  let deployed;
  try {
    deployed = deployedFunctions();
  } catch (err) {
    console.error(
      'deployed: ENVIRONMENT — could not ask production.\n' +
        `  ${err.message.split('\n')[0]}\n` +
        '\n' +
        '  🔴 THE LIKELIEST CAUSE IS THIS DIRECTORY, NOT YOUR LOGIN.\n' +
        '  firebase-tools binds an account PER ABSOLUTE DIRECTORY, in\n' +
        '  ~/.config/configstore/firebase-tools.json under `activeAccounts`. The\n' +
        '  root checkout is bound to the account that owns <project-id>; A FRESH\n' +
        '  WORKTREE IS NOT, so it falls back to the default account and every call\n' +
        '  403s — which reads as a revoked login or a broken CLI and is neither.\n' +
        '\n' +
        `  Fix, in THIS directory:  npx firebase login:use <the owning account>\n` +
        '  Or run the check from the root checkout, which is already bound.\n' +
        '\n' +
        '  🔴 This is NOT a pass. Nothing was compared.',
    );
    process.exit(3);
  }

  const missing = declared.filter((n) => !deployed.includes(n));
  // eslint-disable-next-line no-use-before-define
  const extra = deployed.filter((n) => !declared.includes(n));

  const unledgered = missing.filter((n) => !(n in DELIBERATELY_UNDEPLOYED));
  const {nowDeployed, noLongerDeclared} = classifyStaleLedger(
    declared,
    deployed,
    Object.keys(DELIBERATELY_UNDEPLOYED),
  );
  const staleLedger = [...nowDeployed, ...noLongerDeclared];

  let bad = false;

  if (unledgered.length) {
    bad = true;
    console.error(
      `deployed: ${unledgered.length} DECLARED BUT NOT DEPLOYED — main runs code production does not:\n` +
        unledgered.map((n) => `    ${n}`).join('\n') +
        '\n  Deploy them, or ledger each in DELIBERATELY_UNDEPLOYED with a reason.\n' +
        '  Surgical: npx firebase deploy --only functions:<name>',
    );
  }

  if (extra.length) {
    bad = true;
    console.error(
      `deployed: ${extra.length} DEPLOYED BUT NOT DECLARED — production runs code main does not:\n` +
        extra.map((n) => `    ${n}`).join('\n') +
        '\n  Either it was deleted from index.ts without being deleted from the project,\n' +
        '  or this script stopped recognising its declaration form.',
    );
  }

  // CRITICAL: TWO OPPOSITE CAUSES, AND THE OLD MESSAGE KNEW ONLY ONE OF THEM.
  //
  // Both land a ledger entry in "stale", but the correct response is the
  // reverse of the other, and the single instruction this used to print —
  // "Remove the entry" — is right for the second and WRONG for the first.
  //
  // It went wrong in the live case it was written for. On 2026-08-16
  // `seedDemoAccount` was deployed with 41 siblings while its ledger entry
  // said it must stay off. "Remove the entry" would have SILENTLY ACCEPTED a
  // deployment documented as must-not-happen — clearing the record of the
  // decision instead of acting on it, and leaving nothing behind to say the
  // question had ever been asked.
  //
  // KEY: THE SCRIPT CANNOT TELL "deployed on purpose" FROM "deployed by
  // accident", so it must not pick. It names both remedies and makes the
  // reader choose — the same discipline as exit 3: when the instrument cannot
  // know, it says so rather than guessing in the reassuring direction.
  if (nowDeployed.length) {
    bad = true;
    console.error(
      `deployed: ${nowDeployed.length} LEDGERED AS UNDEPLOYED BUT NOW LIVE — the DEPLOY drifted:\n` +
        nowDeployed.map((n) => `    ${n}`).join('\n') +
        '\n  Two opposite remedies, and this script cannot tell which is right:\n' +
        '    · The deploy was a MISTAKE — remove it from production:\n' +
        '        npx firebase functions:delete <name>\n' +
        '      Keep the ledger entry; it is still the decision.\n' +
        '    · The deploy was INTENDED — the exemption is over, so delete the\n' +
        '      entry from DELIBERATELY_UNDEPLOYED and say why in the commit.\n' +
        '  ⚠️ Deleting the entry to make this green is the DEFAULT MISTAKE: it\n' +
        '     erases a deliberate decision and leaves the function live.',
    );
  }

  if (noLongerDeclared.length) {
    bad = true;
    console.error(
      `deployed: ${noLongerDeclared.length} LEDGERED BUT NO LONGER DECLARED — the CODE drifted:\n` +
        noLongerDeclared.map((n) => `    ${n}`).join('\n') +
        '\n  index.ts no longer declares these, so the exemption has nothing left\n' +
        '  to exempt. Remove the entry — an exemption that outlives its subject\n' +
        '  grants a permanent pass to a name anybody could reintroduce.',
    );
  }

  if (bad) process.exit(1);

  const ledgered = missing.length;
  console.log(
    `deployed: OK — ${declared.length} declared, ${deployed.length} live` +
      (ledgered ? `, ${ledgered} deliberately undeployed (${missing.join(', ')})` : ''),
  );
}

/**
 * Why a ledger entry is stale — and they are NOT the same finding.
 *
 * An entry in `DELIBERATELY_UNDEPLOYED` asserts two things at once: this
 * function EXISTS in index.ts, and it is deliberately NOT in production. It
 * goes stale when either half stops holding, and the two halves fail in
 * opposite directions:
 *
 *   nowDeployed       the function is LIVE. The deploy drifted. Removing the
 *                     entry accepts a deployment the entry existed to forbid.
 *   noLongerDeclared  index.ts no longer declares it. The code drifted, the
 *                     exemption has no subject, and removing the entry is right.
 *
 * WARNING: AN ENTRY CAN BE BOTH — live AND undeclared — which is the "deployed but
 * not declared" case the `extra` check already reports. It is listed under
 * `nowDeployed` only, because that is the half with the dangerous remedy, and
 * reporting one name twice under contradictory instructions is how a reader
 * ends up doing neither.
 *
 * Pure and exported so `deployedFunctions.test.ts` can gate the distinction
 * without credentials — the same split this script already draws, applied to
 * the classification rather than only to the parser.
 */
function classifyStaleLedger(declared, deployed, ledgered) {
  const nowDeployed = ledgered.filter((n) => deployed.includes(n));
  const noLongerDeclared = ledgered.filter(
    (n) => !declared.includes(n) && !deployed.includes(n),
  );
  return {nowDeployed, noLongerDeclared};
}

module.exports = {classifyStaleLedger};

// KEY: GUARDED so requiring this module for `classifyStaleLedger` does not run
// the credentialled check as a side effect. Without it, importing the pure
// function from a jest test would shell out to `firebase functions:list`.
if (require.main === module) {
  main();
}
