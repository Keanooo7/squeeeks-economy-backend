// ---------------------------------------------------------------------------
// What a family IS — the group document, and the pure half of the entitlement
// fan-out
// ---------------------------------------------------------------------------
//
// W2-76, stage 1 of `Projects/Cleaning/spec-2026-08-15-family-plan.md`. The
// Control Center, the message board, the shared task board and trash-day
// shared completion are all screens or writes over the thing defined here, and
// none of them can be built until "a family" names something.
//
// ---------------------------------------------------------------------------
// 🔴 THE DISPROOF: WHY THIS IS NOT `users/{uid}.housemates`
// ---------------------------------------------------------------------------
//
// The brief required this question to be answered before any code: a family
// model that cannot explain why it is not a housemates array has not been
// designed. The cheaper design — derive every family property from the roster
// that already exists — was taken seriously and fails on four counts, of which
// the first is fatal on its own.
//
//   🔴 THE ROSTERS NEED NOT AGREE, SO THERE IS NO FACT OF THE MATTER.
//     `housemates` is a flat array of PEER edges on each user's own document
//     (firestore.rules housemates(), users/{uid}). A's roster may read [B, C]
//     while B's reads [A] and C's reads []. Ask "who is in this family" and
//     the data has three different answers and no tiebreak. Every question
//     this feature asks — who gets Pro, who may post to the board, who is
//     assigned the chore — needs ONE answer. A group document has exactly one
//     because membership is a field on a single document rather than a
//     consensus over N of them. Note the redemption path writes BOTH rosters
//     (housemateToken.ts, "THE GRANT IS MUTUAL"), so PAIRS agree — but
//     agreement between pairs is not transitivity, and a family is not a set
//     of pairs.
//
//   🔴 A SUBSCRIPTION NEEDS A SINGLE OWNER, AND PEER EDGES HAVE NO
//     DISTINGUISHED NODE. Brendan's requirement is that the controlling parent
//     holds the plan. In a symmetric edge set there is nothing to attach that
//     to and nothing to stop two members each believing they are the payer.
//     `ownerUid` is one field precisely because the alternative is a race.
//
//   🔴 THE CAP CANNOT BE ENFORCED, AND THIS IS THE ALREADY-RECORDED RULE. "A
//     cap enforced on a per-edge grant is vacuous until the roster is counted
//     in one place." Rules cannot aggregate across documents, so a per-user
//     roster cap bounds how many edges ONE user issued and says nothing about
//     the size of the group those edges induce. Four users each holding four
//     housemates is a connected component of up to thirteen. FAMILY_CAP below
//     is enforceable ONLY because memberUids is one array on one document —
//     the group document is not incidentally convenient for the cap, it is the
//     thing that makes the cap mean anything.
//
//   📌 A MESSAGE BOARD NEEDS A CONTAINER THAT IS NOBODY'S USER DOCUMENT.
//     Hanging shared posts off one member's document makes that member's
//     account the substrate for everyone else's data, and their account
//     deletion everyone else's data loss.
//
// ✅ SO: `families/{familyId}`, with `housemates` LEFT ALONE as the peer
// visibility mechanism it already is. The two are not redundant and neither
// replaces the other: housemates answers "may this person see my house", the
// family answers "who are we". A member of a family is not automatically a
// housemate and this module never writes that array.
//
// ---------------------------------------------------------------------------
// 🔑 FAMILY IS A SOURCE OF PRO, NOT A TIER — AND THE SHAPE THAT FOLLOWS
// ---------------------------------------------------------------------------
//
// `SubscriptionTier` is `enum { free, pro }` (subscription_tier.dart). The
// brief recommended family be a way of ACQUIRING pro rather than a level above
// it, matching Brendan's own words — "everyone in the family gets pro", not
// "gets family" — and this module implements that. The recoverability argument
// decided it: adding a third tier later is additive, removing one is a
// migration across every entitlement check, rule, CF-owned field gate and
// client branch that switches on the string.
//
// ⚠️ THE STOREKIT SERVICE LEVEL IS A DIFFERENT NUMBER ABOUT A DIFFERENT THING,
// and conflating the two is the easy mistake here. #380 ranked
// `sub_family_monthly` at service LEVEL 1, above Pro, so that Pro→Family is an
// immediate prorated upgrade rather than a crossgrade deferred up to a year for
// an annual subscriber. #382 then reverted #380 — the product turned
// `product_availability_test.dart` red because the app queries a fixed id list
// — but the ranking ARGUMENT survives as analysis, in
// `Projects/Cleaning/asc-family-product-2026-08-15.md`.
//
// Either way it is a statement about Apple's upgrade/downgrade direction
// between PRODUCTS. It is not a statement about this app's entitlement enum,
// which still has two values. A family subscriber and a Pro subscriber are
// entitled to the same thing; they differ in how many people that entitlement
// reaches. 🔑 The revert is also the reason this question is still OPEN and
// still this module's to answer: patching #380 forward would have settled it in
// a hotfix, in lib/, under time pressure. It was reverted instead.
//
// ---------------------------------------------------------------------------
// 🔴 THE FAN-OUT IS A DATED FIELD, AND THE DATE IS THE WHOLE SAFETY ARGUMENT
// ---------------------------------------------------------------------------
//
// The fan-out writes `familyProExpiresAt` onto each member's `users/{uid}`,
// and `resolveEffectiveTier` honours it. Three properties, in the order they
// matter:
//
//   1. IT FAILS CLOSED ON THE CLOCK, WITH NO WRITER REQUIRED. The grant is a
//      timestamp, never a boolean. If every Cloud Function in this repository
//      stopped running tonight, every family grant would still lapse on its
//      own date. `familyProUntil: true` would fail OPEN forever, and the thing
//      that revokes it would be code that has to run — which is the assumption
//      the REFUND branch already exists because you cannot make.
//
//   2. IT NEVER OUTLIVES THE PAYER. FAMILY_GRANT_EXPIRY_SOURCE: the member's
//      expiry is the OWNER's `subscriptionExpiresAt`, copied, never extended.
//      So a member cannot be entitled past the period the owner actually paid
//      for even if no revoke ever runs, and a stale fan-out degrades to
//      "correct until the owner's period ends" instead of "wrong forever".
//
//   3. IT KEEPS `resolveEffectiveTier` PURE AND SINGLE-DOCUMENT. That function
//      is called inside `grantTaskRewards`'s transaction (taskRewards.ts) and
//      at two more sites in index.ts. Making entitlement depend on a SECOND
//      document read would put a cross-document read inside a transaction on
//      the hot completion path, and would make the single authority on
//      entitlement async. The fan-out moves that cost to membership-change and
//      renewal time, which happen orders of magnitude less often.
//
// ⚠️ THE RESIDUAL HOLE, STATED RATHER THAN HIDDEN: a MID-PERIOD refund of the
// owner's family subscription. Natural expiry is covered by property 2 — the
// clock owns it. A refund is the one ending that revokes mid-period, which is
// exactly why `REFUND` is the only App Store notification branch that writes
// (see the handoff's "deliberately correct" list). So the refund path must
// re-run the fan-out, and `planFamilyFanOut` returning a REVOKE plan is how it
// does. Until index.ts calls it there, a refunded family owner's MEMBERS keep
// Pro until the owner's original expiry. That call site is named in the PR and
// is not yet wired — see WIRING, below.
//
// ---------------------------------------------------------------------------
// 📌 WIRING — WHAT THIS MODULE DOES NOT DO, SO NOBODY READS IT AS DONE
// ---------------------------------------------------------------------------
//
// This is the pure half plus the rules and the resolver change. It does NOT
// create families (no callable yet), does not run on renewal, and does not run
// on refund. `planFamilyFanOut` is a pure function with no caller in
// production code, which `moduleReachability.test.ts` would normally flag —
// the entry is declared there deliberately and with this reason.
//
// ⚠️ AND NONE OF THE RULES IN firestore.rules PROTECT ANYONE UNTIL DEPLOYED.
// That file's header says so and it is still true: no window and no CI job
// runs `firebase deploy --only firestore:rules`. It protects the rules FILE;
// the file protects nobody until deployed.

