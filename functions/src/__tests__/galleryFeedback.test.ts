// functions/src/__tests__/galleryFeedback.test.ts
//
// W2-23. Tester feedback storage and export.
//
// 🔑 The assertion this file exists for is `the tester's sentence survives
// exactly`. Everything else here — rects, colour indices, builds — is
// scaffolding around one string that someone typed on a phone, and a feedback
// tool that mangles it has failed at the only thing it does.

import {
  MAX_SUBMISSIONS_PER_DAY,
  validateSubmission,
  formatFeedbackReport,
  isValidRect,
  MAX_COMMENT_LENGTH,
  MAX_LASSOS_PER_SUBMISSION,
  FeedbackRecord,
} from '../galleryFeedback';
import {codeOf} from './helpers/sourceText';

const rect = (x = 0.1, y = 0.1, width = 0.2, height = 0.2) => ({x, y, width, height});

const submission = (over: Record<string, unknown> = {}) => ({
  specimenKey: 'Auth/Login/error',
  appVersion: '1.4.2+42',
  lassos: [{rect: rect(), colourIndex: 0, comment: 'The banner is behind the keyboard.'}],
  ...over,
});

const record = (over: Partial<FeedbackRecord> = {}): FeedbackRecord => ({
  uid: 'tester1',
  specimenKey: 'Auth/Login/error',
  appVersion: '1.4.2+42',
  submittedAtIso: '2026-08-12T20:00:00.000Z',
  lassos: [{rect: rect(), colourIndex: 0, comment: 'The banner is behind the keyboard.'}],
  ...over,
});

describe('normalised coordinates, never device pixels', () => {
  test('a sane unit rect is accepted', () => {
    expect(isValidRect(rect())).toBe(true);
    expect(isValidRect({x: 0, y: 0, width: 1, height: 1})).toBe(true);
  });

  test('🔴 a device-pixel rect is rejected, which is the point', () => {
    // A phone tester and a tablet tester must produce comparable regions. This
    // is what stops {x: 120, y: 340, width: 80, height: 20} being stored and
    // being unreadable a week later.
    expect(isValidRect({x: 120, y: 340, width: 80, height: 20})).toBe(false);
  });

  test('a rect running off the edge is rejected', () => {
    expect(isValidRect({x: 0.9, y: 0, width: 0.2, height: 0.1})).toBe(false);
    expect(isValidRect({x: -0.1, y: 0, width: 0.2, height: 0.1})).toBe(false);
  });

  test('a zero or negative size is rejected', () => {
    expect(isValidRect({x: 0.1, y: 0.1, width: 0, height: 0.1})).toBe(false);
    expect(isValidRect({x: 0.1, y: 0.1, width: -0.2, height: 0.1})).toBe(false);
  });

  test('NaN and Infinity are rejected — they survive a naive range check', () => {
    expect(isValidRect({x: NaN, y: 0.1, width: 0.2, height: 0.2})).toBe(false);
    expect(isValidRect({x: 0.1, y: 0.1, width: Infinity, height: 0.2})).toBe(false);
  });
});

describe('colour is an index, not a hex string', () => {
  test('an integer index is accepted', () => {
    expect(validateSubmission(submission()).ok).toBe(true);
  });

  test('🔑 a hex string is rejected', () => {
    // Storing '#FF00AA' would freeze a palette decision into user data: a later
    // palette change would silently reinterpret every comment ever filed.
    const bad = submission({lassos: [{rect: rect(), colourIndex: '#FF00AA', comment: 'x'}]});
    const v = validateSubmission(bad);
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/index, not a hex string/);
  });

  test('a negative or fractional index is rejected', () => {
    for (const c of [-1, 1.5]) {
      expect(validateSubmission(submission({lassos: [{rect: rect(), colourIndex: c, comment: 'x'}]})).ok).toBe(false);
    }
  });
});

describe('a comment with no build is unmoored', () => {
  test('appVersion is required', () => {
    const v = validateSubmission(submission({appVersion: undefined}));
    expect(v.ok).toBe(false);
    expect(v.reason).toMatch(/appVersion/);
  });

  test('the reason says WHY, so a client author can act on it', () => {
    expect(validateSubmission(submission({appVersion: ''})).reason).toMatch(/unmoored/);
  });
});

