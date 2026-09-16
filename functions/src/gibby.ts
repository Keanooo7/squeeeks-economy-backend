// ---------------------------------------------------------------------------
// Gibby — the permanent starter friend
// ---------------------------------------------------------------------------
//
// Every account gets Gibby, on creation, forever. He does not disappear when
// real friends arrive and he does not stop gifting. The random part of his
// gift is its CONTENTS, never the sender.
//
// Three constraints shaped this module, and each one is load-bearing:
//
//  1. The NAME lives on the Firebase Auth record, not in Firestore.
//     syncPublicProfile builds publicProfiles/{uid} with `await publicRef.set(...)`
//     — a full set — reading displayName off `admin.auth().getUser(uid)`. Writing
//     publicProfiles/{gibby} directly is therefore dead on arrival: the next write
//     to users/{gibby} clobbers it. That is not hypothetical; it is what
//     scripts/set-gibby-avatar.js did, resetting the projection name to ''.
//     Giving Gibby a real Auth record with displayName 'Gibby' makes the existing
//     trigger correct for him with no change to the trigger and no fallback in
//     buildPublicProfile (which would alter behaviour for every other user).
//
//  2. The EDGE SHAPE is fixed by the client, not by us.
//     friends_repository_impl.dart writes {status, addedAt, requesterUid} with
//     addedAt as an ISO STRING — not a Firestore Timestamp — and firestore.rules
//     pins client creates to exactly those three keys. Gibby's edges match, so a
//     client that reads them cannot tell them apart from a real friendship.
//
//  3. The CLIENT HARD-CASTS the gift amount.
//     shop_repository_impl.dart does `data['amount'] as int`. A chest that
//     omitted the field, or a non-integer, is a crash rather than a degraded
//     screen — so every gift reports an integer sponge count, zero included.
//
// Everything here is pure and takes its randomness as an argument, so the tests
// can sweep the unit interval rather than stub Math.random (a CONSTANT stub
// recurses jest's own quicksort to death before any test runs).

/** Gibby's fixed uid — an Auth uid and a Firestore document id. */
export const GIBBY_UID = 'gibby';

/** The name pinned onto the Auth record, and thus into the projection. */
export const GIBBY_DISPLAY_NAME = 'Gibby';

/**
 * The exact key set on a friend edge. firestore.rules enforces
 * hasOnly(['status','addedAt','requesterUid','housePendingFrom']) on client
 * creates; Gibby's Admin-SDK edges match it so the two are indistinguishable
 * to a reader.
 *
 * Note what is NOT here: the housemate roster. Who may see a house is a
 * property of that house, held once at users/{uid}.housemates, not spread
 * across the edges — see the comment on gibbyFriendEdge.
 */
export const FRIEND_EDGE_KEYS = [
  'status',
  'addedAt',
  'requesterUid',
  'housePendingFrom',
] as const;

/** Inclusive sponge band for the ordinary gift. Was 2–10 before Gibby. */
export const GIBBY_SPONGES_MIN = 5;
export const GIBBY_SPONGES_MAX = 15;

/**
 * Chance the gift is a chest instead of sponges. "Rare" per the product call —
 * roughly one gift a fortnight for a daily claimer, which is a surprise rather
 * than an expectation.
 */
export const GIBBY_CHEST_CHANCE = 0.08;

/**
 * Which drop table Gibby's chest rolls against. 'mid' rather than 'rich': this
 * is a free daily faucet, and a rich table here would undercut the 100-sponge
 * Characters chest that is the actual sink.
 */
export const GIBBY_CHEST_DROP_TABLE = 'mid';

/** Tags the inventory row so a Gibby grant is separable from a purchase. */
export const GIBBY_GIFT_SOURCE = 'gibby_daily_gift';

export type GibbyGift =
  | { kind: 'sponges'; sponges: number }
  | { kind: 'chest'; sponges: 0 };

/**
 * Rolls the gift's contents.
 *
 * @param roll        A source of uniform values in [0,1). Injected so tests are
 *                    deterministic without stubbing Math.random.
 * @param chestEnabled Whether the CALLER can render a chest. The shipped client
 *                    cannot — it renders the response as a sponge count — so it
 *                    must never be sent one. This is a capability flag, not a
 *                    client-supplied roll: the client says what it can display,
 *                    the server still decides what is granted. Same contract as
 *                    purchaseChest's optional purchaseId, and it is what lets
 *                    this deploy ship ahead of the app release.
 */
export function rollGibbyGift(
  roll: () => number,
  chestEnabled: boolean,
): GibbyGift {
  if (chestEnabled && roll() < GIBBY_CHEST_CHANCE) {
    return { kind: 'chest', sponges: 0 };
  }

  const span = GIBBY_SPONGES_MAX - GIBBY_SPONGES_MIN + 1;
  // Math.min guards the roll() === 1 case, which a hand-written or badly seeded
  // generator can produce even though Math.random cannot.
  const sponges = Math.min(
    GIBBY_SPONGES_MAX,
    GIBBY_SPONGES_MIN + Math.floor(roll() * span),
  );
  return { kind: 'sponges', sponges };
}

