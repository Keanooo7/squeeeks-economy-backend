// functions/src/__tests__/deployedFunctions.test.ts
//
// W2-92. The half of the deployment check that needs NO credentials.
//
// CRITICAL: THE COMPARISON ITSELF CANNOT LIVE HERE. `check-deployed.cjs` asks
// production, which needs credentials, and CI is out of billing. What lives
// here is everything that can fail WITHOUT asking production: the parser that
// derives the declared set, and the ledger of deliberate omissions.
//
// KEY: THAT SPLIT IS THE POINT. A check somebody has to remember to run is exactly
// the kind this repo keeps being bitten by — so the parts that CAN be automatic
// are, and the one part that cannot is loud about it (exit 3, ENVIRONMENT,
// never confused with a pass).

import * as fs from 'fs';
import * as path from 'path';

import { stripComments } from './support/stripComments';

import {
  DECLARED_FUNCTION_COUNT,
  DELIBERATELY_UNDEPLOYED,
} from '../deployedFunctions';

const REPO = path.resolve(__dirname, '../../..');

/**
 * The declared set, derived exactly as `check-deployed.cjs` derives it.
 *
 * WARNING: A DELIBERATE SECOND COPY OF THE REGEX, and the reason is worth stating: the
 * script cannot import from `src/` (it reads `lib/`, the built output, and runs
 * before jest ever does). Keeping the two in step is what the count pin below
 * is for — if they diverge, one of them stops matching and the count moves.
 */
function declaredFunctions(): string[] {
  const raw = fs.readFileSync(path.join(REPO, 'functions', 'src', 'index.ts'), 'utf8');
  // W2-142: was two chained regex replaces here, block-comments-first. A slash
  // and an asterisk adjacent inside a LINE comment then opened a phantom block
  // that ran to the next closing delimiter — a single prose path in index.ts
  // silently dropped sendDailyGiftReminder and made this count 45, not 46. The
  // anti-vacuity test below is what turned that red instead of green.
  const src = stripComments(raw);
  return [
    ...new Set(
      [...src.matchAll(/^export const (\w+)\s*=\s*(?:on[A-Z]\w*\(|functionsV1Auth)/gm)].map(
        (m) => m[1],
      ),
    ),
  ].sort();
}

describe('🔴 W2-92 the declared-function parser', () => {
  test('🔑 ANTI-VACUITY — it finds the pinned number of exports', () => {
    // The whole gate's failure mode: a regex that stops matching reports
    // "nothing declared", finds no drift, and passes forever. This is what
    // makes a silently-empty parse loud.
    expect(declaredFunctions()).toHaveLength(DECLARED_FUNCTION_COUNT);
  });

  test('🔴 it catches the v1 auth trigger, whose dot is on the NEXT LINE', () => {
    // `export const onNewUserBefriendGibby = functionsV1Auth\n  .user()`. A
    // pattern requiring `functionsV1Auth.` skipped it and produced a phantom
    // "deployed but not declared" the first time the comparison ran for real.
    expect(declaredFunctions()).toContain('onNewUserBefriendGibby');
  });

  test('it catches every trigger STYLE this file uses', () => {
    // One anchor per shape, so a regex narrowed to one style fails here rather
    // than silently halving the declared set.
    const declared = declaredFunctions();
    expect(declared).toContain('createFamily'); // onCall
    expect(declared).toContain('appStoreNotificationsV2'); // onRequest
    expect(declared).toContain('rotateMarket'); // onSchedule
    expect(declared).toContain('syncPublicProfile'); // onDocumentWritten
  });

  test('🔴 a function NAME inside a comment is not a declaration', () => {
    // index.ts names nine family callables in prose. Counting those would
    // inflate the declared set and manufacture drift against production.
    const raw = fs.readFileSync(path.join(REPO, 'functions', 'src', 'index.ts'), 'utf8');
    expect(raw).toContain('// onNewUserBefriendGibby');
    // …and it still appears exactly once in the derived set, not twice.
    expect(declaredFunctions().filter((n) => n === 'onNewUserBefriendGibby')).toHaveLength(1);
  });

  test('every declared name is unique and non-empty', () => {
    const declared = declaredFunctions();
    expect(new Set(declared).size).toBe(declared.length);
    for (const name of declared) expect(name.length).toBeGreaterThan(0);
  });
});

describe('🔴 W2-92 the deliberately-undeployed ledger', () => {
  test('🔴 every ledgered name is actually declared in index.ts', () => {
    // The inverse direction, and the one that makes this a gate rather than a
    // comment: an entry for a function that no longer exists is a permanent
    // exemption nobody will notice. Same defect moduleReachability catches with
    // "does not exempt a module that is in fact reachable".
    const declared = declaredFunctions();
    for (const name of Object.keys(DELIBERATELY_UNDEPLOYED)) {
      expect(`${name} is declared: ${declared.includes(name)}`).toBe(
        `${name} is declared: true`,
      );
    }
  });

  test('every entry states a reason, not a shrug', () => {
    // You cannot silence the deploy check by pasting a name — only by writing
    // why the function is absent from production.
    for (const [name, why] of Object.entries(DELIBERATELY_UNDEPLOYED)) {
      expect(`${name} reason > 80 chars: ${why.length > 80}`).toBe(
        `${name} reason > 80 chars: true`,
      );
    }
  });

  test('📌 the ledger is SMALL — it is an exception list, not a config', () => {
    // Anti-vacuity from the other side. A ledger that grew to cover most of the
    // codebase would pass the check while meaning nothing; if this ever fires,
    // the question is why so much of main is not in production.
    expect(Object.keys(DELIBERATELY_UNDEPLOYED).length).toBeLessThan(5);
  });

  test('seedDemoAccount is the one entry, and it is a product decision', () => {
    // Recorded explicitly so removing it is a deliberate act: it is the
    // screenshot harness (W2-80) and the emulator is where it belongs.
    expect(Object.keys(DELIBERATELY_UNDEPLOYED)).toEqual(['seedDemoAccount']);
  });
});

// ---------------------------------------------------------------------------
// A stale ledger entry has TWO opposite causes (W2-100)
// ---------------------------------------------------------------------------
//
// CRITICAL: THE MESSAGE USED TO KNOW ONLY ONE OF THEM. An entry in
// DELIBERATELY_UNDEPLOYED asserts two things at once — this function EXISTS in
// index.ts, and it is deliberately NOT in production — and it goes stale when
// either half stops holding. The two halves fail in OPPOSITE directions, and
// the script printed a single instruction, "Remove the entry", which is right
// for one and actively wrong for the other.
//
// It was wrong in the live case. On 2026-08-16 `seedDemoAccount` deployed with
// 41 siblings while its entry said it must stay off. Following that instruction
// would have SILENTLY ACCEPTED a deployment documented as must-not-happen:
// erasing the record of the decision rather than acting on it, and leaving
// nothing behind to show the question had been asked.
//
// KEY: The script cannot tell "deployed on purpose" from "deployed by accident",
// so it must not pick. This pins that it reports the two causes SEPARATELY —
// because a classifier that lumps them can only ever print one remedy.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const {classifyStaleLedger} = require('../../scripts/check-deployed.cjs') as {
  classifyStaleLedger: (
    declared: string[],
    deployed: string[],
    ledgered: string[],
  ) => {nowDeployed: string[]; noLongerDeclared: string[]};
};

