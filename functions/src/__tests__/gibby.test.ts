// functions/src/__tests__/gibby.test.ts
//
// Pure-logic tests for Gibby: the gift roll and the friend-edge shape.
//
// Gibby is a PERMANENT starter friend. The random part is the gift's CONTENTS,
// never the sender — so these tests pin the distribution and leave the sender
// fixed. The roll is server-side; nothing here may depend on a client value
// other than the one capability flag tested below.
//
// DETERMINISM: never `jest.spyOn(Math, 'random').mockReturnValue(k)`. A constant
// pivot recurses jest's own quicksort to death before a single test runs. Every
// roll below is INJECTED — either a seeded generator or a deterministic sweep of
// the unit interval, both of which return a different value each call.

import {
  GIBBY_UID,
  GIBBY_DISPLAY_NAME,
  GIBBY_CHEST_CHANCE,
  GIBBY_SPONGES_MIN,
  GIBBY_SPONGES_MAX,
  FRIEND_EDGE_KEYS,
  rollGibbyGift,
  gibbyFriendEdge,
  GIBBY_HOUSE_LAYOUT,
  GIBBY_USER_DOC,
} from '../gibby';

/**
 * mulberry32 — a seeded PRNG. Deterministic across runs, and crucially NOT
 * constant, so sorting a derived array cannot degenerate.
 */
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Walks [0,1) in `steps` even increments, wrapping. Stronger than sampling: it
 * proves a bound over the WHOLE interval rather than over the values a seed
 * happened to visit.
 */
function sweep(steps: number): () => number {
  let i = 0;
  return () => {
    const v = (i % steps) / steps;
    i += 1;
    return v;
  };
}

describe('rollGibbyGift — the sponge band', () => {
  it('never lands outside 5–15, anywhere in the unit interval', () => {
    // chestEnabled false ⇒ exactly one roll consumed per call, so each sweep
    // value is tested as a sponge roll.
    const roll = sweep(1000);
    for (let i = 0; i < 1000; i++) {
      const gift = rollGibbyGift(roll, false);
      expect(gift.sponges).toBeGreaterThanOrEqual(GIBBY_SPONGES_MIN);
      expect(gift.sponges).toBeLessThanOrEqual(GIBBY_SPONGES_MAX);
    }
  });

  it('actually spans the whole band rather than clustering', () => {
    const roll = sweep(1000);
    const seen = new Set<number>();
    for (let i = 0; i < 1000; i++) seen.add(rollGibbyGift(roll, false).sponges);

    const expected = new Set<number>();
    for (let n = GIBBY_SPONGES_MIN; n <= GIBBY_SPONGES_MAX; n++) expected.add(n);
    expect([...seen].sort((a, b) => a - b)).toEqual([...expected]);
  });

  it('always yields an integer, because the client hard-casts it', () => {
    // shop_repository_impl.dart:112 does `data['amount'] as int`. A double
    // crashes the claim screen rather than degrading.
    const roll = seededRng(20260808);
    for (let i = 0; i < 2000; i++) {
      expect(Number.isInteger(rollGibbyGift(roll, true).sponges)).toBe(true);
    }
  });
});

