// ---------------------------------------------------------------------------
// publicProfiles/{uid} — the CF-owned public projection of users/{uid}
// ---------------------------------------------------------------------------
//
// Firestore has no field-level read security: a rule either exposes a document
// or it does not. On users/{uid} the four display-safe fields below share a
// document with fcmToken, subscriptionTier and subscriptionExpiresAt, so no
// `allow list` broad enough to let searchUsers run could avoid handing every
// authenticated client the entire user document. This projection is the
// separation — see the match block in firestore.rules.
//
// It fixes two defects from the 2026-08-03 friends audit:
//   F3  searchUsers listed users where isPublic == true, which the
//       users/{uid} read rule (isOwner || isFriend) cannot satisfy.
//   F5  getFriends read a profile per friend entry; for a PENDING friend that
//       read threw permission-denied and took the whole Friends tab down.
//
// displayName is NOT sourced from users/{uid}. Nothing has ever written it
// there — signup calls updateDisplayName() on the Firebase Auth record
// (auth_repository_impl.dart:69) and touches Firestore not at all, so every
// read of users/{uid}.displayName has always resolved to ''. The name lives in
// Auth, and the trigger reads it from there. That also means existing accounts
// project correctly on backfill with no client change.

/** The exact key set written to publicProfiles/{uid}. */
export const PUBLIC_PROFILE_FIELDS = [
  'displayName',
  'avatarUrl',
  'cleanlinessScore',
  'isPublic',
] as const;

/**
 * The subset of users/{uid} the projection derives from. Changes to any other
 * field must not cost a projection write — see projectionChanged.
 */
const SOURCE_FIELDS = ['avatarUrl', 'cleanlinessScore', 'isPublic'] as const;

export interface PublicProfile {
  displayName: string;
  avatarUrl: string;
  cleanlinessScore: number;
  isPublic: boolean;
}

/**
 * Builds the projection from a users/{uid} document and the display name off
 * the Firebase Auth record.
 *
 * Every field defaults, because users/{uid} has no authoritative creation
 * point — it is upserted opportunistically by the FCM token write, the
 * discoverability toggle, the avatar picker and claimWelcomeChest, so any
 * subset of fields may be absent. isPublic is compared with === true rather
 * than coerced, so a missing field can never read as discoverable.
 */
export function buildPublicProfile(
  userData: Record<string, unknown> | undefined,
  authDisplayName: string | undefined
): PublicProfile {
  const data = userData ?? {};
  const score = data.cleanlinessScore;
  return {
    displayName: authDisplayName ?? '',
    avatarUrl: typeof data.avatarUrl === 'string' ? data.avatarUrl : '',
    cleanlinessScore: typeof score === 'number' && Number.isFinite(score)
      ? score
      : 0,
    isPublic: data.isPublic === true,
  };
}

/**
 * True when a write to users/{uid} could have changed the projection.
 *
 * The trigger fires on EVERY write to users/{uid}, and most of them are
 * irrelevant — fcmToken refreshes, subscription renewals, orientation flags.
 * Without this guard each one would cost an Auth lookup plus a projection
 * write. Returns true when the document is created or deleted, since the
 * projection has to appear or disappear either way.
 *
 * Note this cannot detect a Firebase Auth displayName change on its own; a
 * rename only reaches the projection on the user's next users/{uid} write.
 * Acceptable because the app has no rename UI today — flagged rather than
 * solved, since solving it needs a blocking Identity Platform trigger.
 */
export function projectionChanged(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined
): boolean {
  if (before === undefined || after === undefined) return true;
  return SOURCE_FIELDS.some((field) => before[field] !== after[field]);
}
