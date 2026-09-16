// functions/src/__tests__/trashDay.test.ts
//
// W2-77. One person takes the bins out and it clears for everyone.
//
// ---------------------------------------------------------------------------
// 🔴 "CLEARS FOR ALL" AND "CLEARS FOR ANYONE" ARE THE SAME TEST UNLESS ONE
// ASSERTS A REFUSAL
// ---------------------------------------------------------------------------
//
// The brief named both controls and they are the reason this file exists:
//
//   · a NON-MEMBER's completion must NOT clear the family's bin day — without
//     it, any authenticated account could clear any household's reminder, and
//     the failure would be invisible until somebody's bins were not put out;
//   · a member of ANOTHER family must be unaffected — the failure mode is one
//     shared fact keyed too broadly.
//
// Both are asserted here on the plan, and again in firestore-rules.test.ts on
// the read path, because they are different mechanisms: the plan refuses a
// write, the rules refuse a read, and neither implies the other.
//
// ⚠️ EVERY CONTROL'S MUTATION WAS VERIFIED APPLIED BEFORE ITS RESULT WAS READ,
// per #383 and #384 — where a fourth control silently changed nothing and read
// exactly like a pass, and another left every fixture green because the term it
// removed was redundant with one every fixture already satisfied.

import {FamilyDoc} from '../family';
import {
  BIN_DATE_MAX_SKEW_DAYS,
  reconcileTrashDay,
  TrashDayCompletion,
  isValidBinDateKey,
  planTrashDayCompletion,
  utcBinDateKey,
} from '../trashDay';

const PARENT = 'uid-parent';
const KID = 'uid-kid';
const OUTSIDER = 'uid-outsider';
const OTHER_PARENT = 'uid-other-parent';

// 2026-08-15T12:00:00Z — midday, so the ±2-day window is not measured from a
// boundary that would make an off-by-one invisible.
const NOW = Date.parse('2026-08-15T12:00:00Z');
const TODAY = '2026-08-15';

const familyOf = (memberUids: string[]): FamilyDoc => ({
  ownerUid: memberUids[0],
  memberUids,
  createdAtMs: NOW - 30 * 86_400_000,
});

const OURS = familyOf([PARENT, KID]);
const THEIRS = familyOf([OTHER_PARENT, OUTSIDER]);

const plan = (over: Partial<Parameters<typeof planTrashDayCompletion>[0]> = {}) =>
  planTrashDayCompletion({
    family: OURS,
    actorUid: PARENT,
    binDateKey: TODAY,
    nowMs: NOW,
    existing: null,
    ...over,
  });

describe('a member completes it, and it clears for the whole family', () => {
  test('the completion records who and when', () => {
    const r = plan();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wrote).toBe(true);
    expect(r.completion).toEqual({
      binDateKey: TODAY,
      completedByUid: PARENT,
      completedAtMs: NOW,
    });
  });

  test('🔑 it clears for EVERY member, not just the one who did it', () => {
    const r = plan();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clearsFor.sort()).toEqual([PARENT, KID].sort());
  });

  test('a kid can complete it too — this is not owner-only', () => {
    const r = plan({actorUid: KID});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.completion.completedByUid).toBe(KID);
  });
});

describe('🔴 CONTROL — a non-member does NOT clear the family bin day', () => {
  test('an outsider is refused', () => {
    // Without this, "clears for all" and "clears for anyone" are one function.
    const r = plan({actorUid: OUTSIDER});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('not-a-member');
  });

  test('a member of ANOTHER family is refused against ours', () => {
    // The second named control, at the plan level. OTHER_PARENT is a perfectly
    // real member — of a different family.
    const r = plan({actorUid: OTHER_PARENT});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('not-a-member');
  });

  test('🔴 and the same person IS allowed in their own family', () => {
    // The inverse control, and it is what makes the two above mean "not a
    // member of THIS family" rather than "not allowed at all". Without it,
    // refusing everybody would pass both.
    const r = plan({family: THEIRS, actorUid: OTHER_PARENT});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clearsFor.sort()).toEqual([OTHER_PARENT, OUTSIDER].sort());
  });

  test('🔴 one family\'s clearsFor never names the other family\'s members', () => {
    // The "keyed too broadly" failure, stated directly. The document is also
    // keyed under the family, so this is belt-and-braces — but a plan that
    // returned every uid it had seen would pass every other test here.
    const ours = plan();
    const theirs = plan({family: THEIRS, actorUid: OTHER_PARENT});
    expect(ours.ok && theirs.ok).toBe(true);
    if (!ours.ok || !theirs.ok) return;
    expect(ours.clearsFor).not.toContain(OTHER_PARENT);
    expect(ours.clearsFor).not.toContain(OUTSIDER);
    expect(theirs.clearsFor).not.toContain(PARENT);
    expect(theirs.clearsFor).not.toContain(KID);
  });

  test('membership is refused before the date is even examined', () => {
    // A non-member should not learn whether a date was well-formed. Also means
    // a malformed date from an outsider reports the more serious refusal.
    const r = plan({actorUid: OUTSIDER, binDateKey: 'not-a-date'});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('not-a-member');
  });

  test('an invalid family clears nobody, even for a listed member', () => {
    // Fails closed: a malformed roster is not a reason to treat the caller as
    // a member of it. Owner absent from memberUids — invalid per family.ts.
    const broken: FamilyDoc = {
      ownerUid: 'uid-ghost',
      memberUids: [PARENT, KID],
      createdAtMs: NOW,
    };
    const r = plan({family: broken});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('invalid-family');
  });
});

