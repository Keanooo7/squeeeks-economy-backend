import * as fs from 'fs';
import * as path from 'path';

/**
 * The floor file's own shape, checked by the suite it gates.
 *
 * `check-test-floor.cjs` enforces the counts, but it only runs when someone
 * runs it. These assertions run on every `npm test`, so the file cannot rot
 * into a shape the checker will later refuse — an entry pointing at a script
 * that no longer exists, or a count of 0, which is the value that defeats a
 * `?? 0` fallback and that every run beats.
 */
const FUNCTIONS_DIR = path.resolve(__dirname, '..', '..');
const floor = JSON.parse(fs.readFileSync(path.join(FUNCTIONS_DIR, 'test-floor.json'), 'utf8'));
const pkg = JSON.parse(fs.readFileSync(path.join(FUNCTIONS_DIR, 'package.json'), 'utf8'));

const SUITES = ['unit', 'rules', 'e2e'] as const;

describe('test-floor.json', () => {
  it.each(SUITES)('%s has a positive measured count', (key) => {
    expect(typeof floor[key].count).toBe('number');
    // Not `toBeGreaterThanOrEqual(0)`: zero is precisely the broken value.
    expect(floor[key].count).toBeGreaterThan(0);
  });

  it.each(SUITES)('%s records where the number came from', (key) => {
    expect(floor[key].commit).toMatch(/^[0-9a-f]{7,40}$/);
    expect(floor[key].measured_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(String(floor[key].note).length).toBeGreaterThan(40);
  });

  // A floor whose command no longer exists gates nothing while looking like it
  // does — the same defect as a ledger entry naming a deleted file.
  it.each(SUITES)('%s names a command that still exists', (key) => {
    const command: string = floor[key].command;
    const scriptName = command.replace(/^npm (run )?/, '').trim();
    expect(Object.keys(pkg.scripts)).toContain(scriptName);
  });

  it('is wired to a script that runs the checker', () => {
    expect(pkg.scripts.floor).toContain('check-test-floor');
  });

  // The three suites are deliberately separate numbers. If someone collapses
  // them, a drop in one can hide behind a rise in another.
  it('keeps the suites as independent entries', () => {
    const commands = SUITES.map((key) => floor[key].command);
    for (const key of SUITES) expect(floor[key].count).not.toBe(undefined);
    expect(new Set(commands).size).toBe(SUITES.length);
  });

  // 🔴 EACH SUITE ANSWERS A QUESTION THE OTHERS CANNOT, and the entries must
  // keep saying which. `unit` reads source against a hand-written fake
  // Firestore; `rules` judges the ruleset over documents the test itself
  // seeded; `e2e` runs the real callables against a real emulator and then
  // reads their output back through the rules. The family backend passed the
  // first two for weeks while nothing had proven the feature worked.
  it('the checker knows every suite the floor file declares', () => {
    const checker = fs.readFileSync(
      path.join(FUNCTIONS_DIR, 'scripts', 'check-test-floor.cjs'),
      'utf8',
    );
    for (const key of SUITES) {
      // A floor entry the checker has no SUITES row for is unenforceable: the
      // checker would exit 2 on `floor:<key>` and `floor all` would skip it
      // entirely, which is a number that looks gated and is not.
      expect(checker).toMatch(new RegExp(`^\\s{2}${key}: \\{script:`, 'm'));
    }
  });
});
