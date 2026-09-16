// ---------------------------------------------------------------------------
// The family message board — and the filter Brendan asked for
// ---------------------------------------------------------------------------
//
// W2-88 part 4, spec item 4. Brendan, verbatim: "can you put a 15 word cap on
// the chat line and no links or bad words allowed. this chat should be family
// friendly fully"
//
// 🔴 ENFORCED SERVER-SIDE, AND THAT IS THE WHOLE REASON THIS FILE EXISTS.
// A client-side cap is a suggestion: the callable is reachable directly by
// anyone with the app's config, and this is the one surface where that matters.
// The client should ALSO cap, for the typing experience — but the client's cap
// is a courtesy and this one is the rule.
//
// ---------------------------------------------------------------------------
// 🔴 EVERY REFUSAL IS NAMED SEPARATELY, AND THAT IS NOT DECORATION
// ---------------------------------------------------------------------------
//
// "Too long", "no links" and "watch your language" are three different things a
// person must do three different things about. Collapsing them into one
// "message rejected" is the same defect as telling somebody in a FULL family
// that they are "already a member" — a refusal that is true and useless. The
// client renders the reason; this file names it.
//
// ---------------------------------------------------------------------------
// ⚠️ THE SUBSTRING TRAP, WHICH IS THE ONE THAT WOULD HAVE SHIPPED
// ---------------------------------------------------------------------------
//
// A wordlist checked with `contains` flags "classic", "assignment",
// "Scunthorpe", "grape", "analysis". On a FAMILY board that means telling a
// child their homework message is offensive, which is worse than the word it was
// trying to catch. So matching is on WHOLE TOKENS ONLY, after normalisation, and
// the anti-Scunthorpe cases are named controls in the test file rather than
// something a future reader has to trust.

/**
 * The word cap, exactly as asked for.
 *
 * 🔑 "WORD" IS DEFINED HERE BECAUSE "15 words" HAS SEVERAL READINGS. A word is
 * a run of non-whitespace: split on whitespace, discard empty tokens. So
 * "don't" is one word, "5PM" is one word, and "hello   there" is two. Anything
 * cleverer (hyphens? contractions? emoji?) would be a rule nobody could predict
 * while typing.
 */
export const MAX_WORDS = 15;

/**
 * The character cap.
 *
 * ⚠️ NOT REDUNDANT WITH THE WORD CAP. Fifteen words of two hundred characters
 * each is a wall of text and a storage bill; the word cap bounds the sentence
 * and this bounds the abuse of it. 280 is chosen as a familiar public limit —
 * comfortably more than fifteen ordinary words (~90 characters) so it never
 * fires on a legitimate message, and small enough that it fires on a wall.
 */
export const MAX_CHARACTERS = 280;

/**
 * Words that do not belong on a family board.
 *
 * 🔑 DELIBERATELY SHORT, AND THE SHORTNESS IS THE DESIGN. Every entry is a
 * false-positive surface, and on this board a false positive is a child being
 * told their message is offensive when it is not. A long list catches marginally
 * more and misfires far more, so this covers the obvious and stops.
 *
 * ⚠️ MATCHED ON WHOLE TOKENS ONLY — see `containsBlockedWord`. Substring
 * matching on this list would flag "classic", "assignment", "grape" and
 * "analysis", which is the documented Scunthorpe problem and is asserted
 * against in the tests.
 *
 * 📌 ONE CONSTANT, NOT SCATTERED. Anything that needs to know the policy reads
 * this; nothing re-states it.
 */
export const BLOCKED_WORDS: readonly string[] = [
  'shit', 'shits', 'shitty',
  'fuck', 'fucks', 'fucking', 'fucked',
  'bitch', 'bitches',
  'ass', 'asses', 'arse',
  'dick', 'dicks',
  'piss', 'pissed',
  'crap', 'bastard', 'slut', 'whore', 'cunt', 'wanker',
];

const BLOCKED = new Set(BLOCKED_WORDS);

export type MessageRefusal =
  | 'empty'
  | 'too-many-words'
  | 'too-long'
  | 'contains-link'
  | 'contains-blocked-word';

export type MessageCheck =
  | {ok: true; text: string; wordCount: number}
  | {ok: false; refusal: MessageRefusal};

/** Words, as this module defines them: runs of non-whitespace. */
export function wordsOf(text: string): string[] {
  return text.split(/\s+/).filter((w) => w.length > 0);
}

/**
 * Normalise a token for wordlist comparison.
 *
 * Lower-cased, with leading and trailing punctuation stripped so "Shit!" and
 * "(shit)" match while the INTERIOR is left alone — stripping interior
 * punctuation would turn "class-ic" into a match and re-open the substring
 * problem from a different direction.
 */
