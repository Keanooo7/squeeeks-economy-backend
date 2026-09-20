/**
 * The Pro purchase receipt — composed here, sent by nobody yet.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: THERE IS NO EMAIL INFRASTRUCTURE IN THIS PROJECT. THIS SENDS NOTHING.
 * ---------------------------------------------------------------------------
 *
 * No sendgrid, nodemailer, postmark, mailgun or resend anywhere in `functions/`,
 * and no mail dependency in package.json. This module builds the CONTENT and
 * defines the seam a sender would plug into. Wiring a real provider needs an
 * account, a verified domain and DNS records that only Brendan can create — see
 * REQUIRED_SETUP at the bottom, which names each one precisely.
 *
 * WARNING: AND SENDING MUST NEVER SIT INSIDE THE GRANT. `verifyIapAndGrant` and
 * `verifySubscriptionReceipt` both write their entitlement in a transaction; a
 * mail outage inside one would turn a successful purchase into a failed one,
 * and #472 is one wave old on that exact path. A receipt is a courtesy. The
 * grant is the product.
 *
 * ---------------------------------------------------------------------------
 * WHO CAN ACTUALLY RECEIVE ONE — MEASURED, 2026-08-16
 * ---------------------------------------------------------------------------
 *
 *     17 auth accounts · 6 with an email address · 11 anonymous (65%)
 *     0 purchases have ever been made
 *
 * KEY: SO THE "NO ADDRESS" BRANCH IS A FALLBACK THAT SHOULD NEVER FIRE, NOT A
 * CO-EQUAL PATH. Two thirds of today's accounts could not receive anything —
 * but none of them has bought, and the client will require an account before
 * any future purchase. Every buyer will therefore have an address. The branch
 * stays because a receipt must never be the reason a purchase fails, and
 * because "should never fire" is a prediction rather than a guarantee.
 *
 * ---------------------------------------------------------------------------
 * KEY: EVERY ELEMENT DERIVES. NOTHING IS RETYPED.
 * ---------------------------------------------------------------------------
 *
 * Brendan asked for four things: the rewards, the price, the payment details
 * and the legal links. Each one already exists somewhere authoritative, and a
 * receipt that restated any of them would be a second copy that drifts — which
 * is precisely how the shop spent six days showing 9.99 for a 2.99 product.
 *
 *   rewards  ← PAID_TASK_CAP_BY_TIER × TASK_SPONGE_REWARD (taskRewards.ts)
 *   price    ← SUBSCRIPTION_PRICES below, GATED against Configuration.storekit
 *   payment  ← the verified Apple transaction itself
 *   legal    ← LEGAL_URLS below, GATED against lib/core/config/app_links.dart
 *
 * WARNING: The two GATED tables are the compromise this repo cannot avoid: a Cloud
 * Function cannot import a Dart file or read `ios/` at runtime, so the values
 * must exist here too. What stops them drifting is not discipline, it is
 * proReceipt.test.ts failing when they disagree with their sources.
 */

import {FAMILY_CAP, FAMILY_PRODUCT_ID} from './family';
import {PAID_TASK_CAP_BY_TIER, TASK_SPONGE_REWARD} from './taskRewards';

/** A subscription period, derived from the product — never hard-coded. */
export type BillingPeriod = 'monthly' | 'annual';

/**
 * What each subscription product costs and how often it bills.
 *
 * CRITICAL: GATED AGAINST ios/Configuration.storekit BY TEST. A price in two places is
 * the defect this project already shipped once; the gate is what makes a second
 * copy safe rather than merely convenient.
 *
 * NOTE: `sub_family_monthly` IS PRESENT AS OF W2-157, AND THE COMMENT THAT STOOD
 * HERE SAYING IT WAS "DELIBERATELY ABSENT" WAS FALSE ON BOTH ITS HALVES. It
 * claimed the product "has never existed in App Store Connect or
 * Configuration.storekit". It now exists in BOTH — Apple ID 6801924400, and
 * ios/Configuration.storekit at 12.99 (#380's re-land). While that comment
 * stood, `receiptFor` returned null for the family product and a family
 * subscriber received NO RECEIPT AT ALL.
 *
 * WARNING: `displayPrice` IS THE US TIER AND ONLY THE US TIER. The same tier is
 * AUD 19.99, EUR 14.99, and a different number again across 175 regions. This
 * entry INHERITS that assumption from `sub_pro_monthly` and `sub_pro_annual`
 * rather than introducing it — recorded as a deliberate choice, not slid in.
 * Fixing it means asking Apple for the buyer's actual locale price, which is a
 * real brief and not this one.
 *
 * KEY: `planName` IS MIRRORED FROM THE SAME FILE AND GATED THE SAME WAY. Without
 * it every receipt greeted the buyer with "Squeeeks Pro" and printed
 * "Plan: Squeeeks Pro" — so a Family buyer charged $12.99 got a receipt naming
 * a $5.99 product. On a billing document that is not a cosmetic error.
 */
