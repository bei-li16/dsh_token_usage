// calculator.js — 会话视图组装器（task-15）：读会话日志 → context/composition/
// children 速率，带进程内短缓存。
//
// 生命周期：index.js 每次 apply() 建一个实例注入 routes（参照 llm 注入先例），
// persistence 经 getter 惰性取（宿主服务在挂载期已注入，但 getter 让重挂载窗口
// 内的旧 fiber 不会抓着过期的直接引用）。calculate() 是只读的观察面：任何失败
// （日志不可读 / persistence 缺失 / 单会话解码失败）都降级为 null/空速率，
// 绝不向 route handler 抛异常。
//
// 短缓存（轮询 2s 的面板）：Map<sessionId, {stamp, at, result}>。stat 来自
// persistence.list() 的快照（alpha 面：eventCount|sizeBytes；rc.1 头行无 stat →
// null），stat 变化立即重算；TTL 60s 保底——条目再旧也至少重算一次，statless
// 日志最多 60s 陈旧（任务钉死：短 TTL 内的 staleness 可接受）。缓存上限 32 个
// 会话（超出按插入序淘汰）——派生值绝不落 KV/SQLite（观察式原则）。
//
// 日志读取（alpha open/read/close 分页优先，rc.1 inspect 兜底）与 fork 继承前缀
// 剥离（宿主不变量 cut>0 ⟺ seeded fork；未 seed 会话 cut=0，跳过是空操作）与
// collector.readLog / token-total ownEventsOf 同口径。

import { buildContextWindow, buildUsageComposition, mergeUsageCompositions, buildRates } from './compose.js'

/** 缓存条目最长年龄（ms）：再旧也重算，即便 stat 看不出变化。 */
const CACHE_TTL_MS = 60_000
/** 缓存会话数上限（超出按插入序淘汰）。 */
const CACHE_MAX_SESSIONS = 32
/** 分页读日志的页大小。 */
const READ_PAGE = 500

/** 一个会话日志的读取结果；不可读 → null。 */
async function readLog(persistence, id) {
  try {
    if (typeof persistence.open === 'function') {
      const handle = await persistence.open(id, 'read')
      try {
        const cut = typeof handle?.inheritedEventCount === 'number'
          && Number.isSafeInteger(handle.inheritedEventCount) && handle.inheritedEventCount >= 0
          ? handle.inheritedEventCount
          : 0
        const collected = []
        let offset = 0
        for (;;) {
          const slice = await handle.read(offset, READ_PAGE)
          const page = slice && Array.isArray(slice.events) ? slice.events : []
          if (page.length === 0) break
          for (const ev of page) collected.push(ev)
          offset += page.length
        }
        return { events: collected, inheritedCut: cut }
      } finally {
        try { await handle.close() } catch { /* close 尽力而为 */ }
      }
    }
    if (typeof persistence.inspect === 'function') {
      const inspection = await persistence.inspect(id)
      const cut = typeof inspection?.inheritedEventCount === 'number' && inspection.inheritedEventCount >= 0
        ? inspection.inheritedEventCount
        : 0
      return { events: Array.isArray(inspection?.events) ? inspection.events : [], inheritedCut: cut }
    }
    return null
  } catch {
    return null
  }
}

/** 剥掉 fork 继承前缀后的自有事件（无 seq 的事件保留）。 */
function ownEventsOf(log) {
  if (log === null) return []
  return (log.events ?? []).filter(
    (event) => !(log.inheritedCut > 0 && typeof event?.seq === 'number' && event.seq < log.inheritedCut),
  )
}

/** 全体会话的日志 stat（alpha 快照的 eventCount|sizeBytes；rc.1 头行无 stat →
 *  null）。list 失败 → null（TTL-only 缓存）。 */
