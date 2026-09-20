/**
 * Security-rules tests for `users/{uid}`, `users/{uid}/private/{docId}`,
 * `users/{uid}/profile/{doc=**}` and `users/{uid}/friends/{friendUid}`.
 *
 * Requires the Firestore emulator — excluded from the default `npm test` run.
 * Run with:  npm run test:rules
 *
 * Guards the B1 create/update split. The previous single `allow write` rule
 * called `resource.data.diff(...)`, which errors (and therefore denies) on a
 * create because `resource` is null. That made the first client write to
 * users/{uid} impossible before a Cloud Function had created the document.
 *
 * The profile block carried the identical shape (F2) and was split the same
 * way. It was latent rather than live — nothing client-side writes profile
 * today, every writer is the Admin SDK — but the rule's own comment promised
 * clients could write cosmetic fields, which a create-denying rule cannot
 * honour for a first write.
 *
 * The friends block guards two defects found on 2026-08-03:
 *   F1  isFriend() trusts users/{me}/friends/{them}.status, and the old
 *       `allow create: if isOwner(uid)` let a client write that document
 *       itself with status 'accepted' — a self-service read grant on any
 *       user's doc, profile and house.
 *   F2  sendFriendRequest writes BOTH sides of the request (see
 *       friends_repository_impl.dart), and the same rule denied the
 *       recipient-side write, so requests never arrived.
 * The fixes pull in opposite directions on the same rule, which is why the
 * create is pinned to status 'pending' and only a non-requester may accept.
 *
 * The private block (W2-132) is the counterweight to all of that: users/{uid}
 * is friend-readable BY DESIGN and must stay so, and the push token therefore
 * cannot live on it. Its describe carries the argument.
 */
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {readFileSync} from 'fs';
import {resolve} from 'path';
import {
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  query,
  setDoc,
  updateDoc,
  where,
} from 'firebase/firestore';

const UID = 'uid-owner';
const OTHER_UID = 'uid-stranger';
const THIRD_UID = 'uid-bystander';

let testEnv: RulesTestEnvironment;

beforeAll(async () => {
  // CRITICAL: REFUSE RATHER THAN JUDGE AN EMULATOR NOBODY STARTED (W2-95).
  //
  // `initializeTestEnvironment` is given no host or port on purpose, so the
  // emulator comes from the environment. @firebase/rules-unit-testing resolves
  // it in three steps: explicit config, THEN Emulator-hub discovery, THEN
  // FIRESTORE_EMULATOR_HOST. `npm run test:rules` sets the last two via
  // `emulators:exec --config ../firebase.rules.json`.
  //
  // WARNING: WITHOUT THIS GUARD, RUNNING THE FILE UNDER BARE `jest` REACHES WHATEVER
  // EMULATOR HAPPENS TO BE ANSWERING. That is not hypothetical: for eleven
  // hours on 2026-08-16 the only way anyone ran this suite was the hand-rolled
  // `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 jest …`, which attaches to a
  // long-lived DEV emulator and judges the ruleset against a database that
  // unrelated work has been writing to all day. It reported 188 passed, and a
  // green count from the wrong database is the failure this file exists to
  // prevent, not a result.
  //
  // NOTE: PRESENCE IS CHECKED, NOT VALUE, AND THAT IS DELIBERATE. Asserting a
  // specific port here would copy firebase.rules.json into this file — and a
  // port pinned in the test is precisely the trap that would keep pointing at
  // the old emulator while the config innocently started a new one elsewhere.
  // The config owns the port; this only refuses to run with no emulator named.
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST is unset — run this through `npm run test:rules`, ' +
        'which starts an emulator on the ports firebase.rules.json reserves and ' +
        'exports this variable. Running it under bare `jest` would judge ' +
        'firestore.rules against whichever emulator is answering, or none.',
    );
  }

  testEnv = await initializeTestEnvironment({
    projectId: 'demo-cleaning-rules',
    firestore: {
      rules: readFileSync(resolve(__dirname, '../../../firestore.rules'), 'utf8'),
    },
  });
  // CRITICAL: AN EXPLICIT TIMEOUT, BECAUSE THE DEFAULT ONE LIES ABOUT WHAT FAILED.
  // jest's default hook timeout is 5s. `initializeTestEnvironment` loads the
  // ruleset over the wire, and on a loaded machine that can exceed it — at
  // which point EVERY test in the file reports failed (`Tests: 193 failed, 193
  // total`), which reads exactly like a catastrophic rules regression rather
  // than one slow hook. Observed here on 2026-08-16 running three emulator
  // suites back to back; the identical run passed in isolation seconds later.
  // familyEmulator.test.ts already carries 120_000 on its own beforeAll for
  // this reason. 5s was never a deadline anybody chose — it is jest's default
  // leaking into a gate's headline number.
}, 60_000);

afterAll(async () => {
  await testEnv.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

/** Seeds users/{UID} bypassing rules, as a Cloud Function would. */
async function seedUserDoc(data: Record<string, unknown>) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', UID), data);
  });
}

/** Seeds users/{UID}/profile/data bypassing rules, as awardXp would. */
async function seedProfileDoc(data: Record<string, unknown>) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', UID, 'profile', 'data'), data);
  });
}

/** Makes OTHER_UID an accepted friend of UID, satisfying isFriend(UID). */
async function seedAcceptedFriendship() {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), 'users', OTHER_UID, 'friends', UID),
      {status: 'accepted'},
    );
  });
}

describe('users/{uid} create', () => {
  it('lets the owner create their own document', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', UID), {fcmToken: 'token-abc'}),
    );
  });

  it('rejects a create that seeds a Cloud-Function-owned field', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, 'users', UID), {
        fcmToken: 'token-abc',
        subscriptionTier: 'premium',
      }),
    );
    await assertFails(
      setDoc(doc(db, 'users', UID), {streakShields: 99}),
    );
    await assertFails(
      setDoc(doc(db, 'users', UID), {orientationCompleted: true}),
    );
  });

  // PrivacySettingsNotifier.setDiscoverable writes set(merge:), which is a
  // CREATE for a user who reaches Settings before anything has created their
  // doc — reachable, because orientation never writes Firestore. isPublic is
  // not a Cloud-Function-owned field, so the create must pass.
  it('lets the owner create their doc with only isPublic', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', UID), {isPublic: true}, {merge: true}),
    );
  });

  it('rejects a create on someone else’s document', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(setDoc(doc(db, 'users', UID), {fcmToken: 'x'}));
  });

  it('rejects an unauthenticated create', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, 'users', UID), {fcmToken: 'x'}));
  });
});

describe('users/{uid} update', () => {
  it('lets the owner change a non-protected field', async () => {
    await seedUserDoc({fcmToken: 'old', subscriptionTier: 'premium'});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', UID), {fcmToken: 'new'}),
    );
  });

  it('rejects changes to Cloud-Function-owned fields', async () => {
    await seedUserDoc({
      fcmToken: 'old',
      subscriptionTier: 'free',
      streakShields: 1,
      orientationCompleted: false,
    });
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {subscriptionTier: 'premium'}),
    );
    await assertFails(updateDoc(doc(db, 'users', UID), {streakShields: 99}));
    await assertFails(
      updateDoc(doc(db, 'users', UID), {orientationCompleted: true}),
    );
  });

  it('🔴 refuses to let a client freeze the notification high-water mark', async () => {
    // THE REFUND BYPASS. appStoreNotificationsV2 drops any notification whose
    // Apple-signed signedDate is at or before `subscriptionNotifiedAt`, because
    // Apple does not guarantee delivery order. A client that can write that
    // field far into the future switches off every subsequent notification.
    //
    // Natural expiry survives it — the clock owns that, and
    // subscriptionExpiresAt is CF-owned — but a REFUND does not. A refund is
    // the one ending that revokes MID-period, so freezing this buys back a full
    // paid month after Apple has returned the money, every cycle.
    //
    // WARNING: The field shipped in #348 and was NOT in userCfOwnedFields() for one
    // PR. The rule is a DENYLIST, so a new CF-written field on users/{uid} is
    // client-writable by default: forgetting one fails OPEN and in silence.
    await seedUserDoc({
      subscriptionTier: 'pro',
      subscriptionNotifiedAt: new Date('2026-08-14T00:00:00Z'),
    });
    const db = testEnv.authenticatedContext(UID).firestore();

    await assertFails(
      updateDoc(doc(db, 'users', UID), {
        subscriptionNotifiedAt: new Date('2099-01-01T00:00:00Z'),
      }),
    );
  });

  it('🔴 refuses to let a client SEED the high-water mark on create', async () => {
    // The create rule guards the literal key set rather than a diff, so it is a
    // separate branch and a separate hole. A brand-new account that could seed
    // this field arrives pre-immunised against its own refund notifications.
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      setDoc(doc(db, 'users', OTHER_UID), {
        displayName: 'new',
        subscriptionNotifiedAt: new Date('2099-01-01T00:00:00Z'),
      }),
    );
  });

  it('🔴 refuses to let a client clear or set the promo stamp', async () => {
    // `proPromoGrantedAt` is the ONLY thing standing between "one free month per
    // account, ever" and one free month every three weeks. Firestore rules
    // cannot express "only if this has never happened", so the callable enforces
    // uniqueness inside a transaction and this rule stops the client from
    // rewinding the record it reads.
    //
    // NOTE: Added in the SAME COMMIT as the code that writes it. #348 shipped
    // `subscriptionNotifiedAt` without its entry and #356 closed the resulting
    // refund bypass — this list is a DENYLIST, so a new CF-written field is
    // client-writable by default and the omission has no symptom.
    await seedUserDoc({
      subscriptionTier: 'pro',
      proPromoGrantedAt: new Date('2026-08-14T00:00:00Z'),
    });
    const db = testEnv.authenticatedContext(UID).firestore();

    // Clearing it re-arms the promo.
    await assertFails(
      updateDoc(doc(db, 'users', UID), {proPromoGrantedAt: null}),
    );
    // Moving it is the same exploit with an extra step.
    await assertFails(
      updateDoc(doc(db, 'users', UID), {
        proPromoGrantedAt: new Date('2020-01-01T00:00:00Z'),
      }),
    );
  });

  it('a client may still write its own non-protected fields alongside', async () => {
    // The control. A denylist that had grown to cover everything would pass
    // both tests above while breaking every legitimate client write.
    await seedUserDoc({fcmToken: 'old', subscriptionNotifiedAt: new Date()});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', UID), {fcmToken: 'new'}),
    );
  });

  it('rejects an update to someone else’s document', async () => {
    await seedUserDoc({fcmToken: 'old'});
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(updateDoc(doc(db, 'users', UID), {fcmToken: 'new'}));
  });
});

describe('users/{uid} delete and read', () => {
  it('rejects a client delete (account deletion goes through Auth)', async () => {
    await seedUserDoc({fcmToken: 'old'});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, 'users', UID)));
  });

  it('lets the owner read their own document', async () => {
    await seedUserDoc({fcmToken: 'old'});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'users', UID)));
  });

  it('rejects a read by a stranger who is not a friend', async () => {
    await seedUserDoc({fcmToken: 'old'});
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID)));
  });
});

// ---------------------------------------------------------------------------
// users/{uid}/private/push — the push token, off the friend-readable document
// ---------------------------------------------------------------------------
//
// users/{uid} is readable by `isOwner(uid) || isFriend(uid)`, and it carried
// `fcmToken` — so every accepted friend could read the raw device push token
// of every friend they had. Firestore has no field-level read security, so the
// only fix is to move the field to a document with a different rule.
//
// KEY: THE PARENT RULE COULD NOT SIMPLY BE NARROWED TO THE OWNER. The friend
// read is live: friends_repository_impl.dart `_roster()` reads `housemates`
// off users/{friendUid} for every accepted friend to answer "may I visit their
// house?" — and it swallows the permission error and returns empty, so
// narrowing the rule would not have failed loudly, it would have turned every
// Visit button into an Ask button with nothing going red. The last describe in
// this file still asserts that friend read succeeds, deliberately.
//
// CRITICAL: BOTH DIRECTIONS ARE PROVEN BELOW. A rule that denied everybody would pass
// every deny assertion here and silently break push for the user themselves,
// whose own device is the only thing that ever writes this document.
describe('users/{uid}/private/push — owner-only push token', () => {
  /** Seeds users/{UID}/private/push bypassing rules. */
  async function seedPrivatePush(data: Record<string, unknown>) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', UID, 'private', 'push'), data);
    });
  }

  it('lets the OWNER read their own push token', async () => {
    // The allow half. Without this the deny tests below are satisfied by a
    // rule that denies everyone, which breaks the only reader that matters.
    await seedPrivatePush({fcmToken: 'token-abc'});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      getDoc(doc(db, 'users', UID, 'private', 'push')),
    );
  });

  it('🔴 DENIES AN ACCEPTED FRIEND — the whole point of the move', async () => {
    // The defect, stated. Seeded exactly as the friend-readable parent is:
    // an accepted edge, which on users/{uid} is enough and here is not.
    await seedPrivatePush({fcmToken: 'token-abc'});
    await seedAcceptedFriendship();
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      getDoc(doc(db, 'users', UID, 'private', 'push')),
    );
  });

  it('DENIES a stranger with no friend edge at all', async () => {
    await seedPrivatePush({fcmToken: 'token-abc'});
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      getDoc(doc(db, 'users', UID, 'private', 'push')),
    );
  });

  it('DENIES an UNAUTHENTICATED client, so the gate is not merely a doc path', async () => {
    await seedPrivatePush({fcmToken: 'token-abc'});
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      getDoc(doc(db, 'users', UID, 'private', 'push')),
    );
  });

  it('lets the owner CREATE the document with their first token', async () => {
    // fcm_service.dart writes set(merge:) on every launch, and the very first
    // one is a create — the case a single `allow write` calling
    // resource.data.diff() denies, because resource is null. Split rule.
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      setDoc(
        doc(db, 'users', UID, 'private', 'push'),
        {fcmToken: 'token-abc'},
        {merge: true},
      ),
    );
  });

  it('lets the owner UPDATE their token, and clear it on sign-out', async () => {
    await seedPrivatePush({fcmToken: 'old'});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', UID, 'private', 'push'), {fcmToken: 'new'}),
    );
    await assertSucceeds(
      updateDoc(doc(db, 'users', UID, 'private', 'push'), {
        fcmToken: deleteField(),
      }),
    );
  });

  it('DENIES an accepted friend writing a token into your document', async () => {
    // Write matters as well as read: a friend who could write here could
    // redirect the owner's push to a device they control.
    await seedPrivatePush({fcmToken: 'old'});
    await seedAcceptedFriendship();
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID, 'private', 'push'), {fcmToken: 'theirs'}),
    );
    await assertFails(
      setDoc(doc(db, 'users', UID, 'private', 'push'), {fcmToken: 'theirs'}),
    );
  });

  it('rejects a document delete even by the owner', async () => {
    // Sign-out clears the FIELD inside a set(merge:), which is an update.
    // Nothing deletes this document, so nothing may — same posture as the
    // parent, where account deletion goes through Auth.
    await seedPrivatePush({fcmToken: 'old'});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, 'users', UID, 'private', 'push')));
  });

  it('rules do not cascade: the friend-readable parent does not open the child', async () => {
    // KEY: The control that names the mechanism. The parent IS readable by this
    // friend — asserted here in the same test, on the same seeded state — and
    // the child still is not. Without the succeeding half, a reader cannot
    // tell this test from one where the friendship seed simply failed.
    await seedUserDoc({fcmToken: 'legacy-copy', housemates: []});
    await seedPrivatePush({fcmToken: 'token-abc'});
    await seedAcceptedFriendship();
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'users', UID)));
    await assertFails(getDoc(doc(db, 'users', UID, 'private', 'push')));
  });
});

