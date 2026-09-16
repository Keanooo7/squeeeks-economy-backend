/**
 * What a housemate is allowed to see of another account.
 *
 * ---------------------------------------------------------------------------
 * 🔑 PROJECT, DO NOT WIDEN — AND THIS FILE IS THE PROJECTION
 * ---------------------------------------------------------------------------
 *
 * Equipped skins live at `users/{uid}/inventory/{itemId}`, which is owner-only
 * in `firestore.rules` and must stay that way. Widening that collection would
 * grant a read of every row it will ever hold, including fields nobody has
 * reviewed yet — the same argument `publicProfiles` already makes for existing
 * as a separate document rather than as a relaxation of `users/{uid}`.
 *
 * ⚠️ AND IT WOULD LEAK MORE THAN THE FEATURE ASKS FOR. The inventory says what
 * a player owns, so a reader of the whole collection learns what they have NOT
 * unlocked — a proxy for how long they have played and how much they have
 * spent. The screen needs only what is currently WORN.
 *
 * Before this module the friend-visit payload was assembled ON THE CLIENT
 * (`friends_repository_impl.getFriendVisit`), reading two documents directly
 * under rules. There was no server-side payload, so there was nowhere to
 * project into — a projection needs a place where a field can be dropped, and
 * a direct client read has none.
 *
 * ---------------------------------------------------------------------------
 * 🔴 TASKS ARE DELIBERATELY ABSENT, AND THE REASON IS NOT "LATER"
 * ---------------------------------------------------------------------------
 *
 * The spec asks for the host's tasks for TODAY. That cannot be computed here,
 * and the reason is written down three times elsewhere in this codebase:
 *
 *   streak.ts        "The server runs in UTC and CANNOT recover the user's
 *                     timezone, so we never anchor these to an absolute
 *                     instant."
 *   quests.ts        `empty_by_nine` sits in QUESTS_NOT_BUILDABLE for exactly
 *                     this — "the user timezone, which the server does not
 *                     store".
 *   galleryFeedback  "a per-tester timezone the server does not store".
 *
 * The viewer's day is the wrong day: the screen's claim is about what the HOST
 * is cleaning, so a visitor past midnight or in another timezone would be
 * shown the host's schedule labelled against their own calendar. The host's
 * day is the right one and is not readable — the schedule stores
 * `cleaningDayOfWeek` and `weekStartDate`, and neither says what day the host
 * is currently having.
 *
 * 📌 `streak.ts`'s pattern does not rescue it. That works because the CLIENT
 * writes a naive-local wall-clock string and the server does arithmetic in
 * that frame — but "today's tasks" is not a completion record, it is a lookup
 * into a schedule, and no host-written date exists to key it by.
 *
 * So shipping tasks needs one of: a schema addition (the host writes its local
 * date), an accepted inaccuracy (UTC, wrong for most of the planet), or
 * returning the whole week and letting the client choose — which is the
 * widening this file exists to avoid. That is a product decision, not a
 * mechanical addition, and it is recorded here rather than in a commit message
 * so the next reader does not re-derive it.
 */

import { rosterOf } from './housemateToken';

/**
 * The complete set of keys a housemate view may contain.
 *
 * 🔴 THE TEST ON THIS IS "ONLY THESE", NEVER "CONTAINS THESE". A presence
 * assertion passes when a field is ADDED to the source and carried through,
 * which is the entire failure this module exists to prevent — the source
 * documents will gain fields, and every one of them must be excluded by
 * default rather than included by accident.
 */
export const HOUSEMATE_VIEW_FIELDS = [
  'hostUid',
  'equippedSkinIds',
] as const;

export type HousemateView = {
  hostUid: string;
  /** Slot id → equipped skin id. Equipped only, defaults omitted. */
  equippedSkinIds: Record<string, string>;
};

/** The permanent starter friend, mirroring `isStarterFriend` in the rules. */
export const STARTER_FRIEND_UID = 'gibby';

