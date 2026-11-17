// smoke.mjs — src/routes/ 的冒烟测试：无宿主、零依赖，plugin 根目录下
// `node src/routes/smoke.mjs` 直接跑。覆盖：fence 五路用例（loopback 放行 /
// evil.com / cross-site / Origin 不一致 / 无 Origin 放行，外加 trustedHosts、
// bind 地址、Origin 一致、"null" Origin、trust 抛错 fail-closed）、8 个方法的
// happy path 与参数校验/clamp、错误码（非法日期/跨度超限/未知方法/非 POST/坏
// JSON/超大 body）、reset 在 boot 扫描中 409、500 不回显内部错误文本。

import assert from 'node:assert/strict'
import { buildLedgerRoute } from './routes.js'

// ── 假 req/res ─────────────────────────────────────────────────────────────

function fakeReq({ url, method = 'POST', headers = {}, body = '{}' }) {
  return {
    url,
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body)
    },
  }
}

async function call(route, opts) {
  const res = {
    statusCode: 0,
    headers: {},
    bodyText: '',
    writeHead(status, headers) { this.statusCode = status; this.headers = headers },
    end(chunk) { this.bodyText = chunk ?? '' },
  }
  await route.handler(fakeReq(opts), res)
  return { status: res.statusCode, headers: res.headers, body: res.bodyText, json: JSON.parse(res.bodyText) }
}

// ── mock store/collector ─────────────────────────────────────────────────────

function makeMocks() {
  const calls = []
  const store = {
    status: () => ({
      backend: 'sqlite', degraded: false, backendError: null, retentionDays: 30,
      requestRows: 10, toolRows: 20, kvDays: 3, kvSessions: 4, recordFailures: 0,
      lastPruneDay: null,
      backfill: { running: false, total: 0, done: 0, scannedSessions: 0 },
    }),
    summary: async () => ({
      tokens: 123, inputTokens: 1, outputTokens: 2, reasoningTokens: 0,
      cacheReadTokens: 100, cacheWriteTokens: 20, requests: 4, failures: 0,
      turns: 2, toolCalls: 9, activeDays: 3, firstDay: '2026-01-01',
      lastDay: '2026-01-03', peakDay: { day: '2026-01-02', tokens: 100 },
      streakDays: 2, avgFirstTokenMs: 800, cacheHitRate: 50, errorRate: 0,
      tokensPerSecond: 42, degraded: false,
    }),
    daily: async (q) => {
      calls.push(['daily', q])
      return {
        from: q.from ?? '2026-01-01', to: q.to ?? '2026-01-07',
        granularity: q.granularity ?? 'day', group: q.group ?? null,
        buckets: [], groupTotals: [], degraded: false,
      }
    },
    heatmap: async (q) => { calls.push(['heatmap', q]); return { weeks: q.weeks, days: [], maxTokens: 0 } },
    sessions: async (q) => { calls.push(['sessions', q]); return { total: 0, rows: [] } },
    sessionDetail: async (id) => {
      calls.push(['sessionDetail', id])
      if (id === 'explode') throw new Error('sqlite: cannot open C:\\secret\\facts.db')
      // v7 wire 形状示例（与 db smoke 的 s1/s2 夹具同数）：children[] +
      // byModel 四桶。's-degraded' 分支验证降级透传（children 在、byModel 空）。
      const child = id === 's-degraded'
        ? { id: 's9c', parentId: 's-degraded', kind: 'subagent', name: '', requests: 1, failures: 0, turns: 0, tokens: 10, inputTokens: 7, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }
        : { id: 's2', parentId: 's1', kind: 'subagent', name: 'child-agent', requests: 1, failures: 1, turns: 1, tokens: 15, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }
      const degraded = id === 's-degraded'
      return {
        id, index: null,
        totals: { tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
        requests: 0, failures: 0,
        children: [child],
        avgFirstTokenMs: null, tokensPerSecond: null,
        byModel: degraded ? [] : [{ model: 'gpt-x', provider: 'openai', tokens: 1480, requests: 3, failures: 0, inputTokens: 1100, outputTokens: 350, cacheReadTokens: 20, cacheWriteTokens: 10 }],
        records: [], tools: [], degraded,
      }
    },
    tools: async (q) => { calls.push(['tools', q]); return { tools: [] } },
  }
  const collector = { status: { running: false, total: 9, done: 5, scannedSessions: 9 } }
  const state = { rebuilding: false, resets: 0 }
  const route = buildLedgerRoute({
    store,
    collector,
    trust: () => ({ trustedHosts: ['myhost.local'], bindHost: '192.168.1.5', protocol: 'http:' }),
    isRebuilding: () => state.rebuilding,
    resetAndRescan: async () => { state.resets++ },
    config: { heatmapWeeks: 7, retentionDays: 30 },
  })
  return { route, calls, collector, state, store }
}

const LOOPBACK = { host: '127.0.0.1:50224' }

// ── 测试 ───────────────────────────────────────────────────────────────────

const tests = []
const test = (name, fn) => tests.push([name, fn])

test('route 形状: kind=prefix, path=/usage-ledger/api', () => {
  const { route } = makeMocks()
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/usage-ledger/api')
  assert.equal(typeof route.handler, 'function')
})

// fence ─────────────────────────────────────────────────────────────────────

test('fence: loopback Host（无 Origin）放行', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/summary', headers: { ...LOOPBACK } })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
})

