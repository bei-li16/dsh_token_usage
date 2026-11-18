/**
 * Collector smoke test — synthetic session logs through a mock store.
 *
 * Covers: step/start → request/context → assistant/message (usage + stream
 * first token), llm/retry-started retry chain, assistant/attempt failure,
 * turn/end interruption, compaction/summary, tool/call + tool/result
 * (isError AND error-string failure paths), subagent/descriptor naming,
 * fork prefix (inheritedEventCount > 0), the workflow kind heuristic,
 * live capture + disposer teardown, and the cursor skip of a second pass.
 *
 * Fix regressions (2026-11-16): live-session deferral (never marked
 * backfilled without a usable boundary), the same-activation boundary race,
 * off-window gap catch-up on first live observation, dispose tail
 * catch-up, and flush({dropRunning}).
 *
 * Fix regressions (2026-11-17): the inherited prefix stays skipped
 * UNCONDITIONALLY — host invariant cut > 0 ⟺ seeded fork (seeded forks carry
 * no parentSession; see the j1/k1/j2 guard below).
 *
 * Fix regressions (task-6, 2026-11-17 double-count incident): the store's KV
 * delta base moved from the prunable SQLite detail rows to PERMANENT anchors
 * (request_anchor/tool_anchor/turn_anchor — prune never deletes them, reset
 * clears them), and turn markers dedupe on (session, seq). modelStore below
 * mirrors both semantics plus the 0.1.2 legacy mode; scenarios M/N/O/P replay
 * the release-acceptance incident (reset → rescan → remount window → sweep):
 * legacy reproduces the exactly-2×-old-days fingerprint, the fix keeps every
 * day/session counter strictly unchanged (verify-usage [d]/[e] semantics).
 *
 * Run: node src/collector/smoke.mjs   (exit 0 = pass)
 */

import { RequestFold } from './fold.js'
import { LedgerCollector } from './collector.js'
import { dayKey, hourKey, todayKey } from '../contract.js'

const T0 = 1763000000000 // fixed epoch base; all times derive from it

let failures = 0
let checks = 0
function ok(cond, label, extra) {
  checks++
  if (!cond) {
    failures++
    console.error(`FAIL  ${label}${extra !== undefined ? ` — got ${JSON.stringify(extra)}` : ''}`)
  }
}
function eq(got, want, label) {
  ok(got === want, label, got === want ? undefined : { got, want })
}

// ── mock store: records every call ──────────────────────────────────────────

function mockStore() {
  const calls = { request: [], tool: [], turn: [], meta: [], markLive: [], markBackfilled: [], markSessionSeq: [] }
  let cursor = { backfilledSessions: [], liveFirstSeq: {} }
  const sessions = new Map()
  return {
    calls,
    sessions,
    setCursor(c) { cursor = c },
    recordRequest(f) { calls.request.push(f) },
    recordToolCall(f) { calls.tool.push(f) },
    recordTurn(m) { calls.turn.push(m) },
    recordSessionMeta(m) { calls.meta.push(m) },
    async markLiveSequence(id, seq) { calls.markLive.push([id, seq]) },
    async cursorState() { return { cursor } },
    async markBackfilled(ids) { calls.markBackfilled.push(ids) },
    async sessionHighSeq(id) { const row = sessions.get(id); return row ? (row.lastSeq ?? -1) : null },
    async markSessionSeq(id, seq) {
      calls.markSessionSeq.push([id, seq])
      const row = sessions.get(id)
      if (row && (row.lastSeq ?? -1) < seq) row.lastSeq = seq
    },
    async prune() { calls.pruned = (calls.pruned ?? 0) + 1 },
  }
}

// ── mock persistence (alpha shape: list → snapshots, open/read/close) ───────

function mockPersistence(logs) {
  // logs: Map id → {header, inheritedEventCount, events[]}
  return {
    async list(options) {
      return [...logs.values()].map((l) => ({ header: l.header }))
    },
    async open(id, mode, options) {
      const log = logs.get(id)
      if (!log) throw new Error(`unknown session ${id}`)
      return {
        inheritedEventCount: log.inheritedEventCount ?? 0,
        async read(offset, limit) {
          return { events: log.events.slice(offset, offset + limit) }
        },
        async close() {},
      }
    },
  }
}

const noLiveSessions = { list: () => [] }

function ev(seq, time, type, data) {
  return { seq, time, type, data }
}

// ── scenario A: the full state machine in one main session ──────────────────

const s1events = [
  ev(0, T0 - 10, 'request/context', { provider: 'deepseek', model: 'deepseek-chat' }),
  // turn 1: open → effort → close with usage + stream first token
  ev(1, T0, 'step/start', { turn: 1, step: 1 }),
  ev(2, T0 + 10, 'request/header', { header: { config: { reasoningEffort: 'high' } } }),
  ev(3, T0 + 600, 'assistant/message', {
    turn: 1, step: 1,
    message: { source: { provider: 'deepseek', model: 'deepseek-chat' } },
    stream: [
      { type: 'chunk', time: T0 + 100, chunk: { type: 'text-delta', text: 'hi' } },
      { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 9, outputTokens: 4 } } },
    ],
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 3 },
  }),
  ev(4, T0 + 700, 'turn/end', { turn: 1, reason: 'completed' }),
  // turn 2: retry chain — step/start, retry-started, failed attempt
  ev(5, T0 + 1000, 'step/start', { turn: 2, step: 1 }),
  ev(6, T0 + 1050, 'llm/retry-started', { turn: 2, step: 1 }),
  ev(7, T0 + 1200, 'assistant/attempt', {
    turn: 2, step: 1,
    stream: [
      { type: 'chunk', time: T0 + 1150, chunk: { type: 'text-delta', text: 'pa' } },
      { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 1 } } },
    ],
  }),
  ev(8, T0 + 1300, 'turn/end', { turn: 2, reason: 'failed' }),
  // turn 3: completed message with stream-only usage — decode must NOT close
  ev(9, T0 + 2000, 'step/start', { turn: 3, step: 1 }),
  ev(10, T0 + 2400, 'assistant/message', {
    turn: 3, step: 1,
    message: {},
    stream: [
      { type: 'chunk', time: T0 + 2080, chunk: { type: 'text-delta', text: 'x' } },
      { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 2 } } },
    ],
  }),
  ev(11, T0 + 2500, 'turn/end', { turn: 3, reason: 'completed' }),
  // turn 4: interrupted by turn/end while still running
  ev(12, T0 + 3000, 'step/start', { turn: 4, step: 1 }),
  ev(13, T0 + 3030, 'turn/end', { turn: 4, reason: 'cancelled' }),
  // compaction: standalone request row
  ev(14, T0 + 4000, 'compaction/summary', {
    compactionId: 'c1', provider: 'deepseek', model: 'deepseek-reasoner',
    usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
  }),
  // turn 5: tools — one ok, one isError, one error-string
  ev(15, T0 + 5000, 'tool/call', { turn: 5, step: 1, callId: 'call1', name: 'pwsh' }),
  ev(16, T0 + 5040, 'tool/result', { turn: 5, step: 1, message: { toolCallId: 'call1' } }),
  ev(17, T0 + 5050, 'tool/call', { turn: 5, step: 2, callId: 'call2', name: 'read' }),
  ev(18, T0 + 5090, 'tool/result', { turn: 5, step: 2, message: { toolCallId: 'call2', isError: true } }),
  ev(19, T0 + 5100, 'tool/call', { turn: 5, step: 3, callId: 'call3', name: 'grep' }),
  ev(20, T0 + 5150, 'tool/result', { turn: 5, step: 3, message: { toolCallId: 'call3' }, error: 'boom' }),
  ev(21, T0 + 5200, 'turn/end', { turn: 5, reason: 'completed' }),
  // naming hints: label beats title
  ev(22, T0 + 6000, 'session/title', { title: 'A title' }),
  ev(23, T0 + 6100, 'subagent/descriptor', { label: 'my-agent' }),
]

