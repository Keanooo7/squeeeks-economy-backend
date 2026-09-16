/**
 * The Pro receipt (W2-107) — and the two gates that stop it drifting.
 *
 * 🔴 A RECEIPT IS THE WORST PLACE FOR A STALE NUMBER, because nobody diffs an
 * email against a config. The shop showed 9.99 for a 2.99 product for six days
 * with a test suite green the whole time; a receipt stating a wrong price would
 * survive longer and reach the buyer directly.
 *
 * So every element the receipt states is either COMPUTED from live constants or
 * GATED against its real source. The two gated tables exist only because a
 * Cloud Function cannot import a Dart file or read `ios/` at runtime.
 */
import {readFileSync} from 'fs';
import {resolve} from 'path';

import {
  LEGAL_URLS,
  REQUIRED_SETUP,
  SUBSCRIPTION_PRICES,
  benefitLinesFor,
  receiptFor,
} from '../proReceipt';
import {FAMILY_CAP} from '../family';
import {PAID_TASK_CAP_BY_TIER, TASK_SPONGE_REWARD} from '../taskRewards';

const REPO = resolve(__dirname, '..', '..', '..');
const PURCHASED = Date.UTC(2026, 7, 16);
const EXPIRES = Date.UTC(2026, 8, 16);

/** One StoreKit entry, in either of the two places StoreKit puts them. */
interface Entry {
  productID: string;
  displayPrice?: string;
  localizations?: {displayName?: string}[];
}

const base = {
  email: 'buyer@example.com',
  productId: 'sub_pro_monthly',
  transactionId: 'txn-1',
  purchaseDateMs: PURCHASED,
  expiresDateMs: EXPIRES,
};

describe('🔴 the price is GATED against ios/Configuration.storekit', () => {
  const cfg = JSON.parse(
    readFileSync(resolve(REPO, 'ios', 'Configuration.storekit'), 'utf8'),
  ) as {
    products: Entry[];
    subscriptionGroups?: {subscriptions: Entry[]}[];
  };

  /** Every registered product, whether one-off or inside a subscription group. */
  const registered = new Map<string, string | undefined>();
  /** The buyer-facing name Apple shows, keyed the same way. */
  const displayNames = new Map<string, string | undefined>();
  const record = (e: Entry) => {
    registered.set(e.productID, e.displayPrice);
    displayNames.set(e.productID, e.localizations?.[0]?.displayName);
  };
  for (const p of cfg.products ?? []) record(p);
  for (const g of cfg.subscriptionGroups ?? []) {
    for (const s of g.subscriptions ?? []) record(s);
  }

  it('the registry parsed and is not vacuously empty', () => {
    // ⚠️ Subscriptions live under `subscriptionGroups`, NOT `products` — a
    // reader that only walked `products` would find zero subscriptions and
    // every assertion below would pass against nothing.
    expect(registered.size).toBeGreaterThanOrEqual(6);
    expect(registered.has('sub_pro_monthly')).toBe(true);
    expect(registered.has('sub_pro_annual')).toBe(true);
  });

  it.each(Object.keys(SUBSCRIPTION_PRICES))(
    '%s charges what the receipt says it charges',
    (productId) => {
      expect(
        `${productId} → ${registered.get(productId)}`,
      ).toBe(`${productId} → ${SUBSCRIPTION_PRICES[productId].displayPrice}`);
    },
  );

  it('every priced product is actually registered', () => {
    // The inverse direction: a price for a product that ships nowhere is the
    // `premium_offer_spring` shape, and it would put an uncharged number in
    // front of a buyer.
    for (const productId of Object.keys(SUBSCRIPTION_PRICES)) {
      expect(`${productId} registered: ${registered.has(productId)}`).toBe(
        `${productId} registered: true`,
      );
    }
  });

  it('🔴 W2-157 REVERSED: sub_family_monthly IS priced, so a family buyer gets a receipt', () => {
    // ⚠️ THIS TEST USED TO ASSERT THE EXACT OPPOSITE, and it was right to at the
    // time: the product existed nowhere, so a receipt for it would have had to
    // INVENT a charge, and `receiptFor` returned null rather than guess. That
    // premise died — the product is in App Store Connect (Apple ID 6801924400)
    // and in ios/Configuration.storekit at 12.99. The ratchet is reversed
    // deliberately, not relaxed: it still pins the same decision, it just pins
    // it to the side the world is now on.
    //
    // 🔑 WHAT IT COST WHILE THE OLD ASSERTION STOOD: a family subscriber
    // received NO RECEIPT AT ALL. Not a failed purchase — they were charged and
    // granted correctly — a missing email, which receiptFor's own header calls
    // "a missing courtesy, not a failed purchase".
    expect(SUBSCRIPTION_PRICES.sub_family_monthly).toEqual({
      displayPrice: '12.99',
      period: 'monthly',
      planName: 'Family',
    });
    expect(receiptFor({...base, productId: 'sub_family_monthly'})).not.toBeNull();
  });

  it('🔴 the PLAN NAME is gated against the same file as the price', () => {
    // Without this the table could name a Family purchase "Pro" and no test
    // would object — which is exactly what the receipt did before W2-157, on
    // every product, because the name was a hardcoded string in the body.
    for (const productId of Object.keys(SUBSCRIPTION_PRICES)) {
      expect(`${productId} → ${displayNames.get(productId)}`).toBe(
        `${productId} → ${SUBSCRIPTION_PRICES[productId].planName}`,
      );
    }
  });
});

