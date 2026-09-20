import * as admin from 'firebase-admin';
// Imported modularly rather than as `admin.firestore.Timestamp` etc.: the
// Functions emulator proxies the admin SDK and the proxy does not carry the
// static properties across, so the namespaced form is `undefined` under
// `firebase emulators:start` while working fine when deployed. Symptom was
// `TypeError: Cannot read properties of undefined (reading 'fromDate')`.
import {
  Timestamp,
  FieldValue,
  type DocumentData,
} from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest, onCall, HttpsError } from 'firebase-functions/v2/https';
// First Firestore trigger in the codebase — every other export is
// onSchedule/onCall/onRequest. See syncPublicProfile below.
import { onDocumentWritten } from 'firebase-functions/v2/firestore';
// The ONLY v1 import in this file, and deliberately so. An account-creation
// hook has exactly two forms: this, or beforeUserCreated from
// 'firebase-functions/v2/identity'. The v2 form is a BLOCKING function and
// requires upgrading the project to Identity Platform, which this project has
// not had — so the v2 route would fail at deploy, not at runtime. See
// onNewUserBefriendGibby.
import * as functionsV1Auth from 'firebase-functions/v1/auth';
import {
  rollRarity,
  SEED_ITEMS,
  CHEST_CATEGORY_DROP_TABLE,
  CHEST_PRICE,
  subjectForDay,
  offeredChestCategories,
  partitionByOwnership,
  pickWithDuplicateBias,
  refundForCategory,
  refundForDropTable,
  refundForPrice,
  sumDuplicateRefunds,
} from './itemPool';
import {
  evaluateQuests,
  QuestStateMap,
  QuestPayout,
  CompletedTask,
} from './quests';
import {
  CompletionRecord,
  completionDocId,
  mergeCompletions,
  unloggedCompletions,
} from './completionLog';
import {recomputeDelta} from './questRecompute';
import { assertValidReplayKey } from './replayKey';
import {
  validateSubmission,
  formatFeedbackReport,
  MAX_SUBMISSIONS_PER_DAY,
  FeedbackSubmission,
  FeedbackRecord,
} from './galleryFeedback';
import {
  MINIGAME_REWARD,
  MinigameLedger,
  canClaimMinigame,
  minigameDayKey,
} from './minigame';
import { WEEKLY_OFFERS, validateOfferContents, WeeklyOfferConfig } from './weeklyOffers';
import {
  equippedSkinIdsFrom,
  mayViewHousemateData,
  familyRosterOf,
  projectHousemateView,
} from './housemateView';
import {
  HOUSEMATE_CAP,
  HOUSEMATE_TOKEN_TTL_SECONDS,
  HousemateTokenDoc,
  appendHousemate,
  evaluateRedemption,
  generateHousemateTokenCode,
  isValidHousemateTokenCode,
  rosterOf,
} from './housemateToken';
import {
  STREAK_SHIELD_PRICE,
  MAX_STREAK_SHIELDS,
  STREAK_MILESTONES,
  parseNaiveDate,
  streakDate,
  toNaiveIso,
} from './streak';
import { XP_CHEST, XP_GIFT_CLAIM, awardXp, xpDocPath, XP_FIELD } from './xp';
import { boundedDayKey, grantTaskRewards, resolveEffectiveTier, resolveOwnPaidExpiryMs, resolveOwnPaidTier } from './taskRewards';
import type { FamilyDoc } from './family';
import {
  FAMILY_CAP,
  FAMILY_CREATE_REFUSALS,
  FAMILY_PRODUCT_ID,
  FAMILY_INVITE_TTL_SECONDS,
  FAMILY_JOIN_REFUSALS,
  FAMILY_DEPARTURE_REFUSALS,
  FamilyDeparturePlan,
  FamilyInviteDoc,
  planFamilyCreation,
  planFamilyDeparture,
  planFamilyFanOut,
  planFamilyDisband,
  planFamilyJoin,
  planFamilyBinDay,
  FAMILY_BIN_DAY_REFUSALS,
} from './family';
import { DEMO_FIXTURE, anchorNoonUtc, planDemoAccount } from './demoAccount';
import {
  checkMessage,
  FamilyMessageDoc,
  MESSAGE_REFUSALS,
} from './familyMessages';
import {
  CHORE_REFUSALS,
  FamilyChoreDoc,
  planChoreAssignment,
  planChoreCompletion,
} from './familyChores';
import { planFamilyFanOutForEffect } from './family';
import {
  type AccountDeletionPlan,
  planAccountDeletion,
  thirdPartyWrites,
} from './accountDeletion';
import {
  TRASH_DAY_REFUSALS,
  type TrashDayCompletion,
  planTrashDayCompletion,
} from './trashDay';
import {
  buildPublicProfile,
  projectionChanged,
} from './publicProfile';
import {
  GIBBY_UID,
  GIBBY_DISPLAY_NAME,
  GIBBY_USER_DOC,
  GIBBY_PROFILE_DOC,
  GIBBY_HOUSE_LAYOUT,
  GIBBY_CHEST_DROP_TABLE,
  GIBBY_GIFT_SOURCE,
  gibbyFriendEdge,
  rollGibbyGift,
} from './gibby';
import { appleJws, type AppleTransaction } from './appleJws';
import {
  PLANT_DIRECTORY,
  type PlantSpecies,
  findPlant,
  validatePlantDirectory,
} from './plantDirectory';
import {
  ACTIVE_RULE,
  PROMO_ACTIVE_DAYS_PER_WINDOW,
  PROMO_GRANT_DAYS,
  PROMO_OBSERVATION_DAYS,
  evaluatePromo,
  observationStartMs,
  promoExpiryMs,
} from './retentionPromo';
import {
  SUBSCRIPTION_PRODUCT_TIERS,
  effectOf,
  ownerKeyFor,
} from './appStoreNotifications';
import { accountTokenRollout, purchaseTokenForUid } from './purchaseAccountToken';
import { planAdminGrant, ADMIN_GRANT_REFUSALS } from './adminGrant';
// WARNING: The two reminder crons below are the ONLY deployed copies. `notifications.ts`
// exports functions with these same names, but nothing imports it and `main` is
// `lib/index.js`, so Firebase never discovers them — confirmed against production
// on 2026-08-05 (`functions:list` shows exactly one of each). Patch these, not those.
import {
  buildPushBatch,
  legacyPushTokenDocPath,
  pushTokenDocPath,
  sendEachAndPruneDeadTokens,
  type PushTokenEntry,
} from './pushTokens';

import { BUILD_SHA, BUILD_TIME } from './buildInfo.generated';

// KEY: WHICH SHA IS LIVE — answered by a log line rather than inferred from an
// upload timestamp (W2-155). Every other deployment check in this repo reads
// `source.storageSource.generation`, which is WHEN a zip was uploaded and never
// what was in it; `check-deployed-revision.cjs` says so in its own header. This
// runs at module load, i.e. once per cold start, so the first entry of every
// new instance names the commit that instance is executing.
//
// WARNING: IT IS NOT A SUBSTITUTE FOR THAT CHECK, because a function that never runs
// never writes it. `onNewUserBefriendGibby` has never executed in production
// over its entire existence, so this line will never appear for it — that
// function stays unmeasured and this mechanism does not change that.
console.log(`cleaning-functions cold start · build ${BUILD_SHA.slice(0, 7)} · stamped ${BUILD_TIME}`);

admin.initializeApp();
const db = admin.firestore();

/**
 * Options for the two admin HTTP endpoints gated on the shared SEED_SECRET.
 *
 * Same Gen2 rule as APPLE_RECEIPT_OPTS, and it bit harder here: both endpoints
 * were declared as bare `onRequest`, so `firebase functions:secrets:set
 * SEED_SECRET` created a Secret Manager entry that never reached the runtime.
 * `process.env.SEED_SECRET` stayed undefined, the fail-closed gate below did
 * exactly what it should, and every request 403'd forever — which reads as a
 * wrong secret rather than an unbound one. Running the backfill in production
 * needed a gitignored .env file to get around it.
 *
 * Both endpoints share the one secret, so binding one and not the other leaves
 * half the problem in place.
 */
const SEED_OPTS = { secrets: ['SEED_SECRET'] };

/**
 * Options for the feedback EXPORT, which has its own secret.
 *
 * KEY: ONE SECRET PER BLAST RADIUS, NOT ONE PER ENDPOINT. This is not a second
 * secret model competing with the first — it is the first one, scoped
 * correctly. SEED_SECRET guards the two endpoints that WRITE:
 *
 *   seedShopData            re-seeds shop documents and the bundled item set —
 *                           the only path that changes player-visible state
 *   backfillPublicProfiles  rewrites every public profile projection
 *
 * The feedback export only READS. Sharing one string across both radii means a
 * leak of the pasteable one is a leak of the destructive one.
 *
 * WARNING: AND THE ASYMMETRY IS WHAT DECIDED IT, not tidiness: THE READ ENDPOINT IS
 * THE ONE THAT GETS HANDED AROUND. It is the useful one — somebody will want to
 * read what testers wrote, and the natural way to share that is to send someone
 * the curl. Every casual copy of that command carried the ability to rewrite
 * the shop. Two secrets means the worst case of handing out the useful one is
 * that someone reads feedback.
 *
 * Rotating them is now independent, which is the other half: rotating
 * SEED_SECRET no longer breaks the export, so there is no reason to delay it.
 */
const FEEDBACK_OPTS = { secrets: ['FEEDBACK_EXPORT_SECRET'] };

/**
 * Firestore caps a WriteBatch at 500 operations and rejects the entire commit
 * past that. 400 leaves headroom for a projection that grows a second write.
 */
const BACKFILL_CHUNK_SIZE = 400;

/** Simultaneous admin.auth().getUser calls during a backfill. */
const AUTH_LOOKUP_CONCURRENCY = 25;

/**
 * Like Promise.all(items.map(fn)) but with at most `limit` in flight, and with
 * results kept in input order. Unbounded fan-out over a large user collection
 * is a stampede against the Auth API; serial is a round trip per user.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Gift helpers
// ---------------------------------------------------------------------------

// Friend-to-friend gift invites (sendGiftInvite). NOT Gibby's distribution —
// his lives in gibby.ts. Kept separate on purpose: these are the amounts a
// player spends a daily invite to send, and folding the two together would
// change friend gifting as a side effect of changing Gibby.
function weightedGiftAmount(): number {
  const roll = Math.random();
  if (roll < 0.60) return Math.floor(Math.random() * 11) + 5;   // 5–15  (60%)
  if (roll < 0.90) return Math.floor(Math.random() * 15) + 16;  // 16–30 (30%)
  return Math.floor(Math.random() * 20) + 31;                   // 31–50 (10%)
}

// ---------------------------------------------------------------------------
// Gibby — the permanent starter friend
// ---------------------------------------------------------------------------

/**
 * Makes Gibby exist, idempotently: Auth record first, then his documents.
 *
 * The ORDER matters. The Auth record carries the display name, and
 * syncPublicProfile reads the name from there — so creating it first means the
 * users/{gibby} write below projects as 'Gibby' rather than ''. Writing the
 * projection directly at the end is not a race with that trigger: because the
 * Auth record now exists, the trigger recomputes the identical document. That
 * is the difference between this and the old seed scripts, whose projection got
 * blanked by the next write to Gibby's user doc.
 */
async function ensureGibbyAccount(): Promise<void> {
  try {
    await admin.auth().createUser({
      uid: GIBBY_UID,
      displayName: GIBBY_DISPLAY_NAME,
    });
  } catch (err) {
    if ((err as { code?: string }).code !== 'auth/uid-already-exists') throw err;
    // Already there. Re-pin the name anyway: a record created by an earlier
    // hand-run script may carry no displayName at all, which is precisely the
    // state that projects an empty name.
    await admin.auth().updateUser(GIBBY_UID, {
      displayName: GIBBY_DISPLAY_NAME,
    });
  }

  await db.doc(`users/${GIBBY_UID}`).set(GIBBY_USER_DOC, { merge: true });
  await db
    .doc(`users/${GIBBY_UID}/profile/data`)
    .set(GIBBY_PROFILE_DOC, { merge: true });
  await db.doc(`users/${GIBBY_UID}/house/layout`).set(GIBBY_HOUSE_LAYOUT);

  // Written directly rather than left to the trigger. getFriendVisit
  // (friends_repository_impl.dart:170) throws StateError when the host's
  // projection is missing, so a user who opens Gibby's house in the window
  // before the trigger fires would crash the visit screen.
  await db
    .doc(`publicProfiles/${GIBBY_UID}`)
    .set(buildPublicProfile(GIBBY_USER_DOC, GIBBY_DISPLAY_NAME));
}

/**
 * Writes BOTH sides of the accepted friendship. Batched, because a half-written
 * friendship is the exact defect F2 fixed for real friend requests: one side
 * present, the other missing, and no path that repairs it.
 *
 * Returns false for Gibby himself — ensureGibbyAccount calls createUser, which
 * fires the account-creation trigger, so without this guard Gibby befriends
 * himself and recurses.
 */
async function ensureGibbyFriendship(uid: string): Promise<boolean> {
  if (!uid || uid === GIBBY_UID) return false;

  const userEdge = db.doc(`users/${uid}/friends/${GIBBY_UID}`);
  const gibbyEdge = db.doc(`users/${GIBBY_UID}/friends/${uid}`);
  const [userSnap, gibbySnap] = await Promise.all([
    userEdge.get(),
    gibbyEdge.get(),
  ]);

  // Already befriended in both directions — write nothing and SAY so.
  if (userSnap.exists && gibbySnap.exists) return false;

  // WARNING: WRITE ONLY THE MISSING SIDE. This used to `set` both unconditionally,
  // and that was destructive in a way nothing announced: `set` without merge
  // REPLACES the document, so re-running it reset `addedAt` to now and cleared
  // `housePendingFrom` to []. That array is live state, not decoration —
  // firestore.rules:112 reads it to decide house access, and the client mutates
  // it with arrayUnion/arrayRemove. Overwriting it revokes a pending housemate
  // request silently.
  //
  // KEY: AND THE RETURN VALUE WAS A CONSTANT. It was `true` for every real uid,
  // so `onNewUserBefriendGibby`'s `friendship=${wrote ? 'written' : 'skipped'}`
  // could never log 'skipped', and backfillGibbyFriendship's
  // `befriended N/M` always reported N === M. Both instruments answered the
  // question they were asked with the same word every time, which is why a
  // green run of either proves nothing about how many accounts were missing
  // Gibby. The boolean now means what its callers already claimed it meant.
  //
  // Cost: two reads per user in the backfill. That is what buys a count that
  // can be believed, and a re-run that cannot destroy state.
  const edge = gibbyFriendEdge(new Date().toISOString());
  const batch = db.batch();
  if (!userSnap.exists) batch.set(userEdge, edge);
  if (!gibbySnap.exists) batch.set(gibbyEdge, edge);
  await batch.commit();
  return true;
}

/**
 * Draws the single item behind a Gibby chest.
 *
 * Mirrors claimWelcomeChest's fallback: prefer the `items` collection, fall
 * back to the bundled SEED_ITEMS when it has not been seeded. A rarity-only
 * equality query needs no composite index. Falls back once more to the whole
 * pool if the rolled rarity is empty, so the grant cannot dead-end the way the
 * welcome chest did on 2026-08-05.
 */
async function drawGibbyChestItem(): Promise<WelcomeChestPick> {
  const rarity = rollRarity(GIBBY_CHEST_DROP_TABLE);

  const pool = SEED_ITEMS.filter((i) => i.rarity === rarity);
  const source = pool.length > 0 ? pool : SEED_ITEMS;
  const item = source[Math.floor(Math.random() * source.length)];
  return {
    itemId: item.id,
    name: item.name,
    rarity: item.rarity,
    type: item.type,
    artUrl: item.artUrl,
  };
}

// ---------------------------------------------------------------------------
// Push notification scheduled functions
// ---------------------------------------------------------------------------

/**
 * Read both homes of each uid's push token.
 *
 * The token is moving off users/{uid} — which every accepted friend can read —
 * onto users/{uid}/private/push, which only the owner can. The only writer is
 * the client, so during the rollout a token may be in either place and this
 * reads both; resolvePushToken decides which one wins. See the migration note
 * at the top of pushTokens.ts for when the legacy read may be dropped.
 *
 * WARNING: This costs two document reads per reminded user instead of one. That is
 * the price of not stopping push for every install that has not updated yet,
 * and it goes away with the legacy read.
 */
async function readPushTokenEntries(
  uids: readonly string[],
): Promise<PushTokenEntry[]> {
  return Promise.all(
    uids.map(async (uid): Promise<PushTokenEntry> => {
      const [privateSnap, legacySnap] = await Promise.all([
        db.doc(pushTokenDocPath(uid)).get(),
        db.doc(legacyPushTokenDocPath(uid)).get(),
      ]);
      return {
        uid,
        privateData: privateSnap.data(),
        legacyData: legacySnap.data(),
      };
    }),
  );
}

/**
 * The one line a scheduled sender always emits, whatever it did.
 *
 * CRITICAL: WITHOUT IT A SILENT RUN AND A WORKING RUN ARE INDISTINGUISHABLE, and that is
 * measured rather than argued: both senders used to `return` early when nothing
 * was selected, and the only console.log on the send path sits AFTER
 * `if (dead.length === 0) return []` in sendEachAndPruneDeadTokens
 * (pushTokens.ts:176), so a clean fan-out was silent too. W2-139 drove the
 * selection twice against seeded state — once selecting nobody, once sending to
 * one — and both runs produced byte-identical output: `[]`.
 *
 * KEY: IT COST A WHOLE BRIEF. W2-138 had to answer "did the daily reminder fire?"
 * from Cloud Scheduler status plus Brendan's own Firestore document, because
 * nothing here could separate "ran and correctly excluded him" from "never ran".
 *
 * WARNING: WHAT GEN2 ALREADY GIVES YOU, so this does not duplicate it: every
 * invocation produces a Cloud Run request log (`POST 200`, latency, timestamp),
 * which answers "did it run on date X" on its own. What it CANNOT answer is
 * whether anyone was selected — measured 2026-08-24, three consecutive daily
 * runs were each `POST 200 · 97 B`, a constant response size carrying no
 * information about the outcome. That is the gap this closes, and it is why the
 * line reports COUNTS rather than a bare "done".
 *
 * NOTE: ONE LINE PER INVOCATION, NOT PER USER. These jobs scan every user; a line
 * per user is volume that buries the line that answers the question.
 *
 * `sent` can be lower than `selected`: a selected user with no resolvable push
 * token is dropped by buildPushBatch, and that difference is exactly the kind of
 * thing a reader of this line needs to see.
 */
function logSenderOutcome(
  name: string,
  scanned: number,
  selected: number,
  sent: number,
): void {
  console.log(`${name}: scanned=${scanned} selected=${selected} sent=${sent}`);
}

// Daily 8pm PT (03:00 UTC) — remind users who haven't completed a task today
export const sendStreakReminder = onSchedule('0 3 * * *', async () => {
  const today = new Date().toISOString().split('T')[0];
  // CRITICAL: `streak`, SINGULAR. It was `streaks` from the day this was written and
  // that collection group has never existed: every writer in the codebase uses
  // the singular — index.ts:3589/3695/3754 (`users/${uid}/streak/main`) and
  // streak_repository_impl.dart:31 — and the console's enumeration of every
  // collection group in production lists `streak` and no `streaks`.
  //
  // WARNING: THE MISSING INDEX MASKED IT FOR 23 NIGHTS. The job died at
  // FAILED_PRECONDITION before the query could return anything, so the wrong
  // name never got the chance to return zero rows. Once #584's index landed the
  // query SUCCEEDED and returned nothing, every night, and Cloud Scheduler
  // flipped Failed -> Success. A silent job that reports success.
  //
  // NOTE: NO DOC-ID GUARD IS NEEDED HERE, unlike sendDailyGiftReminder below which
  // must skip `doc.id !== 'data'`. That guard exists because a TOP-LEVEL `shop`
  // collection also matches `collectionGroup('shop')`. Production has exactly
  // three top-level collections — publicProfiles, shop, users — so
  // `collectionGroup('streak')` matches only `users/{uid}/streak/{doc}` and
  // every match is a real user's streak document.
  //
  // WARNING: WRITE WILDCARD PATHS WITH BRACES, NEVER WITH GLOB STARS. A slash
  // immediately followed by an asterisk, even inside a line comment like this
  // one, is read as OPENING a block comment by every source-parsing gate in
  // functions/src/__tests__. Writing that sequence here deleted this query and
  // the 100 lines under it from one gate's view, and silently removed
  // sendDailyGiftReminder from another's export count. Both happened while
  // writing this fix; see support/stripComments.ts for the scanner that ended it.
  const streakSnapshot = await db.collectionGroup('streak')
    .where('currentStreak', '>', 0)
    .get();

  const userIds = new Set<string>();
  for (const doc of streakSnapshot.docs) {
    const lastDate = doc.data().lastCompletionDate;
    const lastDateStr = typeof lastDate === 'string'
      ? lastDate.split('T')[0]
      : (lastDate?.toDate?.()?.toISOString().split('T')[0] ?? '');
    if (lastDateStr < today) {
      const uid = doc.ref.parent.parent?.id;
      if (uid) userIds.add(uid);
    }
  }
  let sent = 0;
  if (userIds.size > 0) {
    const entries = await readPushTokenEntries([...userIds]);
    const { recipients, messages } = buildPushBatch(entries, token => ({
      token,
      notification: { title: '🔥 Keep your streak alive!', body: "You haven't cleaned today yet." },
      data: { type: 'streak_reminder' },
    }));
    await sendEachAndPruneDeadTokens(admin.messaging(), db, recipients, messages);
    sent = messages.length;
  }
  logSenderOutcome('sendStreakReminder', streakSnapshot.docs.length, userIds.size, sent);
});

