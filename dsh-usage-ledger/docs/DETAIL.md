![Usage ledger panel: daily token curves, a 52-week activity heatmap, and per-model distribution](preview.svg)

## Session view (per-session Usage tab)

Each session page gains a Usage tab (`conversation.view` slot) with that
session's own breakdown — aligned with token-total's session view, minus its
request-records section (a deliberate design decision). A scope line under
the live header notes that the numbers cover this session and all its
subagents, accumulated from the historical logs:

- **Six metric cards**: requests (with failure count and failure rate), total /
  input / output tokens, cache hit rate (cache-read over the three prompt
  buckets), and decode speed with the average first-token wait.
- **Current context card**: what this session's NEXT request would carry,
  rebuilt from the session's own log (fork-inherited prefix stripped).
  Shadowed events (compaction prune/summary) are dropped, compaction
  summaries stand in as injected content, and the tool catalogue comes from
  the newest request header. Token counts are character-class ESTIMATES over
  7 buckets (system prompt, user, skill, tool results, tool definitions,
  injected, assistant — output never occupies the window); the headline is
  the provider-exact billed prompt when the newest usage report has one,
  otherwise the replay estimate, and the context-window occupancy
  (`used / window`) drives the progress bar. Null (card hidden) when the log
  is unreadable or empty.
- **Token stats card**: what every request in the session tree actually paid
  for. Each request pays for the whole replayed message list, so a bucket's
  number is the sum of its size at EVERY request — 8 buckets (the 7 plus
  output, which never replays and lands in its own bucket). Bucket numbers
  are estimates (marked ≈ in the legend); the donut's center total and the
  cache-hit badge come straight from provider usage records and are exact.
  Null when no request ever reported usage.
- **Sub-session table**: descendant sessions (name, requests, tokens, cache
  hit rate, average first-token wait, token speed, kind). Sourced from the
  permanent KV session index, so it stays available even when the SQLite
  detail backend is degraded. The two rate columns are log-replay values
  counting completed records only: first-token averages count only completed
  records with a value, and speed = Σoutput/(ΣdecodeMs/1000) over completed
  records with a decode window; null when the child's log is unreadable or
  reports no rate.
- **Per-model table**: requests plus input / output / cache-read /
  cache-write token buckets and cache hit rate, aggregated by an unbounded
  SQLite `GROUP BY` over the session and its descendants (not truncated by
  the detail cap). Needs the detail backend, so it is empty while degraded;
  tool chips likewise. Rows show the model's display name when the llm
  metadata service resolves one, the route id otherwise.
- **Live header**: a 2-second serialized poll (at most one in-flight request,
  with an immediate catch-up fetch when the tab becomes visible again) with
  the last successful read's clock stamp, plus a manual refresh that never
  stalls behind an in-flight poll. A failed poll keeps the last good data.

The context/composition cards and the children rate columns are assembled on
demand by a log-replay calculator whose output the session endpoint merges
in: persistence is read per request through a getter, results are cached
in-process (invalidated when a session log's stat changes, 60 s TTL, at most
32 sessions), and every failure degrades to null — the detail page stays
available.

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
