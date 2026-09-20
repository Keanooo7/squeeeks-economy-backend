// functions/src/__tests__/helpers/sourceText.ts
//
// Reading source in a test, without the source's own comments answering you.
//
// ---------------------------------------------------------------------------
// CRITICAL: WHY THIS EXISTS
// ---------------------------------------------------------------------------
//
// W2-27: a guard in galleryFeedback.test.ts asserted the feedback export shared
// `SEED_OPTS` with the write endpoints. The export stopped sharing it. THE GUARD
// KEPT PASSING — because the handler body still contained the string
// `SEED_OPTS` in a COMMENT, and still contained `x-seed-secret` inside the
// sentence saying THE ENDPOINT NO LONGER ACCEPTS IT.
//
// The assertion was satisfied by prose describing its own negation.
//
// That is not a quirk of one test. It is structural: this codebase writes long
// explanatory comments, and a comment about a thing contains the name of the
// thing. The more carefully a change is documented, the more likely its own
// documentation satisfies the grep that was meant to police it.
//
// ---------------------------------------------------------------------------
// WARNING: AND THE FIX IS NOT "STRIP EVERYTHING" — THAT IS THE OPPOSITE MISTAKE
// ---------------------------------------------------------------------------
//
// Some assertions are ABOUT the comments, deliberately. floorExitCodes asserts
// that check-test-floor.cjs documents its exit-code contract. replayKey asserts
// that the migration order is written down. Those must read raw text; stripping
// them makes them vacuous — they would pass against a file with no
// documentation at all, which is the exact thing they exist to prevent.
//
//   stripping a DOC assertion   -> vacuous: it can no longer fail
//   not stripping a CODE one    -> satisfiable by prose
//
// Both are lies, in opposite directions. So this module offers BOTH, named, and
// the caller states which kind each assertion is:
//
//   codeOf(src)  — comments removed. For "the code does X".
//   src          — raw. For "the file DOCUMENTS X".
//
// NOTE: A `.not.toContain()` guard cannot be falsely GREEN from a comment — it can
// be falsely RED. economyIdempotency asserts index.ts contains no
// /rateLimit|throttle|appCheck/i, while its own comments discuss rate limiting
// at length; it passes only because they say "rate-limit" hyphenated. It
// survived on spelling. Stripping removes the coincidence, so this helps both
// polarities and not only the one that found it.

/** Line comments, block comments, and nothing else. */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /^\s*\/\/.*$/gm;

/**
 * [src] with comments removed, for assertions about what the code DOES.
 *
 * WARNING: Regex, not a parser. A `//` inside a string literal — a URL, say — would be
 * mangled. No file this is used against contains one, and a test helper is the
 * wrong place for a TypeScript parser. If a future caller reads a file with URLs
 * in strings, that is the moment to reach for something real rather than to
 * widen this quietly.
 */
export function codeOf(src: string): string {
  return src.replace(BLOCK_COMMENT, '').replace(LINE_COMMENT, '');
}

/**
 * The body of a top-level `export const NAME = …(` declaration, sliced at the
 * first column-0 `});`.
 *
 * KEY: SLICING TO THE NEXT `export const` IS WRONG AND WAS DONE TWICE THIS
 * SESSION: it runs PAST the handler into whatever helper sits between, so the
 * test asserts about a different function while passing for the wrong reason.
 * An onCall/onRequest handler ends at `\n});` in column 0.
 *
 * Returns the RAW slice, comments included — call [codeOf] on it for a code
 * assertion. Kept raw here so a caller asserting the handler is DOCUMENTED can
 * still do so.
 */
export function handlerBody(src: string, exportName: string): string {
  const start = src.indexOf(`export const ${exportName}`);
  if (start === -1) {
    throw new Error(
      `handlerBody: no "export const ${exportName}" in source. ` +
        'A guard that cannot find its subject must fail loudly rather than ' +
        'assert against an empty string, which would pass every not.toContain.',
    );
  }
  const end = src.indexOf('\n});', start);
  if (end === -1) {
    throw new Error(
      `handlerBody: no column-0 "});" after "export const ${exportName}".`,
    );
  }
  return src.slice(start, end + 4);
}
