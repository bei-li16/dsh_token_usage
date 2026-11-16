/**
 * LedgerCollector — live capture + persistence backfill (design notes).
 *
 * Live: `start(ctx)` subscribes `session/event` / `session/disposed` and feeds
 * every event through one RequestFold per session; fold outputs are upserts
 * (same fact id, newer evidence), dispatched fire-and-forget to the store.
 * The first event observed for a session marks the live/backfill boundary via
 * `store.markLiveSequence(id, seq|-1)`: [0, boundary) belongs to backfill,
 * [boundary, ∞) to the live pass — never both, never neither.
 *
 * Backfill: `backfill(persistence, sessions, signal)` enumerates persisted
 * sessions (dual list shape: rc.1 header[] / alpha snapshot[]), skips cursor-
 * known `backfilledSessions`, and replays each remainder through a FRESH fold
 * with one batch flush per session. A fork-inherited prefix (seq <
 * inheritedEventCount) is skipped — the parent's pass owns those events.
 * Concurrency is a simple worker pool (default 4); every 32 finished sessions
 * are `markBackfilled` in one batch; an abort exits cleanly mid-scan and a
 * single broken session lands in `status.error` (first message kept) without
 * stopping the batch.
 *
 * DEFERRED live sessions (fix, 2026-11-16): a session that is open at replay
 * time and has no usable boundary must NOT be marked backfilled — the live
 * pass can only see events from THIS activation onward, so marking it would
 * silently drop its whole persisted history (observed: a 69.3M-token session
 * recorded as zero). Such a session is DEFERRED: skipped now, left out of the
 * cursor, and fully replayed by a later pass once it is closed. The in-memory
 * `liveBoundaries` map closes the KV write race for sessions already
 * observed live this activation (backfill reads the cursor once up front, so
 * the async `markLiveSequence` write may not have landed yet).
 *
 * OFF-WINDOW GAP CATCH-UP (fix, 2026-11-16): while the plugin is disabled,
 * uninstalled or mid-upgrade (fiber dispose → re-apply), open sessions keep
 * persisting events nobody records. On the next activation the live pass
 * first observes such a session at seq F while its session row's lastSeq
 * high-water is H < F-1 — the persisted range (H, F) was never accounted.
 * `catchUpLiveGap` replays exactly that range (turn markers advance the
 * high-water at turn boundaries; facts are idempotent upserts, so a stale H
 * can only re-replay, never double-count tokens). A session that closes
 * WITHOUT a post-gap event is healed by `disposeCatchUp` (tail replay above
 * the high-water); one that closed while the plugin was fully off is only
 * healed by /reset — documented residual.
 *
 * Iron rules honored here: the session log is the only source of truth (this
 * module NEVER appends anything), no polling (we wait for persisted events),
 * every listener is removable via the returned disposer, and nothing ever
 * throws into the host — observation must not break a turn.
 * Zero runtime dependencies; pure ESM.
 */

import { RequestFold } from './fold.js'

/** Batch size for markBackfilled cursor writes. */
const MARK_BATCH = 32
/** Persisted high-water throttling: mark at least every N live events. */
const HIGH_SEQ_EVERY = 128
/** status.deferredSessions reporting cap (ids only, newest kept). */
const DEFERRED_LIST_CAP = 50

/** Stable session id from a live callback's session argument. */
function sessionIdOf(session) {
  const id = session?.id
  return typeof id === 'string' && id !== '' ? id : '(unknown-session)'
}

/** Parent id from a live session handle (`header.parentSession ?? parentSession`). */
function liveParentOf(session) {
  const p = session?.header?.parentSession ?? session?.parentSession
  return typeof p === 'string' && p !== '' ? p : null
}

/** Parent id from a persisted header (backfill path). */
function headerParentOf(header) {
  const p = header?.parentSession ?? header?.parentId
  return typeof p === 'string' && p !== '' ? p : null
}

/** Route seed from a live handle; request/context only logs on route CHANGES. */
function liveRouteOf(session) {
  try {
    const rc = session?.requestContext?.()
    return {
      provider: typeof rc?.provider === 'string' ? rc.provider : '',
      model: typeof rc?.model === 'string' ? rc.model : '',
    }
  } catch {
    return { provider: '', model: '' }
  }
}

