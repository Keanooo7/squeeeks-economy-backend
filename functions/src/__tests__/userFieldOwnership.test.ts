// functions/src/__tests__/userFieldOwnership.test.ts
//
// A two-way ledger over the fields Cloud Functions write to `users/{uid}`.
//
// ---------------------------------------------------------------------------
// CRITICAL: WHY THIS EXISTS — it has already cost one live exploit
// ---------------------------------------------------------------------------
//
// `firestore.rules` guards the user document with a DENYLIST:
//
//   allow update: if isAuthenticated() && isOwner(uid)
//     && !request.resource.data.diff(resource.data)
//          .affectedKeys().hasAny(userCfOwnedFields())
//
// A field the Admin SDK writes is protected ONLY if its name appears in that
// list. Every other field is client-writable. So adding a CF-written field and
// forgetting the rules entry FAILS OPEN — and it fails open in SILENCE: no
// error, no log, and nothing in the field's definition in `functions/` that
// hints a file two directories away needs editing.
//
// #348 added `subscriptionNotifiedAt`, the high-water mark that makes
// `appStoreNotificationsV2` drop out-of-order notifications, and left it off the
// list. Frozen to a far-future value by the client, every later notification is
// judged stale — natural expiry still works, but a REFUND is discarded, so a
// subscriber keeps a paid month after Apple returns the money. #356 closed it.
//
// The lesson is not "remember the list". A rule that asks someone to notice is
// not a lock. This is the lock.
//
// ---------------------------------------------------------------------------
// WARNING: WHAT THIS GATE CAN AND CANNOT DO — read before trusting it
// ---------------------------------------------------------------------------
//
// Part 1 (rules ↔ ledger) is AIRTIGHT. Both sides are literal string lists, and
// drift in either direction is caught exactly.
//
// Part 2 (source → written fields) is a STATIC EXTRACTOR and is best-effort. It
// understands the shapes this codebase actually uses; a write in a shape it does
// not parse would be missed, and a missed write is a silent pass — the very
// failure mode this file exists to fix. That is mitigated, not solved:
//
//   - the extractor must find every field in EXPECTED_WRITE_SITES, so a
//     refactor that breaks parsing turns this suite RED instead of vacuous;
//   - it reads COMMENT-STRIPPED source, because this codebase documents itself
//     heavily and a field name in a comment would otherwise satisfy the scan.
//     See helpers/sourceText.ts — that exact failure has happened here before.
//
// If you add a write in a new shape, the honest fix is to teach the extractor,
// not to add the field to a ledger and move on.
// ---------------------------------------------------------------------------

import * as fs from 'fs';
import * as path from 'path';

import { codeOf } from './helpers/sourceText';

const SRC_DIR = path.join(__dirname, '..');
const RULES_PATH = path.join(__dirname, '..', '..', '..', 'firestore.rules');

/**
 * The fields Cloud Functions own outright — the client may never set or change
 * them. MUST equal `userCfOwnedFields()` in firestore.rules, and part 1 below
 * asserts that in both directions.
 */
