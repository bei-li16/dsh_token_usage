// routes.js — dsh-usage-ledger 的 fenced JSON API：/usage-ledger/api 前缀路由上的
// 小型 JSON RPC。方法：summary | daily | heatmap | sessions | session | tools |
// status | reset（全 POST）。
//
// 设计（为什么长这样）：
// - 一切请求先过 fence.js 的浏览器信任围栏（Host 头 loopback/trustedHosts/bind
//   地址 + cross-site/Origin 校验），不过 → 403；围栏判定 fail-closed（trust
//   输入解析抛错视为不可信），handler 全 try/catch，绝不向 webserver 抛异常。
// - 只收 POST；子路径 = url 去掉前缀后的第一段，未知 → 404，已知但非 POST → 405。
// - body 用 async iterator 读，上限 64 KiB（413）；JSON.parse 失败 → 400；空 body
//   与非对象 JSON 一律按 {} 处理（观测面 RPC，参数全靠默认值兜底）。
// - 响应统一 {ok:true,value} | {ok:false,error:{code,message}}，头带
//   content-type: application/json; charset=utf-8 + cache-control: no-store。
// - 4xx 回显用户向消息；500 一律 'internal error'，真实错误只进 deps.logger
//   （index.js 目前未接线 logger，静默丢弃也不影响正确性）。
// - 本层只读 store（派生缓存），绝不自己读会话日志；日期校验照抄 token-total 的
//   parseDayKey（回绝 2026-13-45 这类翻卷形状），跨度上限 366 天。

import { createTrustFence } from './fence.js'

const PREFIX = '/usage-ledger/api'

/** JSON body 上限。面板只 post 小对象；上限只为约束行为异常的 trusted 客户端。 */
const MAX_JSON_BODY_BYTES = 64 * 1024
/** 自定义日期跨度上限（一个闰年）——约束 daily/tools 响应体积。 */
const MAX_CUSTOM_SPAN_DAYS = 366

const METHODS = new Set(['summary', 'daily', 'heatmap', 'sessions', 'session', 'tools', 'status', 'reset'])
const GROUPS = new Set(['model', 'kind', 'tool'])
const GRANULARITIES = new Set(['day', 'hour'])

/** 用户可见错误，携带 HTTP status 与稳定 code。 */
class LedgerApiError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

/** 把 async-iterable 请求体读成 UTF-8 文本并 JSON.parse；空体返回 undefined。 */
async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
  let body = ''
  let bytes = 0
  for await (const chunk of req) {
    bytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength
    if (bytes > maxBytes) {
      throw new LedgerApiError(413, 'payload_too_large', `usage ledger: request body exceeds ${maxBytes} bytes`)
    }
    body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
  }
  if (body === '') return undefined
  try {
    return JSON.parse(body)
  } catch {
    throw new LedgerApiError(400, 'bad_request', 'usage ledger: invalid json body')
  }
}

