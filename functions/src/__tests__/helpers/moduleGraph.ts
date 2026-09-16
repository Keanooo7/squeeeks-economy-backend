/**
 * Transitive reachability of `src/*.ts` from the deployed entry point.
 *
 * `functions/package.json` sets `main: lib/index.js`, so Firebase discovers
 * exactly the functions that `index.ts` reaches. A module that compiles, has
 * tests, and is imported by nothing is never deployed — and nothing says so.
 * `notifications.ts` is the confirmed case: it exports functions with the same
 * names as the live crons, and `functions:list` showed exactly one of each on
 * 2026-08-05.
 *
 * Imports are extracted with `ts.preProcessFile`, the compiler's own scanner,
 * rather than a regex over the source. A regex has to be told about line
 * comments, block comments, strings, `export ... from`, `import type`, and
 * dynamic `import()` — and gets a module wrong by silently missing an edge,
 * which reads exactly like a genuine orphan.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as ts from 'typescript';

export const SRC_DIR = path.resolve(__dirname, '..', '..');
export const ENTRY = 'index';

/** Module names (basename, no extension) of every `src/*.ts`. */
export function allModules(): string[] {
  return fs
    .readdirSync(SRC_DIR, {withFileTypes: true})
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => e.name.replace(/\.ts$/, ''))
    .sort();
}

/** Local sibling modules that `moduleName` imports, by any syntax. */
export function directImports(moduleName: string): string[] {
  const file = path.join(SRC_DIR, `${moduleName}.ts`);
  const text = fs.readFileSync(file, 'utf8');
  // readImportedFiles + detectJavaScriptImports, so `export ... from`,
  // `import type`, and `require()` all count as edges.
  const info = ts.preProcessFile(text, true, true);
  return info.importedFiles
    .map((f) => f.fileName)
    .filter((spec) => spec.startsWith('.'))
    .map((spec) => path.basename(spec).replace(/\.(ts|js)$/, ''))
    .filter((name) => fs.existsSync(path.join(SRC_DIR, `${name}.ts`)));
}

/**
 * Every module reachable from `index.ts`, following imports transitively.
 * Includes the entry point itself.
 */
export function reachableFromEntry(): Set<string> {
  const seen = new Set<string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const next of directImports(current)) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  return seen;
}