/**
 * How many people may be in one family.
 *
 * 🔴 DECIDED 2026-08-19, BY BRENDAN, ANSWERING W1-133's ESCALATION: FIVE — AND
 * FIVE IS THE TOTAL, so four people besides whoever started it. `memberUids`
 * "includes the owner" (see FamilyDoc) and is bounded by this, so the two
 * agree; it is written in both forms because the alternative reading costs a
 * whole seat and would surface only to a family that could not add its last
 * member.
 *
 * 🔑 THE PREVIOUS VALUE PREDICTED THIS ANSWER AND SAID SO, WHICH IS WHY THIS
 * IS ONE LINE AND NOT A MIGRATION. It was 4, decided 2026-08-14, and that
 * comment recorded its own doubt in as many words: "a family of five is a
 * normal family — two parents and three children — so 4 is very likely wrong
 * for this feature and is NOT being asserted as right." It also chose the
 * recoverable direction on purpose — raising a cap later is additive and harms
 * nobody, while lowering one means either evicting members who are already in
 * a family or grandfathering them. That reasoning is being cashed in here, not
 * re-argued.
 *
 * REJECTED: reading the decision as "five BESIDES the owner" (six total).
 * W1-133 refused to resolve the total-versus-besides ambiguity by inference
 * and escalated instead, and the answer came back in the form this file
 * demands — "5 total including the owner". The rejected reading is recorded
 * because it is the one that comes back: W0 once proposed 6 "because Apple
 * Family Sharing is 6" while meaning six BESIDES the owner, and Apple's six
 * INCLUDES the organiser, so that argument compared two different numbers
 * wearing one label. Any future proposal to move this number says TOTAL or
 * BESIDES in the same breath, or it is not yet a proposal.
 *
 * ⚠️ DELIBERATELY A SEPARATE CONSTANT FROM `HOUSEMATE_CAP` rather than an
 * import of it. They answer different questions — "how many people may see my
 * house" versus "how many people does one subscription cover" — and the second
 * has a price attached. Aliasing them would mean answering Brendan's cap
 * question for families silently changed the housemate cap too. As of this
 * decision they are DIFFERENT numbers — 5 here, 4 there — so the independence
 * is now visible in the values rather than only asserted in this comment.
 */
export const FAMILY_CAP = 5;

/**
 * Minimum members for a family to be worth existing: the owner plus one.
 *
 * A family of one is a Pro subscription with extra steps, and permitting it
 * would make `familyProExpiresAt` a second, parallel way to be entitled to
 * exactly what `subscriptionTier` already grants you — two sources of one
 * truth, for no gain.
 */
export const FAMILY_MIN_MEMBERS = 2;

/**
 * The Apple product behind a family plan.
 *
 * ✅ THE PRODUCT NOW EXISTS IN BOTH PLACES (W2-157, 2026-08-24). This header
 * used to open "🔴 THIS PRODUCT DOES NOT EXIST ANYWHERE YET … no StoreKit
 * product, no App Store Connect product, and nothing server-side that has ever
 * seen this string in a receipt." Every clause of that is now false:
 *
 *   App Store Connect   Apple ID 6801924400, Prepare for Submission,
 *                       Family Sharing ON (verified by Brendan 2026-08-24)
 *   StoreKit            ios/Configuration.storekit, displayPrice 12.99,
 *                       familyShareable FALSE — deliberate, #380 / 6d00fc8
 *   server-side         functions/src/proReceipt.ts prices it, so a family
 *                       purchase now composes a receipt naming this string
 *
 * 📌 THE #380/#382 HISTORY IS KEPT BECAUSE IT STILL EXPLAINS A CONSTRAINT, not
 * because it describes today. #382 reverted #380 for a real reason — the app
 * queries a FIXED LIST of product ids, and adding one the list did not contain
 * turned `product_availability_test.dart` red on main. Anyone touching the
 * product list still has to satisfy that test.
 *
 * ⚠️ APPLE FAMILY SHARING (ON in ASC) AND `familyShareable` (FALSE in StoreKit)
 * NOW DISAGREE, AND THAT IS NOT THIS FILE'S TO RESOLVE. W4-131 established the
 * StoreKit flag is deliberate; the reconciliation is Brendan's and is on his
 * list. Named here so the next reader does not "fix" one side of it.
 *
 * It is declared here anyway because `planFamilyFanOut`'s caller has to name
 * the product it is fanning out FOR, and a string literal repeated at each
 * future call site is the shape this repo has already been bitten by
 * (chest_drop_rates.dart, TASK_LIBRARY_IDS, and HOUSEMATE_CAP's own mirror
 * warning two constants above).
 *
 * 📌 THE RE-LAND IS CONSTRAINED BY A FINDING THAT SURVIVED THE REVERT, because
 * it is analysis rather than code: the family product must OUTRANK Pro in its
 * subscription group. At equal service level a switch is a CROSSGRADE, and a
 * crossgrade between different durations defers to the next renewal — which for
 * `sub_pro_annual` means paying for Family and waiting up to a YEAR to receive
 * it. Written up in `Projects/Cleaning/asc-family-product-2026-08-15.md`.
 *
 * ⚠️ That constrains whoever re-lands the product. It does NOT decide this
 * module's question: StoreKit service level is about Apple's upgrade direction
 * between PRODUCTS, and says nothing about whether this app's entitlement enum
 * grows a third value. See the header — it does not.
 */
export const FAMILY_PRODUCT_ID = 'sub_family_monthly';

/**
 * The family group document, as stored at `families/{familyId}`.
 *
 * ⚠️ EVERY FIELD HERE IS SERVER-WRITTEN. `firestore.rules` allows clients to
 * READ a family they belong to and to write NOTHING — see the families match
 * block. That is the recoverable direction: opening a field to client writes
 * later is additive, closing one after clients depend on it is a breaking
 * change plus a security review.
 */