function writeJson(res, value, status = 200) {
  res.statusCode = status
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

function writeError(res, err) {
  const status = err instanceof LedgerApiError ? err.status : 500
  // 刻意的 4xx 携带用户向消息；意外 500 不回显内部错误文本（路径/驱动消息），
  // 真实错误由路由 handler 记进 logger。
  const message = err instanceof LedgerApiError ? err.message : 'internal error'
  const code = err instanceof LedgerApiError ? err.code : 'internal_error'
  writeJson(res, { ok: false, error: { code, message } }, status)
}

/** 解析严格 YYYY-MM-DD 日历日（回绝 "2026-13-45" 这类正则能过但翻卷的形状）。 */
function parseDayKey(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (match === null) return null
  const y = Number(match[1])
  const m = Number(match[2])
  const d = Number(match[3])
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? { y, m, d } : null
}

/** 校验 body 的 from/to（可缺省）：给了就必须是严格 YYYY-MM-DD；两者都在时
 *  to >= from 且跨度 ≤ MAX_CUSTOM_SPAN_DAYS。返回只含已给字段的 query 片段。 */
function resolveDateRange(body) {
  const hasFrom = body.from !== undefined
  const hasTo = body.to !== undefined
  const fromParts = hasFrom && typeof body.from === 'string' ? parseDayKey(body.from) : null
  const toParts = hasTo && typeof body.to === 'string' ? parseDayKey(body.to) : null
  if (hasFrom && fromParts === null) {
    throw new LedgerApiError(400, 'bad_request', 'usage ledger: from must be a valid YYYY-MM-DD date')
  }
  if (hasTo && toParts === null) {
    throw new LedgerApiError(400, 'bad_request', 'usage ledger: to must be a valid YYYY-MM-DD date')
  }
  if (fromParts !== null && toParts !== null) {
    if (body.to < body.from) {
      throw new LedgerApiError(400, 'bad_request', 'usage ledger: to must be >= from')
    }
    // 两个 key 都是纯日历日，UTC 毫秒差恰为整天数。
    const spanDays = (Date.UTC(toParts.y, toParts.m - 1, toParts.d) - Date.UTC(fromParts.y, fromParts.m - 1, fromParts.d)) / 86_400_000 + 1
    if (spanDays > MAX_CUSTOM_SPAN_DAYS) {
      throw new LedgerApiError(400, 'bad_request', `usage ledger: date range spans more than ${MAX_CUSTOM_SPAN_DAYS} days`)
    }
  }
  const out = {}
  if (hasFrom) out.from = body.from
  if (hasTo) out.to = body.to
  return out
}

/** 数值参数 clamp：非有限数（含缺省）取 fallback，否则取整后夹到 [min, max]。 */
function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** ref `provider/model` 拆分（允许空侧）。 */
function splitModelRef(ref) {
  const i = ref.indexOf('/')
  return i > 0 ? { provider: ref.slice(0, i), model: ref.slice(i + 1) } : { provider: '', model: ref }
}

/** 把 day_model 的路由引用解析为模型选择器的显示名（dsh-token-total 的
 *  resolveModelNames 同款模式：resolveModelInfo 主查 + listModels 兜底 +
 *  并发 4 + 共享 2s deadline；元数据是附属面，任何失败都回退原始引用）。 */
async function resolveGroupNames(refs, llm) {
  const names = {}
  if (!llm) return names
  const list = [...new Set(refs)].filter((r) => typeof r === 'string' && r !== '' && r !== '(unknown)')
  if (list.length === 0) return names
  const deadline = Date.now() + 2000
  const withTimeout = (p) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), Math.max(1, deadline - Date.now())))])
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(4, list.length) }, async () => {
    while (cursor < list.length && Date.now() < deadline) {
      const ref = list[cursor++]
      const { provider, model } = splitModelRef(ref)
      try {
        if (typeof llm.resolveModelInfo === 'function') {
          const info = await withTimeout(Promise.resolve().then(() => llm.resolveModelInfo(provider, model)))
          const name = info?.name?.trim()
          if (name) { names[ref] = name; continue }
        }
        if (typeof llm.listModels === 'function') {
          const cat = await withTimeout(Promise.resolve().then(() => llm.listModels(provider)))
          const hit = Array.isArray(cat) ? cat.find((m) => m?.id === model) : undefined
          const name = hit?.name?.trim()
          if (name) names[ref] = name
        }
      } catch { /* 单个引用失败不影响其余 */ }
    }
  }))
  return names
}

/**
 * 构建 /usage-ledger/api 前缀路由（webServer.register 的形状）。
 * @param {object} deps
 * @param {import('../contract.js').LedgerStore} deps.store
 * @param {{status: {running: boolean, total: number, done: number, scannedSessions: number,
 *           lastSessionId?: string, error?: string}}} deps.collector
 * @param {() => {trustedHosts: string[], bindHost?: string, protocol?: 'http:'|'https:'}} deps.trust
 * @param {() => boolean} deps.isRebuilding
 * @param {() => Promise<void>} deps.resetAndRescan
 * @param {{heatmapWeeks?: number, retentionDays?: number}} deps.config
 * @param {{warn?: (msg: unknown) => void}} [deps.logger] 可选（index.js 目前不接线）
 */
