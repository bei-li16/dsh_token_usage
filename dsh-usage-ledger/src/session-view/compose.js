// compose.js — 会话日志按需组装的纯函数核心（task-15）。
//
// 三个组装器，全部只吃一个会话自己的事件（fork 继承前缀先剥掉）：
// - buildContextWindow：重建「下一个请求会携带什么」（当前上下文卡）。
//   剪枝事件（compaction/prune|summary 的 shadowedSeqs/shadowedRange）丢弃、
//   compaction 摘要按 injected 记、工具目录取最新 request/header 的 catalogue，
//   分桶映射到 7 桶（无 output）。token 数为字符估值（contract 的 estimateTokens），
//   与 provider 精确计费的 promptTokens 并排给出。
// - buildUsageComposition：这笔会话「实际为什么付费」（Token 统计 donut 卡）。
//   live block map + 每请求快照（O(events + requests×8)，禁止 O(requests×events)）：
//   每个请求为当时的整段消息列表付费，compaction shadow 一到就剪掉对应 block；
//   output 从不属于回放 prompt，直接计入自己的桶；billed/四桶来自 provider 精确
//   usage。8 桶 = 7 桶 + output。
// - buildRates：该会话的应答速率（completed 口径：firstTokenMs 均值只算
//   completed 且有值；tokensPerSecond = Σoutput/(ΣdecodeMs/1000)，只算有
//   decode 窗口的 completed 记录）。用本插件自己的 RequestFold 重放取
//   firstTokenMs/decodeMs，与 store 的 sessionDetail 速率同口径。
//
// 参照 dsh-token-total 的 context-window.ts / usage-composition.ts /
// session-detail.ts（只读参照，零 import）；分桶与排序与任务钉死的 wire 契约
// 逐字一致。纯函数、零依赖（除 ../contract.js 与 ../collector/fold.js）。

import { estimateTokens, decodeRateOf } from '../contract.js'
import { RequestFold } from '../collector/fold.js'

/** 花费构成的 8 桶，定序（7 桶 + output）。 */
export const COMPOSITION_BUCKETS = ['systemPrompt', 'user', 'skill', 'toolResult', 'toolDef', 'injected', 'assistant', 'output']
/** 当前上下文的 7 桶（output 从不占用窗口）。 */
export const CONTEXT_BUCKETS = COMPOSITION_BUCKETS.filter((key) => key !== 'output')

// ── 估值小工具（与 token-total context-window.ts 同口径，基于自己的
//    contract.estimateTokens：ASCII 4 字符、宽字符 1.5、emoji 3）────────────

/** JSON 值的近似 token：只数字符串与叶子标量，跳过 provider 记账签名。 */
function valueTokens(value) {
  if (typeof value === 'string') return estimateTokens(value)
  if (typeof value === 'number' || typeof value === 'boolean') return 1
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + valueTokens(item), 0)
  if (value !== null && typeof value === 'object') {
    let sum = 0
    for (const [key, item] of Object.entries(value)) {
      // replay/thinking 签名是 provider 记账不回传的内容，计它只会虚高。
      if (key === 'replayState' || key === 'thinkingSignature' || key === 'textSignature') continue
      sum += valueTokens(item)
    }
    return sum
  }
  return 0
}

/** 一条回放消息的近似 token（内容 + 每消息 4 token 框架费）。 */
export function messageTokens(message) {
  const content = message?.content
  const blocks = Array.isArray(content) ? content : content === undefined ? [] : [content]
  let sum = 4
  for (const block of blocks) {
    const kind = block?.type
    if (kind === 'image' || kind === 'image-url') { sum += 1100; continue }
    // 文本块的 type 判别符是聊天框架而非内容：把 "text" 字面量计进去会给
    // 每个块加一个幻影 token。
    if (kind === 'text' && typeof block?.text === 'string') {
      sum += valueTokens(block.text)
      continue
    }
    sum += valueTokens(block)
  }
  return sum
}

/** 一个工具定义的近似 token：名字 + 描述 + JSON schema + 每节点框架费。 */
export function toolTokens(tool) {
  const name = typeof tool?.name === 'string' ? tool.name : ''
  if (name === '') return 0
  return estimateTokens(name) + valueTokens(tool?.description)
    + estimateTokens(JSON.stringify(tool?.parameters ?? {})) + 8
}

/** 一次回答实际发出的 prompt token（provider 计费口径）：total−output，或
 *  未报 total 时 uncached+cached。完全没有 usage → null。 */