export interface FamilyDoc {
  /**
   * The controlling parent. Holds the subscription, and is the single node
   * that peer edges could not provide.
   *
   * 🔑 ALWAYS ALSO PRESENT IN `memberUids`. The owner is a member who happens
   * to pay, not a separate role outside the roster — otherwise every member
   * count, every cap check and every fan-out has to remember to add one, and
   * one of them eventually will not.
   */
  ownerUid: string;
  /** Everyone in the family, INCLUDING the owner. Bounded by FAMILY_CAP. */
  memberUids: string[];
  /**
   * Display names, keyed by uid — a DENORMALISED COPY, and the reason is a
   * rules problem rather than a performance one.
   *
   * 🔴 A FAMILY MEMBER CANNOT READ ANOTHER MEMBER'S NAME ANY OTHER WAY.
   * `publicProfiles/{uid}` grants `get` to the owner, to anyone holding a
   * friend edge, or when `isPublic == true` — and `isPublic` DEFAULTS FALSE
   * (`buildPublicProfile`: `data.isPublic === true`). Family membership is not
   * one of the conditions. So the family page, which needs a name per member,
   * had no readable source for one.
   *
   * 🔑 DENORMALISED HERE RATHER THAN WIDENING publicProfiles, deliberately.
   * `families/{familyId}` already grants read to its own members, so this is
   * ONE document read that returns the roster and the names together. Widening
   * the profile rule instead would need TWO rules `get()`s per profile — the
   * reader's familyId and the target's, since neither is on the profile — and
   * would expose names to a wider set than intended. The narrow-looking fix is
   * the broader one here.
   *
   * ⚠️ IT GOES STALE ON A RENAME, and that is accepted rather than unnoticed:
   * `publicProfiles` has exactly the same property from exactly the same cause
   * (a copy of the Auth record, refreshed only when something writes). A
   * rename-propagation path is one brief, not this one.
   *
   * 📌 A MISSING ENTRY IS NORMAL, NOT AN ERROR. An Auth record can be absent or
   * carry no displayName, and a document can outlive its Auth user — the same
   * degradation `syncPublicProfile` already handles by writing an empty name.
   * Readers must tolerate a uid with no entry.
   */
  memberNames?: Record<string, string>;
  /**
   * Avatar IDS, keyed by uid — denormalised for the same reason as
   * `memberNames`, and blocked by the same rule.
   *
   * 🔴 AN **ID**, NOT AN ASSET PATH, AND THAT IS THE WHOLE DECISION.
   * `users/{uid}.avatarUrl` stores a STABLE ID (`'fox'`) — the name is legacy;
   * old values holding a real Storage URL still resolve — and
   * `avatarAssetFor` (avatar_catalog.dart) maps it to
   * `assets/images/avatars/<name>.webp` on the CLIENT.
   *
   * 🔑 THE SERVER HAS NO BUSINESS MINTING ASSET PATHS. Storing a resolved path
   * here would be a SECOND vocabulary for something the client already owns —
   * and the moment an asset is renamed or the catalogue moves, every stored
   * path is a broken-image box that no test would catch, because nothing
   * server-side can know the bundle. Storing the id keeps ONE resolver.
   *
   * 📌 The equipped CHARACTER was the other candidate and is deliberately not
   * used: it lives inside `users/{uid}/house/layout`, a large client-owned save
   * that stays denied cross-user, and it is not a small stable value. The
   * profile avatar is the field the app already treats as "this person's
   * picture".
   *
   * ⚠️ A MISSING ENTRY IS NORMAL — a user who never chose one has no value, and
   * `avatarAssetFor(null)` already returns null for exactly that case.
   */
  memberAvatars?: Record<string, string>;
  /**
   * The weekday the bins go out, shared by the whole family. Monday = 1 …
   * Sunday = 7 — Dart's `DateTime.weekday`, the convention `weekStartKey`
   * (demoAccount.ts) already writes down.
   *
   * 🔴 THIS FIELD EXISTS BECAUSE THE DOCUMENT KEY IS DERIVED FROM IT, AND THE
   * DERIVATION USED TO HAPPEN PER DEVICE. `#490` made one member taking the
   * bins out clear it for everyone, keyed by bin DATE
   * (`families/{id}/trashDay/YYYY-MM-DD`). The date came from each member's own
   * SharedPreferences weekday, so a family that disagreed by one weekday wrote
   * and watched DIFFERENT DOCUMENTS — every member's takeover stayed on screen
   * and nothing anywhere reported it. One value on one document is what makes
   * the disagreement unrepresentable rather than merely discouraged.
   *
   * ⚠️ ABSENT IS NORMAL AND IS NOT AN ERROR. Every family created before this
   * field existed has none, and a family whose owner has never set one has
   * none. Readers fall back to the member's own local value — the solo path,
   * unchanged. **Do not write a default here**: a server-chosen weekday would
   * silently move a household's bin day to something nobody picked.
   */
  binWeekday?: number;
  /** Milliseconds since epoch, server clock. */
  createdAtMs: number;
}

/** Why a candidate family document is not a valid one. */
export type FamilyInvalidReason =
  | 'owner-missing'
  | 'owner-not-a-member'
  | 'duplicate-members'
  | 'too-few-members'
  | 'over-cap';

/**
 * The structural invariants of a family, checked in one place.
 *
 * 🔑 `owner-not-a-member` and `duplicate-members` are the two that carry
 * weight, and both are about the CAP rather than about tidiness. If the owner
 * could sit outside `memberUids`, the array would undercount the people a
 * subscription covers by exactly one. If a uid could appear twice, the array
 * would OVERcount — and a family could be padded to the cap with one repeated
 * uid, which is harmless, or trimmed under it by deduplication, which is not.
 * A cap over a list only means anything if the list is a set.
 */
export function familyInvalidReason(
  family: FamilyDoc,
): FamilyInvalidReason | null {
  if (!family.ownerUid) return 'owner-missing';
  if (!family.memberUids.includes(family.ownerUid)) return 'owner-not-a-member';
  if (new Set(family.memberUids).size !== family.memberUids.length) {
    return 'duplicate-members';
  }
  if (family.memberUids.length < FAMILY_MIN_MEMBERS) return 'too-few-members';
  if (family.memberUids.length > FAMILY_CAP) return 'over-cap';
  return null;
}

/** True when [family] satisfies every invariant in [familyInvalidReason]. */
/**
 * Structurally sound: an owner who is in their own roster, no duplicates, and
 * within the cap. **Says nothing about the family being big enough to grant.**
 *
 * 🔴 THIS EXISTS BECAUSE `isValidFamily` MADE THE WHOLE FEATURE UNREACHABLE, and
 * every test missed it by seeding a state the system could not produce.
 *
 * `createFamily` writes `memberUids: [ownerUid]` — one member, deliberately,
 * because that is the only way to reach two. But `isValidFamily` includes
 * `too-few-members` (< FAMILY_MIN_MEMBERS), so EVERY LIFECYCLE OPERATION
 * REFUSED THE STATE createFamily HAD JUST CREATED:
 *
 *   · joinFamily      → `invalid-family`. NOBODY COULD EVER JOIN A NEW FAMILY.
 *   · leaveFamily     → the same, once a family fell back to one member.
 *   · disbandFamily   → so an owner could not even END a family everyone left.
 *
 * The create→invite→join path could never complete, and the suite was green
 * because W2-83's fixtures seeded `[OWNER, KID]` — a roster only reachable
 * AFTER a successful join, which could not happen. A fixture asserting a state
 * the system cannot produce is the same class as a control that passes on seed
 * order: it describes an intention rather than the code.
 *
 * 🔑 MIN_MEMBERS IS A GRANTING RULE, NOT A STRUCTURAL ONE. "A family of one is a
 * Pro subscription with extra steps" is a correct reason not to ENTITLE anyone
 * through it, and a wrong reason to refuse the join that would make it two. So
 * `planFamilyFanOut` still uses `isValidFamily`, and the three lifecycle
 * planners use this.
 */
export function isStructurallySoundFamily(family: FamilyDoc): boolean {
  const reason = familyInvalidReason(family);
  return reason === null || reason === 'too-few-members';
}

export function isValidFamily(family: FamilyDoc): boolean {
  return familyInvalidReason(family) === null;
}

/** One member's share of the owner's entitlement, as a write to users/{uid}. */
export interface FamilyGrant {
  uid: string;
  /**
   * Milliseconds since epoch, or null to REVOKE.
   *
   * ⚠️ null is an explicit revoke and not "leave it alone". A plan that
   * omitted revoked members would make removing someone from a family a
   * no-op on their entitlement, which is the failure this whole module's
   * dated-field design exists to bound rather than to permit.
   */
  familyProExpiresAtMs: number | null;
}

/**
 * The complete set of `familyProExpiresAt` writes implied by [family] and its
 * owner's subscription, for the moment [nowMs].
 *
 * 🔴 THE ENTITLEMENT IS THE OWNER'S EXPIRY, COPIED — NEVER EXTENDED, NEVER
 * ROUNDED UP. See FAMILY_GRANT_EXPIRY_SOURCE in the header: a member who could
 * outlive the owner's paid period would be entitled to something nobody paid
 * for, and the error would be invisible because it looks exactly like a
 * working feature.
 *
 * ⚠️ FAILS CLOSED IN EVERY DIRECTION. An invalid family, an owner who is not
 * entitled, an unreadable or already-past expiry, and a family whose owner is
 * missing all produce REVOKE plans rather than grants. There is no branch here
 * that grants on the strength of something being absent.
 *
 * [previousMemberUids] are people who were in the family and are not any more.
 * They are revoked explicitly, for the reason on [FamilyGrant.familyProExpiresAtMs].
 *
 * Pure: takes the clock as a parameter and reads no database. The caller
 * applies the plan.
 */
