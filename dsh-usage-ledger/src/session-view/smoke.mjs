// smoke.mjs — src/session-view/ 的冒烟测试（task-15）：估算器锚点、8 桶构成
// 全路径（live block + 每请求快照）、7 桶当前上下文、compaction shadow 剪除、
// prune、空日志/无 usage 降级、速率 completed 口径、组装器合并 + 短缓存。
//
// 断言数字全部手算（纯 ASCII 文本按 4 字符/token、每消息 4 token 框架费）。
// 运行：node src/session-view/smoke.mjs   (exit 0 = pass)

import assert from 'node:assert/strict'
import { estimateTokens } from '../contract.js'
import {
  messageTokens,
  toolTokens,
  buildContextWindow,
  buildUsageComposition,
  mergeUsageCompositions,
  buildRates,
} from './compose.js'
import { createSessionViewCalculator } from './calculator.js'

const T0 = 1763000000000

let failures = 0
let checks = 0
function ok(cond, label, extra) {
  checks++
  if (!cond) {
    failures++
    console.error(`FAIL  ${label}${extra !== undefined ? ` — got ${JSON.stringify(extra)}` : ''}`)
  }
}
function eq(got, want, label) {
  ok(got === want, label, got === want ? undefined : { got, want })
}

function ev(seq, time, type, data) {
  return { seq, time, type, data }
}
const rep = (ch, n) => ch.repeat(n)

// ── 估算器锚点（与 token-total context-window.ts 同参数）──────────────────
eq(estimateTokens('abcd'), 1, '估算：纯 ASCII 4 字符/token')
eq(estimateTokens('ab'), 1, '估算：ASCII 向上取整')
eq(estimateTokens('中中中'), 2, '估算：宽字符 1.5 字符/token（3→2）')
eq(estimateTokens('😀'), 2, '估算：emoji 计 3 宽字符（→2）')
eq(messageTokens({ content: rep('a', 40) }), 14, 'messageTokens：内容 10 + 框架 4')
eq(messageTokens({ content: [{ type: 'text', text: rep('a', 40) }] }), 14, 'messageTokens：文本块不计 type 判别符')
eq(messageTokens({ content: [{ type: 'image', url: 'x' }] }), 1104, 'messageTokens：图片按 tile 计（1100）')
eq(toolTokens({ name: 'read', description: rep('x', 8), parameters: { k: 1 } }), 13, 'toolTokens：名字1 + 描述2 + schema2 + 框架8')
eq(toolTokens({ name: '', description: 'x' }), 0, 'toolTokens：无名条目为 0')

// ── 夹具：两请求 8 桶全路径（数字全手算）──────────────────────────────────
// 块估值：system 104 / user 24 / skill 14 / injected 19 / toolResult 54 /
// toolDef 目录 21 / assistant₁ 34 / assistant₂ 24。
const fixture = [
  ev(0, T0, 'request/context', { provider: 'deepseek', model: 'deepseek-chat', contextWindow: 128000 }),
  ev(1, T0 + 10, 'system/message', { message: { source: { kind: 'system-prompt' }, content: rep('A', 400) } }),
  ev(2, T0 + 20, 'user/message', { source: { kind: 'user' }, message: { content: rep('B', 80) } }),
  ev(3, T0 + 30, 'user/message', { source: { kind: 'skill-catalog' }, message: { content: rep('C', 40) } }),
  ev(4, T0 + 40, 'user/message', { source: { kind: 'memory-file' }, message: { content: rep('D', 60) } }),
  ev(5, T0 + 50, 'tool/result', { message: { toolCallId: 'c1', content: rep('E', 200) } }),
  ev(6, T0 + 60, 'request/header', { header: { tools: [{ name: 'pwsh', description: rep('F', 40), parameters: { k: 1 } }] } }),
  ev(7, T0 + 1000, 'assistant/message', {
    message: { content: rep('G', 120) },
    usage: { inputTokens: 300, outputTokens: 40, cacheReadTokens: 60, cacheWriteTokens: 0, reasoningTokens: 5 },
  }),
  ev(8, T0 + 2000, 'assistant/message', {
    message: { content: rep('H', 80) },
    usage: { inputTokens: 400, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 10, reasoningTokens: 0 },
  }),
]

