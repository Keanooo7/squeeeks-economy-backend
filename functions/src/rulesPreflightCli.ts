#!/usr/bin/env node
/**
 * CLI wrapper for {@link checkRulesConfig}. Exits non-zero when a rules deploy
 * would upload nothing, so it can gate a deploy:
 *
 *   npm --prefix functions run preflight:rules && \
 *     firebase deploy --only functions,firestore:rules
 *
 * Takes an optional path to a firebase.json; defaults to the repo root's.
 */
import * as fs from 'fs';
import * as path from 'path';

import {checkRulesConfig, UNCOVERED_CASE} from './rulesPreflight';

function main(argv: string[]): number {
  // Compiled to functions/lib/, so the repo root is two levels up.
  const defaultConfig = path.resolve(__dirname, '..', '..', 'firebase.json');
  const configPath = argv[2] ? path.resolve(argv[2]) : defaultConfig;
  const repoRoot = path.dirname(configPath);

  if (!fs.existsSync(configPath)) {
    console.error(`rules preflight: no firebase.json at ${configPath}`);
    return 1;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error(`rules preflight: ${configPath} is not valid JSON — ${(e as Error).message}`);
    return 1;
  }

  const result = checkRulesConfig(raw, {
    fileExists: (p) => fs.existsSync(path.join(repoRoot, p)),
  });

  // Printed on pass as well as on refusal: a guard that states its coverage
  // only when it fires lets a green run imply coverage it does not have.
  if (result.ok) {
    console.log(`rules preflight: ok — ${configPath} would deploy both rulesets.`);
    console.log(`  ${UNCOVERED_CASE}`);
    return 0;
  }

  console.error(`rules preflight: REFUSED — ${configPath} would deploy silently incomplete rules.`);
  for (const violation of result.violations) {
    console.error(`  - ${violation}`);
  }
  console.error(
    '\nA firebase rules deploy exits 0 when it has nothing to upload. Fix the ' +
      'config above before deploying; do not bypass this check.',
  );
  console.error(`\n  ${UNCOVERED_CASE}`);
  return 1;
}

process.exitCode = main(process.argv);
