/**
 * RequestFold — the single-session event→fact state machine (design notes).
 *
 * One fold instance replays ONE session's event log (live stream or backfill
 * pass) and upserts facts keyed by id, last-wins within the pass:
 *   - request facts:  `${sessionId}:${turn}:${step}:${attempt}` (attempt bumps
 *     on llm/retry-started) plus standalone `${sessionId}:compaction:${seq}`.
 *   - tool facts:     `${sessionId}:${callId}`.
 *   - turn markers:   one per turn/end (failed turns count too).
 *
 * The record state machine mirrors dsh-token-total's session-detail.ts:
 *   step/start opens → assistant/chunk enriches (stream usage, first token) →
 *   assistant/message closes (completed|interrupted) / assistant/attempt fails
 *   / turn/end interrupts whatever is still running.
 * Decode-window parity with the official sessionStats projection: the step's
 * FIRST token time is recorded once (earliest attempt survives an in-step
 * retry) and only an assembled assistant/message carrying top-level usage
 * closes the window (decodeMs = finishedAt − stepFirstToken, completed only).
 *
 * The session log is the ONLY source of truth: this module never writes to
 * the log, never throws, and ignores unknown event types (returns []).
 * Zero runtime dependencies; pure ESM.
 */

import { normalizeRequestFact, normalizeToolFact, dayKey } from '../contract.js'

// ── helpers mirrored from dsh-token-total session-detail.ts ────────────────

/** Usage bucket extraction: accepts `{usage}` wrapper or a bare usage object. */
function usageOf(x) {
  const u = x?.usage ?? x
  return {
    inputTokens: Number(u?.inputTokens) || 0,
    outputTokens: Number(u?.outputTokens) || 0,
    cacheReadTokens: Number(u?.cacheReadTokens) || 0,
    cacheWriteTokens: Number(u?.cacheWriteTokens) || 0,
    reasoningTokens: Number(u?.reasoningTokens) || 0,
    providerTotal: typeof u?.totalTokens === 'number' && Number.isFinite(u.totalTokens) ? u.totalTokens : null,
  }
}

/** Route extraction: message.source is authoritative per call, else request/context shapes. */
function routeOf(x) {
  const source = x?.message?.source ?? x?.source ?? x?.request ?? x?.context ?? x
  return {
    provider: typeof source?.provider === 'string' ? source.provider : '',
    model: typeof source?.model === 'string' ? source.model : '',
  }
}

/** Whether one stream chunk carries the model's first output token (mirrors isTokenDelta). */
function isTokenDelta(chunk) {
  switch (chunk?.type) {
    case 'text-delta': case 'reasoning-delta': return chunk.text !== ''
    case 'tool-call-delta': return chunk.argumentsDelta !== '' || chunk.name !== undefined
    default: return false
  }
}

/** First-token time of one packed delta run (mirrors runFirstTokenTime). */
function runFirstTokenTime(run) {
  if (run?.type === 'tool-call-chunks' && run.name !== undefined) return run.time0
  const fragments = run?.type === 'tool-call-chunks' ? run.args : run?.texts
  if (!Array.isArray(fragments)) return undefined
  let time = Number(run.time0)
  for (let i = 0; i < fragments.length; i++) {
    if (i > 0) time += Number(run.dt?.[i - 1]) || 0
    if (fragments[i] !== '') return time
  }
  return undefined
}

/** First-token time of one compact attempt stream (mirrors streamFirstTokenTime). */
function streamFirstTokenTime(stream) {
  for (const r of Array.isArray(stream) ? stream : []) {
    const t = r?.type === 'chunk' ? (isTokenDelta(r.chunk) ? r.time : undefined) : runFirstTokenTime(r)
    if (typeof t === 'number' && Number.isFinite(t)) return t
  }
  return undefined
}

