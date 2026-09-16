// functions/src/__tests__/rulesAllowlist.test.ts
//
// W2-22. The ceiling I named in W2-20 and left: rulesNoCatchAll.test.ts is a
// BLOCKLIST. It catches the two catch-all shapes I could think of, and a third I
// could not would pass.
//
// 🔑 THIS IS THE INVERSE, AND IT IS THE SAME LOGIC AS THE THING IT PROTECTS.
// Firestore default-denies any path no `match` reaches. This allowlist
// default-fails any `match` no entry names. A new path is a deliberate act with
// a written reason, or it is a red test.
//
// ---------------------------------------------------------------------------
// THE DISPROOF, ANSWERED BEFORE BUILDING: 24 match statements, 519 rules lines.
// ---------------------------------------------------------------------------
//
// The brief's stop condition was "if the allowlist becomes a second copy of
// firestore.rules, it is a maintenance burden updated mechanically without
// thought — WORSE than the blocklist, because it looks stronger."
//
// It does not, for two reasons:
//
//  1. IT CAPTURES TOPOLOGY, NOT POLICY. 24 path tokens against 519 lines — under
//     5%. The allow/read/write conditions, which are the part that actually
//     decides who can do what and the part most likely to churn, are NOT
//     mirrored here. Editing a rule's condition does not touch this file at all.
//     Only ADDING or REMOVING A PATH does, which is exactly the event worth a
//     human reading the diff.
//
//  2. EVERY ENTRY CARRIES A REASON, and a test asserts the reason is longer than
//     a shrug. That is what stops the mechanical update the brief feared: you
//     cannot make this green by pasting a path, only by writing why the path
//     exists. Same construction as QUESTS_NOT_BUILDABLE, BENCHED_SUBJECTS, the
//     module-reachability ledger and the economy-idempotency ledger — four
//     prior uses in this repo, all of which have caught something.
//
// ⚠️ 24 is small enough to read. If it ever passes ~60, revisit: at that size a
// reviewer WOULD rubber-stamp the diff and the brief's objection starts to hold.

import * as fs from 'fs';
import * as path from 'path';
import {codeOf} from './helpers/sourceText';

const RULES_PATH = path.join(__dirname, '..', '..', '..', 'firestore.rules');
const RULES = fs.readFileSync(RULES_PATH, 'utf8');

/** Strips comments so a `match` written in prose is not counted as code. */
function code(): string {
  return codeOf(RULES);
}

