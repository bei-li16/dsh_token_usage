![Usage ledger panel: daily token curves, a 52-week activity heatmap, and per-model distribution](preview.svg)

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
