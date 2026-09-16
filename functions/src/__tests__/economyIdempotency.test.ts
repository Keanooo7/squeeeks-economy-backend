// functions/src/__tests__/economyIdempotency.test.ts
//
// W2-18. Nothing rate-limits any callable. `git grep ratelimit|throttle|appCheck`
// across functions/src returns NOTHING, for any of the twelve.
//
// 🔑 AND THE AUDIT SAYS THAT IS MOSTLY FINE, WHICH IS THE POINT OF THIS FILE.
// A rate limiter is the wrong instrument for a replay: it makes abuse slower,
// not impossible, and it would be a second mechanism guarding what idempotency
// already guards. What actually protects the economy is that every grant is
// either transactional or guarded by a ledger read inside the same transaction.
//
// So this is a TWO-WAY LEDGER over the callables that move currency, in the
// shape of moduleReachability.test.ts: every one is transactional, or it is
// listed below with a reason. A new non-transactional grant fails this suite
// until someone decides which it is.
//
// ⚠️ WHY A GATE RATHER THAN A PARAGRAPH IN A RETURN: an audit that produces no
// gate is a finding that rots. This one caught two things at the time of
// writing, and both are recorded below rather than fixed here — fixing either
// needs a client change, which is not this window's lane.

import * as fs from 'fs';
import * as path from 'path';
import {codeOf} from './helpers/sourceText';

const INDEX_RAW = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');

/**
 * 🔴 W2-29. Source greps here read CODE, never comments.
 *
 * W2-27 found a guard in galleryFeedback.test.ts passing because the handler
 * MENTIONED the thing it was asserting was gone — in a comment saying it was
 * gone. The assertion was satisfied by prose describing its own negation. Every
 * source-reading guard written this session had the same hole; this is one of
 * five audited under W2-29.
 *
 * ⚠️ The classification below (movesValue / hasTransaction) was checked raw vs
 * stripped for all 12 callables and NOT ONE changed — so this guard was not
 * lying. It is stripped anyway, because it was one long comment away from it:
 * a handler whose comment mentioned `runTransaction` would have been silently
 * counted as transactional.
 */
const INDEX = codeOf(INDEX_RAW);

/** Every `export const X = onCall(` in index.ts, with its handler body. */
function callables(): {name: string; body: string}[] {
  const out: {name: string; body: string}[] = [];
  const re = /export const (\w+) = onCall\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(INDEX)) !== null) {
    // A handler ends at the first `});` in column 0. ⚠️ Slicing to the next
    // `export const` runs PAST it into whatever helper sits between, and a test
    // that does that is asserting about the wrong function while passing for
    // the wrong reason. That mistake was made twice while writing this session.
    const end = INDEX.indexOf('\n});', m.index);
    out.push({name: m[1], body: INDEX.slice(m.index, end === -1 ? undefined : end + 4)});
  }
  return out;
}

/** Writes that move real value. An increment is the dangerous shape. */
const VALUE_WRITES = [
  'spongeBalance',
  'streakShields',
  '/inventory/',
  'XP_FIELD',
  'awardXp',
];

function movesValue(body: string): boolean {
  return VALUE_WRITES.some((w) => body.includes(w));
}

/**
 * Value-moving callables that are NOT wrapped in a transaction, with the reason
 * each is safe anyway. Not a blessing — a decision, recorded.
 */
const NON_TRANSACTIONAL_BUT_SAFE: Record<string, string> = {
  verifySubscriptionReceipt:
    'Check-then-act on processedReceipts/{productId}_{transactionId} across two ' +
    'separate awaits, so two concurrent calls with one receipt CAN both pass the ' +
    'ledger check. Benign, because what it grants is a SET of subscriptionTier, ' +
    'not an increment — both writers produce the same state. It would stop being ' +
    'benign the moment it granted sponges or an item, and that is the change that ' +
    'should force it into a transaction. Note the ordering is deliberate: it ' +
    'grants BEFORE writing the ledger, because a previous version wrote the ' +
    'ledger first and a replay then returned alreadyProcessed WITHOUT EVER ' +
    'HAVING GRANTED (comment at the top of the handler).',
};

/**
 * Value-moving callables with NO replay key, and why each is or is not a hole.
 *
 * 🔴 A transaction stops two CONCURRENT calls from racing. It does nothing about
 * the SAME call arriving twice — a dropped response and a client retry. Those
 * are different problems and only one of them is solved by `runTransaction`.
 */
