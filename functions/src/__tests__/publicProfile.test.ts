/**
 * Tests for the publicProfiles/{uid} projection — the pure builders in
 * publicProfile.ts and the syncPublicProfile / backfillPublicProfiles handlers
 * in index.ts.
 *
 * Why the projection exists: Firestore has no field-level read security, and
 * on users/{uid} displayName-adjacent fields share a document with fcmToken
 * and subscriptionTier, so no rule could unblock searchUsers (F3) or a pending
 * friend's profile read (F5) without exposing the whole user document. The
 * rules half of this is covered in firestore-rules.test.ts.
 *
 * The subtle case worth reading: displayName is sourced from the Firebase Auth
 * record, not from users/{uid}. Nothing has ever written it to Firestore, so
 * every historical read of users/{uid}.displayName resolved to ''.
 */
import {
  PUBLIC_PROFILE_FIELDS,
  buildPublicProfile,
  projectionChanged,
} from '../publicProfile';

const _db: {
  doc: jest.Mock;
  collection: jest.Mock;
  batch: jest.Mock;
  runTransaction: jest.Mock;
} = {
  doc: jest.fn(),
  collection: jest.fn(),
  batch: jest.fn(),
  runTransaction: jest.fn(),
};

const _auth: { getUser: jest.Mock } = { getUser: jest.fn() };

jest.mock('firebase-admin', () => {
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = {
    increment: (n: number) => ({ _type: 'increment', n }),
  };
  firestoreFn.Timestamp = {
    now: () => ({ seconds: 0, nanoseconds: 0 }),
  };
  return {
    initializeApp: jest.fn(),
    firestore: firestoreFn,
    auth: jest.fn(() => _auth),
    messaging: jest.fn(() => ({ send: jest.fn() })),
  };
});

// index.ts imports Timestamp/FieldValue from 'firebase-admin/firestore' rather
// than off the admin.firestore namespace — the Functions emulator's admin
// proxy drops those statics. Re-export the same sentinels so both import
// styles resolve to one fake.
jest.mock('firebase-admin/firestore', () => {
  const admin = jest.requireMock('firebase-admin') as any;
  return {
    FieldValue: admin.firestore.FieldValue,
    Timestamp: admin.firestore.Timestamp,
  };
});

jest.mock('firebase-functions/v2/https', () => ({
  onCall: (...args: any[]) => ({ _handler: args[args.length - 1] }),
  // onRequest(handler) AND onRequest(opts, handler) — the secret-bound admin
  // endpoints use the second form, and a single-arg mock silently captures the
  // options object as the handler.
  onRequest: (...args: any[]) => ({ _handler: args[args.length - 1] }),
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: (_schedule: string, handler: () => any) => ({ _handler: handler }),
}));