/** kind = parentId ? 'subagent' : 'main', upgraded to 'workflow' when the
 *  session's OWN first event is `tool-workflow/agent-start`. */
function kindOf(parentId, firstOwnEventType) {
  if (firstOwnEventType === 'tool-workflow/agent-start') return 'workflow'
  return parentId ? 'subagent' : 'main'
}

/** Event seq with defensive typing. */
function seqOf(event) {
  return typeof event?.seq === 'number' && Number.isFinite(event.seq) ? event.seq : undefined
}

export class LedgerCollector {
  /**
   * @param {{store: import('../contract.js').LedgerStore, concurrency?: number,
   *          logger?: {warn?: (...a: any[]) => void, info?: (...a: any[]) => void}}} opts
   */
  constructor({ store, concurrency, logger } = {}) {
    this.store = store
    this.logger = logger
    const n = Number(concurrency)
    this.concurrency = Number.isFinite(n) && n >= 1 ? Math.min(16, Math.round(n)) : 4
    /** @type {{running: boolean, total: number, done: number, scannedSessions: number,
     *          lastSessionId?: string, error?: string, deferredSessions?: string[]}} routes read this for /status. */
    this.status = { running: false, total: 0, done: 0, scannedSessions: 0, deferredSessions: [] }
    /** @type {Map<string, RequestFold>} one fold per live session */
    this.folds = new Map()
    /** Live session ids whose boundary was already marked this boot. */
    this.liveMarked = new Set()
    /** First live seq per session observed THIS activation (closes the async
     *  KV boundary-write race for same-activation backfill passes). */
    this.liveBoundaries = new Map()
    /** Max live seq per session observed this activation (high-water). */
    this.liveHighSeq = new Map()
    /** Gap/tail catch-ups in flight (session ids) — never stack a replay. */
    this.catchUpInFlight = new Set()
    /** Sessions whose live pass is CONTIGUOUS with the persisted high-water —
     *  live marks may advance the row only after this first-observation check
     *  confirmed no off-window gap (else the live mark would blind the gap
     *  detector before it replayed the gap). */
    this.liveContiguous = new Set()
    /** Persistence/sessions services stashed by backfill — catch-up replays
     *  need a readable log seam without waiting for another boot. */
    this.persistence = null
    this.sessions = null
  }

  // ── live capture ──────────────────────────────────────────────────────────

  /**
   * Attach the live listeners. MUST be called inside a ctx.effect; the
   * returned disposer removes every subscription this method made. Degrades
   * to backfill-only (one warning) when the host context has no `on`.
   * @returns {() => void} disposer
   */
  start(ctx) {
    const noop = () => {}
    if (typeof ctx?.on !== 'function') {
      try {
        this.logger?.warn?.('[dsh-usage-ledger] live session-event subscription unavailable (ctx.on missing); only backfill will record usage')
      } catch { /* logger must never take us down */ }
      return noop
    }
    const offEvent = ctx.on('session/event', (session, event) => {
      try {
        this.onSessionEvent(session, event)
      } catch { /* observational: never throw into the host */ }
    })
    const offDisposed = ctx.on('session/disposed', (session) => {
      try {
        this.onSessionDisposed(session)
      } catch { /* observational */ }
    })
    return () => {
      try { offEvent?.() } catch { /* ignore */ }
      try { offDisposed?.() } catch { /* ignore */ }
      this.folds.clear()
    }
  }