test('fence: localhost 与 bind 地址放行', async () => {
  const { route } = makeMocks()
  const a = await call(route, { url: '/usage-ledger/api/summary', headers: { host: 'localhost:50224' } })
  assert.equal(a.status, 200)
  const b = await call(route, { url: '/usage-ledger/api/summary', headers: { host: '192.168.1.5:1234' } })
  assert.equal(b.status, 200)
})

test('fence: trustedHosts 条目（无端口条目匹配任意端口）放行', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/summary', headers: { host: 'myhost.local:9999' } })
  assert.equal(r.status, 200)
})

test('fence: host evil.com 拒绝（403 forbidden）', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/summary', headers: { host: 'evil.com' } })
  assert.equal(r.status, 403)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.error.code, 'forbidden')
})

test('fence: sec-fetch-site: cross-site 拒绝', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/summary', headers: { ...LOOPBACK, 'sec-fetch-site': 'cross-site' } })
  assert.equal(r.status, 403)
  assert.equal(r.json.error.code, 'forbidden')
})

test('fence: Origin 与 Host 不一致拒绝', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/summary', headers: { ...LOOPBACK, origin: 'http://evil.com' } })
  assert.equal(r.status, 403)
  const wrongPort = await call(route, { url: '/usage-ledger/api/summary', headers: { ...LOOPBACK, origin: 'http://127.0.0.1:9999' } })
  assert.equal(wrongPort.status, 403)
})

test('fence: Origin 恰等于 Host authority 放行', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/summary', headers: { ...LOOPBACK, origin: 'http://127.0.0.1:50224' } })
  assert.equal(r.status, 200)
})

test('fence: "null" Origin 拒绝', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/summary', headers: { ...LOOPBACK, origin: 'null' } })
  assert.equal(r.status, 403)
})

test('fence: trust() 抛错 fail-closed（403，不向 webserver 抛异常）', async () => {
  const { store, collector } = makeMocks()
  const route = buildLedgerRoute({
    store, collector,
    trust: () => { throw new Error('ctx gone') },
    isRebuilding: () => false,
    resetAndRescan: async () => {},
    config: {},
  })
  const r = await call(route, { url: '/usage-ledger/api/summary', headers: { ...LOOPBACK } })
  assert.equal(r.status, 403)
  assert.equal(r.json.error.code, 'forbidden')
})

// happy path ─────────────────────────────────────────────────────────────────