describe('users/{uid}/profile create', () => {
  it('lets the owner create their profile doc with cosmetic fields', async () => {
    // This is the case the pre-split `allow write` rule denied outright: the
    // diff() call errors when resource is null, and a rules error is a deny.
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', UID, 'profile', 'data'), {
        displayName: 'Sponge Fan',
        avatarId: 'duck',
      }),
    );
  });

  it('rejects a create that seeds an economy field', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, 'users', UID, 'profile', 'data'), {
        displayName: 'Sponge Fan',
        spongeBalance: 9999,
      }),
    );
    await assertFails(
      setDoc(doc(db, 'users', UID, 'profile', 'data'), {totalXp: 9999}),
    );
  });

  it('rejects a create on someone else’s profile', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      setDoc(doc(db, 'users', UID, 'profile', 'data'), {displayName: 'x'}),
    );
  });

  it('rejects an unauthenticated create', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      setDoc(doc(db, 'users', UID, 'profile', 'data'), {displayName: 'x'}),
    );
  });
});

describe('users/{uid}/profile update', () => {
  it('lets the owner change a cosmetic field alongside existing economy fields', async () => {
    await seedProfileDoc({displayName: 'old', spongeBalance: 120, totalXp: 900});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', UID, 'profile', 'data'), {displayName: 'new'}),
    );
  });

  it('rejects changes to economy fields', async () => {
    await seedProfileDoc({displayName: 'old', spongeBalance: 120, totalXp: 900});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID, 'profile', 'data'), {spongeBalance: 9999}),
    );
    await assertFails(
      updateDoc(doc(db, 'users', UID, 'profile', 'data'), {totalXp: 9999}),
    );
  });

  it('rejects an update to someone else’s profile', async () => {
    await seedProfileDoc({displayName: 'old'});
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID, 'profile', 'data'), {displayName: 'new'}),
    );
  });
});

describe('users/{uid}/profile delete and read', () => {
  it('rejects a client delete', async () => {
    await seedProfileDoc({displayName: 'old'});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, 'users', UID, 'profile', 'data')));
  });

  it('lets the owner read their own profile', async () => {
    // The path spongeBalanceStreamProvider / totalXpStreamProvider read.
    await seedProfileDoc({spongeBalance: 137});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'users', UID, 'profile', 'data')));
  });

  it('lets an accepted friend read the profile', async () => {
    await seedProfileDoc({displayName: 'old'});
    await seedAcceptedFriendship();
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'users', UID, 'profile', 'data')));
  });

  it('rejects a read by a stranger who is not a friend', async () => {
    await seedProfileDoc({displayName: 'old'});
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'profile', 'data')));
  });
});

// ---------------------------------------------------------------------------
// users/{uid}/friends/{friendUid}
// ---------------------------------------------------------------------------

/** The exact payload sendFriendRequest writes to BOTH sides of a request. */
function requestPayload(requesterUid: string) {
  return {
    status: 'pending',
    addedAt: '2026-08-03T00:00:00.000Z',
    requesterUid,
  };
}

/** Seeds a pending request from `from` to `to`, on both sides, out of band. */
async function seedPendingRequest(from: string, to: string) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    // Resolve the instance once — a second ctx.firestore() after a write has
    // started throws "settings can no longer be changed".
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', from, 'friends', to), requestPayload(from));
    await setDoc(doc(db, 'users', to, 'friends', from), requestPayload(from));
  });
}

describe('users/{uid}/friends/{friendUid} — escalation (F1)', () => {
  it('rejects fabricating an accepted friendship on your own side', async () => {
    // The escalation itself. isFriend(UID) reads exactly this document, so a
    // client that can create it with status 'accepted' grants itself read on
    // users/UID, its profile and its house.
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      setDoc(doc(db, 'users', OTHER_UID, 'friends', UID), {
        status: 'accepted',
        addedAt: '2026-08-03T00:00:00.000Z',
        requesterUid: OTHER_UID,
      }),
    );
  });

  it('rejects the requester accepting their own request', async () => {
    // The back door: create as 'pending' (allowed), then self-accept.
    await seedPendingRequest(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', OTHER_UID, 'friends', UID), {
        status: 'accepted',
      }),
    );
  });

  it('rejects a create that attributes the request to someone else', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      setDoc(
        doc(db, 'users', OTHER_UID, 'friends', UID),
        requestPayload(UID),
      ),
    );
  });

  it('rejects an unauthenticated create', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      setDoc(
        doc(db, 'users', OTHER_UID, 'friends', UID),
        requestPayload(OTHER_UID),
      ),
    );
  });

  it('rejects a third party touching a friendship they are not part of', async () => {
    await seedPendingRequest(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(THIRD_UID).firestore();
    await assertFails(
      setDoc(
        doc(db, 'users', OTHER_UID, 'friends', UID),
        requestPayload(OTHER_UID),
      ),
    );
    await assertFails(
      updateDoc(doc(db, 'users', OTHER_UID, 'friends', UID), {
        status: 'accepted',
      }),
    );
  });
});

describe('users/{uid}/friends/{friendUid} — sendFriendRequest (F2)', () => {
  it('lets the sender write BOTH sides of a pending request', async () => {
    // sendFriendRequest writes the sender side and then the recipient side.
    // The old `allow create: if isOwner(uid)` denied the second write, after
    // the first had already committed un-transacted.
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(
      setDoc(
        doc(db, 'users', OTHER_UID, 'friends', UID),
        requestPayload(OTHER_UID),
      ),
    );
    await assertSucceeds(
      setDoc(
        doc(db, 'users', UID, 'friends', OTHER_UID),
        requestPayload(OTHER_UID),
      ),
    );
  });

  it('rejects a create carrying an unexpected field', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      setDoc(doc(db, 'users', OTHER_UID, 'friends', UID), {
        ...requestPayload(OTHER_UID),
        spongeBalance: 9999,
      }),
    );
  });
});

describe('users/{uid}/friends/{friendUid} — acceptFriendRequest', () => {
  it('lets the recipient flip both documents to accepted', async () => {
    await seedPendingRequest(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', UID, 'friends', OTHER_UID), {
        status: 'accepted',
      }),
    );
    await assertSucceeds(
      updateDoc(doc(db, 'users', OTHER_UID, 'friends', UID), {
        status: 'accepted',
      }),
    );
  });

  it('rejects an accept that also rewrites addedAt', async () => {
    await seedPendingRequest(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID, 'friends', OTHER_UID), {
        status: 'accepted',
        addedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
  });

  it('rejects an update to any status other than accepted', async () => {
    await seedPendingRequest(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID, 'friends', OTHER_UID), {
        status: 'blocked',
      }),
    );
  });
});

describe('users/{uid}/friends/{friendUid} — reads and the isFriend path', () => {
  it('lets both parties read the friendship document', async () => {
    await seedPendingRequest(OTHER_UID, UID);
    const owner = testEnv.authenticatedContext(UID).firestore();
    const other = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(
      getDoc(doc(owner, 'users', UID, 'friends', OTHER_UID)),
    );
    await assertSucceeds(
      getDoc(doc(other, 'users', UID, 'friends', OTHER_UID)),
    );
  });

  it('rejects a read by a third party', async () => {
    await seedPendingRequest(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(THIRD_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'friends', OTHER_UID)));
  });

  it('still grants an accepted friend read access to the user doc', async () => {
    // The legitimate isFriend() path must keep working after the hardening.
    await seedUserDoc({fcmToken: 'token-abc'});
    await seedAcceptedFriendship();
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'users', UID)));
  });

  it('denies read access while the request is only pending', async () => {
    await seedUserDoc({fcmToken: 'token-abc'});
    await seedPendingRequest(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID)));
  });

  it('lets either party delete the friendship', async () => {
    await seedPendingRequest(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(
      deleteDoc(doc(db, 'users', UID, 'friends', OTHER_UID)),
    );
  });
});

// ---------------------------------------------------------------------------
// Housemates — you see the homes of people you live with
//
// Friendship and house access are two different consents. Before this block,
// one tap on Accept did both: isFriend() alone opened users/{uid}/house, so
// becoming someone's friend published the inside of your home to them with
// nothing in the UI saying so.
//
// The state is split across two documents, and the split is forced:
//   users/{uid}.housemates             — the ROSTER: who may read this house.
//                                        One document, so the four-person cap
//                                        is countable. On the friend edge it
//                                        would not be: users/A/friends/B can
//                                        only ever name A or B, and rules
//                                        cannot aggregate across documents.
//   friends/{friendUid}.housePendingFrom — the REQUEST, per friendship.
//
// The two-step lives in the join between them: a uid may only be appended to
// the roster if it is already sitting in housePendingFrom on the accepted
// edge. Neither half opens a house on its own.
// ---------------------------------------------------------------------------

// NOTE: IMPORTED, NOT REDECLARED. This was a local `const HOUSEMATE_CAP = 4` — a
// THIRD copy of a number that already existed twice (housemateCap() in
// firestore.rules, and the server-side constant the redemption callable
// enforces). Importing it collapses one of the copies and makes the mirror test
// in housemateToken.test.ts — which parses housemateCap() out of the rules file
// — cover this assertion too, instead of a local literal agreeing with itself.
import {HOUSEMATE_CAP} from '../housemateToken';

/** An accepted edge, optionally carrying outstanding move-in requests. */
function edgePayload(requesterUid: string, pending: string[] = []) {
  return {
    status: 'accepted',
    addedAt: '2026-08-03T00:00:00.000Z',
    requesterUid,
    housePendingFrom: pending,
  };
}

/** Seeds both sides of an accepted friendship out of band. */
async function seedEdge(a: string, b: string, pending: string[] = []) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const payload = edgePayload(a, pending);
    await setDoc(doc(db, 'users', a, 'friends', b), payload);
    await setDoc(doc(db, 'users', b, 'friends', a), payload);
  });
}

/** Seeds users/{uid} with a roster, bypassing rules as a prior write would. */
async function seedRoster(uid: string, housemates: string[]) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', uid), {housemates});
  });
}

/** Seeds users/{uid}/house/layout, the document a visit actually reads. */
async function seedHouse(uid: string) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', uid, 'house', 'layout'), {
      floors: [],
      gridCols: 8,
      gridRows: 8,
    });
  });
}

