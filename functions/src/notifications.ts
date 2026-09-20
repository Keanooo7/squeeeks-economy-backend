// ---------------------------------------------------------------------------
// CRITICAL: THIS FILE IS NOT DEPLOYED. DO NOT PATCH IT AND EXPECT AN EFFECT.
// ---------------------------------------------------------------------------
//
// It exports `sendStreakReminder` and `sendDailyGiftReminder`, but nothing
// imports it and `main` is `lib/index.js`, so Firebase never discovers these
// — confirmed against production on 2026-08-05 (`functions:list` shows exactly
// one of each). The live copies are in `index.ts`, under "Push notification
// scheduled functions"; index.ts:166 says the same thing from the other side.
//
// WARNING: THE READS BELOW ARE THE OLD SHAPE ON PURPOSE. They fetch `users/{uid}`
// and take `.fcmToken` off it — the friend-readable location the token moved
// off in W2-132. The live crons read `users/{uid}/private/push` first and fall
// back to that field; see pushTokens.ts. This copy is left as it was rather
// than half-migrated, because a dead file that looks maintained is worse than
// one that obviously is not. Surfaced, not deleted: removing it is its own
// change, not a rider on a security fix.

import * as admin from 'firebase-admin';
// Modular import — see the note in index.ts: the emulator's admin proxy drops
// the statics off `admin.firestore`.
import { Timestamp } from 'firebase-admin/firestore';
import { onSchedule } from 'firebase-functions/v2/scheduler';

// Daily 8pm PT (03:00 UTC) — remind users who haven't completed a task today
export const sendStreakReminder = onSchedule('0 3 * * *', async () => {
  const today = new Date().toISOString().split('T')[0];

  // Query streak subcollections across all users via collection group
  const streakSnapshot = await admin.firestore()
    .collectionGroup('streaks')
    .where('currentStreak', '>', 0)
    .get();

  const userIds = new Set<string>();
  for (const doc of streakSnapshot.docs) {
    const data = doc.data();
    const lastDate = data.lastCompletionDate;
    // lastCompletionDate is stored as ISO string (YYYY-MM-DD portion)
    const lastDateStr = typeof lastDate === 'string'
      ? lastDate.split('T')[0]
      : (lastDate?.toDate?.()?.toISOString().split('T')[0] ?? '');
    if (lastDateStr < today) {
      // Parent path is users/{uid}/streaks/{streakId}
      const userId = doc.ref.parent.parent?.id;
      if (userId) userIds.add(userId);
    }
  }

  if (userIds.size === 0) return;

  const tokenDocs = await Promise.all(
    [...userIds].map(uid => admin.firestore().collection('users').doc(uid).get())
  );

  const messages = tokenDocs
    .filter(d => d.exists && d.data()?.fcmToken)
    .map(d => ({
      token: d.data()!.fcmToken as string,
      notification: {
        title: '🔥 Keep your streak alive!',
        body: "You haven't cleaned today yet.",
      },
      data: { type: 'streak_reminder' },
    }));

  if (messages.length === 0) return;
  await admin.messaging().sendEach(messages);
});

// Daily 10am PT (17:00 UTC) — remind users whose daily gift is ready to claim
export const sendDailyGiftReminder = onSchedule('0 17 * * *', async () => {
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;

  // DailyGift is stored at users/{uid}/dailyGift (single doc per user)
  const giftSnapshot = await admin.firestore()
    .collectionGroup('dailyGift')
    .get();

  const userIds: string[] = [];
  for (const doc of giftSnapshot.docs) {
    const data = doc.data();
    const lastClaim = data.lastClaimTime;
    const lastClaimMs = lastClaim instanceof Timestamp
      ? lastClaim.toMillis()
      : typeof lastClaim === 'string'
        ? new Date(lastClaim).getTime()
        : 0;
    if (lastClaimMs < cutoffMs) {
      const userId = doc.ref.parent.parent?.id;
      if (userId) userIds.push(userId);
    }
  }

  if (userIds.length === 0) return;

  const tokenDocs = await Promise.all(
    userIds.map(uid => admin.firestore().collection('users').doc(uid).get())
  );

  const messages = tokenDocs
    .filter(d => d.exists && d.data()?.fcmToken)
    .map(d => ({
      token: d.data()!.fcmToken as string,
      notification: {
        title: '🎁 Your daily gift is ready!',
        body: 'Tap to claim your sponges.',
      },
      data: { type: 'daily_gift' },
    }));

  if (messages.length === 0) return;
  await admin.messaging().sendEach(messages);
});