// Daily 10am PT (17:00 UTC) — remind users whose daily gift is ready to claim
export const sendDailyGiftReminder = onSchedule('0 17 * * *', async () => {
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  // Daily-gift claim state lives at users/{uid}/shop/data (field
  // lastDailyGiftClaimedAt), written by claimDailyGift — there is no 'dailyGift'
  // collection. collectionGroup('shop') also matches the top-level shop/current
  // doc, which is skipped by the doc-id guard / missing parent user.
  const shopSnapshot = await db.collectionGroup('shop').get();

  let scanned = 0;
  const userIds: string[] = [];
  for (const doc of shopSnapshot.docs) {
    if (doc.id !== 'data') continue;
    const uid = doc.ref.parent.parent?.id;
    if (!uid) continue;
    scanned++;
    const lastClaim = doc.data().lastDailyGiftClaimedAt;
    const lastClaimMs = lastClaim instanceof Timestamp
      ? lastClaim.toMillis()
      : typeof lastClaim === 'string' ? new Date(lastClaim).getTime() : 0;
    // lastClaimMs === 0 (never claimed) → gift is ready → remind.
    if (lastClaimMs < cutoffMs) {
      userIds.push(uid);
    }
  }
  let sent = 0;
  if (userIds.length > 0) {
    const entries = await readPushTokenEntries(userIds);
    const { recipients, messages } = buildPushBatch(entries, token => ({
      token,
      notification: {
        title: '🎁 Gibby left you a gift!',
        body: 'Tap to see what your friend dropped off.',
      },
      data: { type: 'daily_gift' },
    }));
    await sendEachAndPruneDeadTokens(admin.messaging(), db, recipients, messages);
    sent = messages.length;
  }
  logSenderOutcome('sendDailyGiftReminder', scanned, userIds.length, sent);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nextMidnightUTC(): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function nextMondayMidnightUTC(): Date {
  const d = new Date();
  const daysUntilMonday = (8 - d.getUTCDay()) % 7 || 7;
  d.setUTCDate(d.getUTCDate() + daysUntilMonday);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function userShopRef(uid: string) {
  return db.doc(`users/${uid}/shop/data`);
}

/**
 * Per-window purchase key for the weekly offer, so a recurring offer is buyable
 * once PER active window rather than once ever. Combines the offer id with its
 * `startsAt` (set fresh on every Monday rotation). Falls back to the bare id if
 * `startsAt` is missing — callers must still reject offers with no id.
 */
function weeklyOfferPurchaseKey(offer: DocumentData): string {
  const startsAt = offer.startsAt;
  const startMs =
    typeof startsAt?.toMillis === 'function'
      ? startsAt.toMillis()
      : typeof startsAt === 'number'
        ? startsAt
        : null;
  return startMs != null ? `${offer.id}_${startMs}` : `${offer.id}`;
}

// ---------------------------------------------------------------------------
// rotateMarket — daily 00:00 UTC
// Writes 3 chests to /shop/current.dailyChests
// ---------------------------------------------------------------------------

export const rotateMarket = onSchedule('0 0 * * *', async (_event) => {
  // Date-stamp IDs so dailyChestsPurchased entries from yesterday don't block today's rotation
  const dateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');

  // `rarity` is the chest's own display tier for the shop card. `dropTable`
  // names the table it rolls against, and is the ONLY thing purchaseChest
  // consults. Before W3-08 one field did both jobs and the assignment was
  // inverted: the Styles chest drew from the most generous table while the
  // Characters chest drew from the least, the reverse of the Part C ordering
  // (characters = RAREST, furniture = MOST COMMON).
  //
  // `subject` themes the chest on one variant set for the day. Without it
  // pickChestItem filtered on rarity alone and a Character chest could grant
  // a sofa.
  const chests = [
    { id: `chest_characters_${dateStr}`, category: 'characters', rarity: 'legendary', dropTable: CHEST_CATEGORY_DROP_TABLE.characters, subject: subjectForDay('characters', dateStr), name: 'Character', price: CHEST_PRICE.characters, artUrl: 'assets/images/shop/chest_characters.png' },
    { id: `chest_styles_${dateStr}`,     category: 'styles',     rarity: 'rare',      dropTable: CHEST_CATEGORY_DROP_TABLE.styles,     subject: subjectForDay('styles', dateStr),     name: 'Styles',    price: CHEST_PRICE.styles, artUrl: 'assets/images/shop/chest_styles.png' },
    { id: `chest_furniture_${dateStr}`,  category: 'furniture',  rarity: 'common',    dropTable: CHEST_CATEGORY_DROP_TABLE.furniture,  subject: subjectForDay('furniture', dateStr),  name: 'Furniture', price: CHEST_PRICE.furniture, artUrl: 'assets/images/shop/chest_furniture.png' },
  ].filter((chest) => offeredChestCategories(dateStr).includes(chest.category));

  // WARNING: The three chests above are BUILT unconditionally and then filtered, which
  // looks wasteful and is not. chestPricing.test.ts asserts against the source
  // text that there are exactly six chest-writer lines and that every one takes
  // its price from CHEST_PRICE — the durable half of W2-06, which exists because
  // the two writers were once hand-copied and drifted. Building conditionally
  // would delete those lines and the guard with them. The filter is the stock
  // rotation; the literals are the price contract. Keep them separate.

  try {
    await db.doc('shop/current').set(
      {
        dailyChests: chests,
        dailyChestsRefreshAt: Timestamp.fromDate(nextMidnightUTC()),
      },
      { merge: true }
    );
    console.log(`rotateMarket: daily chests updated for ${dateStr}`);
  } catch (err) {
    console.error('rotateMarket: failed to update daily chests', err);
    throw err;
  }
});

// ---------------------------------------------------------------------------
// rotateWeeklyOffer — every Monday 00:00 UTC
// Reads next offer from /shopConfig/weeklyOffers and writes to /shop/current
// ---------------------------------------------------------------------------

export const rotateWeeklyOffer = onSchedule('0 0 * * 1', async (_event) => {
  const configSnap = await db.doc('shopConfig/weeklyOffers').get();
  const configData = configSnap.data() ?? {};
  const seeded: DocumentData[] = configData.offers ?? [];

  // `shopConfig/weeklyOffers` is hand-seeded and in production never was —
  // rotation warned and returned every Monday, leaving shop/current with no
  // weeklyOffer field at all, which the client renders as $0.00 / no contents /
  // "Refreshing..." (weekly_offer.dart defaults every field). Falling back to
  // the bundled pool makes a deploy sufficient, the same way SEED_ITEMS made
  // the welcome chest survive an unseeded `items` collection. Firestore still
  // wins when populated, so offers stay hot-fixable without a deploy.
  let offers = seeded;
  if (offers.length === 0) {
    console.warn(
      'rotateWeeklyOffer: shopConfig/weeklyOffers is missing or empty — falling back to the bundled WEEKLY_OFFERS pool',
    );
    offers = WEEKLY_OFFERS as unknown as DocumentData[];
  }

  if (offers.length === 0) {
    console.error('rotateWeeklyOffer: bundled offer pool is empty — nothing to rotate');
    return;
  }

  // Cycle through offers by week number (epoch-relative, deterministic)
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const offer = offers[weekNum % offers.length];

  // Validate offer shape AND CONTENTS before writing. `id` is required: it's the
  // dedup key, and an undefined id makes the purchase check
  // `undefined === undefined` true, blocking first-time buyers.
  //
  // CRITICAL: W2-39 widened this from shape to CONTENTS. verifyIapAndGrant validates
  // nothing about contents[].itemId — it writes users/{uid}/inventory/{itemId}
  // for whatever string it finds — so an offer naming a nonexistent item does
  // not fail, it SUCCEEDS and grants a paid-for nothing.
  //
  // Caught HERE because catching it at rotation is free and catching it at
  // purchase is a refund.
  // Cast: offers may come from Firestore (DocumentData) or the bundled config.
  // The validator is total over a malformed shape — it reports what is missing
  // rather than assuming the fields exist — so a bad cast surfaces as a problem
  // string, not a crash.
  const problems = validateOfferContents(
    offer as unknown as WeeklyOfferConfig,
    SEED_ITEM_IDS,
  );
  if (problems.length > 0) {
    // Every problem at once — an offer with two bad ids must not need two
    // deploys to discover.
    console.error(
      `rotateWeeklyOffer: REFUSING to publish offer '${offer.id}' — ` +
        `${problems.length} problem(s): ${problems.join(' | ')}`,
      offer,
    );

    // CRITICAL: W2-40: THE REFUSAL HAS TO LAND SOMEWHERE A HUMAN LOOKS.
    //
    // W2-39 traded a silent bad outcome (a purchase granting a phantom) for a
    // loud one (the rotation refuses) — but loud only in Cloud Functions logs,
    // which nobody here has ever opened. A Monday with no offer, explained in a
    // place no one reads, is not meaningfully better than a Monday with a bad
    // one.
    //
    // WARNING: AND PREVENTION IS IMPOSSIBLE, which is why this is detection.
    // `shopConfig/weeklyOffers` is READ at :460 and WRITTEN BY NOTHING — no
    // callable, no endpoint, and no rules block, so it is console-only. There
    // is no write path to hook a check onto. The earliest moment a hand-edited
    // offer can be judged is the moment rotation reads it, which is here.
    //
    // So the reason is written NEXT TO THE DATA. Someone investigating "the
    // offer is missing" opens shop/current — that is the first place they look,
    // and now the explanation is sitting in it.
    try {
      await db.doc('shop/current').set(
        {
          weeklyOfferError: {
            at: Timestamp.now(),
            offerId: offer.id ?? '(no id)',
            problems,
            source: seeded.length > 0 ? 'shopConfig/weeklyOffers' : 'bundled WEEKLY_OFFERS',
          },
        },
        // mergeFields, not merge: replaces the error map wholesale and leaves
        // dailyChests and any previous weeklyOffer untouched. A refusal must not
        // take the daily chests down with it.
        { mergeFields: ['weeklyOfferError'] },
      );
    } catch (writeErr) {
      // The diagnostic must never become the failure. If this write fails the
      // log line above still happened, and the throw below is what matters.
      console.error('rotateWeeklyOffer: could not record weeklyOfferError', writeErr);
    }

    throw new Error('Malformed weekly offer config');
  }

  const now = new Date();
  const endsAt = nextMondayMidnightUTC();

  const weeklyOffer = {
    ...offer,
    startsAt: Timestamp.fromDate(now),
    endsAt: Timestamp.fromDate(endsAt),
  };

  try {
    // mergeFields (NOT merge: true) so the weeklyOffer MAP is replaced
    // wholesale — set-merge deep-merges nested maps and would leave stale
    // fields from a previous offer shape. dailyChests stays untouched.
    await db.doc('shop/current').set(
      {
        weeklyOffer,
        // KEY: CLEARED ON SUCCESS. A diagnostic that outlives the fault it
        // describes is its own lie — someone would read last month's refusal
        // beside this month's working offer and go looking for a bug that was
        // already fixed.
        //
        // WARNING: `null`, NOT FieldValue.delete(). The Functions emulator proxies the
        // admin SDK and drops the statics off `admin.firestore`, so
        // FieldValue.delete is undefined under test while working when deployed
        // — the same trap this file's header records for Timestamp. It failed
        // eight existing rotateWeeklyOffer tests immediately, which is the only
        // reason it was caught. A null field also reads better in the console
        // than an absent one: "checked, nothing wrong" rather than "never ran".
        weeklyOfferError: null,
        weeklyOfferRefreshAt: Timestamp.fromDate(endsAt),
      },
      // WARNING: weeklyOfferError MUST be listed here. mergeFields is an allowlist:
      // a FieldValue.delete() for a field absent from this array is SILENTLY
      // IGNORED, so the clear above would have done nothing and a stale refusal
      // would have sat beside a working offer forever. Caught in review of this
      // very diff; a test pins the two lists together.
      { mergeFields: ['weeklyOffer', 'weeklyOfferRefreshAt', 'weeklyOfferError'] }
    );
    console.log(`rotateWeeklyOffer: offer set to "${offer.title}"`);
  } catch (err) {
    console.error('rotateWeeklyOffer: failed to write offer', err);
    throw err;
  }
});

// ---------------------------------------------------------------------------
// purchaseChest — callable
// Input:  { chestId: string }
// Returns: { items: DroppedItem[], duplicateRefund: number, granted: boolean }
// ---------------------------------------------------------------------------

/// One item drawn for a chest, normalised so the grant write and the response
/// never care which source won. Mirrors WelcomeChestPick (see #67), plus a
/// `ref`: purchaseChest re-reads the chosen doc INSIDE its transaction to keep
/// the grant atomic, and a bundled pick has no document to re-read. `ref` is
/// null exactly when the pick came from SEED_ITEMS.
interface ChestItemPick {
  itemId: string;
  name: string;
  rarity: string;
  type: string;
  artUrl: string;
  /**
   * Whether the biased draw landed on something the player already held.
   *
 * WARNING: ADVISORY, NOT AUTHORITATIVE. It is computed from an ownership read taken
   * OUTSIDE the transaction, so a grant that lands in between can make it stale.
   * Every caller re-reads the chosen item's own inventory doc inside the
   * transaction and pays on THAT. This field exists to shape the odds and to
   * tell the two kinds of duplicate apart, never to decide a payment.
   */
  isDuplicate: boolean;
  /** True when the cell was exhausted and no non-duplicate existed to pick. */
  forcedDuplicate: boolean;
}

/// Draws one item of [itemRarity] and [subject] from the `items` collection,
/// falling back to the bundled SEED_ITEMS pool when the collection has nothing
/// matching.
///
/// [subject] is what makes a chest themed: a Character chest must not grant a
/// sofa. Before W3-08 this filtered on rarity alone and did exactly that. An
/// empty [subject] means "any", which keeps a chest row written by an older
/// deploy (no `subject` field) working rather than throwing not-found on every
/// purchase.
///
/// Firestore wins when populated, so a seeded collection stays authoritative
/// and remains hot-fixable without a deploy — the same precedence #67 used for
/// the welcome chest and #70 used for WEEKLY_OFFERS.
async function pickChestItem(
  subject: string,
  itemRarity: string,
  uid?: string,
): Promise<ChestItemPick> {
  const seeded = SEED_ITEMS.filter(
    (i) => i.rarity === itemRarity && (!subject || i.subject === subject),
  );
  if (seeded.length === 0) {
    // Only reachable if the BUNDLED pool has lost its last item of this
    // (subject, rarity) pair — a build-time fault, not a seeding one.
    // dailyRotation.test.ts ("every subject a chest can be themed on is
    // stocked at EVERY rarity") pins that every subject holds at least one
    // SEED_ITEMS entry for every rarity rollRarity can emit, which is what
    // makes this unreachable in practice. That guard is over the constants, so
    // it holds no matter how many times a chest is bought — which is what lets
    // W2-08 remove the daily cap without widening this hole.
    throw new HttpsError(
      'not-found',
      `No items available for subject "${subject}" at rarity ${itemRarity}`,
    );
  }
  // CRITICAL: THE BIAS, AND WHY IT IS NOT IN `DROP_TABLES`. What stood here was
  //
  //     const item = seeded[Math.floor(Math.random() * seeded.length)];
  //
  // — a uniform pick over the cell with NO ownership filter of any kind, which
  // is why this codebase had no duplicate probability to tune before W2-161.
  // The drop table chooses a RARITY and knows nothing about what the player
  // owns, so no amount of tuning it can move a duplicate rate. The rate is a
  // property of this line.
  const ownedIds = uid ? await ownedIdsAmong(uid, seeded.map((i) => i.id)) : EMPTY_OWNERSHIP;
  const {unowned, owned} = partitionByOwnership(seeded, ownedIds, (i) => i.id);
  const {item, isDuplicate, forcedDuplicate} = pickWithDuplicateBias(unowned, owned);
  return {
    itemId: item.id,
    name: item.name,
    rarity: item.rarity,
    type: item.type,
    artUrl: item.artUrl ?? '',
    isDuplicate,
    forcedDuplicate,
  };
}

/** No ownership known — the unbiased draw every caller had before W2-161. */
const EMPTY_OWNERSHIP: ReadonlySet<string> = new Set<string>();

/**
 * Which of `candidateIds` this player already holds.
 *
 * WARNING: READ OUTSIDE THE TRANSACTION, ON PURPOSE. The draw happens before the
 * transaction opens — it always has, and `pickChestItem` is a pure bundled
 * lookup since W2-134 — so this read is what the bias is shaped against. It can
 * go stale between here and the commit, and that is ACCEPTABLE for exactly one
 * reason: it only mis-shapes the ODDS. Every caller re-reads the chosen item's
 * own inventory document inside its transaction and pays the refund on that, so
 * a stale read here can never produce a wrong grant or a wrong charge.
 *
 * NOTE: One round trip, not one per item. Cells hold at most 6 items (measured over
 * the bundled pool), so `getAll` is a single call and the cost of the bias is
 * one extra round trip per chest, not one per candidate.
 */
async function ownedIdsAmong(
  uid: string,
  candidateIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (candidateIds.length === 0) return EMPTY_OWNERSHIP;
  const snaps = await db.getAll(
    ...candidateIds.map((id) => db.doc(`users/${uid}/inventory/${id}`)),
  );
  return new Set(snaps.filter((snap) => snap.exists).map((snap) => snap.id));
}

// chest.category is consumed client-side only as of Sprint 27
export const purchaseChest = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const uid = request.auth.uid;
  const { chestId, purchaseId } = request.data as {
    chestId: string;
    purchaseId?: string;
  };

  if (!chestId || typeof chestId !== 'string') {
    throw new HttpsError('invalid-argument', 'chestId (string) required');
  }

  // OPTIONAL replay key (W2-08). See the block comment above the daily-cap
  // removal below for why this exists. Optional so this deploy needs no
  // coordinated app release: the shipped client sends only { chestId }.
  //
  // Validated as a document id, because that is what it becomes: a '/' would
  // silently write into a nested collection, and an unbounded string would
  // let a caller author arbitrarily long paths.
  //
  // KEY: The rule lives in replayKey.ts and is SHARED with purchaseStreakShield
  // (W2-19). It used to be four conditions inline here; a second callable
  // copying them would have been a second definition of "valid replay key",
  // which is the drift this codebase keeps filing.
  assertValidReplayKey(purchaseId);

  // --- Pre-flight: read shop + roll item outside the transaction ---
  // Firestore transactions do not support collection queries (only document
  // reads). We pre-read the item list here, then re-verify the chosen item
  // doc INSIDE the transaction so the grant stays atomic and consistent.
  const shopSnap = await db.doc('shop/current').get();
  const shopData = shopSnap.data();
  if (!shopData) throw new HttpsError('not-found', 'Shop not initialized');

  // FIX #1: guard the array so a missing field is a clean 404, not a TypeError -> 'internal'
  const dailyChests = (shopData.dailyChests ?? []) as DocumentData[];
  const chest = dailyChests.find((c) => c.id === chestId);
  if (!chest) throw new HttpsError('not-found', 'Chest not in daily rotation');

  // `dropTable` decides the roll; `rarity` is display only. A chest row
  // written by a pre-W3-08 deploy has no dropTable, so fall back to the
  // category mapping rather than silently rolling the leanest table.
  const chestDropTable =
    (chest.dropTable as string) ??
    CHEST_CATEGORY_DROP_TABLE[chest.category as string] ??
    'lean';
  const chestSubject = (chest.subject as string) ?? '';
  const itemRarity = rollRarity(chestDropTable);

  // NOTE (cost): reads every item of the rolled rarity on each purchase.
  // Fine for now; at scale switch to a count + random-offset query.
  //
  // Draw from `items` when it is populated, and fall back to the bundled
  // SEED_ITEMS of the rolled rarity when it is not — the same remedy #67 gave
  // claimWelcomeChest, for the same reason. `items` is written ONLY by
  // seedShopData, a manual secret-gated POST that nothing enforces, and on
  // 2026-08-05 the production collection was observed in the Firebase console
  // to not exist at all (root collections: publicProfiles, shop, users). So
  // this throw was firing on EVERY chest purchase — including chests bought
  // with sponges a player had already earned — while shop/current was actively
  // selling three chests a day at 100 sponges each.
  const pick = await pickChestItem(chestSubject, itemRarity, uid);
  const itemId = pick.itemId;

  // --- Atomic transaction: re-verify rotation + item, check balance, deduct, grant ---
  const result = await db.runTransaction(async (tx) => {
    // ============================ READS ============================
    // (Firestore requires ALL reads before ANY writes.)

    // Re-verify shop state (chest must still be in rotation)
    const txShopSnap = await tx.get(db.doc('shop/current'));
    const txShopData = txShopSnap.data();
    if (!txShopData) throw new HttpsError('not-found', 'Shop not initialized');
    const txDailyChests = (txShopData.dailyChests ?? []) as DocumentData[];
    const txChest = txDailyChests.find((c) => c.id === chestId);
    if (!txChest) throw new HttpsError('not-found', 'Chest not in daily rotation');

    // FIX #3b: the item was rolled in pre-flight. If the rotation refreshed
    // mid-flight and the chest changed, the roll is stale — reject so we never
    // charge the new price for an old roll. ('aborted' signals the client it's
    // safe to retry.)
    //
    // This must compare the fields that actually DROVE the roll. It used to
    // compare `rarity`, which after W3-08 is display-only: a rotation that
    // changed the drop table or the day's subject while leaving the display
    // tier alone would have slipped through and granted an off-subject item at
    // the wrong odds.
    const txDropTable =
      (txChest.dropTable as string) ??
      CHEST_CATEGORY_DROP_TABLE[txChest.category as string] ??
      'lean';
    if (txDropTable !== chestDropTable ||
        ((txChest.subject as string) ?? '') !== chestSubject) {
      throw new HttpsError('aborted', 'Chest rotation changed, please retry');
    }

    // W2-08 — THE DAILY CAP IS GONE. Brendan's call: no daily limit on chest
    // purchases. What stood here was
    //
    //     const purchased = userShopData.dailyChestsPurchased ?? [];
    //     if (purchased.includes(chestId)) throw already-exists;
    //
    // against an array of DATE-STAMPED chest ids (see the rotation writer
    // above) — so it was one purchase per chest id per day, not a count, and
    // with three chests written a day that meant three purchases a day. It was
    // the thing standing between a day's rotation existing and anyone seeing
    // it: on device all three chests read "Purchased" within minutes and the
    // themed rotation was never exercised.
    //
    // KEY: It was ALSO the only replay guard in this callable — one field doing
    // two jobs, the shape `chest.rarity` had before #88. The replay half is
    // replaced below by the optional `purchaseId` ledger, not dropped.
    //
    // WARNING: The write is removed too, not just the check. The client reads this
    // very array (daily_market_grid.dart -> ChestCard.isPurchased) and
    // disables the card on it, so leaving the write in place would have kept
    // the button grey and delivered nothing.
    const purchaseLedgerRef = purchaseId
      ? db.doc(`users/${uid}/chestPurchases/${purchaseId}`)
      : null;
    if (purchaseLedgerRef != null) {
      const ledgerSnap = await tx.get(purchaseLedgerRef);
      if (ledgerSnap.exists) {
        throw new HttpsError('already-exists', 'This purchase was already processed');
      }
    }

    // User balance
    const profileRef = db.doc(`users/${uid}/profile/data`);
    const profileSnap = await tx.get(profileRef);
    const profileData = profileSnap.data() ?? {};
    const balance: number = profileData.spongeBalance ?? 0;

    // Duplicate check (document read — inside the transaction)
    const inventoryRef = db.doc(`users/${uid}/inventory/${itemId}`);
    const inventorySnap = await tx.get(inventoryRef);
    const isDuplicate = inventorySnap.exists;

    // FIX #3a re-read the chosen item doc in-tx so itemData could not go stale
    // between pre-flight and commit. W2-134 retired the `items` collection read,
    // so every pick is now a BUNDLED one: it ships inside the function and has no
    // document to re-read or to go stale. The re-read, its not-found throw, and
    // the nullable `ref` that selected between them are removed as dead rather
    // than left as an always-false branch.
    const itemData: DocumentData = {
      name: pick.name,
      rarity: pick.rarity,
      type: pick.type,
      artUrl: pick.artUrl,
    };

    // =========================== COMPUTE ===========================
    // W2-06: this was `txChest.price ?? 100`, which was harmless only while
    // every chest cost 100. With characters at 500 the same fallback silently
    // charges 100 for a 500 chest — no error, in the player's favour, and
    // invisible in the ledger because a wrong-but-legal number passes every
    // well-formedness check.
    //
    // `txChest` is an element of a persisted array on `shop/current`, written
    // by a DIFFERENT process at a DIFFERENT time (rotateMarket / seedShopData).
    // Firestore has no schema and the rules cannot validate array contents, so
    // "price is present" is a property of today's writers, not an invariant of
    // the data. Every writer in this file's history has set it — but the moment
    // one does not, guessing a price invents a transaction the player never
    // agreed to. Refuse instead: a missing price is an unpriced chest, not a
    // 100-sponge one.
    const rawChestPrice = txChest.price;
    if (typeof rawChestPrice !== 'number' || !Number.isFinite(rawChestPrice) || rawChestPrice < 0) {
      throw new HttpsError(
        'failed-precondition',
        'Chest has no valid price; refusing to charge a guessed amount',
      );
    }
    const chestPrice: number = rawChestPrice;

    // CRITICAL: THE REFUND IS A CREDIT, NOT A DISCOUNT — W2-161. Brendan asked for it
    // "treated like the daily reward, how you just receive the sponge amount":
    // the chest is charged at full price and the sponges are paid back, which is
    // what `openPendingChest` already did at its own `spongeBalance` increment
    // while this path did something else.
    //
    // WARNING: THE SPONGE ARITHMETIC IS UNCHANGED BY THAT, AND SAYING SO IS THE POINT.
    // The old discount incremented by -(price - refund); charging price and
    // crediting refund increments by (refund - price). Identical. What actually
    // changes is TWO things, and neither is the net:
    //   1. AFFORDABILITY. The gate below now requires the FULL price. Under the
    //      discount a player holding 187 sponges could buy a 250 chest and have
    //      it succeed as long as the item turned out to be a duplicate — the
    //      cost depended on the prize, which the player cannot know in advance.
    //   2. WHAT THE CLIENT IS TOLD. `duplicateRefund` is now a credit the reveal
    //      can show being paid, rather than a rebate already netted off.
    //
    // NOTE: 75% OF WHAT THIS CHEST ACTUALLY COST, not of a table keyed by the rolled
    // rarity. The old `DUPLICATE_REFUNDS[itemRarity]` paid a flat 100 for a
    // legendary whether it fell out of a 500-sponge characters chest or a
    // 100-sponge furniture one — 20% of one purchase and a 100% rebate on the
    // other. `chestPrice` is already in hand here, read off the shop document
    // inside this transaction, so the refund is derived from the real price
    // rather than from a second lookup that could disagree with it.
    //
    // No clamp is needed: `refundForPrice` is a fraction below 1 of a price this
    // block has already validated as a finite non-negative number, so it cannot
    // exceed what was charged and `duplicateRefund - chestPrice` cannot go
    // positive. The old `Math.min` guarded a table that had no such relationship
    // to the price.
    const duplicateRefund = isDuplicate ? refundForPrice(chestPrice) : 0;

    // Full price up front, whatever the prize turns out to be.
    if (balance < chestPrice) {
      throw new HttpsError('failed-precondition', 'Insufficient sponge balance');
    }

    // ============================ WRITES ============================
    // One increment, not two. Firestore coalesces writes to the same field in a
    // transaction rather than summing them, so a literal "charge, then credit"
    // pair would silently keep only the second. The charge and the credit are
    // therefore combined here and named in the expression rather than in a
    // comment that could drift from it.
    tx.set(
      profileRef,
      { spongeBalance: FieldValue.increment(duplicateRefund - chestPrice) },
      { merge: true }
    );

    // Clear rather than merely stop writing. Entries stamped earlier today
    // survive a deploy, and while one is present the client still greys that
    // card out — so a purchase actively removes the field rather than leaving
    // it to expire at the next UTC rotation.
    tx.set(
      userShopRef(uid),
      { dailyChestsPurchased: FieldValue.delete() },
      { merge: true }
    );

    // The replay guard proper. The read above returns a clean `already-exists`
    // for the ordinary retry; this `create` is what makes it atomic against a
    // genuinely concurrent one — a check followed by a write can interleave, a
    // create cannot.
    if (purchaseLedgerRef != null) {
      tx.create(purchaseLedgerRef, {
        chestId,
        itemId,
        purchasedAt: Timestamp.now(),
      });
    }

    if (!isDuplicate) {
      tx.set(inventoryRef, {
        itemId,
        ownedAt: Timestamp.now(),
        equipped: false,
      });
    }

    const droppedItem = {
      itemId,
      name: itemData.name ?? itemId,
      rarity: itemData.rarity ?? itemRarity,
      type: itemData.type ?? 'style',
      artUrl: itemData.artUrl ?? '',
    };

    // FIX #4: tell the client whether the item was actually granted, so it
    // doesn't append a duplicate to local inventory. Show the reveal, then
    // convert to refund when granted === false.
    return { items: [droppedItem], duplicateRefund, granted: !isDuplicate };
  });

  // XP for the purchase — awarded after the transaction commits so a failed or
  // aborted purchase never earns XP. Replays can't double-award: buying the
  // same chest twice throws 'already-exists' inside the transaction above.
  await awardXp(uid, XP_CHEST, 'chest_purchase');

  return result;
});

// ---------------------------------------------------------------------------
// claimDailyGift — callable. "A gift from Gibby."
//
// Input:  { supportsChest?: boolean }
// Returns: { amount, nextClaimableAt, kind, from, fromUid, items? }
//
// This is a RE-SKIN of the pre-existing daily gift, not a second faucet. A
// separate Gibby minter would have given the game two daily free-sponge
// sources and roughly doubled free income — an economy change nobody asked
// for. The decision was about the gift's CONTENTS, so only the contents moved:
// the 24h cooldown, the transaction, the claim state and the reminder push are
// all the ones that were already here.
//
// `amount` and `nextClaimableAt` keep their exact former types because the
// SHIPPED client hard-casts both (shop_repository_impl.dart:112-113). The new
// fields are additive and the current client ignores them.
//
// `supportsChest` is a CAPABILITY flag, not a roll: the client states what it
// can render, the server still decides what is granted. The live app renders
// this response as a sponge count and would show a chest as "0 sponges", so
// chests are withheld until a client opts in. Same contract, and the same
// reason, as purchaseChest's optional purchaseId — it lets this function
// deploy without a coordinated app release.
// ---------------------------------------------------------------------------

export const claimDailyGift = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const uid = request.auth.uid;

  const supportsChest = (request.data as { supportsChest?: boolean } | undefined)
    ?.supportsChest === true;

  // Rolled OUTSIDE the transaction, like purchaseChest's pre-flight: a
  // transaction body can be retried, and re-rolling on retry would let a
  // contended claim shop for a better gift.
  const gift = rollGibbyGift(Math.random, supportsChest);
  const chestItem = gift.kind === 'chest' ? await drawGibbyChestItem() : null;

  return db.runTransaction(async (tx) => {
    const userShopSnap = await tx.get(userShopRef(uid));
    const userShopData = userShopSnap.data() ?? {};

    // Read before any write, per Firestore's transaction rule — and read the
    // ownership the grant below depends on while reads are still legal.
    const giftItemOwned =
      chestItem != null &&
      (await tx.get(db.doc(`users/${uid}/inventory/${chestItem.itemId}`))).exists;

    const lastClaimed: Timestamp | null =
      userShopData.lastDailyGiftClaimedAt ?? null;

    if (lastClaimed) {
      const msSince = Date.now() - lastClaimed.toDate().getTime();
      if (msSince < 24 * 60 * 60 * 1000) {
        throw new HttpsError('already-exists', 'Daily gift already claimed');
      }
    }

    const amount = gift.sponges;

    // Skipped entirely for a chest: increment(0) is a pointless write, and
    // writing it would make the sponge ledger claim a credit that never
    // happened.
    if (amount > 0) {
      tx.set(
        db.doc(`users/${uid}/profile/data`),
        { spongeBalance: FieldValue.increment(amount) },
        { merge: true }
      );
    }

    // KEY: NO DUPLICATE REFUND ON THIS PATH, AND THAT ASYMMETRY IS DELIBERATE.
    // The purchase, quest and pending-chest paths all pay 75% on a duplicate;
    // this one pays nothing, and a future reader will otherwise take that for an
    // oversight and "fix" it.
    //
    // Brendan, 2026-08-29, ruling on exactly this question: *"The daily gift only
    // gives sponges so it would be a waste to add anything as the duplicate is
    // just for items, the daily gift is also free so it would make no sense."*
    //
    // The reasoning, because the number alone would not survive: the daily gift
    // is a SPONGE faucet, and a duplicate is an ITEM concept — so a refund here
    // is a category error rather than a mispriced one. It is also free, so there
    // is nothing to refund 75% OF. Deriving a price for it through
    // GIBBY_CHEST_DROP_TABLE ('mid' → styles → 187) is arithmetically possible
    // and would pay 12–37x the 5–15 sponges an ordinary gift day pays, from a
    // faucet nobody costed, while inverting the incentive so a player would
    // rather draw the duplicate than the item.
    //
    // NOTE: And the usual objection to paying nothing — "a duplicate that gives
    // nothing reads as a broken chest", which is why the purchase path pays —
    // does not apply here: `supportsChest` gates this branch dark, and
    // gibbyFunctions.test.ts pins that the shipped client never receives a chest
    // at all. There is no dead gift day to create.
    //
    // CRITICAL: A BARE `tx.set` REPLACES THE DOCUMENT. What stood here wrote the item
    // unconditionally, so gifting a player something they already owned reset
    // `ownedAt` to today and silently UNEQUIPPED an item they were wearing —
    // and destroyed any field this write does not name. The vault recorded this
    // as an `equipped: false` overwrite; it is a whole-document replace.
    //
    // WARNING: THE FIX IS NOT `merge: true`. Merging would preserve `equipped` and
    // still move `ownedAt` forward, and it changes the semantics of every field
    // in the document including ones nobody considered. An already-owned item
    // needs NO write at all: the correct grant is the one that does not happen.
    if (chestItem != null && !giftItemOwned) {
      tx.set(db.doc(`users/${uid}/inventory/${chestItem.itemId}`), {
        itemId: chestItem.itemId,
        ownedAt: Timestamp.now(),
        equipped: false,
        source: GIBBY_GIFT_SOURCE,
      });
    }

    const now = Timestamp.now();
    const nextClaimableAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    tx.set(
      userShopRef(uid),
      {
        lastDailyGiftClaimedAt: now,
        lastDailyGiftAmount: amount,
      },
      { merge: true }
    );

    return {
      amount,
      nextClaimableAt: nextClaimableAt.toISOString(),
      kind: gift.kind,
      from: GIBBY_DISPLAY_NAME,
      fromUid: GIBBY_UID,
      // `items` is closed to clients in firestore.rules, so this response is the
      // only way a reveal learns what was granted — same as claimWelcomeChest.
      ...(chestItem != null ? { items: [chestItem] } : {}),
    };
  });
});

/** The free tier's weekly Sunday gift. Brendan, 2026-08-14: "20 sponges a week on sunday". */
export const WEEKLY_FREE_GIFT_SPONGES = 20;

/**
 * The `YYYY-MM-DD` of the most recent Sunday, in UTC, for [now].
 *
 * CRITICAL: A DATE, NOT A DURATION, AND THE DIFFERENCE IS THE WHOLE DESIGN.
 * `claimDailyGift` keys on `msSince < 24h`, a rolling window, which is right for
 * a gift with no anchor. It is wrong here. A rolling seven days re-anchors the
 * week to whenever the player last opened the app: miss Sunday, claim Monday,
 * and every future gift is Monday's forever. Storing the Sunday means a missed
 * week is SKIPPED rather than shifted.
 *
 * WARNING: The inverse hazard is on file — a per-week CAP keyed on a calendar bucket
 * permits double the rate across the boundary, and rolling was the fix there. A
 * cap and a grant fail in opposite directions; the rule does not carry across.
 *
 * UTC, matching every schedule in this file (`rotateMarket '0 0 * * *'`,
 * `rotateWeeklyOffer '0 0 * * 1'`). Consistency beats any one player's midnight,
 * and the next reader should not have to infer which clock this is.
 */
export function mostRecentSundayUtc(now: Date): string {
  const d = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  // getUTCDay(): 0 = Sunday, so this is a no-op when today IS Sunday.
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().split('T')[0];
}

// ---------------------------------------------------------------------------
// claimWeeklyGift — callable. The free tier's 20 sponges, once per calendar week.
//
// Returns: { amount, sunday }
//
// A CALLABLE, not a scheduled fan-out: every existing `onSchedule` in this file
// writes ONE shared document, and a per-user sweep would cost a write per user
// per week whether or not they play. Same shape as claimDailyGift — the client
// asks, the server decides.
//
// CRITICAL: FREE ONLY. Pro's 80 is a billing-event grant and is NOT this function. A
// pro account silently receiving the free tier's weekly 20 is the failure mode,
// so the refusal is asserted out loud in the tests rather than left implied.
//
// Fail-closed by construction: `resolveEffectiveTier` decodes a stored
// `premium` to `pro` (refused) and passes an UNRECOGNISED string through
// unchanged, which is then also refused because it is not exactly 'free'. Only
// a genuinely free tier is paid. Note the direction differs from
// `paidTaskCapFor`, where failing closed means resolving to free — for a CAP the
// free value is the least generous, for a GRANT it is the only one that pays.
//
// WARNING: A LAPSED SUBSCRIBER IS PAID, and that is the point of resolving against the
// clock rather than reading the stored tier. Someone whose subscription ended is
// a free user, and the free tier's gift is theirs. This is the one place W2-67
// moves in the generous direction; every other consumer of the effective tier
// loses a benefit when it lapses. It also means an unreadable expiry pays: the
// server declined to certify a PAID entitlement, and refusing the free gift on
// the strength of a claim it just disbelieved would be the wrong closure.
// ---------------------------------------------------------------------------

