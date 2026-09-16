/**
 * `recordTaskCompletion` — the core loop — driven against a REAL Firestore.
 *
 * ---------------------------------------------------------------------------
 * 🔴 WHAT THE EXISTING GATES DO AND DO NOT PROVE
 * ---------------------------------------------------------------------------
 *
 * This callable is the one a player invokes more than any other, and it was
 * already covered three ways — none of which can see the failure below.
 *
 *   · `economyIdempotency.test.ts` is a SOURCE GREP. It reads `index.ts` as
 *     text and asserts every value-moving callable CONTAINS `runTransaction`.
 *     It proves the word is present. It never executes anything, and it stays
 *     green for a transaction that reads the wrong thing inside it.
 *   · `xp.test.ts` and `streak.test.ts` DO execute the handler — against the
 *     hand-written fake `firebase-admin`. ⚠️ A fake `runTransaction` RUNS THE
 *     CALLBACK ONCE AND NEVER RETRIES. Contention does not exist there, so the
 *     one property that makes an economy safe cannot be tested.
 *   · `make test` drives the client against fakes.
 *
 * 🔑 SO THE GAP IS NOT "NEVER EXECUTED". It is "never executed where two calls
 * can overlap" — and this callable pays currency, so that is the gap that costs
 * money. `grantTaskRewards` guards a replay with a LEDGER READ INSIDE THE
 * TRANSACTION (`users/{uid}/economy/taskRewards`). Move that read outside and
 * every existing gate stays green: the word `runTransaction` is still there for
 * the grep, and the fake runs sequentially so a stale read never happens. Only
 * two genuinely concurrent calls against a real Firestore can tell.
 *
 * ⚠️ THE POINT OF `the SAME day paid ONCE under CONCURRENT calls` IS THAT NO
 * OTHER TEST IN THIS REPO CAN GO RED FOR IT.
 *
 * ---------------------------------------------------------------------------
 * 🔴 WHAT THIS STILL CANNOT PROVE
 * ---------------------------------------------------------------------------
 *
 *   · IT DOES NOT ASK PRODUCTION ANYTHING. It runs `index.ts` from THIS working
 *     tree. `make check-deployed` is the gate for that question.
 *   · IT DOES NOT EXERCISE THE CALLABLE TRANSPORT. `.run()` hands the handler a
 *     `CallableRequest` directly — App Check, the ID-token verification that
 *     populates `request.auth`, CORS, region and timeout are all skipped, so
 *     every `unauthenticated` branch here is proven only for a null `auth`.
 *   · IT DOES NOT TOUCH THE DART CLIENT, whose own suite still runs against
 *     `fake_cloud_firestore`.
 *   · TWO OVERLAPPING `.run()` CALLS IN ONE PROCESS ARE NOT TWO DEVICES. They
 *     are the closest thing reachable here, and they are enough to make a
 *     transaction retry — but a real race across regions is wider than this.
 */
import {readFileSync} from 'fs';
import {resolve} from 'path';
import * as admin from 'firebase-admin';

import {TASK_SPONGE_REWARD, paidTaskCapFor} from '../taskRewards';
import {BONUS_TASK_MULTIPLIER, bonusTaskIdFor} from '../dailyBonusTask';
import {XP_TASK} from '../xp';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const idx = require('../index') as Record<string, {run: (req: unknown) => Promise<any>}>;

const PROJECT_ID = process.env.GCLOUD_PROJECT;
const SOLO = 'e2e-task-solo';
const RACER = 'e2e-task-racer';
const CAPPED = 'e2e-task-capped';
const ROTATOR = 'e2e-day-rotator';
const BONUS_ROTATOR = 'e2e-day-bonus-rotator';
const EDGE = 'e2e-day-edge';
const OUT_OF_RANGE = 'e2e-day-out-of-range';
const MIGRATED = 'e2e-day-migrated';

