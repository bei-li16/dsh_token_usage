// dsh-usage-ledger/src/db/store.js — LedgerStore：双后端派生缓存的编排层。
//
// 设计（为什么长这样）：
// - 会话日志是唯一事实源；本 store 只是两个派生缓存的合体：node:sqlite 存
//   30 天滚动明细（sqlite.js），storageDomain KV 存永久日级 rollup（kv.js）。
// - 观察式记录：record* 全部 fire-and-forget，进内部串行队列，任何后端故障
//   只计入 recordFailures / status，绝不向宿主抛出。队列同时充当 cursor
//   读-改-写的串行化链（token-total 的 cursorChain 等价物），所以 KV 行可以
//   用简单的 get→put 而不怕 lost update。
// - upsert 纠偏用 delta 语义：先取旧行（SQLite 的永久 delta 锚 request_anchor /
//   tool_anchor——prune 永不删除；降级时的进程内 recentFacts），旧贡献从旧 key
//   上减去、新贡献加到新 key上，因此 status 转换（running→completed/failed）与
//   跨天/跨模型修正都收敛，且同一事实的任意次重放（含跨 30 天 prune 窗口）对
//   KV 严格幂等（2026-11-17 双计事故修复：delta 基准曾依赖可被 prune 清空的
//   明细行，旧事实重放时 old=null → 盲目 +add → 六天恰好翻倍）。
// - 降级：SQLite 打不开 → 纯 KV（detail 查询 degraded:true，rollup 照记，
//   delta 基准退到 recentFacts Map；重启后由 backfill cursor 保证不重放）；
//   KV 打不开 → 纯 SQLite（cursor 方法报明确错误，collector 会 catch）。
// - failures 口径：只计 status 'failed' 的请求行（sqlite.js 的
//   FAILURE_STATUSES 与 rollup delta 共用同一判断）。

import {
  dayKey,
  todayKey,
  dayMinus,
  daysInRange,
  emptyDayRollup,
  emptyDayModelRollup,
  emptyDayKindRollup,
  emptyDayToolRollup,
  emptySessionIndexRow,
  normalizeRequestFact,
  normalizeToolFact,
  cacheHitRateOf,
  decodeRateOf,
} from '../contract.js'
import { openFactsBackend, resolveFactsDbPath, FAILURE_STATUSES } from './sqlite.js'
import { openKvBackend, modelRefOf, splitDayGroupKey } from './kv.js'

const DEFAULT_RETENTION_DAYS = 30
const DEFAULT_HEATMAP_WEEKS = 52
/** 降级模式下 recentFacts 的上限（FIFO 淘汰），防内存膨胀。 */
const RECENT_FACTS_CAP = 10000
/** sessionDetail 明细上限（contract 钉死 cap 500）。 */
const SESSION_RECORDS_CAP = 500
/** Store 代码代际：index.js 的全局单例发现代际不符时 dispose 旧实例重建
 *  （插件 toggle 即可升级 store，无需重启应用）。
 *  v4：新增 sessionHighSeq / markSessionSeq（disable-enable 窗口断档回放
 *  依赖的会话高水位）。
 *  v5（2026-11-17）：record* 的 delta 基准改为永久锚（request_anchor /
 *  tool_anchor / turn_anchor，prune 永不删除）——v4 实例没有锚读写语义，
 *  若不升代，toggle 升级会继续复用旧实例，锚代码永不激活（0.1.3 发布
 *  验收实测：旧实例上的 sweep 复现 KV 双计，/status 无 anchorRows 字段）。 */
export const STORE_VERSION = 5

/** 错误对象 → 单行安全文本（status.backendError 用）。 */
function sanitizeError(err) {
  if (err === undefined || err === null) return null
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(/\s+/g, ' ').slice(0, 300)
}

/** 非负计数器的 clamp 加/减：rollup 行任何字段都不允许为负（漂移时收敛到 0）。 */
function addClamped(row, field, delta) {
  const next = (typeof row[field] === 'number' && Number.isFinite(row[field]) ? row[field] : 0) + delta
  row[field] = next > 0 ? next : 0
}

/**
 * 创建 LedgerStore。同步返回（index.js 的 globalThis 单例缓存不 await），
 * 后端探测在后台进行，ready() 在探测结束后 resolve。
 * @param {{ storageDomain: object, config?: {retentionDays?: number, factsDbPath?: string}, logger?: object }} deps
 */