describe('the bin date is a real date, and near today', () => {
  test('a well-formed date passes', () => {
    expect(isValidBinDateKey('2026-08-15')).toBe(true);
  });

  test('🔴 a date that only LOOKS well-formed is refused', () => {
    // The pattern alone accepts these. Date.parse rolls 2026-02-31 to March 3rd,
    // so the document id would name a day that does not exist and every later
    // lookup for the real date would miss it.
    expect(isValidBinDateKey('2026-02-31')).toBe(false);
    expect(isValidBinDateKey('2026-13-01')).toBe(false);
    expect(isValidBinDateKey('2026-00-10')).toBe(false);
  });

  test('non-strings and wrong shapes are refused', () => {
    for (const bad of ['15-08-2026', '2026-8-15', '', 'today', 42, null, undefined, {}]) {
      expect(isValidBinDateKey(bad)).toBe(false);
    }
  });

  test('yesterday and tomorrow are inside the window', () => {
    // A real timezone can put a household a day either side of UTC.
    expect(plan({binDateKey: '2026-08-14'}).ok).toBe(true);
    expect(plan({binDateKey: '2026-08-16'}).ok).toBe(true);
  });

  test('the window edge is inclusive, and one day past it is not', () => {
    expect(BIN_DATE_MAX_SKEW_DAYS).toBe(2);
    expect(plan({binDateKey: '2026-08-13'}).ok).toBe(true);
    const tooFar = plan({binDateKey: '2026-08-12'});
    expect(tooFar.ok).toBe(false);
    if (tooFar.ok) return;
    expect(tooFar.refusal).toBe('bin-date-out-of-range');
  });

  test('🔴 a bin day weeks out cannot be pre-cleared', () => {
    // The one abuse that would be invisible until the bins were missed.
    const r = plan({binDateKey: '2026-09-30'});
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.refusal).toBe('bin-date-out-of-range');
  });

  test('utcBinDateKey is the bound, and is not used to SET the date', () => {
    expect(utcBinDateKey(NOW)).toBe(TODAY);
  });
});

describe('a second completion preserves the first, and does not rewrite', () => {
  const first: TrashDayCompletion = {
    binDateKey: TODAY,
    completedByUid: KID,
    completedAtMs: NOW - 3600_000,
  };

  test('🔑 the kid took the bins out; the parent tapping later does not steal it', () => {
    const r = plan({actorUid: PARENT, existing: first});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wrote).toBe(false);
    expect(r.completion).toEqual(first);
    expect(r.completion.completedByUid).toBe(KID);
  });

  test('it still reports as cleared for the whole family', () => {
    const r = plan({actorUid: PARENT, existing: first});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.clearsFor.sort()).toEqual([PARENT, KID].sort());
  });

  test('🔴 a completion for a DIFFERENT bin date does not satisfy today', () => {
    // The dated-key property, and the reason acknowledgedFor is a date rather
    // than a bool: last week's completion must not pre-clear this week.
    const lastWeek: TrashDayCompletion = {
      binDateKey: '2026-08-08',
      completedByUid: KID,
      completedAtMs: NOW - 7 * 86_400_000,
    };
    const r = plan({existing: lastWeek});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.wrote).toBe(true);
    expect(r.completion.binDateKey).toBe(TODAY);
    expect(r.completion.completedByUid).toBe(PARENT);
  });
});

// ---------------------------------------------------------------------------
// W2-81 — RECONCILIATION: the local cache versus the shared fact
// ---------------------------------------------------------------------------
//
// 🔴 THE FAILURE THIS FILE IS NOW ALSO GUARDING: a device that has not synced
// must not be able to un-clear what a housemate cleared.
//
// ⚠️ AND THE CONTROL THAT KEEPS IT HONEST is the ordinary case — one device,
// one same-day ack, no server record. If the rule were simply "the server
// replaces the local answer", THAT case would break: a member who tapped OK
// while offline (which is every member today, since nothing stamps a familyId)
// would be shown the takeover again. So the tests below assert BOTH directions;
// either alone is satisfied by a rule that is wrong in the other.

