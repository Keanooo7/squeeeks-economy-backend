/**
 * The TypeScript half of the reconciliation parity contract.
 *
 * ---------------------------------------------------------------------------
 * 🔴 THE RULE IS IMPLEMENTED TWICE AND NOTHING CHECKED THAT THE TWO AGREE
 * ---------------------------------------------------------------------------
 *
 *   · `functions/src/trashDay.ts` — `reconcileTrashDay`, the NORMATIVE
 *     specification. Its own docstring says so, and it has NO CALLERS in
 *     production code by design: Dart cannot invoke it.
 *   · `lib/features/trash_day/domain/trash_day_reconciliation.dart` — a hand
 *     transcription, and the one that actually runs on a device.
 *
 * Each has its own unit tests. Each suite is green. **NEITHER CAN SEE THE
 * OTHER.** Edit one and not the other and both suites stay green while the
 * client disagrees with its own specification about whether a housemate has
 * already taken the bins out.
 *
 * ⚠️ AND AN EMULATOR TEST CANNOT CLOSE THIS. Driving reconciliation against a
 * real Firestore would exercise the TYPESCRIPT — the copy with no callers —
 * while the defect would live in the DART copy that ships. A gate can only
 * catch a divergence if it reads BOTH sides, and no single process runs both
 * languages. So: one table, two readers.
 *
 * This file is reader one. Reader two is `test/features/trash_day/
 * trash_day_reconciliation_test.dart` and is W1's lane — ⚠️ NOT YET WIRED, so
 * until it is, this fixture pins the TypeScript only and the parity claim is
 * half-built. Said plainly here rather than implied, because a half-built gate
 * that reads as finished is worse than none.
 *
 * 🔑 THE EXPECTATIONS ARE AUTHORED, NOT GENERATED. A table produced by running
 * `reconcileTrashDay` would agree with it by construction and could never fail
 * — the producer's own instrument grading the producer. Every row was derived
 * from the stated contract and then checked against the code, in that order.
 */
import {readFileSync} from 'fs';
import {resolve} from 'path';

import {reconcileTrashDay, TrashDayCompletion} from '../trashDay';

interface Case {
  name: string;
  server: string | null;
  local: string | null;
  cleared: boolean;
  clearedBy: 'server' | 'local' | null;
  mustPush: boolean;
  mustCacheLocally: boolean;
  why: string;
}

const FIXTURE = resolve(__dirname, 'fixtures', 'reconciliation-cases.json');
const table = JSON.parse(readFileSync(FIXTURE, 'utf8')) as {
  binDateKey: string;
  otherDateKey: string;
  cases: Case[];
};

/** A server document holding [binDateKey], shaped as the writer stores it. */
function completionFor(binDateKey: string): TrashDayCompletion {
  return {binDateKey, completedByUid: 'uid-housemate', completedAtMs: 1_700_000_000_000};
}

describe('reconcileTrashDay agrees with the shared truth table', () => {
  // 🔴 THE GUARD THAT STOPS EVERY OTHER ASSERTION PASSING VACUOUSLY. `it.each`
  // over an empty array is a green suite that ran nothing, and a fixture that
  // failed to parse, moved, or lost its `cases` key would produce exactly that.
  // The space is 3 x 3 and the count is asserted, not merely non-zero, so a row
  // deleted to make a failure go away is itself a failure.
  it('reads an EXHAUSTIVE table — 9 rows, one per input combination', () => {
    expect(table.cases).toHaveLength(9);
    const combos = new Set(table.cases.map((c) => `${c.server ?? 'null'}|${c.local ?? 'null'}`));
    expect(combos.size).toBe(9);
    for (const c of table.cases) {
      for (const v of [c.server, c.local]) {
        expect(v === null || v === table.binDateKey || v === table.otherDateKey).toBe(true);
      }
      // Each row states WHY. An unexplained row is one nobody can check.
      expect(c.why.length).toBeGreaterThan(30);
    }
  });

  it.each(table.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const result = reconcileTrashDay({
      binDateKey: table.binDateKey,
      serverCompletion: c.server === null ? null : completionFor(c.server),
      localAckBinDateKey: c.local,
    });

    expect(result.cleared).toBe(c.cleared);
    expect(result.clearedBy).toBe(c.clearedBy);
    expect(result.mustPush).toBe(c.mustPush);
    expect(result.mustCacheLocally).toBe(c.mustCacheLocally);

    // TypeScript-only field, with no Dart counterpart: the server document is
    // returned exactly when the SERVER is the one that cleared it. Asserted
    // here rather than in the shared table because a Dart reader has nothing to
    // compare it against, and a field in the table that only one reader checks
    // would rot without either suite noticing.
    if (c.clearedBy === 'server') {
      expect(result.completion?.binDateKey).toBe(table.binDateKey);
    } else {
      expect(result.completion).toBeNull();
    }
  });

  it('🔴 no input makes a local clear turn INTO an un-clear', () => {
    // The property the union exists to guarantee, asserted over the whole table
    // rather than trusted to the rows: whenever the device says this date is
    // cleared, the verdict is cleared — no matter what the server holds or
    // fails to hold. A "server wins" precedence would break exactly this and
    // could still satisfy several individual rows above.
    for (const c of table.cases) {
      if (c.local === table.binDateKey) {
        expect(c.cleared).toBe(true);
        const result = reconcileTrashDay({
          binDateKey: table.binDateKey,
          serverCompletion: c.server === null ? null : completionFor(c.server),
          localAckBinDateKey: c.local,
        });
        expect(result.cleared).toBe(true);
      }
    }
  });

  it('🔑 an unreachable server and an empty one are the SAME input', () => {
    // `serverCompletion: null` deliberately means both "no document" and "the
    // read failed". If they were ever split, offline would become a distinct
    // code path that nobody tests — so this pins that there is only one.
    const offline = reconcileTrashDay({
      binDateKey: table.binDateKey,
      serverCompletion: null,
      localAckBinDateKey: table.binDateKey,
    });
    const empty = reconcileTrashDay({
      binDateKey: table.binDateKey,
      serverCompletion: null,
      localAckBinDateKey: table.binDateKey,
    });
    expect(offline).toEqual(empty);
    expect(offline.mustPush).toBe(true);
  });
});