/** The server's own UTC calendar date, `YYYY-MM-DD`. */
function serverUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/** [n] days from the `YYYY-MM-DD` key [day], as another such key. */
function shiftDay(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * ⚠️ THE DAY KEY FLOATS NOW, AND IT HAS TO.
 *
 * This file used to pin `2026-08-16` so the key could not drift under a
 * midnight run. `recordTaskCompletion` now BOUNDS the client's key against the
 * server clock (W2-174), so a key fixed months in the past is exactly the input
 * the callable is supposed to refuse — a pinned date would make every test here
 * assert `invalid-argument`.
 *
 * 📌 Drift is handled by the bound itself rather than by pinning: the admitted
 * window is +/- one day, so a run that crosses UTC midnight turns TODAY into
 * yesterday and TOMORROW into today, both still inside it. The two tests that
 * probe the +/-1 EDGE re-derive their key at call time for the same reason.
 */
const TODAY = serverUtcDay();
const TOMORROW = shiftDay(TODAY, 1);
const CLIENT_NOW = `${TODAY}T09:00:00`;
const DAY_KEY = TODAY;

let db: admin.firestore.Firestore;

function call(name: string, uid: string | null, data: unknown): Promise<any> {
  const fn = idx[name];
  if (!fn || typeof fn.run !== 'function') {
    throw new Error(`index.ts exports no callable named "${name}"`);
  }
  return fn.run({data, auth: uid ? {uid, token: {}} : undefined, rawRequest: {}});
}

/** [count] task documents marked complete on [DAY_KEY], as the client writes them. */
async function seedCompletedTasks(uid: string, count: number) {
  const batch = db.batch();
  for (let i = 0; i < count; i++) {
    batch.set(db.doc(`users/${uid}/tasks/task-${i}`), {
      title: `task ${i}`,
      completedDate: DAY_KEY,
      status: 'completed',
    });
  }
  await batch.commit();
}

/**
 * The reward ledger for [day] — `users/{uid}/days/{day}` since W2-174.
 *
 * ⚠️ IT MOVED, AND THAT IS THE FIX RATHER THAN A REFACTOR. It used to be one
 * document, `users/{uid}/economy/taskRewards`, carrying a `date` field that the
 * three counters compared against a CALLER-CHOSEN key — so naming a different
 * day reset all three. A day is now a document ID, which has no comparison to
 * get wrong.
 */
async function ledgerOf(uid: string, day: string = DAY_KEY) {
  return (await db.doc(`users/${uid}/days/${day}`).get()).data();
}

/** The ledger INDEX — the ratchet's high-water mark. */
async function ledgerIndexOf(uid: string) {
  return (await db.doc(`users/${uid}/economy/taskRewards`).get()).data();
}

async function profileOf(uid: string) {
  return (await db.doc(`users/${uid}/profile/data`).get()).data();
}

beforeAll(async () => {
  if (!PROJECT_ID) {
    throw new Error(
      'GCLOUD_PROJECT is unset — run this through `npm run test:e2e`, which boots ' +
        'the emulators and sets it. Under plain jest the Admin SDK would point at ' +
        'a project this test cannot see, and every assertion would pass against ' +
        'an empty database.',
    );
  }
  if (!process.env.FIRESTORE_EMULATOR_HOST) {
    throw new Error(
      'FIRESTORE_EMULATOR_HOST is unset. Without it the Admin SDK would try to ' +
        'reach REAL Firestore, and this test writes freely.',
    );
  }
  // Read so a rules/indexes change cannot make this file silently a different
  // test; the value is unused, the failure to find it is the point.
  readFileSync(resolve(__dirname, '../../../firestore.rules'), 'utf8');

  db = admin.firestore();
  for (const uid of [SOLO, RACER, CAPPED, ROTATOR, BONUS_ROTATOR, EDGE, OUT_OF_RANGE,
    MIGRATED]) {
    await db.doc(`users/${uid}`).set({subscriptionTier: 'free'});
  }
}, 120_000);

afterAll(async () => {
  await Promise.all(admin.apps.map((app) => app?.delete()));
});

describe('recordTaskCompletion against a real Firestore', () => {
  test('one completion pays sponges and XP, and writes the ledger', async () => {
    await seedCompletedTasks(SOLO, 1);
    const res = await call('recordTaskCompletion', SOLO, {clientNowIso: CLIENT_NOW});

    expect(res.granted.sponges).toBe(TASK_SPONGE_REWARD);
    expect(res.granted.xp).toBe(XP_TASK);

    // 🔑 THE STORED DOCUMENTS, NOT THE RESPONSE. A handler can return the right
    // numbers while writing nothing, and the response is what every existing
    // unit test already checks against a fake.
    const ledger = await ledgerOf(SOLO);
    expect(ledger?.dayKey).toBe(DAY_KEY);
    expect(ledger?.paidCount).toBe(1);
    expect(ledger?.xpPaidCount).toBe(1);

    // The ratchet's high-water mark, written alongside the settlement. Without
    // it a rotated key would pay nothing (the day document sees to that) but
    // would be accepted in silence.
    expect((await ledgerIndexOf(SOLO))?.maxDayKey).toBe(DAY_KEY);

    const profile = await profileOf(SOLO);
    expect(profile?.spongeBalance).toBe(TASK_SPONGE_REWARD);
    expect(profile?.totalXp).toBe(XP_TASK);

    // The streak document the transaction creates on a first ever completion.
    const streak = (await db.doc(`users/${SOLO}/streak/main`).get()).data();
    expect(streak?.currentStreak).toBe(1);
  });

  test('a sequential replay of the same day pays nothing further', async () => {
    const before = await profileOf(SOLO);
    const res = await call('recordTaskCompletion', SOLO, {clientNowIso: CLIENT_NOW});

    expect(res.granted.sponges).toBe(0);
    expect(res.granted.xp).toBe(0);

    const after = await profileOf(SOLO);
    expect(after?.spongeBalance).toBe(before?.spongeBalance);
    expect(after?.totalXp).toBe(before?.totalXp);
    expect((await ledgerOf(SOLO))?.paidCount).toBe(1);
  });

  test('🔴 the same day is paid ONCE under CONCURRENT calls', async () => {
    // ⚠️ THE ASSERTION NO OTHER TEST IN THIS REPO CAN MAKE.
    //
    // Two overlapping invocations of the real handler against a real Firestore.
    // The replay guard is a ledger read INSIDE `grantTaskRewards`' transaction;
    // if that read ever moves outside it, both calls see `alreadyPaid: 0`, both
    // pay, and the player is paid twice for one task — silently, and only when
    // two calls overlap.
    //
    // 🔑 EVERY EXISTING GATE STAYS GREEN FOR THAT MUTATION. economyIdempotency
    // greps for the word `runTransaction`, which is still present; the fake
    // firestore in xp.test.ts and streak.test.ts runs the callback once and
    // never retries, so a stale read cannot occur there at all. This is the
    // whole marginal value of the file.
    await seedCompletedTasks(RACER, 1);
    // 🔑 THE STREAK DOC IS PRE-SEEDED, AND THAT IS WHAT MAKES THIS A RACE.
    // Without it both calls hit the `streakSnap does not exist` branch and
    // contend on CREATING
    // it, so Firestore serialises them in the streak transaction and the
    // second reaches grantTaskRewards only after the first has finished —
    // closing the very window this test exists to open. Measured: with the
    // ledger read hoisted out of the transaction, the unseeded version stayed
    // GREEN. Seeding sends both calls down the gap==0 read-only path instead.
    await db.doc(`users/${RACER}/streak/main`).set({
      habitId: 'main', currentStreak: 1, longestStreak: 1,
      lastCompletionDate: CLIENT_NOW, streakStartDate: DAY_KEY, isBroken: false,
      awardedMilestones: [],
    });

    const [a, b] = await Promise.all([
      call('recordTaskCompletion', RACER, {clientNowIso: CLIENT_NOW}),
      call('recordTaskCompletion', RACER, {clientNowIso: CLIENT_NOW}),
    ]);

    // Exactly one call pays. Which one wins the race is not asserted — that is
    // genuinely nondeterministic, and pinning it would make this flaky for a
    // reason unrelated to the property.
    const spongesPaid = a.granted.sponges + b.granted.sponges;
    const xpPaid = a.granted.xp + b.granted.xp;
    expect(spongesPaid).toBe(TASK_SPONGE_REWARD);
    expect(xpPaid).toBe(XP_TASK);

    // 🔴 AND THE DATABASE AGREES. Two responses summing correctly while the
    // balance was written twice is exactly what a lost-update looks like, so
    // the stored balance is the real assertion.
    const profile = await profileOf(RACER);
    expect(profile?.spongeBalance).toBe(TASK_SPONGE_REWARD);
    expect(profile?.totalXp).toBe(XP_TASK);

    const ledger = await ledgerOf(RACER);
    expect(ledger?.paidCount).toBe(1);
    expect(ledger?.xpPaidCount).toBe(1);
    // ⚠️ 30s, not jest's 5s default. Two genuinely contending transactions
    // RETRY, and retrying is the whole mechanism under test — the default
    // timeout fired here the moment the race window actually opened, which
    // read as a hang rather than as the property working.
  }, 30_000);

  test('the free cap is enforced against a REAL transactional query', async () => {
    // `grantTaskRewards` counts today's completions with
    // `.where('completedDate', '==', dayKey)` read INSIDE the transaction. A
    // fake `where()` returns whatever the fake was written to return and can
    // never need an index; this drives the real query engine.
    const cap = paidTaskCapFor('free');
    expect(cap).toBe(1);

    await seedCompletedTasks(CAPPED, 4);
    const res = await call('recordTaskCompletion', CAPPED, {clientNowIso: CLIENT_NOW});

    // Sponges stop at the cap; XP does not — the split the ledger's two
    // counters exist to keep apart.
    expect(res.granted.sponges).toBe(cap * TASK_SPONGE_REWARD);
    expect(res.granted.xp).toBe(4 * XP_TASK);

    const ledger = await ledgerOf(CAPPED);
    expect(ledger?.paidCount).toBe(cap);
    expect(ledger?.xpPaidCount).toBe(4);

    const profile = await profileOf(CAPPED);
    expect(profile?.spongeBalance).toBe(cap * TASK_SPONGE_REWARD);
    expect(profile?.totalXp).toBe(4 * XP_TASK);
  });

  test('an unauthenticated call is refused and writes nothing', async () => {
    const before = await profileOf(SOLO);
    let code: string | null = null;
    try {
      await call('recordTaskCompletion', null, {clientNowIso: CLIENT_NOW});
    } catch (err) {
      code = String((err as {code?: unknown}).code ?? '');
    }
    expect(code).toBe('unauthenticated');
    expect((await profileOf(SOLO))?.spongeBalance).toBe(before?.spongeBalance);
  });
});

// ---------------------------------------------------------------------------
// 🔴 W2-174 · THE DAY KEY WAS CHOSEN BY THE CALLER, AND IT GATED THREE LEDGERS
// ---------------------------------------------------------------------------
//
// `recordTaskCompletion` derived its day key as `clientNowIso.slice(0, 10)`, and
// `grantTaskRewards` then reset every counter whose stored `date` did not equal
// it. Three independent reads, one caller-chosen key:
//
//     paidCount     sponges, capped per tier
//     xpPaidCount   XP, uncapped — and SILENT, because nobody counts XP the way
//                   they count sponges
//     bonusPaid     the daily 2x task's extra
//
// So alternating two well-formed dates re-minted all three. W2-173 executed it:
// 15 sponges against a cap of 5, one account, three calls.
//
// 🔑 WHY THE FIX IS NOT A SERVER-DERIVED UTC KEY. `dayKey` is also the QUERY key
// over `users/{uid}/tasks.completedDate`, which the CLIENT stamps from a bare
// local `DateTime.now()`. A UTC key would match nothing a Los Angeles player
// completed after 17:00 local, or an Auckland player completed before 13:00 —
// every day. That is a payment outage, not a fix, and it is why W2-173 stopped
// rather than shipping. taskRewards.ts:308 predicted it in advance about a
// smaller version of the same mistake.
//
// ✅ WHAT SHIPPED INSTEAD. The client still names its own local day, but:
//   1. BOUNDED   — a key more than one day from the server's UTC date is
//                  refused. Real offsets span UTC-12..UTC+14, so every honest
//                  local date is within one day of UTC and nothing legitimate
//                  moves. The fabricable supply drops from infinite to three.
//   2. PER-DAY   — the ledger is `users/{uid}/days/{dayKey}`, one document per
//                  day, so a day can be settled ONCE EVER. Coming back to a
//                  spent key buys nothing even if the call is admitted.
//   3. RATCHETED — a key earlier than the high-water mark is refused outright,
//                  so the rotation fails LOUDLY instead of quietly paying zero.
//
// ⚠️ THE RESIDUAL, MEASURED AND STATED RATHER THAN HIDDEN. The admitted window
// is three keys wide, so a determined caller can pull forward at most TWO extra
// days' cap, ONCE — after which each real day admits exactly one new key and the
// long-run rate is the honest one. Deploy 3 of the migration removes even that by
// dropping the client key entirely once timezone coverage is high enough.
//
// 📌 WHICH SCRIPT RUNS THIS FILE: `npm run test:e2e`, NOT `npm test`. The base
// jest config ignores `*Emulator.test.ts` (see jest.config.js), so quoting
// `npm test` as this brief's gate would quote a run that never loaded the file.

/** Stamps [ids] under users/[uid]/tasks with `completedDate` = [day]. */
async function stampTasks(uid: string, ids: string[], day: string) {
  const batch = db.batch();
  for (const id of ids) {
    batch.set(
      db.doc(`users/${uid}/tasks/${id}`),
      {title: id, completedDate: day, status: 'completed'},
      {merge: true},
    );
  }
  await batch.commit();
}

/**
 * What the player has actually been PAID, read off the stored profile.
 *
 * 🔑 Deliberately not the ledger: this is the one quantity whose meaning does
 * not change when the ledger's SHAPE changes, so the same assertion is
 * meaningful against the old single document and the new per-day one. A response
 * payload can be right while the write is wrong; the balance cannot.
 */
async function storedTotals(uid: string): Promise<{sponges: number; xp: number}> {
  const p = await profileOf(uid);
  return {sponges: (p?.spongeBalance as number) ?? 0, xp: (p?.totalXp as number) ?? 0};
}

/** Calls the handler and reports the error CODE instead of throwing. */
async function callForCode(uid: string, clientNowIso: string) {
  try {
    const res = await call('recordTaskCompletion', uid, {clientNowIso});
    return {code: null as string | null, res};
  } catch (err) {
    return {code: String((err as {code?: unknown}).code ?? ''), res: null};
  }
}

describe('🔴 the reward day key is bounded and ratcheted', () => {
  const CAP = paidTaskCapFor('free');
  /** The 2x task's EXTRA, over and above the ordinary completion it also is. */
  const BONUS_EXTRA = TASK_SPONGE_REWARD * (BONUS_TASK_MULTIPLIER - 1);

  // Two plain ids. Bonus ids are all `lib_*` (dailyBonusTask.ts), so neither of
  // these can accidentally collect the 2x extra and blur the arms apart.
  const PLAIN = ['task-a', 'task-b'];

  /** Everything the rotation arm measured, filled in by the beforeAll below. */
  const rot = {
    afterFirst: {sponges: 0, xp: 0},
    beforeReplay: {sponges: 0, xp: 0},
    afterReplay: {sponges: 0, xp: 0},
    replayCode: null as string | null,
    streakBefore: undefined as Record<string, unknown> | undefined,
    streakAfter: undefined as Record<string, unknown> | undefined,
    questPayouts: [] as unknown[],
    beforeHighWater: {sponges: 0, xp: 0},
    afterHighWater: {sponges: 0, xp: 0},
    highWaterCode: null as string | null,
  };

  /** The same rotation with the day's 2x task, isolating the third counter. */
  const bonusRot = {
    afterFirst: {sponges: 0, xp: 0},
    beforeReplay: {sponges: 0, xp: 0},
    afterReplay: {sponges: 0, xp: 0},
  };

  beforeAll(async () => {
    // --- arm 1: two plain completions, rotated TODAY -> TOMORROW -> TODAY ----
    await stampTasks(ROTATOR, PLAIN, TODAY);
    const first = await call('recordTaskCompletion', ROTATOR, {
      clientNowIso: `${TODAY}T09:00:00`,
    });
    rot.questPayouts = first.questPayouts ?? [];
    rot.afterFirst = await storedTotals(ROTATOR);

    // The same two documents, re-stamped. This is the whole exploit: the client
    // owns `completedDate` (firestore.rules `match /tasks/{doc=**}`), so it can
    // present identical work as a different day's work.
    await stampTasks(ROTATOR, PLAIN, TOMORROW);
    await call('recordTaskCompletion', ROTATOR, {clientNowIso: `${TOMORROW}T09:00:00`});

    await stampTasks(ROTATOR, PLAIN, TODAY);
    rot.beforeReplay = await storedTotals(ROTATOR);
    rot.streakBefore = (await db.doc(`users/${ROTATOR}/streak/main`).get()).data();
    const replay = await callForCode(ROTATOR, `${TODAY}T09:00:00`);
    rot.replayCode = replay.code;
    rot.afterReplay = await storedTotals(ROTATOR);
    rot.streakAfter = (await db.doc(`users/${ROTATOR}/streak/main`).get()).data();

    // A fourth call AT the high-water mark. The ratchet admits it — equal is not
    // earlier — so whatever refuses to pay here is the per-day document and
    // nothing else. See the test that reads these two.
    await stampTasks(ROTATOR, PLAIN, TOMORROW);
    rot.beforeHighWater = await storedTotals(ROTATOR);
    rot.highWaterCode = (await callForCode(ROTATOR, `${TOMORROW}T21:00:00`)).code;
    rot.afterHighWater = await storedTotals(ROTATOR);

    // --- arm 2: the SAME rotation carrying today's 2x bonus task ------------
    // One document only, whose id IS today's bonus id, so the arm's sponge
    // total decomposes exactly: CAP * TASK_SPONGE_REWARD per settled day, plus
    // BONUS_EXTRA once. That is what makes the third counter attributable.
    const bonusToday = bonusTaskIdFor(TODAY)!;
    await stampTasks(BONUS_ROTATOR, [bonusToday], TODAY);
    await call('recordTaskCompletion', BONUS_ROTATOR, {clientNowIso: `${TODAY}T09:00:00`});
    bonusRot.afterFirst = await storedTotals(BONUS_ROTATOR);

    await stampTasks(BONUS_ROTATOR, [bonusToday], TOMORROW);
    await call('recordTaskCompletion', BONUS_ROTATOR, {
      clientNowIso: `${TOMORROW}T09:00:00`,
    });

    await stampTasks(BONUS_ROTATOR, [bonusToday], TODAY);
    bonusRot.beforeReplay = await storedTotals(BONUS_ROTATOR);
    await callForCode(BONUS_ROTATOR, `${TODAY}T09:00:00`);
    bonusRot.afterReplay = await storedTotals(BONUS_ROTATOR);
  }, 60_000);

  // -------------------------------------------------------------------------
  // The controls. Without these both arms could read zero and pass vacuously.
  // -------------------------------------------------------------------------

  test('the honest first call IS paid — the control over the control', () => {
    expect(rot.afterFirst.sponges).toBe(CAP * TASK_SPONGE_REWARD);
    expect(rot.afterFirst.xp).toBe(PLAIN.length * XP_TASK);
    expect(rot.afterFirst.sponges).toBeGreaterThan(0);
  });

  test('the bonus arm really did collect the 2x extra — the second control', () => {
    // CAP ordinary completions plus the extra. If the bonus never fired, the
    // bonus-ledger assertion below would be about nothing.
    expect(bonusRot.afterFirst.sponges).toBe(CAP * TASK_SPONGE_REWARD + BONUS_EXTRA);
    expect(BONUS_EXTRA).toBeGreaterThan(0);
  });

  test('the arms are decidable — free cap and bonus extra are distinguishable', () => {
    // A cap of 0, or a bonus extra equal to nothing, would make "unchanged"
    // true for the wrong reason.
    expect(CAP).toBeGreaterThan(0);
    expect(rot.questPayouts).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 🔴 Ledger 1 of 3 — sponges.
  // -------------------------------------------------------------------------

  test('🔴 a rotated day key re-mints NO SPONGES', () => {
    // W2-173 measured 15 against a cap of 5 here: three calls, one account,
    // two well-formed dates.
    expect(rot.afterReplay.sponges).toBe(rot.beforeReplay.sponges);
  });

  // -------------------------------------------------------------------------
  // 🔴 Ledger 2 of 3 — XP. The silent one.
  // -------------------------------------------------------------------------

  test('🔴 a rotated day key re-mints NO XP', () => {
    // `xpPaidCount` is a SECOND counter on the same key (taskRewards.ts:374).
    // A fix that re-keyed only `paidCount` would leave this open, and nobody
    // watches XP the way they watch sponges — it gates level, which gates
    // content.
    expect(rot.afterReplay.xp).toBe(rot.beforeReplay.xp);
  });

  // -------------------------------------------------------------------------
  // 🔴 Ledger 3 of 3 — the daily 2x bonus.
  // -------------------------------------------------------------------------

  test('🔴 a rotated day key re-mints NO 2x DAILY BONUS', () => {
    // `bonusPaid` is a third read on the same key (taskRewards.ts:385), and it
    // is a BOOLEAN, so re-keying it hands back the whole extra rather than a
    // delta. This arm is one task document, so the only sponges that can move
    // here beyond the cap are the bonus's.
    expect(bonusRot.afterReplay.sponges).toBe(bonusRot.beforeReplay.sponges);
  });

  test('🔴 the bonus extra was paid exactly ONCE across the whole rotation', () => {
    // The decomposition, asserted rather than described. Two admitted keys were
    // settled, each paying CAP ordinary completions; everything above that is
    // bonus extras.
    const ADMITTED_DAYS = 2;
    const extrasPaid =
      (bonusRot.afterReplay.sponges - ADMITTED_DAYS * CAP * TASK_SPONGE_REWARD) /
      BONUS_EXTRA;
    expect(extrasPaid).toBe(1);
  });

  // -------------------------------------------------------------------------
  // The stored ledger, not the response. All three counters, one settlement.
  // -------------------------------------------------------------------------

  test('the per-day document records ONE settlement of all three counters', async () => {
    const day = await ledgerOf(ROTATOR, TODAY);
    expect(day?.paidCount).toBe(CAP);
    expect(day?.xpPaidCount).toBe(PLAIN.length);
    expect(day?.bonusPaid).toBe(false);
  });

  test('the rotated call is REFUSED, not silently zero', () => {
    // Assert the code as well as the count. A callable that rejects AND pays is
    // the shape this brief exists for; a callable that pays nothing and returns
    // ok is survivable but tells the caller nothing.
    expect(rot.replayCode).toBe('failed-precondition');
  });

  test('🔴 the PER-DAY DOCUMENT carries the money, not the ratchet', async () => {
    // 🔑 THE SEPARATION, MADE MEASURABLE. The rotation above is refused by the
    // ratchet, so those assertions cannot tell which of the two guards is doing
    // the work — and if the ratchet were ever relaxed, that ambiguity would be
    // a hole nobody could see. This call is AT the high-water mark, which the
    // ratchet admits (earlier is refused, equal is not), against a day that has
    // already been settled. Anything that refuses to pay here is the per-day
    // document.
    expect(rot.highWaterCode).toBeNull();
    expect(rot.afterHighWater).toEqual(rot.beforeHighWater);
    expect(rot.beforeHighWater.sponges).toBeGreaterThan(0);
  });

  test('a refused rotation does not also break the streak', async () => {
    // 🔑 THE ORDERING ASSERTION. The reward transaction runs BEFORE the streak
    // transaction, so a refused key writes nothing at all. With the two the
    // other way round the throw lands after the streak has already been reset
    // by the backwards date — refusing the call and costing the player their
    // streak in the same breath.
    expect(rot.streakAfter?.currentStreak).toBe(rot.streakBefore?.currentStreak);
    expect(rot.streakAfter?.isBroken).toBe(rot.streakBefore?.isBroken);
    expect(rot.streakAfter?.lastCompletionDate).toBe(rot.streakBefore?.lastCompletionDate);
  });

  // -------------------------------------------------------------------------
  // The bound.
  // -------------------------------------------------------------------------

  test('a key five days from server UTC is refused', async () => {
    const far = shiftDay(serverUtcDay(), 5);
    const {code} = await callForCode(OUT_OF_RANGE, `${far}T09:00:00`);
    expect(code).toBe('invalid-argument');
  });

  test('a key five days BEHIND server UTC is refused too', async () => {
    const far = shiftDay(serverUtcDay(), -5);
    const {code} = await callForCode(OUT_OF_RANGE, `${far}T09:00:00`);
    expect(code).toBe('invalid-argument');
  });

  test('🔴 a refused key writes NOTHING — not the profile, not even the streak', async () => {
    // The count, not the code. Both calls above were refused; if either wrote
    // anything this account would carry it, and a rejection that still moves
    // state is the failure mode the brief named.
    expect(await storedTotals(OUT_OF_RANGE)).toEqual({sponges: 0, xp: 0});
    expect((await db.doc(`users/${OUT_OF_RANGE}/streak/main`).get()).exists).toBe(false);
    expect((await db.doc(`users/${OUT_OF_RANGE}/days/${serverUtcDay()}`).get()).exists)
      .toBe(false);
  });

  test('the bound is not a UTC key in disguise — one day EITHER side is paid', async () => {
    // 🔴 THE DISPROOF CLAUSE FROM W2-173, KEPT AS A TEST. A Los Angeles player
    // at 17:00 local sends a key one day BEHIND UTC; an Auckland player at 10:00
    // local sends one a day AHEAD. Both are honest and both must be paid, which
    // is precisely what a server-derived UTC key would have stopped.
    //
    // Re-derived at call time, not from the module constants, so this stays
    // exactly +/-1 even if the run crosses UTC midnight.
    const behind = shiftDay(serverUtcDay(), -1);
    await stampTasks(EDGE, ['task-lax'], behind);
    const lax = await callForCode(EDGE, `${behind}T17:00:00`);
    expect(lax.code).toBeNull();
    expect(lax.res.granted.sponges).toBe(CAP * TASK_SPONGE_REWARD);

    const ahead = shiftDay(serverUtcDay(), 1);
    await stampTasks(EDGE, ['task-akl'], ahead);
    const akl = await callForCode(EDGE, `${ahead}T10:00:00`);
    expect(akl.code).toBeNull();
    expect(akl.res.granted.sponges).toBe(CAP * TASK_SPONGE_REWARD);
  });

  // -------------------------------------------------------------------------
  // The migration. A shape change to a live ledger pays somebody twice unless
  // the old document is read on the way past.
  // -------------------------------------------------------------------------

  test('a legacy single-document ledger for today is carried forward, not ignored', async () => {
    // Every player mid-day at deploy time has `economy/taskRewards` holding the
    // day's counters and no `days/{dayKey}` document at all. Reading only the
    // new path would treat all of them as unpaid and re-grant the whole day —
    // a one-off mint on the entire active population, caused by the fix.
    await db.doc(`users/${MIGRATED}/economy/taskRewards`).set({
      date: TODAY,
      paidCount: CAP,
      xpPaidCount: 2,
      bonusPaid: false,
    });
    await stampTasks(MIGRATED, PLAIN, TODAY);

    const res = await call('recordTaskCompletion', MIGRATED, {
      clientNowIso: `${TODAY}T09:00:00`,
    });

    expect(res.granted.sponges).toBe(0);
    expect(res.granted.xp).toBe(0);
    expect((await storedTotals(MIGRATED)).sponges).toBe(0);
  });
});