export function createLedgerStore({ storageDomain, config, logger }) {
  const retentionDays = Number.isFinite(config?.retentionDays) && config.retentionDays > 0
    ? Math.round(config.retentionDays)
    : DEFAULT_RETENTION_DAYS
  const log = {
    warn: (msg) => { try { logger?.warn?.(msg) } catch { /* logger 也是观察面 */ } },
    info: (msg) => { try { logger?.info?.(msg) } catch { /* ignore */ } },
  }

  /** @type {ReturnType<typeof openFactsBackend>|null} */
  let sqlite = null
  /** @type {Awaited<ReturnType<typeof openKvBackend>>|null} */
  let kv = null
  let sqliteError = null
  let kvError = null
  let recordFailures = 0
  let lastPruneDay = null
  /** 降级模式的 delta 基准：id → 最近一次归一化 fact。 */
  const recentFacts = new Map()
  let disposed = false

  // ── 后端探测（ready 永不 reject）───────────────────────────────────────
  const readyPromise = (async () => {
    try {
      kv = await openKvBackend(storageDomain)
    } catch (err) {
      kvError = sanitizeError(err)
      kv = null
      log.warn(`[dsh-usage-ledger] KV domain unavailable, rollup backend degraded: ${kvError}`)
    }
    try {
      sqlite = openFactsBackend(resolveFactsDbPath(config?.factsDbPath))
    } catch (err) {
      sqliteError = sanitizeError(err)
      sqlite = null
      log.warn(`[dsh-usage-ledger] SQLite facts backend unavailable, detail degraded: ${sqliteError}`)
    }
  })()

  // ── 内部串行队列：所有写与 cursor 读-改-写都排队，任务永不 reject ──────
  // 成功时透传 job 的返回值（sessionHighSeq 这类读方法需要）；失败吞错并
  // 计数 recordFailures（返回 undefined，调用方按防御默认处理）。
  let chain = Promise.resolve()
  function enqueue(job) {
    const run = chain.then(async () => {
      await readyPromise
      if (disposed) return
      try {
        return await job()
      } catch (err) {
        recordFailures += 1
        log.warn(`[dsh-usage-ledger] record job failed: ${sanitizeError(err)}`)
      }
    })
    chain = run.then(() => undefined, () => undefined)
    return run
  }

  /** 等待已派发的写全部落盘（查询与 smoke 用；合同外增量方法）。 */
  const flush = () => chain

  // ── KV 行读-改-写小工具（都在队列内调用，串行安全）────────────────────
  async function putRow(table, key, row) {
    await table.put(key, row)
  }

  /** days 行应用一次带符号贡献。 */
  async function applyDay(c, sign) {
    const row = kv.days.get(c.day) ?? emptyDayRollup(c.day)
    addClamped(row, 'tokens', sign * c.tokens)
    addClamped(row, 'inputTokens', sign * c.inputTokens)
    addClamped(row, 'outputTokens', sign * c.outputTokens)
    addClamped(row, 'reasoningTokens', sign * c.reasoningTokens)
    addClamped(row, 'cacheReadTokens', sign * c.cacheReadTokens)
    addClamped(row, 'cacheWriteTokens', sign * c.cacheWriteTokens)
    addClamped(row, 'requests', sign * c.requests)
    addClamped(row, 'failures', sign * c.failures)
    addClamped(row, 'firstTokenMsSum', sign * c.firstTokenMsSum)
    addClamped(row, 'firstTokenCount', sign * c.firstTokenCount)
    addClamped(row, 'decodeMsSum', sign * c.decodeMsSum)
    addClamped(row, 'decodeCount', sign * c.decodeCount)
    addClamped(row, 'decodeTokens', sign * c.decodeTokens)
    if (sign > 0 && c.time > row.lastSeen) row.lastSeen = c.time
    await putRow(kv.days, c.day, row)
  }

  async function applyDayModel(c, sign) {
    const key = `${c.day}|${c.modelRef}`
    const row = kv.dayModel.get(key) ?? emptyDayModelRollup(c.day, c.modelRef)
    addClamped(row, 'tokens', sign * c.tokens)
    addClamped(row, 'inputTokens', sign * c.inputTokens)
    addClamped(row, 'outputTokens', sign * c.outputTokens)
    addClamped(row, 'reasoningTokens', sign * c.reasoningTokens)
    addClamped(row, 'cacheReadTokens', sign * c.cacheReadTokens)
    addClamped(row, 'cacheWriteTokens', sign * c.cacheWriteTokens)
    addClamped(row, 'requests', sign * c.requests)
    addClamped(row, 'failures', sign * c.failures)
    await putRow(kv.dayModel, key, row)
  }

  async function applyDayKind(c, sign) {
    const key = `${c.day}|${c.kind}`
    const row = kv.dayKind.get(key) ?? emptyDayKindRollup(c.day, c.kind)
    addClamped(row, 'tokens', sign * c.tokens)
    addClamped(row, 'requests', sign * c.requests)
    addClamped(row, 'failures', sign * c.failures)
    await putRow(kv.dayKind, key, row)
  }

  async function applyDayTool(c, sign) {
    const key = `${c.day}|${c.name}`
    const row = kv.dayTool.get(key) ?? emptyDayToolRollup(c.day, c.name)
    addClamped(row, 'calls', sign * c.calls)
    addClamped(row, 'failures', sign * c.failures)
    addClamped(row, 'durationMsSum', sign * c.durationMsSum)
    await putRow(kv.dayTool, key, row)
  }

  /** sessions 索引行：计数器带符号；firstDay/lastDay/lastSeen 只在正贡献时前进。 */
  async function applySession(c, sign) {
    const row = kv.sessions.get(c.sessionId) ?? emptySessionIndexRow(c.sessionId)
    if (c.parentId !== undefined && c.parentId !== null) row.parentId = c.parentId
    if (typeof c.kind === 'string' && c.kind !== '') row.kind = c.kind
    addClamped(row, 'tokens', sign * (c.tokens ?? 0))
    addClamped(row, 'inputTokens', sign * (c.inputTokens ?? 0))
    addClamped(row, 'outputTokens', sign * (c.outputTokens ?? 0))
    addClamped(row, 'cacheReadTokens', sign * (c.cacheReadTokens ?? 0))
    addClamped(row, 'cacheWriteTokens', sign * (c.cacheWriteTokens ?? 0))
    addClamped(row, 'reasoningTokens', sign * (c.reasoningTokens ?? 0))
    addClamped(row, 'requests', sign * (c.requests ?? 0))
    addClamped(row, 'failures', sign * (c.failures ?? 0))
    addClamped(row, 'turns', sign * (c.turns ?? 0))
    addClamped(row, 'toolCalls', sign * (c.toolCalls ?? 0))
    if (sign > 0) {
      if (typeof c.day === 'string' && c.day !== '') {
        row.firstDay = row.firstDay === '' || c.day < row.firstDay ? c.day : row.firstDay
        row.lastDay = row.lastDay === '' || c.day > row.lastDay ? c.day : row.lastDay
      }
      if (typeof c.time === 'number' && c.time > row.lastSeen) row.lastSeen = c.time
    }
    await putRow(kv.sessions, c.sessionId, row)
  }

  // ── 贡献（contribution）抽取：delta = 新贡献 − 旧贡献 ──────────────────
  function requestContrib(f) {
    return {
      sessionId: f.sessionId, parentId: f.parentId, kind: f.kind, day: f.day, time: f.time,
      modelRef: modelRefOf(f.provider, f.model),
      tokens: f.computedTotal, inputTokens: f.inputTokens, outputTokens: f.outputTokens,
      reasoningTokens: f.reasoningTokens, cacheReadTokens: f.cacheReadTokens,
      cacheWriteTokens: f.cacheWriteTokens,
      requests: 1, failures: FAILURE_STATUSES.has(f.status) ? 1 : 0,
      firstTokenMsSum: f.firstTokenMs ?? 0, firstTokenCount: f.firstTokenMs !== null ? 1 : 0,
      decodeMsSum: f.decodeMs ?? 0, decodeCount: f.decodeMs !== null ? 1 : 0,
      decodeTokens: f.decodeMs !== null ? f.outputTokens : 0,
    }
  }

  function toolContrib(f) {
    return {
      sessionId: f.sessionId, parentId: f.parentId, kind: f.kind, day: f.day, time: f.time,
      name: f.name,
      calls: 1, failures: f.status === 'failed' ? 1 : 0,
      durationMsSum: f.durationMs ?? 0,
    }
  }

  /** 旧行贡献 −1、新行贡献 +1（KV 不可用时整体跳过）。 */
  async function applyRequestDelta(fresh, old) {
    if (!kv) return
    if (old) {
      const c = requestContrib(old)
      await applyDay(c, -1)
      await applyDayModel(c, -1)
      await applyDayKind(c, -1)
      await applySession(c, -1)
    }
    const c = requestContrib(fresh)
    await applyDay(c, 1)
    await applyDayModel(c, 1)
    await applyDayKind(c, 1)
    await applySession(c, 1)
  }

  async function applyToolDelta(fresh, old) {
    if (!kv) return
    if (old) {
      const c = toolContrib(old)
      await applyDayTool(c, -1)
      const dayRow = { day: c.day, time: 0, tokens: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, requests: 0, failures: 0, firstTokenMsSum: 0, firstTokenCount: 0, decodeMsSum: 0, decodeCount: 0, decodeTokens: 0 }
      await applyToolDayRow(dayRow, -c.calls, -c.failures)
      await applySession({ sessionId: c.sessionId, toolCalls: c.calls }, -1)
    }
    const c = toolContrib(fresh)
    await applyDayTool(c, 1)
    await applyToolDayRow({ day: c.day, time: c.time }, c.calls, c.failures)
    await applySession({ sessionId: c.sessionId, parentId: c.parentId, kind: c.kind, day: c.day, time: c.time, toolCalls: c.calls }, 1)
  }

  /** days 行的 toolCalls/toolFailures 与 request 贡献分开维护。 */
  async function applyToolDayRow(c, callsDelta, failuresDelta) {
    const row = kv.days.get(c.day) ?? emptyDayRollup(c.day)
    addClamped(row, 'toolCalls', callsDelta)
    addClamped(row, 'toolFailures', failuresDelta)
    if (callsDelta > 0 && typeof c.time === 'number' && c.time > row.lastSeen) row.lastSeen = c.time
    await putRow(kv.days, c.day, row)
  }

  // ── prune ────────────────────────────────────────────────────────────
  async function pruneImpl() {
    const today = todayKey()
    lastPruneDay = today
    const cutoff = dayMinus(today, retentionDays - 1)
    if (sqlite) {
      sqlite.pruneOlderThan(cutoff)
    } else {
      // 降级模式：recentFacts 同步修剪，防 Map 只增不减。
      for (const [id, fact] of recentFacts) {
        if (fact.day < cutoff) recentFacts.delete(id)
      }
    }
  }

  // ── cursor ───────────────────────────────────────────────────────────
  function readCursor() {
    if (!kv) return { backfilledSessions: [], liveFirstSeq: {} }
    const value = kv.globalHandle.get()
    return {
      backfilledSessions: Array.isArray(value?.backfilledSessions) ? value.backfilledSessions : [],
      liveFirstSeq: typeof value?.liveFirstSeq === 'object' && value.liveFirstSeq !== null ? value.liveFirstSeq : {},
    }
  }

  // ══ 公共面（contract.js LedgerStore）═══════════════════════════════════
  const store = {
    storeVersion: STORE_VERSION,
    ready: () => readyPromise,

    // ── 写入（fire-and-forget，永不 throw）──────────────────────────────
    recordRequest(fact) {
      void enqueue(async () => {
        const f = normalizeRequestFact(fact)
        // prune 节流：每天第一次写入顺带 prune 一次。
        if (lastPruneDay !== todayKey()) await pruneImpl()
        // Delta base (2026-11-17 double-count fix): the PERMANENT anchor row,
        // not the prunable detail row. A detail row is deleted once its day
        // falls below the retention cutoff, so keying the delta on it turned
        // any post-prune replay of an old fact into old=null → applyDelta
        // blindly +add → the KV rollups doubled (release acceptance observed
        // six days at exactly 2×). Anchors survive prune; only reset clears
        // them (a full rebuild wipes the KV side too, so the pairing holds).
        const old = sqlite ? (sqlite.getRequestAnchor(f.id) ?? sqlite.getRequest(f.id)) : recentFacts.get(f.id)
        if (sqlite) {
          sqlite.upsertRequest(f)
          sqlite.upsertRequestAnchor(f)
        }
        await applyRequestDelta(f, old)
        if (!sqlite) {
          recentFacts.set(f.id, f)
          if (recentFacts.size > RECENT_FACTS_CAP) {
            const oldest = recentFacts.keys().next().value
            recentFacts.delete(oldest)
          }
        }
      })
    },

    recordToolCall(fact) {
      void enqueue(async () => {
        const f = normalizeToolFact(fact)
        // Delta base = permanent anchor (see recordRequest; same fix).
        const old = sqlite ? (sqlite.getToolAnchor(f.id) ?? sqlite.getTool(f.id)) : recentFacts.get(f.id)
        if (sqlite) {
          sqlite.upsertTool(f)
          sqlite.upsertToolAnchor(f)
        }
        await applyToolDelta(f, old)
        if (!sqlite) {
          recentFacts.set(f.id, f)
          if (recentFacts.size > RECENT_FACTS_CAP) {
            const oldest = recentFacts.keys().next().value
            recentFacts.delete(oldest)
          }
        }
      })
    },

    recordTurn(marker) {
      void enqueue(async () => {
        if (!kv || !marker || typeof marker.sessionId !== 'string') return
        // Replay guard (2026-11-17 double-count fix): turn markers carry no
        // fact id, so a replay re-emitting an already-counted marker would
        // blindly +1 the turns counters again (the incident doubled turns the
        // same way it doubled tokens). The permanent (session, seq) anchor
        // makes re-delivered markers a no-op; markers without a seq (defensive
        // shape) stay unguarded, matching the pre-fix behavior.
        if (sqlite && typeof marker.seq === 'number' && Number.isFinite(marker.seq)) {
          const seq = Math.round(marker.seq)
          if (sqlite.hasTurnAnchor(marker.sessionId, seq)) return
          sqlite.addTurnAnchor(marker.sessionId, seq)
        }
        const day = typeof marker.day === 'string' && marker.day !== '' ? marker.day : dayKey(marker.time)
        const time = typeof marker.time === 'number' && Number.isFinite(marker.time) ? marker.time : Date.now()
        const row = kv.days.get(day) ?? emptyDayRollup(day)
        addClamped(row, 'turns', 1)
        if (time > row.lastSeen) row.lastSeen = time
        await putRow(kv.days, day, row)
        const kindKey = `${day}|${marker.kind ?? 'main'}`
        const kindRow = kv.dayKind.get(kindKey) ?? emptyDayKindRollup(day, marker.kind ?? 'main')
        addClamped(kindRow, 'turns', 1)
        await putRow(kv.dayKind, kindKey, kindRow)
        await applySession({ sessionId: marker.sessionId, parentId: marker.parentId ?? null, kind: marker.kind, day, time, turns: 1 }, 1)
      })
    },

    recordSessionMeta(meta) {
      void enqueue(async () => {
        if (!kv || !meta || typeof meta.id !== 'string' || meta.id === '') return
        const row = kv.sessions.get(meta.id) ?? emptySessionIndexRow(meta.id)
        if (meta.parentId !== undefined) row.parentId = meta.parentId === '' ? null : meta.parentId
        if (typeof meta.kind === 'string' && meta.kind !== '') row.kind = meta.kind
        if (typeof meta.name === 'string' && meta.name !== '') row.name = meta.name
        await putRow(kv.sessions, meta.id, row)
      })
    },

    prune() {
      return enqueue(pruneImpl)
    },

    reset(boundaries) {
      return enqueue(async () => {
        if (sqlite) sqlite.clearAll()
        recentFacts.clear()
        if (kv) {
          for (const table of [kv.days, kv.dayModel, kv.dayKind, kv.dayTool, kv.sessions]) {
            await table.deleteMany([...table.keys()])
          }
          const liveFirstSeq = {}
          if (boundaries instanceof Map) {
            for (const [id, seq] of boundaries) {
              if (typeof id === 'string' && typeof seq === 'number' && Number.isFinite(seq)) {
                liveFirstSeq[id] = Math.round(seq)
              }
            }
          }
          await kv.globalHandle.set({ backfilledSessions: [], liveFirstSeq })
        }
        lastPruneDay = null
      })
    },

    // ── cursor（backfill / live 边界）────────────────────────────────────
    async liveSequences() {
      await readyPromise
      return new Map(Object.entries(readCursor().liveFirstSeq))
    },

    markLiveSequence(id, seq) {
      return enqueue(async () => {
        if (!kv) throw new Error('KV backend unavailable: cannot persist live sequence boundary')
        if (typeof id !== 'string' || typeof seq !== 'number' || !Number.isFinite(seq)) return
        const cursor = readCursor()
        const merged = { ...cursor.liveFirstSeq }
        const prev = merged[id]
        // 最早的边界获胜：它是前缀回放的安全分界点。
        if (prev === undefined || seq < prev) {
          merged[id] = Math.round(seq)
          await kv.globalHandle.set({ backfilledSessions: cursor.backfilledSessions, liveFirstSeq: merged })
        }
      })
    },

    // 会话高水位（lastSeq）：collector 在 turn 边界 / 会话关闭时推进。
    // 只更新已存在的行——空会话不建行，避免污染 /sessions 索引。
    sessionHighSeq(id) {
      return enqueue(async () => {
        if (typeof id !== 'string' || id === '') return null
        const row = kv?.sessions.get(id)
        if (!row) return null
        const seq = row.lastSeq
        return typeof seq === 'number' && Number.isFinite(seq) ? seq : -1
      })
    },

    markSessionSeq(id, seq) {
      return enqueue(async () => {
        if (!kv) return
        if (typeof id !== 'string' || id === '') return
        if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return
        const row = kv.sessions.get(id)
        if (!row) return
        const prev = typeof row.lastSeq === 'number' && Number.isFinite(row.lastSeq) ? row.lastSeq : -1
        if (seq > prev) {
          row.lastSeq = Math.round(seq)
          await putRow(kv.sessions, id, row)
        }
      })
    },

    async cursorState() {
      await readyPromise
      const cursor = readCursor()
      return {
        cursor: {
          backfilledSessions: [...cursor.backfilledSessions],
          liveFirstSeq: { ...cursor.liveFirstSeq },
        },
      }
    },

    markBackfilled(ids) {
      return enqueue(async () => {
        if (!kv) throw new Error('KV backend unavailable: cannot persist backfill cursor')
        const cursor = readCursor()
        const seen = new Set(cursor.backfilledSessions)
        let changed = false
        for (const id of ids ?? []) {
          if (typeof id === 'string' && !seen.has(id)) {
            seen.add(id)
            changed = true
          }
        }
        if (changed) {
          await kv.globalHandle.set({ backfilledSessions: [...seen], liveFirstSeq: cursor.liveFirstSeq })
        }
      })
    },

    // ── 查询（routes 直接用）────────────────────────────────────────────
    async summary() {
      await readyPromise
      const rows = kv ? [...kv.days.entries()].map(([, row]) => row) : []
      let tokens = 0; let inputTokens = 0; let outputTokens = 0; let reasoningTokens = 0
      let cacheReadTokens = 0; let cacheWriteTokens = 0; let requests = 0; let failures = 0
      let turns = 0; let toolCalls = 0; let activeDays = 0
      let firstTokenMsSum = 0; let firstTokenCount = 0; let decodeMsSum = 0; let decodeTokens = 0
      let firstDay = null; let lastDay = null; let peakDay = null
      const activeByDay = new Map()
      for (const row of rows) {
        tokens += row.tokens; inputTokens += row.inputTokens; outputTokens += row.outputTokens
        reasoningTokens += row.reasoningTokens ?? 0
        cacheReadTokens += row.cacheReadTokens; cacheWriteTokens += row.cacheWriteTokens
        requests += row.requests; failures += row.failures; turns += row.turns; toolCalls += row.toolCalls
        firstTokenMsSum += row.firstTokenMsSum; firstTokenCount += row.firstTokenCount
        decodeMsSum += row.decodeMsSum; decodeTokens += row.decodeTokens
        const active = row.tokens > 0 || row.requests > 0
        if (active) activeDays += 1
        activeByDay.set(row.day, active)
        if (firstDay === null || row.day < firstDay) firstDay = row.day
        if (lastDay === null || row.day > lastDay) lastDay = row.day
        if (row.tokens > 0 && (peakDay === null || row.tokens > peakDay.tokens)) {
          peakDay = { day: row.day, tokens: row.tokens }
        }
      }
      // streak：今天活跃则从今天往回数，否则从昨天往回数。
      let streakDays = 0
      let cursorDay = todayKey()
      if (!activeByDay.get(cursorDay)) cursorDay = dayMinus(cursorDay, 1)
      while (activeByDay.get(cursorDay)) {
        streakDays += 1
        cursorDay = dayMinus(cursorDay, 1)
      }
      return {
        tokens, inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWriteTokens,
        requests, failures, turns, toolCalls, activeDays, firstDay, lastDay, peakDay, streakDays,
        avgFirstTokenMs: firstTokenCount > 0 ? Math.round(firstTokenMsSum / firstTokenCount) : null,
        cacheHitRate: cacheHitRateOf(inputTokens, cacheReadTokens, cacheWriteTokens),
        errorRate: requests > 0 ? (failures / requests) * 100 : null,
        tokensPerSecond: decodeRateOf(decodeTokens, decodeMsSum),
        degraded: sqlite === null,
      }
    },

    async daily(query = {}) {
      await readyPromise
      const to = typeof query.to === 'string' && query.to !== '' ? query.to : todayKey()
      const from = typeof query.from === 'string' && query.from !== '' ? query.from : dayMinus(to, 29)
      const group = query.group === 'model' || query.group === 'kind' || query.group === 'tool' ? query.group : 'model'
      const granularity = query.granularity === 'hour' ? 'hour' : 'day'

      // hour 粒度在纯 KV 降级下没有数据来源：回退 day 桶并打 degraded 标记。
      if (granularity === 'hour' && sqlite) {
        return hourlyDaily(sqlite, from, to, group)
      }
      const degraded = granularity === 'hour' && !sqlite
      const days = daysInRange(from, to)
      const buckets = new Map(days.map((day) => [day, { key: day, tokens: 0, requests: 0, failures: 0, turns: 0, cacheHitRate: null, groups: {} }]))
      if (kv) {
        for (const [, row] of kv.days.entries()) {
          const bucket = buckets.get(row.day)
          if (!bucket) continue
          bucket.tokens = row.tokens
          bucket.requests = row.requests
          bucket.failures = row.failures
          bucket.turns = row.turns
          bucket.cacheHitRate = cacheHitRateOf(row.inputTokens, row.cacheReadTokens, row.cacheWriteTokens)
        }
        const groupTable = group === 'model' ? kv.dayModel : group === 'kind' ? kv.dayKind : kv.dayTool
        for (const [key, row] of groupTable.entries()) {
          const split = splitDayGroupKey(key)
          if (!split) continue
          const bucket = buckets.get(split.day)
          if (!bucket) continue
          const value = group === 'tool' ? row.calls : row.tokens
          bucket.groups[split.group] = (bucket.groups[split.group] ?? 0) + value
        }
      }
      const groupTotals = dailyGroupTotals(kv, group, from, to)
      return { from, to, granularity: 'day', group, buckets: [...buckets.values()], groupTotals, degraded }
    },

    async heatmap(query = {}) {
      await readyPromise
      const raw = Number(query.weeks)
      const weeks = Number.isFinite(raw) && raw > 0 ? Math.min(260, Math.round(raw)) : DEFAULT_HEATMAP_WEEKS
      const to = todayKey()
      const from = dayMinus(to, weeks * 7 - 1)
      const byDay = new Map()
      if (kv) {
        for (const [, row] of kv.days.entries()) {
          if (row.day >= from && row.day <= to) byDay.set(row.day, row)
        }
      }
      let maxTokens = 0
      const days = daysInRange(from, to).map((day) => {
        const row = byDay.get(day)
        const tokens = row?.tokens ?? 0
        if (tokens > maxTokens) maxTokens = tokens
        return { day, tokens, requests: row?.requests ?? 0 }
      })
      return { weeks, days, maxTokens }
    },

    async sessions(query = {}) {
      await readyPromise
      const limit = Number.isFinite(Number(query.limit)) && Number(query.limit) > 0 ? Math.round(Number(query.limit)) : 50
      const offset = Number.isFinite(Number(query.offset)) && Number(query.offset) > 0 ? Math.round(Number(query.offset)) : 0
      const needle = typeof query.q === 'string' && query.q !== '' ? query.q.toLowerCase() : null
      let rows = kv ? [...kv.sessions.entries()].map(([, row]) => row) : []
      if (needle !== null) {
        rows = rows.filter((row) => row.id.toLowerCase().includes(needle) || (row.name ?? '').toLowerCase().includes(needle))
      }
      // 排序：token 消耗降序（用户验收口径），同量按最近活跃，再按 id 稳定。
      rows.sort((a, b) => ((b.tokens ?? 0) - (a.tokens ?? 0)) || (b.lastSeen - a.lastSeen) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      return { total: rows.length, rows: rows.slice(offset, offset + limit) }
    },

    async sessionDetail(id) {
      await readyPromise
      const index = kv ? (kv.sessions.get(id) ?? null) : null
      // BFS：子孙会话沿 sessions 表 parentId 链扩散。
      const memberIds = []
      const memberRows = []
      if (kv) {
        // 预建 parentId → children 映射，BFS 不致退化成 O(n²) 全表扫描。
        const childrenByParent = new Map()
        for (const [, row] of kv.sessions.entries()) {
          if (row.parentId === null || row.parentId === undefined) continue
          const list = childrenByParent.get(row.parentId) ?? []
          list.push(row)
          childrenByParent.set(row.parentId, list)
        }
        const seen = new Set([id])
        const queue = [id]
        while (queue.length > 0) {
          const current = queue.shift()
          const row = kv.sessions.get(current)
          if (row) memberRows.push(row)
          memberIds.push(current) // 无索引行的节点仍保留明细查询
          for (const child of childrenByParent.get(current) ?? []) {
            if (!seen.has(child.id)) {
              seen.add(child.id)
              queue.push(child.id)
            }
          }
        }
      } else {
        memberIds.push(id)
      }
      const totals = { tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
      let requests = 0; let failures = 0
      for (const row of memberRows) {
        totals.tokens += row.tokens; totals.inputTokens += row.inputTokens; totals.outputTokens += row.outputTokens
        totals.cacheReadTokens += row.cacheReadTokens; totals.cacheWriteTokens += row.cacheWriteTokens
        totals.reasoningTokens += row.reasoningTokens ?? 0
        requests += row.requests; failures += row.failures
      }
      if (!sqlite) {
        return {
          id, index, totals, requests, failures,
          avgFirstTokenMs: null, tokensPerSecond: null,
          byModel: [], records: [], tools: [], degraded: true,
        }
      }
      const records = sqlite.sessionRecords(memberIds, SESSION_RECORDS_CAP)
      const tools = sqlite.sessionToolAgg(memberIds).map((row) => ({
        name: row.name, calls: Number(row.calls), failures: Number(row.failures),
      }))
      const byModelMap = new Map()
      let ftmSum = 0; let ftmCount = 0; let decodeMsSum = 0; let decodeOutput = 0
      for (const record of records) {
        const key = `${record.provider}|${record.model}`
        const agg = byModelMap.get(key) ?? { model: record.model, provider: record.provider, tokens: 0, requests: 0, failures: 0 }
        agg.tokens += record.computedTotal
        agg.requests += 1
        if (FAILURE_STATUSES.has(record.status)) agg.failures += 1
        byModelMap.set(key, agg)
        // 速率均值只算 completed 且有值的记录（contract 口径）。
        if (record.status === 'completed' && record.firstTokenMs !== null) {
          ftmSum += record.firstTokenMs; ftmCount += 1
        }
        if (record.status === 'completed' && record.decodeMs !== null) {
          decodeMsSum += record.decodeMs; decodeOutput += record.outputTokens
        }
      }
      const byModel = [...byModelMap.values()].sort((a, b) => b.tokens - a.tokens)
      return {
        id, index, totals, requests, failures,
        avgFirstTokenMs: ftmCount > 0 ? Math.round(ftmSum / ftmCount) : null,
        tokensPerSecond: decodeRateOf(decodeOutput, decodeMsSum),
        byModel, records, tools, degraded: false,
      }
    },

    async tools(query = {}) {
      await readyPromise
      const to = typeof query.to === 'string' && query.to !== '' ? query.to : todayKey()
      const from = typeof query.from === 'string' && query.from !== '' ? query.from : dayMinus(to, 29)
      const byName = new Map()
      if (kv) {
        for (const [key, row] of kv.dayTool.entries()) {
          const split = splitDayGroupKey(key)
          if (!split || split.day < from || split.day > to) continue
          const agg = byName.get(row.tool) ?? { name: row.tool, calls: 0, failures: 0, durationMsSum: 0 }
          agg.calls += row.calls
          agg.failures += row.failures
          agg.durationMsSum += row.durationMsSum
          byName.set(row.tool, agg)
        }
      }
      let totalCalls = 0
      for (const agg of byName.values()) totalCalls += agg.calls
      const tools = [...byName.values()]
        .map((agg) => ({
          name: agg.name,
          calls: agg.calls,
          failures: agg.failures,
          // day_tool 只存 durationMsSum（无 duration 计数），avg = sum/calls，
          // 有 running 行时会略低估——contract 把精确口径留给 client 侧。
          avgDurationMs: agg.calls > 0 ? Math.round(agg.durationMsSum / agg.calls) : null,
          percent: totalCalls > 0 ? (agg.calls / totalCalls) * 100 : 0,
        }))
        .sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1))
      return { tools }
    },

    status() {
      let counts = { requestRows: 0, toolRows: 0, anchorRows: 0 }
      if (sqlite) {
        try {
          counts = sqlite.rowCounts()
        } catch (err) {
          sqliteError = sanitizeError(err)
        }
      }
      return {
        backend: sqlite ? 'sqlite' : 'kv',
        degraded: sqlite === null,
        backendError: sqliteError ?? kvError,
        retentionDays,
        requestRows: counts.requestRows,
        toolRows: counts.toolRows,
        // Permanent delta anchors (prune-proof KV delta base, 2026-11-17).
        anchorRows: counts.anchorRows,
        kvDays: kv ? kv.days.size : 0,
        kvSessions: kv ? kv.sessions.size : 0,
        recordFailures,
        lastPruneDay,
        // backfill 运行态归 collector 管；routes 合并时覆盖此占位。
        backfill: { running: false, total: 0, done: 0, scannedSessions: 0 },
        // 增量字段（contract 允许）：两个后端的独立健康位。
        sqliteOk: sqlite !== null,
        kvOk: kv !== null,
        sqliteError,
        kvError,
      }
    },

    // ── 合同外增量：排空队列 / 关闭后端（smoke 与测试用）──────────────────
    flush,
    async dispose() {
      disposed = true
      await chain
      if (sqlite) sqlite.close()
      if (kv) await kv.domain.close().catch(() => {})
    },
  }
  return store
}