/**
 * Whether [guestUid] may see inside [hostUid]'s account.
 *
 * 🔑 THE SAME PREDICATE AS `canViewHouse` IN firestore.rules — deliberately,
 * and built on the exported `rosterOf` rather than re-parsing the roster:
 *
 *     canViewHouse(uid) = (isFriend(uid) && housemates(uid).hasAny([auth.uid]))
 *                       || sharesFamilyWith(uid)
 *
 * 🔑 THE FAMILY DISJUNCT READS THE ROSTER, NOT THE POINTER (W2-111). The rules
 * resolve users/{guest}.familyId only to LOOK UP families/{id}, then decide on
 * memberUids — so this takes the resolved roster and asks it the same
 * question. Mirroring the pointer comparison instead (guest.familyId ===
 * host.familyId) would be a second, subtly different predicate that agrees
 * with the rules right up until the two documents disagree.
 *
 * ⚠️ It has to be re-expressed here because the Admin SDK bypasses rules
 * entirely, so a callable that read with admin privileges and did not check
 * would be a hole straight through the consent model. That duplication is
 * forced by the platform, not chosen — the mitigation is that both sides read
 * the SAME roster field through the SAME helper, and that this is stated
 * rather than left for someone to discover.
 *
 * 📌 Friendship alone is not enough, which is the whole point of the split
 * argued in the rules: accepting a friend request and letting someone into
 * your home are two different consents.
 */
export function mayViewHousemateData(args: {
  hostUid: string;
  guestUid: string;
  hostUserData: Record<string, unknown> | undefined | null;
  friendshipAccepted: boolean;
  /**
   * `memberUids` of the GUEST's family, or `[]` when they are in none.
   *
   * ⚠️ Defaulted so an existing call site cannot silently widen access, and
   * read through `familyRosterOf` for the same reason `rosterOf` exists: a
   * malformed document must mean "no family", not a thrown callable.
   */
  guestFamilyMemberUids?: readonly string[];
}): boolean {
  const {
    hostUid, guestUid, hostUserData, friendshipAccepted,
  } = args;
  if (!hostUid || !guestUid) return false;
  if (hostUid === guestUid) return true;
  // Gibby is everybody's housemate by construction; the rules say the same.
  if (hostUid === STARTER_FRIEND_UID) return true;
  // 🔑 BEFORE the friendship gate, not after. A family member need not be a
  // friend — that is the entire point of W2-111 — and the early return below
  // would otherwise refuse them one line before this could answer.
  const family = args.guestFamilyMemberUids ?? [];
  if (family.includes(hostUid) && family.includes(guestUid)) return true;
  if (!friendshipAccepted) return false;
  return rosterOf(hostUserData).includes(guestUid);
}

/**
 * `memberUids` off a `families/{id}` document, defensively.
 *
 * The exact counterpart of `familyRoster()` in firestore.rules, which reads
 * `.get('memberUids', [])` so a malformed family DENIES rather than erroring.
 * Non-string entries are dropped for the same reason `rosterOf` drops them:
 * a uid that is not a string can never equal one that is, so keeping it could
 * only ever produce a wrong answer.
 */
export function familyRosterOf(
  familyData: Record<string, unknown> | undefined | null,
): string[] {
  const raw = familyData?.memberUids;
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === 'string');
}

/**
 * Equipped skins from raw inventory rows, keyed by slot.
 *
 * ⚠️ Reads `isEquipped === true` STRICTLY. A missing field, `null`, `0` or the
 * string `"true"` all mean not-equipped: a truthy check here would publish a
 * row that the owner's own screen does not draw as worn.
 *
 * 🔑 CHARACTER SKINS ARE INCLUDED, and that is the actual gap. If you can see
 * someone's house you already see their walls, their floors and their
 * furniture — the animal standing in it was the one thing missing, which made
 * the visit read as a different person's home.
 */
export function equippedSkinIdsFrom(
  rows: Array<{ id: string; data: Record<string, unknown> | undefined | null }>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const d = row.data;
    if (!d) continue;
    if (d.isEquipped !== true) continue;
    const slot = typeof d.slotId === 'string' && d.slotId ? d.slotId : row.id;
    out[slot] = row.id;
  }
  return out;
}

/**
 * Builds the view, dropping everything not named in [HOUSEMATE_VIEW_FIELDS].
 *
 * Constructed key by key rather than by copying and deleting: a spread-then-
 * delete carries any new source field until someone remembers to remove it,
 * and remembering is the thing that fails.
 */
export function projectHousemateView(args: {
  hostUid: string;
  equippedSkinIds: Record<string, string>;
}): HousemateView {
  return {
    hostUid: args.hostUid,
    equippedSkinIds: { ...args.equippedSkinIds },
  };
}
