import { HttpsError } from 'firebase-functions/v2/https';
import {
  Environment,
  SignedDataVerifier,
  VerificationException,
  VerificationStatus,
} from '@apple/app-store-server-library';
import { APPLE_ROOT_CERTIFICATES } from './appleRootCerts';

/**
 * The app's bundle identifier, asserted by the verifier on every transaction.
 *
 * Confirmed against `ios/Runner.xcodeproj/project.pbxproj:486`. A JWS for any
 * other app fails with INVALID_APP_IDENTIFIER even if Apple genuinely signed it.
 */
export const BUNDLE_ID = 'com.brendankeane.cleaning';

/**
 * The app's numeric App Store id, required to verify **Production** transactions.
 *
 * Read from App Store Connect → Apps → Squeeeks → Distribution → App Information
 * → General Information → Apple ID on 2026-08-05, and corroborated by the console
 * URL for the same page (`/apps/6797102615/distribution`).
 *
 * WARNING: Do not set this back to `null`. While it was null the Production verifier
 * could not be *constructed* at all — `new SignedDataVerifier(...,
 * Environment.PRODUCTION, ...)` throws `appAppleId is required when the
 * environment is Production` in v3.1.0, because the constructor validates the
 * field even though it is optional in the type signature and unread by
 * `verifyAndDecodeTransaction`. So a Production transaction was rejected rather
 * than verified: Sandbox (and therefore TestFlight) worked, App Store release
 * did not. `appleJws.test.ts` pins this as a number for that reason.
 */
export const APP_APPLE_ID: number | null = 6797102615;

/**
 * The one transaction carried by a StoreKit 2 JWS, normalised.
 *
 * WARNING: A JWS describes exactly ONE transaction — unlike a StoreKit 1 app receipt,
 * which was a cumulative list of every purchase on the device. That difference
 * is the whole reason this module exists; see the header comment on
 * `validateAppleTransaction` in index.ts.
 */
export interface AppleTransaction {
  transactionId: string;
  productId: string;
  /**
   * The id of the transaction that STARTED the subscription, stable across
   * every renewal of it.
   *
 * KEY: This is the only durable link between a server notification and one of
   * our accounts. `transactionId` changes on every renewal and
   * `appAccountToken` is a **one-way** uuidv5 of the uid
   * (`purchaseAccountToken.ts`) that cannot be inverted, so neither can answer
   * "whose subscription is this?" for an UNAUTHENTICATED notification. The
   * owner index keyed on this field — `subscriptionOwners/{id}` in index.ts —
   * is what makes `appStoreNotifications` able to find a user at all.
   *
   * Null only on a payload Apple signed without one, which no subscription
   * transaction does; the field is optional in the library's type, not in
   * practice.
   */
  originalTransactionId: string | null;
  /** UNIX ms. Used by the `appAccountToken` rollout comparison. */
  purchaseDateMs: number;
  /** UNIX ms; null for anything that is not an auto-renewable subscription. */
  expiresDateMs: number | null;
  /**
   * UNIX ms at which Apple refunded or revoked this transaction; null when it
   * still stands.
   *
 * WARNING: A refund can land in the MIDDLE of a paid period, so this is the one
   * signal that must revoke an entitlement whose `expiresDate` is still in the
   * future. Everything else can be left to lapse on the clock.
   */
  revocationDateMs: number | null;
  /** The account stamp, or null on a transaction predating the stamping build. */
  appAccountToken: string | null;
}

/**
 * One App Store Server Notification V2, verified and normalised.
 *
 * `transaction` is null for the payload shapes that carry no
 * `signedTransactionInfo` at all — `TEST`, the `summary` form of
 * `RENEWAL_EXTENSION`, and `EXTERNAL_PURCHASE_TOKEN`. Those are acknowledged
 * and ignored rather than treated as malformed.
 */
