#!/usr/bin/env node
// ---------------------------------------------------------------------------
// check-rules-deployed — is the ruleset on production the one on main?
// ---------------------------------------------------------------------------
//
// W2-98. The sibling `check-deployed.cjs` asks production which CALLABLES are
// live. It greps for `rules` exactly once, and never asks about them.
//
// 🔴 SO DEPLOYMENT HAD A GATE FOR FUNCTIONS AND NONE FOR THE HALF THAT DECIDES
// WHO MAY READ ANOTHER PLAYER'S DATA. That gap let two records of record
// contradict each other for a fortnight with no way to settle it:
//
//   · `firestore.rules`'s own header: "DEPLOYING IT IS A HUMAN ACTION NOBODY
//     HAS TAKEN… the DEPLOYED rules are 141 lines dated 2026-07-02"
//   · the 2026-08-16 restart doc: "firestore.rules — released to cloud.firestore"
//
// Neither document could settle it. Only production could. It answered on
// 2026-08-16: an 856-line ruleset, 35 match blocks, released 00:59:48Z — so the
// header was stale and the restart doc was right. The header is fixed
// separately; THIS file is the instrument that made the question answerable,
// and the reason it will not need answering by hand again.
//
// ⚠️ THE FILE ON DISK IS NOT EVIDENCE OF ANYTHING PRODUCTION ENFORCES. Rules
// are dead text until deployed, a merged PR deploys nothing, and a reviewer's
// natural reading of "the rules now require X" is that they require X today.
//
//     make check-rules-deployed
//
// EXIT CODES — the same three-way split as check-deployed.cjs, for the same
// reason: "could not ask" must never read as "asked, and fine".
//   0  in sync — production is running this ruleset
//   1  DRIFT — production is running something else
//   3  ENVIRONMENT — could not ask (no credentials, token expired, API down)
//
// 🔑 3 IS SEPARATE FROM 1 ON PURPOSE. A network failure reporting DRIFT is
// worse than no checker: it trains people to ignore the one alarm that means
// "a player's data is not protected by what you think protects it".
//
// ⚠️ `make` COLLAPSES 1 AND 3 TO 2, exactly as it does for check-deployed —
// make reports its own exit code for a failed recipe. Run the script directly
// when you need to tell DRIFT from ENVIRONMENT.
//
// ---------------------------------------------------------------------------
// HOW IT READS PRODUCTION, WRITTEN DOWN SO THE NEXT WINDOW DOES NOT RE-DERIVE IT
// ---------------------------------------------------------------------------
//
// 🔴 `firebase firestore:rules` DOES NOT EXIST. Not in v15.25.1 — `firestore`
// has delete, bulkdelete, indexes, locations, operations, databases and backups,
// and nothing that reads the live ruleset. `firebase deploy --only
// firestore:rules --dry-run` compiles the local file and proves you hold deploy
// credentials, but says NOTHING about what is live. There is no CLI read path.
//
// The Rules REST API is the read path:
//   GET /v1/projects/{project}/releases/cloud.firestore   -> rulesetName
//   GET /v1/{rulesetName}                                 -> source files
//
// ⚠️ AND THE TOKEN IS PER-DIRECTORY, WHICH IS THE TRAP. firebase-tools binds an
// account to an ABSOLUTE PATH in `activeAccounts`. The root checkout is bound to
// the account that owns the project; a FRESH WORKTREE IS NOT, and falls back to
// the default `user`, which here is a different person entirely and 403s in a
// way that reads like a revoked login. So this resolves the account by walking
// up from the repo root through `activeAccounts` before falling back — and when
// it falls back it SAYS SO, because a 403 explained as "wrong account" is a
// two-second fix and a 403 explained as nothing is an afternoon.
//
// 🔑 THE OAUTH CLIENT IS READ FROM THE INSTALLED firebase-tools, NEVER COPIED
// HERE. Its id and secret are public constants of that package, but a literal
// copy in this repo would (a) rot silently when they rotate and (b) read as a
// committed credential to every scanner and every human. Resolved at runtime or
// we exit 3.
//
// 🔴 NO TOKEN IS EVER PRINTED OR WRITTEN, INCLUDING IN ERROR PATHS — and the
// error path is the one that needs saying out loud. When the OAuth token
// endpoint rejects a refresh it can echo the REQUEST PARAMETERS back in its
// response body, and those parameters include the refresh token itself. So the
// failure here reports the STATUS CODE and the account, never `await
// res.text()`. The instinct to dump a response body when something fails is
// exactly right everywhere else in this repo and exactly wrong here; see the
// `refreshing the access token failed` branch below.

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const RULES_FILE = path.join(REPO, 'firestore.rules');
const RELEASE = 'cloud.firestore';

