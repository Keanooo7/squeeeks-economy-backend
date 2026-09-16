// functions/src/__tests__/familyMessages.test.ts
//
// W2-88 part 4. Brendan: "15 word cap ... no links or bad words ... family
// friendly fully".
//
// 🔴 THE NEGATIVE CONTROLS ARE THE POINT OF THIS FILE. A filter that refuses
// everything satisfies every "is refused" test ever written, and on a family
// board the cost of a false positive is a child being told their homework
// message is offensive. So the anti-Scunthorpe cases and the ordinary-sentence
// cases are named, explicit, and first.

import {
  BLOCKED_WORDS,
  checkMessage,
  containsBlockedWord,
  containsLink,
  MAX_CHARACTERS,
  MAX_WORDS,
  MESSAGE_REFUSALS,
  wordsOf,
} from '../familyMessages';

const refusalOf = (text: string) => {
  const r = checkMessage(text);
  return r.ok ? null : r.refusal;
};

// ---------------------------------------------------------------------------
// 🔴 THE FALSE-POSITIVE CONTROLS
// ---------------------------------------------------------------------------

describe('🔴 ANTI-SCUNTHORPE — innocent words containing blocked substrings PASS', () => {
  // `'classic'.includes('ass')` is true. A wordlist checked with `contains`
  // flags every one of these, and this is the documented, named bug class the
  // implementation exists to avoid.
  const innocent = [
    'classic',
    'assignment',
    'assignments',
    'grape',
    'grapes',
    'analysis',
    'passed',
    'password',
    'class',
    'glasses',
    'bass',
    'compass',
    'assess',
    'Scunthorpe',
    'dickens',
    'cassette',
    'massive',
    'brass',
  ];

  test('🔴 every one of them is accepted', () => {
    for (const word of innocent) {
      expect(`${word}: ${containsBlockedWord(word)}`).toBe(`${word}: false`);
    }
  });

  test('🔴 and they pass the whole check, in a real sentence', () => {
    const r = checkMessage('I finished my assignment and the classic grape analysis');
    expect(r.ok).toBe(true);
  });

  test('🔑 ANTI-VACUITY — the filter DOES catch a real one', () => {
    // Without this, a `containsBlockedWord` that always returned false would
    // pass every test above.
    expect(containsBlockedWord('shit')).toBe(true);
    expect(refusalOf('this is shit')).toBe('contains-blocked-word');
  });
});

