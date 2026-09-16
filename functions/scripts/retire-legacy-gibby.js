'use strict';

/**
 * retire-legacy-gibby.js
 *
 * Removes the HAND-SEEDED Gibby that predates the Cloud Function.
 *
 * Gibby is now a real, permanent, Auth-backed friend under the uid `gibby`,
 * created by the onNewUserBefriendGibby trigger and repaired for existing
 * accounts by POSTing to backfillGibbyFriendship. Two scripts used to do this
 * job by hand under the uid `gibby-test-uid`, and both were broken:
 *
 *   seed-gibby.js       wrote users/gibby-test-uid with displayName in
 *                       Firestore. Nothing reads displayName from there — the
 *                       publicProfiles projection sources it from the Firebase
 *                       Auth record, and there was no Auth record — so the
 *                       friend rendered nameless.
 *   set-gibby-avatar.js merge-wrote users/gibby-test-uid.avatarUrl, which fired
 *                       syncPublicProfile, which found no Auth record and reset
 *                       the projection's displayName to ''.
 *
 * Both are deleted. Left in place, the legacy uid shows up as a SECOND,
 * nameless Gibby in the friends list of any account that was seeded with it.
 * This script removes it. It is idempotent and safe to run when there is
 * nothing to remove.
 *
 * Usage:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json \
 *     node scripts/retire-legacy-gibby.js [--dry-run]
 */

const LEGACY_UID = 'gibby-test-uid';

if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    'Set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json',
  );
  process.exit(1);
}

const dryRun = process.argv.includes('--dry-run');

const admin = require('firebase-admin');
admin.initializeApp();
const db = admin.firestore();

async function main() {
  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Retiring legacy Gibby (${LEGACY_UID})...\n`,
  );

  const targets = [
    `users/${LEGACY_UID}`,
    `users/${LEGACY_UID}/profile/data`,
    `users/${LEGACY_UID}/house/layout`,
    `publicProfiles/${LEGACY_UID}`,
  ];

  // Friend edges pointing AT the legacy uid, from whichever accounts were
  // seeded with it. Walking users is cheap here and does not assume a DEV_UID
  // the way the old script did.
  const usersSnap = await db.collection('users').get();
  for (const userDoc of usersSnap.docs) {
    if (userDoc.id === LEGACY_UID) continue;
    const edge = await db
      .doc(`users/${userDoc.id}/friends/${LEGACY_UID}`)
      .get();
    if (edge.exists) targets.push(`users/${userDoc.id}/friends/${LEGACY_UID}`);
  }

  // The legacy uid's own friends subcollection.
  const legacyFriends = await db
    .collection(`users/${LEGACY_UID}/friends`)
    .get();
  for (const f of legacyFriends.docs) {
    targets.push(`users/${LEGACY_UID}/friends/${f.id}`);
  }

  // Gift invites the old seed script planted in inboxes.
  for (const userDoc of usersSnap.docs) {
    const invites = await db
      .collection(`users/${userDoc.id}/giftInvites`)
      .where('fromUid', '==', LEGACY_UID)
      .get();
    for (const inv of invites.docs) {
      targets.push(`users/${userDoc.id}/giftInvites/${inv.id}`);
    }
  }

  if (targets.length === 0) {
    console.log('  Nothing to remove — already clean.\n');
    return;
  }

  for (const path of targets) {
    console.log(`  ${dryRun ? 'would delete' : 'deleting'}  ${path}`);
    if (!dryRun) await db.doc(path).delete();
  }

  console.log(
    `\n${dryRun ? '[DRY RUN] ' : ''}Done — ${targets.length} path(s).\n`,
  );
  if (!dryRun) {
    console.log('The Auth record, if any, is left alone: this uid was never');
    console.log('an Auth user, and deleting one is not a scripted action.\n');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('retire-legacy-gibby failed:', err);
    process.exit(1);
  });