describe('classifyStaleLedger — the deploy drifted vs the code drifted', () => {
  it('a ledgered function that is genuinely absent is NOT stale', () => {
    // The healthy state, and the guard that stops every case below passing
    // vacuously: `seedDemoAccount` declared, not deployed, ledgered — silent.
    expect(
      classifyStaleLedger(['a', 'seedDemoAccount'], ['a'], ['seedDemoAccount']),
    ).toEqual({nowDeployed: [], noLongerDeclared: []});
  });

  it('🔴 LIVE despite the ledger is the DEPLOY drifting — the dangerous remedy', () => {
    // The seedDemoAccount case. It must land under nowDeployed, because that
    // is the branch whose message refuses to tell the reader to delete the
    // entry.
    expect(
      classifyStaleLedger(
        ['a', 'seedDemoAccount'],
        ['a', 'seedDemoAccount'],
        ['seedDemoAccount'],
      ),
    ).toEqual({nowDeployed: ['seedDemoAccount'], noLongerDeclared: []});
  });

  it('no longer declared is the CODE drifting — removing the entry is right', () => {
    expect(classifyStaleLedger(['a'], ['a'], ['deletedFn'])).toEqual({
      nowDeployed: [],
      noLongerDeclared: ['deletedFn'],
    });
  });

  it('🔑 the two causes are never reported for the same name at once', () => {
    // An entry can be BOTH live and undeclared. Reporting one name twice under
    // contradictory instructions is how a reader ends up doing neither, so it
    // is classified once — under the half with the dangerous remedy.
    const r = classifyStaleLedger(['a'], ['a', 'ghost'], ['ghost']);
    expect(r.nowDeployed).toEqual(['ghost']);
    expect(r.noLongerDeclared).toEqual([]);
    expect(r.nowDeployed.filter((n) => r.noLongerDeclared.includes(n))).toEqual([]);
  });

  it('🔴 requiring the script does not RUN it', () => {
    // The guard that makes this test file possible at all. Without
    // `require.main === module`, importing classifyStaleLedger would shell out
    // to `firebase functions:list` on every `npm test` — a credentialled
    // network call inside the suite that is supposed to need none. Reaching
    // this assertion at all proves main() did not fire on import.
    expect(typeof classifyStaleLedger).toBe('function');
  });
});
