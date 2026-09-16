// functions/src/__tests__/appleJws.test.ts
//
// The one place the REAL cryptography runs. Everything else drives the
// callables through the `appleJws.verify` seam with an already-decoded payload,
// so if this file stubbed anything out the signature check would be untested
// everywhere at once.
//
// A root -> intermediate -> leaf EC chain is generated here at runtime and a JWS
// is signed with the leaf key. Nothing is committed: no fixture certificates, no
// private keys in the repo. The chain carries the two Apple-specific extension
// OIDs that SignedDataVerifier requires (1.2.840.113635.100.6.2.1 on the
// intermediate, 1.2.840.113635.100.6.11.1 on the leaf) — omit either and the
// library rejects the chain, which is itself worth knowing.

import { generateKeyPairSync } from 'crypto';

import * as jsrsasign from 'jsrsasign';
import * as jwt from 'jsonwebtoken';
import { makeVerify, makeVerifyNotification, BUNDLE_ID, APP_APPLE_ID } from '../appleJws';

const APPLE_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';
const APPLE_LEAF_OID = '1.2.840.113635.100.6.11.1';

const SIGNED_MS = Date.UTC(2026, 0, 1);

interface KeyPair {
  /** PKCS#8 PEM. */
  prv: string;
  /** SPKI PEM. */
  pub: string;
}

/**
 * Node's native P-256 generator, NOT `KEYUTIL.generateKeypair`.
 *
 * 🔑 jsrsasign generates keys with pure-JS bignum arithmetic. This file builds
 * six keypairs at module scope and that cost **2603 ms** of the suite's wall
 * time, measured with `--cpu-prof` in W2-143 (`am1`, its multiply-accumulate
 * core, was 60.9% of the whole profile). Native does the same six in ~6 ms.
 *
 * ⚠️ The certificates below still get their SIGNATURES from jsrsasign and that
 * cannot move — they carry Apple's two extension OIDs and node's crypto cannot
 * mint an x509 cert. Only key GENERATION moved.
 *
 * The PEMs are interchangeable with that signing path: `prime256v1` and
 * `secp256r1` are the same curve, jsrsasign accepts SPKI/PKCS#8 PEM for
 * `sbjpubkey` and `cakey`, and `jsonwebtoken` signs ES256 straight from the
 * PKCS#8 PEM — so `leafPrvPem` no longer needs a `KEYUTIL.getPEM` conversion.
 */
function keypair(): KeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { prv: privateKey, pub: publicKey };
}

function makeCert(opts: {
  subject: string;
  issuer: string;
  subjectPub: KeyPair['pub'];
  issuerPrv: KeyPair['prv'];
  ca?: boolean;
  extOid?: string;
}): string {
  const ext: Record<string, unknown>[] = [];
  if (opts.ca) ext.push({ extname: 'basicConstraints', cA: true, critical: true });
  // The verifier only checks that the extension is PRESENT, so a DER NULL (0500)
  // is a sufficient value.
  if (opts.extOid) ext.push({ extname: opts.extOid, extn: '0500' });

  return new jsrsasign.KJUR.asn1.x509.Certificate({
    version: 3,
    serial: { int: opts.subject.length + 1000 },
    issuer: { str: opts.issuer },
    notbefore: '200101000000Z',
    notafter: '350101000000Z',
    subject: { str: opts.subject },
    sbjpubkey: opts.subjectPub,
    ext,
    sigalg: 'SHA256withECDSA',
    cakey: opts.issuerPrv,
  } as never).getPEM();
}

function der(pem: string): Buffer {
  return Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''), 'base64');
}

/** A freshly generated, self-consistent chain plus the leaf signing key. */
function buildChain() {
  const root = keypair();
  const intermediate = keypair();
  const leaf = keypair();

  const rootPem = makeCert({
    subject: '/CN=TestRoot',
    issuer: '/CN=TestRoot',
    subjectPub: root.pub,
    issuerPrv: root.prv,
    ca: true,
  });
  const intermediatePem = makeCert({
    subject: '/CN=TestIntermediate',
    issuer: '/CN=TestRoot',
    subjectPub: intermediate.pub,
    issuerPrv: root.prv,
    ca: true,
    extOid: APPLE_INTERMEDIATE_OID,
  });
  const leafPem = makeCert({
    subject: '/CN=TestLeaf',
    issuer: '/CN=TestIntermediate',
    subjectPub: leaf.pub,
    issuerPrv: intermediate.prv,
    extOid: APPLE_LEAF_OID,
  });

  return {
    rootDer: der(rootPem),
    x5c: [leafPem, intermediatePem, rootPem].map((p) => der(p).toString('base64')),
    leafPrvPem: leaf.prv,
  };
}