describe('🔴 the legal links are GATED against lib/core/config/app_links.dart', () => {
  const dart = readFileSync(
    resolve(REPO, 'lib', 'core', 'config', 'app_links.dart'),
    'utf8',
  );

  /** The value of a `const String kName = '…';`, across a line break or not. */
  function dartConst(name: string): string {
    const m = new RegExp(`${name}\\s*=\\s*\\n?\\s*'([^']+)'`).exec(dart);
    // Anti-vacuity: a rename in the Dart file must fail loudly here rather than
    // yielding undefined and comparing two nothings.
    expect(`${name} found in app_links.dart: ${m !== null}`).toBe(
      `${name} found in app_links.dart: true`,
    );
    return m![1];
  }

  it('the privacy URL matches the app', () => {
    expect(LEGAL_URLS.privacy).toBe(dartConst('kPrivacyPolicyUrl'));
  });

  it('the terms URL matches the app', () => {
    expect(LEGAL_URLS.terms).toBe(dartConst('kTermsOfServiceUrl'));
  });

  it('the support address matches the app', () => {
    expect(LEGAL_URLS.support).toBe(dartConst('kSupportEmail'));
  });
});

describe('the receipt states what Brendan asked for', () => {
  it('names the rewards, COMPUTED from the live caps', () => {
    // 🔑 Not a typed sentence. taskRewards.ts says "work it out from the
    // constants — do not restate it", and an email is where a restated number
    // would live longest unnoticed.
    const r = receiptFor(base)!;
    const proSponges = PAID_TASK_CAP_BY_TIER.pro * TASK_SPONGE_REWARD;
    expect(r.body).toContain(`${proSponges} sponges a day`);
    expect(benefitLinesFor('sub_pro_monthly').join('\n')).toContain(
      `${PAID_TASK_CAP_BY_TIER.pro} paid task`,
    );
  });

  it('names the price and the payment details', () => {
    const r = receiptFor(base)!;
    expect(r.body).toContain('$5.99');
    expect(r.body).toContain('2026-08-16');
    expect(r.body).toContain('txn-1');
    expect(r.subject).toContain('5.99');
    // Apple is the merchant of record — a receipt implying we can cancel it
    // creates a support ticket nobody here can resolve.
    expect(r.body).toContain('Billed by Apple');
  });

  it('attaches the legal links below, as asked', () => {
    const r = receiptFor(base)!;
    expect(r.body).toContain(LEGAL_URLS.terms);
    expect(r.body).toContain(LEGAL_URLS.privacy);
  });

  it('🔴 derives the PERIOD from the product — annual is not "monthly"', () => {
    // ⚠️ W4-83 lands the annual plan. A receipt hard-coding "monthly" is the
    // 3.1.2 disclosure shape in an email, and it would be wrong for exactly the
    // buyer who paid the most.
    const annual = receiptFor({...base, productId: 'sub_pro_annual'})!;
    expect(annual.period).toBe('annual');
    expect(annual.body).toContain('$59.88 per year');
    expect(annual.body).not.toContain('per month');

    const monthly = receiptFor(base)!;
    expect(monthly.period).toBe('monthly');
    expect(monthly.body).toContain('per month');
  });
});

describe('🔴 it refuses to invent, and never fails a purchase', () => {
  it('no address → no receipt, and that is not an error', () => {
    // Measured 2026-08-16: 11 of 17 accounts are anonymous and have no address.
    // None of them has bought anything, and the client will require an account
    // before any future purchase — so this is a fallback that should never
    // fire, kept because a receipt must never be why a purchase fails.
    expect(receiptFor({...base, email: null})).toBeNull();
    expect(receiptFor({...base, email: undefined})).toBeNull();
    expect(receiptFor({...base, email: ''})).toBeNull();
  });

  it('an unknown product → no receipt rather than a fabricated price', () => {
    expect(receiptFor({...base, productId: 'sub_not_a_real_plan'})).toBeNull();
  });

  it('a missing expiry still produces a receipt, without inventing a date', () => {
    const r = receiptFor({...base, expiresDateMs: null})!;
    expect(r.body).toContain('Renews automatically');
    expect(r.body).not.toMatch(/Renews on \d{4}-\d{2}-\d{2}/);
  });
});