test('summary: 200 且 value 为 SummaryResponse 形状', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/summary', headers: { ...LOOPBACK } })
  assert.equal(r.status, 200)
  assert.equal(r.json.value.tokens, 123)
  assert.equal(r.json.value.degraded, false)
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(r.headers['cache-control'], 'no-store')
})

test('daily: 合法参数原样传给 store', async () => {
  const { route, calls } = makeMocks()
  const r = await call(route, {
    url: '/usage-ledger/api/daily', headers: { ...LOOPBACK },
    body: JSON.stringify({ from: '2026-01-01', to: '2026-01-31', group: 'model', granularity: 'day' }),
  })
  assert.equal(r.status, 200)
  assert.deepEqual(calls.at(-1), ['daily', { from: '2026-01-01', to: '2026-01-31', group: 'model', granularity: 'day' }])
})

test('daily: 空 body 不注入任何字段', async () => {
  const { route, calls } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/daily', headers: { ...LOOPBACK } })
  assert.equal(r.status, 200)
  assert.deepEqual(calls.at(-1), ['daily', {}])
})

test('heatmap: weeks 缺省取 config，越界 clamp 到 1..260', async () => {
  const { route, calls } = makeMocks()
  const a = await call(route, { url: '/usage-ledger/api/heatmap', headers: { ...LOOPBACK } })
  assert.equal(a.json.value.weeks, 7)
  assert.deepEqual(calls.at(-1), ['heatmap', { weeks: 7 }])
  await call(route, { url: '/usage-ledger/api/heatmap', headers: { ...LOOPBACK }, body: JSON.stringify({ weeks: 999 }) })
  assert.deepEqual(calls.at(-1), ['heatmap', { weeks: 260 }])
  await call(route, { url: '/usage-ledger/api/heatmap', headers: { ...LOOPBACK }, body: JSON.stringify({ weeks: 0 }) })
  assert.deepEqual(calls.at(-1), ['heatmap', { weeks: 1 }])
})

test('sessions: limit clamp 1..200 默认 50，offset/q 透传', async () => {
  const { route, calls } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/sessions', headers: { ...LOOPBACK } })
  assert.equal(r.status, 200)
  assert.deepEqual(calls.at(-1), ['sessions', { limit: 50, offset: 0 }])
  await call(route, {
    url: '/usage-ledger/api/sessions', headers: { ...LOOPBACK },
    body: JSON.stringify({ limit: 1000, offset: -5, q: 'abc' }),
  })
  assert.deepEqual(calls.at(-1), ['sessions', { limit: 200, offset: 0, q: 'abc' }])
})

test('session: id 透传，返回 SessionDetailResponse 形状', async () => {
  const { route, calls } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/session', headers: { ...LOOPBACK }, body: JSON.stringify({ id: 's1' }) })
  assert.equal(r.status, 200)
  assert.equal(r.json.value.id, 's1')
  assert.deepEqual(calls.at(-1), ['sessionDetail', 's1'])
})

test('session: children[] 形状透传（id/name/requests/tokens/四桶）', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/session', headers: { ...LOOPBACK }, body: JSON.stringify({ id: 's1' }) })
  assert.equal(r.status, 200)
  const child = r.json.value.children[0]
  assert.deepEqual(
    [child.id, child.parentId, child.kind, child.name, child.requests, child.failures, child.turns, child.tokens, child.inputTokens, child.outputTokens, child.cacheReadTokens, child.cacheWriteTokens],
    ['s2', 's1', 'subagent', 'child-agent', 1, 1, 1, 15, 10, 5, 0, 0],
    'children 行：id/parentId/kind/name + requests/failures/turns + tokens 四桶',
  )
})