/** Exit codes, named so call sites read as intent. */
const OK = 0;
const DRIFT = 1;
const ENVIRONMENT = 3;

function fail(code, message) {
  console.error(`\n${code === ENVIRONMENT ? 'ENVIRONMENT' : 'DRIFT'}: ${message}\n`);
  process.exit(code);
}

/** The project id, from .firebaserc — never hard-coded. */
function projectId() {
  const rc = path.join(REPO, '.firebaserc');
  if (!fs.existsSync(rc)) {
    fail(ENVIRONMENT, `no .firebaserc at ${rc}, so the project id is unknown.`);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(rc, 'utf8'));
  } catch (e) {
    fail(ENVIRONMENT, `.firebaserc is not valid JSON — ${e.message}`);
  }
  const id = parsed?.projects?.default;
  if (!id) fail(ENVIRONMENT, '.firebaserc has no projects.default.');
  return id;
}

/** firebase-tools' OAuth client, resolved from the installed package. */
function oauthClient() {
  const candidates = [];
  try {
    candidates.push(require.resolve('firebase-tools/lib/api'));
  } catch {
    // Not resolvable from here; try the global install the CLI runs from.
  }
  const globalLib = path.join(
    path.dirname(process.execPath),
    '..',
    'lib',
    'node_modules',
    'firebase-tools',
    'lib',
    'api.js',
  );
  candidates.push(globalLib);

  for (const c of candidates) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const api = require(c);
      if (typeof api.clientId === 'function' && typeof api.clientSecret === 'function') {
        return {id: api.clientId(), secret: api.clientSecret()};
      }
    } catch {
      // Try the next candidate.
    }
  }
  fail(
    ENVIRONMENT,
    'could not load firebase-tools\' OAuth client. Install firebase-tools ' +
      '(`npm i -g firebase-tools`) — this script deliberately does not carry a ' +
      'copy of its client id/secret.',
  );
}

/**
 * The stored credential for whichever account is bound to this repo.
 *
 * Returns {tokens, email, boundTo} — boundTo is null when we fell back to the
 * default user, which is the case worth naming in a 403.
 */
function storedCredential() {
  const file = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  if (!fs.existsSync(file)) {
    fail(ENVIRONMENT, `no firebase-tools credential at ${file}. Run \`firebase login\`.`);
  }
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(ENVIRONMENT, `firebase-tools credential file is not valid JSON — ${e.message}`);
  }

  // Walk UP from the repo, because a worktree under the repo root inherits the
  // root's binding conceptually even though firebase-tools keys on exact paths.
  const active = cfg.activeAccounts || {};
  let dir = REPO;
  let boundEmail = null;
  let boundTo = null;
  for (;;) {
    if (active[dir]) {
      boundEmail = active[dir];
      boundTo = dir;
      break;
    }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }

  const accounts = [
    ...(cfg.user && cfg.tokens ? [{user: cfg.user, tokens: cfg.tokens}] : []),
    ...(cfg.additionalAccounts || []),
  ];
  const chosen = boundEmail
    ? accounts.find((a) => a.user?.email === boundEmail)
    : accounts[0];

  if (!chosen?.tokens?.refresh_token) {
    fail(
      ENVIRONMENT,
      boundEmail
        ? `no stored credential for ${boundEmail}, which is the account bound to ${boundTo}. Run \`firebase login\`.`
        : 'no stored firebase-tools credential with a refresh token. Run `firebase login`.',
    );
  }
  return {tokens: chosen.tokens, email: chosen.user?.email ?? '(unknown)', boundTo};
}