describe('rollGibbyGift — the chest branch', () => {
  it('never hands a chest to a client that cannot render one', () => {
    // The shipped client sends no capability flag, so it must be sponges-only.
    // This is what lets the function deploy ahead of the app release.
    const roll = sweep(997);
    for (let i = 0; i < 997; i++) {
      expect(rollGibbyGift(roll, false).kind).toBe('sponges');
    }
  });

  it('is rare, not routine, for a client that opts in', () => {
    const roll = seededRng(4242);
    let chests = 0;
    const runs = 20000;
    for (let i = 0; i < runs; i++) {
      if (rollGibbyGift(roll, true).kind === 'chest') chests += 1;
    }
    const rate = chests / runs;
    expect(rate).toBeGreaterThan(0);
    // Comfortably inside "rare" either side of the configured chance.
    expect(rate).toBeLessThan(0.15);
    expect(Math.abs(rate - GIBBY_CHEST_CHANCE)).toBeLessThan(0.02);
  });

  it('grants no sponges alongside a chest', () => {
    // `amount` still has to be an int for the client cast; a chest reports 0
    // rather than omitting the field.
    const roll = seededRng(7);
    let checked = 0;
    for (let i = 0; i < 5000 && checked < 25; i++) {
      const gift = rollGibbyGift(roll, true);
      if (gift.kind === 'chest') {
        expect(gift.sponges).toBe(0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('gibbyFriendEdge', () => {
  it('writes exactly the keys the security rules permit', () => {
    // firestore.rules pins creates to hasOnly(FRIEND_EDGE_KEYS). An extra key
    // makes the edge unwritable by any path but the Admin SDK, and silently
    // diverges from what sendFriendRequest writes.
    const edge = gibbyFriendEdge('2026-08-08T00:00:00.000Z');
    expect(Object.keys(edge).sort()).toEqual([...FRIEND_EDGE_KEYS].sort());
  });

  it('stamps addedAt as an ISO string, not a Timestamp', () => {
    // friends_repository_impl.dart:141 writes `now.toIso8601String()` and the
    // reader parses a string. A Firestore Timestamp here mis-parses silently.
    const edge = gibbyFriendEdge('2026-08-08T00:00:00.000Z');
    expect(typeof edge.addedAt).toBe('string');
    expect(new Date(edge.addedAt).toISOString()).toBe(edge.addedAt);
  });

  it('is already accepted, and attributes the request to Gibby', () => {
    // Gibby is not a pending request the user has to approve — he is a friend
    // on arrival. requesterUid must be Gibby so the accept rule (which forbids
    // a requester accepting their own request) can never apply to the user.
    const edge = gibbyFriendEdge('2026-08-08T00:00:00.000Z');
    expect(edge.status).toBe('accepted');
    expect(edge.requesterUid).toBe(GIBBY_UID);
  });

  it('arrives with no outstanding housemate request', () => {
    const edge = gibbyFriendEdge('2026-08-08T00:00:00.000Z');
    expect(edge.housePendingFrom).toEqual([]);
  });

  it('does NOT make the player a housemate', () => {
    // Gibby's house is opened by an NPC carve-out in firestore.rules, not by
    // a roster entry. A roster would grow by one per signup and hit the
    // four-person cap on the fifth account, breaking the day-one visit for
    // every account after that.
    const edge = gibbyFriendEdge('2026-08-08T00:00:00.000Z');
    expect(Object.keys(edge)).not.toContain('housemates');
    expect(Object.keys(edge)).not.toContain('houseGrantedTo');
  });

  it('names Gibby with a uid that is a legal Firestore document id', () => {
    expect(GIBBY_UID).not.toContain('/');
    expect(GIBBY_UID.length).toBeGreaterThan(0);
    expect(GIBBY_DISPLAY_NAME).toBe('Gibby');
  });
});

// ---------------------------------------------------------------------------
// The house document — review note 3.1's server half
// ---------------------------------------------------------------------------
//
// 🔴 This layout was written to match a CLIENT BUG. getFriendVisit read
// data['rooms'], so gibby.ts stored its floors array under the key `rooms` and
// the two wrong halves agreed. PR #122 fixed the client to read `floors` —
// which is the only key HouseLayoutModel.toJson() has ever written — so this
// document has to move with it or Gibby's house goes blank for everyone.
//
// The heal is free: ensureGibbyAccount does a full `.set()` on
// users/{gibby}/house/layout (index.ts:166), not a merge, and runs on every
// account creation plus the backfill endpoint. Existing documents are
// overwritten the next time either fires.

describe('Gibby house layout', () => {
  it('keys the floors array as `floors`, the only key the app writes', () => {
    expect(Object.keys(GIBBY_HOUSE_LAYOUT)).toContain('floors');
    expect(Object.keys(GIBBY_HOUSE_LAYOUT)).not.toContain('rooms');
  });

  it('holds floor objects, each carrying its own nested rooms and furniture', () => {
    const floors = GIBBY_HOUSE_LAYOUT.floors as Array<Record<string, unknown>>;
    expect(Array.isArray(floors)).toBe(true);
    expect(floors).toHaveLength(1);

    const floor = floors[0];
    expect(floor.id).toBe('floor-0');
    expect(floor.index).toBe(0);
    expect(Array.isArray(floor.rooms)).toBe(true);
    expect(Array.isArray(floor.furniture)).toBe(true);
    expect((floor.rooms as unknown[]).length).toBeGreaterThan(0);
    expect((floor.furniture as unknown[]).length).toBeGreaterThan(0);
  });

  it('gives every room integer bounds', () => {
    const floors = GIBBY_HOUSE_LAYOUT.floors as Array<Record<string, unknown>>;
    for (const floor of floors) {
      for (const room of floor.rooms as Array<Record<string, unknown>>) {
        for (const key of ['x', 'y', 'width', 'height']) {
          expect(Number.isInteger(room[key])).toBe(true);
        }
        expect(typeof room.roomId).toBe('string');
      }
    }
  });

  it('places only furniture ids the catalogue can resolve', () => {
    // A furnitureId absent from FurnitureCatalogue is skipped silently by
    // home_iso_game.dart — an invisible object, no error, no log. These three
    // are the living-room presets.
    const known = new Set(['sofa', 'coffee_table', 'armchair']);
    const floors = GIBBY_HOUSE_LAYOUT.floors as Array<Record<string, unknown>>;
    for (const floor of floors) {
      for (const item of floor.furniture as Array<Record<string, unknown>>) {
        expect(known.has(item.furnitureId as string)).toBe(true);
        expect(typeof item.id).toBe('string');
      }
    }
  });
});

describe('Gibby user document', () => {
  it('carries his own avatar rather than the person placeholder', () => {
    // An empty avatarUrl renders the grey Material person glyph — review note
    // 3.2. `gibby` is an AvatarPreset id that avatarAssetFor resolves to
    // assets/images/avatars/gibby.webp, the same field every fox outfit writes.
    expect(GIBBY_USER_DOC.avatarUrl).toBe('gibby');
  });

  it('wears an avatar id no player can select', () => {
    // The face is his alone: `gibby` sits outside kAvatarPresets and outside
    // unlockedAvatarPresets on the client, so it never reaches the picker. It
    // used to be `duck`, one of the launch three, which meant the starter
    // friend was indistinguishable from any player who had picked the duck.
    // The client half of this contract is asserted in
    // test/features/settings/avatar_catalog_test.dart.
    expect(GIBBY_USER_DOC.avatarUrl).toBe(GIBBY_UID);
  });

  it('stays out of user search', () => {
    // He is granted to everyone by the creation trigger, so surfacing him in
    // search would let people "find" a friend they already have.
    expect(GIBBY_USER_DOC.isPublic).toBe(false);
  });
});
