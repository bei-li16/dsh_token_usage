// compare-sessions.mjs — 逐会话对账：dsh-usage-ledger vs dsh-token-total（task-13/17）。
//
// 【B. 0.1.7 并排对照（task-17）】对样本会话（默认本会话 session-351c7605-… + 3 个有
//   子会话的会话，--id 可指定，可多次）：
//   - 我方：POST /usage-ledger/api/session {"id"}；live 端点已部署 0.1.7（响应含
//     context/composition 键）则直接用 live 值；否则用工作区组装器
//     src/session-view/calculator.js 以【只读 mock persistence 直读磁盘真实日志】
//     in-process 计算（与 task-15 验收同法，.dsh 全程只读），来源明确标注。
//   - 他方：POST /token-total/api/session-detail {"sessionId"}（实测这才是含
//     context/composition/subagents 速率的端点；…/api/session 只有四桶树聚合）。
//   - 判据：子会话 tokens 精确一致（A1，容差 0）；子会话 avgFirstTokenMs /
//     tokensPerSecond ±15%；context totalTokens ±15%、contextWindow 精确或同 null、
//     provider/model 一致；composition billedTokens 精确一致（A2，容差 0）、8 桶每桶
//     ±15%（基准 = 他方）。任一侧 context/composition null → INFO 不判。
//
// 对磁盘上每个会话（C:\Users\18283\.dsh\sessions\<ws>\<session>\，只读目录名）：
//   - 本插件  ：POST http://127.0.0.1:<port>/usage-ledger/api/session  {"id":...}
//              → SessionDetailResponse；totals 是 BFS（本会话+全部后代）四桶合计。
//   - token-total：POST http://127.0.0.1:<port>/token-total/api/session {"sessionId":...}
//              → 实测 wire：{ self, selfCompaction, subagents, total, subagentSessions,
//                coverage }，total 四桶（uncachedInput/output/cacheRead/cacheWrite）同为
//                "本会话+全部后代" 口径；【无 requests 字段】（该项跳过）。
//   对比项：tokens（四桶之和）、inputTokens（我方 inputTokens vs 他方 uncachedInputTokens）、
//   outputTokens、cacheReadTokens、cacheWriteTokens；记录绝对值 + 相对值差异。
//
// --strict 判据（任一命中 → exit 1）：
//   [S1] 任一【非活会话】四桶差异 |Δ| > 0.5%（基准 = 双方该桶较大值）且 |Δ| > 10K tokens。
//        活会话判定：我方 records[0].time（最新一条）距今 < 30 分钟（他方按需读日志、
//        我方 live 计数，尾巴时序差属预期）——活会话只列出不判。
//   [S2] task-11 新字段联调校验失败：children[] / byModel 四桶在 live 端点不可用。
//        （报告模式同样大声标注 FAIL，但不影响 exit 0。）
//   [S3] 0.1.7 对照（B 部分）：A1/A2（容差 0）或任一 ±15% 项超容差（null 跳过项不判）。
//   端点不可达（网络级）→ exit 2（宿主 Web GUI 端口可能变化：--port N 或环境变量
//   COMPARE_SESSIONS_PORT 覆盖，默认 11370）。
//
// 已知可解释差异（归因线索，报告注明）：
//   · 活会话实时尾巴时序差（我方 live 计数 vs 他方按需读日志快照）。
//   · token-total 对 retry 尝试的计数口径差（历史上 10-10/10-11 有 +136K 级差异）。
//   · 他方 30 天明细窗口外不完整（老会话他方可能偏低；他方响应带 coverage 佐证）。
//
// 约束：对 C:\Users\18283\.dsh 只读；不 toggle/不 POST /reset 等任何线上操作；
// 不 git commit；ESM 单文件，除工作区插件自身源码（calculator/compose）外零依赖。
//
// 运行：node compare-sessions.mjs [--strict] [--port N] [--id <sessionId> ...]

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { createSessionViewCalculator } from './dsh-usage-ledger/src/session-view/calculator.js'

const DSH_HOME = process.env.VERIFY_DSH_HOME || 'C:/Users/18283/.dsh'
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const PROJCACHE_ROOT = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
// 并排对照的默认本会话（lead 钉死的样本锚点）。
const THIS_SESSION = 'session-351c7605-90ac-42f1-9be0-6583f07bfdce'

