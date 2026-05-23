# Document Mode — delta sync architecture

**Status:** proposal
**Date:** 2026-05-22
**Branch:** `feat/how-fat-is-data-model-for-sync-for-new-fbd044`
**Supersedes:** the "Future work — per-context sync entities" section of
[`2026-05-22-document-mode-sync-data-model.md`](./2026-05-22-document-mode-sync-data-model.md)
(that doc's Phase 1 — bare-atom chips — remains the immediate, separately-tracked fix)

## Problem

The document-mode plugin (`packages/plugin-dev/document-mode/`) is a TipTap
editor that persists **all** its data as a single opaque JSON blob via
`PluginAPI.persistDataSynced(string)`. The blob is:

```jsonc
{ "version": 1,
  "docs": { "<ctxId>": <full ProseMirror JSON>, ... },  // one doc per project/tag/TODAY
  "enabledCtxIds": ["..."] }
```

Host-side this becomes **one** `PluginUserData` entry with `entityId = pluginId`.
Every save is one op (`upsertPluginUserData`, `entityType: PLUGIN_USER_DATA`,
`opType: Update`) whose payload embeds the **entire blob string**. So the data
sent per change is the whole multi-context corpus (~26–48 KB encrypted for a
typical 5-context user, measured) — **regardless of how tiny the edit was**.
Saves are throttled ~1 op / 2 s while typing (`SAVE_THROTTLE_MS` in
`src/ui/editor.ts`; the host additionally coalesces via
`MIN_PLUGIN_PERSIST_INTERVAL_MS`).

This is **not a delta**. Typing one character re-transmits, re-encrypts, and
re-stores every project and tag document. Phase 1 of the sibling doc shrinks the
blob ~46% by stripping redundant chip content, but the unit transmitted is still
"the whole corpus". The deeper question — *can a change send only the change?* —
is what this doc addresses.

## Goals

1. Lay out the design space for transmitting **less than the whole corpus** per
   edit, with honest effort/payoff for each option.
2. Identify which options are compatible with the op-log's partial ordering and
   conflict model (a hard constraint — see below).
3. Recommend a staged path: what to do now, mid-term, and long-term.

## Non-goals

- Re-deriving the Phase 1 (bare-atom chip) work — already planned and tracked in
  the sibling doc; it is orthogonal and complementary to everything here.
- Committing to an implementation in this branch. This is an architecture
  proposal for discussion.
- Removing the in-tree `src/app/features/document-mode/` feature.

## Why naive deltas do not work here

The op-log is **partially ordered and conflict-resolved**. Vector clocks reorder
ops; `SYNC_IMPORT` / `BACKUP_IMPORT` deliberately drop concurrent ops
(`CONCURRENT` / `LESS_THAN` by vector clock — by design, per the sync model).
A position-dependent patch — "insert these 3 chars at offset 4012" — is only
valid against the exact base state it was computed from. Once another op is
interleaved ahead of it, the offset is wrong and the patch corrupts the
document.

This is precisely why the op-log replays **semantic action payloads**, never
text diffs: an action like "set task title to X" is replayable against any
state. So a *valid* delta for this system must be **either**:

- a **semantic operation** that is replayable against any document state, **or**
- a **commutative CRDT update** that composes correctly under any order.

A line/character/JSON-position patch is neither. This rules out the "obvious"
delta — diff the old and new blob — outright.

## The granularity spectrum

| Granularity | Delta unit | ~Per change sent | Effort |
| --- | --- | --- | --- |
| Whole blob (today) | entire corpus | ~26–48 KB | — |
| Per-context entity | one document | ~6–9 KB | moderate (host API change) |
| Per-block entity | one paragraph | ~hundreds of B | high (stable block ids) |
| ProseMirror steps / Yjs CRDT | the actual edit | tens of B | major (new sync channel) |

Each row below the first is a real option. They are not mutually exclusive —
per-context is a stepping stone, not a dead end.

### Option A — per-context sync entities (document-level "delta")

Give each `(plugin, context)` pair its own sync entity, so editing project X's
document transmits only project X's document, not the whole corpus.

**What it needs:**

1. **Keyed plugin-persistence API.** `persistDataSynced` is currently
   single-arg (`persistDataSynced(dataStr: string)` in
   `packages/plugin-api/src/types.ts`, line 555; `loadSyncedData()` line 557 —
   verified). Add an optional `key`: `persistDataSynced(data, key?)` /
   `loadSyncedData(key?)`, threaded through the whole chain — `plugin-api/types.ts`,
   `plugin-bridge.service.ts`, the iframe wrapper (`plugin-api.ts`), and the
   iframe postMessage util (`plugin-iframe.util.ts`, which currently drops a
   second argument).
2. **Composite entity id.** `PluginUserData.id` becomes `pluginId:key`, so
   concurrent edits to *different* contexts stop colliding on one entity.
3. **Virtual-entity LWW support — required, not optional.** `PLUGIN_USER_DATA`
   is registered as a **`virtual`** entity in
   `src/app/op-log/core/entity-registry.ts` (lines 318–322, verified), and
   `ConflictResolutionService.getCurrentEntityState`
   (`src/app/op-log/sync/conflict-resolution.service.ts`, lines 805–873) has
   branches for adapter / singleton / map / array entities but **no `virtual`
   branch** — it falls through and returns `undefined`. So the LWW local-win
   path (`_createLocalWinUpdateOp`) cannot read the entity and produces no
   replacement op. **LWW conflict resolution cannot resolve plugin-data
   conflicts at all today.** Per-context entity ids alone do not fix this; a
   same-context concurrent edit still mis-resolves. Conflict resolution must
   learn to read a virtual entity from `selectPluginUserDataFeatureState`.

**Payoff:** ~5x smaller payload per typical edit (~26–48 KB → ~6–9 KB). This is
a document-level "delta" — only the *edited document* is transmitted, never
sub-document. Concurrent edits to different contexts stop conflicting entirely.

**Limits:** a single document is still sent whole on every keystroke-batch.
Concurrent edits to the *same* document still resolve whole-doc (LWW, once the
virtual branch exists). This is the realistic, moderate-effort win.

### Option B — per-block sync entities

Make each top-level block (paragraph, heading, list) its own keyed entity, so a
one-paragraph edit transmits one paragraph.

**What it needs:** stable per-node ids — a TipTap unique-id extension that
assigns and preserves an id across edits. Split, merge, and reorder of blocks
each touch multiple entities (a paragraph split = one update + one create; a
merge = one update + one delete), and the ordering of blocks becomes its own
synced structure.

**Assessment:** this is **essentially reinventing a block-level CRDT** — stable
identity, structural ops, ordering — but without the convergence guarantees a
real CRDT gives for free. The split/merge/reorder bookkeeping is exactly the
hard part of CRDTs, done by hand. **Not recommended.** If sub-document
granularity is wanted, go straight to Option C, which solves identity and
ordering correctly and gives finer granularity for the same conceptual cost.

### Option C — Yjs CRDT (true edit-level deltas)

Integrate `y-prosemirror`. Yjs models the document as a CRDT and emits a small
**binary update** per edit. These updates are **commutative** — they compose
correctly under *any* order — which is exactly the property the op-log's partial
ordering requires and that text/JSON patches lack.

**How it maps onto the op-log:**

- Each Yjs update becomes an **append-only** op (`opType: Create`) — never an
  Update-that-replaces. The op-log already handles append-only creates well.
- **Conflict resolution becomes a no-op** for these ops: a CRDT converges by
  construction, so there is no conflict to resolve. The partial-order /
  `SYNC_IMPORT`-drops-concurrent problem disappears — Yjs updates are designed
  to be applied in any order, including after gaps.
- **Op-log compaction** snapshots the document via `Y.encodeStateAsUpdate(doc)`
  — a single binary blob that supersedes all prior update ops, the CRDT
  equivalent of a state snapshot.

**Cost:**

- A new dependency (`yjs` + `y-prosemirror`).
- `persistDataSynced` is **replace-only**; Yjs needs an **append** primitive —
  a new plugin API such as `appendSyncedDelta(bytes)`. This is a genuinely new
  persistence channel, not a parameter addition.
- An op-log path that treats these ops as commutative create-only ops exempt
  from conflict detection.

**Bonus:** Yjs also enables **real-time concurrent editing of the same
document** — currently an explicit Non-goal of the sibling doc. It is the *only*
option here that does.

**Assessment:** the correct long-term answer and the only path to true
edit-level deltas. But a CRDT sync channel is a significant architecture
initiative — disproportionate for an opt-in POC plugin *today*. It becomes the
right investment if/when real-time co-editing becomes a product goal, or the
plugin ships bundled-by-default and document sync volume matters at scale.

## Recommendation

A staged path, each stage independently shippable:

1. **Now — Phase 1 (bare-atom chips).** Already planned and being implemented
   separately (sibling doc). ~46% smaller blob, no schema break, no host change.
2. **Mid-term — Option A (per-context entities).** The realistic document-level
   "delta": moderate effort, ~5x payload reduction, and it *also* fixes the
   currently-broken plugin-data conflict resolution (virtual-entity LWW). Pick
   this up when document mode ships more widely or cross-context conflicts are
   observed.
3. **Long-term / conditional — Option C (Yjs).** The only path to true
   edit-level deltas; subsumes the conflict problem entirely and unlocks
   real-time co-editing. Justified once co-editing is a goal or sync volume at
   scale demands it. **Skip Option B** — it is Option C's hard parts without its
   guarantees.

## Risks

| Risk | Mitigation |
| --- | --- |
| Option A's per-key rate-limit / size-cap weakens the per-plugin flood guard (`MIN_PLUGIN_PERSIST_INTERVAL_MS`, `MAX_PLUGIN_DATA_SIZE` become per-key) | Keep an additional per-*plugin* aggregate cap; see sibling doc's Future-work item 4. |
| Option A uninstall cleanup — `removePluginUserData(pluginId)` deletes only the exact id; `pluginId:*` entries leak | Make deletion prefix-aware (sibling doc Future-work item 5). |
| Option A migration — splitting the legacy single blob into per-key entities | One-time, idempotent, guarded on a meta key's existence (sibling doc Future-work item 7). |
| Option C dependency size / bundle weight | `yjs` + `y-prosemirror` are compact and tree-shakeable; the plugin is opt-in so it does not affect the core bundle for non-users. |
| Option C — exempting CRDT ops from conflict detection could mask a real bug if the wrong ops are routed there | Gate strictly on `entityType` + a dedicated `opType`/actionType; never a general "skip conflict detection" flag. |
| Option C op-log growth before compaction (one op per edit) | Compaction snapshots `Y.encodeStateAsUpdate`; tune `COMPACTION_THRESHOLD` for the higher op rate. |

## Open questions

1. Does Option A need to land before Option C, or can Option C replace the
   blob entirely in one step? (Likely A first — it is lower-risk and the keyed
   API it adds is reusable; but C does not strictly depend on A.)
2. Should the keyed plugin-persistence API (Option A item 1) be designed up
   front to also accommodate Option C's `appendSyncedDelta`, so plugins get one
   coherent persistence surface rather than two bolt-ons?
3. Is real-time co-editing a desired product direction at all? The answer
   decides whether Option C is "long-term" or "never".
