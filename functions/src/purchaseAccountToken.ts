import { createHash } from 'crypto';

/**
 * Namespace for {@link purchaseTokenForUid}. Frozen — changing a single
 * character re-derives every token and orphans the attribution on every
 * transaction Apple has already stamped.
 *
 * KEY: Must stay byte-identical to `kPurchaseTokenNamespace` in
 * `lib/core/purchases/purchase_account_token.dart`. The same frozen vectors are
 * asserted in both suites (`__tests__/purchaseAccountToken.test.ts` and
 * `test/core/purchases/purchase_account_token_test.dart`) precisely so the two
 * cannot drift apart silently — a mismatch would reject every honest purchase
 * and there would be nothing in either codebase that looked wrong.
 */
export const NAMESPACE = '6f9d3b2a-1c47-5e8a-9f30-2b7c5d41e8a6';

/**
 * The cutoff after which a transaction carrying **no** `appAccountToken` is
 * refused. `epochMs: null` means the rule is written and tested but disabled.
 *
 * KEY: It ships disabled deliberately. The token-stamping client build is not in
 * TestFlight yet, so *every* transaction Apple has signed to date is unstamped —
 * any epoch in the past would reject every legitimate purchase in existence.
 * Set it to the release date of the first stamped build once that build is
 * actually live, which turns a permanent compatibility hole into one that closes
 * on a date someone chose on purpose.
 *
 * CRITICAL: CRITICAL: READ THIS BEFORE SETTING IT: DOING SO REFUSES EVERY FAMILY-SHARED
 * PURCHASE. (W2-90.)
 *
 * Apple Family Sharing is ON for the Pro subscriptions in App Store Connect, and
 * per Apple's documentation `appAccountToken` is NOT AVAILABLE on family-shared
 * transactions — Apple directs you to `appTransactionId` instead. So a family
 * member's transaction arrives with NO token, falls through the branch above
 * while `epochMs` is null, and is granted. Setting an epoch turns that grant
 * into `permission-denied` for every member of every family, silently, for a
 * reason that has nothing to do with families.
 *
 * WARNING: AND IT LOOKS SAFE FROM THE BUYER'S SIDE, which is what makes it a trap: the
 * PURCHASER's own transaction is stamped and keeps working. Only the shared ones
 * break, and only for people who are not the person testing it.
 *
 * KEY: THE PREREQUISITE IS A FIELD NOTHING READS YET. Apple distinguishes the two
 * with `inAppOwnershipType` (`PURCHASED` / `FAMILY_SHARED`); the only occurrence
 * in this repo is a test fixture. Exempting shared transactions from this rule
 * means reading that field first — a real change, not a flag flip.
 *
 * All four behaviours are pinned in verifyIapAndGrant.test.ts under
 * "W2-90 Family Sharing and the account boundary", including this future one.
 *
 * A mutable object rather than a bare `const` for the same reason `appleJws` is
 * one: the comparison is only meaningfully testable if a test can move the
 * cutoff, and a rule that ships disabled with no test of its enabled behaviour
 * is a rule nobody has ever run.
 */
export const accountTokenRollout: { epochMs: number | null } = { epochMs: null };

/**
 * The value the client passes to StoreKit as `appAccountToken`, identifying
 * *which of our accounts* initiated a purchase.
 *
 * Apple stores it on the transaction itself, so it survives a reinstall and
 * comes back on every redelivery, restore and renewal. The server recomputes it
 * from `request.auth.uid` — the only field it can trust — and refuses to grant
 * when the transaction carries a different one.
 *
 * WARNING: **This is not a secret.** It is a hash of a uid in a public namespace, so
 * anyone who knows a uid can compute it. It *claims* attribution; it does not
 * authorise anything. Authentication is still `request.auth`; this only narrows
 * which account an already-authenticated caller may have a transaction granted to.
 */
export function purchaseTokenForUid(uid: string): string {
  return uuidV5(NAMESPACE, uid);
}

/**
 * RFC 4122 §4.3 name-based UUID, SHA-1 flavour.
 *
 * A line-for-line translation of `_uuidV5` in
 * `lib/core/purchases/purchase_account_token.dart` onto Node's `crypto`. Both
 * are hand-rolled and deliberately short: the two implementations have to agree
 * byte for byte, and the cheapest way to keep them agreeing is for each to be
 * readable in one sitting beside the other.
 */
function uuidV5(namespace: string, name: string): string {
  const bytes = Buffer.concat([namespaceBytes(namespace), Buffer.from(name, 'utf8')]);
  const hash = createHash('sha1').update(bytes).digest().subarray(0, 16);

  // Version 5 in the high nibble of byte 6, RFC 4122 variant in byte 8.
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;

  const hex = hash.toString('hex');
  return (
    `${hex.substring(0, 8)}-${hex.substring(8, 12)}-` +
    `${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`
  );
}

function namespaceBytes(uuid: string): Buffer {
  return Buffer.from(uuid.replace(/-/g, ''), 'hex');
}
