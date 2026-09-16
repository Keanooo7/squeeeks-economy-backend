import * as fs from 'fs';
import * as path from 'path';

import {checkRulesConfig, RulesPreflightDeps, UNCOVERED_CASE} from '../rulesPreflight';

/** The shape of the real firebase.json, trimmed to what the preflight reads. */
const GOOD_CONFIG = {
  firestore: {rules: 'firestore.rules', indexes: 'firestore.indexes.json'},
  storage: {rules: 'storage.rules'},
};

/** Pretend every path named in GOOD_CONFIG is on disk, and nothing else is. */
const presentFiles = new Set(['firestore.rules', 'firestore.indexes.json', 'storage.rules']);
const deps: RulesPreflightDeps = {
  fileExists: (p) => presentFiles.has(p),
};

/** Deep clone so a test's deletion cannot leak into the next test. */
function configWithout(mutate: (c: Record<string, any>) => void): Record<string, any> {
  const copy = JSON.parse(JSON.stringify(GOOD_CONFIG));
  mutate(copy);
  return copy;
}

describe('checkRulesConfig', () => {
  it('passes the current, correct config', () => {
    const result = checkRulesConfig(GOOD_CONFIG, deps);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  // The bug this module exists for: firebase-tools guards
  // `if (firestoreConfig.rules)`, so an absent key deploys nothing and exits 0.
  it('refuses when the firestore rules key is absent', () => {
    const result = checkRulesConfig(
      configWithout((c) => delete c.firestore.rules),
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('firestore.rules');
    expect(result.violations[0]).toContain('absent');
  });

  it('refuses when the storage rules key is absent', () => {
    const result = checkRulesConfig(
      configWithout((c) => delete c.storage.rules),
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('storage.rules');
  });

  // One level up from the key: with no firestore block, the whole deploy step
  // returns early and still exits 0.
  it('refuses when the entire firestore block is absent', () => {
    const result = checkRulesConfig(
      configWithout((c) => delete c.firestore),
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toContain('firestore');
  });

  it('refuses when the entire storage block is absent', () => {
    const result = checkRulesConfig(
      configWithout((c) => delete c.storage),
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.violations.join('\n')).toContain('storage');
  });

  // This case already fails closed inside firebase-tools; the preflight catches
  // it earlier and says which key is at fault.
  it('refuses when a rules key names a file that does not exist', () => {
    const result = checkRulesConfig(
      configWithout((c) => (c.firestore.rules = 'firestore.rules.moved')),
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain('does not exist');
  });

  it('refuses an empty or non-string rules path', () => {
    expect(checkRulesConfig(configWithout((c) => (c.storage.rules = '')), deps).ok).toBe(false);
    expect(checkRulesConfig(configWithout((c) => (c.storage.rules = 42)), deps).ok).toBe(false);
  });

  it('reports every problem at once rather than stopping at the first', () => {
    const result = checkRulesConfig(
      configWithout((c) => {
        delete c.firestore.rules;
        delete c.storage.rules;
      }),
      deps,
    );
    expect(result.violations).toHaveLength(2);
  });

  // firebase.json permits an array of firestore configs, one per database.
  it('checks every firestore config when the block is an array', () => {
    const result = checkRulesConfig(
      {
        firestore: [{rules: 'firestore.rules'}, {indexes: 'firestore.indexes.json'}],
        storage: {rules: 'storage.rules'},
      },
      deps,
    );
    expect(result.ok).toBe(false);
    expect(result.violations[0]).toContain('firestore[1].rules');
  });

  it('rejects a config that is not an object', () => {
    expect(checkRulesConfig(null, deps).ok).toBe(false);
    expect(checkRulesConfig('firebase.json', deps).ok).toBe(false);
  });
});

// The tests above run against a fixture, deliberately: the live firebase.json
// is correct, so a test pointed at it would pass without exercising anything.
// This one asserts the live config really is correct at this commit, which is
// the claim the brief made — and would go red the day someone breaks it.
describe('the repository firebase.json', () => {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const raw = () => JSON.parse(fs.readFileSync(path.join(repoRoot, 'firebase.json'), 'utf8'));

  it('is configured to actually deploy both rulesets', () => {
    const result = checkRulesConfig(raw(), {
      fileExists: (p) => fs.existsSync(path.join(repoRoot, p)),
    });
    expect(result.violations).toEqual([]);
  });

  // The guard is only reached because firebase.json asks for it. Without this
  // the check keeps passing at `npm test` while no longer running at deploy —
  // the check would still be green and the deploy would be unguarded.
  it('wires the guard in as a firestore predeploy hook', () => {
    const predeploy: string[] = raw().firestore.predeploy ?? [];
    expect(predeploy.join(' ')).toContain('preflight:rules');
  });

  // `firebase deploy --only functions` uploads functions/ as it sits; it does
  // not compile. lib/ is gitignored, so without this hook the deploy ships
  // whatever happens to be on the deploying machine's disk — or nothing at all
  // on a fresh clone. Deleting the key breaks the deploy and no other test
  // notices, which is why this assertion exists.
  it('wires the build in as a functions predeploy hook', () => {
    const blocks = raw().functions;
    const list: Array<Record<string, any>> = Array.isArray(blocks) ? blocks : [blocks];
    expect(list.length).toBeGreaterThan(0);
    for (const block of list) {
      expect((block.predeploy ?? []).join(' ')).toContain('run build');
    }
  });
});

describe('UNCOVERED_CASE', () => {
  // The brief's requirement: the hole is stated by the guard itself, not only
  // in a PR description. If someone deletes the sentence, this goes red.
  it('names the missing-block case the predeploy hook cannot catch', () => {
    expect(UNCOVERED_CASE).toContain('firestore');
    expect(UNCOVERED_CASE).toContain('cannot guard its own absence');
  });
});