describe('🔴 ORDINARY PUNCTUATION IS NOT A LINK', () => {
  const ordinary = [
    "I'll do it tonight. Thanks.",
    'Done. What next?',
    'ok. bye',
    'Sorted the darks. Bins out too.',
    'Be home at 5. Love you.',
    'Mr. Smith called about school',
    'wait... really?',
  ];

  test('🔴 every one of them is accepted', () => {
    for (const text of ordinary) {
      expect(`${text} -> ${containsLink(text)}`).toBe(`${text} -> false`);
    }
  });

  test('🔑 ANTI-VACUITY — the detector DOES catch a real link', () => {
    expect(containsLink('https://example.com')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Links, including the obfuscated forms that are the only ones that matter
// ---------------------------------------------------------------------------

describe('🔴 links are refused, including obfuscated forms', () => {
  const links = [
    'https://example.com',
    'http://example.com/thing',
    'HTTPS://EXAMPLE.COM',
    'www.example.com',
    'www . example . com',
    'example.com',
    'foo dot com',
    'foo[.]com',
    'foo(.)com',
    'foo{.}com',
    'foo . com',
    'check out badsite.xyz',
    'go to twitch.tv now',
  ];

  test('every form is refused', () => {
    for (const text of links) {
      expect(`${text} -> ${refusalOf(text)}`).toBe(`${text} -> contains-link`);
    }
  });

  test('the refusal has its own code and message', () => {
    expect(MESSAGE_REFUSALS['contains-link'].message).toMatch(/link/i);
  });
});

// ---------------------------------------------------------------------------
// The word cap — the boundary from BOTH sides
// ---------------------------------------------------------------------------

describe('🔴 the 15-word cap', () => {
  const words = (n: number) => Array.from({length: n}, (_, i) => `w${i}`).join(' ');

  test('🔴 exactly 15 words PASSES', () => {
    const r = checkMessage(words(MAX_WORDS));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wordCount).toBe(15);
  });

  test('🔴 16 words is REFUSED', () => {
    // The boundary from both sides. A cap tested only from above passes with an
    // off-by-one that rejects fifteen.
    expect(refusalOf(words(MAX_WORDS + 1))).toBe('too-many-words');
  });

  test('📌 "word" is a run of non-whitespace, and that is asserted not assumed', () => {
    expect(wordsOf("don't  stop   now")).toEqual(["don't", 'stop', 'now']);
    expect(wordsOf('  padded  ')).toEqual(['padded']);
    expect(wordsOf('')).toEqual([]);
    // Newlines and tabs are whitespace too — a message cannot smuggle words in
    // by separating them with returns.
    expect(wordsOf('a\nb\tc')).toEqual(['a', 'b', 'c']);
  });

  test('leading and trailing whitespace does not count against the cap', () => {
    expect(checkMessage(`   ${words(MAX_WORDS)}   `).ok).toBe(true);
  });
});

describe('🔴 the character cap', () => {
  test('a wall of text inside the word cap is still refused', () => {
    // 15 words of 200 characters each is a wall and a storage problem — which
    // is exactly why the word cap alone is not enough.
    const wall = Array.from({length: 15}, () => 'x'.repeat(200)).join(' ');
    expect(wordsOf(wall).length).toBe(15);
    expect(refusalOf(wall)).toBe('too-long');
  });

  test('🔴 CONTROL — an ordinary 15-word message is nowhere near the cap', () => {
    // The character cap must never fire on a legitimate message, or it becomes
    // the real cap and the word cap becomes decoration.
    const ordinary = 'please can you sort the darks before dinner tonight and take the bins';
    expect(wordsOf(ordinary).length).toBeLessThanOrEqual(MAX_WORDS);
    expect(ordinary.length).toBeLessThan(MAX_CHARACTERS);
    expect(checkMessage(ordinary).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Every refusal is separately named
// ---------------------------------------------------------------------------

describe('🔴 each rule has its OWN named refusal', () => {
  test('the five reasons are distinguishable', () => {
    // Three different refusals rendered identically is the error-message defect
    // from #400: true, and useless to the person who has to act on it.
    expect(refusalOf('')).toBe('empty');
    expect(refusalOf('   ')).toBe('empty');
    expect(refusalOf('x'.repeat(MAX_CHARACTERS + 1))).toBe('too-long');
    expect(refusalOf(Array.from({length: 16}, () => 'w').join(' '))).toBe('too-many-words');
    expect(refusalOf('see example.com')).toBe('contains-link');
    expect(refusalOf('you are a bitch')).toBe('contains-blocked-word');
  });

  test('every refusal has a rendering and none is a shrug', () => {
    for (const [reason, spec] of Object.entries(MESSAGE_REFUSALS)) {
      expect(`${reason} has a message: ${spec.message.length > 8}`).toBe(
        `${reason} has a message: true`,
      );
      expect(spec.code).toMatch(/invalid-argument|failed-precondition/);
    }
  });

  test('a non-string is refused without throwing', () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(checkMessage(bad).ok).toBe(false);
    }
  });
});

describe('the blocked list itself', () => {
  test('🔑 it is non-empty and deliberately short', () => {
    // Anti-vacuity on one side; on the other, a long list is a large
    // false-positive surface and every false positive lands on a child.
    expect(BLOCKED_WORDS.length).toBeGreaterThan(5);
    expect(BLOCKED_WORDS.length).toBeLessThan(40);
  });

  test('every entry is lower-case and single-token', () => {
    // A multi-word or upper-case entry could never match, because comparison is
    // against a normalised single token — it would be a silent no-op.
    for (const word of BLOCKED_WORDS) {
      expect(`${word} is lowercase: ${word === word.toLowerCase()}`).toBe(
        `${word} is lowercase: true`,
      );
      expect(`${word} is one token: ${wordsOf(word).length === 1}`).toBe(
        `${word} is one token: true`,
      );
    }
  });

  test('matching is case-insensitive and survives punctuation', () => {
    expect(containsBlockedWord('SHIT')).toBe(true);
    expect(containsBlockedWord('Shit!')).toBe(true);
    expect(containsBlockedWord('(shit)')).toBe(true);
    expect(containsBlockedWord('...shit...')).toBe(true);
  });

  test('📌 interior punctuation is NOT stripped, or the substring bug returns', () => {
    // Stripping interior punctuation would make "cl-ass-ic" a match and reopen
    // exactly the problem whole-token matching solves.
    expect(containsBlockedWord('cl-ass-ic')).toBe(false);
  });
});

describe('accepted messages', () => {
  test('the stored text is TRIMMED', () => {
    const r = checkMessage('  darks before dinner please  ');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.text).toBe('darks before dinner please');
  });

  test('ordinary family traffic passes', () => {
    for (const text of [
      'Darks before dinner please!',
      'already did it',
      'good work',
      'bins are out',
      "I'll do it after homework, promise",
    ]) {
      expect(`${text} -> ${checkMessage(text).ok}`).toBe(`${text} -> true`);
    }
  });
});