function promptTokensOf(usage) {
  const total = Number(usage?.totalTokens) || 0
  const output = Number(usage?.outputTokens) || 0
  if (total > output) return total - output
  const input = Number(usage?.inputTokens) || 0
  const cached = Number(usage?.cacheReadTokens) || 0
  return input + cached > 0 ? input + cached : null
}

/** 一个 compaction 事件剪掉的序列集合（shadowedSeqs + shadowedRange）。 */
export function shadowedSeqsOf(data) {
  const seqs = []
  for (const seq of Array.isArray(data?.shadowedSeqs) ? data.shadowedSeqs : []) seqs.push(Number(seq))
  const range = data?.shadowedRange
  if (typeof range?.start === 'number' && typeof range?.end === 'number') {
    for (let seq = range.start; seq <= range.end; seq++) seqs.push(seq)
  }
  return seqs
}

// ── 桶分类：一个回放事件属于哪个桶（context 与 composition 共用）──────────

/** 把一类事件映射到 7 桶之一；返回 null 表示该事件不占窗口（不回放）。 */
function blockBucketOf(type, data) {
  switch (type) {
    case 'system/message': {
      const kind = String(data?.message?.source?.kind ?? data?.source?.kind ?? 'system-prompt')
      return kind === 'system-prompt' ? 'systemPrompt' : 'injected'
    }
    case 'user/message': {
      const kind = String(data?.source?.kind ?? data?.message?.source?.kind ?? 'user')
      if (kind === 'user') return 'user'
      if (kind === 'skill-catalog') return 'skill'
      return 'injected'
    }
    case 'assistant/message':
      return 'assistant'
    case 'tool/result':
      return 'toolResult'
    default:
      return null
  }
}

/** 按事件序排序的防御性拷贝（组装器都要求 seq 升序）。 */
function orderedBySeq(events) {
  return [...(Array.isArray(events) ? events : [])].sort((a, b) => (a?.seq ?? 0) - (b?.seq ?? 0))
}

// ── 当前上下文（7 桶）──────────────────────────────────────────────────────

/**
 * 重建「下一个请求会携带什么」。空事件 → null（面板自隐藏）。
 * 只回放仍会被携带的内容：剪枝序列丢弃、compaction 摘要顶替（injected）、
 * 工具目录取最新 request/header。token 为估值；promptTokens/cache 为 provider
 * 精确数（来自最新一次带 usage 的回答或 compaction 摘要调用）。
 */
export function buildContextWindow(events) {
  if (!Array.isArray(events) || events.length === 0) return null
  const ordered = orderedBySeq(events)
  // ── 第一遍：当前请求派生自的状态（剪枝集 / 摘要 / 工具目录 / 路由 / 缓存）──
  const shadowed = new Set()
  const summaries = []
  let tools = []
  let headerRoute = null
  let route = null
  let cache = null
  let billed = null
  for (const event of ordered) {
    const data = event?.data ?? {}
    if (event.type === 'compaction/prune' || event.type === 'compaction/summary') {
      for (const seq of shadowedSeqsOf(data)) shadowed.add(seq)
      if (event.type === 'compaction/summary') {
        summaries.push({ seq: event.seq, tokens: messageTokens({ content: data.summary }) })
        const usage = data.usage
        if (usage) {
          cache = {
            hit: Number(usage.cacheReadTokens) || 0,
            miss: (Number(usage.inputTokens) || 0) + (Number(usage.cacheWriteTokens) || 0),
          }
          const summaryBilled = promptTokensOf(usage)
          if (summaryBilled !== null) billed = summaryBilled
        }
      }
      continue
    }
    if (event.type === 'request/header') {
      const header = data.header ?? {}
      if (Array.isArray(header.tools)) tools = header.tools
      const config = header.config ?? {}
      if (typeof config.provider === 'string' || typeof config.model === 'string') {
        headerRoute = { provider: String(config.provider ?? ''), model: String(config.model ?? '') }
      }
      continue
    }
    if (event.type === 'request/context') {
      route = {
        provider: String(data.provider ?? ''),
        model: String(data.model ?? ''),
        contextWindow: typeof data.contextWindow === 'number' && data.contextWindow > 0 ? data.contextWindow : null,
      }
      continue
    }
    if (event.type === 'assistant/message' && data.usage) {
      const usage = data.usage
      cache = {
        hit: Number(usage.cacheReadTokens) || 0,
        miss: (Number(usage.inputTokens) || 0) + (Number(usage.cacheWriteTokens) || 0),
      }
      const prompt = promptTokensOf(usage)
      if (prompt !== null) billed = prompt
    }
  }
  // ── 第二遍：每个仍会被回放进窗口的事件 → 7 桶累加 ────────────────────────
  const buckets = new Map()
  const add = (key, tokens) => {
    if (tokens > 0) buckets.set(key, (buckets.get(key) ?? 0) + tokens)
  }
  for (const event of ordered) {
    if (shadowed.has(event.seq)) continue
    const key = blockBucketOf(event.type, event?.data ?? {})
    if (key === null) continue
    const data = event?.data ?? {}
    // tool/result 只估 data.message（token-total 同口径）；其余回退 content。
    add(key, event.type === 'tool/result' ? messageTokens(data.message ?? {}) : messageTokens(data.message ?? { content: data.content }))
  }
  // compaction 摘要顶替被剪区间，按 injected 记（模型没写过它）。
  for (const summary of summaries) add('injected', summary.tokens)
  // 下一个请求发送的工具目录：名字 + 描述 + JSON schema。
  for (const tool of tools) {
    const tokens = toolTokens(tool)
    if (tokens > 0) add('toolDef', tokens)
  }
  let totalTokens = 0
  for (const tokens of buckets.values()) totalTokens += tokens
  return {
    totalTokens,
    contextWindow: route?.contextWindow ?? null,
    provider: route?.provider || headerRoute?.provider || '',
    model: route?.model || headerRoute?.model || '',
    promptTokens: billed,
    cacheHitTokens: cache?.hit ?? 0,
    cacheMissTokens: cache?.miss ?? 0,
    cacheKnown: cache !== null,
    buckets: CONTEXT_BUCKETS.map((key) => ({ key, tokens: buckets.get(key) ?? 0 })),
  }
}

