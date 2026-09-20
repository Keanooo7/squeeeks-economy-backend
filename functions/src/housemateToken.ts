// ---------------------------------------------------------------------------
// Housemate verification tokens — the pure half
// ---------------------------------------------------------------------------
//
// W4-36, Phase 1 of `Projects/Cleaning/spec-2026-08-13-in-person-housemate-
// verification.md`. The host taps "verify we live together", the server mints a
// short-lived single-use code, the guest hands that code back, and the server —
// never the client — writes the housemate edge.
//
// ---------------------------------------------------------------------------
// CRITICAL: THE DISPROOF, ANSWERED BEFORE ANY CODE WAS WRITTEN
// ---------------------------------------------------------------------------
//
// The question was whether the existing rules-only path can carry this, because
// every housemate check today lives in firestore.rules and adding the first
// server-side enforcement is not free. Taken one property at a time:
//
//   EXPIRY — rules CAN do this, and the brief's premise was too strong here.
//     `request.time` exists, so `resource.data.expiresAt > request.time` is a
//     legal condition, and a client-written expiry can even be BOUNDED at write
//     time with `request.resource.data.expiresAt < request.time +
//     duration.value(45, 's')`. Expiry alone is not the reason a callable is
//     needed, and saying otherwise would be a plausible finding that is false.
//
//   SINGLE-USE, WITHIN ONE DOCUMENT — rules CAN do this too. A rule reading
//     `resource.data.redeemed == false && request.resource.data.redeemed ==
//     true` is a genuine compare-and-set: rules evaluate against the committed
//     document state, so two concurrent redemptions cannot both pass.
//
//   SINGLE-USE, ACROSS TWO DOCUMENTS — CRITICAL: rules CANNOT do this, and this is the
//     one that kills the rules-only design. Redemption is inherently two
//     writes: consume the token, and append to users/{host}.housemates. Rules
//     evaluate each document's write independently — even inside a batch or a
//     transaction — so no condition on the ROSTER write can require that the
//     TOKEN write happened. A client sending only the roster append passes: the
//     roster rule `get()`s the token document, sees redeemed == false, and
//     allows. The append is then replayable until the cap fills. Nothing in the
//     rules language can bind the two writes together, which is the same
//     limitation already recorded at firestore.rules:30 in a different shape —
//     one condition can only ever see one document's write.
//
//   AND THE HOLE IT WOULD TAKE TO TRY — the guest is not the owner of
//     users/{host}, so a rules-only redemption needs a NEW `allow update` on
//     users/{host} for a NON-OWNER. That branch would have to re-prove every
//     guarantee the isOwner branch gets for free (no CF-owned field may be
//     touched, nothing but `housemates` may change, the cap holds). A
//     non-owner write path onto another player's top-level document is a
//     strictly larger exposure than the feature being built.
//
// OK: SO: two callables. The Admin SDK bypasses rules entirely, which is exactly
// why the callable must carry the cap ITSELF — see HOUSEMATE_CAP.
//
// ---------------------------------------------------------------------------
// WARNING: WHAT THIS PROVES, STATED ONCE AND NOT OVERSOLD
// ---------------------------------------------------------------------------
//
// INTENT, NOT PRESENCE. A code on one screen can be read aloud, screenshotted,
// or texted; Phase 2's QR changes the ergonomics and none of the security. The
// radio handshake (Phase 3) is the part that would prove two people were in a
// room together, and it does not exist. What the 45 seconds and the single use
// DO buy is that the two people must be coordinating in real time and that
// NEITHER can grant themselves anything — which is a real bar, just a lower one
// than Apple's or Google's. CRITICAL: No field written by this module may ever be
// rendered as "verified in person".
//
// ---------------------------------------------------------------------------
// NOTE: THE GRANT IS MUTUAL, AND THAT IS A DECISION
// ---------------------------------------------------------------------------
//
// The existing ask/accept flow is one-directional: A asks, B adds A to B's
// roster, A may now see B's house and not the reverse. A redemption writes BOTH
// rosters instead. Two reasons:
//   1. Both parties performed an affirmative act — the host tapped mint, the
//      guest tapped redeem — so both consents exist, which is not true of the
//      one-sided ask.
//   2. "We live together" that grants one-way visibility would need the pair to
//      run the whole flow twice, and any UI honest about the asymmetry would be
//      confusing enough that nobody would.
// The cap is therefore checked on BOTH rosters before either is written; a full
// house on either side refuses the whole redemption rather than half-granting.

