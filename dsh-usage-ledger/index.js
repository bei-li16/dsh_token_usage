/**
 * dsh-usage-ledger host entry — WIRING ONLY. The implementation lives in:
 *   src/db/store.js        LedgerStore (dual backend: node:sqlite facts.db 30-day
 *                          detail + storageDomain KV permanent day rollups)
 *   src/collector/         live session/event fold + persistence backfill
 *   src/routes/            fenced /usage-ledger/api JSON routes
 *   client.js              browser artifact (sidebar row + global panel + session view)
 *
 * Observational by design: a bad disk state must never interrupt a turn, so
 * every store write is fire-and-forget behind an internal queue and failures
 * surface only through /usage-ledger/api/status.
 */

import { createLedgerStore, STORE_VERSION } from './src/db/store.js'
import { LedgerCollector } from './src/collector/collector.js'
import { buildLedgerRoute } from './src/routes/routes.js'
import { createSessionViewCalculator } from './src/session-view/calculator.js'

export const name = 'dsh-usage-ledger'

/** Services required before mounting: web routes, session persistence + live
 *  store (backfill + live events), and the storage domain hub (durable rows). */
export const inject = ['webServer', 'sessionPersistence', 'sessions', 'storageDomain']

/**
 * Tunables (edit on the `usage-ledger` row's `config` in cordis.patch.yml).
 * No Config schema export: this plugin deliberately imports nothing beyond
 * relative modules, so config is normalized here with defensive defaults.
 * @typedef {Object} UsageLedgerConfig
 * @property {number} [retentionDays]        SQLite detail retention (default 30)
 * @property {number} [heatmapWeeks]         default heatmap span (default 52)
 * @property {number} [backfillConcurrency]  historical scan parallelism (default 4)
 * @property {string} [factsDbPath]          override for the SQLite file
 *                                           (default `<DSH_HOME>/storages/usage-ledger-facts.db`)
 */

/** Clamp a config number to a sane positive range. */
function positiveInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function normalizeConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  return {
    retentionDays: positiveInt(c.retentionDays, 30, 1, 3650),
    heatmapWeeks: positiveInt(c.heatmapWeeks, 52, 4, 260),
    backfillConcurrency: positiveInt(c.backfillConcurrency, 4, 1, 16),
    factsDbPath: typeof c.factsDbPath === 'string' ? c.factsDbPath : '',
  }
}

/**
 * /reset replay boundary for ONE live session (drain-gap fix, 2026-11-17).
 *
 * The post-reset rescan replays exactly [0, boundary) per session (collector
 * partition: [0, boundary) is backfill's span, [boundary, ∞) the live pass's
 * — never both, never neither). store.reset() wipes the KV rollups and the
 * live chain never re-observes a past event, so the boundary must cover
 * every event the live chain has ALREADY observed and counted this
 * activation: the replay prefix is the only path that can re-land them.
 *
 * `persistedEnd` is an EXCLUSIVE end — normally handle.seq, the host
 * JsonlSessionHandle's persisted length. Live events buffer in the host and
 * "drain through the same chain" in a bounded batch window, so at wipe time
 * the persisted log typically ends BELOW what the live chain has already
 * seen (seq >= handle.seq). Callers fall back to the store's previous live
 * watermark, then the -1 "replay nothing" sentinel. `liveHighSeq` is the
 * collector's max live-observed seq this activation — an INCLUSIVE 0-based
 * event seq — hence the +1: the event AT the high-water must fall inside
 * [0, boundary). Timing is safe: the buffered events reach the log within
 * the host's own batch timer (seconds), while the rescan reaches this
 * session minutes later — by replay time the prefix is fully materialized
 * on disk.
 *
 * @param {number} [persistedEnd] exclusive persisted end (length / prior watermark)
 * @param {number} [liveHighSeq] inclusive max live-observed seq (this activation)
 * @returns {number} the exclusive replay boundary
 */
