![Usage ledger panel: daily token curves, a 52-week activity heatmap, and per-model distribution](preview.svg)

## Session view (per-session Usage tab)

Each session page gains a Usage tab (`conversation.view` slot) with that
session's own breakdown — aligned with token-total's session view, minus its
request-records section (a deliberate design decision):

- **Six metric cards**: requests (with failure count and failure rate), total /
  input / output tokens, cache hit rate (cache-read over the three prompt
  buckets), and decode speed with the average first-token wait.
- **Sub-session table**: descendant sessions (name, requests, tokens, cache
  hit rate, kind). Sourced from the permanent KV session index, so it stays
  available even when the SQLite detail backend is degraded.
- **Per-model table**: requests plus input / output / cache-read /
  cache-write token buckets and cache hit rate, aggregated by an unbounded
  SQLite `GROUP BY` over the session and its descendants (not truncated by
  the detail cap). Needs the detail backend, so it is empty while degraded;
  tool chips likewise.
- **Live header**: a 2-second serialized poll (at most one in-flight request,
  with an immediate catch-up fetch when the tab becomes visible again) with
  the last successful read's clock stamp, plus a manual refresh that never
  stalls behind an in-flight poll. A failed poll keeps the last good data.

## Backfill semantics (disable / reinstall / upgrade)

- **Deferred live sessions**: a session that is open (window still alive) when
  backfill reaches it and has no recorded live boundary is DEFERRED — left out
  of the cursor and fully replayed by a later pass once it is closed. Its
  status is surfaced in `/status` → `backfill.deferredSessions`.
- **Off-window gap catch-up**: events persisted while the plugin was disabled,
  uninstalled or mid-upgrade are detected on the next activation (the live
  pass's first observation of the session vs the session row's `lastSeq`
  high-water) and replayed from the log. Facts are idempotent upserts, so a
  stale high-water can only re-replay, never double-count tokens.
- **Startup reconciliation sweep**: after the main historical scan, every
  cursor-marked session that is no longer live is reconciled against its
  session row's `lastSeq` high-water. No row at all (legacy zero-mark
  victims) → the whole log is replayed from seq 0; row below the log's max
  seq (a session that kept persisting events while the plugin was fully
  off, then closed) → the open tail above the high-water is replayed;
  otherwise the session is already accounted for and costs one read-only
  log pass. Live and deferred sessions are never touched — the live pass
  owns them. The sweep is reported in `/status` → `backfill.sweep`
  (`{checked, replayed}`); `/usage-ledger/api/reset` (wipe + full rescan)
  remains available as a manual escape hatch.
- **Inherited prefix replay**: a replay unconditionally skips the prefix
  below the host-reported `inheritedEventCount` cut. The host guarantees that
  cut is greater than zero exactly for seeded sessions — including UI-forked
  children whose header carries no parent session — while unseeded sessions
  always report 0, so for them the skip is a no-op and their whole log (the
  complete canonical history) is replayed. A seeded child's skipped prefix is
  owned by its parent's own pass (an observed seeded child overlapped its
  parent's log by ~6.3M tokens), so skipping it is what prevents
  cross-session double counting.
- **Degraded (KV-only) mode limitation**: when the SQLite detail backend
  fails to open, the plugin degrades to pure-KV operation and the delta base
  falls back to an in-process recent-facts map (capped at 10000 with FIFO
  eviction, and pruned together with the 30-day retention window). In that
  degraded mode, replaying a fact older than the retention window can still
  double-accumulate KV counts — the same class of defect as the SQLite-mode
  double-count fixed in 0.1.3. In normal mode the permanent delta anchors
  (request / tool / turn) survive prune and cover every replay path; for
  degraded mode, restore the SQLite backend (remount / restart) and run
  `POST /usage-ledger/api/reset` to rebuild a calibrated state.
- **Replay idempotence across the prune window (0.1.3)**: the KV rollup
  delta base is a set of permanent anchor rows (`request_anchor` /
  `tool_anchor` / `turn_anchor`) in the SQLite database, not the 30-day
  detail rows. A prune deletes detail rows; anchors survive it, and only
  `/reset` clears them (it wipes the KV side too, so the pairing holds).
  Replaying any already-counted fact therefore computes a delta of zero
  even when its detail row has been pruned; turn markers dedupe on
  `(session, seq)`. Before 0.1.3 the delta base was the prunable detail row,
  so a post-prune replay of an old fact saw `old = null` and blindly
  re-added its tokens to the permanent rollups — release acceptance
  observed six days at exactly 2×, all older than the 30-day cutoff, after a
  remount window let the startup sweep re-replay sessions whose
  high-watermarks read behind. The sweep × prune interaction is now safe in
  both directions: a caught-up session costs one read-only pass, and a
  behind or stale-marked session's full re-replay is strictly idempotent.
  `/status` reports the anchor count as `anchorRows`. Since 0.1.5 the
  `/reset` live-session boundary watermarks are sampled inside the store's
  serial-queue reset job — at job time, immediately before the wipe —
  closing the sub-second sampling-to-wipe window in which a live-observed
  event could be wiped, yet skipped by the rescan (seq ≥ boundary) and
  never re-observed by the live chain.