describe('what bounds a write from a stranger', () => {
  test('an over-long comment is rejected', () => {
    const long = 'x'.repeat(MAX_COMMENT_LENGTH + 1);
    expect(validateSubmission(submission({lassos: [{rect: rect(), colourIndex: 0, comment: long}]})).ok).toBe(false);
  });

  test('a comment exactly at the limit is accepted', () => {
    const atLimit = 'x'.repeat(MAX_COMMENT_LENGTH);
    expect(validateSubmission(submission({lassos: [{rect: rect(), colourIndex: 0, comment: atLimit}]})).ok).toBe(true);
  });

  test('too many lassos in one submission is rejected', () => {
    const many = Array.from({length: MAX_LASSOS_PER_SUBMISSION + 1}, () => ({
      rect: rect(), colourIndex: 0, comment: 'x',
    }));
    expect(validateSubmission(submission({lassos: many})).ok).toBe(false);
  });

  test('an empty submission is rejected — nothing to say is not feedback', () => {
    expect(validateSubmission(submission({lassos: []})).ok).toBe(false);
  });

  test('an EMPTY comment string is still accepted', () => {
    // A lasso with no words is a tester pointing at something. Rejecting it
    // would discard the gesture; the export shows a blank line under a region,
    // which is legible as "look here".
    expect(validateSubmission(submission({lassos: [{rect: rect(), colourIndex: 0, comment: ''}]})).ok).toBe(true);
  });

  test('junk input is rejected without throwing', () => {
    for (const junk of [null, undefined, 42, 'string', []]) {
      expect(() => validateSubmission(junk)).not.toThrow();
      expect(validateSubmission(junk).ok).toBe(false);
    }
  });
});

describe('an unknown specimenKey is STORED, not rejected', () => {
  test('the server does not mirror the specimen registry', () => {
    // 🔑 The registry lives in lib/. A copy here would be a second definition
    // that drifts — the defect this codebase keeps filing. And rejecting an
    // unknown key loses the tester's sentence, while storing it exports as an
    // unknown key: visible and recoverable.
    expect(validateSubmission(submission({specimenKey: 'Nonsense/Made/Up'})).ok).toBe(true);
  });

  test('but an implausibly long key is refused', () => {
    expect(validateSubmission(submission({specimenKey: 'x'.repeat(201)})).ok).toBe(false);
  });
});

describe('🔑 the export is readable by a human', () => {
  test('the tester\'s sentence survives EXACTLY', () => {
    // The assertion this file exists for.
    const words = 'The "Continue" button is 2px off — and it\'s teal, not #0A7?';
    const out = formatFeedbackReport([record({lassos: [{rect: rect(), colourIndex: 1, comment: words}]})]);
    expect(out).toContain(words);
  });

  test('a multi-line comment keeps its line breaks', () => {
    const out = formatFeedbackReport([
      record({lassos: [{rect: rect(), colourIndex: 0, comment: 'Line one.\nLine two.'}]}),
    ]);
    expect(out).toContain('Line one.');
    expect(out).toContain('Line two.');
    // Indented, not reflowed — the indent is the only alteration.
    expect(out).toMatch(/ {6}Line one\.\n {6}Line two\./);
  });

  test('nothing is truncated, however long', () => {
    const long = 'y'.repeat(MAX_COMMENT_LENGTH);
    const out = formatFeedbackReport([record({lassos: [{rect: rect(), colourIndex: 0, comment: long}]})]);
    expect(out).toContain(long);
    expect(out).not.toContain('…');
    expect(out).not.toContain('...');
  });

  test('it groups by specimen rather than by time', () => {
    // The reader opens a screen, fixes it, moves on. Sorting by time would
    // scatter one screen's problems across the whole file.
    const out = formatFeedbackReport([
      record({specimenKey: 'Shop/Chests/default', lassos: [{rect: rect(), colourIndex: 0, comment: 'AAA'}]}),
      record({specimenKey: 'Auth/Login/error', lassos: [{rect: rect(), colourIndex: 0, comment: 'BBB'}]}),
      record({specimenKey: 'Shop/Chests/default', lassos: [{rect: rect(), colourIndex: 1, comment: 'CCC'}]}),
    ]);
    expect(out.indexOf('Auth/Login/error')).toBeLessThan(out.indexOf('Shop/Chests/default'));
    // 🔑 Both Shop comments sit under ONE heading. The heading appearing
    // exactly once despite two records IS the grouping — an ungrouped report
    // would print it twice.
    expect(out.split('Shop/Chests/default').length - 1).toBe(1);
    expect(out.indexOf('AAA')).toBeLessThan(out.indexOf('CCC'));
  });

  test('it carries the build and the region in human units', () => {
    const out = formatFeedbackReport([record()]);
    expect(out).toContain('1.4.2+42');
    expect(out).toMatch(/10%,10% 20%x20%/); // percentages, not raw floats
  });

  test('it is not JSON', () => {
    const out = formatFeedbackReport([record()]);
    expect(() => JSON.parse(out)).toThrow();
    expect(out).toContain('TESTER FEEDBACK');
  });

  test('an empty export says so rather than returning nothing', () => {
    // "No feedback yet" and "the export broke" must not look the same — the
    // same reasoning as blindBefore in questRecompute.ts.
    expect(formatFeedbackReport([])).toMatch(/No tester feedback has been submitted yet/);
  });

  test('it counts comments, screens and testers', () => {
    const out = formatFeedbackReport([
      record({uid: 'a', specimenKey: 'X/Y/z'}),
      record({uid: 'b', specimenKey: 'X/Y/z'}),
    ]);
    expect(out).toMatch(/2 comment\(s\) across 1 screen\(s\), from 2 tester\(s\)/);
  });
});

