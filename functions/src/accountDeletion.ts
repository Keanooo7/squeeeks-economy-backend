// ---------------------------------------------------------------------------
// accountDeletion — the pure planner behind `deleteAccount`.
//
// 🔴 THE DIALOG ALREADY PROMISED THIS AND THE CODE DID NOT DO IT.
// `settings_page.dart` says "All your data will be deleted" and then runs
// `FirebaseAuth.instance.currentUser?.delete()` — the Auth record, and nothing
// else. Every document below survived, owned by a uid that can never sign in
// again. App Store Review Guideline 5.1.1(v) requires the account AND its data;
// deleting the login is not deleting the account.
//
// 🔑 PURE, IN THE `family.ts` / `housemateView.ts` SENSE: plain data in, a plan
// out. No `db`, no async, no Firestore types. Raw documents cross the boundary
// as `Record<string, unknown> | undefined | null` (i.e. `snap.data()`) and
// collections as `Array<{id, data}>`, because a planner that took a
// QuerySnapshot could only be tested against a fake Firestore — and the whole
// point of the split is that the DECISIONS are testable without one.
//
// ⚠️ THE PLANNER DOES NOT DISCOVER, IT DECIDES. Which documents exist is a
// Firestore question and is answered by the caller (`listCollections` /
// `listDocuments` / four single-field queries). What is deleted, what is
// mutated on somebody else's document, and what is deliberately KEPT are the
// decisions, and they are all here.
// ---------------------------------------------------------------------------

import {
  type FamilyDeparturePlan,
  type FamilyDepartureRefusal,
  type FamilyDoc,
  planFamilyDeparture,
  planFamilyDisband,
} from './family';
import {rosterOf} from './housemateToken';

/**
 * A document outside `users/{uid}` that names this uid in a field, already
 * located by the caller's query. `reason` is carried so the applier's log and
 * the return block can say WHY each foreign document was touched.
 */
export interface ForeignHit {
  path: string;
  reason: string;
}

/** Something found, and deliberately not deleted. Every entry needs a reason. */
export interface RetainedRecord {
  what: string;
  reason: string;
}

/**
 * 📌 THE SUBCOLLECTIONS THIS PROJECT KNOWS ABOUT, AND WHY THE LIST IS NOT THE
 * MECHANISM.
 *
 * 🔴 The cascade is driven by `listCollections()` AT RUNTIME, not by this
 * constant. A hard-coded list is a comment that compiles: add a subcollection
 * and the deletion silently misses it, invisibly, because an orphaned
 * subcollection does not show up under a deleted parent in the console either.
 *
 * 🔑 So this exists only as a PIN — `accountDeletion.test.ts` asserts the
 * runtime enumeration in a seeded fixture covers it. It can go stale upward
 * (a new subcollection nobody added here) without breaking the cascade, which
 * is the direction that is safe.
 *
 * ⚠️ `shieldPurchases` HAS NO BLOCK IN `firestore.rules` (written server-side
 * only, `index.ts` `buyStreakShield`). Anyone enumerating this surface from the
 * rules file — the obvious way — misses it. That is the concrete reason the
 * runtime list leads and this one follows.
 */
export const KNOWN_USER_SUBCOLLECTIONS: readonly string[] = [
  'chestPurchases',
  'completions',
  'dailyScores',
  'economy',
  'feedbackCounts',
  'fridgeItems',
  'friends',
  'giftInvites',
  'habits',
  'house',
  'inventory',
  'inviteCounts',
  'profile',
  'quests',
  'rewardHistory',
  'shieldPurchases',
  'shop',
  'streak',
  'tasks',
  'weeklySchedule',
];

/**
 * What deleting this account changes.
 *
 * 🔑 THE THIRD-PARTY EFFECTS ARE SEPARATE FIELDS, NOT ONE `paths` LIST, for the
 * same reason `FamilyDeparturePlan` splits `memberUids` from `revokedUids`:
 * they are different WRITES to different documents, and a plan that merged them
 * would leave the caller to infer which was which. Inferring it is how one
 * gets skipped.
 */