// The codebase's first Firestore trigger, so this mock is new. Same shape as
// the others: strip the registration and hand back the raw handler.
jest.mock('firebase-functions/v2/firestore', () => ({
  onDocumentWritten: (_path: string, handler: any) => ({ _handler: handler }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { syncPublicProfile, backfillPublicProfiles } = require('../index') as {
  syncPublicProfile: { _handler: (event: any) => Promise<void> };
  backfillPublicProfiles: { _handler: (req: any, res: any) => Promise<void> };
};

/** Builds the Change<DocumentSnapshot> shape a Firestore trigger receives. */
function writeEvent(
  uid: string,
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined
) {
  return {
    params: { uid },
    data: {
      before: { exists: before !== undefined, data: () => before },
      after: { exists: after !== undefined, data: () => after },
    },
  };
}

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('buildPublicProfile', () => {
  it('projects only the four display-safe fields', () => {
    const result = buildPublicProfile(
      {
        avatarUrl: 'duck',
        cleanlinessScore: 73,
        isPublic: true,
        // Everything below shares the document and must NOT be projected —
        // this is the entire reason the collection exists.
        fcmToken: 'token-abc',
        subscriptionTier: 'premium',
        subscriptionExpiresAt: '2027-01-01',
        orientationCompleted: true,
      },
      'Brendan'
    );

    expect(result).toEqual({
      displayName: 'Brendan',
      avatarUrl: 'duck',
      cleanlinessScore: 73,
      isPublic: true,
    });
    expect(Object.keys(result).sort()).toEqual(
      [...PUBLIC_PROFILE_FIELDS].sort()
    );
  });

  it('defaults every field when the user document is empty', () => {
    // users/{uid} has no authoritative creation point — it is upserted by the
    // FCM write, the discoverability toggle, the avatar picker or
    // claimWelcomeChest, whichever fires first. Any subset may be missing.
    expect(buildPublicProfile({}, undefined)).toEqual({
      displayName: '',
      avatarUrl: '',
      cleanlinessScore: 0,
      isPublic: false,
    });
  });

  it('defaults when the user document does not exist at all', () => {
    expect(buildPublicProfile(undefined, undefined)).toEqual({
      displayName: '',
      avatarUrl: '',
      cleanlinessScore: 0,
      isPublic: false,
    });
  });

  it('never reads a non-boolean isPublic as discoverable', () => {
    // A truthy-but-not-true value must not make a private user searchable.
    expect(buildPublicProfile({ isPublic: 'yes' }, 'X').isPublic).toBe(false);
    expect(buildPublicProfile({ isPublic: 1 }, 'X').isPublic).toBe(false);
    expect(buildPublicProfile({ isPublic: false }, 'X').isPublic).toBe(false);
    expect(buildPublicProfile({ isPublic: true }, 'X').isPublic).toBe(true);
  });

  it('falls back to 0 for a non-numeric cleanlinessScore', () => {
    expect(buildPublicProfile({ cleanlinessScore: '80' }, 'X')
      .cleanlinessScore).toBe(0);
    expect(buildPublicProfile({ cleanlinessScore: NaN }, 'X')
      .cleanlinessScore).toBe(0);
  });
});

describe('projectionChanged', () => {
  it('ignores writes that touch no projected field', () => {
    // The guard that keeps fcmToken refreshes and subscription renewals from
    // costing an Auth lookup plus a write on every single one.
    expect(projectionChanged(
      { avatarUrl: 'duck', isPublic: true, fcmToken: 'old' },
      { avatarUrl: 'duck', isPublic: true, fcmToken: 'new' }
    )).toBe(false);

    expect(projectionChanged(
      { isPublic: true, subscriptionTier: 'free' },
      { isPublic: true, subscriptionTier: 'premium' }
    )).toBe(false);
  });

  it('detects a discoverability flip', () => {
    expect(projectionChanged({ isPublic: false }, { isPublic: true }))
      .toBe(true);
  });

  it('detects avatar and score changes', () => {
    expect(projectionChanged({ avatarUrl: 'duck' }, { avatarUrl: 'cat' }))
      .toBe(true);
    expect(projectionChanged({ cleanlinessScore: 10 }, { cleanlinessScore: 90 }))
      .toBe(true);
  });

  it('treats a create or a delete as a change', () => {
    expect(projectionChanged(undefined, { isPublic: true })).toBe(true);
    expect(projectionChanged({ isPublic: true }, undefined)).toBe(true);
  });
});

describe('syncPublicProfile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('writes the projection with the display name from Firebase Auth', async () => {
    // The load-bearing case. displayName is NOT in users/{uid} — signup only
    // calls updateDisplayName() on the Auth record — so sourcing it here is
    // what makes search return named results instead of blanks.
    const set = jest.fn().mockResolvedValue(undefined);
    _db.doc.mockReturnValue({ set, delete: jest.fn() });
    _auth.getUser.mockResolvedValue({ displayName: 'Brendan' });

    await syncPublicProfile._handler(
      writeEvent('uid-a', { isPublic: false }, { isPublic: true, avatarUrl: 'duck' })
    );

    expect(_auth.getUser).toHaveBeenCalledWith('uid-a');
    expect(_db.doc).toHaveBeenCalledWith('publicProfiles/uid-a');
    expect(set).toHaveBeenCalledWith({
      displayName: 'Brendan',
      avatarUrl: 'duck',
      cleanlinessScore: 0,
      isPublic: true,
    });
  });

  it('skips the write when no projected field changed', async () => {
    const set = jest.fn();
    _db.doc.mockReturnValue({ set, delete: jest.fn() });

    await syncPublicProfile._handler(
      writeEvent('uid-a', { isPublic: true, fcmToken: 'old' },
        { isPublic: true, fcmToken: 'new' })
    );

    expect(set).not.toHaveBeenCalled();
    expect(_auth.getUser).not.toHaveBeenCalled();
  });

  it('deletes the projection when the user document is deleted', async () => {
    const del = jest.fn().mockResolvedValue(undefined);
    _db.doc.mockReturnValue({ set: jest.fn(), delete: del });

    await syncPublicProfile._handler(
      writeEvent('uid-a', { isPublic: true }, undefined)
    );

    expect(_db.doc).toHaveBeenCalledWith('publicProfiles/uid-a');
    expect(del).toHaveBeenCalled();
  });

  it('degrades to an empty name when the Auth record is gone', async () => {
    // A users/{uid} document can outlive its Auth user. Throwing here would
    // make the trigger retry the same doomed write until backoff expires.
    const set = jest.fn().mockResolvedValue(undefined);
    _db.doc.mockReturnValue({ set, delete: jest.fn() });
    _auth.getUser.mockRejectedValue(new Error('user-not-found'));

    await syncPublicProfile._handler(
      writeEvent('uid-a', undefined, { isPublic: true })
    );

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: '', isPublic: true })
    );
  });

  it('projects a user with no Auth display name as an empty string', async () => {
    const set = jest.fn().mockResolvedValue(undefined);
    _db.doc.mockReturnValue({ set, delete: jest.fn() });
    _auth.getUser.mockResolvedValue({ displayName: null });

    await syncPublicProfile._handler(
      writeEvent('uid-a', undefined, { isPublic: true })
    );

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: '' })
    );
  });
});

