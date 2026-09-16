// functions/src/__tests__/appStoreNotifications.test.ts
//
// The notification-type decision table, tested as pure data.
//
// `effectOf` deliberately owns every "what does this notification MEAN" branch
// so the table can be exercised without Firestore, an emulator, or a signed
// payload. The Firestore half — idempotency, ordering, the owner lookup — is in
// verifyIapAndGrant.test.ts, driving the real handler; the cryptography is in
// appleJws.test.ts. Nothing here knows about any of the three.

import { effectOf, ownerKeyFor, SUBSCRIPTION_PRODUCT_TIERS } from '../appStoreNotifications';
import type { AppleNotification, AppleTransaction } from '../appleJws';

const NOW = Date.UTC(2026, 7, 14);
const MONTH = 30 * 24 * 3600 * 1000;

function transaction(overrides: Partial<AppleTransaction> = {}): AppleTransaction {
  return {
    transactionId: 'tx-renewal-2',
    productId: 'sub_pro_monthly',
    originalTransactionId: 'tx-original-1',
    purchaseDateMs: NOW,
    expiresDateMs: NOW + MONTH,
    revocationDateMs: null,
    appAccountToken: null,
    ...overrides,
  };
}

function notification(
  notificationType: string,
  overrides: Partial<AppleNotification> = {},
): AppleNotification {
  return {
    notificationType,
    subtype: null,
    notificationUUID: `uuid-${notificationType}`,
    signedDateMs: NOW,
    transaction: transaction(),
    ...overrides,
  };
}

describe('effectOf — the notifications that GRANT', () => {
  // The whole point of the endpoint. Before it existed, DID_RENEW reached
  // nothing: both client listeners are created inside a buy action and
  // cancelled when it resolves, and a rebill happens with the app closed.
  test.each([
    'SUBSCRIBED',
    'DID_RENEW',
    'OFFER_REDEEMED',
    'RENEWAL_EXTENDED',
    'DID_CHANGE_RENEWAL_PREF',
  ])('%s entitles through the transaction expiry', (type) => {
    expect(effectOf(notification(type))).toEqual({
      kind: 'entitle',
      tier: 'pro',
      productId: 'sub_pro_monthly',
      expiresAtMs: NOW + MONTH,
    });
  });

  test('the expiry is READ from Apple, never fabricated', () => {
    const odd = NOW + 12345;
    const effect = effectOf(
      notification('DID_RENEW', { transaction: transaction({ expiresDateMs: odd }) }),
    );
    expect(effect).toMatchObject({ kind: 'entitle', expiresAtMs: odd });
  });

  test('the annual product resolves to pro, not to a default', () => {
    const effect = effectOf(
      notification('DID_RENEW', { transaction: transaction({ productId: 'sub_pro_annual' }) }),
    );
    expect(effect).toMatchObject({ kind: 'entitle', tier: 'pro' });
  });

  test('an entitling notification with NO expiry is refused, not granted forever', () => {
    // The fail-closed direction, and the exact bug #343 was opened to fix: a
    // tier written with no readable end date never lapses. Granting on a
    // subscription notification that somehow carries no expiresDate would
    // reintroduce it through a new door.
    const effect = effectOf(
      notification('DID_RENEW', { transaction: transaction({ expiresDateMs: null }) }),
    );
    expect(effect.kind).toBe('ignore');
  });
});

describe('effectOf — the notifications that REVOKE', () => {
  test('REFUND revokes at the revocation date, NOT at the still-future expiry', () => {
    // 🔴 The one case the clock cannot handle on its own. Apple can refund in
    // the middle of a paid period, so `subscriptionExpiresAt` is still weeks
    // ahead and every reader would keep computing `pro`. Without this branch a
    // refunded account keeps Pro until a period it was paid back for runs out.
    const revokedAt = NOW + 3 * 24 * 3600 * 1000;
    const effect = effectOf(
      notification('REFUND', {
        transaction: transaction({
          expiresDateMs: NOW + MONTH,
          revocationDateMs: revokedAt,
        }),
      }),
    );

    expect(effect).toEqual({
      kind: 'revoke',
      productId: 'sub_pro_monthly',
      endedAtMs: revokedAt,
      reason: 'REFUND',
    });
    // The assertion that matters: the end is the revocation, not the expiry.
    expect(effect).not.toMatchObject({ endedAtMs: NOW + MONTH });
  });

  test('REVOKE — Family Sharing withdrawn — revokes the same way', () => {
    const revokedAt = NOW + 1000;
    expect(
      effectOf(
        notification('REVOKE', {
          transaction: transaction({ revocationDateMs: revokedAt }),
        }),
      ),
    ).toMatchObject({ kind: 'revoke', endedAtMs: revokedAt });
  });

  test.each(['EXPIRED', 'GRACE_PERIOD_EXPIRED'])(
    '%s revokes at the expiry when there is no revocation date',
    (type) => {
      // A PIN, not a regression catch, and marked as one in the floor note:
      // `resolveEffectiveTier` already returns free once the stored expiry has
      // passed, so this write changes no READER's answer. It exists so the
      // stored document agrees with what every reader computes.
      expect(effectOf(notification(type))).toMatchObject({
        kind: 'revoke',
        endedAtMs: NOW + MONTH,
      });
    },
  );

  test('the subtype is carried into the reason, because logs are read', () => {
    const effect = effectOf(notification('EXPIRED', { subtype: 'VOLUNTARY' }));
    expect(effect).toMatchObject({ reason: 'EXPIRED (VOLUNTARY)' });
  });
});

