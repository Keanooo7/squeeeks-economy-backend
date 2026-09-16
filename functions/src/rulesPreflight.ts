/**
 * Preflight for a rules deploy.
 *
 * `firebase deploy --only firestore:rules` behaves in opposite ways for two
 * different kinds of missing input:
 *
 *   - `"rules"` present but naming a file that does not exist -> fails closed.
 *     firebase-tools reads the path and throws `Error reading rules file`.
 *   - `"rules"` key absent -> exits 0 having uploaded nothing. `prepare.js`
 *     guards `if (firestoreConfig.rules)`, so the ruleset list stays empty,
 *     `compile()` never runs, and the deploy loop has nothing to iterate. The
 *     previously-deployed rules stay live, so nothing visibly breaks — a rules
 *     change simply never ships while the command reports success.
 *
 * The same is true one level up: with no `firestore` block at all, the whole
 * firestore deploy step returns early and still exits 0.
 *
 * This module answers "would this config actually upload a ruleset?" so a
 * deploy that would silently no-op can be refused instead.
 */

/**
 * The hole in this guard, stated wherever the guard speaks.
 *
 * It is wired as a `firestore.predeploy` hook, and firebase-tools resolves
 * hooks with `options.config.get("firestore")` (`lifecycleHooks.js:99`), which
 * returns `[]` when the block is absent. Measured against the installed
 * firebase-tools: the hook RUNS for `--only firestore:rules`, and runs even
 * when the `rules` key is missing — but is SKIPPED when the whole `firestore`
 * block is deleted, which is also the case where the deploy itself silently
 * does nothing. A predeploy hook cannot guard its own absence.
 */
export const UNCOVERED_CASE =
  'Not covered: deleting the whole "firestore" block from firebase.json skips ' +
  'this check AND the deploy, both silently. A predeploy hook cannot guard its ' +
  'own absence — only the missing "rules" key is caught here.';

/** Everything this check needs from the outside world. */
export interface RulesPreflightDeps {
  /** True if `relativePath`, resolved against the repo root, exists. */
  fileExists(relativePath: string): boolean;
}

export interface RulesPreflightResult {
  ok: boolean;
  /** One human-readable line per problem; empty when `ok`. */
  violations: string[];
}

/** A `rules` key we expect to find, and where it lives. */
interface RulesSlot {
  /** Dotted path as it appears in firebase.json, for error text. */
  label: string;
  /** The block the key should sit in, already extracted. */
  block: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * firebase.json allows `firestore` to be either a single config object or an
 * array of them (one per database). Normalise to a list so both shapes get the
 * same treatment.
 */
function asBlocks(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function checkSlot(slot: RulesSlot, deps: RulesPreflightDeps): string[] {
  const {label, block} = slot;

  if (!isRecord(block)) {
    return [
      `${label}: block is missing from firebase.json — a deploy would skip ` +
        `this target entirely and still exit 0.`,
    ];
  }

  const rules = block.rules;

  if (rules === undefined) {
    return [
      `${label}.rules: key is absent — firebase would upload no ruleset and ` +
        `still exit 0, leaving the previously deployed rules live.`,
    ];
  }

  if (typeof rules !== 'string' || rules.trim() === '') {
    return [`${label}.rules: must be a non-empty path, got ${JSON.stringify(rules)}.`];
  }

  if (!deps.fileExists(rules)) {
    return [`${label}.rules: names "${rules}", which does not exist.`];
  }

  return [];
}

/**
 * Check that `rawConfig` (a parsed firebase.json) would really deploy both
 * rulesets. Pure — all filesystem access goes through `deps`.
 */
export function checkRulesConfig(
  rawConfig: unknown,
  deps: RulesPreflightDeps,
): RulesPreflightResult {
  if (!isRecord(rawConfig)) {
    return {ok: false, violations: ['firebase.json: expected a JSON object at the top level.']};
  }

  const violations: string[] = [];

  const firestoreBlocks = asBlocks(rawConfig.firestore);
  if (firestoreBlocks.length === 0) {
    violations.push(
      'firestore: block is missing from firebase.json — `firebase deploy ' +
        '--only firestore:rules` would return early and still exit 0.',
    );
  } else {
    firestoreBlocks.forEach((block, i) => {
      const label = firestoreBlocks.length > 1 ? `firestore[${i}]` : 'firestore';
      violations.push(...checkSlot({label, block}, deps));
    });
  }

  violations.push(...checkSlot({label: 'storage', block: rawConfig.storage}, deps));

  return {ok: violations.length === 0, violations};
}