export interface AccountDeletionPlan {
  uid: string;
  /** Every document under `users/{uid}`, deleted before the root document.
   *  Deepest-first, so a document is never removed before its own children. */
  ownDocPaths: string[];
  /** The root document. Deleting it fires `syncPublicProfile`, which removes
   *  `publicProfiles/{uid}` — so the projection is NOT listed here. */
  rootPath: string;
  /** `users/{friend}/friends/{uid}` — the mirror of each edge this user holds. */
  mirrorEdgePaths: string[];
  /** Users whose `housemates` array must `arrayRemove(uid)`. ONE field each. */
  housemateArrayUids: string[];
  /** Gift invites this user SENT, which live in the RECIPIENT's subcollection. */
  sentGiftInvitePaths: string[];
  /**
   * `families/{familyId}/chores` assigned to this user.
   *
   * 🔑 DELETED, NOT UNASSIGNED, and the type is the argument.
   * `FamilyChoreDoc.assignedToUid` is a non-optional `string` and
   * `planChoreAssignment` refuses any uid outside `memberUids`, so there is no
   * "unassigned" state to write it back to. `planChoreCompletion` refuses
   * everyone else with `not-yours`, so a chore assigned to a deleted member is
   * a row nobody can ever complete or reassign. It is this user's own task,
   * and it is dead.
   */
  choreDocPaths: string[];
  /**
   * `families/{familyId}/messages` this user SENT.
   *
   * 🔴 DELETED AS OF W2-127, AND THIS REVERSES A DOCUMENTED DECISION. They were
   * in `ALWAYS_RETAINED` with the reasoning "they are this user's own words,
   * but they sit inside other people's conversation and removing them rewrites
   * a chat everyone else can still read". That reasoning was about
   * conversational integrity and it is not wrong — it was simply outranked.
   *
   * Brendan's decision, 2026-08-19, after the Guideline 1.3 (Kids Category)
   * rejection: an account deletion that leaves a child's own words readable by
   * other accounts is not a deletion, and "we delete everything on request"
   * has to be true as written before it is written to Apple.
   *
   * ⚠️ THE OLD COMMENT CLAIMED THE FLIP WAS "A ONE-LINE CHANGE". Half true and
   * recorded here because the half that was false cost the estimate: the index
   * claim holds — a single-field equality query inside one known subcollection
   * is auto-indexed — but the planner is PURE over already-fetched data, so it
   * took a new argument, this field, a mapping, a query in the caller, a delete
   * in the applier and an entry in `thirdPartyWrites`. A remedy asserted in a
   * comment is not a remedy measured.
   */
  messageDocPaths: string[];
  /** Documents outside `users/` naming this uid: tokens, invites, feedback,
   *  subscription routing. */
  foreignDocPaths: ForeignHit[];
  /** The family effect, delegated to the existing departure planners. */
  family: {
    familyId: string;
    departure: Extract<FamilyDeparturePlan, {ok: true}>;
  } | null;
  /**
   * 🔴 A FAMILY THAT COULD NOT BE PLANNED DOES NOT BLOCK THE DELETION.
   * `planFamilyDeparture` refuses a structurally unsound family document, and
   * an unreadable family record must never be able to trap somebody inside an
   * account they asked to delete — that is exactly the 5.1.1(v) failure. The
   * refusal is recorded, reported, and stepped over.
   */
  familyRefusal: {familyId: string; refusal: FamilyDepartureRefusal} | null;
  /** Found, and kept on purpose. */
  retained: RetainedRecord[];
}

/**
 * 📌 KEPT ON PURPOSE, AND THE LIST IS ASSERTED BY THE SUITE.
 *
 * The failure mode this defends against is not deleting too much — it is
 * keeping something silently. A collection that nobody deleted and nobody wrote
 * down is indistinguishable, six months later, from one that was missed.
 */