export const claimWeeklyGift = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const uid = request.auth.uid;

  const sunday = mostRecentSundayUtc(new Date());

  return db.runTransaction(async (tx) => {
    const [userSnap, shopSnap] = await Promise.all([
      tx.get(db.doc(`users/${uid}`)),
      tx.get(userShopRef(uid)),
    ]);

    const tier = resolveEffectiveTier(userSnap.data(), Date.now());
    if (tier !== 'free') {
      throw new HttpsError(
        'failed-precondition',
        'The weekly gift is the free tier only',
      );
    }

    if (shopSnap.data()?.lastWeeklyGiftSunday === sunday) {
      throw new HttpsError('already-exists', 'Weekly gift already claimed');
    }

    tx.set(
      db.doc(`users/${uid}/profile/data`),
      { spongeBalance: FieldValue.increment(WEEKLY_FREE_GIFT_SPONGES) },
      { merge: true },
    );
    tx.set(userShopRef(uid), { lastWeeklyGiftSunday: sunday }, { merge: true });

    console.log(
      `claimWeeklyGift: +${WEEKLY_FREE_GIFT_SPONGES} sponges to ${uid} for week of ${sunday}`,
    );

    return { amount: WEEKLY_FREE_GIFT_SPONGES, sunday };
  });
});

// ---------------------------------------------------------------------------
// verifyIapAndGrant — callable
// Input: { receipt: string, productId: string }
// Returns: { success: boolean, granted: { sponges: number, items: string[] } }
// ---------------------------------------------------------------------------

export const verifyIapAndGrant = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const uid = request.auth.uid;
  const { receipt, productId } = request.data as {
    receipt: string;
    productId: string;
  };

  if (!receipt || !productId) {
    throw new HttpsError('invalid-argument', 'receipt and productId required');
  }

  // Verify the signature AND confirm the transaction is actually for the claimed
  // product — without this a genuine cheap transaction could be replayed against
  // an expensive productId on its first (un-processed) call.
  //
  // 2026-08-05 — this runs BEFORE the dedup check, where it used to run after.
  // The ledger is keyed on Apple's transaction id, which is only knowable from a
  // verified transaction. Verification is now local, so unlike the old receipt
  // path this costs no network round trip at all.
  const transaction = await validateAppleTransaction(receipt, productId, uid);
  const transactionId = transaction.transactionId;
  const processedRef = receiptLedgerRef(productId, transactionId);

  // Fast path — already processed. (Re-checked atomically inside the tx below.)
  const processedSnap = await processedRef.get();
  if (processedSnap.exists) {
    const prev = processedSnap.data()!;
    // `granted` is absent on a ledger doc written by verifySubscriptionReceipt.
    // It can no longer land on this key, but defaulting beats handing the
    // client `granted: undefined` where it expects {sponges, items}.
    return {
      success: true,
      granted: prev.granted ?? { sponges: 0, items: [] },
      alreadyProcessed: true,
    };
  }

  // Determine grant.
  const SPONGE_PACKS: Record<string, number> = {
    sponge_pack_100: 100,
    sponge_pack_550: 550,
    sponge_pack_1200: 1200,
  };

  let grantedSponges = 0;
  const grantedItems: string[] = [];
  let offerWindowKey: string | null = null; // set only for weekly-offer purchases

  if (SPONGE_PACKS[productId] != null) {
    grantedSponges = SPONGE_PACKS[productId];
  } else {
    // Weekly offer — read current offer contents (dedup re-checked in the tx).
    const shopSnap = await db.doc('shop/current').get();
    const offer = shopSnap.data()?.weeklyOffer as DocumentData | undefined;

    if (!offer || offer.iapProductId !== productId) {
      throw new HttpsError('not-found', 'Product not found in current offer');
    }
    if (!offer.id) {
      throw new HttpsError('failed-precondition', 'Current offer is misconfigured (missing id)');
    }
    offerWindowKey = weeklyOfferPurchaseKey(offer);

    for (const content of (offer.contents ?? []) as DocumentData[]) {
      if (content.type === 'sponges') {
        grantedSponges += content.amount ?? 0;
      } else if (content.itemId) {
        grantedItems.push(content.itemId);
      }
    }
  }

  const granted = { sponges: grantedSponges, items: grantedItems };

  // Atomic claim + grant. The processedReceipts doc is created INSIDE the
  // transaction as the idempotency lock, so concurrent calls / retries can
  // never double-apply the consumable sponge increment. All reads precede all
  // writes (Firestore transaction requirement).
  return db.runTransaction(async (tx) => {
    // ---- reads ----
    const txProcessed = await tx.get(processedRef);
    if (txProcessed.exists) {
      // Lost the race to a concurrent call — return its grant, don't re-apply.
      const prev = txProcessed.data()!;
      return {
        success: true,
        granted: prev.granted ?? { sponges: 0, items: [] },
        alreadyProcessed: true,
      };
    }

    const userShopDataRef = userShopRef(uid);
    if (offerWindowKey != null) {
      const userShopSnap = await tx.get(userShopDataRef);
      if (userShopSnap.data()?.weeklyOfferPurchasedFor === offerWindowKey) {
        throw new HttpsError('already-exists', 'Weekly offer already purchased');
      }
    }

    // Read inventory docs up front so re-granting an already-owned item never
    // resets its `equipped` state.
    const inventoryRefs = grantedItems.map((itemId) =>
      db.doc(`users/${uid}/inventory/${itemId}`),
    );
    const inventorySnaps = await Promise.all(inventoryRefs.map((ref) => tx.get(ref)));

    // ---- writes ----
    tx.set(processedRef, {
      uid,
      productId,
      transactionId,
      processedAt: Timestamp.now(),
      granted,
      // Same as the subscription path: recorded alongside the grant, inside the
      // same transaction, so a consumable bought anonymously is findable too.
      ...purchaserIdentityFields(request.auth),
    });

    if (grantedSponges > 0) {
      tx.set(
        db.doc(`users/${uid}/profile/data`),
        { spongeBalance: FieldValue.increment(grantedSponges) },
        { merge: true },
      );
    }

    inventoryRefs.forEach((ref, i) => {
      if (inventorySnaps[i].exists) {
        // Already owned — refresh ownedAt only, never touch `equipped`.
        tx.set(
          ref,
          { itemId: grantedItems[i], ownedAt: Timestamp.now() },
          { merge: true },
        );
      } else {
        tx.set(ref, {
          itemId: grantedItems[i],
          ownedAt: Timestamp.now(),
          equipped: false,
        });
      }
    });

    if (offerWindowKey != null) {
      tx.set(userShopDataRef, { weeklyOfferPurchasedFor: offerWindowKey }, { merge: true });
    }

    return { success: true, granted };
  });
});

// ---------------------------------------------------------------------------
// verifySubscriptionReceipt — callable
// Input: { receipt: string, productId: string }
// Returns: { success: boolean, alreadyProcessed?: boolean }
// Validates Apple receipt server-side and writes subscriptionTier to Firestore
// via Admin SDK (bypasses client write rules). iOS/Apple only — Android TBD.
// ---------------------------------------------------------------------------

export const verifySubscriptionReceipt = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const uid = request.auth.uid;
  const { receipt, productId } = request.data as { receipt: string; productId: string };

  if (!receipt || !productId) {
    throw new HttpsError('invalid-argument', 'receipt and productId required');
  }

  // Product id → tier. ONE table, now in appStoreNotifications.ts because the
  // notification endpoint grants on the same lookup; see its comment for why it
  // fails closed and why `sub_premium_monthly` is absent.
  const tier = SUBSCRIPTION_PRODUCT_TIERS[productId];
  if (!tier) {
    throw new HttpsError('invalid-argument', `Not a subscription product: ${productId}`);
  }

  // Verify the signature, confirm the transaction is for THIS subscription, and
  // read the REAL expiry — never fabricate it. A one-time, cancelled, or expired
  // transaction plus a claimed sub_* productId must not grant access.
  //
  // 2026-08-05 — verification moved ahead of the idempotency check for the same
  // reason as verifyIapAndGrant: the ledger is now keyed on Apple's transaction
  // id. This callable used to key on sha256(receipt), the SAME key
  // verifyIapAndGrant used, so whichever callable ran first wrote the lock and
  // this one returned alreadyProcessed WITHOUT EVER WRITING subscriptionTier.
  //
  // WARNING: 2026-08-05, corrected: the original note here said the collision came
  // from StoreKit 1, where `serverVerificationData` is the whole cumulative app
  // receipt. **That is not this app's code path** — the app runs StoreKit 2 and
  // the string is a JWS for one transaction (see appleJws.ts). Keying on the
  // transaction id is still right; the reason recorded was wrong, and the next
  // person would have reasoned from it. Under SK2 the collision route was a
  // restore: all three listeners treat `PurchaseStatus.restored` as `purchased`
  // (shop_purchase_provider.dart:45,146, subscription_purchase_provider.dart:38)
  // and a restore redelivers past transactions, so a paying customer who
  // reinstalled could silently lose their tier.
  const transaction = await validateAppleTransaction(receipt, productId, uid);
  const transactionId = transaction.transactionId;
  const processedRef = receiptLedgerRef(productId, transactionId);
  if ((await processedRef.get()).exists) {
    return { success: true, alreadyProcessed: true };
  }

  const expiresMs = transaction.expiresDateMs;
  if (expiresMs == null) {
    throw new HttpsError('invalid-argument', 'Subscription receipt has no expiry date');
  }
  if (expiresMs <= Date.now()) {
    throw new HttpsError('failed-precondition', 'Subscription has already expired');
  }

  // `tier` was resolved from SUBSCRIPTION_PRODUCT_TIERS at the top of this
  // handler, in the same lookup that gated the product id.
  const expiresAt = new Date(expiresMs);

  // ---------------------------------------------------------------------
  // CRITICAL: A RESTORE MAY ONLY EVER MOVE THE ENTITLEMENT FORWARD (W2-105).
  // ---------------------------------------------------------------------
  //
  // `appStoreNotificationsV2` writes these same three fields and guards the
  // write with a staleness check, for the reason its own comment gives:
  // "an EXPIRED redelivered after the DID_RENEW that followed it would wipe a
  // live entitlement." This path wrote them with NO comparison at all — two
  // writers of one field, one checked and one not.
  //
  // MEASURED, not theorised. Against the emulator: the webhook applied an
  // expiry six months out, a restore presenting an older still-valid
  // transaction overwrote it with one month, and the stored value was the
  // older one. `resolveEffectiveTier` reads exactly that field, so a paying
  // subscriber silently lost five months.
  //
  // WARNING: THE TWO HANDLERS USE DIFFERENT LEDGERS, which is what makes it
  // reachable: the webhook records `processedNotifications/{notificationUUID}`
  // and this path checks `processedReceipts/{productId}_{transactionId}`. A
  // renewal applied by the webhook leaves NOTHING this path can see, so the
  // idempotency check above cannot stand in for an ordering check.
  //
  // KEY: WHY THE COMPARISON IS AN EXPIRY HERE AND A `signedDate` THERE, WHICH
  // LOOKS INCONSISTENT AND IS NOT. The webhook must be able to move the expiry
  // BACKWARDS — a refund is exactly that — so it cannot compare expiries and
  // uses Apple's monotonic signing stamp instead. A RESTORE HAS NO
  // `signedDate`, and it also has no legitimate reason to reduce access: it
  // means "I paid for this, give it back". So the safe rule is not "is this
  // newer" but "does this grant MORE than what is already stored" — a
  // question a restore can actually answer.
  //
  // WARNING: TIER CANNOT REGRESS BY THIS PATH, so the expiry is the whole comparison:
  // every product in SUBSCRIPTION_PRODUCT_TIERS maps to 'pro'
  // (sub_pro_monthly, sub_pro_annual, sub_family_monthly). If a second tier is
  // ever added, this comparison becomes incomplete and must gain a tier rank.
  const currentExpiryMs = (
    (await db.doc(`users/${uid}`).get()).data()?.subscriptionExpiresAt as Timestamp | undefined
  )?.toMillis();
  const alreadyEntitledLonger = currentExpiryMs != null && currentExpiryMs >= expiresMs;

  if (alreadyEntitledLonger) {
    // The stored entitlement already covers everything this transaction would
    // grant. Skipping the write is the whole fix.
    //
    // NOTE: THE LEDGER AND THE OWNER INDEX ARE STILL WRITTEN BELOW, deliberately:
    // the transaction HAS been processed, and the owner index is how renewals
    // find this account. Returning early here would leave a restore that
    // re-runs forever and, worse, could leave `subscriptionOwners` unwritten
    // for a subscription whose renewals then land nowhere.
    console.log(
      `verifySubscriptionReceipt: ${productId}/${transactionId} grants to ` +
        `${new Date(expiresMs).toISOString()} but ${uid} is already entitled to ` +
        `${new Date(currentExpiryMs).toISOString()} — entitlement left alone`,
    );
  } else {
    // Admin SDK write bypasses client Firestore rules — intentional
    await db.doc(`users/${uid}`).set({
      subscriptionTier: tier,
      subscriptionProductId: productId,
      subscriptionExpiresAt: Timestamp.fromDate(expiresAt),
    }, { merge: true });
  }

  // -------------------------------------------------------------------------
  // CRITICAL: W2-163 — THE FAMILY THE BUYER ALREADY HAS
  // -------------------------------------------------------------------------
  //
  // A player buys `sub_family_monthly` and someone ALREADY in their family gets
  // nothing. Not a race and not an edge case — it is the ordinary "invite your
  // household first, upgrade later" path, and before this block
  // `planFamilyFanOut` had exactly TWO callers, neither of them here:
  // `joinFamily` (which has already run for an existing member) and
  // `appStoreNotificationsV2` (whose last mile is not wired — the ASC Server
  // Notifications URL has never been confirmed registered). So an existing
  // member got `familyProExpiresAt` from neither route and stayed free while
  // the owner paid for them.
  //
  // OK: Brendan, 2026-08-30: fan out to existing members on purchase. Every
  // current member gets Pro, plus everyone who joins later. It matches what the
  // buyer paid for.
  //
  // KEY: THE PRODUCT GATE COMES FROM `planFamilyFanOutForEffect`, NOT FROM AN `if`
  // I WROTE HERE, AND THAT IS THE LOAD-BEARING CHOICE. `planFamilyFanOut` plans
  // a REVOKE for every subject whenever `ownerHasFamilySubscription` is false —
  // it is one function that both grants and revokes, and the flag is what picks.
  // So calling it directly from here would mean that a family owner renewing
  // their PERSONAL `sub_pro_monthly` planned `familyProExpiresAt: null` for
  // every member and stripped the family the moment they bought anything else.
  // `planFamilyFanOutForEffect` returns `[]` for any product that is not
  // FAMILY_PRODUCT_ID, so the wrong-product case writes NOTHING rather than
  // writing a revoke — the same rule `joinFamily` and the webhook already obey,
  // reused rather than restated. Pinned by the control in verifyIapAndGrant.test.ts.
  //
  // NOTE: THE EXPIRY IS THE ONE NOW STORED, not `expiresMs`. When
  // `alreadyEntitledLonger` skipped the write above, the owner keeps a LONGER
  // stored expiry, and members must get what the owner actually holds rather
  // than the shorter figure this particular transaction happened to carry.
  //
  // WARNING: NOT IN A TRANSACTION, and that is safe here for a reason the webhook's
  // own comment already gives: these writes are ABSOLUTE (`familyProExpiresAt`
  // = a timestamp, or null), never `increment`, so applying the same plan twice
  // writes the same value twice. The webhook needs a transaction because it
  // must not skip a REVOKE behind an already-set lock; this path only ever
  // grants, and re-running it is a no-op rather than a double-grant.
  const ownedFamilies = await db
    .collection('families')
    .where('ownerUid', '==', uid)
    .limit(1)
    .get();
  const ownedFamily = ownedFamilies.docs[0];
  if (ownedFamily) {
    const familyExpiryMs = Math.max(expiresMs, currentExpiryMs ?? 0);
    const grants = planFamilyFanOutForEffect({
      family: ownedFamily.data() as FamilyDoc,
      effect: { kind: 'entitle', tier, productId, expiresAtMs: familyExpiryMs },
      nowMs: Date.now(),
    });
    for (const grant of grants) {
      // Hoisted out of the object literal on purpose: written inline, the
      // ternary makes userFieldOwnership's static extractor report a CF-written
      // field literally named `null`. Same reason as the two sibling call sites.
      const familyProExpiresAt =
        grant.familyProExpiresAtMs == null
          ? null
          : Timestamp.fromMillis(grant.familyProExpiresAtMs);
      await db.doc(`users/${grant.uid}`).set({ familyProExpiresAt }, { merge: true });
    }
  }

  // KEY: The owner index, and the reason a RENEWAL can ever find this account.
  //
  // A server notification arrives with no `request.auth` and cannot be made to
  // have one. The two identifiers on the transaction are both dead ends for
  // that purpose: `transactionId` is different on every renewal, and
  // `appAccountToken` is uuidv5(NAMESPACE, uid) — a ONE-WAY hash, computable
  // forward from a uid and not invertible back to one. `originalTransactionId`
  // is the only field that is both stable across renewals and usable as a key,
  // so the purchase — which IS authenticated — records the mapping here for the
  // notification to read.
  //
  // Written after the entitlement rather than before: an index entry pointing at
  // an account that was never entitled is worse than a missing one, because the
  // notification handler would find it and act on it.
  //
  // WARNING: Null only if Apple ever signs a subscription transaction without an
  // original id, which does not happen; the field is optional in the library's
  // types, not in the data. Skipped rather than defaulted.
  //
  // CRITICAL: AND IT IS NEVER RE-POINTED AT A DIFFERENT ACCOUNT (W2-105). The previous
  // version of this comment said "a wrong key here would hand one account's
  // renewals to another" and then guarded only the NULL case — while
  // `set({uid}, {merge: true})` would overwrite an existing entry naming
  // somebody else without a word. Two app accounts restoring the same Apple
  // original transaction — a reinstall onto a different account, or a shared
  // Apple ID — re-pointed EVERY FUTURE RENEWAL to whoever restored last. That
  // is deterministic, not a race, and it is the exact outcome the old comment
  // named as the thing to avoid.
  //
  // KEY: A STALE INDEX IS BETTER THAN A WRONG ONE. Refusing leaves the first
  // account receiving its renewals, which is at worst the status quo; allowing
  // the overwrite silently transfers a paid subscription's future to another
  // account. So the write is refused and the collision is logged loudly rather
  // than resolved by guessing which account deserves it — that is a support
  // decision with facts this server does not have.
  //
  // WARNING: THE SAME ACCOUNT RE-RESTORING IS NOT A COLLISION and still refreshes the
  // entry. Without that, a legitimate reinstall — the ordinary reason anyone
  // restores at all — would stop updating `linkedAt` and `productId`.
  const ownerKey = ownerKeyFor(transaction);
  if (ownerKey != null) {
    const existingOwner = (await subscriptionOwnerRef(ownerKey).get()).data()?.uid as
      | string
      | undefined;
    if (existingOwner != null && existingOwner !== uid) {
      console.error(
        `verifySubscriptionReceipt: originalTransactionId ${ownerKey} is already ` +
          `owned by ${existingOwner}; ${uid} restored the same subscription. ` +
          'Refusing to re-point the owner index — renewals continue to reach the ' +
          'original account.',
      );
    } else {
      await subscriptionOwnerRef(ownerKey).set({
        uid,
        productId,
        linkedAt: Timestamp.now(),
      }, { merge: true });
    }
  } else {
    console.error(
      `verifySubscriptionReceipt: ${productId}/${transactionId} has no originalTransactionId — ` +
        'renewals for this subscription cannot be attributed',
    );
  }

  await processedRef.set({
    uid,
    productId,
    transactionId,
    tier,
    processedAt: Timestamp.now(),
    // Recorded, never enforced — see signInProviderOf. The grant above has
    // already happened by the time this line runs, and that ordering is the
    // point rather than an accident.
    ...purchaserIdentityFields(request.auth),
  });

  return { success: true };
});

// ---------------------------------------------------------------------------
// appStoreNotificationsV2 — onRequest, called by Apple, never by the app
//
// CRITICAL: THE RENEWAL PATH. Until this existed a subscription was granted exactly
// once, at the moment of purchase, and never again — not because the grant was
// wrong but because nothing on the client was listening when Apple redelivered.
// Both purchase listeners are created INSIDE a buy action and cancelled when it
// resolves (`subscription_purchase_provider.dart:71`,
// `shop_purchase_provider.dart:81`), so `verifySubscriptionReceipt` is only ever
// reached from inside an active buy flow. A rebill happens with the app closed.
// Verified against origin/main @ 4886b83 rather than taken from the brief.
//
// WARNING: THE LAST MILE IS NOT WIRED, and cannot be from here. The URL has to be
// pasted into App Store Connect → App Information → App Store Server
// Notifications (Production and Sandbox are separate fields), and that console
// section is not reachable until the Paid Applications Agreement is signed.
// Until Brendan does both, Apple sends nothing and this endpoint is correct,
// deployed, tested and never called. Use the console's "Request a Test
// Notification" button to confirm the wiring: it sends TEST, which this handler
// answers 200 and ignores.
// ---------------------------------------------------------------------------

// Bare `onRequest`, with no options — deliberately, and unlike the four
// endpoints above. Those bind a secret; this one has nothing to bind. Apple
// authenticates itself with a signature, so there is no shared secret to
// declare, and the Gen2 secret-binding trap described on SEED_OPTS cannot apply
// to a function that reads no `process.env`.
export const appStoreNotificationsV2 = onRequest(async (req, res) => {
  // Apple POSTs `{ signedPayload }`. There is no shared secret, no header token
  // and no allow-list of source IPs — Apple publishes none and pins nothing.
  // THE SIGNATURE IS THE AUTHENTICATION: the payload is signed by a chain
  // rooted in Apple's CAs and asserts our bundle id, so a forged body fails
  // verification and nothing downstream runs. That is why every branch below
  // sits AFTER `verifyNotification`.
  if (req.method !== 'POST') {
    res.status(405).send('Method not allowed');
    return;
  }

  const signedPayload = (req.body as { signedPayload?: unknown } | undefined)?.signedPayload;
  if (typeof signedPayload !== 'string' || !signedPayload) {
    res.status(400).send('Missing signedPayload');
    return;
  }

  let notification;
  try {
    notification = await appleJws.verifyNotification(signedPayload);
  } catch (error) {
    // KEY: The response code decides whether Apple RETRIES, and the two failure
    // classes want opposite answers. A bad signature will fail identically
    // forever, so retrying it is pure noise — but answering 200 to a payload we
    // could not verify would make a genuine misconfiguration (wrong bundle id,
    // stale root certificates) silently indistinguishable from steady state.
    // 400 is loud and Apple's retries are bounded. `unavailable` is Apple's own
    // "transient, try again" signal and gets a 5xx so the retry is useful.
    const transient = error instanceof HttpsError && error.code === 'unavailable';
    console.error(
      `appStoreNotificationsV2: verification failed (${transient ? 'transient' : 'permanent'})`,
      error,
    );
    res.status(transient ? 503 : 400).send('Verification failed');
    return;
  }

  const { notificationUUID, notificationType, subtype, signedDateMs } = notification;
  const effect = effectOf(notification);

  if (effect.kind === 'ignore') {
    console.log(
      `appStoreNotificationsV2: ${notificationUUID} ${notificationType} ignored — ${effect.reason}`,
    );
    res.status(200).send('OK');
    return;
  }

  const ownerKey = notification.transaction && ownerKeyFor(notification.transaction);
  if (ownerKey == null) {
    console.error(
      `appStoreNotificationsV2: ${notificationUUID} ${notificationType} has no ` +
        'originalTransactionId — cannot attribute to an account',
    );
    res.status(400).send('Unattributable notification');
    return;
  }

  const ownerSnap = await subscriptionOwnerRef(ownerKey).get();
  const uid = ownerSnap.data()?.uid as string | undefined;
  if (!uid) {
    // WARNING: 503, NOT 200, and the idempotency lock is deliberately NOT written.
    //
    // Apple sends SUBSCRIBED at the same moment the client calls
    // `verifySubscriptionReceipt`, so this is a genuine race that a retry wins:
    // the index appears, the redelivery resolves, the entitlement lands. Taking
    // the lock here would make the retry a no-op and strand the subscriber.
    // Apple retries for ~3 days and then gives up, which is the correct
    // behaviour for a subscription this server has genuinely never seen.
    console.error(
      `appStoreNotificationsV2: ${notificationUUID} ${notificationType} — no owner for ` +
        `originalTransactionId ${ownerKey}; asking Apple to retry`,
    );
    res.status(503).send('Owner not yet known');
    return;
  }

  const applied = await db.runTransaction(async (tx) => {
    // ---- reads ----
    const lockRef = processedNotificationRef(notificationUUID);
    const [lockSnap, userSnap, ownedFamilies] = await Promise.all([
      tx.get(lockRef),
      tx.get(db.doc(`users/${uid}`)),
      // KEY: THE FAMILY THIS SUBSCRIBER OWNS, read in the SAME transaction as the
      // lock so the fan-out cannot be skipped by a retry that sees the lock
      // already set — see the block above the writes for why that, and not a
      // second ledger key, is the right shape here.
      //
      // `ownerUid ==` is a single-field equality, so Firestore's automatic
      // index serves it and firestore.indexes.json needs nothing. Limit 1
      // because a subscriber owns at most one family; a second would be a
      // defect in the creating callable, and taking the first is the same
      // fail-quiet the rest of this handler uses rather than 500ing at Apple.
      tx.get(db.collection('families').where('ownerUid', '==', uid).limit(1)),
    ]);

    if (lockSnap.exists) return 'duplicate';

    // CRITICAL: Apple does NOT guarantee delivery order, and retries can arrive days
    // late. Without this an EXPIRED redelivered after the DID_RENEW that
    // followed it would wipe a live entitlement. `signedDate` is Apple's own
    // ordering stamp and is monotonic per subscription; anything at or before
    // the last applied one is stale by construction.
    //
    // Stored on the user document rather than derived from
    // `subscriptionExpiresAt`, because a REFUND legitimately MOVES THE EXPIRY
    // BACKWARDS — comparing expiries would reject exactly the notification that
    // matters most.
    const lastMs = (userSnap.data()?.subscriptionNotifiedAt as Timestamp | undefined)?.toMillis();
    if (lastMs != null && signedDateMs <= lastMs) return 'stale';

    // ---- writes ----
    // merge: true throughout. `users/{uid}` is a mixed document — display name,
    // orientation state, streak fields — and a bare set() would replace all of
    // it with three subscription keys.
    tx.set(
      db.doc(`users/${uid}`),
      effect.kind === 'entitle'
        ? {
            subscriptionTier: effect.tier,
            subscriptionProductId: effect.productId,
            subscriptionExpiresAt: Timestamp.fromMillis(effect.expiresAtMs),
            subscriptionNotifiedAt: Timestamp.fromMillis(signedDateMs),
          }
        : {
            subscriptionTier: 'free',
            subscriptionProductId: effect.productId,
            // Backdated to when Apple says it ended, so the stored document and
            // `resolveEffectiveTier` agree instead of relying on a tier string.
            subscriptionExpiresAt: Timestamp.fromMillis(effect.endedAtMs),
            subscriptionNotifiedAt: Timestamp.fromMillis(signedDateMs),
          },
      { merge: true },
    );

    // -----------------------------------------------------------------------
    // CRITICAL: THE FAMILY FAN-OUT (W2-79), AND WHY IT HAS NO LEDGER KEY OF ITS OWN
    // -----------------------------------------------------------------------
    //
    // W2-76 left a residual: `familyProExpiresAt` is the owner's expiry COPIED,
    // so natural expiry lapses every member's grant on the clock with no writer
    // required — but a REFUND moves the expiry BACKWARDS, and a copy made
    // yesterday does not know. Without this, a refunded family owner's members
    // keep Pro until the period nobody paid for runs out.
    //
    // WARNING: THE BRIEF REQUIRED A SEPARATE LEDGER KEY AND I HAVE NOT ADDED ONE.
    // Its premise is that "the notification lock is taken BEFORE the effect is
    // applied, so riding on it would double-revoke on an Apple retry". That is
    // true of the sponge grant it comes from and is NOT true here, on two
    // counts, both checkable in this function:
    //
    //   1. THERE IS NO WINDOW. `lockRef` is written by the same `tx` as the
    //      user document, inside one `runTransaction`. Lock and effect commit
    //      together or not at all, so a retry cannot observe the lock without
    //      also observing the effect. The sponge finding was about a grant
    //      applied OUTSIDE the locked transaction, which this is not.
    //   2. A DOUBLE-APPLY WOULD BE HARMLESS ANYWAY. These writes are absolute
    //      (`familyProExpiresAt` = a timestamp, or null), not `increment`. The
    //      sponge grant was additive, which is the entire reason it needed its
    //      own key.
    //
    // KEY: AND THE REAL HAZARD RUNS THE OTHER WAY. The danger for a revoke is not
    // applying it twice, it is never applying it once — a lock set with the
    // fan-out undone, after which every retry returns `duplicate` and the stale
    // grant is permanent. A SEPARATE ledger key would have created exactly that
    // window by moving the fan-out outside this transaction. Keeping it inside
    // is what makes the revoke unmissable.
    //
    // Recorded rather than quietly done, because it deviates from a CRITICAL: gate.
    const ownedFamily = ownedFamilies.docs[0];
    if (ownedFamily) {
      const grants = planFamilyFanOutForEffect({
        family: ownedFamily.data() as FamilyDoc,
        effect,
        nowMs: signedDateMs,
      });
      for (const grant of grants) {
        // WARNING: THE TERNARY IS HOISTED OUT OF THE OBJECT LITERAL ON PURPOSE, and
        // it is not a style preference. Written inline as
        // `familyProExpiresAt: x == null ? null : Timestamp.fromMillis(x)`,
        // userFieldOwnership's static extractor parsed the ternary's branches
        // as keys and reported a CF-written field literally named `null`
        // (`null (written in index.ts)`). That is a fourth bug in the family
        // #364/#365 catalogued — but the FIRST that fails LOUD rather than
        // silent, so it cost a red suite instead of an open denylist. Recorded
        // in the PR; the extractor is not fixed here because a phantom field
        // cannot make the gate pass, and widening a parser is its own brief.
        const familyProExpiresAt =
          grant.familyProExpiresAtMs == null
            ? null
            : Timestamp.fromMillis(grant.familyProExpiresAtMs);
        tx.set(db.doc(`users/${grant.uid}`), { familyProExpiresAt }, { merge: true });
      }
    }

    tx.set(lockRef, {
      uid,
      notificationType,
      subtype: subtype ?? null,
      originalTransactionId: ownerKey,
      transactionId: notification.transaction?.transactionId ?? null,
      effect: effect.kind,
      signedAt: Timestamp.fromMillis(signedDateMs),
      processedAt: Timestamp.now(),
    });

    return 'applied';
  });

  console.log(
    `appStoreNotificationsV2: ${notificationUUID} ${notificationType} ${effect.kind} ` +
      `for ${uid} — ${applied}`,
  );
  res.status(200).send('OK');
});

