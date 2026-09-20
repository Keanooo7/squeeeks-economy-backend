// functions/src/__tests__/entitlement.test.ts
//
// W2-67. An entitlement is a claim about NOW, and until this file existed
// nothing on the server ever asked what time it was.
//
// `subscriptionExpiresAt` was written once (index.ts, inside
// verifySubscriptionReceipt) and read by nothing. The only comparison against a
// clock ran on the freshly-verified Apple transaction BEFORE the field was
// written, so a subscriber whose subscription ended months ago kept the paid
// task cap and the paid gift-invite allowance for ever.
//
// `resolveEffectiveTier` is the single authority that closes that. It is a pure
// function with the clock injected, which is the whole reason these cases can be
// written at all — an expiry boundary tested against `Date.now()` is a test that
// passes for a different reason every time it runs.
//
// WARNING: IT FAILS CLOSED, INCLUDING ON A MISSING EXPIRY. A paid tier string with no
// readable expiry resolves to free. That is deliberate: the alternative — trust
// the tier when the date is unreadable — is precisely the bug this file exists
// to prevent, and it would be reachable by writing one malformed field.

import { resolveEffectiveTier } from '../taskRewards';

/** A fixed clock. Nothing here reads the real one. */
const NOW = Date.UTC(2026, 7, 14, 12, 0, 0); // 2026-08-14T12:00:00Z
const HOUR = 60 * 60 * 1000;

/** The shape the Admin SDK actually hands back for a Timestamp field. */
function realTimestamp(ms: number) {
  return { toMillis: () => ms };
}

/**
 * The shape the suite's own hand-rolled `admin.firestore.Timestamp` produces.
 *
 * WARNING: Not a convenience — verifyIapAndGrant.test.ts asserts the subscription
 * write lands as `{ _type: 'ts', ms }`, so this is the representation every
 * OTHER test in this suite would feed the resolver. A resolver that only
 * understood the real Timestamp would fail closed on every mocked document and
 * the behaviour tests would go green for the wrong reason.
 */
function mockTimestamp(ms: number) {
  return { _type: 'ts', ms };
}

describe('resolveEffectiveTier — the free tier', () => {
  it('resolves free to free and never consults the date', () => {
    // A throwing expiry proves the date is not read on this path.
    const exploding = {
      subscriptionTier: 'free',
      get subscriptionExpiresAt(): never {
        throw new Error('the free path must not read the expiry');
      },
    };
    expect(resolveEffectiveTier(exploding, NOW)).toBe('free');
  });

  it('resolves a missing tier to free', () => {
    expect(resolveEffectiveTier({}, NOW)).toBe('free');
  });

  it('resolves an undefined document to free', () => {
    expect(resolveEffectiveTier(undefined, NOW)).toBe('free');
    expect(resolveEffectiveTier(null, NOW)).toBe('free');
  });

  it('resolves a non-string tier to free', () => {
    expect(resolveEffectiveTier({ subscriptionTier: 7 }, NOW)).toBe('free');
    expect(resolveEffectiveTier({ subscriptionTier: null }, NOW)).toBe('free');
  });
});

describe('resolveEffectiveTier — a live subscription', () => {
  it('keeps pro when the expiry is in the future', () => {
    const doc = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: realTimestamp(NOW + HOUR),
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('pro');
  });

  it('reads the mocked Timestamp shape this suite writes', () => {
    const doc = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: mockTimestamp(NOW + HOUR),
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('pro');
  });

  it('reads a Date', () => {
    const doc = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: new Date(NOW + HOUR),
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('pro');
  });

  it('reads a raw millisecond number', () => {
    const doc = { subscriptionTier: 'pro', subscriptionExpiresAt: NOW + HOUR };
    expect(resolveEffectiveTier(doc, NOW)).toBe('pro');
  });

  it('reads an ISO string, which is how the Dart User entity serialises it', () => {
    // lib/domain/entities/user.g.dart round-trips this field with
    // toIso8601String() — a different serialisation from the server's Timestamp
    // for the same field name. Both must resolve, or the representation a
    // document happens to carry decides whether someone keeps what they paid for.
    const doc = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: new Date(NOW + HOUR).toISOString(),
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('pro');
  });
});