export const SUBSCRIPTION_PRICES: Record<
  string,
  {displayPrice: string; period: BillingPeriod; planName: string}
> = {
  sub_pro_monthly: {displayPrice: '5.99', period: 'monthly', planName: 'Pro'},
  sub_pro_annual: {displayPrice: '59.88', period: 'annual', planName: 'Pro'},
  sub_family_monthly: {
    displayPrice: '12.99',
    period: 'monthly',
    planName: 'Family',
  },
};

/**
 * Fails LOUDLY for any subscription product this table cannot price.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: WHY THIS EXISTS AS A SEPARATE FUNCTION RATHER THAN AS A THROW INSIDE
 * `receiptFor`, WHICH IS THE OBVIOUS PLACE AND IS THE WRONG ONE.
 * ---------------------------------------------------------------------------
 *
 * `receiptFor` returns `null` for an unpriced product ON PURPOSE, and that
 * contract must not change: this module's own rule is that a receipt is a
 * courtesy and the grant is the product, so a receipt that cannot be composed
 * must never become a purchase that fails. Making the RUNTIME path throw would
 * invert exactly the rule the file opens with, and #472 is on that path.
 *
 * KEY: SO THE LOUD FAILURE MOVES TO THE GATE INSTEAD OF THE GRANT. A missing
 * price is a build-time defect — somebody added a subscription to
 * `ios/Configuration.storekit` and not here — and a build-time defect belongs
 * in a test, where it costs a red suite instead of a silent non-receipt. It is
 * `null` at runtime and a named, filed failure at gate time; those are not in
 * tension, they are the same decision applied where each is correct.
 *
 * WARNING: THE MESSAGE NAMES THE PRODUCT ID **AND** THIS FILE, because a bare
 * "missing price" sends the reader hunting through three tables that all key on
 * a product id — `SUBSCRIPTION_PRODUCT_TIERS`, `WEEKLY_OFFERS` and this one.
 *
 * NOTE: `sub_family_monthly` IS THE PRODUCT THIS WAS WRITTEN FOR, and it was
 * ALREADY FIXED by W2-157 before this function existed — the entry is above.
 * What was missing is the thing that would have CAUGHT it, which is why this
 * lands anyway rather than being dropped as redundant.
 */
export function assertPricedSubscriptions(productIds: readonly string[]): void {
  const missing = productIds.filter((id) => SUBSCRIPTION_PRICES[id] == null);
  if (missing.length === 0) return;

  throw new Error(
    `SUBSCRIPTION_PRICES has no entry for ${missing.join(', ')} — add one to ` +
      'functions/src/proReceipt.ts. Until then receiptFor() returns null for ' +
      'that product, the buyer is charged and receives no receipt, and nothing ' +
      'else in the codebase notices.',
  );
}

/**
 * The hosted legal pages, mirrored from lib/core/config/app_links.dart.
 *
 * CRITICAL: GATED AGAINST THAT FILE BY TEST, for the same reason as the prices: a
 * Cloud Function cannot import Dart, so the URL exists twice and only a test
 * can keep the copies honest. App Store review checks these, and a receipt
 * linking to a dead page is worse than one linking nowhere.
 */
export const LEGAL_URLS = {
  privacy: 'https://keanooo7.github.io/squeeeks-legal/privacy.html',
  terms: 'https://keanooo7.github.io/squeeeks-legal/terms.html',
  support: 'support@example.com',
};

