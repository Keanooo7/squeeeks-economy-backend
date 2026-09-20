import { FieldValue } from 'firebase-admin/firestore';

/**
 * Sending a push batch, and clearing the tokens FCM says are dead.
 *
 * Both reminder crons used to call `sendEach(messages)` and discard the
 * returned `BatchResponse` entirely, so a token Apple/FCM had *permanently*
 * rejected was retried on every run, forever. Nothing ever removed one:
 * `fcmToken` had no server-side writer at all, only the client
 * (`lib/core/services/fcm_service.dart`).
 *
 * WARNING: This is NOT the account-switch defect fixed in #82. That token was live
 * and had been re-owned by a second account, and the fix was to clear it on
 * sign-out, client-side. These are tokens that are genuinely dead. Two
 * different defects with two different mechanisms — do not merge them.
 */

/**
 * The only error codes that may cause a token to be deleted.
 *
 * KEY: Deliberately just these two. Every other `sendEach` failure — quota,
 * `messaging/internal-error`, an auth blip, a timeout — is transient, and
 * pruning on those would turn one bad night at FCM into mass unsubscription of
 * healthy devices that would never come back. The bias is to keep a dead token
 * (costing one wasted send per day) over dropping a live one (costing the user
 * permanently). `pushTokens.test.ts` pins that with a transient-error case.
 */
export const PERMANENT_TOKEN_FAILURES: ReadonlySet<string> = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
]);

// ---------------------------------------------------------------------------
// Where the token lives — and why there are two answers
// ---------------------------------------------------------------------------
//
// `fcmToken` shipped on users/{uid}, whose read rule is
// `isOwner(uid) || isFriend(uid)`, so every accepted friend could read every
// friend's raw device token. It now belongs at users/{uid}/private/push,
// which is owner-only (see the match block in firestore.rules).
//
// CRITICAL: BOTH PATHS ARE READ, AND THAT IS NOT BELT-AND-BRACES — IT IS THE
// MIGRATION. The only writer is the client (fcm_service.dart), and a rules
// change cannot reach a build Apple already has. Until the client that writes
// the new path has shipped AND a given install has launched once under it,
// that user's token exists ONLY in the legacy field. Reading the new path
// alone would silently stop push for every install that had not updated —
// which is worse than the exposure this is fixing.
//
// WARNING: NO BACKFILL RUNS. The client rewrites its token on every launch, so the
// migration is each install's next cold start; users who never update keep a
// token in the old place and keep receiving push. Drop the legacy read only
// once that population is empty, not on a date.

/** `users/{uid}/private/push` — the owner-only home of the push token. */
export function pushTokenDocPath(uid: string): string {
  return `users/${uid}/private/push`;
}

/** `users/{uid}` — the friend-readable document the token is moving off. */
export function legacyPushTokenDocPath(uid: string): string {
  return `users/${uid}`;
}

/**
 * Which document a token was actually found in.
 *
 * Carried all the way through to the prune, because clearing a dead token
 * from the wrong document leaves the live one in place and re-sends to it
 * every day forever — the exact defect sendEachAndPruneDeadTokens exists to
 * fix, reintroduced by a half-done migration.
 */
export type PushTokenSource = 'private' | 'legacy';

/** One addressee: the token to push to, whose it is, and where it was found. */
export interface PushRecipient {
  uid: string;
  token: string;
  source: PushTokenSource;
}

/** The two documents that may hold one user's token, already read. */
export interface PushTokenEntry {
  uid: string;
  /** `users/{uid}/private/push` data; undefined when the doc is absent. */
  privateData?: Record<string, unknown>;
  /** `users/{uid}` data; undefined when the doc is absent. */
  legacyData?: Record<string, unknown>;
}

