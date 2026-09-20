/**
 * The push-token pruning contract, and the two places a token can live.
 *
 * Two tests here are decisive and the rest are scaffolding around them.
 *
 *   1. The transient-error case. Pruning on *any* send failure rather than on
 *      the two permanent-failure codes would turn a bad night at FCM into mass
 *      unsubscription — and it would look correct in every other test here.
 *
 *   2. The prune-path cases. The token is moving off the friend-readable
 *      `users/{uid}` onto the owner-only `users/{uid}/private/push`, and both
 *      are read during the rollout. A prune that clears the field from a fixed
 *      path deletes nothing for half the population while the send that
 *      triggered it keeps firing at the same dead token every day — the exact
 *      defect this module was written to fix, reintroduced by the migration.
 *      The fake Firestore therefore records the full document PATH, not just
 *      the uid — a uid-only assertion cannot see a prune sent to the wrong
 *      document, because the uid is right in both.
 */
import {
  sendEachAndPruneDeadTokens,
  buildPushBatch,
  resolvePushToken,
  pushTokenDocPath,
  legacyPushTokenDocPath,
  PERMANENT_TOKEN_FAILURES,
  type PushRecipient,
  type PushTokenSource,
} from '../pushTokens';

// FieldValue.delete() is a sentinel; the real one needs no app, but stubbing it
// keeps the assertion readable and independent of SDK internals.
jest.mock('firebase-admin/firestore', () => ({
  FieldValue: { delete: () => '__DELETE__' },
}));

const NOT_REGISTERED = 'messaging/registration-token-not-registered';
const INVALID_TOKEN = 'messaging/invalid-registration-token';
const TRANSIENT = 'messaging/internal-error';

function ok() {
  return { success: true };
}
function fail(code: string) {
  return { success: false, error: { code } };
}

/** A Firestore double that records the full path of every update. */
function fakeDb() {
  const updates: { path: string; data: Record<string, unknown> }[] = [];
  const db = {
    doc: (path: string) => ({
      update: async (data: Record<string, unknown>) => {
        updates.push({ path, data });
        return undefined;
      },
    }),
  };
  return { db, updates };
}

type FakeResponse = { success: boolean; error?: { code?: string } | null };

function fakeMessaging(responses: FakeResponse[]) {
  const sendEach = jest.fn(async () => ({ responses }));
  return { messaging: { sendEach }, sendEach };
}

/**
 * Recipients whose token was found in the legacy document — the shape every
 * install has until it launches once under the client that writes the new
 * path.
 */
function recipientsFor(...uids: string[]): PushRecipient[] {
  return uids.map((uid) => ({ uid, token: `tok-${uid}`, source: 'legacy' as const }));
}

function recipient(uid: string, source: PushTokenSource): PushRecipient {
  return { uid, token: `tok-${uid}`, source };
}

describe('resolvePushToken — which document holds the token', () => {
  test('a token only in the private document is used, and named private', () => {
    expect(
      resolvePushToken({ uid: 'a', privateData: { fcmToken: 'new-tok' } }),
    ).toEqual({ token: 'new-tok', source: 'private' });
  });

  test('a token only in the legacy field is still used', () => {
    // KEY: The install that has not updated. Reading the private path alone
    // would silently stop push for every one of them, which is worse than the
    // exposure being fixed.
    expect(
      resolvePushToken({ uid: 'a', legacyData: { fcmToken: 'old-tok' } }),
    ).toEqual({ token: 'old-tok', source: 'legacy' });
  });

  test('THE PRIVATE DOCUMENT WINS when both carry a token', () => {
    // KEY: The decisive tie. A document carrying both was caught between the
    // client's write of the new path and its clear of the old field, so the
    // private copy is the newer one. Preferring legacy would pin the user to
    // whatever their last pre-update launch recorded — a token that may
    // already have been reissued.
    expect(
      resolvePushToken({
        uid: 'a',
        privateData: { fcmToken: 'new-tok' },
        legacyData: { fcmToken: 'old-tok' },
      }),
    ).toEqual({ token: 'new-tok', source: 'private' });
  });

  test('an empty string in the private document falls through to legacy', () => {
    // An empty token is not a token. Treating it as one would send FCM an
    // invalid-argument, and the prune would then read that as a dead device.
    expect(
      resolvePushToken({
        uid: 'a',
        privateData: { fcmToken: '' },
        legacyData: { fcmToken: 'old-tok' },
      }),
    ).toEqual({ token: 'old-tok', source: 'legacy' });
  });

  test('a non-string token in either place is not a token', () => {
    expect(
      resolvePushToken({
        uid: 'a',
        privateData: { fcmToken: 12345 },
        legacyData: { fcmToken: { nested: true } },
      }),
    ).toBeNull();
  });

  test('neither document present resolves to nothing', () => {
    expect(resolvePushToken({ uid: 'a' })).toBeNull();
  });

  test('the two paths are the friend-readable doc and its owner-only child', () => {
    expect(legacyPushTokenDocPath('uid-1')).toBe('users/uid-1');
    expect(pushTokenDocPath('uid-1')).toBe('users/uid-1/private/push');
  });
});

