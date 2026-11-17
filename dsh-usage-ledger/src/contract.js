/**
 * dsh-usage-ledger contract — THE single source of truth for every interface
 * between the four workstreams (db / collector / routes / client). Pure
 * dependency-free ESM: no Node, no DOM, no imports. Every host module may
 * import from here; the browser artifact (client.js) CANNOT import package
 * files at runtime, so it mirrors the wire shapes below in its own comments
 * — keep both sides in sync when a shape changes.
 *
 * Conventions:
 * - Day keys are LOCAL calendar days "YYYY-MM-DD"; hour keys "YYYY-MM-DDTHH"
 *   (fixed width, plain string compare is chronological).
 * - Token totals are PROVIDER-INCLUSIVE: computedTotal =
 *   input + output + cacheRead + cacheWrite (reasoning is informational,
 *   already inside output for the providers that report it — never added).
 * - providerTotal is the provider-reported totalTokens when present (it may
 *   exceed the four-bucket sum on aggregate-counter providers); null else.
 *   Rollups never sum providerTotal; `tokens` always means computedTotal.
 * - Cache hit rate: cacheRead / (input + cacheRead + cacheWrite) × 100 —
 *   the share of prompt-side tokens served from cache. Null when the
 *   denominator is 0.
 * - Decode throughput: Σ outputTokens / Σ decodeMs × 1000 (tok/s), only over
 *   completed rows that have a decode window.
 * - `estimated` marks values derived from character counts rather than
 *   provider usage. M1 collector writes estimated:false exclusively
 *   (provider usage or zeros); the flag exists so later milestones can mix
 *   estimates in without a schema change.
 */

// ── calendar keys ─────────────────────────────────────────────────────────

/** Local calendar day key, e.g. "2026-08-02" (no UTC shift). */
export function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Local calendar hour key, e.g. "2026-08-02T07". */
export function hourKey(ts) {
  const d = new Date(ts)
  return `${dayKey(ts)}T${String(d.getHours()).padStart(2, '0')}`
}

/** All local-calendar day keys in [from, to], inclusive. Invalid or reversed
 *  bounds yield an empty list. */
export function daysInRange(from, to) {
  const out = []
  const start = new Date(`${from}T00:00:00`)
  const end = new Date(`${to}T00:00:00`)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) return out
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(dayKey(d.getTime()))
  }
  return out
}

/** Today as a day key. */
export function todayKey(now = Date.now()) {
  return dayKey(now)
}

/** Day key `days` before the given day key (local calendar arithmetic). */
export function dayMinus(key, days) {
  const d = new Date(`${key}T00:00:00`)
  d.setDate(d.getDate() - days)
  return dayKey(d.getTime())
}

// ── enums ─────────────────────────────────────────────────────────────────

/** @typedef {'main'|'subagent'|'workflow'} SessionKind */
export const KINDS = /** @type {const} */ (['main', 'subagent', 'workflow'])

/** @typedef {'running'|'completed'|'failed'|'interrupted'} RequestStatus */
export const REQUEST_STATUSES = /** @type {const} */ (['running', 'completed', 'failed', 'interrupted'])

/** @typedef {'running'|'completed'|'failed'} ToolStatus */
export const TOOL_STATUSES = /** @type {const} */ (['running', 'completed', 'failed'])

// ── request fact ──────────────────────────────────────────────────────────

/**
 * One provider call = one row. The fold upserts by `id` as stream evidence
 * arrives (last-wins per id); the store applies the delta to rollups.
 *
 * @typedef {Object} RequestFact
 * @property {string} id            `${sessionId}:${turn}:${step}:${attempt}` — attempt 0 for
 *                                  the step's first call, bumped per `llm/retry-started`.
 *                                  Compaction calls: `${sessionId}:compaction:${seq}`.
 * @property {string} sessionId
 * @property {string|null} parentId null for a root session
 * @property {SessionKind} kind
 * @property {number} turn
 * @property {number} step
 * @property {number} attempt
 * @property {number} time          call start (step/start or retry-started time), epoch ms
 * @property {number|null} finishedAt epoch ms, null while running
 * @property {string} day           local day key of `time`
 * @property {string} hour          local hour key of `time`
 * @property {string} provider      '' when unknown
 * @property {string} model         '' when unknown (bare model id, NOT "provider/model")
 * @property {string} effort        reasoning effort, '' when unknown
 * @property {RequestStatus} status
 * @property {number} inputTokens        uncached prompt tokens
 * @property {number} outputTokens
 * @property {number} reasoningTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number|null} providerTotal provider-reported totalTokens, null when unreported
 * @property {number} computedTotal input+output+cacheRead+cacheWrite
 * @property {number|null} firstTokenMs step start → first output token; null unknown
 * @property {number|null} decodeMs     first token → assembled message (completed only); null else
 * @property {boolean} estimated   M1: always false (provider usage or zeros only)
 */