export function buildLedgerRoute(deps) {
  const { store, collector, trust, isRebuilding, resetAndRescan } = deps
  const config = deps.config ?? {}
  const logger = deps.logger
  const fence = createTrustFence(typeof trust === 'function' ? trust : () => ({ trustedHosts: [] }))
  const defaultHeatmapWeeks = clampInt(config.heatmapWeeks, 52, 1, 260)

  const logWarn = (err) => {
    try {
      logger?.warn?.(err instanceof Error ? err : new Error(String(err)))
    } catch { /* logger 也是观测面，绝不反向砸 handler */ }
  }

  /** store.status() 合并 collector.status 进 backfill 字段（collector 值优先）。 */
  const currentStatus = () => {
    const st = store.status()
    const live = collector?.status ?? {}
    return { ...st, backfill: { ...(st?.backfill ?? {}), ...live } }
  }

  const handlers = {
    summary: async () => store.summary(),

    daily: async (body) => {
      const q = resolveDateRange(body)
      if (body.group !== undefined) {
        if (!GROUPS.has(body.group)) {
          throw new LedgerApiError(400, 'bad_request', 'usage ledger: group must be one of model|kind|tool')
        }
        q.group = body.group
      }
      if (body.granularity !== undefined) {
        if (!GRANULARITIES.has(body.granularity)) {
          throw new LedgerApiError(400, 'bad_request', 'usage ledger: granularity must be one of day|hour')
        }
        q.granularity = body.granularity
      }
      const result = await store.daily(q)
      // 模型显示名解析（additive groupNames）：只在 model 分组且有分组键时做。
      if (q.group === 'model' || (q.group === undefined && result.group === 'model')) {
        const keys = new Set()
        for (const g of result.groupTotals ?? []) keys.add(g.key)
        for (const b of result.buckets ?? []) for (const k of Object.keys(b.groups ?? {})) keys.add(k)
        const groupNames = await resolveGroupNames([...keys], deps.llm ? deps.llm() : undefined)
        if (Object.keys(groupNames).length > 0) result.groupNames = groupNames
      }
      return result
    },

    heatmap: async (body) => store.heatmap({ weeks: clampInt(body.weeks, defaultHeatmapWeeks, 1, 260) }),

    sessions: async (body) => {
      const q = {
        limit: clampInt(body.limit, 50, 1, 200),
        offset: clampInt(body.offset, 0, 0, Number.MAX_SAFE_INTEGER),
      }
      if (typeof body.q === 'string' && body.q !== '') q.q = body.q
      return store.sessions(q)
    },

    session: async (body) => {
      const id = typeof body.id === 'string' ? body.id.trim() : ''
      if (id === '') {
        throw new LedgerApiError(400, 'bad_request', 'usage ledger: session needs a non-empty id')
      }
      return store.sessionDetail(id)
    },

    tools: async (body) => store.tools(resolveDateRange(body)),

    status: async () => currentStatus(),

    reset: async () => {
      // 重建逃生舱：仅在 BOOT 扫描（非 reset 发起）进行中时拒绝；与 reset 管线
      // 重叠的请求搭 coalescing 便车——一次 wipe+rebuild，每个调用者拿到同一结果。
      if (collector?.status?.running && !isRebuilding()) {
        throw new LedgerApiError(409, 'conflict', 'usage ledger: backfill already running')
      }
      await resetAndRescan()
      return currentStatus()
    },
  }

  const handler = async (req, res) => {
    try {
      // 围栏 fail-closed：trust 输入解析失败视为不可信，而不是放行或 500。
      let trusted = false
      try {
        trusted = fence.isTrusted(req)
      } catch (err) {
        logWarn(err)
        trusted = false
      }
      if (!trusted) {
        writeJson(res, { ok: false, error: { code: 'forbidden', message: 'untrusted host' } }, 403)
        return
      }
      // 只按 PATH 匹配：剥掉 ?/#；前缀后第一段即子路径（/usage-ledger/api/x/...
      // 的第一段是 x，不会误吞 deeper path 到别的方法）。
      const url = req.url ?? ''
      const path = url.split(/[?#]/, 1)[0] ?? ''
      const rest = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : ''
      const sub = rest.startsWith('/') ? rest.slice(1).split('/')[0] : ''
      if (!METHODS.has(sub)) {
        throw new LedgerApiError(404, 'not_found', `unknown endpoint ${sub === '' ? path : `${PREFIX}/${sub}`}`)
      }
      const method = req.method ?? 'GET'
      if (method !== 'POST') {
        throw new LedgerApiError(405, 'method_not_allowed', 'usage ledger: POST only')
      }
      const parsed = await readJsonBody(req)
      const body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      const value = await handlers[sub](body)
      writeJson(res, { ok: true, value })
    } catch (err) {
      // 真实失败记服务端日志（围栏挡住了不可信调用方，能到这的是 trusted
      // 客户端或内部故障）；writeError 对非 LedgerApiError 只回通用 500。
      if (!(err instanceof LedgerApiError)) logWarn(err)
      writeError(res, err)
    }
  }

  return { kind: 'prefix', path: PREFIX, handler }
}
