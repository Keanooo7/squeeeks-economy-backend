/**
 * patch-weekly-offer.js
 *
 * Rewrites the LIVE weekly offer on `shop/current` from the bundled seed, so a
 * player stops seeing a stale one. Modelled on patch-chest-names.js.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: WHY THIS EXISTS, AND WHY THE PRICE IS THE SMALLER HALF
 * ---------------------------------------------------------------------------
 *
 * Measured against production on 2026-08-16, `shop/current.weeklyOffer` held:
 *
 *     price:        9.99                     (the seed says 2.99 since #350/#415)
 *     iapProductId: premium_offer_spring     (a product that DOES NOT EXIST)
 *
 * WARNING: THE PRICE IS THE VISIBLE HALF. `premium_offer_spring` is registered in
 * NEITHER App Store Connect NOR ios/Configuration.storekit — #415 found it and
 * offerIntegrity.test.ts asserts the seed never uses it again. A missing SHOP
 * product THROWS at the client, so the card in the shop right now is not merely
 * mispriced: TAPPING IT CANNOT COMPLETE A PURCHASE AT ALL. That is very likely
 * what "it has been a problem for way too long" actually describes.
 *
 * ---------------------------------------------------------------------------
 * WHY THE CODE FIX NEVER REACHED A PLAYER
 * ---------------------------------------------------------------------------
 *
 *   · `/shop/current.weeklyOffer` is written ONLY by `rotateWeeklyOffer`,
 *     `onSchedule('0 0 * * 1')` — Mondays 00:00 UTC.
 *   · The live document was written by the Monday 2026-08-10 rotation
 *     (`startsAt: 2026-08-10T00:00:04Z`), from the seed AS IT WAS THEN.
 *   · The seed was corrected on 2026-08-14 — FOUR DAYS AFTER that rotation.
 *   · There has been no rotation since, so nothing has re-read the corrected
 *     seed. The fix was real, landed, gated, and invisible.
 *
 * KEY: AND THE NEXT ROTATION FIXES IT BY ITSELF. `rotateWeeklyOffer` reads
 * `shopConfig/weeklyOffers` and falls back to the bundled `WEEKLY_OFFERS` when
 * that config is missing or empty. **That document returns HTTP 404 in
 * production — it does not exist** — so the seed IS the source, and Monday
 * 2026-08-17T00:00Z writes 2.99 with the real product id.
 *
 * WARNING: THAT INVERTS THE OBVIOUS WORRY. The fear was that patching the visible
 * document would be reverted by the next rotation. It is the opposite: the next
 * rotation is the fix, and this script only brings it forward. It is worth
 * running because a submission or a player looking today sees the broken card,
 * not because the schedule would undo it.
 *
 * NOTE: THE DAILY WRITER IS NOT A RACE. `rotateMarket` runs `0 0 * * *` and writes
 * `shop/current` with `{merge: true}`, touching only `dailyChests` and
 * `dailyChestsRefreshAt`. It cannot clobber `weeklyOffer`.
 *
 * ---------------------------------------------------------------------------
 * Prerequisites — same as patch-chest-names.js
 *   1. Firebase console → Project Settings → Service Accounts
 *                       → Generate new private key. Store it OUTSIDE the repo.
 *   2. export GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json
 *   3. From the repo root:
 *        node functions/scripts/patch-weekly-offer.js          # dry run
 *        node functions/scripts/patch-weekly-offer.js --write  # actually write
 *
 * CRITICAL: DRY RUN IS THE DEFAULT. It prints the before and after and writes nothing
 * unless `--write` is passed, because the failure mode of a patch script is
 * running it while reading its output.
 *
 * ---------------------------------------------------------------------------
 * CRITICAL: W2-164 — THE WINDOW IS REPORTED AND NEVER PATCHED. THE DECISION, AND WHY.
 * ---------------------------------------------------------------------------
 *
 * This script used to decide `NOTHING TO DO` from PRICE and PRODUCT ID alone,
 * and the two fields that decide whether a player SEES the offer are `startsAt`
 * and `endsAt`. Its dry run never printed them either — so the operator running
 * it to CHECK got the same blind answer as the operator running it to FIX, and a
 * live offer whose window had closed was reported healthy with exit 0.
 *
 * The window is now PRINTED, EVALUATED, and NEVER WRITTEN. Not writing it is the
 * decision, not an omission:
 *
 *   · THE SEED HAS NO WINDOW TO PATCH TO. `WEEKLY_OFFERS` carries no
 *     `startsAt`/`endsAt` at all — deliberately, per weeklyOffers.ts: the cron
 *     generates them server-side and overrides anything supplied there. There is
 *     no stale-vs-fresh comparison to make, because there is no seed value.
 *   · A WRONG WINDOW IS WORSE THAN A STALE PRICE. A mispriced card is visible and
 *     wrong; a card outside its window is not on the screen at all. Inventing a
 *     window here would put a third author on a field `rotateWeeklyOffer` owns.
 *   · SO THE WINDOW CHANGES WHAT THE EXIT MEANS, NOT WHAT GETS WRITTEN — see
 *     EXIT_NOT_VISIBLE below. "The fields I can patch are correct" and "the offer
 *     is on a player's screen" used to be the same green.
 *
 * WARNING: AND THE MERGE DOES NOT DO WHAT THIS FILE USED TO CLAIM. `{merge: true}`
 * DEEP-MERGES a nested map, so a patch leaves `startsAt`/`endsAt` untouched
 * rather than replacing the whole `weeklyOffer`. Measured against the emulator on
 * 2026-08-30; the old comment at the write said "replaces", and acting on that
 * belief would delete a live window. The consequence is that a successful
 * `--write` can leave the card invisible, which the script now says out loud
 * instead of printing "OK".
 *
 * KEY: The logic lives in `src/weeklyOffers.ts` (`offerWindowState` and friends),
 * not in this file, so `npm test` can reach it. A second copy here would be a
 * third place for the rule to drift — the exact defect this script exists to
 * repair.
 */