/**
 * Normalize a partial fact into a complete RequestFact (defaults, day/hour
 * derivation, computedTotal). Unknown/absent numbers become 0; non-finite and
 * negative numbers become 0. Never throws.
 * @param {Partial<RequestFact> & {id: string, sessionId: string}} f
 * @returns {RequestFact}
 */
export function normalizeRequestFact(f) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)
  const time = typeof f.time === 'number' && Number.isFinite(f.time) ? Math.round(f.time) : Date.now()
  const input = num(f.inputTokens)
  const output = num(f.outputTokens)
  const cacheRead = num(f.cacheReadTokens)
  const cacheWrite = num(f.cacheWriteTokens)
  const kind = KINDS.includes(/** @type {SessionKind} */ (f.kind)) ? /** @type {SessionKind} */ (f.kind) : (f.parentId ? 'subagent' : 'main')
  const status = REQUEST_STATUSES.includes(/** @type {RequestStatus} */ (f.status)) ? /** @type {RequestStatus} */ (f.status) : 'running'
  return {
    id: f.id,
    sessionId: f.sessionId,
    parentId: typeof f.parentId === 'string' && f.parentId !== '' ? f.parentId : null,
    kind,
    turn: num(f.turn),
    step: num(f.step),
    attempt: num(f.attempt),
    time,
    finishedAt: numOrNull(f.finishedAt),
    day: typeof f.day === 'string' && f.day !== '' ? f.day : dayKey(time),
    hour: typeof f.hour === 'string' && f.hour !== '' ? f.hour : hourKey(time),
    provider: typeof f.provider === 'string' ? f.provider : '',
    model: typeof f.model === 'string' ? f.model : '',
    effort: typeof f.effort === 'string' ? f.effort : '',
    status,
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: num(f.reasoningTokens),
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    providerTotal: numOrNull(f.providerTotal),
    computedTotal: input + output + cacheRead + cacheWrite,
    firstTokenMs: numOrNull(f.firstTokenMs),
    decodeMs: numOrNull(f.decodeMs),
    estimated: f.estimated === true,
  }
}

// ── tool-call fact ────────────────────────────────────────────────────────

/**
 * One tool execution = one row, keyed by `${sessionId}:${callId}`.
 *
 * @typedef {Object} ToolCallFact
 * @property {string} id
 * @property {string} sessionId
 * @property {string|null} parentId
 * @property {SessionKind} kind
 * @property {number} turn
 * @property {number} step
 * @property {string} name          tool name from `tool/call`
 * @property {number} time          `tool/call` time, epoch ms
 * @property {number|null} finishedAt `tool/result` time, null while running
 * @property {string} day
 * @property {string} hour
 * @property {ToolStatus} status    failed when the result has isError/error
 * @property {number|null} durationMs finishedAt − time
 */

/** @param {Partial<ToolCallFact> & {id: string, sessionId: string, name: string}} f
 *  @returns {ToolCallFact} */
export function normalizeToolFact(f) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v) : 0)
  const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : null)
  const time = typeof f.time === 'number' && Number.isFinite(f.time) ? Math.round(f.time) : Date.now()
  const status = TOOL_STATUSES.includes(/** @type {ToolStatus} */ (f.status)) ? /** @type {ToolStatus} */ (f.status) : 'running'
  const finishedAt = numOrNull(f.finishedAt)
  return {
    id: f.id,
    sessionId: f.sessionId,
    parentId: typeof f.parentId === 'string' && f.parentId !== '' ? f.parentId : null,
    kind: KINDS.includes(/** @type {SessionKind} */ (f.kind)) ? /** @type {SessionKind} */ (f.kind) : (f.parentId ? 'subagent' : 'main'),
    turn: num(f.turn),
    step: num(f.step),
    // A tool/result whose tool/call opener is outside the folded window
    // (install boundary, fork cut, cursor split) carries no name; an empty
    // name must never reach a rollup key — it poisons the day_tool table.
    name: typeof f.name === 'string' && f.name !== '' ? f.name : '(unknown)',
    time,
    finishedAt,
    day: typeof f.day === 'string' && f.day !== '' ? f.day : dayKey(time),
    hour: typeof f.hour === 'string' && f.hour !== '' ? f.hour : hourKey(time),
    status,
    durationMs: numOrNull(f.durationMs ?? (finishedAt !== null ? finishedAt - time : null)),
  }
}