describe('sendEachAndPruneDeadTokens', () => {
  test('a permanently-dead token clears THAT user and only that user', async () => {
    const { db, updates } = fakeDb();
    const { messaging } = fakeMessaging([ok(), fail(NOT_REGISTERED), ok()]);

    const pruned = await sendEachAndPruneDeadTokens(
      messaging,
      db,
      recipientsFor('alice', 'bob', 'carol'),
      [{}, {}, {}],
    );

    expect(pruned).toEqual(['bob']);
    expect(updates).toEqual([
      { path: 'users/bob', data: { fcmToken: '__DELETE__' } },
    ]);
  });

  test('a private-sourced token is cleared from the PRIVATE document', async () => {
    // KEY: The migration's decisive prune case. A prune hard-coded to
    // users/{uid} would write a delete for a field that is not there and leave
    // the real dead token in place, so the next cron sends to it again.
    const { db, updates } = fakeDb();
    const { messaging } = fakeMessaging([fail(NOT_REGISTERED)]);

    const pruned = await sendEachAndPruneDeadTokens(
      messaging,
      db,
      [recipient('alice', 'private')],
      [{}],
    );

    expect(pruned).toEqual(['alice']);
    expect(updates).toEqual([
      { path: 'users/alice/private/push', data: { fcmToken: '__DELETE__' } },
    ]);
  });

  test('a mixed batch clears each user from the document it was read from', async () => {
    // The realistic rollout state: some installs updated, some not. Getting
    // this wrong is invisible in a uid-only assertion.
    const { db, updates } = fakeDb();
    const { messaging } = fakeMessaging([
      fail(NOT_REGISTERED),
      ok(),
      fail(INVALID_TOKEN),
    ]);

    const pruned = await sendEachAndPruneDeadTokens(
      messaging,
      db,
      [
        recipient('updated', 'private'),
        recipient('healthy', 'private'),
        recipient('stale', 'legacy'),
      ],
      [{}, {}, {}],
    );

    expect(pruned).toEqual(['updated', 'stale']);
    expect(updates).toEqual([
      { path: 'users/updated/private/push', data: { fcmToken: '__DELETE__' } },
      { path: 'users/stale', data: { fcmToken: '__DELETE__' } },
    ]);
  });

  test('a TRANSIENT error clears nothing', async () => {
    // KEY: The test that matters. messaging/internal-error is a bad night at FCM,
    // not a dead device — pruning on it would unsubscribe healthy users
    // permanently, and they would never get a notification again.
    const { db, updates } = fakeDb();
    const { messaging } = fakeMessaging([fail(TRANSIENT), fail(TRANSIENT), ok()]);

    const pruned = await sendEachAndPruneDeadTokens(
      messaging,
      db,
      recipientsFor('alice', 'bob', 'carol'),
      [{}, {}, {}],
    );

    expect(pruned).toEqual([]);
    expect(updates).toEqual([]);
  });

  test('a mix prunes only the permanent failures', async () => {
    const { db, updates } = fakeDb();
    const { messaging } = fakeMessaging([
      fail(TRANSIENT),
      fail(NOT_REGISTERED),
      ok(),
      fail(INVALID_TOKEN),
      fail('messaging/server-unavailable'),
    ]);

    const pruned = await sendEachAndPruneDeadTokens(
      messaging,
      db,
      recipientsFor('a', 'b', 'c', 'd', 'e'),
      [{}, {}, {}, {}, {}],
    );

    expect(pruned).toEqual(['b', 'd']);
    expect(updates.map((u) => u.path)).toEqual(['users/b', 'users/d']);
  });

  test('index→uid mapping holds when the failure is not first', async () => {
    // The regression lock on the alignment bug this change exists to avoid:
    // the message objects carry a token and no uid, so responses[i] is the only
    // link back to a user. An off-by-one here deletes an innocent user's token.
    const { db, updates } = fakeDb();
    const { messaging } = fakeMessaging([ok(), ok(), ok(), fail(NOT_REGISTERED)]);

    const pruned = await sendEachAndPruneDeadTokens(
      messaging,
      db,
      recipientsFor('w', 'x', 'y', 'z'),
      [{}, {}, {}, {}],
    );

    expect(pruned).toEqual(['z']);
    expect(updates).toEqual([
      { path: 'users/z', data: { fcmToken: '__DELETE__' } },
    ]);
  });

  test('index→SOURCE mapping holds when the failure is not first', async () => {
    // The same off-by-one, on the axis the migration added. Here every uid is
    // legacy except the one that fails, so a prune reading the wrong index
    // picks the wrong DOCUMENT while still naming the right user — a failure
    // the uid assertion above cannot see.
    const { db, updates } = fakeDb();
    const { messaging } = fakeMessaging([ok(), ok(), fail(NOT_REGISTERED)]);

    await sendEachAndPruneDeadTokens(
      messaging,
      db,
      [
        recipient('w', 'legacy'),
        recipient('x', 'legacy'),
        recipient('y', 'private'),
      ],
      [{}, {}, {}],
    );

    expect(updates).toEqual([
      { path: 'users/y/private/push', data: { fcmToken: '__DELETE__' } },
    ]);
  });

  test('an empty batch sends nothing at all', async () => {
    const { db, updates } = fakeDb();
    const { messaging, sendEach } = fakeMessaging([]);

    const pruned = await sendEachAndPruneDeadTokens(messaging, db, [], []);

    expect(sendEach).not.toHaveBeenCalled();
    expect(pruned).toEqual([]);
    expect(updates).toEqual([]);
  });

  test('a response array that never arrives prunes nobody', async () => {
    // An older SDK or a test double can return undefined. That is not evidence
    // any token is dead, so it must not be treated as such.
    const { db, updates } = fakeDb();
    const messaging = { sendEach: jest.fn(async () => undefined) };

    const pruned = await sendEachAndPruneDeadTokens(
      messaging,
      db,
      recipientsFor('alice'),
      [{}],
    );

    expect(pruned).toEqual([]);
    expect(updates).toEqual([]);
  });

  test('a failed prune write does not fail the send', async () => {
    // Pruning is opportunistic cleanup running inside a cron. A user doc
    // deleted between the read and the write must not take the whole run down.
    const db = {
      doc: () => ({ update: async () => { throw new Error('NOT_FOUND'); } }),
    };
    const { messaging } = fakeMessaging([fail(NOT_REGISTERED)]);

    await expect(
      sendEachAndPruneDeadTokens(messaging, db, recipientsFor('ghost'), [{}]),
    ).resolves.toEqual(['ghost']);
  });

  test('only the two permanent codes are listed', () => {
    expect([...PERMANENT_TOKEN_FAILURES].sort()).toEqual([
      'messaging/invalid-registration-token',
      'messaging/registration-token-not-registered',
    ]);
  });
});