/** day 粒度的 groupTotals：按值降序 + percent。tool 分组的值是调用次数
 *  （此时 groupTotals.tokens 承载调用次数——contract 对 tool 分组未单独定
 *  义 groupTotals 语义，排序/百分比都统一用这个值）。 */
function dailyGroupTotals(kv, group, from, to) {
  const totals = new Map()
  if (kv) {
    const table = group === 'model' ? kv.dayModel : group === 'kind' ? kv.dayKind : kv.dayTool
    for (const [key, row] of table.entries()) {
      const split = splitDayGroupKey(key)
      if (!split || split.day < from || split.day > to) continue
      const agg = totals.get(split.group) ?? { key: split.group, tokens: 0, requests: 0 }
      if (group === 'tool') {
        agg.tokens += row.calls
        agg.requests += row.calls
      } else {
        agg.tokens += row.tokens
        agg.requests += row.requests
      }
      totals.set(split.group, agg)
    }
  }
  let sum = 0
  for (const agg of totals.values()) sum += agg.tokens
  return [...totals.values()]
    .map((agg) => ({ key: agg.key, tokens: agg.tokens, requests: agg.requests, percent: sum > 0 ? (agg.tokens / sum) * 100 : 0 }))
    .sort((a, b) => b.tokens - a.tokens || (a.key < b.key ? -1 : 1))
}