describe('users/{uid}/house — the roster gates the read', () => {
  it('DENIES an accepted friend who is not a housemate', async () => {
    // The whole point of the feature. Friendship alone used to be enough.
    await seedHouse(UID);
    await seedRoster(UID, []);
    await seedEdge(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('allows an accepted friend on the roster', async () => {
    await seedHouse(UID);
    await seedRoster(UID, [OTHER_UID]);
    await seedEdge(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('DENIES a roster entry that is no longer a friend', async () => {
    // canViewHouse is isFriend AND on the roster. Unfriending must close the
    // house even if the roster entry was never tidied up.
    await seedHouse(UID);
    await seedRoster(UID, [OTHER_UID]);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('DENIES a user document that predates the roster field', async () => {
    // seedAcceptedFriendship writes {status:'accepted'} and nothing else, and
    // the user doc here has no housemates key — the shape every account in
    // production has today. The rule reads through .get('housemates', []), so
    // a missing field defaults to "no access" rather than erroring the whole
    // expression out. That defaulting IS the migration: no backfill runs and
    // existing friends lose access nobody was ever shown an advisory for.
    await seedHouse(UID);
    await seedUserDoc({fcmToken: 'token-abc'});
    await seedAcceptedFriendship();
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('still lets the owner read their own house', async () => {
    await seedHouse(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('opens Gibby house to any signed-in player, roster or not', async () => {
    // The NPC carve-out. His layout is seeded content, identical for every
    // account. Making players his housemates instead would grow his roster by
    // one per signup and hit the cap on the fifth account.
    await seedHouse(GIBBY);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'users', GIBBY, 'house', 'layout')));
  });

  it('is one-directional', async () => {
    // OTHER_UID lives with UID. That says nothing about the reverse.
    await seedHouse(UID);
    await seedHouse(OTHER_UID);
    await seedRoster(UID, [OTHER_UID]);
    await seedEdge(OTHER_UID, UID);
    const host = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      getDoc(doc(host, 'users', OTHER_UID, 'house', 'layout')),
    );
  });

  it('keeps profile and user-doc reads on plain friendship', async () => {
    // The ask was the house layout. Display name and cleanliness score stay
    // where they were — widening the gate to those is a separate decision.
    await seedUserDoc({fcmToken: 'token-abc'});
    await seedProfileDoc({spongeBalance: 10});
    await seedAcceptedFriendship();
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'users', UID)));
    await assertSucceeds(getDoc(doc(db, 'users', UID, 'profile', 'data')));
  });
});

// ---------------------------------------------------------------------------
// W2-111 — a family implies house access, in both directions
// ---------------------------------------------------------------------------
//
// Brendan's decision, 2026-08-17: joining a family grants house access both
// ways. Before this, visiting needed a friend edge AND a two-step housemate
// handshake, and a family member had neither by virtue of being family — so
// the feature shipped chores, trash day and a message board, and then could
// not show you the house they are all about.
//
// KEY: THE GRANT IS NOT WRITTEN ANYWHERE. It is a second disjunct on
// canViewHouse, resolved from the READER's own uid: users/{me}.familyId →
// families/{fid}.memberUids. `users/{uid}.housemates` is deliberately
// untouched — see family.ts:12-57 for why a family is not a housemates array,
// and the W2-111 return for why writing that roster was the wrong shape.

/** Seeds `families/{familyId}` the way createFamily/joinFamily leave it. */
async function seedFamily(familyId: string, memberUids: string[]) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'families', familyId), {
      ownerUid: memberUids[0],
      memberUids,
      createdAtMs: 1_760_000_000_000,
    });
  });
}

/**
 * Seeds the pointer half on each member's user document.
 *
 * WARNING: A FULL setDoc, exactly like seedRoster above — so a test needing both a
 * roster and a familyId must seed them in ONE call, not one after the other.
 */
async function seedFamilyPointer(
  uid: string,
  familyId: string | null,
  extra: Record<string, unknown> = {},
) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', uid), {familyId, ...extra});
  });
}

/** Puts UID and OTHER_UID in one family, with no friendship between them. */
async function seedSharedFamily(familyId = 'fam-home') {
  await seedFamily(familyId, [UID, OTHER_UID]);
  await seedFamilyPointer(UID, familyId);
  await seedFamilyPointer(OTHER_UID, familyId);
}

describe('users/{uid}/house — a family opens the door too', () => {
  it('lets a family member read the house with NO friend edge', async () => {
    // The grant. Neither half of the old gate is present: no accepted edge,
    // and neither roster mentions the other.
    await seedHouse(UID);
    await seedSharedFamily();
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('opens BOTH doors — the same fixture, read the other way', async () => {
    // "Both ways" was the decision, and it is structural rather than a second
    // write: one roster answers both directions. Contrast the housemate path
    // directly above, which is deliberately one-directional.
    await seedHouse(UID);
    await seedHouse(OTHER_UID);
    await seedSharedFamily();
    const host = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      getDoc(doc(host, 'users', OTHER_UID, 'house', 'layout')),
    );
  });

  it('🔴 DENIES a member of ANOTHER family — the decoy', async () => {
    // Seeded the way familyEmulator.test.ts pairs every membership denial
    // with the same read succeeding: without a second family in the database
    // this suite would pass on "a family exists" rather than on membership.
    await seedHouse(UID);
    await seedSharedFamily();
    await seedFamily('fam-next-door', [THIRD_UID]);
    await seedFamilyPointer(THIRD_UID, 'fam-next-door');
    const db = testEnv.authenticatedContext(THIRD_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  // -------------------------------------------------------------------------
  // THE REVOKE — the half this change is actually about
  // -------------------------------------------------------------------------
  //
  // A member who leaves and can still walk through your front door is the
  // defect. Nothing in this file mocks a callable: each case seeds the exact
  // document shape applyFamilyDeparture / planFamilyDisband COMMIT, so the
  // assertion is about the rules given that state, not about the planner.

  it('🔴 DENIES a member pruned from memberUids (leave / removeMember)', async () => {
    await seedHouse(UID);
    await seedSharedFamily();
    await seedFamily('fam-home', [UID]);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('🔴 DENIES a leaver whose familyId was nulled', async () => {
    // applyFamilyDeparture writes `familyId: null`, it does not delete the
    // key — so `.get('familyId', '')` returns null and the '' default never
    // fires. `is string` is the clause that catches it; without it the rule
    // builds /families/null and errors.
    await seedHouse(UID);
    await seedSharedFamily();
    await seedFamilyPointer(OTHER_UID, null);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('🔴 DENIES everyone once the family is disbanded', async () => {
    // planFamilyDisband deletes the document. The pointers are nulled in the
    // same transaction, but the rule must not depend on that: a dangling
    // pointer at a deleted family is what exists() is here for.
    await seedHouse(UID);
    await seedSharedFamily();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(ctx.firestore(), 'families', 'fam-home'));
    });
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('🔴 DENIES a STALE POINTER whose roster dropped the reader', async () => {
    // The reason sharesFamilyWith asks the roster about BOTH uids. Here the
    // target is still a member and the reader's pointer still names the
    // family, but the roster no longer lists the reader — the state a
    // half-applied teardown would leave. Checking only the target would read
    // this as a grant.
    await seedHouse(UID);
    await seedSharedFamily();
    await seedFamily('fam-home', [UID, THIRD_UID]);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('does NOT revoke a housemate edge the pair earned separately', async () => {
    // WARNING: The brief's warning. A and B were housemates by token BEFORE they
    // were family; B leaving the family must not close a door B was let
    // through on its own consent. Nothing here needs provenance because the
    // grant was never copied into the roster — the two paths are independent
    // by construction, which is the property, not a precaution.
    await seedHouse(UID);
    await seedFamilyPointer(UID, null, {housemates: [OTHER_UID]});
    await seedFamilyPointer(OTHER_UID, null);
    await seedEdge(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('🔴 DENIES a reader whose user document has no familyId at all', async () => {
    // The shape every account in production has today. Same defaulting
    // argument as the housemates migration above: absent means no access,
    // and it must DENY rather than error the expression out.
    await seedHouse(UID);
    await seedSharedFamily();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', OTHER_UID), {
        fcmToken: 'token-abc',
      });
    });
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('🔴 DENIES a pointer naming a family that never existed', async () => {
    await seedHouse(UID);
    await seedFamilyPointer(OTHER_UID, 'fam-ghost');
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('🔴 DENIES a family whose document carries no memberUids', async () => {
    // Malformed denies rather than errors — the same .get(key, []) doctrine
    // the trashDay block states for the identical reason.
    await seedHouse(UID);
    await seedFamilyPointer(OTHER_UID, 'fam-home');
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'families', 'fam-home'), {
        ownerUid: UID,
      });
    });
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('🔴 DENIES a reader with no user document at all', async () => {
    await seedHouse(UID);
    await seedFamily('fam-home', [UID, OTHER_UID]);
    await seedFamilyPointer(UID, 'fam-home');
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'house', 'layout')));
  });

  it('does NOT widen the user document or profile to family', async () => {
    // Same boundary the housemate change drew: the ask was the house. A
    // family member reads the layout and still not the cleanliness score.
    await seedSharedFamily();
    await seedProfileDoc({spongeBalance: 10});
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID)));
    await assertFails(getDoc(doc(db, 'users', UID, 'profile', 'data')));
  });
});

describe('users/{uid}/friends/{friendUid} — asking to move in', () => {
  it('lets a friend add THEMSELVES to housePendingFrom, on both sides', async () => {
    await seedEdge(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', OTHER_UID, 'friends', UID), {
        housePendingFrom: [OTHER_UID],
      }),
    );
    await assertSucceeds(
      updateDoc(doc(db, 'users', UID, 'friends', OTHER_UID), {
        housePendingFrom: [OTHER_UID],
      }),
    );
  });

  it('rejects asking on someone else’s behalf', async () => {
    // Manufacturing a request from another account is the first half of a
    // two-step forgery — the roster append would then find it legitimate.
    await seedEdge(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', OTHER_UID, 'friends', UID), {
        housePendingFrom: [UID],
      }),
    );
  });

  it('rejects asking on a merely pending friendship', async () => {
    await seedPendingRequest(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', OTHER_UID, 'friends', UID), {
        housePendingFrom: [OTHER_UID],
      }),
    );
  });

  it('rejects an ask that rides along with a status change', async () => {
    await seedPendingRequest(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID, 'friends', OTHER_UID), {
        status: 'accepted',
        housePendingFrom: [UID],
      }),
    );
  });

  it('lets either party clear the request', async () => {
    await seedEdge(OTHER_UID, UID, [OTHER_UID]);
    const host = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      updateDoc(doc(host, 'users', UID, 'friends', OTHER_UID), {
        housePendingFrom: [],
      }),
    );
    const asker = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(
      updateDoc(doc(asker, 'users', OTHER_UID, 'friends', UID), {
        housePendingFrom: [],
      }),
    );
  });

  it('rejects a third party touching the request list', async () => {
    await seedEdge(OTHER_UID, UID, [OTHER_UID]);
    const db = testEnv.authenticatedContext(THIRD_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID, 'friends', OTHER_UID), {
        housePendingFrom: [THIRD_UID],
      }),
    );
  });

  it('accepts a create that seeds the request list empty', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', OTHER_UID, 'friends', UID), {
        ...requestPayload(OTHER_UID),
        housePendingFrom: [],
      }),
    );
  });

  it('rejects a create that arrives already asking', async () => {
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      setDoc(doc(db, 'users', OTHER_UID, 'friends', UID), {
        ...requestPayload(OTHER_UID),
        housePendingFrom: [OTHER_UID],
      }),
    );
  });
});

describe('users/{uid}.housemates — the roster', () => {
  it('lets the host add a friend who asked', async () => {
    await seedUserDoc({housemates: []});
    await seedEdge(OTHER_UID, UID, [OTHER_UID]);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', UID), {housemates: [OTHER_UID]}),
    );
  });

  it('REJECTS adding someone who never asked', async () => {
    // The two-step. Without the housePendingFrom join, "grant" is a single
    // unilateral write and the advisory is decoration.
    await seedUserDoc({housemates: []});
    await seedEdge(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {housemates: [OTHER_UID]}),
    );
  });

  it('REJECTS adding yourself to someone else’s roster', async () => {
    // The escalation, and the reason the roster sits on a document only its
    // owner may write: OTHER_UID cannot write users/UID at all.
    await seedUserDoc({housemates: []});
    await seedEdge(OTHER_UID, UID, [OTHER_UID]);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {housemates: [OTHER_UID]}),
    );
  });

  it('rejects adding a friend whose friendship is only pending', async () => {
    await seedUserDoc({housemates: []});
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'users', UID, 'friends', OTHER_UID), {
        ...requestPayload(OTHER_UID),
        housePendingFrom: [OTHER_UID],
      });
    });
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {housemates: [OTHER_UID]}),
    );
  });

  it('rejects adding two uids in one write', async () => {
    // Rules have no loop, so a multi-uid add cannot be checked candidate by
    // candidate. Restricting growth to a single append is what keeps the
    // membership check expressible rather than skipped.
    await seedUserDoc({housemates: []});
    await seedEdge(OTHER_UID, UID, [OTHER_UID]);
    await seedEdge(THIRD_UID, UID, [THIRD_UID]);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {
        housemates: [OTHER_UID, THIRD_UID],
      }),
    );
  });

  it('rejects an append that also swaps in an unapproved uid', async () => {
    // Same size delta as a legitimate append, but two uids move: THIRD_UID
    // never asked and would arrive on the roster alongside the one that did.
    await seedUserDoc({housemates: ['uid-a', 'uid-b']});
    await seedEdge(OTHER_UID, UID, [OTHER_UID]);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {
        housemates: ['uid-a', THIRD_UID, OTHER_UID],
      }),
    );
  });

  it('enforces the four-person cap', async () => {
    await seedUserDoc({housemates: ['a', 'b', 'c', 'd']});
    await seedEdge(OTHER_UID, UID, [OTHER_UID]);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {
        housemates: ['a', 'b', 'c', 'd', OTHER_UID],
      }),
    );
  });

  it('allows the last slot under the cap', async () => {
    await seedUserDoc({housemates: ['a', 'b', 'c']});
    await seedEdge(OTHER_UID, UID, [OTHER_UID]);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', UID), {
        housemates: ['a', 'b', 'c', OTHER_UID],
      }),
    );
    expect(HOUSEMATE_CAP).toBe(4);
  });

  it('lets the owner remove a housemate freely', async () => {
    // Every removal reduces access, so it needs no guard beyond ownership —
    // in particular it must not require the friendship to still exist.
    await seedUserDoc({housemates: [OTHER_UID, THIRD_UID]});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', UID), {housemates: [THIRD_UID]}),
    );
  });

  it('rejects a create that arrives with a roster', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, 'users', UID), {housemates: [OTHER_UID]}),
    );
  });

  it('lets an unrelated field change without touching the roster', async () => {
    // housemateWriteOk must be a no-op for every write that leaves the field
    // alone, or it breaks every other user-doc update in the app.
    await seedUserDoc({housemates: [OTHER_UID], fcmToken: 'old'});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', UID), {fcmToken: 'new'}),
    );
  });
});

