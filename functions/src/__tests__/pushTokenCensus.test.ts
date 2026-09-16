/**
 * The push-token census — the number that gates the last two moves.
 *
 * ---------------------------------------------------------------------------
 * 🔴 WHAT IS DECISIVE HERE, AND WHY IT IS NOT THE OBVIOUS ONE
 * ---------------------------------------------------------------------------
 *
 * The tempting reading of this census is "how many users are un-migrated", and
 * the tempting implementation is `has a legacy token`. That implementation is
 * wrong for the ONE case that matters: a user mid-migration carries a token in
 * BOTH documents, and `resolvePushToken` already serves them from the private
 * one. Counting them as legacy-only inflates the blocking population with users
 * who are not blocked — and since the client keeps writing both during the
 * rollout, that population would never reach zero. The condition pushTokens.ts
 * states ("drop the legacy read only once that population is empty") could then
 * never be met, and the migration freezes permanently.
 *
 * ⚠️ THE MUTATION TO BEAT: reorder `classifyPushTokenMigration` so `both` is
 * tested after `legacy`, i.e. classify a both-present user as legacy-only. That
 * reddens `both-present is NOT legacy-only` and the resolver-agreement test
 * here, and NOTHING ELSE in the suite — measured, not assumed.
 *
 * 📌 EVERY FIXTURE TOKEN VALUE IN THIS FILE IS DISTINCT, including the two a
 * both-present user carries. Identical values hide a wrong lookup: a census
 * that read the legacy field into the private slot still passes when both
 * documents say 'token-abc'.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE CANNOT PROVE
 * ---------------------------------------------------------------------------
 *
 *   · That a real Firestore hands back the document shapes the fake here
 *     imitates — that a missing document yields `undefined` from `data()`, and
 *     that `collectionGroup('private')` really produces `users/{uid}/private/push`
 *     with the uid reachable from `ref`. `pushTokenCensusEmulator.test.ts` drives
 *     that against the emulator; a fake cannot answer it, and a census that
 *     mis-read the real shape would report zero legacy-only users and green-light
 *     the sweep that breaks push.
 *   · Anything about PRODUCTION's numbers. Nothing here asks production a
 *     question; see the header of scripts/count-legacy-push-tokens.cjs.
 */
import {spawnSync} from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import {
  PUSH_TOKEN_DOC_ID,
  classifyPushTokenMigration,
  pushTokenOwnerUid,
  readPushTokenCensus,
  resolvePushToken,
  tallyPushTokenMigration,
  type PushTokenEntry,
} from '../pushTokens';
import {codeOf} from './helpers/sourceText';

jest.mock('firebase-admin/firestore', () => ({
  FieldValue: {delete: () => '__DELETE__'},
}));

// Four distinct values. The two on the both-present user are distinct FROM EACH
// OTHER as well, which is what makes a private/legacy mix-up visible.
const LEGACY_ONLY_TOKEN = 'tok-legacy-only-1111';
const PRIVATE_ONLY_TOKEN = 'tok-private-only-2222';
const BOTH_PRIVATE_TOKEN = 'tok-both-private-3333';
const BOTH_LEGACY_TOKEN = 'tok-both-legacy-4444';

const SCRIPT = path.join(
  __dirname, '..', '..', 'scripts', 'count-legacy-push-tokens.cjs',
);

/** A `QueryDocumentSnapshot` for `users/{uid}/private/{leaf}`, shape and all. */
function privateDocFor(
  uid: string,
  data: Record<string, unknown>,
  shape: {leaf?: string; collection?: string; root?: string; orphan?: boolean} = {},
) {
  const leaf = shape.leaf ?? PUSH_TOKEN_DOC_ID;
  const rootCollection = {id: shape.root ?? 'users', parent: null};
  const userDoc = {id: uid, parent: rootCollection};
  const privateCollection = {
    id: shape.collection ?? 'private',
    parent: shape.orphan ? null : userDoc,
  };
  return {id: leaf, ref: {id: leaf, parent: privateCollection}, data: () => data};
}

/** A Firestore double that records which queries the census actually issued. */
function censusDb(
  users: {uid: string; data: Record<string, unknown>}[],
  privateDocs: ReturnType<typeof privateDocFor>[],
) {
  const calls: string[] = [];
  const db = {
    collection: (collectionPath: string) => ({
      select: (...fields: string[]) => ({
        get: async () => {
          calls.push(`collection(${collectionPath}).select(${fields.join(',')})`);
          return {
            docs: users.map((u) => ({
              id: u.uid,
              ref: {id: u.uid, parent: {id: 'users', parent: null}},
              data: () => u.data,
            })),
          };
        },
      }),
    }),
    collectionGroup: (collectionId: string) => ({
      get: async () => {
        calls.push(`collectionGroup(${collectionId})`);
        return {docs: privateDocs};
      },
    }),
  };
  return {db, calls};
}