test('session: byModel 行四桶透传（tokens 仍为 computedTotal 之和）', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/session', headers: { ...LOOPBACK }, body: JSON.stringify({ id: 's1' }) })
  assert.equal(r.status, 200)
  const m = r.json.value.byModel[0]
  assert.deepEqual(
    [m.provider, m.model, m.tokens, m.requests, m.failures, m.inputTokens, m.outputTokens, m.cacheReadTokens, m.cacheWriteTokens],
    ['openai', 'gpt-x', 1480, 3, 0, 1100, 350, 20, 10],
    'byModel 行：既有五字段 + input/output/cacheRead/cacheWrite 四桶',
  )
})

test('session: degraded 时 children 仍可用（KV 来源）而 byModel 空', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/session', headers: { ...LOOPBACK }, body: JSON.stringify({ id: 's-degraded' }) })
  assert.equal(r.status, 200)
  assert.equal(r.json.value.degraded, true)
  assert.deepEqual(r.json.value.byModel, [], 'degraded：byModel 维持 []')
  assert.equal(r.json.value.children.length, 1, 'degraded：children 仍可用')
  assert.equal(r.json.value.children[0].id, 's9c')
  assert.equal(r.json.value.children[0].tokens, 10)
})

test('tools: 日期范围透传', async () => {
  const { route, calls } = makeMocks()
  const r = await call(route, {
    url: '/usage-ledger/api/tools', headers: { ...LOOPBACK },
    body: JSON.stringify({ from: '2026-02-01', to: '2026-02-02' }),
  })
  assert.equal(r.status, 200)
  assert.deepEqual(calls.at(-1), ['tools', { from: '2026-02-01', to: '2026-02-02' }])
})

test('status: store.status 合并 collector.status 进 backfill', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/status', headers: { ...LOOPBACK } })
  assert.equal(r.status, 200)
  assert.equal(r.json.value.backend, 'sqlite')
  assert.equal(r.json.value.retentionDays, 30)
  assert.deepEqual(r.json.value.backfill, { running: false, total: 9, done: 5, scannedSessions: 9 })
})

test('body: 空 body 与非对象 JSON 按 {} 处理', async () => {
  const { route } = makeMocks()
  const empty = await call(route, { url: '/usage-ledger/api/summary', headers: { ...LOOPBACK }, body: '' })
  assert.equal(empty.status, 200)
  const arr = await call(route, { url: '/usage-ledger/api/summary', headers: { ...LOOPBACK }, body: '[]' })
  assert.equal(arr.status, 200)
})

// 错误码 ─────────────────────────────────────────────────────────────────────

test('daily: 翻卷日期 2026-13-45 → 400', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/daily', headers: { ...LOOPBACK }, body: JSON.stringify({ from: '2026-13-45' }) })
  assert.equal(r.status, 400)
  assert.equal(r.json.ok, false)
  assert.equal(r.json.error.code, 'bad_request')
})

test('daily: to < from 与跨度 >366 天 → 400', async () => {
  const { route } = makeMocks()
  const rev = await call(route, {
    url: '/usage-ledger/api/daily', headers: { ...LOOPBACK },
    body: JSON.stringify({ from: '2026-02-10', to: '2026-02-01' }),
  })
  assert.equal(rev.status, 400)
  // 2026-01-01..2027-01-01 恰 366 天放行；..2027-02-01 为 397 天拒绝。
  const ok366 = await call(route, {
    url: '/usage-ledger/api/daily', headers: { ...LOOPBACK },
    body: JSON.stringify({ from: '2026-01-01', to: '2027-01-01' }),
  })
  assert.equal(ok366.status, 200)
  const over = await call(route, {
    url: '/usage-ledger/api/daily', headers: { ...LOOPBACK },
    body: JSON.stringify({ from: '2026-01-01', to: '2027-02-01' }),
  })
  assert.equal(over.status, 400)
})

test('daily: 非法 group / granularity → 400', async () => {
  const { route } = makeMocks()
  const g = await call(route, { url: '/usage-ledger/api/daily', headers: { ...LOOPBACK }, body: JSON.stringify({ group: 'bogus' }) })
  assert.equal(g.status, 400)
  const gr = await call(route, { url: '/usage-ledger/api/daily', headers: { ...LOOPBACK }, body: JSON.stringify({ granularity: 'minute' }) })
  assert.equal(gr.status, 400)
})

