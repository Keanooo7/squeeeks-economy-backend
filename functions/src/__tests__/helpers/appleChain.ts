// functions/src/__tests__/helpers/appleChain.ts
//
// A generated Apple-shaped certificate chain, and a signer for it.
//
// KEY: WHY THIS EXISTS SEPARATELY FROM `appleJws.test.ts`, WHICH HAS ITS OWN COPY.
//
// `appleJws.test.ts` is the ground truth for the cryptography: it is the one
// place that asserts a tampered payload is rejected, that a foreign chain is
// rejected, and that a transaction for another app is rejected. A test that
// vouches for the verifier must not share its fixture builder with the tests
// that lean on the verifier being sound — if this file ever minted a subtly
// wrong chain, a shared builder would move both the ground truth and the thing
// it grounds at once, and the pair would still agree with each other.
//
// So the duplication is deliberate and one-directional: `appleJws.test.ts` is
// left alone, and everything that needs a REAL signed JWS for a reason other
// than testing the signature comes here.
//
// WARNING: THIS IS NOT A STUB. The chain is real, the signature is real, and
// `makeVerify([rootDer], BUNDLE_ID)` is the shipped verifier with one input
// changed — the trust anchor. Nothing about the JWS parsing, the chain walk,
// the environment retry or the payload normalisation is bypassed.

import {generateKeyPairSync} from 'crypto';

import * as jsrsasign from 'jsrsasign';
import * as jwt from 'jsonwebtoken';

/**
 * The two Apple-specific extension OIDs `SignedDataVerifier` requires. Omit
 * either and the library rejects the chain before it ever reads the payload.
 */
const APPLE_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';
const APPLE_LEAF_OID = '1.2.840.113635.100.6.11.1';

interface KeyPair {
  /** PKCS#8 PEM. */
  prv: string;
  /** SPKI PEM. */
  pub: string;
}

/**
 * Node's native P-256 generator, NOT `KEYUTIL.generateKeypair`.
 *
 * KEY: jsrsasign generates keys with pure-JS bignum arithmetic, which cost 2603 ms
 * of suite wall time when `appleJws.test.ts` used it (measured with `--cpu-prof`
 * in W2-143). Native does the same work in single-digit milliseconds. Only key
 * GENERATION moved — the certificates below still get their signatures from
 * jsrsasign, because node's crypto cannot mint an x509 cert carrying Apple's
 * extension OIDs.
 */
function keypair(): KeyPair {
  const {privateKey, publicKey} = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
    publicKeyEncoding: {type: 'spki', format: 'pem'},
    privateKeyEncoding: {type: 'pkcs8', format: 'pem'},
  });
  return {prv: privateKey, pub: publicKey};
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
  if (opts.ca) ext.push({extname: 'basicConstraints', cA: true, critical: true});
  // The verifier only checks that the extension is PRESENT, so a DER NULL
  // (0500) is a sufficient value.
  if (opts.extOid) ext.push({extname: opts.extOid, extn: '0500'});

  return new jsrsasign.KJUR.asn1.x509.Certificate({
    version: 3,
    serial: {int: opts.subject.length + 1000},
    issuer: {str: opts.issuer},
    notbefore: '200101000000Z',
    notafter: '350101000000Z',
    subject: {str: opts.subject},
    sbjpubkey: opts.subjectPub,
    ext,
    sigalg: 'SHA256withECDSA',
    cakey: opts.issuerPrv,
  } as never).getPEM();
}

function der(pem: string): Buffer {
  return Buffer.from(
    pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, ''),
    'base64',
  );
}

export interface AppleChain {
  /** The trust anchor to hand `makeVerify`. */
  rootDer: Buffer;
  /** leaf, intermediate, root — base64 DER, in the order Apple sends them. */
  x5c: string[];
  /** PKCS#8 PEM for the leaf, for `jwt.sign`. */
  leafPrvPem: string;
}

/** A freshly generated, self-consistent root → intermediate → leaf chain. */
export function buildChain(): AppleChain {
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
    x5c: [leafPem, intermediatePem, rootPem].map((p) =>
      der(p).toString('base64'),
    ),
    leafPrvPem: leaf.prv,
  };
}

/**
 * Signs a StoreKit 2 transaction payload with the chain's leaf key.
 *
 * WARNING: `noTimestamp: true` — `jsonwebtoken` would otherwise add an `iat` claim
 * Apple does not send, and the payload is asserted on by shape elsewhere.
 */
export function signTransactionJws(
  payload: Record<string, unknown>,
  chain: AppleChain,
): string {
  return jwt.sign(payload, chain.leafPrvPem, {
    algorithm: 'ES256',
    header: {alg: 'ES256', x5c: chain.x5c},
    noTimestamp: true,
  });
}
