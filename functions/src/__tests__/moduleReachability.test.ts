import * as fs from 'fs';
import * as path from 'path';

import {allModules, reachableFromEntry, SRC_DIR} from './helpers/moduleGraph';

/**
 * A two-way ledger over `src/*.ts`. Every module is either reachable from
 * `index.ts` — and therefore deployed, because `package.json` sets
 * `main: lib/index.js` — or it is listed here with a reason. A new orphan
 * fails this suite until someone decides which it is.
 *
 * The prose warning at `index.ts:60` did not prevent anything, because prose
 * is not a gate. This is the gate.
 */

/**
 * Not cloud functions, and not expected to be reachable. These are invoked by
 * something other than the Firebase entry point.
 */
const NOT_A_CLOUD_FUNCTION: Record<string, string> = {
  rulesPreflight:
    'Pure config check. Invoked by rulesPreflightCli, which firebase.json runs ' +
    'as a firestore predeploy hook — not by the functions entry point.',
  rulesPreflightCli:
    'CLI entry point for the rules-deploy guard, run by `npm run preflight:rules` ' +
    'from the firestore predeploy hook. Reaching it from index.ts would deploy it ' +
    'as a cloud function, which is wrong.',
};

/**
 * Unreachable AND that is a defect — kept here so the omission is visible and
 * counted, not so it is blessed. Fixing one means deciding what to do with the
 * module, not deleting the entry.
 */
const KNOWN_UNREACHABLE: Record<string, string> = {
  proReceipt:
    'COMPOSED BUT NOT SENT (W2-107), and unreachable because THERE IS NO EMAIL ' +
    'PROVIDER YET. It builds the Pro purchase receipt — rewards, price, payment ' +
    'details and legal links, every one derived rather than retyped — and ' +
    'defines the EmailSender seam. Nothing implements that seam, because doing ' +
    'so needs an account, a sending domain and SPF/DKIM/DMARC records that only ' +
    'Brendan can create; REQUIRED_SETUP names each one. 🔴 WIRING IT INTO ' +
    'index.ts BEFORE A PROVIDER EXISTS WOULD BE WORSE THAN LEAVING IT HERE: the ' +
    'call site would either do nothing while looking finished, or be written ' +
    'inside the grant — and a mail outage inside a grant turns a paid purchase ' +
    'into a failed one, which is the #472 shape on the same path. Fixing this ' +
    'entry means completing the provider setup and then adding the send AFTER ' +
    'the grant and outside its transaction, not adding an import.',
  deployedFunctions:
    'BUILD-TIME METADATA, NOT RUNTIME CODE, and unreachable ON PURPOSE (W2-92). ' +
    'It holds DELIBERATELY_UNDEPLOYED and DECLARED_FUNCTION_COUNT for ' +
    'check-deployed.cjs — the gate that asks PRODUCTION whether it runs what ' +
    'main declares, after nine family callables sat undeployed for days with ' +
    'every other gate green. Its consumers are that script (which reads the ' +
    'BUILT lib/, not src/) and deployedFunctions.test.ts. 🔴 IMPORTING IT FROM ' +
    'index.ts WOULD BE WRONG, not an improvement: it would ship a list of what ' +
    'is not shipped into the deployed bundle, and make the runtime depend on ' +
    'its own deployment ledger. Unreachable is the correct state here, which is ' +
    'why this entry states a REASON rather than an apology.',
  // NOTE: `defaultHouses` WAS HERE AND IS NOT ANY MORE, removed in W2-80 — and
  // removed by the gate rather than by anyone remembering, the same way
  // `family` was. Its entry ended "fixing it means writing the seeder brief,
  // not adding an import", and W2-80 is that brief: demoAccount.ts imports
  // DEFAULT_HOUSES to install a furnished house on the screenshot account, and
  // index.ts imports demoAccount. So the import is a consequence of the seeder
  // existing, which is the order the entry asked for.
  //
  // WARNING: IT DID NOT DECIDE THE THING THE ENTRY SAID WAS UNDECIDED. "Which house a
  // new player receives, whether they choose" is still nobody's decision — the
  // seeder picks a house for a DEMO account via `DEMO_FIXTURE.houseId`, which
  // is screenshot policy, not onboarding policy. If someone later reads this
  // removal as new-player policy having been settled, it has not been.
  // NOTE: `family` WAS HERE AND IS NOT ANY MORE, removed in W2-77 by the gate
  // rather than by anyone remembering. It was exempted in W2-76 as a pure half
  // shipped ahead of its callers; trashDay.ts now imports isValidFamily and
  // index.ts imports trashDay, so it is genuinely reachable. The INVERSE
  // direction of this ledger caught it — `does not exempt a module that is in
  // fact reachable` went red the moment completeTrashDay was wired, which is
  // the half of a ledger that stops it rotting into noise.
  notifications:
    'DEFECT, deliberately not fixed here. Exports functions with the same names ' +
    'as the two reminder crons defined inline in index.ts. Nothing imports it, so ' +
    'Firebase never discovers it — confirmed against production 2026-08-05, ' +
    '`functions:list` shows exactly one of each. Importing it would deploy ' +
    'DUPLICATE crons under the live names, so the fix is a decision about which ' +
    'copy is canonical, not an import. See index.ts:60.',
};

const ledger = () => ({...NOT_A_CLOUD_FUNCTION, ...KNOWN_UNREACHABLE});

describe('module reachability from the deployed entry point', () => {
  it('has no module that is neither reachable nor accounted for', () => {
    const reachable = reachableFromEntry();
    const accounted = ledger();
    const unaccounted = allModules().filter((m) => !reachable.has(m) && !(m in accounted));

    // Named in the failure, per the brief: an orphan should be identifiable
    // from the test output alone, without opening the graph.
    expect(unaccounted).toEqual([]);
  });

  // The inverse direction of the ledger. Without it, a module that gets wired
  // up later keeps its exemption forever and the list rots into noise.
  it('does not exempt a module that is in fact reachable', () => {
    const reachable = reachableFromEntry();
    const wronglyExempt = Object.keys(ledger()).filter((m) => reachable.has(m));
    expect(wronglyExempt).toEqual([]);
  });

  // A stale name in the ledger is the same defect one level up: an entry that
  // silently covers nothing, while looking like coverage.
  it('names only files that exist', () => {
    const missing = Object.keys(ledger()).filter(
      (m) => !fs.existsSync(path.join(SRC_DIR, `${m}.ts`)),
    );
    expect(missing).toEqual([]);
  });

  it('gives every ledger entry a reason', () => {
    const empty = Object.entries(ledger())
      .filter(([, reason]) => reason.trim().length < 40)
      .map(([m]) => m);
    expect(empty).toEqual([]);
  });

  // The known defect is asserted positively. If someone wires notifications in,
  // this goes red and forces the duplicate-cron question to be answered rather
  // than discovered in production.
  it('still has notifications unreachable, as production showed', () => {
    expect(reachableFromEntry().has('notifications')).toBe(false);
  });

  // dailyBonusTask was reported as a second unreachable module. It is not: it
  // is reached transitively via taskRewards, which index.ts imports. Recorded
  // as a test because a direct-import check would call it an orphan again.
  it('reaches dailyBonusTask transitively, not directly', () => {
    const reachable = reachableFromEntry();
    expect(reachable.has('dailyBonusTask')).toBe(true);
    expect(reachable.has('appleRootCerts')).toBe(true);
  });
});