// ── 8 桶构成（每请求为当时整段消息列表付费）──────────────────────────────
const comp = buildUsageComposition(fixture)
ok(comp !== null, '构成：有 usage 的日志非 null')
assert.deepEqual(
  comp.buckets.map((b) => [b.key, b.tokens]),
  [
    ['systemPrompt', 208], // 104 × 2 次请求
    ['user', 48],
    ['skill', 28],
    ['toolResult', 108],
    ['toolDef', 42], // 目录 21 × 2
    ['injected', 38],
    ['assistant', 34], // 只被第二请求携带
    ['output', 90], // 40 + 50（从不属于回放 prompt）
  ],
  '构成：8 桶定序 + 每请求快照累计',
)
eq(comp.billedTokens, 860, '构成：billed = 精确四桶之和（400+460）')
assert.deepEqual(
  comp.totals,
  { tokens: 860, inputTokens: 700, outputTokens: 90, cacheReadTokens: 60, cacheWriteTokens: 10, reasoningTokens: 5 },
  '构成：totals 六字段',
)
eq(comp.requests, 2, '构成：requests 计数')

// ── 7 桶当前上下文（下一请求携带内容的构成）──────────────────────────────
const ctx = buildContextWindow(fixture)
ok(ctx !== null, '上下文：非空日志非 null')
assert.deepEqual(
  ctx.buckets.map((b) => [b.key, b.tokens]),
  [
    ['systemPrompt', 104],
    ['user', 24],
    ['skill', 14],
    ['toolResult', 54],
    ['toolDef', 21], // 最新 request/header 的目录
    ['injected', 19],
    ['assistant', 58], // 34 + 24
  ],
  '上下文：7 桶定序（无 output）',
)
eq(ctx.totalTokens, 294, '上下文：totalTokens = 桶之和')
eq(ctx.contextWindow, 128000, '上下文：contextWindow 取 request/context')
eq(ctx.provider, 'deepseek', '上下文：provider')
eq(ctx.model, 'deepseek-chat', '上下文：model')
eq(ctx.cacheHitTokens, 0, '上下文：最新 usage 的 cacheRead')
eq(ctx.cacheMissTokens, 410, '上下文：最新 usage 的 input+cacheWrite')
eq(ctx.cacheKnown, true, '上下文：cacheKnown')
eq(ctx.promptTokens, 400, '上下文：promptTokens = 最新计费（无 total 时 input+cacheRead）')

// ── compaction shadow 剪除 + 摘要顶替（injected）─────────────────────────
const shadowed = [
  ev(0, T0, 'system/message', { message: { source: { kind: 'system-prompt' }, content: rep('A', 400) } }),
  ev(1, T0 + 10, 'user/message', { source: { kind: 'user' }, message: { content: rep('B', 80) } }),
  ev(2, T0 + 20, 'tool/result', { message: { toolCallId: 'c1', content: rep('E', 200) } }),
  ev(3, T0 + 100, 'assistant/message', {
    message: { content: rep('G', 120) },
    usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  }),
  ev(4, T0 + 200, 'compaction/summary', {
    summary: rep('S', 160),
    usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    shadowedSeqs: [1, 2],
  }),
  ev(5, T0 + 300, 'assistant/message', {
    message: { content: rep('G', 120) },
    usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  }),
]
const shadowComp = buildUsageComposition(shadowed)
assert.deepEqual(
  shadowComp.buckets.map((b) => [b.key, b.tokens]),
  [
    ['systemPrompt', 312], // 3 次请求都在
    ['user', 48], // 前两次在（shadow 后剪除）
    ['skill', 0],
    ['toolResult', 108], // 前两次在
    ['toolDef', 0],
    ['injected', 44], // 摘要 block 只被第三请求携带
    ['assistant', 68], // 摘要调用 + 第三请求
    ['output', 35], // 10 + 20 + 5
  ],
  'shadow：摘要调用按 PRE-prune 快照计费，shadow 后剪除，摘要顶替为 injected',
)
eq(shadowComp.billedTokens, 385, 'shadow：billed 110+220+55')
eq(shadowComp.requests, 3, 'shadow：requests')
const shadowCtx = buildContextWindow(shadowed)
assert.deepEqual(
  shadowCtx.buckets.map((b) => [b.key, b.tokens]),
  [
    ['systemPrompt', 104],
    ['user', 0],
    ['skill', 0],
    ['toolResult', 0],
    ['toolDef', 0],
    ['injected', 44], // 摘要顶替
    ['assistant', 68],
  ],
  'shadow：当前上下文剪掉 shadowed 序列、摘要按 injected 记',
)
eq(shadowCtx.totalTokens, 216, 'shadow：当前上下文 totalTokens')
eq(shadowCtx.promptTokens, 50, 'shadow：最新计费 promptTokens')

