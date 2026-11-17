# dsh-usage-ledger

Request-level token usage ledger for DeepSeek Harness.

- **Fact store**: every provider call lands as one row (tokens, first-token
  wait, decode speed, status) in a local SQLite database with a 30-day
  rolling prune; permanent per-day rollups (day × model / kind / tool, plus a
  session index) live in a storage domain.
- **Global panel**: a Usage ledger row in the sidebar opens lifetime summary
  cards, a 52-week heatmap, daily per-model curves, and model/tool
  distribution.
- **Session view**: each session page gains a Usage tab (`conversation.view`
  slot) with that session's own breakdown — six metric cards (requests with
  failure count and rate, total / input / output tokens, cache hit rate,
  decode speed with average first-token wait), a sub-session table of
  descendant sessions (sourced from the permanent KV session index, so it
  stays available even when the SQLite detail backend is degraded), a
  per-model table with the four token buckets, tool chips, and a live header
  with 2-second polling and a manual refresh. No per-request detail table —
  a deliberate design decision.

All data is derived from session logs; recording is observational and never
interferes with turns. Do not enable together with `dsh-token-total`: both
plugins register a Usage tab on session pages, so running both crowds the
same tab bar and duplicates the numbers.

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
  delta base is a set of *permanent anchor rows* (`request_anchor` /
  `tool_anchor` / `turn_anchor`) in the SQLite database, not the 30-day
  detail rows. A prune deletes detail rows; anchors survive it, and only
  `/reset` clears them (it wipes the KV side too, so the pairing holds).
  Consequence: replaying any already-counted fact computes a delta of zero
  even when its detail row has been pruned — before 0.1.3 the delta base was
  the prunable detail row, so a post-prune replay of an old fact saw
  `old = null` and blindly re-added its tokens to the permanent rollups
  (release acceptance observed six days at exactly 2×, only days older than
  the 30-day cutoff). Turn markers dedupe on `(session, seq)` for the same
  reason. The sweep × prune interaction is therefore safe in both
  directions: a caught-up session costs one read-only pass, and a behind or
  stale-marked session's full re-replay is strictly idempotent. Facts whose
  detail was pruned before 0.1.3 have no anchor; they are protected by the
  `lastSeq` high-water marks instead, and `/reset` re-derives everything.
  Since 0.1.5 the live-session boundary watermarks for `/reset` are sampled
  inside the store's serial-queue reset job — at job time, immediately
  before the wipe — closing the sub-second sampling-to-wipe window in which
  a live-observed event could be wiped, yet skipped by the rescan
  (seq ≥ boundary) and never re-observed by the live chain.

## Configuration

Edit the `usage-ledger` row's `config` in `cordis.patch.yml`:

| Key | Default | Meaning |
| --- | --- | --- |
| `retentionDays` | 30 | SQLite detail retention |
| `heatmapWeeks` | 52 | Default heatmap span |
| `backfillConcurrency` | 4 | Historical scan parallelism |
| `factsDbPath` | `""` | Override the SQLite file location |