describe('classifyPushTokenMigration — the four states of the two documents', () => {
  test('a token only in the legacy field is legacy-only', () => {
    expect(
      classifyPushTokenMigration({uid: 'a', legacyData: {fcmToken: LEGACY_ONLY_TOKEN}}),
    ).toBe('legacy-only');
  });

  test('a token only in the private document is private-only', () => {
    expect(
      classifyPushTokenMigration({uid: 'a', privateData: {fcmToken: PRIVATE_ONLY_TOKEN}}),
    ).toBe('private-only');
  });

  test('🔴 both-present is NOT legacy-only — the error that freezes the migration', () => {
    // This user is already served from the private document. Counting them as
    // legacy-only makes the blocking population look permanently non-empty.
    expect(
      classifyPushTokenMigration({
        uid: 'a',
        privateData: {fcmToken: BOTH_PRIVATE_TOKEN},
        legacyData: {fcmToken: BOTH_LEGACY_TOKEN},
      }),
    ).toBe('both');
  });

  test('no token in either document is neither, not legacy-only', () => {
    expect(classifyPushTokenMigration({uid: 'a'})).toBe('neither');
    expect(
      classifyPushTokenMigration({uid: 'a', privateData: {}, legacyData: {}}),
    ).toBe('neither');
  });

  test('an empty private token leaves the user legacy-only, not both', () => {
    // An empty string is not a token — resolvePushToken falls through it — so a
    // user carrying one is still un-migrated and still blocks the sweep.
    expect(
      classifyPushTokenMigration({
        uid: 'a',
        privateData: {fcmToken: ''},
        legacyData: {fcmToken: LEGACY_ONLY_TOKEN},
      }),
    ).toBe('legacy-only');
  });

  test('a non-string in either place is not a token', () => {
    expect(
      classifyPushTokenMigration({
        uid: 'a',
        privateData: {fcmToken: 12345},
        legacyData: {fcmToken: {nested: true}},
      }),
    ).toBe('neither');
  });
});

describe('the census and the resolver can never disagree', () => {
  // 🔑 The census exists to decide when the resolver may stop reading the
  // legacy field. If the two read "is there a token here" differently, the
  // number is measuring a population the senders do not have. All nine
  // combinations, checked as one property rather than picked by hand.
  const values: {name: string; data?: Record<string, unknown>}[] = [
    {name: 'absent', data: undefined},
    {name: 'empty', data: {fcmToken: ''}},
    {name: 'valid-private', data: {fcmToken: BOTH_PRIVATE_TOKEN}},
  ];
  const legacyValues: {name: string; data?: Record<string, unknown>}[] = [
    {name: 'absent', data: undefined},
    {name: 'empty', data: {fcmToken: ''}},
    {name: 'valid-legacy', data: {fcmToken: BOTH_LEGACY_TOKEN}},
  ];

  for (const priv of values) {
    for (const legacy of legacyValues) {
      test(`private=${priv.name} legacy=${legacy.name}`, () => {
        const entry: PushTokenEntry = {
          uid: 'a',
          privateData: priv.data,
          legacyData: legacy.data,
        };
        const state = classifyPushTokenMigration(entry);
        const resolved = resolvePushToken(entry);

        if (state === 'neither') {
          expect(resolved).toBeNull();
        } else if (state === 'legacy-only') {
          expect(resolved).toEqual({token: BOTH_LEGACY_TOKEN, source: 'legacy'});
        } else {
          // private-only AND both: the private document wins in both.
          expect(resolved).toEqual({token: BOTH_PRIVATE_TOKEN, source: 'private'});
        }
      });
    }
  }
});

describe('tallyPushTokenMigration', () => {
  test('counts each state and every user exactly once', () => {
    const census = tallyPushTokenMigration([
      {uid: 'l1', legacyData: {fcmToken: LEGACY_ONLY_TOKEN}},
      {uid: 'l2', legacyData: {fcmToken: `${LEGACY_ONLY_TOKEN}-b`}},
      {uid: 'p1', privateData: {fcmToken: PRIVATE_ONLY_TOKEN}},
      {
        uid: 'b1',
        privateData: {fcmToken: BOTH_PRIVATE_TOKEN},
        legacyData: {fcmToken: BOTH_LEGACY_TOKEN},
      },
      {uid: 'n1'},
    ]);
    expect(census).toEqual({
      legacyOnly: 2,
      privateOnly: 1,
      both: 1,
      neither: 1,
      total: 5,
    });
  });

  test('an empty population is all zeroes, not a missing answer', () => {
    expect(tallyPushTokenMigration([])).toEqual({
      legacyOnly: 0, privateOnly: 0, both: 0, neither: 0, total: 0,
    });
  });
});