export const ALWAYS_RETAINED: readonly RetainedRecord[] = [
  {
    what: 'processedReceipts/{productId}_{transactionId}',
    reason:
      'The Apple replay-protection ledger. Its EXISTENCE is the guard, so ' +
      'deleting it would let the same transaction be redeemed a second time ' +
      'by a new account. The uid in the body is informational, not the key. ' +
      'Financial/anti-fraud record; 5.1.1(v) permits retention on that basis.',
  },
  {
    what: 'processedNotifications/{notificationUUID}',
    reason:
      'Keyed by Apple notification UUID and carries no uid at all — there is ' +
      'nothing here belonging to this person to delete.',
  },
  {
    what: 'housemateTokens where redeemedByUid == uid',
    reason:
      "Somebody else's invite token, already spent, with a short TTL. The " +
      'host owns that record; deleting it would be editing their history to ' +
      'tidy a reference. Only tokens this user HOSTED are deleted.',
  },
  {
    what: 'families/{familyId}/trashDay/{date}.completedByUid',
    reason:
      'Shared household history, same reasoning as messages — the record is ' +
      'that the bins went out, which is a fact about the family.',
  },
];

/**
 * Plan the deletion of one account.
 *
 * ⚠️ IDEMPOTENT BY CONSTRUCTION. Every field is a set of things to remove, so
 * a plan built from already-partially-deleted state is simply a smaller plan.
 * A retry after a failure mid-cascade succeeds; that property is what makes it
 * safe to delete the Auth record LAST.
 *
 * @param user       `users/{uid}` document data. Absent is fine — an account
 *                   with no user document still has an Auth record to remove.
 * @param friendEdges `users/{uid}/friends` — the doc id IS the other uid.
 * @param family     the one family named by `users/{uid}.familyId`, or null.
 */
export function planAccountDeletion(args: {
  uid: string;
  user: Record<string, unknown> | undefined | null;
  ownDocPaths: readonly string[];
  friendEdges: readonly {id: string}[];
  family: {id: string; data: FamilyDoc} | null;
  sentGiftInvites: readonly {ownerUid: string; inviteId: string}[];
  choreIds: readonly string[];
  /** `families/{familyId}/messages` ids whose `senderUid` is this uid. */
  messageIds: readonly string[];
  foreignHits: readonly ForeignHit[];
  nowMs: number;
}): AccountDeletionPlan {
  const {
    uid,
    user,
    ownDocPaths: discovered,
    friendEdges,
    family,
    sentGiftInvites,
    choreIds,
    messageIds,
    foreignHits,
    nowMs,
  } = args;

  // 🔴 THE PREFIX GUARD IS NOT DEFENSIVE TIDYING — IT IS THE BLAST RADIUS.
  // The caller discovers these paths by walking `users/{uid}` with
  // `listCollections`/`listDocuments`. A bug in that walk — a wrong ref, a
  // stale uid variable, a `..` in a document id — turns this list into "delete
  // these documents with the Admin SDK, which bypasses every rule". Filtering
  // to the one prefix that can possibly be this account's own data means the
  // worst a discovery bug can do is delete too LITTLE, which is recoverable.
  const ownPrefix = `users/${uid}/`;
  const ownDocPaths = discovered.filter((p) => p.startsWith(ownPrefix));

  // 🔴 EVERY EDGE, NOT ONLY THE ACCEPTED ONES. A 'pending' edge is still a row
  // on somebody else's friends list naming a uid that no longer exists, and the
  // starter edge to Gibby (`users/gibby/friends/{uid}`) is one of these too.
  // Self-edges are excluded because deleting `users/{uid}/friends/{uid}` is
  // already covered by ownDocPaths and listing it twice would make the applier
  // report a delete it did not do.
  const mirrorEdgePaths = friendEdges
    .map((e) => e.id)
    .filter((friendUid) => friendUid.length > 0 && friendUid !== uid)
    .map((friendUid) => `users/${friendUid}/friends/${uid}`);

  // 🔑 THE USER'S OWN `housemates` ARRAY IS THE REVERSE INDEX, and there is no
  // other one. `redeemHousemateToken` writes BOTH sides (`hostRef` and
  // `guestRef` each get a `housemates` array), so whoever lists this uid is
  // exactly whoever this uid lists. Scanning friends instead would be both
  // wider and wrong — a housemate need not still be a friend.
  const housemateArrayUids = rosterOf(user).filter((h) => h !== uid);

  const sentGiftInvitePaths = sentGiftInvites.map(
    (g) => `users/${g.ownerUid}/giftInvites/${g.inviteId}`,
  );

  // Only reachable when the user is in a family at all — the caller cannot run
  // the query otherwise, and the planner must not invent a path from a
  // familyId it was not given.
  const choreDocPaths = family
    ? choreIds.map((id) => `families/${family.id}/chores/${id}`)
    : [];

  // Same guard as chores: the planner must not invent a path from a familyId it
  // was not given, and the caller cannot have run the query without one.
  const messageDocPaths = family
    ? messageIds.map((id) => `families/${family.id}/messages/${id}`)
    : [];

  let familyEffect: AccountDeletionPlan['family'] = null;
  let familyRefusal: AccountDeletionPlan['familyRefusal'] = null;
  if (family) {
    // 🔴 AN OWNER DISBANDS; A MEMBER DEPARTS — and this is the ONE product
    // decision in this file. `planFamilyDeparture` refuses an owner with
    // `owner-must-disband` because the grant dies with the payer. Deleting the
    // account is the STRONGER act, so it must not be blocked by the weaker one:
    // it disbands. Transfer is the attractive wrong answer — the new owner is
    // not the one paying, so the family's Pro would be funded by a subscription
    // that no longer exists.
    const departure =
      family.data.ownerUid === uid
        ? planFamilyDisband({family: family.data, actorUid: uid, nowMs})
        : planFamilyDeparture({
            family: family.data,
            actorUid: uid,
            targetUid: uid,
            nowMs,
          });

    if (departure.ok) {
      familyEffect = {familyId: family.id, departure};
    } else {
      familyRefusal = {familyId: family.id, refusal: departure.refusal};
    }
  }

  const retained: RetainedRecord[] = [...ALWAYS_RETAINED];
  if (familyRefusal) {
    retained.push({
      what: `families/${familyRefusal.familyId}`,
      reason:
        `The family record could not be planned (${familyRefusal.refusal}), so ` +
        'it is left untouched rather than half-rewritten. The account is still ' +
        'deleted — an unreadable family must not trap somebody in an account.',
    });
  }

  return {
    uid,
    ownDocPaths,
    rootPath: `users/${uid}`,
    mirrorEdgePaths,
    housemateArrayUids,
    sentGiftInvitePaths,
    choreDocPaths,
    messageDocPaths,
    foreignDocPaths: [...foreignHits],
    family: familyEffect,
    familyRefusal,
    retained,
  };
}