describe('effectOf — the notifications that must change NOTHING', () => {
  test('DID_FAIL_TO_RENEW does not cut off a subscriber Apple is still charging', () => {
    // 🔑 The tempting wrong answer. A failed rebill is not an ended
    // subscription: with a billing-retry or grace period the subscriber is
    // still entitled through the expiry already stored, and without one the
    // clock revokes them at that same moment. Writing `free` here would
    // de-entitle a paying customer mid-retry.
    expect(effectOf(notification('DID_FAIL_TO_RENEW')).kind).toBe('ignore');
  });

  test('DID_CHANGE_RENEWAL_STATUS — auto-renew toggled off — changes nothing now', () => {
    // It changes what happens at the END of the period. The period is unchanged.
    expect(effectOf(notification('DID_CHANGE_RENEWAL_STATUS')).kind).toBe('ignore');
  });

  test('TEST is acknowledged, so App Store Connect can prove the URL is wired', () => {
    // The console's "Request a Test Notification" button carries no transaction
    // and is the ONLY way to confirm the endpoint before a real purchase
    // exists. Treating a missing transaction as malformed would report the
    // endpoint unreachable at the exact moment someone is checking it.
    const effect = effectOf(
      notification('TEST', { transaction: null }),
    );
    expect(effect).toMatchObject({ kind: 'ignore' });
    expect(effect.kind === 'ignore' && effect.reason).toMatch(/reachable/);
  });

  test('an UNKNOWN notification type is ignored, never an error', () => {
    // ⚠️ Apple adds notification types without asking — RESCIND_CONSENT,
    // METADATA_UPDATE and MIGRATION are all newer than this app. A handler that
    // threw on an unrecognised one would turn a routine Apple release into
    // three days of retries against an endpoint that looks broken.
    expect(effectOf(notification('SOME_TYPE_APPLE_ADDS_IN_2027')).kind).toBe('ignore');
  });

  test('a REFUND for a SPONGE PACK never writes over a live subscription', () => {
    // A consumable refund is a real event with real notifications, and its
    // product has no tier. Falling through to `revoke` here would let a
    // refunded 100-sponge pack cancel someone's Pro subscription.
    const effect = effectOf(
      notification('REFUND', {
        transaction: transaction({ productId: 'sponge_pack_100' }),
      }),
    );
    expect(effect.kind).toBe('ignore');
  });

  test('an unrecognised product id never resolves to a tier', () => {
    const effect = effectOf(
      notification('DID_RENEW', { transaction: transaction({ productId: 'sub_pro_lifetime' }) }),
    );
    expect(effect.kind).toBe('ignore');
  });

  test('the retired premium product is not billable', () => {
    // #314 retired the tier and the client has no reference to it. A renewal
    // notification for a grandfathered `sub_premium_monthly` must not re-grant.
    expect(SUBSCRIPTION_PRODUCT_TIERS['sub_premium_monthly']).toBeUndefined();
    expect(
      effectOf(
        notification('DID_RENEW', {
          transaction: transaction({ productId: 'sub_premium_monthly' }),
        }),
      ).kind,
    ).toBe('ignore');
  });
});

describe('ownerKeyFor', () => {
  test('keys on the ORIGINAL transaction id, which survives every renewal', () => {
    // The renewal carries a different `transactionId` and the same
    // `originalTransactionId`. Keying the owner index on the former would make
    // every renewal unattributable, which is the whole failure this endpoint
    // exists to fix.
    expect(ownerKeyFor(transaction())).toBe('tx-original-1');
    expect(ownerKeyFor(transaction())).not.toBe('tx-renewal-2');
  });

  test('a transaction with no original id is unresolvable, not guessed', () => {
    // Guessing `transactionId` here would hand one account's renewals to
    // whichever account happened to own a transaction with that id.
    expect(ownerKeyFor(transaction({ originalTransactionId: null }))).toBeNull();
  });
});