import { randomBytes } from 'crypto';

/**
 * How long a minted code stays redeemable, in seconds.
 *
 * KEY: "Tens of seconds, not minutes" is the spec's bar, and the reason is that a
 * token which outlives the moment is a token that can be forwarded. 45 leaves
 * room to unlock a phone and open a scanner while staying unambiguously short
 * of the minute that would read as "text it to me".
 *
 * WARNING: Raising this past ~60 changes what the feature claims. It is not a tuning
 * knob; it is the only thing standing between "you were both here" and "someone
 * sent you a code".
 */
export const HOUSEMATE_TOKEN_TTL_SECONDS = 45;

/**
 * Alphabet for a minted code. Crockford base32 — no I, L, O or U, so nothing
 * is ambiguous when a human reads it off a screen, and no accidental words.
 *
 * KEY: EXACTLY 32 CHARACTERS, and that is load-bearing. 256 is divisible by 32,
 * so `byte % 32` is uniform. A 33-character alphabet would silently bias the
 * first character of every code ever minted, with no test able to see it.
 */
export const HOUSEMATE_TOKEN_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Code length. 10 x 5 bits = 50 bits of entropy.
 *
 * The threat is online guessing against a live token, not offline cracking:
 * a code is only valid for HOUSEMATE_TOKEN_TTL_SECONDS, and guessing one in
 * that window means ~2^49 callable invocations. WARNING: Nothing rate-limits the
 * redeem callable itself — the same gap recorded for submitGalleryFeedback —
 * so the entropy is doing all of the work here, deliberately.
 */
export const HOUSEMATE_TOKEN_LENGTH = 10;

/**
 * CRITICAL: THE CAP, MIRRORED FROM `housemateCap()` IN firestore.rules — AND THE
 * MIRROR IS WHY THIS CONSTANT IS DANGEROUS.
 *
 * A second definition of a shared number is the defect this codebase keeps
 * filing (chest_drop_rates.dart, TASK_LIBRARY_IDS, kBonusTaskMultiplier). It
 * cannot be avoided here: rules and TypeScript share no source of truth, and
 * the redemption write goes through the Admin SDK, WHICH BYPASSES RULES
 * ENTIRELY. So firestore.rules does not and cannot gate this path — the
 * callable is the gate, and the rules are the second gate on the OTHER,
 * client-written path that still exists.
 *
 * What keeps the two honest is a test that parses `housemateCap()` out of
 * firestore.rules and asserts it equals this number.
 */
export const HOUSEMATE_CAP = 4;

/** A minted token, as it is stored and read back. */
export interface HousemateTokenDoc {
  /** Who minted it. The roster edge is written between this uid and the guest. */
  hostUid: string;
  /** Milliseconds since epoch, server clock. */
  createdAtMs: number;
  /** createdAtMs + TTL. Stored rather than derived so the TTL can change without reinterpreting live tokens. */
  expiresAtMs: number;
  /** Set exactly once, by the redemption transaction. Its presence IS "spent". */
  redeemedAtMs?: number;
  /** Who spent it. Kept for the audit trail, never read back by the client. */
  redeemedByUid?: string;
}

/**
 * Mints a code.
 *
 * `random` is injectable so a test can pin the bytes; production always uses
 * `crypto.randomBytes`. CRITICAL: Never `Math.random()` — it is seeded, predictable
 * and would make the 50 bits above a fiction.
 */