  /** Handle one live session event (never throws). */
  onSessionEvent(session, event) {
    const sid = sessionIdOf(session)
    if (!event || typeof event.type !== 'string') return
    // First observation: record the live/backfill boundary for this session.
    if (!this.liveMarked.has(sid) && sid !== '(unknown-session)') {
      this.liveMarked.add(sid)
      const seq = typeof event.seq === 'number' && Number.isFinite(event.seq) ? event.seq : -1
      this.liveBoundaries.set(sid, seq)
      try {
        void Promise.resolve(this.store.markLiveSequence(sid, seq)).catch(() => {})
      } catch { /* store failures are observational */ }
      // A cursor-owned session may carry an off-window gap (plugin disabled /
      // uninstalled / upgrading while this session kept producing events):
      // replay the persisted range below this first live event.
      this.catchUpLiveGap(sid, seq, liveParentOf(session))
    }
    // High-water tracking (in-memory on every event; persisted at turn
    // boundaries + throttle) — the gap detector reads the persisted copy.
    if (sid !== '(unknown-session)') {
      const seq = seqOf(event)
      if (seq !== undefined) {
        const prev = this.liveHighSeq.get(sid)
        if (prev === undefined || seq > prev) this.liveHighSeq.set(sid, seq)
        if (seq % HIGH_SEQ_EVERY === 0) this.markHighSeq(sid, seq)
      }
    }
    const fold = this.liveFoldFor(sid, session, event)
    for (const output of fold.fold(event)) this.dispatch(output)
    // Turn boundaries persist the high-water AFTER the marker landed (the
    // marker's applySession creates the session row on first turn).
    if (sid !== '(unknown-session)' && event.type === 'turn/end') {
      const seq = seqOf(event)
      if (seq !== undefined) this.markHighSeq(sid, seq)
    }
  }

  /** Live session closed: persist the final high-water; heal an unobserved
   *  cursor-owned session's tail (closed right after a re-enable, no event). */
  onSessionDisposed(session) {
    const sid = sessionIdOf(session)
    if (sid === '(unknown-session)') {
      // The live boundary is already marked; dropping the fold only frees
      // memory — a resumed session gets a fresh fold on its next event.
      this.folds.delete(sid)
      return
    }
    const high = this.liveHighSeq.get(sid)
    if (high !== undefined) this.markHighSeq(sid, high)
    const observed = this.liveBoundaries.has(sid)
    this.folds.delete(sid)
    if (!observed) this.disposeCatchUp(sid, liveParentOf(session))
  }

  /** Lazily create the per-session live fold, seeded with route and kind. */
  liveFoldFor(sid, session, firstEvent) {
    let fold = this.folds.get(sid)
    if (fold) return fold
    const parentId = liveParentOf(session)
    fold = new RequestFold({
      sessionId: sid,
      parentId,
      kind: kindOf(parentId, firstEvent?.type),
      route: liveRouteOf(session),
    })
    this.folds.set(sid, fold)
    return fold
  }

  /** Fire-and-forget dispatch of one fold output to the store. */
  dispatch(output) {
    try {
      switch (output.type) {
        case 'request': this.store.recordRequest(output.fact); break
        case 'tool': this.store.recordToolCall(output.fact); break
        case 'turn': this.store.recordTurn(output.marker); break
        case 'meta': this.store.recordSessionMeta(output.meta); break
      }
    } catch { /* a degraded store is counted by the store itself */ }
  }

  // ── off-window gap catch-up ─────────────────────────────────────────────

  /** Best-effort persisted high-water advance (existing rows only). Live-path
   *  marks are gated on `liveContiguous` — claiming a seq the gap below it has
   *  not replayed would blind the gap detector; replay paths pass trusted. */
  markHighSeq(sid, seq, trusted = false) {
    if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return
    if (!trusted && !this.liveContiguous.has(sid)) return
    if (typeof this.store.markSessionSeq !== 'function') return
    try {
      void Promise.resolve(this.store.markSessionSeq(sid, seq)).catch(() => {})
    } catch { /* observational */ }
  }