const NO_REPLAY_KEY: Record<string, string> = {
  recordTaskCompletion:
    'No caller-supplied key, and does not need one: grantTaskRewards pays only ' +
    'the delta against a per-day paidCount ledger read inside its own ' +
    'transaction, so a replay pays zero. The idempotency is in the ledger rather ' +
    'than in a key.',
  claimMinigamePrize:
    'Same shape: the per-day claimed flag is read and written inside one ' +
    'transaction, so a replay returns alreadyClaimed and grants nothing.',
  claimDailyGift: 'Guarded by lastDailyGiftClaimedAt inside its transaction.',
  claimWeeklyGift:
    'Guarded by lastWeeklyGiftSunday inside its transaction. Note the key is a ' +
    'DATE (the most recent Sunday, UTC), not a timestamp compared against a ' +
    'rolling window as claimDailyGift uses — so a replay in the same calendar ' +
    'week is refused even if seven days have passed since the claim.',
  claimWelcomeChest: 'Guarded by a claimed flag inside its transaction.',
  claimGift: 'Guarded by a claimed flag inside its transaction.',
  awardStreakReward: 'Guarded by awardedMilestones inside its transaction.',
  openPendingChest:
    'No caller-supplied key and it does not need one: the CHEST DOCUMENT IS the ' +
    'replay key. `openedAt` is read and written inside one transaction, so a ' +
    'second call — concurrent or retried — finds it non-null and throws ' +
    'already-exists having granted nothing. A pending chest is single-use by ' +
    'construction rather than by a ledger beside it. ⚠️ Note the roll happens ' +
    'OUTSIDE the transaction (pickChestItem runs a collection query, which a ' +
    'transaction cannot serve), so two racing taps both roll — but only one can ' +
    'pass the in-transaction openedAt check, so only one roll is ever APPLIED. ' +
    'The wasted roll is invisible and costs nothing; the double grant is what ' +
    'matters and it cannot happen.',
  resolveStreak: 'Guarded by awardedMilestones and the gap == 0 no-op.',
  verifySubscriptionReceipt: 'Keyed on the receipt transactionId; see above.',
  verifyIapAndGrant: 'Keyed on the receipt transactionId.',
  sendGiftInvite: 'Guarded by a claimed flag inside its transaction.',
};

describe('the callable surface', () => {
  test('there are callables to audit at all — the check must not vacuously pass', () => {
    // Zero callables found is not zero defects; it is a broken regex.
    expect(callables().length).toBeGreaterThanOrEqual(12);
  });

  test('no callable is rate-limited, throttled, or App Check gated — stated, not assumed', () => {
    // This is the brief's premise and it is asserted so that it stays true or
    // stops being a surprise. If someone adds a limiter, this test says so.
    expect(INDEX).not.toMatch(/rateLimit|rate_limit|throttle|appCheck|enforceAppCheck/i);
  });
});

describe('every value-moving callable is transactional, or listed with a reason', () => {
  test('no unaccounted non-transactional grant', () => {
    const offenders = callables()
      .filter((c) => movesValue(c.body))
      .filter((c) => !c.body.includes('runTransaction'))
      .filter((c) => !(c.name in NON_TRANSACTIONAL_BUT_SAFE))
      .map((c) => c.name);
    // Named in the failure so an orphan is identifiable from the output alone.
    expect(offenders).toEqual([]);
  });

  test('the ledger has no stale entry — every listed name still exists', () => {
    // The inverse direction. Without it, a callable that gets wrapped in a
    // transaction leaves a permanent excuse behind for a problem it no longer has.
    const names = callables().map((c) => c.name);
    for (const listed of Object.keys(NON_TRANSACTIONAL_BUT_SAFE)) {
      expect(names).toContain(listed);
    }
  });

  test('every listed entry still lacks a transaction', () => {
    const byName = new Map(callables().map((c) => [c.name, c.body]));
    for (const listed of Object.keys(NON_TRANSACTIONAL_BUT_SAFE)) {
      expect(byName.get(listed)).not.toContain('runTransaction');
    }
  });

  test('every reason is a reason, not a shrug', () => {
    for (const reason of Object.values(NON_TRANSACTIONAL_BUT_SAFE)) {
      expect(reason.length).toBeGreaterThan(80);
    }
  });
});