// ── turn marker ───────────────────────────────────────────────────────────

/**
 * One completed turn (failed turns count too — a turn ends exactly once).
 * Not a request row; the store folds it straight into the day/kind rollups.
 * @typedef {Object} TurnMarker
 * @property {string} sessionId
 * @property {string|null} parentId
 * @property {SessionKind} kind
 * @property {number} time
 * @property {string} day
 * @property {number} [seq]   the turn/end event's seq — feeds the session's
 *                            lastSeq high-water (off-window gap catch-up)
 */

// ── rollup rows (KV domain `usage_ledger`, version 1) ─────────────────────

/**
 * Table `days`, key = day.
 * @typedef {Object} DayRollup
 * @property {string} day
 * @property {number} tokens        Σ computedTotal
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} reasoningTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} requests      request rows attributed to the day
 * @property {number} failures      failed request rows (subset of requests)
 * @property {number} turns         completed turns
 * @property {number} firstTokenMsSum / firstTokenCount  avg = sum/count
 * @property {number} firstTokenCount
 * @property {number} decodeMsSum / decodeCount          speed = Σoutput/(sum/1000)
 * @property {number} decodeCount
 * @property {number} decodeTokens  Σ outputTokens over rows with a decode window
 * @property {number} toolCalls
 * @property {number} toolFailures
 * @property {number} lastSeen      newest fact time, epoch ms
 */

/** @returns {DayRollup} */
export function emptyDayRollup(day) {
  return {
    day, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, failures: 0, turns: 0,
    firstTokenMsSum: 0, firstTokenCount: 0, decodeMsSum: 0, decodeCount: 0, decodeTokens: 0,
    toolCalls: 0, toolFailures: 0, lastSeen: 0,
  }
}

/**
 * Table `day_model`, key = `${day}|${provider}/${model}` ('' sides allowed:
 * "provider/", "/model", "|(unknown)" fallback rules live in the store).
 * @typedef {Object} DayModelRollup
 * @property {string} day
 * @property {string} model      combined `provider/model` ref
 * @property {number} tokens
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} reasoningTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} requests
 * @property {number} failures
 */

/** @returns {DayModelRollup} */
export function emptyDayModelRollup(day, model) {
  return {
    day, model, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, failures: 0,
  }
}

/**
 * Table `day_kind`, key = `${day}|${kind}`.
 * @typedef {Object} DayKindRollup
 * @property {string} day
 * @property {SessionKind} kind
 * @property {number} tokens
 * @property {number} requests
 * @property {number} failures
 * @property {number} turns
 */

/** @returns {DayKindRollup} */
export function emptyDayKindRollup(day, kind) {
  return { day, kind, tokens: 0, requests: 0, failures: 0, turns: 0 }
}

/**
 * Table `day_tool`, key = `${day}|${toolName}`.
 * @typedef {Object} DayToolRollup
 * @property {string} day
 * @property {string} tool
 * @property {number} calls
 * @property {number} failures
 * @property {number} durationMsSum  avg = sum / calls-with-duration (client side)
 */

/** @returns {DayToolRollup} */
export function emptyDayToolRollup(day, tool) {
  return { day, tool, calls: 0, failures: 0, durationMsSum: 0 }
}

/**
 * Table `sessions`, key = sessionId. Permanent index of every session that
 * ever produced a fact, for the /sessions list and per-session totals that
 * outlive the 30-day SQLite detail.
 * @typedef {Object} SessionIndexRow
 * @property {string} id
 * @property {string|null} parentId
 * @property {SessionKind} kind
 * @property {string} name         subagent label / session title / cwd basename / id
 * @property {string} firstDay
 * @property {string} lastDay
 * @property {number} tokens
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} requests
 * @property {number} failures
 * @property {number} turns
 * @property {number} toolCalls
 * @property {number} lastSeen
 * @property {number} lastSeq      high-water of ACCOUNTED events (seq) for
 *                                  this session; -1 = none yet. Additive field:
 *                                  old rows default to -1. The collector
 *                                  advances it at turn boundaries and session
 *                                  close so a disable/enable (or upgrade)
 *                                  window can be detected and replayed.
 */

