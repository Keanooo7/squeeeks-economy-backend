// functions/src/__tests__/adminGrant.test.ts — the admin grant planner (W2-122)
//
// 🔴 THE QUESTION ASKED OF EVERY TEST BELOW: what single line could I delete
// that SHOULD turn this red?
//
// The dangerous half of this feature is not sponges — a sponge is a number and
// `FieldValue.increment` already does it. It is SKIN IDS: a granted id the
// client cannot resolve THROWS rather than degrading (`premium_offer_spring`
// made a shop card untappable), so an unchecked id is a crash shipped to a
// player Brendan was trying to be generous to.

import {
  planAdminGrant,
  ADMIN_GRANT_REFUSALS,
  MAX_SPONGES_PER_GRANT,
  MAX_CHESTS_PER_GRANT,
  catalogueIds,
} from '../adminGrant';
import { SEED_ITEMS } from '../itemPool';

const UID = 'uid-tester';
const GRANT = 'edan-launch-01';

/** A real id, read out of the catalogue rather than hard-coded. */
const REAL_ITEM = SEED_ITEMS[0].id;

const ok = (over: Record<string, unknown> = {}) =>
  planAdminGrant({ uid: UID, grantId: GRANT, sponges: 1000, ...over });

describe('🔴 W2-122 the grant id is the idempotency key, so it is checked hardest', () => {
  test.each([
    ['missing', undefined],
    ['empty', ''],
    ['a number', 7],
    ['containing a slash', 'a/b'],
  ])('%s is refused', (_label, grantId) => {
    const d = planAdminGrant({ uid: UID, grantId, sponges: 1000 });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.refusal).toBe('no-grant-id');
  });

  // 🔑 THE SLASH CASE IS NOT PEDANTRY. `adminGrants/{grantId}` is a document
  // path: a grantId of `x/y` addresses a different collection entirely, so the
  // idempotency lock would be written somewhere no retry would ever look —
  // and the retry would apply a SECOND grant while reporting success. Same
  // guard `completeTrashDay` carries on familyId.
  test('the slash refusal is about the document path, not about tidiness', () => {
    const d = planAdminGrant({ uid: UID, grantId: 'grants/../x', sponges: 1 });
    expect(d.ok).toBe(false);
  });
});

describe('🔴 W2-122 a skin id that does not exist is refused — the WHOLE request', () => {
  test('a real catalogue id is accepted', () => {
    const d = ok({ sponges: 0, itemIds: [REAL_ITEM] });
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error('unreachable');
    expect(d.plan.itemIds).toEqual([REAL_ITEM]);
  });

  test('an id that is not in the catalogue is refused and NAMES itself', () => {
    const d = ok({ itemIds: ['char_does_not_exist'] });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.refusal).toBe('unknown-item');
    // The detail is the product: "unknown item" without the id is a puzzle.
    expect(d.detail).toBe('char_does_not_exist');
  });

  // 🔴 THE CONTROL THAT MAKES THIS MEAN SOMETHING. A partial grant is the worst
  // outcome available — the admin sees success, the recipient gets some of what
  // was promised, and the audit row records a grant that did not fully happen.
  // Mutating the planner to filter bad ids instead of refusing turns ONLY this
  // test red; every other test in this describe passes against that mutation.
  test('🔴 ONE bad id refuses the whole request — good ids are NOT granted anyway', () => {
    const d = ok({ sponges: 1000, itemIds: [REAL_ITEM, 'char_does_not_exist'] });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.refusal).toBe('unknown-item');
  });

  // ⚠️ THE CASE #518 CREATED, AND IT IS THE SUBTLE ONE. #518 withdrew the FOX
  // CUTS of char_chef and char_cleaner on a design measurement. Their ATLASES
  // STILL SHIP, so an id check against files on disk would pass them — but the
  // items themselves are still sold and still wearable by a bear or a duck, so
  // the correct answer here is ACCEPT. "Is this id real" and "can this recipient
  // wear it" are different questions and only the first is answerable here.
  test('📌 char_chef is still a legal grant — #518 withdrew its FOX CUT, not the item', () => {
    const d = ok({ sponges: 0, itemIds: ['char_chef'] });
    expect(d.ok).toBe(true);
    expect(catalogueIds()).toContain('char_chef');
  });

  test('the catalogue is SEED_ITEMS, and every one of its ids is grantable', () => {
    // Anti-vacuity: if the id set were ever built empty, every grant would be
    // refused and the tests above would still pass on their refusals alone.
    expect(catalogueIds().length).toBe(SEED_ITEMS.length);
    expect(catalogueIds().length).toBeGreaterThan(30);
  });
});

