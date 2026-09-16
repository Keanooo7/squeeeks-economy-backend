import { SEED_ITEMS } from '../itemPool';

// claimWelcomeChest grants one RARE item of each of these three types. If the
// seed ever loses its last rare of any type, the callable throws
// 'failed-precondition' at claim time — which is the orientation dead end all
// over again, for a new player, in production. Catch it here instead.
//
// Deliberately asserts against SEED_ITEMS rather than a live Firestore: this
// is the source the `items` collection is seeded from, so it is the thing that
// can actually drift.
const WELCOME_CHEST_TYPES = ['furniture', 'character', 'style'] as const;

describe('welcome chest pool', () => {
  for (const type of WELCOME_CHEST_TYPES) {
    it(`has at least one rare ${type} to draw`, () => {
      const rares = SEED_ITEMS.filter(
        (i) => i.type === type && i.rarity === 'rare',
      );
      expect(rares.length).toBeGreaterThan(0);
    });
  }

  it('covers every type the callable draws from', () => {
    const seededTypes = new Set(SEED_ITEMS.map((i) => i.type));
    for (const type of WELCOME_CHEST_TYPES) {
      expect(seededTypes).toContain(type);
    }
  });

  it('grants three items — one per type, no duplicates possible', () => {
    // The callable runs one query per type, so a single item can never be
    // drawn twice. Guards against a future seed row with an ambiguous type.
    const byType = new Map<string, string[]>();
    for (const item of SEED_ITEMS) {
      if (item.rarity !== 'rare') continue;
      byType.set(item.type, [...(byType.get(item.type) ?? []), item.id]);
    }
    const drawable = WELCOME_CHEST_TYPES.map((t) => byType.get(t) ?? []);
    expect(drawable).toHaveLength(3);
    expect(drawable.every((ids) => ids.length > 0)).toBe(true);

    const allIds = drawable.flat();
    expect(new Set(allIds).size).toBe(allIds.length);
  });
});