function readToken(data: Record<string, unknown> | undefined): string | null {
  const token = data?.fcmToken;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

/**
 * The token to push to, or null if this user has none.
 *
 * KEY: THE PRIVATE DOCUMENT WINS WHEN BOTH EXIST, and the tie is not arbitrary:
 * an install mid-migration writes the private path and then clears the legacy
 * field, so a document carrying both was caught between those two writes and
 * the private copy is the newer one. Preferring the legacy field would pin
 * such a user to whatever token their last pre-update launch recorded.
 */
export function resolvePushToken(
  entry: PushTokenEntry,
): { token: string; source: PushTokenSource } | null {
  const priv = readToken(entry.privateData);
  if (priv !== null) return { token: priv, source: 'private' };
  const legacy = readToken(entry.legacyData);
  if (legacy !== null) return { token: legacy, source: 'legacy' };
  return null;
}

/** The slice of `BatchResponse` this module reads. */
interface SendResponseLike {
  success: boolean;
  error?: { code?: string } | null;
}
interface BatchResponseLike {
  responses?: SendResponseLike[];
}

/** The slice of `admin.messaging()` this module calls. */
interface MessagingLike {
  sendEach(messages: unknown[]): Promise<BatchResponseLike | undefined>;
}

/**
 * The slice of Firestore this module writes through.
 *
 * `doc(path)` rather than `collection(c).doc(id)` because the two homes of a
 * token are at different depths — `users/{uid}` and `users/{uid}/private/push`
 * — and one addressing form that covers both keeps the prune from having to
 * branch on shape as well as on source.
 */
interface FirestoreLike {
  doc(path: string): { update(data: Record<string, unknown>): Promise<unknown> };
}

/**
 * Send one batch and clear the `fcmToken` of every recipient FCM permanently
 * rejected. Returns the uids pruned, for logging and for the tests.
 *
 * KEY: `recipients[i]` must correspond to `messages[i]`. `sendEach` guarantees
 * `responses[i]` is aligned with the input array, and that index is the *only*
 * link back to a user — the message objects carry a token and no uid. Building
 * the two arrays from one list in one pass is what keeps them aligned; the
 * previous code lost the correspondence at its `.filter(...)`, which is exactly
 * where a uid could go missing without the array length looking wrong.
 */
export async function sendEachAndPruneDeadTokens(
  messaging: MessagingLike,
  db: FirestoreLike,
  recipients: readonly PushRecipient[],
  messages: readonly unknown[],
): Promise<string[]> {
  if (messages.length === 0) return [];

  const batch = await messaging.sendEach([...messages]);

  // A mock or an older SDK may hand back nothing; that is not a reason to
  // delete anybody's token.
  const responses = batch?.responses;
  if (!Array.isArray(responses)) return [];

  const dead: PushRecipient[] = [];
  responses.forEach((response, i) => {
    if (response?.success) return;
    const code = response?.error?.code;
    if (!code || !PERMANENT_TOKEN_FAILURES.has(code)) return;
    const recipient = recipients[i];
    if (recipient) dead.push(recipient);
  });

  if (dead.length === 0) return [];

  await Promise.all(
    dead.map(({ uid, source }) =>
      db
        .doc(source === 'private'
          ? pushTokenDocPath(uid)
          : legacyPushTokenDocPath(uid))
        .update({ fcmToken: FieldValue.delete() })
        // A user doc deleted between the read and here would reject the update
        // and take the whole cron down with it. Pruning is opportunistic
        // cleanup; it must never fail the send it is cleaning up after.
        .catch((error: unknown) => {
          console.error(`Failed to clear dead fcmToken for ${uid}`, error);
        }),
    ),
  );

  console.log(`Cleared ${dead.length} permanently-dead push token(s)`);
  return dead.map((recipient) => recipient.uid);
}

/**
 * Turn the documents a reminder cron just read into aligned recipient and
 * message arrays.
 *
 * A user with no token in either document is skipped entirely rather than
 * pushed with an empty string, which FCM rejects as an invalid-argument and
 * which the prune would then read as a permanently dead token.
 */
export function buildPushBatch<T>(
  entries: readonly PushTokenEntry[],
  toMessage: (token: string) => T,
): { recipients: PushRecipient[]; messages: T[] } {
  const recipients: PushRecipient[] = [];
  const messages: T[] = [];
  for (const entry of entries) {
    const resolved = resolvePushToken(entry);
    if (resolved === null) continue;
    recipients.push({ uid: entry.uid, token: resolved.token, source: resolved.source });
    messages.push(toMessage(resolved.token));
  }
  return { recipients, messages };
}

// ---------------------------------------------------------------------------
// Counting the un-migrated population — the number both remaining moves need
// ---------------------------------------------------------------------------
//
// The migration note above ends on a condition rather than a date: drop the
// legacy read "once that population is empty". Nobody has ever measured that
// population, so BOTH remaining moves are blocked on the same unknown — the
// server-side sweep that would delete the exposed legacy field, and the removal
// of the legacy read itself. This section is the measurement, and nothing else:
// it counts, it never writes.
//
// CRITICAL: THREE COUNTS, NOT ONE, AND THE THIRD IS THE ONE THAT MATTERS. A single
// "how many are un-migrated" cannot separate "nobody is un-migrated" from
// "nobody has a token at all", and those have opposite consequences: the first
// unblocks the sweep, the second means the scan found nothing and proves
// nothing. `neither` is reported for exactly that reason.
//
// WARNING: CLASSIFYING A BOTH-PRESENT USER AS legacy-only IS THE ERROR THAT FREEZES
// THE MIGRATION FOREVER. A user mid-migration carries a token in both places
// and is already migrated as far as `resolvePushToken` is concerned — it takes
// the private one. Counting them as legacy-only makes the blocking population
// look permanently non-empty, so the condition above can never be met and the
// legacy read can never be dropped. `classifyPushTokenMigration` therefore
// tests `both` FIRST, and pushTokenCensus.test.ts mutates that order.

/**
 * Where one user's token lives, as a census bucket.
 *
 * KEY: These are the four states of the two documents, not four kinds of user —
 * `neither` includes every account that has simply never granted push.
 */
export type PushTokenMigrationState =
  | 'legacy-only'
  | 'private-only'
  | 'both'
  | 'neither';

/**
 * Which bucket this user falls in.
 *
 * KEY: BUILT ON `readToken`, THE SAME PREDICATE `resolvePushToken` USES, so the
 * census and the resolver cannot drift into disagreeing about what a token is.
 * An empty string and a non-string are not tokens in either place; a census
 * that counted them would report a legacy population the senders never see.
 */
export function classifyPushTokenMigration(
  entry: PushTokenEntry,
): PushTokenMigrationState {
  const hasPrivate = readToken(entry.privateData) !== null;
  const hasLegacy = readToken(entry.legacyData) !== null;
  if (hasPrivate && hasLegacy) return 'both';
  if (hasPrivate) return 'private-only';
  if (hasLegacy) return 'legacy-only';
  return 'neither';
}

/** The census: how many users sit in each of the four states. */
export interface PushTokenCensus {
 /** CRITICAL: The population that blocks the sweep AND the legacy-read removal. */
  legacyOnly: number;
  /** Migrated: the token is only in the owner-only document. */
  privateOnly: number;
  /** Mid-migration: both documents carry one. Already served from `private`. */
  both: number;
  /** No token anywhere. Not a blocker, and not evidence of migration either. */
  neither: number;
  /** Every user the scan saw, in any state. */
  total: number;
}

/** Tally [entries] into a census. Pure; the reads happen in the caller. */
export function tallyPushTokenMigration(
  entries: Iterable<PushTokenEntry>,
): PushTokenCensus {
  const census: PushTokenCensus = {
    legacyOnly: 0,
    privateOnly: 0,
    both: 0,
    neither: 0,
    total: 0,
  };
  for (const entry of entries) {
    census.total += 1;
    switch (classifyPushTokenMigration(entry)) {
      case 'both':
        census.both += 1;
        break;
      case 'private-only':
        census.privateOnly += 1;
        break;
      case 'legacy-only':
        census.legacyOnly += 1;
        break;
      case 'neither':
        census.neither += 1;
        break;
    }
  }
  return census;
}

/**
 * The document id under `users/{uid}/private/` that holds the push token.
 *
 * `pushTokenDocPath` builds the path a writer uses; the census arrives from the
 * other direction — a collection-group scan hands back documents and has to
 * decide which are push tokens — so the leaf id is named once, here, and both
 * directions read it.
 */
export const PUSH_TOKEN_DOC_ID = 'push';

/** A `DocumentReference`, structurally: an id and the chain above it. */
interface CensusDocumentRef {
  id: string;
  parent: { id: string; parent: CensusDocumentRef | null };
}

/** A `QueryDocumentSnapshot`, structurally. */
interface CensusDocument {
  id: string;
  ref: CensusDocumentRef;
  data(): Record<string, unknown> | undefined;
}

interface CensusQuery {
  get(): Promise<{ docs: CensusDocument[] }>;
}

/**
 * The slice of Firestore the census reads through.
 *
 * CRITICAL: THERE IS NO WRITE METHOD ON THIS INTERFACE, AND THAT IS THE POINT. The
 * census runs against production data if it runs anywhere useful, and the whole
 * hazard of this brief is a destructive sweep shipped before the number that
 * justifies it. A reader that structurally CANNOT write is worth more than a
 * `--dry-run` flag somebody can forget to pass.
 */
export interface CensusFirestoreLike {
  collection(path: string): { select(...fields: string[]): CensusQuery };
  collectionGroup(collectionId: string): CensusQuery;
}

/**
 * The uid a `users/{uid}/private/push` document belongs to, or null if this
 * document is not one.
 *
 * WARNING: A COLLECTION-GROUP SCAN MATCHES BY COLLECTION ID ALONE, at any depth and
 * anywhere in the tree. `collectionGroup('shop')` in index.ts already has to
 * skip the TOP-LEVEL `shop/current` document with a doc-id guard, and a
 * `private` subcollection under something other than a user would be counted
 * here in exactly the same way. So the full shape is checked — leaf id `push`,
 * inside a `private` collection, whose parent document sits in `users` — rather
 * than trusting the collection id that selected the document in the first
 * place.
 */
export function pushTokenOwnerUid(doc: CensusDocument): string | null {
  if (doc.id !== PUSH_TOKEN_DOC_ID) return null;
  if (doc.ref.parent.id !== 'private') return null;
  const userDoc = doc.ref.parent.parent;
  if (userDoc === null) return null;
  if (userDoc.parent.id !== 'users') return null;
  return userDoc.id;
}

/**
 * Read every user's two token homes and tally the four states.
 *
 * KEY: TWO QUERIES, NOT TWO READS PER USER. `readPushTokenEntries` in index.ts
 * reads a known handful of uids and can afford a pair of gets each; a census
 * covers everybody, so it takes one projected scan of `users` and one
 * collection-group scan of `private`. The cost is one document read per user
 * plus one per existing private document — not two per user.
 *
 * WARNING: `select('fcmToken')` PROJECTS, IT DOES NOT FILTER. Every user document
 * comes back, including those with no token, which is what makes `total` and
 * `neither` meaningful. A `where('fcmToken','!=',null)` would have been cheaper
 * and would have silently answered a different question.
 *
 * NOTE: A user with a private token and no `users/{uid}` document still counts —
 * the private scan adds uids the users scan never saw. Dropping them would
 * under-report the migrated population.
 */
export async function readPushTokenCensus(
  db: CensusFirestoreLike,
): Promise<PushTokenCensus> {
  const [userDocs, privateDocs] = await Promise.all([
    db.collection('users').select('fcmToken').get(),
    db.collectionGroup('private').get(),
  ]);

  const entries = new Map<string, PushTokenEntry>();
  for (const doc of userDocs.docs) {
    entries.set(doc.id, { uid: doc.id, legacyData: doc.data() });
  }
  for (const doc of privateDocs.docs) {
    const uid = pushTokenOwnerUid(doc);
    if (uid === null) continue;
    const existing = entries.get(uid);
    if (existing) existing.privateData = doc.data();
    else entries.set(uid, { uid, privateData: doc.data() });
  }

  return tallyPushTokenMigration(entries.values());
}
