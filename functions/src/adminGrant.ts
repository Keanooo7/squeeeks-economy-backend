// functions/src/adminGrant.ts — the admin grant path (W2-122)
//
// Brendan names an account he has verified, confirms it, and a grant is issued:
// sponges, skins, and chests. Before this there was NO path at all —
// `spongeBalance` moved only inside player-facing callables, and skins and
// chests had no grant surface whatsoever.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE IS PURE
// ---------------------------------------------------------------------------
//
// Everything here decides; nothing reads or writes. The endpoint in index.ts
// owns the transaction, the idempotency lock and the audit row. That split is
// the same one `family.ts` and `trashDay.ts` use, and it is what lets the hard
// part — which ids are legal — be tested without an emulator.
//
// ---------------------------------------------------------------------------
// CRITICAL: THE HARD PART IS NOT SPONGES
// ---------------------------------------------------------------------------
//
// A sponge is a number and `FieldValue.increment` already does it. Skins are
// where this gets dangerous:
//
//   A GRANTED SKIN ID THAT DOES NOT EXIST IS A CLIENT CRASH. The precedent is
//   `premium_offer_spring`, a missing shop product that made a shop card
//   untappable — a bad id does not degrade, it throws at the client.
//
// KEY: SO THE WHOLE REQUEST IS REFUSED, NOT THE BAD ROW. A partial grant is the
// worst outcome available: the admin sees success, the recipient gets some of
// what was promised, and the audit row records a grant that did not fully
// happen. Refusing the request keeps the ledger honest and costs one retry.
//
// WARNING: AND THE CATALOGUE IS `SEED_ITEMS`, NOT THE ASSET DIRECTORY. #518 withdrew
// the fox cuts of `char_chef` and `char_cleaner` on a design measurement AND
// THEIR ATLASES STILL SHIP, so an id check against files on disk would happily
// pass a skin the game deliberately no longer offers. The shipped rows are the
// catalogue; the files are an implementation detail of the rows.
//
// NOTE: NOTE THE SUBTLETY THAT MAKES THAT EXAMPLE THE RIGHT ONE: `char_chef` is
// still a legal grant. What #518 withdrew was its FOX CUT — the item is still
// sold and still wearable by a bear or a duck. So "is this id real" and "can
// this recipient wear it" are two different questions, and only the first one
// is answerable here. See SPECIES, below.

import { SEED_ITEMS, CHEST_CATEGORY_DROP_TABLE } from './itemPool';

/** Every id the shipped catalogue defines. Built once, at module load. */
const CATALOGUE_IDS: ReadonlySet<string> = new Set(SEED_ITEMS.map((i) => i.id));

/** Every chest category the rotation knows how to roll. */
const CHEST_CATEGORIES: ReadonlySet<string> = new Set(
  Object.keys(CHEST_CATEGORY_DROP_TABLE),
);

/**
 * The most sponges one grant may issue.
 *
 * WARNING: NOT A BALANCE CAP AND NOT A GAME RULE — a typo guard. The difference
 * between granting 1000 and 100000 is one keystroke on a number nobody reads
 * back, and the second one is not recoverable through this endpoint because
 * there is deliberately no negative grant. Brendan can issue two grants of
 * 50000 if he ever means it; he cannot un-issue one.
 */
export const MAX_SPONGES_PER_GRANT = 50_000;

/** The most chests one grant may issue, for the same reason. */
export const MAX_CHESTS_PER_GRANT = 20;

export type AdminGrantRefusal =
  | 'no-grant-id'
  | 'no-uid'
  | 'nothing-to-grant'
  | 'bad-sponge-amount'
  | 'sponges-over-cap'
  | 'unknown-item'
  | 'unknown-chest-category'
  | 'too-many-chests';

export interface AdminGrantPlan {
  uid: string;
  grantId: string;
  sponges: number;
  /** Catalogue ids, de-duplicated, order preserved. */
  itemIds: string[];
  /** Chest CATEGORIES to mint as unopened chests — see index.ts. */
  chestCategories: string[];
}

export type AdminGrantDecision =
  | { ok: true; plan: AdminGrantPlan }
  | { ok: false; refusal: AdminGrantRefusal; detail?: string };

/**
 * Whether this grant request is legal, and exactly what it would write.
 *
 * KEY: ORDER MATTERS AND IS DELIBERATE: shape first, then the catalogue. An admin
 * holding the secret is trusted, so this is not defending against them — it is
 * defending the RECIPIENT against a typo, and a refusal that names the typo is
 * the whole product. Every refusal below carries a `detail` naming the offending
 * value, because "unknown item" without the id is a puzzle.
 *
 * WARNING: SPECIES IS DELIBERATELY NOT CHECKED HERE, AND THAT IS A DECISION RATHER
 * THAN AN OMISSION. `wearableRefusalFor` exists because a skin dresses specific
 * animals, so granting a fox outfit to a player who has no fox produces an album
 * entry they cannot use. Three options were available — refuse, warn, allow —
 * and this ALLOWS, because:
 *
 *   · the recipient may unlock that species later, at which point the grant
 *     becomes live on its own and a refusal would have been simply wrong;
 *   · Brendan names each recipient by hand after verifying them, so a
 *     pre-grant is a plausible intention rather than an accident;
 *   · refusing is the IRREVERSIBLE-FEELING direction: it forces him to grant a
 *     species first, through a path that does not exist yet.
 *
 * NOTE: But it is REPORTED. The endpoint's response names any granted skin the
 * recipient cannot currently wear, so the decision is visible at the moment it
 * is made rather than discovered in an album. Allowing silently would be the
 * option nobody chose.
 *
 * Pure: no clock, no database, no randomness.
 */