describe('buildPushBatch', () => {
  test('recipients and messages stay index-aligned across skipped users', () => {
    // The alignment the old `.filter(...).map(...)` produced correctly for the
    // messages and threw away for the uids.
    const { recipients, messages } = buildPushBatch(
      [
        { uid: 'alice', legacyData: { fcmToken: 'tok-a' } },
        { uid: 'nodoc' },
        { uid: 'notoken', legacyData: { fcmToken: undefined } },
        { uid: 'bob', privateData: { fcmToken: 'tok-b' } },
      ],
      (token) => ({ token }),
    );

    expect(recipients).toEqual([
      { uid: 'alice', token: 'tok-a', source: 'legacy' },
      { uid: 'bob', token: 'tok-b', source: 'private' },
    ]);
    expect(messages).toEqual([{ token: 'tok-a' }, { token: 'tok-b' }]);
    recipients.forEach((r, i) => expect(messages[i]).toEqual({ token: r.token }));
  });

  test('an empty-string token is skipped, not sent', () => {
    const { recipients, messages } = buildPushBatch(
      [
        { uid: 'alice', legacyData: { fcmToken: '' } },
        { uid: 'bob', legacyData: { fcmToken: 'tok-b' } },
      ],
      (token) => ({ token }),
    );

    expect(recipients).toEqual([{ uid: 'bob', token: 'tok-b', source: 'legacy' }]);
    expect(messages).toEqual([{ token: 'tok-b' }]);
  });

  test('a user carrying both tokens is pushed once, at the private one', () => {
    // The batch must not double-send to a user caught mid-migration.
    const { recipients, messages } = buildPushBatch(
      [
        {
          uid: 'midway',
          privateData: { fcmToken: 'tok-new' },
          legacyData: { fcmToken: 'tok-old' },
        },
      ],
      (token) => ({ token }),
    );

    expect(recipients).toEqual([
      { uid: 'midway', token: 'tok-new', source: 'private' },
    ]);
    expect(messages).toEqual([{ token: 'tok-new' }]);
  });
});