const CF_OWNED: Record<string, string> = {
  subscriptionTier:
    'The entitlement itself. Written by verifySubscriptionReceipt, ' +
    'appStoreNotificationsV2 and claimRetentionPromo.',
  subscriptionProductId:
    'Which Apple product bought the entitlement. Deliberately NOT written by ' +
    'the promo grant, which has no product behind it.',
  subscriptionExpiresAt:
    'When it lapses. resolveEffectiveTier dates the stored tier against the ' +
    'clock, so a client that could write this would grant itself Pro forever.',
  subscriptionNotifiedAt:
    'The notification ordering high-water mark. #348 shipped it WITHOUT this ' +
    'entry and #356 closed the refund bypass that followed — a client that can ' +
    'freeze it switches off every later App Store notification, discarding a ' +
    'REFUND while natural expiry still appears to work.',
  proPromoGrantedAt:
    'The once-per-account stamp for the 5-of-7 free month. Clearing it re-arms ' +
    'the promo; rules cannot express "only if this has never happened", so the ' +
    'callable enforces uniqueness in a transaction and this stops the client ' +
    'rewinding the record it reads.',
  orientationCompleted:
    'Gates the welcome chest, which grants three rare items. A client that ' +
    'could clear it would re-claim them.',
  orientationCompletedAt: 'Written with orientationCompleted, by the same callable.',
  streakShields:
    'Purchased currency, granted by purchaseStreakShield and spent by the ' +
    'streak repair path. Client-writable would be a free balance.',
  familyId:
    'Which family this account owns or belongs to, stamped by createFamily ' +
    '(W2-82). 🔴 IT IS THE KEY EVERY FAMILY READ IS SCOPED BY, so a client ' +
    'that could write it would point itself at ANOTHER household: ' +
    'completeTrashDay verifies membership against the family the CLIENT ' +
    'names, and the trash-day rules grant reads to members of the named ' +
    'family — but a self-assigned familyId is how a client would decide which ' +
    'family to name in the first place. Writable would also let an owner ' +
    'orphan their own family by pointing elsewhere, stranding the members ' +
    'whose grant is copied from it.',
  familyProExpiresAt:
    'The family Pro grant (W2-76). resolveEffectiveTier returns pro whenever ' +
    'this timestamp is in the future, INDEPENDENTLY of subscriptionTier, so a ' +
    'client that could write it would grant itself Pro without needing a ' +
    'family, a subscription or any other document — an easier self-grant than ' +
    'subscriptionExpiresAt guards, since there is no tier string to set too. ' +
    '📌 LISTED BEFORE ANY CODE WRITES IT, which is the inverse of #348: this ' +
    'is a denylist, so the entry costs nothing while no writer exists and ' +
    'closes the hole the moment one lands.',
};

/**
 * Fields the SERVER writes that are deliberately NOT CF-owned.
 *
 * KEY: This ledger is why the gate cannot simply assert "everything the server
 * writes is CF-owned". That is false, and knowing WHICH exceptions are intended
 * is a judgement that has to be written down rather than inferred — the same
 * construction as moduleReachability's KNOWN_UNREACHABLE and rulesAllowlist.
 */
const SERVER_WRITTEN_CLIENT_OWNED: Record<string, string> = {
  housemates:
    'Written by the housemate-token redemption (index.ts, tx.set on hostRef and ' +
    'guestRef) AND by the owner from the client, which is the whole design: the ' +
    'roster lives on users/{uid} because a cap has to count every grant one user ' +
    'has issued, and rules cannot aggregate across documents. It is guarded by ' +
    'housemateWriteOk rather than by ownership — a uid may only be ADDED if it ' +
    'already sits in housePendingFrom on an accepted friend edge, and the result ' +
    'may not exceed housemateCap(). Making it CF-owned would break the ' +
    'client-side removal path, which is deliberately unconstrained because every ' +
    'removal reduces access.',
};

/**
 * `users/{uid}/profile/data`'s Cloud-Function-owned fields.
 *
 * CRITICAL: A LARGER BLAST RADIUS THAN THE USER DOCUMENT. `profile/data` has its own
 * denylist (`profileCfOwnedFields`) with the same fail-open shape, and the two
 * fields on it are the CURRENCY and the PROGRESSION. A missed field beside
 * `subscriptionNotifiedAt` cost a refund window; a missed field beside
 * `spongeBalance` is the balance itself.
 */
const PROFILE_CF_OWNED: Record<string, string> = {
  spongeBalance:
    'The currency. Incremented by purchaseChest, claimDailyGift, claimGift, ' +
    'claimWeeklyGift, verifyIapAndGrant and the task reward path — nine write ' +
    'sites across index.ts and taskRewards.ts. Client-writable would be a free ' +
    'balance, and unlike an entitlement there is no expiry to limit the damage.',
  totalXp:
    'Progression. Written by awardXp and by the task reward path. ⚠️ Only ONE of ' +
    'its two write sites states the field name literally: xp.ts writes ' +
    '`{ [XP_FIELD]: … }` to `db.doc(xpDocPath(uid))`, so neither the field nor ' +
    'the document appears at the call site. Both indirections are resolved by ' +
    'the extractor, and EXPECTED_PROFILE_WRITE_SITES pins that they still are.',
};

