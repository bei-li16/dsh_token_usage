// dsh-usage-ledger/src/db/kv.js — storageDomain KV 永久 rollup 后端。
//
// 设计：KV 域 `usage_ledger` v1 存永久日级聚合（days / day_model / day_kind /
// day_tool / sessions 五表 + 全局 backfill cursor），是 SQLite 明细被 30 天
// prune 之后仍然存活的统计面。spec 必须传给宿主 storageDomain.open() 的是
// 纯对象（宿主源码核实：open 只读 spec.name/version/tables/global 与
// valueSchema.parse），因此这里手写 {parse} shim——插件零运行时依赖，
// 禁止 import zod / @deepseek-ai/dsh-storage-domain。parse 的职责是
// 「校验存量记录 + 补默认值」（早期行可能缺后加的字段），类型根本不对就
// throw，配合 invalidRecords:'backup-and-skip' 让宿主把坏行挪走、跳过，
// 而不是整个域打不开（本层数据全是派生缓存，可丢弃重建）。

import {
  emptyDayRollup,
  emptyDayModelRollup,
  emptyDayKindRollup,
  emptyDayToolRollup,
  emptySessionIndexRow,
} from '../contract.js'

/** 非负有限数取整，否则 fallback。 */
function num(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback
}

/** 非空字符串才接受，否则 fallback。 */
function str(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function plainObject(value) {
  // 派生缓存自愈原则：坏行一律归一为可加载的死行，绝不 throw——一次 throw
  // 会让 single-document 后端的整域 open 失败（backup-and-skip 对它无效）。
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value
}

/** parse shim：normalize 返回合法行；结构性错误 throw（触发 invalid-record）。 */
function schemaOf(normalize) {
  return { parse: (value) => normalize(value) }
}

const daySchema = schemaOf((value) => {
  const v = plainObject(value)
  const day = typeof v.day === 'string' ? v.day : ''
  return {
    ...emptyDayRollup(day),
    tokens: num(v.tokens),
    inputTokens: num(v.inputTokens),
    outputTokens: num(v.outputTokens),
    reasoningTokens: num(v.reasoningTokens),
    cacheReadTokens: num(v.cacheReadTokens),
    cacheWriteTokens: num(v.cacheWriteTokens),
    requests: num(v.requests),
    failures: num(v.failures),
    turns: num(v.turns),
    firstTokenMsSum: num(v.firstTokenMsSum),
    firstTokenCount: num(v.firstTokenCount),
    decodeMsSum: num(v.decodeMsSum),
    decodeCount: num(v.decodeCount),
    decodeTokens: num(v.decodeTokens),
    toolCalls: num(v.toolCalls),
    toolFailures: num(v.toolFailures),
    lastSeen: num(v.lastSeen),
  }
})

const dayModelSchema = schemaOf((value) => {
  const v = plainObject(value)
  const day = typeof v.day === 'string' ? v.day : ''
  const model = typeof v.model === 'string' && v.model !== '' ? v.model : '(unknown)'
  return {
    ...emptyDayModelRollup(day, model),
    tokens: num(v.tokens),
    inputTokens: num(v.inputTokens),
    outputTokens: num(v.outputTokens),
    reasoningTokens: num(v.reasoningTokens),
    cacheReadTokens: num(v.cacheReadTokens),
    cacheWriteTokens: num(v.cacheWriteTokens),
    requests: num(v.requests),
    failures: num(v.failures),
  }
})

const dayKindSchema = schemaOf((value) => {
  const v = plainObject(value)
  const day = typeof v.day === 'string' ? v.day : ''
  const kind = typeof v.kind === 'string' && v.kind !== '' ? v.kind : 'main'
  return {
    ...emptyDayKindRollup(day, kind),
    tokens: num(v.tokens),
    requests: num(v.requests),
    failures: num(v.failures),
    turns: num(v.turns),
  }
})

const dayToolSchema = schemaOf((value) => {
  const v = plainObject(value)
  // 防御：空工具名历史毒行（见 2026-11-14 事故）在此归一为 '(unknown)'——
  // 单行问题绝不能否决整个 domain 的 open（single-document 后端没有
  // backupRecord，backup-and-skip 会退化为整域拒开）。
  const day = typeof v.day === 'string' ? v.day : ''
  const tool = typeof v.tool === 'string' && v.tool !== '' ? v.tool : '(unknown)'
  return {
    ...emptyDayToolRollup(day, tool),
    calls: num(v.calls),
    failures: num(v.failures),
    durationMsSum: num(v.durationMsSum),
  }
})

const sessionSchema = schemaOf((value) => {
  const v = plainObject(value)
  const row = {
    ...emptySessionIndexRow(typeof v.id === 'string' ? v.id : ''),
    parentId: typeof v.parentId === 'string' && v.parentId !== '' ? v.parentId : null,
    kind: str(v.kind, 'main'),
    name: str(v.name),
    firstDay: str(v.firstDay),
    lastDay: str(v.lastDay),
    tokens: num(v.tokens),
    inputTokens: num(v.inputTokens),
    outputTokens: num(v.outputTokens),
    cacheReadTokens: num(v.cacheReadTokens),
    cacheWriteTokens: num(v.cacheWriteTokens),
    requests: num(v.requests),
    failures: num(v.failures),
    turns: num(v.turns),
    toolCalls: num(v.toolCalls),
    lastSeen: num(v.lastSeen),
  }
  // reasoningTokens 是 SessionIndexRow typedef 之外的增量字段（contract 只允许
  // 增量扩展）：SessionDetailResponse.totals 需要它，老行缺省为 0。
  row.reasoningTokens = num(v.reasoningTokens)
  return row
})

/** 全局 cursor：宿主把 null 当「从未写入」（直接发 initial），所以 parse 遇 null 必须 throw。 */
const cursorSchema = schemaOf((value) => {
  const v = plainObject(value)
  const backfilledSessions = Array.isArray(v.backfilledSessions)
    ? v.backfilledSessions.filter((id) => typeof id === 'string')
    : []
  const liveFirstSeq = {}
  if (typeof v.liveFirstSeq === 'object' && v.liveFirstSeq !== null && !Array.isArray(v.liveFirstSeq)) {
    for (const [id, seq] of Object.entries(v.liveFirstSeq)) {
      if (typeof seq === 'number' && Number.isFinite(seq)) liveFirstSeq[id] = Math.round(seq)
    }
  }
  return { backfilledSessions, liveFirstSeq }
})

/** 传给宿主 storageDomain.open() 的纯对象 spec（defineDomain/domainTable 的手写等价物）。 */
export const DOMAIN_SPEC = {
  name: 'usage_ledger',
  version: 1,
  // 派生缓存：坏行挪走跳过，比整个域拒开更符合「观察式记录」。
  invalidRecords: 'backup-and-skip',
  global: {
    schema: cursorSchema,
    initial: { backfilledSessions: [], liveFirstSeq: {} },
  },
  tables: {
    days: { valueSchema: daySchema },
    day_model: { valueSchema: dayModelSchema },
    day_kind: { valueSchema: dayKindSchema },
    day_tool: { valueSchema: dayToolSchema },
    sessions: { valueSchema: sessionSchema },
  },
}

/**
 * 打开 KV 后端。失败（already-open / invalid-record / 后端不可用）直接 throw，
 * 由 store 降级为无 rollup 模式或纯 SQLite 模式。
 * 'already-open' 做有限重试：旧代际 store 的 dispose 与 domain.close() 是异步的，
 * 新旧交替窗口内 open 会短暂撞名。
 * @returns {Promise<{domain: object, days: object, dayModel: object, dayKind: object,
 *   dayTool: object, sessions: object, globalHandle: object}>}
 */
export async function openKvBackend(storageDomain) {
  let lastErr
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const domain = await storageDomain.open(DOMAIN_SPEC)
      return {
        domain,
        days: domain.table('days'),
        dayModel: domain.table('day_model'),
        dayKind: domain.table('day_kind'),
        dayTool: domain.table('day_tool'),
        sessions: domain.table('sessions'),
        globalHandle: domain.global,
      }
    } catch (err) {
      lastErr = err
      if (!/already open/.test(String(err?.message ?? err))) throw err
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
  }
  throw lastErr
}

/** provider/model → day_model 分组引用：双空时 '(unknown)'，否则允许空侧。 */
export function modelRefOf(provider, model) {
  const p = typeof provider === 'string' ? provider : ''
  const m = typeof model === 'string' ? model : ''
  if (p === '' && m === '') return '(unknown)'
  return `${p}/${m}`
}

/** day_model 键 `${day}|${modelRef}` 的分割：day 定宽 10，第 11 位起是 modelRef。 */
export function splitDayGroupKey(key) {
  if (typeof key !== 'string' || key.length < 12 || key[10] !== '|') return null
  return { day: key.slice(0, 10), group: key.slice(11) }
}