// ---------------------------------------------------------------------------
// claimRetentionPromo — callable
// Returns: { granted, alreadyGranted, eligible, rule, activeDays, windows,
//            shortfall, expiresAt? }
//
// The 5-of-7 retention promo: clean 5 days of 7 for three weeks, receive one
// free month of Pro, once per account, ever. The decision lives entirely in
// retentionPromo.ts; this reads the log, performs the write, and decides
// nothing.
//
// KEY: ONE CALLABLE, NOT TWO. It answers "how am I doing?" and "give me the
// month" in a single round trip because the two questions share their whole
// cost — the eligibility query — and a separate read-only endpoint would double
// the reads for a screen that must show progress anyway. It is safe to call at
// any time: it grants only when eligible AND never granted before, and returns
// the progress either way.
// ---------------------------------------------------------------------------

export const claimRetentionPromo = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const uid = request.auth.uid;
  const nowMs = Date.now();

  // Bounded by the observation window, NOT the account's age. The collection is
  // never pruned and has no TTL — deliberately, since pruning destroys the
  // recompute the log exists for — so the existing full-collection shape
  // (`db.collection(...).get()`, index.ts:2527) would read a player's entire
  // history to answer a 21-day question.
  //
  // Range filter on `loggedAt` only, so no composite index is required:
  // Firestore builds single-field indexes automatically and
  // firestore.indexes.json carries just the giftInvites composite.
  const logSnap = await db
    .collection(`users/${uid}/completions`)
    .where('loggedAt', '>=', Timestamp.fromMillis(observationStartMs(nowMs)))
    .get();

  // CRITICAL: `loggedAt`, NEVER `dayKey`. The record carries both, and `dayKey` is the
  // player's LOCAL day — which is what a progress display wants and what an
  // entitlement must never trust, because it is CLIENT-SUPPLIED
  // (`clientNowIso.slice(0, 10)`, index.ts:2864 and :2368). A device clock
  // rolled forward and back manufactures three weeks of habit in one evening.
  // Tolerable for a quest tier; not for a free month. `loggedAt` is a server
  // Timestamp and cannot be moved from the client.
  const loggedAtMs = logSnap.docs
    .map((d) => (d.data().loggedAt as Timestamp | undefined)?.toMillis())
    .filter((ms): ms is number => typeof ms === 'number' && Number.isFinite(ms));

  const progress = evaluatePromo(loggedAtMs, nowMs);

  return db.runTransaction(async (tx) => {
    // ---- reads ----
    const userRef = db.doc(`users/${uid}`);
    const userSnap = await tx.get(userRef);
    const user = userSnap.data();

    // CRITICAL: ONCE PER ACCOUNT, ENFORCED BY A READ-THEN-WRITE INSIDE THE
    // TRANSACTION. Firestore rules cannot count across documents and cannot
    // express "only if this has never happened", so the uniqueness is the
    // server's job or it is nobody's. Same shape as claimWelcomeChest.
    if (user?.proPromoGrantedAt != null) {
      return { granted: false, alreadyGranted: true, ...progress };
    }

    if (!progress.eligible) {
      return { granted: false, alreadyGranted: false, ...progress };
    }

    // EXTENDS an existing entitlement rather than replacing it — see
    // promoExpiryMs. A month added to someone with three weeks left must not
    // shorten them to a month.
    const currentExpiryMs =
      (user?.subscriptionExpiresAt as Timestamp | undefined)?.toMillis() ?? null;
    const expiresMs = promoExpiryMs(nowMs, currentExpiryMs);

    // ---- writes ----
    // merge: true — users/{uid} is a mixed document and a bare set() would
    // replace a display name and a streak with three subscription keys.
    //
    // WARNING: `subscriptionProductId` is deliberately NOT written. There is no Apple
    // product behind this grant, and stamping one would make a promo look like
    // a purchase to anything that reads it — including a human reading the
    // document to work out what somebody paid.
    tx.set(
      userRef,
      {
        subscriptionTier: 'pro',
        subscriptionExpiresAt: Timestamp.fromMillis(expiresMs),
        proPromoGrantedAt: Timestamp.fromMillis(nowMs),
      },
      { merge: true },
    );

    console.log(
      `claimRetentionPromo: granted ${PROMO_GRANT_DAYS} days to ${uid} ` +
        `(rule=${ACTIVE_RULE}, windows=${progress.windows.join('/')}, ` +
        `>=${PROMO_ACTIVE_DAYS_PER_WINDOW} of ${PROMO_OBSERVATION_DAYS / 3} each)`,
    );

    return {
      granted: true,
      alreadyGranted: false,
      ...progress,
      expiresAt: Timestamp.fromMillis(expiresMs),
    };
  });
});

// ---------------------------------------------------------------------------
// getPlantDirectory — callable
// Input:  { query?: string }
// Returns: { plants: PlantSpecies[], source, match: PlantSpecies | null }
//
// Brendan: "say the plant time and it will use a directory's saved on the
// server with house plants and optimal watering times". This serves that
// directory. The timer that counts down is W1's; the interval it counts is
// this.
//
// KEY: THE OVERRIDE EXISTS SO A WRONG NUMBER CAN BE FIXED WITHOUT AN APP RELEASE,
// which is the whole reason the directory is server-side rather than bundled
// into the client. A watering interval is a claim the app makes about a living
// thing somebody owns; "wait for the next TestFlight build" is not an
// acceptable latency for correcting it.
//
// WARNING: AND THE BUNDLED LIST IS THE FALLBACK, NOT THE OTHER WAY AROUND — the same
// shape as rotateWeeklyOffer, adopted for the same hard-won reason. A
// hand-seeded config document that nothing writes is a trap this repo has
// already fallen into twice: `shopConfig/weeklyOffers` was never seeded in
// production and rotation warned and returned every Monday for weeks, and the
// unseeded `items` collection dead-ended orientation. Shipping the data inside
// the function bundle makes a DEPLOY sufficient and no manual step
// load-bearing, while Firestore still wins when someone populates it.
// ---------------------------------------------------------------------------

export const getPlantDirectory = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');

  const configSnap = await db.doc('plantConfig/directory').get();
  const override = (configSnap.data()?.plants ?? []) as DocumentData[];

  let plants: PlantSpecies[] = PLANT_DIRECTORY;
  let source: 'plantConfig/directory' | 'bundled' = 'bundled';

  if (override.length > 0) {
    // CRITICAL: VALIDATED BEFORE IT IS SERVED. The override is editable in the Firebase
    // console, so it passes through no test, no review and no deploy — the only
    // moment it can be judged is the moment it is read. Two species answering to
    // one alias, or an interval outside its own range, would otherwise reach a
    // player as a confident number.
    //
    // A bad override FALLS BACK rather than failing the call: a stale-but-sane
    // bundled interval is better for the plant than an error screen, and the
    // console edit that caused it is not the player's problem.
    const problems = validatePlantDirectory(override);
    if (problems.length > 0) {
      console.error(
        `getPlantDirectory: REFUSING plantConfig/directory — ${problems.length} ` +
          `problem(s): ${problems.join(' | ')}`,
      );
    } else {
      plants = override as unknown as PlantSpecies[];
      source = 'plantConfig/directory';
    }
  }

  // The lookup is served here rather than shipped to the client so that
  // "devil's ivy" and "Devils Ivy" resolve identically on every platform, and
  // so a matching fix does not need a client release either.
  const query = (request.data as { query?: unknown } | undefined)?.query;
  const match = typeof query === 'string' ? findPlant(query, plants) : null;

  return { plants, source, match };
});

/**
 * The idempotency ledger key for one NOTIFICATION.
 *
 * CRITICAL: Separate from `receiptLedgerRef` on purpose, and keyed on Apple's
 * `notificationUUID` rather than on a transaction id. The transaction id is
 * unique per renewal, which makes it the right key for a PURCHASE — but Apple
 * sends several notifications about the SAME transaction (`DID_FAIL_TO_RENEW`
 * and then `EXPIRED`, or `REFUND` after the `DID_RENEW` that paid for it), so a
 * notification ledger keyed that way would classify the second one as already
 * processed and silently drop it. The brief for this work said the idempotency
 * layer already existed because `receiptLedgerRef` is keyed per renewal; that is
 * true of renewals and false of the ending notifications, which is precisely the
 * half that revokes access.
 */
function processedNotificationRef(notificationUUID: string) {
  return db.doc(`processedNotifications/${notificationUUID}`);
}

/**
 * The `originalTransactionId -> uid` index, written at purchase and read by the
 * notification endpoint. See the write site in `verifySubscriptionReceipt`.
 */
function subscriptionOwnerRef(originalTransactionId: string) {
  return db.doc(`subscriptionOwners/${originalTransactionId}`);
}

/**
 * Verifies the client's signed transaction and returns it, or throws.
 *
 * CRITICAL: **2026-08-05 — this replaced a call to Apple's legacy `verifyReceipt`
 * endpoint, which could never have succeeded.** The app runs StoreKit 2
 * (`in_app_purchase_storekit` 0.4.10 defaults `_useStoreKit2 = true`, and
 * `enableStoreKit1()` cannot force it back on any iOS 15+ device), so
 * `PurchaseDetails.verificationData.serverVerificationData` is a **JWS signed
 * transaction**, not a base64 ASN.1 app receipt. Posting a JWS to
 * `/verifyReceipt` returns a non-zero status every time, for every product, so
 * both callables failed 100% of the time regardless of App Store Connect state.
 * That is the mechanical explanation for production `processedReceipts` being
 * empty: it was not that nobody had bought anything, it was that nobody could.
 *
 * The parameter is still named `receipt` because that is the callable's wire
 * contract with the shipped client; it is a JWS.
 *
 * Three checks, in order, all of which must pass before any ledger write:
 *   1. Apple's signature over the transaction (offline — see appleJws.ts).
 *   2. The transaction is for the productId the client claims. Without this a
 *      genuine cheap transaction could be replayed against an expensive one.
 *   3. The account boundary below.
 */
async function validateAppleTransaction(
  jws: string,
  productId: string,
  uid: string,
): Promise<AppleTransaction> {
  const transaction = await appleJws.verify(jws);

  if (transaction.productId !== productId) {
    throw new HttpsError('invalid-argument', 'Receipt does not contain the purchased product');
  }

  assertAccountBoundary(transaction, uid);
  return transaction;
}

/**
 * Refuses to grant a transaction that Apple stamped for a *different* account.
 *
 * The client stamps every purchase with `appAccountToken = uuidv5(NAMESPACE,
 * uid)` (`lib/core/purchases/purchase_account_token.dart`), Apple stores it on
 * the transaction itself, and it comes back on every redelivery, restore and
 * renewal. Here we recompute it from `request.auth.uid` — the only field on the
 * request that cannot be forged — and compare.
 *
 * KEY: The client-side half is a fix for honest-user mis-attribution; **this** is
 * the security boundary. A device-local `{productId -> uid}` map is overwritten
 * by the next account to buy the same product before the first account's
 * transaction is redelivered, so it ends up vouching for the wrong one.
 *
 * A null token is the compatibility case: every transaction Apple has signed so
 * far predates the stamping build. See `accountTokenRollout`.
 */
function assertAccountBoundary(transaction: AppleTransaction, uid: string): void {
  const token = transaction.appAccountToken;

  if (token == null) {
    const epochMs = accountTokenRollout.epochMs;
    if (epochMs != null && transaction.purchaseDateMs >= epochMs) {
      throw new HttpsError(
        'permission-denied',
        'Transaction is not attributed to an account',
      );
    }
    return;
  }

  if (token.toLowerCase() !== purchaseTokenForUid(uid)) {
    throw new HttpsError(
      'permission-denied',
      'Transaction belongs to a different account',
    );
  }
}

/**
 * The idempotency ledger key for one purchase.
 *
 * Namespaced by product as well as transaction so the two callables can never
 * write each other's lock even if Apple ever reused an id across product types.
 *
 * Before 2026-08-05 this was sha256(receipt) in BOTH callables. WARNING: The note that
 * used to sit here explained the collision in terms of StoreKit 1, where
 * `serverVerificationData` is one cumulative app receipt covering the whole
 * device — **that is not this app's code path**; see validateAppleTransaction.
 * The collision was real by a different route (a restore redelivering past
 * transactions), and Apple's transaction id is unique per purchase and per
 * renewal, so it separates distinct purchases while still catching a replay.
 */
/**
 * How the buyer signed in, from the VERIFIED ID token — never from the client.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: THIS DETECTS AND RECORDS. IT MUST NEVER REFUSE.
 * ---------------------------------------------------------------------------
 *
 * An anonymous uid lives on one device: lose the phone and the subscription is
 * unreachable, because `restorePurchases` restores the Apple transaction to a
 * uid nobody can sign into again. That is a real problem and it is worth
 * knowing about.
 *
 * WARNING: AND IT MUST NOT BE SOLVED HERE, BECAUSE APPLE HAS ALREADY CHARGED THE CARD
 * BY THE TIME THIS CODE RUNS. A server that refused an anonymous purchase would
 * produce a player who HAS PAID AND RECEIVED NOTHING — unrecoverable without a
 * manual refund, and a certain App Review rejection. The account requirement
 * belongs BEFORE the charge, in the client, or it does not exist.
 *
 * NOTE: THE SAME SHAPE AS `accountTokenRollout.epochMs`, which is still null for
 * exactly this reason: a guard correct in intent and catastrophic because it
 * fires after the money moved.
 *
 * KEY: TRUSTWORTHY, AND THAT WAS THE OPEN QUESTION. `request.auth.token` is the
 * DECODED, VERIFIED ID token — `firebase.sign_in_provider` is a claim Firebase
 * Auth signs, not a field the client hands us. It reads `'anonymous'` for
 * anonymous sign-in, and a client cannot forge it into saying otherwise. No
 * client-reported flag is needed and none should be added.
 */
function signInProviderOf(auth: {token?: unknown} | undefined): string | null {
  const token = auth?.token as {firebase?: {sign_in_provider?: unknown}} | undefined;
  const provider = token?.firebase?.sign_in_provider;
  return typeof provider === 'string' && provider.length > 0 ? provider : null;
}

/** Ledger fields recording WHO bought, so an anonymous buyer is findable later. */
function purchaserIdentityFields(auth: {token?: unknown} | undefined) {
  const provider = signInProviderOf(auth);
  return {
    // Null rather than absent when unknown: a missing field cannot be queried
    // for, and "we never recorded it" and "it was not anonymous" must not look
    // the same to whoever counts these later.
    purchaserSignInProvider: provider,
    purchaserWasAnonymous: provider === 'anonymous',
  };
}

function receiptLedgerRef(productId: string, transactionId: string) {
  return db.doc(`processedReceipts/${productId}_${transactionId}`);
}

// ---------------------------------------------------------------------------
// claimWelcomeChest — Gen2 callable (Sprint 28 Orientation)
// Called once per user at the end of the orientation flow.
// Grants exactly one RARE item of each of the three collection types, writes
// them to inventory, and atomically sets users/{uid}.orientationCompleted=true.
// Idempotent: throws 'already-exists' if already claimed.
// Returns: { items: DroppedItem[] }
//
// 2026-08-03 — rewritten from a room-keyed draw. The old version read
// weeklySchedule/current, mapped goal rooms to furniture categories
// ('Seating', 'Tables', 'Beds', …) and queried `items` with them. Those names
// come from the CLIENT's RoomCatalogue (placeable furniture); `items` is
// seeded from itemPool.ts, which is the SKIN/collection pool and uses
// 'sofa'/'chair'/'lamp'. The two vocabularies never intersected, so the query
// was always empty and every call threw 'not-found'. It had never been called
// by the app, so the bug shipped unnoticed.
//
// The draw is now room-independent, which also lets the weeklySchedule
// precondition go: orientation's first page is still a stub that saves no
// schedule, and requiring one here would fail every real claim.
// ---------------------------------------------------------------------------

/// One rare pick from each, in reveal order. Mirrors SEED_ITEMS `type`.
const WELCOME_CHEST_TYPES = ['furniture', 'character', 'style'] as const;

/// A granted item, already in the shape the callable returns. Drawing from the
/// `items` collection and from SEED_ITEMS both normalise to this, so the write
/// and the response never care which source won.
interface WelcomeChestPick {
  itemId: string;
  name: string;
  rarity: string;
  type: string;
  artUrl: string;
}

export const claimWelcomeChest = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const uid = request.auth.uid;

  // Early idempotency check — fast path before any heavy reads
  const userSnap = await db.doc(`users/${uid}`).get();
  if (userSnap.data()?.orientationCompleted === true) {
    // WARNING: NOT THE STRING THE PLAYER SEES, which matters for anyone asked to "fix
    // the wording". The shipped client matches on the CODE and substitutes its
    // own text — shop_repository_impl.dart:120 throws
    // AlreadyClaimedException('Welcome chest already claimed.') — so a player
    // re-entering orientation reads the CLIENT's sentence. This one reaches
    // logs and API consumers only. Reworded because it is free and it is what
    // a debugger reads; the player-facing half is W1's.
    throw new HttpsError(
      'already-exists',
      'This account has already claimed its welcome chest — nothing further to grant.',
    );
  }

  // NOTE: items query uses db (not tx) — items collection is read-only by
  // clients, so a non-transactional read is safe (same pattern as
  // purchaseChest). One query per type: three equality-only queries need no
  // composite index.
  //
  // Draw from `items` when it is populated, and fall back to the bundled
  // SEED_ITEMS per type when it is not.
  //
  // 2026-08-05 — the fallback exists because `items` is populated by a MANUAL
  // POST to seedShopData that nothing enforces. The welcome chest is a fixed,
  // guaranteed, once-per-user grant, so hard-failing when that step has not
  // been run turned a seeding gap into a dead end: on the first real-hardware
  // run this threw
  //   FAILED_PRECONDITION 'No rare furniture item in the pool'
  // which the client surfaces as "Something went wrong opening your chest."
  // with no way past it — a new user could not finish onboarding.
  //
  // SEED_ITEMS is the source `items` is seeded FROM and ships inside the
  // function bundle, so the fallback grants exactly the ids the collection
  // would have. welcomeChestPool.test.ts guarantees it holds a rare of every
  // drawn type, which is what makes the remaining throw unreachable in practice.
  const picks: WelcomeChestPick[] = [];
  for (const type of WELCOME_CHEST_TYPES) {
    const seeded = SEED_ITEMS.filter(
      (i) => i.type === type && i.rarity === 'rare',
    );
    if (seeded.length === 0) {
      // Only reachable if the BUNDLED pool has lost its last rare of this type
      // — a build-time fault, not a seeding one, and caught by
      // welcomeChestPool.test.ts before it can ship.
      throw new HttpsError('failed-precondition', `No rare ${type} item in the pool`);
    }
    const item = seeded[Math.floor(Math.random() * seeded.length)];
    picks.push({
      itemId: item.id,
      name: item.name,
      rarity: item.rarity,
      type: item.type,
      artUrl: item.artUrl,
    });
  }

  return db.runTransaction(async (tx) => {
    // Re-check inside transaction to guard against concurrent calls
    const userRefInTx = db.doc(`users/${uid}`);
    const userSnapInTx = await tx.get(userRefInTx);

    // Reads before writes, and before the throw below so the read set is the
    // same on every path through this transaction.
    const welcomeItemOwned = new Set<string>();
    for (const pick of picks) {
      if ((await tx.get(db.doc(`users/${uid}/inventory/${pick.itemId}`))).exists) {
        welcomeItemOwned.add(pick.itemId);
      }
    }
    if (userSnapInTx.data()?.orientationCompleted === true) {
      // WARNING: NOT THE STRING THE PLAYER SEES, which matters for anyone asked to "fix
      // the wording". The shipped client matches on the CODE and substitutes its
      // own text — shop_repository_impl.dart:120 throws
      // AlreadyClaimedException('Welcome chest already claimed.') — so a player
      // re-entering orientation reads the CLIENT's sentence. This one reaches
      // logs and API consumers only. Reworded because it is free and it is what
      // a debugger reads; the player-facing half is W1's.
      throw new HttpsError(
        'already-exists',
        'This account has already claimed its welcome chest — nothing further to grant.',
      );
    }

    // CRITICAL: The same bare-`tx.set` replace as the gift and quest paths. Reachable
    // only once per account, behind the `orientationCompleted` throw above, so
    // it is a far narrower bug than the other two — but it is the same defect,
    // and "narrow" is a statement about today's callers rather than about the
    // write. An item already held is left alone rather than overwritten.
    for (const pick of picks) {
      if (welcomeItemOwned.has(pick.itemId)) continue;
      tx.set(db.doc(`users/${uid}/inventory/${pick.itemId}`), {
        itemId: pick.itemId,
        ownedAt: Timestamp.now(),
        equipped: false,
        source: 'welcome_chest',
      });
    }
    tx.set(userRefInTx, {
      orientationCompleted: true,
      orientationCompletedAt: Timestamp.now(),
    }, { merge: true });

    return {
      // `items` is closed to clients in firestore.rules, so this response is
      // the only way the reveal learns what was granted — keep it complete.
      // Already normalised at draw time, so the fallback path returns the same
      // shape as a collection hit.
      items: picks,
    };
  });
});

// ---------------------------------------------------------------------------
// seedShopData — HTTP POST (dev/testing only)
// Seeds /shop/current and /items collection
// ---------------------------------------------------------------------------

export const seedShopData = onRequest(SEED_OPTS, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // Auth gate — this dev-only endpoint overwrites shop/current and the items
  // collection, so it must never run unauthenticated. Fails closed: if
  // SEED_SECRET is unset (e.g. prod), every request is rejected.
  const expectedSecret = process.env.SEED_SECRET;
  if (!expectedSecret || req.get('x-seed-secret') !== expectedSecret) {
    res.status(403).send('Forbidden');
    return;
  }

  const batch = db.batch();

  // Seed items collection.
  // `subject` is written here because pickChestItem filters the `items` query
  // on it — a seeded doc without one is invisible to every themed chest, and
  // the function would fall through to the bundled pool on every purchase
  // while `items` looked correctly populated in the console.
  for (const item of SEED_ITEMS) {
    batch.set(db.doc(`items/${item.id}`), {
      type: item.type,
      category: item.category,
      subject: item.subject,
      name: item.name,
      rarity: item.rarity,
      artUrl: item.artUrl,
    });
  }

  const now = new Date();
  const seedDateStr = now.toISOString().split('T')[0].replace(/-/g, '');
  // NOTE: DELIBERATELY NOT filtered by offeredChestCategories, unlike rotateMarket.
  // This is the bootstrap writer: it populates a fresh or emulated environment,
  // its ids are stable rather than date-stamped, and whatever it writes is
  // replaced wholesale at the next midnight rotation. Filtering here would make
  // a fresh install's shop depend on the date it happened to be seeded, and
  // would leave a developer unable to open a chest category on demand. The
  // stock rotation is a live-service behaviour, not a seeding one.
  const chests = [
    { id: 'chest_characters', category: 'characters', rarity: 'legendary', dropTable: CHEST_CATEGORY_DROP_TABLE.characters, subject: subjectForDay('characters', seedDateStr), name: 'Character', price: CHEST_PRICE.characters, artUrl: 'assets/images/shop/chest_characters.png' },
    { id: 'chest_styles',     category: 'styles',     rarity: 'rare',      dropTable: CHEST_CATEGORY_DROP_TABLE.styles,     subject: subjectForDay('styles', seedDateStr),     name: 'Styles',    price: CHEST_PRICE.styles, artUrl: 'assets/images/shop/chest_styles.png' },
    { id: 'chest_furniture',  category: 'furniture',  rarity: 'common',    dropTable: CHEST_CATEGORY_DROP_TABLE.furniture,  subject: subjectForDay('furniture', seedDateStr),  name: 'Furniture', price: CHEST_PRICE.furniture, artUrl: 'assets/images/shop/chest_furniture.png' },
  ];

  // CRITICAL: THE SECOND WRITER OF shop/current, AND IT USED TO CARRY ITS OWN COPY.
  // seedShopData bypasses rotateWeeklyOffer entirely, so a byte-identical
  // duplicate of offer_seed_001 lived here and nothing gated the two against
  // each other — changing one was a live half-state, and validating only the
  // rotation would have left this path unchecked (W2-39's disproof).
  //
  // Now it imports the one definition and runs the same validator. There is no
  // second copy to diverge.
  const seedOffer = WEEKLY_OFFERS[0];
  const seedProblems = validateOfferContents(seedOffer, SEED_ITEM_IDS);
  if (seedProblems.length > 0) {
    throw new Error(
      `seedShopData: refusing to seed malformed offer — ${seedProblems.join(' | ')}`,
    );
  }
  const weeklyOffer = {
    ...seedOffer,
    startsAt: Timestamp.fromDate(now),
    endsAt: Timestamp.fromDate(nextMondayMidnightUTC()),
  };

  batch.set(db.doc('shop/current'), {
    weeklyOffer,
    dailyChests: chests,
    dailyChestsRefreshAt: Timestamp.fromDate(nextMidnightUTC()),
    weeklyOfferRefreshAt: Timestamp.fromDate(nextMondayMidnightUTC()),
  });

  await batch.commit();

  res.json({ success: true, itemsSeeded: SEED_ITEMS.length });
});

// ---------------------------------------------------------------------------
// syncPublicProfile — mirrors users/{uid} into publicProfiles/{uid}
//
// The projection that makes user search and the Friends tab possible at all;
// the reasoning for why this cannot be done in rules is in publicProfile.ts
// and in the firestore.rules match block. This is the first Firestore trigger
// in the codebase.
// ---------------------------------------------------------------------------

export const syncPublicProfile = onDocumentWritten('users/{uid}', async (event) => {
  const uid = event.params.uid;
  const publicRef = db.doc(`publicProfiles/${uid}`);

  const before = event.data?.before.data();
  const after = event.data?.after.data();

  // The user document was deleted — the projection must not outlive it.
  if (after === undefined) {
    await publicRef.delete();
    return;
  }

  // The trigger fires on EVERY write to users/{uid}, and most carry nothing
  // the projection cares about: fcmToken refreshes, subscription renewals,
  // orientationCompleted. Bailing here keeps those free rather than paying an
  // Auth lookup plus a write each time.
  if (!projectionChanged(before, after)) return;

  // displayName comes from the Firebase Auth record, not the document —
  // nothing has ever written it to Firestore (see publicProfile.ts).
  let authDisplayName: string | undefined;
  try {
    authDisplayName = (await admin.auth().getUser(uid)).displayName ?? undefined;
  } catch (err) {
    // A users/{uid} document can outlive its Auth user. Degrade to an empty
    // name rather than throwing: an unhandled rejection here would make the
    // trigger retry this write until the backoff expires, for a document that
    // will never resolve.
    console.warn(`syncPublicProfile: no Auth record for ${uid}`, err);
    authDisplayName = undefined;
  }

  await publicRef.set(buildPublicProfile(after, authDisplayName));
});

// ---------------------------------------------------------------------------
// seedDemoAccount — HTTP POST (emulator-facing, secret-gated)
//
// W2-80. Creates an account with enough history that the store frames worth
// showing actually render. The decision half — what "enough history" is, and
// every date derived from one instant — is `demoAccount.ts`; this is the write
// half and deliberately holds no fixture values of its own.
//
// CRITICAL: EMULATOR ONLY, ENFORCED TWICE, AND THE SECRET ALONE IS NOT ENOUGH.
// seedShopData's secret gate makes prod safe because prod has no SEED_SECRET.
// That reasoning does NOT transfer here: this endpoint creates an AUTH USER
// with a known, published password, so a deployed runtime that ever did get the
// secret would gain a permanent back door. It therefore also requires the
// emulator env var, which Google's runtime never sets. Belt and braces, because
// the failure is not "a wrong shop item" but "anyone can log in".
// ---------------------------------------------------------------------------

/** The seeded account's credentials. Published on purpose — see below. */
const DEMO_EMAIL = 'demo@screenshots.local';
const DEMO_PASSWORD = 'screenshot-demo-2026';

export const seedDemoAccount = onRequest(SEED_OPTS, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // CRITICAL: GATE 1 — the emulator. `FIREBASE_AUTH_EMULATOR_HOST` is set by the
  // emulator suite and never by the deployed runtime, so this is not a
  // configuration that can be forgotten into the wrong state.
  if (!process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    res
      .status(403)
      .send('Forbidden: seedDemoAccount runs against the Auth emulator only');
    return;
  }

  // GATE 2 — the same shared secret as seedShopData, failing closed when unset.
  const expectedSecret = process.env.SEED_SECRET;
  if (!expectedSecret || req.get('x-seed-secret') !== expectedSecret) {
    res.status(403).send('Forbidden');
    return;
  }

  // WARNING: THE DEVICE'S WEEK, NOT THE SERVER'S, WHEN THE CALLER KNOWS IT.
  // `currentWeekStart()` runs in the DEVICE's local timezone; this runtime is
  // UTC. Near a Monday boundary they disagree and the schedule silently does
  // not load, because weekStartDate is an equality key. The response echoes
  // which week was written so a caller can see the value rather than assume it.
  const weekStartOverride =
    typeof req.body?.weekStartDate === 'string' ? req.body.weekStartDate : undefined;

  // CRITICAL: `todayLocal` ANCHORS EVERY DATE, NOT JUST THE WEEK — and the end-to-end
  // run is what proved it necessary. Without it, day keys come from this
  // runtime's UTC: seeded at 22:00 Pacific, the newest dailyScores cell came
  // back as the device's TOMORROW and lastCompletionDate sat a day in its
  // future. `weekStartDate` alone fixed the schedule and left the calendar
  // wrong. Anchored at noon UTC so it survives any real timezone.
  const nowMs =
    typeof req.body?.todayLocal === 'string'
      ? anchorNoonUtc(req.body.todayLocal)
      : Date.now();

  const auth = admin.auth();
  let uid: string;
  try {
    uid = (await auth.getUserByEmail(DEMO_EMAIL)).uid;
    // Re-seeding an existing account is the normal case, not an error: a
    // screenshot session is re-run until the frames are right, and a seeder
    // that only worked once would be re-run by deleting the emulator.
    await auth.updateUser(uid, {password: DEMO_PASSWORD});
  } catch {
    uid = (
      await auth.createUser({
        email: DEMO_EMAIL,
        password: DEMO_PASSWORD,
        displayName: DEMO_FIXTURE.displayName,
      })
    ).uid;
  }

  const writes = planDemoAccount({
    uid,
    nowMs,
    weekStartOverride,
  });

  // Chunked because a batch caps at 500 writes and `historyDays` is a fixture
  // value someone will raise: at 21 days this is ~26 writes, but the cap is not
  // a number this file should silently depend on.
  for (let i = 0; i < writes.length; i += 400) {
    const batch = db.batch();
    for (const w of writes.slice(i, i + 400)) {
      batch.set(db.doc(w.path), w.data, {merge: true});
    }
    await batch.commit();
  }

  res.status(200).json({
    uid,
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    documentsWritten: writes.length,
    weekStartDate: writes.find((w) => w.path.endsWith('weeklySchedule/current'))
      ?.data.weekStartDate,
    // Stated in the response because a harness that reports "seeded" while
    // covering two of three frames is the failure mode this brief named.
    framesSeedable: ['furnished house', '7-day streak'],
    framesNeedingADriver: [
      'running chore timer — CountdownTimer is ephemeral widget state mounted ' +
        'at task_completion_page.dart:284; no document can make it run. The ' +
        'seeded schedule makes it reachable on ' + DEMO_FIXTURE.timerTaskId + '.',
    ],
  });
});

