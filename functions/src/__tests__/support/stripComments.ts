/**
 * W2-142 · TypeScript access to the ONE comment stripper.
 *
 * KEY: THE IMPLEMENTATION IS DELIBERATELY NOT HERE. It lives in
 * `functions/scripts/stripComments.cjs`, which carries the full account of why
 * a regex cannot do this job. `check-deployed.cjs` runs against production
 * before jest exists and cannot import from `src/`, so CommonJS is the only
 * module format all three consumers can share.
 *
 * WARNING: RE-IMPLEMENTING IT HERE WOULD RECREATE THE EXACT BUG THIS FIXED. The old
 * comment in `deployedFunctions.test.ts` called its duplicate regex "A
 * DELIBERATE SECOND COPY … keeping the two in step is what the count pin is
 * for" — and they went out of step anyway, because a count pin can only notice
 * divergence on inputs that happen to expose it. One implementation, no pin
 * needed.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const {stripComments} = require('../../../scripts/stripComments.cjs') as {
  stripComments: (src: string) => string;
};

export {stripComments};