describe('backfillPublicProfiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SEED_SECRET;
  });

  it('rejects a non-POST request', async () => {
    const res = makeRes();
    await backfillPublicProfiles._handler({ method: 'GET', get: () => undefined }, res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it('fails closed when SEED_SECRET is unset', async () => {
    // Same posture as seedShopData: in an environment without the secret --
    // production -- every request is rejected rather than allowed.
    const res = makeRes();
    await backfillPublicProfiles._handler(
      { method: 'POST', get: () => 'anything' }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('rejects a wrong secret', async () => {
    process.env.SEED_SECRET = 'right';
    const res = makeRes();
    await backfillPublicProfiles._handler(
      { method: 'POST', get: () => 'wrong' }, res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('projects every existing user document', async () => {
    process.env.SEED_SECRET = 'right';
    const batchSet = jest.fn();
    const commit = jest.fn().mockResolvedValue(undefined);
    _db.batch.mockReturnValue({ set: batchSet, commit });
    _db.collection.mockReturnValue({
      get: jest.fn().mockResolvedValue({
        size: 2,
        docs: [
          { id: 'uid-a', data: () => ({ isPublic: true, avatarUrl: 'duck' }) },
          { id: 'uid-b', data: () => ({ isPublic: false }) },
        ],
      }),
    });
    _db.doc.mockImplementation((path: string) => ({ _path: path }));
    _auth.getUser.mockImplementation(async (uid: string) =>
      ({ displayName: uid === 'uid-a' ? 'Alice' : 'Bob' }));

    const res = makeRes();
    await backfillPublicProfiles._handler(
      { method: 'POST', get: () => 'right' }, res);

    expect(batchSet).toHaveBeenCalledTimes(2);
    expect(batchSet).toHaveBeenCalledWith(
      { _path: 'publicProfiles/uid-a' },
      { displayName: 'Alice', avatarUrl: 'duck', cleanlinessScore: 0, isPublic: true }
    );
    expect(batchSet).toHaveBeenCalledWith(
      { _path: 'publicProfiles/uid-b' },
      { displayName: 'Bob', avatarUrl: '', cleanlinessScore: 0, isPublic: false }
    );
    expect(commit).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, profilesBackfilled: 2 });
  });

  it('does not abort the whole backfill on one orphaned document', async () => {
    process.env.SEED_SECRET = 'right';
    const batchSet = jest.fn();
    const commit = jest.fn().mockResolvedValue(undefined);
    _db.batch.mockReturnValue({ set: batchSet, commit });
    _db.collection.mockReturnValue({
      get: jest.fn().mockResolvedValue({
        size: 2,
        docs: [
          { id: 'uid-orphan', data: () => ({ isPublic: true }) },
          { id: 'uid-ok', data: () => ({ isPublic: true }) },
        ],
      }),
    });
    _db.doc.mockImplementation((path: string) => ({ _path: path }));
    _auth.getUser.mockImplementation(async (uid: string) => {
      if (uid === 'uid-orphan') throw new Error('user-not-found');
      return { displayName: 'Ok' };
    });

    const res = makeRes();
    await backfillPublicProfiles._handler(
      { method: 'POST', get: () => 'right' }, res);

    expect(batchSet).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalled();
  });
});