// ---------------------------------------------------------------------------
// publicProfiles/{uid} — the CF-owned projection (F3 / F5)
//
// users/{uid} carries displayName-adjacent fields in the same document as
// fcmToken, subscriptionTier and subscriptionExpiresAt, and Firestore has no
// field-level read security: a rule either exposes the document or it does
// not. So no `allow list` on users/{uid} can unblock search without handing
// every authenticated client the whole user document. publicProfiles is the
// projection that makes the two operations separable.
//
//   F3  searchUsers lists users where isPublic == true, which the users/{uid}
//       read rule (isOwner || isFriend) can never satisfy → permission-denied
//       on every search.
//   F5  getFriends reads a profile per friend entry. For a PENDING friend
//       isFriend() is false, that read throws, and the error propagates out of
//       friendsProvider — one pending request renders "Could not load
//       friends." instead of the pending badge.
//
// get and list are split deliberately. A blanket `allow read: if
// isAuthenticated()` would fix both, but it also lets any signed-in user who
// knows a uid read the name of someone who has turned discoverability OFF —
// strictly weaker than the posture users/{uid} has today. Instead `list`
// forces the query to carry the isPublic filter, and `get` widens only to the
// owner and to someone holding a friend edge.
// ---------------------------------------------------------------------------

/** Seeds publicProfiles/{uid} bypassing rules, as syncPublicProfile would. */
async function seedPublicProfile(
  uid: string,
  data: Record<string, unknown>,
) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'publicProfiles', uid), data);
  });
}

/** The projection syncPublicProfile writes. isPublic drives discoverability. */
function publicProfilePayload(isPublic: boolean) {
  return {
    displayName: 'Owner',
    avatarUrl: 'duck',
    cleanlinessScore: 42,
    isPublic,
  };
}

describe('publicProfiles/{uid} — get', () => {
  it('lets a stranger read a discoverable profile', async () => {
    // The whole point of the projection: discovery without exposing the user
    // document. A stranger has neither isOwner nor a friend edge.
    await seedPublicProfile(UID, publicProfilePayload(true));
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'publicProfiles', UID)));
  });

  it('rejects a stranger reading a non-discoverable profile', async () => {
    // Turning discoverability off must still mean something. This is the case
    // a blanket `allow read: if isAuthenticated()` would have given away.
    await seedPublicProfile(UID, publicProfilePayload(false));
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'publicProfiles', UID)));
  });

  it('lets a FAMILY member read a non-discoverable profile (W2-111)', async () => {
    // getFriendVisit reads this document BEFORE the layout, so without this
    // the family house grant is unreachable for the account it is for: a
    // member with discoverability off and no friend edge. Paired with the
    // stranger denial directly above — same profile, same isPublic: false,
    // and only family separates them.
    await seedPublicProfile(UID, publicProfilePayload(false));
    await seedSharedFamily();
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'publicProfiles', UID)));
  });

  it('🔴 rejects a member of ANOTHER family — the decoy again', async () => {
    await seedPublicProfile(UID, publicProfilePayload(false));
    await seedSharedFamily();
    await seedFamily('fam-next-door', [THIRD_UID]);
    await seedFamilyPointer(THIRD_UID, 'fam-next-door');
    const db = testEnv.authenticatedContext(THIRD_UID).firestore();
    await assertFails(getDoc(doc(db, 'publicProfiles', UID)));
  });

  it('lets the owner read their own non-discoverable profile', async () => {
    await seedPublicProfile(UID, publicProfilePayload(false));
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'publicProfiles', UID)));
  });

  it('lets a PENDING friend read a non-discoverable profile (F5)', async () => {
    // The F5 regression test. getFriends resolves display info for every
    // entry including pending ones; isFriend() requires status 'accepted', so
    // the rule matches on the mere EXISTENCE of the edge instead. Without
    // this, one pending request takes the entire Friends tab down.
    await seedPublicProfile(UID, publicProfilePayload(false));
    await seedPendingRequest(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'publicProfiles', UID)));
  });

  it('lets an accepted friend read a non-discoverable profile', async () => {
    await seedPublicProfile(UID, publicProfilePayload(false));
    await seedAcceptedFriendship();
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'publicProfiles', UID)));
  });

  it('rejects an unauthenticated read of a discoverable profile', async () => {
    await seedPublicProfile(UID, publicProfilePayload(true));
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'publicProfiles', UID)));
  });
});

describe('publicProfiles/{uid} — list', () => {
  it('lets a stranger list profiles filtered on isPublic (F3)', async () => {
    // The F3 regression test, and the exact query searchUsers must issue.
    await seedPublicProfile(UID, publicProfilePayload(true));
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertSucceeds(
      getDocs(query(
        collection(db, 'publicProfiles'),
        where('isPublic', '==', true),
      )),
    );
  });

  it('rejects an unfiltered list', async () => {
    // list rules are evaluated per returned document, so dropping the filter
    // pulls in non-discoverable profiles and the whole query is denied. This
    // is what forces the client to keep where('isPublic', isEqualTo: true).
    await seedPublicProfile(UID, publicProfilePayload(false));
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDocs(collection(db, 'publicProfiles')));
  });

  it('rejects a list that inverts the filter', async () => {
    await seedPublicProfile(UID, publicProfilePayload(false));
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      getDocs(query(
        collection(db, 'publicProfiles'),
        where('isPublic', '==', false),
      )),
    );
  });

  it('rejects an unauthenticated list', async () => {
    await seedPublicProfile(UID, publicProfilePayload(true));
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(
      getDocs(query(
        collection(db, 'publicProfiles'),
        where('isPublic', '==', true),
      )),
    );
  });
});

describe('publicProfiles/{uid} — writes are Admin-SDK only', () => {
  it('rejects a create by the profile owner', async () => {
    // cleanlinessScore is a score. If the client could write the projection,
    // it could forge one — the reason this is a CF-owned mirror and not just
    // a second document the client maintains.
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, 'publicProfiles', UID), publicProfilePayload(true)),
    );
  });

  it('rejects an update by the profile owner', async () => {
    await seedPublicProfile(UID, publicProfilePayload(true));
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'publicProfiles', UID), {cleanlinessScore: 100}),
    );
  });

  it('rejects a delete by the profile owner', async () => {
    await seedPublicProfile(UID, publicProfilePayload(true));
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, 'publicProfiles', UID)));
  });

  it('rejects a write by a stranger', async () => {
    await seedPublicProfile(UID, publicProfilePayload(true));
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'publicProfiles', UID), {displayName: 'Impostor'}),
    );
  });
});

// ---------------------------------------------------------------------------
// users/{uid}/economy/{doc=**} — the task-reward ledger
// ---------------------------------------------------------------------------
//
// economy/taskRewards records how many task completions have already been paid
// out today. grantTaskRewards pays only the delta against paidCount, so a
// client that could write this document could reset it to 0 and re-collect the
// day's sponges without limit. CF-only, like streak/ and rewardHistory/.
describe('users/{uid}/economy', () => {
  const ledgerPath = (uid: string) => `users/${uid}/economy/taskRewards`;

  async function seedLedger(uid: string) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ledgerPath(uid)), {
        date: '2026-06-29',
        paidCount: 8,
      });
    });
  }

  it('lets the owner read their own ledger', async () => {
    await seedLedger(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(getDoc(doc(db, ledgerPath(UID))));
  });

  it('rejects a create by the owner', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, ledgerPath(UID)), {date: '2026-06-29', paidCount: 0}),
    );
  });

  // The exploit this rule exists to stop: zeroing paidCount makes every task
  // completed today unpaid again, so the next call re-grants the full day.
  it('rejects an update that resets paidCount', async () => {
    await seedLedger(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(db, ledgerPath(UID)), {paidCount: 0}));
  });

  it('rejects a delete by the owner', async () => {
    await seedLedger(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, ledgerPath(UID))));
  });

  it('rejects a read by a stranger', async () => {
    await seedLedger(UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, ledgerPath(UID))));
  });
});

// ---------------------------------------------------------------------------
// users/{uid}/days/{dayKey} — the PER-DAY task-reward ledger (W2-174)
// ---------------------------------------------------------------------------
//
// CRITICAL: THIS COLLECTION IS THE MONEY GUARD. `recordTaskCompletion` took its day key
// from the caller (`clientNowIso.slice(0, 10)`), and the three counters —
// paidCount, xpPaidCount, bonusPaid — all reset when that key changed, so
// alternating two well-formed dates re-minted the day's pay. Measured: 15
// sponges against a free cap of 5, one account, three calls.
//
// The repair makes the DAY THE DOCUMENT ID, so a day can be settled once ever.
// A client that could write here would restore the exploit in one line, by
// zeroing or deleting the document for a day it had already been paid.
//
// WARNING: READ IS ALLOWED AND THAT IS DELIBERATE, unlike economy/ next door. Deploy 2
// of the migration drives the cap UI off a snapshot listener on today's
// document so the counter moves on tap through the offline cache instead of
// waiting on the callable. Watching is not writing.
describe('users/{uid}/days/{dayKey} — the per-day reward ledger', () => {
  const DAY = '2026-09-13';
  const dayPath = (uid: string) => `users/${uid}/days/${DAY}`;

  async function seedDay(uid: string) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), dayPath(uid)), {
        dayKey: DAY,
        paidCount: 1,
        xpPaidCount: 4,
        bonusPaid: true,
      });
    });
  }

  it('lets the owner read their own day ledger', async () => {
    await seedDay(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(getDoc(doc(db, dayPath(UID))));
  });

  it('rejects a create by the owner', async () => {
    // Pre-creating tomorrow's document with paidCount 0 would not help on its
    // own, but pre-creating it at all is a write to a ledger the server owns.
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, dayPath(UID)), {dayKey: DAY, paidCount: 0}),
    );
  });

  // CRITICAL: The exploit this block exists to stop, stated as an assertion: zeroing
  // paidCount makes every completion on that day unpaid again.
  it('rejects an update that resets paidCount', async () => {
    await seedDay(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(db, dayPath(UID)), {paidCount: 0}));
  });

  it('rejects an update that clears bonusPaid', async () => {
    // The third counter, and the one a fix aimed only at sponges would miss.
    // It is a BOOLEAN, so flipping it hands back the whole 2x extra rather
    // than a delta.
    await seedDay(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(db, dayPath(UID)), {bonusPaid: false}));
  });

  it('rejects an update that rewinds xpPaidCount', async () => {
    // XP is UNCAPPED, so a client that could rewind this counter could re-earn
    // XP for every completed task on every call — silently, because nobody
    // watches XP the way they watch sponges.
    await seedDay(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(db, dayPath(UID)), {xpPaidCount: 0}));
  });

  it('rejects a DELETE by the owner — the cheapest reset of all', async () => {
    // Deny-write covers delete, and it has to: a deleted day document reads as
    // an unsettled day, which is the same mint with fewer keystrokes.
    await seedDay(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, dayPath(UID))));
  });

  it('rejects a read by a stranger', async () => {
    await seedDay(UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, dayPath(UID))));
  });

  it('rejects a read by an accepted FRIEND', async () => {
    // users/{uid} is friend-readable by design and rules do not cascade. A
    // cleaning cap is nobody else's business.
    await seedDay(UID);
    await seedAcceptedFriendship();
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, dayPath(UID))));
  });

  it('rejects an unauthenticated read', async () => {
    await seedDay(UID);
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, dayPath(UID))));
  });
});

// ---------------------------------------------------------------------------
// CRITICAL: THE AMENDMENT'S OWN REGRESSION CHECK — users/{uid} STAYS CLIENT-WRITABLE
// ---------------------------------------------------------------------------
//
// `Projects/Cleaning/dayKey-migration-2026-09-13.md` proposes locking the day
// ledger with this snippet:
//
//     match /users/{uid} {
//       allow write: if false;     // functions only
//       match /days/{dayKey} { allow write: if false; }
//     }
//
// CRITICAL: THE OUTER HALF MUST NOT BE APPLIED, AND IT WAS NOT. It breaks two live
// client write paths, and the rules file already carries the argument at its
// create/update split: a single `allow write` has to call
// `resource.data.diff(...)`, which ERRORS — and therefore DENIES — on a create,
// because `resource` is null. This repo has already shipped that bug once and
// silently broke the first write to users/{uid}.
//
// The two paths, both `set(merge:)` against a document that may not exist yet:
//   · privacy_settings_notifier.setDiscoverable — writes `isPublic`
//   · fcm_service.saveToken / clearLegacyToken  — writes users/{uid}/private/push
//     and clears the legacy users/{uid}.fcmToken
//
// These are DEMONSTRATED rather than asserted in prose, because the whole point
// of the amendment is that the prose version of this claim was wrong once.
describe('🔴 locking the day ledger did not lock users/{uid} — the live writes still pass', () => {
  it('setDiscoverable CREATES users/{uid} when no document exists', async () => {
    // The exact call: set(merge:) with only `isPublic`, on an account that has
    // never had a user document — orientation does not create one, sign-up
    // touches Auth alone.
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', UID), {isPublic: true}, {merge: true}),
    );
  });

  it('setDiscoverable UPDATES an existing users/{uid}', async () => {
    await seedUserDoc({isPublic: true, housemates: []});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', UID), {isPublic: false}, {merge: true}),
    );
  });

  it('the FCM token write to users/{uid}/private/push still passes', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      setDoc(
        doc(db, 'users', UID, 'private', 'push'),
        {fcmToken: 'token-abc'},
        {merge: true},
      ),
    );
  });

  it('clearing the LEGACY users/{uid}.fcmToken still passes', async () => {
    // The migration write in fcm_service: the private copy is written, then the
    // legacy field on the parent is deleted through a set(merge:). A blanket
    // `allow write: if false` on users/{uid} would strand every account
    // mid-migration with the token in two places.
    await seedUserDoc({fcmToken: 'legacy-copy', housemates: []});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      setDoc(doc(db, 'users', UID), {fcmToken: deleteField()}, {merge: true}),
    );
  });

  it('and the door did NOT swing open — a CF-owned field is still refused', async () => {
    // KEY: THE CONTROL. Four passing writes prove nothing on their own: they would
    // also pass against a rules file with no user block at all, which is the
    // failure mode opposite to the one the amendment prevents.
    await seedUserDoc({subscriptionTier: 'free', housemates: []});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, 'users', UID), {subscriptionTier: 'pro'}, {merge: true}),
    );
  });
});