export function planFamilyFanOut(args: {
  family: FamilyDoc;
  /**
   * The owner's `subscriptionExpiresAt`, already resolved to milliseconds by
   * the caller, or null if it could not be read.
   *
   * 📌 A NUMBER RATHER THAN THE OWNER'S DOCUMENT, deliberately. The many
   * shapes `subscriptionExpiresAt` arrives in (Timestamp, ISO string, the unit
   * suite's `{_type:'ts', ms}` sentinel) are already decoded in exactly one
   * place — `expiryMillis` in taskRewards.ts — and a second decoder that
   * understood a different subset of them would lapse or over-grant whichever
   * users happened to be written by the writer it did not know about.
   */
  ownerExpiresAtMs: number | null;
  /** True when the owner holds a live FAMILY subscription right now. */
  ownerHasFamilySubscription: boolean;
  nowMs: number;
  previousMemberUids?: string[];
}): FamilyGrant[] {
  const {
    family,
    ownerExpiresAtMs,
    ownerHasFamilySubscription,
    nowMs,
    previousMemberUids = [],
  } = args;

  // Everyone the plan must say something about: current members, plus anyone
  // who has just left and therefore needs an explicit revoke.
  const subjects = Array.from(
    new Set([...family.memberUids, ...previousMemberUids]),
  );

  const entitled =
    isValidFamily(family) &&
    ownerHasFamilySubscription &&
    ownerExpiresAtMs !== null &&
    Number.isFinite(ownerExpiresAtMs) &&
    // Matches the `<=` boundary in resolveEffectiveTier: an entitlement that
    // is exactly used up is used up. Pinned in both places on purpose.
    ownerExpiresAtMs > nowMs;

  const currentMembers = new Set(family.memberUids);

  return subjects.map((uid) => ({
    uid,
    familyProExpiresAtMs:
      entitled && currentMembers.has(uid) ? ownerExpiresAtMs : null,
  }));
}

// ---------------------------------------------------------------------------
// 🔴 W2-79 — THE FAN-OUT NOW HAS A CALLER, AND THE FALSIFIER CHANGED THE SHAPE
// ---------------------------------------------------------------------------
//
// W2-76 left this: "the refund path must re-run the fan-out, and
// planFamilyFanOut returning a REVOKE plan is how it does. Until index.ts calls
// it there, a refunded family owner's MEMBERS keep Pro until the owner's
// original expiry." This is that caller's decision half.
//
// 🔑 THE BRIEF ASKED ME TO CHECK WHETHER REFUND IS THE ONLY NOTIFICATION THAT
// MOVES AN EXPIRY BACKWARDS. IT IS NOT, AND THERE IS NO REFUND BRANCH TO SIT
// BESIDE. `effectOf` in appStoreNotifications.ts collapses FOUR types —
// REFUND, REVOKE, EXPIRED and GRACE_PERIOD_EXPIRED — into one `revoke` effect
// (REVOKING_TYPES). Wiring `notificationType === 'REFUND'` would have missed
// REVOKE, which Apple sends for family-sharing removal and for fraud, and which
// moves the expiry backwards exactly as a refund does.
//
// So this keys off the EFFECT, not the type. That is not merely broader — it is
// the chokepoint the existing code already computes, so a notification type
// added to REVOKING_TYPES tomorrow is covered here without anyone remembering.
//
// 📌 EXPIRED and GRACE_PERIOD_EXPIRED are tidy-ups for the family exactly as
// they are for the owner: `familyProExpiresAt` is the owner's expiry copied, so
// a natural expiry has already lapsed every member's grant on the clock. Writing
// null makes the stored documents agree with what the resolver computes. Harmless
// and consistent, which is the same reason they are in REVOKING_TYPES at all.
//
// 🔴 AND THE PRODUCT MATTERS MORE THAN THE DIRECTION. Only the FAMILY product
// funds a family. A refund of the owner's personal `sub_pro_monthly` must not
// revoke their family's grant, and a renewal of it must not create one — those
// are two different subscriptions that happen to belong to one person. An effect
// naming any other product produces NO WRITES AT ALL, which is a stronger
// statement than "no change" and is asserted as such.

import type {SubscriptionEffect} from './appStoreNotifications';

/**
 * The `familyProExpiresAt` writes implied by one App Store notification, for
 * the family its subscriber OWNS.
 *
 * Returns an EMPTY array when the notification has nothing to do with a family
 * subscription — not a list of unchanged grants. A caller that wrote every
 * returned grant unconditionally would then touch nothing, which is the
 * behaviour worth having by construction rather than by the caller's care.
 *
 * ⚠️ Fails CLOSED in the direction that matters: an unrecognised or malformed
 * effect revokes nothing and grants nothing, and an invalid family on a
 * revoking effect still revokes — because [planFamilyFanOut] only validates for
 * a GRANT, and refusing to revoke a broken family would leave exactly the stale
 * entitlement this function exists to remove.
 *
 * Pure. The clock is a parameter and nothing is read or written here.
 */
export function planFamilyFanOutForEffect(args: {
  family: FamilyDoc;
  effect: SubscriptionEffect;
  nowMs: number;
  previousMemberUids?: string[];
}): FamilyGrant[] {
  const {family, effect, nowMs, previousMemberUids} = args;

  if (effect.kind === 'ignore') return [];
  if (effect.productId !== FAMILY_PRODUCT_ID) return [];

  if (effect.kind === 'revoke') {
    return planFamilyFanOut({
      family,
      ownerExpiresAtMs: null,
      ownerHasFamilySubscription: false,
      nowMs,
      previousMemberUids,
    });
  }

  return planFamilyFanOut({
    family,
    ownerExpiresAtMs: effect.expiresAtMs,
    ownerHasFamilySubscription: true,
    nowMs,
    previousMemberUids,
  });
}

// ---------------------------------------------------------------------------
// CREATION — the decision half of the callable that finally stamps a familyId
// ---------------------------------------------------------------------------
//
// W2-82. Everything in this file has been inert since #383 for one reason:
// nothing stamps `familyId` on `users/{uid}`, so no client can name its family
// and no family can be created. This is the half that decides whether a create
// is allowed; index.ts writes it.
//
// ---------------------------------------------------------------------------
// 🔴 THE ENTITLEMENT GATE MUST READ THE OWNER'S **OWN PAID** TIER, NOT THEIR
// EFFECTIVE ONE — AND THE OBVIOUS CHOICE IS THE BROKEN ONE
// ---------------------------------------------------------------------------
//
// `resolveEffectiveTier` answers "is this account entitled". It returns `pro`
// for a member of somebody else's family, because `familyProExpiresAt` was
// copied onto them. Gate creation on it and the check ADMITS EXACTLY THE CASE
// IT EXISTS TO REJECT:
//
//   Alice owns family A and pays for it. Bob is a member, so Bob reads as pro
//   while paying nothing. Bob creates family B. B is an EMPTY SHELL — the
//   fan-out only ever runs on a notification for its OWN owner's family
//   product, and Bob has none, so nobody in B is ever granted anything.
//
// The gate exists to stop empty shells, so it must ask what the owner PAYS FOR:
// `resolveOwnPaidTier` (taskRewards.ts), which is the same code with the family
// branch removed. A control below builds precisely Bob and asserts the refusal.
//
// 🥇 RE-DECIDED — 2026-09-04, BY BRENDAN, AND THIS REVERSES THE 2026-08-24
// RULING THAT STOOD HERE. ONLY `sub_family_monthly` MAY CREATE A FAMILY. A
// personal Pro subscription does not fund one: a Pro subscriber is refused and
// shown an upsell.
//
// The ruling this replaces read: "Either the Pro or the Family plan can make a
// Family, but the sub_family_monthly grants everyone in that house Pro
// memberships." It is quoted rather than deleted because it explains the shape
// of the code around it — the asymmetry below was deliberate for six weeks, and
// the fan-out still carries the rule it was built against. What changed is the
// CREATE GATE, and only the create gate.
//
// So the two halves now answer the same question with the same rule:
//
//   WHO MAY CREATE a family    — `sub_family_monthly` and nothing else.
//                                (`ownProductId` in `planFamilyCreation`)
//   WHAT ENTITLES THE SEATS    — `sub_family_monthly` and nothing else.
//                                (`planFamilyFanOutForEffect`)
//
// 🔑 AND THE REASON THE GATE COULD NOT BE TIGHTENED BY REWORDING THE CHECK IT
// ALREADY MADE: `ownPaidTier` is a TIER, and `SUBSCRIPTION_PRODUCT_TIERS` maps
// BOTH `sub_pro_monthly` AND `sub_family_monthly` to `pro` ON PURPOSE — "family
// is a SOURCE of pro, not a third tier". `resolveOwnPaidTier` returns the
// identical string for a Pro buyer and a Family buyer, so the tier check is
// structurally blind to the product and no rewording of it can see the
// difference. The gate needed a NEW INPUT, not a new comparison — and that
// input reuses the rule the fan-out already had (`=== FAMILY_PRODUCT_ID`)
// rather than inventing a fourth one. The billing table is NOT the thing to
// change; a third tier there would break the member entitlement that depends on
// the owner reading as plain `pro`.
//
// ⚠️ WHAT THIS CLOSES: a personal-Pro owner could create a family, invite four
// people, and every one of them got NOTHING — an empty shell, silently, with no
// error anywhere. W2-156 recorded that as "a UX trap, not a correctness bug"
// whose remedy was "a CLIENT warning at create/invite time ... NOT a third rule
// here". THAT PARAGRAPH IS GONE RATHER THAN AMENDED: the rule is here now, and
// a comment prescribing a client-side remedy would send the next window to fix
// something that can no longer happen. (W2-177)
//
// 📌 THE COST IS REAL AND WAS ACCEPTED, NOT OVERLOOKED: an existing Pro
// subscriber must cancel and rebuy to invite their household. The price ladder
// is what pays for it — Family at 12.99 is not defensible against Pro at 5.99
// if Pro quietly creates families too.