export function resetReplayBoundary(persistedEnd, liveHighSeq) {
  const base = typeof persistedEnd === 'number' && Number.isFinite(persistedEnd) && persistedEnd >= 0
    ? persistedEnd
    : -1
  if (typeof liveHighSeq !== 'number' || !Number.isFinite(liveHighSeq) || liveHighSeq < 0) return base
  // Inclusive live high-water → exclusive boundary: cover the event at seq
  // liveHighSeq itself, not only the ones below it.
  return Math.max(base, liveHighSeq + 1)
}

/**
 * The store is a PROCESS-level singleton, keyed on globalThis. A hot reload
 * (fiber dispose + re-import + fresh apply()) constructs a fresh plugin whose
 * storageDomain.open('usage_ledger') would otherwise hit "already-open" — the
 * domain handle stays valid for the process lifetime, so one store is reused
 * across fibers. (Same failure mode dsh-token-total documented for its store.)
 */
// v2: the v1 instance may sit degraded in a live process (the 2026-11-14
// poisoned day_tool row incident); a fresh key lets a plugin toggle heal it
// without an app restart.
const STORE_KEY = '__dshUsageLedgerStoreV2'

function sharedStore(ctx, config) {
  const g = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis))
  const existing = g[STORE_KEY]
  if (existing) {
    if (existing.storeVersion === STORE_VERSION) return /** @type {import('./src/contract.js').LedgerStore} */ (existing)
    // The cached instance predates the current store code generation: dispose
    // it (closes the domain + SQLite handles) and rebuild, so a plugin toggle
    // upgrades the store without an app restart. dispose() is async; the new
    // store's KV open retries 'already-open' across the close window.
    try { existing.dispose?.() } catch { /* best-effort teardown of the old generation */ }
  }
  // createLedgerStore never throws on an unavailable backend — it degrades
  // internally to KV-only — so caching the instance here is safe.
  const created = createLedgerStore({
    storageDomain: ctx.storageDomain,
    config: { retentionDays: config.retentionDays, factsDbPath: config.factsDbPath },
    logger: ctx.logger,
  })
  g[STORE_KEY] = created
  return created
}