const CHAIN = buildChain();
// A second, unrelated chain — its leaf signs validly but chains to a root the
// verifier does not trust.
const FOREIGN = buildChain();

function payloadFor(overrides: Record<string, unknown> = {}) {
  return {
    transactionId: 'tx-1',
    productId: 'sponge_pack_100',
    bundleId: BUNDLE_ID,
    purchaseDate: SIGNED_MS,
    signedDate: SIGNED_MS,
    environment: 'Sandbox',
    type: 'Consumable',
    inAppOwnershipType: 'PURCHASED',
    ...overrides,
  };
}

function signJws(
  payload: Record<string, unknown>,
  chain: ReturnType<typeof buildChain> = CHAIN,
): string {
  return jwt.sign(payload, chain.leafPrvPem, {
    algorithm: 'ES256',
    header: { alg: 'ES256', x5c: chain.x5c },
    noTimestamp: true,
  });
}

const verify = makeVerify([CHAIN.rootDer], BUNDLE_ID);

describe('appleJws — real signature verification', () => {
  test('a well-formed JWS verifies and normalises the transaction', async () => {
    const result = await verify(
      signJws(
        payloadFor({
          transactionId: 'tx-real',
          appAccountToken: 'dab16d5c-6fc1-5338-a7c8-ab04e765232b',
        }),
      ),
    );

    // 2026-08-14 — `originalTransactionId` and `revocationDateMs` were added to
    // AppleTransaction for the notification endpoint. An exact-shape assertion
    // is the point of this test, so it gains the two keys rather than loosening
    // to a subset match: both are absent from THIS payload and both must
    // normalise to null rather than to undefined.
    expect(result).toEqual({
      transactionId: 'tx-real',
      productId: 'sponge_pack_100',
      originalTransactionId: null,
      purchaseDateMs: SIGNED_MS,
      expiresDateMs: null,
      revocationDateMs: null,
      appAccountToken: 'dab16d5c-6fc1-5338-a7c8-ab04e765232b',
    });
  });

  test('a subscription transaction carries its real expiry', async () => {
    const expires = SIGNED_MS + 30 * 24 * 3600 * 1000;
    const result = await verify(
      signJws(payloadFor({ productId: 'sub_pro_monthly', expiresDate: expires, type: 'Auto-Renewable Subscription' })),
    );

    expect(result.expiresDateMs).toBe(expires);
  });

  test('an unstamped (legacy) transaction reports a null token, not a missing key', async () => {
    // The compatibility case the ROLLOUT_EPOCH rule in index.ts exists for.
    const result = await verify(signJws(payloadFor()));
    expect(result.appAccountToken).toBeNull();
  });

  test('a PRODUCTION transaction verifies once APP_APPLE_ID is configured', async () => {
    // The App Store path, proven working ahead of the value being known — so
    // filling in APP_APPLE_ID is a one-line change and not a leap of faith.
    const withAppleId = makeVerify([CHAIN.rootDer], BUNDLE_ID, 1234567890);
    const result = await withAppleId(
      signJws(payloadFor({ environment: 'Production', transactionId: 'tx-prod' })),
    );
    expect(result.transactionId).toBe('tx-prod');
  });

  test('a SANDBOX transaction still verifies when APP_APPLE_ID is configured', async () => {
    // The Production-then-Sandbox fallback: the Production verifier raises
    // INVALID_ENVIRONMENT and the Sandbox one then accepts it.
    const withAppleId = makeVerify([CHAIN.rootDer], BUNDLE_ID, 1234567890);
    const result = await withAppleId(signJws(payloadFor({ transactionId: 'tx-sandbox' })));
    expect(result.transactionId).toBe('tx-sandbox');
  });

  test('with appAppleId null, a PRODUCTION transaction is refused', async () => {
    // The failure mode that shipping without the id used to have, kept as a
    // regression lock now that APP_APPLE_ID is set: a Production verifier cannot
    // be CONSTRUCTED without appAppleId (it throws in the constructor, despite
    // the field being optional in the type signature).
    //
    // ⚠️ The null is passed EXPLICITLY. This test used to drive the shared
    // `verify` above and so depended, silently, on the module constant still
    // being null — filling APP_APPLE_ID in turned it red. What it means to
    // assert is "a null appAppleId refuses Production", which is what it now
    // says.
    const withoutAppleId = makeVerify([CHAIN.rootDer], BUNDLE_ID, null);
    await expect(
      withoutAppleId(signJws(payloadFor({ environment: 'Production' }))),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('APP_APPLE_ID is set to a number, not null', () => {
    // The guard against a silent revert. While this was null the Production
    // verifier was disabled entirely and only Sandbox/TestFlight worked, which
    // is invisible until App Store release day.
    expect(typeof APP_APPLE_ID).toBe('number');
    expect(APP_APPLE_ID).toBe(6797102615);
  });

  test('SECURITY: a tampered payload is rejected', async () => {
    // The exact attack the whole module exists to stop: keep Apple's signature
    // and header, swap the cheap product for the expensive one.
    const good = signJws(payloadFor({ productId: 'sponge_pack_100' }));
    const [header, , signature] = good.split('.');
    const forged = Buffer.from(
      JSON.stringify(payloadFor({ productId: 'sponge_pack_1200' })),
    ).toString('base64url');

    await expect(verify([header, forged, signature].join('.'))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  test('SECURITY: a validly signed JWS from an untrusted chain is rejected', async () => {
    // Self-signing your own chain must not be enough — this is the difference
    // between "the signature is internally consistent" and "Apple signed it".
    await expect(verify(signJws(payloadFor(), FOREIGN))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  test('SECURITY: a transaction for another app is rejected', async () => {
    await expect(
      verify(signJws(payloadFor({ bundleId: 'com.someone.else' }))),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('a JWS with a short certificate chain is rejected', async () => {
    const short = jwt.sign(payloadFor(), CHAIN.leafPrvPem, {
      algorithm: 'ES256',
      header: { alg: 'ES256', x5c: CHAIN.x5c.slice(0, 2) },
      noTimestamp: true,
    });

    await expect(verify(short)).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('a transaction missing its id fails closed rather than being granted', async () => {
    // Granting without a stable idempotency key would make the purchase
    // infinitely replayable — strictly worse than an error the client retries.
    // Every field here is Apple-signed, so this is a fail-closed assertion about
    // Apple's own output, not validation of client input.
    const noId = payloadFor();
    delete (noId as Record<string, unknown>).transactionId;

    await expect(verify(signJws(noId))).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('garbage and empty input are rejected rather than throwing raw', async () => {
    await expect(verify('not-a-jws')).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(verify('')).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('a misconfigured server fails closed, and says so distinctly', async () => {
    // Replaces the old APPLE_SHARED_SECRET guard. The distinct code matters:
    // 'failed-precondition' means the server is broken, 'invalid-argument'
    // means the user's purchase is. Conflating them is what made a
    // misconfigured server look like a user with a bad receipt for days.
    const unconfigured = makeVerify([], BUNDLE_ID);
    await expect(unconfigured(signJws(payloadFor()))).rejects.toMatchObject({
      code: 'failed-precondition',
    });

    const noBundle = makeVerify([CHAIN.rootDer], '');
    await expect(noBundle(signJws(payloadFor()))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
});

// ---------------------------------------------------------------------------
// App Store Server Notifications V2
//
// 🔑 A notification is a DIFFERENT JWS SHAPE from a transaction, and that is
// the reason `makeVerifyNotification` exists rather than the endpoint reusing
// `verify`. The envelope carries the bundle id, app id and environment in a
// `data` block instead of on a transaction, and `verifyAndDecodeTransaction`
// cannot parse it — the brief for this endpoint described appleJws.ts as
// already able to verify Apple's signed payload, which is true of the payload
// the CLIENT sends and false of this one.
//
// The inner `signedTransactionInfo` is a nested JWS, verified separately. These
// tests run the REAL cryptography over both layers against the same generated
// chain the transaction tests use.
// ---------------------------------------------------------------------------

function notificationPayloadFor(overrides: Record<string, unknown> = {}) {
  const {
    transaction: transactionOverrides,
    data: dataOverrides,
    ...rest
  } = overrides as Record<string, any>;

  const signedTransactionInfo = signJws(
    payloadFor({
      productId: 'sub_pro_monthly',
      transactionId: 'tx-renewal-2',
      originalTransactionId: 'tx-original-1',
      expiresDate: SIGNED_MS + 30 * 24 * 3600 * 1000,
      type: 'Auto-Renewable Subscription',
      ...(transactionOverrides ?? {}),
    }),
  );

  return {
    notificationType: 'DID_RENEW',
    notificationUUID: 'uuid-1',
    version: '2.0',
    signedDate: SIGNED_MS,
    data: {
      bundleId: BUNDLE_ID,
      environment: 'Sandbox',
      signedTransactionInfo,
      ...(dataOverrides ?? {}),
    },
    ...rest,
  };
}

const verifyNotification = makeVerifyNotification([CHAIN.rootDer], BUNDLE_ID);

describe('appleJws — notification verification', () => {
  test('a well-formed notification verifies and normalises both layers', async () => {
    const result = await verifyNotification(signJws(notificationPayloadFor()));

    expect(result).toEqual({
      notificationType: 'DID_RENEW',
      subtype: null,
      notificationUUID: 'uuid-1',
      signedDateMs: SIGNED_MS,
      transaction: {
        transactionId: 'tx-renewal-2',
        productId: 'sub_pro_monthly',
        originalTransactionId: 'tx-original-1',
        purchaseDateMs: SIGNED_MS,
        expiresDateMs: SIGNED_MS + 30 * 24 * 3600 * 1000,
        revocationDateMs: null,
        appAccountToken: null,
      },
    });
  });

  test('the renewal transaction id differs from the original, and both survive', async () => {
    // The single fact the owner index depends on. If these collapsed to one
    // value, either every renewal would be unattributable or the index would be
    // rewritten on every rebill.
    const result = await verifyNotification(signJws(notificationPayloadFor()));
    expect(result.transaction!.transactionId).toBe('tx-renewal-2');
    expect(result.transaction!.originalTransactionId).toBe('tx-original-1');
  });

  test('a REFUND carries the revocation date through', async () => {
    const revoked = SIGNED_MS + 3 * 24 * 3600 * 1000;
    const result = await verifyNotification(
      signJws(
        notificationPayloadFor({
          notificationType: 'REFUND',
          transaction: { revocationDate: revoked },
        }),
      ),
    );
    expect(result.transaction!.revocationDateMs).toBe(revoked);
  });

  test('a notification signed by an UNTRUSTED chain is rejected', async () => {
    // The endpoint is unauthenticated by construction — Apple publishes no
    // shared secret and no source IP range — so this signature check IS the
    // authentication. A forged renewal that verified here would grant Pro to
    // anyone who could POST.
    const forged = jwt.sign(notificationPayloadFor(), FOREIGN.leafPrvPem, {
      algorithm: 'ES256',
      header: { alg: 'ES256', x5c: FOREIGN.x5c },
      noTimestamp: true,
    });

    await expect(verifyNotification(forged)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  test('a notification for ANOTHER app is rejected', async () => {
    await expect(
      verifyNotification(
        signJws(notificationPayloadFor({ data: { bundleId: 'com.someone.else' } })),
      ),
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('a notification with no notificationUUID fails closed', async () => {
    // Without it there is no idempotency key, and a replayed renewal is exactly
    // what the notification ledger exists to prevent.
    const noUuid = notificationPayloadFor();
    delete (noUuid as Record<string, unknown>).notificationUUID;

    await expect(verifyNotification(signJws(noUuid))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
  });

  test('a TEST notification carrying no transaction verifies, with a null transaction', async () => {
    // App Store Connect's "Request a Test Notification" button. It must not
    // read as malformed — it is the only proof the URL is wired before a real
    // purchase exists.
    const test = notificationPayloadFor({ notificationType: 'TEST' });
    delete ((test as any).data as Record<string, unknown>).signedTransactionInfo;

    const result = await verifyNotification(signJws(test));
    expect(result.notificationType).toBe('TEST');
    expect(result.transaction).toBeNull();
  });

  test('a PRODUCTION notification verifies once APP_APPLE_ID is configured', async () => {
    const withAppleId = makeVerifyNotification([CHAIN.rootDer], BUNDLE_ID, 1234567890);
    const result = await withAppleId(
      signJws(
        notificationPayloadFor({
          data: { environment: 'Production', appAppleId: 1234567890 },
          // The NESTED transaction must say Production too. It is verified with
          // the same verifier that accepted the envelope — deliberately, so a
          // Sandbox transaction can never be validated against Production trust
          // settings — so a fixture whose two layers disagree is rejected, and
          // correctly.
          transaction: { environment: 'Production' },
        }),
      ),
    );
    expect(result.notificationType).toBe('DID_RENEW');
  });

  test('a SANDBOX notification still verifies when APP_APPLE_ID is configured', async () => {
    // The Production-then-Sandbox retry, on the notification path this time:
    // the Production verifier raises INVALID_ENVIRONMENT and Sandbox accepts.
    const withAppleId = makeVerifyNotification([CHAIN.rootDer], BUNDLE_ID, 1234567890);
    const result = await withAppleId(signJws(notificationPayloadFor()));
    expect(result.notificationType).toBe('DID_RENEW');
  });

  test('garbage and empty input are rejected rather than throwing raw', async () => {
    await expect(verifyNotification('not-a-jws')).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(verifyNotification('')).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('a misconfigured server fails closed on notifications too, and says so distinctly', async () => {
    const unconfigured = makeVerifyNotification([], BUNDLE_ID);
    await expect(unconfigured(signJws(notificationPayloadFor()))).rejects.toMatchObject({
      code: 'failed-precondition',
    });
  });
});