describe('resolveEffectiveTier — a lapsed subscription', () => {
  it('drops pro to free when the expiry has passed', () => {
    const doc = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: realTimestamp(NOW - HOUR),
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('free');
  });

  it('drops pro to free at the exact instant of expiry', () => {
    // The boundary is `<=`, matching the grant-time check in
    // verifySubscriptionReceipt. An entitlement that is exactly used up is used
    // up; picking `<` here would disagree with the function that issued it.
    const doc = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: realTimestamp(NOW),
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('free');
  });

  it('drops pro to free one millisecond after expiry', () => {
    const doc = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: realTimestamp(NOW - 1),
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('free');
  });

  it('keeps pro one millisecond before expiry', () => {
    const doc = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: realTimestamp(NOW + 1),
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('pro');
  });
});

describe('resolveEffectiveTier — fails closed on an unreadable expiry', () => {
  it('drops a paid tier with NO expiry field to free', () => {
    expect(resolveEffectiveTier({ subscriptionTier: 'pro' }, NOW)).toBe('free');
  });

  it('drops a paid tier with a null expiry to free', () => {
    const doc = { subscriptionTier: 'pro', subscriptionExpiresAt: null };
    expect(resolveEffectiveTier(doc, NOW)).toBe('free');
  });

  it('drops a paid tier with an unparseable string expiry to free', () => {
    const doc = { subscriptionTier: 'pro', subscriptionExpiresAt: 'soon' };
    expect(resolveEffectiveTier(doc, NOW)).toBe('free');
  });

  it('drops a paid tier with a NaN or infinite expiry to free', () => {
    expect(
      resolveEffectiveTier(
        { subscriptionTier: 'pro', subscriptionExpiresAt: NaN },
        NOW,
      ),
    ).toBe('free');
    expect(
      resolveEffectiveTier(
        { subscriptionTier: 'pro', subscriptionExpiresAt: Infinity },
        NOW,
      ),
    ).toBe('free');
  });

  it('drops a paid tier whose expiry is an object it cannot read to free', () => {
    const doc = { subscriptionTier: 'pro', subscriptionExpiresAt: { when: 1 } };
    expect(resolveEffectiveTier(doc, NOW)).toBe('free');
  });

  it('drops a paid tier whose toMillis does not return a number to free', () => {
    const doc = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: { toMillis: () => 'later' },
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('free');
  });
});