const admin = require('firebase-admin');
const path = require('path');

/**
 * Exit codes are a contract, the same discipline `check-test-floor.cjs` states:
 *
 *   0  healthy — price and product id match the seed AND the window is open
 *   1  error   — could not run, or the re-read disagreed with the write
 *   2  THE OFFER IS NOT VISIBLE. Everything this script can patch is correct
 *      (or has just been patched) and the card is still off every screen,
 *      because the window is closed, absent or unreadable and only
 *      `rotateWeeklyOffer` writes it.
 *
 * KEY: 2 EXISTS SO "I FIXED IT" AND "IT IS FIXED" CAN BE TOLD APART. Collapsed
 * into 0 they were the same green, and the green was the defect.
 */
const EXIT_NOT_VISIBLE = 2;

const WRITE = process.argv.includes('--write');
const PROJECT_ID = '<project-id>';

const CRED_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS;
if (!CRED_PATH) {
  console.error(
    'ERROR: set GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json\n' +
      '  Firebase console → Project Settings → Service Accounts → Generate new private key.\n' +
      '  Store it OUTSIDE the repo and never commit it.',
  );
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(CRED_PATH)),
  projectId: PROJECT_ID,
});

const db = admin.firestore();

/**
 * The offer this script writes, taken from the COMPILED seed — never retyped.
 *
 * CRITICAL: A HAND-COPIED PRICE HERE WOULD BE THE ORIGINAL BUG, REBUILT INSIDE ITS OWN
 * FIX. The whole defect is a number that was correct in one place and stale in
 * another; typing `2.99` into this file would create a third place to drift.
 * `lib/weeklyOffers.js` is the build output of `functions/src/weeklyOffers.ts`,
 * so this reads exactly what `rotateWeeklyOffer` would read.
 *
 * WARNING: Requires a build first: `npm --prefix functions run build`.
 */
/**
 * The compiled `weeklyOffers` module — the seed AND the window helpers.
 *
 * Same discipline as `seedOffer` below and the same reason: the window logic is
 * decided once, in TypeScript, where `npm test` can reach it. A second copy
 * inside this script would be a third place for the rule to drift, which is the
 * exact defect this script was written to repair.
 */
function offerWindow() {
  const libPath = path.resolve(__dirname, '..', 'lib', 'weeklyOffers.js');
  try {
    return require(libPath);
  } catch (e) {
    console.error(
      `ERROR: could not load the compiled seed at ${libPath}\n` +
        '  Run `npm --prefix functions run build` first.\n' +
        `  (${e.message})`,
    );
    process.exit(1);
  }
}

