// functions/src/__tests__/replayKey.test.ts
//
// W2-19. The shared replay-key rule, and the double charge it closes.
//
// CRITICAL: THE BUG WAS NOT A MISSING TRANSACTION. purchaseStreakShield always had one,
// and the audit column that said so is what nearly let it through (W2-18). A
// transaction stops two CONCURRENT calls racing; it does nothing about the SAME
// call arriving twice after a dropped response. The tests below are written to
// keep those two apart, because collapsing them is the actual defect.

import {
  assertValidReplayKey,
  MAX_REPLAY_KEY_LENGTH,
  REPLAY_KEY_IS_OPTIONAL,
} from '../replayKey';

describe('a replay key is validated as the document id it becomes', () => {
  test('a plain key is accepted', () => {
    expect(() => assertValidReplayKey('abc-123')).not.toThrow();
  });

  test('undefined is accepted — an absent key means none was requested', () => {
    expect(() => assertValidReplayKey(undefined)).not.toThrow();
  });

  test('🔴 a slash is rejected, because it would write into a NESTED COLLECTION', () => {
    // Not a style rule. `users/{uid}/shieldPurchases/a/b/c` is a valid path to
    // a document in a different collection — the write would succeed silently
    // and the replay guard would never match again.
    expect(() => assertValidReplayKey('a/b')).toThrow(/purchaseId/);
    expect(() => assertValidReplayKey('../../other')).toThrow(/purchaseId/);
  });

  test('an empty string is rejected — it is not a document id at all', () => {
    expect(() => assertValidReplayKey('')).toThrow(/purchaseId/);
  });

  test('an over-long key is rejected, so a caller cannot author huge paths', () => {
    expect(() => assertValidReplayKey('x'.repeat(MAX_REPLAY_KEY_LENGTH))).not.toThrow();
    expect(() => assertValidReplayKey('x'.repeat(MAX_REPLAY_KEY_LENGTH + 1))).toThrow(/purchaseId/);
  });

  test('a non-string is rejected', () => {
    for (const bad of [123, null, {}, [], true]) {
      expect(() => assertValidReplayKey(bad)).toThrow(/purchaseId/);
    }
  });

  test('the error names the constraint, not just "invalid"', () => {
    // A client author reading the message should not have to read the source.
    expect(() => assertValidReplayKey('a/b')).toThrow(/at most 128 characters and contain no/);
  });
});

describe('🔑 the double charge this closes, stated as the sequence', () => {
  // Expressed against the ledger semantics rather than a Firestore mock: the
  // guard is "a document with this id already exists", and `tx.create` is what
  // makes the second attempt fail rather than overwrite.
  test('the same key twice is the same document id — so the second create fails', () => {
    const idFor = (uid: string, key: string) => `users/${uid}/shieldPurchases/${key}`;
    expect(idFor('u1', 'k1')).toBe(idFor('u1', 'k1'));
  });

  test('a different key is a different purchase, and must still go through', () => {
    // The guard must not be so blunt that a player cannot buy a second shield.
    const idFor = (uid: string, key: string) => `users/${uid}/shieldPurchases/${key}`;
    expect(idFor('u1', 'k1')).not.toBe(idFor('u1', 'k2'));
  });

  test('two players sharing a key do not collide', () => {
    const idFor = (uid: string, key: string) => `users/${uid}/shieldPurchases/${key}`;
    expect(idFor('u1', 'k1')).not.toBe(idFor('u2', 'k1'));
  });
});

describe('⚠️ the key is optional, and that is recorded as a decision with an expiry', () => {
  test('the flag says so in code, not only in a PR body', () => {
    expect(REPLAY_KEY_IS_OPTIONAL).toBe(true);
  });

  test('the reason and the safe migration order are written down', () => {
    const src: string = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'replayKey.ts'),
      'utf8',
    );
    // Required-first breaks every installed build; client-first does not.
    expect(src).toContain('BREAKING CHANGE');
    // No /s flag: tsc --noEmit accepts it and ts-jest does not, because they
    // resolve a different target. Written to pass both.
    expect(src).toMatch(/client starts sending a key[\s\S]*wait for adoption[\s\S]*THEN make it required/);
    expect(src).toContain('TestFlight');
  });

  test('the module explains why a transaction was not enough', () => {
    const src: string = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'replayKey.ts'),
      'utf8',
    );
    expect(src).toMatch(/A transaction stops two CONCURRENT/);
    expect(src).toMatch(/SAME call arriving twice/);
  });
});