// ── 花费构成（8 桶）───────────────────────────────────────────────────────

/**
 * 累计一个会话「每个请求实际为什么付费」。O(events + requests×8)：单遍日志
 * 维护 live block map 与每桶小计，请求到达时快照（8 个加法）+ 工具目录总额，
 * shadow 序列一到就从回放列表剪掉。请求一次都没报 usage → null。
 */
export function buildUsageComposition(events) {
  if (!Array.isArray(events) || events.length === 0) return null
  const ordered = orderedBySeq(events)

  /** 仍会被下一请求回放的 block，按事件 seq 键控。 */
  const live = new Map()
  /** 回放列表的当前每桶小计——一个请求会发送什么。 */
  const liveByBucket = new Map()
  /** 每个请求至今发送过的东西，按桶累计。 */
  const acc = new Map()
  const totals = { tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  let billed = 0
  let requests = 0
  /** 最新 request/header 的工具目录的 prompt 估值。 */
  let catalogue = 0

  const addBlock = (seq, bucket, tokens) => {
    if (!(tokens > 0)) return
    live.set(seq, { bucket, tokens })
    liveByBucket.set(bucket, (liveByBucket.get(bucket) ?? 0) + tokens)
  }
  const dropBlock = (seq) => {
    const block = live.get(seq)
    if (block === undefined) return
    live.delete(seq)
    liveByBucket.set(block.bucket, (liveByBucket.get(block.bucket) ?? 0) - block.tokens)
  }
  /** 一个请求为它回放的一切付费。 */
  const snapshot = () => {
    for (const [bucket, tokens] of liveByBucket) {
      if (tokens > 0) acc.set(bucket, (acc.get(bucket) ?? 0) + tokens)
    }
    if (catalogue > 0) acc.set('toolDef', (acc.get('toolDef') ?? 0) + catalogue)
  }
  /** 把 provider 的精确报告折进计费四桶。 */
  const account = (usage) => {
    const input = Number(usage?.inputTokens) || 0
    const cacheRead = Number(usage?.cacheReadTokens) || 0
    const cacheWrite = Number(usage?.cacheWriteTokens) || 0
    const output = Number(usage?.outputTokens) || 0
    const reasoning = Number(usage?.reasoningTokens) || 0
    totals.inputTokens += input
    totals.cacheReadTokens += cacheRead
    totals.cacheWriteTokens += cacheWrite
    totals.outputTokens += output
    totals.reasoningTokens += reasoning
    totals.tokens += input + cacheRead + cacheWrite + output
    billed += input + cacheRead + cacheWrite + output
    requests++
    // output 从不属于回放 prompt，不是 live block：直接记到自己的桶。
    if (output > 0) acc.set('output', (acc.get('output') ?? 0) + output)
  }

  for (const event of ordered) {
    const data = event?.data ?? {}
    if (event.type === 'compaction/prune' || event.type === 'compaction/summary') {
      // 摘要调用本身携带 PRE-prune 的 prompt：先计费再应用 shadow——且在
      // 摘要自己的 block 落地之前。
      if (event.type === 'compaction/summary' && data.usage !== undefined && data.usage !== null) {
        snapshot()
        account(data.usage)
      }
      for (const seq of shadowedSeqsOf(data)) dropBlock(seq)
      if (event.type === 'compaction/summary') {
        addBlock(event.seq, 'injected', messageTokens({ content: data.summary }))
      }
      continue
    }
    if (event.type === 'request/header') {
      const header = data.header ?? {}
      if (Array.isArray(header.tools)) {
        catalogue = 0
        for (const tool of header.tools) catalogue += toolTokens(tool)
      }
      continue
    }
    if (event.type === 'assistant/message') {
      if (data.usage !== undefined && data.usage !== null) {
        snapshot()
        account(data.usage)
      }
      addBlock(event.seq, 'assistant', messageTokens(data.message ?? { content: data.content }))
      continue
    }
    const bucket = blockBucketOf(event.type, data)
    if (bucket === null) continue
    // tool/result 只估 data.message（token-total 同口径）；其余回退 content。
    addBlock(event.seq, bucket, event.type === 'tool/result'
      ? messageTokens(data.message ?? {})
      : messageTokens(data.message ?? { content: data.content }))
  }

  if (requests === 0) return null
  return {
    buckets: COMPOSITION_BUCKETS.map((key) => ({ key, tokens: Math.max(0, Math.round(acc.get(key) ?? 0)) })),
    billedTokens: billed,
    totals,
    requests,
  }
}

/** 把一棵树（根 + 后代）的构成按桶合并（token-total mergeUsageCompositions 同款）。 */
export function mergeUsageCompositions(parts) {
  const present = (Array.isArray(parts) ? parts : []).filter((p) => p !== null && p !== undefined)
  if (present.length === 0) return null
  const acc = new Map()
  const totals = { tokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
  let billed = 0
  let requests = 0
  for (const part of present) {
    for (const bucket of part.buckets ?? []) {
      if (typeof bucket?.key === 'string') acc.set(bucket.key, (acc.get(bucket.key) ?? 0) + (bucket.tokens ?? 0))
    }
    totals.tokens += part.totals?.tokens ?? 0
    totals.inputTokens += part.totals?.inputTokens ?? 0
    totals.outputTokens += part.totals?.outputTokens ?? 0
    totals.cacheReadTokens += part.totals?.cacheReadTokens ?? 0
    totals.cacheWriteTokens += part.totals?.cacheWriteTokens ?? 0
    totals.reasoningTokens += part.totals?.reasoningTokens ?? 0
    billed += part.billedTokens ?? 0
    requests += part.requests ?? 0
  }
  return {
    buckets: COMPOSITION_BUCKETS.map((key) => ({ key, tokens: acc.get(key) ?? 0 })),
    billedTokens: billed,
    totals,
    requests,
  }
}

// ── 应答速率（completed 口径）─────────────────────────────────────────────

/**
 * 一个会话自己的应答速率：用本插件自己的 RequestFold 重放（与 store 的
 * sessionDetail 速率同口径），再按 token-total session-detail 的 per-part
 * 规则聚合——firstTokenMs 均值只算 completed 且有值的记录；速度 =
 * Σoutput/(ΣdecodeMs/1000)，只算有 decode 窗口的 completed 记录。
 */
export function buildRates(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return { avgFirstTokenMs: null, tokensPerSecond: null }
  }
  const fold = new RequestFold({ sessionId: 'session-view-rates' })
  for (const event of events) {
    try {
      fold.fold(event)
    } catch { /* 组装是观察面，坏事件不砸视图 */ }
  }
  let facts
  try {
    facts = fold.flush().requests
  } catch {
    return { avgFirstTokenMs: null, tokensPerSecond: null }
  }
  let firstSum = 0
  let firstCount = 0
  let outputSum = 0
  let decodeSum = 0
  for (const fact of facts) {
    if (fact?.status !== 'completed') continue
    if (typeof fact.firstTokenMs === 'number' && fact.firstTokenMs !== null) {
      firstSum += fact.firstTokenMs
      firstCount++
    }
    // 速度只算有 decode 窗口的 completed 记录（top-level usage 才关窗）。
    if (typeof fact.decodeMs === 'number' && fact.decodeMs > 0
      && typeof fact.outputTokens === 'number' && fact.outputTokens > 0) {
      outputSum += fact.outputTokens
      decodeSum += fact.decodeMs
    }
  }
  return {
    avgFirstTokenMs: firstCount > 0 ? Math.round(firstSum / firstCount) : null,
    tokensPerSecond: decodeRateOf(outputSum, decodeSum),
  }
}