describe('the setup Brendan must do is stated, not implied', () => {
  it('names a provider, a domain, DNS and the secret', () => {
    // A "state exactly what must be created" deliverable that says "configure
    // email" is not one. Each item is asserted so it cannot be quietly dropped.
    const all = REQUIRED_SETUP.join(' | ');
    expect(all).toMatch(/provider/i);
    expect(all).toMatch(/domain/i);
    expect(all).toMatch(/SPF|DKIM|DMARC/);
    expect(all).toMatch(/EMAIL_API_KEY/);
    expect(REQUIRED_SETUP.length).toBeGreaterThanOrEqual(5);
  });
});

describe('🔴 W2-157 the receipt names the plan the buyer actually bought', () => {
  const familyBase = {...base, productId: 'sub_family_monthly'};

  it('a FAMILY purchase is not called Pro anywhere in the receipt', () => {
    // 🔴 THE DEFECT THIS GUARDS. Every string in the body was hardcoded to
    // "Squeeeks Pro", so the moment the family price existed the receipt read
    // "Plan: Squeeeks Pro" and "Your Squeeeks Pro receipt — $12.99" — a $5.99
    // product's name next to a $12.99 charge, on the document that proves what
    // the customer bought. A price fix alone SHIPS that; it is why the price
    // was not the whole fix.
    const r = receiptFor(familyBase)!;
    expect(r.subject).toBe('Your Squeeeks Family receipt — $12.99');
    expect(r.body).toContain('Thanks for subscribing to Squeeeks Family.');
    expect(r.body).toContain('• Plan:      Squeeeks Family (monthly)');
    expect(r.body).not.toContain('Squeeeks Pro');
  });

  it('🔴 CONTROL: a PRO purchase is still called Pro', () => {
    // Without this, "never says Pro" and "says the right thing" are the same
    // green — a table that returned 'Family' for every product would pass the
    // test above.
    const r = receiptFor(base)!;
    expect(r.subject).toBe('Your Squeeeks Pro receipt — $5.99');
    expect(r.body).toContain('• Plan:      Squeeeks Pro (monthly)');
    expect(r.body).not.toContain('Squeeeks Family');
  });
});

describe("🔴 W2-157 the coverage line is per-product, because it was a false promise", () => {
  it('🔴 a PRO receipt no longer promises that the buyer\'s family gets Pro', () => {
    // 🔴 THE HEADLINE DEFECT. This line shipped on the ONLY receipt that has
    // ever been composable — $5.99 sub_pro_monthly — and W2-156 established it
    // is FALSE: planFamilyFanOutForEffect returns [] unless the owner's product
    // is FAMILY_PRODUCT_ID, so a personal-Pro subscriber's invitees are entitled
    // to nothing. The receipt promised them the opposite in writing.
    const r = receiptFor(base)!;
    expect(r.body).not.toContain('everyone in your family gets Pro');
    expect(r.body).not.toContain('Squeeeks family');
  });

  it('a FAMILY receipt states the coverage, with the cap READ from FAMILY_CAP', () => {
    // The other half: the promise is true for THIS product, so it is stated —
    // and the number comes from the constant, per taskRewards.ts's "work it out
    // from the constants, do not restate it".
    const r = receiptFor({...base, productId: 'sub_family_monthly'})!;
    expect(r.body).toContain(
      `• Everyone in your Squeeeks family — up to ${FAMILY_CAP} people including you — ` +
        'gets Pro for as long as this subscription stays active',
    );
  });

  it("🔴 no receipt uses Apple's term \"Family sharing\"", () => {
    // familyShareable is FALSE on every product in Configuration.storekit,
    // deliberately (#380, 6d00fc8). Apple's Family Sharing and this app's roster
    // are two different mechanisms; naming ours after theirs means the buyer
    // cannot tell which one they were sold. Checked on BOTH products, because
    // the old line was unconditional and a per-product fix could reintroduce it
    // on one branch only.
    for (const productId of ['sub_pro_monthly', 'sub_family_monthly']) {
      const r = receiptFor({...base, productId})!;
      expect(`${productId}: ${r.body.includes('Family sharing')}`).toBe(
        `${productId}: false`,
      );
    }
  });
});

