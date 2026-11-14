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
  // run instead of racing it. Live sessions are watermarked at wipe time (see
  // dsh-token-total's resetAndRescan for why the boundary must be re-sampled).
  let resetInFlight = /** @type {Promise<void>|null} */ (null)
  const isRebuilding = () => resetInFlight !== null
  const resetAndRescan = () => {
    if (resetInFlight) return resetInFlight
    resetInFlight = (async () => {
      const previous = await store.liveSequences()
      const boundaries = new Map()
      for (const handle of ctx.sessions.list()) {
        const seq = handle.seq
        if (typeof seq === 'number' && Number.isFinite(seq) && seq >= 0) {
          boundaries.set(handle.id, seq)
          continue
        }
        const old = previous.get(handle.id)
        boundaries.set(handle.id, typeof old === 'number' ? old : -1)
      }
      await store.reset(boundaries)
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