// ---------------------------------------------------------------------------
// backfillPublicProfiles — HTTP POST (one-shot, admin only)
//
// syncPublicProfile only fires on FUTURE writes, so every account that existed
// before it deployed has no projection and is invisible to search. Same auth
// shape as seedShopData: POST-only, shared-secret header, fails closed when
// the secret is unset.
// ---------------------------------------------------------------------------

export const backfillPublicProfiles = onRequest(SEED_OPTS, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const expectedSecret = process.env.SEED_SECRET;
  if (!expectedSecret || req.get('x-seed-secret') !== expectedSecret) {
    res.status(403).send('Forbidden');
    return;
  }

  const usersSnap = await db.collection('users').get();
  const userDocs = usersSnap.docs;

  // Resolve the Auth display names first, with a bounded pool. Serially this
  // was one round trip per user — fine at two, minutes at five thousand.
  const authNames = await mapWithConcurrency(
    userDocs,
    AUTH_LOOKUP_CONCURRENCY,
    async (userDoc) => {
      try {
        return (await admin.auth().getUser(userDoc.id)).displayName ?? undefined;
      } catch {
        // Orphaned document — project it with an empty name rather than
        // aborting the whole backfill on one bad row.
        return undefined;
      }
    }
  );

  // Chunked commit. A WriteBatch is capped at 500 operations server-side, so a
  // single batch over every user throws INVALID_ARGUMENT above that and writes
  // NOTHING — a silent, total failure of the one operation you would be
  // running because search is broken. Log per chunk so a partial failure is
  // visible in the response and the logs rather than being inferred.
  let profilesBackfilled = 0;
  for (let start = 0; start < userDocs.length; start += BACKFILL_CHUNK_SIZE) {
    const chunk = userDocs.slice(start, start + BACKFILL_CHUNK_SIZE);
    const batch = db.batch();
    for (const [offset, userDoc] of chunk.entries()) {
      batch.set(
        db.doc(`publicProfiles/${userDoc.id}`),
        buildPublicProfile(userDoc.data(), authNames[start + offset])
      );
    }
    try {
      await batch.commit();
    } catch (err) {
      // Report what did land. Returning 200 with a full count here would claim
      // a backfill that never happened.
      console.error(
        `backfillPublicProfiles: chunk at offset ${start} failed after ` +
          `${profilesBackfilled}/${userDocs.length} profiles`,
        err
      );
      res.status(500).json({
        success: false,
        profilesBackfilled,
        totalUsers: userDocs.length,
        failedAtOffset: start,
      });
      return;
    }
    profilesBackfilled += chunk.length;
    console.log(
      `backfillPublicProfiles: committed ${profilesBackfilled}/${userDocs.length}`
    );
  }

  res.json({ success: true, profilesBackfilled });
});

// ---------------------------------------------------------------------------
// onNewUserBefriendGibby — Firebase Auth account creation
//
// The codebase had NO account-creation hook of any kind: no auth trigger, no
// blocking function, and no authoritative users/{uid} creation point (the
// document is upserted opportunistically by the FCM token write, the
// discoverability toggle, the avatar picker and claimWelcomeChest). So there
// was nowhere to hang "every new player starts with a friend".
//
// The client cannot do this itself and should not be able to: firestore.rules
// pins a client-written friend edge to status 'pending', which is what stops a
// client fabricating an 'accepted' edge and granting itself read access to any
// user's documents. Only an Admin SDK write can produce 'accepted', so this has
// to be server-side.
//
// v1 rather than v2: the v2 equivalent is beforeUserCreated, a BLOCKING
// function that requires an Identity Platform upgrade this project has not had.
// v1 auth triggers need no such upgrade.
//
// Covers BOTH signup paths, and by construction rather than by luck. Email
// signup calls createUserWithEmailAndPassword; the anonymous-link path calls
// linkWithCredential, which does NOT mint a new account — it attaches
// credentials to the existing anonymous uid, whose creation already fired this
// trigger. One account, one firing, either way.
// ---------------------------------------------------------------------------

export const onNewUserBefriendGibby = functionsV1Auth
  .user()
  .onCreate(async (user) => {
    // createUser inside ensureGibbyAccount fires this trigger for Gibby
    // himself. Bail before doing anything, or he befriends himself and the
    // ensure runs a second time.
    if (user.uid === GIBBY_UID) return;

    try {
      await ensureGibbyAccount();
      const wrote = await ensureGibbyFriendship(user.uid);

      // KEY: THE SUCCESS PATH MUST NAME THE uid, AND UNTIL W2-35 IT DID NOT.
      //
      // The swallow below means a failed grant and a successful one both finish
      // with platform status 'ok'. The only line carrying a uid was the
      // console.error — which, correctly, never fires. So a SUCCESS was
      // anonymous too: W2-31 could prove this trigger ran twice on the night a
      // guest reported Gibby missing, and could NOT prove either firing was his
      // account. Two firings, both 'ok', neither traceable to a person.
      //
      // WARNING: Written for `functions:log` ALONE, because that is the one production
      // tool this window proved reachable — no gcloud, no gen2 logs, no
      // Firestore reads (D48). So: one line, plain text, uid in it. Combined
      // with the error line below, which still carries the raw uid,
      // `functions:log --only onNewUserBefriendGibby | grep <uid>` now finds
      // EITHER outcome for a named account — the question anyone debugging
      // this actually has.
      //
      // NOTE: The error's wording is deliberately UNCHANGED. `grep -c "failed for"`
      // returning 0 across all history is the evidence W2-31 rests on, and
      // rewording it would silently invalidate a repeat of that check against
      // logs already written.
      console.log(
        `onNewUserBefriendGibby: ok uid=${user.uid} friendship=${wrote ? 'written' : 'skipped'}`,
      );
    } catch (err) {
      // Swallowed deliberately, and this MUST STAY. An unhandled rejection makes
      // the platform retry this trigger until backoff expires, and a failure
      // here must never be able to hold up account creation — a player without
      // Gibby is a missing friend, a player stuck at signup is a lost install.
      //
      // The swallow is exactly why the success line above exists: it is what
      // makes the two outcomes indistinguishable from outside, so the
      // distinction has to be written down rather than inferred from status.
      console.error(`onNewUserBefriendGibby: failed for ${user.uid}`, err);
    }
  });

// ---------------------------------------------------------------------------
// backfillGibbyFriendship — HTTP POST (one-shot, admin only)
//
// The trigger above only fires on FUTURE accounts, so everyone who signed up
// before it deployed has no Gibby. Same auth shape as backfillPublicProfiles
// and seedShopData: POST-only, shared-secret header, fails closed when the
// secret is unset.
// ---------------------------------------------------------------------------

export const backfillGibbyFriendship = onRequest(SEED_OPTS, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const expectedSecret = process.env.SEED_SECRET;
  if (!expectedSecret || req.get('x-seed-secret') !== expectedSecret) {
    res.status(403).send('Forbidden');
    return;
  }

  await ensureGibbyAccount();

  const usersSnap = await db.collection('users').get();

  // Bounded concurrency for the same reason backfillPublicProfiles uses it:
  // unbounded fan-out over the user collection is a write stampede, and serial
  // is a round trip per user. Each friendship is its own batch (two writes), so
  // one failure cannot roll back the rest.
  const results = await mapWithConcurrency(
    usersSnap.docs,
    AUTH_LOOKUP_CONCURRENCY,
    async (userDoc) => {
      try {
        return await ensureGibbyFriendship(userDoc.id);
      } catch (err) {
        console.error(
          `backfillGibbyFriendship: failed for ${userDoc.id}`,
          err,
        );
        return false;
      }
    },
  );

  const usersBefriended = results.filter(Boolean).length;
  console.log(
    `backfillGibbyFriendship: befriended ${usersBefriended}/${usersSnap.docs.length}`,
  );
  res.json({ success: true, usersBefriended });
});

// ---------------------------------------------------------------------------
// sendGiftInvite — tier-gated daily gift invite
// ---------------------------------------------------------------------------

export const sendGiftInvite = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const uid = request.auth.uid;

  const recipientUid: string = request.data?.recipientUid;
  if (!recipientUid || typeof recipientUid !== 'string') {
    throw new HttpsError('invalid-argument', 'recipientUid is required');
  }
  if (recipientUid === uid) {
    throw new HttpsError('invalid-argument', 'Cannot send a gift to yourself');
  }

  // Friend-only guard (read-only, outside transaction)
  const friendSnap = await db.doc(`users/${uid}/friends/${recipientUid}`).get();
  if (!friendSnap.exists || friendSnap.data()?.status !== 'accepted') {
    throw new HttpsError('failed-precondition', 'Recipient is not an accepted friend');
  }

  // Sender display name. Reads the projection, not users/{uid}/profile/data —
  // nothing has ever written displayName to that subdocument, so this always
  // fell through to 'A friend' and every gift invite arrived anonymous. The
  // projection sources the name from the Firebase Auth record.
  const senderProfileSnap = await db.doc(`publicProfiles/${uid}`).get();
  const fromDisplayName: string =
    senderProfileSnap.data()?.displayName || 'A friend';

  // Tier limits
  const userSnap = await db.doc(`users/${uid}`).get();
  // Resolved, not read raw, and the raw value is wrong in BOTH directions. A
  // document written before #314 still says `premium`, and nothing migrates
  // them — decoding resolves it to `pro` so a user who paid keeps a paid
  // allowance instead of falling to the free 1/day default below. And a
  // subscription that ENDED still says `pro` for ever, because nothing rewrites
  // the field when it lapses — dating it against the clock is what stops a
  // cancelled subscriber keeping 5 invites a day indefinitely. See
  // resolveEffectiveTier and LEGACY_TIER_ALIASES in taskRewards.ts.
  const tier: string = resolveEffectiveTier(userSnap.data(), Date.now());

  // WARNING: `premium: Infinity` is GONE, and it took a client orphan with it. It was
  // the only branch that made an allowance unbounded, and its client twin —
  // GiftAllowance.isUnlimited, the '∞' label, and friends_page.dart's disjunct
  // — became unreachable the moment #314 retired the tier. They were left in
  // place on purpose, to be removed together with this line rather than one
  // half at a time; splitting client from server is what produced the orphan.
  //
  // WARNING: AND IT MISSED ONE, THIRTY LINES DOWN. This note announced that orphan
  // closed while the ENCODING that carried the removed value — an `Infinity`
  // branch and a `-1` sentinel in the return — survived below it, which is the
  // same mechanism it describes: remove the value, leave the shape it needed.
  // Retired separately; the note is left standing because a comment claiming a
  // class of bug is closed should carry the instance it did not catch.
  //
  // Fails closed via `?? 1`: an unrecognised tier gets the free allowance.
  const dailyLimits: Record<string, number> = {
    free: 1,
    pro: 5,
  };
  const limit = dailyLimits[tier] ?? 1;

  const today = new Date().toISOString().split('T')[0];

  return db.runTransaction(async (tx) => {
    const countRef = db.doc(`users/${uid}/inviteCounts/${today}`);
    const countSnap = await tx.get(countRef);
    const currentCount: number = countSnap.data()?.count ?? 0;

    if (currentCount >= limit) {
      throw new HttpsError('resource-exhausted', `Daily gift limit of ${limit} reached`);
    }

    const inviteRef = db.collection(`users/${recipientUid}/giftInvites`).doc();
    const amount = weightedGiftAmount();

    tx.set(inviteRef, {
      fromUid: uid,
      fromDisplayName,
      amount,
      sentAt: Timestamp.now(),
      claimed: false,
    });

    tx.set(countRef, { count: FieldValue.increment(1) }, { merge: true });

    // `remaining` is always in [0, limit - 1], and both former escape hatches
    // are gone because neither value can occur:
    //
    //   Infinity — `dailyLimits` has no unbounded entry since #315 removed
    //   `premium: Infinity`, and `?? 1` bounds the miss. `limit` is 1 or 5.
    //
    //   negative — the `currentCount >= limit` guard above THROWS, so this line
    //   is reached only when currentCount <= limit - 1. Being at the cap is a
    //   real state, but it leaves as resource-exhausted; it never arrives here
    //   as a negative number.
    //
    // WARNING: The `-1` this replaces was a SENTINEL for unlimited, not a count, and
    // it was returned on the same channel as a real count — so a client had to
    // know that one value of a number meant "not a number". That is worth
    // stating because the obvious reading of a stray `-1` is the other one: an
    // at-cap user. It never meant that here.
    const remaining = limit - currentCount - 1;
    return { remaining };
  });
});

// ---------------------------------------------------------------------------
// claimGift — idempotent gift claim, credits spongeBalance
// ---------------------------------------------------------------------------

export const claimGift = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const uid = request.auth.uid;

  const inviteId: string = request.data?.inviteId;
  if (!inviteId || typeof inviteId !== 'string') {
    throw new HttpsError('invalid-argument', 'inviteId is required');
  }

  const result = await db.runTransaction(async (tx) => {
    const inviteRef = db.doc(`users/${uid}/giftInvites/${inviteId}`);
    const inviteSnap = await tx.get(inviteRef);

    if (!inviteSnap.exists) {
      throw new HttpsError('not-found', `Gift invite ${inviteId} not found`);
    }

    const data = inviteSnap.data()!;
    if (data.claimed === true) {
      throw new HttpsError('already-exists', 'Gift already claimed');
    }

    const amount: number = data.amount as number;

    tx.set(
      db.doc(`users/${uid}/profile/data`),
      { spongeBalance: FieldValue.increment(amount) },
      { merge: true },
    );

    tx.set(
      inviteRef,
      { claimed: true, claimedAt: Timestamp.now() },
      { merge: true },
    );

    return { amount };
  });

  // XP for the claim — awarded after the transaction commits. Replays can't
  // double-award: a re-claim throws 'already-exists' inside the transaction.
  await awardXp(uid, XP_GIFT_CLAIM, 'gift_claim');

  return result;
});

// ---------------------------------------------------------------------------
// purchaseStreakShield — callable (Streak feature)
// Input: {} (auth uid used)
// Spends STREAK_SHIELD_PRICE sponges to add one streak shield, capped at
// MAX_STREAK_SHIELDS. spongeBalance lives at users/{uid}/profile/data;
// streakShields lives at the top-level users/{uid} doc — both mutated in one
// transaction so a deduction can never commit without the shield grant.
// Returns: { shields, spent, balance }
// ---------------------------------------------------------------------------

export const purchaseStreakShield = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Not signed in');

  // OPTIONAL replay key (W2-19), same rule as purchaseChest via replayKey.ts.
  //
  // CRITICAL: THE TRANSACTION BELOW WAS NEVER THE PROBLEM. It makes the shield cap and
  // the balance check race-safe, and it does nothing at all about the SAME call
  // arriving twice after a dropped response — the client retries and a second
  // debit is perfectly consistent from the server's side. Before this key, a
  // lost network response cost the player 150 sponges and bought a shield they
  // already owned.
  //
  // Optional for now because requiring it breaks every installed build; see
  // REPLAY_KEY_IS_OPTIONAL in replayKey.ts and the W2-19 return.
  const { purchaseId } = (request.data ?? {}) as { purchaseId?: string };
  assertValidReplayKey(purchaseId);

  const userRef = db.doc(`users/${uid}`);
  const profileRef = db.doc(`users/${uid}/profile/data`);
  const purchaseLedgerRef = purchaseId
    ? db.doc(`users/${uid}/shieldPurchases/${purchaseId}`)
    : null;

  return db.runTransaction(async (tx) => {
    // NOTE: The ledger read joins the EXISTING Promise.all rather than adding a
    // round-trip. A reuse of purchaseChest's pattern, not a restructure — which
    // was the brief's disproof condition, and it does not fire.
    const [userSnap, profileSnap, ledgerSnap] = await Promise.all([
      tx.get(userRef),
      tx.get(profileRef),
      purchaseLedgerRef ? tx.get(purchaseLedgerRef) : Promise.resolve(null),
    ]);

    if (ledgerSnap != null && ledgerSnap.exists) {
      throw new HttpsError('already-exists', 'This purchase was already processed');
    }
    const shields: number = userSnap.data()?.streakShields ?? 0;
    const balance: number = profileSnap.data()?.spongeBalance ?? 0;

    if (shields >= MAX_STREAK_SHIELDS) {
      throw new HttpsError('failed-precondition', 'Shield cap reached', { reason: 'cap_reached' });
    }
    if (balance < STREAK_SHIELD_PRICE) {
      throw new HttpsError('failed-precondition', 'Insufficient balance', { reason: 'insufficient_balance' });
    }

    // create(), not set(): a check followed by a write can interleave, a create
    // cannot. Same reasoning as purchaseChest's ledger — the read above catches
    // a retry, this catches a genuinely concurrent one.
    if (purchaseLedgerRef != null) {
      tx.create(purchaseLedgerRef, {
        spent: STREAK_SHIELD_PRICE,
        purchasedAt: Timestamp.now(),
      });
    }

    tx.set(userRef, { streakShields: FieldValue.increment(1) }, { merge: true });
    tx.set(profileRef, { spongeBalance: FieldValue.increment(-STREAK_SHIELD_PRICE) }, { merge: true });

    return { shields: shields + 1, spent: STREAK_SHIELD_PRICE, balance: balance - STREAK_SHIELD_PRICE };
  });
});

// ---------------------------------------------------------------------------
// recordTaskCompletion — callable (Streak feature)
// Input: { clientNowIso: string } — naive-local ISO from the client.
// Advances the streak for a task completion. Mirrors task_provider.dart's
// streak logic, with shield-awareness added for multi-day gaps: a gap > 1 day
// burns one shield (if available) to keep the streak alive instead of resetting.
// Idempotent within a streak-day (gap == 0 → no-op).
//
// It also pays the completion. Rewards are PER TASK, capped per day, and are
// granted by grantTaskRewards() against a ledger of what today already paid —
// they no longer ride the streak's gap == 0 guard, which used to mean the
// second task of a day earned nothing at all. See taskRewards.ts.
// Returns: { ok: true, granted: { sponges, xp, paidCount, capped },
//            streakAdvanced: boolean }
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// recomputeQuestReport — callable, READ-ONLY
// Input: { from?: string, to?: string }  (YYYY-MM-DD, both inclusive)
// ---------------------------------------------------------------------------
//
// Replays the caller's own completion log through the live evaluator and
// reports what quest state it implies. W2-13.
//
// CRITICAL: IT GRANTS NOTHING AND WRITES NOTHING. That is the entire contract, and it
// is enforced by construction: this handler has no write in it, and
// questRecompute.ts has no Firestore import at all. A recompute that silently
// pays out is a migration that guesses — and with sweeps unverifiable from the
// log (see questRecompute.ts) some of what it would pay is guessed by
// construction. Granting is a separate, deliberate act that needs a human
// decision, and Brendan has not made it.
//
// NOTE: Owner-scoped, and exposes nothing new: firestore.rules already lets a user
// READ their own users/{uid}/completions and quests/state. This does the replay
// server-side against the same evaluator the grant path uses, which is the
// point — a client-side reimplementation would be a second evaluator, and a
// recompute that disagrees with the live path is worse than none.
//
// WARNING: It deliberately takes the window as an argument with NO default. How far
// back a quest may be recomputed is the retention decision, and that is a
// product call.
export const recomputeQuestReport = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Not signed in');

  const {from, to} = (request.data ?? {}) as {from?: string; to?: string};
  const isDayKey = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  if (from !== undefined && !isDayKey(from)) {
    throw new HttpsError('invalid-argument', 'from must be YYYY-MM-DD');
  }
  if (to !== undefined && !isDayKey(to)) {
    throw new HttpsError('invalid-argument', 'to must be YYYY-MM-DD');
  }

  const logSnap = await db.collection(`users/${uid}/completions`).get();
  const records = logSnap.docs.map((d) => d.data() as CompletionRecord);

  const stateSnap = await db.doc(`users/${uid}/quests/state`).get();
  const liveState = (stateSnap.data()?.quests ?? {}) as QuestStateMap;

  // recomputeDelta, not recomputeFromLog: replaying from scratch re-reports
  // every tier the log implies INCLUDING those already paid, and handing that
  // list to a granter would pay them twice. Passing the live state lets
  // claimedTiers suppress them. The read-only contract makes this safe either
  // way; using the delta means the report also answers the only question worth
  // asking before a grant — "what has NOT been paid".
  const report = recomputeDelta(records, liveState, {from, to});

  return {
    ok: true,
    // `unpaid`, not `payouts` — naming it for what it means to a reader, so
    // nobody mistakes a report for a receipt.
    unpaid: report.payouts,
    daysWithRecords: report.daysWithRecords,
    recordsReplayed: report.recordsReplayed,
    earliestRecord: report.earliestRecord,
    latestRecord: report.latestRecord,
    // NOTE: The blind-before date. A zero here means "no data", never "no
    // progress", and without this field those are the same output.
    blindBefore: report.blindBefore,
    windowPrecedesLog: report.windowPrecedesLog,
    approximations: report.approximations,
  };
});

// ---------------------------------------------------------------------------
// claimMinigamePrize — callable
// Input: { clientNowIso: string }
// ---------------------------------------------------------------------------
//
// Grants the organisation mini-game's daily reward. W2-17.
//
// KEY: IT VALIDATES THE CLAIM, NOT THE DRAG. No arrangement is accepted, none is
// checked, and none could be — see the header of minigame.ts for why replaying
// the puzzle server-side would be a second implementation of the slot-fit rule,
// and what that costs in this codebase specifically.
//
// CRITICAL: THE DAILY CLOCK IS THE SERVER'S, AND IT USED TO BE THE CALLER'S. W2-172.
// This read `const dayKey = clientNowIso.slice(0, 10)` — the key the whole
// once-per-day guarantee rests on, supplied by whoever is calling. Since
// `canClaimMinigame` keeps ONE row and grants on any dayKey that is not the last
// one, alternating two well-formed dates minted 50 sponges per call without
// bound, and the format regex only ever checked the SHAPE of the date.
//
// KEY: It is not a judgement call about acceptable risk — it is this callable
// failing a rule its neighbour keeps. index.ts:2161-2167 already says `dayKey`
// "is what an entitlement must never trust, because it is CLIENT-SUPPLIED", and
// grantProPromo obeys it by reading a server `loggedAt`.
//
// WARNING: `request.data` IS NOT READ AT ALL NOW, AND THAT IS THE STRONGER STATEMENT.
// A callable simply ignores fields it does not destructure, so a client sending
// the old `{clientNowIso}` payload still succeeds and one sending `{}` does too
// — nothing in lib/ has ever called this (measured: zero callers in the whole
// history), so there was no payload to preserve either way. What the absence
// buys is that no client value can reach the grant path, which minigame.test.ts
// pins as `expect(body).not.toContain('request.data')`.
export const claimMinigamePrize = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Not signed in');

  const dayKey = minigameDayKey();

  const ledgerRef = db.doc(`users/${uid}/economy/minigame`);

  return db.runTransaction(async (tx) => {
    const ledgerSnap = await tx.get(ledgerRef);
    const ledger = ledgerSnap.data() as MinigameLedger | undefined;

    // A replay is a NO-OP THAT REPORTS ITSELF, not an error. The client may
    // retry on a dropped response, and a second solve in one day is an ordinary
    // thing for a player to attempt — neither deserves a thrown callable.
    if (!canClaimMinigame(ledger, dayKey)) {
      return { ok: true, granted: 0, alreadyClaimed: true, dayKey };
    }

    // Same sponge ledger the shop, the daily gift and task rewards write.
    tx.set(
      db.doc(`users/${uid}/profile/data`),
      { spongeBalance: FieldValue.increment(MINIGAME_REWARD.sponges) },
      { merge: true },
    );
    // date AND claimed together: `date` alone would make yesterday's row look
    // like today's claim, and `claimed` alone would lock the player out forever.
    tx.set(ledgerRef, { date: dayKey, claimed: true }, { merge: true });

    return {
      ok: true,
      granted: MINIGAME_REWARD.sponges,
      alreadyClaimed: false,
      dayKey,
    };
  });
});

// ---------------------------------------------------------------------------
// submitGalleryFeedback — callable
// Input: { specimenKey, appVersion, lassos: [{rect, colourIndex, comment}] }
// ---------------------------------------------------------------------------
//
// W2-23. A tester's lassoed comments on one gallery screen.
//
// WARNING: THIS IS THE ONLY CALLABLE WHOSE PURPOSE IS ACCEPTING ARBITRARY TEXT FROM A
// STRANGER. It grants nothing, so there is no replay key and no transaction —
// two identical submissions are a tester tapping twice, which is noise rather
// than theft, and de-duplicating them would silently discard a real second
// comment. What bounds it is in galleryFeedback.ts, including what does not.
export const submitGalleryFeedback = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Not signed in');

  const verdict = validateSubmission(request.data);
  if (!verdict.ok) {
    // The reason is returned to the caller on purpose: a client author
    // debugging a rejected lasso should not have to read the source.
    throw new HttpsError('invalid-argument', verdict.reason ?? 'invalid submission');
  }
  const submission = request.data as FeedbackSubmission;

  // KEY: THE PER-DAY CAP REUSES THE inviteCounts PATTERN EXACTLY (index.ts:1744):
  // a per-day counter document read and incremented inside ONE transaction, and
  // a `resource-exhausted` refusal naming the limit. Inventing a second
  // rate-limiting shape here would be the same mistake as inventing a second
  // admin model — and this one already exists three lines of thought away.
  //
  // WARNING: A transaction on a path that "should be cheap" is affordable HERE and
  // would not be everywhere: this fires when a human taps send after typing a
  // sentence, not on a hot loop. The gift-invite path already pays the same
  // cost for the same reason.
  const today = new Date().toISOString().split('T')[0];
  const countRef = db.doc(`users/${uid}/feedbackCounts/${today}`);

  const ref = db.collection('galleryFeedback').doc();
  const usedAfter = await db.runTransaction(async (tx) => {
    const countSnap = await tx.get(countRef);
    // A counter from a previous day is stale, not a count — the same reasoning
    // as grantTaskRewards and the mini-game ledger. Reading it as today's would
    // lock a tester out permanently after one busy day.
    const data = countSnap.data();
    const used: number = data?.date === today ? (data?.count ?? 0) : 0;

    if (used >= MAX_SUBMISSIONS_PER_DAY) {
      // CRITICAL: THE TESTER IS TOLD, NOT SILENTLY DROPPED. A feedback tool that
      // swallows the sentence someone typed is worse than one that refuses it,
      // and the refusal has to be legible enough that they keep the words and
      // try tomorrow rather than assume the app is broken.
      throw new HttpsError(
        'resource-exhausted',
        `Daily feedback limit of ${MAX_SUBMISSIONS_PER_DAY} submissions reached. ` +
          'Nothing was saved for this one — copy your notes somewhere safe and ' +
          'send them tomorrow, or tell Brendan if you genuinely hit this by hand.',
      );
    }

    tx.set(ref, {
      uid,
      specimenKey: submission.specimenKey,
      appVersion: submission.appVersion,
      lassos: submission.lassos,
      submittedAt: Timestamp.now(),
    });
    // date AND count together: `count` alone would carry yesterday's total into
    // today, and `date` alone would never bound anything.
    tx.set(countRef, {date: today, count: used + 1}, {merge: true});
    return used + 1;
  });

  return {
    ok: true,
    id: ref.id,
    lassoCount: submission.lassos.length,
    // WARNING: The REAL remainder, computed inside the transaction. Returning the
    // constant here would be a payload that always says "plenty left" right up
    // to the refusal — a field that lies is worse than no field, and the client
    // is meant to warn BEFORE the wall rather than at it.
    submissionsRemainingToday: MAX_SUBMISSIONS_PER_DAY - usedAfter,
  };
});