const args = process.argv.slice(2)
const STRICT = args.includes('--strict')
const portArgIdx = args.indexOf('--port')
const PORT = Number(portArgIdx >= 0 ? args[portArgIdx + 1] : process.env.COMPARE_SESSIONS_PORT ?? 11370)
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`[硬错误] 无效端口: ${PORT}`)
  process.exit(2)
}
const explicitIds = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--id' && typeof args[i + 1] === 'string' && args[i + 1] !== '') explicitIds.push(args[i + 1])
}
const OURS_URL = `http://127.0.0.1:${PORT}/usage-ledger/api/session`
const THEIRS_URL = `http://127.0.0.1:${PORT}/token-total/api/session`
const THEIRS_DETAIL_URL = `http://127.0.0.1:${PORT}/token-total/api/session-detail`

const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0).toLocaleString('en-US')
const pad = (s, w, right = false) => (right ? String(s).padStart(w) : String(s).padEnd(w))
const now = Date.now()
const ACTIVE_WINDOW_MS = 30 * 60 * 1000

// ── HTTP ───────────────────────────────────────────────────────────────────

class EndpointDown extends Error {}
class ApiError extends Error {}

async function postJson(url, body, timeoutMs) {
  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? 30_000),
    })
  } catch (err) {
    throw new EndpointDown(`无法访问 ${url}（${err?.message ?? err}）——宿主 Web GUI 端口可能变化：--port N 或环境变量 COMPARE_SESSIONS_PORT 指定实际端口后重试`)
  }
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  if (res.status === 403) throw new ApiError(`HTTP 403 信任围栏拒绝（Host 非 loopback；请用 http://127.0.0.1:${PORT}/... 直连）`)
  if (res.status === 405) throw new ApiError('HTTP 405（路由只收 POST）')
  if (json?.ok !== true) throw new ApiError(`HTTP ${res.status} ${text.slice(0, 160)}`)
  return json.value
}

// ── 双方响应提取 ───────────────────────────────────────────────────────────

function extractOurs(v) {
  const t = v?.totals ?? {}
  const byModel = Array.isArray(v?.byModel) ? v.byModel : null
  const byModelBucketsOk = byModel !== null && byModel.length > 0
    && byModel.every((m) => ['tokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']
      .every((k) => typeof m[k] === 'number'))
  return {
    tokens: Number(t.tokens) || 0,
    input: Number(t.inputTokens) || 0,
    output: Number(t.outputTokens) || 0,
    cacheRead: Number(t.cacheReadTokens) || 0,
    cacheWrite: Number(t.cacheWriteTokens) || 0,
    requests: Number(v?.requests) || 0,
    name: typeof v?.index?.name === 'string' ? v.index.name : '',
    degraded: v?.degraded === true,
    // task-11 v7 字段探测（live 端点可能尚未运行新代码）。
    children: Array.isArray(v?.children) ? v.children : null,
    byModel,
    byModelBucketsOk,
    newestTime: typeof v?.records?.[0]?.time === 'number' ? v.records[0].time : null,
  }
}

function extractTheirs(v) {
  const t = v?.total ?? {}
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  return {
    tokens: num(t.uncachedInputTokens) + num(t.outputTokens) + num(t.cacheReadTokens) + num(t.cacheWriteTokens),
    input: num(t.uncachedInputTokens),
    output: num(t.outputTokens),
    cacheRead: num(t.cacheReadTokens),
    cacheWrite: num(t.cacheWriteTokens),
    requests: typeof v?.requests === 'number' ? v.requests : undefined, // 实测：该端点无此字段
    coverage: v?.coverage ?? null,
    subagentSessions: v?.subagentSessions ?? null,
  }
}

const BUCKETS = [
  { key: 'tokens', label: 'tokens' },
  { key: 'input', label: 'input' },
  { key: 'output', label: 'output' },
  { key: 'cacheRead', label: 'cacheRead' },
  { key: 'cacheWrite', label: 'cacheWrite' },
]

// ── B 部分（0.1.7 并排对照）：只读 mock persistence + 工作区组装器 ──────────
// live 端点未部署 0.1.7 时的兜底：用工作区 calculator.js 组装（与 task-15 验收
// 同法）。mock persistence 直读磁盘真实 session.v4.jsonl.zstd（多 frame zstd 切分解码
// 逻辑与 verify-usage.mjs 同款，.dsh 全程只读）；inheritedEventCount 取 projcache。