// W2-26 — the per-day feedback counter.
//
// This document IS the bound on how much a stranger can write. A client that
// could zero it could file without limit, which is the whole point of the cap.
describe('users/{uid}/feedbackCounts', () => {
  const countPath = (uid: string) => `users/${uid}/feedbackCounts/2026-08-12`;

  async function seedCount(uid: string) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), countPath(uid)), {date: '2026-08-12', count: 100});
    });
  }

  it('lets the owner read their own count', async () => {
    await seedCount(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(getDoc(doc(db, countPath(UID))));
  });

  // CRITICAL: The exploit the cap exists to stop: zero the counter, file forever.
  it('rejects an update that resets the count', async () => {
    await seedCount(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(db, countPath(UID)), {count: 0}));
  });

  it('rejects a delete, which is the same exploit by another route', async () => {
    await seedCount(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, countPath(UID))));
  });

  it('rejects a create by the owner', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(setDoc(doc(db, countPath(UID)), {date: '2026-08-12', count: 0}));
  });

  it('rejects a read by a stranger', async () => {
    await seedCount(UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, countPath(UID))));
  });
});

// W2-23 — tester feedback on gallery specimens.
//
// The only collection in the app a stranger WRITES arbitrary text into, so its
// rules are the ones worth being exact about. create-only, owner-stamped, and
// read-denied even to the author: the export runs Admin-side, so nothing needs
// client read, and allowing it would let any tester read every other tester's
// comments.
describe('galleryFeedback', () => {
  const item = (uid: string) => ({
    uid,
    specimenKey: 'Auth/Login/error',
    appVersion: '1.4.2+42',
    lassos: [{rect: {x: 0.1, y: 0.1, width: 0.2, height: 0.2}, colourIndex: 0, comment: 'hi'}],
  });

  it('lets a signed-in tester file their own feedback', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(setDoc(doc(db, 'galleryFeedback/f1'), item(UID)));
  });

  // CRITICAL: Owner-stamping: the uid ON THE DOCUMENT must be the caller's, or one
  // tester could file comments under another's name.
  it('rejects filing under someone else\'s uid', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(setDoc(doc(db, 'galleryFeedback/f2'), item(OTHER_UID)));
  });

  it('rejects an anonymous write', async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, 'galleryFeedback/f3'), item(UID)));
  });

  // A comment that can be edited or deleted is a sentence that can be lost, and
  // the sentence is the whole product.
  it('rejects an update, even by the author', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'galleryFeedback/f4'), item(UID));
    });
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(db, 'galleryFeedback/f4'), {lassos: []}));
  });

  it('rejects a delete, even by the author', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'galleryFeedback/f5'), item(UID));
    });
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, 'galleryFeedback/f5')));
  });

  // WARNING: Read is denied to the AUTHOR too, not just to strangers.
  it('denies read to the author and to everyone else', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'galleryFeedback/f6'), item(UID));
    });
    const mine = testEnv.authenticatedContext(UID).firestore();
    const theirs = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(mine, 'galleryFeedback/f6')));
    await assertFails(getDoc(doc(theirs, 'galleryFeedback/f6')));
  });
});

// W2-20 — the replay ledgers, and the default-deny that guards one of them.
//
// CRITICAL: users/{uid}/shieldPurchases/{id} HAS NO RULES BLOCK. It is protected by
// Firestore default-denying anything no `match` reaches — an ABSENCE, which is
// what a well-meaning change deletes. A convenience `match /users/{uid}/{doc=**}`
// would open it and nothing would go red. rulesNoCatchAll.test.ts guards against
// that edit in the UNIT suite (which always runs); this proves the behaviour
// against the real emulator.
//
// WARNING: Deliberately NOT given a rules block. Default-deny is already correct, and
// a block that restates it is a block someone can later loosen.
describe('users/{uid}/shieldPurchases — protected by having no rule at all', () => {
  const shieldPath = (uid: string) => `users/${uid}/shieldPurchases/pk_abc123`;

  async function seedShield(uid: string) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), shieldPath(uid)), {
        spent: 150,
      });
    });
  }

  // CRITICAL: The one that matters: deleting a ledger row would let the player re-buy
  // the shield they already paid for, undoing W2-19 entirely.
  it('rejects a delete by the owner', async () => {
    await seedShield(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, shieldPath(UID))));
  });

  it('rejects a create — a client cannot pre-claim an id to lock itself out', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(setDoc(doc(db, shieldPath(UID)), {spent: 0}));
  });

  it('rejects an update by the owner', async () => {
    await seedShield(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(db, shieldPath(UID)), {spent: 0}));
  });

  // WARNING: Default-deny denies READ too, unlike its sibling chestPurchases which has
  // an explicit owner-read block. Asserted so the asymmetry is a recorded fact
  // rather than a surprise the first time someone builds a purchase history.
  it('denies READ to the owner as well — the asymmetry with chestPurchases', async () => {
    await seedShield(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(getDoc(doc(db, shieldPath(UID))));
  });

  it('rejects a stranger entirely', async () => {
    await seedShield(UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, shieldPath(UID))));
  });

  // An unmatched path chosen at random, proving the default-deny is general and
  // not something specific to this collection name.
  it('an arbitrary unmatched path under the user is denied too', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(setDoc(doc(db, `users/${UID}/notAThing/x`), {a: 1}));
  });
});

// W2-17 — the mini-game claim ledger.
//
// users/{uid}/economy/minigame is what stops a second claim in one day. It is
// NOT a new rules block — `match /economy/{doc=**}` already covers it — and that
// is precisely why it is asserted here rather than assumed: a wildcard you have
// not tested at the specific path is a wildcard you believe in.
describe('users/{uid}/economy/minigame', () => {
  const gamePath = (uid: string) => `users/${uid}/economy/minigame`;

  async function seedGame(uid: string) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), gamePath(uid)), {
        date: '2026-08-12',
        claimed: true,
      });
    });
  }

  it('lets the owner read their own claim ledger', async () => {
    await seedGame(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(getDoc(doc(db, gamePath(UID))));
  });

  // The exploit: clear `claimed`, or roll `date` back, and claim again today.
  it('rejects an update that un-claims the day', async () => {
    await seedGame(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(db, gamePath(UID)), {claimed: false}));
  });

  it('rejects a delete, which would be the same exploit by another route', async () => {
    await seedGame(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, gamePath(UID))));
  });

  it('rejects a create by the owner', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(setDoc(doc(db, gamePath(UID)), {date: '2026-08-12', claimed: false}));
  });
});

// W2-11 — the completion log.
//
// One record per (task, day), written only by recordTaskCompletion. Quest
// progress is derived from it, so a client that could write here could
// manufacture completions; a client that could DELETE here could retract one and
// re-earn the reward, which is the exploit the log closes.
describe('users/{uid}/completions', () => {
  const logPath = (uid: string) => `users/${uid}/completions/2026-08-12_t_dish`;

  async function seedLog(uid: string) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), logPath(uid)), {
        taskId: 't_dish',
        room: 'RoomType.kitchen',
        title: 'Wash the dishes',
        dayKey: '2026-08-12',
      });
    });
  }

  it('lets the owner read their own completion log', async () => {
    await seedLog(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(getDoc(doc(db, logPath(UID))));
  });

  // Manufacturing a completion is as good as doing the task.
  it('rejects a create by the owner', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, logPath(UID)), {
        taskId: 't_dish',
        room: 'RoomType.kitchen',
        title: 'Wash the dishes',
        dayKey: '2026-08-12',
      }),
    );
  });

  // CRITICAL: The exploit itself: delete the record, re-complete, earn it twice.
  it('rejects a delete by the owner — this is the retraction the log forbids', async () => {
    await seedLog(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, logPath(UID))));
  });

  it('rejects an update that rewrites which day a task was done', async () => {
    await seedLog(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(db, logPath(UID)), {dayKey: '2026-08-13'}));
  });

  it('rejects a read by a stranger', async () => {
    await seedLog(UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, logPath(UID))));
  });
});

// W2-10 — quest state.
//
// users/{uid}/quests/state holds `claimedTiers`, which is the ONLY thing
// stopping a player re-collecting a quest reward forever, and the progress
// counters that decide when a reward is due at all. A client that could write
// here could award itself unlimited sponges and hand itself chests it never
// earned. CF-only, like streak/ and economy/.
describe('users/{uid}/quests', () => {
  const questPath = (uid: string) => `users/${uid}/quests/state`;

  async function seedQuests(uid: string) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), questPath(uid)), {
        quests: {bed_head: {value: 2, lastDay: '2026-08-12', claimedTiers: []}},
      });
    });
  }

  it('lets the owner read their own quest state', async () => {
    await seedQuests(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(getDoc(doc(db, questPath(UID))));
  });

  it('rejects a create by the owner', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(setDoc(doc(db, questPath(UID)), {quests: {}}));
  });

  // The exploit this rule exists to stop: clearing claimedTiers makes every
  // tier unpaid again, so the next completion re-grants the whole quest line.
  it('rejects an update that clears claimedTiers', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), questPath(UID)), {
        quests: {bed_head: {value: 8, lastDay: '2026-08-12', claimedTiers: [3, 5, 8]}},
      });
    });
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, questPath(UID)), {'quests.bed_head.claimedTiers': []}),
    );
  });

  // The other half: inflating progress is as good as clearing the ledger.
  it('rejects an update that inflates progress', async () => {
    await seedQuests(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, questPath(UID)), {'quests.bed_head.value': 999}),
    );
  });

  it('rejects a delete by the owner', async () => {
    await seedQuests(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, questPath(UID))));
  });

  it('rejects a read by a stranger', async () => {
    await seedQuests(UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, questPath(UID))));
  });
});

// ---------------------------------------------------------------------------
// W2-08 — the chest replay ledger
//
// purchaseChest lost its daily cap, and that cap was also the only thing
// stopping a retried call from charging twice. The replacement is a ledger doc
// created inside the purchase transaction under a caller-supplied purchaseId.
// It is only worth anything if the client cannot touch it.
// ---------------------------------------------------------------------------

describe('users/{uid}/chestPurchases — the replay ledger is Admin-SDK only', () => {
  const ledgerPath = (uid: string) => `users/${uid}/chestPurchases/tap-1`;

  async function seedPurchase(uid: string) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), ledgerPath(uid)), {
        chestId: 'chest_furniture_2026-08-06',
        itemId: 'furn_sofa_cream',
      });
    });
  }

  it('lets the owner read their own purchase ledger', async () => {
    await seedPurchase(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(getDoc(doc(db, ledgerPath(UID))));
  });

  // The exploit: pre-claiming an id the client is about to use would lock the
  // player out of their own purchase.
  it('rejects a create by the owner', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(setDoc(doc(db, ledgerPath(UID)), {chestId: 'x'}));
  });

  // The worse exploit: deleting the entry replays the grant for free.
  it('rejects a delete by the owner', async () => {
    await seedPurchase(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, ledgerPath(UID))));
  });

  it('rejects an update by the owner', async () => {
    await seedPurchase(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(db, ledgerPath(UID)), {chestId: 'other'}));
  });

  it('rejects a read by a stranger', async () => {
    await seedPurchase(UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, ledgerPath(UID))));
  });
});

// ---------------------------------------------------------------------------
// users/{uid}/friends/{GIBBY_UID} — the permanent starter friend
//
// Gibby is PERMANENT: he does not disappear when real friends are added, and
// the client must not be able to remove him. The delete rule was
//   allow delete: if isAuthenticated() && (isOwner(uid) || isOwner(friendUid));
// which let any client unfriend him from either side — and nothing recreates
// the edge, because the creation trigger fires once per ACCOUNT, not per visit
// to the Friends tab. One tap and Gibby was gone for good.
// ---------------------------------------------------------------------------

const GIBBY = 'gibby';

/** Seeds the accepted Gibby edges the way the Admin SDK writes them. */
async function seedGibbyFriendship(userUid: string) {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const edge = {
      status: 'accepted',
      addedAt: '2026-08-08T00:00:00.000Z',
      requesterUid: GIBBY,
    };
    await setDoc(doc(db, 'users', userUid, 'friends', GIBBY), edge);
    await setDoc(doc(db, 'users', GIBBY, 'friends', userUid), edge);
  });
}

describe('users/{uid}/friends/{friendUid} — Gibby is permanent', () => {
  it('rejects unfriending Gibby from the user side', async () => {
    await seedGibbyFriendship(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, 'users', UID, 'friends', GIBBY)));
  });

  it('rejects unfriending Gibby from Gibby side', async () => {
    // The other half of the same edge. isOwner(friendUid) made this reachable
    // by the user, so carving out only the first path leaves the door open.
    await seedGibbyFriendship(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, 'users', GIBBY, 'friends', UID)));
  });

  it('rejects a stranger deleting someone else Gibby edge', async () => {
    await seedGibbyFriendship(UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(deleteDoc(doc(db, 'users', UID, 'friends', GIBBY)));
  });

  it('still lets a real friendship be deleted from either side', async () => {
    // The carve-out must be Gibby-shaped, not a blanket ban: unfriending a
    // real person is a supported action and stays supported.
    await seedPendingRequest(OTHER_UID, UID);
    const dbOwner = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      deleteDoc(doc(dbOwner, 'users', UID, 'friends', OTHER_UID)),
    );
    await assertSucceeds(
      deleteDoc(doc(dbOwner, 'users', OTHER_UID, 'friends', UID)),
    );
  });
});

// ---------------------------------------------------------------------------
// housemateTokens/{code} — W4-36, the verification token
// ---------------------------------------------------------------------------
//
// CRITICAL: THE DOCUMENT ID IS THE SECRET. Everywhere else in this file a deny-write
// block is about integrity; here read matters just as much, because a client
// that could `list` this collection would hold every live code in the app and
// could redeem them all without ever standing next to anybody.
//
// WARNING: These rules are NOT what makes redemption safe. The callable writes through
// the Admin SDK, which bypasses rules entirely — the transaction in
// redeemHousemateToken is the enforcement, and housemateToken.ts explains why no
// rule can do that job. What this block does is close the collection to
// clients, which is a different and still necessary thing.