// ---------------------------------------------------------------------------
// W2-24 — who can read everyone else's feedback
// ---------------------------------------------------------------------------
//
// 🔴 The export was a callable, so ANY signed-in user could read EVERY tester's
// comments. These assertions pin the gate that closed it, and pin the shape of
// the refusal — because a refused caller who is not told how to proceed turns a
// working feature into what looks like a bug.
//
// ⚠️ THE LIMIT, STATED RATHER THAN PAPERED OVER: this is source-level. There is
// no functions-emulator harness in this repo, so no test here executes the
// endpoint, and nothing in this window can verify the secret is bound on a real
// deployment — that needs the squeeeks project, which this account cannot reach
// (D48). The gate's SHAPE is asserted; its BINDING is not, and cannot be here.

describe('🔴 the export is admin-only, and refuses in a way you can act on', () => {
  const read = (f: string): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', f), 'utf8');

  /**
   * The endpoint body with COMMENTS STRIPPED.
   *
   * 🔴 W2-27 caught why this matters. Before stripping, `it reuses the EXISTING
   * admin gate` passed AFTER the gate stopped being reused — because the body
   * still mentioned `SEED_OPTS` in a comment, and mentioned `x-seed-secret` in a
   * sentence saying the endpoint NO LONGER ACCEPTS IT. The assertion was
   * satisfied by prose describing the opposite of what it claimed to check.
   * A code assertion must read code.
   */
  function handlerCode(): string {
    return codeOf(handler());
  }

  /** The endpoint body, sliced at its own column-0 `});`. Comments included. */
  function handler(): string {
    const code = read('index.ts');
    const start = code.indexOf('export const exportGalleryFeedback');
    expect(start).toBeGreaterThan(-1);
    // Not the next `export const` — that runs past the handler into whatever
    // sits between, and would assert about the wrong function while passing.
    const end = code.indexOf('\n});', start);
    expect(end).toBeGreaterThan(start);
    return code.slice(start, end + 4);
  }

  test('it is no longer a callable', () => {
    // The whole defect: onCall + any signed-in user = every tester's comments.
    expect(handler()).not.toContain('onCall');
    expect(handler()).toContain('onRequest');
  });

  // 🔑 THIS TEST INVERTED IN W2-27, and it is the third time a ledger-style
  // assertion has caught its own author. It used to assert the export shared
  // SEED_OPTS with the write endpoints. Splitting the secret by blast radius
  // made that false — and the un-stripped version PASSED ANYWAY on comment
  // prose, which is why handlerCode() exists.
  test('it uses its OWN secret, not the one guarding the write endpoints', () => {
    const body = handlerCode();
    expect(body).toContain('FEEDBACK_OPTS');
    expect(body).toContain('process.env.FEEDBACK_EXPORT_SECRET');
    expect(body).toContain('x-feedback-secret');
    // The point of the split: a leak of the pasteable read secret must not be a
    // leak of the one that can rewrite the shop.
    expect(body).not.toContain('process.env.SEED_SECRET');
    expect(body).not.toContain("req.get('x-seed-secret')");
  });

  test('the two WRITE endpoints keep SEED_SECRET, untouched', () => {
    // One secret per blast radius — not one per endpoint. The write pair still
    // shares, because they share consequences.
    const code = read('index.ts');
    expect(code).toContain('export const backfillPublicProfiles = onRequest(SEED_OPTS');
    expect(code).toContain('export const seedShopData = onRequest(SEED_OPTS');
    expect(code).toContain("const SEED_OPTS = { secrets: ['SEED_SECRET'] };");
  });

  test('the two secrets are declared separately and do not alias', () => {
    const code = read('index.ts');
    expect(code).toContain("const FEEDBACK_OPTS = { secrets: ['FEEDBACK_EXPORT_SECRET'] };");
    // A single Secret Manager entry under two names would be the split in name
    // only — the whole point is that rotating one does not touch the other.
    expect(code).not.toMatch(/FEEDBACK_EXPORT_SECRET\s*=\s*.*SEED_SECRET/);
  });

  test('it is POST-only', () => {
    expect(handler()).toContain("req.method !== 'POST'");
    expect(handler()).toContain('405');
  });

  test('it fails CLOSED when the secret is unset', () => {
    // An unbound secret must refuse everyone, never admit everyone.
    const body = handler();
    const unsetGuard = body.indexOf('if (!expectedSecret)');
    const query = body.indexOf("db.collection('galleryFeedback')");
    expect(unsetGuard).toBeGreaterThan(-1);
    expect(query).toBeGreaterThan(unsetGuard); // the read is AFTER both guards
  });

  test('🔑 an UNSET secret and a WRONG secret say different things', () => {
    // SEED_OPTS' docstring records the cost of conflating them: the secret
    // never reached the runtime and every request 403'd forever, "which reads
    // as a wrong secret rather than an unbound one".
    const body = handler();
    expect(body).toMatch(/is not bound on this deployment/);
    expect(body).toMatch(/does not match/);
  });

  test('the refusal tells the caller HOW, since it is the only documentation they get', () => {
    const body = handler();
    expect(body).toContain('functions:secrets:set FEEDBACK_EXPORT_SECRET');
    expect(body).toContain('curl -X POST -H "x-feedback-secret:');
  });

  test('🔑 each refusal names WHICH secret, because now there are two', () => {
    // "the secret is wrong" is an ambiguous sentence once two exist, and the
    // person reading it is holding one of them wondering which.
    const body = handler();
    expect(body).toContain('FEEDBACK_EXPORT_SECRET is not bound');
    expect(body).toContain('NOT the same secret as SEED_SECRET');
    expect(body).toContain('no longer accepts x-seed-secret');
  });

  test('neither refusal leaks the secret itself', () => {
    // They must name the failure, never the value.
    const body = handler();
    const sends = [...body.matchAll(/\.send\(([\s\S]*?)\);/g)].map((m) => m[1]);
    expect(sends.length).toBeGreaterThan(2);
    for (const s of sends) expect(s).not.toContain('expectedSecret');
  });

  test('it returns text/plain, because a person reads it', () => {
    expect(handler()).toContain("type('text/plain')");
  });
});

