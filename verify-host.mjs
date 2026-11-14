// verify-host.mjs — dsh-usage-ledger 宿主侧端到端装配验证（Lead 集成工具，不属于包）。
//
// 用 fake cordis ctx（webServer/sessionPersistence/sessions/storageDomain + on/effect/get）
// 驱动真实 index.js：apply() 接线 → 捕获注册的路由 → 直接以假 req/res 打
// POST /usage-ledger/api/{status,summary,daily,heatmap,sessions,tools}，断言信封与形状。
// SQLite 落在临时 DSH_HOME 下，跑完清理。
//
// 运行：node verify-host.mjs

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const fakeHome = mkdtempSync(join(tmpdir(), 'usage-ledger-verify-'))
process.env.DSH_HOME = fakeHome

const { apply } = await import('./dsh-usage-ledger/index.js')

// ── fake storageDomain（内存 backing，接口对齐宿主 Domain/KvTable）──────────
function fakeTable() {
  const map = new Map()
  return {
    get: (k) => map.get(k),
    entries: () => [...map.entries()][Symbol.iterator](),
    keys: () => [...map.keys()][Symbol.iterator](),
    get size() { return map.size },
    put: async (k, v) => { map.set(k, v) },
    delete: async (k) => map.delete(k),
    deleteMany: async (ks) => { let n = 0; for (const k of ks) if (map.delete(k)) n++; return n },
    update: async (k, fn) => {
      if (!map.has(k)) throw new Error(`no record ${k} to update`)
      const next = fn(map.get(k)); map.set(k, next); return next
    },
  }
}
function fakeStorageDomain() {
  const domains = new Map()
  return {
    async open(spec) {
      if (domains.has(spec.name)) throw new Error(`domain '${spec.name}' is already open`)
      const tables = new Map(Object.keys(spec.tables ?? {}).map((t) => [t, fakeTable()]))
      let globalValue = spec.global ? spec.global.initial : undefined
      const domain = {
        name: spec.name,
        table: (n) => {
          const t = tables.get(n)
          if (!t) throw new Error(`domain '${spec.name}' declares no table '${n}'`)
          return t
        },
        global: { get: () => globalValue, set: async (v) => { globalValue = v } },
        close: async () => { domains.delete(spec.name) },
      }
      domains.set(spec.name, domain)
      return domain
    },
  }
}

// ── fake ctx ──────────────────────────────────────────────────────────────
const routes = []
const disposers = []
const listeners = new Map()
const ctx = {
  storageDomain: fakeStorageDomain(),
  webServer: {
    host: '127.0.0.1',
    protocol: 'http:',
    register(route) { routes.push(route); return () => {} },
  },
  sessionPersistence: { list: async () => [] },
  sessions: { list: () => [], get: () => undefined },
  logger: { warn: (m) => console.warn('[fake-host warn]', m), info: () => {} },
  effect(fn, label) { const d = fn(); if (typeof d === 'function') disposers.push([label, d]) },
  on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) },
  get: () => undefined,
}

apply(ctx, {})

const route = routes.find((r) => r.path === '/usage-ledger/api')
if (!route) throw new Error('route /usage-ledger/api was not registered')

// ── fake HTTP ─────────────────────────────────────────────────────────────
function fakeReq(method, url, body) {
  const payload = body === undefined ? '' : JSON.stringify(body)
  return {
    method,
    url,
    headers: { host: '127.0.0.1:50224', 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() { if (payload) yield payload },
  }
}
function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers ?? {}) },
    end(chunk) { this.body = chunk ?? '' },
    json() { return JSON.parse(this.body) },
  }
}
async function call(method, body, reqOverrides = {}) {
  const req = { ...fakeReq('POST', `/usage-ledger/api/${method}`, body), ...reqOverrides }
  const res = fakeRes()
  await route.handler(req, res)
  return res
}

let passed = 0
function check(name, cond, extra) {
  if (!cond) {
    console.error(`FAIL - ${name}`, extra ?? '')
    process.exitCode = 1
    return
  }
  passed += 1
  console.log(`ok   - ${name}`)
}

// 等采集器 boot 回填（空列表，应秒完）与 store 探测结束。
await new Promise((resolve) => setTimeout(resolve, 500))

const status = await call('status')
check('status 200 + ok 信封', status.statusCode === 200 && status.json().ok === true, status.body)
const statusValue = status.json().value
check('status.backend 为 sqlite（临时 HOME 可写）', statusValue.backend === 'sqlite', JSON.stringify(statusValue))
check('status.backfill 已跑完空扫描', statusValue.backfill && statusValue.backfill.running === false, JSON.stringify(statusValue.backfill))

const summary = await call('summary')
check('summary 200 + 形状', summary.statusCode === 200 && summary.json().value && typeof summary.json().value.tokens === 'number', summary.body)
check('summary 空库零值 + degraded=false', summary.json().value.degraded === false && summary.json().value.requests === 0, summary.body)