// ---------------------------------------------------------------------------
// exportGalleryFeedback — HTTP POST, admin only
// ---------------------------------------------------------------------------
//
// Returns every tester's feedback as text a person reads top to bottom.
//
// CRITICAL: IT WAS A CALLABLE AND THAT WAS A DATA DISCLOSURE (W2-23's own unanswered
// #1). Any signed-in user could read every other tester's comments. Fine for a
// cohort Brendan picked by hand; wrong the first time a stranger installs the
// app, and "we will add an admin check later" is the sentence that precedes
// every one of these.
//
// KEY: NO NEW ADMIN MODEL WAS INVENTED, BECAUSE ONE ALREADY EXISTS. This now uses
// the SAME gate as backfillPublicProfiles and seedShopData: POST-only, a shared
// SEED_SECRET in an `x-seed-secret` header, failing closed when the secret is
// unset. A custom claim would have been a second admin mechanism guarding one
// more thing than the first — and it would need somebody to set a claim nobody
// has set, on a project this window cannot reach.
//
// NOTE: AND HTTP IS THE RIGHT SHAPE ANYWAY, WHICH IS WHY THIS IS NOT A WORKAROUND.
// The consumer is a human with a terminal reading what testers wrote, not the
// shipped app — nothing in lib/ should ever call it. A callable implies the app
// invokes it; an HTTP endpoint returning text/plain is `curl | less`.
export const exportGalleryFeedback = onRequest(FEEDBACK_OPTS, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // WARNING: THE TWO 403s ARE DELIBERATELY DIFFERENT, and this is the one place this
  // endpoint improves on the two it copies. SEED_OPTS' own docstring records
  // what happened last time: both endpoints were declared as bare `onRequest`,
  // the secret never reached the runtime, `process.env.SEED_SECRET` stayed
  // undefined, and every request 403'd forever — "which reads as a wrong secret
  // rather than an unbound one". That cost real time. An unset secret and a
  // wrong one are different problems with different fixes, so they say so.
  //
  // Neither message leaks the secret; they name the FAILURE, not the value.
  // KEY: FEEDBACK_EXPORT_SECRET, not SEED_SECRET — see FEEDBACK_OPTS. Each
  // refusal names WHICH secret it means, because two secrets make "the secret
  // is wrong" an ambiguous sentence and the person reading it is holding one of
  // them wondering which.
  const expectedSecret = process.env.FEEDBACK_EXPORT_SECRET;
  if (!expectedSecret) {
    res
      .status(403)
      .send(
        'Forbidden — FEEDBACK_EXPORT_SECRET is not bound on this deployment, so ' +
          'no header can match. This is a server configuration problem, not a ' +
          'wrong secret, and it is NOT the same secret as SEED_SECRET. Bind it ' +
          'with `firebase functions:secrets:set FEEDBACK_EXPORT_SECRET` AND ' +
          'redeploy exportGalleryFeedback, or provide it via a .env locally.\n',
      );
    return;
  }
  if (req.get('x-feedback-secret') !== expectedSecret) {
    res
      .status(403)
      .send(
        'Forbidden — the x-feedback-secret header is missing or does not match. ' +
          'Note this endpoint no longer accepts x-seed-secret. Call it with: ' +
          'curl -X POST -H "x-feedback-secret: $FEEDBACK_EXPORT_SECRET" <url>\n',
      );
    return;
  }

  const snap = await db.collection('galleryFeedback').orderBy('specimenKey').get();
  const records: FeedbackRecord[] = snap.docs.map((d) => {
    const data = d.data();
    const submittedAt = data.submittedAt;
    return {
      uid: typeof data.uid === 'string' ? data.uid : 'unknown',
      specimenKey: typeof data.specimenKey === 'string' ? data.specimenKey : 'unknown',
      appVersion: typeof data.appVersion === 'string' ? data.appVersion : 'unknown',
      lassos: Array.isArray(data.lassos) ? data.lassos : [],
      submittedAtIso:
        typeof submittedAt?.toDate === 'function'
          ? submittedAt.toDate().toISOString()
          : 'unknown',
    };
  });

  // text/plain, not JSON: the whole point is that a person reads it.
  res.status(200).type('text/plain').send(formatFeedbackReport(records));
});

/** Marks an inventory row as having arrived from a quest rather than a purchase. */
/**
 * Every itemId the grant path could resolve.
 *
 * Built once from the bundled pool. `verifyIapAndGrant` writes an inventory row
 * for any string it is handed, so this is the set an offer's contents must fall
 * inside — checked at WRITE time, never at grant time.
 */
const SEED_ITEM_IDS: ReadonlySet<string> = new Set(SEED_ITEMS.map((i) => i.id));

const QUEST_SOURCE = 'quest';

/**
 * Server-only. Advances quest progress for [uid] from the tasks completed on
 * [dayKey], persists it to `users/{uid}/quests/state`, and grants any rewards
 * that just came due.
 *
 * KEY: Progress is accumulated forward into quest state, but it is now derived
 * from the DURABLE COMPLETION LOG unioned with the task documents' current
 * flags — see completionLog.ts. A completion is a fact with a timestamp, so
 * un-completing cannot walk progress backwards (D94-4), and the log is the
 * history a recompute would need (D92). This function is the only writer of
 * quest state and of the completion log.
 *
 * WARNING: Reads the user's whole tasks collection, because a SWEEP quest needs to
 * know how many tasks EXIST in a room, not merely how many were completed. That
 * is one extra full read per completion; a user's task collection is tens of
 * documents, not thousands. If it ever stops being small, cache the per-room
 * census rather than dropping the guard — `total === 0` is what stops a player
 * with no bathroom tasks completing Bathroom Warrior by doing nothing.
 */
async function applyQuestProgress(
  uid: string,
  dayKey: string,
  bonusTaskId: string | null,
): Promise<QuestPayout[]> {
  const stateRef = db.doc(`users/${uid}/quests/state`);
  const tasksSnap = await db.collection(`users/${uid}/tasks`).get();

  const roomTaskCounts: Record<string, number> = {};
  const currentlyComplete: CompletedTask[] = [];
  for (const doc of tasksSnap.docs) {
    const data = doc.data();
    const room = typeof data.room === 'string' ? data.room : '';
    roomTaskCounts[room] = (roomTaskCounts[room] ?? 0) + 1;
    if (data.completedDate === dayKey) {
      currentlyComplete.push({
        id: doc.id,
        room,
        title: typeof data.title === 'string' ? data.title : '',
      });
    }
  }

  // The durable log for TODAY. Filtered on dayKey, so this read is O(tasks
  // completed today) and does not grow with history — see completionLog.ts.
  const logRef = db.collection(`users/${uid}/completions`);
  const logSnap = await logRef.where('dayKey', '==', dayKey).get();
  const logged: CompletionRecord[] = logSnap.docs.map((d) => d.data() as CompletionRecord);
  const loggedIds = new Set(logSnap.docs.map((d) => d.id));

  // CRITICAL: THE UNION IS THE FIX for D94-4. The log cannot be retracted, so
  // un-completing a task does not remove it from today's set and re-completing
  // it adds nothing. Progress can only move forward.
  const completedToday = mergeCompletions(logged, currentlyComplete);

  // New completions become durable records. Un-completion writes NOTHING — it
  // is the absence of an event, not an event, and a retraction record would
  // reintroduce the retractability this whole change removes.
  const toLog = unloggedCompletions(loggedIds, currentlyComplete, dayKey);
  if (toLog.length > 0) {
    const batch = db.batch();
    for (const task of toLog) {
      batch.set(logRef.doc(completionDocId(dayKey, task.id)), {
        taskId: task.id,
        room: task.room,
        // Recorded at completion time on purpose: a later rename cannot rewrite
        // what the task was called when it was done. D93 is still open, but this
        // is the input its migration would need.
        title: task.title,
        dayKey,
        // KEY: The room's census AS OF THIS COMPLETION (W2-14). A sweep is a
        // ratio, and this is its denominator — the only part of a sweep that
        // cannot be reconstructed afterwards, because a room's task list
        // changes and nothing records what it used to be.
        //
        // NOTE: COSTS NOTHING EXTRA. roomTaskCounts is already built above from the
        // full tasks scan this function makes for sweep evaluation, so writing
        // it adds no read and no query — one integer per record.
        roomTaskCount: roomTaskCounts[task.room] ?? 0,
        // KEY: Which task paid double, frozen at write time (W2-16).
        // bonusTaskIdFor indexes into a mutable list, so recomputing this later
        // gives the answer for TODAY's library, not the library as it was. The
        // id comes from `granted` — what the PAYER actually used — rather than
        // being recomputed here, so the log records the decision that was made
        // rather than one made again beside it.
        //
        // WARNING: `bonusPaid` is DELIBERATELY NOT RECORDED. It is mutable within the
        // day (the bonus can pay on a later call than the one that first logged
        // the task) and this record is write-once by id, so a snapshot of it
        // would freeze a `false` that later became true — authoritative-looking
        // and wrong. Whether the bonus was PAID stays underivable; whether the
        // task WAS the bonus is now permanent. See the return for that line.
        wasBonusTask: bonusTaskId != null && task.id === bonusTaskId,
        loggedAt: Timestamp.now(),
      });
    }
    await batch.commit();
  }

  // Dry run, OUTSIDE the transaction, purely to learn which chests to draw.
  // pickChestItem runs a collection query against `items`, and the draw must be
  // resolved before the transaction opens. Nothing is written here, so a dry run
  // that the transaction later disagrees with costs one discarded draw and
  // never a spurious grant.
  const priorSnap = await stateRef.get();
  const dryRun = evaluateQuests(
    (priorSnap.data()?.quests ?? {}) as QuestStateMap,
    completedToday,
    dayKey,
    roomTaskCounts,
  );

  const chestPicks: Record<string, ChestItemPick> = {};
  for (const payout of dryRun.payouts) {
    if (payout.reward.kind !== 'chest' || !payout.reward.chestCategory) continue;
    const category = payout.reward.chestCategory;
    // KEY: The SAME roll the shop uses. A second way to receive a chest is a
    // second way to be wrong about the odds, and chest_drop_rates.dart is
    // already a hand-maintained mirror with no cross-language test.
    const itemRarity = rollRarity(CHEST_CATEGORY_DROP_TABLE[category]);
    const subject = subjectForDay(category, dayKey.replace(/-/g, ''));
    chestPicks[`${payout.questId}:${payout.threshold}`] =
      await pickChestItem(subject, itemRarity);
  }

  // The authoritative pass. State is re-read inside the transaction and
  // re-evaluated from that fresh prior, so two completions racing each other
  // cannot both pay the same tier — `claimedTiers` is the guard and it is only
  // ever read and written under the lock.
  return db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(stateRef);

    // Ownership of every DRAWN pick, read here because Firestore requires all
    // reads before all writes and the grant loop below is a write. Reading the
    // whole draw rather than only the granted subset keeps this above the first
    // write without depending on `granted`, which is computed further down.
    const questItemOwned = new Set<string>();
    for (const pick of Object.values(chestPicks)) {
      if ((await tx.get(db.doc(`users/${uid}/inventory/${pick.itemId}`))).exists) {
        questItemOwned.add(pick.itemId);
      }
    }

    const {state, payouts} = evaluateQuests(
      (freshSnap.data()?.quests ?? {}) as QuestStateMap,
      completedToday,
      dayKey,
      roomTaskCounts,
    );

    // A chest tier the dry run did not predict has no drawn item. Rather than
    // grant nothing and still mark it claimed — which would silently eat the
    // reward forever — UNCLAIM it, so the next completion draws and pays it.
    // The evaluator is pure and re-derives the same tier from the same state,
    // so this converges rather than looping.
    const undrawn = payouts.filter(
      (p) => p.reward.kind === 'chest' && !chestPicks[`${p.questId}:${p.threshold}`],
    );
    for (const p of undrawn) {
      const progress = state[p.questId];
      if (progress) {
        progress.claimedTiers = progress.claimedTiers.filter((t) => t !== p.threshold);
      }
    }
    const granted = payouts.filter((p) => !undrawn.includes(p));

    tx.set(
      stateRef,
      {quests: state, updatedAt: Timestamp.now()},
      {merge: true},
    );

    // KEY: A QUEST CHEST HAS NO PURCHASE PRICE, so its duplicate pays 75% of the
    // LIST price of the category the quest awarded — the same fraction the
    // purchase path pays against the price actually charged. Before W2-161 a
    // duplicate here paid nothing at all: the grant was written over the top of
    // the item the player already had and the tier was marked claimed, so the
    // reward evaporated silently. Paying it is the other half of not writing it.
    const duplicateRefunds = sumDuplicateRefunds(
      granted.map((p) => ({
        category: p.reward.kind === 'chest' ? p.reward.chestCategory : undefined,
        itemId: chestPicks[`${p.questId}:${p.threshold}`]?.itemId,
      })),
      questItemOwned,
    );

    const totalSponges = granted.reduce((sum, p) => sum + p.sponges, 0) + duplicateRefunds;
    const totalXp = granted.reduce((sum, p) => sum + p.xp, 0);

    // Sponges and XP land on the SAME document, so they are one write.
    //
    // KEY: XP IS WRITTEN HERE RATHER THAN VIA awardXp(), AND THAT IS NOT A SECOND
    // XP PATH. awardXp is deliberately non-transactional; calling it from inside
    // this transaction would put the XP outside the lock that `claimedTiers`
    // lives under, so a tier could be marked claimed while its XP was lost. For
    // sponges that would be a balance bug; for XP it is a PROGRESSION bug, and
    // permanent progression cannot be walked back. So the write is transactional
    // and it names xpDocPath/XP_FIELD — the same constants awardXp itself uses,
    // so there remains exactly one definition of where XP lives.
    const profileWrite: Record<string, unknown> = {};
    if (totalSponges > 0) {
      // increment(0) is skipped rather than written, so the balance never
      // records a credit of nothing.
      profileWrite.spongeBalance = FieldValue.increment(totalSponges);
    }
    if (totalXp > 0) {
      profileWrite[XP_FIELD] = FieldValue.increment(totalXp);
    }
    if (Object.keys(profileWrite).length > 0) {
      tx.set(db.doc(xpDocPath(uid)), profileWrite, {merge: true});
    }

    for (const payout of granted) {
      if (payout.reward.kind !== 'chest') continue;
      const pick = chestPicks[`${payout.questId}:${payout.threshold}`];
      // CRITICAL: Same replace-bug as the daily gift, same fix: an already-owned item
      // gets NO write, rather than a `merge` that would still reset `ownedAt`.
      if (questItemOwned.has(pick.itemId)) continue;
      tx.set(db.doc(`users/${uid}/inventory/${pick.itemId}`), {
        itemId: pick.itemId,
        ownedAt: Timestamp.now(),
        equipped: false,
        source: QUEST_SOURCE,
      });
    }

    return granted;
  });
}

export const recordTaskCompletion = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Not signed in');
  const { clientNowIso } = request.data as { clientNowIso: string };
  if (!clientNowIso) throw new HttpsError('invalid-argument', 'clientNowIso required');

  // CRITICAL: THE DAY KEY IS BOUNDED BEFORE ANYTHING ELSE HAPPENS (W2-174).
  //
  // This line used to be `clientNowIso.slice(0, 10)` two hundred lines further
  // down, which meant THE CALLER CHOSE WHICH DAY IT WAS BEING PAID FOR, and every
  // counter in grantTaskRewards resets when that key changes. Alternating two
  // well-formed dates re-minted the day's pay: measured at 15 sponges against a
  // free cap of 5, one account, three calls.
  //
  // It is FIRST, and pure, so a refused key costs the caller nothing at all —
  // no streak write, no ledger write, nothing partially applied. The day
  // boundary itself is unchanged: still the client's own local calendar date,
  // still NOT streakDate()'s 4 AM cutoff, because it has to match the
  // `completedDate` the client stamps on task documents. See the block comment
  // in taskRewards.ts for why deriving it from server UTC instead would stop
  // paying honest players across most of the world.
  const dayKey = boundedDayKey(clientNowIso, Date.now());

  const userRef = db.doc(`users/${uid}`);
  const streakRef = db.doc(`users/${uid}/streak/main`);
  const clientNow = parseNaiveDate(clientNowIso);
  const today = streakDate(clientNow);

  // Rewards are per-task, not per-streak-day. `dayAdvanced` gates the STREAK
  // only; it used to gate XP too, which meant the second task of a day earned
  // nothing. grantTaskRewards carries its own idempotency (a per-day ledger of
  // how many completions have been paid for), so replays are safe without
  // borrowing the streak's gap == 0 guard.
  const granted = await grantTaskRewards(uid, dayKey);

  // The transaction reports whether the streak-day advanced so the XP award
  // below reuses the same gap == 0 guard (no double-award on same-day replay).
  //
  // NOTE: IT RUNS SECOND NOW, AFTER grantTaskRewards, AND THE ORDER IS LOAD-BEARING
  // (W2-174). The reward grant is the step that can REFUSE — a day key earlier
  // than the account's high-water mark throws `failed-precondition` — and with
  // the streak in front of it that throw landed after the streak had already
  // been reset by the same backwards date. The call was refused AND the player
  // lost their streak. Nothing here depends on the rewards and nothing there
  // depends on the streak, so running the refusable step first makes every
  // rejection write-free. `taskCompletionEmulator.test.ts` asserts exactly that.
  const dayAdvanced = await db.runTransaction(async (tx) => {
    const [streakSnap, userSnap] = await Promise.all([tx.get(streakRef), tx.get(userRef)]);
    const shields: number = userSnap.data()?.streakShields ?? 0;

    if (!streakSnap.exists) {
      // First ever completion — create the streak doc.
      tx.set(streakRef, {
        habitId: 'main',
        currentStreak: 1,
        longestStreak: 1,
        lastCompletionDate: clientNowIso,
        streakStartDate: toNaiveIso(today),
        isBroken: false,
        awardedMilestones: [],
      });
      return true;
    }

    const data = streakSnap.data()!;
    const last = streakDate(parseNaiveDate(data.lastCompletionDate));
    const gapDays = Math.round((today.getTime() - last.getTime()) / 86400000);

    if (gapDays === 0) return false; // same streak-day — idempotent no-op

    let newStreak: number;
    let newStart: string;
    let broken: boolean;

    if (gapDays === 1) {
      // Consecutive day — extend the streak.
      newStreak = (data.currentStreak ?? 0) + 1;
      newStart = data.streakStartDate;
      broken = false;
    } else if (shields > 0) {
      // Gap > 1 but a shield covers it — burn one, keep the streak alive.
      tx.set(userRef, { streakShields: FieldValue.increment(-1) }, { merge: true });
      newStreak = (data.currentStreak ?? 0) + 1;
      newStart = data.streakStartDate;
      broken = false;
    } else {
      // Gap > 1 and no shields — reset.
      newStreak = 1;
      newStart = toNaiveIso(today);
      broken = true;
    }

    tx.set(streakRef, {
      currentStreak: newStreak,
      longestStreak: Math.max(newStreak, data.longestStreak ?? 0),
      lastCompletionDate: clientNowIso, // naive format preserved
      streakStartDate: newStart,
      isBroken: broken,
    }, { merge: true });
    return true;
  });


  // Quests are evaluated AFTER task rewards and outside their transaction: they
  // are additive, and a quest evaluator throwing must not cost the player the
  // sponges they already earned for the task itself.
  let questPayouts: QuestPayout[] = [];
  try {
    questPayouts = await applyQuestProgress(uid, dayKey, granted.bonusTaskId);
  } catch (err) {
    console.error('recordTaskCompletion: quest evaluation failed', err);
  }

  // Returned for the reward moment. The client currently animates the deltas
  // off the spongeBalance/totalXp streams rather than off this payload, so
  // these fields are additive and need no client change — they exist so the
  // moment can stop guessing once W1 picks them up.
  return { ok: true, granted, streakAdvanced: dayAdvanced, questPayouts };
});

// ---------------------------------------------------------------------------
// resolveStreak — callable (Streak feature)
// Input: { clientNowIso: string }
// Called on app/StreakPage open WITHOUT a completion. Detects missed days and
// either burns shields to re-anchor the streak to "yesterday" (so the next
// completion sees gap == 1) or breaks it when shields can't cover the gap.
// Returns: { changed, shieldConsumed?, currentStreak?, shields? }
// ---------------------------------------------------------------------------

export const resolveStreak = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Not signed in');
  const { clientNowIso } = request.data as { clientNowIso: string };
  if (!clientNowIso) throw new HttpsError('invalid-argument', 'clientNowIso required');

  const userRef = db.doc(`users/${uid}`);
  const streakRef = db.doc(`users/${uid}/streak/main`);
  const clientNow = parseNaiveDate(clientNowIso);
  const today = streakDate(clientNow);

  return db.runTransaction(async (tx) => {
    const [streakSnap, userSnap] = await Promise.all([tx.get(streakRef), tx.get(userRef)]);
    const shields: number = userSnap.data()?.streakShields ?? 0;

    if (!streakSnap.exists) return { changed: false };
    const data = streakSnap.data()!;
    if ((data.currentStreak ?? 0) === 0 || data.isBroken) return { changed: false };

    const last = streakDate(parseNaiveDate(data.lastCompletionDate));
    const gapDays = Math.round((today.getTime() - last.getTime()) / 86400000);
    if (gapDays <= 1) return { changed: false }; // still active — no-op

    const missedDays = gapDays - 1;
    if (missedDays <= shields) {
      // Shields cover all missed days — re-anchor to "yesterday" so the next
      // completion sees gap == 1. yesterdayMidnight + 20h = yesterday 8 PM,
      // whose streakDate (floor(8PM - 4h)) is yesterday.
      const yesterdayMidnight = new Date(today.getTime() - 86400000);
      const reAnchor = new Date(yesterdayMidnight.getTime() + 20 * 3600000);
      tx.set(userRef, { streakShields: FieldValue.increment(-missedDays) }, { merge: true });
      tx.set(streakRef, {
        lastCompletionDate: toNaiveIso(reAnchor),
        isBroken: false,
      }, { merge: true });
      return {
        changed: true,
        shieldConsumed: missedDays,
        currentStreak: data.currentStreak,
        shields: shields - missedDays,
      };
    }

    // Not enough shields — break the streak.
    tx.set(streakRef, { currentStreak: 0, isBroken: true }, { merge: true });
    return { changed: true, shieldConsumed: 0, currentStreak: 0, shields };
  });
});

// ---------------------------------------------------------------------------
// awardStreakReward — callable (Streak feature)
// Input: { rewardId: string } — must be a key of STREAK_MILESTONES.
// Pays a milestone's sponge reward once the best (current or longest) streak
// meets its threshold. Idempotent per milestone via awardedMilestones; writes a
// rewardHistory entry. spongeBalance and the milestone flag are mutated in one
// transaction so a payout can never commit without recording the claim.
// Returns: { rewardId, sponges, label }
// ---------------------------------------------------------------------------

export const awardStreakReward = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Not signed in');
  const { rewardId } = request.data as { rewardId: string };
  const milestone = STREAK_MILESTONES[rewardId];
  if (!milestone) throw new HttpsError('invalid-argument', `Unknown rewardId: ${rewardId}`);

  const streakRef = db.doc(`users/${uid}/streak/main`);
  const profileRef = db.doc(`users/${uid}/profile/data`);
  const rewardHistoryRef = db.collection(`users/${uid}/rewardHistory`).doc();

  return db.runTransaction(async (tx) => {
    const streakSnap = await tx.get(streakRef);
    if (!streakSnap.exists) throw new HttpsError('not-found', 'No streak found');
    const data = streakSnap.data()!;

    const best = Math.max(data.currentStreak ?? 0, data.longestStreak ?? 0);
    if (best < milestone.threshold) {
      throw new HttpsError('failed-precondition', `Streak ${best} < required ${milestone.threshold}`);
    }
    const awarded: string[] = data.awardedMilestones ?? [];
    if (awarded.includes(rewardId)) {
      throw new HttpsError('already-exists', `Milestone ${rewardId} already claimed`);
    }

    tx.set(profileRef, { spongeBalance: FieldValue.increment(milestone.payout) }, { merge: true });
    tx.set(streakRef, { awardedMilestones: FieldValue.arrayUnion(rewardId) }, { merge: true });
    tx.set(rewardHistoryRef, {
      type: 'streak_milestone',
      label: milestone.label,
      sponges: milestone.payout,
      timestamp: Timestamp.now(),
    });

    return { rewardId, sponges: milestone.payout, label: milestone.label };
  });
});

// ---------------------------------------------------------------------------
// mintHousemateToken / redeemHousemateToken — W4-36, Phase 1
// ---------------------------------------------------------------------------
//
// The first server-side enforcement of housemate status in this codebase.
// Everything else about housemates lives in firestore.rules, and the reasons a
// rule cannot carry THIS are written out at the top of housemateToken.ts —
// short version: rules can expire a value and can compare-and-set within ONE
// document, but redemption is inherently two documents (spend the token, write
// the roster) and no rule can require that the second write accompanied the
// first.
//
// WARNING: Admin SDK writes BYPASS firestore.rules, so housemateCap() does not gate
// this path at all. The cap below is the gate; the rules remain the gate on the
// client-written ask/accept path, which is untouched.

/**
 * Mints a short-lived, single-use code the caller can show to someone standing
 * next to them.
 *
 * Input:  {} — the caller's uid is the host.
 * Output: { code, expiresAtMs, ttlSeconds }
 */
/**
 * What a housemate may see of another account — currently their equipped skins.
 *
 * Input:  { hostUid }
 * Output: { hostUid, equippedSkinIds }
 *
 * KEY: EXISTS BECAUSE THERE WAS NOWHERE TO PROJECT. The friend-visit payload is
 * assembled on the CLIENT (`friends_repository_impl.getFriendVisit`), reading
 * documents directly under rules — so the only ways to put equipped skins in
 * front of a visitor were to widen `users/{uid}/inventory` in the rules, or to
 * build a place where fields can be dropped. `inventory` is owner-only and
 * stays that way; this is that place. See housemateView.ts.
 *
 * WARNING: ADMIN SDK READS BYPASS RULES, so the gate here IS the security boundary,
 * not a convenience. `mayViewHousemateData` re-expresses `canViewHouse` from
 * firestore.rules over the same roster field, through the same exported
 * `rosterOf` helper — friendship alone is not enough.
 *
 * NOTE: The response is built by `projectHousemateView`, key by key, so a field
 * added to `users/{uid}/inventory` later cannot arrive here by being copied.
 */
export const getHousemateView = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const guestUid = request.auth.uid;
  const hostUid = (request.data ?? {}).hostUid;
  if (typeof hostUid !== 'string' || !hostUid) {
    throw new HttpsError('invalid-argument', 'hostUid is required.');
  }

  const [hostSnap, edgeSnap, guestSnap] = await Promise.all([
    db.doc(`users/${hostUid}`).get(),
    db.doc(`users/${hostUid}/friends/${guestUid}`).get(),
    db.doc(`users/${guestUid}`).get(),
  ]);

  // W2-111. The guest's family is the second source of access, and it is
  // resolved in two hops exactly as the rules do it: the pointer only names
  // the document, and `memberUids` on that document decides. Fetched only
  // when the pointer is a non-empty string — `applyFamilyDeparture` writes
  // `familyId: null` rather than deleting the key, so the common case for a
  // former member is a present field with a null in it.
  const guestFamilyId = guestSnap.data()?.familyId;
  const familySnap = typeof guestFamilyId === 'string' && guestFamilyId
    ? await db.doc(`families/${guestFamilyId}`).get()
    : null;

  const allowed = mayViewHousemateData({
    hostUid,
    guestUid,
    hostUserData: hostSnap.data(),
    friendshipAccepted: edgeSnap.data()?.status === 'accepted',
    guestFamilyMemberUids: familyRosterOf(familySnap?.data()),
  });
  if (!allowed) {
    // Same wording as the client's PermissionDeniedException for a denied
    // layout read: "not let in" is an ordinary state, not a fault.
    throw new HttpsError(
      'permission-denied',
      'This friend has not shared their home with you yet.',
    );
  }

  const inventory = await db.collection(`users/${hostUid}/inventory`).get();
  return projectHousemateView({
    hostUid,
    equippedSkinIds: equippedSkinIdsFrom(
      inventory.docs.map((d) => ({ id: d.id, data: d.data() })),
    ),
  });
});

export const mintHousemateToken = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const hostUid = request.auth.uid;

  // The house has to have room BEFORE a code is shown, so the pair are not sent
  // to stand next to each other for a refusal. Advisory only — the real check
  // runs inside the redemption transaction, because a roster can fill in the 45
  // seconds between the two.
  const hostSnap = await db.doc(`users/${hostUid}`).get();
  const hostRoster = rosterOf(hostSnap.data());
  if (hostRoster.length >= HOUSEMATE_CAP) {
    throw new HttpsError(
      'resource-exhausted',
      `A household holds ${HOUSEMATE_CAP} people. Remove someone first.`,
    );
  }

  const nowMs = Date.now();
  const expiresAtMs = nowMs + HOUSEMATE_TOKEN_TTL_SECONDS * 1000;

  // `create()` rather than `set()`: the code IS the document id, so a collision
  // must fail loudly rather than overwrite somebody else's live token with a
  // different host on it. At 50 bits this effectively never fires; the retry
  // exists so that when it does, nothing silently mis-attributes a house.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateHousemateTokenCode();
    try {
      await db.doc(`housemateTokens/${code}`).create({
        hostUid,
        createdAtMs: nowMs,
        expiresAtMs,
      });
      return { code, expiresAtMs, ttlSeconds: HOUSEMATE_TOKEN_TTL_SECONDS };
    } catch (e) {
      const code6 = (e as { code?: number | string }).code;
      // ALREADY_EXISTS is 6 in gRPC. Anything else is a real failure and must
      // not be retried into a loop that hides it.
      if (code6 !== 6 && code6 !== 'already-exists') throw e;
    }
  }
  throw new HttpsError('internal', 'Could not mint a code. Try again.');
});

/**
 * Spends a code and writes the housemate edge, in one transaction.
 *
 * Input:  { code }
 * Output: { hostUid, housemateCount }
 *
 * CRITICAL: THE TRANSACTION IS THE SINGLE-USE MECHANISM. A read-then-write outside one
 * is a race two phones in one room will actually hit — both see redeemedAtMs
 * absent, both write the edge, and the code has been used twice. Firestore
 * transactions are optimistic-locked on every document READ inside them, so the
 * loser re-runs, re-reads a token that now carries redeemedAtMs, and is refused
 * by evaluateRedemption. The token document is read first for exactly that
 * reason: it is the contended one.
 */