  /**
   * Off-window gap catch-up at the live pass's first observation of a
   * cursor-owned session. The plugin was off while the session persisted
   * events, so the persisted range (row.lastSeq, firstLiveSeq) was never
   * accounted. Fire-and-forget; never stacks a second replay per session.
   */
  catchUpLiveGap(sid, firstSeq, parentId) {
    if (typeof firstSeq !== 'number' || firstSeq < 0) return
    if (typeof this.store.sessionHighSeq !== 'function' || typeof this.store.cursorState !== 'function') return
    if (this.catchUpInFlight.has(sid)) return
    this.catchUpInFlight.add(sid)
    void (async () => {
      try {
        const state = await this.store.cursorState()
        const backfilled = state?.cursor?.backfilledSessions ?? []
        if (!backfilled.includes(sid)) return // deferred/new: no live marks
        const high = await this.store.sessionHighSeq(sid)
        // No row / no high-water yet: nothing recorded before — the live pass
        // owns everything it sees; its marks are safe.
        if (high === null || high === undefined || high < 0) {
          this.liveContiguous.add(sid)
          return
        }
        if (firstSeq <= high + 1) {
          // No gap: the live pass is contiguous with the persisted history.
          this.liveContiguous.add(sid)
          // Claim events already seen live while the marks were gated.
          const seen = this.liveHighSeq.get(sid)
          if (typeof seen === 'number' && seen > high) this.markHighSeq(sid, seen, true)
          return
        }
        // Off-window gap: replay (high, firstSeq), then the session is
        // contiguous from the live pass's first observation onward.
        await this.replayRange(sid, parentId, high, firstSeq)
        this.liveContiguous.add(sid)
        const seen = this.liveHighSeq.get(sid)
        if (typeof seen === 'number' && seen > firstSeq - 1) this.markHighSeq(sid, seen, true)
      } catch { /* gap catch-up is observational */ } finally {
        this.catchUpInFlight.delete(sid)
      }
    })()
  }

  /**
   * Tail catch-up for a cursor-owned session that closed without a single
   * event this activation (its off-window tail has no live trigger left):
   * replay everything above the session row's lastSeq high-water.
   */
  disposeCatchUp(sid, parentId) {
    if (typeof this.store.sessionHighSeq !== 'function' || typeof this.store.cursorState !== 'function') return
    if (this.catchUpInFlight.has(sid)) return
    this.catchUpInFlight.add(sid)
    void (async () => {
      try {
        const state = await this.store.cursorState()
        const backfilled = state?.cursor?.backfilledSessions ?? []
        if (!backfilled.includes(sid)) return
        const high = await this.store.sessionHighSeq(sid)
        if (high === null || high === undefined || high < 0) return
        await this.replayRange(sid, parentId, high, Infinity)
      } catch { /* tail catch-up is observational */ } finally {
        this.catchUpInFlight.delete(sid)
      }
    })()
  }

  /** Replay one session's persisted events in the open range (fromSeq, toSeq). */
  async replayRange(sid, parentId, fromSeq, toSeq) {
    const persistence = this.persistence
    if (!persistence || typeof persistence.open !== 'function') return
    const { events, inheritedCut } = await this.readLog(persistence, sid)
    const own = events.filter((ev) => !(inheritedCut > 0 && seqOf(ev) !== undefined && seqOf(ev) < inheritedCut))
    const firstOwn = own.find((ev) => ev && typeof ev.type === 'string')
    const fold = new RequestFold({
      sessionId: sid,
      parentId,
      kind: kindOf(parentId, firstOwn?.type),
    })
    let maxSeq = fromSeq
    for (const ev of own) {
      const seq = seqOf(ev)
      if (seq === undefined || seq <= fromSeq || seq >= toSeq) continue
      fold.fold(ev) // outputs are discarded: one flush below
      if (seq > maxSeq) maxSeq = seq
    }
    const { requests, tools, turns, meta } = fold.flush({ dropRunning: true })
    for (const fact of requests) { try { this.store.recordRequest(fact) } catch { /* observational */ } }
    for (const fact of tools) { try { this.store.recordToolCall(fact) } catch { /* observational */ } }
    for (const marker of turns) { try { this.store.recordTurn(marker) } catch { /* observational */ } }
    if (meta) { try { this.store.recordSessionMeta(meta) } catch { /* observational */ } }
    // Advance the high-water to the gap end (or the replayed max for a tail):
    // everything below it is now accounted. Replay claims are always trusted.
    this.markHighSeq(sid, toSeq === Infinity ? maxSeq : toSeq - 1, true)
  }

  // ── backfill ──────────────────────────────────────────────────────────────

