// ---------------------------------------------------------------------------
// What index.ts declares, and what is deliberately not deployed
// ---------------------------------------------------------------------------
//
// W2-92. On 2026-08-15 the ENTIRE family backend was found undeployed: nine
// callables — createFamily, joinFamily, leaveFamily, disbandFamily,
// removeMember, mintFamilyInvite, postFamilyMessage, assignFamilyChore,
// completeFamilyChore — existed on `main` and nowhere else, for days, while a
// client PR wired five controls straight to them.
//
// CRITICAL: EVERY GATE THIS PROJECT OWNS WAS GREEN THE WHOLE TIME, AND THAT IS THE
// FINDING RATHER THAN THE OUTAGE.
//
//   `npm test`        1170 tests — against the SOURCE
//   the rules suite   loads firestore.rules from the REPO
//   `make test`       the client, against FAKES
//
// Not one of them asks PRODUCTION a question. `test-floor.json` exists because
// "one combined number would let a drop in one hide behind a rise in the other"
// — deployment is a third surface, and it had no number at all.
//
// ---------------------------------------------------------------------------
// KEY: WHY THIS FILE HOLDS THE LIST AND THE CHECK LIVES ELSEWHERE
// ---------------------------------------------------------------------------
//
// The comparison needs `firebase functions:list`, which needs CREDENTIALS — and
// CI is out of billing, so it cannot be a test. It is `make check-deployed`,
// run by a human or by W0 before declaring a feature done.
//
// WARNING: THAT SPLIT IS THE WEAK POINT AND IS STATED RATHER THAN HIDDEN: a check
// somebody has to remember is exactly the kind this repo has been bitten by.
// What CAN be gated without credentials is the half below — the ledger, and the
// parser that derives the declared set — so a broken parser or a stale
// exemption fails in `npm test` even though the comparison cannot.

/**
 * Exports that are declared in `index.ts` and deliberately NOT deployed.
 *
 * KEY: Same construction as `KNOWN_MISSING` in productRegistry.test.ts and
 * `KNOWN_UNREACHABLE` in moduleReachability.test.ts: an entry is not a blessing,
 * it is a visible, counted omission with the reason attached. You cannot silence
 * the check by adding a name — only by writing why it is absent.
 */
export const DELIBERATELY_UNDEPLOYED: Record<string, string> = {
  seedDemoAccount:
    'A SEEDING CALLABLE, and putting one in production is a product decision ' +
    'rather than a drift fix. It writes a fabricated account — house, streak, ' +
    'inventory, a week of schedule — and although it refuses to run without ' +
    'both FIREBASE_AUTH_EMULATOR_HOST and SEED_SECRET, the honest reason to ' +
    'keep it out is that nobody has asked for it to exist there. It is the ' +
    'screenshot harness (W2-80); the emulator is where it belongs. 🔴 If it is ' +
    'ever deployed on purpose, DELETE this entry rather than editing it — the ' +
    'stale-entry test will demand that anyway.',
};

/**
 * The number of function exports `index.ts` declares.
 *
 * WARNING: AN ANTI-VACUITY PIN, NOT A BUDGET. The parser that derives the declared set
 * is a regex over source, and this gate's failure mode is a regex that stops
 * matching: it would report "nothing declared", find no drift, and pass
 * forever. This number is what makes a silently-empty parse loud.
 *
 * KEY: IT IS EXPECTED TO CHANGE, and changing it is a one-line, deliberate act
 * every time a function is added or removed. That is the point — the same
 * ratchet shape as the test floors, on the surface that had none.
 *
 * NOTE: The parser already missed one export once: `onNewUserBefriendGibby` is
 * written `export const X = functionsV1Auth\n  .user()`, with the dot on the
 * NEXT LINE, so a pattern requiring `functionsV1Auth.` skipped it and the check
 * reported a phantom "deployed but not declared". Found by running the
 * comparison for real before trusting it.
 */
export const DECLARED_FUNCTION_COUNT = 46;