function seedOffer() {
  const libPath = path.resolve(__dirname, '..', 'lib', 'weeklyOffers.js');
  let mod;
  try {
    mod = require(libPath);
  } catch (e) {
    console.error(
      `ERROR: could not load the compiled seed at ${libPath}\n` +
        '  Run `npm --prefix functions run build` first — this script deliberately\n' +
        '  reads the seed rather than carrying its own copy of the price.\n' +
        `  (${e.message})`,
    );
    process.exit(1);
  }
  const offers = mod.WEEKLY_OFFERS;
  if (!Array.isArray(offers) || offers.length === 0) {
    console.error('ERROR: WEEKLY_OFFERS is missing or empty in the compiled seed.');
    process.exit(1);
  }
  // rotateWeeklyOffer picks `offers[weekNum % offers.length]`. With a
  // single-entry pool that is offers[0]; if the pool ever grows, this script
  // patches to the FIRST entry and says so rather than guessing the week.
  if (offers.length > 1) {
    console.warn(
      `⚠️  the seed pool has ${offers.length} offers; this script writes offers[0] ` +
        '(“' + offers[0].title + '”). rotateWeeklyOffer picks by week number, so ' +
        'confirm that is the one you want before --write.',
    );
  }
  return offers[0];
}

/** A stored timestamp as readable UTC, or a marked absence. */
function stamp(value) {
  if (value == null) return '(absent)';
  const ms = offerWindow().offerTimestampMillis(value);
  if (ms === null) return `(unreadable: ${JSON.stringify(value)})`;
  return new Date(ms).toISOString();
}

function describe(offer, nowMs) {
  if (!offer) return '(no weeklyOffer field)';
  const lines = [
    `  id:           ${offer.id}`,
    `  title:        ${offer.title}`,
    `  price:        ${offer.price} ${offer.currency ?? ''}`.trimEnd(),
    `  iapProductId: ${offer.iapProductId}`,
    // CRITICAL: W2-164 — THE TWO FIELDS THAT DECIDE WHETHER A PLAYER SEES ANY OF THE
    // ABOVE. They were absent from this function, so an operator running the
    // dry run to CHECK the offer got the same blind answer as one running it to
    // FIX: every price could be right and the card still invisible.
    `  startsAt:     ${stamp(offer.startsAt)}`,
    `  endsAt:       ${stamp(offer.endsAt)}`,
  ];
  if (nowMs != null) {
    const state = offerWindow().offerWindowState(offer, nowMs);
    lines.push(`  window:       ${state} — ${offerWindow().offerWindowExplanation(state)}`);
  }
  return lines.join('\n');
}

