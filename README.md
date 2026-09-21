# Economy backend

The server-authoritative currency and grant path for a shipped iOS game, plus the test suite
and Firestore rules that hold it closed.

The interesting half is not the feature work. It is that **every value-moving call is a
transaction over server-derived state**, that two real exploits were found by attacking it,
and that the obvious fix for one of them was disproven before it shipped.

**1,695 tests across 75 suites in about 7 seconds: 1,694 pass on a fresh clone and one is
skipped on purpose** (below). 17,028 lines of TypeScript under test by 35,343 lines of test code,
plus a 1,069-line Firestore ruleset.

```
npm --prefix functions install
npm --prefix functions test
# Test Suites: 75 passed, 75 total
# Tests:       1 skipped, 1694 passed, 1695 total
```

The skipped test is `dailyRotation.test.ts`'s check that no roof art exists, which is why the roof
prize is benched. It walks `assets/`, and the art tree is not part of this extract, so on a clone the
premise cannot be read. The test skips rather than passing, because a gate that cannot find a
directory has not shown the art is absent. In the source repository it runs against 1,018 asset
files and passes. The assertions that roof is benched and in no pool run everywhere.

## The core: `purchaseChest`

`functions/src/index.ts:936-1210`. A player spends soft currency on a loot chest.

**It accepts exactly two fields from the client** (`:939-942`):

```ts
const { chestId, purchaseId } = request.data as { chestId: string; purchaseId?: string };
```

No price, no amount, no quantity, no rarity, no item, no date. Confirmed across the whole
history — `git log -S"data.price"`, `-S"data.cost"`, `-S"data.quantity"` over the backend all
return zero commits. Everything else is re-derived server-side: the shop document is re-read
**inside** the transaction (`:1006`), the rarity is rolled by server RNG (`:983`), the price
comes off the shop doc (`:1102`), and the authoritative duplicate check re-reads the player's
own inventory document inside the transaction (`:1070-1072`).

**It refuses rather than guesses** (`:1102-1108`):

```ts
const rawChestPrice = txChest.price;
if (typeof rawChestPrice !== 'number' || !Number.isFinite(rawChestPrice) || rawChestPrice < 0) {
  throw new HttpsError('failed-precondition',
    'Chest has no valid price; refusing to charge a guessed amount');
}
```

**The debit is an atomic increment, not a read-modify-write** (`:1154-1158`). The balance is
separately *read* at `:1065` to gate affordability, which places the profile document under the
transaction's optimistic lock so a concurrent purchase forces a retry. Both halves are pinned
by tests: `'a balance that funds ONE purchase funds exactly one'`
(`purchaseChest.test.ts:535`) and `'a balance that funds BOTH is debited twice, not once'`
(`:557`).

## Two exploits, and why the obvious fix for one was wrong

**Caller-chosen day keys.** Two callables derived their once-per-day idempotency key from a
client-supplied timestamp, behind only a format check:

```ts
const dayKey = clientNowIso.slice(0, 10);   // /^\d{4}-\d{2}-\d{2}$/ was the only guard
```

The guard kept one row and granted on any key different from the last — so **alternating two
well-formed dates minted currency without bound.**

- `claimMinigamePrize`, fixed 2026-09-04. The handler now reads `request.data` **not at all**;
  the key is derived server-side by `minigameDayKey()` in `functions/src/minigame.ts`. The test
  pins the absence: `expect(body).not.toContain('request.data')`.
- `recordTaskCompletion`, fixed 2026-09-13, and worse — the same key reset **three** ledgers:
  currency, XP (uncapped and silent), and a 2× daily bonus. Reproduced against a real Firestore
  before the fix: currency 10→15, XP 40→60, bonus paid 3× instead of 1×.

🔑 **The obvious fix was disproven before shipping.** Deriving the key from server UTC would
have been correct for the exploit and broken for players: anyone in UTC−12…UTC+14 would read
zero completions on their own calendar day. The shipped repair is three mechanisms instead —
`boundedDayKey()` refusing a key more than one day from server time
(`functions/src/taskRewards.ts:353-380`), moving the ledger to `users/{uid}/days/{dayKey}` so
the day *is* the document id, and a `maxDayKey` high-water ratchet (`:521-527`). Fabricable
supply went from infinite to three.

## A weakness named in the source, with a migration order

`functions/src/replayKey.ts:55-72`:

> 🔴 **THE KEY IS OPTIONAL, AND THAT IS A DECISION WITH AN EXPIRY, NOT A DESIGN.**
> A client that omits it gets a transaction and NO replay protection. So "purchaseChest has a
> replay ledger" is weaker than it reads … It is optional because making it required is a
> BREAKING CHANGE — a callable that starts rejecting `{ chestId }` breaks every
> already-installed build … **this is not W2's call to make unilaterally.**

The shape that ends it cleanly is recorded in the same comment: client starts sending a key →
wait for adoption → *then* make it required. Required-first inverts the order and breaks people.

## The second boundary: `firestore.rules`

1,069 lines, and the economy fields are closed at the rules layer as well as the callable layer.
`firestore.rules:349-356` names the Cloud-Function-owned fields; `:699-722` splits create and
update deliberately, because a single `allow write` must call `resource.data.diff()`, which
errors — and therefore denies — on a create. `pendingChests`, `chestPurchases`, `economy`,
`days` and `shop` are all `allow write: if false`, each with its reasoning in the file.

The rules suite is 3,390 lines driving 241 assertions against the emulator
(`npm --prefix functions run test:rules`). It needs Java and the Firebase emulator, so it is
**not** part of the 1,695 above.

## What is honest about the test suite

- The concurrency claims are asserted against a **hand-rolled in-memory Firestore mock** that
  models optimistic locking (`purchaseChest.test.ts:36-60`), not against real Firestore.
  `openPendingChest` is the mirror image and no better off — two emulator suites and **no**
  behavioural unit suite at all. Neither callable is tested both ways; each is missing the half
  the other has.
- Two assertions in `chestPricing.test.ts` are **source-text** assertions
  (`expect(INDEX_CODE).toMatch(/typeof rawChestPrice !== 'number'/)`), not behavioural ones.
  They pin that a guard exists, not that it works.
- `functions/src/index.ts` is **5,744 lines carrying 46 Firebase triggers.** It is the clearest
  structural weakness here and the highest-value refactor available. It is left intact because
  this is an extract, not a fork.

## Scope of this extract

The backend, its tests, and the rules. A handful of counterpart files from the app
(`lib/core/config/app_links.dart`, `lib/features/**/collection_seed.dart`,
`ios/Configuration.storekit`) are included because several suites are **parity tests** that
assert the backend and the client have not drifted — those tests are part of the point, so
their counterparts have to be here. The support email was replaced with `support@example.com`
on both sides; the parity gate caught the inconsistent first attempt, which is the gate working.

Emulator suites (`*Emulator.test.ts`) are excluded from `npm test` by
`functions/jest.config.js` and need `npm run test:e2e`.

## Provenance

Extracted from a private application repository. Development was agent-assisted: most commits
in the source repository carry `Co-Authored-By` trailers naming an AI coding agent. The
security decisions above — refusing a client-supplied price, rejecting a server-UTC day key on
timezone grounds, keeping the replay key optional until clients adopt it — were human calls;
the implementations were largely agent-written under review.