export const redeemHousemateToken = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const guestUid = request.auth.uid;

  const code: unknown = request.data?.code;
  if (!isValidHousemateTokenCode(code)) {
    // Refused before any read: the code becomes a document id, and a string
    // outside the minted alphabet was never minted here.
    throw new HttpsError('invalid-argument', 'That code is not valid. Ask for a fresh one.');
  }

  const nowMs = Date.now();
  const tokenRef = db.doc(`housemateTokens/${code}`);

  return db.runTransaction(async (tx) => {
    const tokenSnap = await tx.get(tokenRef);
    const token = tokenSnap.exists
      ? (tokenSnap.data() as HousemateTokenDoc)
      : null;

    const verdict = evaluateRedemption(token, guestUid, nowMs);
    if (!verdict.ok) throw new HttpsError(verdict.code, verdict.reason);
    const hostUid = verdict.hostUid;

    // Friendship is a precondition rather than a nicety: canViewHouse() is
    // `isFriend() && roster.hasAny(...)`, so a roster entry without an accepted
    // edge grants nothing. Writing one would leave a row that looks like access
    // and is not — worse than a refusal, which at least says what to do.
    const [hostEdge, guestEdge] = await Promise.all([
      tx.get(db.doc(`users/${hostUid}/friends/${guestUid}`)),
      tx.get(db.doc(`users/${guestUid}/friends/${hostUid}`)),
    ]);
    if (
      hostEdge.data()?.status !== 'accepted' ||
      guestEdge.data()?.status !== 'accepted'
    ) {
      throw new HttpsError(
        'failed-precondition',
        'You need to be friends before you can move in together.',
      );
    }

    const hostRef = db.doc(`users/${hostUid}`);
    const guestRef = db.doc(`users/${guestUid}`);
    const [hostSnap, guestSnap] = await Promise.all([tx.get(hostRef), tx.get(guestRef)]);

    // Both sides evaluated before either is written — see the header of
    // housemateToken.ts on why the grant is mutual. A full house on EITHER side
    // refuses the whole redemption; half a grant is a state no screen can
    // describe.
    const hostAfter = appendHousemate(rosterOf(hostSnap.data()), guestUid);
    if (!hostAfter.ok) throw new HttpsError(hostAfter.code, hostAfter.reason);
    const guestAfter = appendHousemate(rosterOf(guestSnap.data()), hostUid);
    if (!guestAfter.ok) {
      throw new HttpsError(
        guestAfter.code,
        'Their household is full. They need to remove someone first.',
      );
    }

    // The spend and both grants commit together or not at all.
    tx.set(tokenRef, { redeemedAtMs: nowMs, redeemedByUid: guestUid }, { merge: true });
    tx.set(hostRef, { housemates: hostAfter.roster }, { merge: true });
    tx.set(guestRef, { housemates: guestAfter.roster }, { merge: true });

    return { hostUid, housemateCount: guestAfter.roster.length };
  });
});

/**
 * Apply a departure plan: rewrite the roster, revoke every departing grant, and
 * clear their familyId — all in one transaction.
 *
 * KEY: SHARED BY ALL THREE CALLABLES ON PURPOSE. leaveFamily, removeMember and
 * disbandFamily differ ONLY in who is allowed to ask; the effect is identical,
 * and a second copy of "revoke and unstamp" is the copy that would forget one
 * of the two writes.
 */
function applyFamilyDeparture(
  tx: admin.firestore.Transaction,
  familyRef: admin.firestore.DocumentReference,
  plan: Extract<FamilyDeparturePlan, {ok: true}>,
): void {
  if (plan.noop) return;

  if (plan.dissolved) {
    tx.delete(familyRef);
  } else {
    tx.update(familyRef, {
      memberUids: plan.memberUids,
      memberNames: plan.memberNames,
      memberAvatars: plan.memberAvatars,
    });
  }

  for (const uid of plan.revokedUids) {
    // CRITICAL: BOTH FIELDS, IN THE SAME WRITE. `familyProExpiresAt: null` ends the
    // entitlement — without it a leaver keeps Pro until the copied expiry runs
    // out — and `familyId: null` unstamps them so no family read still finds
    // them. Clearing one without the other leaves either a grant nobody funds
    // or a pointer at a family that does not hold them.
    tx.set(
      db.doc(`users/${uid}`),
      {familyProExpiresAt: null, familyId: null},
      {merge: true},
    );
  }
}

/**
 * Leave the family you are in.
 *
 * WARNING: IDEMPOTENT: leaving a family you are not in SUCCEEDS and writes nothing.
 * The caller asked for an end state and it already holds; an error here would
 * say their first attempt failed.
 *
 * CRITICAL: AN OWNER IS REFUSED WITH `owner-must-disband`, which names the alternative.
 * See the block above `planFamilyDeparture` for why dissolving is the right
 * answer and transfer is the attractive wrong one.
 */
export const leaveFamily = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const actorUid = request.auth.uid;
  const nowMs = Date.now();

  const familyId: unknown = request.data?.familyId;
  if (typeof familyId !== 'string' || familyId.length === 0 || familyId.includes('/')) {
    throw new HttpsError('invalid-argument', 'A family id is required.');
  }
  const familyRef = db.doc(`families/${familyId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(familyRef);
    if (!snap.exists) {
      // Already gone. Same idempotence argument as leaving a family you are not
      // in: the end state holds.
      return {left: true, noop: true};
    }

    const plan = planFamilyDeparture({
      family: snap.data() as FamilyDoc,
      actorUid,
      targetUid: actorUid,
      nowMs,
    });
    if (!plan.ok) {
      const {code, message} = FAMILY_DEPARTURE_REFUSALS[plan.refusal];
      throw new HttpsError(code, message);
    }

    applyFamilyDeparture(tx, familyRef, plan);
    return {left: true, noop: plan.noop};
  });
});

/**
 * Remove somebody else from the family you own.
 *
 * NOTE: A SEPARATE CALLABLE FROM `leaveFamily`, NOT A PARAMETER ON IT, and the
 * reason is authorisation rather than tidiness: leaving is authorised by BEING
 * the person, removing is authorised by OWNING the family. One callable taking
 * an optional uid would mean a single code path where the difference between
 * "me" and "somebody else" is a defaulted argument — and a bug in that default
 * is the bug that lets one member evict another. Two names, two authorities,
 * one shared plan and one shared writer.
 */
export const removeMember = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const actorUid = request.auth.uid;
  const nowMs = Date.now();

  const familyId: unknown = request.data?.familyId;
  const targetUid: unknown = request.data?.uid;
  if (typeof familyId !== 'string' || familyId.length === 0 || familyId.includes('/')) {
    throw new HttpsError('invalid-argument', 'A family id is required.');
  }
  if (typeof targetUid !== 'string' || targetUid.length === 0) {
    throw new HttpsError('invalid-argument', 'A member uid is required.');
  }
  const familyRef = db.doc(`families/${familyId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(familyRef);
    if (!snap.exists) throw new HttpsError('not-found', 'That family does not exist.');

    const plan = planFamilyDeparture({
      family: snap.data() as FamilyDoc,
      actorUid,
      targetUid,
      nowMs,
    });
    if (!plan.ok) {
      const {code, message} = FAMILY_DEPARTURE_REFUSALS[plan.refusal];
      throw new HttpsError(code, message);
    }

    applyFamilyDeparture(tx, familyRef, plan);
    return {removed: targetUid, noop: plan.noop};
  });
});

/**
 * End the family, for everyone.
 *
 * CRITICAL: THE OWNER'S EXIT, AND IT REVOKES EVERY MEMBER INCLUDING THEMSELVES. Their
 * `subscriptionTier` is untouched — they keep what they pay for; what ends is
 * the family grant derived from it. Leaving their own `familyProExpiresAt` set
 * would make `resolveEffectiveTier` answer `pro` from a family that no longer
 * exists.
 */
export const disbandFamily = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const actorUid = request.auth.uid;
  const nowMs = Date.now();

  const familyId: unknown = request.data?.familyId;
  if (typeof familyId !== 'string' || familyId.length === 0 || familyId.includes('/')) {
    throw new HttpsError('invalid-argument', 'A family id is required.');
  }
  const familyRef = db.doc(`families/${familyId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(familyRef);
    if (!snap.exists) return {disbanded: true, noop: true, revokedUids: []};

    const plan = planFamilyDisband({
      family: snap.data() as FamilyDoc,
      actorUid,
      nowMs,
    });
    if (!plan.ok) {
      const {code, message} = FAMILY_DEPARTURE_REFUSALS[plan.refusal];
      throw new HttpsError(code, message);
    }

    applyFamilyDeparture(tx, familyRef, plan);
    return {disbanded: true, noop: false, revokedUids: plan.revokedUids};
  });
});

// ---------------------------------------------------------------------------
// deleteAccount — the cascade the delete dialog has always claimed to do
//
// CRITICAL: WHAT THIS REPLACES. `settings_page.dart` showed "This action is permanent
// and cannot be undone. All your data will be deleted." and then ran
// `FirebaseAuth.instance.currentUser?.delete()`. That deletes the Auth record.
// Everything else — the house, the inventory, the friend edges on OTHER
// people's documents, the family seat, the public profile — survived, owned by
// a uid that could never sign in again. App Store Review Guideline 5.1.1(v)
// requires the account AND the associated data.
//
// KEY: THE ORDER IS THE DESIGN, AND IT IS CHOSEN BY WHICH FAILURE IS RECOVERABLE.
// The Auth record goes LAST. A failure anywhere before that leaves an account
// that can still sign in and re-run this call, so the user can retry and a
// human can inspect it. A failure AFTER the auth record went, with data still
// present, leaves that data owned by a uid nobody can authenticate as — which
// is the exact bug being fixed here. Every step is a delete or an
// already-holds no-op, so a retry on partial state converges.
//
// WARNING: THE ONE WINDOW THIS CANNOT CLOSE: an ID token already issued stays valid
// for up to an hour after `deleteUser`, so a client that kept running could
// re-create documents it is still permitted to write. Nothing server-side can
// revoke an outstanding ID token — `revokeRefreshTokens` only stops the NEXT
// refresh. The mitigation is the client signing out the moment this returns,
// and that is W1's change, not this one.
// ---------------------------------------------------------------------------

/** Firestore's hard cap is 500 writes per batch; 400 leaves room to be wrong. */
const ACCOUNT_DELETION_BATCH_SIZE = 400;

/**
 * Every document beneath a document, deepest first.
 *
 * CRITICAL: `listCollections()` AT RUNTIME, NOT A HARD-CODED LIST OF SUBCOLLECTIONS.
 * Deleting `users/{uid}` does NOT delete its subcollections — they become
 * orphans that are invisible under a parent that no longer exists, so a missed
 * one is a miss nobody will ever see. A constant list would go stale the first
 * time somebody adds a subcollection and nothing would fail.
 * `KNOWN_USER_SUBCOLLECTIONS` exists only to PIN this in the suite.
 *
 * NOTE: Recursive rather than one level down because `listDocuments()` also
 * returns refs to documents that do not exist but DO have children, which is
 * exactly how an orphan hides.
 */
async function descendantDocPaths(
  ref: admin.firestore.DocumentReference,
): Promise<string[]> {
  const out: string[] = [];
  for (const col of await ref.listCollections()) {
    for (const child of await col.listDocuments()) {
      out.push(...(await descendantDocPaths(child)));
      out.push(child.path);
    }
  }
  return out;
}

/** Delete a list of documents in batches. Deleting an absent document is a
 *  no-op in Firestore, which is what makes a retry safe. */
async function deleteDocPaths(paths: readonly string[]): Promise<number> {
  for (let i = 0; i < paths.length; i += ACCOUNT_DELETION_BATCH_SIZE) {
    const batch = db.batch();
    for (const p of paths.slice(i, i + ACCOUNT_DELETION_BATCH_SIZE)) {
      batch.delete(db.doc(p));
    }
    await batch.commit();
  }
  return paths.length;
}

/** `collection where field == uid` -> the ids that matched. */
async function idsWhere(
  collectionPath: string,
  field: string,
  uid: string,
): Promise<string[]> {
  const snap = await db.collection(collectionPath).where(field, '==', uid).get();
  return snap.docs.map((d) => d.id);
}

/**
 * Apply a deletion plan. Everything except the Auth record.
 *
 * KEY: SPLIT OUT FROM THE CALLABLE SO IT CAN BE TESTED, and the split is where
 * the seed-assert-present-delete-assert-absent test hangs. A test that only
 * drove the planner would prove the right paths were NAMED and nothing about
 * whether they were removed.
 */
async function applyAccountDeletion(plan: AccountDeletionPlan): Promise<void> {
  // 1. Third parties FIRST, while `users/{uid}` and its friends subcollection
  //    are still readable — if this order inverted, a failure midway would
  //    leave references to a uid whose own record is already gone, and nothing
  //    could then work out what to clean.
  await deleteDocPaths(plan.mirrorEdgePaths);
  await deleteDocPaths(plan.sentGiftInvitePaths);
  await deleteDocPaths(plan.choreDocPaths);
  // CRITICAL: THE USER'S OWN MESSAGES, INSIDE OTHER PEOPLE'S CONVERSATION (W2-127).
  // Previously retained on conversational-integrity grounds; Brendan reversed
  // that after the Guideline 1.3 rejection — see AccountDeletionPlan.
  await deleteDocPaths(plan.messageDocPaths);

  for (const other of plan.housemateArrayUids) {
    // WARNING: arrayRemove ON ONE FIELD. This is somebody else's user document; the
    // only thing touched is their `housemates` array, and only this uid is
    // removed from it. A `set` of the whole roster would race with their own
    // housemate changes.
    await db
      .doc(`users/${other}`)
      .set({housemates: FieldValue.arrayRemove(plan.uid)}, {merge: true});
  }

  // 2. The family, through the SAME transaction-applier the three family
  //    callables use. A second copy of "revoke and unstamp" is the copy that
  //    forgets one of the two writes — see applyFamilyDeparture.
  if (plan.family) {
    const familyRef = db.doc(`families/${plan.family.familyId}`);
    const departure = plan.family.departure;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(familyRef);
      if (!snap.exists) return;
      applyFamilyDeparture(tx, familyRef, departure);
    });
  }

  // 3. Foreign documents naming this uid.
  await deleteDocPaths(plan.foreignDocPaths.map((h) => h.path));

  // 4. This account's own documents, deepest first, then the root. Deleting the
  //    root fires syncPublicProfile, which removes publicProfiles/{uid} — so
  //    the projection is deliberately not in the plan.
  await deleteDocPaths(plan.ownDocPaths);
  await db.doc(plan.rootPath).delete();
}

/**
 * Delete the calling account and its data.
 *
 * WARNING: IDEMPOTENT: calling it twice succeeds. The second call plans an almost
 * empty cascade and `deleteUser` on an already-deleted uid is tolerated.
 *
 * NOTE: THE SERVER DELETES THE AUTH RECORD, NOT THE CLIENT, and that is a fix as
 * well as an ordering choice: `currentUser.delete()` throws
 * `requires-recent-login` for anyone who has not signed in recently, which the
 * old client handled by telling the user to sign out and back in first. The
 * Admin SDK has no recency requirement.
 */
export const deleteAccount = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const uid = request.auth.uid;
  const nowMs = Date.now();

  const userRef = db.doc(`users/${uid}`);
  const userSnap = await userRef.get();
  const userData = userSnap.data();

  const ownDocPaths = await descendantDocPaths(userRef);

  const friendEdges = (await db.collection(`users/${uid}/friends`).listDocuments()).map(
    (d) => ({id: d.id}),
  );

  const familyId = typeof userData?.familyId === 'string' ? userData.familyId : null;
  let family: {id: string; data: FamilyDoc} | null = null;
  let choreIds: string[] = [];
  let messageIds: string[] = [];
  if (familyId && !familyId.includes('/')) {
    const familySnap = await db.doc(`families/${familyId}`).get();
    if (familySnap.exists) {
      family = {id: familyId, data: familySnap.data() as FamilyDoc};
      choreIds = await idsWhere(`families/${familyId}/chores`, 'assignedToUid', uid);
      // Single-field equality inside ONE known subcollection, so it is served by
      // Firestore's automatic single-field index — no composite index, for the
      // same reason the chores query above needs none.
      messageIds = await idsWhere(`families/${familyId}/messages`, 'senderUid', uid);
    }
  }

  // KEY: THE FRIENDS LIST BOUNDS THIS QUERY, WHICH IS WHY IT NEEDS NO INDEX.
  // A gift invite this user SENT lives in the RECIPIENT's subcollection, and
  // there is no reverse pointer. The general form is a collection-group query
  // on `fromUid`, which would need a new composite index. Invites only ever go
  // to friends, so iterating the friends list turns it into N single-field
  // queries, each auto-indexed.
  const sentGiftInvites: Array<{ownerUid: string; inviteId: string}> = [];
  for (const edge of friendEdges) {
    for (const inviteId of await idsWhere(
      `users/${edge.id}/giftInvites`,
      'fromUid',
      uid,
    )) {
      sentGiftInvites.push({ownerUid: edge.id, inviteId});
    }
  }

  const foreignHits: Array<{path: string; reason: string}> = [];
  for (const id of await idsWhere('subscriptionOwners', 'uid', uid)) {
    foreignHits.push({
      path: `subscriptionOwners/${id}`,
      // CRITICAL: DELETED ON PURPOSE, and it is the one foreign delete with a
      // consequence. This document routes a FUTURE Apple renewal to a uid.
      // Leaving it means the next renewal notification resolves to an account
      // that cannot exist and writes Pro into nothing; removing it lets the
      // same Apple subscription bind to a new account cleanly.
      reason: 'renewal routing to a uid that will not exist',
    });
  }
  for (const id of await idsWhere('galleryFeedback', 'uid', uid)) {
    foreignHits.push({path: `galleryFeedback/${id}`, reason: "this user's own feedback"});
  }
  for (const id of await idsWhere('housemateTokens', 'hostUid', uid)) {
    foreignHits.push({path: `housemateTokens/${id}`, reason: 'token this user hosted'});
  }
  for (const id of await idsWhere('familyInvites', 'ownerUid', uid)) {
    foreignHits.push({path: `familyInvites/${id}`, reason: 'invite this user issued'});
  }

  const plan = planAccountDeletion({
    uid,
    user: userData,
    ownDocPaths,
    friendEdges,
    family,
    sentGiftInvites,
    choreIds,
    messageIds,
    foreignHits,
    nowMs,
  });

  await applyAccountDeletion(plan);

  // CRITICAL: LAST, AND ONLY AFTER THE CASCADE COMMITTED. See the header block.
  // `user-not-found` is success: it means a previous attempt got this far.
  try {
    await admin.auth().deleteUser(uid);
  } catch (err) {
    if ((err as {code?: string}).code !== 'auth/user-not-found') throw err;
  }

  // One line, plain text, uid in it — the same reasoning as
  // onNewUserBefriendGibby's success line. `functions:log --only deleteAccount
  // | grep <uid>` is the only production tool proven reachable on this project,
  // and a deletion nobody can attribute afterwards is a deletion nobody can
  // answer a support mail about.
  const writes = thirdPartyWrites(plan);
  console.log(
    `deleteAccount: ok uid=${uid} ownDocs=${plan.ownDocPaths.length} ` +
      `thirdPartyWrites=${writes.length} foreign=${plan.foreignDocPaths.length} ` +
      `family=${plan.family ? (plan.family.departure.dissolved ? 'dissolved' : 'departed') : 'none'}` +
      `${plan.familyRefusal ? ` familyRefusal=${plan.familyRefusal.refusal}` : ''}`,
  );

  return {
    deleted: true,
    ownDocsDeleted: plan.ownDocPaths.length,
    thirdPartyWrites: writes.length,
    familyDissolved: plan.family?.departure.dissolved ?? false,
  };
});

/**
 * Post a message to the family board.
 *
 * CRITICAL: EVERY RULE IS ENFORCED HERE, NOT ON THE CLIENT. A client-side cap is a
 * suggestion — this callable is reachable directly by anyone with the app's
 * config, and a family board is the one surface where that matters. The client
 * should also cap for the typing experience; that copy is a courtesy and this
 * one is the rule.
 *
 * KEY: ANY MEMBER POSTS, ANY MEMBER READS, NOBODY EDITS ANOTHER'S — so the
 * authority is simply membership, unlike chores where assigning and completing
 * are different powers. There is no edit path at all: an edited message is a
 * changed record of what somebody said, which is a different feature and a
 * worse default on a board children read.
 */
export const postFamilyMessage = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const senderUid = request.auth.uid;
  const nowMs = Date.now();

  const familyId: unknown = request.data?.familyId;
  if (typeof familyId !== 'string' || familyId.length === 0 || familyId.includes('/')) {
    throw new HttpsError('invalid-argument', 'A family id is required.');
  }

  // Validated BEFORE any read: a 5,000-character paste should not cost a
  // Firestore round trip to be told it is too long.
  const check = checkMessage(request.data?.text);
  if (!check.ok) {
    const {code, message} = MESSAGE_REFUSALS[check.refusal];
    throw new HttpsError(code, message);
  }

  const familyRef = db.doc(`families/${familyId}`);
  const messageRef = db.collection(`families/${familyId}/messages`).doc();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(familyRef);
    if (!snap.exists) throw new HttpsError('not-found', 'That family does not exist.');
    const family = snap.data() as FamilyDoc;

    if (!family.memberUids.includes(senderUid)) {
      throw new HttpsError('permission-denied', 'You are not in this family.');
    }

    // KEY: THE SENDER'S NAME AND AVATAR ARE STAMPED ONTO THE MESSAGE, not left
    // for the reader to resolve. This is the W2-87 problem one level up: a
    // client cannot read another member's publicProfiles document, so a message
    // carrying only a uid renders as an unnamed bubble. Both come from the
    // family's own denormalised maps, which the sender can already read.
    const doc: FamilyMessageDoc = {
      senderUid,
      senderName: family.memberNames?.[senderUid] ?? '',
      senderAvatarId: family.memberAvatars?.[senderUid] ?? null,
      text: check.text,
      postedAtMs: nowMs,
    };
    tx.set(messageRef, doc);
    return {messageId: messageRef.id, ...doc};
  });
});

/**
 * Assign a chore to a family member.
 *
 * CRITICAL: ONLY THE OWNER, and the write goes through here rather than through rules.
 * `families/{familyId}/chores/{choreId}` is deny-write to every client for the
 * same reason `trashDay` is: the roster lives on the PARENT document, and a
 * rule that verified the writer against it would need a `get()` that is only as
 * trustworthy as whoever controls that document. The callable is the gate.
 */
export const assignFamilyChore = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const actorUid = request.auth.uid;
  const nowMs = Date.now();

  const familyId: unknown = request.data?.familyId;
  if (typeof familyId !== 'string' || familyId.length === 0 || familyId.includes('/')) {
    throw new HttpsError('invalid-argument', 'A family id is required.');
  }
  const assignedToUid: unknown = request.data?.uid;
  if (typeof assignedToUid !== 'string' || assignedToUid.length === 0) {
    throw new HttpsError('invalid-argument', 'A member uid is required.');
  }

  const familyRef = db.doc(`families/${familyId}`);
  const choreRef = db.collection(`families/${familyId}/chores`).doc();

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(familyRef);
    if (!snap.exists) throw new HttpsError('not-found', 'That family does not exist.');
    const family = snap.data() as FamilyDoc;

    const plan = planChoreAssignment({
      family,
      actorUid,
      assignedToUid,
      taskId: request.data?.taskId,
      dueAtMs: request.data?.dueAtMs,
      nowMs,
    });
    if (!plan.ok) {
      const {code, message} = CHORE_REFUSALS[plan.refusal];
      throw new HttpsError(code, message);
    }

    tx.set(choreRef, plan.chore);
    return {choreId: choreRef.id, ...plan.chore};
  });
});

/**
 * Set the family's shared bin day.
 *
 * CRITICAL: THIS EXISTS BECAUSE `firestore.rules:822` IS `allow write: if false` ON
 * `families/{familyId}` — the client cannot write this document at all, which
 * is why every family mutation is a callable. That denial is not an obstacle
 * being worked around; it is what makes `ownerUid` mean anything.
 *
 * OK: AND THE READ PATH NEEDS NO RULES CHANGE. `firestore.rules:819` already
 * grants `get` on the family document to any member, so a member reads
 * `binWeekday` by reading the family they are already reading for the roster.
 * **This brief ships no rules change and therefore needs no deploy.**
 *
 * NOTE: SET-ONLY, NEVER CLEARED. There is no "unset the family bin day" path
 * here: a family that had a shared day and lost it would silently fall back to
 * per-device weekdays, which is the exact bug this closes, arriving later and
 * looking like a new one.
 */
