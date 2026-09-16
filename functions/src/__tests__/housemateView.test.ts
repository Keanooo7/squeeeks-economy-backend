// What a housemate is allowed to see — and, more importantly, what they are not.
//
// 🔴 EVERY ASSERTION ABOUT THE PAYLOAD IS "ONLY THESE FIELDS", NEVER "CONTAINS
// THESE FIELDS". The entire reason this projection exists is that the source
// documents will gain fields later, and a `contains` assertion passes happily
// while a new one is carried straight through to a visitor. A projection tested
// by presence is not tested at all.

import {
  HOUSEMATE_VIEW_FIELDS,
  STARTER_FRIEND_UID,
  equippedSkinIdsFrom,
  familyRosterOf,
  mayViewHousemateData,
  projectHousemateView,
} from '../housemateView';

const HOST = 'host-uid';
const GUEST = 'guest-uid';

describe('the gate — canViewHouse, re-expressed because Admin SDK bypasses rules', () => {
  const roster = (uids: string[]) => ({ housemates: uids });

  test('a housemate on an accepted friendship may look', () => {
    expect(
      mayViewHousemateData({
        hostUid: HOST,
        guestUid: GUEST,
        hostUserData: roster([GUEST]),
        friendshipAccepted: true,
      }),
    ).toBe(true);
  });

  test('🔴 FRIENDSHIP ALONE IS NOT ENOUGH', () => {
    // The consent split the rules argue for: accepting a friend request and
    // letting someone into your home are two different consents. If this ever
    // returns true, the callable has become a way around firestore.rules.
    expect(
      mayViewHousemateData({
        hostUid: HOST,
        guestUid: GUEST,
        hostUserData: roster([]),
        friendshipAccepted: true,
      }),
    ).toBe(false);
  });

  test('being on the roster without an accepted friendship is not enough either', () => {
    // Both halves are required, so neither can be the only thing checked.
    expect(
      mayViewHousemateData({
        hostUid: HOST,
        guestUid: GUEST,
        hostUserData: roster([GUEST]),
        friendshipAccepted: false,
      }),
    ).toBe(false);
  });

  test('a host with no roster field at all denies rather than throws', () => {
    // Documents written before the feature have no `housemates` key. The rules
    // default them to "no access" via .get(key, []); this must agree.
    for (const data of [undefined, null, {}, { housemates: null }]) {
      expect(
        mayViewHousemateData({
          hostUid: HOST,
          guestUid: GUEST,
          hostUserData: data as Record<string, unknown>,
          friendshipAccepted: true,
        }),
      ).toBe(false);
    }
  });

  test('the owner may always see their own account', () => {
    expect(
      mayViewHousemateData({
        hostUid: HOST,
        guestUid: HOST,
        hostUserData: roster([]),
        friendshipAccepted: false,
      }),
    ).toBe(true);
  });

  test('gibby is everybody\'s housemate, matching isStarterFriend in the rules', () => {
    expect(
      mayViewHousemateData({
        hostUid: STARTER_FRIEND_UID,
        guestUid: GUEST,
        hostUserData: roster([]),
        friendshipAccepted: false,
      }),
    ).toBe(true);
  });

  // -------------------------------------------------------------------------
  // W2-111 — family, the second source of access
  // -------------------------------------------------------------------------
  //
  // The rules table for this lives in firestore-rules.test.ts under
  // "a family opens the door too". These are the SAME cases against the TS
  // port, because the Admin SDK bypasses rules and this predicate — not the
  // ruleset — is what stands between a visitor and getHousemateView's payload.

  test('a family member may look WITHOUT any friendship', () => {
    // 🔑 The case that proves the family branch precedes the friendship early
    // return. friendshipAccepted is false and the roster is empty: every
    // other path through this function returns false here.
    expect(
      mayViewHousemateData({
        hostUid: HOST,
        guestUid: GUEST,
        hostUserData: roster([]),
        friendshipAccepted: false,
        guestFamilyMemberUids: [HOST, GUEST],
      }),
    ).toBe(true);
  });

  test('🔴 a roster that omits the HOST denies — the decoy', () => {
    // A guest in some family is not a guest in THIS host's family. Without
    // this the branch would pass on "has a family" rather than on membership.
    expect(
      mayViewHousemateData({
        hostUid: HOST,
        guestUid: GUEST,
        hostUserData: roster([]),
        friendshipAccepted: false,
        guestFamilyMemberUids: [GUEST, 'someone-else'],
      }),
    ).toBe(false);
  });

  test('🔴 a roster that omits the GUEST denies — the stale pointer', () => {
    // Mirrors sharesFamilyWith asking the roster about BOTH uids: a guest
    // pruned from memberUids whose familyId has not yet been nulled must not
    // read the members they just left.
    expect(
      mayViewHousemateData({
        hostUid: HOST,
        guestUid: GUEST,
        hostUserData: roster([]),
        friendshipAccepted: false,
        guestFamilyMemberUids: [HOST, 'someone-else'],
      }),
    ).toBe(false);
  });

  test('🔴 omitting guestFamilyMemberUids cannot widen access', () => {
    // The parameter is optional so the change is additive. An existing call
    // site that never passes it must behave exactly as it did before — the
    // default is the DENYING value, not the permissive one.
    expect(
      mayViewHousemateData({
        hostUid: HOST,
        guestUid: GUEST,
        hostUserData: roster([]),
        friendshipAccepted: true,
      }),
    ).toBe(false);
  });

  test('an empty family roster denies', () => {
    expect(
      mayViewHousemateData({
        hostUid: HOST,
        guestUid: GUEST,
        hostUserData: roster([]),
        friendshipAccepted: false,
        guestFamilyMemberUids: [],
      }),
    ).toBe(false);
  });

  test('a housemate edge survives leaving the family', () => {
    // The brief's warning, on this surface too: family gone (empty roster),
    // token-earned housemate edge intact, access unchanged. The two paths are
    // independent because neither is stored in terms of the other.
    expect(
      mayViewHousemateData({
        hostUid: HOST,
        guestUid: GUEST,
        hostUserData: roster([GUEST]),
        friendshipAccepted: true,
        guestFamilyMemberUids: [],
      }),
    ).toBe(true);
  });

  test('an empty uid still denies even inside a family', () => {
    // The guard ordering: the empty-uid rejection must precede the family
    // branch, or two blank uids in a malformed roster would match each other.
    expect(
      mayViewHousemateData({
        hostUid: '',
        guestUid: '',
        hostUserData: roster([]),
        friendshipAccepted: false,
        guestFamilyMemberUids: ['', ''],
      }),
    ).toBe(false);
  });

  test('an empty uid on either side denies', () => {
    expect(
      mayViewHousemateData({
        hostUid: '',
        guestUid: GUEST,
        hostUserData: roster([GUEST]),
        friendshipAccepted: true,
      }),
    ).toBe(false);
    expect(
      mayViewHousemateData({
        hostUid: HOST,
        guestUid: '',
        hostUserData: roster(['']),
        friendshipAccepted: true,
      }),
    ).toBe(false);
  });
});