describe('the SUBMIT path stays open, and that is a decision', () => {
  const code = (): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', 'index.ts'), 'utf8');

  test('submitGalleryFeedback is still a callable for any signed-in user', () => {
    // 🔑 DELIBERATE, not an oversight. Testers must be able to file feedback —
    // that is the entire feature — and gating writes behind an admin secret
    // would mean only Brendan could report a bug. The write is already narrow:
    // create-only, owner-stamped so nobody can file under another name, no
    // update, no delete, and bounded in size and count per submission.
    //
    // The asymmetry is the point: WRITING one comment about yourself is not the
    // same act as READING everyone's. Only the second is a disclosure.
    expect(code()).toContain('export const submitGalleryFeedback = onCall');
  });

  test('it still requires authentication — open is not anonymous', () => {
    const start = code().indexOf('export const submitGalleryFeedback');
    const body = code().slice(start, code().indexOf('\n});', start));
    expect(body).toContain("throw new HttpsError('unauthenticated'");
  });
});

// ---------------------------------------------------------------------------
// W2-26 — the per-day cap
// ---------------------------------------------------------------------------
//
// 🔴 The item raised in three consecutive returns: nothing bounded how many
// documents one tester could create. These pin the cap AND the two things that
// make a cap survivable — a refusal the tester can act on, and a limit generous
// enough that a real gallery pass never meets it.