test('tools: 非法日期 → 400', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/tools', headers: { ...LOOPBACK }, body: JSON.stringify({ to: '2026-02-30' }) })
  assert.equal(r.status, 400)
})

test('session: 缺 id → 400', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/session', headers: { ...LOOPBACK } })
  assert.equal(r.status, 400)
  assert.equal(r.json.error.code, 'bad_request')
})

test('未知子路径 → 404 not_found（含前缀根）', async () => {
  const { route } = makeMocks()
  const nope = await call(route, { url: '/usage-ledger/api/nope', headers: { ...LOOPBACK } })
  assert.equal(nope.status, 404)
  assert.equal(nope.json.error.code, 'not_found')
  const root = await call(route, { url: '/usage-ledger/api', headers: { ...LOOPBACK } })
  assert.equal(root.status, 404)
})

test('非 POST → 405 method_not_allowed', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/summary', method: 'GET', headers: { ...LOOPBACK } })
  assert.equal(r.status, 405)
  assert.equal(r.json.error.code, 'method_not_allowed')
  assert.equal(r.headers['cache-control'], 'no-store')
})

test('坏 JSON body → 400；超 64 KiB → 413', async () => {
  const { route } = makeMocks()
  const bad = await call(route, { url: '/usage-ledger/api/summary', headers: { ...LOOPBACK }, body: 'not json{' })
  assert.equal(bad.status, 400)
  const big = await call(route, {
    url: '/usage-ledger/api/summary', headers: { ...LOOPBACK },
    body: `{"pad":"${'x'.repeat(70 * 1024)}"}`,
  })
  assert.equal(big.status, 413)
  assert.equal(big.json.error.code, 'payload_too_large')
})

test('store 抛错 → 500 internal_error，不回显内部文本', async () => {
  const { route } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/session', headers: { ...LOOPBACK }, body: JSON.stringify({ id: 'explode' }) })
  assert.equal(r.status, 500)
  assert.equal(r.json.error.code, 'internal_error')
  assert.equal(r.json.error.message, 'internal error')
  assert.ok(!r.body.includes('C:\\secret') && !r.body.includes('sqlite:'))
})

// reset ─────────────────────────────────────────────────────────────────────

test('reset: boot 扫描中（running 且非 rebuilding）→ 409', async () => {
  const { route, collector, state } = makeMocks()
  collector.status.running = true
  state.rebuilding = false
  const r = await call(route, { url: '/usage-ledger/api/reset', headers: { ...LOOPBACK } })
  assert.equal(r.status, 409)
  assert.equal(r.json.error.code, 'conflict')
  assert.equal(state.resets, 0)
})

test('reset: rebuilding 中的扫描搭 coalescing 便车（200）', async () => {
  const { route, collector, state } = makeMocks()
  collector.status.running = true
  state.rebuilding = true
  const r = await call(route, { url: '/usage-ledger/api/reset', headers: { ...LOOPBACK } })
  assert.equal(r.status, 200)
  assert.equal(state.resets, 1)
  assert.equal(r.json.value.backfill.running, true)
})

test('reset: 空闲时执行并返回最新合并 status', async () => {
  const { route, state } = makeMocks()
  const r = await call(route, { url: '/usage-ledger/api/reset', headers: { ...LOOPBACK } })
  assert.equal(r.status, 200)
  assert.equal(state.resets, 1)
  assert.equal(r.json.value.backfill.done, 5)
  assert.equal(r.json.value.backend, 'sqlite')
})

// ── runner ─────────────────────────────────────────────────────────────────

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`ok   - ${name}`)
  } catch (err) {
    failed++
    console.error(`FAIL - ${name}`)
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err))
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`)
if (failed > 0) process.exitCode = 1
