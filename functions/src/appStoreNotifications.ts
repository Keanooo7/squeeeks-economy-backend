import type { AppleNotification, AppleTransaction } from './appleJws';

/**
 * Product id → tier. **THE** table: the gate in `verifySubscriptionReceipt` and
 * the tier written by `appStoreNotificationsV2` are the same lookup, so they
 * cannot drift apart.
 *
 * ⚠️ Fails CLOSED, and that is a change of direction rather than a tidy-up.
 * It used to be an allow-list Set plus, 40 lines later, a BINARY ternary
 * (`productId === 'sub_pro_monthly' ? 'pro' : 'premium'`). The ternary was safe
 * only because the Set happened to reject everything else first — anything that
 * got past the Set and was not the monthly product was granted PREMIUM: 24 paid
 * tasks a day and unlimited gifts, via an Admin SDK write that bypasses
 * Firestore rules. Adding a product to the Set without touching the ternary
 * would have granted it. Deriving both from one table removes that ordering
 * hazard instead of merely sequencing it correctly.
 *
 * An unrecognised id is rejected and reaches nothing further, matching the
 * direction `paidTaskCapFor` states in taskRewards.ts: never resolve an unknown
 * string to the most generous outcome.
 *
 * `sub_premium_monthly` is deliberately ABSENT — #314 retired that tier and the
 * client has no reference to it, so it must not remain billable. Stored
 * documents still carrying `premium` are handled separately, by decoding rather
 * than deletion; see LEGACY_TIER_ALIASES in taskRewards.ts.
 *
 * 📌 2026-08-14 — MOVED here from an inline `const` inside
 * `verifySubscriptionReceipt`. It was inline while exactly one entry point
 * granted a tier. A second one now does, and a per-entry-point copy of a
 * fail-closed allow-list is the drift the comment above already describes.
 */
export const SUBSCRIPTION_PRODUCT_TIERS: Record<string, string> = {
  sub_pro_monthly: 'pro',
  sub_pro_annual: 'pro',
  // 🔴 ADDED IN W2-79, AND ITS ABSENCE MADE THE FAMILY REFUND PATH INERT.
  //
  // `effectOf` rejects any product not in this table BEFORE it classifies the
  // notification type — `${productId} is not a subscription product` — so with
  // `sub_family_monthly` missing, EVERY family notification resolved to
  // `ignore`. A REFUND of a family subscription changed nothing, and the
  // entitlement fan-out that W2-79 exists to trigger could never have fired
  // even once it was wired.
  //
  // 🔑 Found by a test that drove the REAL `effectOf` rather than constructing
  // a `SubscriptionEffect` by hand. Every hand-built-effect test in that file
  // passed against the broken table; only the four going through the actual
  // classifier went red. A fixture that skips the unit under test cannot see
  // the unit under test being wrong.
  //
  // 📌 IT MAPS TO 'pro', WHICH IS THE W2-76 DECISION SPELLED OUT IN DATA:
  // family is a SOURCE of pro, not a third tier, so the owner's own
  // `subscriptionTier` reads `pro` exactly as a personal subscriber's does.
  // Members are entitled separately through `familyProExpiresAt`. Anything else
  // here would smuggle a third tier in through the billing table.
  //
  // 📌 CORRECTED 2026-08-29 (W2-158). THIS PARAGRAPH USED TO READ "the PRODUCT
  // still exists nowhere — #380 added it to Configuration.storekit and #382
  // reverted that, and App Store Connect has never had it", AND BOTH HALVES
  // WERE FALSE BY THE TIME ANYONE READ THEM. #587 re-added it to
  // `ios/Configuration.storekit` (measured on origin/main, not inferred), and
  // App Store Connect has carried it all along as Apple ID 6801924400
  // (Projects/Cleaning/appstore-connect-facts.md:37,39).
  //
  // 🔴 IT IS CORRECTED HERE RATHER THAN LEFT TO ROT BECAUSE THIS EXACT CLAIM
  // HAS ALREADY MISLED TWICE. `productRegistry.test.ts` carries its own
  // correction of the same sentence, and W2-158's brief inherited the stale
  // half from SHIP.md — which measured at `3d35236`, before W2-157 landed the
  // price entry. A comment saying "safe precisely because no such transaction
  // can be signed yet" is not merely out of date: it tells the next reader that
  // this row cannot be exercised, at the moment the row went live.
  //
  // ⚠️ A REAL TRANSACTION FOR THIS PRODUCT CAN NOW BE SIGNED, and
  // `productGrantCoverage.test.ts` signs one and drives it through the shipped
  // verifier into the grant. What remains true is narrower and belongs to the
  // store-readiness audit, not here: at status "Prepare for Submission" the
  // product does not yet RESOLVE in production.
  sub_family_monthly: 'pro',
};

/**
 * What one notification should do to a user document.
 *
 * A discriminated union rather than a mutation, so the decision is testable
 * without Firestore and the whole notification-type table can be exercised as
 * plain data. The Firestore half lives in index.ts and does no deciding.
 */
export type SubscriptionEffect =
  /** Write the entitlement through `expiresAtMs`. */
  | { kind: 'entitle'; tier: string; productId: string; expiresAtMs: number }
  /** Drop to free NOW, regardless of a still-future expiry. */
  | { kind: 'revoke'; productId: string; endedAtMs: number; reason: string }
  /** Acknowledged, no state change. Always carries why, because logs are read. */
  | { kind: 'ignore'; reason: string };