describe('equipped skins — worn only, never the whole collection', () => {
  test('only rows with isEquipped === true appear', () => {
    const out = equippedSkinIdsFrom([
      { id: 'skin_sofa_gold', data: { isEquipped: true, slotId: 'sofa' } },
      { id: 'skin_sofa_plain', data: { isEquipped: false, slotId: 'sofa' } },
      { id: 'skin_wall_x', data: { slotId: 'wall' } },
    ]);
    expect(out).toEqual({ sofa: 'skin_sofa_gold' });
  });

  test('🔴 CHARACTER SKINS ARE INCLUDED — the actual gap', () => {
    // If you can see someone's house you already see their walls, floors and
    // furniture. The animal standing in it was the one thing missing.
    const out = equippedSkinIdsFrom([
      { id: 'char_pyjama', data: { isEquipped: true, slotId: 'character' } },
    ]);
    expect(out).toEqual({ character: 'char_pyjama' });
  });

  test('truthy is not true — a string or a 1 does not count as worn', () => {
    // The owner's own screen draws `isEquipped === true`. Anything looser here
    // publishes a skin the host does not see themselves wearing.
    const out = equippedSkinIdsFrom([
      { id: 'a', data: { isEquipped: 'true', slotId: 's' } },
      { id: 'b', data: { isEquipped: 1, slotId: 's' } },
      { id: 'c', data: { isEquipped: {}, slotId: 's' } },
    ]);
    expect(out).toEqual({});
  });

  test('a missing or malformed document is skipped, not thrown on', () => {
    expect(
      equippedSkinIdsFrom([
        { id: 'a', data: undefined },
        { id: 'b', data: null },
      ]),
    ).toEqual({});
  });

  test('a row with no slotId falls back to its own id', () => {
    expect(
      equippedSkinIdsFrom([{ id: 'skin_x', data: { isEquipped: true } }]),
    ).toEqual({ skin_x: 'skin_x' });
  });
});