/** Why a create was refused. */
/**
 * The next uid → string map — add one, drop everyone no longer in the roster.
 *
 * 📌 RENAMED FROM `namesFor` IN W2-88 because it now backs `memberAvatars` too.
 * A helper called "names" quietly managing avatars is the kind of mislabel a
 * later reader trusts.
 *
 * 🔑 PURE, AND SEPARATE FROM THE ROSTER WRITE, so the two cannot drift: every
 * path that changes membership passes through this, and a name for somebody not
 * in `memberUids` cannot survive it.
 *
 * ⚠️ AN ABSENT OR EMPTY NAME WRITES NO ENTRY RATHER THAN AN EMPTY STRING. A uid
 * mapped to '' renders as a member with a blank name, which looks like a bug in
 * the page; a uid with no entry lets the reader choose its own fallback. The
 * Auth record can genuinely have no displayName, so this is the normal case and
 * not a defensive branch.
 */
export function memberMapFor(
  current: Record<string, string> | undefined,
  opts: {
    add?: {uid: string; name?: string};
    keepOnly?: string[];
  },
): Record<string, string> {
  const next: Record<string, string> = {...(current ?? {})};

  if (opts.add && opts.add.name) next[opts.add.uid] = opts.add.name;

  if (opts.keepOnly) {
    const keep = new Set(opts.keepOnly);
    for (const uid of Object.keys(next)) {
      if (!keep.has(uid)) delete next[uid];
    }
  }
  return next;
}

export type FamilyCreateRefusal =
  | 'not-entitled'
  // 🔴 W2-177. SEPARATE FROM `not-entitled` ON PURPOSE, because the two want
  // opposite things from the person reading them: `not-entitled` pays for
  // nothing and is sold a subscription, while this one ALREADY PAYS and is sold
  // an UPGRADE. Collapsing them would ship "subscribe to Pro" to somebody
  // holding a Pro subscription. Both map to `failed-precondition`, so a client
  // switching on the CODE is unaffected by the new member.
  | 'needs-family-subscription'
  | 'already-owns-a-family';

export type FamilyCreatePlan =
  | {ok: true; family: FamilyDoc}
  | {ok: false; refusal: FamilyCreateRefusal};

/**
 * Whether [ownerUid] may create a family, and what that family looks like.
 *
 * Pure: the clock and both facts are parameters, nothing is read or written.
 *
 * @param ownPaidTier the owner's OWN paid tier — `resolveOwnPaidTier`, never
 *        `resolveEffectiveTier`. See the block above; passing the wrong one is
 *        the one mistake this signature cannot prevent, which is why the
 *        parameter is named for what it must be rather than for what it is.
 * @param ownProductId the product the owner PAYS FOR — `users/{uid}
 *        .subscriptionProductId`, read from the same document as the tier and
 *        NEVER from the request. `undefined` is normal (a free account, and
 *        also the Pro promo grant, which deliberately writes no product id) and
 *        refuses, which is the closed direction.
 * @param alreadyOwnsAFamily whether a family with this owner already exists,
 *        read inside the same transaction that will do the write.
 */
export function planFamilyCreation(args: {
  ownerUid: string;
  ownPaidTier: string;
  /**
   * 🔴 REQUIRED, NOT OPTIONAL, AND THAT IS THE POINT. An optional product id
   * would still fail closed at runtime, but a call site that forgot it would
   * compile and then refuse EVERY create in production — a gate that is wrong
   * in the quiet direction. Required means forgetting it is a tsc error.
   */
  ownProductId: string | undefined;
  alreadyOwnsAFamily: boolean;
  nowMs: number;
  /** From the Auth record. Absent is normal — see FamilyDoc.memberNames. */
  ownerDisplayName?: string;
  /** `users/{uid}.avatarUrl` — an ID. See FamilyDoc.memberAvatars. */
  ownerAvatarId?: string;
  /**
   * The founding owner's OWN bin day, from their device, so the family starts
   * agreeing with the person who started it. Anything invalid or absent is
   * dropped — see the seeding note in the body.
   */
  ownerBinWeekday?: unknown;
}): FamilyCreatePlan {
  const {
    ownerUid,
    ownPaidTier,
    ownProductId,
    alreadyOwnsAFamily,
    nowMs,
    ownerDisplayName,
    ownerAvatarId,
    ownerBinWeekday,
  } = args;

  // 🔴 SINGLE OWNERSHIP, CHECKED FIRST. `ownedFamilies` in
  // appStoreNotificationsV2 reads the owner's family with `.limit(1)` against
  // an invariant that nothing enforced — "a subscriber owns at most one family;
  // a second would be a defect in the creating callable". This IS the creating
  // callable, so the invariant becomes true here or it is never true anywhere.
  // Checked before the entitlement so a second create is refused for the honest
  // reason rather than for whatever the subscription happened to be doing.
  if (alreadyOwnsAFamily) return {ok: false, refusal: 'already-owns-a-family'};

  // Fails CLOSED: an unrecognised tier string normalises to `free` upstream, so
  // a value nobody understands refuses rather than grants.
  //
  // 📌 CHECKED BEFORE THE PRODUCT so somebody paying for nothing is told they
  // need a subscription, not that they need to upgrade the one they do not
  // have. Order is the whole difference between the two messages being right.
  if (ownPaidTier === 'free') return {ok: false, refusal: 'not-entitled'};

  // 🔴 W2-177 — THE PRODUCT, NOT THE TIER. Both paid products resolve to the
  // tier `pro`, so this is the only check that can tell a Family buyer from a
  // Pro buyer. Same rule as the fan-out's, deliberately, rather than a looser
  // sibling: what may CREATE a family is now exactly what ENTITLES its seats.
  //
  // ⚠️ THIS ALSO REFUSES A PROMO-GRANTED PRO, and that is a real cohort rather
  // than a hypothetical: `claimRetentionPromo` sets the tier to `pro` and
  // deliberately writes NO `subscriptionProductId` ("there is no Apple product
  // behind this grant"). Such an account reaches here with `undefined` and is
  // refused. That follows from the ruling — a promotional month is not a family
  // purchase — but it was a consequence nobody ruled on explicitly, so it is
  // named here rather than left for a reader to discover from a support ticket.
  if (ownProductId !== FAMILY_PRODUCT_ID) {
    return {ok: false, refusal: 'needs-family-subscription'};
  }

  return {
    ok: true,
    family: {
      ownerUid,
      // 🔑 THE OWNER IS A MEMBER FROM THE FIRST INSTANT. FamilyDoc requires it
      // ("a member who happens to pay, not a separate role outside the
      // roster"), and `familyInvalidReason` returns 'owner-not-a-member'
      // otherwise — so a family created without this line is invalid on
      // arrival and every fan-out fails closed against it.
      //
      // ⚠️ This also means a NEW family already holds 1 of FAMILY_CAP's 5
      // seats. It is deliberately BELOW FAMILY_MIN_MEMBERS (2) at this moment:
      // a family of one is not yet worth existing, but it is the only way to
      // reach two, and refusing it would make families uncreatable. Validity is
      // a property of a family being USED, not of the instant it is born.
      memberUids: [ownerUid],
      createdAtMs: nowMs,
      memberNames: memberMapFor({}, {add: {uid: ownerUid, name: ownerDisplayName}}),
      memberAvatars: memberMapFor({}, {add: {uid: ownerUid, name: ownerAvatarId}}),
      // 🔑 SEEDED SO THE DISAGREEMENT CANNOT OCCUR, RATHER THAN MERELY BEING
      // FIXABLE. W2-118 gave the owner a way to set one shared bin day; until
      // they used it a NEW family had none, so every member fell back to their
      // own device weekday and `#490`'s split-document bug was the DEFAULT
      // state of every family for as long as nobody opened the setting.
      // Seeding from the founder closes the window instead of shortening it.
      //
      // 🔴 AND NO DEFAULT IS INVENTED WHEN THE OWNER HAS NONE. An absent
      // weekday stays absent: a family that prompts is visibly incomplete,
      // while a family silently assigned Monday looks finished and is wrong,
      // and nobody audits a plausible value. Same reason the field itself is
      // optional — a server-chosen bin day is one nobody picked.
      //
      // ⚠️ AN INVALID VALUE IS DROPPED, NOT REFUSED. A malformed weekday from
      // some future client must not be able to stop a family being created;
      // creating the family is the important act and the bin day is
      // recoverable afterwards by the owner. Refusing here would trade a
      // cosmetic defect for a broken feature.
      ...(isValidBinWeekday(ownerBinWeekday)
        ? {binWeekday: ownerBinWeekday}
        : {}),
    },
  };
}

