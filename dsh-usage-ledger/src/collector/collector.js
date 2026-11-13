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
 * Iron rules honored here: the session log is the only source of truth (this
 * module NEVER appends anything), no polling (we wait for persisted events),
 * every listener is removable via the returned disposer, and nothing ever
 * throws into the host — observation must not break a turn.
 * Zero runtime dependencies; pure ESM.
 */

import { RequestFold } from './fold.js'

/** Batch size for markBackfilled cursor writes. */
const MARK_BATCH = 32

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
     *          lastSessionId?: string, error?: string}} routes read this for /status. */
    this.status = { running: false, total: 0, done: 0, scannedSessions: 0 }
    /** @type {Map<string, RequestFold>} one fold per live session */
    this.folds = new Map()
    /** Live session ids whose boundary was already marked this boot. */
    this.liveMarked = new Set()
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
        // The live boundary is already marked; dropping the fold only frees
        // memory — a resumed session gets a fresh fold on its next event.
        this.folds.delete(sessionIdOf(session))
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
      try {
        void Promise.resolve(this.store.markLiveSequence(sid, seq)).catch(() => {})
      } catch { /* store failures are observational */ }
    }
    const fold = this.liveFoldFor(sid, session, event)
    for (const output of fold.fold(event)) this.dispatch(output)
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
            await this.replaySession(persistence, sessions, header, liveFirstSeq, signal)
            completed.push(header.id)
            if (completed.length >= MARK_BATCH) await flushCompleted()
            this.status.scannedSessions++
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
      try { await this.store.prune() } catch { /* idempotent housekeeping */ }
    } catch (err) {
      // Listing/cursor orchestration failures surface in status, never escape.
      this.status.error = err instanceof Error ? err.message : String(err)
    } finally {
      this.status.running = false
    }
  }

  /**
   * Replay ONE session's persisted log through a fresh fold and flush once.
   * Throws (to the worker's per-session catch) when no readable seam exists.
   */
  async replaySession(persistence, sessions, header, liveFirstSeq, signal) {
    const boundary = liveFirstSeq[header.id]
    // Liveness recheck at replay time: a live session without a usable
    // boundary is owned by this boot's live pass — replay nothing of it.
    let isLiveNow = false
    try {
      isLiveNow = typeof sessions?.list === 'function' && sessions.list().some((s) => s?.id === header.id)
    } catch { isLiveNow = false }
    if (isLiveNow && (boundary === undefined || boundary < 0)) return
    // Seq partition: no boundary → replay from scratch; negative sentinel →
    // replay nothing (never risk a duplicate); N → replay exactly [0, N).
    const fromScratch = boundary === undefined
    const replayNothing = !fromScratch && boundary < 0
    // Read the log: alpha open()+paged read()+close() wins; rc.1 inspect()
    // is the fallback. Both yield (events, inheritedCut).
    let events = []
    let inheritedCut = 0
    if (typeof persistence.open === 'function') {
      const handle = await persistence.open(header.id, 'read', signal === undefined ? undefined : { signal })
      try {
        const cut = handle?.inheritedEventCount
        inheritedCut = typeof cut === 'number' && Number.isSafeInteger(cut) && cut >= 0 ? cut : 0
        const collected = []
        let offset = 0
        const PAGE = 500
        for (;;) {
          if (signal?.aborted) return
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
      const inspection = await persistence.inspect(header.id, signal)
      inheritedCut = typeof inspection?.inheritedEventCount === 'number' && inspection.inheritedEventCount >= 0 ? inspection.inheritedEventCount : 0
      events = Array.isArray(inspection?.events) ? inspection.events : []
    } else {
      throw new Error('no readable persistence seam (need open or inspect)')
    }
    if (replayNothing) return
    // Own events: skip the fork-inherited prefix (the parent's pass owns it).
    const own = events.filter((ev) => !(inheritedCut > 0 && typeof ev?.seq === 'number' && ev.seq < inheritedCut))
    // The session's own first event decides the workflow heuristic.
    const parentId = headerParentOf(header)
    const firstOwn = own.find((ev) => ev && typeof ev.type === 'string')
    const fold = new RequestFold({
      sessionId: header.id,
      parentId,
      kind: kindOf(parentId, firstOwn?.type),
    })
    for (const ev of own) {
      if (signal?.aborted) return
      if (!fromScratch && typeof ev.seq === 'number' && ev.seq >= boundary) continue // live-owned tail
      fold.fold(ev) // outputs are discarded: backfill flushes once per session
    }
    const { requests, tools, turns, meta } = fold.flush()
    for (const fact of requests) { try { this.store.recordRequest(fact) } catch { /* observational */ } }
    for (const fact of tools) { try { this.store.recordToolCall(fact) } catch { /* observational */ } }
    for (const marker of turns) { try { this.store.recordTurn(marker) } catch { /* observational */ } }
    if (meta) { try { this.store.recordSessionMeta(meta) } catch { /* observational */ } }
  }
}