describe('🔴 the projection returns ONLY the allowed fields', () => {
  test('the payload keys are exactly HOUSEMATE_VIEW_FIELDS', () => {
    const view = projectHousemateView({
      hostUid: HOST,
      equippedSkinIds: { sofa: 'skin_sofa_gold' },
    });
    expect(Object.keys(view).sort()).toEqual([...HOUSEMATE_VIEW_FIELDS].sort());
  });

  test('the allowlist itself is non-empty and has no duplicates', () => {
    // Guards the assertion above: an empty allowlist would make "keys equal
    // allowlist" true of an empty object, and the whole file vacuous.
    expect(HOUSEMATE_VIEW_FIELDS.length).toBeGreaterThan(0);
    expect(new Set(HOUSEMATE_VIEW_FIELDS).size).toBe(
      HOUSEMATE_VIEW_FIELDS.length,
    );
  });

  test('tasks are NOT in the payload, and that is deliberate', () => {
    // The server cannot recover the host's timezone — streak.ts, quests.ts and
    // galleryFeedback.ts all say so, and an entire quest is filed unbuildable
    // for it. The viewer's day is the wrong day for a screen that claims to
    // show what the HOST is cleaning. See housemateView.ts.
    expect(HOUSEMATE_VIEW_FIELDS).not.toContain('tasks');
    expect(HOUSEMATE_VIEW_FIELDS).not.toContain('todaysTasks');
  });

  test('the skin map is COPIED, so the caller cannot mutate the source', () => {
    const source = { sofa: 'skin_sofa_gold' };
    const view = projectHousemateView({ hostUid: HOST, equippedSkinIds: source });
    source.sofa = 'mutated';
    expect(view.equippedSkinIds).toEqual({ sofa: 'skin_sofa_gold' });
  });
});

describe('familyRosterOf — the counterpart of familyRoster() in the rules', () => {
  test('reads memberUids off a well-formed family document', () => {
    expect(familyRosterOf({ memberUids: ['a', 'b'], ownerUid: 'a' }))
      .toEqual(['a', 'b']);
  });

  test('a malformed or missing family reads as NO family, never a throw', () => {
    // firestore.rules reads .get('memberUids', []) so a malformed document
    // denies rather than erroring the whole expression out. This must agree,
    // or the two ports disagree on exactly the documents nobody tested.
    for (const data of [undefined, null, {}, { memberUids: null },
      { memberUids: 'a' }, { memberUids: 42 }]) {
      expect(familyRosterOf(data as Record<string, unknown>)).toEqual([]);
    }
  });

  test('🔴 drops non-string entries rather than carrying them', () => {
    // Same argument as rosterOf: a uid that is not a string can never equal
    // one that is, so keeping it could only ever produce a wrong answer.
    expect(familyRosterOf({ memberUids: ['a', 7, null, {}, 'b'] }))
      .toEqual(['a', 'b']);
  });
});