/**
 * @param {import('cordis').Context} ctx
 * @param {UsageLedgerConfig} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const store = sharedStore(ctx, config)
  const collector = new LedgerCollector({ store, concurrency: config.backfillConcurrency, logger: ctx.logger })

  /** Live trust inputs for the /usage-ledger/api fence, resolved per request
   *  (the host line decides which provider carries the explicit authorities;
   *  both are probed with ctx.get() because a traced Context throws on a
   *  direct property read of a service the host does not register). */
  const trust = () => {
    const runtime = /** @type {{trustedHosts?: string[]}|undefined} */ (ctx.get('webRuntime'))
    const startup = /** @type {{trustedHosts?: string[]}|undefined} */ (ctx.get('webStartup'))
    return {
      trustedHosts: runtime?.trustedHosts ?? startup?.trustedHosts ?? [],
      bindHost: ctx.webServer.host,
      protocol: ctx.webServer.protocol ?? 'http:',
    }
  }

  // One abortable scan at a time: the boot backfill and any /reset rescan
  // share this controller slot; fiber teardown aborts whatever is in flight.
  let scanController = /** @type {AbortController|null} */ (null)
  const rescan = async () => {
    scanController?.abort()
    const controller = new AbortController()
    scanController = controller
    await store.ready()
    await collector.backfill(ctx.sessionPersistence, ctx.sessions, controller.signal)
  }

  // /reset rebuild pipeline: concurrent callers coalesce into one in-flight
  // run instead of racing it. Live sessions are watermarked by a PROVIDER
  // evaluated inside the store's serial reset job — at job time,
  // immediately before the wipe (0.1.5 sub-second-window fix). The watermark
  // is max(persisted end, live high-water + 1) so the replay prefix also
  // covers events counted live but not yet drained to the log (drain-gap
  // fix, 2026-11-17 — see resetReplayBoundary).
  let resetInFlight = /** @type {Promise<void>|null} */ (null)
  const isRebuilding = () => resetInFlight !== null
  const resetAndRescan = () => {
    if (resetInFlight) return resetInFlight
    resetInFlight = (async () => {
      // Rare fallback only (handle.seq not a usable number): the store's last
      // live watermarks. Prefetching before enqueue is safe — it is NOT part
      // of the tightness argument below.
      const previous = await store.liveSequences()
      // Tightness (0.1.5): the provider below runs INSIDE the store's serial
      // reset job, so sampling and wipe are adjacent in queue order — no
      // event can slip between them:
      //  - recordRequests enqueued BEFORE the reset job (their events were
      //    observed before sampling) already applied their KV contributions,
      //    which the wipe is about to clear; their seq ≤ the liveHighSeq the
      //    provider reads (the collector raises liveHighSeq synchronously
      //    before dispatching), so the max(persisted, liveHigh+1) boundary
      //    covers them → the rescan replays them back.
      //  - events observed only AFTER the provider ran enqueue their
      //    recordRequests BEHIND the reset job → they land on the fresh
      //    ledger; their seq > liveHighSeq@provider ⇒ ≥ boundary, so the
      //    rescan's live-owned skip ([boundary, ∞)) leaves them to the live
      //    count — exactly once.
      await store.reset(() => {
        const boundaries = new Map()
        for (const handle of ctx.sessions.list()) {
          const seq = handle.seq
          // Persisted end: handle.seq (the JsonlSessionHandle's persisted
          // length) when usable; else the store's last live watermark; else -1.
          const persisted = typeof seq === 'number' && Number.isFinite(seq) && seq >= 0
            ? seq
            : previous.get(handle.id)
          // Drain-gap fix (2026-11-17): events already observed live but still
          // in the host's drain buffer (seq >= handle.seq) were counted into
          // the KV rollups that the wipe is about to clear, and the live
          // chain will never re-observe them — only the replay prefix can
          // re-land them (see resetReplayBoundary for the exclusive/inclusive
          // +1 detail).
          boundaries.set(handle.id, resetReplayBoundary(
            typeof persisted === 'number' ? persisted : -1,
            collector.liveHighSeqOf(handle.id),
          ))
        }
        return boundaries
      })
      await rescan()
    })().finally(() => {
      resetInFlight = null
    })
    return resetInFlight
  }

  ctx.effect(() => {
    const route = buildLedgerRoute({
      store,
      collector,
      trust,
      isRebuilding,
      resetAndRescan,
      config: { heatmapWeeks: config.heatmapWeeks, retentionDays: config.retentionDays },
      // Model display-name metadata for /daily groupNames (optional service;
      // probed with ctx.get because a traced Context throws on absent reads).
      llm: () => ctx.get('llm'),
      // Session-view assembler (task-15): on-demand log replay for the
      // session page's context/composition cards + children speed columns.
      // persistence goes through a getter (the llm injection precedent) so a
      // remount window can never hold a stale direct reference; the assembler
      // keeps its own in-process short cache and degrades to nulls.
      sessionView: createSessionViewCalculator({ getPersistence: () => ctx.sessionPersistence, logger: ctx.logger }),
    })
    const dispose = ctx.webServer.register(route)
    return dispose
  }, 'dsh-usage-ledger: routes')

  ctx.effect(() => {
    const dispose = collector.start(ctx)
    // Boot backfill after the routes mount so the UI can poll status. The
    // chain runs fire-and-forget behind the host: a degraded store or failed
    // persistence listing must surface as a logged boot failure (the scan's
    // own error already rides collector status), never as an unhandled
    // rejection that can take the process down.
    void rescan().catch((err) => {
      ctx.logger?.warn?.(`[dsh-usage-ledger] boot scan failed: ${err instanceof Error ? err.message : String(err)}`)
    })
    return () => {
      scanController?.abort()
      dispose()
    }
  }, 'dsh-usage-ledger: collector')
}