/**
 * Notification types that carry a live, paid-through entitlement.
 *
 * `DID_CHANGE_RENEWAL_PREF` is here because a tier/plan change resigns a
 * transaction with a new product id — the entitlement is still live and the
 * product it names may have changed.
 */
const ENTITLING_TYPES = new Set([
  'SUBSCRIBED',
  'DID_RENEW',
  'OFFER_REDEEMED',
  'RENEWAL_EXTENDED',
  'DID_CHANGE_RENEWAL_PREF',
]);

/**
 * Notification types that end an entitlement at a moment Apple chose.
 *
 * 🔑 `REFUND` and `REVOKE` are the ones that MATTER, and they are the whole
 * reason this set is not simply "let it lapse". Every other ending — a
 * cancellation, a failed rebill, a natural expiry — leaves `expiresDate`
 * untouched and in the past by the time it bites, and `resolveEffectiveTier`
 * dates the stored tier against the clock (#343), so the entitlement lapses
 * correctly with no write at all. A REFUND does not: Apple can refund in the
 * MIDDLE of a paid period, leaving `subscriptionExpiresAt` weeks in the future
 * on a subscription that has been paid back. Without this branch a refunded
 * account keeps Pro until the period it no longer paid for runs out.
 *
 * `EXPIRED` and `GRACE_PERIOD_EXPIRED` are included even though the clock
 * already handles them, because writing `free` makes the stored document agree
 * with what every reader computes. That is a tidy-up, not a fix, and it is
 * marked as one in the tests.
 */
const REVOKING_TYPES = new Set(['REFUND', 'REVOKE', 'EXPIRED', 'GRACE_PERIOD_EXPIRED']);

/**
 * Decides what a verified notification means for the owner's entitlement.
 *
 * ⚠️ Unknown types resolve to `ignore`, NOT to an error. Apple adds
 * notification types without asking — `RESCIND_CONSENT`, `METADATA_UPDATE` and
 * `MIGRATION` are all newer than this app — and a handler that 500s on one it
 * has never seen turns a routine Apple release into three days of retries and
 * an endpoint that looks broken. Failing closed here means changing nothing,
 * which is the safe direction for a type whose meaning we do not know.
 */
export function effectOf(notification: AppleNotification): SubscriptionEffect {
  const { notificationType, subtype, transaction } = notification;

  if (notificationType === 'TEST') {
    // App Store Connect's "Request a Test Notification" button, and the only
    // way to confirm the URL is wired before a real purchase exists. It carries
    // no transaction and must answer 200 or the console reports the endpoint
    // unreachable.
    return { kind: 'ignore', reason: 'TEST notification — endpoint reachable' };
  }

  if (transaction == null) {
    return {
      kind: 'ignore',
      reason: `${notificationType} carries no signed transaction`,
    };
  }

  const tier = SUBSCRIPTION_PRODUCT_TIERS[transaction.productId];
  if (!tier) {
    // A consumable sponge pack also generates notifications (ONE_TIME_CHARGE,
    // REFUND). They are `verifyIapAndGrant`'s products and have no tier; a
    // refunded sponge pack is a separate problem and is NOT silently handled
    // here by writing `free` over a live subscription.
    return {
      kind: 'ignore',
      reason: `${transaction.productId} is not a subscription product`,
    };
  }

  if (REVOKING_TYPES.has(notificationType)) {
    return {
      kind: 'revoke',
      productId: transaction.productId,
      // `revocationDate` is set on a refund and absent on an expiry, where the
      // period genuinely ran to its end.
      endedAtMs: transaction.revocationDateMs ?? transaction.expiresDateMs ?? 0,
      reason: subtype ? `${notificationType} (${subtype})` : notificationType,
    };
  }

  if (ENTITLING_TYPES.has(notificationType)) {
    if (transaction.expiresDateMs == null) {
      // A subscription transaction always carries one. Refusing to write an
      // entitlement with no end date is the fail-closed direction: the
      // alternative is a tier that never lapses, which is the exact bug #343
      // was opened to fix.
      return {
        kind: 'ignore',
        reason: `${notificationType} for ${transaction.productId} has no expiry date`,
      };
    }
    return {
      kind: 'entitle',
      tier,
      productId: transaction.productId,
      expiresAtMs: transaction.expiresDateMs,
    };
  }

  // DID_FAIL_TO_RENEW lands here on purpose. It means the rebill failed, not
  // that access ended: with a billing-retry or grace period the subscriber is
  // still entitled through the expiry already stored, and without one the
  // clock revokes them at that same moment. Either way there is nothing to
  // write, and writing `free` here would cut off a subscriber Apple is still
  // trying to charge.
  //
  // DID_CHANGE_RENEWAL_STATUS likewise: auto-renew was toggled off, which
  // changes what happens at the END of the period and nothing about now.
  return {
    kind: 'ignore',
    reason: subtype
      ? `${notificationType} (${subtype}) changes no entitlement`
      : `${notificationType} changes no entitlement`,
  };
}

/**
 * The owner-index key for a subscription, stable across every renewal of it.
 *
 * Returns null when Apple signed a transaction with no `originalTransactionId`,
 * which no subscription transaction does — the field is optional in the
 * library's types, not in the data. Callers treat null as unresolvable rather
 * than guessing.
 */
export function ownerKeyFor(transaction: AppleTransaction): string | null {
  return transaction.originalTransactionId ?? null;
}