// ── compaction/prune：只剪不顶替、不计费 ─────────────────────────────────
const pruned = [
  ev(0, T0, 'system/message', { message: { source: { kind: 'system-prompt' }, content: rep('A', 400) } }),
  ev(1, T0 + 10, 'user/message', { source: { kind: 'user' }, message: { content: rep('B', 80) } }),
  ev(2, T0 + 20, 'compaction/prune', { shadowedRange: { start: 1, end: 1 } }),
  ev(3, T0 + 100, 'assistant/message', {
    message: { content: rep('G', 120) },
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  }),
]
const pruneComp = buildUsageComposition(pruned)
eq(pruneComp.buckets.find((b) => b.key === 'user').tokens, 0, 'prune：range 剪除后不再计入')
eq(pruneComp.buckets.find((b) => b.key === 'systemPrompt').tokens, 104, 'prune：未剪块照计')
eq(pruneComp.buckets.find((b) => b.key === 'output').tokens, 2, 'prune：output 照计')
eq(pruneComp.requests, 1, 'prune：prune 事件自身不计费')
eq(buildContextWindow(pruned).buckets.find((b) => b.key === 'user').tokens, 0, 'prune：当前上下文同步剪除')

// ── 空日志 / 无 usage 降级 ───────────────────────────────────────────────
eq(buildContextWindow([]), null, '空日志：上下文 null')
eq(buildUsageComposition([]), null, '空日志：构成 null')
const noUsage = [
  ev(0, T0, 'system/message', { message: { source: { kind: 'system-prompt' }, content: rep('A', 400) } }),
  ev(1, T0 + 10, 'user/message', { source: { kind: 'user' }, message: { content: rep('B', 80) } }),
]
eq(buildUsageComposition(noUsage), null, '无 usage：构成 null（卡片自隐藏）')
ok(buildContextWindow(noUsage) !== null, '无 usage：上下文仍可用')