/**
 * The friend edge written to BOTH sides of the Gibby friendship.
 *
 * Accepted on arrival — Gibby is not a request the user has to approve. He is
 * also the requester, which keeps the accept rule (a requester may not accept
 * their own request) from ever applying to the user.
 *
 * ⚠️ Gibby carries NO housemate grant, and must not.
 *
 * Since house reads moved behind canViewHouse(), an accepted friendship no
 * longer opens a house — but the fix for Gibby is not to make every player his
 * housemate. His roster would then grow by one on every signup and hit the
 * four-person cap on the fifth account, silently breaking the day-one visit
 * for everyone after that. He is instead carved out in firestore.rules as an
 * NPC whose house is open to any signed-in player: it is seeded content,
 * identical for every account, with nothing in it to protect.
 *
 * @param addedAt ISO 8601 string. NOT a Timestamp — the client parses a string
 *                and mis-reads a Timestamp silently.
 */
export function gibbyFriendEdge(addedAt: string): {
  status: 'accepted';
  addedAt: string;
  requesterUid: string;
  housePendingFrom: string[];
} {
  return {
    status: 'accepted',
    addedAt,
    requesterUid: GIBBY_UID,
    housePendingFrom: [],
  };
}

/**
 * Gibby's users/{uid} document. isPublic is FALSE deliberately: he is given to
 * everyone by the creation trigger, so surfacing him in user search as well
 * would let people "find" a friend they already have.
 */
export const GIBBY_USER_DOC: Record<string, unknown> = {
  // An empty avatarUrl renders the grey Material person placeholder, which is
  // what the 2026-08-09 review flagged (note 3.2, "give him duck PFP").
  // `gibby` is an AvatarPreset id (avatar_catalog.dart) that avatarAssetFor
  // resolves to assets/images/avatars/gibby.webp — the same single field every
  // equipped fox outfit writes, so the friend card, the top bar and the
  // settings page all pick it up with no client change.
  //
  // ⚠️ It is NOT the shared `duck` preset he used to wear. That one is in the
  // launch three, so every player could pick it and the starter friend looked
  // like an arbitrary stranger. `gibby` lives outside kAvatarPresets and
  // unlockedAvatarPresets and has no unlock path, so the face is his alone —
  // but it IS in kAllAvatarPresets, which is what makes it resolve on the
  // friend card of an account that owns nothing.
  avatarUrl: 'gibby',
  cleanlinessScore: 92,
  isPublic: false,
  subscriptionTier: 'free',
};

/** Read by sendGiftInvite's sender lookup and the sponge ledger. */
export const GIBBY_PROFILE_DOC: Record<string, unknown> = {
  spongeBalance: 100,
};

/**
 * Gibby's house, so visiting him shows a room rather than an empty plot.
 *
 * Shape notes, each of which has bitten before:
 *   - the key is `floors` — it is the ONLY top-level key HouseLayoutModel.toJson()
 *     has ever written (house_model.dart:40), and `rooms` lives one level down,
 *     inside each floor map. ⚠️ This used to say the opposite, and said it for a
 *     reason: getFriendVisit read data['rooms'], so this document was shaped to
 *     match a CLIENT BUG and the two wrong halves agreed. PR #122 fixed the
 *     client; leaving this as `rooms` would have blanked Gibby's house for
 *     everyone. If one half moves, the other must move with it.
 *   - each entry is a FLOOR object {id, index, rooms[], furniture[]};
 *   - RoomPlacement x/y/width/height are ints;
 *   - furnitureId must exist in FurnitureCatalogue or it is silently skipped.
 *     sofa / coffee_table / armchair are the living-room presets and are real.
 *
 * Existing documents heal themselves: ensureGibbyAccount writes this with a full
 * `.set()` (index.ts:166), not a merge, on every account creation and on the
 * backfill endpoint.
 */
export const GIBBY_HOUSE_LAYOUT: Record<string, unknown> = {
  floors: [
    {
      id: 'floor-0',
      index: 0,
      rooms: [{ roomId: 'living_room-1', x: 1, y: 1, width: 4, height: 4 }],
      furniture: [
        { id: 'g1', furnitureId: 'sofa', x: 2.0, y: 2.0, rotation: 0, heightLevel: 0 },
        { id: 'g2', furnitureId: 'coffee_table', x: 2.0, y: 3.0, rotation: 0, heightLevel: 0 },
        { id: 'g3', furnitureId: 'armchair', x: 4.0, y: 2.0, rotation: 2, heightLevel: 0 },
      ],
    },
  ],
};