/**
 * Fields the SERVER writes to `profile/data` that are deliberately NOT
 * CF-owned.
 *
 * NOTE: EMPTY ON PURPOSE, and asserted to be. The user document needs this escape
 * hatch because `housemates` is genuinely written from both sides; nothing on
 * profile/data is. An entry appearing here later is a real decision — someone
 * deciding a client may write a field a Cloud Function also writes — and it
 * should be argued for in the entry, not added to make a suite green.
 */
const PROFILE_SERVER_WRITTEN_CLIENT_OWNED: Record<string, string> = {};

/**
 * The two documents this gate covers, as path-template regexes.
 *
 * `users/{uid}` holds one segment after `users/`; `users/{uid}/profile/data` is
 * a different document with its OWN denylist (`profileCfOwnedFields`) and its
 * own hazard — `spongeBalance` and `totalXp` are the currency and the
 * progression, so a missed field there is worth real money rather than a
 * refund window.
 */
const TARGETS = {
  user: String.raw`\`users\/\$\{[^}]+\}\``,
  profile: String.raw`\`users\/\$\{[^}]+\}\/profile\/data\``,
} as const;

type TargetKind = keyof typeof TARGETS;

/**
 * Local `const NAME = 'literal'` bindings, for resolving COMPUTED KEYS.
 *
 * CRITICAL: `xp.ts` writes `{ [XP_FIELD]: FieldValue.increment(amount) }`. The field
 * name `totalXp` DOES NOT APPEAR at the write site at all — it appears once,
 * as `export const XP_FIELD = 'totalXp'`. A scanner that only understands
 * `name:` sees an empty object there and reports, truthfully and uselessly,
 * that xp.ts writes nothing.
 *
 * This is a general mechanism, not an accommodation for one file: any computed
 * key whose identifier resolves to a string const in the same file is read.
 * One that does not resolve is reported as `[UNRESOLVED]` and fails the ledger
 * loudly rather than vanishing.
 */
function stringConsts(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?:export\s+)?const\s+([A-Z_][A-Z0-9_]*)\s*(?::\s*\w+\s*)?=\s*'([^']*)'/g;
  for (let m = re.exec(code); m; m = re.exec(code)) out.set(m[1], m[2]);
  return out;
}

/**
 * Local `const f = (args) => \`template\`` bindings, for resolving INDIRECT doc
 * paths.
 *
 * CRITICAL: `xp.ts` writes to `admin.firestore().doc(xpDocPath(uid))`, where
 * `xpDocPath` is `(uid) => \`users/${uid}/profile/data\``. The path never
 * appears at the call site. Again general rather than file-specific: any
 * single-expression arrow returning a template literal is resolved to that
 * template, and the result is matched against the same target regexes.
 */