export interface AppleNotification {
  notificationType: string;
  subtype: string | null;
  /**
   * Apple's own unique id for this NOTIFICATION.
   *
 * CRITICAL: The idempotency key, and deliberately NOT `transactionId`. Apple sends
   * more than one notification about the same transaction — `DID_FAIL_TO_RENEW`
   * and then `EXPIRED` both carry the last renewal's transaction — so a ledger
   * keyed on the transaction id would swallow the second one as
   * already-processed and the entitlement would never be revoked.
   */
  notificationUUID: string;
  /** UNIX ms at which Apple signed this notification. Orders redeliveries. */
  signedDateMs: number;
  transaction: AppleTransaction | null;
}

/**
 * Verifies a StoreKit 2 signed transaction **offline** and returns its payload.
 *
 * KEY: Offline is the entire point. `SignedDataVerifier` validates the JWS `x5c`
 * chain against Apple's public root CAs locally, so the purchase path makes no
 * network call and needs no App Store Connect API key. (Only
 * `AppStoreServerAPIClient` — which queries transaction *history* — needs an
 * issuer id + key id + `.p8`, and none exists for this project.)
 *
 * Production is tried first and Sandbox second — the same two-environment shape
 * the old `verifyReceipt` path had in its `21007` retry, moved to the new layer:
 * the verifier asserts the payload's `environment` claim matches the one it was
 * constructed with, so a Sandbox transaction raises INVALID_ENVIRONMENT against
 * the Production verifier and is then re-verified against Sandbox.
 *
 * WARNING: While {@link APP_APPLE_ID} is null the Production attempt is skipped
 * entirely, because the verifier cannot be constructed without it. Sandbox — and
 * therefore TestFlight — is fully functional; App Store release is not.
 */
/**
 * Builds a verify function bound to a set of trust anchors.
 *
 * Parameterised on the roots so `__tests__/appleJws.test.ts` can exercise the
 * **real** `SignedDataVerifier` against a locally generated
 * root → intermediate → leaf chain. Without that seam the only way to test the
 * cryptography would be to stub it out, which would test nothing.
 */
export function makeVerify(
  roots: Buffer[],
  bundleId: string,
  appAppleId: number | null = APP_APPLE_ID,
): (jws: string) => Promise<AppleTransaction> {
  const verifierFor = makeVerifierFactory(roots, bundleId, appAppleId);

  return async function verify(jws: string): Promise<AppleTransaction> {
    if (!jws) {
      throw new HttpsError('invalid-argument', 'Missing signed transaction');
    }

    assertConfigured(roots, bundleId, 'Receipt validation is unavailable');

    const payload = await inWhicheverEnvironmentSigned(
      verifierFor,
      appAppleId,
      (verifier) => verifier.verifyAndDecodeTransaction(jws),
      'Rejected a Production transaction because APP_APPLE_ID is unset — ' +
        'set it in appleJws.ts before App Store release',
    );

    return normaliseTransaction(payload);
  };
}

/**
 * Builds a notification verify function bound to a set of trust anchors.
 *
 * KEY: A notification is a DIFFERENT JWS shape from a transaction and needs a
 * different library call — `verifyAndDecodeNotification`, which asserts the
 * bundle id, app id and environment out of the payload's `data` block rather
 * than out of a transaction. `verifyAndDecodeTransaction` cannot parse one.
 * That distinction is the reason this exists at all: the brief that asked for
 * the endpoint described `appleJws.ts` as already able to verify Apple's signed
 * payload, which is true of the payload the CLIENT sends and not of this one.
 *
 * The inner `signedTransactionInfo` is verified with the SAME verifier that
 * accepted the envelope, so a Sandbox notification can never have its
 * transaction validated against Production trust settings.
 *
 * Parameterised on the roots for the same reason {@link makeVerify} is — so the
 * suite can drive the real `SignedDataVerifier` off a locally generated chain.
 */