  /**
   * Replay persisted sessions the cursor has not seen. Resolves early on
   * abort; never rejects into the caller (errors ride `status.error`).
   * @param {*} persistence  sessionPersistence service
   * @param {*} sessions     sessions service (live liveness recheck)
   * @param {AbortSignal} [signal]
   */
  async backfill(persistence, sessions, signal) {
    if (this.status.running) return
    if (signal?.aborted) return
    // Stash for gap/tail catch-ups (the live pass has no persistence handle).
    this.persistence = persistence ?? null
    this.sessions = sessions ?? null
    this.status.running = true
    this.status.error = undefined
    try {
      const cursor = await this.store.cursorState()
      const backfilled = new Set(cursor?.cursor?.backfilledSessions ?? [])
      const liveFirstSeq = cursor?.cursor?.liveFirstSeq ?? {}
      // Dual-shape listing: alpha (open present) takes {signal} and returns
      // snapshots; rc.1 takes a bare signal and returns headers.
      const useAlpha = typeof persistence?.open === 'function'
      const rawList = useAlpha
        ? await persistence.list(signal === undefined ? undefined : { signal })
        : await persistence.list(signal)
      const headers = (Array.isArray(rawList) ? rawList : [])
        .map((item) => {
          const inner = item?.header
          if (inner !== null && typeof inner === 'object' && typeof inner.id === 'string') return inner
          return item
        })
        .filter((h) => typeof h?.id === 'string' && h.id !== '')
      const targets = headers.filter((h) => !backfilled.has(h.id))
      this.status.total = targets.length
      this.status.done = 0
      const deferred = []
      let next = 0
      const completed = []
      const flushCompleted = async () => {
        if (completed.length === 0) return
        const batch = completed.splice(0, completed.length)
        try { await this.store.markBackfilled(batch) } catch { /* cursor write is observational */ }
      }
      const worker = async () => {
        for (;;) {
          if (signal?.aborted) return
          const i = next++
          if (i >= targets.length) return
          const header = targets[i]
          this.status.lastSessionId = header.id
          try {
            const result = await this.replaySession(persistence, sessions, header, liveFirstSeq, signal)
            if (result === 'deferred') {
              // Do NOT mark backfilled: a later pass (next boot / toggle)
              // replays it fully once the session is closed.
              deferred.push(header.id)
            } else {
              completed.push(header.id)
              if (completed.length >= MARK_BATCH) await flushCompleted()
              this.status.scannedSessions++
            }
          } catch (err) {
            // One broken session must not abort the batch; keep the FIRST error.
            if (this.status.error === undefined) {
              this.status.error = `session ${header.id}: ${err instanceof Error ? err.message : String(err)}`
            }
          } finally {
            this.status.done++
          }
        }
      }
      const lanes = Math.min(this.concurrency, Math.max(1, targets.length))
      await Promise.all(Array.from({ length: lanes }, () => worker()))
      await flushCompleted()
      // Report deferrals (capped id list) — /status surfaces them.
      this.status.deferredSessions = deferred.slice(-DEFERRED_LIST_CAP)
      try { await this.store.prune() } catch { /* idempotent housekeeping */ }
    } catch (err) {
      // Listing/cursor orchestration failures surface in status, never escape.
      this.status.error = err instanceof Error ? err.message : String(err)
    } finally {
      this.status.running = false
    }
  }

  /**
   * Read one session's persisted log (paged), both alpha and rc.1 seams.
   * @returns {Promise<{events: any[], inheritedCut: number}>}
   */
  async readLog(persistence, sessionId, signal) {
    let events = []
    let inheritedCut = 0
    if (typeof persistence.open === 'function') {
      const handle = await persistence.open(sessionId, 'read', signal === undefined ? undefined : { signal })
      try {
        const cut = handle?.inheritedEventCount
        inheritedCut = typeof cut === 'number' && Number.isSafeInteger(cut) && cut >= 0 ? cut : 0
        const collected = []
        let offset = 0
        const PAGE = 500
        for (;;) {
          if (signal?.aborted) return { events: [], inheritedCut: 0 }
          const slice = await handle.read(offset, PAGE, signal === undefined ? undefined : { signal })
          const page = slice && Array.isArray(slice.events) ? slice.events : []
          if (page.length === 0) break
          for (const ev of page) collected.push(ev)
          offset += page.length
        }
        events = collected
      } finally {
        try { await handle.close() } catch { /* close is best-effort */ }
      }
    } else if (typeof persistence.inspect === 'function') {
      const inspection = await persistence.inspect(sessionId, signal)
      inheritedCut = typeof inspection?.inheritedEventCount === 'number' && inspection.inheritedEventCount >= 0 ? inspection.inheritedEventCount : 0
      events = Array.isArray(inspection?.events) ? inspection.events : []
    } else {
      throw new Error('no readable persistence seam (need open or inspect)')
    }
    return { events, inheritedCut }
  }