function pathHelpers(code: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /(?:export\s+)?const\s+(\w+)\s*(?::[^=]+)?=\s*\([^)]*\)\s*(?::\s*string\s*)?=>\s*(`[^`]*`)/g;
  for (let m = re.exec(code); m; m = re.exec(code)) out.set(m[1], m[2]);
  return out;
}

/** Every field name written to the given document kind, extracted from source. */
function writtenFields(kind: TargetKind): Map<string, string[]> {
  const found = new Map<string, string[]>();
  const target = new RegExp('^' + TARGETS[kind] + '$');
  const docOf = String.raw`db\.doc\(` + TARGETS[kind] + String.raw`\)`;

  for (const file of fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'))) {
    const code = codeOf(fs.readFileSync(path.join(SRC_DIR, file), 'utf8'));
    const consts = stringConsts(code);

    // Identifiers bound to the target document, either directly from a literal
    // path or through a local path helper resolved above.
    const refNames = new Set<string>();
    const bind = new RegExp(String.raw`(?:const|let)\s+(\w+)\s*=\s*` + docOf, 'g');
    for (let m = bind.exec(code); m; m = bind.exec(code)) refNames.add(m[1]);

    // `.doc(helper(...))` — resolve the helper's template and keep it only if
    // it names this target.
    const helperDocs: string[] = [];
    for (const [name, tmpl] of pathHelpers(code)) {
      if (target.test(tmpl)) helperDocs.push(name);
    }
    const viaHelper = helperDocs.length
      ? String.raw`\.doc\(\s*(?:${helperDocs.join('|')})\([^)]*\)\s*\)\.set\(`
      : null;

    const alts = [docOf + String.raw`\.set\(`, String.raw`\btx\.set\(\s*` + docOf + String.raw`\s*,`];
    if (viaHelper) alts.push(viaHelper);
    if (refNames.size > 0) {
      const names = [...refNames].join('|');
      alts.push(String.raw`\b(?:` + names + String.raw`)\.set\(`);
      alts.push(String.raw`\btx\.set\(\s*(?:` + names + String.raw`)\s*,`);
    }
    const setCall = new RegExp(`(?:${alts.join('|')})`, 'g');

    for (let m = setCall.exec(code); m; m = setCall.exec(code)) {
      // WARNING: WHICH `(` OPENS THE CALL depends on the shape, and getting it wrong
      // is silent: paren-matching from `db.doc(`'s bracket closes immediately,
      // finds no object literal, and contributes nothing — a miss that looks
      // exactly like "this site writes no fields".
      //
      //   tx.set( db.doc(`…`), {…} )   -> the FIRST `(`
      //   db.doc(`…`).set({…})         -> the LAST `(`
      const paren = m[0].startsWith('tx.set(')
        ? m.index + m[0].indexOf('(')
        : m.index + m[0].lastIndexOf('(');
      for (const key of fieldsWrittenByCall(code, paren, consts)) {
        if (!found.has(key)) found.set(key, []);
        found.get(key)!.push(file);
      }
    }
  }
  return found;
}

/**
 * Top-level keys of every data object inside one `set(...)` call.
 *
 * WARNING: EVERY object, not the first — because a write may be a TERNARY over two
 * shapes (`effect.kind === 'entitle' ? {…} : {…}` in appStoreNotificationsV2),
 * and taking only the first branch would let a field that appears solely in the
 * other branch go unledgered.
 *
 * The Firestore options object is skipped by its CONTENT rather than its
 * position: an object whose only keys are `merge`/`mergeFields` is never a data
 * object. Position is unreliable here for the same reason as above.
 */
function fieldsWrittenByCall(
  code: string,
  openParen: number,
  consts: Map<string, string>,
): string[] {
  const keys: string[] = [];
  let depth = 0;

  for (let i = openParen; i < code.length; i++) {
    const c = code[i];
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) break;
    } else if (c === '{' && depth === 1) {
      const objKeys = topLevelKeys(code, i, consts);
      const optionsOnly =
        objKeys.length > 0 && objKeys.every((k) => k === 'merge' || k === 'mergeFields');
      if (!optionsOnly) keys.push(...objKeys);
      i = endOfObject(code, i);
    }
  }
  return keys;
}

/** Index of the `}` closing the object literal that starts at `open`. */
function endOfObject(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return code.length - 1;
}

/** Top-level keys of the object literal starting at `open`. */
function topLevelKeys(code: string, open: number, consts: Map<string, string>): string[] {
  const keys: string[] = [];
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];

    // CRITICAL: KEY DETECTION RUNS BEFORE DEPTH ACCOUNTING, and the order is the whole
    // correctness of the computed-key branch. `[` is BOTH a depth token and the
    // opening of `[XP_FIELD]:`. Counting depth first pushes the scan to 2
    // before the key is ever examined, so every computed key is invisible — and
    // invisible reads as "this object has no fields", which is a silent pass.
    if (depth === 1 && /[\s{,]/.test(code[i - 1] ?? '')) {
      const plain = /^([A-Za-z_$][\w$]*)\s*:/.exec(code.slice(i));
      if (plain) {
        keys.push(plain[1]);
        i += plain[0].length - 1;
        continue;
      }
      // A COMPUTED key, `[XP_FIELD]:`. Resolved against the file's string
      // consts; an identifier that does not resolve becomes [UNRESOLVED] so it
      // fails the ledger loudly instead of disappearing.
      const computed = /^\[\s*([A-Za-z_$][\w$]*)\s*\]\s*:/.exec(code.slice(i));
      if (computed) {
        keys.push(consts.get(computed[1]) ?? `[UNRESOLVED:${computed[1]}]`);
        i += computed[0].length - 1;
        continue;
      }
    }

    if (c === '{' || c === '(' || c === '[') depth++;
    else if (c === '}' || c === ')' || c === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  return keys;
}

/** Back-compat alias — the user document is one of the two targets. */
const writtenUserFields = () => writtenFields('user');

/** `userCfOwnedFields()` as firestore.rules actually declares it. */
function rulesCfOwnedFields(): string[] {
  const rules = codeOf(fs.readFileSync(RULES_PATH, 'utf8'));
  const body = /function\s+userCfOwnedFields\(\)\s*\{\s*return\s*\[([^\]]*)\]/.exec(rules);
  if (!body) throw new Error('userCfOwnedFields() not found in firestore.rules');
  return [...body[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** `profileCfOwnedFields()` as firestore.rules actually declares it. */
function rulesProfileCfOwnedFields(): string[] {
  const rules = codeOf(fs.readFileSync(RULES_PATH, 'utf8'));
  const body = /function\s+profileCfOwnedFields\(\)\s*\{\s*return\s*\[([^\]]*)\]/.exec(rules);
  if (!body) throw new Error('profileCfOwnedFields() not found in firestore.rules');
  return [...body[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/**
 * Fields the extractor MUST find, or it is not working.
 *
 * The anti-vacuity guard, and the reason a parsing regression fails LOUDLY
 * rather than turning this whole file into a green no-op.
 */
const EXPECTED_PROFILE_WRITE_SITES = [
  'spongeBalance',
  // CRITICAL: THE ONE THAT PROVES THE INDIRECTIONS STILL RESOLVE. `totalXp` reaches
  // profile/data from xp.ts as `{ [XP_FIELD]: … }` on `db.doc(xpDocPath(uid))`
  // — the field name and the document path BOTH absent from the call site. If
  // either resolution regresses this goes red, which is the only reason the
  // profile half of this gate can be trusted at all.
  'totalXp',
];

const EXPECTED_WRITE_SITES = [
  'subscriptionTier',
  'subscriptionExpiresAt',
  'subscriptionNotifiedAt',
  'proPromoGrantedAt',
  'orientationCompleted',
  'streakShields',
  'housemates',
];

describe('the extractor is actually reading the source', () => {
  const written = writtenUserFields();

  test('it finds every write site we already know about', () => {
    // CRITICAL: If this goes red, the EXTRACTOR broke — not the rules. Fix the parser
    // before trusting anything below it, because a parser that finds nothing
    // makes every assertion in this file vacuously true.
    for (const field of EXPECTED_WRITE_SITES) {
      expect(Array.from(written.keys())).toContain(field);
    }
  });

  test('it is reading comment-stripped code', () => {
    // helpers/sourceText exists because a guard once passed on a field name
    // that appeared only in a comment explaining its own removal. `merge` and
    // `_comment` are shapes that would show up if raw text were scanned.
    expect(written.has('merge')).toBe(false);
  });

  test('it does not mistake a SUBCOLLECTION write for a user-document write', () => {
    // `users/{uid}/inventory/{itemId}` and `users/{uid}/profile/data` are
    // different documents with different rules. `equipped` and `spongeBalance`
    // live there and must not be dragged into this ledger.
    expect(written.has('equipped')).toBe(false);
    expect(written.has('spongeBalance')).toBe(false);
  });
});

describe('🔴 firestore.rules and this ledger agree', () => {
  // Part 1, and the airtight half: both sides are literal string lists.
  test('every field in userCfOwnedFields() is in the ledger, with a reason', () => {
    for (const field of rulesCfOwnedFields()) {
      expect(Object.keys(CF_OWNED)).toContain(field);
      expect((CF_OWNED[field] ?? '').length).toBeGreaterThan(30);
    }
  });

  test('every ledger entry is in userCfOwnedFields()', () => {
    // The direction that catches a REMOVAL from the rules — which is the
    // dangerous edit, and the one a one-way check would wave through.
    for (const field of Object.keys(CF_OWNED)) {
      expect(rulesCfOwnedFields()).toContain(field);
    }
  });

  test('the rules list is not vacuously empty', () => {
    expect(rulesCfOwnedFields().length).toBeGreaterThanOrEqual(8);
  });
});

describe('🔴 every field a Cloud Function writes to users/{uid} is accounted for', () => {
  test('it is CF-owned, or explicitly ledgered as client-owned', () => {
    // Part 2. The check that would have failed on #348 the moment
    // `subscriptionNotifiedAt` was introduced, instead of one PR later.
    const written = writtenUserFields();
    const accounted = new Set([
      ...Object.keys(CF_OWNED),
      ...Object.keys(SERVER_WRITTEN_CLIENT_OWNED),
    ]);

    const unaccounted = [...written.entries()]
      .filter(([field]) => !accounted.has(field))
      .map(([field, files]) => `${field} (written in ${[...new Set(files)].join(', ')})`);

    // The message matters: whoever hits this needs to know the DECISION they
    // are being asked to make, not just that a list is short.
    expect(unaccounted).toEqual([]);
  });

  test('every client-owned exception carries a real reason', () => {
    for (const [field, why] of Object.entries(SERVER_WRITTEN_CLIENT_OWNED)) {
      expect(why.length).toBeGreaterThan(60);
      expect(field.length).toBeGreaterThan(0);
    }
  });
});


describe('the extractor reads profile/data too', () => {
  const written = writtenFields('profile');

  test('it finds both known profile write sites', () => {
    // CRITICAL: Red here means the EXTRACTOR broke, not the rules. In particular
    // `totalXp` arrives through two indirections, and a regression in either
    // makes every profile assertion below vacuously true.
    for (const field of EXPECTED_PROFILE_WRITE_SITES) {
      expect(Array.from(written.keys())).toContain(field);
    }
  });

  test('it resolves the computed key rather than reporting it unresolved', () => {
    // `[UNRESOLVED:X]` is what the scan emits for a computed key it cannot
    // resolve. It is deliberately a value that can never be a real field name,
    // so it fails the ledger loudly instead of vanishing — but if it appears,
    // the extractor has stopped understanding the write, not found a new field.
    for (const key of written.keys()) {
      expect(key).not.toMatch(/^\[UNRESOLVED:/);
    }
  });

  test('it sees the write in xp.ts, not only the literal one', () => {
    // The two sites write the SAME field by different means. Asserting the file
    // and not just the field is what stops a passing test that only ever saw
    // taskRewards.ts.
    expect(written.get('totalXp')).toContain('xp.ts');
    expect(written.get('totalXp')).toContain('taskRewards.ts');
  });

  test('it does not sweep the parent user document into the profile scan', () => {
    // `users/{uid}` and `users/{uid}/profile/data` are different documents with
    // different denylists. A target regex that matched loosely would merge the
    // two ledgers and make both meaningless.
    expect(written.has('subscriptionTier')).toBe(false);
    expect(written.has('streakShields')).toBe(false);
  });
});

describe('🔴 firestore.rules and the profile ledger agree', () => {
  test('every field in profileCfOwnedFields() is ledgered, with a reason', () => {
    for (const field of rulesProfileCfOwnedFields()) {
      expect(Object.keys(PROFILE_CF_OWNED)).toContain(field);
      expect((PROFILE_CF_OWNED[field] ?? '').length).toBeGreaterThan(30);
    }
  });

  test('every profile ledger entry is in profileCfOwnedFields()', () => {
    for (const field of Object.keys(PROFILE_CF_OWNED)) {
      expect(rulesProfileCfOwnedFields()).toContain(field);
    }
  });

  test('the profile rules list is not vacuously empty', () => {
    expect(rulesProfileCfOwnedFields().length).toBeGreaterThanOrEqual(2);
  });
});

describe('🔴 every field a Cloud Function writes to profile/data is accounted for', () => {
  test('it is CF-owned, or explicitly ledgered as client-owned', () => {
    const written = writtenFields('profile');
    const accounted = new Set([
      ...Object.keys(PROFILE_CF_OWNED),
      ...Object.keys(PROFILE_SERVER_WRITTEN_CLIENT_OWNED),
    ]);

    const unaccounted = [...written.entries()]
      .filter(([field]) => !accounted.has(field))
      .map(([field, files]) => `${field} (written in ${[...new Set(files)].join(', ')})`);

    expect(unaccounted).toEqual([]);
  });

  test('the profile client-owned exception list is empty ON PURPOSE', () => {
    // NOTE: Not an oversight. The user document needs that escape hatch because
    // `housemates` is genuinely written from both sides; nothing on
    // profile/data is. If this ever gains an entry it is a real decision and
    // the entry must argue for itself.
    expect(Object.keys(PROFILE_SERVER_WRITTEN_CLIENT_OWNED)).toEqual([]);
  });
});
