// functions/src/__tests__/taskRewardsBonus.test.ts
//
// W2-15. The daily 2x task doubles SPONGES and not XP.
//
// 🔴 THIS FILE EXISTS BECAUSE NOTHING ASSERTED EITHER WAY. Today's behaviour is
// unmultiplied XP; the history says that was never decided (see the comment at
// the `const xp =` line in taskRewards.ts). An undecided asymmetry with no test
// is indistinguishable from a deliberate one — which is precisely how the brief
// that produced this file came to exist.
//
// So the point of these assertions is NOT that flat XP is correct. It is that
// the value cannot move in EITHER direction without a gate objecting and a human
// reading the reasoning. If Brendan decides XP should be doubled, this file
// fails, someone reads the comment, and the change is made deliberately.
//
// ⚠️ Nothing here stubs Math.random — bonusTaskIdFor is a seeded pure function
// of the date, so there is no randomness to stub, and stubbing it under Jest
// kills the runner before any test executes.

import {TASK_SPONGE_REWARD} from '../taskRewards';
import {
  BONUS_TASK_MULTIPLIER,
  bonusTaskIdFor,
  TASK_LIBRARY_IDS,
} from '../dailyBonusTask';
import {XP_TASK} from '../xp';
import {codeOf} from './helpers/sourceText';

/**
 * The reward arithmetic of grantTaskRewards, extracted exactly as the source
 * computes it. Kept in step by `the pinned arithmetic matches the source` below,
 * which reads taskRewards.ts as text — so this cannot drift into testing a
 * private copy of the rules, which is the failure mode a re-implemented fixture
 * always has.
 *
 * ⚠️ SINCE W2-66 THIS MODELS THE BELOW-CAP CASE ONLY. The source pays sponges on
 * `newlyPaid` (capped) and XP on `newlyXp` (uncapped); the two coincide until a
 * player passes the cap, and every case here is below it. That is deliberate —
 * this file pins the BONUS asymmetry, and the bonus can only fire while the day
 * still has paid capacity, so the uncapped numerator never enters its question.
 * The uncapped behaviour is covered in xp.test.ts against the real callable.
 */
function reward(newlyPaid: number, payBonus: boolean) {
  const bonusSponges = payBonus ? TASK_SPONGE_REWARD * (BONUS_TASK_MULTIPLIER - 1) : 0;
  return {
    sponges: newlyPaid * TASK_SPONGE_REWARD + bonusSponges,
    xp: newlyPaid * XP_TASK,
  };
}

describe('the daily 2x task doubles sponges', () => {
  test('a bonus completion pays one extra task of sponges, not two', () => {
    // The multiplier is expressed as (MULTIPLIER - 1) extra, added to the
    // ordinary payment the task already earned. 2x total, not 3x.
    const plain = reward(1, false);
    const bonus = reward(1, true);
    expect(plain.sponges).toBe(TASK_SPONGE_REWARD);
    expect(bonus.sponges).toBe(TASK_SPONGE_REWARD * BONUS_TASK_MULTIPLIER);
  });

  test('the bonus is a flat extra, independent of how many tasks were paid', () => {
    // It enriches one slot; it does not scale with the day's volume.
    for (const n of [1, 3, 8]) {
      const delta = reward(n, true).sponges - reward(n, false).sponges;
      expect(delta).toBe(TASK_SPONGE_REWARD * (BONUS_TASK_MULTIPLIER - 1));
    }
  });
});

