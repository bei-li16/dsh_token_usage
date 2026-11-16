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
 * Run: node src/collector/smoke.mjs   (exit 0 = pass)
 */

import { RequestFold } from './fold.js'
import { LedgerCollector } from './collector.js'
import { dayKey, hourKey } from '../contract.js'

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
  const store2 = mockStore()
  store2.setCursor({ backfilledSessions: ['s1', 's2', 's3'], liveFirstSeq: {} })
  const collector2 = new LedgerCollector({ store: store2, concurrency: 4 })
  await collector2.backfill(mockPersistence(logs), noLiveSessions)
  eq(store2.calls.request.length, 0, 'second pass with full cursor replays nothing')
  eq(collector2.status.total, 0, 'second pass total 0')

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
  await collectorF.backfill(mockPersistence(logsF), noLiveSessions) // cursor owns f1 → nothing replayed
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
  await collectorG.backfill(mockPersistence(logsG), noLiveSessions) // cursor owns g1 → nothing replayed
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