export function planAdminGrant(args: {
  uid: unknown;
  grantId: unknown;
  sponges?: unknown;
  itemIds?: unknown;
  chestCategories?: unknown;
}): AdminGrantDecision {
  const { uid, grantId, sponges, itemIds, chestCategories } = args;

  // CRITICAL: THE GRANT ID IS THE IDEMPOTENCY KEY, SO IT IS CHECKED FIRST AND HARDEST.
  // Without it a retried curl — the most likely thing to happen on a flaky
  // connection — is a second 1000 sponges, and nothing afterwards can tell the
  // two grants apart. A slash would escape the collection and address an
  // arbitrary document, the same guard `completeTrashDay` carries on familyId.
  if (typeof grantId !== 'string' || grantId.length === 0 || grantId.includes('/')) {
    return { ok: false, refusal: 'no-grant-id' };
  }
  if (typeof uid !== 'string' || uid.length === 0 || uid.includes('/')) {
    return { ok: false, refusal: 'no-uid' };
  }

  // Sponges: absent means zero, which is normal — a skins-only grant is a
  // perfectly good grant. But a PRESENT value that is not a whole number is a
  // typo, and 2.5 sponges is not a thing this economy can represent.
  let spongeAmount = 0;
  if (sponges !== undefined && sponges !== null) {
    if (
      typeof sponges !== 'number' ||
      !Number.isInteger(sponges) ||
      sponges < 0
    ) {
      return { ok: false, refusal: 'bad-sponge-amount', detail: String(sponges) };
    }
    if (sponges > MAX_SPONGES_PER_GRANT) {
      return { ok: false, refusal: 'sponges-over-cap', detail: String(sponges) };
    }
    spongeAmount = sponges;
  }

  const rawItems = normaliseList(itemIds);
  const rawChests = normaliseList(chestCategories);

  // CRITICAL: EVERY ID, AGAINST THE SHIPPED ROWS. First offender wins so the message
  // names one thing to fix rather than a list to decode.
  for (const id of rawItems) {
    if (!CATALOGUE_IDS.has(id)) {
      return { ok: false, refusal: 'unknown-item', detail: id };
    }
  }
  for (const category of rawChests) {
    if (!CHEST_CATEGORIES.has(category)) {
      return { ok: false, refusal: 'unknown-chest-category', detail: category };
    }
  }
  if (rawChests.length > MAX_CHESTS_PER_GRANT) {
    return { ok: false, refusal: 'too-many-chests', detail: String(rawChests.length) };
  }

  // WARNING: A GRANT OF NOTHING IS REFUSED RATHER THAN WRITTEN. It would take a
  // grantId — burning it forever, since the ledger is keyed on it — and write
  // an audit row recording that nothing happened. The retry with the real
  // payload would then be refused as already-processed, which is the most
  // confusing possible outcome of a typo.
  if (spongeAmount === 0 && rawItems.length === 0 && rawChests.length === 0) {
    return { ok: false, refusal: 'nothing-to-grant' };
  }

  return {
    ok: true,
    plan: {
      uid,
      grantId,
      sponges: spongeAmount,
      // De-duplicated: granting the same skin twice is one inventory document
      // either way, so the plan should say what will actually happen.
      itemIds: [...new Set(rawItems)],
      // NOT de-duplicated: two chests of the same category is a legitimate ask
      // and produces two openable chests.
      chestCategories: rawChests,
    },
  };
}

/** Accepts a missing value, a single string, or an array of them. */
function normaliseList(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/** Human-facing refusal text. These are read by a person in a terminal. */
export const ADMIN_GRANT_REFUSALS: Record<AdminGrantRefusal, string> = {
  'no-grant-id':
    'grantId is required, must be a non-empty string, and must not contain "/". ' +
    'It is the idempotency key: reusing it returns the ORIGINAL grant instead of ' +
    'issuing a second one, which is what makes a retry safe.',
  'no-uid': 'uid is required, must be a non-empty string, and must not contain "/".',
  'nothing-to-grant':
    'This grant would write nothing. Supply at least one of sponges, itemIds or ' +
    'chestCategories — an empty grant would burn its grantId and make the real ' +
    'retry look already-processed.',
  'bad-sponge-amount': 'sponges must be a whole number of 0 or more.',
  'sponges-over-cap':
    `sponges exceeds MAX_SPONGES_PER_GRANT (${MAX_SPONGES_PER_GRANT}). This is a ` +
    'typo guard, not a game rule — issue two grants if you mean it. There is no ' +
    'negative grant, so an over-grant cannot be undone here.',
  'unknown-item':
    'That item id is not in the shipped catalogue (SEED_ITEMS). A granted id the ' +
    'client cannot resolve THROWS rather than degrading — see premium_offer_spring. ' +
    'The whole request was refused; nothing was written.',
  'unknown-chest-category':
    'That is not a chest category this app rolls. Known categories come from ' +
    `CHEST_CATEGORY_DROP_TABLE: ${[...CHEST_CATEGORIES].join(', ')}.`,
  'too-many-chests': `More than MAX_CHESTS_PER_GRANT (${MAX_CHESTS_PER_GRANT}) chests in one grant.`,
};

/** The catalogue ids, for callers that want to report what IS legal. */
export function catalogueIds(): string[] {
  return [...CATALOGUE_IDS];
}