  /**
   * Replay ONE session's persisted log through a fresh fold and flush once.
   * Returns 'deferred' for a live session without a usable boundary (left
   * out of the cursor for a later pass); 'done' otherwise. Throws (to the
   * worker's per-session catch) when no readable seam exists.
   */
  async replaySession(persistence, sessions, header, liveFirstSeq, signal) {
    let boundary = liveFirstSeq?.[header.id]
    // Same-activation live observations close the async KV boundary race:
    // the in-memory first-seq is exactly the complement of the live pass.
    const liveBoundary = this.liveBoundaries.get(header.id)
    if (typeof liveBoundary === 'number' && (boundary === undefined || liveBoundary < boundary)) {
      boundary = liveBoundary
    }
    // Liveness recheck at replay time: a live session without a usable
    // boundary is DEFERRED — the live pass owns only events from THIS
    // activation onward, so its persisted history must stay replayable.
    let isLiveNow = false
    try {
      isLiveNow = typeof sessions?.list === 'function' && sessions.list().some((s) => s?.id === header.id)
    } catch { isLiveNow = false }
    if (isLiveNow && (boundary === undefined || boundary < 0)) return 'deferred'
    // Seq partition: no boundary → replay from scratch; negative sentinel →
    // replay nothing (never risk a duplicate); N → replay exactly [0, N).
    const fromScratch = boundary === undefined
    const replayNothing = !fromScratch && boundary < 0
    // Read the log: alpha open()+paged read()+close() wins; rc.1 inspect()
    // is the fallback. Both yield (events, inheritedCut).
    const { events, inheritedCut } = await this.readLog(persistence, header.id, signal)
    if (replayNothing) return 'done'
    // Own events: skip the fork-inherited prefix (the parent's pass owns it).
    const own = events.filter((ev) => !(inheritedCut > 0 && seqOf(ev) !== undefined && seqOf(ev) < inheritedCut))
    // The session's own first event decides the workflow heuristic.
    const parentId = headerParentOf(header)
    const firstOwn = own.find((ev) => ev && typeof ev.type === 'string')
    const fold = new RequestFold({
      sessionId: header.id,
      parentId,
      kind: kindOf(parentId, firstOwn?.type),
    })
    let maxSeq = -1
    for (const ev of own) {
      if (signal?.aborted) return 'done'
      const seq = seqOf(ev)
      if (seq !== undefined && seq > maxSeq) maxSeq = seq
      if (!fromScratch && seq !== undefined && seq >= boundary) continue // live-owned tail
      fold.fold(ev) // outputs are discarded: backfill flushes once per session
    }
    const { requests, tools, turns, meta } = fold.flush()
    for (const fact of requests) { try { this.store.recordRequest(fact) } catch { /* observational */ } }
    for (const fact of tools) { try { this.store.recordToolCall(fact) } catch { /* observational */ } }
    for (const marker of turns) { try { this.store.recordTurn(marker) } catch { /* observational */ } }
    if (meta) { try { this.store.recordSessionMeta(meta) } catch { /* observational */ } }
    // The replayed span is accounted: advance the high-water (only rows that
    // exist — a zero-usage session has none and needs none). Replay claims
    // are trusted: the range below them was just replayed.
    this.markHighSeq(header.id, fromScratch ? maxSeq : Math.max(boundary - 1, -1), true)
    // A live session observed THIS activation is contiguous once its prefix
    // replay lands (the reset rescan path: its live marks were gated while the
    // cursor was mid-rebuild) — ungate them and claim what the live pass saw.
    if (isLiveNow && this.liveBoundaries.has(header.id)) {
      this.liveContiguous.add(header.id)
      const seen = this.liveHighSeq.get(header.id)
      if (typeof seen === 'number') this.markHighSeq(header.id, seen, true)
    }
    return 'done'
  }
}