/**
 * Every third-party document this plan writes to, for the log line and the
 * return block.
 *
 * 📌 EXISTS BECAUSE THE BRIEF ASKS FOR IT BY NAME: "do not delete another
 * user's document to clean up a dangling reference without saying exactly which
 * fields you touched". This is the machine-readable version of that sentence,
 * so the answer cannot drift from what the code does.
 */
export function thirdPartyWrites(plan: AccountDeletionPlan): Array<{
  path: string;
  op: 'delete' | 'update';
  fields?: string[];
}> {
  const out: Array<{path: string; op: 'delete' | 'update'; fields?: string[]}> = [];
  for (const p of plan.mirrorEdgePaths) out.push({path: p, op: 'delete'});
  for (const p of plan.sentGiftInvitePaths) out.push({path: p, op: 'delete'});
  for (const p of plan.choreDocPaths) out.push({path: p, op: 'delete'});
  for (const p of plan.messageDocPaths) out.push({path: p, op: 'delete'});
  for (const h of plan.housemateArrayUids) {
    out.push({path: `users/${h}`, op: 'update', fields: ['housemates']});
  }
  if (plan.family) {
    const {familyId, departure} = plan.family;
    if (!departure.noop) {
      out.push(
        departure.dissolved
          ? {path: `families/${familyId}`, op: 'delete'}
          : {
              path: `families/${familyId}`,
              op: 'update',
              fields: ['memberUids', 'memberNames', 'memberAvatars'],
            },
      );
    }
    for (const revoked of departure.revokedUids) {
      if (revoked === plan.uid) continue;
      out.push({
        path: `users/${revoked}`,
        op: 'update',
        fields: ['familyProExpiresAt', 'familyId'],
      });
    }
  }
  return out;
}
