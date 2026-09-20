module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.ts'],
  // firestore-rules.test.ts needs a running Firestore emulator — `npm run
  // test:rules` starts one and runs it explicitly.
  //
  // familyEmulator.test.ts needs the Firestore AND Auth emulators, and it
  // imports index.ts UNMOCKED so the Admin SDK inside every callable writes to
  // that emulator. `npm run test:e2e` starts them on their own ports (see
  // firebase.e2e.json). WARNING: It is excluded here rather than left to fail
  // loudly under `npm test` because its own beforeAll refuses without the
  // emulator env — a red suite in the default run would be noise, and a suite
  // that FAILS TO RUN contributes zero tests to the count, which reads green.
  testPathIgnorePatterns: [
    '/node_modules/',
    'firestore-rules\\.test\\.ts$',
    // WARNING: GENERALISED from 'familyEmulator' to ANY *Emulator suite (W2-101).
    // taskCompletionEmulator.test.ts was added and this list still named only
    // the one file, so the new suite ran under `npm test` with no emulator and
    // failed 5 tests there — which read as 'the change broke the unit suite'
    // and cost a wrong conclusion about which gate had caught a mutation.
    // `test:e2e` matches the same way, so the two stay in step: a file named
    // *Emulator.test.ts is an emulator suite, both ways. NOTE: W2-140 moved that
    // half out of the package.json script and into `jest.e2e.config.js`, which
    // spreads this file and overrides testMatch — the pairing is unchanged, but
    // it now lives next to the e2e suite's stated testTimeout instead of inside
    // a quoted shell string.
    'Emulator\\.test\\.ts$',
  ],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.json' }],
  },
};
