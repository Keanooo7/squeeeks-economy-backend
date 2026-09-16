// functions/src/__tests__/minigame.test.ts
//
// W2-17. The organisation mini-game's daily claim.
//
// 🔑 The load-bearing test in this file is not the happy path. It is
// `the server does NOT validate the arrangement`, which pins an ABSENCE — and an
// absence is exactly what a well-meaning future change deletes. Someone will
// eventually read "the server grants without checking the puzzle" as a bug and
// add validation, shipping the slot-fit rule twice. That test makes them argue
// with a gate first.

import {
  MINIGAME_REWARD,
  MINIGAME_REWARDS_ARE_PROVISIONAL,
  canClaimMinigame,
  minigameDayKey,
} from '../minigame';

const DAY = '2026-08-12';
const NEXT = '2026-08-13';

import {codeOf, handlerBody} from './helpers/sourceText';

const read = (f: string): string =>
  require('fs').readFileSync(require('path').join(__dirname, '..', f), 'utf8');

/** CODE — comments removed. See helpers/sourceText.ts for why both exist. */
const readCode = (f: string): string => codeOf(read(f));

/** The callable's body, sliced at its own closing `});`. */
/**
 * CODE view of the handler.
 *
 * 🔑 W2-30 measured this before changing it: `arrangement`, `placements`,
 * `slots`, `solution`, `board` and `grid` were all absent raw AND stripped —
 * the guard was clean. It was clean by PLACEMENT, not by design: the block
 * comment explaining "No arrangement is accepted, none is checked" sits ABOVE
 * `export const`, so the slice never included it. Move that comment inside the
 * function and the `.not.toContain` guards go falsely RED for a change nobody
 * made. This removes the dependency on where a comment happens to sit.
 */
function handler(): string {
  return codeOf(handlerBody(read('index.ts'), 'claimMinigamePrize'));
}

describe('one claim per player per day', () => {
  test('an unclaimed day can be claimed', () => {
    expect(canClaimMinigame(undefined, DAY)).toBe(true);
    expect(canClaimMinigame({}, DAY)).toBe(true);
  });

  test('🔴 a SECOND claim on the same day grants nothing — attempted, not asserted', () => {
    // The attack, such as it is: solve, claim, claim again.
    let ledger = {} as {date?: string; claimed?: boolean};
    expect(canClaimMinigame(ledger, DAY)).toBe(true);
    ledger = {date: DAY, claimed: true}; // as the transaction writes it
    expect(canClaimMinigame(ledger, DAY)).toBe(false);
  });

  test('and a tenth claim still grants nothing', () => {
    const ledger = {date: DAY, claimed: true};
    for (let i = 0; i < 10; i++) expect(canClaimMinigame(ledger, DAY)).toBe(false);
  });

  test('🔑 but yesterday\'s ledger does NOT lock the player out today', () => {
    // A stale row means "yesterday was claimed", which says nothing about today.
    // Reading it as a claim would lock a player out permanently after one solve
    // — the failure grantTaskRewards avoids by treating a previous day as zero.
    expect(canClaimMinigame({date: DAY, claimed: true}, NEXT)).toBe(true);
  });

  test('a ledger with a date but no claim flag is claimable', () => {
    expect(canClaimMinigame({date: DAY}, DAY)).toBe(true);
    expect(canClaimMinigame({date: DAY, claimed: false}, DAY)).toBe(true);
  });

  test('the writer sets date AND claimed together', () => {
    // Either alone is a bug: `date` alone makes yesterday look like today's
    // claim, `claimed` alone locks the player out forever.
    expect(handler()).toContain('{ date: dayKey, claimed: true }');
  });
});