export function generateHousemateTokenCode(
  random: (n: number) => Uint8Array = randomBytes,
): string {
  const bytes = random(HOUSEMATE_TOKEN_LENGTH);
  let out = '';
  for (let i = 0; i < HOUSEMATE_TOKEN_LENGTH; i++) {
    out += HOUSEMATE_TOKEN_ALPHABET[bytes[i] % HOUSEMATE_TOKEN_ALPHABET.length];
  }
  return out;
}

/**
 * True when [code] is shaped like something this server minted.
 *
 * NOTE: Stricter than `assertValidReplayKey`, and NOT a copy of it. A replay key
 * is authored by the client, so that rule can only validate a string as a
 * usable document id. This alphabet is chosen by the SERVER, so anything
 * outside it was not minted here and can be refused before a read — which also
 * means no attacker-chosen string ever becomes a document path segment.
 */
export function isValidHousemateTokenCode(code: unknown): code is string {
  if (typeof code !== 'string') return false;
  if (code.length !== HOUSEMATE_TOKEN_LENGTH) return false;
  for (const ch of code) {
    if (!HOUSEMATE_TOKEN_ALPHABET.includes(ch)) return false;
  }
  return true;
}

/** How a refusal is reported: an HttpsError code plus words a client can show. */
export interface Refusal {
  ok: false;
  code:
    | 'not-found'
    | 'invalid-argument'
    | 'failed-precondition'
    | 'deadline-exceeded'
    | 'already-exists'
    | 'resource-exhausted';
  reason: string;
}

export type Verdict<T> = ({ ok: true } & T) | Refusal;

/**
 * PURE. Decides whether [token] may be redeemed by [guestUid] at [nowMs].
 *
 * Every branch here is a BEHAVIOUR a test can drive, which is the point of
 * splitting it out of the transaction: "an expired token fails" is then an
 * assertion about a decision, not about a field existing.
 */
export function evaluateRedemption(
  token: HousemateTokenDoc | null,
  guestUid: string,
  nowMs: number,
): Verdict<{ hostUid: string }> {
  if (token === null) {
    // Deliberately the same refusal a well-formed but unknown code gets. A
    // guesser learns nothing from it; the real user is told to ask for a fresh
    // code either way.
    return { ok: false, code: 'not-found', reason: 'That code is not valid. Ask for a fresh one.' };
  }
  if (token.redeemedAtMs !== undefined) {
    return {
      ok: false,
      code: 'already-exists',
      reason: 'That code has already been used. Codes work exactly once.',
    };
  }
  if (nowMs >= token.expiresAtMs) {
    return {
      ok: false,
      code: 'deadline-exceeded',
      reason: `That code expired. They only last ${HOUSEMATE_TOKEN_TTL_SECONDS} seconds — ask for a new one.`,
    };
  }
  if (token.hostUid === guestUid) {
    // CRITICAL: THE SELF-GRANT. Without this, one person with one phone mints and
    // redeems their own code and the whole feature is a button that says yes.
    return {
      ok: false,
      code: 'failed-precondition',
      reason: 'You cannot redeem your own code.',
    };
  }
  return { ok: true, hostUid: token.hostUid };
}

/** Reads a roster field defensively — absent, null and junk all mean "empty". */
export function rosterOf(userData: Record<string, unknown> | undefined | null): string[] {
  const raw = userData?.housemates;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

/**
 * PURE. The roster [roster] with [uid] added, or a refusal if the house is full.
 *
 * Already-present is a SUCCESS with an unchanged roster, not a refusal: a pair
 * who are already housemates re-running the flow should not see an error, and
 * the cap must not be tripped by someone who is already inside it.
 */
export function appendHousemate(roster: string[], uid: string): Verdict<{ roster: string[] }> {
  if (roster.includes(uid)) return { ok: true, roster };
  if (roster.length >= HOUSEMATE_CAP) {
    return {
      ok: false,
      code: 'resource-exhausted',
      reason: `A household holds ${HOUSEMATE_CAP} people. Remove someone first.`,
    };
  }
  return { ok: true, roster: [...roster, uid] };
}