export const setFamilyBinDay = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const actorUid = request.auth.uid;

  const familyId: unknown = request.data?.familyId;
  if (typeof familyId !== 'string' || familyId.length === 0 || familyId.includes('/')) {
    throw new HttpsError('invalid-argument', 'A family id is required.');
  }

  const familyRef = db.doc(`families/${familyId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(familyRef);
    if (!snap.exists) throw new HttpsError('not-found', 'That family does not exist.');
    const family = snap.data() as FamilyDoc;

    const plan = planFamilyBinDay({
      family,
      actorUid,
      binWeekday: request.data?.binWeekday,
    });
    if (!plan.ok) {
      const {code, message} = FAMILY_BIN_DAY_REFUSALS[plan.refusal];
      throw new HttpsError(code, message);
    }

    // KEY: A MERGE, NOT A SET. The roster, the denormalised names and the avatars
    // all live on this document; a bare set() here would delete the family to
    // change one integer.
    tx.set(familyRef, {binWeekday: plan.binWeekday}, {merge: true});
    return {binWeekday: plan.binWeekday};
  });
});

/**
 * Mark your own chore done.
 *
 * KEY: THE AUTHORITY IS BEING THE ASSIGNEE, not owning the family — completion is
 * the member's own act. A parent marking a child's chore done is a different
 * feature with a different meaning on the board.
 */
export const completeFamilyChore = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const actorUid = request.auth.uid;
  const nowMs = Date.now();

  const familyId: unknown = request.data?.familyId;
  const choreId: unknown = request.data?.choreId;
  if (typeof familyId !== 'string' || familyId.length === 0 || familyId.includes('/')) {
    throw new HttpsError('invalid-argument', 'A family id is required.');
  }
  if (typeof choreId !== 'string' || choreId.length === 0 || choreId.includes('/')) {
    throw new HttpsError('invalid-argument', 'A chore id is required.');
  }

  const choreRef = db.doc(`families/${familyId}/chores/${choreId}`);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(choreRef);
    if (!snap.exists) throw new HttpsError('not-found', 'That chore does not exist.');

    const plan = planChoreCompletion({
      chore: snap.data() as FamilyChoreDoc,
      actorUid,
      nowMs,
    });
    if (!plan.ok) {
      const {code, message} = CHORE_REFUSALS[plan.refusal];
      throw new HttpsError(code, message);
    }

    // KEY: READ AND WRITE IN ONE TRANSACTION, so two taps cannot both see
    // `completedAtMs: null` and both write — the second re-runs, sees the first
    // stamp, and is refused. The FIRST completion time survives.
    tx.update(choreRef, {completedAtMs: plan.completedAtMs});
    return {choreId, completedAtMs: plan.completedAtMs};
  });
});

/**
 * Mint a short-lived invite code for the family you own.
 *
 * CRITICAL: THE INVITE IS THE CAPABILITY, NOT THE FAMILY ID. `joinFamily(familyId)`
 * would let anyone who learns an id add themselves and collect Pro — the
 * fan-out copies `familyProExpiresAt` to every member — and a document id is
 * not a secret. Same problem housemateToken.ts solved, same shape, and the same
 * QR gesture the family spec describes.
 *
 * WARNING: Reusing the token SHAPE is not aliasing the RELATION: nothing here touches
 * `users/{uid}.housemates`, and a family member does not become a housemate.
 */
export const mintFamilyInvite = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const ownerUid = request.auth.uid;
  const nowMs = Date.now();

  // Only a family's OWNER may mint. A member could otherwise recruit into
  // somebody else's household — and into somebody else's subscription.
  const owned = await db
    .collection('families')
    .where('ownerUid', '==', ownerUid)
    .limit(1)
    .get();
  if (owned.empty) {
    throw new HttpsError('failed-precondition', 'You do not have a family to invite anyone to.');
  }

  const familyDoc = owned.docs[0];
  const family = familyDoc.data() as FamilyDoc;
  // Refuse to mint into a family that is already full, so the code is not spent
  // discovering the cap. The join enforces it again — this is a courtesy, the
  // one at redemption is the gate.
  if (family.memberUids.length >= FAMILY_CAP) {
    const {message} = FAMILY_JOIN_REFUSALS['family-full'];
    throw new HttpsError('resource-exhausted', message);
  }

  const code = generateHousemateTokenCode();
  const invite: FamilyInviteDoc = {
    familyId: familyDoc.id,
    ownerUid,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + FAMILY_INVITE_TTL_SECONDS * 1000,
  };
  await db.doc(`familyInvites/${code}`).set(invite);

  return {code, expiresAtMs: invite.expiresAtMs, ttlSeconds: FAMILY_INVITE_TTL_SECONDS};
});

/**
 * Redeem an invite and join the family it names.
 *
 * CRITICAL: THE JOINER'S OWN SUBSCRIPTION IS NOT TOUCHED, AND THE RESPONSE SAYS SO. A
 * callable cannot cancel a StoreKit subscription — only the account holder can,
 * through Apple — so someone who joins while paying for their own Pro is now
 * paying twice. Pretending otherwise would be worse than saying it: SILENT
 * double-billing is the failure, and the billing itself is Apple's to refund.
 * `alreadyPayingSeparately` exists so the client can tell them, in words, at
 * the moment it starts.
 *
 * WARNING: THAT FLAG READS `resolveOwnPaidTier`, NOT `resolveEffectiveTier` — the
 * same trap createFamily's gate has, approached from the other side. The
 * effective tier is `pro` for anyone already carrying a family grant, so the
 * warning would fire for people paying nothing at all.
 *
 * NOTE: ENTITLEMENT IS NOT REQUIRED TO JOIN, deliberately. Needing Pro to accept a
 * family's Pro would make the feature useless to exactly the people it is for.
 */
export const joinFamily = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const joinerUid = request.auth.uid;
  const nowMs = Date.now();

  const code: unknown = request.data?.code;
  // Validated BEFORE it is used as a path segment, so no attacker-chosen string
  // ever addresses a document. The alphabet is server-chosen, so anything
  // outside it was not minted here.
  if (!isValidHousemateTokenCode(code)) {
    throw new HttpsError('invalid-argument', 'That is not a valid invite code.');
  }

  const inviteRef = db.doc(`familyInvites/${code}`);
  const joinerDisplayName = await authDisplayNameOf(joinerUid);

  return db.runTransaction(async (tx) => {
    const inviteSnap = await tx.get(inviteRef);
    if (!inviteSnap.exists) {
      throw new HttpsError('not-found', 'That invite is no longer valid.');
    }
    const invite = inviteSnap.data() as FamilyInviteDoc;

    const familyRef = db.doc(`families/${invite.familyId}`);
    const joinerRef = db.doc(`users/${joinerUid}`);
    const [familySnap, joinerSnap] = await Promise.all([
      tx.get(familyRef),
      tx.get(joinerRef),
    ]);
    if (!familySnap.exists) {
      throw new HttpsError('not-found', 'That family no longer exists.');
    }

    const joinerData = joinerSnap.data();
    const currentFamilyId = joinerData?.familyId;
    const family = familySnap.data() as FamilyDoc;

    // CRITICAL: THE OWNER IS READ SO THE JOINER CAN BE GRANTED NOW, NOT AT THE NEXT
    // RENEWAL. W2-83 wired the roster and the familyId and NOT the entitlement:
    // `familyProExpiresAt` had exactly two writers — the notification fan-out
    // and the departure revoke — so a member who joined received NOTHING until
    // the owner's next DID_RENEW. Up to a full billing month of a paid-for
    // member getting nothing, which is this feature failing at the one thing it
    // is sold as doing. The commit that shipped it asserted symmetry with
    // createFamily over `familyId` — true of that field, false of this one.
    const ownerSnap =
      family.ownerUid === joinerUid
        ? joinerSnap
        : await tx.get(db.doc(`users/${family.ownerUid}`));
    const ownerData = ownerSnap.data();

    const plan = planFamilyJoin({
      family,
      familyId: invite.familyId,
      joinerUid,
      joinerOwnPaidTier: resolveOwnPaidTier(joinerData, nowMs),
      joinerCurrentFamilyId:
        typeof currentFamilyId === 'string' ? currentFamilyId : null,
      inviteExpiresAtMs: invite.expiresAtMs,
      nowMs,
      joinerDisplayName,
      joinerAvatarId: avatarIdOf(joinerData),
    });

    if (!plan.ok) {
      const {code: errCode, message} = FAMILY_JOIN_REFUSALS[plan.refusal];
      throw new HttpsError(errCode, message);
    }

    // KEY: THE GRANT GOES THROUGH planFamilyFanOut, NOT A BESPOKE COPY.
    // `familyProExpiresAt` already has one decider and this does not become its
    // second — the same refusal made about shop/current's fourth writer, applied
    // to my own code. The fan-out is handed the roster AFTER the join so the
    // joiner is one of its subjects, and only THEIR grant is written: the
    // existing members' values are already correct, and rewriting them would
    // risk moving a correct value from an expiry this call had to re-read.
    //
    // WARNING: `ownerHasFamilySubscription` USES THE FAN-OUT'S OWN RULE — the owner
    // holds the FAMILY product — rather than a second, looser one.
    //
    // NOTE: THE DISAGREEMENT THIS COMMENT USED TO RECORD IS RESOLVED (W2-177). The
    // create gate was MORE PERMISSIVE than this line — it accepted a personal
    // Pro — and refusing to invent a looser rule here is what kept that visible
    // until it was ruled on. It now applies the SAME rule, so an owner reaching
    // this point holds the family product by construction. The check stays
    // anyway: a family created before the ruling, or an owner whose product
    // changed after creating one, still reaches here and must not grant.
    const ownerProductId = ownerData?.subscriptionProductId;
    const grants = planFamilyFanOut({
      family: {...family, memberUids: plan.memberUids},
      ownerExpiresAtMs: resolveOwnPaidExpiryMs(ownerData, nowMs),
      ownerHasFamilySubscription: ownerProductId === FAMILY_PRODUCT_ID,
      nowMs,
    });
    const joinerGrant = grants.find((g) => g.uid === joinerUid);
    if (joinerGrant) {
      // Hoisted out of the object literal on purpose — an inline ternary makes
      // userFieldOwnership's static extractor report a CF-written field
      // literally named `null`. Recorded in #389; the extractor is unfixed and
      // that is deliberate.
      const familyProExpiresAt =
        joinerGrant.familyProExpiresAtMs == null
          ? null
          : Timestamp.fromMillis(joinerGrant.familyProExpiresAtMs);
      tx.set(joinerRef, {familyProExpiresAt}, {merge: true});
    }

    tx.update(familyRef, {
      memberUids: plan.memberUids,
      memberNames: plan.memberNames,
      memberAvatars: plan.memberAvatars,
    });
    // Stamped in the SAME transaction, exactly as createFamily does: a member
    // whose familyId does not point at the family holding them is a member no
    // family read can find.
    tx.set(joinerRef, {familyId: invite.familyId}, {merge: true});
    // KEY: SINGLE USE. Deleted inside the transaction, so a code cannot be
    // redeemed twice even by two calls racing — the second re-runs and finds it
    // gone. An invite is a capability, and a capability that survives its use
    // is a capability someone else can still spend.
    tx.delete(inviteRef);

    return {
      familyId: invite.familyId,
      memberUids: plan.memberUids,
      alreadyPayingSeparately: plan.alreadyPayingSeparately,
    };
  });
});

/**
 * The Auth record's display name, or undefined.
 *
 * WARNING: NEVER THROWS. A users/{uid} document can outlive its Auth user, and an
 * Auth user need not have a displayName at all — `syncPublicProfile` already
 * degrades the same way and for the same reason. A family create or join must
 * not fail because a name could not be read; the name is decoration on the
 * membership, not the membership.
 */
function avatarIdOf(data: Record<string, unknown> | undefined): string | undefined {
  // WARNING: THE FIELD IS NAMED `avatarUrl` AND HOLDS AN **ID**. avatar_catalog.dart:
  // "Stable id stored in users/{uid}.avatarUrl". Legacy documents may hold a
  // real Storage URL, and `avatarAssetFor` matches on id OR url, so both
  // resolve on the client — which is exactly why this passes the value through
  // UNINTERPRETED rather than trying to normalise it here.
  const raw = data?.avatarUrl;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * The product this account PAYS FOR, or undefined.
 *
 * CRITICAL: W2-177. TYPED `string | undefined` RATHER THAN PASSED THROUGH RAW, because
 * `snap.data()?.subscriptionProductId` is `any` and `any !== FAMILY_PRODUCT_ID`
 * compiles for a number, an object, or a lie. Anything that is not a non-empty
 * string becomes `undefined` here, which the create gate refuses — the closed
 * direction, chosen where a malformed document would otherwise be compared
 * against a constant and silently lose.
 *
 * KEY: THE VALUE COMES FROM `users/{uid}`, NEVER FROM THE REQUEST. A
 * client-supplied product id would be a trust signal from the untrusted side,
 * and every gate in this file exists precisely because the client cannot be
 * asked what it is entitled to.
 */
function ownProductIdOf(data: Record<string, unknown> | undefined): string | undefined {
  const raw = data?.subscriptionProductId;
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

async function authDisplayNameOf(uid: string): Promise<string | undefined> {
  try {
    return (await admin.auth().getUser(uid)).displayName ?? undefined;
  } catch (err) {
    console.warn(`family: no Auth record for ${uid}`, err);
    return undefined;
  }
}

/**
 * Create a family, and stamp `familyId` on the owner.
 *
 * CRITICAL: THIS IS THE FIELD WHOSE ABSENCE MADE THE WHOLE FEATURE INERT. Every family
 * module since #383 has carried the same footnote — "nothing stamps a familyId
 * on users/{uid}, so no client can name its family". completeTrashDay is
 * unreachable for that reason, and the refund fan-out closed a hole no family
 * could yet fall into. This is the writer.
 *
 * CRITICAL: SINGLE OWNERSHIP IS ENFORCED IN THE TRANSACTION, and that is the residual
 * W0 raised when it accepted #389: `ownedFamilies` reads with `.limit(1)`
 * against an invariant that nothing enforced. The query and the write share one
 * transaction, so two concurrent creates cannot both see "no family" — the
 * second re-runs, sees the first, and is refused. A check outside the
 * transaction would be a race that only shows up under exactly the conditions
 * nobody tests.
 *
 * WARNING: THE ENTITLEMENT GATE READS `resolveOwnPaidTier`, NOT `resolveEffectiveTier`.
 * A member of somebody else's family resolves to `pro` while paying nothing, so
 * the obvious call would admit the empty-shell case the gate exists to reject.
 * See the block above `planFamilyCreation`.
 *
 * CRITICAL: AND SINCE W2-177 THE TIER IS NOT ENOUGH ON ITS OWN. Both paid products map
 * to the tier `pro`, so the gate also reads `subscriptionProductId` and admits
 * only FAMILY_PRODUCT_ID. A personal Pro subscriber is refused with
 * `needs-family-subscription` — the create gate and the entitlement fan-out now
 * apply the same rule, where they used to disagree.
 *
 * NOTE: IT DOES NOT DECIDE WHETHER CHILDREN ARE ACCOUNTS OR PROFILES, and it did
 * not have to. `memberUids` is uid-keyed under either model, so this lands
 * without foreclosing that question in either direction — which is the only
 * reason it could be built while the answer was still moving. Nothing here
 * presumes an independent kid sign-in.
 */
export const createFamily = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const ownerUid = request.auth.uid;
  const nowMs = Date.now();

  const userRef = db.doc(`users/${ownerUid}`);
  const familyRef = db.collection('families').doc();
  // Read OUTSIDE the transaction on purpose: it is an Auth call, not a
  // Firestore read, so it cannot participate in the transaction's consistency
  // and holding the transaction open across it would only widen the window.
  const ownerDisplayName = await authDisplayNameOf(ownerUid);

  return db.runTransaction(async (tx) => {
    // ---- reads, both inside the transaction ----
    const [userSnap, owned] = await Promise.all([
      tx.get(userRef),
      // Single-field equality, so the automatic index serves it and
      // firestore.indexes.json needs nothing — the same shape and the same
      // reasoning as the fan-out's read in appStoreNotificationsV2.
      tx.get(db.collection('families').where('ownerUid', '==', ownerUid).limit(1)),
    ]);

    const plan = planFamilyCreation({
      ownerUid,
      ownPaidTier: resolveOwnPaidTier(userSnap.data(), nowMs),
      // W2-177 — the product, off the SAME snapshot the tier came from and
      // inside the same transaction. No extra read, and no second moment at
      // which the two facts could disagree with each other.
      ownProductId: ownProductIdOf(userSnap.data()),
      alreadyOwnsAFamily: !owned.empty,
      nowMs,
      ownerDisplayName,
      // No extra read: users/{uid} is already fetched above for the
      // entitlement gate, and the avatar id rides along on it.
      ownerAvatarId: avatarIdOf(userSnap.data()),
      // The founder's own bin day, so the family agrees with the person who
      // started it from its first instant. Unvalidated here on purpose — the
      // planner owns what a legal weekday is, and duplicating the check at the
      // call site is how the two definitions drift apart.
      ownerBinWeekday: request.data?.binWeekday,
    });

    if (!plan.ok) {
      const {code, message} = FAMILY_CREATE_REFUSALS[plan.refusal];
      throw new HttpsError(code, message);
    }

    tx.set(familyRef, plan.family);

    // KEY: STAMPED IN THE SAME TRANSACTION AS THE FAMILY IS CREATED. A family
    // whose owner is not pointed at it is a family nobody can reach — the exact
    // state this callable exists to end — and two writes would make that state
    // reachable by a crash between them.
    //
    // WARNING: `merge: true`: users/{uid} carries the subscription and the profile,
    // and this owns exactly one field of it.
    tx.set(userRef, {familyId: familyRef.id}, {merge: true});

    return {familyId: familyRef.id, memberUids: plan.family.memberUids};
  });
});

/**
 * "I took the bins out" — one member's completion, shared with the family.
 *
 * CRITICAL: THE SERVER WRITES IT, AND THE NON-MEMBER CHECK IS WHY. The shared fact
 * lives under a family document the caller does not own, so rules cannot carry
 * this: the only rule that would permit the write is one letting a non-owner
 * write into somebody else's family, which is the same shape housemateToken.ts
 * rejected and for the same reason. `families/{familyId}/trashDay/{key}` is
 * deny-write to every client; this callable is the gate.
 *
 * WARNING: `familyId` COMES FROM THE CLIENT, AND THAT IS SAFE HERE BECAUSE MEMBERSHIP
 * IS VERIFIED AGAINST THE NAMED DOCUMENT. Naming a family you are not in earns
 * `permission-denied` from `planTrashDayCompletion`, and naming one that does
 * not exist earns `not-found`. Taking the id rather than querying for it also
 * keeps this off `where('memberUids','array-contains',uid)` — one fewer read
 * shape, and no index to maintain.
 *
 * NOTE: IT IS NOT REACHABLE FROM THE APP YET, and that is inherited rather than
 * introduced: nothing stamps a `familyId` on `users/{uid}`, so no client can
 * name its family — the gap recorded in W2-76's rules block and still open,
 * because the creating callable is blocked on Brendan. What lands here is the
 * server half, gated; the client half arrives with the field.
 */
export const completeTrashDay = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const actorUid = request.auth.uid;

  const familyId: unknown = request.data?.familyId;
  if (typeof familyId !== 'string' || familyId.length === 0 || familyId.includes('/')) {
    // A slash would escape the collection and address an arbitrary document.
    throw new HttpsError('invalid-argument', 'A family id is required.');
  }

  const binDateKey: unknown = request.data?.binDateKey;
  const nowMs = Date.now();
  const familyRef = db.doc(`families/${familyId}`);
  const completionRef = db.doc(`families/${familyId}/trashDay/${binDateKey}`);

  return db.runTransaction(async (tx) => {
    const familySnap = await tx.get(familyRef);
    if (!familySnap.exists) {
      // Deliberately the same shape a non-member gets nothing extra from: this
      // says the family is absent, not who is in it.
      throw new HttpsError('not-found', 'That family does not exist.');
    }
    const family = familySnap.data() as FamilyDoc;

    // KEY: READ THE EXISTING COMPLETION INSIDE THE TRANSACTION. Two members
    // tapping at once must not both write: the second read sees the first
    // write's version and the transaction re-runs, so the FIRST completer is
    // preserved rather than whichever call happened to commit last.
    const existingSnap = await tx.get(completionRef);
    const existing = existingSnap.exists
      ? (existingSnap.data() as TrashDayCompletion)
      : null;

    const plan = planTrashDayCompletion({
      family,
      actorUid,
      binDateKey,
      nowMs,
      existing,
    });

    if (!plan.ok) {
      const {code, message} = TRASH_DAY_REFUSALS[plan.refusal];
      throw new HttpsError(code, message);
    }

    if (plan.wrote) {
      tx.set(completionRef, plan.completion);
    }

    return {
      wrote: plan.wrote,
      completedByUid: plan.completion.completedByUid,
      completedAtMs: plan.completion.completedAtMs,
      binDateKey: plan.completion.binDateKey,
      clearedForCount: plan.clearsFor.length,
    };
  });
});

// ---------------------------------------------------------------------------
// adminGrant — HTTP POST, admin only (W2-122)
// ---------------------------------------------------------------------------
//
// Brendan names an account he has verified and issues sponges, skins and
// chests. Before this there was no path at all.
//
// KEY: NO NEW ADMIN MODEL WAS INVENTED. This is the SAME gate as seedShopData and
// backfillPublicProfiles: POST-only, a shared SEED_SECRET in an `x-seed-secret`
// header, failing closed when the secret is unset. A custom claim would have
// been a second admin mechanism guarding one more thing than the first.
//
// KEY: AND SEED_SECRET RATHER THAN A NEW ONE IS A BLAST-RADIUS DECISION, NOT
// LAZINESS. FEEDBACK_EXPORT_SECRET exists because that endpoint only READS, and
// "the read endpoint is the one that gets handed around". This one WRITES
// player-visible state — the same radius seedShopData already occupies. A third
// secret would split that radius without shrinking it.
//
// NOTE: HTTP, NOT A CALLABLE, AND THAT IS THE POINT. The consumer is a human with
// a terminal. Nothing in lib/ should ever call this. A callable implies the app
// invokes it, and an admin callable the app can reach is a mint anyone can
// find — exportGalleryFeedback was a callable and that was a data disclosure.
export const adminGrant = onRequest(SEED_OPTS, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  // WARNING: THE TWO 403s ARE DELIBERATELY DIFFERENT, copied from exportGalleryFeedback
  // rather than from seedShopData — seedShopData still collapses both into a
  // bare 'Forbidden', which is the shape that cost real time. An UNSET secret
  // and a WRONG one are different problems with different fixes: the first is a
  // deployment that never bound it (the Gen2 trap SEED_OPTS documents), the
  // second is a person holding the wrong string. Neither message leaks the
  // value; they name the FAILURE.
  const expectedSecret = process.env.SEED_SECRET;
  if (!expectedSecret) {
    res
      .status(403)
      .send(
        'Forbidden — SEED_SECRET is not bound on this deployment, so no header ' +
          'can match. This is a server configuration problem, NOT a wrong secret. ' +
          'Bind it with `firebase functions:secrets:set SEED_SECRET` AND redeploy ' +
          'adminGrant, or provide it via a .env locally.\n',
      );
    return;
  }
  if (req.get('x-seed-secret') !== expectedSecret) {
    res
      .status(403)
      .send(
        'Forbidden — the x-seed-secret header is missing or does not match.\n',
      );
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const decision = planAdminGrant({
    uid: body.uid,
    grantId: body.grantId,
    sponges: body.sponges,
    itemIds: body.itemIds,
    chestCategories: body.chestCategories,
  });

  if (!decision.ok) {
    res.status(400).json({
      ok: false,
      refusal: decision.refusal,
      detail: decision.detail ?? null,
      message: ADMIN_GRANT_REFUSALS[decision.refusal],
    });
    return;
  }

  const plan = decision.plan;

  // CRITICAL: DRY RUN IS THE DEFAULT AND `apply` MUST BE THE BOOLEAN `true`.
  // The precedent in this project is that Brendan executes production writes;
  // this endpoint's job is to show him exactly what it would do first. Requiring
  // the literal `true` rather than any truthy value means a stray `"apply":
  // "false"` — a string, which is truthy — cannot apply a grant.
  const apply = body.apply === true;

  if (!apply) {
    res.status(200).json({
      ok: true,
      dryRun: true,
      wouldGrant: plan,
      note:
        'Nothing was written. Re-send with "apply": true (boolean, not a string) ' +
        'to issue this grant.',
    });
    return;
  }

  const grantRef = db.doc(`adminGrants/${plan.grantId}`);
  const profileRef = db.doc(`users/${plan.uid}/profile/data`);

  // CRITICAL: ONE DATE FOR THE WHOLE GRANT, COMPUTED BEFORE THE TRANSACTION OPENS.
  // `db.runTransaction` RE-RUNS on contention, so every `Timestamp.now()`
  // inside it produces a different value on each attempt. Resolving the frozen
  // subject in there would let a grant that retries across UTC midnight stamp
  // `grantedAt` from one day and a `subject` from the next — a document
  // disagreeing with itself about when it was granted, discoverable only by a
  // player whose chest rolled the wrong theme.
  //
  // NOTE: `grantedAt` and `issuedAt` below still vary across retries for exactly
  // this reason. That is pre-existing and harmless today, and hoisting them
  // would change the meaning of fields other code reads — surfaced here rather
  // than folded into a fix brief (W2-125).
  //
  // Format mirrors the shop rotation (`:531`, `:2387`) rather than inventing a
  // second one: `subjectForDay` parses `YYYYMMDD` with `Number(replace(/\D/g,''))`.
  const grantDateStr = new Date().toISOString().split('T')[0].replace(/-/g, '');

  try {
    const result = await db.runTransaction(async (tx) => {
      // ---- reads first, all of them (Firestore transaction requirement) ----
      const grantSnap = await tx.get(grantRef);
      if (grantSnap.exists) {
        // KEY: THE IDEMPOTENCY LOCK, THE SAME SHAPE AS processedReceipts: the
        // ledger document is created INSIDE the transaction, so a retry or a
        // concurrent call returns the ORIGINAL grant rather than applying a
        // second one. A retried curl must not be a second 1000 sponges.
        const prev = grantSnap.data()!;
        return { alreadyProcessed: true, granted: prev.granted ?? null };
      }

      // Read even though the value is unused: a Firestore transaction only
      // retries on documents it READ, and this one WRITES the profile. Without
      // the read a concurrent spend could interleave between the read set and
      // the commit without triggering a retry.
      await tx.get(profileRef);
      const inventoryRefs = plan.itemIds.map((id) =>
        db.doc(`users/${plan.uid}/inventory/${id}`),
      );
      const inventorySnaps = await Promise.all(inventoryRefs.map((r) => tx.get(r)));

      // ---- writes ----
      if (plan.sponges > 0) {
        // WARNING: increment(), not a computed set. Two admins granting at once, or a
        // player spending mid-grant, must not lose either write — and the
        // profile document may not exist yet on a fresh account, which is why
        // this is a merge rather than an update.
        tx.set(
          profileRef,
          { spongeBalance: FieldValue.increment(plan.sponges) },
          { merge: true },
        );
      }

      const alreadyOwned: string[] = [];
      plan.itemIds.forEach((itemId, i) => {
        if (inventorySnaps[i].exists) {
          // NOTE: NOT RE-WRITTEN. Re-granting an owned item would reset `equipped`,
          // silently un-equipping something the player is wearing. The grant is
          // still recorded as successful — they own it, which is what was asked.
          alreadyOwned.push(itemId);
          return;
        }
        tx.set(inventoryRefs[i], {
          itemId,
          ownedAt: Timestamp.now(),
          equipped: false,
        });
      });

      // CRITICAL: CHESTS ARE MINTED UNOPENED — Brendan's decision, over rolling them
      // server-side. The player opens each one through `openPendingChest` and
      // sees the reveal, which is the half that makes a chest a chest.
      // WARNING: THE CONSEQUENCE, STATED WHERE IT IS TRUE: the shipped client has no
      // UI for these yet. A chest granted today is invisible until that lands.
      const pendingChestIds: string[] = [];
      plan.chestCategories.forEach((category, i) => {
        const pendingId = `${plan.grantId}_${i}`;
        pendingChestIds.push(pendingId);
        tx.set(db.doc(`users/${plan.uid}/pendingChests/${pendingId}`), {
          category,
          // Frozen at MINT time, not read at open time. The rotation's drop
          // table can change between the grant and the open, and the recipient
          // should get the odds that were granted rather than the odds that
          // happen to be live when they tap.
          dropTable: CHEST_CATEGORY_DROP_TABLE[category] ?? 'lean',
          // CRITICAL: THE SECOND FROZEN AXIS, AND IT WAS MISSING UNTIL W2-125.
          // `dropTable` froze the RARITY axis on the line above; nothing ever
          // froze the SUBJECT axis, and `openPendingChest` was passing the
          // CATEGORY into a filter that reads a SUBJECT. Categories are
          // characters|styles|furniture; subjects are sofa|character|roof|…
          // Disjoint sets, so every chest minted before this line existed threw
          // `not-found` on open. The shop's own chest rows have carried
          // `subject: subjectForDay(category, dateStr)` since they were written
          // (`:532-534`, `:2396`) — this is the grant path writing the field the
          // shop path already writes, not a new concept.
          //
          // WARNING: RESOLVED FROM THE GRANT DATE, NEVER THE OPEN DATE. `subjectForDay`
          // is day-keyed, so calling it at open time would derive the theme from
          // the day the player taps — the same defect `dropTable` exists to
          // prevent, on the other axis. What you were granted is what you get.
          subject: subjectForDay(category, grantDateStr),
          grantedAt: Timestamp.now(),
          grantId: plan.grantId,
          openedAt: null,
        });
      });

      const granted = {
        sponges: plan.sponges,
        itemIds: plan.itemIds,
        alreadyOwned,
        pendingChestIds,
      };

      // The audit row, and the lock, and they are the same document on purpose:
      // a grant that was applied but not recorded is the state nothing can
      // reconcile afterwards.
      tx.set(grantRef, {
        uid: plan.uid,
        grantId: plan.grantId,
        granted,
        issuedAt: Timestamp.now(),
      });

      return { alreadyProcessed: false, granted };
    });

    res.status(200).json({ ok: true, dryRun: false, ...result });
  } catch (err) {
    console.error('adminGrant: failed', err);
    res.status(500).json({ ok: false, message: 'Grant failed; nothing was written.' });
  }
});

// ---------------------------------------------------------------------------
// openPendingChest — the player opens a granted chest
// ---------------------------------------------------------------------------
//
// A callable, unlike adminGrant, because THIS one the app really does invoke —
// it is the player's own act, on their own document.
//
// KEY: THE ROLL HAPPENS HERE, NOT AT GRANT TIME, and that is the whole reason
// pendingChests exist as documents rather than as resolved contents. A chest
// whose result is already decided is a list of items wearing a chest costume.
export const openPendingChest = onCall(async (request) => {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Authentication required');
  const uid = request.auth.uid;

  const pendingChestId: unknown = request.data?.pendingChestId;
  if (
    typeof pendingChestId !== 'string' ||
    pendingChestId.length === 0 ||
    pendingChestId.includes('/')
  ) {
    throw new HttpsError('invalid-argument', 'A pendingChestId is required.');
  }

  const chestRef = db.doc(`users/${uid}/pendingChests/${pendingChestId}`);

  // The roll and the item lookup happen OUTSIDE the transaction: pickChestItem
  // runs a collection query, which a transaction cannot serve, and the same
  // split purchaseChest already uses. The transaction below re-reads the chest
  // and refuses if it was opened in the meantime, so the roll cannot be applied
  // twice however many times this races.
  const preSnap = await chestRef.get();
  if (!preSnap.exists) throw new HttpsError('not-found', 'No such chest.');
  const chest = preSnap.data()!;
  if (chest.openedAt != null) {
    throw new HttpsError('already-exists', 'That chest is already open.');
  }

  const itemRarity = rollRarity((chest.dropTable as string) ?? 'lean');

  // CRITICAL: THE SUBJECT, NOT THE CATEGORY. This line read `chest.category` until
  // W2-125, and `pickChestItem`'s first parameter filters `items` on `subject`.
  // Categories are characters|styles|furniture (itemPool.ts:66); subjects are
  // sofa|character|roof|wall|lamp|armchair and siblings (SEED_ITEMS). The two
  // sets are disjoint — `character` is not `characters` — so the query matched
  // nothing, the bundled SEED_ITEMS fallback matched nothing, and every chest
  // `adminGrant` ever minted threw `not-found` on open. The other two callers
  // always passed a subject: `chestSubject` at the purchase path, and
  // `subjectForDay(category, …)` at the quest payout.
  //
  // WARNING: AND THE FAILURE WAS INVERTED, WHICH IS WHY NO FIXTURE CAUGHT IT: an
  // EMPTY subject SKIPS the filter and rolls on rarity alone, so a chest
  // document MISSING its category opened fine while a well-formed one threw.
  // Any test seeded without a category would have gone green over the bug.
  //
  // NOTE: Read from the document, never re-derived. `subjectForDay` is day-keyed,
  // so resolving it here would give the theme of the day the player TAPS —
  // the same defect `dropTable` was frozen to prevent, on the other axis.
  const chestSubject = chest.subject;
  if (typeof chestSubject !== 'string') {
    // A chest minted before W2-125 froze the field. Refusing is deliberate and
    // is the SAFE half of a choice whose other half is worse: falling back to
    // `''` would skip the subject filter entirely and roll on rarity alone, so
    // a furniture chest could pay out a character — succeeding while silently
    // ignoring what it was. A refusal is visible; a wrong prize is not.
    //
    // KEY: THE CHEST IS NOT CONSUMED BY THIS THROW. It happens before the
    // transaction, so `openedAt` stays null and the chest opens correctly the
    // moment a subject can be resolved for it.
    throw new HttpsError(
      'failed-precondition',
      'That chest predates the themed-grant fix and cannot be opened yet.',
    );
  }
  const pick = await pickChestItem(chestSubject, itemRarity, uid);

  // KEY: A GRANTED CHEST HAS NO PURCHASE PRICE, SO ITS REFUND COMES FROM THE LIST
  // PRICE OF THE CATEGORY IT WAS MINTED AS. `category` is written at mint time
  // by adminGrant; `dropTable` is the frozen fallback for a chest minted before
  // the field existed, and it inverts 1:1 through CHEST_CATEGORY_DROP_TABLE.
  // Both return 0 rather than guessing when they resolve to nothing — an
  // underivable price is an unpriced chest, the same stance the purchase path
  // takes when `txChest.price` is missing.
  const chestRefund =
    refundForCategory(chest.category as string) ||
    refundForDropTable(chest.dropTable as string);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(chestRef);
    if (!snap.exists) throw new HttpsError('not-found', 'No such chest.');
    // CRITICAL: THE RE-READ IS THE REPLAY GUARD. Two taps in flight at once both pass
    // the pre-flight check above; only one can pass this one.
    if (snap.data()!.openedAt != null) {
      throw new HttpsError('already-exists', 'That chest is already open.');
    }

    const inventoryRef = db.doc(`users/${uid}/inventory/${pick.itemId}`);
    const inventorySnap = await tx.get(inventoryRef);
    const isDuplicate = inventorySnap.exists;

    if (!isDuplicate) {
      tx.set(inventoryRef, {
        itemId: pick.itemId,
        ownedAt: Timestamp.now(),
        equipped: false,
      });
    } else {
      // Same consolation the purchase path pays, for the same reason: a
      // duplicate that gives nothing reads as a broken chest.
      tx.set(
        db.doc(`users/${uid}/profile/data`),
        { spongeBalance: FieldValue.increment(chestRefund) },
        { merge: true },
      );
    }

    tx.set(chestRef, { openedAt: Timestamp.now() }, { merge: true });

    return {
      itemId: pick.itemId,
      name: pick.name,
      rarity: pick.rarity,
      type: pick.type,
      artUrl: pick.artUrl,
      isDuplicate,
      refund: isDuplicate ? chestRefund : 0,
    };
  });
});
