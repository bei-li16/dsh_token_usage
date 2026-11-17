// verify-usage.mjs — dsh-usage-ledger 三方对账验收工具（task-2）。
//
// 三方数据源：
//   1. ground truth：直接解码磁盘会话日志 C:\Users\18283\.dsh\sessions\
//      <workspace-dir>\<session-dir>\session.v4.jsonl.zstd（多 zstd frame 串联），
//      用插件自己的 RequestFold（./dsh-usage-ledger/src/collector/fold.js）逐条回放
//      —— 完全绕过宿主 API 与插件回填编排，只读。
//   2. ledger：插件 HTTP API（POST /usage-ledger/api/{status,summary,daily}）。
//   3. token-total：dsh-token-total 历史文件 storages\token_total_history.json
//      的 tables.days（键 "YYYY-MM-DD|agent|model"，tokens = in+out+cacheRead+cacheWrite）。
//
// --strict 判据（任一命中 → exit 1；默认报告模式只报告，exit 0）：
//   [a] ledger 终身 < groundTruth × 0.95（回填缺口）
//   [b] 除补偿日 2026-11-07（约 2.1M 已删会话）外，任一日 ledger < token-total
//   [c] fork 日（有 fork/子会话贡献的日子）ledger > groundTruth × 1.02（fork 双计）
//   [d] ledger 终身 > groundTruth × 1.05（防重复计数护栏，lead 2026-11-17 增补）
//   [e] 任一日（GT>0）ledger > 该日 groundTruth × 1.10（防重复计数护栏）
//       注：GT=0 但 ledger>0 的日子是已删会话日（磁盘日志已不存在，GT 天生看不见），
//       无法据 GT 判双计 —— 计入信息注记而非违规；跨日重复计数由 [d] 终身护栏兜底。
//
// 实现要点（与采集器 collector.js 对齐）：
//   - v4 日志 = 多个 zstd frame 串联，每 frame 解压出一段 JSONL 文本（多条记录）。
//     node:zlib 的 zstdDecompressSync 只解输入的第一帧（实测：多帧输入不报错、
//     截断帧也可能不报错），所以必须按 magic 28 B5 2F FD 从偏移 4 起扫描切 frame，
//     逐段解压；某段解压失败则与下一段合并重试（容忍撕裂尾部/写一半的 frame），
//     合并到末尾仍失败 → 计入警告跳过。撕裂尾部的截断 JSON 行由逐行解析警告兜底。
//   - fork 子会话（含 isSeeded 延续会话）只统计 inheritedEventCount 之上的事件；
//     inheritedEventCount 读 storages\session_projcache\sessions\session-<id>.json 的
//     record.identity.inheritedEventCount，读不到按 0。子会话（header.parentSession）
//     与 seeded 会话的区分以 projcache 为准（实测 seeded fork 子会话头里没有
//     parentSession 字段，而普通 subagent 有 parentSession 但 cut=0，按 cut 统一处理
//     与采集器 readLog/replaySession 的行为一致）。
//   - 对 C:\Users\18283\.dsh 下一切路径只读；本文件零运行时依赖（node 内置模块）。
//
// 运行：node verify-usage.mjs [--strict]
// 退出码：报告模式 0（除非数据源不可达等硬错误 → 1）；strict 模式判据任一命中 → 1。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { RequestFold } from './dsh-usage-ledger/src/collector/fold.js'

const DSH_HOME = process.env.VERIFY_DSH_HOME || 'C:/Users/18283/.dsh'
const SESSIONS_ROOT = join(DSH_HOME, 'sessions')
const PROJCACHE_ROOT = join(DSH_HOME, 'storages', 'session_projcache', 'sessions')
const TOKEN_TOTAL_FILE = join(DSH_HOME, 'storages', 'token_total_history.json')
const API_BASE = process.env.VERIFY_LEDGER_API || 'http://127.0.0.1:14400/usage-ledger/api/'
const V4_LOG_NAME = 'session.v4.jsonl.zstd'
// 已删会话补偿日（token-total 约 2.1M 来自已删除会话，集中在该日，允许 ledger < tt）。
const COMP_DAY = '2026-11-07'
const STRICT = process.argv.includes('--strict')

// ── 小工具 ─────────────────────────────────────────────────────────────────

