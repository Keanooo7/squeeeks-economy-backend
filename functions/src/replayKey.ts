// ---------------------------------------------------------------------------
// Replay keys — one definition of what a valid one is
// ---------------------------------------------------------------------------
//
// W2-19. Extracted from purchaseChest, which had these four checks inline, so
// that purchaseStreakShield reuses the RULE rather than a copy of it.
//
// 🔑 A SECOND DEFINITION OF "VALID REPLAY KEY" IS THE DEFECT THIS CODEBASE KEEPS
// FILING — chest_drop_rates.dart mirroring the drop tables, TASK_LIBRARY_IDS
// mirroring task_library.dart, the FNV-1a hash written twice, kBonusTaskMultiplier
// standing beside BONUS_TASK_MULTIPLIER. Every one drifted or was caught only by
// a mirror test. Two callables validating "the same" key with two copies of four
// conditions is the same shape, one size smaller.
//
// ⚠️ THE CHECKS ARE NOT ARBITRARY AND MUST NOT BE RELAXED. The key BECOMES a
// Firestore document id:
//   · a '/' would silently write into a NESTED COLLECTION rather than failing;
//   · an unbounded string would let a caller author arbitrarily long paths;
//   · an empty string is not a document id at all.
// So this validates the key as what it is about to become, not as a string.
//
// 📌 WHY A REPLAY KEY AND NOT A TRANSACTION. A transaction stops two CONCURRENT
// calls racing. It does nothing about the SAME call arriving twice after a
// dropped response — the client retries, and a second debit is entirely
// consistent from the server's point of view. Those are different problems and
// only one of them is solved by runTransaction. That distinction is W2-18's
// finding and this module exists because of it.

import { HttpsError } from 'firebase-functions/v2/https';

/** Maximum length of a replay key, because it becomes a document id. */
export const MAX_REPLAY_KEY_LENGTH = 128;

/**
 * Throws unless [purchaseId] is usable as a Firestore document id.
 *
 * Callers pass `undefined` freely — an absent key means "no replay protection
 * requested", which is currently allowed. See `replayKeyPolicy` below for why
 * that is not yet an error.
 */
export function assertValidReplayKey(purchaseId: unknown): asserts purchaseId is string | undefined {
  if (purchaseId === undefined) return;
  if (
    typeof purchaseId !== 'string' ||
    purchaseId.length === 0 ||
    purchaseId.length > MAX_REPLAY_KEY_LENGTH ||
    purchaseId.includes('/')
  ) {
    throw new HttpsError(
      'invalid-argument',
      `purchaseId must be a non-empty string of at most ${MAX_REPLAY_KEY_LENGTH} characters and contain no "/"`,
    );
  }
}

/**
 * 🔴 THE KEY IS OPTIONAL, AND THAT IS A DECISION WITH AN EXPIRY, NOT A DESIGN.
 *
 * A client that omits it gets a transaction and NO replay protection. So
 * "purchaseChest has a replay ledger" is weaker than it reads: the ledger exists
 * and the shipped client does not use it.
 *
 * It is optional because making it required is a BREAKING CHANGE — a callable
 * that starts rejecting `{ chestId }` breaks every already-installed build, and
 * TestFlight is imminent. Rejecting old clients at exactly that moment is a bad
 * surprise, so this is not W2's call to make unilaterally.
 *
 * The options, with their costs, are in the W2-19 return. The shape that ends
 * this cleanly is: client starts sending a key (harmless, server already accepts
 * it) → wait for adoption → THEN make it required. Required-first inverts the
 * order and breaks people.
 */
export const REPLAY_KEY_IS_OPTIONAL = true;