/** Human-facing refusal text, and the callable's error code for each. */
export const FAMILY_CREATE_REFUSALS: Record<
  FamilyCreateRefusal,
  {code: 'failed-precondition' | 'already-exists'; message: string}
> = {
  // ⚠️ THE MESSAGE MOVED WITH THE GATE. It used to read "A Pro subscription is
  // required to start a family", which after W2-177 is precisely the sentence
  // that is NOT true — a Pro subscription is the thing that is no longer
  // sufficient. A shipped string that contradicts the rule beside it misdirects
  // the one person guaranteed to read it.
  'not-entitled': {
    code: 'failed-precondition',
    message: 'A Family subscription is required to start a family.',
  },
  'needs-family-subscription': {
    code: 'failed-precondition',
    message:
      'Your Pro subscription does not include a family. ' +
      'Upgrade to the Family plan to start one.',
  },
  'already-owns-a-family': {
    code: 'already-exists',
    message: 'You already have a family.',
  },
};

// ---------------------------------------------------------------------------
// JOINING — the other half, and the reason it is not `joinFamily(familyId)`
// ---------------------------------------------------------------------------
//
// W2-83.
//
// 🔴 AN UNGATED JOIN IS A FREE-PRO VECTOR, AND THE OBVIOUS SIGNATURE IS THE
// UNGATED ONE. `joinFamily(familyId)` lets anyone who learns a family id add
// themselves and be entitled: `familyProExpiresAt` is copied to every member by
// the fan-out, so the attacker gets Pro until the cap fills, and the owner's
// only symptom is a household they did not invite. A document id is not a
// secret — it appears in client logs, in support screenshots, in any shared
// device — so unguessability is not a defence, it is a delay.
//
// 🔑 SO THE INVITE IS THE CAPABILITY, NOT THE FAMILY ID. The owner mints a
// short-lived code; the joiner redeems it. That is exactly the shape
// housemateToken.ts already uses for the same problem — a stranger must not add
// themselves to your house — and it is exactly the QR flow the family spec
// describes ("a parent scans the kid's phone").
//
// ⚠️ REUSING THE SHAPE IS NOT ALIASING THE RELATION. A family member does NOT
// become a housemate (#383) and this does not touch `users/{uid}.housemates`.
// The two systems share a proven token pattern and nothing else — family is
// billing plus shared chores, housemates is a peer roster that need not agree.

/**
 * How long a family invite code lives.
 *
 * Matched to `HOUSEMATE_TOKEN_TTL_SECONDS` because it is the same physical act
 * — two people, two phones, one in the room — and a second number for the same
 * gesture would be one more thing to keep in step. Short by design: a code that
 * outlives the conversation is a code that can be shoulder-surfed.
 */
export const FAMILY_INVITE_TTL_SECONDS = 45;

/** A minted invite, at `familyInvites/{code}`. */
export interface FamilyInviteDoc {
  familyId: string;
  /** Who minted it. Only a family's owner may. */
  ownerUid: string;
  createdAtMs: number;
  /** Stored rather than derived, so the TTL can change without reinterpreting
   *  codes already in flight. */
  expiresAtMs: number;
}

export type FamilyJoinRefusal =
  | 'invalid-family'
  | 'family-full'
  | 'already-a-member'
  | 'already-in-another-family'
  | 'invite-expired';

export type FamilyJoinPlan =
  | {
      ok: true;
      /** The roster AFTER the join. The whole document is rewritten from this. */
      memberUids: string[];
      /** `memberNames` AFTER the join — the joiner added, nobody dropped. */
      memberNames: Record<string, string>;
      /** `memberAvatars` AFTER the join. */
      memberAvatars: Record<string, string>;
      /**
       * 🔴 THE JOINER IS NOW PAYING TWICE, AND WE CANNOT STOP IT.
       *
       * A callable cannot cancel a StoreKit subscription — only the account
       * holder can, through Apple — so a joiner with their own active Pro keeps
       * being billed for it while also receiving the family grant. Pretending
       * otherwise would be worse than saying it.
       *
       * 🔑 SILENT double-billing is the failure; the double-billing itself is
       * Apple's to refund. So this is RETURNED rather than logged, so the client
       * can say it in words to the person it is happening to, at the moment it
       * starts.
       *
       * ⚠️ Computed from the joiner's OWN PAID tier, never the effective one —
       * the effective tier would be `pro` for anyone already carrying a family
       * grant, and this would then fire for people paying nothing. Same trap as
       * the creation gate, approached from the other side.
       */
      alreadyPayingSeparately: boolean;
    }
  | {ok: false; refusal: FamilyJoinRefusal};

/**
 * Whether [joinerUid] may join [family], and what the roster becomes.
 *
 * Pure: every fact is a parameter and nothing is read or written.
 *
 * @param joinerOwnPaidTier the joiner's OWN paid tier — `resolveOwnPaidTier`.
 *        Used ONLY for the double-pay warning; it is deliberately NOT an
 *        entitlement gate, because needing Pro to accept a family's Pro would
 *        make the feature useless to exactly the people it is for.
 * @param joinerCurrentFamilyId `users/{uid}.familyId`, or null.
 */
