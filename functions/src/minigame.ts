// ---------------------------------------------------------------------------
// The organisation mini-game — server half
// ---------------------------------------------------------------------------
//
// Spec: Projects/Cleaning/spec-2026-08-12-organization-minigame.md (M2).
//
// KEY: THE SERVER VALIDATES THE CLAIM, NOT THE DRAG. It does not know what the
// puzzle was, does not receive the arrangement, and cannot check it. That is
// deliberate and it is the whole architecture:
//
//   Replaying the arrangement server-side would be a SECOND IMPLEMENTATION of
//   the slot-fit rule. Two implementations of one rule is the defect this
//   codebase keeps filing — chest_drop_rates.dart mirroring the drop tables,
//   TASK_LIBRARY_IDS mirroring task_library.dart, the FNV-1a hash written twice.
//   Every one of them has drifted or been found only by a mirror test.
//
// WARNING: SO WHAT IS THE EXPOSURE, STATED PLAINLY RATHER THAN GLOSSED? A player with
// a debugger can call this and collect the reward without solving anything. That
// is accepted, and it is bounded by the same thing that bounds it for a solved
// puzzle: ONCE PER DAY, at a value nobody has set yet.
//
// CRITICAL: W2-172 — THE BOUND THAT ACCEPTANCE RESTED ON DID NOT HOLD, AND THIS
// PARAGRAPH IS WHERE IT MATTERS. The sentence above is the risk argument, and
// every word of it is fine EXCEPT that "once per day" was enforced by a key the
// caller supplied: `clientNowIso.slice(0, 10)`. `canClaimMinigame` keeps one
// row and grants on any key that is not the last one, so alternating two
// well-formed dates collected the reward without bound — the callable being
// DEPLOYED, ACTIVE and `ingressSettings: ALLOW_ALL` the whole time. The
// acceptance was not wrong to be made; it was made against a bound that was not
// there. `minigameDayKey()` below is what puts it there.
//
// KEY: The lesson is the shape, not the bug: an accepted risk NAMES what bounds
// it, and that named bound is a claim to be checked like any other. The alternative costs a
// duplicated rule engine and buys protection against a player cheating
// themselves out of a puzzle they chose to play. minigame.test.ts PINS the
// no-validation property so that a later "fix" has to argue with a test rather
// than quietly ship the puzzle twice.
//
// ---------------------------------------------------------------------------
// NOTE: THE DAILY CLOCK IS REUSED, AND IT IS NOT subjectForDay
// ---------------------------------------------------------------------------
//
// The spec says "reuse the existing daily-rotation pattern — rotateMarket and
// subjectForDay ... don't write a second daily clock". The instruction is right
// and the named function is not the one to reuse. Two different things are
// bundled in that sentence:
//
//   THE CLOCK          `clientNowIso.slice(0, 10)` -> a `YYYY-MM-DD` dayKey,
//                      exactly as recordTaskCompletion derives it (index.ts).
//                      Reused here. This is what "don't write a second daily
//                      clock" is protecting.
//   THE SUBJECT PICKER `subjectForDay(category, dateStr)` (itemPool.ts:169) —
//                      answers "which SUBJECT does this SHOP CATEGORY theme on
//                      today". NOT reused, on purpose.
//
// CRITICAL: WHY NOT: subjectForDay reads DAILY_SUBJECT_POOLS, which is gated by a SHOP
// invariant — dailyRotation.test.ts enforces that a subject may only enter the
// pool once it is STOCKED AT EVERY RARITY, because a themed chest that cannot
// fill its tail refuses a purchase the player can see and afford. And
// itemPool.ts records that adding a subject HALVES the existing one's rotation,
// measured when `fox_outfit` landed (W3-09).
//
// So making the mini-game's variety a function of that pool would weld the
// puzzle to the shop's inventory-coverage rule: you could not add a puzzle
// without also stocking a chest at three rarities, and adding one would change
// shop theming as a side effect. Nobody asked for that.
//
// KEY: AND THE SERVER DOES NOT NEED IT. Because it validates the claim rather than
// the puzzle, it never has to know WHICH puzzle today was. The coupling would be
// imported for no benefit whatsoever. If the puzzle rotation ever needs to be
// server-driven, that wants its own pool and its own brief.