// ── 速率：completed 口径（firstTokenMs 均值 + Σoutput/ΣdecodeMs）──────────
const ratesEvents = [
  // r1：completed，firstTokenMs 200 / decodeMs 800 / output 50
  ev(0, T0, 'step/start', { turn: 1, step: 1 }),
  ev(1, T0 + 1000, 'assistant/message', {
    turn: 1, step: 1, message: {},
    stream: [
      { type: 'chunk', time: T0 + 200, chunk: { type: 'text-delta', text: 'x' } },
      { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 50 } } },
    ],
    usage: { inputTokens: 10, outputTokens: 50 },
  }),
  ev(2, T0 + 1100, 'turn/end', { turn: 1, reason: 'completed' }),
  // r2：completed，firstTokenMs 200 / decodeMs 800 / output 30
  ev(3, T0 + 2000, 'step/start', { turn: 2, step: 1 }),
  ev(4, T0 + 3000, 'assistant/message', {
    turn: 2, step: 1, message: {},
    stream: [
      { type: 'chunk', time: T0 + 2200, chunk: { type: 'text-delta', text: 'x' } },
      { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 30 } } },
    ],
    usage: { inputTokens: 5, outputTokens: 30 },
  }),
  ev(5, T0 + 3100, 'turn/end', { turn: 2, reason: 'completed' }),
  // r3：completed 但只有 stream usage（无 top-level usage）→ decodeMs null → 只进均值不进速度
  ev(6, T0 + 4000, 'step/start', { turn: 3, step: 1 }),
  ev(7, T0 + 5000, 'assistant/message', {
    turn: 3, step: 1, message: {},
    stream: [
      { type: 'chunk', time: T0 + 4300, chunk: { type: 'text-delta', text: 'x' } },
      { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 3, outputTokens: 9 } } },
    ],
  }),
  ev(8, T0 + 5100, 'turn/end', { turn: 3, reason: 'completed' }),
  // r4：failed attempt → 全排除
  ev(9, T0 + 6000, 'step/start', { turn: 4, step: 1 }),
  ev(10, T0 + 6100, 'assistant/attempt', {
    turn: 4, step: 1,
    stream: [
      { type: 'chunk', time: T0 + 6050, chunk: { type: 'text-delta', text: 'x' } },
      { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } },
    ],
  }),
  ev(11, T0 + 6200, 'turn/end', { turn: 4, reason: 'failed' }),
  // r5：interrupted → 全排除
  ev(12, T0 + 7000, 'step/start', { turn: 5, step: 1 }),
  ev(13, T0 + 7100, 'turn/end', { turn: 5, reason: 'cancelled' }),
]
const rates = buildRates(ratesEvents)
eq(rates.avgFirstTokenMs, 233, '速率：均值只算 completed 且有值（round((200+200+300)/3)）')
eq(rates.tokensPerSecond, 50, '速率：Σoutput/ΣdecodeMs = 80/1.6s，只算有 decode 窗口的 completed')
assert.deepEqual(buildRates([]), { avgFirstTokenMs: null, tokensPerSecond: null }, '速率：空日志 null/null')

// ── 组装器：读日志 + 合并 + 短缓存 ───────────────────────────────────────
function mockPersistence(logs, { statless = false } = {}) {
  const reads = { open: 0 }
  return {
    reads,
    async list() {
      return [...logs.entries()].map(([id, log]) => (statless
        ? { id }
        : { header: { id }, eventCount: log.events.length, sizeBytes: 1000 + log.events.length }))
    },
    async open(id) {
      const log = logs.get(id)
      if (log === undefined) throw new Error(`unknown session ${id}`)
      reads.open++
      return {
        inheritedEventCount: log.inheritedEventCount ?? 0,
        async read(offset, limit) {
          return { events: log.events.slice(offset, offset + limit) }
        },
        async close() {},
      }
    },
  }
}

const childFixture = [
  ev(0, T0, 'system/message', { message: { source: { kind: 'system-prompt' }, content: rep('A', 400) } }),
  ev(1, T0 + 100, 'assistant/message', {
    message: { content: rep('G', 120) },
    usage: { inputTokens: 40, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
  }),
]
const childRatesEvents = [
  ev(0, T0, 'step/start', { turn: 1, step: 1 }),
  ev(1, T0 + 1000, 'assistant/message', {
    turn: 1, step: 1, message: {},
    stream: [
      { type: 'chunk', time: T0 + 400, chunk: { type: 'text-delta', text: 'x' } },
      { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 2, outputTokens: 20 } } },
    ],
    usage: { inputTokens: 2, outputTokens: 20 },
  }),
  ev(2, T0 + 1400, 'turn/end', { turn: 1, reason: 'completed' }),
]

const logs = new Map([
  ['r1', { events: fixture }],
  ['c1', { events: [...childFixture, ...childRatesEvents] }],
])
const persistence = mockPersistence(logs)
const calc = createSessionViewCalculator({ getPersistence: () => persistence, logger: { warn: () => {} } })
const view = await calc.calculate('r1', ['c1'])
ok(view.context !== null, '组装器：根日志可读 → context 非 null')
eq(view.context.totalTokens, 294, '组装器：context = 根会话自身（不含子会话）')
ok(view.composition !== null, '组装器：构成非 null')
eq(view.composition.requests, 4, '组装器：composition = 根+子合并（根 2 + 子 2 个带 usage 请求）')
eq(view.composition.billedTokens, 860 + 48 + 22, '组装器：合并 billed（860+48+22）')
eq(view.composition.buckets.find((b) => b.key === 'systemPrompt').tokens, 416, '组装器：合并桶（根 208 + 子 104×2 次快照）')
ok(view.childRates instanceof Map && view.childRates.has('c1'), '组装器：childRates 按 id')
eq(view.childRates.get('c1').avgFirstTokenMs, 400, '组装器：子会话速率（firstTokenMs）')
ok(Math.abs(view.childRates.get('c1').tokensPerSecond - 100 / 3) < 1e-9, '组装器：子会话速率（20 tok / 600ms）')