export function makeVerifyNotification(
  roots: Buffer[],
  bundleId: string,
  appAppleId: number | null = APP_APPLE_ID,
): (signedPayload: string) => Promise<AppleNotification> {
  const verifierFor = makeVerifierFactory(roots, bundleId, appAppleId);

  return async function verifyNotification(signedPayload: string): Promise<AppleNotification> {
    if (!signedPayload) {
      throw new HttpsError('invalid-argument', 'Missing signed payload');
    }

    assertConfigured(roots, bundleId, 'Notification validation is unavailable');

    const { payload, transaction } = await inWhicheverEnvironmentSigned(
      verifierFor,
      appAppleId,
      async (verifier) => {
        const decoded = await verifier.verifyAndDecodeNotification(signedPayload);
        const signedTransactionInfo = decoded.data?.signedTransactionInfo;
        return {
          payload: decoded,
          transaction: signedTransactionInfo
            ? normaliseTransaction(
                await verifier.verifyAndDecodeTransaction(signedTransactionInfo),
              )
            : null,
        };
      },
      'Rejected a Production notification because APP_APPLE_ID is unset — ' +
        'set it in appleJws.ts before App Store release',
      // CRITICAL: A NOTIFICATION NEEDS A WIDER RETRY PREDICATE THAN A TRANSACTION, and
      // getting this wrong breaks Sandbox — which is TestFlight, which is the
      // only environment that can be tested before release.
      //
      // Apple OMITS `appAppleId` from a Sandbox notification, and
      // `verifyNotification` checks the app identifier BEFORE the environment:
      //
      //   this.bundleId !== bundleId ||
      //     (this.environment === PRODUCTION && this.appAppleId !== appAppleId)
      //       -> INVALID_APP_IDENTIFIER
      //
      // So a genuine Sandbox notification hitting the Production verifier
      // raises INVALID_APP_IDENTIFIER (3), never INVALID_ENVIRONMENT (4), and a
      // retry gated on the environment status alone never fires. A TRANSACTION
      // does not hit this because it carries no `appAppleId` field for the
      // comparison to fail on — which is exactly why copying `makeVerify`'s
      // predicate looked right and was not.
      //
      // Widening it costs no safety: the Sandbox verifier still asserts the
      // bundle id, so a notification for another app fails there too.
      (error) => isEnvironmentMismatch(error) || isAppIdentifierMismatch(error),
    );

    // Apple-signed, so this asserts Apple's output rather than validating
    // untrusted input — but without a uuid there is no idempotency key, and
    // replaying a renewal is exactly what the ledger exists to prevent.
    if (!payload.notificationType || !payload.notificationUUID) {
      throw new HttpsError(
        'invalid-argument',
        'Signed notification is missing notificationType or notificationUUID',
      );
    }

    return {
      notificationType: payload.notificationType,
      subtype: payload.subtype ?? null,
      notificationUUID: payload.notificationUUID,
      signedDateMs: payload.signedDate ?? 0,
      transaction,
    };
  };
}

function makeVerifierFactory(
  roots: Buffer[],
  bundleId: string,
  appAppleId: number | null,
): (environment: Environment) => SignedDataVerifier {
  return (environment: Environment) =>
    new SignedDataVerifier(
      roots,
      // Online checks would add an OCSP round trip per purchase and reintroduce
      // exactly the network dependency this change removes. With them off the
      // certificate validity window is checked against the payload's signedDate.
      /* enableOnlineChecks */ false,
      environment,
      bundleId,
      appAppleId ?? undefined,
    );
}

/**
 * Fail loudly on a misconfigured server rather than letting a verification
 * error read as "the user's purchase is bad". This replaces the equivalent
 * guard the old verifyReceipt path had on APPLE_SHARED_SECRET, which the JWS
 * path no longer uses at all.
 */
function assertConfigured(roots: Buffer[], bundleId: string, message: string): void {
  if (roots.length === 0 || !bundleId) {
    console.error('Apple JWS verification is misconfigured — no root certificates or bundle id');
    throw new HttpsError('failed-precondition', message);
  }
}

/**
 * Runs `attempt` against Production and retries against Sandbox on an
 * environment mismatch — the same two-environment shape the old `verifyReceipt`
 * path had in its `21007` retry.
 *
 * WARNING: While {@link APP_APPLE_ID} is null the Production attempt is SKIPPED
 * entirely, because `SignedDataVerifier` throws on construction without it.
 * Sandbox — and therefore TestFlight — is fully functional; App Store release
 * is not, which is what `productionSkippedMessage` says out loud.
 */