export function planFamilyJoin(args: {
  family: FamilyDoc;
  familyId: string;
  joinerUid: string;
  joinerOwnPaidTier: string;
  joinerCurrentFamilyId: string | null;
  inviteExpiresAtMs: number;
  nowMs: number;
  /** From the Auth record. Absent is normal — see FamilyDoc.memberNames. */
  joinerDisplayName?: string;
  /** `users/{uid}.avatarUrl` — an ID. See FamilyDoc.memberAvatars. */
  joinerAvatarId?: string;
}): FamilyJoinPlan {
  const {
    family,
    familyId,
    joinerUid,
    joinerOwnPaidTier,
    joinerCurrentFamilyId,
    inviteExpiresAtMs,
    nowMs,
    joinerDisplayName,
    joinerAvatarId,
  } = args;

  // Fails CLOSED on a malformed roster, exactly as the trash-day plan does: a
  // family that cannot be validated is not one to add a person to.
  if (!isStructurallySoundFamily(family)) {
    return {ok: false, refusal: 'invalid-family'};
  }

  // Expiry before everything else — an expired capability should not report
  // anything about the family it names.
  if (nowMs > inviteExpiresAtMs) return {ok: false, refusal: 'invite-expired'};

  // 🔑 IDEMPOTENT, AND BEFORE THE CAP. Redeeming twice — a double tap, a retry
  // on a flaky connection — must not be an error, and must not consume a seat
  // that is already theirs. Checked before the cap so the last member of a FULL
  // family can still re-redeem without being told the family is full.
  if (family.memberUids.includes(joinerUid)) {
    return {ok: false, refusal: 'already-a-member'};
  }

  // One family per person, the joining-side counterpart of the single-ownership
  // rule createFamily enforces. Without it a person accumulates grants from
  // several families and `users/{uid}.familyId` — which every family read is
  // scoped by — silently names only the most recent.
  if (joinerCurrentFamilyId !== null && joinerCurrentFamilyId !== familyId) {
    return {ok: false, refusal: 'already-in-another-family'};
  }

  // 🔴 THE CAP IS ENFORCED AT THE JOIN, NOT ONLY AT CREATE, and it counts the
  // TOTAL including the owner — FAMILY_CAP is 5 people, so four besides the
  // owner. A cap checked only where the document is born is not a cap.
  if (family.memberUids.length >= FAMILY_CAP) {
    return {ok: false, refusal: 'family-full'};
  }

  const memberUids = [...family.memberUids, joinerUid];
  return {
    ok: true,
    memberUids,
    memberNames: memberMapFor(family.memberNames, {
      add: {uid: joinerUid, name: joinerDisplayName},
      keepOnly: memberUids,
    }),
    memberAvatars: memberMapFor(family.memberAvatars, {
      add: {uid: joinerUid, name: joinerAvatarId},
      keepOnly: memberUids,
    }),
    alreadyPayingSeparately: joinerOwnPaidTier !== 'free',
  };
}

/** Human-facing refusal text, and the callable's error code for each. */
export const FAMILY_JOIN_REFUSALS: Record<
  FamilyJoinRefusal,
  {
    code: 'failed-precondition' | 'already-exists' | 'resource-exhausted' | 'deadline-exceeded';
    message: string;
  }
> = {
  'invalid-family': {
    code: 'failed-precondition',
    message: 'That family record is not usable.',
  },
  'family-full': {
    code: 'resource-exhausted',
    message: `A family holds ${FAMILY_CAP} people, including whoever started it.`,
  },
  'already-a-member': {
    code: 'already-exists',
    message: 'You are already in this family.',
  },
  'already-in-another-family': {
    code: 'failed-precondition',
    message: 'You are already in a family. Leave it first.',
  },
  'invite-expired': {
    code: 'deadline-exceeded',
    message: `That invite expired. They only last ${FAMILY_INVITE_TTL_SECONDS} seconds — ask for a new one.`,
  },
};

// ---------------------------------------------------------------------------
// LEAVING — and the grant that outlives the payer if nothing revokes it
// ---------------------------------------------------------------------------
//
// W2-84. Until now a family could be created and joined and never left, and a
// member's grant had no revoking event except the OWNER's own refund.
//
// 🔴 THAT IS A FREE-PRO VECTOR WITH A LONGER FUSE THAN THE INVITE ONE.
// `familyProExpiresAt` is a COPY of the owner's expiry, so a member who walks
// away keeps Pro until that clock runs out — up to a full billing period of
// entitlement funded by somebody who is no longer sharing anything with them.
// Every departure below therefore revokes IN THE SAME TRANSACTION as the roster
// write; a revoke that is a second step is a revoke that a crash skips.
//
// ---------------------------------------------------------------------------
// 🔴 THE OWNER LEAVING: IT DISSOLVES THE FAMILY. My reading, and the argument.
// ---------------------------------------------------------------------------
//
// Three options were open — refuse, transfer, dissolve — and the deciding fact
// is that THE SUBSCRIPTION IS THE FAMILY. The owner is not a member who happens
// to pay; the family exists because they pay, and the fan-out only ever runs on
// a notification for the OWNER'S OWN family product.
//
//   · TRANSFER IS THE ATTRACTIVE WRONG ANSWER. Hand the family to Bob and it is
//     inert by construction: no notification for Bob's product will ever arrive
//     (he has none), so nothing can refresh anybody's grant. The family sits
//     there granting nothing until the copied expiry lapses and then silently
//     stops. That is EXACTLY the empty-shell class #397's entitlement gate
//     exists to prevent, arriving through a back door. It would only work if
//     the recipient already held their own family subscription — at which point
//     the honest act is for them to create their own family and invite
//     everyone, which is one existing call rather than an ownership-migration
//     path that also has to negotiate single ownership.
//
//   · REFUSING IS WORSE THAN DISSOLVING. An owner with no exit does not stay;
//     they cancel their subscription instead. That strands every member with a
//     grant that lapses later, from no event anyone can see, with no record of
//     why. Dissolving makes the ending explicit, immediate, and attributable.
//
// So: dissolve — and as a SEPARATELY NAMED act, not as a branch of leaving.
// `leaveFamily` refuses an owner with `owner-must-disband`, which names the
// alternative rather than merely saying no. Destroying four people's
// entitlement should require typing the word for it.

export type FamilyDepartureRefusal =
  | 'invalid-family'
  | 'not-authorised'
  | 'owner-must-disband'
  | 'not-the-owner';

/**
 * What a departure changes.
 *
 * 🔑 `revokedUids` IS SEPARATE FROM `memberUids` BECAUSE THEY ARE DIFFERENT
 * WRITES TO DIFFERENT DOCUMENTS. The roster lives on the family; the grant
 * lives on each user. A plan that returned only the new roster would leave the
 * caller to infer who lost their grant, and inferring it is how the revoke gets
 * skipped.
 */
export type FamilyDeparturePlan =
  | {
      ok: true;
      /** No write is needed — the desired end state already holds. */
      noop: boolean;
      /** The roster AFTER the departure. Empty when the family dissolves. */
      memberUids: string[];
      /** `memberNames` AFTER the departure — the leaver's entry dropped. */
      memberNames: Record<string, string>;
      /** `memberAvatars` AFTER the departure. */
      memberAvatars: Record<string, string>;
      /** Everyone whose `familyProExpiresAt` and `familyId` must be cleared. */
      revokedUids: string[];
      /** True when the family document itself should be deleted. */
      dissolved: boolean;
    }
  | {ok: false; refusal: FamilyDepartureRefusal};

/**
 * One member leaves, or is removed by the owner.
 *
 * ⚠️ IDEMPOTENT BY DESIGN, AND "NOT A MEMBER" IS A SUCCESS RATHER THAN A
 * REFUSAL. The caller asked for an end state — this person is not in this
 * family — and that end state already holds. Reporting an error would say the
 * first attempt failed, and a client that believed it would retry forever or,
 * worse, tell the user their departure did not work. Same reasoning as W2-81's
 * union: the goal is a state, not an event.
 *
 * 🔑 IT DOES NOT REWRITE THE REMAINING MEMBERS' GRANTS. The owner still pays and
 * their entitlement is unchanged, so touching them would risk moving a correct
 * value based on an expiry this call had to re-read. Minimum blast radius: the
 * only grant that changes is the one that must.
 *
 * @param targetUid who is leaving. Equal to `actorUid` for a self-departure.
 */