// 短缓存：stat 不变 → 复用（不再 open 日志）
const readsBefore = persistence.reads.open
const again = await calc.calculate('r1', ['c1'])
eq(persistence.reads.open, readsBefore, '缓存：stat 不变不重读日志')
eq(again.context.totalTokens, 294, '缓存：结果复用')
// 日志变化（stat 变了）→ 重算
logs.get('r1').events.push(ev(9, T0 + 3000, 'user/message', { source: { kind: 'user' }, message: { content: rep('B', 80) } }))
await calc.calculate('r1', ['c1'])
ok(persistence.reads.open > readsBefore, '缓存：stat 变化触发重算（重新 open 日志）')

// TTL 兜底：statless（rc.1 头行）→ TTL 内复用、过期重算
{
  const statlessLogs = new Map([['s1', { events: fixture }]])
  const statless = mockPersistence(statlessLogs, { statless: true })
  const shortTtl = createSessionViewCalculator({ getPersistence: () => statless, ttlMs: 80, logger: { warn: () => {} } })
  await shortTtl.calculate('s1', [])
  const n0 = statless.reads.open
  await shortTtl.calculate('s1', [])
  eq(statless.reads.open, n0, '缓存：statless TTL 内复用')
  await new Promise((resolve) => setTimeout(resolve, 120))
  await shortTtl.calculate('s1', [])
  ok(statless.reads.open > n0, '缓存：TTL 过期保底重算')
}

// 优雅降级：未知会话 / persistence 缺失 / 抛错
{
  const unknown = await calc.calculate('no-such-session', [])
  eq(unknown.context, null, '降级：日志不可读 → context null')
  eq(unknown.composition, null, '降级：构成 null')
  eq(unknown.childRates.size, 0, '降级：childRates 空')
  const broken = createSessionViewCalculator({ getPersistence: () => { throw new Error('ctx gone') }, logger: { warn: () => {} } })
  const res = await broken.calculate('s1', ['c1'])
  eq(res.context, null, '降级：getPersistence 抛错 → null')
  eq(res.composition, null, '降级：getPersistence 抛错 → composition null')
}

// fork 继承前缀剥离（cut>0 只对 seeded fork 生效；未 seed cut=0 空操作）
{
  const seeded = new Map([['f1', { inheritedEventCount: 2, events: [
    ev(0, T0, 'user/message', { source: { kind: 'user' }, message: { content: rep('B', 80) } }),
    ev(1, T0 + 1, 'user/message', { source: { kind: 'user' }, message: { content: rep('B', 80) } }),
    ev(2, T0 + 100, 'assistant/message', { message: { content: rep('G', 120) }, usage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } }),
  ] }]])
  const forkPersistence = mockPersistence(seeded)
  const forkCalc = createSessionViewCalculator({ getPersistence: () => forkPersistence, logger: { warn: () => {} } })
  const forkView = await forkCalc.calculate('f1', [])
  eq(forkView.composition.buckets.find((b) => b.key === 'user').tokens, 0, 'fork：继承前缀不计入构成')
  eq(forkView.composition.requests, 1, 'fork：只计自有请求')
  eq(forkView.context.buckets.find((b) => b.key === 'assistant').tokens, 34, 'fork：当前上下文只含自有块')
}

// mergeUsageCompositions：空输入 null / 合并求和
eq(mergeUsageCompositions([null, null]), null, '合并：全 null → null')
eq(mergeUsageCompositions([comp, null]).billedTokens, comp.billedTokens, '合并：跳过 null 部分')

// ── 汇总 ────────────────────────────────────────────────────────────────
if (failures > 0) {
  console.error(`\nsmoke FAILED: ${failures}/${checks} checks failed`)
  process.exit(1)
}
console.log(`smoke OK: ${checks}/${checks} checks passed`)