/** hour 粒度：SQLite GROUP BY hour（±分组键），24×天数零填充。
 *  turn 标记只折进日级 rollup，hour 桶的 turns 恒为 0（明细表无对应列可还原）。 */
function hourlyDaily(sqlite, from, to, group) {
  const days = daysInRange(from, to)
  const bucketKeys = []
  for (const day of days) {
    for (let h = 0; h < 24; h += 1) bucketKeys.push(`${day}T${String(h).padStart(2, '0')}`)
  }
  const buckets = new Map(bucketKeys.map((key) => [key, { key, tokens: 0, requests: 0, failures: 0, turns: 0, cacheHitRate: null, groups: {} }]))
  const agg = sqlite.hourly(from, to)
  for (const row of agg.base) {
    const bucket = buckets.get(row.hour)
    if (!bucket) continue
    bucket.tokens = Number(row.tokens)
    bucket.requests = Number(row.requests)
    bucket.failures = Number(row.failures)
    bucket.cacheHitRate = cacheHitRateOf(Number(row.inputTokens ?? 0), Number(row.cacheReadTokens ?? 0), Number(row.cacheWriteTokens ?? 0))
  }
  const grouped = group === 'model' ? agg.byModel : group === 'kind' ? agg.byKind : agg.byTool
  for (const row of grouped) {
    const bucket = buckets.get(row.hour)
    if (!bucket) continue
    const key = group === 'model' ? modelRefOf(row.provider, row.model) : group === 'kind' ? row.kind : row.name
    const value = group === 'tool' ? Number(row.calls) : Number(row.tokens)
    bucket.groups[key] = (bucket.groups[key] ?? 0) + value
  }
  const totals = new Map()
  for (const row of grouped) {
    const key = group === 'model' ? modelRefOf(row.provider, row.model) : group === 'kind' ? row.kind : row.name
    const value = group === 'tool' ? Number(row.calls) : Number(row.tokens)
    const count = group === 'tool' ? Number(row.calls) : Number(row.requests)
    const aggTotal = totals.get(key) ?? { key, tokens: 0, requests: 0 }
    aggTotal.tokens += value
    aggTotal.requests += count
    totals.set(key, aggTotal)
  }
  let sum = 0
  for (const aggTotal of totals.values()) sum += aggTotal.tokens
  const groupTotals = [...totals.values()]
    .map((aggTotal) => ({ key: aggTotal.key, tokens: aggTotal.tokens, requests: aggTotal.requests, percent: sum > 0 ? (aggTotal.tokens / sum) * 100 : 0 }))
    .sort((a, b) => b.tokens - a.tokens || (a.key < b.key ? -1 : 1))
  return { from, to, granularity: 'hour', group, buckets: [...buckets.values()], groupTotals, degraded: false }
}

export default createLedgerStore
