// Force module scope. A .ts file with no top-level import/export is a SCRIPT,
// so its top-level `const _db` would land in the global scope and collide with
// the identically-named one in ten sibling test files (TS2451).
export {};

// functions/src/__tests__/scheduledSenderObservability.test.ts
//
// W2-139 · A run that selected nobody and a run that sent to somebody must not
// look the same in the logs.
//
// CRITICAL: THE DEFECT, STATED AS THE THING THIS FILE MEASURES. `sendDailyGiftReminder`
// and `sendStreakReminder` return early when nothing is selected (index.ts:439,
// :474) and log nothing when they do send: the only console.log on the send path
// sits AFTER `if (dead.length === 0) return []` in sendEachAndPruneDeadTokens
// (pushTokens.ts:176,194), so a clean fan-out is silent too. `grep -c 'logger.'
// functions/src/index.ts` is 0 for the whole file.
//
// KEY: WHAT IT COST, WHICH IS WHY THIS IS A GATE AND NOT A NICETY. W2-138 spent a
// whole brief answering "did the daily reminder fire?" and had to settle it from
// Cloud Scheduler status plus Brendan's own Firestore document, because the logs
// could not distinguish "ran and correctly excluded him" from "never ran".
//
// WARNING: WHAT THIS DOES NOT ASSERT, stated so it is not mistaken for more: it proves
// the process EMITS a distinguishing line. It cannot prove the line reaches Cloud
// Logging, and it cannot prove anything is deployed.

const _db: { doc: jest.Mock; collectionGroup: jest.Mock } = {
  doc: jest.fn(),
  collectionGroup: jest.fn(),
};
const _sendEach = jest.fn(async (messages: unknown[]) => ({
  responses: messages.map(() => ({ success: true })),
}));

jest.mock('firebase-admin', () => {
  const firestoreFn: any = jest.fn(() => _db);
  firestoreFn.FieldValue = { delete: () => ({ _type: 'delete' }) };
  firestoreFn.Timestamp = class {};
  return {
    initializeApp: jest.fn(),
    firestore: firestoreFn,
    messaging: jest.fn(() => ({ sendEach: _sendEach })),
  };
});

jest.mock('firebase-admin/firestore', () => {
  const admin = jest.requireMock('firebase-admin') as any;
  return { FieldValue: admin.firestore.FieldValue, Timestamp: admin.firestore.Timestamp };
});

jest.mock('firebase-functions/v2/https', () => ({
  onCall: (...args: any[]) => ({ _handler: args[args.length - 1] }),
  onRequest: (...args: any[]) => ({ _handler: args[args.length - 1] }),
  HttpsError: class HttpsError extends Error {
    code: string;
    constructor(code: string, message: string) { super(message); this.code = code; }
  },
}));

jest.mock('firebase-functions/v2/scheduler', () => ({
  onSchedule: (_schedule: string, handler: () => any) => ({ _handler: handler }),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { sendDailyGiftReminder } = require('../index') as {
  sendDailyGiftReminder: { _handler: () => Promise<void> };
};

/** Every line the process wrote, in order, across all four console channels. */
async function captureConsole(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const channels = ['log', 'info', 'warn', 'error'] as const;
  const saved = channels.map((c) => console[c]);
  for (const c of channels) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (console as any)[c] = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  }
  try { await run(); } finally {
    channels.forEach((c, i) => { (console as any)[c] = saved[i]; });
  }
  return lines;
}

/**
 * Seed `collectionGroup('shop')` with ONE user whose gift claim is `ageHours`
 * old, and a token for them. The job reminds users whose last claim is older
 * than 24h, so 1 hour selects nobody and 72 hours selects exactly one.
 *
 * ISO strings rather than Timestamps on purpose: the production code accepts
 * both (`typeof lastClaim === 'string'`), and a string keeps the fixture free of
 * an `instanceof Timestamp` mock whose identity would have to match the module
 * the code imports.
 */
function seedOneUser(ageHours: number): void {
  const claimedAt = new Date(Date.now() - ageHours * 3600 * 1000).toISOString();
  _db.collectionGroup.mockImplementation((name: string) => ({
    get: async () => ({
      docs: name === 'shop'
        ? [{
            id: 'data',
            ref: { parent: { parent: { id: 'uid-1' } } },
            data: () => ({ lastDailyGiftClaimedAt: claimedAt }),
          }]
        : [],
    }),
  }));
  _db.doc.mockImplementation((path: string) => ({
    path,
    get: async () => ({
      // The token lives on the legacy `users/{uid}` doc, which is where
      // Brendan's actually is (W2-138). `users/{uid}/private/push` is empty.
      data: () => (path === 'uid-1' || path === 'users/uid-1' ? { fcmToken: 'tok-1' } : undefined),
    }),
    update: async () => undefined,
  }));
}

describe('a scheduled sender says what it did', () => {
  beforeEach(() => {
    _db.doc.mockReset();
    _db.collectionGroup.mockReset();
    _sendEach.mockClear();
  });

  test('the capture harness sees a line when one is written', async () => {
    // Anti-vacuity, and it is not ceremony: every assertion below is about the
    // ABSENCE or CONTENT of captured lines. A harness that silently captured
    // nothing would make all of them pass or fail for the wrong reason.
    const lines = await captureConsole(async () => { console.log('probe'); });
    expect(lines).toEqual(['probe']);
  });

  test('🔴 selecting NOBODY and sending to ONE do not produce identical output', async () => {
    seedOneUser(1);   // claimed an hour ago -> inside the 24h window -> nobody
    const selectedNobody = await captureConsole(() => sendDailyGiftReminder._handler());
    const sentCount = _sendEach.mock.calls.length;

    seedOneUser(72);  // claimed three days ago -> selected
    const sentToOne = await captureConsole(() => sendDailyGiftReminder._handler());

    // The fixture must actually drive the two different paths, or the
    // comparison below is between two runs of the same branch.
    expect(`selected nobody sent: ${sentCount}, selected one sent: ${_sendEach.mock.calls.length - sentCount}`)
      .toBe('selected nobody sent: 0, selected one sent: 1');

    expect(
      `zero-recipient run: ${JSON.stringify(selectedNobody)}\n` +
      `one-recipient  run: ${JSON.stringify(sentToOne)}\n` +
      `identical: ${JSON.stringify(selectedNobody) === JSON.stringify(sentToOne)}`,
    ).not.toContain('identical: true');
  });

  test('a run that selects nobody still emits exactly one completion line', async () => {
    // The case that emits nothing today, and the case that cost W2-138 its time.
    seedOneUser(1);
    const lines = await captureConsole(() => sendDailyGiftReminder._handler());
    expect(`lines emitted when nobody was selected: ${JSON.stringify(lines)}`)
      .not.toBe('lines emitted when nobody was selected: []');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/sendDailyGiftReminder/);
  });

  test('the completion line names what was scanned, selected and sent', async () => {
    seedOneUser(72);
    const lines = await captureConsole(() => sendDailyGiftReminder._handler());
    const line = lines.find((l) => l.includes('sendDailyGiftReminder')) ?? '';
    // Keyed on the NUMBERS, not on prose: a line that says "done" would satisfy
    // the test above and answer none of W2-138's questions.
    expect(`scanned in line: ${/scanned=\d+/.test(line)}`).toBe('scanned in line: true');
    expect(`selected in line: ${/selected=\d+/.test(line)}`).toBe('selected in line: true');
    expect(`sent in line: ${/sent=\d+/.test(line)}`).toBe('sent in line: true');
  });
});