describe('housemateTokens/{code} is closed to clients in both directions', () => {
  /** A live token, written out of band exactly as the mint callable would. */
  async function seedToken(code: string, hostUid: string) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'housemateTokens', code), {
        hostUid,
        createdAtMs: 1_700_000_000_000,
        expiresAtMs: 1_700_000_045_000,
      });
    });
  }

  it('DENIES reading a token you did not mint', async () => {
    await seedToken('ABCDEFGHJK', UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'housemateTokens', 'ABCDEFGHJK')));
  });

  it('DENIES reading a token you DID mint — the code came back in the response', async () => {
    // The host has no reason to read it: mintHousemateToken returns the code.
    // Allowing an owner read would mean storing hostUid where a query could
    // reach it, and a query is exactly what must not exist here.
    await seedToken('ABCDEFGHJK', UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(getDoc(doc(db, 'housemateTokens', 'ABCDEFGHJK')));
  });

  it('🔴 DENIES listing the collection — that would be every live code at once', async () => {
    await seedToken('ABCDEFGHJK', UID);
    await seedToken('MNPQRSTVWX', OTHER_UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDocs(collection(db, 'housemateTokens')));
  });

  it('DENIES minting a token client-side', async () => {
    // A client-minted token names its own host. That is the self-grant the
    // whole feature exists to prevent, one document earlier than the roster.
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      setDoc(doc(db, 'housemateTokens', 'ABCDEFGHJK'), {
        hostUid: UID,
        createdAtMs: 1_700_000_000_000,
        expiresAtMs: 1_700_000_045_000,
      }),
    );
  });

  it('🔴 DENIES clearing redeemedAtMs — that field IS the single use', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'housemateTokens', 'ABCDEFGHJK'), {
        hostUid: UID,
        createdAtMs: 1_700_000_000_000,
        expiresAtMs: 1_700_000_045_000,
        redeemedAtMs: 1_700_000_001_000,
        redeemedByUid: OTHER_UID,
      });
    });
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'housemateTokens', 'ABCDEFGHJK'), {redeemedAtMs: null}),
    );
  });

  it('DENIES pushing the expiry out — a token that can be extended is not short-lived', async () => {
    await seedToken('ABCDEFGHJK', UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'housemateTokens', 'ABCDEFGHJK'), {
        expiresAtMs: 9_999_999_999_999,
      }),
    );
  });

  it('DENIES deleting a spent token — a delete is a replay', async () => {
    await seedToken('ABCDEFGHJK', UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, 'housemateTokens', 'ABCDEFGHJK')));
  });

  it('DENIES an unauthenticated client everything', async () => {
    await seedToken('ABCDEFGHJK', UID);
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'housemateTokens', 'ABCDEFGHJK')));
    await assertFails(
      setDoc(doc(db, 'housemateTokens', 'ZZZZZZZZZZ'), {hostUid: UID}),
    );
  });
});

describe('🔑 the roster stays server-only on the redemption path', () => {
  // The property the callable exists to hold, asserted from the client side:
  // whatever redeemHousemateToken does, no client may reach the same result by
  // writing documents itself.

  it('a guest holding a valid token still cannot write the host roster', async () => {
    // Possession of a code grants nothing at the rules layer — there is no rule
    // anywhere that consults housemateTokens, deliberately. The ONLY thing that
    // turns a code into an edge is the callable.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'housemateTokens', 'ABCDEFGHJK'), {
        hostUid: UID,
        createdAtMs: 1_700_000_000_000,
        expiresAtMs: 1_700_000_045_000,
      });
    });
    await seedUserDoc({housemates: []});
    await seedEdge(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {housemates: [OTHER_UID]}),
    );
  });

  it('a host cannot write a roster entry for a guest who never asked', async () => {
    // The token path does not use housePendingFrom, so the client-side rule is
    // unchanged and must stay exactly as strict as it was.
    await seedUserDoc({housemates: []});
    await seedEdge(OTHER_UID, UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {housemates: [OTHER_UID]}),
    );
  });

  it('the cap still binds a client write after a server grant', async () => {
    // A redemption writes the roster through the Admin SDK. The next CLIENT
    // append must still be refused at four — the server path must not leave the
    // document in a state the rules then wave through.
    await seedRoster(UID, ['a', 'b', 'c', 'd']);
    await seedEdge(OTHER_UID, UID, [OTHER_UID]);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {
        housemates: ['a', 'b', 'c', 'd', OTHER_UID],
      }),
    );
    expect(HOUSEMATE_CAP).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// The subscription-notification collections — both Admin SDK only
//
// Neither is reachable by any client, and `subscriptionOwners` is the one worth
// arguing about: its document id is a subscription and its body is a uid, so a
// readable copy is a directory of everybody who pays. Denying read is not
// symmetry for its own sake.
// ---------------------------------------------------------------------------

describe('processedNotifications/{notificationUUID} is closed to clients', () => {
  const UUID = '9f8a7b6c-5d4e-3f2a-1b0c-9d8e7f6a5b4c';

  async function seedNotification() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'processedNotifications', UUID), {
        uid: UID,
        notificationType: 'DID_RENEW',
        effect: 'entitle',
      });
    });
  }

  it('an authenticated client cannot read a notification ledger entry', async () => {
    await seedNotification();
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(getDoc(doc(db, 'processedNotifications', UUID)));
  });

  it('an unauthenticated client cannot read one either', async () => {
    await seedNotification();
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'processedNotifications', UUID)));
  });

  it('a client cannot list the collection', async () => {
    await seedNotification();
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(getDocs(collection(db, 'processedNotifications')));
  });

  it('a client cannot forge a ledger entry to suppress a real notification', async () => {
    // KEY: The write that would MATTER. The endpoint returns early when the lock
    // exists, so a client able to create one could pre-empt its own EXPIRED or
    // REFUND and keep an entitlement it no longer has.
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, 'processedNotifications', UUID), {uid: UID, effect: 'entitle'}),
    );
  });

  it('a client cannot delete a ledger entry to replay a renewal', async () => {
    await seedNotification();
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, 'processedNotifications', UUID)));
  });
});

describe('subscriptionOwners/{originalTransactionId} is closed in both directions', () => {
  const ORIGINAL_TX = 'tx-original-1';

  async function seedOwner(uid = UID) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'subscriptionOwners', ORIGINAL_TX), {
        uid,
        productId: 'sub_pro_monthly',
      });
    });
  }

  it('a client cannot read the mapping — not even to its OWN subscription', async () => {
    // Denied by path, not by ownership. There is no client-side reason to
    // resolve a transaction to an account at all, so the rule does not need to
    // reason about who is asking.
    await seedOwner(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(getDoc(doc(db, 'subscriptionOwners', ORIGINAL_TX)));
  });

  it("a client cannot read another account's mapping", async () => {
    await seedOwner(OTHER_UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(getDoc(doc(db, 'subscriptionOwners', ORIGINAL_TX)));
  });

  it('a client cannot LIST the collection — that would enumerate every subscriber', async () => {
    // The reason read is denied rather than scoped to the owner: the collection
    // as a whole is a directory of who pays.
    await seedOwner();
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(getDocs(collection(db, 'subscriptionOwners')));
  });

  it('a client cannot claim an unowned subscription by creating a mapping', async () => {
    // CRITICAL: THE WRITE THAT WOULD HAND OVER SOMEBODY ELSE'S SUBSCRIPTION. The
    // notification endpoint trusts this document to say who a renewal belongs
    // to, so a forged entry redirects every future rebill of a real, paid
    // subscription onto the attacker's account.
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, 'subscriptionOwners', ORIGINAL_TX), {
        uid: UID,
        productId: 'sub_pro_monthly',
      }),
    );
  });

  it("a client cannot repoint an existing mapping at itself", async () => {
    await seedOwner(OTHER_UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'subscriptionOwners', ORIGINAL_TX), {uid: UID}),
    );
  });

  it('a client cannot delete a mapping to orphan an account from its renewals', async () => {
    await seedOwner();
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, 'subscriptionOwners', ORIGINAL_TX)));
  });

  it('an unauthenticated client is refused the same way', async () => {
    await seedOwner();
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'subscriptionOwners', ORIGINAL_TX)));
    await assertFails(
      setDoc(doc(db, 'subscriptionOwners', 'tx-anything'), {uid: UID}),
    );
  });
});

// ---------------------------------------------------------------------------
// KEY: families/{familyId} — the group document (W2-76)
// ---------------------------------------------------------------------------
//
// WARNING: MOST OF THIS BLOCK IS PINS, AND IT IS LABELLED AS SUCH. Firestore
// default-denies, so deleting the whole match block leaves every assertBails
// below still passing — the same measurement W2-68 recorded when 12 new tests
// survived the deletion of both match blocks they covered. Only the two
// CONTROL tests are catches, and each names the exact edit that turns it red.
//
// The one rule here with a real condition is `get`, and its control is to
// replace the membership check with a bare isAuthenticated().
describe('families/{familyId} — membership gates the read', () => {
  const FAMILY_ID = 'family-1';

  async function seedFamily(memberUids = [UID, THIRD_UID]) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'families', FAMILY_ID), {
        ownerUid: memberUids[0],
        memberUids,
        createdAtMs: 1_760_000_000_000,
      });
    });
  }

  it('🔴 CONTROL: a NON-MEMBER cannot read the family', async () => {
    // The catch. Replace the membership condition in the families block with a
    // bare `isAuthenticated()` and this goes red while every other test in the
    // block stays green — which is the whole reason it is written this way
    // round. A family document carries the roster and, once the later briefs
    // land, the message board; it is not public to every signed-in account.
    await seedFamily([UID, THIRD_UID]);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'families', FAMILY_ID)));
  });

  it('a member CAN read the family they belong to', async () => {
    // The inverse control. Without it, denying every read would satisfy the
    // test above and the feature would be unusable rather than secure.
    await seedFamily([UID, THIRD_UID]);
    const db = testEnv.authenticatedContext(THIRD_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'families', FAMILY_ID)));
  });

  it('the owner can read it too — the owner is a member who pays', async () => {
    await seedFamily([UID, THIRD_UID]);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'families', FAMILY_ID)));
  });

  it('an unauthenticated client is refused', async () => {
    await seedFamily();
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'families', FAMILY_ID)));
  });

  it('a family document with no memberUids field denies rather than errors', async () => {
    // The rule reads memberUids through .get(…, []) for the same reason
    // housemates() does: a malformed or half-written document must DENY, not
    // error the expression out — an error would deny a member's own read too,
    // which looks identical from the client and is a different bug.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'families', FAMILY_ID), {
        ownerUid: UID,
        createdAtMs: 1,
      });
    });
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(getDoc(doc(db, 'families', FAMILY_ID)));
  });

  it('🔴 a client cannot LIST families — that would enumerate every roster', async () => {
    // Denied separately from get, and deliberately. A query rule cannot
    // inspect each returned document, so any workable allow-list would have to
    // trust a client-supplied constraint.
    await seedFamily();
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(getDocs(collection(db, 'families')));
  });
});

describe('families/{familyId} — every write is denied, including the owner\'s', () => {
  const FAMILY_ID = 'family-2';

  async function seedFamily(memberUids = [UID, THIRD_UID]) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'families', FAMILY_ID), {
        ownerUid: memberUids[0],
        memberUids,
        createdAtMs: 1_760_000_000_000,
      });
    });
  }

  it('🔴 a stranger cannot ADD THEMSELVES to a paying family', async () => {
    // The write that would buy a $12.99 subscription for free. The entitlement
    // fan-out reads memberUids to decide who gets Pro, so an editable roster
    // is a self-service Pro grant — which is why the rule denies writes rather
    // than scoping them to the owner.
    await seedFamily([UID, THIRD_UID]);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'families', FAMILY_ID), {
        memberUids: [UID, THIRD_UID, OTHER_UID],
      }),
    );
  });

  it('🔴 the OWNER cannot edit the roster either', async () => {
    // The one most likely to be read as over-strict, so it is pinned. An owner
    // who could edit memberUids could hand Pro to arbitrary uids and past the
    // cap; membership changes go through a callable, for the same reason
    // housemate redemption does — rules cannot bind two writes, and this one
    // has a subscription on the other end.
    await seedFamily([UID, THIRD_UID]);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'families', FAMILY_ID), {
        memberUids: [UID, THIRD_UID, OTHER_UID],
      }),
    );
  });

  it('a member cannot repoint ownerUid at itself', async () => {
    await seedFamily([UID, THIRD_UID]);
    const db = testEnv.authenticatedContext(THIRD_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'families', FAMILY_ID), {ownerUid: THIRD_UID}),
    );
  });

  it('a client cannot CREATE a family from scratch', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, 'families', 'family-forged'), {
        ownerUid: UID,
        memberUids: [UID, OTHER_UID],
        createdAtMs: 1,
      }),
    );
  });

  it('a member cannot DELETE the family', async () => {
    await seedFamily();
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(deleteDoc(doc(db, 'families', FAMILY_ID)));
  });
});