describe('🔴 W2-81 reconcileTrashDay — a device cannot un-clear a housemate', () => {
  const OTHERS_COMPLETION: TrashDayCompletion = {
    binDateKey: TODAY,
    completedByUid: PARENT,
    completedAtMs: 1_760_000_000_000,
  };

  test('🔴 THE FAILURE: server cleared, device knows NOTHING -> still cleared', () => {
    // The un-synced device. If this is ever false, a housemate's completion has
    // been un-cleared by a device that simply had not heard about it.
    const r = reconcileTrashDay({
      binDateKey: TODAY,
      serverCompletion: OTHERS_COMPLETION,
      localAckBinDateKey: null,
    });
    expect(r.cleared).toBe(true);
    expect(r.clearedBy).toBe('server');
    expect(r.completion?.completedByUid).toBe(PARENT);
  });

  test('🔴 server cleared, device holds a STALE ack for another day -> cleared', () => {
    // Sharper than the null case: the device has a positive local value that
    // disagrees. A precedence rule written the wrong way round would let this
    // stale ack decide, and the takeover would return for a day already done.
    const r = reconcileTrashDay({
      binDateKey: TODAY,
      serverCompletion: OTHERS_COMPLETION,
      localAckBinDateKey: '2026-08-01',
    });
    expect(r.cleared).toBe(true);
    expect(r.clearedBy).toBe('server');
  });

  test('the un-synced device is told to update its cache, and not to push', () => {
    const r = reconcileTrashDay({
      binDateKey: TODAY,
      serverCompletion: OTHERS_COMPLETION,
      localAckBinDateKey: null,
    });
    expect(r.mustCacheLocally).toBe(true);
    // Re-pushing cannot change the record — the first completer is preserved —
    // so a push here is a wasted call, not a harmless one.
    expect(r.mustPush).toBe(false);
  });

  test('🔴 CONTROL — an ordinary same-day ack from the ONLY device still clears', () => {
    // The inverse failure, and the reason "server wins" is not the rule. With
    // no server record, a server-authoritative reading would show the takeover
    // again to someone who already tapped OK.
    const r = reconcileTrashDay({
      binDateKey: TODAY,
      serverCompletion: null,
      localAckBinDateKey: TODAY,
    });
    expect(r.cleared).toBe(true);
    expect(r.clearedBy).toBe('local');
    expect(r.mustPush).toBe(true);
    expect(r.mustCacheLocally).toBe(false);
  });

  test('🔴 CONTROL — nobody has done it: not cleared, and nothing to sync', () => {
    // Without this, a function that returned `cleared: true` unconditionally
    // would pass every test above.
    const r = reconcileTrashDay({
      binDateKey: TODAY,
      serverCompletion: null,
      localAckBinDateKey: null,
    });
    expect(r.cleared).toBe(false);
    expect(r.clearedBy).toBeNull();
    expect(r.mustPush).toBe(false);
    expect(r.mustCacheLocally).toBe(false);
  });

  test('an unreachable server and an empty one are the SAME input', () => {
    // Both are `null`, deliberately: if offline were a distinct case it would be
    // a distinct code path, and it would be the one nobody exercises.
    const offline = reconcileTrashDay({
      binDateKey: TODAY,
      serverCompletion: null,
      localAckBinDateKey: TODAY,
    });
    const empty = reconcileTrashDay({
      binDateKey: TODAY,
      serverCompletion: null,
      localAckBinDateKey: TODAY,
    });
    expect(offline).toEqual(empty);
  });
});

describe('🔴 W2-81 reconcileTrashDay — the date is what scopes it', () => {
  test("a completion for ANOTHER day does not clear this one", () => {
    // The whole reason the fact is dated: a bool cannot tell this week from
    // three weeks ago, so next week's reminder would arrive pre-dismissed.
    const r = reconcileTrashDay({
      binDateKey: TODAY,
      serverCompletion: {
        binDateKey: '2026-08-01',
        completedByUid: PARENT,
        completedAtMs: 1,
      },
      localAckBinDateKey: null,
    });
    expect(r.cleared).toBe(false);
    expect(r.clearedBy).toBeNull();
    expect(r.completion).toBeNull();
  });

  test('a local ack for another day does not clear this one either', () => {
    const r = reconcileTrashDay({
      binDateKey: TODAY,
      serverCompletion: null,
      localAckBinDateKey: '2026-08-01',
    });
    expect(r.cleared).toBe(false);
    expect(r.mustPush).toBe(false);
  });

  test('⚠️ keys are compared as STRINGS — no instant is ever derived', () => {
    // Parsing a key to a timestamp is how a comparison acquires a timezone it
    // should not have, and this module has both a UTC helper and a local key in
    // scope. `2026-08-10` and a `2026-08-10T…Z` instant are not interchangeable
    // inputs here, and the mismatch must simply not match rather than be
    // coerced into agreeing.
    const r = reconcileTrashDay({
      binDateKey: TODAY,
      serverCompletion: null,
      localAckBinDateKey: `${TODAY}T00:00:00Z`,
    });
    expect(r.cleared).toBe(false);
  });

  test('both sources agreeing reports the SERVER, because it names a person', () => {
    const r = reconcileTrashDay({
      binDateKey: TODAY,
      serverCompletion: {
        binDateKey: TODAY,
        completedByUid: PARENT,
        completedAtMs: 5,
      },
      localAckBinDateKey: TODAY,
    });
    expect(r.clearedBy).toBe('server');
    expect(r.completion?.completedByUid).toBe(PARENT);
    // Already in sync in both directions.
    expect(r.mustPush).toBe(false);
    expect(r.mustCacheLocally).toBe(false);
  });
});