describe('🔴 the server does NOT validate the arrangement — pinned so a "fix" must argue', () => {
  test('the callable accepts no puzzle state at all', () => {
    const body = handler();
    // 🔑 STRENGTHENED BY W2-172, NOT WEAKENED. This asserted
    // `expect(body).toContain('const { clientNowIso } = request.data')` —
    // "only the clock comes in" — which was the strongest available statement
    // while the clock DID come in. It reads nothing from `request.data` now, so
    // the claim is the stronger one: no client value reaches this handler at
    // all, and there is no field to add a puzzle to without deleting this line.
    expect(body).not.toContain('request.data');
    for (const forbidden of ['arrangement', 'placements', 'slots', 'solution', 'board', 'grid']) {
      expect(body.toLowerCase()).not.toContain(forbidden);
    }
  });

  test('a claim with no puzzle state still grants — that is the design', () => {
    // Expressed against the pure gate: nothing about the puzzle is an input to
    // whether the reward is owed. Only the day and the ledger are.
    expect(canClaimMinigame(undefined, DAY)).toBe(true);
    expect(canClaimMinigame.length).toBe(2); // (ledger, dayKey) — no third input
  });

  test('the reasoning is recorded in the module, not only in a PR body', () => {
    // A finding that lives only in a review is lost on the next /clear.
    const src = read('minigame.ts');
    expect(src).toContain('VALIDATES THE CLAIM, NOT THE DRAG');
    expect(src).toMatch(/SECOND IMPLEMENTATION/);
    // And the exposure is stated rather than glossed.
    expect(src).toMatch(/debugger can call this and collect the reward/);
  });
});

describe('📌 the daily clock is reused; subjectForDay deliberately is not', () => {
  // 🔴 REWRITTEN BY W2-172 BECAUSE IT PINNED THE DEFECT. This test read:
  //
  //     expect(handler()).toContain("clientNowIso.slice(0, 10)");
  //     expect(readCode('index.ts')).toContain(
  //       'const dayKey = clientNowIso.slice(0, 10);');
  //
  // and it was RIGHT about what it set out to check — that the callable reuses
  // an existing daily derivation instead of inventing a second clock. What it
  // could not see is that the derivation it pinned took its value from the
  // CALLER. So the guard against a second clock was holding the wrong clock in
  // place, and any change to a server-derived key would have gone red as a
  // regression. That is the shape worth remembering: a test can be correct
  // about its own question and still be the thing standing in the way.
  //
  // The intent survives — reuse, don't invent — and the reuse is now
  // `new Date().toISOString().split('T')[0]`, which index.ts:482, :3138, :3485
  // and notifications.ts:27 already use to derive a server day.
  test('the dayKey is server-derived, and reuses the existing server-day shape', () => {
    expect(handler()).toContain('minigameDayKey()');
    expect(handler()).not.toContain('clientNowIso.slice');
    // CODE — the derivation itself, in minigame.ts, not merely a comment
    // claiming it is server-side.
    expect(readCode('minigame.ts')).toContain("now.toISOString().split('T')[0]");
    // And it is the shape already in use elsewhere, not a fourth clock.
    expect(readCode('index.ts')).toContain("new Date().toISOString().split('T')[0]");
  });

  test('🔑 the accepted-risk paragraph names the bound that failed', () => {
    // minigame.ts accepts that a player with a debugger can claim without
    // solving, "bounded by the same thing that bounds it for a solved puzzle:
    // ONCE PER DAY". That acceptance rested on a bound the client could pick
    // its way around. The module has to say so where the risk is evaluated, or
    // the next reader re-derives the same false comfort.
    expect(read('minigame.ts')).toContain('THE BOUND THAT ACCEPTANCE RESTED ON');
  });

  test('the callable does not touch subjectForDay or the shop pools', () => {
    const body = handler();
    expect(body).not.toContain('subjectForDay');
    expect(body).not.toContain('DAILY_SUBJECT_POOLS');
  });

  test('and minigame.ts imports nothing from itemPool', () => {
    // The weld this brief was told to check for. Reusing the pool would make
    // adding a puzzle require stocking a chest at three rarities.
    const src = read('minigame.ts');
    expect(src).not.toMatch(/from '\.\/itemPool'/);
  });

  test('the reason for not reusing it is written down, with the invariant named', () => {
    const src = read('minigame.ts');
    expect(src).toContain('STOCKED AT EVERY RARITY');
    expect(src).toContain('itemPool.ts:169');
  });
});

