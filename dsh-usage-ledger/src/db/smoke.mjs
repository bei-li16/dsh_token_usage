// dsh-usage-ledger/src/db/smoke.mjs — 存储层冒烟测试（不依赖宿主）。
//
// 设计：用真实 node:sqlite（tmp 目录）+ 内存版 fake storageDomain（共享
// backing Map，模拟重开后数据仍在）驱动 store.js 全合同面。断言数字全部
// 手算：upsert 纠偏（running→completed/failed 的 requests/failures delta）、
// 跨天明细、prune 只删明细不删 rollup、重开持久、reset、KV-only 降级路径。
// 运行：node src/db/smoke.mjs（包根目录或任意 cwd 均可）。结尾清理 tmp。

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLedgerStore } from './store.js'
import { todayKey, dayMinus } from '../contract.js'

// ── fake storageDomain：backing 共享 → 同一实例多次 open 模拟进程重开 ──────
function makeFakeStorageDomain() {
  const backing = { tables: new Map(), global: null }
  const open = async (spec) => {
    for (const name of Object.keys(spec.tables)) {
      if (!backing.tables.has(name)) backing.tables.set(name, new Map())
    }
    const makeTable = (map) => ({
      get: (key) => map.get(key),
      entries: () => [...map.entries()][Symbol.iterator](),
      keys: () => [...map.keys()][Symbol.iterator](),
      get size() { return map.size },
      put: async (key, value) => { map.set(key, value) },
      delete: async (key) => map.delete(key),
      deleteMany: async (keys) => {
        let n = 0
        for (const key of keys) if (map.delete(key)) n += 1
        return n
      },
      update: async (key, fn) => {
        if (!map.has(key)) throw new Error(`domain '${spec.name}' table has no record '${key}' to update`)
        const next = fn(map.get(key))
        map.set(key, next)
        return next
      },
    })
    return {
      name: spec.name,
      table: (name) => makeTable(backing.tables.get(name)),
      global: {
        get: () => backing.global ?? spec.global.initial,
        set: async (value) => { backing.global = value },
      },
      close: async () => {},
    }
  }
  return { open, backing }
}

const logger = { warn: () => {}, info: () => {} }
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps
/** 所有创建的 store：断言中途失败时也要 dispose，否则 SQLite 句柄锁文件、tmp 清不掉。 */
const stores = []
const makeStore = (deps) => {
  const store = createLedgerStore(deps)
  stores.push(store)
  return store
}

const tmp = mkdtempSync(join(tmpdir(), 'usage-ledger-smoke-'))
const factsDbPath = join(tmp, 'facts.db')

const today = todayKey()
const day5 = dayMinus(today, 5)
const day40 = dayMinus(today, 40)
/** 本地时刻：new Date('YYYY-MM-DDTHH:MM') 按本地时区解析，day/hour 由归一化推导。 */
const at = (day, hh, mm = 0) => new Date(`${day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`).getTime()