const ZSTD_MAGIC = 0xfd2fb528 // 小端 28 B5 2F FD
/** 解码 v4 多 frame zstd 日志（逻辑同 verify-usage.mjs，失败段合并重试/跳过）。 */
function decodeV4Log(buf, label, warn) {
  if (buf.length === 0) { warn.push(`${label}: 0KB 日志`); return [] }
  const bounds = [0]
  for (let i = 4; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === ZSTD_MAGIC) bounds.push(i)
  const records = []
  let idx = 0
  while (idx < bounds.length) {
    const from = bounds[idx]
    let consumed = -1
    for (let j = idx + 1; j <= bounds.length; j++) {
      const to = j < bounds.length ? bounds[j] : buf.length
      try {
        const text = zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
        for (const line of text.split('\n')) {
          const s = line.trim()
          if (!s) continue
          try { records.push(JSON.parse(s)) } catch { warn.push(`${label}: 撕裂 JSON 行跳过`) }
        }
        consumed = j
        break
      } catch {
        if (j === bounds.length) warn.push(`${label}: 字节段 [${from},${to}) 合并到末尾仍解压失败，跳过`)
      }
    }
    if (consumed === -1) break
    idx = consumed
  }
  return records
}

/** projcache inheritedEventCount（多候选文件名兜底，读不到按 0）。 */
function inheritedCutOf(sessionId) {
  if (!sessionId) return 0
  const bare = sessionId.replace(/^session-/, '')
  for (const name of [...new Set([sessionId, bare, `session-${sessionId}`, `session-${bare}`])]) {
    try {
      const j = JSON.parse(readFileSync(join(PROJCACHE_ROOT, `${name}.json`), 'utf8'))
      const n = j?.record?.identity?.inheritedEventCount
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return Math.floor(n)
    } catch { /* 试下一个候选名 */ }
  }
  return 0
}

/** id → v4 日志文件路径 索引（扫一遍 sessions 树，只读）。 */
function diskLogIndex() {
  const map = new Map()
  for (const ws of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    for (const sd of readdirSync(join(SESSIONS_ROOT, ws.name), { withFileTypes: true })) {
      if (!sd.isDirectory()) continue
      const file = join(SESSIONS_ROOT, ws.name, sd.name, 'session.v4.jsonl.zstd')
      if (existsSync(file)) map.set(sd.name, file)
    }
  }
  return map
}