describe('no value is decided here', () => {
  test('the reward is marked provisional', () => {
    expect(MINIGAME_REWARDS_ARE_PROVISIONAL).toBe(true);
  });

  test('the mini-game carries no number of its own', () => {
    // Mirrors the quest rule that kept that economy a one-file edit. The
    // callable must READ the table, never restate it.
    const body = handler();
    expect(body).toContain('MINIGAME_REWARD.sponges');
    expect(body).not.toMatch(/increment\(\s*\d/);
    expect(body).not.toMatch(/sponges:\s*\d/);
  });

  test('the value lives in exactly one place', () => {
    const src = read('minigame.ts');
    const occurrences = (src.match(/sponges: \d+/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(MINIGAME_REWARD.sponges).toBe(50);
  });

  test('it grants sponges only — no XP was invented', () => {
    // The spec names sponges. Quests award XP by an explicit Brendan ruling
    // (W2-12); nothing has ruled on the mini-game, so nothing is granted.
    const body = handler();
    expect(body).not.toContain('XP_FIELD');
    expect(body).not.toContain('awardXp');
    expect(body).not.toContain('totalXp');
  });
});

describe('a replay is a no-op that reports itself, not an error', () => {
  test('the handler returns rather than throwing on a second claim', () => {
    const body = handler();
    expect(body).toContain('alreadyClaimed: true');
    // A dropped response is an ordinary client event; throwing would turn a
    // retry into a visible failure.
    const afterGuard = body.slice(body.indexOf('canClaimMinigame'));
    expect(afterGuard).not.toContain('already-exists');
  });

  test('it reports the dayKey it settled, so the client need not guess', () => {
    expect(handler()).toContain('dayKey');
  });
});

// ---------------------------------------------------------------------------
// W2-35 — a failed first-run grant should leave a trace, and so should a good one
// ---------------------------------------------------------------------------
//
// 🔴 onNewUserBefriendGibby swallows its errors, deliberately and correctly: a
// failed Gibby write must never be able to fail signup. The cost is that a
// failure and a success both finish with platform status 'ok', so the outcome
// is invisible from outside.
//
// W2-31 hit the sharper half of that. The only line carrying a uid was the
// console.error, which never fires — so a SUCCESS was anonymous too. That
// investigation could prove the trigger ran twice on the night a guest reported
// Gibby missing, and could NOT prove either firing belonged to his account.
//
// These pin the trace, and they pin the swallow, because the fix is worthless
// if a later change removes either.

describe('🔑 the Gibby trigger names the account on BOTH outcomes', () => {
  const indexSrc = (): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', 'index.ts'), 'utf8');

  const trigger = (): string =>
    codeOf(handlerBody(indexSrc(), 'onNewUserBefriendGibby'));

  test('the success path logs the uid', () => {
    // Without this, "it ran" and "it ran for THIS person" are the same log line.
    const body = trigger();
    expect(body).toContain('console.log');
    expect(body).toContain('uid=${user.uid}');
  });

  test('the success line reports whether the friendship was written', () => {
    // `ensureGibbyFriendship` returns false for a uid it refuses (Gibby
    // himself). "ok" without that is ambiguous between "wrote it" and
    // "declined to".
    expect(trigger()).toContain('friendship=');
  });

  test('🔴 the swallow is still there — the fix must not have removed it', () => {
    // A player without Gibby is a missing friend; a player stuck at signup is a
    // lost install. If someone "improves" this by rethrowing, the platform
    // retries until backoff expires and signup can hang.
    const body = trigger();
    expect(body).toContain('catch');
    expect(body).toContain('console.error');
    expect(body).not.toMatch(/catch[\s\S]*\bthrow\b/);
  });

  test('📌 the ERROR wording is unchanged, because evidence depends on it', () => {
    // `grep -c "failed for"` returning 0 across all history is what W2-31 rests
    // on. Rewording it would silently invalidate a repeat of that check against
    // logs already written.
    expect(trigger()).toContain('failed for ${user.uid}');
  });

  test('one grep finds either outcome for a named account', () => {
    // The whole design constraint: functions:log is the only production tool
    // reachable from this window, so both lines must carry the raw uid.
    const body = trigger();
    const success = body.slice(body.indexOf('console.log'));
    const failure = body.slice(body.indexOf('console.error'));
    expect(success).toContain('user.uid');
    expect(failure).toContain('user.uid');
  });
});

describe('the already-exists message is restated, and only half of it is mine', () => {
  const indexSrc = (): string =>
    require('fs').readFileSync(require('path').join(__dirname, '..', 'index.ts'), 'utf8');

  test('both server sites carry the calmer wording', () => {
    // True either way; this one reads as a statement rather than a fault.
    const hits = indexSrc().split('already claimed its welcome chest').length - 1;
    expect(hits).toBe(2);
  });

  test('⚠️ the CODE is untouched, because the shipped client matches on it', () => {
    // shop_repository_impl.dart:120 branches on e.code == 'already-exists' and
    // substitutes its own text. Changing the code would break the shipped
    // build; changing the message cannot.
    expect(indexSrc()).toContain("'already-exists'");
  });

  test('the comment records that the player never sees this string', () => {
    // So the next person asked to "fix the wording" edits lib/, not this.
    expect(indexSrc()).toContain('NOT THE STRING THE PLAYER SEES');
  });
});

// ---------------------------------------------------------------------------
// W2-172 · the once-per-day key was chosen by the CALLER
// ---------------------------------------------------------------------------
//
// 🔴 THE HOLE THESE TESTS CLOSE, AND WHY THE EXISTING ONES COULD NOT SEE IT.
// Above, `a SECOND claim on the same day grants nothing` is correct and was
// never the whole question. It fixes `dayKey` and varies the ledger — so it
// pins replay for ONE key. The handler took its key from
// `clientNowIso.slice(0, 10)`, and `canClaimMinigame` keeps ONE row and grants
// on any key that is not the last one, so a caller alternating two well-formed
// dates was granted every time. 50 sponges per call, unbounded, against a
// callable that is DEPLOYED and ACTIVE with `ingressSettings: ALLOW_ALL`.
//
// 📌 `economyIdempotency.test.ts:104-106` records the same reasoning and is
// true for exactly the same reason and to exactly the same depth: "a replay
// returns alreadyClaimed and grants nothing" holds for a replay with the SAME
// dayKey, which is the question that file set out to answer. Neither file was
// wrong. Both were silent on the key's SOURCE, and that silence is the gap.
// → the fix is minigameDayKey(), which takes no client input at all.

/** The transaction's decide-and-write loop, as a pure replay. */
function claimRun(dayKeys: readonly string[]): number {
  let ledger: {date?: string; claimed?: boolean} | undefined;
  let granted = 0;
  for (const key of dayKeys) {
    if (!canClaimMinigame(ledger, key)) continue;
    granted += MINIGAME_REWARD.sponges;
    ledger = {date: key, claimed: true}; // exactly what the tx writes
  }
  return granted;
}

describe('🔴 the day key comes from the server, not the caller', () => {
  test('THE ATTACK: alternating two well-formed dates mints once, not forever', () => {
    // What the caller sends. Every one of these is a valid ISO instant and
    // passes the old `^\d{4}-\d{2}-\d{2}$` shape check.
    const attack = [
      '2026-09-03T10:00:00',
      '2026-09-04T10:00:00',
      '2026-09-03T11:00:00',
      '2026-09-04T11:00:00',
      '1999-01-01T00:00:00',
    ];

    // The CONTROL, and it is the whole test: this is what the handler did.
    // Kept as an executable statement of the defect rather than a sentence,
    // because a comment describing a hole cannot fail when the hole comes back.
    const asClientChose = claimRun(attack.map((iso) => iso.slice(0, 10)));
    expect(asClientChose).toBe(5 * MINIGAME_REWARD.sponges);

    // What it does now: the key is the server's, so the caller's five payloads
    // collapse to one day and the second through fifth grant nothing.
    const now = new Date('2026-09-03T10:30:00Z');
    const asServerDerives = claimRun(attack.map(() => minigameDayKey(now)));
    expect(asServerDerives).toBe(MINIGAME_REWARD.sponges);
  });

  test('minigameDayKey takes no client input and cannot be moved by one', () => {
    // Its only parameter is a clock, and the handler passes none — so there is
    // no argument on the wire that can reach it.
    expect(minigameDayKey.length).toBeLessThanOrEqual(1);
    expect(minigameDayKey(new Date('2026-09-03T00:00:00Z'))).toBe('2026-09-03');
    expect(minigameDayKey(new Date('2026-09-03T23:59:59Z'))).toBe('2026-09-03');
    expect(minigameDayKey(new Date('2026-09-04T00:00:00Z'))).toBe('2026-09-04');
  });

  test('🔑 the handler no longer derives the key from request data', () => {
    // The assertion that would have caught this before it shipped. CODE view,
    // so the comment above the handler explaining the old shape cannot satisfy
    // it — the same discipline W2-30 established for this file.
    const body = handler();
    expect(body).not.toContain('clientNowIso.slice');
    expect(body).toContain('minigameDayKey()');
  });

  test('and it is not required on the wire, so no payload shape breaks', () => {
    // Nothing in lib/ has ever called this — zero callers across the whole
    // history — so there is nothing to break either way. Keeping the field
    // accepted and unrequired means a client written to either shape works.
    expect(handler()).not.toContain("'clientNowIso required'");
  });
});