const fmt = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 0).toLocaleString('en-US')
const pct = (a, b) => (b > 0 ? `${(a / b * 100).toFixed(1)}%` : '—')

class Warn {
  constructor(cap = 40) { this.list = []; this.cap = cap }
  push(msg) {
    if (this.list.length < this.cap) this.list.push(msg)
    else if (this.list.length === this.cap) this.list.push('……（后续警告省略）')
  }
  get size() { return this.list.length }
}

// ── ground truth：v4 多 frame zstd 日志解码 + RequestFold 回放 ────────────

const ZSTD_MAGIC = 0xfd2fb528 // 小端 28 B5 2F FD

/** 解码一个 session.v4.jsonl.zstd：按 magic 切 frame 逐段解压，容忍撕裂段。
 *  返回 {records, warnings}；从不 throw（0KB / 全解不出 → 空 records + 警告）。 */
function decodeV4Log(buf, label, warn) {
  if (buf.length === 0) { warn.push(`${label}: 0KB 日志`); return [] }
  const bounds = [0]
  for (let i = 4; i + 4 <= buf.length; i++) if (buf.readUInt32LE(i) === ZSTD_MAGIC) bounds.push(i)
  const records = []
  let idx = 0
  while (idx < bounds.length) {
    const from = bounds[idx]
    let consumed = -1
    // 先试 [from, 下一边界)，失败则与下一段合并重试直到末尾。
    for (let j = idx + 1; j <= bounds.length; j++) {
      const to = j < bounds.length ? bounds[j] : buf.length
      try {
        const text = zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
        for (const line of text.split('\n')) {
          const s = line.trim()
          if (!s) continue
          try { records.push(JSON.parse(s)) } catch {
            warn.push(`${label}: 字节段 [${from},${to}) 一行 JSON 解析失败（撕裂尾部容忍），跳过该行`)
          }
        }
        consumed = j
        break
      } catch {
        if (j === bounds.length) {
          warn.push(`${label}: 字节段 [${from},${to}) 合并到末尾仍解压失败，跳过该段`)
        }
      }
    }
    if (consumed === -1) break // 该段到文件尾整体不可解，无法前进
    idx = consumed
  }
  return records
}

/** projcache 的 inheritedEventCount（fork/seeded 继承前缀长度），读不到按 0。
 *  实测文件名约定是 <sessionId>.json（subagent 裸 id 无 session- 前缀、主会话 id 自带
 *  前缀），为稳妥同时尝试几种候选名。 */
function inheritedCutOf(sessionId, warn) {
  if (!sessionId) return 0
  const bare = sessionId.replace(/^session-/, '')
  const candidates = [...new Set([sessionId, bare, `session-${sessionId}`, `session-${bare}`])]
  for (const name of candidates) {
    try {
      const j = JSON.parse(readFileSync(join(PROJCACHE_ROOT, `${name}.json`), 'utf8'))
      const n = j?.record?.identity?.inheritedEventCount
      if (typeof n === 'number' && Number.isFinite(n) && n >= 0) return Math.floor(n)
    } catch { /* 试下一个候选名 */ }
  }
  return 0
}