describe('🔴 a transaction is not a replay guard — they solve different problems', () => {
  // A transaction stops two CONCURRENT calls racing. It does nothing about the
  // SAME call arriving twice after a dropped response. Conflating them is how a
  // "it's transactional, so it's safe" review misses a double charge.
  test('every value-moving callable is accounted for in the replay ledger', () => {
    const unaccounted = callables()
      .filter((c) => movesValue(c.body))
      .filter((c) => !(c.name in NO_REPLAY_KEY))
      .filter((c) => !c.body.includes('purchaseId'))
      .map((c) => c.name);
    expect(unaccounted).toEqual([]);
  });

  test('purchaseChest is the pattern the gap should be closed with', () => {
    const chest = callables().find((c) => c.name === 'purchaseChest');
    expect(chest).toBeDefined();
    expect(chest!.body).toContain('purchaseId');
    expect(chest!.body).toContain('runTransaction');
  });

  test('⚠️ but purchaseChest\'s replay key is OPTIONAL, so the guard is opt-in', () => {
    // `purchaseId?: string` — a client that omits it gets a transaction and no
    // replay protection. Recorded because "purchaseChest has a replay ledger"
    // reads as stronger than it is.
    expect(INDEX).toContain('purchaseId?: string');
  });

  // 🔑 THIS TEST INVERTED WHEN W2-19 FIXED THE DEFECT IT WAS DESCRIBING, which
  // is the two-way ledger doing its job: closing the gap FORCED the excuse to be
  // deleted, rather than leaving a permanent note about a problem that no longer
  // exists. It previously asserted `not.toContain('purchaseId')`.
  test('purchaseStreakShield now has BOTH a transaction and a replay key', () => {
    const shield = callables().find((c) => c.name === 'purchaseStreakShield');
    expect(shield).toBeDefined();
    expect(shield!.body).toContain('runTransaction');        // races
    expect(shield!.body).toContain('purchaseId');            // replays
    expect(shield!.body).toContain('assertValidReplayKey');  // the SHARED rule
    expect(NO_REPLAY_KEY).not.toHaveProperty('purchaseStreakShield');
  });

  test('it writes its ledger with create(), which cannot interleave', () => {
    const shield = callables().find((c) => c.name === 'purchaseStreakShield');
    // A check followed by a set can interleave; a create cannot. The read
    // catches a retry, the create catches a genuinely concurrent call.
    expect(shield!.body).toContain('tx.create(purchaseLedgerRef');
  });

  test('the ledger read joins the existing Promise.all — no extra round-trip', () => {
    // The brief's disproof condition: reuse, not restructure.
    const shield = callables().find((c) => c.name === 'purchaseStreakShield');
    const all = shield!.body.indexOf('Promise.all');
    const get = shield!.body.indexOf('tx.get(purchaseLedgerRef');
    expect(all).toBeGreaterThan(-1);
    expect(get).toBeGreaterThan(all);
  });

  test('both callables validate the key through ONE shared rule', () => {
    // Two copies of four conditions is a second definition of "valid replay
    // key" — the drift this codebase keeps filing, one size smaller.
    const chest = callables().find((c) => c.name === 'purchaseChest');
    const shield = callables().find((c) => c.name === 'purchaseStreakShield');
    expect(chest!.body).toContain('assertValidReplayKey');
    expect(shield!.body).toContain('assertValidReplayKey');
    // And the old inline copy is gone rather than merely unused.
    expect(INDEX).not.toContain("purchaseId.length > 128");
  });
});

describe('the once-per-day checks cannot be raced', () => {
  // The brief's second question. Every daily gate reads its ledger INSIDE the
  // transaction that writes it, so two concurrent calls cannot both observe
  // "unclaimed" and both commit — Firestore retries the loser.
  const DAILY_GATED = [
    'claimMinigamePrize',
    'claimDailyGift',
    'recordTaskCompletion',
  ];

  test.each(DAILY_GATED)('%s reads its guard inside a transaction', (name) => {
    const c = callables().find((x) => x.name === name);
    expect(c).toBeDefined();
    const body = c!.body;
    const txAt = body.indexOf('runTransaction');
    expect(txAt).toBeGreaterThan(-1);
    // The guard read must come AFTER the transaction opens. A check-then-act
    // above the transaction is the exact shape verifySubscriptionReceipt has.
    const guardAt = Math.max(body.indexOf('tx.get('), body.indexOf('grantTaskRewards'));
    expect(guardAt).toBeGreaterThan(txAt);
  });
});