describe('🔴 W2-122 sponges: a typo guard, not a game rule', () => {
  test.each([
    ['fractional', 2.5],
    ['negative', -100],
    ['NaN', Number.NaN],
    ['a numeric string', '1000'],
  ])('%s is refused', (_label, sponges) => {
    const d = ok({ sponges });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.refusal).toBe('bad-sponge-amount');
  });

  test('over the cap is refused, and the cap is a separate refusal from a bad value', () => {
    const d = ok({ sponges: MAX_SPONGES_PER_GRANT + 1 });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    // 🔑 A DIFFERENT REFUSAL ON PURPOSE. "50001 is not a whole number" would be
    // a lie, and the fix for the two cases is different: one is a typo, the
    // other is a deliberate amount that needs splitting into two grants.
    expect(d.refusal).toBe('sponges-over-cap');
  });

  test('exactly the cap is allowed — an off-by-one here refuses a legitimate grant', () => {
    expect(ok({ sponges: MAX_SPONGES_PER_GRANT }).ok).toBe(true);
  });

  test('1000 sponges, the actual ask, is accepted', () => {
    const d = ok({ sponges: 1000 });
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error('unreachable');
    expect(d.plan.sponges).toBe(1000);
  });
});

describe('🔴 W2-122 an empty grant is refused rather than written', () => {
  // It would take a grantId — burning it forever, since the ledger is keyed on
  // it — and write an audit row saying nothing happened. The retry carrying the
  // real payload would then be refused as already-processed, which is the most
  // confusing possible outcome of a typo.
  test('no sponges, no items, no chests', () => {
    const d = planAdminGrant({ uid: UID, grantId: GRANT });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.refusal).toBe('nothing-to-grant');
  });

  test('an explicit zero with nothing else is still nothing', () => {
    const d = planAdminGrant({ uid: UID, grantId: GRANT, sponges: 0, itemIds: [] });
    expect(d.ok).toBe(false);
  });

  test('CONTROL: zero sponges WITH an item is a perfectly good grant', () => {
    expect(planAdminGrant({
      uid: UID, grantId: GRANT, sponges: 0, itemIds: [REAL_ITEM],
    }).ok).toBe(true);
  });
});

describe('W2-122 chests are named by CATEGORY, because that is what rolls', () => {
  test('a known category is accepted and is not de-duplicated', () => {
    const d = ok({ sponges: 0, chestCategories: ['characters', 'characters'] });
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error('unreachable');
    // Two chests of one category is a legitimate ask and must produce TWO
    // openable chests — unlike skins, where a duplicate is one document.
    expect(d.plan.chestCategories).toEqual(['characters', 'characters']);
  });

  test('skins ARE de-duplicated, because a duplicate is one inventory document', () => {
    const d = ok({ sponges: 0, itemIds: [REAL_ITEM, REAL_ITEM] });
    expect(d.ok).toBe(true);
    if (!d.ok) throw new Error('unreachable');
    expect(d.plan.itemIds).toEqual([REAL_ITEM]);
  });

  test('an unknown category is refused and names itself', () => {
    const d = ok({ chestCategories: ['spaceships'] });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.refusal).toBe('unknown-chest-category');
    expect(d.detail).toBe('spaceships');
  });

  test('more than the cap is refused', () => {
    const d = ok({
      chestCategories: Array(MAX_CHESTS_PER_GRANT + 1).fill('characters'),
    });
    expect(d.ok).toBe(false);
    if (d.ok) throw new Error('unreachable');
    expect(d.refusal).toBe('too-many-chests');
  });
});

describe('📌 W2-122 every refusal has text a person in a terminal can act on', () => {
  test('the table covers every refusal the planner can return', () => {
    const produced = new Set<string>();
    const cases: Array<Record<string, unknown>> = [
      { uid: UID, grantId: '' },
      { uid: '', grantId: GRANT },
      { uid: UID, grantId: GRANT },
      { uid: UID, grantId: GRANT, sponges: 2.5 },
      { uid: UID, grantId: GRANT, sponges: MAX_SPONGES_PER_GRANT + 1 },
      { uid: UID, grantId: GRANT, itemIds: ['nope'] },
      { uid: UID, grantId: GRANT, chestCategories: ['nope'] },
      {
        uid: UID, grantId: GRANT,
        chestCategories: Array(MAX_CHESTS_PER_GRANT + 1).fill('characters'),
      },
    ];
    for (const c of cases) {
      const d = planAdminGrant(c as never);
      if (!d.ok) produced.add(d.refusal);
    }
    // Every refusal the planner can actually produce has an entry, and the
    // table has no entries for refusals that cannot happen.
    expect([...produced].sort()).toEqual(Object.keys(ADMIN_GRANT_REFUSALS).sort());
    for (const text of Object.values(ADMIN_GRANT_REFUSALS)) {
      expect(text.length).toBeGreaterThan(20);
    }
  });
});
