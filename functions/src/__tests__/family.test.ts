// functions/src/__tests__/family.test.ts
//
// Gates for the family group document and the pure half of the entitlement
// fan-out (W2-76). See functions/src/family.ts for why a family is a document
// rather than a derivation over `users/{uid}.housemates`.
//
// ---------------------------------------------------------------------------
// CRITICAL: THE QUESTION ASKED OF EVERY TEST BELOW: what single line could I delete
// that SHOULD turn this red?
// ---------------------------------------------------------------------------
//
// The brief named the failure to avoid: "a test proving a family member
// resolves to pro is worthless if it also passes with the family lookup
// deleted". So the grant tests come in PAIRS — a case that must grant, and the
// same case with exactly one precondition removed that must NOT. A test that
// only ever asserts a grant cannot tell the difference between a working
// fan-out and one that returns the owner's expiry for everybody.
//
// The controls were RUN, not reasoned about, and what each one produced is
// recorded in test-floor.json.

import {
  FAMILY_CAP,
  FAMILY_MIN_MEMBERS,
  FamilyDoc,
  familyInvalidReason,
  isStructurallySoundFamily,
  isValidFamily,
  planFamilyFanOut,
  planFamilyBinDay,
  FAMILY_BIN_DAY_REFUSALS,
  isValidBinWeekday,
} from '../family';

const NOW = 1_760_000_000_000;
const HOUR = 60 * 60 * 1000;

const OWNER = 'uid-parent';
const KID = 'uid-kid';
const OTHER_KID = 'uid-kid-2';
const STRANGER = 'uid-stranger';

const familyOf = (memberUids: string[], ownerUid = OWNER): FamilyDoc => ({
  ownerUid,
  memberUids,
  createdAtMs: NOW - 30 * 24 * HOUR,
});

/** The ordinary case: a live family subscription with a month left to run. */
const livePlan = (overrides: Partial<Parameters<typeof planFamilyFanOut>[0]> = {}) =>
  planFamilyFanOut({
    family: familyOf([OWNER, KID]),
    ownerExpiresAtMs: NOW + 30 * 24 * HOUR,
    ownerHasFamilySubscription: true,
    nowMs: NOW,
    ...overrides,
  });

const grantFor = (plan: ReturnType<typeof planFamilyFanOut>, uid: string) =>
  plan.find((g) => g.uid === uid);

describe('familyInvalidReason — the invariants', () => {
  test('a parent and a kid is a valid family', () => {
    expect(familyInvalidReason(familyOf([OWNER, KID]))).toBeNull();
    expect(isValidFamily(familyOf([OWNER, KID]))).toBe(true);
  });

  test('🔴 the owner must be IN memberUids, or the array undercounts by one', () => {
    // The cap counts memberUids. An owner sitting outside it means a family of
    // FAMILY_CAP + 1 people passes a FAMILY_CAP check.
    expect(familyInvalidReason(familyOf([KID, OTHER_KID]))).toBe('owner-not-a-member');
  });

  test('🔴 a repeated uid is refused, because a cap over a list needs a set', () => {
    // Padding to the cap with one duplicated uid is harmless; being trimmed
    // UNDER the cap by a later deduplication is not, and both are avoided by
    // refusing the shape outright.
    expect(familyInvalidReason(familyOf([OWNER, KID, KID]))).toBe('duplicate-members');
  });

  test('a family of one is refused — it is a Pro subscription with extra steps', () => {
    expect(familyInvalidReason(familyOf([OWNER]))).toBe('too-few-members');
    expect(FAMILY_MIN_MEMBERS).toBe(2);
  });

  test('over the cap is refused, and the cap is the family one', () => {
    const tooMany = familyOf(
      [OWNER, ...Array.from({length: FAMILY_CAP}, (_, i) => `uid-extra-${i}`)],
    );
    expect(familyInvalidReason(tooMany)).toBe('over-cap');
  });

  test('exactly at the cap is allowed — the boundary is inclusive', () => {
    const atCap = familyOf(
      [OWNER, ...Array.from({length: FAMILY_CAP - 1}, (_, i) => `uid-extra-${i}`)],
    );
    expect(atCap.memberUids).toHaveLength(FAMILY_CAP);
    expect(familyInvalidReason(atCap)).toBeNull();
  });

  test('an empty ownerUid is refused before anything else looks at it', () => {
    expect(familyInvalidReason(familyOf([KID, OTHER_KID], ''))).toBe('owner-missing');
  });

  test('⚠️ FAMILY_CAP is a SEPARATE constant from HOUSEMATE_CAP, not an alias', () => {
    // They answer different questions — "who may see my house" vs "how many
    // people does one subscription cover" — and only the second has a price on
    // it. This test exists so that answering Brendan's open cap question for
    // families cannot silently move the housemate cap. It pins independence,
    // NOT equality: change FAMILY_CAP alone and this stays green.
    const familySource = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'family.ts'),
      'utf8',
    );
    expect(familySource).not.toMatch(/import\s*\{[^}]*HOUSEMATE_CAP/);
  });
});

describe('planFamilyFanOut — the grant', () => {
  test('every member gets the OWNER\'S expiry, copied exactly', () => {
    const expiry = NOW + 30 * 24 * HOUR;
    const plan = livePlan();

    expect(plan).toHaveLength(2);
    expect(grantFor(plan, OWNER)?.familyProExpiresAtMs).toBe(expiry);
    expect(grantFor(plan, KID)?.familyProExpiresAtMs).toBe(expiry);
  });

  test('🔴 the expiry is never EXTENDED beyond what the owner paid for', () => {
    // The whole safety argument in one assertion. A member entitled past the
    // owner's period is entitled to something nobody paid for, and it would
    // look exactly like a working feature.
    const shortExpiry = NOW + 2 * HOUR;
    const plan = livePlan({ownerExpiresAtMs: shortExpiry});

    for (const grant of plan) {
      expect(grant.familyProExpiresAtMs).toBe(shortExpiry);
      expect(grant.familyProExpiresAtMs!).toBeLessThanOrEqual(shortExpiry);
    }
  });

  test('the owner is granted too — they are a member who pays, not a role outside', () => {
    expect(grantFor(livePlan(), OWNER)?.familyProExpiresAtMs).not.toBeNull();
  });
});

describe('🔴 planFamilyFanOut — the anti-vacuity controls', () => {
  // Each test here is the SAME case as a grant above with exactly ONE
  // precondition removed. If the fan-out ever degrades into "return the
  // owner's expiry for everyone", these are what go red.

  test('CONTROL: no family subscription -> revoke, not grant', () => {
    const plan = livePlan({ownerHasFamilySubscription: false});
    expect(plan.every((g) => g.familyProExpiresAtMs === null)).toBe(true);
  });

  test('CONTROL: an ALREADY-LAPSED owner expiry -> revoke', () => {
    const plan = livePlan({ownerExpiresAtMs: NOW - HOUR});
    expect(plan.every((g) => g.familyProExpiresAtMs === null)).toBe(true);
  });

  test('CONTROL: an UNREADABLE owner expiry -> revoke, never a grant', () => {
    const plan = livePlan({ownerExpiresAtMs: null});
    expect(plan.every((g) => g.familyProExpiresAtMs === null)).toBe(true);
  });

  test('CONTROL: an INVALID family grants nobody, even with a paid owner', () => {
    // The owner is entitled and the subscription is live — only the family's
    // shape is wrong. A fan-out that skipped validation would grant here.
    const plan = planFamilyFanOut({
      family: familyOf([KID, OTHER_KID]), // owner not a member
      ownerExpiresAtMs: NOW + 30 * 24 * HOUR,
      ownerHasFamilySubscription: true,
      nowMs: NOW,
    });
    expect(plan.every((g) => g.familyProExpiresAtMs === null)).toBe(true);
  });

  test('🔴 CONTROL: a NON-MEMBER in the same plan is revoked while members are granted', () => {
    // The sharpest one. Both branches run in a SINGLE call, so this cannot be
    // satisfied by a function that returns one answer for everybody — which is
    // exactly the degenerate implementation the other controls could not
    // separately rule out.
    const plan = livePlan({previousMemberUids: [STRANGER]});

    expect(grantFor(plan, KID)?.familyProExpiresAtMs).not.toBeNull();
    expect(grantFor(plan, STRANGER)?.familyProExpiresAtMs).toBeNull();
  });

  test('the boundary: an expiry exactly equal to now is used up', () => {
    // Pinned to match resolveEffectiveTier's `<=`. The two must agree or a
    // member is entitled for one tick after the owner is not.
    const plan = livePlan({ownerExpiresAtMs: NOW});
    expect(plan.every((g) => g.familyProExpiresAtMs === null)).toBe(true);
  });
});