// ── scenario B: forked child (inherited prefix must produce zero output) ────

const s2events = [
  ev(0, T0, 'step/start', { turn: 1, step: 1 }), // inherited from parent
  ev(1, T0 + 500, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 50, outputTokens: 50 } }), // inherited
  ev(2, T0 + 1000, 'step/start', { turn: 2, step: 1 }), // own
  ev(3, T0 + 1500, 'assistant/message', { turn: 2, step: 1, message: { source: { provider: 'p', model: 'm' } }, usage: { inputTokens: 5, outputTokens: 6 } }),
  ev(4, T0 + 1600, 'turn/end', { turn: 2, reason: 'completed' }),
]

// ── scenario C: workflow kind heuristic (first own event = agent-start) ─────

const s3events = [
  ev(0, T0, 'tool-workflow/agent-start', { label: 'wf' }),
  ev(1, T0 + 10, 'step/start', { turn: 1, step: 1 }),
  ev(2, T0 + 500, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 1, outputTokens: 1 } }),
  ev(3, T0 + 600, 'turn/end', { turn: 1, reason: 'completed' }),
]

// ── run backfill over all three sessions ────────────────────────────────────

async function main() {
  const logs = new Map([
    ['s1', { header: { id: 's1' }, inheritedEventCount: 0, events: s1events }],
    ['s2', { header: { id: 's2', parentSession: 'p1' }, inheritedEventCount: 2, events: s2events }],
    ['s3', { header: { id: 's3', parentSession: 'p1' }, inheritedEventCount: 0, events: s3events }],
  ])
  const store = mockStore()
  const collector = new LedgerCollector({ store, concurrency: 2, logger: console })
  await collector.backfill(mockPersistence(logs), noLiveSessions)

  const reqs = store.calls.request
  const tools = store.calls.tool
  const turns = store.calls.turn
  const metas = store.calls.meta

  // ── dedup: one flush per session ⇒ each fact id recorded exactly once ──
  const ids = reqs.map((r) => r.id)
  eq(new Set(ids).size, ids.length, 'backfill emits each request id exactly once')

  const byId = new Map(reqs.map((r) => [r.id, r]))

  // ── scenario A facts ──
  const a = byId.get('s1:1:1:0')
  ok(a !== undefined, 's1:1:1:0 exists')
  eq(a?.status, 'completed', 's1:1:1:0 status')
  eq(a?.attempt, 0, 's1:1:1:0 attempt')
  eq(a?.time, T0, 's1:1:1:0 time = step/start time')
  eq(a?.finishedAt, T0 + 600, 's1:1:1:0 finishedAt = message time')
  eq(a?.provider, 'deepseek', 's1:1:1:0 provider from message.source')
  eq(a?.model, 'deepseek-chat', 's1:1:1:0 model from message.source')
  eq(a?.effort, 'high', 's1:1:1:0 effort from request/header')
  eq(a?.inputTokens, 10, 's1:1:1:0 input (top-level usage wins over stream)')
  eq(a?.outputTokens, 5, 's1:1:1:0 output')
  eq(a?.reasoningTokens, 3, 's1:1:1:0 reasoning')
  eq(a?.cacheReadTokens, 2, 's1:1:1:0 cacheRead')
  eq(a?.cacheWriteTokens, 1, 's1:1:1:0 cacheWrite')
  eq(a?.providerTotal, 15, 's1:1:1:0 providerTotal = totalTokens')
  eq(a?.computedTotal, 18, 's1:1:1:0 computedTotal = 10+5+2+1')
  eq(a?.firstTokenMs, 100, 's1:1:1:0 firstTokenMs = stream first token − start')
  eq(a?.decodeMs, 500, 's1:1:1:0 decodeMs = finishedAt − step first token')
  eq(a?.estimated, false, 's1:1:1:0 estimated false')
  eq(a?.kind, 'main', 's1:1:1:0 kind main (no parent)')
  eq(a?.parentId, null, 's1:1:1:0 parentId null')
  eq(a?.day, dayKey(T0), 's1:1:1:0 day key')
  eq(a?.hour, hourKey(T0), 's1:1:1:0 hour key')

  // retry: old attempt failed, new attempt id opened
  const r0 = byId.get('s1:2:1:0')
  const r1 = byId.get('s1:2:1:1')
  ok(r0 !== undefined && r1 !== undefined, 'retry produced both attempt ids')
  eq(r0?.status, 'failed', 'retry supersedes: attempt 0 failed')
  eq(r0?.finishedAt, T0 + 1050, 'attempt 0 finishedAt = retry-started time')
  eq(r1?.attempt, 1, 'attempt 1 attempt number')
  eq(r1?.time, T0 + 1050, 'attempt 1 time = retry-started time')
  eq(r1?.status, 'failed', 'attempt 1 failed by assistant/attempt')
  eq(r1?.finishedAt, T0 + 1200, 'attempt 1 finishedAt = attempt event time')
  eq(r1?.inputTokens, 3, 'attempt 1 usage from stream last usage chunk')
  eq(r1?.outputTokens, 1, 'attempt 1 output')
  eq(r1?.providerTotal, null, 'attempt 1 providerTotal null (no totalTokens)')
  eq(r1?.firstTokenMs, 100, 'attempt 1 firstTokenMs from failed stream')
  eq(r1?.decodeMs, null, 'assistant/attempt NEVER closes the decode window')

  // stream-only usage: decode window stays open
  const s3rec = byId.get('s1:3:1:0')
  eq(s3rec?.status, 'completed', 's1:3:1:0 completed')
  eq(s3rec?.inputTokens, 7, 's1:3:1:0 usage from stream')
  eq(s3rec?.firstTokenMs, 80, 's1:3:1:0 firstTokenMs')
  eq(s3rec?.decodeMs, null, 'decode window closes ONLY on top-level usage')
  eq(s3rec?.provider, 'deepseek', 's1:3:1:0 provider falls back to session route')

  // interrupted by turn/end
  const s4rec = byId.get('s1:4:1:0')
  eq(s4rec?.status, 'interrupted', 'turn/end interrupts still-running record')
  eq(s4rec?.finishedAt, T0 + 3030, 'interrupted finishedAt = turn/end time')
  eq(s4rec?.decodeMs, null, 'interrupted has no decode window')

  // compaction row
  const comp = byId.get('s1:compaction:14')
  ok(comp !== undefined, 'compaction id uses event seq')
  eq(comp?.turn, 0, 'compaction turn 0')
  eq(comp?.step, 0, 'compaction step 0')
  eq(comp?.status, 'completed', 'compaction completed')
  eq(comp?.provider, 'deepseek', 'compaction provider self-named')
  eq(comp?.model, 'deepseek-reasoner', 'compaction model self-named')
  eq(comp?.computedTotal, 120, 'compaction computedTotal')
  eq(comp?.providerTotal, 120, 'compaction providerTotal')
  eq(comp?.firstTokenMs, null, 'compaction firstTokenMs null')
  eq(comp?.decodeMs, null, 'compaction decodeMs null')

  // turn markers: 5 ended turns, failed turn counts too
  eq(turns.filter((m) => m.sessionId === 's1').length, 5, 'five turn markers for s1 (failed turn counts)')
  const tm = turns.find((m) => m.sessionId === 's1' && m.time === T0 + 700)
  eq(tm?.kind, 'main', 'turn marker kind')
  eq(tm?.day, dayKey(T0 + 700), 'turn marker day')

  // tools
  const toolById = new Map(tools.map((t) => [t.id, t]))
  const t1 = toolById.get('s1:call1')
  eq(t1?.status, 'completed', 'tool ok')
  eq(t1?.durationMs, 40, 'tool durationMs')
  eq(t1?.name, 'pwsh', 'tool name')
  eq(toolById.get('s1:call2')?.status, 'failed', 'tool isError ⇒ failed')
  eq(toolById.get('s1:call3')?.status, 'failed', 'tool error field ⇒ failed')
  eq(toolById.get('s1:call3')?.durationMs, 50, 'tool error durationMs')

  // meta: label beats title, emitted once with the final name
  const s1metas = metas.filter((m) => m.id === 's1')
  ok(s1metas.length >= 1, 'session meta recorded')
  eq(s1metas[s1metas.length - 1]?.name, 'my-agent', 'label wins over title')

  // ── scenario B: fork prefix produced zero facts ──
  ok(!ids.some((id) => id === 's2:1:1:0'), 'fork-inherited prefix yields zero request facts')
  const b = byId.get('s2:2:1:0')
  ok(b !== undefined, 'fork own events replayed')
  eq(b?.kind, 'subagent', 'fork child kind subagent')
  eq(b?.parentId, 'p1', 'fork child parentId from persisted header')
  eq(b?.computedTotal, 11, 'fork own fact tokens')
  eq(turns.filter((m) => m.sessionId === 's2').length, 1, 'only own turn marker for fork child')

  // ── scenario C: workflow heuristic ──
  const c = byId.get('s3:1:1:0')
  eq(c?.kind, 'workflow', 'first own event tool-workflow/agent-start ⇒ kind workflow')
  eq(c?.parentId, 'p1', 'workflow parentId preserved')

  // ── status + cursor ──
  eq(collector.status.running, false, 'status.running false after backfill')
  eq(collector.status.total, 3, 'status.total')
  eq(collector.status.done, 3, 'status.done')
  eq(collector.status.scannedSessions, 3, 'status.scannedSessions')
  eq(collector.status.error, undefined, 'status.error unset on clean run')
  eq(store.calls.markBackfilled.length, 1, 'markBackfilled batched once for 3 sessions')
  eq(store.calls.markBackfilled[0].length, 3, 'markBackfilled batch carries all ids')
  eq(store.calls.pruned, 1, 'prune called once at the end')

  // ── second pass: cursor skips everything ──
  // The rows below are what pass 1 leaves behind (markSessionSeq advanced
  // each existing row to its replayed max): the 2026-11-17 reconciliation
  // sweep must then find every dead cursor session caught up and write
  // nothing (one log read each, zero replays).
  const store2 = mockStore()
  store2.setCursor({ backfilledSessions: ['s1', 's2', 's3'], liveFirstSeq: {} })
  store2.sessions.set('s1', { lastSeq: 23 })
  store2.sessions.set('s2', { lastSeq: 4 })
  store2.sessions.set('s3', { lastSeq: 3 })
  const collector2 = new LedgerCollector({ store: store2, concurrency: 4 })
  await collector2.backfill(mockPersistence(logs), noLiveSessions)
  eq(store2.calls.request.length, 0, 'second pass with full cursor replays nothing')
  eq(collector2.status.total, 0, 'second pass total 0')
  eq(collector2.status.sweep?.checked, 3, 'second pass sweep checks the dead cursor sessions')
  eq(collector2.status.sweep?.replayed, 0, 'second pass sweep: caught up ⇒ nothing replayed')

  // ── live path: boundary mark, upsert-by-id, disposer ──
  const store3 = mockStore()
  const handlers = new Map()
  const ctx = {
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name) },
  }
  const live = new LedgerCollector({ store: store3, logger: console })
  const dispose = live.start(ctx)
  ok(handlers.has('session/event') && handlers.has('session/disposed'), 'live listeners registered')
  const liveHandle = {
    id: 'live1',
    header: { parentSession: 'root1' },
    requestContext: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
  }
  handlers.get('session/event')(liveHandle, ev(7, T0, 'step/start', { turn: 1, step: 1 }))
  handlers.get('session/event')(liveHandle, ev(8, T0 + 300, 'assistant/message', {
    turn: 1, step: 1, message: {}, usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
  }))
  eq(store3.calls.markLive.length, 1, 'markLiveSequence once on first observation')
  eq(store3.calls.markLive[0]?.[0], 'live1', 'markLiveSequence session id')
  eq(store3.calls.markLive[0]?.[1], 7, 'markLiveSequence first event seq')
  const liveIds = store3.calls.request.map((r) => r.id)
  eq(liveIds.length, 2, 'live upsert: two emissions')
  ok(liveIds.every((id) => id === 'live1:1:1:0'), 'live upsert: SAME fact id (no second row)')
  eq(store3.calls.request[0]?.status, 'running', 'live first emission running')
  eq(store3.calls.request[1]?.status, 'completed', 'live second emission completed')
  eq(store3.calls.request[1]?.provider, 'deepseek', 'live route seeded from requestContext()')
  eq(store3.calls.request[1]?.kind, 'subagent', 'live kind from header.parentSession')
  dispose()
  eq(handlers.size, 0, 'disposer removes every listener')

  // ── degraded host: ctx without on() → backfill-only, no throw ──
  const store4 = mockStore()
  const warned = []
  const degraded = new LedgerCollector({ store: store4, logger: { warn: (...a) => warned.push(a.join(' ')) } })
  const d2 = degraded.start({})
  eq(warned.length, 1, 'ctx.on missing ⇒ one warning')
  d2()

  // ── fix regression (2026-11-16): live session without a boundary is
  //    DEFERRED, not marked backfilled — was: skipped forever, silently
  //    dropping its whole persisted history (observed: 69.3M tokens → 0) ──
  const logsD = new Map([
    ['d1', { header: { id: 'd1' }, inheritedEventCount: 0, events: [
      ev(0, T0, 'step/start', { turn: 1, step: 1 }),
      ev(1, T0 + 100, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 1, outputTokens: 1 } }),
      ev(2, T0 + 150, 'turn/end', { turn: 1, reason: 'completed' }),
    ] }],
  ])
  const storeD = mockStore()
  const collectorD = new LedgerCollector({ store: storeD, concurrency: 1 })
  await collectorD.backfill(mockPersistence(logsD), { list: () => [{ id: 'd1' }] })
  eq(storeD.calls.request.length, 0, 'deferred: live-unmarked session replays nothing now')
  eq(storeD.calls.markBackfilled.length, 0, 'deferred: NOT marked backfilled')
  ok((collectorD.status.deferredSessions ?? []).includes('d1'), 'deferred: status lists the session')
  eq(collectorD.status.scannedSessions, 0, 'deferred: not counted as scanned')
  // …and a later pass with the session closed replays it fully.
  const storeD2 = mockStore()
  const collectorD2 = new LedgerCollector({ store: storeD2, concurrency: 1 })
  await collectorD2.backfill(mockPersistence(logsD), noLiveSessions)
  ok(storeD2.calls.request.some((r) => r.id === 'd1:1:1:0'), 'deferred session replays fully once closed')
  ok(storeD2.calls.markBackfilled.some((b) => b.includes('d1')), 'closed pass marks it backfilled')

  // ── fix regression (2026-11-18): an IDLE session with a stale persisted
  //    boundary must replay from scratch — nothing live owns [boundary, ∞)
  //    anymore (Normal分析1 turn-51 hole: drain-buffered events flushed to
  //    the log only after the boundary was sampled) ──
  const logsN = new Map([
    ['n1', { header: { id: 'n1' }, inheritedEventCount: 0, events: [
      ev(0, T0, 'step/start', { turn: 1, step: 1 }),
      ev(1, T0 + 100, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 1, outputTokens: 1 } }),
      ev(2, T0 + 150, 'turn/end', { turn: 1, reason: 'completed' }),
      ev(5, T0 + 1000, 'step/start', { turn: 2, step: 1 }),
      ev(6, T0 + 1100, 'assistant/message', { turn: 2, step: 1, message: {}, usage: { inputTokens: 20, outputTokens: 5 } }),
      ev(7, T0 + 1200, 'turn/end', { turn: 2, reason: 'completed' }),
    ] }],
  ])
  const storeN = mockStore()
  // boundary 3: turn 2 (seq ≥ 3) looks "live-owned" — but n1 is NOT live.
  storeN.setCursor({ backfilledSessions: [], liveFirstSeq: { n1: 3 } })
  const collectorN = new LedgerCollector({ store: storeN, concurrency: 1 })
  await collectorN.backfill(mockPersistence(logsN), noLiveSessions)
  const nIds = storeN.calls.request.map((r) => r.id)
  ok(nIds.includes('n1:1:1:0'), 'idle+boundary: prefix replayed')
  ok(nIds.includes('n1:2:1:0'), 'idle session ignores stale boundary — tail replayed')

  // ── snapshotLiveFacts (2026-11-18): reset 重记账源——只读快照实时 fold，
  //    且不干扰后续折叠（caab691e 排水窗口丢账修复的配套）──
  const storeS = mockStore()
  const collectorS = new LedgerCollector({ store: storeS, concurrency: 1 })
  const handlersS = new Map()
  collectorS.start({ on(name, fn) { handlersS.set(name, fn); return () => handlersS.delete(name) } })
  const sHandle = { id: 'sn1', header: {}, requestContext: () => ({ provider: 'p', model: 'm' }) }
  handlersS.get('session/event')(sHandle, ev(0, T0, 'step/start', { turn: 1, step: 1 }))
  handlersS.get('session/event')(sHandle, ev(1, T0 + 100, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 7, outputTokens: 3 } }))
  const snap = collectorS.snapshotLiveFacts()
  eq(snap.requests.length, 1, 'snapshot: one request fact')
  eq(snap.requests[0].computedTotal, 10, 'snapshot: fact tokens intact')
  handlersS.get('session/event')(sHandle, ev(2, T0 + 200, 'step/start', { turn: 1, step: 2 }))
  handlersS.get('session/event')(sHandle, ev(3, T0 + 300, 'assistant/message', { turn: 1, step: 2, message: {}, usage: { inputTokens: 1, outputTokens: 1 } }))
  eq(collectorS.snapshotLiveFacts().requests.length, 2, 'snapshot is read-only: fold keeps accumulating')

  // ── fix regression: same-activation live boundary closes the KV write race ──
  const storeE = mockStore()
  const collectorE = new LedgerCollector({ store: storeE, concurrency: 1 })
  const handlersE = new Map()
  collectorE.start({ on(name, fn) { handlersE.set(name, fn); return () => handlersE.delete(name) } })
  const eHandle = { id: 'e1', header: {}, requestContext: () => ({ provider: 'p', model: 'm' }) }
  // The live pass observes seq 5 first — the async KV boundary write has NOT
  // landed in the cursor yet when backfill runs (the original race).
  handlersE.get('session/event')(eHandle, ev(5, T0 + 5000, 'step/start', { turn: 2, step: 1 }))
  const logsE = new Map([
    ['e1', { header: { id: 'e1' }, inheritedEventCount: 0, events: [
      ev(0, T0, 'step/start', { turn: 1, step: 1 }),
      ev(1, T0 + 100, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 8, outputTokens: 9 } }),
      ev(2, T0 + 150, 'turn/end', { turn: 1, reason: 'completed' }),
      ev(5, T0 + 5000, 'step/start', { turn: 2, step: 1 }),
    ] }],
  ])
  await collectorE.backfill(mockPersistence(logsE), { list: () => [{ id: 'e1' }] })
  const eIds = storeE.calls.request.map((r) => r.id)
  ok(eIds.includes('e1:1:1:0'), 'race fix: prefix replayed via the in-memory boundary')
  eq(eIds.filter((id) => id === 'e1:2:1:0').length, 1, 'race fix: live-owned tail emitted once by the live pass, never re-replayed')
  ok(storeE.calls.markBackfilled.some((b) => b.includes('e1')), 'race-fixed session marked backfilled')
  ok(!(collectorE.status.deferredSessions ?? []).includes('e1'), 'race fix: not deferred')

  // ── fix regression: off-window gap catch-up on first live observation ──
  // (plugin disabled/upgraded while the session kept persisting events)
  const storeF = mockStore()
  storeF.setCursor({ backfilledSessions: ['f1'], liveFirstSeq: { f1: 3 } })
  storeF.sessions.set('f1', { lastSeq: 9 })
  const logsF = new Map([
    ['f1', { header: { id: 'f1' }, inheritedEventCount: 0, events: [
      // accounted prefix (seq ≤ 9) — must NOT be re-recorded
      ev(0, T0, 'step/start', { turn: 1, step: 1 }),
      ev(1, T0 + 10, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 1, outputTokens: 1 } }),
      // the off-window gap (10..19): never accounted, never live-observed
      ev(10, T0 + 1000, 'step/start', { turn: 2, step: 1 }),
      ev(11, T0 + 1100, 'assistant/message', { turn: 2, step: 1, message: {}, usage: { inputTokens: 20, outputTokens: 5 } }),
      ev(12, T0 + 1200, 'turn/end', { turn: 2, reason: 'completed' }),
      // a request still running at the gap boundary — live pass owns it
      ev(13, T0 + 1300, 'step/start', { turn: 3, step: 1 }),
      // live-owned (≥ 20)
      ev(20, T0 + 2000, 'turn/end', { turn: 3, reason: 'interrupted' }),
    ] }],
  ])
  const collectorF = new LedgerCollector({ store: storeF, concurrency: 1 })
  const handlersF = new Map()
  collectorF.start({ on(name, fn) { handlersF.set(name, fn); return () => handlersF.delete(name) } })
  // f1 is LIVE (it produces a live event below) — the 2026-11-17 sweep's
  // no-go zone is exactly live sessions; its gap stays the live path's.
  await collectorF.backfill(mockPersistence(logsF), { list: () => [{ id: 'f1' }] }) // cursor owns f1 → nothing replayed
  handlersF.get('session/event')({ id: 'f1', header: {} }, ev(20, T0 + 2000, 'turn/end', { turn: 3, reason: 'interrupted' }))
  await new Promise((resolve) => setTimeout(resolve, 50)) // fire-and-forget catch-up settles
  const fIds = storeF.calls.request.map((r) => r.id)
  ok(fIds.includes('f1:2:1:0'), 'gap catch-up replays the off-window range')
  ok(!fIds.includes('f1:1:1:0'), 'gap catch-up does not re-replay the accounted prefix')
  ok(!fIds.includes('f1:3:1:0'), 'gap catch-up drops records still running at the boundary')
  const fTurnSeqs = storeF.calls.turn.map((m) => m.seq).sort((a, b) => a - b)
  eq(fTurnSeqs.join(','), '12,20', 'turn markers: gap seq 12 + live seq 20, each exactly once')
  eq(storeF.sessions.get('f1')?.lastSeq, 20, 'live turn/end advances the persisted high-water')

  // ── fix regression: dispose tail catch-up (cursor session closed without a
  //    single event this activation — its off-window tail has no live trigger) ──
  const storeG = mockStore()
  storeG.setCursor({ backfilledSessions: ['g1'], liveFirstSeq: { g1: 2 } })
  storeG.sessions.set('g1', { lastSeq: 4 })
  const logsG = new Map([
    ['g1', { header: { id: 'g1' }, inheritedEventCount: 0, events: [
      // accounted prefix (seq ≤ 4)
      ev(0, T0, 'step/start', { turn: 1, step: 1 }),
      ev(1, T0 + 10, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 1, outputTokens: 1 } }),
      // off-window tail (≥ 5): closed while the plugin was off
      ev(5, T0 + 1000, 'step/start', { turn: 2, step: 1 }),
      ev(6, T0 + 1100, 'assistant/message', { turn: 2, step: 1, message: {}, usage: { inputTokens: 30, outputTokens: 4 } }),
      ev(7, T0 + 1200, 'turn/end', { turn: 2, reason: 'completed' }),
    ] }],
  ])
  const collectorG = new LedgerCollector({ store: storeG, concurrency: 1 })
  const handlersG = new Map()
  collectorG.start({ on(name, fn) { handlersG.set(name, fn); return () => handlersG.delete(name) } })
  // g1 is LIVE until its dispose below — the sweep must leave it alone.
  await collectorG.backfill(mockPersistence(logsG), { list: () => [{ id: 'g1' }] }) // cursor owns g1 → nothing replayed
  handlersG.get('session/disposed')({ id: 'g1', header: {} })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const gIds = storeG.calls.request.map((r) => r.id)
  ok(gIds.includes('g1:2:1:0'), 'dispose catch-up replays the unaccounted tail')
  ok(!gIds.includes('g1:1:1:0'), 'dispose catch-up skips the accounted prefix')
  ok(storeG.calls.turn.some((m) => m.seq === 7), 'dispose catch-up records the tail turn marker')

  // ── fold flush dropRunning: still-running records never leak into a gap replay ──
  {
    const foldH = new RequestFold({ sessionId: 'h1' })
    foldH.fold(ev(0, T0, 'step/start', { turn: 1, step: 1 }))
    foldH.fold(ev(1, T0 + 10, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 2, outputTokens: 2 } }))
    foldH.fold(ev(2, T0 + 20, 'step/start', { turn: 2, step: 1 })) // running at range end
    const dropped = foldH.flush({ dropRunning: true })
    eq(dropped.requests.length, 1, 'flush dropRunning drops still-running records')
    eq(dropped.requests[0]?.id, 'h1:1:1:0', 'flush dropRunning keeps closed records')
    const kept = foldH.flush()
    eq(kept.requests.length, 2, 'flush default keeps running records')
  }

  // ── fix regression: a live-observed session's marks ungate after its
  //    prefix replay (the reset-rescan window: marks were gated while the
  //    cursor was mid-rebuild) ──
  const storeI = mockStore()
  const collectorI = new LedgerCollector({ store: storeI, concurrency: 1 })
  const handlersI = new Map()
  collectorI.start({ on(name, fn) { handlersI.set(name, fn); return () => handlersI.delete(name) } })
  const iHandle = { id: 'i1', header: {} }
  handlersI.get('session/event')(iHandle, ev(5, T0, 'step/start', { turn: 2, step: 1 })) // first obs, no KV boundary yet
  handlersI.get('session/event')(iHandle, ev(6, T0 + 50, 'turn/end', { turn: 2, reason: 'completed' })) // gated mark
  const logsI = new Map([
    ['i1', { header: { id: 'i1' }, inheritedEventCount: 0, events: [
      ev(0, T0 - 1000, 'step/start', { turn: 1, step: 1 }),
      ev(1, T0 - 900, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 6, outputTokens: 6 } }),
      ev(2, T0 - 800, 'turn/end', { turn: 1, reason: 'completed' }),
      ev(5, T0, 'step/start', { turn: 2, step: 1 }),
      ev(6, T0 + 50, 'turn/end', { turn: 2, reason: 'completed' }),
    ] }],
  ])
  storeI.sessions.set('i1', { lastSeq: -1 })
  await collectorI.backfill(mockPersistence(logsI), { list: () => [{ id: 'i1' }] })
  eq(storeI.sessions.get('i1')?.lastSeq, 6, 'reset-rescan window: prefix replay + ungated live claim covers the live span')
  ok(collectorI.liveContiguous.has('i1'), 'reset-rescan window: session marked contiguous after prefix replay')

  // ── regression guard (2026-11-17): the inherited prefix is skipped
  //    UNCONDITIONALLY — host invariant (dsh-session-persistence-jsonl,
  //    toHeaderLine): "seeded session header requires an inherited event
  //    count" / "unseeded session header inherited event count must be 0",
  //    i.e. cut > 0 ⟺ isSeeded. A seeded fork child carries NO parentSession
  //    (session-6519d23a: isSeeded, no parentSession, cut=691, its [0,691)
  //    prefix fully overlaps parent session-2841fa4b) — gating the skip on
  //    header.parentSession would double-count ~6.3M. Unseeded sessions
  //    (resume included) report cut = 0: the skip is a no-op and the whole
  //    log replays. ──
  const seedEvents = [
    // inherited span (below the cut) — owned by the PARENT's replay
    ev(0, T0, 'step/start', { turn: 1, step: 1 }),
    ev(1, T0 + 100, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 40, outputTokens: 40 } }),
    ev(2, T0 + 200, 'turn/end', { turn: 1, reason: 'completed' }),
    // own span (above the cut)
    ev(3, T0 + 1000, 'step/start', { turn: 2, step: 1 }),
    ev(4, T0 + 1100, 'assistant/message', { turn: 2, step: 1, message: {}, usage: { inputTokens: 4, outputTokens: 5 } }),
    ev(5, T0 + 1200, 'turn/end', { turn: 2, reason: 'completed' }),
  ]
  const logsJ = new Map([
    // j1: seeded fork child, NO parentSession in the header (like 6519d23a).
    ['j1', { header: { id: 'j1' }, inheritedEventCount: 3, events: seedEvents }],
    // k1: subagent fork child (header DOES carry parentSession).
    ['k1', { header: { id: 'k1', parentSession: 'kp' }, inheritedEventCount: 3, events: seedEvents }],
    // j2: unseeded session (cut = 0) — whole log, both spans.
    ['j2', { header: { id: 'j2' }, inheritedEventCount: 0, events: seedEvents }],
  ])
  const storeJ = mockStore()
  const collectorJ = new LedgerCollector({ store: storeJ, concurrency: 2 })
  await collectorJ.backfill(mockPersistence(logsJ), noLiveSessions)
  const jIds = storeJ.calls.request.map((r) => r.id)
  ok(!jIds.includes('j1:1:1:0'), 'seeded fork (no parentSession): inherited prefix yields zero facts — the parent owns it')
  ok(jIds.includes('j1:2:1:0'), 'seeded fork (no parentSession): own span replayed')
  eq(storeJ.calls.request.find((r) => r.id === 'j1:2:1:0')?.computedTotal, 9, 'seeded fork: own tokens counted')
  eq(storeJ.calls.turn.filter((m) => m.sessionId === 'j1').length, 1, 'seeded fork: only the post-cut turn marker')
  eq(storeJ.calls.request.find((r) => r.id === 'j1:2:1:0')?.kind, 'main', 'seeded fork: kind main (header carries no parentSession)')
  ok(!jIds.includes('k1:1:1:0'), 'subagent fork (parentSession): inherited prefix skipped too')
  ok(jIds.includes('k1:2:1:0'), 'subagent fork: own span replayed')
  eq(storeJ.calls.request.find((r) => r.id === 'k1:2:1:0')?.kind, 'subagent', 'subagent fork: kind subagent')
  ok(jIds.includes('j2:1:1:0') && jIds.includes('j2:2:1:0'), 'unseeded (cut=0): whole log replayed — the skip is a no-op')
  eq(storeJ.calls.turn.filter((m) => m.sessionId === 'j2').length, 2, 'unseeded (cut=0): both turn markers recorded')

  // ── fix regression (2026-11-17): startup reconciliation sweep — cursor-
  //    marked DEAD sessions healed (offline tail hole / zero-mark victim);
  //    live and unmarked sessions are the sweep's no-go zones ──
  const logsL = new Map([
    // w1: dead, cursor-marked, row lastSeq=5 but the log runs to 21 — the
    // plugin was fully off while (5, 21] was persisted, then it closed.
    ['w1', { header: { id: 'w1' }, inheritedEventCount: 0, events: [
      ev(0, T0, 'step/start', { turn: 1, step: 1 }),
      ev(1, T0 + 10, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 1, outputTokens: 1 } }),
      ev(2, T0 + 20, 'turn/end', { turn: 1, reason: 'completed' }),
      ev(3, T0 + 30, 'step/start', { turn: 2, step: 1 }),
      ev(4, T0 + 40, 'assistant/message', { turn: 2, step: 1, message: {}, usage: { inputTokens: 2, outputTokens: 2 } }),
      ev(5, T0 + 50, 'turn/end', { turn: 2, reason: 'completed' }),
      ev(6, T0 + 1000, 'step/start', { turn: 3, step: 1 }),
      ev(20, T0 + 2000, 'assistant/message', { turn: 3, step: 1, message: {}, usage: { inputTokens: 7, outputTokens: 7 } }),
      ev(21, T0 + 2100, 'turn/end', { turn: 3, reason: 'completed' }),
    ] }],
    // w2: dead, cursor-marked, NO session row (zero-mark victim) — full replay.
    ['w2', { header: { id: 'w2' }, inheritedEventCount: 0, events: [
      ev(0, T0, 'step/start', { turn: 1, step: 1 }),
      ev(1, T0 + 10, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 5, outputTokens: 5 } }),
      ev(2, T0 + 20, 'turn/end', { turn: 1, reason: 'completed' }),
    ] }],
    // w3: dead, cursor-marked, row lastSeq == log maxSeq — caught up.
    ['w3', { header: { id: 'w3' }, inheritedEventCount: 0, events: [
      ev(0, T0, 'step/start', { turn: 1, step: 1 }),
      ev(1, T0 + 10, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 6, outputTokens: 6 } }),
      ev(2, T0 + 20, 'turn/end', { turn: 1, reason: 'completed' }),
    ] }],
    // w4: NOT cursor-marked — the main scan owns it, the sweep must not.
    ['w4', { header: { id: 'w4' }, inheritedEventCount: 0, events: [
      ev(0, T0, 'step/start', { turn: 1, step: 1 }),
      ev(1, T0 + 10, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 8, outputTokens: 8 } }),
      ev(2, T0 + 20, 'turn/end', { turn: 1, reason: 'completed' }),
    ] }],
    // w5: LIVE, cursor-marked, row lastSeq=0 with usage above it — the sweep
    // must leave it to catchUpLiveGap/disposeCatchUp (liveContiguous gate).
    ['w5', { header: { id: 'w5' }, inheritedEventCount: 0, events: [
      ev(0, T0, 'step/start', { turn: 1, step: 1 }),
      ev(1, T0 + 10, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 9, outputTokens: 9 } }),
      ev(2, T0 + 20, 'turn/end', { turn: 1, reason: 'completed' }),
    ] }],
  ])
  const storeL = mockStore()
  storeL.setCursor({ backfilledSessions: ['w1', 'w2', 'w3', 'w5'], liveFirstSeq: {} })
  storeL.sessions.set('w1', { lastSeq: 5 })
  storeL.sessions.set('w3', { lastSeq: 2 })
  storeL.sessions.set('w5', { lastSeq: 0 })
  const collectorL = new LedgerCollector({ store: storeL, concurrency: 1 })
  await collectorL.backfill(mockPersistence(logsL), { list: () => [{ id: 'w5' }] })
  const lIds = storeL.calls.request.map((r) => r.id)
  ok(lIds.includes('w1:3:1:0'), 'sweep: offline tail hole (5, 21] replayed')
  ok(!lIds.includes('w1:1:1:0') && !lIds.includes('w1:2:1:0'), 'sweep: accounted prefix untouched')
  ok(storeL.calls.turn.some((m) => m.sessionId === 'w1' && m.seq === 21), 'sweep: tail turn marker recorded')
  eq(storeL.sessions.get('w1')?.lastSeq, 21, 'sweep: high-water advanced to the log max')
  ok(lIds.includes('w2:1:1:0'), 'sweep: zero-mark victim (no row) fully replayed from seq 0')
  eq(storeL.calls.turn.filter((m) => m.sessionId === 'w2').length, 1, 'sweep: zero-mark victim turn marker')
  ok(!lIds.some((id) => id.startsWith('w3:')), 'sweep: caught-up session writes nothing')
  eq(storeL.calls.markSessionSeq.filter(([id]) => id === 'w3').length, 0, 'sweep: caught-up session never marked')
  eq(lIds.filter((id) => id === 'w4:1:1:0').length, 1, 'sweep: unmarked session left to the main scan (exactly once)')
  ok(storeL.calls.markBackfilled.some((b) => b.includes('w4')), 'sweep scenario: main scan still marks unmarked sessions')
  ok(!lIds.some((id) => id.startsWith('w5:')), 'sweep: live session untouched (gap belongs to the live path)')
  eq(collectorL.status.sweep?.checked, 3, 'sweep status: checked = dead cursor sessions (w1, w2, w3)')
  eq(collectorL.status.sweep?.replayed, 2, 'sweep status: replayed = w1 tail + w2 full')
  eq(collectorL.status.error, undefined, 'sweep scenario: clean run leaves status.error unset')

  // ── modelStore：真实 store 的微缩模型（task-6 回归专用）──────────────────
  // 固定语义（0.1.3）：request/tool 的 upsert delta 基准 = 永久锚（prune 不删、
  // reset 清）；turn marker 以 (session, seq) 锚去重。legacy: true 复刻 0.1.2 的
  // 缺陷语义（delta 基准 = 可被 prune 清空的明细行、turn marker 无去重）——
  // 先在 mock 层复现事故指纹，再验证修复语义严格幂等。backing 共享 = 重开/重建
  // 实例看到的持久状态（KV + SQLite 锚/明细）；lastPruneDay 是实例状态（重挂载
  // 的新实例首写先 prune——候选机制 (a) 的放大器）。
  function modelStore({ backing, legacy = false, cutoffDay = dayKey(T0 + 35 * 86400000) } = {}) {
    const b = backing ?? {
      dayTokens: new Map(), dayTurns: new Map(),
      sessionTokens: new Map(), sessionTurns: new Map(),
      sessions: new Map(), // id → { lastSeq }
      cursor: { backfilledSessions: [], liveFirstSeq: {} },
      detail: new Map(), // factId → fact（30 天滚动明细，prune 删）
      anchors: new Map(), // factId → fact（永久 delta 锚，prune 不删）
      turnAnchors: new Set(), // `${sid}|${seq}`
    }
    let lastPruneDay = null // 实例状态：重挂载的新实例 = null → 首写先 prune
    const TODAY = todayKey()
    const pruneDetail = () => {
      for (const [id, f] of b.detail) if (f.day < cutoffDay) b.detail.delete(id)
    }
    const store = {
      backing: b,
      legacy,
      calls: { markSessionSeq: [], markBackfilled: [], prune: 0 },
      /** 当前 day/session 两面计数快照（verify-usage 判据 [d]/[e] 的 mock 面）。 */
      modelTotals: () => ({
        days: new Map(b.dayTokens), dayTurns: new Map(b.dayTurns),
        sessions: new Map(b.sessionTokens), sessionTurns: new Map(b.sessionTurns),
      }),
      async reset(boundaries) {
        b.dayTokens.clear(); b.dayTurns.clear()
        b.sessionTokens.clear(); b.sessionTurns.clear()
        b.sessions.clear(); b.detail.clear(); b.anchors.clear(); b.turnAnchors.clear()
        b.cursor = { backfilledSessions: [], liveFirstSeq: Object.fromEntries([...(boundaries ?? new Map())]) }
        lastPruneDay = null
      },
      async prune() { lastPruneDay = TODAY; pruneDetail(); store.calls.prune++ },
      recordRequest(f) {
        if (lastPruneDay !== TODAY) { lastPruneDay = TODAY; pruneDetail() } // 重建实例首写先 prune
        const old = legacy ? b.detail.get(f.id) : (b.anchors.get(f.id) ?? b.detail.get(f.id))
        const delta = f.computedTotal - (old ? old.computedTotal : 0)
        if (delta !== 0) {
          b.dayTokens.set(f.day, (b.dayTokens.get(f.day) ?? 0) + delta)
          b.sessionTokens.set(f.sessionId, (b.sessionTokens.get(f.sessionId) ?? 0) + delta)
        }
        if (!b.sessions.has(f.sessionId)) b.sessions.set(f.sessionId, { lastSeq: -1 })
        b.detail.set(f.id, f)
        if (!legacy) b.anchors.set(f.id, f)
      },
      recordToolCall(f) {
        if (!b.sessions.has(f.sessionId)) b.sessions.set(f.sessionId, { lastSeq: -1 })
        b.detail.set(f.id, f)
        if (!legacy) b.anchors.set(f.id, f)
      },
      recordTurn(marker) {
        if (!legacy && typeof marker.seq === 'number' && Number.isFinite(marker.seq)) {
          const key = `${marker.sessionId}|${Math.round(marker.seq)}`
          if (b.turnAnchors.has(key)) return
          b.turnAnchors.add(key)
        }
        b.dayTurns.set(marker.day, (b.dayTurns.get(marker.day) ?? 0) + 1)
        b.sessionTurns.set(marker.sessionId, (b.sessionTurns.get(marker.sessionId) ?? 0) + 1)
        if (!b.sessions.has(marker.sessionId)) b.sessions.set(marker.sessionId, { lastSeq: -1 })
      },
      recordSessionMeta() {},
      async cursorState() { return { cursor: { backfilledSessions: [...b.cursor.backfilledSessions], liveFirstSeq: { ...b.cursor.liveFirstSeq } } } },
      async markBackfilled(ids) { b.cursor.backfilledSessions = [...new Set([...b.cursor.backfilledSessions, ...ids])]; store.calls.markBackfilled.push(ids) },
      async markLiveSequence() {},
      async sessionHighSeq(id) { const row = b.sessions.get(id); return row ? (row.lastSeq ?? -1) : null },
      async markSessionSeq(id, seq) {
        store.calls.markSessionSeq.push([id, seq])
        const row = b.sessions.get(id)
        if (row && (row.lastSeq ?? -1) < seq) row.lastSeq = seq
      },
    }
    return store
  }

  // ── task-6 场景夹具：p1 = 全部历史在 prune 截止之前的死会话（e855f1eb 型）；
  //    p2 = 全部数据在 30 天窗口内的死会话（7 个未翻倍会话型）──────────────
  const OLD_T = T0
  const REC_T = T0 + 40 * 86400000
  const incidentEvents = (t0) => [
    ev(0, t0, 'step/start', { turn: 1, step: 1 }),
    ev(1, t0 + 100, 'assistant/message', { turn: 1, step: 1, message: {}, usage: { inputTokens: 1000, outputTokens: 1000 } }),
    ev(2, t0 + 200, 'turn/end', { turn: 1, reason: 'completed' }),
    ev(3, t0 + 1000, 'step/start', { turn: 2, step: 1 }),
    ev(4, t0 + 1100, 'assistant/message', { turn: 2, step: 1, message: {}, usage: { inputTokens: 2000, outputTokens: 2000 } }),
    ev(5, t0 + 1200, 'turn/end', { turn: 2, reason: 'completed' }),
  ]
  const logsIncident = new Map([
    ['p1', { header: { id: 'p1' }, inheritedEventCount: 0, events: incidentEvents(OLD_T) }],
    ['p2', { header: { id: 'p2' }, inheritedEventCount: 0, events: incidentEvents(REC_T) }],
  ])

  // ── 复现序列（发布验收 09:26→09:45）：reset 清空 → 重扫标记（各记一次 +
  //    trusted 标记 maxSeq）→「重挂载」窗口（store 重建：新实例 lastPruneDay=null
  //    → 首写先 prune 清旧明细 —— 候选 (a) 的放大器；行高水位丢失 —— 候选 (b) 的
  //    状态，无论宿主哪条路径造成）→ 新 collector 的 boot sweep 全量重放 ──
  const runIncident = async (legacy) => {
    const m = modelStore({ legacy })
    const c1 = new LedgerCollector({ store: m, concurrency: 1 })
    await c1.backfill(mockPersistence(logsIncident), noLiveSessions)
    const once = m.modelTotals()
    const m2 = modelStore({ backing: m.backing, legacy })
    for (const row of m2.backing.sessions.values()) row.lastSeq = -1 // 高水位丢失
    const c2 = new LedgerCollector({ store: m2, concurrency: 1 })
    await c2.backfill(mockPersistence(logsIncident), noLiveSessions)
    return { once, twice: m2.modelTotals(), sweep: c2.status.sweep }
  }

  // ── 场景 P（task-6 主复现）：legacy 语义复现事故指纹；修复语义严格不变 ──
  const legacyRun = await runIncident(true)
  eq(legacyRun.once.sessions.get('p1'), 6000, '复现前置：重扫各记一次（p1=6000）')
  eq(legacyRun.once.sessions.get('p2'), 6000, '复现前置：p2=6000')
  eq(legacyRun.twice.sessions.get('p1'), 12000, '复现：legacy delta 基准=可 prune 明细 → 旧日会话恰好 2×')
  eq(legacyRun.twice.days.get(dayKey(OLD_T)), 12000, '复现：旧日 day 恰好 2×（verify-usage 判据 [e] 会命中）')
  eq(legacyRun.twice.sessions.get('p2'), 6000, '复现：窗口内会话不翻倍（明细行仍在 → delta 幂等）')
  eq(legacyRun.twice.sessionTurns.get('p1'), 4, '复现：turn marker 无去重 → turns 也翻倍')
  eq(legacyRun.sweep.checked, 2, '复现：sweep checked=2（高水位丢失 → 全判落后）')
  eq(legacyRun.sweep.replayed, 2, '复现：sweep replayed=2')
  const fixedRun = await runIncident(false)
  eq(fixedRun.twice.sessions.get('p1'), 6000, '修复：同一序列下旧日会话严格幂等（判据 [d] 语义）')
  eq(fixedRun.twice.days.get(dayKey(OLD_T)), 6000, '修复：旧日 day 计数严格不变（判据 [e] 语义）')
  eq(fixedRun.twice.sessionTurns.get('p1'), 2, '修复：turns 严格不变')
  eq(fixedRun.twice.sessions.get('p2'), 6000, '修复：窗口内事实幂等')

  // ── 场景 M（候选 a）：store 重建（新实例首写先 prune）单独无害 —— 标记完好
  //    时 sweep 零重放、零写入；prune 已跑（旧明细可被清，放大器上膛）──────
  {
    const m = modelStore()
    const c1 = new LedgerCollector({ store: m, concurrency: 1 })
    await c1.backfill(mockPersistence(logsIncident), noLiveSessions)
    ok(!m.backing.detail.has('p1:1:1:0'), '(a) 重扫收尾 prune 已清旧日明细（放大器上膛）')
    const m2 = modelStore({ backing: m.backing })
    const c2 = new LedgerCollector({ store: m2, concurrency: 1 })
    await c2.backfill(mockPersistence(logsIncident), noLiveSessions)
    eq(c2.status.sweep?.checked, 2, '(a) 重建实例 sweep 仍检查两个死会话')
    eq(c2.status.sweep?.replayed, 0, '(a) 标记完好 → 零重放（重建单独无害）')
    ok(m2.calls.prune >= 1, '(a) 重建实例收尾 prune 照跑（lastPruneDay=实例状态）')
    const after = m2.modelTotals()
    eq(after.sessions.get('p1'), 6000, '(a) 重建+prune 后 day/session 计数严格不变')
    eq(after.days.get(dayKey(REC_T)), 6000, '(a) 窗口内 day 计数严格不变')
  }

  // ── 场景 N（候选 b）：重开实例从「陈旧高水位」加载（无论宿主哪条路径丢了
  //    标记）→ sweep 全量重放 → 修复语义下一切计数严格不变，且事后收敛 ──────
  {
    const m = modelStore()
    const c1 = new LedgerCollector({ store: m, concurrency: 1 })
    await c1.backfill(mockPersistence(logsIncident), noLiveSessions)
    const m2 = modelStore({ backing: m.backing })
    for (const row of m2.backing.sessions.values()) row.lastSeq = -1 // 陈旧高水位
    const c2 = new LedgerCollector({ store: m2, concurrency: 1 })
    await c2.backfill(mockPersistence(logsIncident), noLiveSessions)
    eq(c2.status.sweep?.replayed, 2, '(b) 陈旧高水位 → sweep 全量重放')
    const after = m2.modelTotals()
    eq(after.sessions.get('p1'), 6000, '(b) 修复：旧日事实经永久锚 delta-0，session 不变')
    eq(after.days.get(dayKey(OLD_T)), 6000, '(b) 修复：旧日 day 严格不变')
    eq(after.dayTurns.get(dayKey(OLD_T)), 2, '(b) 修复：day turns 严格不变')
    eq(after.sessions.get('p2'), 6000, '(b) 修复：窗口内事实幂等')
    const c3 = new LedgerCollector({ store: m2, concurrency: 1 })
    await c3.backfill(mockPersistence(logsIncident), noLiveSessions)
    eq(c3.status.sweep?.replayed, 0, '(b) 事后收敛：再扫零重放')
  }

  // ── 场景 O（候选 c）：readLog 多代读法否证护栏。宿主源码（dsh-storage-json
  //    per-record-unit）：KV 后端无状态、loadAll 重读目录、putRecord 逐条原子
  //    落盘——不存在「陈旧文件」窗口；实测 e855f1eb 事后 lastSeq=846=其 v4 日志
  //    maxSeq（若 sweep 读到 v3 代会标 147505）。护栏：sweep 重放后 lastSeq 必须
  //    等于「所读日志」的 maxSeq，且重放经锚严格幂等 ────────────────────────
  {
    const m = modelStore()
    const c1 = new LedgerCollector({ store: m, concurrency: 1 })
    await c1.backfill(mockPersistence(logsIncident), noLiveSessions)
    m.backing.sessions.get('p1').lastSeq = 0 // 陈旧低位 → 尾洞重放 (0, ∞)
    const c2 = new LedgerCollector({ store: m, concurrency: 1 })
    await c2.backfill(mockPersistence(logsIncident), noLiveSessions)
    eq(m.backing.sessions.get('p1')?.lastSeq, 5, '(c) 护栏：重放后 lastSeq=所读日志 maxSeq（=5）')
    eq(m.modelTotals().sessions.get('p1'), 6000, '(c) 护栏：尾洞重放经锚严格幂等')
  }

  // ── summary ──
  if (failures > 0) {
    console.error(`\nsmoke FAILED: ${failures}/${checks} checks failed`)
    process.exit(1)
  }
  console.log(`smoke OK: ${checks}/${checks} checks passed`)
}

main().catch((err) => {
  console.error('smoke crashed:', err)
  process.exit(1)
})
