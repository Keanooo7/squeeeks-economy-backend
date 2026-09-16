/**
 * The credential-free half of `check-rules-deployed.cjs` (W2-98).
 *
 * 🔴 THE COMPARISON FAILS OPEN, WHICH IS WHY IT NEEDS A TEST MORE THAN THE
 * NETWORK HALF DOES. `check-rules-deployed` decides "is production running this
 * ruleset?" by comparing a normalised digest of both sides. If `normalise` ever
 * broke and returned '' — a greedy comment regex would do it in one character —
 * BOTH digests would still be equal, and the script would report `IN SYNC` for
 * every ruleset on earth, forever, with exit 0.
 *
 * That is the exact false reassurance the script was written to end, reproduced
 * inside the instrument. It cannot be caught by running the script (it looks
 * green), so it is caught here.
 *
 * Same split as `check-deployed.cjs` / `deployedFunctions.test.ts`: the half
 * needing credentials cannot be a jest test while CI is out of billing, so the
 * half that does not is gated in `npm test`.
 */
// 🔴 FORCE MODULE SCOPE — LOAD-BEARING, NOT STYLISTIC. Without one top-level
// `import`/`export` this file is a SCRIPT and its top-level `const compare`
// lands in the GLOBAL scope, where it can collide with another script test and
// take THIS ENTIRE SUITE out of the run with no failure reported. The long
// version of the argument is in `deployedRevision.test.ts`; the guard that
// makes it impossible to reintroduce is `testFilesAreModules.test.ts`.
// Do not delete this as an unused export.
export {};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const compare = require('../../scripts/check-rules-deployed.cjs') as {
  normalise: (s: string) => string;
  digest: (s: string) => string;
  matchPaths: (s: string) => string[];
  diffLists: (a: string[], b: string[]) => {onlyInFirst: string[]; onlyInSecond: string[]};
};

const {normalise, digest, matchPaths, diffLists} = compare;

/** A ruleset shaped like the real one, small enough to reason about. */
const RULES = `
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // A line comment naming a path that does not exist: /ghost/{id}
    function isOwner(uid) {
      return request.auth.uid == uid;
    }
    match /users/{uid} {
      allow read: if isOwner(uid);
      match /inventory/{itemId} {
        allow read, write: if isOwner(uid);
      }
    }
  }
}
`;

describe('normalise — the function whose failure mode is silent agreement', () => {
  it('🔴 does NOT collapse a real ruleset to nothing', () => {
    // The guard against failing open. Every other assertion in this file
    // passes vacuously if this one does not hold.
    const out = normalise(RULES);
    expect(out.length).toBeGreaterThan(80);
    expect(out).toContain('match /users/{uid}');
    expect(out).toContain('allow read, write: if isOwner(uid)');
  });

  it('ignores comments and layout, which is the whole point', () => {
    // The deployed copy is whatever was uploaded — comments and all. A checker
    // that cried wolf on a reflowed comment would be switched off in a week.
    const reflowed = RULES.replace('// A line comment naming a path that does not exist: /ghost/{id}', '')
      .replace(/\n/g, '\n\n')
      .replace('service cloud.firestore {', 'service cloud.firestore {\n// added later')
      .replace('/* nothing */', '');
    expect(digest(reflowed)).toBe(digest(RULES));
  });

  it('🔴 does NOT ignore a relaxed CONDITION — the drift that matters most', () => {
    // Same match blocks, one weaker rule. A path-only comparison calls this
    // identical; it is the difference between "only you can read your things"
    // and "anyone signed in can".
    const relaxed = RULES.replace(
      'allow read, write: if isOwner(uid);',
      'allow read, write: if request.auth != null;',
    );
    expect(relaxed).not.toBe(RULES);
    expect(digest(relaxed)).not.toBe(digest(RULES));
    // …and the match paths are genuinely unchanged, which is what makes the
    // digest rather than the path list the actual test.
    expect(matchPaths(relaxed)).toEqual(matchPaths(RULES));
  });

  it('strips a `//` inside a block comment rather than treating it as a line comment', () => {
    // Block comments are removed before line comments for this reason. Getting
    // the order wrong eats the rest of the line after the inner `//` and
    // silently changes the digest of any file containing a URL in a comment.
    const withUrl = RULES.replace(
      'function isOwner(uid) {',
      '/* see https://example.com/docs */\n    function isOwner(uid) {',
    );
    expect(digest(withUrl)).toBe(digest(RULES));
  });
});

describe('matchPaths — used to EXPLAIN a mismatch, not to find one', () => {
  it('finds every match block, including nested ones', () => {
    expect(matchPaths(RULES)).toEqual([
      '/databases/{database}/documents',
      '/users/{uid}',
      '/inventory/{itemId}',
    ]);
  });

  it('does not count a path that only appears inside a comment', () => {
    // `/ghost/{id}` is named in a comment above. A checker that reported it as
    // a deployed collection would invent drift out of prose.
    expect(matchPaths(RULES)).not.toContain('/ghost/{id}');
  });
});

describe('diffLists — which side is missing what', () => {
  it('names the block on main that production does not have', () => {
    // The real 2026-08-16 case: production was main minus /fridgeItems/{itemId}.
    const local = [...matchPaths(RULES), '/fridgeItems/{itemId}'];
    const live = matchPaths(RULES);
    expect(diffLists(local, live)).toEqual({
      onlyInFirst: ['/fridgeItems/{itemId}'],
      onlyInSecond: [],
    });
  });

  it('names a block production has that main does not — a possible console edit', () => {
    // The direction that decides whether deploying main would ERASE something.
    const local = matchPaths(RULES);
    const live = [...matchPaths(RULES), '/handEdited/{id}'];
    expect(diffLists(local, live)).toEqual({
      onlyInFirst: [],
      onlyInSecond: ['/handEdited/{id}'],
    });
  });
});
