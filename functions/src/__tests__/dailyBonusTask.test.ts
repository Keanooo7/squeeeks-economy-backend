// The daily 2x bonus task, and the tier-aware paid cap.
//
// Both landed together on 2026-08-10 from Brendan's direction: a player should
// be able to clean as much as they like and simply stop EARNING once the day's
// allowance is spent, with one task a day paying double.

import {
  TASK_LIBRARY_IDS,
  BONUS_TASK_MULTIPLIER,
  bonusTaskIdFor,
} from '../dailyBonusTask';
import {
  PAID_TASK_CAP_BY_TIER,
  DEFAULT_PAID_TASK_CAP,
  paidTaskCapFor,
} from '../taskRewards';

describe('bonusTaskIdFor', () => {
  it('is deterministic — the same day always yields the same task', () => {
    // The whole reason it is a pure function of the date rather than a stored
    // roll: it survives restarts, reinstalls and cold starts with no write.
    for (const day of ['2026-08-10', '2026-01-01', '2026-12-31']) {
      expect(bonusTaskIdFor(day)).toBe(bonusTaskIdFor(day));
    }
  });

  it('always names a task that exists in the library', () => {
    // A bonus id outside the library would gild nothing and pay nothing — the
    // failure would be silent on both sides.
    for (let d = 1; d <= 28; d++) {
      const day = `2026-02-${String(d).padStart(2, '0')}`;
      expect(TASK_LIBRARY_IDS).toContain(bonusTaskIdFor(day));
    }
  });

  it('moves between days rather than sticking on one task', () => {
    const picks = new Set<string | null>();
    for (let d = 1; d <= 31; d++) {
      picks.add(bonusTaskIdFor(`2026-03-${String(d).padStart(2, '0')}`));
    }
    // A constant hash would give 1. Anything above a handful proves the seed
    // actually varies; exact spread is not a contract worth pinning.
    expect(picks.size).toBeGreaterThan(5);
  });

  it('spreads reasonably evenly over a year', () => {
    // Guards against a hash that technically varies but favours a few slots —
    // "the bonus is always the dishes" is a bug report waiting to happen.
    const counts = new Map<string, number>();
    const start = new Date(Date.UTC(2026, 0, 1));
    for (let i = 0; i < 365; i++) {
      const d = new Date(start.getTime() + i * 86400000);
      const key = d.toISOString().slice(0, 10);
      const id = bonusTaskIdFor(key)!;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    // 365 days over 30 tasks ≈ 12 each. Allow a wide band; the assertion is
    // "no task is starved and none dominates", not uniformity.
    expect(counts.size).toBe(TASK_LIBRARY_IDS.length);
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(2);
      expect(n).toBeLessThan(35);
    }
  });

  it('doubles, and says so in one place', () => {
    expect(BONUS_TASK_MULTIPLIER).toBe(2);
  });

  it('mirrors thirty library ids with no duplicates', () => {
    expect(TASK_LIBRARY_IDS).toHaveLength(30);
    expect(new Set(TASK_LIBRARY_IDS).size).toBe(TASK_LIBRARY_IDS.length);
  });
});

describe('paidTaskCapFor', () => {
  it('raises the ceiling with the tier', () => {
    // 📌 A SECOND literal assertion of the free cap, and it is easy to miss:
    // it reads through paidTaskCapFor rather than naming PAID_TASK_CAP_BY_TIER,
    // so a search for the constant does not find it. The pinning guard below is
    // the one that says WHY; this one only has to agree with it. It has moved
    // twice now: 8 -> 4 (W1-92), then 4 -> 1 (W1-99).
    expect(paidTaskCapFor('free')).toBe(1);
    expect(paidTaskCapFor('pro')).toBe(4);
  });

  it('decodes the retired premium tier to pro rather than dropping it to free', () => {
    // #314 retired premium. Documents written before then still carry it and
    // nothing migrates them, so this is about real stored data, not history.
    //
    // 24 was premium's cap and it is deliberately gone: the tier no longer
    // exists to sell. What must NOT happen is the fail-closed default catching
    // it — that would be 8, the FREE cap, for someone who paid. Decoding to pro
    // is a retirement; falling to free would be a downgrade.
    expect(paidTaskCapFor('premium')).toBe(paidTaskCapFor('pro'));
    expect(paidTaskCapFor('premium')).toBeGreaterThan(DEFAULT_PAID_TASK_CAP);
  });

  it('pins the free tier cap — it may not move without a decision', () => {
    // 🔑 THIS GUARD IS DELIBERATE AND IT IS THE POINT OF THIS TEST. It is the
    // only place the free cap's literal is asserted, so free cannot move
    // quietly. If it fails, someone changed a free player's daily income —
    // which is allowed, but never as a side effect.
    //
    // ⚠️ It has been retargeted ONCE, and the history matters more than the
    // number. It read `toBe(8)` with "this change must not be a nerf … free
    // keeps exactly that", written when paid tiers were raised above a flat 8
    // and the ratchet only ever had to hold free STILL.
    //
    // 8 -> 4 on 2026-08-14, Brendan's call, together with the client half in
    // W1-92. It IS a reduction to the free tier and is recorded as one rather
    // than described as anything else. The guard was kept and repointed rather
    // than deleted: what it defends is that this number changes on purpose, not
    // that it never changes.
    //
    // 4 -> 1 later the same day, W1-99, Brendan verbatim: "free get 1 task they
    // can do a day to get sponges, infinite for xp. pro get 4 a day with
    // sponges." A second reduction, recorded as one.
    //
    // ⚠️ IT IS NOT THE WHOLE PICTURE AND THE GUARD SHOULD NOT PRETEND IT IS.
    // The same respec made XP uncapped (#339) and gave free 20 sponges every
    // Sunday (`claimWeeklyGift`). Free's daily TASK income fell; free's total
    // income did not fall by the same shape. This literal defends the cap, not
    // the offer.
    expect(PAID_TASK_CAP_BY_TIER.free).toBe(1);
  });

  it('fails CLOSED for anything it does not recognise', () => {
    // A missing, misspelled or future tier must resolve to the free cap, never
    // the most generous one — the same direction subscriptionTierProvider
    // fails on the client, where loading and error both report free.
    for (const bad of [undefined, null, '', 'PRO', 'platinum', 42, {}]) {
      expect(paidTaskCapFor(bad)).toBe(DEFAULT_PAID_TASK_CAP);
    }
    expect(DEFAULT_PAID_TASK_CAP).toBe(PAID_TASK_CAP_BY_TIER.free);
  });

  it('every tier a document can hold resolves to a paid cap', () => {
    // ⚠️ Asserted through paidTaskCapFor, NOT by indexing the table. It used to
    // read PAID_TASK_CAP_BY_TIER[tier] directly, which made it a claim about
    // the table's SHAPE rather than about behaviour — and that is exactly the
    // assertion that breaks when a tier is retired, even though the behaviour
    // it cared about (a paying user never silently falls to free) still holds
    // via LEGACY_TIER_ALIASES.
    //
    // 'premium' is included because stored documents still carry it.
    for (const tier of ['pro', 'premium']) {
      expect(paidTaskCapFor(tier)).toBeGreaterThan(DEFAULT_PAID_TASK_CAP);
    }
    expect(paidTaskCapFor('free')).toBe(DEFAULT_PAID_TASK_CAP);
  });
});