/** A usable access token — the cached one if live, otherwise refreshed. */
async function accessToken(cred) {
  const {tokens} = cred;
  // 60s of slack: a token that expires mid-request is an ENVIRONMENT failure
  // that would look like a 401 from nowhere.
  if (tokens.access_token && tokens.expires_at && Date.now() < tokens.expires_at - 60_000) {
    return tokens.access_token;
  }
  const client = oauthClient();
  let res;
  try {
    res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {'Content-Type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({
        client_id: client.id,
        client_secret: client.secret,
        refresh_token: tokens.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
  } catch (e) {
    fail(ENVIRONMENT, `could not reach Google's token endpoint — ${e.message}`);
  }
  if (!res.ok) {
    // 🔴 The BODY is not printed: a token-endpoint error can echo request
    // parameters, and those include the refresh token.
    fail(
      ENVIRONMENT,
      `refreshing the access token failed with HTTP ${res.status}. The stored ` +
        `credential for ${cred.email} may have been revoked — run \`firebase login\`.`,
    );
  }
  const body = await res.json();
  if (!body.access_token) fail(ENVIRONMENT, 'token endpoint returned no access_token.');
  return body.access_token;
}

async function getJson(url, token, cred) {
  let res;
  try {
    res = await fetch(url, {headers: {Authorization: `Bearer ${token}`}});
  } catch (e) {
    fail(ENVIRONMENT, `could not reach the Rules API — ${e.message}`);
  }
  if (res.status === 403 || res.status === 401) {
    fail(
      ENVIRONMENT,
      `the Rules API refused (HTTP ${res.status}) for account ${cred.email}` +
        (cred.boundTo
          ? `, bound to ${cred.boundTo}.`
          : ' — and NO account is bound to this directory, so this is the ' +
            'fallback default user rather than the project owner. ' +
            '⚠️ firebase-tools binds an account PER ABSOLUTE DIRECTORY: run ' +
            '`npx firebase login:use <owner-email>` here, or run this from the ' +
            'root checkout.'),
    );
  }
  if (!res.ok) {
    fail(ENVIRONMENT, `the Rules API returned HTTP ${res.status} for ${url}`);
  }
  return res.json();
}

/**
 * Comparable form of a ruleset: comments stripped, whitespace collapsed.
 *
 * 🔴 BYTE EQUALITY WOULD NEVER HOLD AND MUST NOT BE THE TEST. The deployed copy
 * is whatever was uploaded, comments and all, and a checker that cries wolf on
 * a reflowed comment gets switched off within a week. What matters is whether
 * production ENFORCES what this file says, so comments and layout — the two
 * things that change constantly and enforce nothing — are removed before
 * comparing.
 *
 * ⚠️ Comments are stripped BEFORE whitespace is collapsed, and block comments
 * before line comments, so a `//` inside a `/* … *\/` is not mistaken for the
 * start of a line comment.
 */
function normalise(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function digest(src) {
  return crypto.createHash('sha256').update(normalise(src)).digest('hex').slice(0, 16);
}

/**
 * Every `match` path in a ruleset, in order.
 *
 * Used only to EXPLAIN a mismatch the digest already found — the digest is the
 * test, because a changed CONDITION (`isOwner(uid)` relaxed to
 * `isAuthenticated()`) leaves the match blocks identical and is exactly the
 * drift that matters most.
 */
function matchPaths(src) {
  return [...normalise(src).matchAll(/match\s+(\S+)\s*\{/g)].map((m) => m[1]);
}

function diffLists(a, b) {
  const bs = new Set(b);
  const as = new Set(a);
  return {
    onlyInFirst: a.filter((x) => !bs.has(x)),
    onlyInSecond: b.filter((x) => !as.has(x)),
  };
}

async function main() {
  if (!fs.existsSync(RULES_FILE)) {
    fail(ENVIRONMENT, `no firestore.rules at ${RULES_FILE}`);
  }
  const local = fs.readFileSync(RULES_FILE, 'utf8');
  const project = projectId();
  const cred = storedCredential();
  const token = await accessToken(cred);

  const release = await getJson(
    `https://firebaserules.googleapis.com/v1/projects/${project}/releases/${RELEASE}`,
    token,
    cred,
  );
  const rulesetName = release.rulesetName;
  if (!rulesetName) {
    fail(ENVIRONMENT, `the ${RELEASE} release named no ruleset.`);
  }
  const ruleset = await getJson(
    `https://firebaserules.googleapis.com/v1/${rulesetName}`,
    token,
    cred,
  );

  const files = ruleset.source?.files ?? [];
  if (files.length !== 1) {
    // Not a failure of policy, but this comparison assumes one file and would
    // silently compare the wrong one.
    fail(
      ENVIRONMENT,
      `the deployed ruleset has ${files.length} source files; this checker ` +
        'compares a single firestore.rules and would otherwise compare the wrong one.',
    );
  }
  const live = files[0].content;

  console.log(`project:        ${project}`);
  console.log(`release:        ${RELEASE}`);
  console.log(`ruleset:        ${rulesetName.split('/').pop()}`);
  console.log(`released:       ${release.updateTime}`);
  console.log(`account:        ${cred.email}${cred.boundTo ? '' : '  (⚠️ fallback — no account bound to this directory)'}`);
  console.log(
    `deployed:       ${live.split('\n').length} lines, ${matchPaths(live).length} match blocks, digest ${digest(live)}`,
  );
  console.log(
    `main:           ${local.split('\n').length} lines, ${matchPaths(local).length} match blocks, digest ${digest(local)}`,
  );

  if (digest(live) === digest(local)) {
    console.log('\nfirestore.rules: IN SYNC — production is enforcing this ruleset.\n');
    process.exit(OK);
  }

  const {onlyInFirst: onlyLocal, onlyInSecond: onlyLive} = diffLists(
    matchPaths(local),
    matchPaths(live),
  );

  const lines = [];
  if (onlyLocal.length) {
    lines.push(
      `  NOT DEPLOYED — on main, absent from production (${onlyLocal.length}):`,
      ...onlyLocal.map((p) => `    ${p}`),
    );
  }
  if (onlyLive.length) {
    lines.push(
      `  ONLY IN PRODUCTION — deployed, absent from main (${onlyLive.length}):`,
      ...onlyLive.map((p) => `    ${p}`),
      '  ⚠️ These may be HAND EDITS made in the console. Deploying main would',
      '     erase them. Read them before deciding.',
    );
  }
  if (!onlyLocal.length && !onlyLive.length) {
    lines.push(
      '  The same match blocks on both sides, but the rules DIFFER — so a',
      '  CONDITION changed, not the shape. That is the drift that matters most:',
      '  a relaxed `allow` is invisible to a path-only comparison.',
      `  Read the deployed source:  ${rulesetName}`,
    );
  }

  fail(
    DRIFT,
    'production is NOT running the ruleset on main.\n\n' +
      lines.join('\n') +
      '\n\n  Nothing here is enforced until someone with deploy credentials runs\n' +
      '  `firebase deploy --only firestore:rules`. A merged PR deploys nothing.',
  );
}

// 🔑 THE COMPARISON HALF IS EXPORTED AND TESTED, THE CREDENTIALLED HALF CANNOT
// BE. Same split as check-deployed.cjs / deployedFunctions.test.ts: this script
// needs credentials so it cannot be a jest test while CI is out of billing, but
// `normalise`, `digest` and `matchPaths` are pure — and a silently-broken
// `normalise` is the WORST failure this file has, because it fails OPEN. If it
// ever returned '' for both sides the digests would match and the checker would
// report IN SYNC forever, which is precisely the false reassurance it exists to
// end. rulesDeployedCompare.test.ts pins that in `npm test`.
module.exports = {normalise, digest, matchPaths, diffLists};

if (require.main === module) {
  main().catch((e) => {
    // Anything unforeseen is ENVIRONMENT, never DRIFT: this script must never
    // report "your rules are wrong" because it crashed.
    fail(ENVIRONMENT, `unexpected failure — ${e && e.message ? e.message : String(e)}`);
  });
}