export function planFamilyDeparture(args: {
  family: FamilyDoc;
  actorUid: string;
  targetUid: string;
  nowMs: number;
}): FamilyDeparturePlan {
  const {family, actorUid, targetUid} = args;

  if (!isStructurallySoundFamily(family)) {
    return {ok: false, refusal: 'invalid-family'};
  }

  // Authority BEFORE existence, so a stranger cannot probe a family's roster by
  // reading which uids produce "not a member" and which produce "not allowed".
  const isSelf = actorUid === targetUid;
  const isOwner = family.ownerUid === actorUid;
  if (!isSelf && !isOwner) return {ok: false, refusal: 'not-authorised'};

  // 🔴 THE OWNER CANNOT LEAVE, AND THE REFUSAL NAMES THE ALTERNATIVE.
  //
  // 📌 ITS POSITION ABOVE THE NO-OP BRANCH IS DEFENSIVE, NOT LOAD-BEARING, AND
  // I CHECKED RATHER THAN ASSUMED. Moving it below changes nothing today,
  // proven by mutation: `isValidFamily` refuses `owner-not-a-member`, so the
  // owner is ALWAYS in `memberUids` and can never reach the "not a member"
  // return. An earlier draft of this comment claimed the order stopped an owner
  // being told "nothing to do"; that was an over-claim, and the test written
  // for it passed in both orders — which is the definition of asserting
  // nothing.
  //
  // It stays first because it costs nothing and would become load-bearing the
  // moment that invariant weakened. The test below pins the invariant instead,
  // which is the thing actually holding this up.
  if (targetUid === family.ownerUid) {
    return {ok: false, refusal: 'owner-must-disband'};
  }

  if (!family.memberUids.includes(targetUid)) {
    // The end state already holds. No writes, no error.
    return {
      ok: true,
      noop: true,
      memberUids: [...family.memberUids],
      memberNames: {...(family.memberNames ?? {})},
      memberAvatars: {...(family.memberAvatars ?? {})},
      revokedUids: [],
      dissolved: false,
    };
  }

  const remaining = family.memberUids.filter((uid) => uid !== targetUid);
  return {
    ok: true,
    noop: false,
    memberUids: remaining,
    // 🔑 PRUNED, NOT LEFT BEHIND. A departed member's name lingering on the
    // family document is readable by everyone still in it — a small leak about
    // somebody who left, and stale by definition.
    memberNames: memberMapFor(family.memberNames, {keepOnly: remaining}),
    memberAvatars: memberMapFor(family.memberAvatars, {keepOnly: remaining}),
    // 🔴 THE REVOKE IS THE POINT OF THIS FUNCTION. Without it the leaver keeps a
    // copied expiry worth up to a full billing period.
    revokedUids: [targetUid],
    dissolved: false,
  };
}

/**
 * The owner dissolves the family.
 *
 * 🔴 EVERY MEMBER IS REVOKED, INCLUDING THE OWNER'S OWN `familyProExpiresAt`.
 * The owner's `subscriptionTier` is a different field and is NOT touched — they
 * keep the subscription they are paying for; what ends is the family grant
 * derived from it. Leaving their family grant in place would make
 * `resolveEffectiveTier` answer `pro` from a family that no longer exists.
 */
export function planFamilyDisband(args: {
  family: FamilyDoc;
  actorUid: string;
  nowMs: number;
}): FamilyDeparturePlan {
  const {family, actorUid} = args;

  if (!isStructurallySoundFamily(family)) {
    return {ok: false, refusal: 'invalid-family'};
  }
  if (family.ownerUid !== actorUid) return {ok: false, refusal: 'not-the-owner'};

  return {
    ok: true,
    noop: false,
    memberUids: [],
    memberNames: {},
    memberAvatars: {},
    revokedUids: [...family.memberUids],
    dissolved: true,
  };
}

/** Human-facing refusal text, and the callable's error code for each. */
export const FAMILY_DEPARTURE_REFUSALS: Record<
  FamilyDepartureRefusal,
  {code: 'failed-precondition' | 'permission-denied'; message: string}
> = {
  'invalid-family': {
    code: 'failed-precondition',
    message: 'That family record is not usable.',
  },
  'not-authorised': {
    code: 'permission-denied',
    message: 'Only the person themselves or the family owner can do that.',
  },
  'owner-must-disband': {
    code: 'failed-precondition',
    message:
      'You started this family, so you cannot leave it — you can end it for everyone instead.',
  },
  'not-the-owner': {
    code: 'permission-denied',
    message: 'Only the person who started the family can end it.',
  },
};

// ---------------------------------------------------------------------------
// The shared bin day
// ---------------------------------------------------------------------------

/** Why a bin-day change is refused. */
export type FamilyBinDayRefusal = 'not-the-owner' | 'invalid-weekday';

export type FamilyBinDayPlan =
  | {ok: true; binWeekday: number}
  | {ok: false; refusal: FamilyBinDayRefusal};

/**
 * Whether [value] is a weekday this app can key a bin date from.
 *
 * 🔑 ONE VALIDATOR, USED BY BOTH WRITERS, AND THAT IS THE WHOLE REASON IT IS A
 * FUNCTION. `planFamilyBinDay` (the owner changing it) and
 * `planFamilyCreation` (the family being born) both decide what a legal bin
 * weekday is. Two copies of `>= 1 && <= 7 && Number.isInteger` would agree on
 * the day they were written and drift on the day one of them learns about
 * something the other does not — and the symptom of that drift is a family
 * whose stored weekday one path accepts and the other rejects, which is a
 * worse version of the bug this whole feature exists to close.
 *
 * ⚠️ INTEGER, NOT JUST IN RANGE. `0` and `8` are the obvious rejects; `2.5`,
 * `NaN` and `Infinity` are the ones that pass a bare comparison and produce a
 * bin date that never arrives.
 */
export function isValidBinWeekday(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 7
  );
}

/**
 * Whether [actorUid] may set this family's shared bin day, and to what.
 *
 * 🔴 ONLY THE OWNER SETS IT — the same authority split `assignFamilyChore` and
 * `removeMember` draw. A bin day any member can change is a household argument
 * encoded as a race: two members alternating writes would each see the other's
 * takeover vanish, which is the SAME symptom as the bug this fixes and a
 * harder one to explain.
 *
 * ⚠️ AUTHORITY IS CHECKED BEFORE THE VALUE, deliberately and for the reason
 * `planChoreAssignment` records: a non-owner who could tell `invalid-weekday`
 * from `not-the-owner` learns whether their guess was well-formed, and a
 * refusal that varies by input is a probe.
 *
 * 🔑 THE WEEKDAY IS VALIDATED AS AN INTEGER 1–7 RATHER THAN "A NUMBER".
 * `8` and `0` are the obvious rejects; `2.5` and `NaN` are the ones that would
 * survive a range check and produce a bin DATE that never arrives, which is
 * indistinguishable at the client from the bug this brief exists to fix.
 *
 * Pure: no clock, no database, nothing read or written.
 */
export function planFamilyBinDay(args: {
  family: Pick<FamilyDoc, 'ownerUid'>;
  actorUid: string;
  binWeekday: unknown;
}): FamilyBinDayPlan {
  const {family, actorUid, binWeekday} = args;

  if (family.ownerUid !== actorUid) return {ok: false, refusal: 'not-the-owner'};

  if (!isValidBinWeekday(binWeekday)) {
    return {ok: false, refusal: 'invalid-weekday'};
  }

  return {ok: true, binWeekday};
}

/** Human-facing refusal text, and the callable's error code for each. */
export const FAMILY_BIN_DAY_REFUSALS: Record<
  FamilyBinDayRefusal,
  {code: 'permission-denied' | 'invalid-argument'; message: string}
> = {
  'not-the-owner': {
    code: 'permission-denied',
    message: 'Only the person who started the family can change bin day.',
  },
  'invalid-weekday': {
    code: 'invalid-argument',
    message: 'Pick a day of the week.',
  },
};