export interface ProReceipt {
  to: string;
  subject: string;
  /** Plain text. A receipt must survive a client that refuses HTML. */
  body: string;
  /** For the ledger — what was charged, so a support query has one answer. */
  productId: string;
  transactionId: string;
  displayPrice: string;
  period: BillingPeriod;
}

/** ISO date, no clock: a receipt states a day, not a millisecond. */
function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * What the purchased plan actually gives, computed from the live constants.
 *
 * KEY: NOT A SENTENCE SOMEBODY TYPED. `taskRewards.ts` warns in its own comment
 * "work it out from the constants — do not restate it", and a receipt is
 * exactly the place a restated number would survive unnoticed: nobody diffs an
 * email against a config.
 *
 * CRITICAL: THE COVERAGE LINE IS NOW PER-PRODUCT, AND THE LINE IT REPLACES WAS A FALSE
 * PROMISE ON A BILLING DOCUMENT (W2-157). Every receipt used to end with
 * "• Family sharing — everyone in your family gets Pro while your subscription
 * is active", unconditionally — including the $5.99 `sub_pro_monthly` receipt,
 * which is the only one that has ever actually been composable. It was wrong
 * in two independent ways:
 *
 *   1. IT IS FALSE FOR PRO. W2-156 established that `planFamilyFanOutForEffect`
 *      returns `[]` unless the owner's product is FAMILY_PRODUCT_ID. A personal
 *      Pro subscriber can create a family, invite four people, and NOBODY is
 *      ever entitled. The receipt promised them the opposite, in writing, on
 *      the document that proves what they bought.
 *   2. "FAMILY SHARING" IS APPLE'S TERM FOR A MECHANISM THAT IS OFF. Every
 *      product in ios/Configuration.storekit carries `familyShareable: false`,
 *      deliberately (#380, 6d00fc8) — so the phrase named an Apple feature the
 *      buyer does not get, while the thing they DO get is this app's own
 *      roster. Two different mechanisms, one name, and the buyer cannot tell
 *      which one they were sold. The wording now says "Squeeeks family" and
 *      never "Family sharing".
 *
 * WARNING: THE CAP IS READ FROM `FAMILY_CAP`, NOT TYPED. It is 5 TOTAL — the owner
 * plus four — and `family.ts` records that a previous argument about this
 * number compared a total against a besides-the-owner count "wearing one
 * label". The receipt says "including you" so the buyer cannot make that same
 * mistake about what they just paid for.
 */
export function benefitLinesFor(productId: string): string[] {
  const freeCap = PAID_TASK_CAP_BY_TIER.free;
  const proCap = PAID_TASK_CAP_BY_TIER.pro;
  const lines = [
    `• ${proCap} paid task completions a day, up from ${freeCap} on the free plan`,
    `• ${proCap * TASK_SPONGE_REWARD} sponges a day from tasks, up from ${
      freeCap * TASK_SPONGE_REWARD
    }`,
  ];
  if (productId === FAMILY_PRODUCT_ID) {
    lines.push(
      `• Everyone in your Squeeeks family — up to ${FAMILY_CAP} people including you — ` +
        'gets Pro for as long as this subscription stays active',
    );
  }
  return lines;
}

/**
 * The receipt for one verified subscription purchase, or null if it cannot be
 * stated truthfully.
 *
 * Returns null when there is no address to send to, or when the product has no
 * known price. CRITICAL: NULL IS NOT AN ERROR AND MUST NEVER BE TREATED AS ONE — the
 * grant has already happened by the time anything calls this, and a receipt
 * that could not be composed is a missing courtesy, not a failed purchase.
 */
export function receiptFor(args: {
  email: string | null | undefined;
  productId: string;
  transactionId: string;
  purchaseDateMs: number;
  expiresDateMs: number | null;
}): ProReceipt | null {
  const {email, productId, transactionId, purchaseDateMs, expiresDateMs} = args;
  if (!email) return null;

  const priced = SUBSCRIPTION_PRICES[productId];
  if (!priced) return null;

  const renews =
    expiresDateMs != null
      ? `Renews on ${dayOf(expiresDateMs)} unless cancelled.`
      : 'Renews automatically unless cancelled.';

  const body = [
    `Thanks for subscribing to Squeeeks ${priced.planName}.`,
    '',
    'WHAT YOU GET',
    ...benefitLinesFor(productId),
    '',
    'PAYMENT',
    `• Plan:      Squeeeks ${priced.planName} (${priced.period})`,
    `• Price:     $${priced.displayPrice} ${priced.period === 'annual' ? 'per year' : 'per month'}`,
    `• Purchased: ${dayOf(purchaseDateMs)}`,
    `• ${renews}`,
    '',
    // WARNING: Apple is the merchant of record and the only place a subscription can
    // be cancelled. Saying so is not boilerplate — a receipt that implies we
    // can cancel it generates a support ticket we cannot resolve.
    'Billed by Apple. Manage or cancel any time in Settings → your name → Subscriptions.',
    '',
    'LEGAL',
    `• Terms of Service: ${LEGAL_URLS.terms}`,
    `• Privacy Policy:   ${LEGAL_URLS.privacy}`,
    `• Support:          ${LEGAL_URLS.support}`,
    '',
    `Transaction ID: ${transactionId}`,
  ].join('\n');

  return {
    to: email,
    subject: `Your Squeeeks ${priced.planName} receipt — $${priced.displayPrice}`,
    body,
    productId,
    transactionId,
    displayPrice: priced.displayPrice,
    period: priced.period,
  };
}

/**
 * The seam a real provider plugs into.
 *
 * Nothing implements this yet, deliberately. A caller holding an EmailSender
 * cannot tell whether a message left the building, which is the correct shape
 * while no provider exists — and the reason `send` returns void rather than a
 * delivery promise the caller might be tempted to await inside a transaction.
 */
export interface EmailSender {
  send(receipt: ProReceipt): Promise<void>;
}

/**
 * CRITICAL: WHAT BRENDAN MUST CREATE BEFORE A RECEIPT CAN BE SENT.
 *
 * Named precisely so this needs no follow-up question. Nothing below can be
 * done from inside this repo.
 *
 *  1. AN EMAIL PROVIDER ACCOUNT. Resend or Postmark; both are transactional-only
 *     and neither requires a marketing plan. SendGrid also works. The choice
 *     matters less than that it is transactional — a marketing provider will
 *     eventually add an unsubscribe footer to a purchase receipt, which is both
 *     wrong and a compliance problem.
 *
 * 2. A SENDING DOMAIN YOU CONTROL — e.g. `mail.squeeeks.app`. WARNING: NOT gmail.com:
 *     the support address in app_links.dart is a personal Gmail, and no provider
 *     will let you send as a domain you do not own. This is the item with a
 *     real lead time, because it needs a domain purchase if there is not one.
 *
 *  3. THREE DNS RECORDS on that domain, given to you verbatim by the provider:
 *       · SPF   — a TXT record authorising the provider to send as you
 *       · DKIM  — a CNAME or TXT carrying the signing key
 *       · DMARC — a TXT record at _dmarc.<domain>; start at p=none
 *     Without SPF and DKIM the mail is delivered to spam, which is
 *     indistinguishable from not sending it at all.
 *
 *  4. THE API KEY, stored as a Cloud Functions secret and NEVER in this repo:
 *       firebase functions:secrets:set EMAIL_API_KEY
 *     and referenced from the sending function's `secrets: ['EMAIL_API_KEY']`.
 *     A key committed here is a key that has to be rotated.
 *
 *  5. A FROM ADDRESS on that domain, e.g. `receipts@mail.squeeeks.app`, and a
 *     REPLY-TO of the support address so an answer reaches a human.
 *
 * NOTE: Only step 4 is code. Steps 1-3 and 5 are account and DNS work, and step 2
 * is the one that can take a day.
 */
export const REQUIRED_SETUP = [
  'transactional email provider account (Resend / Postmark / SendGrid)',
  'a sending domain you control — not gmail.com',
  'SPF, DKIM and DMARC DNS records on that domain',
  'EMAIL_API_KEY stored via firebase functions:secrets:set',
  'a from address on the domain, with reply-to set to support',
] as const;
