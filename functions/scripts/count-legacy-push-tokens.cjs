#!/usr/bin/env node
/**
 * How many users still have their push token ONLY in the friend-readable
 * document — the one number that blocks the last two moves of the push-token
 * migration.
 *
 *   npm --prefix functions run census:push-tokens -- --project <id>
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: WHY THIS EXISTS, AND WHY IT IS A COUNTER RATHER THAN A SWEEP
 * ---------------------------------------------------------------------------
 *
 * #663 moved the token off `users/{uid}` — readable by every accepted friend —
 * onto the owner-only `users/{uid}/private/push`, and named the residual it
 * could not close: a user who never launches again keeps an exposed token in
 * the old place. The obvious follow-up is a server-side sweep that clears it.
 *
 * WARNING: THAT SWEEP WOULD STOP PUSH FOR EVERY INSTALL THAT HAS NOT UPDATED. The
 * only writer of either document is the client, so until an install has
 * launched once under the new client, the legacy field is THE ONLY DELIVERY
 * PATH THAT USER HAS — `resolvePushToken` reads the private document first and
 * falls back to it. Deleting it silently ends their reminders.
 *
 * OK: So the sweep, and the removal of the legacy read, are both gated on the
 * same unmeasured number, exactly as pushTokens.ts says: "Drop the legacy read
 * only once that population is empty, not on a date." This script measures it.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: READ-ONLY, STRUCTURALLY — NOT BY A FLAG
 * ---------------------------------------------------------------------------
 *
 * There is no `--dry-run`, because there is no other mode. The census reads
 * through `CensusFirestoreLike` (pushTokens.ts), an interface that carries no
 * write method at all, and `pushTokenCensus.test.ts` scans this file for write
 * calls and fails if one ever appears. A flag can be forgotten; a missing
 * method cannot.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT WOULD TAKE TO RUN THIS AGAINST PRODUCTION
 * ---------------------------------------------------------------------------
 *
 * It has NOT been run against production. Doing so needs, and none of it is
 * mine to grant:
 *
 *   · Application Default Credentials for a principal with Datastore read on
 *     the production project (`gcloud auth application-default login`, or a
 *     service-account key with roles/datastore.viewer).
 *   · The project id passed EXPLICITLY below. There is no default and no
 *     ambient fallback on purpose: firebase binds an account per directory and
 *     a scan has gone to the wrong project here before. If `--project` is
 *     missing this refuses rather than guessing.
 *   · Brendan's authorisation, as the account owner. A window may not decide
 *     on its own to point a full-collection scan at live user data.
 *
 * Cost, so the decision is informed: one document read per user document, plus
 * one per existing `users/{uid}/private/*` document. Two queries, N+M reads,
 * no writes.
 */
'use strict';

function loadCensus() {
  try {
    return require('../lib/pushTokens.js');
  } catch (error) {
    console.error(
      'Could not load ../lib/pushTokens.js — run `npm --prefix functions run build` first.\n' +
        String(error),
    );
    process.exit(2);
  }
}

function parseArgs(argv) {
  const args = { project: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project') args.project = argv[++i] ?? null;
    else if (arg.startsWith('--project=')) args.project = arg.slice('--project='.length);
    else if (arg === '--json') args.json = true;
    else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.project) {
    console.error(
      'Refusing to scan: --project <id> is required.\n' +
        'There is no default project here on purpose — an ambient one has\n' +
        'pointed a scan at the wrong database before. Name the target.',
    );
    process.exit(2);
  }

  const emulator = process.env.FIRESTORE_EMULATOR_HOST;
  console.log(`project: ${args.project}`);
  console.log(`target:  ${emulator ? `EMULATOR at ${emulator}` : 'REAL Firestore'}`);
  console.log('mode:    read-only (this script has no write path)');

  // KEY: LOADED HERE, NOT AT THE TOP, so a run with no --project refuses on the
  // argument rather than on a missing build. The refusal is the behaviour
  // pushTokenCensus.test.ts drives, and it must not depend on `tsc` having run.
  const census = loadCensus();
  const admin = require('firebase-admin');
  admin.initializeApp({ projectId: args.project });
  const counts = await census.readPushTokenCensus(admin.firestore());

  if (args.json) {
    console.log(JSON.stringify(counts, null, 2));
  } else {
    console.log('');
    console.log(`legacy-only:  ${counts.legacyOnly}   <- blocks the sweep AND the legacy-read removal`);
    console.log(`private-only: ${counts.privateOnly}   <- migrated`);
    console.log(`both:         ${counts.both}   <- mid-migration, already served from private`);
    console.log(`neither:      ${counts.neither}   <- no token anywhere`);
    console.log(`total users:  ${counts.total}`);
    console.log('');
    console.log(
      counts.legacyOnly === 0
        ? 'legacy-only is EMPTY: the condition in pushTokens.ts is met.'
        : `legacy-only is NOT empty: ${counts.legacyOnly} install(s) would lose push.`,
    );
    if (counts.privateOnly + counts.both === 0) {
      console.log(
        'WARNING: nothing is migrated at all. An empty legacy-only count here\n' +
          'means the scan saw no tokens whatsoever, not that migration finished.',
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