async function inWhicheverEnvironmentSigned<T>(
  verifierFor: (environment: Environment) => SignedDataVerifier,
  appAppleId: number | null,
  attempt: (verifier: SignedDataVerifier) => Promise<T>,
  productionSkippedMessage: string,
  shouldRetryInSandbox: (error: unknown) => boolean = isEnvironmentMismatch,
): Promise<T> {
  if (appAppleId == null) {
    try {
      return await attempt(verifierFor(Environment.SANDBOX));
    } catch (error) {
      if (shouldRetryInSandbox(error)) console.error(productionSkippedMessage);
      throw asHttpsError(error);
    }
  }

  try {
    return await attempt(verifierFor(Environment.PRODUCTION));
  } catch (error) {
    if (!shouldRetryInSandbox(error)) throw asHttpsError(error);
    try {
      return await attempt(verifierFor(Environment.SANDBOX));
    } catch (sandboxError) {
      throw asHttpsError(sandboxError);
    }
  }
}

/**
 * Every field read below is Apple-signed, so these are assertions about Apple's
 * output rather than validation of client input — but a payload missing one of
 * them would silently produce an unusable grant, so fail closed.
 */
function normaliseTransaction(payload: {
  transactionId?: string;
  productId?: string;
  originalTransactionId?: string;
  purchaseDate?: number;
  expiresDate?: number;
  revocationDate?: number;
  appAccountToken?: string;
}): AppleTransaction {
  if (!payload.productId || !payload.transactionId) {
    throw new HttpsError(
      'invalid-argument',
      'Signed transaction is missing productId or transactionId',
    );
  }

  return {
    transactionId: payload.transactionId,
    productId: payload.productId,
    originalTransactionId: payload.originalTransactionId ?? null,
    purchaseDateMs: payload.purchaseDate ?? 0,
    expiresDateMs: payload.expiresDate ?? null,
    revocationDateMs: payload.revocationDate ?? null,
    appAccountToken: payload.appAccountToken ?? null,
  };
}

function isEnvironmentMismatch(error: unknown): boolean {
  return (
    error instanceof VerificationException &&
    error.status === VerificationStatus.INVALID_ENVIRONMENT
  );
}

/**
 * WARNING: On the NOTIFICATION path this is an environment mismatch wearing another
 * status code, not an assertion that the payload is for another app — see the
 * retry predicate in {@link makeVerifyNotification}. It is not part of the
 * transaction path's predicate, where it means what it says.
 */
function isAppIdentifierMismatch(error: unknown): boolean {
  return (
    error instanceof VerificationException &&
    error.status === VerificationStatus.INVALID_APP_IDENTIFIER
  );
}

function asHttpsError(error: unknown): HttpsError {
  if (error instanceof VerificationException) {
    // RETRYABLE_VERIFICATION_FAILURE is Apple's signal that the failure is
    // transient (a key fetch), not a bad transaction — surfacing it as
    // `unavailable` lets the client retry instead of showing a purchase error.
    if (error.status === VerificationStatus.RETRYABLE_VERIFICATION_FAILURE) {
      return new HttpsError('unavailable', 'Receipt validation is temporarily unavailable');
    }
    return new HttpsError(
      'invalid-argument',
      `Apple transaction verification failed (status ${error.status})`,
    );
  }
  return new HttpsError('invalid-argument', 'Apple transaction verification failed');
}

/**
 * The verification seam.
 *
 * KEY: Exported as a **mutable object** so tests can replace `appleJws.verify`
 * with a stub. That is forced rather than stylistic: the previous test harness
 * intercepted Apple by replacing `global.fetch`, and offline verification makes
 * **no HTTP call at all** — there is no transport left to mock. Driving the
 * callables with a decoded payload keeps the transaction-id ledger tests (which
 * are about idempotency, not about Apple) meaningful, while the real
 * cryptography is covered once, separately, in `__tests__/appleJws.test.ts`.
 */
export const appleJws = {
  verify: makeVerify(APPLE_ROOT_CERTIFICATES, BUNDLE_ID),
  verifyNotification: makeVerifyNotification(APPLE_ROOT_CERTIFICATES, BUNDLE_ID),
};