/** Every match path token, in file order. Duplicates are kept — see below. */
function matchPaths(): string[] {
  return [...code().matchAll(/^\s*match\s+(\S+)\s*\{/gm)].map((m) => m[1]);
}

/**
 * The complete set of paths firestore.rules is allowed to contain, each with the
 * reason it exists. Adding a path here is the deliberate act; a path not here
 * fails the suite.
 *
 * 🔑 `/shop/{doc}` appears TWICE and both are listed, because they are different
 * documents: one under `users/{uid}` (per-player shop state) and one top-level
 * (the shared daily market). Collapsing them into a set would hide the removal
 * of one, so the assertion compares an ordered list rather than a set.
 */
const ALLOWED: {path: string; why: string}[] = [
  {path: '/databases/{database}/documents', why: 'The Firestore service root. Not a rule — the wrapper every rules file opens with.'},
  {path: '/users/{uid}', why: 'The player document. Owner-scoped; the parent of most of the tree below.'},
  {path: '/private/{docId}', why: 'The FCM push token, moved off users/{uid} in W2-132. The parent is readable by isOwner || isFriend and Firestore has no field-level read security, so every accepted friend could read every friend\u2019s raw device token. The parent could NOT be narrowed instead: friends_repository_impl reads `housemates` off users/{friendUid} to answer \u201Cmay I visit their house?\u201D, and it swallows the permission error, so locking it would have silently turned every Visit button into an Ask button. Owner-only read AND write \u2014 the client writes the token, not a Cloud Function.'},
  {path: '/friends/{friendUid}', why: 'Friend edges. Per-edge grants, which is why a roster cap cannot be enforced in rules.'},
  {path: '/inventory/{itemId}', why: 'Owned cosmetics. Written by Cloud Functions on a chest grant, quest reward or gift claim.'},
  {path: '/pendingChests/{pendingChestId}', why: 'Unopened chests minted by adminGrant. Owner-READ only and client-write NEVER: an unopened chest is a promise of a roll, so a writable one is a self-service mint and a writable openedAt re-opens it forever.'},
  {path: '/fridgeItems/{itemId}', why: 'Perishables the player is tracking (W2-97, for the W4-76 client). Owner-only read AND write: unlike the family subcollections there is no callable, FridgeRepository writes straight from the device, and "is this your own fridge" is the whole authority question. Deliberately NOT friend-readable even though users/{uid} is — rules do not cascade, and a fridge list is more personal than a cleanliness score.'},
  {path: '/house/{doc=**}', why: 'The saved house layout. Client-owned; the one large document a player writes directly.'},
  {path: '/streak/{doc=**}', why: 'Streak state, written exclusively by recordTaskCompletion and resolveStreak via Admin SDK.'},
  {path: '/dailyScores/{date}', why: 'Display-only cleanliness history for the heat map. Client-written and gates no currency.'},
  {path: '/economy/{doc=**}', why: 'Server-owned economy ledgers — task rewards and the mini-game claim. Deny-write, or a client could re-collect a day.'},
  {path: '/days/{dayKey}', why: 'The PER-DAY task-reward ledger (W2-174) — paidCount, xpPaidCount and bonusPaid for one calendar day, document id = the day key. It replaced a single economy/taskRewards document stamped with a `date` field, which reset all three counters whenever the caller named a different day — and recordTaskCompletion let the caller name the day, so alternating two well-formed dates re-minted the cap (measured: 15 sponges against a cap of 5, three calls). Deny-write: a client that could zero or delete a day document would restore that mint exactly. Read IS allowed, unlike economy/, because Deploy 2 of the migration drives the cap UI off a snapshot listener on today\'s document.'},
  {path: '/completions/{completionId}', why: 'The durable completion log (W2-11). Reward-bearing, so deny-write AND deny-delete: deleting a record would retract a completion and re-earn it.'},
  {path: '/quests/{doc=**}', why: 'Quest progress and claimedTiers (W2-10). claimedTiers is the only thing stopping infinite re-collection of a quest reward.'},
  {path: '/rewardHistory/{rewardId}', why: 'Streak milestone rewards, written by awardStreakReward. Client reads for the history list.'},
  {path: '/habits/{doc=**}', why: 'Habit definitions the player authors. Client-owned content that gates no currency, so client-write is correct here.'},
  {path: '/tasks/{doc=**}', why: 'The player task list, including the completedDate flag the completion log is derived from.'},
  {path: '/weeklySchedule/{doc=**}', why: 'The weekly cleaning plan the player builds. Client-owned content; task_library.dart is its source of task ids.'},
  {path: '/dailyGift', why: 'Daily gift state. A single named document rather than a collection, hence no wildcard.'},
  {path: '/profile/{doc=**}', why: 'profile/data holds spongeBalance and totalXp — the two values every economy write touches. Client-write denylisted.'},
  {path: '/inviteCounts/{date}', why: 'Per-day gift invite counters, the only thing bounding invite spam — a client that could write these could invite without limit.'},
  {path: '/feedbackCounts/{date}', why: 'Per-day tester feedback submission counter (W2-26), same shape as inviteCounts. A client that could write here could zero its own count and file without limit — that counter IS the bound, so deny-write.'},
  {path: '/giftInvites/{inviteId}', why: 'Outstanding gift invites between players, consumed by claimGift. The claimed flag inside its transaction is what stops a double claim.'},
  {path: '/chestPurchases/{purchaseId}', why: 'Replay ledger for purchaseChest (W2-08), keyed on the caller-supplied purchaseId. Owner-READ and deny-write. NOTE: its sibling shieldPurchases has NO block and is default-denied, so the two differ on read — recorded in rulesNoCatchAll.test.ts.'},
  {path: '/shop/{doc}', why: 'Per-player shop state under users/{uid} — dailyChestsPurchased, lastDailyGiftClaimedAt. Written by Cloud Functions.'},
  {path: '/galleryFeedback/{feedbackId}', why: 'Tester feedback on gallery specimens (W2-23). CREATE-only and owner-stamped — the uid on the document must be the caller\'s. No update, no delete: an edited or vanished comment is a lost sentence. Client read is DENIED even for your own items, because the export runs Admin-side and allowing it would let any tester read every other tester\'s comments.'},
  {path: '/publicProfiles/{uid}', why: 'Public projection written by syncPublicProfile. Display-safe fields only, readable by other players.'},
  {path: '/shop/{doc}', why: 'TOP-LEVEL shop/current — the shared daily market written by rotateMarket. A different document from the per-player one above; both are listed on purpose.'},
  {path: '/shopInventory/{dateDoc}', why: 'Dated shop inventory snapshots, kept so a past day can be inspected without re-deriving it from rotateMarket.'},
  {path: '/families/{familyId}', why: 'The family group document (W2-76). A family is a DOCUMENT rather than a derivation over users/{uid}.housemates because peer rosters need not agree — A may list B while B lists nobody — so "who is in this family" has no single answer without one, and a subscription needs a single owner to hang on. get is membership-scoped and read off the document itself (resource.data.memberUids), so it needs no get() and cannot be fooled by a stale roster elsewhere. list is denied separately: a query rule cannot inspect each returned document, so any workable allow-list would trust a client-supplied constraint and expose every family roster in the app. Write is denied outright INCLUDING to the owner — the entitlement fan-out reads memberUids to decide who gets Pro, so an editable roster is a self-service Pro grant.'},
  {path: '/trashDay/{binDateKey}', why: 'Shared trash-day completion under families/{familyId} (W2-77). One member takes the bins out and the fact is readable by the whole family, so every member\'s in-app takeover has nothing left to show. The document id IS the bin date (YYYY-MM-DD), dated for the same reason acknowledgedFor is a date rather than a bool: last week\'s completion must not pre-clear this week. Scoping is STRUCTURAL — the record lives under one family, so another family\'s bin day is not reachable by any query a client can write, which is stronger than filtering. Read is membership and needs a get() because the roster lives on the PARENT document, read through .get(memberUids, []) so a malformed family denies rather than erroring (an error would deny a real member too). Write is denied to everyone including members: a member forging a completion clears their household\'s reminder without doing the chore, and rules cannot verify the writer against a roster on another document without the same get() being only as trustworthy as whoever controls it. completeTrashDay in index.ts is the gate.'},
  {path: '/chores/{choreId}', why: 'Family chores under families/{familyId} (W2-88). Read is MEMBERSHIP, write is DENIED to everyone including members — the same split trashDay draws and for the same reason. The two authority questions are "is the actor the OWNER" (assign) and "is the actor the ASSIGNEE" (complete), and both live on documents a rule cannot reach without a get() that is only as trustworthy as whoever controls it. A member-writable completion is a member marking their own chore done without doing it; a member-writable assignment is one child handing chores to another. assignFamilyChore and completeFamilyChore in index.ts are the gates. Scoping is STRUCTURAL — the record lives under one family, so another family\'s chores are not reachable by any query a client can write.'},
  {path: '/messages/{messageId}', why: 'The family message board under families/{familyId} (W2-88). Read is MEMBERSHIP, write is DENIED to everyone including members — and the write rule does MORE work here than for chores or trashDay. Every message is filtered server-side by postFamilyMessage: a 15-word cap, a 280-character cap, no links including obfuscated forms like "foo dot com" and "foo[.]com", and a family-friendly wordlist matched on WHOLE TOKENS so it cannot flag "classic" or "assignment". A member-writable board would let any client skip all four by writing the document directly, which is the entire point of the filter. No edit path exists at all: an edited message is a changed record of what somebody said, a worse default on a board children read.'},
  {path: '/housemateTokens/{code}', why: 'Housemate verification tokens (W4-36). The document id IS the short-lived code, so read is denied as hard as write: a client that could list this collection could redeem every live code in the app without meeting anybody. Admin SDK only, both directions.'},
  {path: '/familyInvites/{code}', why: 'Family invite codes (W2-83), minted by mintFamilyInvite and spent by joinFamily. Same shape and same reasoning as housemateTokens: the document id IS the capability, so a client that could LIST this collection could join arbitrary families and collect the Pro grant the fan-out copies to every member. The familyId is not the secret — the code is. Admin SDK only, both directions. 📌 The rules block is a PIN, not a catch: Firestore default-denies, so the collection was already protected before the block existed and shipping the join path opened no window.'},
  {path: '/plantConfig/{doc}', why: 'House-plant directory override read by getPlantDirectory, which validates it and falls back to the bundled list. Denied to clients in BOTH directions: writable intervals would let one account tell another to water a fern monthly, and a direct read would bypass the validation that makes a Firebase-console edit safe.'},
  {path: '/adminGrants/{grantId}', why: 'Admin grant audit ledger AND idempotency lock (W2-122). Denied outright including read: a client that could write it could pre-create the lock and make a real grant return alreadyProcessed having written nothing.'},
  {path: '/processedReceipts/{hash}', why: 'IAP receipt replay ledger, keyed on productId_transactionId. Stops one receipt granting twice.'},
  {path: '/processedNotifications/{notificationUUID}', why: 'App Store Server Notification replay ledger, keyed on Apple notificationUUID rather than a transaction id — Apple sends several notifications about one transaction, so a transaction-keyed ledger would drop the second one. Admin SDK only; Apple calls the endpoint, no client does.'},
  {path: '/subscriptionOwners/{originalTransactionId}', why: 'originalTransactionId -> uid, written at purchase so an UNAUTHENTICATED renewal notification can find the account. Read is denied as hard as write: the id is a subscription and the body is a uid, so a client that could list this would enumerate every subscriber in the app.'},
];

describe('the allowlist is measuring the real file', () => {
  test('firestore.rules was found and is non-trivial', () => {
    // A guard that read the wrong path would pass everything.
    expect(RULES.length).toBeGreaterThan(1000);
    expect(RULES).toContain('rules_version');
  });

  test('it found matches to check — the assertion must not pass vacuously', () => {
    expect(matchPaths().length).toBeGreaterThan(20);
  });
});

describe('🔑 every match path is on the allowlist, in order', () => {
  test('the rules file contains exactly the allowed paths and no others', () => {
    // Ordered comparison, not a set: `/shop/{doc}` legitimately appears twice
    // and a set would hide the removal of one of them.
    expect(matchPaths()).toEqual(ALLOWED.map((a) => a.path));
  });

  test('a path added to the rules file without an allowlist entry fails', () => {
    // The demonstration, run in-memory so the real file is never edited: a NEW,
    // UNANTICIPATED path — not a catch-all, so the blocklist cannot see it.
    const withNew = [...matchPaths(), '/secretStuff/{doc}'];
    expect(withNew).not.toEqual(ALLOWED.map((a) => a.path));
  });

  test('a path REMOVED from the rules file also fails', () => {
    // The other direction. A guard that only catches additions would let
    // someone delete `allow write: if false` by deleting the whole block.
    const withoutOne = matchPaths().slice(0, -1);
    expect(withoutOne).not.toEqual(ALLOWED.map((a) => a.path));
  });
});

describe('⚠️ the allowlist cannot be made green by pasting a path', () => {
  // This is what stops the mechanical update the brief warned about, and it is
  // the difference between a ledger and a list.
  test('every entry carries a reason, and a reason is longer than a shrug', () => {
    for (const {path: p, why} of ALLOWED) {
      expect(why.length).toBeGreaterThan(40);
      expect(why).not.toMatch(/^(ok|fine|needed|required|used)\.?$/i);
      expect(p).toMatch(/^\//);
    }
  });

  test('the two /shop/{doc} entries have DIFFERENT reasons', () => {
    // A duplicate path with a copy-pasted reason would mean nobody looked at
    // the second one. They are genuinely different documents.
    const shops = ALLOWED.filter((a) => a.path === '/shop/{doc}');
    expect(shops).toHaveLength(2);
    expect(shops[0].why).not.toEqual(shops[1].why);
  });

  test('the list is small enough that a reviewer will actually read the diff', () => {
    // The brief's stop condition, kept live: at ~60 a reviewer rubber-stamps and
    // this guard becomes theatre. Fail before it silently gets there.
    expect(ALLOWED.length).toBeLessThan(60);
  });
});
