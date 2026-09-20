// ---------------------------------------------------------------------------
// XP progression config + server-side award helper
// ---------------------------------------------------------------------------
//
// totalXp lives at users/{uid}/profile/data and is written EXCLUSIVELY by
// Cloud Functions via the Admin SDK — firestore.rules puts it in the profile
// client-write denylist alongside spongeBalance. The client streams it
// read-only (totalXpStreamProvider) and derives level/ring locally.

import * as admin from 'firebase-admin';
// Modular import — see the note in index.ts: the emulator's admin proxy drops
// the statics off `admin.firestore`.
import { FieldValue } from 'firebase-admin/firestore';

// Tunable constants — mirror these values in
// lib/features/progression/domain/level_curve.dart (kXpBase / kXpStep).
export const XP_BASE = 100;   // XP to reach level 2
export const XP_STEP = 50;    // additional XP each successive level costs

// Per-action awards
export const XP_TASK       = 10;
export const XP_CHEST      = 25;
export const XP_GIFT_CLAIM = 15;

/**
 * WHERE XP LIVES. One definition, so there is exactly one answer to "which
 * document and which field is totalXp".
 *
 * KEY: These exist because W2-12 needed to award XP from INSIDE a transaction
 * (quest rewards must commit atomically with `claimedTiers`, or a tier can be
 * marked claimed while its XP is lost — and XP is permanent progression that
 * cannot be walked back). `awardXp` below is deliberately non-transactional, so
 * it cannot be called there. Rather than let a second caller hardcode the path
 * and silently drift, both callers now name the same constants.
 *
 * WARNING: If XP ever moves document, change it HERE and both writers follow.
 */
export const xpDocPath = (uid: string): string => `users/${uid}/profile/data`;
export const XP_FIELD = 'totalXp';

/**
 * Server-only. Increments totalXp for [uid] by [amount].
 *
 * Writes to users/{uid}/profile/data.totalXp via FieldValue.increment. Uses
 * set + merge (not update()) so an award for a user whose profile doc doesn't
 * exist yet can never fail with NOT_FOUND — the same pattern as every other
 * economy write in index.ts. Logs [reason] for auditability.
 */
export async function awardXp(
  uid: string,
  amount: number,
  reason: string
): Promise<void> {
  await admin.firestore().doc(xpDocPath(uid)).set(
    { [XP_FIELD]: FieldValue.increment(amount) },
    { merge: true }
  );
  console.log(`awardXp: +${amount} XP to ${uid} (${reason})`);
}