describe('resolveEffectiveTier — a retired tier string', () => {
  // normalizeTier decodes `premium` to `pro` because documents written before
  // #314 still carry it and nothing migrates them. Decoding has to happen FIRST:
  // a legacy subscriber who is still inside their term keeps what they paid for,
  // and one who is not lapses like anybody else.
  it('decodes premium to pro while the expiry is in the future', () => {
    const doc = {
      subscriptionTier: 'premium',
      subscriptionExpiresAt: realTimestamp(NOW + HOUR),
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('pro');
  });

  it('drops an expired premium to free', () => {
    const doc = {
      subscriptionTier: 'premium',
      subscriptionExpiresAt: realTimestamp(NOW - HOUR),
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('free');
  });

  it('drops a premium with no expiry to free', () => {
    expect(resolveEffectiveTier({ subscriptionTier: 'premium' }, NOW)).toBe(
      'free',
    );
  });

  it('passes an unrecognised tier through while live, and lapses it', () => {
    // normalizeTier passes an unknown string through unchanged so the CALLER's
    // own fail-closed default decides what it is worth. That contract is
    // unchanged here — the resolver only adds the clock.
    const live = {
      subscriptionTier: 'platinum',
      subscriptionExpiresAt: realTimestamp(NOW + HOUR),
    };
    expect(resolveEffectiveTier(live, NOW)).toBe('platinum');

    const lapsed = {
      subscriptionTier: 'platinum',
      subscriptionExpiresAt: realTimestamp(NOW - HOUR),
    };
    expect(resolveEffectiveTier(lapsed, NOW)).toBe('free');
  });
});

// ---------------------------------------------------------------------------
// KEY: THE FAMILY GRANT — a SOURCE of pro, not a tier (W2-76)
// ---------------------------------------------------------------------------
//
// `SubscriptionTier` stays `enum { free, pro }`. A family member with no
// subscription of their own resolves to `pro` because `familyProExpiresAt` on
// their user document is in the future — the fan-out's copy of the family
// owner's own expiry (see family.ts).
//
// WARNING: EVERY GRANT TEST HERE HAS A CONTROL, for the reason the brief gave: a
// test proving a family member resolves to pro is worthless if it also passes
// with the family branch deleted. The controls below are the same documents
// with the family field lapsed, unreadable or absent.
describe('resolveEffectiveTier — a family grant', () => {
  it('🔴 grants pro to a member who has NO subscription of their own', () => {
    // The feature, in one assertion. No subscriptionTier, no
    // subscriptionExpiresAt — entitled purely by family membership.
    const doc = { familyProExpiresAt: realTimestamp(NOW + HOUR) };
    expect(resolveEffectiveTier(doc, NOW)).toBe('pro');
  });

  it('grants pro to a member whose OWN subscription has lapsed', () => {
    // The two dates are independent. A lapsed personal subscription must not
    // shadow a live family grant, or joining a family would fail for exactly
    // the people most likely to join one.
    const doc = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: realTimestamp(NOW - HOUR),
      familyProExpiresAt: realTimestamp(NOW + HOUR),
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('pro');
  });

  it('CONTROL: the same document with the family grant LAPSED is free', () => {
    // Delete the family branch in taskRewards.ts and the two tests above stay
    // green on their own; this is what separates them from a no-op.
    const doc = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: realTimestamp(NOW - HOUR),
      familyProExpiresAt: realTimestamp(NOW - HOUR),
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('free');
  });

  it('CONTROL: no family field at all is free, not pro', () => {
    expect(resolveEffectiveTier({}, NOW)).toBe('free');
  });

  it('the boundary: a family grant exactly at now is used up', () => {
    // The same `<=` boundary as the paid path, and pinned to agree with
    // planFamilyFanOut. If the two disagreed a member would be entitled for
    // one tick after the fan-out stopped granting.
    const doc = { familyProExpiresAt: realTimestamp(NOW) };
    expect(resolveEffectiveTier(doc, NOW)).toBe('free');
  });

  it('fails CLOSED on an unreadable family expiry', () => {
    // Decoded by the same expiryMillis as the paid path, not a second decoder.
    expect(resolveEffectiveTier({ familyProExpiresAt: 'not-a-date' }, NOW)).toBe('free');
    expect(resolveEffectiveTier({ familyProExpiresAt: {} }, NOW)).toBe('free');
    expect(resolveEffectiveTier({ familyProExpiresAt: true }, NOW)).toBe('free');
    expect(resolveEffectiveTier({ familyProExpiresAt: null }, NOW)).toBe('free');
  });

  it('reads the family expiry in every shape the paid path accepts', () => {
    // Firestore Timestamp, ISO string and raw millis all reach this field for
    // the same reasons subscriptionExpiresAt does.
    expect(resolveEffectiveTier(
      { familyProExpiresAt: realTimestamp(NOW + HOUR) }, NOW)).toBe('pro');
    expect(resolveEffectiveTier(
      { familyProExpiresAt: new Date(NOW + HOUR).toISOString() }, NOW)).toBe('pro');
    expect(resolveEffectiveTier(
      { familyProExpiresAt: NOW + HOUR }, NOW)).toBe('pro');
  });

  it('a LIVE personal subscription still wins on its own, with no family field', () => {
    // The inverse control: the family branch must not have broken the path
    // that already worked.
    const doc = {
      subscriptionTier: 'pro',
      subscriptionExpiresAt: realTimestamp(NOW + HOUR),
    };
    expect(resolveEffectiveTier(doc, NOW)).toBe('pro');
  });
});