/** 只读 mock persistence：calculator.js 的 open/read/close/list 面。 */
function mockPersistence(index, warn) {
  return {
    async list() { return null }, // statStamps 拿不到快照 → 组装器不做短缓存，每次新鲜算
    async open(id) {
      const file = index.get(id)
      if (file === undefined) throw new Error(`no disk log for ${id}`)
      const records = decodeV4Log(readFileSync(file), id, warn)
      const cut = inheritedCutOf(id)
      let cursor = 0
      return {
        inheritedEventCount: cut,
        async read(offset, limit) {
          if (offset !== cursor) return { events: [] } // calculator 只顺序分页读
          const events = records.slice(cursor, cursor + (limit ?? 500))
          cursor += events.length
          return { events }
        },
        async close() {},
      }
    },
  }
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

function listDiskSessions() {
  const ids = []
  for (const ws of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    for (const sd of readdirSync(join(SESSIONS_ROOT, ws.name), { withFileTypes: true })) {
      if (sd.isDirectory()) ids.push(sd.name)
    }
  }
  return ids
}

// ── B 部分：0.1.7 并排对照的对照引擎 ───────────────────────────────────────

const TOL_PCT = 15
/** 相对容差（基准 = 他方）：±TOL_PCT% 内 PASS；他方 0 时要求我方同为 0。 */
function relTolOk(ours, theirs) {
  if (theirs === 0) return ours === 0
  return Math.abs(ours - theirs) <= (TOL_PCT / 100) * Math.abs(theirs)
}
function sum4(t) {
  const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
  return num(t?.uncachedInputTokens) + num(t?.outputTokens) + num(t?.cacheReadTokens) + num(t?.cacheWriteTokens)
}
function shortId(id) { return String(id).replace(/^session-/, '').slice(0, 10) }

/** 样本选择：--id 显式指定；否则 本会话 THIS_SESSION + 其余有子会话者按规模取 3。 */
function pickSampleIds(sweepRows) {
  if (explicitIds.length > 0) return [...new Set(explicitIds)]
  const withChildren = sweepRows.filter((r) => Array.isArray(r.ours.children) && r.ours.children.length > 0).map((r) => r.id)
  const out = []
  if (sweepRows.some((r) => r.id === THIS_SESSION)) out.push(THIS_SESSION)
  for (const id of withChildren) {
    if (out.length >= 4) break
    if (!out.includes(id)) out.push(id)
  }
  return out
}

/**
 * 一个样本会话的并排对照：我方 live 优先、0.1.7 缺位时工作区组装器兜底，
 * 他方 /token-total/api/session-detail。返回 {id, cmp, error?} 供打印与判据。
 */
async function compareSampleSession(id, calculator) {
  const cmp = []
  const row = (name, o, t, verdict, note) => cmp.push({ name, o, t, verdict, note })
  let detail = null
  let tt = null
  try { detail = await postJson(OURS_URL, { id }, 60_000) }
  catch (err) { return { id, cmp, error: `我方端点 ${err.message}` } }
  try { tt = await postJson(THEIRS_DETAIL_URL, { sessionId: id }, 60_000) }
  catch (err) { return { id, cmp, error: `他方端点 ${err.message}` } }

  // 我方 0.1.7 字段来源判定：live 响应含 context 键 → 已部署；children 速率键同理。
  const liveCtx = detail !== null && typeof detail === 'object' && Object.prototype.hasOwnProperty.call(detail, 'context')
  const liveRates = Array.isArray(detail?.children)
    && detail.children.some((c) => c !== null && typeof c === 'object'
      && (typeof c.avgFirstTokenMs === 'number' || typeof c.tokensPerSecond === 'number'))
  let context = liveCtx ? (detail.context ?? null) : null
  let composition = liveCtx ? (detail.composition ?? null) : null
  const childRates = new Map()
  if (liveRates) {
    for (const c of detail.children) {
      childRates.set(c.id, { avgFirstTokenMs: c.avgFirstTokenMs ?? null, tokensPerSecond: c.tokensPerSecond ?? null })
    }
  }
  if (!liveCtx || !liveRates) {
    const childIds = (Array.isArray(detail?.children) ? detail.children : [])
      .map((c) => (c !== null && typeof c === 'object' ? c.id : undefined))
      .filter((x) => typeof x === 'string' && x !== '')
    const view = await calculator.calculate(id, childIds)
    if (!liveCtx) { context = view.context; composition = view.composition }
    if (!liveRates) {
      for (const [k, v] of (view.childRates instanceof Map ? view.childRates : new Map())) {
        if (!childRates.has(k)) childRates.set(k, v)
      }
    }
  }
  const source = liveCtx && liveRates ? 'live 端点'
    : (!liveCtx && !liveRates ? 'workspace 组装器 in-process'
      : `context/composition=${liveCtx ? 'live' : '组装器'}, 速率=${liveRates ? 'live' : '组装器'}`)

  // ── 当前上下文 ──
  const tc = tt?.context ?? null
  if (context === null || tc === null) {
    row('context', context === null ? 'null' : '(有)', tc === null ? 'null' : '(有)', 'INFO',
      '一侧 null 不判（他方老 host / 日志不可读 / 组装器降级）')
  } else {
    const o = Number(context.totalTokens) || 0
    const t = Number(tc.totalTokens) || 0
    row('context.totalTokens', o, t, relTolOk(o, t) ? 'PASS' : 'FAIL', `±${TOL_PCT}%（同为字符估算，允许实现差）`)
    const ow = typeof context.contextWindow === 'number' ? context.contextWindow : null
    const tw = typeof tc.contextWindow === 'number' ? tc.contextWindow : null
    row('context.contextWindow', ow ?? 'null', tw ?? 'null', ow === tw ? 'PASS' : 'FAIL', '精确一致或同为 null')
    row('context.provider', context.provider ?? '', tc.provider ?? '', String(context.provider ?? '') === String(tc.provider ?? '') ? 'PASS' : 'FAIL', '一致')
    row('context.model', context.model ?? '', tc.model ?? '', String(context.model ?? '') === String(tc.model ?? '') ? 'PASS' : 'FAIL', '一致')
  }

  // ── Token 统计（composition）──
  const tp = tt?.composition ?? null
  if (composition === null || tp === null) {
    row('composition', composition === null ? 'null' : '(有)', tp === null ? 'null' : '(有)', 'INFO', '一侧 null 不判')
  } else {
    const ob = Number(composition.billedTokens) || 0
    const tb = Number(tp.billedTokens) || 0
    row('composition.billedTokens', ob, tb, ob === tb ? 'PASS' : 'FAIL', 'A2 精确一致（provider 精确 usage）')
    const ourBuckets = new Map((Array.isArray(composition.buckets) ? composition.buckets : [])
      .map((b) => [String(b?.key), Number(b?.tokens) || 0]))
    const theirBuckets = new Map((Array.isArray(tp.buckets) ? tp.buckets : [])
      .map((b) => [String(b?.key), Number(b?.tokens) || 0]))
    const keys = [...new Set([...ourBuckets.keys(), ...theirBuckets.keys()])]
    for (const k of keys) {
      const o = ourBuckets.get(k) ?? 0
      const t = theirBuckets.get(k) ?? 0
      row(`composition.${k}`, o, t, relTolOk(o, t) ? 'PASS' : 'FAIL', `±${TOL_PCT}%（分桶估算允许实现差）`)
    }
  }

  // ── 子会话行（A1 tokens 精确 + 速率 ±15%）──
  const ourChildren = Array.isArray(detail?.children) ? detail.children : []
  const theirSubs = Array.isArray(tt?.subagents) ? tt.subagents : []
  const theirById = new Map(theirSubs.map((s) => [s?.sessionId, s]))
  const ourIds = new Set(ourChildren.map((c) => c?.id))
  const missingOnTheirs = [...ourIds].filter((x) => !theirById.has(x))
  const missingOnOurs = [...theirById.keys()].filter((x) => !ourIds.has(x))
  if (missingOnTheirs.length > 0) row('子会话集合（他方缺）', missingOnTheirs.map(shortId).join(','), '—', 'INFO', '集合差异，列出不判')
  if (missingOnOurs.length > 0) row('子会话集合（我方缺）', '—', missingOnOurs.map(shortId).join(','), 'INFO', '集合差异，列出不判')
  for (const c of ourChildren) {
    const s = theirById.get(c.id)
    if (!s) continue // 集合差异已列 INFO
    const theirTokens = sum4(s.totals)
    row(`子 ${shortId(c.id)} tokens`, Number(c.tokens) || 0, theirTokens, Number(c.tokens) === theirTokens ? 'PASS' : 'FAIL', 'A1 精确一致（容差 0）')
    const or = childRates.get(c.id)
    const pairs = [
      ['avgFirstTokenMs', or?.avgFirstTokenMs ?? null, typeof s.averageFirstTokenMs === 'number' ? s.averageFirstTokenMs : null],
      ['tokensPerSecond', or?.tokensPerSecond ?? null, typeof s.tokensPerSecond === 'number' ? s.tokensPerSecond : null],
    ]
    for (const [name, o, t] of pairs) {
      if (o === null || t === null) {
        row(`子 ${shortId(c.id)} ${name}`, o ?? 'null', t ?? 'null', 'INFO', '一侧 null 不判')
      } else {
        row(`子 ${shortId(c.id)} ${name}`, Math.round(o), Math.round(t), relTolOk(o, t) ? 'PASS' : 'FAIL', `±${TOL_PCT}%`)
      }
    }
  }

  return { id, cmp, error: null, detail, tt, context, composition, childRates, source, name: typeof detail?.index?.name === 'string' ? detail.index.name : '' }
}

/** 打印一个样本会话的对照块（表 + 原始 JSON 段）。 */
function printSampleBlock(s) {
  const short = String(s.id).replace(/^session-/, '')
  console.log(`\n  ▸ ${short}${s.name ? `（${s.name.slice(0, 30)}）` : ''}   我方 0.1.7 数据来源: ${s.source}`)
  if (s.error) { console.log(`    [端点错误] ${s.error}`); return }
  console.log(`    ${pad('项', 34)}${pad('我方', 15)}${pad('他方', 15)}${pad('判定', 6)}说明`)
  for (const r of s.cmp) {
    const o = typeof r.o === 'number' ? fmt(r.o) : String(r.o)
    const t = typeof r.t === 'number' ? fmt(r.t) : String(r.t)
    console.log(`    ${pad(r.name, 34)}${pad(o, 15)}${pad(t, 15)}${pad(r.verdict, 6)}${r.note ?? ''}`)
  }
  const clip = (x, n = 520) => {
    const s2 = JSON.stringify(x)
    return s2 === undefined ? 'undefined' : (s2.length > n ? `${s2.slice(0, n)}…` : s2)
  }
  console.log(`    我方 context    : ${clip(s.context)}`)
  console.log(`    他方 context    : ${clip(s.tt?.context ?? null)}`)
  console.log(`    我方 composition: ${clip(s.composition)}`)
  console.log(`    他方 composition: ${clip(s.tt?.composition ?? null)}`)
  const bm = Array.isArray(s.detail?.byModel) ? s.detail.byModel[0] : null
  console.log(`    我方 byModel[0] : ${clip(bm)}${bm && typeof bm.name === 'string' ? '' : '（name 省略：llm 元数据未解析到，contract 允许）'}`)
}

async function main() {
  console.log('════ 逐会话对账 · dsh-usage-ledger vs dsh-token-total · compare-sessions.mjs ════')
  console.log(`模式: ${STRICT ? 'strict（判据命中 → exit 1）' : '报告（默认，exit 0）'}   时间: ${new Date().toISOString()}`)
  console.log(`端口: ${PORT}（我方 ${OURS_URL}）`)

  // 端点可达性预检（网络级失败 → exit 2，给可读提示）。
  for (const [label, url, body] of [['我方', OURS_URL, { id: '__reachability_probe__' }], ['他方', THEIRS_URL, { sessionId: '__reachability_probe__' }]]) {
    try { await postJson(url, body, 10_000) } catch (err) {
      if (err instanceof EndpointDown) { console.error(`\n[exit 2] ${label}端点不可达: ${err.message}`); process.exit(2) }
      // 非 200 信封（如 probe id 查无此会话）也算可达。
    }
  }

  const ids = listDiskSessions()
  const rows = []
  const errors = []
  for (const id of ids) {
    let ours = null
    let theirs = null
    try { ours = extractOurs(await postJson(OURS_URL, { id })) }
    catch (err) { errors.push(`${id}: 我方端点 ${err.message}`); continue }
    try { theirs = extractTheirs(await postJson(THEIRS_URL, { sessionId: id }, 60_000)) }
    catch (err) { errors.push(`${id}: 他方端点 ${err.message}`); continue }
    const active = ours.newestTime !== null && (now - ours.newestTime) < ACTIVE_WINDOW_MS
    const diffs = {}
    for (const b of BUCKETS) {
      const d = ours[b.key] - theirs[b.key]
      const base = Math.max(ours[b.key], theirs[b.key], 1)
      diffs[b.key] = { delta: d, pct: Math.abs(d) / base * 100 }
    }
    rows.push({ id, ours, theirs, active, diffs })
  }
  rows.sort((a, b) => Math.max(b.ours.tokens, b.theirs.tokens) - Math.max(a.ours.tokens, a.theirs.tokens))

  // ── task-11 v7 字段联调校验 ──
  const v7 = { childrenSeen: false, byModelBucketsOk: false, sample: null }
  for (const r of rows) {
    if (r.ours.children && r.ours.children.length > 0) v7.childrenSeen = true
    if (r.ours.byModelBucketsOk) v7.byModelBucketsOk = true
    if (!v7.sample && (r.ours.children?.length > 0 || r.ours.byModel?.length > 0)) {
      v7.sample = { id: r.id, child: r.ours.children?.[0] ?? null, model: r.ours.byModel?.[0] ?? null }
    }
  }
  const v7Missing = !rows.some((r) => r.ours.children !== null)
  const v7Ok = v7.childrenSeen && v7.byModelBucketsOk

  // ── 逐会话表 ──
  console.log(`\n── 逐会话对账（${rows.length} 会话；按规模降序）`)
  console.log(`${pad('session', 12)}${pad('name', 26)}${pad('我方 tokens', 15)}${pad('他方 tokens', 15)}${pad('Δ', 14)}${pad('Δ%', 8)}标记`)
  for (const r of rows) {
    const d = r.diffs.tokens
    const flag = Math.abs(d.delta) < 1 ? '✓' : d.pct <= 1 ? '~' : '✗'
    const marks = [flag]
    if (r.active) marks.push('ACT')
    if (r.ours.degraded) marks.push('deg')
    if (r.theirs.coverage?.complete === false) marks.push('tt窗口')
    const short = r.id.replace(/^session-/, '').slice(0, 10)
    console.log(`${pad(short, 12)}${pad((r.ours.name || '—').slice(0, 26), 26)}${pad(fmt(r.ours.tokens), 15)}${pad(fmt(r.theirs.tokens), 15)}${pad((d.delta >= 0 ? '+' : '') + fmt(d.delta), 14)}${pad(d.pct.toFixed(2) + '%', 8)}${marks.join(' ')}`)
  }

  // ── 差异明细与归因线索 ──
  const exact = rows.filter((r) => BUCKETS.every((b) => Math.abs(r.diffs[b.key].delta) < 1))
  const differing = rows.filter((r) => !exact.includes(r))
  console.log(`\n── 汇总：总对比 ${rows.length} · 精确一致 ${exact.length} · 有差异 ${differing.length} · 端点错误 ${errors.length}`)
  if (differing.length > 0) {
    console.log('\n── 差异会话明细（四桶 + 归因线索）')
    for (const r of differing) {
      const short = r.id.replace(/^session-/, '')
      const hints = []
      if (r.active) hints.push('活会话：实时尾巴时序差（我方 live 计数 vs 他方按需读日志快照）——但若多次运行 Δ 恒定，则非时序差而是固定历史缺口，需人工看')
      if (r.theirs.coverage?.complete === false) hints.push(`他方日志覆盖不完整 coverage=${JSON.stringify(r.theirs.coverage)}`)
      const newestDay = r.ours.newestTime !== null ? new Date(r.ours.newestTime).toISOString().slice(0, 10) : null
      if (newestDay === '2026-10-10' || newestDay === '2026-10-11') hints.push('他方 retry 口径差（历史已知 10-10/10-11 +136K 级）')
      if (r.diffs.tokens.delta < 0 && r.ours.newestTime !== null && (now - r.ours.newestTime) > 30 * 86_400_000) hints.push('他方 30 天明细窗口外可能不完整（老会话他方偏低方向不符，需人工看）')
      if (hints.length === 0) hints.push('需人工看')
      console.log(`\n  ${short}${r.ours.name ? `（${r.ours.name.slice(0, 30)}）` : ''}  ${r.active ? '[ACT 活会话]' : ''}`)
      for (const b of BUCKETS) {
        const d = r.diffs[b.key]
        if (Math.abs(d.delta) < 1) continue
        console.log(`    ${pad(b.label, 10)} 我方 ${fmt(r.ours[b.key])} vs 他方 ${fmt(r.theirs[b.key])}  Δ ${d.delta >= 0 ? '+' : ''}${fmt(d.delta)}（${d.pct.toFixed(2)}%）`)
      }
      if (r.ours.requests !== undefined && r.theirs.requests !== undefined) {
        console.log(`    requests   我方 ${fmt(r.ours.requests)} vs 他方 ${fmt(r.theirs.requests)}`)
      }
      for (const h of hints) console.log(`    ↳ ${h}`)
    }
    if (rows.some((r) => r.theirs.requests === undefined)) {
      console.log('\n  （注：他方 session 端点实测无 requests 字段，该项不可对比，已跳过）')
    }
  }
  if (errors.length > 0) {
    console.log(`\n── 端点错误（${errors.length}，未计入对比）`)
    for (const e of errors) console.log(`  · ${e}`)
  }

  // ── task-11 v7 字段校验结果 ──
  console.log('\n── task-11 新字段联调校验（children[] / byModel 四桶）')
  if (v7Missing) {
    console.log('  FAIL — live 端点未返回 children/byModel 字段：宿主实例运行的是旧代码')
    console.log('        （磁盘已装副本 0.1.6 已含 v7 sessionDetail；需插件重载/宿主重启后复跑——本工具不代为操作）')
  } else {
    console.log(`  children[] 非空: ${v7.childrenSeen ? 'PASS' : 'FAIL（所有会话都无后代成员）'}`)
    console.log(`  byModel 四桶齐全: ${v7.byModelBucketsOk ? 'PASS' : 'FAIL（字段在但四桶缺失/为空）'}`)
    if (v7.sample) {
      console.log(`  样本（${v7.sample.id}）:`)
      console.log(`    children[0]: ${JSON.stringify(v7.sample.child)}`)
      console.log(`    byModel[0]: ${JSON.stringify(v7.sample.model)}`)
    }
  }

  // ── B 部分：0.1.7 并排对照（task-17）──
  const sampleIds = pickSampleIds(rows)
  const sbWarn = { list: [], push(m) { this.list.push(m) } }
  const samples = []
  if (sampleIds.length > 0) {
    const calculator = createSessionViewCalculator({ getPersistence: () => mockPersistence(diskLogIndex(), sbWarn) })
    for (const id of sampleIds) samples.push(await compareSampleSession(id, calculator))
  }
  console.log(`\n── 0.1.7 并排对照（context / composition / 子会话速率；样本 ${samples.length}）`)
  if (samples.length === 0) console.log('  （无样本会话：--id 指定或磁盘上有子会话的会话）')
  for (const s of samples) printSampleBlock(s)
  const sbAll = samples.flatMap((s) => s.cmp)
  const sbPass = sbAll.filter((r) => r.verdict === 'PASS').length
  const sbFail = sbAll.filter((r) => r.verdict === 'FAIL').length
  const sbInfo = sbAll.filter((r) => r.verdict === 'INFO').length
  const sbErrors = samples.filter((s) => s.error).length
  console.log(`\n  对照汇总：PASS ${sbPass} · FAIL ${sbFail} · INFO ${sbInfo} · 端点错误 ${sbErrors}`)
  if (sbFail > 0) {
    for (const s of samples) {
      for (const r of s.cmp.filter((x) => x.verdict === 'FAIL')) {
        const o = typeof r.o === 'number' ? fmt(r.o) : String(r.o)
        const t = typeof r.t === 'number' ? fmt(r.t) : String(r.t)
        console.log(`      · ${shortId(s.id)} ${r.name}: 我方 ${o} vs 他方 ${t}（${r.note}）`)
      }
    }
  }
  if (sbWarn.list.length > 0) {
    console.log(`  组装器警告（${sbWarn.list.length}）`)
    for (const w of sbWarn.list) console.log(`    · ${w}`)
  }
  const live017 = samples.some((s) => s.source === 'live 端点')
  if (samples.length > 0 && !live017) {
    console.log('  注：live 端点尚未返回 0.1.7 的 context/composition/速率键 —— 我方数值来自工作区组装器')
    console.log('      in-process（只读直读磁盘真实日志）；宿主重载插件后复跑即可转 live 来源。')
  }

  // ── strict 判据 ──
  const violations = []
  for (const r of rows) {
    if (r.active) continue // 活会话只列出不判
    for (const b of BUCKETS) {
      const d = r.diffs[b.key]
      const base = Math.max(r.ours[b.key], r.theirs[b.key], 1)
      if (d.pct > 0.5 && Math.abs(d.delta) > 10_000) {
        violations.push(`${r.id} [${b.label}] Δ${d.delta >= 0 ? '+' : ''}${fmt(d.delta)}（${(d.pct).toFixed(2)}% of ${fmt(base)}）`)
      }
    }
  }
  console.log(`\n── 判据${STRICT ? '（strict）' : '（报告模式列出，不影响退出码）'}`)
  console.log(`  [S1] 非活会话四桶 |Δ| ≤ 0.5% 或 ≤ 10K  ${violations.length === 0 ? 'PASS' : 'FAIL'}  — ${violations.length === 0 ? '全部通过' : `${violations.length} 项违反`}`)
  for (const v of violations) console.log(`      · ${v}`)
  console.log(`  [S2] task-11 children[]/byModel 四桶联调  ${v7Ok ? 'PASS' : 'FAIL'}`)
  console.log(`  [S3] 0.1.7 A1/A2 与 ±${TOL_PCT}% 容差对照  ${sbFail === 0 ? 'PASS' : `FAIL — ${sbFail} 项超容差（null 跳过项未计）`}`)

  console.log('\n── 说明')
  console.log('  · 我方与他方 totals 均为“本会话+全部后代”口径（我方 BFS、他方 self+compaction+subagents），可直接对比。')
  console.log('  · 活会话（ACT）：我方 live 计数、他方按需读日志，实时尾巴存在时序差，只列出不判（30 分钟窗口）。')
  console.log('  · 他方 retry 计数口径差、30 天明细窗口外不完整为已知可解释差异（见各差异行归因线索）。')
  console.log('  · composition 的 billed 来自 provider 精确 usage（A2 精确判）；分桶与 context.totalTokens 是字符估算（±15% 判）。')

  if (STRICT) {
    const hit = [violations.length > 0 ? 'S1' : '', !v7Ok ? 'S2' : '', sbFail > 0 ? 'S3' : ''].filter(Boolean)
    if (hit.length > 0) {
      console.log(`\nstrict FAIL: ${hit.join(', ')} 判据命中`)
      process.exit(1)
    }
    console.log('\nstrict PASS: 全部判据通过')
  } else {
    console.log('\n报告模式完成（exit 0）')
  }
}

main().catch((err) => {
  console.error(`\n[硬错误] ${err?.stack ?? err}`)
  process.exit(1)
})