describe('🔴 users/{uid}.familyId is CF-owned (W2-82)', () => {
  // Stamped by createFamily. CRITICAL: IT IS THE KEY EVERY FAMILY READ IS SCOPED BY:
  // completeTrashDay verifies membership against the family the CLIENT names,
  // and the trash-day rules grant reads to members of the named family — so a
  // self-assigned familyId is how a client would choose which household to
  // point at in the first place.
  //
  // CRITICAL: A CATCH, NOT A PIN: remove 'familyId' from userCfOwnedFields() and all
  // three below go red, because the surrounding `allow update` otherwise lets
  // an owner write their own document freely.
  async function seedUser(extra = {}) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', UID), {
        displayName: 'Owner',
        subscriptionTier: 'free',
        ...extra,
      });
    });
  }

  it('a client cannot POINT ITSELF at a family', async () => {
    await seedUser();
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {familyId: 'fam-someone-elses'}),
    );
  });

  it('an owner cannot REPOINT, which would orphan their own family', async () => {
    // The members' grant is copied from the family this points at. Rewriting it
    // strands them behind a document nobody owns any more.
    await seedUser({familyId: 'fam-ours'});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {familyId: 'fam-theirs'}),
    );
  });

  it('a client cannot CLEAR it', async () => {
    await seedUser({familyId: 'fam-ours'});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(updateDoc(doc(db, 'users', UID), {familyId: null}));
  });

  it('🔴 CONTROL — an ordinary field on the same document still writes', async () => {
    // Without this, a rule that denied every update would pass all three above
    // and the refusals would mean nothing about familyId specifically.
    await seedUser({familyId: 'fam-ours'});
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', UID), {displayName: 'Renamed'}),
    );
  });
});

describe('🔴 users/{uid}.familyProExpiresAt is CF-owned', () => {
  // The field resolveEffectiveTier now reads. A client that could write it
  // would grant itself Pro indefinitely WITHOUT needing a family, a
  // subscription, or any other document — an easier self-grant than
  // subscriptionExpiresAt guards, because there is no tier string to set too.
  //
  // CRITICAL: THIS ONE IS A CATCH, NOT A PIN: remove 'familyProExpiresAt' from
  // userCfOwnedFields() and both tests below go red, because the surrounding
  // `allow update` otherwise permits an owner to write their own document.
  async function seedUser() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', UID), {
        displayName: 'Owner',
        subscriptionTier: 'free',
      });
    });
  }

  it('the owner cannot SET it — that is a free Pro subscription', async () => {
    await seedUser();
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {
        familyProExpiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000,
      }),
    );
  });

  it('the owner cannot CLEAR it either', async () => {
    // Self-harm rather than escalation, but still not the client's call — the
    // same reasoning proPromoGrantedAt carries.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', UID), {
        displayName: 'Owner',
        subscriptionTier: 'free',
        familyProExpiresAt: 1_760_000_000_000,
      });
    });
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID), {familyProExpiresAt: null}),
    );
  });

  it('an ordinary client-owned field on the same document still writes', async () => {
    // The inverse control. Without it, a rule that denied ALL updates would
    // satisfy both tests above and break every legitimate client write.
    await seedUser();
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertSucceeds(
      updateDoc(doc(db, 'users', UID), {displayName: 'Renamed'}),
    );
  });
});

// ---------------------------------------------------------------------------
// KEY: users/{uid}/pendingChests and adminGrants/{grantId} — the grant path (W2-122)
// ---------------------------------------------------------------------------
//
// CRITICAL: THE WRITE DENIALS ARE THE POINT, AND THEY ARE NOT THE SAME DENIAL.
// An unopened chest is a PROMISE OF A ROLL: a client that could write the
// collection could mint itself chests, and one that could write `openedAt`
// could re-open the same chest forever. The audit ledger is worse — a client
// that could write `adminGrants/{grantId}` could PRE-CREATE the idempotency
// lock, and a real grant would then return `alreadyProcessed` having written
// nothing. That is a denial of service against your own gift.
//
// WARNING: Admin SDK writes bypass rules entirely, so the secret gate in `adminGrant`
// is the security boundary for ISSUING. These rules stop the CLIENT, which is
// the only party they can stop.

describe('users/{uid}/pendingChests — the owner reads, nobody writes', () => {
  async function seedPendingChest(uid: string) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'users', uid, 'pendingChests', 'g1_0'), {
        category: 'characters',
        dropTable: 'rich',
        grantId: 'g1',
        openedAt: null,
      });
    });
  }

  it('the owner CAN read it — an unopened chest they cannot see is not a gift', async () => {
    await seedPendingChest(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    const snap = await assertSucceeds(
      getDoc(doc(db, 'users', UID, 'pendingChests', 'g1_0')),
    );
    expect(snap.data()!.category).toBe('characters');
  });

  it('🔴 CONTROL: another player cannot read it', async () => {
    // Without this, "the owner can read" would be satisfied by a rule granting
    // every signed-in account. Rules do NOT cascade from users/{uid}, which
    // allows isFriend — so a reader will guess wrong about this in either
    // direction unless it is pinned.
    await seedPendingChest(UID);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'users', UID, 'pendingChests', 'g1_0')));
  });

  it('🔴 the OWNER cannot MINT one — this is the self-service chest', async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, 'users', UID, 'pendingChests', 'forged'), {
        category: 'characters',
        dropTable: 'rich',
        openedAt: null,
      }),
    );
  });

  it('🔴 and cannot write openedAt — that would re-open the same chest forever', async () => {
    await seedPendingChest(UID);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'users', UID, 'pendingChests', 'g1_0'), {openedAt: null}),
    );
  });
});

describe('adminGrants/{grantId} — denied outright, including to the recipient', () => {
  async function seedGrant() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'adminGrants', 'g1'), {
        uid: UID,
        grantId: 'g1',
        granted: {sponges: 1000, itemIds: [], alreadyOwned: [], pendingChestIds: []},
      });
    });
  }

  it('🔴 even the RECIPIENT cannot read their own grant record', async () => {
    // It is an admin action they were never party to, and it doubles as the
    // idempotency lock — a readable ledger is an enumerable one.
    await seedGrant();
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(getDoc(doc(db, 'adminGrants', 'g1')));
  });

  it('🔴 nobody can PRE-CREATE a lock and starve a real grant', async () => {
    // The sharp one. Forging `adminGrants/{grantId}` before Brendan issues it
    // would make the real grant return alreadyProcessed having written nothing.
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, 'adminGrants', 'not-yet-issued'), {uid: UID, granted: {}}),
    );
  });
});

// ---------------------------------------------------------------------------
// KEY: families/{familyId}.binWeekday — the shared bin day (W2-118)
// ---------------------------------------------------------------------------
//
// OK: THIS BLOCK EXISTS TO PROVE A NEGATIVE: that W2-118 needed NO RULES CHANGE,
// and therefore no deploy. The claim is easy to assert and cheap to be wrong
// about, so it is pinned from both directions — a member can read the field,
// and nobody can write it.
//
// CRITICAL: THE WRITE DENIAL IS THE LOAD-BEARING HALF. `setFamilyBinDay` is a callable
// rather than a rules-scoped write because `allow write: if false` covers this
// document; if that ever relaxed, the callable would become optional and the
// owner-only authority would quietly become advisory.

describe('families/{familyId}.binWeekday — readable by members, writable by nobody', () => {
  const FAMILY_ID = 'family-bin-day';

  async function seedFamilyWithBinDay(memberUids = [UID, THIRD_UID]) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'families', FAMILY_ID), {
        ownerUid: memberUids[0],
        memberUids,
        createdAtMs: 1_760_000_000_000,
        binWeekday: 3,
      });
    });
  }

  it('a NON-OWNER member reads the shared bin day with no rules change', async () => {
    // THIRD_UID is a genuine member and NOT the owner — the case the feature is
    // for. The owner reading their own family would pass under a narrower rule
    // and prove nothing about the member who has to follow it.
    await seedFamilyWithBinDay([UID, THIRD_UID]);
    const db = testEnv.authenticatedContext(THIRD_UID).firestore();
    const snap = await assertSucceeds(getDoc(doc(db, 'families', FAMILY_ID)));
    expect(snap.data()!.binWeekday).toBe(3);
  });

  it('🔴 CONTROL: a NON-MEMBER cannot read it', async () => {
    // Without this, "a member can read" would be satisfied by a rule granting
    // every signed-in account the family document.
    await seedFamilyWithBinDay([UID, THIRD_UID]);
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'families', FAMILY_ID)));
  });

  it('🔴 the OWNER cannot write binWeekday directly — that is why the callable exists', async () => {
    await seedFamilyWithBinDay([UID, THIRD_UID]);
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'families', FAMILY_ID), {binWeekday: 5}),
    );
  });

  it('🔴 and a non-owner member certainly cannot', async () => {
    // The household-argument case: the member who disagrees about bin day is
    // exactly the person motivated to change it behind the owner's back.
    await seedFamilyWithBinDay([UID, THIRD_UID]);
    const db = testEnv.authenticatedContext(THIRD_UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'families', FAMILY_ID), {binWeekday: 5}),
    );
  });
});

// ---------------------------------------------------------------------------
// KEY: families/{familyId}/trashDay/{binDateKey} — the shared completion (W2-77)
// ---------------------------------------------------------------------------
//
// The read half of "one person does it and it clears for all". The WRITE half
// is completeTrashDay in index.ts and cannot be tested here — Admin SDK writes
// bypass rules entirely, which is exactly why the callable is the gate.
//
// WARNING: The deny-write tests below are PINS. Firestore default-denies, so deleting
// the whole block leaves them passing. The read tests are CATCHES: weaken
// isFamilyMember() to a bare isAuthenticated() and the non-member and
// other-family tests go red while the member tests stay green.
// KEY: families/{familyId}/messages/{messageId} — the board (W2-88 part 4)
describe('families/{familyId}/messages — a member reads them, nobody writes them', () => {
  const OUR_FAMILY = 'msg-family-ours';
  const MESSAGE = 'msg-1';

  async function seedMessages() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'families', OUR_FAMILY), {
        ownerUid: UID,
        memberUids: [UID, THIRD_UID],
        createdAtMs: 1_760_000_000_000,
      });
      await setDoc(doc(db, 'families', OUR_FAMILY, 'messages', MESSAGE), {
        senderUid: THIRD_UID,
        senderName: 'Kid',
        senderAvatarId: 'duck',
        text: 'already did it',
        postedAtMs: 1_760_000_000_000,
      });
    });
  }

  it('🔴 CONTROL — a member READS the board', () => {
    return seedMessages().then(async () => {
      const db = testEnv.authenticatedContext(UID).firestore();
      await assertSucceeds(getDoc(doc(db, 'families', OUR_FAMILY, 'messages', MESSAGE)));
    });
  });

  it('🔴 a NON-MEMBER cannot read the board', () => {
    return seedMessages().then(async () => {
      const db = testEnv.authenticatedContext(OTHER_UID).firestore();
      await assertFails(getDoc(doc(db, 'families', OUR_FAMILY, 'messages', MESSAGE)));
    });
  });

  it('🔴 a MEMBER cannot POST directly — that would skip every filter', () => {
    // The write rule is doing more work here than for chores: a direct write
    // skips the 15-word cap, the character cap, the link check and the
    // wordlist, which is the entire point of the filter.
    return seedMessages().then(async () => {
      const db = testEnv.authenticatedContext(THIRD_UID).firestore();
      await assertFails(
        setDoc(doc(db, 'families', OUR_FAMILY, 'messages', 'forged'), {
          senderUid: THIRD_UID,
          text: 'go to badsite.xyz you idiot',
          postedAtMs: 1_760_000_000_000,
        }),
      );
    });
  });

  it('🔴 nobody can EDIT a message — not even its sender', () => {
    // An edited message is a changed record of what somebody said.
    return seedMessages().then(async () => {
      const db = testEnv.authenticatedContext(THIRD_UID).firestore();
      await assertFails(
        updateDoc(doc(db, 'families', OUR_FAMILY, 'messages', MESSAGE), {
          text: 'something else entirely',
        }),
      );
    });
  });
});

// KEY: families/{familyId}/chores/{choreId} — the assigned chore (W2-88 part 3)
//
// Same split as trashDay and for the same reason: READ is membership, WRITE is
// denied to everyone including members. The two authority questions live on
// documents a rule cannot reach — "is the actor the OWNER" (assign) and "is the
// actor the ASSIGNEE" (complete) — so assignFamilyChore and completeFamilyChore
// are the gates.
describe('families/{familyId}/chores — a member reads them, nobody writes them', () => {
  const OUR_FAMILY = 'chores-family-ours';
  const THEIR_FAMILY = 'chores-family-theirs';
  const CHORE = 'chore-1';

  async function seedChores() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'families', OUR_FAMILY), {
        ownerUid: UID,
        memberUids: [UID, THIRD_UID],
        createdAtMs: 1_760_000_000_000,
      });
      await setDoc(doc(db, 'families', THEIR_FAMILY), {
        ownerUid: OTHER_UID,
        memberUids: [OTHER_UID],
        createdAtMs: 1_760_000_000_000,
      });
      await setDoc(doc(db, 'families', OUR_FAMILY, 'chores', CHORE), {
        taskId: 'lib_kitchen_0',
        assignedToUid: THIRD_UID,
        assignedByUid: UID,
        dueAtMs: 1_760_000_100_000,
        assignedAtMs: 1_760_000_000_000,
        completedAtMs: null,
      });
    });
  }

  it('🔴 CONTROL — a member READS the family\'s chores', () => {
    // Without this every refusal below is satisfied by a rule that denies
    // everyone, which would mean the page shows nothing to anybody.
    return seedChores().then(async () => {
      const db = testEnv.authenticatedContext(UID).firestore();
      await assertSucceeds(getDoc(doc(db, 'families', OUR_FAMILY, 'chores', CHORE)));
    });
  });

  it('🔴 a NON-MEMBER cannot read them', () => {
    // A chore names a child and a task. It is a statement about a household.
    return seedChores().then(async () => {
      const db = testEnv.authenticatedContext(OTHER_UID).firestore();
      await assertFails(getDoc(doc(db, 'families', OUR_FAMILY, 'chores', CHORE)));
    });
  });

  it('🔴 a member of ANOTHER family cannot reach ours', () => {
    // Scoping is structural — the record lives under one family — but the read
    // rule is what stops somebody who knows the id.
    return seedChores().then(async () => {
      const db = testEnv.authenticatedContext(OTHER_UID).firestore();
      await assertFails(
        getDoc(doc(db, 'families', OUR_FAMILY, 'chores', CHORE)),
      );
      // …and their own family is still reachable to them, so the refusal above
      // is about scope rather than a blanket denial.
      await assertSucceeds(getDoc(doc(db, 'families', THEIR_FAMILY)));
    });
  });

  it('🔴 a MEMBER cannot mark a chore done directly — the callable is the gate', () => {
    // A member-writable completion is a member marking their own chore done
    // without doing it. NOTE: Counted as a PIN: Firestore default-denies, so this
    // passes with the block deleted.
    return seedChores().then(async () => {
      const db = testEnv.authenticatedContext(THIRD_UID).firestore();
      await assertFails(
        updateDoc(doc(db, 'families', OUR_FAMILY, 'chores', CHORE), {
          completedAtMs: 1_760_000_050_000,
        }),
      );
    });
  });

  it('🔴 the OWNER cannot assign a chore directly either', () => {
    // Owning the family is the authority to assign THROUGH THE CALLABLE, which
    // validates the task id against the library. A direct write would skip that
    // and store an id the renderer drops in silence.
    return seedChores().then(async () => {
      const db = testEnv.authenticatedContext(UID).firestore();
      await assertFails(
        setDoc(doc(db, 'families', OUR_FAMILY, 'chores', 'forged'), {
          taskId: 'lib_not_a_real_task',
          assignedToUid: THIRD_UID,
        }),
      );
    });
  });
});