/** @returns {SessionIndexRow} */
export function emptySessionIndexRow(id) {
  return {
    id, parentId: null, kind: 'main', name: '', firstDay: '', lastDay: '',
    tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    requests: 0, failures: 0, turns: 0, toolCalls: 0, lastSeen: 0, lastSeq: -1,
  }
}

/**
 * Domain global (singleton): the backfill cursor. Semantics mirror
 * dsh-token-total's usageHistoryDomain global:
 * - backfilledSessions: session ids fully replayed by a backfill pass.
 * - liveFirstSeq: per live session, the EXCLUSIVE end of the backfill-owned
 *   prefix — [0, value) replays from the log, [value, ∞) is live-owned.
 *   Written when the live listener first observes a session (its first
 *   event's seq, -1 when unknown → replay nothing) and by /reset (wipe-time
 *   log length).
 * @typedef {Object} LedgerCursor
 * @property {string[]} backfilledSessions
 * @property {Record<string, number>} liveFirstSeq
 */

// ── store face (db/ implements, routes/ consumes) ─────────────────────────

/**
 * The LedgerStore public surface. Every method is safe on a degraded store
 * (KV-only): detail reads return `{ degraded: true, …empty }`, writes still
 * land in the KV rollups. Write methods never throw — recording is
 * observational and must never break a turn; failures are counted and
 * surfaced via `status().recordFailures`.
 *
 * @typedef {Object} LedgerStore
 * @property {() => Promise<void>} ready      resolves after backend probe + domain open settle
 * @property {(fact: RequestFact) => void} recordRequest   upsert + rollup delta, fire-and-forget
 * @property {(fact: ToolCallFact) => void} recordToolCall upsert + rollup delta, fire-and-forget
 * @property {(marker: TurnMarker) => void} recordTurn     rollup-only, fire-and-forget
 * @property {(meta: {id: string, parentId: string|null, kind: SessionKind, name?: string}) => void} recordSessionMeta
 * @property {() => LedgerStatus} status
 * @property {() => Promise<SummaryResponse>} summary
 * @property {(q: {from?: string, to?: string, group?: 'model'|'kind'|'tool', granularity?: 'day'|'hour'}) => Promise<DailyResponse>} daily
 * @property {(q: {weeks?: number}) => Promise<HeatmapResponse>} heatmap
 * @property {(q: {limit?: number, offset?: number, q?: string}) => Promise<SessionsResponse>} sessions
 * @property {(id: string) => Promise<SessionDetailResponse>} sessionDetail
 * @property {(q: {from?: string, to?: string}) => Promise<ToolsResponse>} tools
 * @property {(boundaries: Map<string, number>) => Promise<void>} reset  wipe all rows + cursor at live watermarks
 * @property {() => Promise<Map<string, number>>} liveSequences  current liveFirstSeq map (for /reset)
 * @property {(id: string, seq: number) => Promise<void>} markLiveSequence   live listener's first-observation boundary
 * @property {(id: string) => Promise<number|null>} sessionHighSeq  a session row's lastSeq high-water (null = no row yet)
 * @property {(id: string, seq: number) => Promise<void>} markSessionSeq  advance a session row's lastSeq (existing rows only)
 * @property {() => Promise<{cursor: LedgerCursor}>} cursorState  backfill reads this before scanning
 * @property {(ids: string[]) => Promise<void>} markBackfilled   sessions a backfill pass fully replayed
 * @property {() => Promise<void>} prune      drop SQLite rows older than retentionDays (idempotent)
 */

// ── wire responses (routes/ produce, client mirrors) ──────────────────────