async function main() {
  const ref = db.doc('shop/current');
  const snap = await ref.get();

  // CRITICAL: REFUSES RATHER THAN CREATING, the safety shape patch-chest-names.js set.
  // An absent shop/current means the scheduler has never run or something has
  // deleted it, and inventing a document here would paper over that with a
  // hand-made one nothing else agrees with.
  if (!snap.exists) {
    console.error(
      'ERROR: shop/current does not exist. Refusing to create it.\n' +
        '  That document is written by rotateWeeklyOffer / rotateMarket; if it is\n' +
        '  missing, the schedulers are the problem and a patch would hide it.',
    );
    process.exit(1);
  }

  const before = snap.data()?.weeklyOffer;
  const target = seedOffer();
  const nowMs = Date.now();
  const windowState = offerWindow().offerWindowState(before, nowMs);
  const visible = offerWindow().offerIsVisible(windowState);

  console.log(`project: ${PROJECT_ID}   document: shop/current`);
  console.log(`now:     ${new Date(nowMs).toISOString()}\n`);
  console.log('BEFORE (live):');
  console.log(describe(before, nowMs));
  console.log('\nAFTER (from the bundled seed):');
  // No clock for the seed: it carries no window, so asking about its visibility
  // would print a state for fields that do not exist and cannot.
  console.log(describe(target));
  console.log(
    '\n  note: the seed carries NO startsAt/endsAt — rotateWeeklyOffer generates\n' +
      '        them server-side. This script therefore never writes a window.',
  );

  const samePrice = before?.price === target.price;
  const sameProduct = before?.iapProductId === target.iapProductId;

  // CRITICAL: W2-164 — THE WINDOW IS REPORTED, NEVER PATCHED, AND HERE IS THE REASON.
  //
  // A price mismatch is unambiguous. A window mismatch is not: the cron rewrites
  // `startsAt`/`endsAt` every Monday, and the seed's pool carries neither, so
  // there is no seed value a live window could be "restored" to. A script that
  // wrote one would invent a third author for a field `rotateWeeklyOffer` owns,
  // and a wrong window is worse than a stale price — it makes the card invisible
  // instead of merely mispriced.
  //
  // KEY: SO THE WINDOW CHANGES WHAT THE EXIT MEANS, NOT WHAT GETS WRITTEN. It is
  // the difference between "this document is healthy" and "the two fields I can
  // patch are already correct and the offer is STILL not on anyone's screen" —
  // two facts that used to share the single word NOTHING TO DO.
  if (!visible) {
    console.log(`\n⚠️  WINDOW: ${windowState} — ${offerWindow().offerWindowExplanation(windowState)}`);
    console.log(
      '    Only rotateWeeklyOffer (Mondays 00:00 UTC) can move this. Patching\n' +
        '    price or product id will NOT make the card appear.',
    );
  }

  if (samePrice && sameProduct) {
    // Idempotent: running it twice is a no-op with a clear message rather than
    // a second write that churns updateTime for nothing.
    //
    // WARNING: AND THE MESSAGE NOW NAMES WHAT IT COMPARED. The old text was
    // "NOTHING TO DO — the live offer already matches the seed on price and
    // product id." — true, and read by every operator as "the offer is fine",
    // which it does not say and cannot: it never looked at the window.
    if (visible) {
      console.log(
        '\nNOTHING TO DO — price and iapProductId match the seed, and the window is open.',
      );
      process.exit(0);
    }
    console.log(
      '\nNOTHING THIS SCRIPT CAN DO — price and iapProductId already match the seed,\n' +
        '  but the offer is not visible to players. Compared: price, iapProductId,\n' +
        '  startsAt, endsAt. Patched: nothing. See the WINDOW line above.',
    );
    process.exit(EXIT_NOT_VISIBLE);
  }

  console.log('\nDIFFERS:');
  if (!samePrice) console.log(`  price         ${before?.price} → ${target.price}`);
  if (!sameProduct) console.log(`  iapProductId  ${before?.iapProductId} → ${target.iapProductId}`);

  if (!WRITE) {
    console.log(
      '\nDRY RUN — nothing was written. Re-run with --write to apply:\n' +
        '  node functions/scripts/patch-weekly-offer.js --write',
    );
    process.exit(0);
  }

  // CRITICAL: CORRECTED W2-164, AND THE OLD COMMENT WAS WRONG IN A LOAD-BEARING WAY.
  // It said this "replaces `weeklyOffer`". It does not: Firestore's
  // `{merge: true}` DEEP-MERGES a nested map, so the keys the seed does not
  // carry survive untouched. Measured against the Firestore emulator on
  // 2026-08-30 with exactly this call shape:
  //
  //     before  {id:'live', price:9.99, startsAt:'LIVE-START', endsAt:'LIVE-END'}
  //     after   {startsAt:'LIVE-START', endsAt:'LIVE-END', price:2.99, id:'seed'}
  //
  // KEY: THAT IS THE BEHAVIOUR WE WANT — it is why patching cannot stomp a live
  // window back to a stale seed value — but believing the old comment would lead
  // someone to "fix" the merge into a replace, which WOULD delete `startsAt` and
  // `endsAt` from a live offer and take the card off every screen.
  //
  // `dailyChests` and both refresh stamps are likewise untouched, which the old
  // comment got right for the same reason it got the rest wrong.
  await ref.set({weeklyOffer: target}, {merge: true});
  const after = (await ref.get()).data()?.weeklyOffer;

  console.log('\nWROTE. Re-read from Firestore:');
  console.log(describe(after, Date.now()));
  // Re-read and re-check rather than trusting the write to have done what it
  // said — the same discipline as verifying a floor by re-reading the file.
  if (after?.price !== target.price || after?.iapProductId !== target.iapProductId) {
    console.error('\n🔴 THE RE-READ DOES NOT MATCH. Something else wrote after this did.');
    process.exit(1);
  }
  // WARNING: THE SUCCESS LINE IS CONDITIONAL, because "matches the seed" and "a player
  // can see it" are different claims and this script can only deliver the first.
  // The window survived the merge; if it was closed before, it is closed now.
  const afterState = offerWindow().offerWindowState(after, Date.now());
  if (!offerWindow().offerIsVisible(afterState)) {
    console.log(
      '\n⚠️  WROTE, BUT THE OFFER IS STILL NOT VISIBLE.\n' +
        `    price and iapProductId now match the seed; the window is ${afterState}.\n` +
        '    The window survived the merge unchanged — this script does not write it.\n' +
        '    Only rotateWeeklyOffer (Mondays 00:00 UTC) can open it.',
    );
    process.exit(EXIT_NOT_VISIBLE);
  }
  console.log('\nOK — the live offer matches the seed and its window is open.');
}

main().catch((e) => {
  console.error('patch-weekly-offer failed:', e);
  process.exit(1);
});