describe('🔴 and does NOT double XP — pinned in both directions', () => {
  test('XP is identical whether or not the bonus fired', () => {
    for (const n of [1, 3, 8]) {
      expect(reward(n, true).xp).toBe(reward(n, false).xp);
    }
  });

  test('XP is exactly newlyPaid x XP_TASK, with no multiplier anywhere in it', () => {
    expect(reward(1, true).xp).toBe(XP_TASK);
    expect(reward(8, true).xp).toBe(8 * XP_TASK);
  });

  test('⚠️ CONTROL: if XP were multiplied, these are the values that would appear', () => {
    // Written out so a future reader can see the alternative concretely rather
    // than imagining it, and so the diff of "someone doubled XP" is obvious.
    const wouldBe = XP_TASK * BONUS_TASK_MULTIPLIER;
    expect(reward(1, true).xp).not.toBe(wouldBe);
    expect(wouldBe).toBe(20); // today: XP_TASK 10 x MULTIPLIER 2
  });

  test('the source computes XP without reference to the bonus at all', () => {
    // Against the code, because the arithmetic above is a reconstruction. If
    // someone multiplies XP, the reconstruction would be updated to match and
    // the tests above would pass again — this is what stops that.
    const fs = require('fs');
    const path = require('path');
    // CODE — the arithmetic must be in the code.
    const code: string = codeOf(
      fs.readFileSync(path.join(__dirname, '..', 'taskRewards.ts'), 'utf8'),
    );
    const xpLine = code.split('\n').find((l) => l.includes('const xp ='));
    expect(xpLine).toBeDefined();
    // ⚠️ `newlyXp`, not `newlyPaid`, since W2-66 uncapped XP. The NUMERATOR
    // renamed; the decision this test pins did not. What it guards is the two
    // lines below — that no multiplier reaches XP — and that is untouched.
    expect(xpLine).toContain('newlyXp * XP_TASK');
    expect(xpLine).not.toContain('BONUS');
    expect(xpLine).not.toContain('bonus');
  });

  test('the pinned arithmetic matches the source for sponges too', () => {
    const fs = require('fs');
    const path = require('path');
    // CODE.
    const code: string = codeOf(
      fs.readFileSync(path.join(__dirname, '..', 'taskRewards.ts'), 'utf8'),
    );
    expect(code).toContain('TASK_SPONGE_REWARD * (BONUS_TASK_MULTIPLIER - 1)');
    expect(code).toContain('newlyPaid * TASK_SPONGE_REWARD + bonusSponges');
  });

  test('the undecided status is recorded at the line, not only in a return', () => {
    // A finding that lives only in a PR body is lost on the next /clear.
    const fs = require('fs');
    const path = require('path');
    const code: string = fs.readFileSync(path.join(__dirname, '..', 'taskRewards.ts'), 'utf8');
    expect(code).toMatch(/UNDECIDED, NOT\s*\n?\s*\/\/ DELIBERATE|UNDECIDED, NOT DELIBERATE/);
    expect(code).toContain('#128');
  });
});

describe('the bonus task is a pure function of the date', () => {
  // 📌 This matters beyond this brief: it is what makes it possible to tell,
  // from the completion log alone, whether the bonus TASK was completed on a
  // past day. The brief assumed a recompute could not know that. It can.
  test('the same day always yields the same bonus task', () => {
    for (const d of ['2026-08-12', '2026-01-01', '2027-03-09']) {
      expect(bonusTaskIdFor(d)).toBe(bonusTaskIdFor(d));
    }
  });

  test('different days generally yield different tasks', () => {
    const seen = new Set(
      Array.from({length: 60}, (_, i) => bonusTaskIdFor(`2026-08-${String((i % 28) + 1).padStart(2, '0')}`)),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  test('the bonus id is always a real task id, never a plausible invented one', () => {
    // #128 shipped a first draft with ids written from memory ('dishes',
    // 'make_bed'); the real ones are 'lib_kitchen_0' style. A bonus id matching
    // no task gilds nothing and pays nothing, silently, on both sides.
    for (let i = 1; i <= 28; i++) {
      const id = bonusTaskIdFor(`2026-08-${String(i).padStart(2, '0')}`);
      expect(TASK_LIBRARY_IDS).toContain(id);
    }
  });

  test('⚠️ but it is stable only against the CURRENT library order', () => {
    // bonusTaskIdFor indexes into TASK_LIBRARY_IDS, so reordering or extending
    // that list changes the bonus for every past day. Reconstructing a historical
    // bonus from the log is therefore deterministic against today's list and NOT
    // against the list as it was — the same shape as the room census denominator
    // that W2-14 had to record because it could not be recovered afterwards.
    // Asserted so the coupling is visible rather than folklore.
    // CODE — the indexing expression itself, not a description of it.
    const code: string = codeOf(
      require('fs').readFileSync(
        require('path').join(__dirname, '..', 'dailyBonusTask.ts'),
        'utf8',
      ),
    );
    expect(code).toContain('TASK_LIBRARY_IDS[hashDayKey(dayKey) % TASK_LIBRARY_IDS.length]');
  });
});
