# SQLite Migration — Follow-up Plan

Companion to [`sqlite-migration.md`](./sqlite-migration.md). That doc holds the
architecture and the per-phase design; this one is the **actionable backlog**
of what remains after the work on branch `claude/issue-7892-root-cause-KY1ED`,
ordered so each item is independently shippable and reviewable.

## Where we are now

- ✅ `OpLogDbAdapter` / `OpLogTx` port + declarative `OP_LOG_DB_SCHEMA`.
- ✅ `IndexedDbOpLogAdapter` (faithful `idb` backend) — the live backend.
- ✅ `OperationLogStoreService` + `ArchiveStoreService` fully routed through the
  port (no direct `this.db`), behind a DI factory token
  (`OP_LOG_DB_ADAPTER_FACTORY`), IndexedDB-backed on every platform today.
- ✅ `SqliteOpLogAdapter` fully implemented against a minimal `SqliteDb` port,
  unit-tested against an in-memory SQLite stand-in. **Not wired to any
  platform; no native plugin dependency.**

Nothing below changes runtime behavior for existing users until step B3 flips a
platform to the SQLite backend.

---

## Track A — Ship the #7892 safeguards now (independent of SQLite)

These directly reduce the data-loss blast radius and do **not** depend on the
SQLite work. Highest user value per unit effort; do these first.

### A1. Make `navigator.storage.persist()` observable on native

`startup.service._requestPersistence()` suppresses the not-granted branch on
native and logs nothing when `persist()` resolves `false`. On Android WebView
the grant is often not honored, so today a report like #7892 carries no signal.

- **Do:** `Log.log({ persisted, granted })` on every branch (incl. native), and
  surface the result in the exported logs / "About" diagnostics.
- **Size:** ~1 file, a few lines. **Risk:** none (logging only).
- **Payoff:** the next #7892-style report is conclusive instead of a mystery.

### A2. Periodic local auto-backup outside the WebView store (native)

A second copy of the op-log/state in app-private storage that OS WebView
eviction cannot touch.

- **Do:** on native, periodically (and on a debounced "data changed") write a
  JSON snapshot via `@capacitor/filesystem` to `Directory.Data`; keep the last
  N. Restore offered on a wholly-fresh launch when a backup exists. Hook into
  the existing `_initBackups()` / `loadStateCache()` flow that already has the
  native restore-prompt scaffolding.
- **Size:** medium, isolated feature. **Risk:** low (additive; never deletes the
  live store).
- **Payoff:** survives the exact overnight-eviction scenario in #7892 even
  before SQLite lands.

> A1 + A2 are the recommended near-term fix for #7892. SQLite (Track B) is the
> durable architectural fix but is weeks of on-device work behind these.

---

## Track B — Finish the SQLite backend (native)

### B1. Add `@capacitor-community/sqlite` + a `SqliteDb` wrapper

- **Do:** add the plugin (+ iOS/Android native config), and a ~20-line adapter
  from its `SQLiteDBConnection` to the `SqliteDb` port
  (`run`/`query`). Open one DB named `SUP_OPS` in `Directory.Data`.
- **Gotcha:** the plugin's **web** build is WASM-SQLite persisted into
  IndexedDB — i.e. it reintroduces the eviction risk. Bind SQLite **only** when
  `IS_NATIVE_PLATFORM`; web/PWA/Electron stay on IndexedDB.
- **Size:** small. **Risk:** native build/CI surface.

### B2. Validate `SqliteOpLogAdapter` against a real engine

The current 23 specs use an in-memory stand-in that validates the _translation
layer_, not SQLite itself.

- **Do:** run the adapter once against a real engine. Two options:
  1. **On-device** integration check (most faithful), or
  2. wire **sql.js with a served `.wasm`** into a dedicated Karma run (the
     universal sql.js build statically imports `node:` modules webpack can't
     bundle, so this needs an asset/proxy entry, not the default builder).
- **Do also:** parameterize the existing op-log integration harness to run a
  second pass against `SqliteOpLogAdapter` (the plan's "run the suite against
  both adapters" gate) — catches autoincrement/unique/range/atomicity gaps the
  stand-in can't.
- **Size:** medium. **Risk:** medium — this is where real-SQLite surprises
  surface (collation/ordering of TEXT keys, NULL handling in compound ranges).

### B3. Flip the DI token on native

- **Do:** override `OP_LOG_DB_ADAPTER_FACTORY` to return `SqliteOpLogAdapter`
  when `IS_NATIVE_PLATFORM`, behind a feature flag defaulting **off**.
- **Size:** tiny. **Risk:** gated by the flag.

---

## Track C — Data migration (native, one-time)

### C1. IDB → SQLite copy on first launch after enabling B3

- **Do:** when the SQLite DB is empty/absent **and** a legacy `SUP_OPS`
  IndexedDB exists, copy OPS / STATE*CACHE / VECTOR_CLOCK / CLIENT_ID /
  ARCHIVE*\* across in one SQLite transaction (reuse the IndexedDB adapter's read
  side + the SQLite adapter's write side — both already exist).
- **Verify before commit:** op count, last `seq`, and vector clock match.
- **Keep the IDB copy** untouched for ≥1 release as a fallback; add cleanup
  later. Mirror the proven legacy `pf` → `SUP_OPS` migration pattern.
- **Size:** medium. **Risk:** high (data movement) — mitigated by verify +
  retain-source.

### C2. Staged rollout

Beta/dogfood on real Android devices → staged enable → remove the IDB fallback
and the `adoptConnection` bridge once SQLite is the sole native backend.

---

## Track D — Cleanup (after SQLite is the native default)

- **D1.** Remove the transitional `adoptConnection` bridge from the port and the
  two services once no backend relies on a borrowed connection.
- **D2.** Consider deriving the IndexedDB upgrade from `OP_LOG_DB_SCHEMA` so
  `runDbUpgrade` only carries _deltas_ (the schema spec already guards against
  drift; this removes the remaining hand-maintained duplication).
- **D3.** Out-of-scope for #7892, optional: migrate the other small IDB
  databases (`SUPThemes`, `sup-sync`, `sup-plugin-oauth`) only if fully
  evacuating WebView storage is desired.

---

## Suggested order

1. **A1** (trivial, unblocks diagnosis) → **A2** (the real near-term #7892 fix).
2. **B1 → B2 → B3** (gets SQLite runnable + validated behind a flag).
3. **C1 → C2** (migrate real users' data, staged).
4. **D** (tidy up once SQLite is the native default).

Tracks A and B/C/D are independent — A can ship while B is still in progress.
