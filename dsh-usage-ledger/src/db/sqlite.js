// dsh-usage-ledger/src/db/sqlite.js — node:sqlite 明细后端。
//
// 设计：会话日志是唯一事实源，本模块只是它的 30 天滚动派生平表（request /
// tool_call 各一），供 hour 粒度与 sessionDetail 明细查询；日级以上的长期
// 聚合永远走 KV rollup（见 kv.js）。request_anchor / tool_anchor / turn_anchor
// 是不随 prune 删除的永久 delta 锚——KV rollup 的 upsert delta 基准不得依赖
// 可被 prune 清空的明细行（2026-11-17 双计事故，见 store.js 设计注）。
// 选择同步的 DatabaseSync 是因为宿主
// Electron 内嵌 node v24 已实测可用，且 store.js 的写入路径本身由内部串行
// 队列驱动——同步 prepared statement 在队列单线程语义下没有并发问题，
// 也省去一层异步适配。打开失败（无 node:sqlite、路径不可写、DDL 失败）由
// 调用方捕获并降级为纯 KV 模式，本模块自身不吞错误（探测期 fail-fast），
// 但打开之后的所有方法都假定 store 已串行化调用。

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 解析 SQLite 文件位置：config.factsDbPath 优先，否则落到 DSH_HOME /
 *  DSH_PROFILE_DIR / cwd 的 storages 下。目录递归预建。 */
export function resolveFactsDbPath(configured) {
  if (typeof configured === 'string' && configured !== '') return configured
  const base = process.env.DSH_HOME ?? process.env.DSH_PROFILE_DIR ?? process.cwd()
  return join(base, 'storages', 'usage-ledger-facts.db')
}

const DDL = `
CREATE TABLE IF NOT EXISTS request (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL DEFAULT 'main',
  turn INTEGER NOT NULL DEFAULT 0,
  step INTEGER NOT NULL DEFAULT 0,
  attempt INTEGER NOT NULL DEFAULT 0,
  time INTEGER NOT NULL,
  finished_at INTEGER,
  day TEXT NOT NULL,
  hour TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  effort TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  provider_total INTEGER,
  computed_total INTEGER NOT NULL DEFAULT 0,
  first_token_ms INTEGER,
  decode_ms INTEGER,
  estimated INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_request_day ON request(day);
CREATE INDEX IF NOT EXISTS idx_request_session_time ON request(session_id, time);
CREATE INDEX IF NOT EXISTS idx_request_day_model ON request(day, model);

CREATE TABLE IF NOT EXISTS tool_call (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL DEFAULT 'main',
  turn INTEGER NOT NULL DEFAULT 0,
  step INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  time INTEGER NOT NULL,
  finished_at INTEGER,
  day TEXT NOT NULL,
  hour TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_call_day ON tool_call(day);
CREATE INDEX IF NOT EXISTS idx_tool_call_session_time ON tool_call(session_id, time);

-- Delta anchors (2026-11-17 double-count fix): the KV rollup delta base must
-- NOT depend on the prunable detail rows. These permanent minimal tables hold
-- exactly the columns requestContrib/toolContrib read, so a replay of an
-- already-counted fact computes delta = 0 even after its detail row was pruned
-- (observed incident: a post-reset sweep re-replayed old-day facts whose
-- detail rows a prune had deleted → old = null → blind +add → ~2× on 6 days).
-- pruneOlderThan NEVER deletes them; clearAll (reset) does.
CREATE TABLE IF NOT EXISTS request_anchor (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL DEFAULT 'main',
  day TEXT NOT NULL,
  time INTEGER NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  reasoning_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  computed_total INTEGER NOT NULL DEFAULT 0,
  first_token_ms INTEGER,
  decode_ms INTEGER
);
CREATE TABLE IF NOT EXISTS tool_anchor (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  parent_id TEXT,
  kind TEXT NOT NULL DEFAULT 'main',
  day TEXT NOT NULL,
  time INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  duration_ms INTEGER
);
-- Turn markers carry no fact id; their replay guard is (session, seq).
CREATE TABLE IF NOT EXISTS turn_anchor (
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (session_id, seq)
);
`

/** failures 口径：只计 status='failed' 的请求行（interrupted 多为用户主动
 *  取消，不计入错误率）。store 与查询共用同一判断，避免两侧漂移。 */
export const FAILURE_STATUSES = new Set(['failed'])