async function main() {
  const storageDomain = makeFakeStorageDomain()
  const store = makeStore({ storageDomain, config: { retentionDays: 30, factsDbPath }, logger })
  await store.ready()
  assert.equal(store.status().backend, 'sqlite', 'sqlite backend expected')

  // ── 写入：request（含 upsert 纠偏与 status 转换）────────────────────────
  store.recordRequest({ id: 's1:1:1:0', sessionId: 's1', parentId: null, kind: 'main', turn: 1, step: 1, attempt: 0, time: at(today, 3), provider: 'openai', model: 'gpt-x', status: 'running' })
  store.recordRequest({ id: 's1:1:1:0', sessionId: 's1', parentId: null, kind: 'main', turn: 1, step: 1, attempt: 0, time: at(today, 3), finishedAt: at(today, 3) + 1200, provider: 'openai', model: 'gpt-x', status: 'completed', inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, firstTokenMs: 200, decodeMs: 1000 })
  store.recordRequest({ id: 's1:1:2:0', sessionId: 's1', parentId: null, kind: 'main', turn: 1, step: 2, attempt: 0, time: at(today, 3), finishedAt: at(today, 3) + 2500, provider: 'openai', model: 'gpt-x', status: 'completed', inputTokens: 200, outputTokens: 100, firstTokenMs: 400, decodeMs: 2000 })
  store.recordRequest({ id: 's2:1:1:0', sessionId: 's2', parentId: 's1', kind: 'subagent', turn: 1, step: 1, attempt: 0, time: at(today, 14), finishedAt: at(today, 14) + 500, provider: 'anthropic', model: 'claude', status: 'failed', inputTokens: 10, outputTokens: 5 })
  store.recordRequest({ id: 's1:2:1:0', sessionId: 's1', parentId: null, kind: 'main', turn: 2, step: 1, attempt: 0, time: at(today, 15), provider: '', model: '', status: 'running' })
  store.recordRequest({ id: 's1:2:1:0', sessionId: 's1', parentId: null, kind: 'main', turn: 2, step: 1, attempt: 0, time: at(today, 15), finishedAt: at(today, 15) + 300, provider: '', model: '', status: 'failed', inputTokens: 20, outputTokens: 10 })
  store.recordRequest({ id: 's1:5:1:0', sessionId: 's1', parentId: null, kind: 'main', turn: 5, step: 1, attempt: 0, time: at(day5, 10), finishedAt: at(day5, 10) + 900, provider: 'openai', model: 'gpt-y', status: 'completed', inputTokens: 40, outputTokens: 20 })
  store.recordRequest({ id: 's1:9:1:0', sessionId: 's1', parentId: null, kind: 'main', turn: 9, step: 1, attempt: 0, time: at(day40, 10), finishedAt: at(day40, 10) + 900, provider: 'openai', model: 'gpt-x', status: 'completed', inputTokens: 800, outputTokens: 200 })

  // ── 写入：tool（含 running→completed 纠偏）──────────────────────────────
  store.recordToolCall({ id: 's1:c1', sessionId: 's1', parentId: null, kind: 'main', turn: 1, step: 1, name: 'read', time: at(today, 3), status: 'running' })
  store.recordToolCall({ id: 's1:c1', sessionId: 's1', parentId: null, kind: 'main', turn: 1, step: 1, name: 'read', time: at(today, 3), finishedAt: at(today, 3) + 100, status: 'completed', durationMs: 100 })
  store.recordToolCall({ id: 's1:c2', sessionId: 's1', parentId: null, kind: 'main', turn: 2, step: 1, name: 'grep', time: at(today, 14), finishedAt: at(today, 14) + 50, status: 'failed', durationMs: 50 })
  store.recordToolCall({ id: 's2:c3', sessionId: 's2', parentId: 's1', kind: 'subagent', turn: 1, step: 1, name: 'read', time: at(today, 14), finishedAt: at(today, 14) + 200, status: 'completed', durationMs: 200 })

  // ── 写入：turn 与 session meta ─────────────────────────────────────────
  store.recordTurn({ sessionId: 's1', parentId: null, kind: 'main', time: at(today, 3), day: today })
  store.recordTurn({ sessionId: 's1', parentId: null, kind: 'main', time: at(today, 15), day: today })
  store.recordTurn({ sessionId: 's2', parentId: 's1', kind: 'subagent', time: at(today, 14), day: today })
  store.recordSessionMeta({ id: 's1', parentId: null, kind: 'main', name: 'root-session' })
  store.recordSessionMeta({ id: 's2', parentId: 's1', kind: 'subagent', name: 'child-agent' })
  await store.flush()

  // ── summary：手算全字段 ─────────────────────────────────────────────────
  const summary = await store.summary()
  assert.equal(summary.tokens, 1585, 'summary.tokens')
  assert.equal(summary.inputTokens, 1170, 'summary.inputTokens')
  assert.equal(summary.outputTokens, 385, 'summary.outputTokens')
  assert.equal(summary.cacheReadTokens, 20, 'summary.cacheReadTokens')
  assert.equal(summary.cacheWriteTokens, 10, 'summary.cacheWriteTokens')
  assert.equal(summary.requests, 6, 'summary.requests（upsert 不重复计数）')
  assert.equal(summary.failures, 2, 'summary.failures（running→failed 只 +1）')
  assert.equal(summary.turns, 3, 'summary.turns')
  assert.equal(summary.toolCalls, 3, 'summary.toolCalls')
  assert.equal(summary.activeDays, 3, 'summary.activeDays')
  assert.equal(summary.firstDay, day40, 'summary.firstDay')
  assert.equal(summary.lastDay, today, 'summary.lastDay')
  assert.deepEqual(summary.peakDay, { day: day40, tokens: 1000 }, 'summary.peakDay')
  assert.equal(summary.streakDays, 1, 'summary.streakDays（昨天不活跃）')
  assert.equal(summary.avgFirstTokenMs, 300, 'summary.avgFirstTokenMs')
  assert.ok(approx(summary.cacheHitRate, (20 / 1200) * 100), 'summary.cacheHitRate')
  assert.ok(approx(summary.errorRate, (2 / 6) * 100), 'summary.errorRate')
  assert.ok(approx(summary.tokensPerSecond, 50), 'summary.tokensPerSecond')
  assert.equal(summary.degraded, false, 'summary.degraded')

  // ── daily（day 粒度 + model 分组 + 零填充）─────────────────────────────
  const daily = await store.daily({ from: day5, to: today, group: 'model', granularity: 'day' })
  assert.equal(daily.buckets.length, 6, 'daily 6 天零填充')
  assert.equal(daily.granularity, 'day')
  assert.equal(daily.degraded, false)
  const todayBucket = daily.buckets.find((b) => b.key === today)
  assert.equal(todayBucket.tokens, 525, 'daily today tokens')
  assert.equal(todayBucket.requests, 4, 'daily today requests')
  assert.equal(todayBucket.failures, 2, 'daily today failures')
  assert.equal(todayBucket.turns, 3, 'daily today turns')
  assert.deepEqual(todayBucket.groups, { 'openai/gpt-x': 480, 'anthropic/claude': 15, '(unknown)': 30 }, 'daily today groups')
  const day5Bucket = daily.buckets.find((b) => b.key === day5)
  assert.equal(day5Bucket.tokens, 60, 'daily day5 tokens')
  assert.deepEqual(day5Bucket.groups, { 'openai/gpt-y': 60 }, 'daily day5 groups')
  const midBucket = daily.buckets.find((b) => b.key === dayMinus(today, 2))
  assert.deepEqual(midBucket, { key: dayMinus(today, 2), tokens: 0, requests: 0, failures: 0, turns: 0, groups: {} }, 'daily 中间天空桶')
  assert.deepEqual(
    daily.groupTotals.map((g) => g.key),
    ['openai/gpt-x', 'openai/gpt-y', '(unknown)', 'anthropic/claude'],
    'groupTotals 按值降序',
  )
  assert.equal(daily.groupTotals[0].tokens, 480)
  assert.equal(daily.groupTotals[0].requests, 2)
  assert.ok(approx(daily.groupTotals[0].percent, (480 / 585) * 100), 'groupTotals percent')

  // ── daily（hour 粒度，SQLite GROUP BY + 24 桶零填充）───────────────────
  const hourly = await store.daily({ from: today, to: today, group: 'model', granularity: 'hour' })
  assert.equal(hourly.granularity, 'hour')
  assert.equal(hourly.buckets.length, 24, 'hour 24 桶')
  const h03 = hourly.buckets.find((b) => b.key === `${today}T03`)
  assert.equal(h03.tokens, 480, 'hour 03 tokens')
  assert.equal(h03.requests, 2, 'hour 03 requests')
  assert.deepEqual(h03.groups, { 'openai/gpt-x': 480 }, 'hour 03 groups')
  const h14 = hourly.buckets.find((b) => b.key === `${today}T14`)
  assert.equal(h14.tokens, 15, 'hour 14 tokens')
  assert.equal(h14.failures, 1, 'hour 14 failures')
  const h15 = hourly.buckets.find((b) => b.key === `${today}T15`)
  assert.equal(h15.tokens, 30, 'hour 15 tokens（unknown model）')
  assert.deepEqual(h15.groups, { '(unknown)': 30 }, 'hour 15 groups')

  // ── heatmap ────────────────────────────────────────────────────────────
  const heatmap = await store.heatmap({ weeks: 2 })
  assert.equal(heatmap.days.length, 14, 'heatmap 14 天')
  assert.equal(heatmap.days[13].day, today)
  assert.equal(heatmap.days[13].tokens, 525)
  assert.equal(heatmap.days[8].day, day5)
  assert.equal(heatmap.days[8].tokens, 60)
  assert.equal(heatmap.maxTokens, 525, 'heatmap.maxTokens')

  // ── sessions（分页 + q 过滤）───────────────────────────────────────────
  const sessions = await store.sessions({})
  assert.equal(sessions.total, 2, 'sessions.total')
  assert.equal(sessions.rows[0].id, 's1', 'lastSeen 降序（s1 15:00 最新）')
  const s1Row = sessions.rows.find((r) => r.id === 's1')
  assert.equal(s1Row.tokens, 1570, 's1 tokens（含 day40 明细）')
  assert.equal(s1Row.requests, 5)
  assert.equal(s1Row.failures, 1)
  assert.equal(s1Row.turns, 2)
  assert.equal(s1Row.toolCalls, 2)
  assert.equal(s1Row.name, 'root-session')
  assert.equal(s1Row.firstDay, day40)
  assert.equal(s1Row.lastDay, today)
  const s2Row = sessions.rows.find((r) => r.id === 's2')
  assert.equal(s2Row.tokens, 15)
  assert.equal(s2Row.failures, 1)
  assert.equal(s2Row.parentId, 's1')
  assert.equal(s2Row.kind, 'subagent')
  const filtered = await store.sessions({ q: 'CHILD' })
  assert.equal(filtered.total, 1, 'q 大小写不敏感匹配 name')
  assert.equal(filtered.rows[0].id, 's2')

  // ── sessionDetail（子孙 BFS + 明细聚合）────────────────────────────────
  const detail = await store.sessionDetail('s1')
  assert.equal(detail.degraded, false)
  assert.equal(detail.totals.tokens, 1585, 'detail 含子孙 tokens')
  assert.equal(detail.requests, 6)
  assert.equal(detail.failures, 2)
  assert.equal(detail.records.length, 6, 'prune 前 6 条明细')
  assert.equal(detail.records[0].id, 's1:2:1:0', '明细新的在前')
  assert.deepEqual(
    detail.byModel.map((m) => [m.provider, m.model, m.tokens, m.requests, m.failures]),
    [['openai', 'gpt-x', 1480, 3, 0], ['openai', 'gpt-y', 60, 1, 0], ['', '', 30, 1, 1], ['anthropic', 'claude', 15, 1, 1]],
    'detail.byModel（gpt-x 含 day40 的 1000 tokens / 3 requests）',
  )
  assert.deepEqual(
    detail.tools.map((t) => [t.name, t.calls, t.failures]),
    [['read', 2, 0], ['grep', 1, 1]],
    'detail.tools',
  )
  assert.equal(detail.avgFirstTokenMs, 300, 'detail.avgFirstTokenMs（只算 completed 有值）')
  assert.ok(approx(detail.tokensPerSecond, 50), 'detail.tokensPerSecond')

  // ── tools ──────────────────────────────────────────────────────────────
  const tools = await store.tools({ from: dayMinus(today, 29), to: today })
  assert.deepEqual(
    tools.tools.map((t) => [t.name, t.calls, t.failures, t.avgDurationMs]),
    [['read', 2, 0, 150], ['grep', 1, 1, 50]],
    'tools 聚合',
  )
  assert.ok(approx(tools.tools[0].percent, (2 / 3) * 100), 'tools percent')

  // ── cursor：live 边界 earliest-wins + backfilled 去重 ──────────────────
  await store.markLiveSequence('s1', 42)
  await store.markLiveSequence('s1', 50)
  assert.equal((await store.liveSequences()).get('s1'), 42, 'liveFirstSeq earliest-wins')
  await store.markBackfilled(['s1', 's2', 's1'])
  const cursor = await store.cursorState()
  assert.deepEqual(cursor.cursor.backfilledSessions.sort(), ['s1', 's2'], 'markBackfilled 去重')
  assert.equal(cursor.cursor.liveFirstSeq.s1, 42)

  // ── prune：只删 SQLite 明细，KV rollup 不动 ────────────────────────────
  await store.prune()
  const statusAfterPrune = store.status()
  assert.equal(statusAfterPrune.requestRows, 5, 'prune 删除 day40 明细')
  assert.equal(statusAfterPrune.toolRows, 3, 'tool 明细无超期行')
  assert.equal(statusAfterPrune.lastPruneDay, today)
  assert.equal(statusAfterPrune.kvDays, 3, 'KV rollup 不随 prune 删除')
  const summaryAfterPrune = await store.summary()
  assert.equal(summaryAfterPrune.tokens, 1585, 'prune 后 rollup 总额不变')
  const detailAfterPrune = await store.sessionDetail('s1')
  assert.equal(detailAfterPrune.records.length, 5, 'prune 后明细 5 条')
  assert.equal(detailAfterPrune.totals.tokens, 1585, 'totals 来自永久索引行')

  // ── 模拟重开：新 store 实例，同路径同 domain backing ───────────────────
  await store.dispose()
  const store2 = makeStore({ storageDomain, config: { retentionDays: 30, factsDbPath }, logger })
  await store2.ready()
  const reopenedSummary = await store2.summary()
  assert.equal(reopenedSummary.tokens, 1585, '重开后 rollup 仍在')
  const reopenedDetail = await store2.sessionDetail('s1')
  assert.equal(reopenedDetail.records.length, 5, '重开后 SQLite 明细仍在')
  const reopenedCursor = await store2.cursorState()
  assert.equal(reopenedCursor.cursor.liveFirstSeq.s1, 42, '重开后 cursor 仍在')

  // ── reset：清空 + cursor 置边界 ────────────────────────────────────────
  await store2.reset(new Map([['s1', 7]]))
  const afterReset = await store2.summary()
  assert.equal(afterReset.tokens, 0, 'reset 后 tokens 清零')
  assert.equal(afterReset.requests, 0)
  assert.equal(store2.status().requestRows, 0, 'reset 后明细清空')
  const resetCursor = await store2.cursorState()
  assert.deepEqual(resetCursor.cursor.backfilledSessions, [], 'reset 清空 backfilled')
  assert.deepEqual(resetCursor.cursor.liveFirstSeq, { s1: 7 }, 'reset 置 live 边界')
  assert.equal((await store2.sessions({})).total, 0, 'reset 清空 sessions')
  await store2.dispose()

  // ── 降级路径：factsDbPath 不可写 → 纯 KV，rollup 照记 ──────────────────
  const blocker = join(tmp, 'blocker')
  writeFileSync(blocker, 'x')
  const degradedDomain = makeFakeStorageDomain()
  const store3 = makeStore({
    storageDomain: degradedDomain,
    config: { retentionDays: 30, factsDbPath: join(blocker, 'facts.db') },
    logger,
  })
  await store3.ready()
  const st3 = store3.status()
  assert.equal(st3.backend, 'kv', '降级后 backend=kv')
  assert.equal(st3.degraded, true)
  assert.equal(st3.sqliteOk, false)
  assert.equal(st3.kvOk, true)
  assert.ok(typeof st3.backendError === 'string' && st3.backendError.length > 0, 'backendError 记录探测原因')

  store3.recordRequest({ id: 's9:1:1:0', sessionId: 's9', parentId: null, kind: 'main', turn: 1, step: 1, attempt: 0, time: at(today, 8), provider: 'openai', model: 'gpt-x', status: 'running' })
  store3.recordRequest({ id: 's9:1:1:0', sessionId: 's9', parentId: null, kind: 'main', turn: 1, step: 1, attempt: 0, time: at(today, 8), finishedAt: at(today, 8) + 800, provider: 'openai', model: 'gpt-x', status: 'completed', inputTokens: 60, outputTokens: 40, decodeMs: 800 })
  // 降级模式的 status 转换（recentFacts 做 delta 基准）：running→failed
  store3.recordRequest({ id: 's9:2:1:0', sessionId: 's9', parentId: null, kind: 'main', turn: 2, step: 1, attempt: 0, time: at(today, 9), provider: 'openai', model: 'gpt-x', status: 'running' })
  store3.recordRequest({ id: 's9:2:1:0', sessionId: 's9', parentId: null, kind: 'main', turn: 2, step: 1, attempt: 0, time: at(today, 9), finishedAt: at(today, 9) + 100, provider: 'openai', model: 'gpt-x', status: 'failed', inputTokens: 5, outputTokens: 5 })
  store3.recordToolCall({ id: 's9:c1', sessionId: 's9', parentId: null, kind: 'main', turn: 1, step: 1, name: 'read', time: at(today, 8), status: 'running' })
  store3.recordToolCall({ id: 's9:c1', sessionId: 's9', parentId: null, kind: 'main', turn: 1, step: 1, name: 'read', time: at(today, 8), finishedAt: at(today, 8) + 80, status: 'completed', durationMs: 80 })
  await store3.flush()

  const sum3 = await store3.summary()
  assert.equal(sum3.tokens, 110, '降级模式 rollup 照记')
  assert.equal(sum3.requests, 2, '降级模式 upsert 不重复计数')
  assert.equal(sum3.failures, 1, '降级模式 status 转换 delta')
  assert.equal(sum3.degraded, true)
  const daily3 = await store3.daily({ from: today, to: today, granularity: 'hour' })
  assert.equal(daily3.degraded, true, 'KV-only 的 hour 请求回退 day 桶 + degraded')
  assert.equal(daily3.granularity, 'day')
  assert.equal(daily3.buckets.length, 1)
  assert.equal(daily3.buckets[0].tokens, 110)
  const detail3 = await store3.sessionDetail('s9')
  assert.equal(detail3.degraded, true)
  assert.deepEqual(detail3.records, [], 'KV-only records 为空')
  assert.equal(detail3.totals.tokens, 110, 'KV-only totals 来自索引行')
  assert.equal(detail3.index.requests, 2)
  const tools3 = await store3.tools({})
  assert.deepEqual(tools3.tools.map((t) => [t.name, t.calls, t.avgDurationMs]), [['read', 1, 80]], '降级模式 tool rollup')
  await store3.dispose()

  console.log('smoke OK: all assertions passed')
}

main()
  .catch((err) => {
    console.error('smoke FAILED:', err)
    process.exitCode = 1
  })
  .finally(async () => {
    // 先释放全部 SQLite 句柄（Windows 上句柄未关会 EPERM），再带重试清理。
    for (const store of stores) {
      try { await store.dispose() } catch { /* 清理尽力而为 */ }
    }
    rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  })

