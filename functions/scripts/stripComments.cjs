// functions/scripts/stripComments.cjs
//
// W2-142 · THE one comment stripper. Every gate that reads `index.ts` as text
// uses this and only this.
//
// 🔴 THREE COPIES OF A BROKEN STRIPPER EXISTED BEFORE THIS FILE.
// `collectionGroupIndexes.test.ts`, `deployedFunctions.test.ts` and
// `check-deployed.cjs` each carried the same two chained regex replaces — a
// non-greedy block-comment matcher, then a line-comment matcher — and all three
// were wrong the same way.
//
// ⚠️ WHY BLOCK-COMMENTS-FIRST IS WRONG. A slash and an asterisk adjacent inside
// a LINE comment open a block that runs to the next closing delimiter anywhere
// below. Writing a glob path in prose above the streak query deleted that query
// and 100 lines under it — every `collectionGroup(` in the file went 5 to 0 —
// and independently dropped `sendDailyGiftReminder` from the export count,
// 46 to 45. One prose character, two gates, in opposite parts of the file.
//
// ⚠️ WHY LINE-COMMENTS-FIRST IS ALSO WRONG. It moves the wound: the line-comment
// pass then truncates any string containing a double slash, so a `'https://…'`
// literal swallows the rest of its line.
//
// ✅ No regex can do this, because whether a delimiter opens a comment depends
// on state a regex does not carry. This is a left-to-right scanner over the four
// states source can be in — code, '…', "…", `…` — that opens a comment only
// while in code.
//
// 📌 THIS IS CJS ON PURPOSE. `check-deployed.cjs` cannot import from `src/`: it
// reads `lib/`, the built output, and runs before jest ever does. Making the
// canonical copy CommonJS lets the script and the TypeScript gates share ONE
// implementation instead of a "deliberate second copy" that drifts. The TS side
// re-exports it from `src/__tests__/support/stripComments.ts`.
//
// 📌 THE LIMIT, so it is not mistaken for a lexer: a regex literal containing an
// unpaired quote would be read as opening a string. `index.ts` has none, and
// `support/stripComments.test.ts` pins that. If one ever appears, the answer is
// the TypeScript compiler API, not another special case here.

/**
 * @param {string} src
 * @returns {string}
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        const closed = src[i] === quote;
        i++;
        if (closed) break;
      }
      continue;
    }

    out += c;
    i++;
  }
  return out;
}

module.exports = {stripComments};