/** 扫描全部磁盘会话，RequestFold 回放 → 终身/按日 ground truth。 */
function scanGroundTruth(warn) {
  const sessionRows = []
  const byDay = new Map()
  const forkDays = new Map() // day → tokens（fork/子会话贡献）
  if (!existsSync(SESSIONS_ROOT)) {
    warn.push(`sessions 根目录不存在: ${SESSIONS_ROOT}`)
    return { sessionRows, byDay, forkDays }
  }
  for (const ws of readdirSync(SESSIONS_ROOT, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    for (const sd of readdirSync(join(SESSIONS_ROOT, ws.name), { withFileTypes: true })) {
      if (!sd.isDirectory()) continue
      const file = join(SESSIONS_ROOT, ws.name, sd.name, V4_LOG_NAME)
      let buf
      try {
        const st = statSync(file)
        if (st.size === 0) { warn.push(`${ws.name}/${sd.name}: 0KB 日志，跳过`); continue }
        buf = readFileSync(file)
      } catch (err) {
        if (err?.code === 'ENOENT') continue // 无 v4 日志（.bak/旧格式）→ 按约定忽略
        warn.push(`${ws.name}/${sd.name}: 读取失败 ${err?.message ?? err}`); continue
      }
      const label = `${ws.name}/${sd.name}`
      let records
      try { records = decodeV4Log(buf, label, warn) }
      catch (err) { warn.push(`${label}: 解码异常 ${err?.message ?? err}（全跳过）`); continue }
      if (records.length === 0) { warn.push(`${label}: 一条记录也解不出，跳过`); continue }
      // 头记录（首条 {"type":"session",...}）。
      const header = records.find((r) => r && r.type === 'session') ?? null
      if (!header) warn.push(`${label}: 缺 session 头记录（继续按无名会话回放）`)
      const id = typeof header?.id === 'string' && header.id !== '' ? header.id : sd.name
      const parentId = (typeof header?.parentSession === 'string' && header.parentSession !== ''
        ? header.parentSession
        : (typeof header?.parentId === 'string' && header.parentId !== '' ? header.parentId : null))
      const cut = inheritedCutOf(id, warn)
      // fork 继承前缀跳过（采集器 replaySession 同款过滤；无 seq 的事件保留）。
      const own = records.filter((r) => !(cut > 0 && typeof r?.seq === 'number' && r.seq < cut))
      const firstOwn = own.find((r) => r && typeof r.type === 'string')
      const kind = firstOwn?.type === 'tool-workflow/agent-start'
        ? 'workflow'
        : (parentId ? 'subagent' : 'main')
      const fold = new RequestFold({ sessionId: id, parentId, kind })
      for (const ev of own) fold.fold(ev) // 输出丢弃：flush 一次性取全量（对齐 backfill 路径）
      const { requests } = fold.flush()
      let tokens = 0
      const days = new Set()
      for (const r of requests) {
        tokens += r.computedTotal
        if (r.computedTotal > 0) {
          byDay.set(r.day, (byDay.get(r.day) ?? 0) + r.computedTotal)
          days.add(r.day)
          // fork/子会话（有 parent 或有继承前缀）贡献的日子 → fork 双计检查对象。
          if (parentId || cut > 0) forkDays.set(r.day, (forkDays.get(r.day) ?? 0) + r.computedTotal)
        }
      }
      if (requests.length === 0 || tokens === 0) warn.push(`${label}: 无 usage（requests=${requests.length}, tokens=0）`)
      sessionRows.push({
        id, parentId, kind, cut, requests: requests.length, tokens,
        days: [...days].sort(),
      })
    }
  }
  sessionRows.sort((a, b) => b.tokens - a.tokens)
  return { sessionRows, byDay, forkDays }
}

// ── token-total 历史文件 ───────────────────────────────────────────────────

function loadTokenTotal(warn) {
  const byDay = new Map()
  let lifetime = 0
  try {
    const j = JSON.parse(readFileSync(TOKEN_TOTAL_FILE, 'utf8'))
    const days = j?.tables?.days
    if (!days || typeof days !== 'object') throw new Error('tables.days 缺失')
    for (const [key, v] of Object.entries(days)) {
      const day = String(key).split('|')[0]
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
      const t = (Number(v?.inputTokens) || 0) + (Number(v?.outputTokens) || 0)
        + (Number(v?.cacheReadTokens) || 0) + (Number(v?.cacheWriteTokens) || 0)
      byDay.set(day, (byDay.get(day) ?? 0) + t)
      lifetime += t
    }
  } catch (err) {
    throw new Error(`token-total 历史文件不可读: ${TOKEN_TOTAL_FILE}（${err?.message ?? err}）`)
  }
  return { byDay, lifetime }
}

// ── ledger 插件 HTTP API（只读：status/summary/daily，绝不 POST /reset）───

async function apiPost(name, body, timeoutMs = 30000) {
  let res
  try {
    res = await fetch(API_BASE + name, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw new Error(`无法访问插件 API ${API_BASE}${name}（${err?.message ?? err}）——`
      + '插件可能未启用或正在重扫；稍后重试，或先 POST /status 看 backfill.running'
      + '（及 sweep 相关字段）确认重扫状态')
  }
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  if (res.status === 403) {
    throw new Error(`API ${name} 被信任围栏拒绝 (HTTP 403)——Host 头非 loopback；`
      + `请以 ${API_BASE} 形式的 loopback URL 直连`)
  }
  if (res.status === 405) throw new Error(`API ${name} 返回 405——路由只收 POST`)
  if (!res.ok || json?.ok !== true) {
    throw new Error(`API ${name} 失败: HTTP ${res.status} ${text.slice(0, 200)}`)
  }
  return json.value
}

async function loadLedger() {
  const status = await apiPost('status', {})
  const summary = await apiPost('summary', {})
  return { status, summary }
}

async function loadLedgerDaily(from, to) {
  const v = await apiPost('daily', { from, to, granularity: 'day' })
  const byDay = new Map()
  for (const b of v?.buckets ?? []) byDay.set(String(b.key), Number(b.tokens) || 0)
  return byDay
}

// ── 报告与判据 ─────────────────────────────────────────────────────────────

const dayKeys = (m) => [...m.keys()].sort()
const union = (...maps) => {
  const out = new Set()
  for (const m of maps) for (const d of m.keys()) out.add(d)
  return [...out].sort()
}

function pad(s, width, right = false) {
  s = String(s)
  return right ? s.padStart(width) : s.padEnd(width)
}

function run() {
  const warn = new Warn()
  const gt = scanGroundTruth(warn)
  const tt = loadTokenTotal(warn)

  const gtLifetime = gt.sessionRows.reduce((a, s) => a + s.tokens, 0)
  const gtDays = dayKeys(gt.byDay)
  const ttDays = dayKeys(tt.byDay)

  return { warn, gt, tt, gtLifetime, gtDays, ttDays }
}

async function main() {
  console.log('════ dsh-usage-ledger 三方对账 · verify-usage.mjs ════')
  console.log(`模式: ${STRICT ? 'strict（判据命中 → exit 1）' : '报告（默认，exit 0）'}   时间: ${new Date().toISOString()}`)

  // 1) ground truth + token-total（先算，才知 daily 拉取范围）。
  const { warn, gt, tt, gtLifetime, gtDays, ttDays } = run()

  // 2) ledger：status + summary；daily 的 from/to 取三方日并集
  //    （ledger 自己的 firstDay 可能早于 GT——已删会话日，只按 GT 范围拉会漏掉这些日）。
  let ledger
  try { ledger = await loadLedger() }
  catch (err) {
    console.error(`\n[硬错误] ${err.message}`)
    process.exitCode = 1
    return
  }
  const ledgerLifetime = Number(ledger.summary?.tokens) || 0
  const ledgerFirstDay = typeof ledger.summary?.firstDay === 'string' ? ledger.summary.firstDay : null
  const ledgerLastDay = typeof ledger.summary?.lastDay === 'string' ? ledger.summary.lastDay : null
  const allDays = [...new Set([...gtDays, ...ttDays, ...(ledgerFirstDay ? [ledgerFirstDay] : []), ...(ledgerLastDay ? [ledgerLastDay] : [])])].sort()
  let from = allDays[0]
  let to = allDays[allDays.length - 1]
  if (from === undefined) { console.error('\n[硬错误] 三方都没有任何日数据'); process.exitCode = 1; return }
  // 路由限制跨度 ≤ 366 天；超限截到最近 366 天（当前数据远小于此，纯防御）。
  {
    const span = Math.round((new Date(`${to}T00:00:00`) - new Date(`${from}T00:00:00`)) / 86_400_000) + 1
    if (span > 366) {
      const d = new Date(`${to}T00:00:00`)
      d.setDate(d.getDate() - 365)
      from = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
      warn.push(`daily 跨度 ${span} 天 > 366，截取 [${from}, ${to}]`)
    }
  }
  let ledgerByDay
  try { ledgerByDay = await loadLedgerDaily(from, to) }
  catch (err) {
    console.error(`\n[硬错误] ${err.message}`)
    process.exitCode = 1
    return
  }

  // 3) 数据源概览。
  console.log('\n── 数据源')
  console.log(`ground truth : ${gt.sessionRows.length} 会话（磁盘 ${V4_LOG_NAME} 直算，RequestFold 回放）`
    + `  终身 ${fmt(gtLifetime)} tok · ${gtDays[0] ?? '—'} .. ${gtDays[gtDays.length - 1] ?? '—'} · ${gtDays.length} 个有效日`)
  const bf = ledger.status?.backfill
  console.log(`ledger       : POST ${API_BASE}{status,summary,daily}（backend=${ledger.status?.backend}`
    + `${bf?.running === true ? '，重扫进行中!' : '，backfill 空闲'}）  终身 ${fmt(ledgerLifetime)} tok`
    + ` · ${ledgerFirstDay ?? '—'} .. ${ledgerLastDay ?? '—'}`)
  console.log(`token-total  : ${TOKEN_TOTAL_FILE}  终身 ${fmt(tt.lifetime)} tok · ${ttDays.length} 个有效日`)

  // 4) 终身三方对比。
  const gapLt = ledgerLifetime - gtLifetime
  const gapTt = tt.lifetime - gtLifetime
  console.log('\n── 终身对比')
  console.log(`  groundTruth  ${pad(fmt(gtLifetime), 16)}`)
  console.log(`  ledger       ${pad(fmt(ledgerLifetime), 16)}  (${gapLt >= 0 ? '+' : ''}${fmt(gapLt)}, ${pct(ledgerLifetime, gtLifetime)} of GT)`
    + `${gapLt < -gtLifetime * 0.05 ? '  ← 终身缺口' : ''}${gapLt > gtLifetime * 0.05 ? '  ← 疑似终身双计' : ''}`)
  console.log(`  token-total  ${pad(fmt(tt.lifetime), 16)}  (${gapTt >= 0 ? '+' : ''}${fmt(gapTt)}, ${pct(tt.lifetime, gtLifetime)} of GT)`)

  // 5) 按日对账表（任一方非零的日）。
  const tableDays = union(gt.byDay, tt.byDay, ledgerByDay).filter((d) =>
    (gt.byDay.get(d) ?? 0) > 0 || (tt.byDay.get(d) ?? 0) > 0 || (ledgerByDay.get(d) ?? 0) > 0)
  console.log('\n── 按 day 对账（groundTruth / ledger / token-total）')
  const W = { day: 12, n: 15, d: 15 }
  console.log(`${pad('day', W.day)}${pad('groundTruth', W.n)}${pad('ledger', W.n)}${pad('token-total', W.n)}${pad('ledger−GT', W.d)}标记`)
  const violationsB = [] // 非补偿日 ledger < tt
  const violationsC = [] // fork 日 ledger > GT×1.02
  const violationsE = [] // GT>0 日 ledger > GT×1.10
  const gtZeroLedgerDays = [] // GT=0 但 ledger>0（已删会话日，无法判双计）
  for (const day of tableDays) {
    const g = gt.byDay.get(day) ?? 0
    const l = ledgerByDay.get(day) ?? 0
    const t = tt.byDay.get(day) ?? 0
    const flags = []
    if (gt.forkDays.has(day)) flags.push('F')
    if (day === COMP_DAY) flags.push('补')
    if (t > 0 && l < t && day !== COMP_DAY) { flags.push('TT↑'); violationsB.push(day) }
    if (g === 0 && (l > 0 || t > 0)) { flags.push('GT缺'); gtZeroLedgerDays.push(day) }
    if (g > 0 && l > g * 1.02 && gt.forkDays.has(day)) { flags.push('fork双计?'); violationsC.push(day) }
    if (g > 0 && l > g * 1.10) { flags.push('双计?'); violationsE.push(day) }
    console.log(`${pad(day, W.day)}${pad(fmt(g), W.n)}${pad(fmt(l), W.n)}${pad(fmt(t), W.n)}${pad((l - g >= 0 ? '+' : '') + fmt(l - g), W.d)}${flags.join(' ')}`)
  }

  // 6) fork 日明细。
  const forkDayList = dayKeys(gt.forkDays)
  console.log('\n── fork/子会话日（GT 中 fork 子会话有贡献的日子）')
  if (forkDayList.length === 0) console.log('  （无）')
  for (const day of forkDayList) {
    const g = gt.byDay.get(day) ?? 0
    const l = ledgerByDay.get(day) ?? 0
    const forkTokens = gt.forkDays.get(day) ?? 0
    console.log(`  ${day}: GT ${fmt(g)}（其中子会话 ${fmt(forkTokens)}） · ledger ${fmt(l)}`
      + ` · ${l > g * 1.02 ? 'ledger 超出 GT×1.02 ← fork 双计嫌疑' : '未超 GT×1.02'}`)
  }

  // 7) 会话级 ground truth 明细（tokens 降序）。
  console.log('\n── ground truth 会话明细（tokens 降序）')
  console.log(`${pad('sessionId', 46)}${pad('kind', 9)}${pad('cut', 6)}${pad('reqs', 6)}${pad('tokens', 16)}days`)
  for (const s of gt.sessionRows) {
    console.log(`${pad(s.id, 46)}${pad(s.kind, 9)}${pad(s.cut, 6)}${pad(s.requests, 6)}${pad(fmt(s.tokens), 16)}${s.days[0] ?? '—'}${s.days.length > 1 ? ` .. ${s.days[s.days.length - 1]}` : ''}`)
  }

  // 8) --strict 判据（报告模式同样逐条列出，只是不影响退出码）。
  const checkA = ledgerLifetime < gtLifetime * 0.95
  const checkD = ledgerLifetime > gtLifetime * 1.05
  const checks = [
    { id: 'a', label: 'ledger 终身 ≥ groundTruth × 0.95', fail: checkA,
      detail: `${fmt(ledgerLifetime)} vs ${fmt(gtLifetime)}（${pct(ledgerLifetime, gtLifetime)}）` },
    { id: 'b', label: `除补偿日 ${COMP_DAY} 外每日 ledger ≥ token-total`, fail: violationsB.length > 0,
      detail: violationsB.length > 0 ? `${violationsB.length} 日违反: ${violationsB.join(', ')}` : '全部通过' },
    { id: 'c', label: 'fork 日 ledger ≤ groundTruth × 1.02', fail: violationsC.length > 0,
      detail: violationsC.length > 0 ? `${violationsC.length} 日违反: ${violationsC.join(', ')}` : '全部通过' },
    { id: 'd', label: 'ledger 终身 ≤ groundTruth × 1.05（防双计护栏）', fail: checkD,
      detail: `${fmt(ledgerLifetime)} vs ${fmt(gtLifetime)}（${pct(ledgerLifetime, gtLifetime)}）` },
    { id: 'e', label: '每日 ledger ≤ groundTruth × 1.10（防双计护栏）', fail: violationsE.length > 0,
      detail: violationsE.length > 0 ? `${violationsE.length} 日违反: ${violationsE.join(', ')}` : '全部通过' },
  ]
  console.log(`\n── 判据${STRICT ? '（strict）' : '（报告模式列出，不影响退出码）'}`)
  for (const c of checks) console.log(`  [${c.id}] ${c.label}  ${c.fail ? 'FAIL' : 'PASS'}  — ${c.detail}`)
  const failed = checks.filter((c) => c.fail)

  // 9) 警告。
  console.log(`\n── 警告（${warn.size}）`)
  if (warn.size === 0) console.log('  （无）')
  else for (const m of warn.list) console.log(`  · ${m}`)

  // 10) 说明。
  console.log('\n── 说明')
  console.log('  · 活会话（本工具所在会话等）日志实时追加：GT 快照稍滞后，ledger 实时尾巴可能'
    + '暂时领先 GT —— 终身 5%/每日 10%/fork 2% 判据已覆盖该时序容差。')
  console.log(`  · ${COMP_DAY}：token-total 约 2.1M 来自已删除会话，该日允许 ledger < token-total（判据 b 豁免）。`)
  if (gtZeroLedgerDays.length > 0) {
    console.log(`  · GT=0 但 ledger/token-total > 0 的日子（已删会话日，GT 无法回放、无法据 GT 判双计）: ${gtZeroLedgerDays.join(', ')}`)
  }

  if (STRICT && failed.length > 0) {
    console.log(`\nstrict FAIL: ${failed.map((c) => c.id).join(', ')} 号判据命中`)
    process.exitCode = 1
  } else {
    console.log(STRICT ? '\nstrict PASS: 全部判据通过' : '\n报告模式完成（exit 0）')
  }
}

main().catch((err) => {
  console.error(`\n[硬错误] ${err?.stack ?? err}`)
  process.exitCode = 1
})