async function statStamps(persistence) {
  try {
    if (typeof persistence?.list !== 'function') return null
    const rows = await persistence.list()
    if (!Array.isArray(rows)) return null
    const stamps = new Map()
    for (const row of rows) {
      const snapshot = row !== null && typeof row === 'object' && typeof row.header === 'object' && row.header !== null ? row : null
      const id = typeof snapshot?.header?.id === 'string' && snapshot.header.id !== ''
        ? snapshot.header.id
        : (typeof row?.id === 'string' && row.id !== '' ? row.id : null)
      if (id === null) continue
      const eventCount = typeof snapshot?.eventCount === 'number' && Number.isFinite(snapshot.eventCount) ? snapshot.eventCount : null
      const sizeBytes = typeof snapshot?.sizeBytes === 'number' && Number.isFinite(snapshot.sizeBytes) ? snapshot.sizeBytes : null
      stamps.set(id, eventCount !== null || sizeBytes !== null ? `${eventCount ?? ''}|${sizeBytes ?? ''}` : null)
    }
    return stamps
  } catch {
    return null
  }
}

/**
 * 创建会话视图组装器。
 * @param {{getPersistence?: () => any, logger?: {warn?: (msg: unknown) => void}, ttlMs?: number}} deps
 * @returns {{calculate: (sessionId: string, childIds?: string[]) => Promise<{context: any, composition: any, childRates: Map<string, {avgFirstTokenMs: number|null, tokensPerSecond: number|null}>}>}}}
 */
export function createSessionViewCalculator(deps = {}) {
  const getPersistence = typeof deps.getPersistence === 'function' ? deps.getPersistence : null
  const logWarn = (err) => {
    try {
      deps.logger?.warn?.(err instanceof Error ? err : new Error(String(err)))
    } catch { /* logger 也是观察面 */ }
  }
  const ttlMs = typeof deps.ttlMs === 'number' && Number.isFinite(deps.ttlMs) && deps.ttlMs > 0 ? deps.ttlMs : CACHE_TTL_MS
  /** @type {Map<string, {stamp: string, at: number, result: any}>} */
  const cache = new Map()

  const noop = () => ({ context: null, composition: null, childRates: new Map() })

  return {
    /**
     * 组装一个会话树视图：context = 根会话自身日志的「下一请求」重建；
     * composition = 根 + 各后代的构成合并；childRates = 各后代自己的应答
     * 速率。任何失败都降级（null/空速率），绝不抛出。
     */
    async calculate(sessionId, childIds = []) {
      if (typeof sessionId !== 'string' || sessionId === '') return noop()
      const children = [...new Set((Array.isArray(childIds) ? childIds : [])
        .filter((id) => typeof id === 'string' && id !== '' && id !== sessionId))]
      let persistence = null
      try {
        persistence = getPersistence ? getPersistence() : null
      } catch (err) {
        logWarn(err)
        return noop()
      }
      if (persistence === null || typeof persistence !== 'object') return noop()

      // 短缓存：stat（root + children 的 eventCount|sizeBytes）不变且未过
      // TTL → 直接复用。statless（rc.1 头行）→ TTL-only。
      let stampKey = null
      try {
        const stamps = await statStamps(persistence)
        stampKey = JSON.stringify([sessionId, ...children].map((id) => [id, stamps?.get(id) ?? null]))
      } catch (err) {
        logWarn(err)
      }
      if (stampKey !== null) {
        const cached = cache.get(sessionId)
        const now = Date.now()
        if (cached && cached.stamp === stampKey && now - cached.at < ttlMs) return cached.result
      }

      // ── 组装（观察面：单会话失败降级为空，不砸整体）────────────────────
      const rootLog = await readLog(persistence, sessionId)
      const rootOwn = ownEventsOf(rootLog)
      const context = buildContextWindow(rootOwn)
      const compositions = [buildUsageComposition(rootOwn)]
      /** @type {Map<string, {avgFirstTokenMs: number|null, tokensPerSecond: number|null}>} */
      const childRates = new Map()
      for (const id of children) {
        const childLog = await readLog(persistence, id)
        const childOwn = ownEventsOf(childLog)
        compositions.push(buildUsageComposition(childOwn))
        childRates.set(id, buildRates(childOwn))
      }
      const composition = mergeUsageCompositions(compositions)
      const result = { context, composition, childRates }

      if (stampKey !== null) {
        cache.set(sessionId, { stamp: stampKey, at: Date.now(), result })
        if (cache.size > CACHE_MAX_SESSIONS) {
          const oldest = cache.keys().next().value
          cache.delete(oldest)
        }
      }
      return result
    },
  }
}