describe('🔴 W2-182 the buyer-facing NUMBERS are pinned as LITERALS, not as symbols', () => {
  // ---------------------------------------------------------------------------
  // 🔴 A GATE SPELLED IN ITS OWN CONSTANT CANNOT FAIL. MEASURED, NOT ARGUED.
  // ---------------------------------------------------------------------------
  //
  // Every other assertion in this file that names a derived number imports the
  // SAME symbol `proReceipt.ts` reads, so both sides of the comparison move
  // together and the assertion cannot go red. Three single-constant mutations,
  // each run against THIS FILE alone on 22d659d (W2-182):
  //
  //   FAMILY_CAP                 5 → 6   proReceipt.test.ts  23/23 GREEN
  //   TASK_SPONGE_REWARD         5 → 7   proReceipt.test.ts  23/23 GREEN
  //   PAID_TASK_CAP_BY_TIER.pro  4 → 6   proReceipt.test.ts  23/23 GREEN
  //
  // ⚠️ AND `TASK_SPONGE_REWARD` IS UNPINNED ACROSS THE ENTIRE BACKEND: the full
  // `npm test` run stayed **1687/1687 green** with it at 7. FAMILY_CAP is caught
  // elsewhere (family.test.ts, 5 red) and the pro cap is caught elsewhere
  // (dailyBonusTask.test.ts › `paidTaskCapFor › raises the ceiling with the
  // tier`, 1 red) — the sponge reward was caught by NOTHING, in any suite. A
  // receipt reading "28 sponges a day" would have shipped with every gate
  // reporting success, and nobody diffs an email against a config.
  //
  // 📌 THE ASSERTION AT :283 IS NOT VACUOUS, ONLY ITS NUMBER IS. Positive
  // control on the same sentence and the same population: rewording the source
  // from "including you" to "including yourself" turned exactly that one test
  // red, 1 failed / 22 passed. The prose half is falsifiable; the digit is not.
  //
  // 🔑 SO THE PIN IS ON THE RENDERED SENTENCE RATHER THAN ON THE CONSTANT. What
  // a billing document has to be right about is the string the buyer reads, and
  // pinning the line whole catches a wrong cap, a wrong reward and a reworded
  // promise in one assertion — without adding a second copy of the arithmetic,
  // which would drift in exactly the way the imported symbol does.
  //
  // ⚠️ WHEN A CAP OR A REWARD LEGITIMATELY CHANGES THIS GOES RED, AND THAT IS
  // THE POINT. Retype the line to match what the buyer will now read. Do not
  // reintroduce an interpolated constant to make it quiet again.

  const PRO_LINES = [
    '• 4 paid task completions a day, up from 1 on the free plan',
    '• 20 sponges a day from tasks, up from 5',
  ];
  const FAMILY_COVERAGE =
    '• Everyone in your Squeeeks family — up to 5 people including you — ' +
    'gets Pro for as long as this subscription stays active';

  it('a PRO receipt states 4 paid tasks and 20 sponges, spelled out', () => {
    expect(benefitLinesFor('sub_pro_monthly')).toEqual(PRO_LINES);
  });

  it('a FAMILY receipt states the same two lines plus a roster of 5', () => {
    expect(benefitLinesFor('sub_family_monthly')).toEqual([
      ...PRO_LINES,
      FAMILY_COVERAGE,
    ]);
  });

  it('🔴 and the composed body carries those literal lines, not just the helper', () => {
    // The helper could be right while the body dropped it — benefitLinesFor is
    // spread into `receiptFor`, and a spread that stops being spread is silent.
    const r = receiptFor({...base, productId: 'sub_family_monthly'})!;
    for (const line of [...PRO_LINES, FAMILY_COVERAGE]) {
      expect(`body contains "${line}": ${r.body.includes(line)}`).toBe(
        `body contains "${line}": true`,
      );
    }
  });

  it('🔑 the literals agree with the live constants — a drift fails BOTH ways', () => {
    // Anti-divergence. Without this the pinned strings above could be updated
    // to a number the code does not produce, and the file would then assert two
    // different truths in two places. This is the ONE assertion here that is
    // allowed to be spelled in the symbols, because its whole job is to tie the
    // literal and the symbol together rather than to check either alone.
    expect(`cap ${PAID_TASK_CAP_BY_TIER.pro} free ${PAID_TASK_CAP_BY_TIER.free} reward ${TASK_SPONGE_REWARD} roster ${FAMILY_CAP}`).toBe(
      'cap 4 free 1 reward 5 roster 5',
    );
  });
});
