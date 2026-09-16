// functions/src/__tests__/rulesNoCatchAll.test.ts
//
// W2-20. The protection on `users/{uid}/shieldPurchases/{id}` is the ABSENCE of
// a rule: Firestore default-denies anything no `match` block reaches.
//
// 🔴 AN ABSENCE IS WHAT A WELL-MEANING CHANGE DELETES. Someone adding a
// convenience `match /users/{uid}/{doc=**}` to fix an unrelated read would
// silently open EVERY unmatched path under a user — including the replay ledger
// whose whole job is to stop a second charge. Nothing would fail. The app would
// work better, right up until someone deleted a ledger row and re-bought.
//
// So this is the inverse of the argument from W2-17: a wildcard you have not
// tested at the path you rely on is a wildcard you believe in — and a
// DEFAULT-DENY you have not tested at the path you rely on is a default-deny you
// believe in.
//
// ---------------------------------------------------------------------------
// 📌 WHY THIS LIVES IN THE UNIT SUITE AND NOT THE RULES SUITE
// ---------------------------------------------------------------------------
//
// The behavioural proof — that a client genuinely cannot touch the ledger — is
// in firestore-rules.test.ts, against the emulator, and it is the stronger
// test. But that suite needs JDK 21, is routinely environment-blocked on this
// machine (`floor: rules: the emulator refused to start`), and its floor
// checker reports that as ENVIRONMENT rather than a failure — correctly, but it
// means a run can be skipped without anything going red.
//
// A guard whose whole purpose is to catch a careless edit must not live behind
// a gate that is sometimes not run. This one is pure text over firestore.rules
// and runs on every `npm test`.

import * as fs from 'fs';
import * as path from 'path';
import {codeOf} from './helpers/sourceText';

const RULES = fs.readFileSync(
  path.join(__dirname, '..', '..', '..', 'firestore.rules'),
  'utf8',
);

/** Strips `//` and `/* *​/` comments, so a wildcard in prose is not a match. */
function code(): string {
  return codeOf(RULES);
}

describe('the rules file is the file we think it is', () => {
  // A guard that read the wrong file, or an empty one, would pass everything.
  test('firestore.rules was actually found and has content', () => {
    expect(RULES.length).toBeGreaterThan(1000);
    expect(RULES).toContain('rules_version');
    expect(RULES).toContain('service cloud.firestore');
  });

  test('it contains the blocks this suite reasons about', () => {
    expect(code()).toContain('match /chestPurchases/{purchaseId}');
  });
});

describe('🔴 no catch-all match may exist — it would open every unmatched path', () => {
  test('there is no global `match /{document=**}`', () => {
    // The classic one, straight out of the Firestore quickstart. In an app whose
    // security model is "Cloud Functions write, clients read some things", this
    // single line would undo most of firestore.rules.
    expect(code()).not.toMatch(/match\s+\/\{[A-Za-z_]+=\*\*\}/);
  });

  test('there is no per-user catch-all under users/{uid}', () => {
    // The subtler one, and the likelier one: someone fixing a read they need.
    // It would reach shieldPurchases, which has no block of its own.
    expect(code()).not.toMatch(/match\s+\/users\/\{[A-Za-z_]+\}\/\{[A-Za-z_]+=\*\*\}/);
  });

  test('every recursive wildcard that DOES exist is on a named collection', () => {
    // `match /economy/{doc=**}` is fine — it names a collection and everything
    // under it is server-owned. A `{doc=**}` directly under a user is not.
    const recursive = [...code().matchAll(/match\s+(\/[^\s{]*)\/\{[A-Za-z_]+=\*\*\}/g)];
    expect(recursive.length).toBeGreaterThan(0); // the check must not pass vacuously
    for (const m of recursive) {
      // The segment before the wildcard must be a literal name, not a variable.
      expect(m[1]).not.toMatch(/\}$/);
    }
  });
});

describe('the two replay ledgers are protected by DIFFERENT mechanisms', () => {
  // 📌 Found while verifying this brief's premise, and worth recording because
  // it is invisible: chestPurchases has an explicit block, shieldPurchases has
  // none. Both are deny-write. They differ on READ — a client may read its own
  // chest purchases and may NOT read its own shield purchases.
  //
  // Not a defect today: nothing client-side reads either. But if W1 ever builds
  // a purchase history, one will work and one will silently return nothing.
  test('chestPurchases is protected by an explicit deny-write block', () => {
    const block = code().slice(code().indexOf('match /chestPurchases/{purchaseId}'));
    expect(block.slice(0, 200)).toContain('allow write: if false');
  });

  test('shieldPurchases is protected by the absence of any block', () => {
    // ⚠️ If this ever fails, someone has ADDED a block. That may be fine, but it
    // changes the mechanism from "unreachable" to "reachable and refused", and
    // a block that restates default-deny is a block someone can later loosen.
    // The brief's instruction was explicit: pin the behaviour, do not codify a
    // permission.
    expect(code()).not.toContain('shieldPurchases');
  });

  test('the asymmetry is on READ, and is recorded here rather than discovered', () => {
    // Stated as an assertion so the difference cannot quietly become uniform in
    // either direction without someone reading this comment.
    const c = code();
    const chestBlock = c.slice(c.indexOf('match /chestPurchases/{purchaseId}'), c.indexOf('match /chestPurchases/{purchaseId}') + 200);
    expect(chestBlock).toContain('allow read: if isAuthenticated() && isOwner(uid)');
    expect(c).not.toContain('shieldPurchases');
  });
});