describe('families/{familyId}/trashDay — a member reads it, nobody writes it', () => {
  const OUR_FAMILY = 'family-ours';
  const THEIR_FAMILY = 'family-theirs';
  const BIN_DATE = '2026-08-15';

  async function seedFamilies() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'families', OUR_FAMILY), {
        ownerUid: UID,
        memberUids: [UID, THIRD_UID],
        createdAtMs: 1_760_000_000_000,
      });
      await setDoc(doc(db, 'families', THEIR_FAMILY), {
        ownerUid: OTHER_UID,
        memberUids: [OTHER_UID],
        createdAtMs: 1_760_000_000_000,
      });
      await setDoc(doc(db, 'families', OUR_FAMILY, 'trashDay', BIN_DATE), {
        binDateKey: BIN_DATE,
        completedByUid: THIRD_UID,
        completedAtMs: 1_760_000_000_000,
      });
      await setDoc(doc(db, 'families', THEIR_FAMILY, 'trashDay', BIN_DATE), {
        binDateKey: BIN_DATE,
        completedByUid: OTHER_UID,
        completedAtMs: 1_760_000_000_000,
      });
    });
  }

  it('a member reads the completion — this is what "clears for all" IS', () => {
    // The whole feature from the reading side: the member who did NOT take the
    // bins out can see that they are out.
    return seedFamilies().then(async () => {
      const db = testEnv.authenticatedContext(UID).firestore();
      await assertSucceeds(getDoc(doc(db, 'families', OUR_FAMILY, 'trashDay', BIN_DATE)));
    });
  });

  it('the member who completed it can read it too', async () => {
    await seedFamilies();
    const db = testEnv.authenticatedContext(THIRD_UID).firestore();
    await assertSucceeds(getDoc(doc(db, 'families', OUR_FAMILY, 'trashDay', BIN_DATE)));
  });

  it('🔴 CONTROL: a NON-MEMBER cannot read our family\'s bin day', async () => {
    // Weaken isFamilyMember() to a bare isAuthenticated() and this goes red.
    await seedFamilies();
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(getDoc(doc(db, 'families', OUR_FAMILY, 'trashDay', BIN_DATE)));
  });

  it('🔴 CONTROL: a member of ANOTHER family is unaffected in both directions', async () => {
    // The brief's second named control. OTHER_UID is a real member — of a
    // different family — so this asserts scoping, not authentication.
    await seedFamilies();
    const ours = testEnv.authenticatedContext(UID).firestore();
    const theirs = testEnv.authenticatedContext(OTHER_UID).firestore();

    // They cannot read ours...
    await assertFails(getDoc(doc(theirs, 'families', OUR_FAMILY, 'trashDay', BIN_DATE)));
    // ...we cannot read theirs...
    await assertFails(getDoc(doc(ours, 'families', THEIR_FAMILY, 'trashDay', BIN_DATE)));
    // ...and each CAN still read their own, which is what makes the two
    // refusals above mean "scoped" rather than "broken".
    await assertSucceeds(getDoc(doc(ours, 'families', OUR_FAMILY, 'trashDay', BIN_DATE)));
    await assertSucceeds(getDoc(doc(theirs, 'families', THEIR_FAMILY, 'trashDay', BIN_DATE)));
  });

  it('an unauthenticated client is refused', async () => {
    await seedFamilies();
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, 'families', OUR_FAMILY, 'trashDay', BIN_DATE)));
  });

  it('a completion under a family with no memberUids denies rather than errors', async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'families', 'family-malformed'), {ownerUid: UID});
      await setDoc(doc(db, 'families', 'family-malformed', 'trashDay', BIN_DATE), {
        binDateKey: BIN_DATE,
        completedByUid: UID,
        completedAtMs: 1,
      });
    });
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(getDoc(doc(db, 'families', 'family-malformed', 'trashDay', BIN_DATE)));
  });

  it('🔴 a member cannot WRITE a completion — the callable is the gate', async () => {
    // A member forging one would clear their household's reminder without
    // doing the chore, which is the only thing the feature actually promises.
    await seedFamilies();
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      setDoc(doc(db, 'families', OUR_FAMILY, 'trashDay', '2026-08-22'), {
        binDateKey: '2026-08-22',
        completedByUid: UID,
        completedAtMs: 1,
      }),
    );
  });

  it('a member cannot repoint an existing completion at themselves', async () => {
    await seedFamilies();
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(
      updateDoc(doc(db, 'families', OUR_FAMILY, 'trashDay', BIN_DATE), {
        completedByUid: UID,
      }),
    );
  });

  it('a member cannot DELETE a completion to re-arm the reminder', async () => {
    await seedFamilies();
    const db = testEnv.authenticatedContext(THIRD_UID).firestore();
    await assertFails(deleteDoc(doc(db, 'families', OUR_FAMILY, 'trashDay', BIN_DATE)));
  });

  it('a non-member cannot write into our family either', async () => {
    await seedFamilies();
    const db = testEnv.authenticatedContext(OTHER_UID).firestore();
    await assertFails(
      setDoc(doc(db, 'families', OUR_FAMILY, 'trashDay', '2026-08-22'), {
        binDateKey: '2026-08-22',
        completedByUid: OTHER_UID,
        completedAtMs: 1,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// The fridge — users/{uid}/fridgeItems/{itemId}  (W2-97)
// ---------------------------------------------------------------------------
//
// CRITICAL: WRITTEN BEFORE THE CLIENT LANDS, ON PURPOSE. W4-76 is porting the fridge
// against `users/{uid}/fridgeItems/{id}` (FridgeRepository), and that path had
// no `match` block at all. Firestore default-denies, so the failure would not
// have been loud: every write silently refused, and the client unable to say
// why.
//
// WARNING: AND W4'S OWN SUITE STRUCTURALLY CANNOT CATCH IT. `fake_cloud_firestore`
// calls `maybeThrowSecurityException` only from mock_document_reference.dart,
// so a DENIED COLLECTION READ COMES BACK EMPTY there — an empty fridge and a
// forbidden fridge are one observation to every widget test. `watchItems()`
// reads the collection, so that is exactly the shape this would take. The
// assertion has to live here.
//
// NOTE: THE SHAPE IS READ OFF THE REAL CLIENT, not invented: `name`, `emoji`,
// `category`, `purchasedOn`, `expiresOn`, `done`, `doneAt`, `fromReceipt` —
// dates as ISO-8601 STRINGS (json_serializable), not Timestamps — and `id` is
// the document key and is deliberately NOT stored inside the document.
//
// KEY: NO FIELD-SHAPE VALIDATION IN THE RULE, AND THAT IS A CHOICE. Cut 2 adds
// receipt scanning and will add fields; a rule enumerating today's keys would
// turn every additive client change into a rules deploy, and the blast radius
// of a malformed value is one player's own fridge. Authority is the question
// rules can answer here, so authority is all this rule answers.

describe('fridgeItems — owner-only, and NOT friend-readable', () => {
  const ITEM = 'item-milk';

  /** One item in UID's fridge and one in OTHER_UID's, seeded past the rules. */
  async function seedFridges() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'users', UID, 'fridgeItems', ITEM), {
        name: 'Milk',
        emoji: '🥛',
        category: 'Dairy',
        purchasedOn: '2026-08-16T00:00:00.000',
        expiresOn: '2026-08-23T00:00:00.000',
        done: false,
        doneAt: null,
        fromReceipt: false,
      });
      // KEY: THE DECOY. Without a second, populated fridge, "a stranger cannot
      // read UID's" also passes for credentials that authenticate nobody and
      // for a ruleset that denies everyone — and the list denial would be over
      // an empty collection, which is not a denial at all.
      await setDoc(doc(db, 'users', OTHER_UID, 'fridgeItems', 'item-eggs'), {
        name: 'Eggs',
        emoji: '🥚',
        category: 'Other',
        purchasedOn: '2026-08-16T00:00:00.000',
        expiresOn: '2026-08-30T00:00:00.000',
        done: false,
        doneAt: null,
        fromReceipt: false,
      });
    });
  }

  it('the owner reads, creates, updates and deletes their own items', async () => {
    await seedFridges();
    const db = testEnv.authenticatedContext(UID).firestore();

    await assertSucceeds(getDoc(doc(db, 'users', UID, 'fridgeItems', ITEM)));
    await assertSucceeds(getDocs(collection(db, 'users', UID, 'fridgeItems')));
    // The four operations FridgeRepository actually performs.
    await assertSucceeds(
      setDoc(doc(db, 'users', UID, 'fridgeItems', 'item-bread'), {
        name: 'Bread',
        emoji: '🍞',
        category: 'Bakery',
        purchasedOn: '2026-08-16T00:00:00.000',
        expiresOn: '2026-08-19T00:00:00.000',
        done: false,
        doneAt: null,
        fromReceipt: false,
      }),
    );
    // setDone() — a merge write of just these two fields.
    await assertSucceeds(
      setDoc(
        doc(db, 'users', UID, 'fridgeItems', ITEM),
        {done: true, doneAt: '2026-08-16T09:00:00.000'},
        {merge: true},
      ),
    );
    await assertSucceeds(deleteDoc(doc(db, 'users', UID, 'fridgeItems', 'item-bread')));
  });

  it('🔴 a stranger cannot read another player’s fridge — over a NON-EMPTY collection', async () => {
    await seedFridges();
    const stranger = testEnv.authenticatedContext(OTHER_UID).firestore();

    // The single document and the QUERY are asserted separately: `allow read`
    // covers get and list, and a rule can be relaxed for one and not the other.
    await assertFails(getDoc(doc(stranger, 'users', UID, 'fridgeItems', ITEM)));
    await assertFails(getDocs(collection(stranger, 'users', UID, 'fridgeItems')));

    // KEY: THE PAIR that makes those two mean "scoped" rather than "broken": the
    // same credentials read their OWN fridge, which is populated, in the same
    // moment.
    await assertSucceeds(getDocs(collection(stranger, 'users', OTHER_UID, 'fridgeItems')));
    await assertSucceeds(
      getDoc(doc(stranger, 'users', OTHER_UID, 'fridgeItems', 'item-eggs')),
    );
  });

  it('🔴 a stranger cannot write into another player’s fridge', async () => {
    await seedFridges();
    const stranger = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(
      setDoc(doc(stranger, 'users', UID, 'fridgeItems', 'item-planted'), {
        name: 'Planted',
        emoji: '',
        category: 'Other',
        purchasedOn: '2026-08-16T00:00:00.000',
        expiresOn: '2026-08-23T00:00:00.000',
        done: false,
        doneAt: null,
        fromReceipt: false,
      }),
    );
    await assertFails(
      updateDoc(doc(stranger, 'users', UID, 'fridgeItems', ITEM), {done: true}),
    );
    await assertFails(deleteDoc(doc(stranger, 'users', UID, 'fridgeItems', ITEM)));

    // The stored document is untouched and the collection gained nothing —
    // assertFails watches the promise, not the database.
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const snap = await getDocs(collection(ctx.firestore(), 'users', UID, 'fridgeItems'));
      expect(snap.size).toBe(1);
      expect(snap.docs[0].data().done).toBe(false);
    });
  });

  it('🔴 an ACCEPTED FRIEND still cannot read it — rules do not cascade', async () => {
    // WARNING: THE ONE A READER IS MOST LIKELY TO GET WRONG. `users/{uid}` allows
    // isFriend(uid), and a subcollection does NOT inherit that — so this pins
    // the intended answer rather than leaving it to be re-derived. OTHER_UID is
    // a genuinely accepted friend here, not merely a stranger, which is what
    // separates "friends are excluded" from "everyone is excluded".
    await seedFridges();
    await seedAcceptedFriendship();
    const friend = testEnv.authenticatedContext(OTHER_UID).firestore();

    await assertFails(getDoc(doc(friend, 'users', UID, 'fridgeItems', ITEM)));
    await assertFails(getDocs(collection(friend, 'users', UID, 'fridgeItems')));

    // KEY: THE CONTROL PROVING THE FRIENDSHIP IS REAL AND ACCEPTED. Without it
    // this test also passes when seedAcceptedFriendship() silently wrote
    // nothing — and would then be asserting that a stranger is denied, which
    // the test above already covers.
    await assertSucceeds(getDoc(doc(friend, 'users', UID)));
  });

  it('an UNAUTHENTICATED client is denied, so the gate is not merely ownership', async () => {
    await seedFridges();
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(anon, 'users', UID, 'fridgeItems', ITEM)));
    await assertFails(getDocs(collection(anon, 'users', UID, 'fridgeItems')));
  });
});