describe('the per-day submission cap', () => {
  const code = (): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', 'index.ts'), 'utf8');

  function submitHandler(): string {
    const c = code();
    const start = c.indexOf('export const submitGalleryFeedback');
    expect(start).toBeGreaterThan(-1);
    const end = c.indexOf('\n});', start);
    return c.slice(start, end + 4);
  }

  test('the limit is generous enough for a real gallery pass', () => {
    // 🔑 The gallery has 51 specimens, so a thorough pass filing one submission
    // per screen is ~51. The cap must clear that with room, or it breaks the
    // exact user it exists to serve — a tester on day three.
    expect(MAX_SUBMISSIONS_PER_DAY).toBeGreaterThan(51);
    // ...and low enough to actually bound a runaway client.
    expect(MAX_SUBMISSIONS_PER_DAY).toBeLessThanOrEqual(200);
  });

  test('the number carries its reasoning in the source', () => {
    // A number without a reason is a number the next window changes on a hunch.
    const src: string = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'galleryFeedback.ts'),
      'utf8',
    );
    expect(src).toMatch(/51 specimens/);
    expect(src).toMatch(/two complete passes/);
  });

  test('the count is read and written inside ONE transaction', () => {
    // Check-then-act outside a transaction would let two concurrent submits
    // both see 99 and both write.
    const body = submitHandler();
    const tx = body.indexOf('runTransaction');
    const read = body.indexOf('tx.get(countRef)');
    const write = body.indexOf('tx.set(countRef');
    expect(tx).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(tx);
    expect(write).toBeGreaterThan(read);
  });

  test('the comment and the counter are written in the SAME transaction', () => {
    // Otherwise a crash between them either loses the comment or fails to
    // count it — and the second is the one that quietly unbounds the cap.
    const body = submitHandler();
    expect(body).toMatch(/tx\.set\(ref,[\s\S]*tx\.set\(countRef/);
  });

  test('🔴 a tester who hits the cap is TOLD, and told what to do', () => {
    // A feedback tool that swallows the sentence someone typed is worse than
    // one that refuses it.
    const body = submitHandler();
    expect(body).toContain("'resource-exhausted'");
    expect(body).toContain('Nothing was saved for this one');
    expect(body).toMatch(/copy your notes somewhere safe/);
    // The refusal names the actual number, not "a limit".
    expect(body).toContain('${MAX_SUBMISSIONS_PER_DAY}');
  });

  test('yesterday\'s counter does not lock a tester out today', () => {
    // The inverse of the cap, and the bug that would matter more: reading a
    // stale row as today's count bars anyone after one busy day. Same reasoning
    // as grantTaskRewards and the mini-game ledger.
    expect(submitHandler()).toContain("data?.date === today ? (data?.count ?? 0) : 0");
  });

  test('date and count are written together', () => {
    // `count` alone carries yesterday's total into today; `date` alone bounds
    // nothing.
    expect(submitHandler()).toContain('{date: today, count: used + 1}');
  });

  test('the returned remainder is REAL, not the constant', () => {
    // A field that always says "plenty left" right up to the refusal is worse
    // than no field. It is computed from the transaction's own result.
    const body = submitHandler();
    expect(body).toContain('MAX_SUBMISSIONS_PER_DAY - usedAfter');
    expect(body).not.toMatch(/submissionsRemainingToday: MAX_SUBMISSIONS_PER_DAY,/);
  });

  test('it reuses the inviteCounts pattern rather than inventing a second one', () => {
    const c = code();
    expect(c).toContain('users/${uid}/inviteCounts/${today}'); // the precedent still exists
    expect(submitHandler()).toContain('users/${uid}/feedbackCounts/${today}');
  });
});