/** @param {string} path SQLite 文件路径；打开/DDL 失败直接 throw（由 store 降级）。 */
export function openFactsBackend(path) {
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA busy_timeout=5000')
  db.exec(DDL)

  // Anchor migration (0.1.2 → 0.1.3): seed anchors from surviving detail rows —
  // an upgraded install must keep its delta base for everything still inside
  // the retention window. INSERT OR IGNORE: existing anchors always win. This
  // runs on every open; on an already-migrated DB it is a no-op scan.
  db.exec(`
    INSERT OR IGNORE INTO request_anchor (id, session_id, parent_id, kind, day, time,
      provider, model, status, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, computed_total, first_token_ms, decode_ms)
    SELECT id, session_id, parent_id, kind, day, time,
      provider, model, status, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, computed_total, first_token_ms, decode_ms
    FROM request;
    INSERT OR IGNORE INTO tool_anchor (id, session_id, parent_id, kind, day, time,
      name, status, duration_ms)
    SELECT id, session_id, parent_id, kind, day, time, name, status, duration_ms
    FROM tool_call;
  `)

  const upsertRequestStmt = db.prepare(`
    INSERT INTO request (id, session_id, parent_id, kind, turn, step, attempt, time, finished_at,
      day, hour, provider, model, effort, status,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
      provider_total, computed_total, first_token_ms, decode_ms, estimated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_id=excluded.session_id, parent_id=excluded.parent_id, kind=excluded.kind,
      turn=excluded.turn, step=excluded.step, attempt=excluded.attempt,
      time=excluded.time, finished_at=excluded.finished_at, day=excluded.day, hour=excluded.hour,
      provider=excluded.provider, model=excluded.model, effort=excluded.effort, status=excluded.status,
      input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
      reasoning_tokens=excluded.reasoning_tokens, cache_read_tokens=excluded.cache_read_tokens,
      cache_write_tokens=excluded.cache_write_tokens, provider_total=excluded.provider_total,
      computed_total=excluded.computed_total, first_token_ms=excluded.first_token_ms,
      decode_ms=excluded.decode_ms, estimated=excluded.estimated
  `)
  const getRequestStmt = db.prepare('SELECT * FROM request WHERE id = ?')
  const upsertToolStmt = db.prepare(`
    INSERT INTO tool_call (id, session_id, parent_id, kind, turn, step, name, time, finished_at,
      day, hour, status, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_id=excluded.session_id, parent_id=excluded.parent_id, kind=excluded.kind,
      turn=excluded.turn, step=excluded.step, name=excluded.name, time=excluded.time,
      finished_at=excluded.finished_at, day=excluded.day, hour=excluded.hour,
      status=excluded.status, duration_ms=excluded.duration_ms
  `)
  const getToolStmt = db.prepare('SELECT * FROM tool_call WHERE id = ?')
  // Anchor statements: the aliased SELECTs reshape a minimal anchor row into
  // the detail-row shape, so rowToRequestFact/rowToToolFact serve both.
  const getRequestAnchorStmt = db.prepare(`
    SELECT id, session_id, parent_id, kind, 0 AS turn, 0 AS step, 0 AS attempt,
      time, NULL AS finished_at, day, '' AS hour, provider, model, '' AS effort, status,
      input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens,
      NULL AS provider_total, computed_total, first_token_ms, decode_ms, 0 AS estimated
    FROM request_anchor WHERE id = ?
  `)
  const upsertRequestAnchorStmt = db.prepare(`
    INSERT INTO request_anchor (id, session_id, parent_id, kind, day, time,
      provider, model, status, input_tokens, output_tokens, reasoning_tokens,
      cache_read_tokens, cache_write_tokens, computed_total, first_token_ms, decode_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_id=excluded.session_id, parent_id=excluded.parent_id, kind=excluded.kind,
      day=excluded.day, time=excluded.time, provider=excluded.provider, model=excluded.model,
      status=excluded.status, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
      reasoning_tokens=excluded.reasoning_tokens, cache_read_tokens=excluded.cache_read_tokens,
      cache_write_tokens=excluded.cache_write_tokens, computed_total=excluded.computed_total,
      first_token_ms=excluded.first_token_ms, decode_ms=excluded.decode_ms
  `)
  const getToolAnchorStmt = db.prepare(`
    SELECT id, session_id, parent_id, kind, 0 AS turn, 0 AS step, name, time,
      NULL AS finished_at, day, '' AS hour, status, duration_ms
    FROM tool_anchor WHERE id = ?
  `)
  const upsertToolAnchorStmt = db.prepare(`
    INSERT INTO tool_anchor (id, session_id, parent_id, kind, day, time, name, status, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      session_id=excluded.session_id, parent_id=excluded.parent_id, kind=excluded.kind,
      day=excluded.day, time=excluded.time, name=excluded.name, status=excluded.status,
      duration_ms=excluded.duration_ms
  `)
  const hasTurnAnchorStmt = db.prepare('SELECT 1 FROM turn_anchor WHERE session_id = ? AND seq = ?')
  const addTurnAnchorStmt = db.prepare('INSERT OR IGNORE INTO turn_anchor (session_id, seq) VALUES (?, ?)')
  const pruneRequestStmt = db.prepare('DELETE FROM request WHERE day < ?')
  const pruneToolStmt = db.prepare('DELETE FROM tool_call WHERE day < ?')
  const countRequestStmt = db.prepare('SELECT COUNT(*) AS n FROM request')
  const countToolStmt = db.prepare('SELECT COUNT(*) AS n FROM tool_call')
  const countAnchorStmt = db.prepare('SELECT (SELECT COUNT(*) FROM request_anchor) + (SELECT COUNT(*) FROM tool_anchor) AS n')
  // hour 粒度聚合：按 (hour, provider, model) / (hour, kind) / (hour, tool) 三视角。
  // 范围天然被 retention 窗口限制，全量 GROUP BY 代价可控。
  const hourModelStmt = db.prepare(`
    SELECT hour, provider, model,
      SUM(computed_total) AS tokens, COUNT(*) AS requests,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
    FROM request WHERE day >= ? AND day <= ? GROUP BY hour, provider, model
  `)
  const hourKindStmt = db.prepare(`
    SELECT hour, kind,
      SUM(computed_total) AS tokens, COUNT(*) AS requests,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
    FROM request WHERE day >= ? AND day <= ? GROUP BY hour, kind
  `)
  const hourBaseStmt = db.prepare(`
    SELECT hour,
      SUM(computed_total) AS tokens, COUNT(*) AS requests,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
      SUM(input_tokens) AS inputTokens,
      SUM(cache_read_tokens) AS cacheReadTokens,
      SUM(cache_write_tokens) AS cacheWriteTokens
    FROM request WHERE day >= ? AND day <= ? GROUP BY hour
  `)
  const hourToolStmt = db.prepare(`
    SELECT hour, name, COUNT(*) AS calls,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
    FROM tool_call WHERE day >= ? AND day <= ? GROUP BY hour, name
  `)

  const backend = {
    path,
    /** @returns {object|undefined} 驼峰映射后的 request 行（delta 基准/详情共用）。 */
    getRequest(id) {
      const row = getRequestStmt.get(id)
      return row === undefined ? undefined : rowToRequestFact(row)
    },
    upsertRequest(f) {
      upsertRequestStmt.run(
        f.id, f.sessionId, f.parentId, f.kind, f.turn, f.step, f.attempt, f.time, f.finishedAt,
        f.day, f.hour, f.provider, f.model, f.effort, f.status,
        f.inputTokens, f.outputTokens, f.reasoningTokens, f.cacheReadTokens, f.cacheWriteTokens,
        f.providerTotal, f.computedTotal, f.firstTokenMs, f.decodeMs, f.estimated ? 1 : 0,
      )
    },
    getTool(id) {
      const row = getToolStmt.get(id)
      return row === undefined ? undefined : rowToToolFact(row)
    },
    upsertTool(f) {
      upsertToolStmt.run(
        f.id, f.sessionId, f.parentId, f.kind, f.turn, f.step, f.name, f.time, f.finishedAt,
        f.day, f.hour, f.status, f.durationMs,
      )
    },
    /** Permanent delta anchor for one request fact (prune-proof delta base). */
    getRequestAnchor(id) {
      const row = getRequestAnchorStmt.get(id)
      return row === undefined ? undefined : rowToRequestFact(row)
    },
    upsertRequestAnchor(f) {
      upsertRequestAnchorStmt.run(
        f.id, f.sessionId, f.parentId, f.kind, f.day, f.time,
        f.provider, f.model, f.status,
        f.inputTokens, f.outputTokens, f.reasoningTokens, f.cacheReadTokens, f.cacheWriteTokens,
        f.computedTotal, f.firstTokenMs, f.decodeMs,
      )
    },
    /** Permanent delta anchor for one tool fact. */
    getToolAnchor(id) {
      const row = getToolAnchorStmt.get(id)
      return row === undefined ? undefined : rowToToolFact(row)
    },
    upsertToolAnchor(f) {
      upsertToolAnchorStmt.run(
        f.id, f.sessionId, f.parentId, f.kind, f.day, f.time, f.name, f.status, f.durationMs,
      )
    },
    /** Turn-marker replay guard: was (session, seq) already counted? */
    hasTurnAnchor(sessionId, seq) {
      return hasTurnAnchorStmt.get(sessionId, seq) !== undefined
    },
    addTurnAnchor(sessionId, seq) {
      addTurnAnchorStmt.run(sessionId, seq)
    },
    /** 删除 cutoffDay（不含）之前的明细；返回各表删除行数。
     *  Delta anchors (request_anchor/tool_anchor/turn_anchor) are NEVER
     *  deleted here — they are the permanent KV delta base (2026-11-17 fix). */
    pruneOlderThan(cutoffDay) {
      const requests = Number(pruneRequestStmt.run(cutoffDay).changes)
      const tools = Number(pruneToolStmt.run(cutoffDay).changes)
      return { requests, tools }
    },
    clearAll() {
      db.exec('DELETE FROM request')
      db.exec('DELETE FROM tool_call')
      // reset = full rebuild: anchors go too, or the post-reset rescan would
      // compute delta-0 against anchors of facts whose KV rows were wiped.
      db.exec('DELETE FROM request_anchor')
      db.exec('DELETE FROM tool_anchor')
      db.exec('DELETE FROM turn_anchor')
    },
    rowCounts() {
      return {
        requestRows: Number(countRequestStmt.get().n),
        toolRows: Number(countToolStmt.get().n),
        anchorRows: Number(countAnchorStmt.get().n),
      }
    },
    /** hour 粒度三视角聚合（from/to 为闭区间 day key）。 */
    hourly(from, to) {
      return {
        base: hourBaseStmt.all(from, to),
        byModel: hourModelStmt.all(from, to),
        byKind: hourKindStmt.all(from, to),
        byTool: hourToolStmt.all(from, to),
      }
    },
    /** 会话（含子孙）明细，新的在前，cap limit。 */
    sessionRecords(sessionIds, limit = 500) {
      if (sessionIds.length === 0) return []
      const marks = sessionIds.map(() => '?').join(',')
      const stmt = db.prepare(
        `SELECT * FROM request WHERE session_id IN (${marks}) ORDER BY time DESC, id DESC LIMIT ?`,
      )
      return stmt.all(...sessionIds, limit).map(rowToRequestFact)
    },
    sessionToolAgg(sessionIds) {
      if (sessionIds.length === 0) return []
      const marks = sessionIds.map(() => '?').join(',')
      const stmt = db.prepare(`
        SELECT name, COUNT(*) AS calls,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
        FROM tool_call WHERE session_id IN (${marks}) GROUP BY name ORDER BY calls DESC, name ASC
      `)
      return stmt.all(...sessionIds)
    },
    /** 会话（含子孙）按 (provider, model) 无上限聚合——sessionDetail 的 byModel
     *  四桶来源。刻意不走 500 上限的 records 切片：面板的分桶明细不受明细窗口
     *  cap 截断（v7，2026-11-17）。行形状：
     *  {provider, model, requests, failures, tokens, inputTokens, outputTokens,
     *   cacheReadTokens, cacheWriteTokens}（tokens = computed_total 之和）。 */
    sessionModelAgg(sessionIds) {
      if (sessionIds.length === 0) return []
      const marks = sessionIds.map(() => '?').join(',')
      const stmt = db.prepare(`
        SELECT provider, model, COUNT(*) AS requests,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures,
          SUM(computed_total) AS tokens,
          SUM(input_tokens) AS inputTokens,
          SUM(output_tokens) AS outputTokens,
          SUM(cache_read_tokens) AS cacheReadTokens,
          SUM(cache_write_tokens) AS cacheWriteTokens
        FROM request WHERE session_id IN (${marks}) GROUP BY provider, model
      `)
      return stmt.all(...sessionIds)
    },
    close() {
      try { db.close() } catch { /* 重复 close 无害 */ }
    },
  }
  return backend
}