const daily = await call('daily', { group: 'model', granularity: 'day' })
const dailyValue = daily.json().value
check('daily 200 + 30 天零填充桶', daily.statusCode === 200 && Array.isArray(dailyValue.buckets) && dailyValue.buckets.length === 30, `buckets=${dailyValue?.buckets?.length}`)
check('daily 桶形状 {key,tokens,requests,failures,turns,groups}', dailyValue.buckets.every((b) => typeof b.key === 'string' && typeof b.tokens === 'number' && typeof b.groups === 'object'), '')

const heatmap = await call('heatmap', { weeks: 8 })
check('heatmap 8*7 天', heatmap.statusCode === 200 && heatmap.json().value.days.length === 56, '')

const sessions = await call('sessions', {})
check('sessions 空列表', sessions.statusCode === 200 && sessions.json().value.total === 0, '')

const tools = await call('tools', {})
check('tools 空列表', tools.statusCode === 200 && Array.isArray(tools.json().value.tools), '')

const evil = await call('status', {}, { headers: { host: 'evil.com' } })
check('evil.com Host → 403', evil.statusCode === 403, '')

const getReq = { method: 'GET', url: '/usage-ledger/api/status', headers: { host: '127.0.0.1:50224' }, async *[Symbol.asyncIterator]() {} }
const getRes = fakeRes()
await route.handler(getReq, getRes)
check('GET → 405', getRes.statusCode === 405, '')

// ── 全链路：合成实时事件 → collector fold → store → 路由查询 ──────────────
const onEvent = listeners.get('session/event')
check('session/event 监听已注册', typeof onEvent === 'function', '')
if (typeof onEvent === 'function') {
  const t0 = Date.now() - 60_000
  const session = { id: 's-e2e', header: { id: 's-e2e' } }
  let seq = 0
  // 显式时间线：step/start t0，首 token t0+800，usage chunk t0+2400，message t0+2600。
  const ev = (type, data, time) => ({ type, seq: seq++, time, data })
  onEvent(session, ev('turn/start', { turn: 1 }, t0))
  onEvent(session, ev('step/start', { turn: 1, step: 1 }, t0))
  onEvent(session, ev('request/context', { provider: 'deepseek', model: 'deepseek-chat' }, t0 + 10))
  onEvent(session, ev('assistant/message', {
    turn: 1, step: 1,
    message: { source: { provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: '你好' }] },
    stream: [
      { type: 'chunk', time: t0 + 800, chunk: { type: 'text-delta', text: '你' } },
      { type: 'chunk', time: t0 + 2400, chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } } },
    ],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  }, t0 + 2600))
  onEvent(session, ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'pwsh', arguments: '{}' }, t0 + 2700))
  onEvent(session, ev('tool/result', { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'c1', content: [] } }, t0 + 3000))
  onEvent(session, ev('turn/end', { turn: 1, reason: 'completed' }, t0 + 3100))
  const store = globalThis.__dshUsageLedgerStore
  if (store?.flush) await store.flush()
  await new Promise((resolve) => setTimeout(resolve, 300))

  const s2 = (await call('summary')).json().value
  check('全链路 summary.tokens === 150', s2.tokens === 150, JSON.stringify({ tokens: s2.tokens }))
  check('全链路 summary.requests === 1', s2.requests === 1, '')
  check('全链路 summary.turns === 1', s2.turns === 1, '')
  check('全链路 summary.toolCalls === 1', s2.toolCalls === 1, '')
  check('全链路 summary.avgFirstTokenMs === 800', s2.avgFirstTokenMs === 800, JSON.stringify({ v: s2.avgFirstTokenMs }))
  check('全链路 summary.tokensPerSecond > 0', typeof s2.tokensPerSecond === 'number' && s2.tokensPerSecond > 0, JSON.stringify({ v: s2.tokensPerSecond }))

  const d2 = (await call('daily', { group: 'model' })).json().value
  const todayBucket = d2.buckets[d2.buckets.length - 1]
  check('全链路 daily 今日桶 tokens=150 且模型分组有 deepseek/deepseek-chat',
    todayBucket.tokens === 150 && todayBucket.groups['deepseek/deepseek-chat'] === 150, JSON.stringify(todayBucket))
  check('全链路 daily groupTotals 首位为该模型', d2.groupTotals[0]?.key === 'deepseek/deepseek-chat' && d2.groupTotals[0]?.tokens === 150, '')

  const sess2 = (await call('session', { id: 's-e2e' })).json().value
  check('全链路 session.totals.tokens === 150', sess2.totals?.tokens === 150, '')
  check('全链路 session.records 一条且 TTFT=800', Array.isArray(sess2.records) && sess2.records.length === 1 && sess2.records[0].firstTokenMs === 800, JSON.stringify(sess2.records?.[0]?.firstTokenMs))
  check('全链路 session.tools 含 pwsh', sess2.tools?.some((t) => t.name === 'pwsh' && t.calls === 1), '')
}

// 采集器 disposer + store dispose（避免句柄悬挂）。
for (const [, d] of disposers) { try { d() } catch { /* ignore */ } }
const g = globalThis
if (g.__dshUsageLedgerStoreV2?.dispose) await g.__dshUsageLedgerStoreV2.dispose()

rmSync(fakeHome, { recursive: true, force: true })
console.log(passed > 0 && process.exitCode === undefined ? `\nverify-host OK: ${passed} checks passed` : `\nverify-host done with failures (${passed} passed)`)