describe('pushTokenOwnerUid — which collection-group hits are push tokens', () => {
  test('users/{uid}/private/push belongs to that uid', () => {
    expect(pushTokenOwnerUid(privateDocFor('uid-1', {fcmToken: PRIVATE_ONLY_TOKEN})))
      .toBe('uid-1');
  });

  test('another document in the same private collection is not one', () => {
    // The collection is owner-only and will hold more than the push token.
    expect(pushTokenOwnerUid(privateDocFor('uid-1', {}, {leaf: 'settings'})))
      .toBeNull();
  });

  test('a push document in some other collection is not one', () => {
    expect(pushTokenOwnerUid(privateDocFor('uid-1', {}, {collection: 'secrets'})))
      .toBeNull();
  });

  test('a TOP-LEVEL private collection has no owner', () => {
    // collectionGroup matches by id at any depth — index.ts already has to skip
    // the top-level shop/current for exactly this reason.
    expect(pushTokenOwnerUid(privateDocFor('uid-1', {}, {orphan: true}))).toBeNull();
  });

  test('a private collection under something that is not a user is not one', () => {
    expect(pushTokenOwnerUid(privateDocFor('house-1', {}, {root: 'houses'})))
      .toBeNull();
  });
});

describe('readPushTokenCensus against a fake Firestore', () => {
  test('it projects the users scan and reads the private collection group', async () => {
    const {db, calls} = censusDb([], []);
    await readPushTokenCensus(db);
    // The projection is what keeps a full-collection scan affordable, and the
    // collection-group scan is what makes it two queries instead of 2N reads.
    expect(calls).toEqual([
      'collection(users).select(fcmToken)',
      'collectionGroup(private)',
    ]);
  });

  test('it classifies a real-shaped population, ignoring documents that are not tokens', async () => {
    const {db} = censusDb(
      [
        {uid: 'legacy-1', data: {fcmToken: LEGACY_ONLY_TOKEN}},
        {uid: 'both-1', data: {fcmToken: BOTH_LEGACY_TOKEN}},
        {uid: 'private-1', data: {}},
        {uid: 'none-1', data: {}},
      ],
      [
        privateDocFor('both-1', {fcmToken: BOTH_PRIVATE_TOKEN}),
        privateDocFor('private-1', {fcmToken: PRIVATE_ONLY_TOKEN}),
        // Not a push token: same collection, different document.
        privateDocFor('legacy-1', {theme: 'dark'}, {leaf: 'settings'}),
        // A user whose users/{uid} document the scan never saw.
        privateDocFor('orphan-1', {fcmToken: `${PRIVATE_ONLY_TOKEN}-orphan`}),
      ],
    );
    expect(await readPushTokenCensus(db)).toEqual({
      legacyOnly: 1,
      privateOnly: 2,
      both: 1,
      neither: 1,
      total: 5,
    });
  });

  test('a private token does not leak into the legacy count', async () => {
    // The lookup that would: reading the private document into legacyData. With
    // distinct fixture values that misread is visible; with one shared value it
    // would not be.
    const {db} = censusDb(
      [{uid: 'p', data: {}}],
      [privateDocFor('p', {fcmToken: PRIVATE_ONLY_TOKEN})],
    );
    const census = await readPushTokenCensus(db);
    expect(census.legacyOnly).toBe(0);
    expect(census.privateOnly).toBe(1);
  });
});

describe('the instrument has no write path', () => {
  const SOURCE = fs.readFileSync(SCRIPT, 'utf8');
  // 🔑 A CODE assertion, so it is stripped: this file's own comments discuss
  // deleting the legacy field at length, and an unstripped scan would go red on
  // its documentation rather than on its behaviour.
  const SOURCE_CODE = codeOf(SOURCE);

  test('the script exists and is not empty', () => {
    // A guard reading the wrong path passes everything.
    expect(SOURCE.length).toBeGreaterThan(500);
  });

  test.each([
    ['.set(', 'set'],
    ['.update(', 'update'],
    ['.delete(', 'delete'],
    ['.create(', 'create'],
    ['.commit(', 'commit'],
    ['batch(', 'batch'],
    ['bulkWriter', 'bulkWriter'],
    ['FieldValue', 'FieldValue'],
  ])('it never calls %s', (needle) => {
    expect(SOURCE_CODE).not.toContain(needle);
  });

  test('it refuses to scan without an explicit --project', () => {
    // Behaviour, not prose: run it. An ambient project default is how a scan
    // reaches the wrong database, so the refusal is the safety property.
    const run = spawnSync('node', [SCRIPT], {encoding: 'utf8'});
    expect(run.status).toBe(2);
    expect(run.stderr).toContain('--project');
  });

  test('it states what running against production would take', () => {
    // A DOC assertion, deliberately raw: the operator has to be able to read
    // the credential and authorisation requirements out of the file itself.
    expect(SOURCE).toContain('WHAT IT WOULD TAKE TO RUN THIS AGAINST PRODUCTION');
    expect(SOURCE).toContain('roles/datastore.viewer');
  });
});