/** First-token time carried by one live `assistant/chunk` payload (mirrors chunkFirstTokenTime). */
function chunkFirstTokenTime(data, fallback) {
  const c = data?.chunk
  if (!c) return undefined
  const timed = c.chunk && typeof c.time === 'number' ? c : null
  if (!isTokenDelta(timed ? timed.chunk : c)) return undefined
  return timed ? timed.time : typeof c.time === 'number' ? c.time : fallback
}

/** Last usage chunk inside one compact stream (final report wins). */
function streamUsage(stream) {
  let usage
  for (const r of Array.isArray(stream) ? stream : []) {
    if (r?.type === 'chunk' && r?.chunk?.type === 'usage') usage = r.chunk.usage ?? r.chunk
  }
  return usage
}

/** Provider-reported completion tokens, or null when unreported/invalid. */
function usageOutputTokens(x) {
  const value = (x?.usage ?? x)?.outputTokens
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

// ── the fold ────────────────────────────────────────────────────────────────

export class RequestFold {
  /**
   * @param {{sessionId: string, parentId?: string|null, kind?: 'main'|'subagent'|'workflow',
   *          route?: {provider?: string, model?: string}}} opts
   */
  constructor(opts) {
    this.sessionId = opts.sessionId
    this.parentId = typeof opts.parentId === 'string' && opts.parentId !== '' ? opts.parentId : null
    this.kind = opts.kind === 'workflow' || opts.kind === 'subagent' ? opts.kind : (this.parentId ? 'subagent' : 'main')
    /** Current route, seeded by the caller (live requestContext()) when known. */
    this.route = { provider: opts.route?.provider ?? '', model: opts.route?.model ?? '' }
    this.effort = ''
    /** @type {Map<string, object>} newest request record per `${turn}:${step}` */
    this.byKey = new Map()
    /** @type {Map<string, object>} every MUTABLE request record by fact id
     *  (the flush source; normalized copies are emitted, never stored) */
    this.requests = new Map()
    /** @type {Map<string, number>} next attempt number per `${turn}:${step}` */
    this.attempts = new Map()
    /** @type {Map<string, number>} step first-token time, earliest attempt wins */
    this.stepTokens = new Map()
    /** @type {Set<string>} steps whose decode window is closed */
    this.closedSteps = new Set()
    /** @type {Map<string, object>} tool facts by callId */
    this.tools = new Map()
    /** @type {object[]} turn markers, in event order */
    this.turns = []
    this.label = ''
    this.title = ''
    this.lastMetaName = ''
  }

  /** Base fields shared by every fact this fold emits. */
  base() {
    return { sessionId: this.sessionId, parentId: this.parentId, kind: this.kind }
  }

  emitRequest(rec, out) {
    this.requests.set(rec.id, rec)
    out.push({ type: 'request', fact: normalizeRequestFact(rec) })
  }

  emitTool(rec, out) {
    const fact = normalizeToolFact(rec)
    out.push({ type: 'tool', fact })
  }

  /**
   * Fold one session-log event. Never throws. Returns an array of outputs:
   * `{type:'request',fact}` / `{type:'tool',fact}` / `{type:'turn',marker}` /
   * `{type:'meta',meta}` — empty for unknown or evidence-free events.
   */
  fold(ev) {
    try {
      return this.foldUnsafe(ev)
    } catch {
      return []
    }
  }

  foldUnsafe(ev) {
    const out = []
    if (!ev || typeof ev.type !== 'string') return out
    const d = ev.data ?? {}
    const turn = Number.isFinite(d.turn) ? d.turn : 0
    const step = Number.isFinite(d.step) ? d.step : 0
    const key = `${turn}:${step}`

    switch (ev.type) {
      case 'request/context': {
        const r = routeOf(d)
        this.route = { ...this.route, ...Object.fromEntries(Object.entries(r).filter(([, v]) => v !== '')) }
        return out
      }
      case 'request/header': {
        const e = d.header?.config?.reasoningEffort
        if (typeof e === 'string' && e) {
          this.effort = e
          for (const rec of this.requests.values()) {
            if (rec.status === 'running' && rec.effort !== e) {
              rec.effort = e
              this.emitRequest(rec, out)
            }
          }
        }
        return out
      }
      case 'step/start': {
        if (!this.byKey.has(key)) this.openRecord(key, turn, step, 0, ev, d, out)
        return out
      }
      case 'llm/retry-started': {
        const previous = this.byKey.get(key)
        if (previous && previous.status === 'running') {
          previous.status = 'failed'
          previous.finishedAt = ev.time
          this.emitRequest(previous, out)
        }
        const attempt = (this.attempts.get(key) ?? -1) + 1
        this.openRecord(key, turn, step, attempt, ev, d, out)
        return out
      }
      case 'assistant/chunk':
        return this.foldStreamEvidence(ev, d, key, turn, step, out, 'chunk')
      case 'assistant/message':
        return this.foldStreamEvidence(ev, d, key, turn, step, out, 'message')
      case 'assistant/attempt':
        return this.foldStreamEvidence(ev, d, key, turn, step, out, 'attempt')
      case 'turn/end': {
        for (const rec of this.requests.values()) {
          if (rec.turn === turn && rec.status === 'running' && rec.compaction !== true) {
            rec.status = 'interrupted'
            rec.finishedAt = ev.time
            this.emitRequest(rec, out)
          }
        }
        const marker = { ...this.base(), time: ev.time, day: dayKey(ev.time) }
        this.turns.push(marker)
        out.push({ type: 'turn', marker })
        return out
      }
      case 'compaction/summary': {
        const u = usageOf(d.usage ?? d)
        const rec = {
          ...this.base(),
          id: `${this.sessionId}:compaction:${typeof ev.seq === 'number' ? ev.seq : this.requests.size}`,
          turn: 0, step: 0, attempt: 0,
          time: ev.time, finishedAt: ev.time,
          provider: typeof d.provider === 'string' ? d.provider : '',
          model: typeof d.model === 'string' ? d.model : '',
          effort: '', status: 'completed',
          ...u, firstTokenMs: null, decodeMs: null, estimated: false,
          compaction: true,
        }
        this.emitRequest(rec, out)
        return out
      }
      case 'tool/call': {
        const callId = typeof d.callId === 'string' ? d.callId : ''
        if (callId === '') return out
        const rec = {
          ...this.base(),
          id: `${this.sessionId}:${callId}`,
          turn, step, name: String(d.name ?? ''),
          time: ev.time, finishedAt: null, status: 'running', durationMs: null,
        }
        this.tools.set(callId, rec)
        this.emitTool(rec, out)
        return out
      }
      case 'tool/result': {
        const callId = typeof d.message?.toolCallId === 'string' ? d.message.toolCallId : ''
        if (callId === '') return out
        let rec = this.tools.get(callId)
        if (!rec) {
          rec = {
            ...this.base(),
            id: `${this.sessionId}:${callId}`,
            turn, step, name: typeof d.message?.name === 'string' ? d.message.name : '',
            time: ev.time, finishedAt: null, status: 'running', durationMs: null,
          }
          this.tools.set(callId, rec)
        }
        rec.finishedAt = ev.time
        rec.status = (d.message?.isError === true || d.error) ? 'failed' : 'completed'
        rec.durationMs = rec.finishedAt - rec.time
        this.emitTool(rec, out)
        return out
      }
      case 'subagent/descriptor': {
        const label = typeof d.label === 'string' ? d.label.trim() : ''
        if (!label) return out
        if (!this.label) this.label = label
        return this.metaOutput(out)
      }
      case 'session/title': {
        const title = typeof d.title === 'string' ? d.title.trim() : ''
        if (!title) return out
        this.title = title
        return this.metaOutput(out)
      }
      default:
        return out
    }
  }

  /** Open one running request record (`${sessionId}:${turn}:${step}:${attempt}`). */
  openRecord(key, turn, step, attempt, ev, d, out) {
    const r = routeOf(d)
    const rec = {
      ...this.base(),
      id: `${this.sessionId}:${turn}:${step}:${attempt}`,
      turn, step, attempt,
      time: ev.time, finishedAt: null,
      provider: r.provider || this.route.provider || '',
      model: r.model || this.route.model || '',
      effort: this.effort, status: 'running',
      inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
      cacheReadTokens: 0, cacheWriteTokens: 0, providerTotal: null,
      firstTokenMs: null, decodeMs: null, estimated: false,
    }
    this.byKey.set(key, rec)
    this.attempts.set(key, attempt)
    this.emitRequest(rec, out)
    return rec
  }

  /** Current record for a key, creating an implicit one when the opener was missed. */
  ensureRecord(key, turn, step, ev, d, out) {
    let rec = this.byKey.get(key)
    if (!rec) rec = this.openRecord(key, turn, step, 0, ev, d, out)
    return rec
  }

  /**
   * Shared path for assistant/chunk, assistant/message and assistant/attempt:
   * stream evidence updates the SAME fact id (upsert, never a second row).
   */
  foldStreamEvidence(ev, d, key, turn, step, out, phase) {
    const isChunk = phase === 'chunk'
    const before = out.length
    const rec = this.ensureRecord(key, turn, step, ev, d, out)
    // Per-call route authority: message.source wins over the session route.
    const r = routeOf(d)
    if (r.provider) rec.provider = r.provider
    if (r.model) rec.model = r.model
    // Usage: top-level on message/attempt wins; else the stream's last usage
    // chunk; a legacy assistant/chunk carries usage inline.
    let usage
    if (phase === 'message') usage = d.usage ? usageOf(d.usage) : (streamUsage(d.stream) ? usageOf(streamUsage(d.stream)) : undefined)
    else if (phase === 'attempt') usage = d.usage ? usageOf(d.usage) : (streamUsage(d.stream) ? usageOf(streamUsage(d.stream)) : undefined)
    else usage = d.chunk?.type === 'usage' ? usageOf(d.chunk) : undefined
    if (usage) Object.assign(rec, usage)
    // First token opens this row's wait and the step's decode window; the
    // earliest attempt keeps it across an in-step retry.
    const tokenAt = streamFirstTokenTime(d.stream) ?? chunkFirstTokenTime(d, ev.time)
    if (tokenAt !== undefined) {
      if (!this.stepTokens.has(key)) this.stepTokens.set(key, tokenAt)
      if (rec.firstTokenMs === null) rec.firstTokenMs = Math.max(0, tokenAt - rec.time)
    }
    if (isChunk) {
      if (usage || tokenAt !== undefined) this.emitRequest(rec, out)
      return out
    }
    rec.finishedAt = ev.time
    if (phase === 'attempt') {
      rec.status = 'failed'
      // A failed call NEVER closes the step's decode window.
    } else {
      rec.status = d.interrupted === true ? 'interrupted' : 'completed'
      const stepFirst = this.stepTokens.get(key)
      if (rec.status === 'completed' && !this.closedSteps.has(key) && stepFirst !== undefined && usageOutputTokens(d.usage) !== null) {
        this.closedSteps.add(key)
        rec.decodeMs = Math.max(0, rec.finishedAt - stepFirst)
      }
    }
    this.emitRequest(rec, out)
    return out
  }

  /** Session-name hint output (label beats title), deduped by emitted name. */
  metaOutput(out) {
    const name = this.label || this.title
    if (!name || name === this.lastMetaName) return out
    this.lastMetaName = name
    out.push({ type: 'meta', meta: { id: this.sessionId, parentId: this.parentId, kind: this.kind, name } })
    return out
  }

  /**
   * End-of-pass flush (backfill): every fact this fold deduped, exactly once.
   * Live mode dispatches fold() outputs as they arrive instead.
   */
  flush() {
    return {
      requests: [...this.requests.values()].map((r) => normalizeRequestFact(r)),
      tools: [...this.tools.values()].map((t) => normalizeToolFact(t)),
      turns: this.turns.slice(),
      meta: this.lastMetaName
        ? { id: this.sessionId, parentId: this.parentId, kind: this.kind, name: this.lastMetaName }
        : null,
    }
  }
}
