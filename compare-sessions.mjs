// compare-sessions.mjs — 逐会话对账：dsh-usage-ledger vs dsh-token-total（task-13）。
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
//   端点不可达（网络级）→ exit 2（宿主 Web GUI 端口可能变化：--port N 或环境变量
//   COMPARE_SESSIONS_PORT 覆盖，默认 11370）。
//
// 已知可解释差异（归因线索，报告注明）：
//   · 活会话实时尾巴时序差（我方 live 计数 vs 他方按需读日志快照）。
//   · token-total 对 retry 尝试的计数口径差（历史上 10-10/10-11 有 +136K 级差异）。
//   · 他方 30 天明细窗口外不完整（老会话他方可能偏低；他方响应带 coverage 佐证）。
//
// 约束：对 C:\Users\18283\.dsh 只读；不 toggle/不 POST /reset 等任何线上操作；
// 不 git commit；ESM 单文件，零运行时依赖。
//
// 运行：node compare-sessions.mjs [--strict] [--port N]

import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const DSH_HOME = process.env.VERIFY_DSH_HOME || 'C:/Users/18283/.dsh'
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')

const args = process.argv.slice(2)
const STRICT = args.includes('--strict')
const portArgIdx = args.indexOf('--port')
const PORT = Number(portArgIdx >= 0 ? args[portArgIdx + 1] : process.env.COMPARE_SESSIONS_PORT ?? 11370)
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`[硬错误] 无效端口: ${PORT}`)
  process.exit(2)
}
const OURS_URL = `http://127.0.0.1:${PORT}/usage-ledger/api/session`
const THEIRS_URL = `http://127.0.0.1:${PORT}/token-total/api/session`

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

  console.log('\n── 说明')
  console.log('  · 我方与他方 totals 均为“本会话+全部后代”口径（我方 BFS、他方 self+compaction+subagents），可直接对比。')
  console.log('  · 活会话（ACT）：我方 live 计数、他方按需读日志，实时尾巴存在时序差，只列出不判（30 分钟窗口）。')
  console.log('  · 他方 retry 计数口径差、30 天明细窗口外不完整为已知可解释差异（见各差异行归因线索）。')

  if (STRICT) {
    if (violations.length > 0 || !v7Ok) {
      console.log(`\nstrict FAIL: ${[violations.length > 0 ? 'S1' : '', !v7Ok ? 'S2' : ''].filter(Boolean).join(', ')} 判据命中`)
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