describe('planFamilyFanOut — a member who has left', () => {
  test('🔴 a removed member is REVOKED explicitly, not omitted', () => {
    // An omitted member is a member whose entitlement never changes. The whole
    // dated-field design bounds that failure; it does not make it acceptable.
    const plan = planFamilyFanOut({
      family: familyOf([OWNER, KID]),
      ownerExpiresAtMs: NOW + 30 * 24 * HOUR,
      ownerHasFamilySubscription: true,
      nowMs: NOW,
      previousMemberUids: [OTHER_KID],
    });

    expect(plan.map((g) => g.uid).sort()).toEqual([OWNER, KID, OTHER_KID].sort());
    expect(grantFor(plan, OTHER_KID)?.familyProExpiresAtMs).toBeNull();
  });

  test('someone who is both a current and a previous member is granted, once', () => {
    // Rejoining is a real sequence, and a plan containing the same uid twice
    // with contradictory values would apply in whichever order the caller
    // happened to iterate.
    const plan = planFamilyFanOut({
      family: familyOf([OWNER, KID]),
      ownerExpiresAtMs: NOW + 30 * 24 * HOUR,
      ownerHasFamilySubscription: true,
      nowMs: NOW,
      previousMemberUids: [KID],
    });

    expect(plan.filter((g) => g.uid === KID)).toHaveLength(1);
    expect(grantFor(plan, KID)?.familyProExpiresAtMs).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: W2-79 — the fan-out finally has a caller, and the falsifier changed it
// ---------------------------------------------------------------------------
//
// W2-76 left the residual: a mid-period REFUND moves the owner's expiry
// BACKWARDS and a copy made yesterday does not know. `planFamilyFanOutForEffect`
// is the decision half of the caller that closes it.
//
// KEY: THE BRIEF ASKED WHETHER REFUND IS THE ONLY BACKWARDS MOVER. IT IS NOT.
// `effectOf` collapses REFUND, REVOKE, EXPIRED and GRACE_PERIOD_EXPIRED into
// one `revoke` effect, so this keys off the EFFECT rather than the type — which
// also means a type added to REVOKING_TYPES tomorrow is covered without anyone
// remembering. Both facts are asserted below rather than described.
import {FAMILY_PRODUCT_ID, planFamilyFanOutForEffect} from '../family';
import {effectOf} from '../appStoreNotifications';
import type {SubscriptionEffect} from '../appStoreNotifications';

describe('planFamilyFanOutForEffect — a refund revokes every member', () => {
  const FAM = familyOf([OWNER, KID]);
  const revoke: SubscriptionEffect = {
    kind: 'revoke',
    productId: FAMILY_PRODUCT_ID,
    endedAtMs: NOW,
    reason: 'REFUND',
  };

  test('🔴 THE RESIDUAL, CLOSED: a refund revokes the whole family', () => {
    const grants = planFamilyFanOutForEffect({family: FAM, effect: revoke, nowMs: NOW});
    expect(grants).toHaveLength(2);
    expect(grants.every((g) => g.familyProExpiresAtMs === null)).toBe(true);
    expect(grants.map((g) => g.uid).sort()).toEqual([OWNER, KID].sort());
  });

  test('the OWNER is revoked too, not just the members they paid for', () => {
    const grants = planFamilyFanOutForEffect({family: FAM, effect: revoke, nowMs: NOW});
    expect(grants.find((g) => g.uid === OWNER)?.familyProExpiresAtMs).toBeNull();
  });

  test('🔴 an INVALID family still revokes — refusing would strand the grant', () => {
    // planFamilyFanOut validates only for a GRANT, deliberately. A malformed
    // roster is not a reason to leave a paid-back entitlement in place.
    const broken: FamilyDoc = {
      ownerUid: 'uid-ghost',
      memberUids: [OWNER, KID],
      createdAtMs: NOW,
    };
    const grants = planFamilyFanOutForEffect({family: broken, effect: revoke, nowMs: NOW});
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => g.familyProExpiresAtMs === null)).toBe(true);
  });
});

describe('🔴 CONTROL — a normal renewal does not revoke', () => {
  // Without this, "revokes on refund" and "revokes on any notification" are the
  // same test.
  test('an entitling effect GRANTS rather than revoking', () => {
    const entitle: SubscriptionEffect = {
      kind: 'entitle',
      tier: 'pro',
      productId: FAMILY_PRODUCT_ID,
      expiresAtMs: NOW + 30 * 24 * HOUR,
    };
    const grants = planFamilyFanOutForEffect({
      family: familyOf([OWNER, KID]),
      effect: entitle,
      nowMs: NOW,
    });
    expect(grants).toHaveLength(2);
    expect(grants.every((g) => g.familyProExpiresAtMs === NOW + 30 * 24 * HOUR)).toBe(true);
  });

  test('an IGNORE effect writes nothing at all', () => {
    // An empty array, not a list of unchanged grants — so a caller that writes
    // every returned grant unconditionally still touches nothing.
    const ignore: SubscriptionEffect = {kind: 'ignore', reason: 'DID_FAIL_TO_RENEW'};
    expect(
      planFamilyFanOutForEffect({family: familyOf([OWNER, KID]), effect: ignore, nowMs: NOW}),
    ).toEqual([]);
  });
});

describe('🔴 CONTROL — only the FAMILY product touches a family', () => {
  // Sharper than "a different family": these are two subscriptions belonging to
  // one person. A refund of their personal Pro must not revoke the family they
  // pay separately for, and a renewal of it must not create a grant.
  const FAM = familyOf([OWNER, KID]);

  test('a refund of the owner\'s PERSONAL pro writes nothing', () => {
    const proRefund: SubscriptionEffect = {
      kind: 'revoke',
      productId: 'sub_pro_monthly',
      endedAtMs: NOW,
      reason: 'REFUND',
    };
    expect(planFamilyFanOutForEffect({family: FAM, effect: proRefund, nowMs: NOW})).toEqual([]);
  });

  test('a renewal of the owner\'s PERSONAL pro grants no family pro', () => {
    const proRenew: SubscriptionEffect = {
      kind: 'entitle',
      tier: 'pro',
      productId: 'sub_pro_annual',
      expiresAtMs: NOW + 365 * 24 * HOUR,
    };
    expect(planFamilyFanOutForEffect({family: FAM, effect: proRenew, nowMs: NOW})).toEqual([]);
  });

  test('🔴 and the SAME effect on the family product DOES write', () => {
    // The inverse control. Without it, returning [] for everything would pass
    // both tests above and the feature would be inert.
    const familyRefund: SubscriptionEffect = {
      kind: 'revoke',
      productId: FAMILY_PRODUCT_ID,
      endedAtMs: NOW,
      reason: 'REFUND',
    };
    expect(
      planFamilyFanOutForEffect({family: FAM, effect: familyRefund, nowMs: NOW}),
    ).toHaveLength(2);
  });
});

describe('🔴 CONTROL — a member of a DIFFERENT family is untouched', () => {
  test('the plan names only the passed family\'s members', () => {
    const ours = familyOf([OWNER, KID]);
    const theirs = familyOf(['uid-other-owner', 'uid-other-kid'], 'uid-other-owner');
    const effect: SubscriptionEffect = {
      kind: 'revoke',
      productId: FAMILY_PRODUCT_ID,
      endedAtMs: NOW,
      reason: 'REFUND',
    };

    const ourGrants = planFamilyFanOutForEffect({family: ours, effect, nowMs: NOW});
    const theirUids = planFamilyFanOutForEffect({family: theirs, effect, nowMs: NOW})
      .map((g) => g.uid);

    for (const g of ourGrants) expect(theirUids).not.toContain(g.uid);
    expect(ourGrants.map((g) => g.uid).sort()).toEqual([OWNER, KID].sort());
  });
});

describe('🔑 it is keyed off the EFFECT, so every revoking type is covered', () => {
  // The falsifier, asserted through the REAL effectOf rather than restated. If
  // a type is ever moved in or out of REVOKING_TYPES, this follows it.
  const notificationOf = (notificationType: string) =>
    ({
      notificationUUID: `uuid-${notificationType}`,
      notificationType,
      subtype: null,
      signedDateMs: NOW,
      transaction: {
        productId: FAMILY_PRODUCT_ID,
        expiresDateMs: NOW + 30 * 24 * HOUR,
        revocationDateMs: NOW,
        originalTransactionId: 'otx-1',
        transactionId: 'tx-1',
      },
    }) as Parameters<typeof effectOf>[0];

  test.each(['REFUND', 'REVOKE', 'EXPIRED', 'GRACE_PERIOD_EXPIRED'])(
    '%s revokes the family, not just REFUND',
    (notificationType) => {
      const effect = effectOf(notificationOf(notificationType));

      expect(effect.kind).toBe('revoke');
      const grants = planFamilyFanOutForEffect({
        family: familyOf([OWNER, KID]),
        effect,
        nowMs: NOW,
      });
      expect(grants).toHaveLength(2);
      expect(grants.every((g) => g.familyProExpiresAtMs === null)).toBe(true);
    },
  );

  test('🔴 DID_FAIL_TO_RENEW does NOT revoke — a failed rebill is not an ending', () => {
    // The control for the four above. Apple is still trying to charge; cutting
    // the family off here would be the same defect the owner path avoids.
    const effect = effectOf(notificationOf('DID_FAIL_TO_RENEW'));

    expect(effect.kind).toBe('ignore');
    expect(
      planFamilyFanOutForEffect({family: familyOf([OWNER, KID]), effect, nowMs: NOW}),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: W2-82 — planFamilyCreation, and the gate that the obvious call gets wrong
// ---------------------------------------------------------------------------
//
// Two failures are asserted here and neither is a validation error:
//
//   1. AN EMPTY SHELL. A member of someone else's family reads as `pro` via the
//      copied `familyProExpiresAt`, so gating on `resolveEffectiveTier` would
//      let them create a family that can never grant anybody anything. The
//      control below IS that person, and it must be refused.
//   2. A SECOND FAMILY. `ownedFamilies` reads `.limit(1)` against an invariant
//      nothing enforced until this callable.
//   3. CRITICAL: A PERSONAL PRO SUBSCRIPTION (W2-177). Both paid products map to the
//      tier `pro`, so the tier check cannot see the difference and the gate
//      reads the PRODUCT as well. This block used to assert the opposite —
//      see `a personal Pro subscription cannot fund a family`, which is the
//      same test with its expectation reversed by Brendan's 2026-09-04 ruling.
//
// WARNING: And the control that keeps both honest: an ordinary paying subscriber with
// no family must SUCCEED. Without it, `return {ok: false}` passes every test
// above and the feature is inert in the way #389's tier table was.

import {
  FAMILY_CREATE_REFUSALS,
  planFamilyCreation,
} from '../family';
import {resolveEffectiveTier, resolveOwnPaidTier} from '../taskRewards';

describe('🔴 W2-82 planFamilyCreation — entitlement', () => {
  const NOW = 1_760_000_000_000;

  test('🔴 CONTROL — a paying subscriber with no family CAN create one', () => {
    // The inverse control. A function that refused everything would satisfy
    // every other test in this block.
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'pro',
      ownProductId: FAMILY_PRODUCT_ID,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.family.ownerUid).toBe(OWNER);
    expect(plan.family.createdAtMs).toBe(NOW);
  });

  test('🔑 the owner is a member from the first instant', () => {
    // FamilyDoc requires it and familyInvalidReason returns 'owner-not-a-member'
    // otherwise, so a family created without this is invalid on arrival and
    // every fan-out fails closed against it.
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'pro',
      ownProductId: FAMILY_PRODUCT_ID,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.family.memberUids).toEqual([OWNER]);
  });

  test('a free account cannot create a family', () => {
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'free',
      // A free account has no product. Both reasons to refuse are present and
      // the TIER one must win — see the ordering note in `planFamilyCreation`.
      ownProductId: undefined,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('not-entitled');
    expect(FAMILY_CREATE_REFUSALS[plan.refusal].code).toBe('failed-precondition');
  });
});

describe('🔴 W2-82 THE EMPTY SHELL — the wrong resolver admits the case it rejects', () => {
  const NOW = 1_760_000_000_000;

  // Bob: no subscription of his own, but a live family grant copied from the
  // owner of the family he is IN.
  const BOB_DOC = {
    subscriptionTier: 'free',
    familyProExpiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
  };

  test('🔴 the two resolvers DISAGREE about Bob, and that is the whole point', () => {
    // If this ever stops being true the gate below is testing nothing, so the
    // disagreement is asserted directly rather than assumed.
    expect(resolveEffectiveTier(BOB_DOC, NOW)).toBe('pro');
    expect(resolveOwnPaidTier(BOB_DOC, NOW)).toBe('free');
  });

  test('🔴 Bob is REFUSED — a member of another family cannot found an empty one', () => {
    const plan = planFamilyCreation({
      ownerUid: 'uid-bob',
      ownPaidTier: resolveOwnPaidTier(BOB_DOC, NOW),
      // Bob pays for nothing, so he holds no product either.
      ownProductId: undefined,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('not-entitled');
  });

  test('📌 and the same Bob WOULD have been allowed by the obvious call', () => {
    // The counterfactual, asserted rather than described: this is what the
    // codebase would have shipped had the gate read the effective tier. It
    // documents the defect by constructing it.
    const wrong = planFamilyCreation({
      ownerUid: 'uid-bob',
      ownPaidTier: resolveEffectiveTier(BOB_DOC, NOW),
      // KEY: HELD AT THE ADMITTING VALUE ON PURPOSE. This test isolates ONE
      // variable — which resolver feeds `ownPaidTier` — so every other input
      // must be the one that would pass. Passing Bob's real (absent) product
      // here would refuse for the W2-177 reason and the counterfactual would
      // go green while proving nothing about the resolver.
      ownProductId: FAMILY_PRODUCT_ID,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
    });
    expect(wrong.ok).toBe(true);
  });

  // CRITICAL: REVERSED BY BRENDAN'S RULING, 2026-09-04 (W2-177). This test asserted
  // `.ok === true` and carried the reasoning for it: "Family is a SOURCE of pro,
  // not a tier above it (W2-76), so requiring the family product specifically
  // would make an existing subscriber cancel and rebuy to invite their
  // household." That cost was weighed and accepted — Family at 12.99 is not
  // defensible against Pro at 5.99 if Pro creates families too — and the
  // expectation is now the opposite. Kept as one inverted test rather than
  // deleted and rewritten, so the reversal is visible in the diff.
  test('🔴 a personal Pro subscription CANNOT fund a family', () => {
    const personal = {
      subscriptionTier: 'pro',
      subscriptionProductId: 'sub_pro_monthly',
      subscriptionExpiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
    };
    // KEY: THE ASSERTION THAT STOPS THIS BEING THE FREE-ACCOUNT TEST AGAIN. This
    // owner IS paying and IS on a paid tier: they clear the tier gate in full,
    // so the refusal below can only come from the product.
    expect(resolveOwnPaidTier(personal, NOW)).toBe('pro');
    expect(personal.subscriptionProductId).not.toBe(FAMILY_PRODUCT_ID);

    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: resolveOwnPaidTier(personal, NOW),
      ownProductId: personal.subscriptionProductId,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    // Not `not-entitled`: this person is entitled to Pro, just not to a family.
    expect(plan.refusal).toBe('needs-family-subscription');
    expect(FAMILY_CREATE_REFUSALS[plan.refusal].code).toBe('failed-precondition');
  });

  test('🔴 CONTROL — the SAME owner on the family product CAN', () => {
    // The inverse of the case above, differing in the product alone. Without
    // it, a gate that refused everything would satisfy the test above.
    const family = {
      subscriptionTier: 'pro',
      subscriptionProductId: FAMILY_PRODUCT_ID,
      subscriptionExpiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
    };
    expect(
      planFamilyCreation({
        ownerUid: OWNER,
        ownPaidTier: resolveOwnPaidTier(family, NOW),
        ownProductId: family.subscriptionProductId,
        alreadyOwnsAFamily: false,
        nowMs: NOW,
      }).ok,
    ).toBe(true);
  });

  test('🔴 a PROMO-granted Pro cannot fund a family either', () => {
    // `claimRetentionPromo` writes the tier and deliberately NO product id —
    // "there is no Apple product behind this grant". Such an account therefore
    // reaches the gate paying, on a paid tier, holding nothing, and is refused.
    // Asserted rather than left implicit because it is a real cohort and a NEW
    // refusal for them: surfaced in the W2-177 return, not decided silently.
    const promo = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: NOW + 30 * 24 * 60 * 60 * 1000,
    };
    expect(resolveOwnPaidTier(promo, NOW)).toBe('pro');
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: resolveOwnPaidTier(promo, NOW),
      ownProductId: undefined,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('needs-family-subscription');
  });

  test('an EXPIRED subscription cannot found a family', () => {
    const expired = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: NOW - 1,
    };
    expect(resolveOwnPaidTier(expired, NOW)).toBe('free');
    expect(
      planFamilyCreation({
        ownerUid: OWNER,
        ownPaidTier: resolveOwnPaidTier(expired, NOW),
        // Even holding the right product: a lapsed subscription is not one.
        ownProductId: FAMILY_PRODUCT_ID,
        alreadyOwnsAFamily: false,
        nowMs: NOW,
      }).ok,
    ).toBe(false);
  });
});

describe('🔴 W2-82 SINGLE OWNERSHIP — the invariant .limit(1) already assumed', () => {
  const NOW = 1_760_000_000_000;

  test('🔴 a SECOND create by the same owner is refused', () => {
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'pro',
      ownProductId: FAMILY_PRODUCT_ID,
      alreadyOwnsAFamily: true,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('already-owns-a-family');
    expect(FAMILY_CREATE_REFUSALS[plan.refusal].code).toBe('already-exists');
  });

  test('ownership is checked BEFORE entitlement, so the refusal is the honest one', () => {
    // A lapsed owner who already has a family should be told they have one,
    // not that they need to subscribe — the second is true but misleading, and
    // a client rendering it would prompt a purchase that changes nothing.
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'free',
      ownProductId: undefined,
      alreadyOwnsAFamily: true,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('already-owns-a-family');
  });
});

describe('📌 W2-82 FAMILY_CAP is 5 INCLUDING the owner, and is not HOUSEMATE_CAP', () => {
  test('a new family holds one of the five seats', () => {
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'pro',
      ownProductId: FAMILY_PRODUCT_ID,
      alreadyOwnsAFamily: false,
      nowMs: 1,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // Four other people, not five. Spelled out because the alternative
    // reading costs a whole seat and would surface only to a family that
    // could not add its last member.
    expect(FAMILY_CAP - plan.family.memberUids.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: W2-83 — planFamilyJoin
// ---------------------------------------------------------------------------
//
// The join is gated by an INVITE, not by a family id. `joinFamily(familyId)`
// would let anyone who learns an id collect Pro, since the fan-out copies
// `familyProExpiresAt` to every member — and a document id is not a secret.
//
// WARNING: The double-pay flag is the piece most likely to rot into decoration, so it
// has a NEGATIVE control: it must be FALSE for a joiner with no subscription of
// their own. A flag that is always true is not a warning, it is a banner.

import {
  FAMILY_INVITE_TTL_SECONDS,
  FAMILY_JOIN_REFUSALS,
  planFamilyJoin,
} from '../family';

describe('🔴 W2-83 planFamilyJoin', () => {
  const NOW = 1_760_000_000_000;
  const FAMILY_ID = 'fam-ours';
  const NOT_EXPIRED = NOW + FAMILY_INVITE_TTL_SECONDS * 1000;
  const JOINER = 'uid-joiner';

  const join = (over: Record<string, unknown> = {}) =>
    planFamilyJoin({
      family: familyOf([OWNER, KID]),
      familyId: FAMILY_ID,
      joinerUid: JOINER,
      joinerOwnPaidTier: 'free',
      joinerCurrentFamilyId: null,
      inviteExpiresAtMs: NOT_EXPIRED,
      nowMs: NOW,
      ...over,
    } as Parameters<typeof planFamilyJoin>[0]);

  test('🔴 CONTROL — an ordinary join succeeds and appends the joiner', () => {
    const plan = join();
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.memberUids).toEqual([OWNER, KID, JOINER]);
  });

  test('🔴 the cap is enforced AT THE JOIN, counting the owner', () => {
    // FAMILY_CAP is 5 TOTAL, so a family of five is full and the sixth person
    // is refused. A cap checked only where the document is born is not a cap.
    const full = familyOf([OWNER, KID, 'uid-c', 'uid-d', 'uid-e']);
    expect(full.memberUids).toHaveLength(FAMILY_CAP);
    const plan = join({family: full});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('family-full');
    expect(FAMILY_JOIN_REFUSALS[plan.refusal].code).toBe('resource-exhausted');
  });

  test('a family one short of the cap still accepts one more', () => {
    // The boundary from the other side: without this, an off-by-one that
    // refused at FAMILY_CAP - 1 would pass the test above.
    const plan = join({family: familyOf([OWNER, KID, 'uid-c', 'uid-d'])});
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.memberUids).toHaveLength(FAMILY_CAP);
  });

  test('🔴 a joiner already in ANOTHER family is refused', () => {
    const plan = join({joinerCurrentFamilyId: 'fam-theirs'});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('already-in-another-family');
  });

  test('re-redeeming into the SAME family is not "another family"', () => {
    // A stamped joiner whose familyId already equals this one must fall through
    // to the membership check, not be refused as a defector.
    const plan = join({
      joinerCurrentFamilyId: FAMILY_ID,
      family: familyOf([OWNER, KID, JOINER]),
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('already-a-member');
  });

  test('🔑 an existing member re-redeeming does not consume a second seat', () => {
    const plan = join({family: familyOf([OWNER, JOINER])});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('already-a-member');
  });

  test('🔑 the last member of a FULL family can still re-redeem', () => {
    // Membership is checked BEFORE the cap on purpose: a double tap from
    // someone already in a full family must say "you are already in" rather
    // than "the family is full", which would read as their join having failed.
    const plan = join({family: familyOf([OWNER, 'uid-c', 'uid-d', JOINER])});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('already-a-member');
  });

  test('an expired invite is refused, and before anything about the family', () => {
    const plan = join({nowMs: NOT_EXPIRED + 1});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('invite-expired');
  });

  test('an invalid family fails closed', () => {
    const broken: FamilyDoc = {
      ownerUid: 'uid-ghost',
      memberUids: [OWNER, KID],
      createdAtMs: NOW,
    };
    const plan = join({family: broken});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('invalid-family');
  });
});

describe('🔴 W2-83 the double-pay warning', () => {
  const NOW = 1_760_000_000_000;
  const JOINER = 'uid-joiner';
  const base = {
    family: familyOf([OWNER, KID]),
    familyId: 'fam-ours',
    joinerUid: JOINER,
    joinerCurrentFamilyId: null,
    inviteExpiresAtMs: NOW + 60_000,
    nowMs: NOW,
  };

  test('🔴 set when the joiner has their OWN paid subscription', () => {
    const plan = planFamilyJoin({...base, joinerOwnPaidTier: 'pro'});
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.alreadyPayingSeparately).toBe(true);
  });

  test('🔴 NEGATIVE CONTROL — NOT set when the joiner pays for nothing', () => {
    // Without this the flag could be hard-coded true and every test above would
    // pass. A warning that always fires is a banner, and a banner gets ignored
    // by exactly the person who needed to read it.
    const plan = planFamilyJoin({...base, joinerOwnPaidTier: 'free'});
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.alreadyPayingSeparately).toBe(false);
  });

  test('🔴 the JOIN STILL SUCCEEDS while paying twice — it warns, it does not block', () => {
    // We cannot cancel StoreKit from a callable. Refusing the join would strand
    // someone between two subscriptions; the honest behaviour is to let them in
    // and tell them.
    const plan = planFamilyJoin({...base, joinerOwnPaidTier: 'pro'});
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.memberUids).toContain(JOINER);
  });

  test('📌 and it is computed from OWN PAID, so a family grant does not trigger it', () => {
    // The createFamily trap from the other side: resolveEffectiveTier would be
    // `pro` for anyone already carrying a family grant, so the warning would
    // fire for people paying nothing at all. This asserts the parameter is the
    // own-paid one by feeding the value that resolver actually returns for such
    // a person — `free`.
    const carriesAGrantButPaysNothing = 'free';
    const plan = planFamilyJoin({
      ...base,
      joinerOwnPaidTier: carriesAGrantButPaysNothing,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.alreadyPayingSeparately).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: W2-84 — leaving, removing, disbanding
// ---------------------------------------------------------------------------
//
// The failure these exist to stop: `familyProExpiresAt` is a COPY of the
// owner's expiry, so a member who walks away keeps Pro until that clock runs
// out — up to a full billing period funded by someone they no longer share
// anything with. A free-Pro vector with a longer fuse than the invite one.
//
// WARNING: THE CROSS-FAMILY CONTROL SEEDS THE DECOY FIRST, per #390: a fixture where
// the right answer happens to come first cannot distinguish the rule from the
// ordering, and that is exactly how a scoping bug survived a green suite.

import {
  FAMILY_DEPARTURE_REFUSALS,
  planFamilyDeparture,
  planFamilyDisband,
} from '../family';

describe('🔴 W2-84 planFamilyDeparture — the grant is revoked', () => {
  const NOW = 1_760_000_000_000;
  const depart = (over: Record<string, unknown> = {}) =>
    planFamilyDeparture({
      family: familyOf([OWNER, KID]),
      actorUid: KID,
      targetUid: KID,
      nowMs: NOW,
      ...over,
    } as Parameters<typeof planFamilyDeparture>[0]);

  test('🔴 THE POINT: a leaver is REVOKED, not merely removed from the roster', () => {
    const plan = depart();
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.memberUids).toEqual([OWNER]);
    // Removing them from the roster without this leaves a copied expiry worth
    // up to a full billing period.
    expect(plan.revokedUids).toEqual([KID]);
  });

  test('🔑 the REMAINING members are not rewritten', () => {
    // The owner still pays, so their entitlement is unchanged. Touching it
    // would risk moving a correct value based on an expiry this call re-read.
    const plan = depart({family: familyOf([OWNER, KID, 'uid-c'])});
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.revokedUids).not.toContain(OWNER);
    expect(plan.revokedUids).not.toContain('uid-c');
    expect(plan.revokedUids).toEqual([KID]);
  });

  test('🔴 the OWNER cannot leave — and the refusal NAMES the alternative', () => {
    const plan = depart({actorUid: OWNER, targetUid: OWNER});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('owner-must-disband');
    expect(FAMILY_DEPARTURE_REFUSALS[plan.refusal].message).toMatch(/end it for everyone/);
  });

  test('📌 the INVARIANT that makes the owner check order moot', () => {
    // KEY: THIS REPLACED A TEST THAT ASSERTED NOTHING. The original pinned "the
    // owner is refused BEFORE the no-op branch" and passed in BOTH orders —
    // caught by mutating the order and watching the suite stay green.
    //
    // The real property is that an owner can never REACH the no-op branch:
    // isValidFamily refuses 'owner-not-a-member', so the owner is always in
    // memberUids. That invariant is what holds this up, so that is what is
    // pinned. If it ever weakens, the ordering becomes load-bearing and this
    // goes red first.
    // WARNING: AND THE FIRST VERSION OF THIS REPLACEMENT WAS ALSO VACUOUS. It used
    // `memberUids: [KID]` — one member — so isValidFamily returned false for
    // TOO FEW MEMBERS, not for the owner being absent, and it stayed green when
    // the owner check was mutated away. The roster below has enough members, so
    // owner-absence is the only thing left that can make it invalid.
    const family = familyOf([OWNER, KID]);
    expect(family.memberUids).toContain(family.ownerUid);

    const ownerAbsent = {...family, memberUids: [KID, 'uid-c']};
    expect(ownerAbsent.memberUids.length).toBeGreaterThanOrEqual(FAMILY_MIN_MEMBERS);
    expect(familyInvalidReason(ownerAbsent)).toBe('owner-not-a-member');
    expect(isValidFamily(ownerAbsent)).toBe(false);
  });

  test('🔴 a stranger cannot remove somebody', () => {
    const plan = depart({actorUid: 'uid-stranger', targetUid: KID});
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('not-authorised');
    expect(FAMILY_DEPARTURE_REFUSALS[plan.refusal].code).toBe('permission-denied');
  });

  test('🔴 a MEMBER cannot evict another member', () => {
    // Sharper than the stranger case: being inside the family is not authority
    // over the people in it. Only the owner, or yourself.
    const plan = depart({
      family: familyOf([OWNER, KID, 'uid-c']),
      actorUid: KID,
      targetUid: 'uid-c',
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('not-authorised');
  });

  test('the OWNER can remove a member', () => {
    const plan = depart({actorUid: OWNER, targetUid: KID});
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.revokedUids).toEqual([KID]);
  });

  test('🔴 authority is checked BEFORE existence, so a roster cannot be probed', () => {
    // A stranger asking about a uid that is not in the family must get the same
    // "not allowed" they get for one that is — otherwise the pair of answers
    // enumerates the roster.
    const inFamily = depart({actorUid: 'uid-stranger', targetUid: KID});
    const notInFamily = depart({actorUid: 'uid-stranger', targetUid: 'uid-nobody'});
    expect(inFamily).toEqual(notInFamily);
  });
});

describe('🔴 W2-84 leaving twice is idempotent, not an error', () => {
  const NOW = 1_760_000_000_000;

  test('🔴 leaving a family you are NOT in succeeds and writes nothing', () => {
    // An error here would say the FIRST attempt failed, and a client believing
    // that would retry forever or tell the user their departure did not work.
    const plan = planFamilyDeparture({
      family: familyOf([OWNER, KID]),
      actorUid: 'uid-gone',
      targetUid: 'uid-gone',
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.noop).toBe(true);
    expect(plan.revokedUids).toEqual([]);
    expect(plan.memberUids).toEqual([OWNER, KID]);
  });

  test('🔴 CONTROL — a REAL departure is NOT a no-op', () => {
    // Without this, `noop: true` unconditionally would pass the test above and
    // nothing would ever be revoked.
    const plan = planFamilyDeparture({
      family: familyOf([OWNER, KID]),
      actorUid: KID,
      targetUid: KID,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.noop).toBe(false);
    expect(plan.revokedUids).toEqual([KID]);
  });
});

describe('🔴 W2-84 planFamilyDisband — the owner ends it for everyone', () => {
  const NOW = 1_760_000_000_000;

  test('🔴 EVERY member is revoked, including the owner', () => {
    // The owner's own familyProExpiresAt must go too, or resolveEffectiveTier
    // answers `pro` from a family that no longer exists.
    const plan = planFamilyDisband({
      family: familyOf([OWNER, KID, 'uid-c']),
      actorUid: OWNER,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.revokedUids.sort()).toEqual([OWNER, KID, 'uid-c'].sort());
    expect(plan.dissolved).toBe(true);
    expect(plan.memberUids).toEqual([]);
  });

  test('🔴 a MEMBER cannot disband the family', () => {
    const plan = planFamilyDisband({
      family: familyOf([OWNER, KID]),
      actorUid: KID,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('not-the-owner');
  });

  test('a leave is NOT a dissolve — the two are distinguishable', () => {
    // Without this, `dissolved: true` on every plan would delete the family
    // whenever anybody left.
    const leave = planFamilyDeparture({
      family: familyOf([OWNER, KID]),
      actorUid: KID,
      targetUid: KID,
      nowMs: NOW,
    });
    expect(leave.ok).toBe(true);
    if (!leave.ok) return;
    expect(leave.dissolved).toBe(false);
  });
});

describe('🔴 W2-84 CONTROL — a DIFFERENT family is untouched', () => {
  const NOW = 1_760_000_000_000;

  // WARNING: THE DECOY IS BUILT FIRST AND ITS MEMBERS ARE DISJOINT, per #390. A
  // fixture where the right family happens to be examined first cannot tell the
  // rule from the ordering — that is precisely how a scoping bug survived a
  // green suite, and it cost a landed PR to find.
  const THEIRS = familyOf(['uid-other-owner', 'uid-other-kid'], 'uid-other-owner');
  const OURS = familyOf([OWNER, KID]);

  test('a departure names ONLY the passed family\'s members', () => {
    const plan = planFamilyDeparture({
      family: OURS,
      actorUid: KID,
      targetUid: KID,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    for (const uid of THEIRS.memberUids) {
      expect(plan.revokedUids).not.toContain(uid);
      expect(plan.memberUids).not.toContain(uid);
    }
  });

  test('🔴 a member of ANOTHER family cannot be removed through ours', () => {
    // The owner of our family has no authority over theirs — and the target is
    // not in our roster, so this must be a no-op rather than a revoke.
    const plan = planFamilyDeparture({
      family: OURS,
      actorUid: OWNER,
      targetUid: 'uid-other-kid',
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.noop).toBe(true);
    expect(plan.revokedUids).toEqual([]);
  });

  test('disbanding ours revokes nobody from theirs', () => {
    const plan = planFamilyDisband({family: OURS, actorUid: OWNER, nowMs: NOW});
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    for (const uid of THEIRS.memberUids) {
      expect(plan.revokedUids).not.toContain(uid);
    }
    expect(plan.revokedUids.sort()).toEqual([OWNER, KID].sort());
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: W2-86 — the state createFamily actually produces
// ---------------------------------------------------------------------------
//
// Every W2-83 fixture seeded `familyOf([OWNER, KID])` — a two-member roster —
// and that roster is only reachable AFTER a successful join. The join could not
// succeed, because `isValidFamily` includes `too-few-members` and createFamily
// writes ONE member. So the suite was green about a path that could never run.
//
// KEY: A FIXTURE ASSERTING A STATE THE SYSTEM CANNOT PRODUCE describes an
// intention rather than the code. Same class as a control that passes on seed
// order: green, specific, and about nothing.

describe('🔴 W2-86 a NEW family — one member, exactly as createFamily writes it', () => {
  const NOW = 1_760_000_000_000;

  /** Built by calling the real creator, never by hand — the point is that this
   *  is the shape the system produces, not the shape a test wishes for. */
  const newlyCreated = (): FamilyDoc => {
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'pro',
      ownProductId: FAMILY_PRODUCT_ID,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
    });
    if (!plan.ok) throw new Error('createFamily plan refused');
    return plan.family;
  };

  test('📌 it has ONE member and is NOT isValidFamily — both on purpose', () => {
    const family = newlyCreated();
    expect(family.memberUids).toEqual([OWNER]);
    expect(familyInvalidReason(family)).toBe('too-few-members');
    expect(isValidFamily(family)).toBe(false);
    // …and structurally sound, which is what the lifecycle operates on.
    expect(isStructurallySoundFamily(family)).toBe(true);
  });

  test('🔴 THE DEFECT: somebody can JOIN a newly created family', () => {
    const plan = planFamilyJoin({
      family: newlyCreated(),
      familyId: 'fam-ours',
      joinerUid: KID,
      joinerOwnPaidTier: 'free',
      joinerCurrentFamilyId: null,
      inviteExpiresAtMs: NOW + 45_000,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.memberUids).toEqual([OWNER, KID]);
  });

  test('🔴 THE DEFECT: the owner can DISBAND a family everybody left', () => {
    // A family reduced back to one member must still be endable. Otherwise the
    // owner is locked into paying for a family they cannot close.
    const plan = planFamilyDisband({
      family: newlyCreated(),
      actorUid: OWNER,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.revokedUids).toEqual([OWNER]);
    expect(plan.dissolved).toBe(true);
  });

  test('a genuinely broken family is STILL refused', () => {
    // The fix must not have turned the structural check off. An owner absent
    // from their own roster is not a lifecycle state, it is corruption.
    const broken: FamilyDoc = {
      ownerUid: 'uid-ghost',
      memberUids: [OWNER, KID],
      createdAtMs: NOW,
    };
    expect(isStructurallySoundFamily(broken)).toBe(false);
    const plan = planFamilyJoin({
      family: broken,
      familyId: 'fam-ours',
      joinerUid: 'uid-new',
      joinerOwnPaidTier: 'free',
      joinerCurrentFamilyId: null,
      inviteExpiresAtMs: NOW + 45_000,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(false);
  });

  test('🔑 the GRANTING rule is unchanged — a family of one entitles nobody', () => {
    // MIN_MEMBERS is a granting rule and stays one. "A family of one is a Pro
    // subscription with extra steps" is a correct reason not to entitle through
    // it, and a wrong reason to refuse the join that would make it two.
    const grants = planFamilyFanOut({
      family: newlyCreated(),
      ownerExpiresAtMs: NOW + 30 * 24 * HOUR,
      ownerHasFamilySubscription: true,
      nowMs: NOW,
    });
    expect(grants.every((g) => g.familyProExpiresAtMs === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: W2-87 — memberNames, the only readable source of a member's name
// ---------------------------------------------------------------------------
//
// The family page needs a name per member and had NO readable source for one:
// `publicProfiles/{uid}` grants `get` to the owner, to a friend edge, or when
// `isPublic == true` — which DEFAULTS FALSE. Family membership is not one of
// the conditions. Denormalised onto the family document, which already grants
// read to its own members, so one read returns the roster and the names.

import {memberMapFor} from '../family';

describe('🔴 W2-87 memberMapFor', () => {
  test('adds a name', () => {
    expect(memberMapFor({}, {add: {uid: 'a', name: 'Ada'}})).toEqual({a: 'Ada'});
  });

  test('🔴 an ABSENT name writes NO entry, not an empty string', () => {
    // A uid mapped to '' renders as a member with a blank name, which looks
    // like a bug in the page. No entry lets the reader pick its own fallback.
    expect(memberMapFor({}, {add: {uid: 'a', name: undefined}})).toEqual({});
    expect(memberMapFor({}, {add: {uid: 'a', name: ''}})).toEqual({});
  });

  test('🔴 keepOnly DROPS everyone no longer in the roster', () => {
    // A departed member's name lingering is readable by everyone still in the
    // family — a small leak about somebody who left, and stale by definition.
    expect(
      memberMapFor({a: 'Ada', b: 'Bo', c: 'Cy'}, {keepOnly: ['a', 'c']}),
    ).toEqual({a: 'Ada', c: 'Cy'});
  });

  test('🔴 CONTROL — without keepOnly, nothing is dropped', () => {
    // Otherwise a helper that always emptied the map would pass the test above.
    expect(memberMapFor({a: 'Ada', b: 'Bo'}, {})).toEqual({a: 'Ada', b: 'Bo'});
  });

  test('does not mutate the input', () => {
    const before = {a: 'Ada', b: 'Bo'};
    memberMapFor(before, {add: {uid: 'c', name: 'Cy'}, keepOnly: ['c']});
    expect(before).toEqual({a: 'Ada', b: 'Bo'});
  });

  test('undefined current is treated as empty', () => {
    expect(memberMapFor(undefined, {add: {uid: 'a', name: 'Ada'}})).toEqual({a: 'Ada'});
  });
});

describe('🔴 W2-87 names flow through every membership change', () => {
  const NOW = 1_760_000_000_000;

  test('create records the owner', () => {
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'pro',
      ownProductId: FAMILY_PRODUCT_ID,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
      ownerDisplayName: 'Ada',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.family.memberNames).toEqual({[OWNER]: 'Ada'});
  });

  test('a nameless owner still creates a family', () => {
    // The Auth record can genuinely have no displayName. Membership must not
    // depend on decoration.
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'pro',
      ownProductId: FAMILY_PRODUCT_ID,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.family.memberNames).toEqual({});
  });

  test('join ADDS the joiner and keeps the owner', () => {
    const plan = planFamilyJoin({
      family: {...familyOf([OWNER]), memberNames: {[OWNER]: 'Ada'}},
      familyId: 'fam-ours',
      joinerUid: KID,
      joinerOwnPaidTier: 'free',
      joinerCurrentFamilyId: null,
      inviteExpiresAtMs: NOW + 45_000,
      nowMs: NOW,
      joinerDisplayName: 'Bo',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.memberNames).toEqual({[OWNER]: 'Ada', [KID]: 'Bo'});
  });

  test('🔴 leaving DROPS the leaver\'s name', () => {
    const plan = planFamilyDeparture({
      family: {
        ...familyOf([OWNER, KID]),
        memberNames: {[OWNER]: 'Ada', [KID]: 'Bo'},
      },
      actorUid: KID,
      targetUid: KID,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.memberNames).toEqual({[OWNER]: 'Ada'});
    expect(Object.keys(plan.memberNames)).not.toContain(KID);
  });

  test('🔴 disbanding clears every name', () => {
    const plan = planFamilyDisband({
      family: {
        ...familyOf([OWNER, KID]),
        memberNames: {[OWNER]: 'Ada', [KID]: 'Bo'},
      },
      actorUid: OWNER,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.memberNames).toEqual({});
  });

  test('🔑 a name can never outlive the roster it belongs to', () => {
    // The invariant the whole helper exists for, asserted directly rather than
    // inferred from the three cases above: after ANY membership change, every
    // named uid is still a member.
    const plans = [
      planFamilyJoin({
        family: {...familyOf([OWNER]), memberNames: {[OWNER]: 'Ada', 'uid-ghost': 'Ghost'}},
        familyId: 'fam-ours',
        joinerUid: KID,
        joinerOwnPaidTier: 'free',
        joinerCurrentFamilyId: null,
        inviteExpiresAtMs: NOW + 45_000,
        nowMs: NOW,
        joinerDisplayName: 'Bo',
      }),
      planFamilyDeparture({
        family: {
          ...familyOf([OWNER, KID]),
          memberNames: {[OWNER]: 'Ada', [KID]: 'Bo', 'uid-ghost': 'Ghost'},
        },
        actorUid: KID,
        targetUid: KID,
        nowMs: NOW,
      }),
    ];
    for (const plan of plans) {
      expect(plan.ok).toBe(true);
      if (!plan.ok) continue;
      for (const uid of Object.keys(plan.memberNames)) {
        expect(plan.memberUids).toContain(uid);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: W2-88 part 2 — memberAvatars
// ---------------------------------------------------------------------------
//
// Ruled: a member's avatar is visible to their family. Denormalised for the
// same reason names are — publicProfiles denies the read — and stored as an
// **ID**, never a resolved asset path.

describe('🔴 W2-88 memberAvatars are IDS, not asset paths', () => {
  const NOW = 1_760_000_000_000;

  test('create records the owner\'s avatar id', () => {
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'pro',
      ownProductId: FAMILY_PRODUCT_ID,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
      ownerDisplayName: 'Ada',
      ownerAvatarId: 'fox',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.family.memberAvatars).toEqual({[OWNER]: 'fox'});
  });

  test('🔴 it stores the ID VERBATIM — no asset path is ever minted here', () => {
    // The server has no business knowing bundle paths. A resolved path would be
    // a second vocabulary, and a renamed asset would become a broken-image box
    // that nothing server-side could catch.
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'pro',
      ownProductId: FAMILY_PRODUCT_ID,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
      ownerAvatarId: 'fox',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    const stored = plan.family.memberAvatars![OWNER];
    expect(stored).toBe('fox');
    expect(stored).not.toContain('assets/');
    expect(stored).not.toContain('.webp');
  });

  test('a LEGACY url value passes through uninterpreted', () => {
    // avatarAssetFor matches on id OR url, so both resolve on the client. This
    // must not try to normalise one into the other.
    const legacy = 'https://firebasestorage.googleapis.com/v0/b/x/o/fox_avatar.webp?alt=media';
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'pro',
      ownProductId: FAMILY_PRODUCT_ID,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
      ownerAvatarId: legacy,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.family.memberAvatars![OWNER]).toBe(legacy);
  });

  test('a member who never chose one has NO entry', () => {
    const plan = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'pro',
      ownProductId: FAMILY_PRODUCT_ID,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.family.memberAvatars).toEqual({});
  });

  test('join adds the joiner\'s avatar and keeps the owner\'s', () => {
    const plan = planFamilyJoin({
      family: {
        ...familyOf([OWNER]),
        memberAvatars: {[OWNER]: 'fox'},
      },
      familyId: 'fam-ours',
      joinerUid: KID,
      joinerOwnPaidTier: 'free',
      joinerCurrentFamilyId: null,
      inviteExpiresAtMs: NOW + 45_000,
      nowMs: NOW,
      joinerAvatarId: 'duck',
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.memberAvatars).toEqual({[OWNER]: 'fox', [KID]: 'duck'});
  });

  test('🔴 leaving drops the leaver\'s avatar, exactly as it drops the name', () => {
    const plan = planFamilyDeparture({
      family: {
        ...familyOf([OWNER, KID]),
        memberNames: {[OWNER]: 'Ada', [KID]: 'Bo'},
        memberAvatars: {[OWNER]: 'fox', [KID]: 'duck'},
      },
      actorUid: KID,
      targetUid: KID,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.memberAvatars).toEqual({[OWNER]: 'fox'});
    expect(plan.memberNames).toEqual({[OWNER]: 'Ada'});
  });

  test('🔑 avatars obey the same outlive-the-roster invariant as names', () => {
    const plan = planFamilyDeparture({
      family: {
        ...familyOf([OWNER, KID]),
        memberAvatars: {[OWNER]: 'fox', [KID]: 'duck', 'uid-ghost': 'bear'},
      },
      actorUid: KID,
      targetUid: KID,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    for (const uid of Object.keys(plan.memberAvatars)) {
      expect(plan.memberUids).toContain(uid);
    }
  });

  test('disbanding clears avatars too', () => {
    const plan = planFamilyDisband({
      family: {...familyOf([OWNER, KID]), memberAvatars: {[OWNER]: 'fox'}},
      actorUid: OWNER,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.memberAvatars).toEqual({});
  });
});


// ---------------------------------------------------------------------------
// W2-118 — the shared bin day
// ---------------------------------------------------------------------------
//
// CRITICAL: THE BUG THESE CLOSE. `#490` keys the shared trash-day record by bin DATE
// (`families/{id}/trashDay/YYYY-MM-DD`), and every member derived that date
// from their OWN SharedPreferences weekday. A family that disagreed by one day
// wrote and watched different documents: one member takes the bins out and for
// everyone else nothing happens, silently, with nothing reporting it.
//
// KEY: WHICH MUTATION TURNS ONLY THESE RED — and it is a FIXTURE mutation, which
// is the whole point. Making KID the owner in the not-the-owner fixture
// (`familyOf([OWNER, KID], KID)`) reddens exactly the refusal test and leaves
// every pre-existing test in this file green. The obvious CODE mutation —
// deleting the ownership check — reddens it too, but so would a membership
// check, and the two are not the same guarantee.

describe('🔴 W2-118 planFamilyBinDay — one value, set by the owner', () => {
  test('the owner sets the family bin day', () => {
    const plan = planFamilyBinDay({
      family: familyOf([OWNER, KID]),
      actorUid: OWNER,
      binWeekday: 2,
    });

    expect(plan).toEqual({ok: true, binWeekday: 2});
  });

  test('Monday and Sunday are both inside the range', () => {
    for (const weekday of [1, 7]) {
      expect(
        planFamilyBinDay({
          family: familyOf([OWNER, KID]),
          actorUid: OWNER,
          binWeekday: weekday,
        }),
      ).toEqual({ok: true, binWeekday: weekday});
    }
  });
});

describe('🔴 W2-118 the refusal is about OWNERSHIP, and the fixture is what proves it', () => {
  // WARNING: KID IS A REAL MEMBER HERE, AND THAT IS THE ENTIRE VALUE OF THIS TEST.
  // W2-113 shipped four denial assertions that stayed green against a fixture
  // where nobody had ever joined — a refusal for the wrong reason reads
  // identically to a refusal for the right one. If KID were absent from
  // `memberUids`, this would pass just as well against an implementation that
  // checked membership and never looked at `ownerUid`.
  test('a member who is not the owner is refused', () => {
    const family = familyOf([OWNER, KID]);
    expect(family.memberUids).toContain(KID);

    expect(
      planFamilyBinDay({family, actorUid: KID, binWeekday: 3}),
    ).toEqual({ok: false, refusal: 'not-the-owner'});
  });

  // KEY: THE CONTROL THAT MAKES THE ABOVE MEAN "OWNERSHIP". A stranger who is in
  // no roster at all must be refused for the SAME reason — if this produced a
  // different refusal, the check above would be reading membership.
  test('CONTROL: a stranger is refused for the same reason, not a different one', () => {
    expect(
      planFamilyBinDay({
        family: familyOf([OWNER, KID]),
        actorUid: STRANGER,
        binWeekday: 3,
      }),
    ).toEqual({ok: false, refusal: 'not-the-owner'});
  });

  // CRITICAL: THE PROBE GUARD. `planChoreAssignment` checks authority before anything
  // else so a refusal cannot vary by input; a non-owner who could tell
  // `invalid-weekday` from `not-the-owner` learns whether their guess was
  // well-formed. Swapping the two checks in `planFamilyBinDay` turns ONLY this
  // test red — the refusal tests above pass either way, because their weekday
  // is valid.
  test('authority is decided BEFORE the value, so a non-owner cannot probe', () => {
    expect(
      planFamilyBinDay({
        family: familyOf([OWNER, KID]),
        actorUid: KID,
        binWeekday: 99,
      }),
    ).toEqual({ok: false, refusal: 'not-the-owner'});
  });
});

describe('🔴 W2-118 a weekday that would produce a date nobody reaches', () => {
  // 0 and 8 are the obvious rejects. 2.5, NaN and Infinity are the ones that
  // survive a bare range check and yield a bin date that never arrives —
  // indistinguishable at the client from the bug this brief closes.
  test.each([
    ['zero', 0],
    ['eight', 8],
    ['negative', -1],
    ['fractional', 2.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('%s is refused', (_label, weekday) => {
    expect(
      planFamilyBinDay({
        family: familyOf([OWNER, KID]),
        actorUid: OWNER,
        binWeekday: weekday,
      }),
    ).toEqual({ok: false, refusal: 'invalid-weekday'});
  });

  test.each([
    ['a numeric string', '3'],
    ['null', null],
    ['undefined', undefined],
    ['an object', {weekday: 3}],
  ])('%s is refused — the field is a number, not a coercion', (_label, weekday) => {
    expect(
      planFamilyBinDay({
        family: familyOf([OWNER, KID]),
        actorUid: OWNER,
        binWeekday: weekday,
      }),
    ).toEqual({ok: false, refusal: 'invalid-weekday'});
  });
});

describe('📌 W2-118 every refusal has text and a code', () => {
  test('the table covers both refusals and nothing else', () => {
    expect(Object.keys(FAMILY_BIN_DAY_REFUSALS).sort()).toEqual([
      'invalid-weekday',
      'not-the-owner',
    ]);
    expect(FAMILY_BIN_DAY_REFUSALS['not-the-owner'].code).toBe('permission-denied');
    expect(FAMILY_BIN_DAY_REFUSALS['invalid-weekday'].code).toBe('invalid-argument');
  });
});


// ---------------------------------------------------------------------------
// W2-120 — the family is born already agreeing
// ---------------------------------------------------------------------------
//
// KEY: THE DIFFERENCE THIS CLOSES. W2-118 gave the owner a way to set one shared
// bin day. Until they used it a NEW family had none, so every member fell back
// to their own device weekday — meaning `#490`'s split-document bug was the
// DEFAULT STATE of every family for as long as nobody opened the setting.
// "The disagreement cannot occur" beats "the disagreement is fixable".
//
// CRITICAL: THE DECISIVE TEST HERE IS THE ABSENCE ONE, NOT THE PRESENCE ONE. Seeding
// a value that was supplied is the easy half and almost any implementation
// gets it right. The half that is easy to get wrong — and impossible to notice
// afterwards — is inventing a default when the founder has none: a family
// silently assigned Monday LOOKS finished and is wrong, and nobody audits a
// plausible value.

const BIN_TUESDAY = 2;

describe('🔴 W2-120 planFamilyCreation seeds the founder\'s bin day', () => {
  const entitled = {
    ownerUid: OWNER,
    ownPaidTier: 'pro',
    ownProductId: FAMILY_PRODUCT_ID,
    alreadyOwnsAFamily: false,
    nowMs: NOW,
  };

  test('the founder\'s weekday lands on the family document', () => {
    const plan = planFamilyCreation({...entitled, ownerBinWeekday: BIN_TUESDAY});

    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('unreachable');
    expect(plan.family.binWeekday).toBe(BIN_TUESDAY);
  });

  // CRITICAL: THE CONTROL THAT MATTERS, AND THE MEASURED RESULT RATHER THAN THE TIDY
  // CLAIM. Mutating the planner to invent a default —
  // `binWeekday: isValidBinWeekday(x) ? x : 1` — turns 15 tests red across
  // this file and leaves all 58 OTHER suites green. It is not "only this test"
  // and saying so would be false: every assertion about ABSENCE fails,
  // including the drop-invalid cases and the shared-validator table.
  //
  // KEY: WHAT THE MUTATION ACTUALLY PROVES IS THE SPLIT. Under it, `the founder's
  // weekday lands on the family document` and `seeding does not disturb what
  // creation already stamped` BOTH STAY GREEN — measured, not assumed. A suite
  // containing only the presence half would have shipped the invented default
  // and reported success. That is why the absence half is the evidence.
  test('🔴 no weekday means NO FIELD — the server never invents one', () => {
    const plan = planFamilyCreation(entitled);

    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('unreachable');
    // Not null, not 1, not present-and-undefined: ABSENT. Firestore stores an
    // explicit undefined as a field, and a reader cannot tell that from a
    // value the founder chose.
    expect('binWeekday' in plan.family).toBe(false);
  });

  test.each([
    ['zero', 0],
    ['eight', 8],
    ['fractional', 2.5],
    ['NaN', Number.NaN],
    ['a numeric string', '2'],
    ['null', null],
  ])(
    '%s is dropped and the family is still created — a bad weekday must not block a family',
    (_label, weekday) => {
      const plan = planFamilyCreation({...entitled, ownerBinWeekday: weekday});

      // Creating the family is the important act; the bin day is recoverable
      // afterwards by the owner. Refusing here would trade a cosmetic defect
      // for a broken feature.
      expect(plan.ok).toBe(true);
      if (!plan.ok) throw new Error('unreachable');
      expect('binWeekday' in plan.family).toBe(false);
    },
  );

  test('seeding does not disturb what creation already stamped', () => {
    const plan = planFamilyCreation({
      ...entitled,
      ownerDisplayName: 'Owner Parent',
      ownerBinWeekday: BIN_TUESDAY,
    });

    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('unreachable');
    expect(plan.family.ownerUid).toBe(OWNER);
    expect(plan.family.memberUids).toEqual([OWNER]);
    expect(plan.family.memberNames).toEqual({[OWNER]: 'Owner Parent'});
    expect(plan.family.createdAtMs).toBe(NOW);
  });
});

describe('🔑 W2-120 ONE validator, so the two writers cannot drift', () => {
  // `planFamilyBinDay` (the owner changing it) and `planFamilyCreation` (the
  // family being born) must agree on what a legal weekday is. Two copies of
  // the range check would agree on the day they were written and drift the day
  // one of them learns about something the other does not — and the symptom is
  // a stored weekday one path accepts and the other rejects.
  //
  // KEY: PROVEN BY MUTATION, NOT BY INSPECTION: widening `isValidBinWeekday` to
  // `value >= 0` reddens exactly three tests — the setter's zero case (W2-118),
  // the creator's zero case, and this table's zero row — with all 58 other
  // suites green. One edit, both writers. Two copies of the range check could
  // not produce that result.
  const CASES: Array<[string, unknown, boolean]> = [
    ['Monday', 1, true],
    ['Sunday', 7, true],
    ['zero', 0, false],
    ['eight', 8, false],
    ['fractional', 2.5, false],
    ['NaN', Number.NaN, false],
    ['Infinity', Number.POSITIVE_INFINITY, false],
    ['a numeric string', '3', false],
    ['null', null, false],
    ['undefined', undefined, false],
  ];

  test.each(CASES)('%s — the predicate and BOTH writers agree', (_l, value, legal) => {
    expect(isValidBinWeekday(value)).toBe(legal);

    // The setter's verdict.
    const set = planFamilyBinDay({
      family: familyOf([OWNER, KID]),
      actorUid: OWNER,
      binWeekday: value,
    });
    expect(set.ok).toBe(legal);

    // The creator's verdict, read off whether the field survived.
    const created = planFamilyCreation({
      ownerUid: OWNER,
      ownPaidTier: 'pro',
      ownProductId: FAMILY_PRODUCT_ID,
      alreadyOwnsAFamily: false,
      nowMs: NOW,
      ownerBinWeekday: value,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error('unreachable');
    expect('binWeekday' in created.family).toBe(legal);
  });
});

// ---------------------------------------------------------------------------
// KEY: W2-123 — the cap is FIVE, and this is the block that fails if it reverts
// ---------------------------------------------------------------------------
//
// Every other cap test in this file is written RELATIVE to the symbol —
// `FAMILY_CAP - 1`, `toHaveLength(FAMILY_CAP)`, `familyOf([...length: CAP])`.
// That is correct for testing the boundary LOGIC and it is exactly why none of
// them can notice the NUMBER moving: they are green at 4, at 5 and at 50. The
// three that went red when 4 became 5 did so on hard-coded arithmetic, not on
// anything that knew what the product decided.
//
// KEY: SO THIS BLOCK NAMES FIVE PEOPLE AND NEVER MENTIONS THE SYMBOL. The
// fixture is a literal household — two parents and three children, which is
// the family Brendan's 2026-08-19 decision was actually about — and the two
// behavioural assertions pin the number from both sides at once:
//
//   a household of five is LEGAL  → the cap is not below five, and
//   a household of five is FULL   → the cap is not above five.
//
// Together they admit exactly one value, and they reach it by EXECUTING the
// planners rather than reading a literal out of the source. A source-text
// assertion could not tell 5 from 5 written somewhere it is never used.
//
// WARNING: THE MUTATION THAT TURNS ONLY THIS BLOCK RED IS A FIXTURE MUTATION: drop
// one uid from HOUSEHOLD_OF_FIVE. Nothing else in the repo reads it, so the
// 'family-full' assertion flips to a successful join while every pre-existing
// test in every suite stays green. That is the property being bought. Mutating
// FAMILY_CAP itself turns this red too — but it also turns three other tests
// red, so it proves nothing about THIS block's own value.
//
// NOTE: No `toHaveLength(5)` on the fixture on purpose. It would make the fixture
// mutation fail on a literal count instead of on behaviour, which is the
// weaker of the two reds and would hide which assertion is load-bearing.
describe('🔑 W2-123 a family holds FIVE, including whoever started it', () => {
  const HOUSEHOLD_OF_FIVE = [
    OWNER,
    'uid-parent-two',
    'uid-kid-a',
    'uid-kid-b',
    'uid-kid-c',
  ];

  test('five people are a legal family — the cap is not BELOW five', () => {
    expect(familyInvalidReason(familyOf(HOUSEHOLD_OF_FIVE))).toBeNull();
  });

  test('🔴 a sixth person is refused at the join — the cap is not ABOVE five', () => {
    const plan = planFamilyJoin({
      family: familyOf(HOUSEHOLD_OF_FIVE),
      familyId: 'fam-of-five',
      joinerUid: 'uid-sixth',
      joinerOwnPaidTier: 'free',
      joinerCurrentFamilyId: null,
      inviteExpiresAtMs: NOW + FAMILY_INVITE_TTL_SECONDS * 1000,
      nowMs: NOW,
    });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusal).toBe('family-full');
  });

  test('the sentence a person actually reads says five', () => {
    // The copy interpolates the constant, so it cannot disagree with the cap —
    // but nothing until now asserted the RENDERED sentence, and "5" reaching
    // the user is the part of this decision Brendan can see. A refusal that
    // still said four would be the whole change failing in the only place it
    // is visible.
    expect(FAMILY_JOIN_REFUSALS['family-full'].message).toBe(
      'A family holds 5 people, including whoever started it.',
    );
  });
});
