import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';

// WHY THIS FILE EXISTS
//
// A .ts file with no top-level `import` or `export` is not a module — it is a
// SCRIPT, and TypeScript puts its top-level declarations in the GLOBAL scope
// shared by every other script in the same program. Two such files declaring
// the same identifier collide, and ts-jest reports the collision by dropping a
// suite: `Tests: 18 passed, 18 total` — zero failures, nine short.
//
// 🔴 `tsc --noEmit` EXITS 0 EITHER WAY. The grouping that produces the
// collision exists only inside ts-jest, so the typechecker is not a gate
// against this class and never was. Nor is ESLint: as of this commit
// `functions/` has NO eslint config, NO `lint` script and no CI step that
// would run one, so a lint rule here would be a rule nobody runs.
//
// scripts/check-test-floor.cjs catches the SYMPTOM (a suite that failed to run
// while reporting no failing test). This catches the CAUSE, before the suite
// is even written. Adding `export {};` to a test file that needs no imports is
// the whole fix; that line is load-bearing, not clutter.

const TESTS_DIR = __dirname;

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

// TypeScript's own module/script decision. `ts.isExternalModule` reads the
// `externalModuleIndicator` TS sets when it finds a top-level import/export
// (or `export {}`) — the exact property that decides whether declarations go
// global. So this asks the compiler the question rather than approximating it
// with a regex over source text. (The property itself is internal and absent
// from the public .d.ts; this predicate is its supported form.)
function isModule(filePath: string, source: string): boolean {
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ES2022,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  return ts.isExternalModule(sourceFile);
}

describe('every .ts file under __tests__ is a module', () => {
  const files = collectTsFiles(TESTS_DIR);

  // ⚠️ CONTROL, NOT CEREMONY. The assertion below is a for-each over `files`;
  // if the walk ever returned nothing it would pass vacuously and read as
  // "no scripts found" when it means "no files found". 40 is well under the
  // 64 present when this was written and well over any plausible collapse.
  test('the walk found the test files it is supposed to police', () => {
    expect(files.length).toBeGreaterThan(40);
    expect(files).toContain(path.join(TESTS_DIR, 'testFilesAreModules.test.ts'));
  });

  // ⚠️ CONTROL over the DETECTOR. `isModule` returning true unconditionally
  // would make the real assertion pass on a repo full of scripts. This pins
  // both answers, including the `export {};` marker the fix actually adds.
  test('isModule tells a script from a module', () => {
    const scriptSource = "const checker = require('../x.cjs');\ntest('t', () => {});\n";
    const exportMarkerSource = `export {};\n${scriptSource}`;
    const importSource = `import * as fs from 'fs';\n${scriptSource}`;

    expect(isModule('script.test.ts', scriptSource)).toBe(false);
    expect(isModule('marker.test.ts', exportMarkerSource)).toBe(true);
    expect(isModule('import.test.ts', importSource)).toBe(true);
  });

  test.each(files.map((f) => [path.relative(TESTS_DIR, f), f]))(
    '%s',
    (_rel, full) => {
      const source = fs.readFileSync(full, 'utf8');
      expect(isModule(full, source)).toBe(true);
    },
  );
});