/**
 * @typedef {Object} SummaryResponse
 * @property {number} tokens          lifetime Σ computedTotal
 * @property {number} inputTokens
 * @property {number} outputTokens
 * @property {number} reasoningTokens
 * @property {number} cacheReadTokens
 * @property {number} cacheWriteTokens
 * @property {number} requests
 * @property {number} failures
 * @property {number} turns
 * @property {number} toolCalls
 * @property {number} activeDays      days with tokens > 0 or requests > 0
 * @property {string|null} firstDay
 * @property {string|null} lastDay
 * @property {{day: string, tokens: number}|null} peakDay
 * @property {number} streakDays      consecutive active days ending today
 *                                    (today inactive → streak ending yesterday)
 * @property {number} todayTokens     Σ computedTotal of the local day row for today (0 when inactive)
 * @property {number} todayRequests   request count of the local day row for today (0 when inactive)
 * @property {number|null} avgFirstTokenMs
 * @property {number|null} cacheHitRate    0..100, cacheRead/(input+cacheRead+cacheWrite)
 * @property {number|null} errorRate       0..100, failures/requests
 * @property {number|null} tokensPerSecond Σoutput/(ΣdecodeMs/1000) over decode-windowed rows
 * @property {boolean} degraded       true when SQLite detail is unavailable
 */

/**
 * @typedef {Object} DailyBucket
 * @property {string} key             day or hour key (zero-filled: every bucket present)
 * @property {number} tokens
 * @property {number} requests
 * @property {number} failures
 * @property {number} turns
 * @property {Record<string, number>} groups  group-key → tokens (empty without group)
 * @property {number|null} cacheHitRate  bucket 的缓存命中率 0..100（cacheRead/(input+read+write)），
 *                                       无 prompt 侧数据时为 null；additive 字段。
 *
 * @typedef {Object} DailyResponse
 * @property {string} from
 * @property {string} to
 * @property {'day'|'hour'} granularity
 * @property {'model'|'kind'|'tool'|null} group
 * @property {DailyBucket[]} buckets
 * @property {{key: string, tokens: number, requests: number, percent: number}[]} groupTotals  desc by tokens
 * @property {Record<string, string>} [groupNames]  additive：group='model' 时把
 *          `provider/model` 路由引用解析为模型选择器里的人类可读名（llm 服务），
 *          解析不到的键缺席，客户端回退显示原始引用。
 * @property {boolean} degraded       hour granularity in KV-only mode returns
 *                                    day buckets with degraded:true
 */

/**
 * @typedef {Object} HeatmapResponse
 * @property {number} weeks
 * @property {{day: string, tokens: number, requests: number}[]} days  zero-filled,
 *                                    oldest first, aligned to whole weeks ending today
 * @property {number} maxTokens
 */

/**
 * @typedef {Object} SessionsResponse
 * @property {number} total
 * @property {SessionIndexRow[]} rows  newest lastSeen first
 */

/**
 * @typedef {Object} SessionDetailResponse
 * @property {string} id
 * @property {SessionIndexRow|null} index    permanent rollup row (null if never recorded)
 * @property {{tokens: number, inputTokens: number, outputTokens: number, cacheReadTokens: number,
 *             cacheWriteTokens: number, reasoningTokens: number}} totals  from `index` (zeros when absent)
 * @property {number} requests
 * @property {number} failures
 * @property {{id: string, parentId: string|null, kind: SessionKind, name: string,
 *             requests: number, failures: number, turns: number,
 *             tokens: number, inputTokens: number, outputTokens: number,
 *             cacheReadTokens: number, cacheWriteTokens: number,
 *             avgFirstTokenMs: number|null, tokensPerSecond: number|null}[]} children
 *            KV-sourced descendant rows (BFS below the requested session,
 *            excluding the root itself; [] when none). `tokens` is the
 *            four-bucket sum, same 口径 as `totals`. Available even when
 *            degraded (KV is its only source). The two rate columns come from
 *            the log-replay assembler (completed-only 口径); null when the
 *            child's log is unreadable or reports no rate.
 * @property {number|null} avgFirstTokenMs   over completed records in the detail window
 * @property {number|null} tokensPerSecond
 * @property {SessionContextSummary|null} context
 *            log-replay view of what the session's NEXT request would carry
 *            (null when the log is unreadable or has no events)
 * @property {SessionUsageComposition|null} composition
 *            log-replay spend composition over the session tree (null when
 *            no request ever reported usage)
 * @property {{model: string, provider: string, tokens: number, requests: number, failures: number,
 *             inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number,
 *             name?: string}[]} byModel
 *            unbounded SQLite GROUP BY over member sessions (`tokens` =
 *            computedTotal sum; [] when degraded). `name` is the model
 *            selector's display name resolved via the optional llm service;
 *            omitted when unresolvable (the UI falls back to the model id).
 * @property {RequestFact[]} records         SQLite detail (30-day window), newest first
 * @property {{name: string, calls: number, failures: number}[]} tools
 * @property {boolean} degraded              true when records/tools are unavailable (KV-only)
 */