/** SQLite 行 → contract.js RequestFact 形状（snake_case → camelCase）。 */
export function rowToRequestFact(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentId: row.parent_id ?? null,
    kind: row.kind,
    turn: Number(row.turn),
    step: Number(row.step),
    attempt: Number(row.attempt),
    time: Number(row.time),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
    day: row.day,
    hour: row.hour,
    provider: row.provider ?? '',
    model: row.model ?? '',
    effort: row.effort ?? '',
    status: row.status,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    reasoningTokens: Number(row.reasoning_tokens),
    cacheReadTokens: Number(row.cache_read_tokens),
    cacheWriteTokens: Number(row.cache_write_tokens),
    providerTotal: row.provider_total === null || row.provider_total === undefined ? null : Number(row.provider_total),
    computedTotal: Number(row.computed_total),
    firstTokenMs: row.first_token_ms === null || row.first_token_ms === undefined ? null : Number(row.first_token_ms),
    decodeMs: row.decode_ms === null || row.decode_ms === undefined ? null : Number(row.decode_ms),
    estimated: Number(row.estimated) === 1,
  }
}

/** SQLite 行 → contract.js ToolCallFact 形状。 */
export function rowToToolFact(row) {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentId: row.parent_id ?? null,
    kind: row.kind,
    turn: Number(row.turn),
    step: Number(row.step),
    name: row.name,
    time: Number(row.time),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : Number(row.finished_at),
    day: row.day,
    hour: row.hour,
    status: row.status,
    durationMs: row.duration_ms === null || row.duration_ms === undefined ? null : Number(row.duration_ms),
  }
}