function normaliseToken(token: string): string {
  return token.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/**
 * Whether [text] contains a blocked word as a WHOLE TOKEN.
 *
 * 🔴 THE `contains` IMPLEMENTATION IS THE BUG. `'classic'.includes('ass')` is
 * true, and so is "assignment", "grape", "analysis", "Scunthorpe". This checks
 * membership of the normalised token set instead, so a blocked word must BE a
 * word rather than merely appear inside one.
 */
export function containsBlockedWord(text: string): boolean {
  return wordsOf(text).some((token) => BLOCKED.has(normaliseToken(token)));
}

/**
 * Whether [text] contains something that is trying to be a link.
 *
 * 🔴 THE WELL-FORMED HALF STOPS NOBODY. Anyone posting a link they know is
 * disallowed writes "foo dot com" or "foo[.]com" — so obfuscation is the half
 * that matters and the plain `https://` check is the easy part.
 *
 * ⚠️ AND OVER-MATCHING IS THE WORSE FAILURE. "I'll do it tonight. Thanks."
 * contains a dot between two words and MUST pass; a board that rejects ordinary
 * sentences is worse than one that lets a link through. So the separator forms
 * require a KNOWN TLD immediately after the separator, which is what
 * distinguishes "foo dot com" from "tonight. Thanks".
 */
export function containsLink(text: string): boolean {
  const lower = text.toLowerCase();

  // Scheme or host prefix — the unambiguous forms.
  if (/\bhttps?:\/\//.test(lower)) return true;
  if (/\bwww\s*[.]\s*\w/.test(lower)) return true;

  // A dotted domain: `foo.com`, and the bracketed evasions `foo[.]com`,
  // `foo(.)com`, `foo{.}com`, plus the spelled-out `foo dot com`.
  //
  // 🔑 THE TLD LIST IS WHAT KEEPS THIS FROM EATING PUNCTUATION. Requiring a
  // known TLD immediately after the separator means "tonight. Thanks" cannot
  // match — `thanks` is not a TLD — while "foo dot com" cannot escape.
  const tld = '(?:com|net|org|io|co|uk|me|gg|xyz|link|app|dev|ru|tv|info|biz)';
  const sep = '(?:\\s*[[({<]?\\s*[.]\\s*[\\])}>]?\\s*|\\s+dot\\s+)';
  const domain = new RegExp(`[\\p{L}\\p{N}-]{1,}${sep}${tld}\\b`, 'u');
  return domain.test(lower);
}

/**
 * Validate a message body against every rule, and name the first one it breaks.
 *
 * Pure: no clock, no I/O. Order is deliberate — see below.
 */
export function checkMessage(raw: unknown): MessageCheck {
  if (typeof raw !== 'string') return {ok: false, refusal: 'empty'};

  // Trimmed once, and the TRIMMED text is what gets stored: a message padded
  // with newlines should not consume the character cap or render as a gap.
  const text = raw.trim();
  if (text.length === 0) return {ok: false, refusal: 'empty'};

  // 📌 CHEAP AND UNAMBIGUOUS CHECKS FIRST, CONTENT JUDGEMENT LAST. A 5,000-word
  // paste should be told it is too long rather than have its every token
  // scanned — and a message that breaks two rules is told about the structural
  // one, which is the one the writer can fix without argument.
  if (text.length > MAX_CHARACTERS) return {ok: false, refusal: 'too-long'};

  const words = wordsOf(text);
  if (words.length > MAX_WORDS) return {ok: false, refusal: 'too-many-words'};

  if (containsLink(text)) return {ok: false, refusal: 'contains-link'};
  if (containsBlockedWord(text)) return {ok: false, refusal: 'contains-blocked-word'};

  return {ok: true, text, wordCount: words.length};
}

/** The stored message, at `families/{familyId}/messages/{messageId}`. */
export interface FamilyMessageDoc {
  senderUid: string;
  /**
   * 🔑 THE SENDER'S NAME IS STORED ON THE MESSAGE, not resolved by the reader.
   * This is the W2-87 problem one level up: a client cannot read another
   * member's `publicProfiles` document, so a message carrying only a uid would
   * render as an unnamed bubble. Denormalised at post time from the family's
   * own `memberNames`, which the sender can already read.
   *
   * ⚠️ Stale on a rename, exactly as `memberNames` is, and for the same reason —
   * except more so: a message is a historical record, so the name it carries is
   * arguably the RIGHT one to keep.
   */
  senderName: string;
  /** Avatar ID, never an asset path. Same contract as `memberAvatars`. */
  senderAvatarId: string | null;
  /** Already validated and trimmed by `checkMessage`. */
  text: string;
  /** Server clock. */
  postedAtMs: number;
}

/** Human-facing refusal text, and the callable's error code for each. */
export const MESSAGE_REFUSALS: Record<
  MessageRefusal,
  {code: 'invalid-argument' | 'failed-precondition'; message: string}
> = {
  empty: {
    code: 'invalid-argument',
    message: 'Write something first.',
  },
  'too-many-words': {
    code: 'invalid-argument',
    message: `Keep it to ${MAX_WORDS} words or fewer.`,
  },
  'too-long': {
    code: 'invalid-argument',
    message: `Keep it under ${MAX_CHARACTERS} characters.`,
  },
  'contains-link': {
    code: 'failed-precondition',
    message: 'Links are not allowed here.',
  },
  'contains-blocked-word': {
    code: 'failed-precondition',
    message: 'Let\'s keep it friendly.',
  },
};