/**
 * The session page's "current context" card: what the session's next request
 * would carry, rebuilt from the session's own log (shadowed events dropped,
 * compaction summaries standing in as injected memory, the newest
 * request/header tool catalogue). Token counts are character-class ESTIMATES;
 * `promptTokens`/cache fields are the provider's exact numbers from the
 * newest usage report.
 * @typedef {Object} SessionContextSummary
 * @property {number} totalTokens            sum of the 7 buckets (estimate)
 * @property {number|null} contextWindow     from `request/context` (null when absent)
 * @property {string} provider
 * @property {string} model
 * @property {number|null} promptTokens       what the newest answered request was billed for input-side
 * @property {number} cacheHitTokens
 * @property {number} cacheMissTokens
 * @property {boolean} cacheKnown
 * @property {{key: 'systemPrompt'|'user'|'skill'|'toolResult'|'toolDef'|'injected'|'assistant',
 *             tokens: number}[]} buckets     7 buckets in legend order (no output)
 */

/**
 * The session page's "Token stats" card: what the session tree's requests
 * actually paid for, split by what filled each prompt. Each request pays for
 * the whole replayed message list, so a bucket's number is the sum of its size
 * AT EVERY REQUEST. Bucket tokens are estimates; billed/totals/requests come
 * straight from provider usage records and are exact.
 * @typedef {Object} SessionUsageComposition
 * @property {{key: 'systemPrompt'|'user'|'skill'|'toolResult'|'toolDef'|'injected'|'assistant'|'output',
 *             tokens: number}[]} buckets      8 buckets in legend order
 * @property {number} billedTokens            exact four-bucket sum over provider usage
 * @property {{tokens: number, inputTokens: number, outputTokens: number, cacheReadTokens: number,
 *             cacheWriteTokens: number, reasoningTokens: number}} totals
 * @property {number} requests                requests that reported usage
 */

/**
 * @typedef {Object} ToolsResponse
 * @property {{name: string, calls: number, failures: number, avgDurationMs: number|null, percent: number}[]} tools
 */

/**
 * @typedef {Object} LedgerStatus
 * @property {'sqlite'|'kv'} backend
 * @property {boolean} degraded
 * @property {string|null} backendError   probe/open failure reason, sanitized
 * @property {number} retentionDays
 * @property {number} requestRows          SQLite row counts (0 when degraded)
 * @property {number} toolRows
 * @property {number} kvDays
 * @property {number} kvSessions
 * @property {number} recordFailures
 * @property {string|null} lastPruneDay
 * @property {{running: boolean, total: number, done: number, scannedSessions: number,
 *             lastSessionId?: string, error?: string}} backfill
 */

// ── token estimator (shared; M1 uses it only where provider numbers lack) ──

/** ASCII-ish characters per token (the host estimator's ratio). */
export const ASCII_CHARS_PER_TOKEN = 4
/** Wide (CJK, kana, hangul) characters per token: these bill ~1 token/char. */
export const WIDE_CHARS_PER_TOKEN = 1.5
/** A supplementary-plane emoji is worth a few wide characters. */
export const EMOJI_TOKEN_EQUIVALENT = 3

/** Approximate token count of one string (character-class estimate). */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text === '') return 0
  let ascii = 0
  let wide = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x1f000 && code <= 0x1faff) wide += EMOJI_TOKEN_EQUIVALENT
    else if (code < 0x2e80) ascii++
    else wide++
  }
  return Math.ceil(ascii / ASCII_CHARS_PER_TOKEN + wide / WIDE_CHARS_PER_TOKEN)
}

/** Cache hit rate (percent, 0..100) or null when no prompt tokens are known. */
export function cacheHitRateOf(input, cacheRead, cacheWrite) {
  const denom = input + cacheRead + cacheWrite
  if (!Number.isFinite(denom) || denom <= 0) return null
  return (cacheRead / denom) * 100
}

/** Decode throughput (tok/s) or null. */
export function decodeRateOf(outputTokens, decodeMsSum) {
  if (!Number.isFinite(decodeMsSum) || decodeMsSum <= 0 || !Number.isFinite(outputTokens) || outputTokens <= 0) return null
  return outputTokens / (decodeMsSum / 1000)
}