/**
 * CRITICAL: PROVISIONAL — AWAITING BRENDAN, exactly like QUEST_REWARDS.
 *
 * Not priced here, and the reason is arithmetic rather than caution: at 50/day
 * this is up to 350 sponges a week from the mini-game ALONE, against quests at
 * 50-100 a tier and chests at 100-500. The mini-game and the quest economy have
 * to be priced TOGETHER or the shop stops mattering, and neither number is ours.
 *
 * NOTE: THIS IS THE ONLY PLACE THE VALUE LIVES. The callable reads it; nothing
 * hardcodes it. minigame.test.ts asserts that, mirroring the rule that kept the
 * quest economy a one-file edit.
 */
export const MINIGAME_REWARD = {
  sponges: 50,
} as const;

/** WARNING: PROVISIONAL — see above. */
export const MINIGAME_REWARDS_ARE_PROVISIONAL = true;

/**
 * The day this claim belongs to, **derived from the server clock**.
 *
 * CRITICAL: IT TAKES NO CLIENT INPUT, AND THAT IS THE WHOLE POINT. Until W2-172 the
 * handler used `clientNowIso.slice(0, 10)` — a value the caller supplies — as
 * the once-per-day key, while `canClaimMinigame` keeps exactly ONE row. Any
 * dayKey that is not the last one grants, so an authenticated caller alternating
 * two well-formed dates minted 50 sponges per call, unbounded. The format regex
 * checked the SHAPE of the date and never its distance from now.
 *
 * KEY: THE RULE WAS ALREADY WRITTEN IN THIS CODEBASE, at index.ts:2161-2167:
 * "`loggedAt`, NEVER `dayKey` … what an entitlement must never trust, because it
 * is CLIENT-SUPPLIED. A device clock rolled forward and back manufactures three
 * weeks of habit in one evening." `grantProPromo` obeys it. This did not.
 *
 * NOTE: `new Date().toISOString().split('T')[0]` is the existing server-day shape in
 * this repo, not a new one — index.ts:482, :3138, :3485 (submitGalleryFeedback's
 * own per-day cap) and notifications.ts:27 all derive a day exactly this way.
 * Reusing it beats inventing a fourth.
 *
 * WARNING: THIS IS A UTC DAY, AND THAT IS A PRODUCT CONSEQUENCE, NOT A DETAIL. The
 * reset lands at 00:00 UTC, so a player in UTC+13 rolls over at 13:00 local
 * rather than midnight. No client calls this callable today — there has never
 * been one — so nothing observable changes now, and the alternative (trusting
 * the device's local day) is the defect this function exists to remove. If
 * "their" local day turns out to be required, it needs a SECOND, server-verified
 * signal (an offset bounded against the server clock), not this key.
 *
 * @param now injected so a test can pin a boundary rather than sample the clock.
 */
export function minigameDayKey(now: Date = new Date()): string {
  return now.toISOString().split('T')[0];
}

/** The per-player, per-day claim ledger document shape. */
export interface MinigameLedger {
  /** `YYYY-MM-DD` of the day this ledger refers to. */
  date?: string;
  claimed?: boolean;
}

/**
 * PURE. Whether [uid]'s mini-game reward is still unclaimed on [dayKey].
 *
 * KEY: A ledger from a PREVIOUS day is stale, not a claim — it means "yesterday
 * was claimed", which says nothing about today. Reading it as a claim would
 * lock a player out permanently after their first solve. Same shape, and the
 * same reasoning, as grantTaskRewards treating a previous day's paidCount as 0
 * rather than carrying it forward.
 */
export function canClaimMinigame(
  ledger: MinigameLedger | undefined,
  dayKey: string,
): boolean {
  if (!ledger) return true;
  if (ledger.date !== dayKey) return true;
  return ledger.claimed !== true;
}
