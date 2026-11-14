/**
 * dsh-usage-ledger browser artifact (single self-contained file by design:
 * the module loader loads exactly one factory; no bundler, no relative imports).
 * React comes from the factory's require('react'); JSX is impossible here, so
 * everything is React.createElement. Charts are hand-drawn SVG — no charting
 * library, no host UI package. All chrome colors are var(--dsw-alias-*) theme
 * tokens; only the chart series palette is literal (artwork exception).
 * All visible text flows through the 'usageLedger' locale namespace (zh/en;
 * zh-TW reuses the zh dictionary for v1).
 *
 * Wire shapes mirror dsh-usage-ledger/src/contract.js (SummaryResponse,
 * DailyResponse, HeatmapResponse, SessionsResponse, SessionDetailResponse,
 * ToolsResponse, LedgerStatus) over POST usage-ledger/api/<method>
 * (document-relative, envelope {ok:true,value}|{ok:false,error}).
 */
window.__ModuleLoader__.load({
  id: 'dsh-usage-ledger',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const LOCALE_NS = 'usageLedger'

    // ── locale dictionaries (zh/en keys must stay aligned) ────────────────
    const zh = {
      nav: '用量账本', tab: '用量', back: '返回', loading: '加载中…',
      loadError: '加载失败', retry: '重试', empty: '暂无数据', na: '—',
      degraded: '明细数据不可用，以下为永久汇总（KV 模式）。',
      backfill: '正在回填历史数据',
      sumTitle: '总览', totalTokens: '总 tokens', requests: '请求数', failures: '失败',
      errorRate: '错误率', cacheHit: '缓存命中率', avgTtft: '平均首 token',
      decodeSpeed: '解码速度', streak: '连续活跃', streakUnit: '天', peakDay: '峰值日',
      activeDays: '活跃天数', inputTok: '输入', outputTok: '输出',
      cacheReadTok: '缓存读', cacheWriteTok: '缓存写', turns: '轮次', toolCalls: '工具调用',
      dailyTitle: '每日用量（按模型）', rToday: '今天', r7: '7 天', r30: '30 天', r90: '90 天',
      heatTitle: '近一年活跃度', less: '少', more: '多',
      hmDay: '每日', hmWeek: '每周', hmCum: '累计',
      donutTitle: '模型占比', other: '其他',
      toolsTitle: '工具分布', tName: '工具', tCalls: '次数', tFail: '失败率', tAvg: '平均耗时',
      sessTitle: '会话', sName: '名称', sKind: '类型', sDays: '活跃区间', sReq: '请求', sTok: 'tokens',
      kindMain: '主会话', kindSub: '子代理', kindWorkflow: '工作流',
      svTotals: '会话汇总（含子孙）', svRecords: '请求明细', svTools: '工具调用',
      svDegraded: '明细已超保留期或不可用，仅显示永久汇总。',
      cTime: '时间', cModel: '模型', cStatus: '状态', cTok: 'tokens', cTtft: '首 token', cSpeed: '速度',
      stRunning: '进行中', stCompleted: '完成', stFailed: '失败', stInterrupted: '中断',
      tokPerS: 'tok/s',
      reqWord: '次请求', recordFail: '条写入失败',
      sessTotal: '共 {n} 个会话', recTrunc: '显示前 50 / 共 {n} 条',
      donutWindow: '（近 30 天）',
    }
    const en = {
      nav: 'Usage ledger', tab: 'Usage', back: 'Back', loading: 'Loading…',
      loadError: 'Failed to load', retry: 'Retry', empty: 'No data yet', na: '—',
      degraded: 'Detail unavailable; showing permanent rollup only (KV mode).',
      backfill: 'Backfilling history',
      sumTitle: 'Overview', totalTokens: 'Total tokens', requests: 'Requests', failures: 'Failures',
      errorRate: 'Error rate', cacheHit: 'Cache hit rate', avgTtft: 'Avg first token',
      decodeSpeed: 'Decode speed', streak: 'Active streak', streakUnit: 'd', peakDay: 'Peak day',
      activeDays: 'Active days', inputTok: 'Input', outputTok: 'Output',
      cacheReadTok: 'Cache read', cacheWriteTok: 'Cache write', turns: 'Turns', toolCalls: 'Tool calls',
      dailyTitle: 'Daily usage by model', rToday: 'Today', r7: '7d', r30: '30d', r90: '90d',
      heatTitle: 'Past year activity', less: 'Less', more: 'More',
      hmDay: 'Daily', hmWeek: 'Weekly', hmCum: 'Cumulative',
      donutTitle: 'Model share', other: 'Other',
      toolsTitle: 'Tool usage', tName: 'Tool', tCalls: 'Calls', tFail: 'Failure rate', tAvg: 'Avg duration',
      sessTitle: 'Sessions', sName: 'Name', sKind: 'Kind', sDays: 'Active span', sReq: 'Requests', sTok: 'tokens',
      kindMain: 'Main', kindSub: 'Subagent', kindWorkflow: 'Workflow',
      svTotals: 'Session totals (incl. descendants)', svRecords: 'Request records', svTools: 'Tool calls',
      svDegraded: 'Detail has aged out of retention or is unavailable; permanent rollup only.',
      cTime: 'Time', cModel: 'Model', cStatus: 'Status', cTok: 'tokens', cTtft: 'TTFT', cSpeed: 'Speed',
      stRunning: 'Running', stCompleted: 'Completed', stFailed: 'Failed', stInterrupted: 'Interrupted',
      tokPerS: 'tok/s',
      reqWord: 'requests', recordFail: 'write failures',
      sessTotal: '{n} sessions', recTrunc: 'showing first 50 of {n}',
      donutWindow: ' (last 30 days)',
    }

    // t is bound in apply() before any component renders.
    let t = (k) => k

    // ── api ────────────────────────────────────────────────────────────────
    function post(method, body, signal) {
      return fetch(`usage-ledger/api/${method}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}), signal,
      }).then((r) => r.json()).then((w) => {
        if (!w || w.ok !== true) throw new Error((w && w.error && w.error.message) || 'usage api error')
        return w.value
      })
    }

    /** Fetch one api method; aborts in-flight request on unmount / dep change. */
    function useApi(method, body, deps) {
      const [state, setState] = React.useState({ data: null, error: null, loading: true, tick: 0 })
      React.useEffect(() => {
        const ac = new AbortController()
        setState((s) => ({ data: null, error: null, loading: true, tick: s.tick }))
        post(method, body, ac.signal).then(
          (data) => setState((s) => ({ data, error: null, loading: false, tick: s.tick })),
          (error) => {
            if (error && error.name === 'AbortError') return
            setState((s) => ({ data: null, error, loading: false, tick: s.tick }))
          },
        )
        return () => ac.abort()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, deps.concat(state.tick))
      const retry = () => setState((s) => ({ ...s, tick: s.tick + 1 }))
      return { ...state, retry }
    }

    /** Status with 1s polling while backfill.running; timers cleared on stop/unmount.
     *  refreshTick increments on the running true→false transition so panels refetch. */
    function useStatus() {
      const [status, setStatus] = React.useState(null)
      const [refreshTick, setRefreshTick] = React.useState(0)
      React.useEffect(() => {
        let stopped = false
        let timer = null
        let ac = null
        let wasRunning = false
        const tick = () => {
          ac = new AbortController()
          post('status', {}, ac.signal).then((s) => {
            if (stopped) return
            setStatus(s)
            const running = !!(s && s.backfill && s.backfill.running)
            if (wasRunning && !running) setRefreshTick((v) => v + 1) // backfill just finished → refresh sections
            wasRunning = running
            if (running) timer = setTimeout(tick, 1000)
          }, () => { /* status bar stays hidden on error */ })
        }
        tick()
        return () => { stopped = true; if (timer) clearTimeout(timer); if (ac) ac.abort() }
      }, [])
      return { status, refreshTick }
    }

    // ── formatting helpers ─────────────────────────────────────────────────
    const fmtInt = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : t('na'))
    const fmtTok = (n) => {
      if (typeof n !== 'number' || !Number.isFinite(n)) return t('na')
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
      return String(Math.round(n))
    }
    const fmtMs = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return t('na')
      if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`
      return `${Math.round(ms)}ms`
    }
    const fmtPct = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)}%` : t('na'))
    const fmtSpeed = (v) => (typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(1)} ${t('tokPerS')}` : t('na'))
    const pad2 = (n) => String(n).padStart(2, '0')
    const fmtTime = (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return t('na')
      const d = new Date(ms)
      return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    }
    // heatmap tooltip header: zh → 2026年11月13日, en → November 13, 2026
    const fmtDayLong = (dayKey) => {
      const d = new Date(`${dayKey}T00:00:00`)
      if (Number.isNaN(d.getTime())) return dayKey
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
    }

    // ── styles (chrome colors: --dsw-alias-* tokens only) ─────────────────
    const CSS = `
.ul-page{display:flex;flex-direction:column;align-items:center;box-sizing:border-box;height:100%;overflow:auto;padding:0 clamp(24px,4vw,48px) 48px;color:var(--dsw-alias-label-primary);font:inherit}
.ul-page>*{width:100%;max-width:960px}
.ul-backRow{display:flex;box-sizing:border-box;padding-top:28px;margin-bottom:18px}
.ul-back{display:inline-flex;align-items:center;gap:6px;border:none;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font:inherit;padding:4px 8px;border-radius:6px}
.ul-back:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.ul-panel{display:flex;flex-direction:column;gap:18px;min-width:0}
.ul-banner{box-sizing:border-box;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px}
.ul-sec{display:flex;flex-direction:column;gap:10px}
.ul-secTitle{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ul-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.ul-card{box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);min-width:0}
.ul-cardLabel{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}
.ul-cardValue{font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ul-cardSub{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ul-band{display:flex;flex-wrap:wrap;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ul-bandItem{flex:1 1 118px;min-width:0;box-sizing:border-box;padding:12px 14px}
.ul-bandItem+.ul-bandItem{border-left:1px solid var(--dsw-alias-border-l2)}
.ul-bandValue{font-size:19px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ul-bandLabel{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ul-bandSub{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ul-note{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:8px 0}
.ul-error{color:var(--dsw-alias-label-secondary);font-size:12px;display:flex;gap:8px;align-items:center}
.ul-error button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:2px 10px;cursor:pointer;font:inherit;font-size:12px}
.ul-error button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ul-toolbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.ul-seg{display:inline-flex;gap:2px;padding:3px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-1)}
.ul-segBtn{border:none;background:none;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:3px 10px;border-radius:6px;cursor:pointer}
.ul-segBtn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ul-segActive,.ul-segActive:hover{background:color-mix(in srgb,var(--dsw-tone-1) 14%,transparent);color:var(--dsw-tone-1);font-weight:600}
.ul-chart{width:100%;height:auto;display:block}
.ul-chartWrap{position:relative}
.ul-tip{position:absolute;z-index:5;pointer-events:none;box-sizing:border-box;min-width:132px;max-width:260px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));box-shadow:0 4px 16px rgba(0,0,0,.24);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.ul-tipTitle{font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ul-tipRow{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);white-space:nowrap;margin-top:2px}
.ul-tipDot{width:8px;height:8px;border-radius:50%;flex:0 0 auto}
.ul-tipName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px}
.ul-tipStrong{font-weight:600;color:var(--dsw-alias-label-primary)}
.ul-tipVal{margin-left:auto;padding-left:12px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}
.ul-legend{display:flex;flex-wrap:wrap;gap:8px}
.ul-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:999px;padding:2px 10px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ul-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ul-chipOff{opacity:.45}
.ul-swatch{width:10px;height:10px;border-radius:3px;flex:0 0 auto}
.ul-chartCard{display:flex;flex-direction:column;gap:12px;box-sizing:border-box;padding:14px 16px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}
.ul-cardHead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.ul-heatWrap{}
.ul-heatInner{position:relative;width:100%}
.ul-heat{width:100%;height:auto;display:block}
.ul-heat0{fill:color-mix(in srgb,var(--dsw-tone-1) 14%,transparent)}
.ul-heat1{fill:color-mix(in srgb,var(--dsw-tone-1) 25%,transparent)}
.ul-heat2{fill:color-mix(in srgb,var(--dsw-tone-1) 45%,transparent)}
.ul-heat3{fill:color-mix(in srgb,var(--dsw-tone-1) 65%,transparent)}
.ul-heat4{fill:color-mix(in srgb,var(--dsw-tone-1) 85%,transparent)}
.ul-heatLegend{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ul-heatKey{width:12px;height:12px;border-radius:3px;display:inline-block}
.ul-donutRow{display:flex;flex-wrap:wrap;align-items:center;gap:20px}
.ul-donutWrap{position:relative;flex:0 0 auto}
.ul-donutLegend{display:flex;flex-direction:column;gap:6px;min-width:0}
.ul-donutItem{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ul-donutName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
.ul-donutPct{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ul-table{display:grid;align-items:center;gap:4px 12px;font-size:12px}
.ul-toolHead,.ul-toolRow{grid-template-columns:minmax(120px,1fr) minmax(140px,2fr) 80px 90px}
.ul-toolHead{color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:6px}
.ul-toolRow{padding:5px 0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 50%,transparent);color:var(--dsw-alias-label-secondary)}
.ul-cellName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.ul-cellNum{font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:8px;justify-content:flex-end}
.ul-barWrap{flex:1;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ul-bar{display:block;height:100%;border-radius:3px;background:color-mix(in srgb,var(--dsw-tone-1) 70%,transparent)}
.ul-sessHead,.ul-sessRow{grid-template-columns:minmax(140px,2fr) 70px minmax(130px,1.2fr) 70px 80px}
.ul-sessHead{color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:6px}
.ul-sessRow{padding:5px 0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 50%,transparent);color:var(--dsw-alias-label-secondary)}
.ul-cellDim{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ul-cellNum2{font-variant-numeric:tabular-nums;text-align:right}
.ul-session{display:flex;flex-direction:column;gap:18px;color:var(--dsw-alias-label-primary);font:inherit;padding:8px 0}
.ul-recHead,.ul-recRow{grid-template-columns:90px minmax(100px,1.4fr) 70px 70px 70px 70px}
.ul-recHead{color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:6px}
.ul-recRow{padding:4px 0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 50%,transparent);color:var(--dsw-alias-label-secondary)}
.ul-cellBad{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}
.ul-toolMini{display:flex;flex-wrap:wrap;gap:8px}
`

    // ── shared bits ────────────────────────────────────────────────────────
    function LoadState({ state }) {
      if (state.loading) return h('div', { className: 'ul-note' }, t('loading'))
      if (state.error) {
        return h('div', { className: 'ul-error' },
          h('span', null, `${t('loadError')}: ${state.error.message}`),
          h('button', { type: 'button', onClick: () => state.retry() }, t('retry')))
      }
      return null
    }

    function Card({ label, value, sub }) {
      return h('div', { className: 'ul-card' },
        h('div', { className: 'ul-cardLabel' }, label),
        h('div', { className: 'ul-cardValue' }, value),
        sub ? h('div', { className: 'ul-cardSub' }, sub) : null)
    }

    // One strip item of the overview band: big value on top, small label
    // below, optional sub line last. Vertical 1px dividers come from CSS
    // (.ul-bandItem + .ul-bandItem), so the first item has none.
    function BandItem({ label, value, sub }) {
      return h('div', { className: 'ul-bandItem' },
        h('div', { className: 'ul-bandValue' }, value),
        h('div', { className: 'ul-bandLabel' }, label),
        sub ? h('div', { className: 'ul-bandSub' }, sub) : null)
    }

    // ── shared chart tooltip (styled card; replaces native <title>) ───────
    // Absolutely positioned inside a position:relative chart wrapper;
    // pointerEvents none so it never steals hover. Caller supplies
    // left/top/transform (flip logic lives at each chart).
    function ChartTip({ style, children }) {
      return h('div', { className: 'ul-tip', style }, children)
    }

    function TipRow({ color, children }) {
      return h('div', { className: 'ul-tipRow' },
        color ? h('span', { className: 'ul-tipDot', style: { background: color } }) : null,
        children)
    }

    // ── lifetime summary cards (/summary) ──────────────────────────────────
    function SummaryCards({ tick }) {
      const state = useApi('summary', {}, [tick])
      if (state.loading || state.error) return h(LoadState, { state })
      const s = state.data
      if (!s) return h('div', { className: 'ul-note' }, t('empty'))
      return h('section', { className: 'ul-sec' },
        h('div', { className: 'ul-secTitle' }, t('sumTitle')),
        h('div', { className: 'ul-band' },
          h(BandItem, { label: t('totalTokens'), value: fmtTok(s.tokens), sub: `${t('inputTok')} ${fmtTok(s.inputTokens)} · ${t('outputTok')} ${fmtTok(s.outputTokens)}` }),
          h(BandItem, { label: t('requests'), value: fmtInt(s.requests), sub: `${t('failures')} ${fmtInt(s.failures)} · ${t('errorRate')} ${fmtPct(s.errorRate)}` }),
          h(BandItem, { label: t('cacheHit'), value: fmtPct(s.cacheHitRate), sub: `${t('cacheReadTok')} ${fmtTok(s.cacheReadTokens)} · ${t('cacheWriteTok')} ${fmtTok(s.cacheWriteTokens)}` }),
          h(BandItem, { label: t('avgTtft'), value: fmtMs(s.avgFirstTokenMs) }),
          h(BandItem, { label: t('decodeSpeed'), value: fmtSpeed(s.tokensPerSecond) }),
          h(BandItem, { label: t('streak'), value: `${fmtInt(s.streakDays)} ${t('streakUnit')}`, sub: `${t('activeDays')} ${fmtInt(s.activeDays)}` }),
          s.peakDay ? h(BandItem, { label: t('peakDay'), value: fmtTok(s.peakDay.tokens), sub: s.peakDay.day }) : null))
    }

    // ── chart series palette (artwork exception: literals allowed) ────────
    const PALETTE = ['#4c8dff', '#22c1a3', '#f2a93b', '#e5646e', '#9a6df3', '#5cb8e6', '#8a8f98']

    // ── Fritsch–Carlson monotone cubic interpolation (PCHIP) ───────────────
    // Given strictly increasing xs, compute limited tangents m_i so the
    // piecewise cubic Hermite curve is monotone on every segment the data is
    // monotone on (never overshoots). Rules: secant slopes d_i; interior
    // tangents average adjacent secants but become 0 on sign change / zero;
    // then the (a²+b²>9) limiter scales tangent pairs back into the monotone
    // region. This is the fix for the known Catmull-Rom overshoot bug.
    // A verbatim copy of fcTangents/fcCurvePath lives in
    // src/client/fc.check.mjs with node monotonicity assertions.
    function fcTangents(xs, ys) {
      const n = xs.length
      const d = []
      for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]))
      const m = new Array(n).fill(0)
      m[0] = d[0]
      m[n - 1] = d[n - 2]
      for (let i = 1; i < n - 1; i++) {
        m[i] = (d[i - 1] === 0 || d[i] === 0 || Math.sign(d[i - 1]) !== Math.sign(d[i]))
          ? 0
          : (d[i - 1] + d[i]) / 2
      }
      for (let i = 0; i < n - 1; i++) {
        if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
        const a = m[i] / d[i]
        const b = m[i + 1] / d[i]
        const s = a * a + b * b
        if (s > 9) {
          const tau = 3 / Math.sqrt(s)
          m[i] = tau * a * d[i]
          m[i + 1] = tau * b * d[i]
        }
      }
      return m
    }

    const rnd = (v) => Math.round(v * 100) / 100

    /** points: [{x,y}] with strictly increasing x → SVG path string (M + C segments). */
    function fcCurvePath(points) {
      const n = points.length
      if (n === 0) return ''
      if (n === 1) return `M${rnd(points[0].x)},${rnd(points[0].y)}`
      const xs = points.map((p) => p.x)
      const ys = points.map((p) => p.y)
      if (n === 2) return `M${rnd(xs[0])},${rnd(ys[0])}L${rnd(xs[1])},${rnd(ys[1])}`
      const m = fcTangents(xs, ys)
      let d = `M${rnd(xs[0])},${rnd(ys[0])}`
      for (let i = 0; i < n - 1; i++) {
        const dx = xs[i + 1] - xs[i]
        d += `C${rnd(xs[i] + dx / 3)},${rnd(ys[i] + (m[i] * dx) / 3)} ${rnd(xs[i + 1] - dx / 3)},${rnd(ys[i + 1] - (m[i + 1] * dx) / 3)} ${rnd(xs[i + 1])},${rnd(ys[i + 1])}`
      }
      return d
    }

    // ── daily multi-model line chart (/daily?group=model) ─────────────────
    const dayKeyOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
    const RANGES = [
      { id: 'today', label: 'rToday', days: 1, granularity: 'hour' },
      { id: '7', label: 'r7', days: 7, granularity: 'day' },
      { id: '30', label: 'r30', days: 30, granularity: 'day' },
      { id: '90', label: 'r90', days: 90, granularity: 'day' },
    ]

    function LineChart({ keys, granularity, degraded, series, animKey }) {
      const W = 720; const H = 240; const padL = 46; const padR = 24; const padT = 12; const padB = 22
      const n = keys.length
      const [hover, setHover] = React.useState(null) // hovered bucket index
      // Entrance "draw" animation. Trigger key = the fetched data reference
      // (animKey), so hovers and legend toggles (same data, new series
      // array identity) never replay it; a range switch / refetch arrives
      // as a new reference and replays. Each visible path measures itself
      // with getTotalLength() — no fabricated lengths; degenerate paths
      // (unmeasurable / zero length) are skipped. Reduced-motion → final
      // state immediately. transitionend listeners are removed on cleanup.
      const pathsRef = React.useRef({})
      React.useLayoutEffect(() => { // layout effect: no final-state flash before the sweep starts
        if (typeof window === 'undefined' || !window.matchMedia) return undefined
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
        const cleanups = []
        for (const key of Object.keys(pathsRef.current)) {
          const el = pathsRef.current[key]
          if (!el) continue
          let len = 0
          try { len = el.getTotalLength() } catch { continue }
          if (!Number.isFinite(len) || len <= 0) continue
          el.style.transition = 'none'
          el.style.strokeDasharray = `${len} ${len}`
          el.style.strokeDashoffset = `${len}`
          el.getBoundingClientRect() // flush so the transition starts at len
          el.style.transition = 'stroke-dashoffset 720ms ease-out'
          el.style.strokeDashoffset = '0'
          const done = () => { el.style.transition = ''; el.style.strokeDasharray = ''; el.style.strokeDashoffset = '' }
          el.addEventListener('transitionend', done, { once: true })
          cleanups.push(() => el.removeEventListener('transitionend', done))
        }
        return () => { for (const c of cleanups) c() }
      }, [animKey])
      let max = 0
      for (const s of series) for (const v of s.values) if (v > max) max = v
      if (max <= 0) max = 1
      const x = (i) => (n === 1 ? padL + (W - padL - padR) / 2 : padL + (i * (W - padL - padR)) / (n - 1))
      const y = (v) => padT + (H - padT - padB) * (1 - v / max)
      // KV-degraded responses return day buckets even for the hourly range.
      const isHour = granularity === 'hour' && !degraded
      const labelOf = (key) => (isHour ? `${key.slice(-2)}:00` : key.slice(5) || key)
      const tickEvery = Math.max(1, Math.ceil(n / 8))
      // Tick de-collision: stride ticks as before, but the trailing label
      // replaces the previous stride tick when they would sit closer than
      // ~44px (was: unconditional append → overlapping "11-1211-1").
      const tickIdx = []
      for (let i = 0; i < n; i += tickEvery) tickIdx.push(i)
      const lastTick = tickIdx[tickIdx.length - 1]
      if (n > 0 && lastTick !== n - 1) {
        if (x(n - 1) - x(lastTick) < 44) tickIdx[tickIdx.length - 1] = n - 1
        else tickIdx.push(n - 1)
      }
      const grid = [0, 0.5, 1]
      // offsetX → nearest bucket index (svg scales to 100% width, so map
      // through the viewBox: client px → viewBox units).
      const onMove = (e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        if (!rect || rect.width <= 0) return
        const px = ((e.clientX - rect.left) * W) / rect.width
        let i = n === 1 ? 0 : Math.round(((px - padL) * (n - 1)) / (W - padL - padR))
        if (i < 0) i = 0
        if (i > n - 1) i = n - 1
        setHover((prev) => (prev === i ? prev : i))
      }
      const hi = hover !== null && hover < n ? hover : null
      const tipFrac = hi !== null ? x(hi) / W : 0
      return h('div', { className: 'ul-chartWrap' },
        h('svg', {
          className: 'ul-chart', viewBox: `0 0 ${W} ${H}`, role: 'img',
          onMouseMove: onMove, onMouseLeave: () => setHover(null),
        },
          grid.map((g) => h('g', { key: g },
            h('line', { x1: padL, x2: W - padR, y1: y(max * g), y2: y(max * g), stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1, vectorEffect: 'non-scaling-stroke' }),
            h('text', { x: padL - 6, y: y(max * g) + 3, textAnchor: 'end', fontSize: 10, fill: 'var(--dsw-alias-label-tertiary)' }, fmtTok(max * g)))),
          hi !== null
            ? h('line', {
              x1: x(hi), x2: x(hi), y1: padT, y2: H - padB,
              stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1,
              strokeDasharray: '4 3', vectorEffect: 'non-scaling-stroke',
            })
            : null,
          series.map((s) => {
            const pts = s.values.map((v, i) => ({ x: x(i), y: y(v) }))
            return h('g', { key: s.key },
              h('path', {
                d: fcCurvePath(pts), fill: 'none', stroke: s.color, strokeWidth: 2, vectorEffect: 'non-scaling-stroke', strokeLinejoin: 'round', strokeLinecap: 'round',
                ref: (el) => { if (el) pathsRef.current[s.key] = el; else delete pathsRef.current[s.key] },
              }))
          }),
          tickIdx.map((i) => {
            // End labels anchor inward so they never overflow the viewBox
            // (was: middle-anchored last label clipped at the right edge).
            const atEnd = i === n - 1
            const anchor = i === 0 ? 'start' : atEnd ? 'end' : 'middle'
            const lx = i === 0 ? padL : atEnd ? W - padR : x(i)
            return h('text', {
              key: keys[i], x: lx, y: H - 6, textAnchor: anchor, fontSize: 10, fill: 'var(--dsw-alias-label-tertiary)',
            }, labelOf(keys[i]))
          })),
        hi !== null
          ? h(ChartTip, {
            style: {
              left: `${tipFrac * 100}%`, top: 4,
              transform: tipFrac > 0.6 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
            },
          },
            h('div', { className: 'ul-tipTitle' },
              `${labelOf(keys[hi])} - ${fmtTok(series.reduce((a, s) => a + (s.values[hi] || 0), 0))} tokens`),
            series.map((s) => h(TipRow, { key: s.key, color: s.color },
              h('span', { className: 'ul-tipName' }, s.key),
              h('span', { className: 'ul-tipVal' }, `${fmtTok(s.values[hi])} tokens`))))
          : null)
    }

    function DailySection({ tick }) {
      const [rangeId, setRangeId] = React.useState('30')
      const [hidden, setHidden] = React.useState({})
      const range = RANGES.find((r) => r.id === rangeId) || RANGES[2]
      const to = dayKeyOf(new Date())
      const fromDate = new Date(); fromDate.setDate(fromDate.getDate() - (range.days - 1))
      const body = { from: dayKeyOf(fromDate), to, group: 'model', granularity: range.granularity }
      const state = useApi('daily', body, [rangeId, tick])
      const data = state.data
      const keys = data ? data.buckets.map((b) => b.key) : []
      const totals = data ? data.groupTotals : []
      const top = totals.slice(0, 6)
      const rest = totals.slice(6)
      const restTokens = rest.reduce((a, g) => a + g.tokens, 0)
      // top-6 series + a grey "other" rollup so line totals match the cards.
      const legendItems = top.map((g, gi) => ({ key: g.key, color: PALETTE[gi % PALETTE.length] }))
      if (restTokens > 0) legendItems.push({ key: t('other'), color: PALETTE[6] })
      const valOf = (b, k) => (b.groups && typeof b.groups[k] === 'number' ? b.groups[k] : 0) // defensive zero-fill
      const series = data
        ? legendItems
          .map((it, li) => ({
            key: it.key,
            color: it.color,
            values: li === legendItems.length - 1 && restTokens > 0
              ? data.buckets.map((b) => rest.reduce((a, g) => a + valOf(b, g.key), 0))
              : data.buckets.map((b) => valOf(b, it.key)),
          }))
          .filter((s) => !hidden[s.key])
        : []
      return h('section', { className: 'ul-chartCard' },
        h('div', { className: 'ul-cardHead' },
          h('div', { className: 'ul-secTitle' }, t('dailyTitle')),
          h('div', { className: 'ul-seg' },
            RANGES.map((r) => h('button', {
              key: r.id, type: 'button',
              className: r.id === rangeId ? 'ul-segBtn ul-segActive' : 'ul-segBtn',
              onClick: () => setRangeId(r.id),
            }, t(r.label))))),
        state.loading || state.error
          ? h(LoadState, { state })
          : !data || totals.length === 0
            ? h('div', { className: 'ul-note' }, t('empty'))
            : h(React.Fragment, null,
              h(LineChart, { keys, granularity: range.granularity, degraded: !!data.degraded, series, animKey: data }),
              h('div', { className: 'ul-legend' },
                legendItems.map((it) => h('button', {
                  key: it.key, type: 'button',
                  className: hidden[it.key] ? 'ul-chip ul-chipOff' : 'ul-chip',
                  onClick: () => setHidden((prev) => ({ ...prev, [it.key]: !prev[it.key] })),
                },
                  h('span', { className: 'ul-swatch', style: { background: it.color } }),
                  it.key)))))
    }

    // ── 52-week heatmap (/heatmap) ─────────────────────────────────────────
    // GitHub-style FULL-RECTANGLE grid: rows = weekday (Monday on top, labeled
    // in a left gutter), columns = weeks; every cell of the rectangle renders
    // — out-of-range and future days as level-0 — so the grid is always a
    // clean slab with no ragged holes. Geometry is measured: a ResizeObserver
    // sizes square cells to the container width (no fixed natural width).
    // Mode segment: day tokens / week sums / running total. The geometry core
    // (heatGeometry/heatRowOf/heatMonthLabels) is mirrored verbatim in
    // src/client/heatgeo.check.mjs with node assertions.
    const HEAT_MODES = [
      { id: 'day', label: 'hmDay' },
      { id: 'week', label: 'hmWeek' },
      { id: 'cum', label: 'hmCum' },
    ]
    const HEAT_GUTTER = 26
    const HEAT_GAP = 3
    const HEAT_LABEL_H = 16
    const HEAT_DAY_MS = 86400000
    /** Monday-top rows: Mon=0 … Sun=6. */
    const heatRowOf = (ms) => (new Date(ms).getDay() + 6) % 7
    const heatDayMs = (k) => new Date(`${k}T00:00:00`).getTime()
    /** Grid geometry for [firstDay, today] padded to whole weeks. */
    function heatGeometry(firstDay, todayDay, availW) {
      const firstMs = heatDayMs(firstDay)
      const todayMs = heatDayMs(todayDay)
      const weekStartMs = firstMs - heatRowOf(firstMs) * HEAT_DAY_MS // Monday of column 0
      const weekEndMs = todayMs + (6 - heatRowOf(todayMs)) * HEAT_DAY_MS // Sunday of the current week
      const totalDays = Math.round((weekEndMs - weekStartMs) / HEAT_DAY_MS) + 1
      const cols = Math.ceil(totalDays / 7)
      // Fractional step: the grid fills the measured width EXACTLY (integer
      // stepping used to leave up to a column of slack on the right).
      const step = Math.max(6, availW / cols)
      const cell = Math.max(4, step - HEAT_GAP)
      const width = HEAT_GUTTER + cols * step
      const height = 7 * step + HEAT_LABEL_H
      return { weekStartMs, weekEndMs, cols, step, cell, width, height }
    }
    /** Month labels at each column whose Monday enters a new month; dropped
     *  when closer than 30px to the previous label or past the right edge. */
    function heatMonthLabels(geo) {
      const labels = []
      let prevMonth = -1; let lastX = -Infinity
      for (let col = 0; col < geo.cols; col++) {
        const dt = new Date(geo.weekStartMs + col * 7 * HEAT_DAY_MS)
        const m = dt.getMonth()
        if (m === prevMonth) continue
        prevMonth = m
        const x = HEAT_GUTTER + col * geo.step
        if ((col !== 0 && x - lastX < 30) || x > geo.width - 24) continue
        lastX = x
        labels.push({ x, text: dt.toLocaleDateString(undefined, { month: 'short' }) })
      }
      return labels
    }
    function HeatmapSection({ tick }) {
      const state = useApi('heatmap', { weeks: 52 }, [tick])
      const [hover, setHover] = React.useState(null) // hovered data cell
      const [mode, setMode] = React.useState('day')
      // Callback ref (not useEffect+useRef): the wrap only exists AFTER the
      // data arrives — a mount-time effect would see null and never observe,
      // pinning wrapW at 0 and the grid at minimum step.
      const roRef = React.useRef(null)
      const [wrapW, setWrapW] = React.useState(0)
      const wrapRef = React.useCallback((el) => {
        if (roRef.current) { roRef.current.disconnect(); roRef.current = null }
        if (el && typeof ResizeObserver === 'function') {
          const seed = el.getBoundingClientRect().width
          if (seed > 0) setWrapW(Math.floor(seed))
          const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect?.width
            if (typeof w === 'number' && w > 0) setWrapW(Math.floor(w))
          })
          ro.observe(el)
          roRef.current = ro
        }
      }, [])
      React.useEffect(() => () => { if (roRef.current) roRef.current.disconnect() }, [])
      if (state.loading || state.error) return h(LoadState, { state })
      const data = state.data
      if (!data || !data.days || data.days.length === 0) return h('div', { className: 'ul-note' }, t('empty'))
      const today = dayKeyOf(new Date())
      if (Number.isNaN(heatDayMs(data.days[0].day))) return h('div', { className: 'ul-note' }, t('empty'))
      const geo = heatGeometry(data.days[0].day, today, wrapW === 0 ? 0 : wrapW - HEAT_GUTTER)
      // Full rectangle: one cell per (col,row) in [weekStart, weekEnd]; days
      // outside the API window or in the future carry d:null (level-0, no tip).
      const byDay = new Map(data.days.map((d) => [d.day, d]))
      const cells = []
      for (let col = 0; col < geo.cols; col++) {
        for (let row = 0; row < 7; row++) {
          const ms = geo.weekStartMs + (col * 7 + row) * HEAT_DAY_MS
          const day = dayKeyOf(new Date(ms))
          cells.push({ day, col, row, ms, d: byDay.get(day) ?? null })
        }
      }
      // Mode values from REAL data days only: week sums per column, running total.
      const weekSum = []
      const cumByDay = new Map()
      let run = 0
      for (const d of data.days) {
        const ms = heatDayMs(d.day)
        if (Number.isNaN(ms) || ms < geo.weekStartMs || ms > geo.weekEndMs) continue
        const col = Math.floor((ms - geo.weekStartMs) / HEAT_DAY_MS / 7)
        weekSum[col] = (weekSum[col] || 0) + d.tokens
        run += d.tokens
        cumByDay.set(d.day, run)
      }
      const valueOf = (c) => (c.d === null ? 0 : mode === 'week' ? (weekSum[c.col] ?? 0) : mode === 'cum' ? (cumByDay.get(c.day) ?? 0) : c.d.tokens)
      let max = 0
      for (const c of cells) { const v = valueOf(c); if (v > max) max = v }
      if (max <= 0) max = 1
      const level = (v) => {
        if (v <= 0) return 0
        const r = v / max
        return r < 0.25 ? 1 : r < 0.5 ? 2 : r < 0.75 ? 3 : 4
      }
      const monthLabels = heatMonthLabels(geo)
      const weekdayLabels = []
      for (let row = 0; row < 7; row++) {
        weekdayLabels.push(new Date(geo.weekStartMs + row * HEAT_DAY_MS).toLocaleDateString(undefined, { weekday: 'short' }))
      }
      const gridH = 7 * geo.step
      let tipStyle = null
      if (hover) {
        const fx = ((HEAT_GUTTER + hover.col * geo.step + geo.cell / 2) / geo.width) * 100
        const fy = ((hover.row * geo.step) / geo.height) * 100
        // flip: right edge → card grows left; top rows → card drops below cell
        const tx = fx > 82 ? 'translateX(calc(-100% + 10px))' : fx < 10 ? 'translateX(-10px)' : 'translateX(-50%)'
        const ty = hover.row >= 2 ? 'translateY(calc(-100% - 8px))' : `translateY(${geo.cell + 8}px)`
        tipStyle = { left: `${fx}%`, top: `${fy}%`, transform: `${tx} ${ty}` }
      }
      return h('section', { className: 'ul-chartCard' },
        h('div', { className: 'ul-cardHead' },
          h('div', { className: 'ul-secTitle' }, t('heatTitle')),
          h('div', { className: 'ul-seg' },
            HEAT_MODES.map((m) => h('button', {
              key: m.id, type: 'button',
              className: m.id === mode ? 'ul-segBtn ul-segActive' : 'ul-segBtn',
              onClick: () => setMode(m.id),
            }, t(m.label))))),
        h('div', { className: 'ul-heatWrap', ref: wrapRef },
          h('div', { className: 'ul-heatInner', style: { width: `${geo.width}px` } },
            h('svg', { width: geo.width, height: geo.height, viewBox: `0 0 ${geo.width} ${geo.height}`, role: 'img', style: { display: 'block' } },
              weekdayLabels.map((w, row) => h('text', {
                key: `w${row}`, x: 0, y: row * geo.step + geo.cell / 2,
                fontSize: 9, fill: 'var(--dsw-alias-label-tertiary)', dominantBaseline: 'central',
              }, w)),
              cells.map((c) => h('rect', {
                key: c.day,
                x: HEAT_GUTTER + c.col * geo.step, y: c.row * geo.step,
                width: geo.cell, height: geo.cell, rx: 3,
                class: `ul-heat${level(valueOf(c))}`,
                ...(c.d !== null ? {
                  onMouseEnter: () => setHover(c),
                  onMouseLeave: () => setHover(null),
                } : {}),
              })),
              monthLabels.map((ml) => h('text', {
                key: `m${ml.x}`, x: ml.x, y: gridH + 12,
                fontSize: 10, fill: 'var(--dsw-alias-label-tertiary)',
              }, ml.text))),
            hover
              ? h(ChartTip, { style: tipStyle },
                h('div', { className: 'ul-tipTitle' }, fmtDayLong(hover.day)),
                h('div', { className: 'ul-tipRow' }, `${fmtTok(hover.d.tokens)} tokens · ${fmtInt(hover.d.requests)} ${t('reqWord')}`))
              : null)),
        h('div', { className: 'ul-heatLegend' },
          h('span', null, t('less')),
          [0, 1, 2, 3, 4].map((lv) => h('span', { key: lv, className: `ul-heatKey ul-heat${lv}` })),
          h('span', null, t('more'))))
    }

    // ── model donut (/daily?group=model groupTotals, 30d window) ──────────
    const DONUT_R = 48
    const DONUT_C = 2 * Math.PI * DONUT_R
    function DonutSection({ tick }) {
      const to = dayKeyOf(new Date())
      const fromDate = new Date(); fromDate.setDate(fromDate.getDate() - 29)
      const state = useApi('daily', { from: dayKeyOf(fromDate), to, group: 'model', granularity: 'day' }, [tick])
      const [hover, setHover] = React.useState(null) // { i, x, y } in wrap px
      const wrapRef = React.useRef(null)
      const arcsRef = React.useRef({})
      // Entrance sweep. Trigger key = the fetched data reference (state.data):
      // hovers re-render with the same reference and never replay; a refetch
      // arrives as a new reference and replays. Each arc's dasharray grows
      // from 0 to its rendered final value (read off the element's own
      // attribute — no fabricated lengths) in one shared 720ms ease-out
      // window with a 60ms stagger. Degenerate slices (final dash ≤ 0) are
      // skipped. Reduced-motion → final state immediately; transitionend
      // listeners are removed on cleanup.
      React.useLayoutEffect(() => { // layout effect: no final-state flash before the sweep starts
        if (!state.data) return undefined
        if (typeof window === 'undefined' || !window.matchMedia) return undefined
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined
        const cleanups = []
        let stagger = 0
        for (const key of Object.keys(arcsRef.current)) {
          const el = arcsRef.current[key]
          if (!el) continue
          const target = el.getAttribute('stroke-dasharray') // rendered final "dash gap"
          if (!target) continue
          const dash = parseFloat(target)
          if (!Number.isFinite(dash) || dash <= 0) continue
          el.style.transition = 'none'
          el.style.strokeDasharray = `0 ${DONUT_C}`
          el.getBoundingClientRect() // flush so the transition starts at 0
          el.style.transition = `stroke-dasharray 720ms ease-out ${stagger * 60}ms`
          stagger += 1
          el.style.strokeDasharray = target
          const done = () => { el.style.transition = ''; el.style.strokeDasharray = '' }
          el.addEventListener('transitionend', done, { once: true })
          cleanups.push(() => el.removeEventListener('transitionend', done))
        }
        return () => { for (const c of cleanups) c() }
      }, [state.data])
      if (state.loading || state.error) return h(LoadState, { state })
      const data = state.data
      const totals = data ? data.groupTotals : []
      if (!data || totals.length === 0) return h('div', { className: 'ul-note' }, t('empty'))
      const top = totals.slice(0, 5)
      const rest = totals.slice(5)
      const restTokens = rest.reduce((a, g) => a + g.tokens, 0)
      const slices = top.map((g, i) => ({ key: g.key, tokens: g.tokens, color: PALETTE[i % PALETTE.length] }))
      if (restTokens > 0) slices.push({ key: t('other'), tokens: restTokens, color: PALETTE[6] })
      const sum = slices.reduce((a, s) => a + s.tokens, 0) || 1
      const R = DONUT_R; const C = DONUT_C
      let acc = 0
      const posOf = (e, i) => {
        const el = wrapRef.current
        if (!el) return { i, x: 0, y: 0 }
        const r = el.getBoundingClientRect()
        return { i, x: e.clientX - r.left, y: e.clientY - r.top }
      }
      const hs = hover && slices[hover.i] ? slices[hover.i] : null
      return h('section', { className: 'ul-chartCard' },
        h('div', { className: 'ul-secTitle' }, `${t('donutTitle')}${t('donutWindow')}`),
        h('div', { className: 'ul-donutRow' },
          h('div', { className: 'ul-donutWrap', ref: wrapRef },
            h('svg', {
              width: 132, height: 132, viewBox: '0 0 132 132', role: 'img',
              onMouseLeave: () => setHover(null),
            },
              h('circle', { cx: 66, cy: 66, r: R, fill: 'none', stroke: 'var(--dsw-alias-bg-layer-1)', strokeWidth: 18 }),
              slices.map((s, si) => {
                const frac = s.tokens / sum
                const off = acc
                acc += frac
                return h('circle', {
                  key: s.key, cx: 66, cy: 66, r: R, fill: 'none',
                  stroke: s.color, strokeWidth: hs && hover.i === si ? 21 : 18,
                  strokeDasharray: `${Math.max(0, frac * C - 1.5)} ${C - Math.max(0, frac * C - 1.5)}`,
                  strokeDashoffset: -off * C + C / 4,
                  ref: (el) => { if (el) arcsRef.current[s.key] = el; else delete arcsRef.current[s.key] },
                  onMouseEnter: (e) => setHover(posOf(e, si)),
                  onMouseMove: (e) => setHover(posOf(e, si)),
                })
              })),
            hs
              ? h(ChartTip, {
                style: {
                  left: hover.x, top: hover.y,
                  transform: hover.x > 66 ? 'translate(calc(-100% - 10px), -50%)' : 'translate(12px, -50%)',
                },
              },
                h(TipRow, { color: hs.color },
                  h('span', { className: 'ul-tipName ul-tipStrong' }, hs.key)),
                h('div', { className: 'ul-tipRow' },
                  `${fmtTok(hs.tokens)} tokens · ${((hs.tokens / sum) * 100).toFixed(1)}%`))
              : null),
          h('div', { className: 'ul-donutLegend' },
            slices.map((s) => h('div', { key: s.key, className: 'ul-donutItem' },
              h('span', { className: 'ul-swatch', style: { background: s.color } }),
              h('span', { className: 'ul-donutName' }, s.key),
              h('span', { className: 'ul-donutPct' }, `${((s.tokens / sum) * 100).toFixed(1)}%`))))))
    }

    // ── tool distribution (/tools) ─────────────────────────────────────────
    function ToolsSection({ tick }) {
      const state = useApi('tools', {}, [tick])
      if (state.loading || state.error) return h(LoadState, { state })
      const data = state.data
      const tools = data ? data.tools.slice(0, 12) : []
      if (!data || tools.length === 0) return h('div', { className: 'ul-note' }, t('empty'))
      return h('section', { className: 'ul-chartCard' },
        h('div', { className: 'ul-secTitle' }, t('toolsTitle')),
        h('div', { className: 'ul-table ul-toolHead' },
          h('span', null, t('tName')), h('span', null, t('tCalls')),
          h('span', null, t('tFail')), h('span', null, t('tAvg'))),
        tools.map((tool) => {
          const failRate = tool.calls > 0 ? (tool.failures / tool.calls) * 100 : 0
          return h('div', { key: tool.name, className: 'ul-table ul-toolRow' },
            h('span', { className: 'ul-cellName', title: tool.name }, tool.name),
            h('span', { className: 'ul-cellNum' },
              h('span', { className: 'ul-barWrap' },
                h('span', { className: 'ul-bar', style: { width: `${Math.min(100, tool.percent)}%` } })),
              fmtInt(tool.calls)),
            h('span', { className: 'ul-cellNum' }, fmtPct(failRate)),
            h('span', { className: 'ul-cellNum' }, fmtMs(tool.avgDurationMs)))
        }))
    }

    // ── sessions table (/sessions, read-only) ──────────────────────────────
    const KIND_LABEL = { main: 'kindMain', subagent: 'kindSub', workflow: 'kindWorkflow' }
    function SessionsSection({ tick }) {
      const state = useApi('sessions', { limit: 30 }, [tick])
      if (state.loading || state.error) return h(LoadState, { state })
      const data = state.data
      const rows = data ? data.rows : []
      if (!data || rows.length === 0) return h('div', { className: 'ul-note' }, t('empty'))
      return h('section', { className: 'ul-chartCard' },
        h('div', { className: 'ul-secTitle' }, t('sessTitle')),
        h('div', { className: 'ul-table ul-sessHead' },
          h('span', null, t('sName')), h('span', null, t('sKind')),
          h('span', null, t('sDays')), h('span', null, t('sReq')), h('span', null, t('sTok'))),
        rows.map((row) => h('div', { key: row.id, className: 'ul-table ul-sessRow' },
          h('span', { className: 'ul-cellName', title: row.id }, row.name || row.id),
          h('span', null, t(KIND_LABEL[row.kind] || 'kindMain')),
          h('span', { className: 'ul-cellDim' }, row.firstDay === row.lastDay ? row.firstDay : `${row.firstDay} ~ ${row.lastDay}`),
          h('span', { className: 'ul-cellNum2' }, fmtInt(row.requests)),
          h('span', { className: 'ul-cellNum2' }, fmtTok(row.tokens)))),
        typeof data.total === 'number'
          ? h('div', { className: 'ul-note' }, t('sessTotal').replace('{n}', fmtInt(data.total)))
          : null)
    }

    // ── placeholders, filled in one component at a time ────────────────────
    // ── per-session usage view (/session {id}) — conversation.view slot ────
    const STATUS_LABEL = { running: 'stRunning', completed: 'stCompleted', failed: 'stFailed', interrupted: 'stInterrupted' }
    function SessionUsageView({ sessionId }) {
      const state = useApi('session', { id: sessionId }, [sessionId])
      if (state.loading || state.error) {
        return h('div', { className: 'ul-session' }, h('style', null, CSS), h(LoadState, { state }))
      }
      const d = state.data
      if (!d) return h('div', { className: 'ul-session' }, h('style', null, CSS), h('div', { className: 'ul-note' }, t('empty')))
      const records = d.degraded ? [] : d.records.slice(0, 50)
      const tools = d.degraded ? [] : d.tools
      return h('div', { className: 'ul-session' },
        h('style', null, CSS),
        h('section', { className: 'ul-sec' },
          h('div', { className: 'ul-secTitle' }, t('svTotals')),
          h('div', { className: 'ul-cards' },
            h(Card, { label: t('totalTokens'), value: fmtTok(d.totals.tokens), sub: `${t('inputTok')} ${fmtTok(d.totals.inputTokens)} · ${t('outputTok')} ${fmtTok(d.totals.outputTokens)}` }),
            h(Card, { label: t('requests'), value: fmtInt(d.requests), sub: `${t('failures')} ${fmtInt(d.failures)}` }),
            h(Card, { label: t('avgTtft'), value: fmtMs(d.avgFirstTokenMs) }),
            h(Card, { label: t('decodeSpeed'), value: fmtSpeed(d.tokensPerSecond) }))),
        d.degraded
          ? h('div', { className: 'ul-banner' }, t('svDegraded'))
          : h(React.Fragment, null,
              h('section', { className: 'ul-sec' },
                h('div', { className: 'ul-secTitle' }, t('svRecords')),
                records.length === 0
                  ? h('div', { className: 'ul-note' }, t('empty'))
                  : h(React.Fragment, null,
                      h('div', { className: 'ul-table ul-recHead' },
                        h('span', null, t('cTime')), h('span', null, t('cModel')), h('span', null, t('cStatus')),
                        h('span', null, t('cTok')), h('span', null, t('cTtft')), h('span', null, t('cSpeed'))),
                      records.map((r) => {
                        const speed = r.decodeMs > 0 ? r.outputTokens / (r.decodeMs / 1000) : null
                        return h('div', { key: r.id, className: 'ul-table ul-recRow' },
                          h('span', { className: 'ul-cellDim' }, fmtTime(r.time)),
                          h('span', { className: 'ul-cellName', title: r.model }, r.model || t('na')),
                          h('span', { className: r.status === 'failed' ? 'ul-cellBad' : null }, t(STATUS_LABEL[r.status] || 'stCompleted')),
                          h('span', { className: 'ul-cellNum2' }, fmtTok(r.computedTotal)),
                          h('span', { className: 'ul-cellNum2' }, fmtMs(r.firstTokenMs)),
                          h('span', { className: 'ul-cellNum2' }, speed === null ? t('na') : `${speed.toFixed(1)}`))
                      }),
                      d.records.length > records.length
                        ? h('div', { className: 'ul-note' }, t('recTrunc').replace('{n}', fmtInt(d.records.length)))
                        : null)),
              tools.length === 0 ? null : h('section', { className: 'ul-sec' },
                h('div', { className: 'ul-secTitle' }, t('svTools')),
                h('div', { className: 'ul-toolMini' },
                  tools.map((tool) => h('span', { key: tool.name, className: 'ul-chip' },
                    `${tool.name} · ${fmtInt(tool.calls)}${tool.failures > 0 ? ` (${fmtInt(tool.failures)}✗)` : ''}`))))))
    }

    // ── panel assembly ─────────────────────────────────────────────────────
    function StatusBanner({ status }) {
      if (!status) return null
      const parts = []
      if (status.degraded) parts.push(status.backendError ? `${t('degraded')} (${status.backendError})` : t('degraded'))
      if (status.backfill && status.backfill.running) {
        parts.push(`${t('backfill')} ${status.backfill.done}/${status.backfill.total}…`)
      }
      if (status.recordFailures > 0) parts.push(`${fmtInt(status.recordFailures)} ${t('recordFail')}`)
      if (parts.length === 0) return null
      return h('div', { className: 'ul-banner' }, parts.join(' '))
    }

    function PanelBody({ showBack, goBack }) {
      const { status, refreshTick } = useStatus()
      return h('div', { className: 'ul-page' },
        h('style', null, CSS),
        showBack ? h('div', { className: 'ul-backRow' },
          h('button', { type: 'button', className: 'ul-back', onClick: goBack }, `← ${t('back')}`)) : null,
        h('div', { className: 'ul-panel' },
          h(StatusBanner, { status }),
          h(SummaryCards, { tick: refreshTick }),
          h(DailySection, { tick: refreshTick }),
          h(HeatmapSection, { tick: refreshTick }),
          h(DonutSection, { tick: refreshTick }),
          h(ToolsSection, { tick: refreshTick }),
          h(SessionsSection, { tick: refreshTick })))
    }

    function PanelPage(props) { return h(PanelBody, { showBack: true, goBack: props.goBack }) }
    function Section() { return h(PanelBody, { showBack: false }) }

    function SidebarIcon({ size }) {
      const s = typeof size === 'number' ? size : 16
      return h('svg', { width: s, height: s, viewBox: '0 0 36 36', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, 'aria-hidden': true },
        h('path', { d: 'M18 11C15 8.5 11 8 7.5 9L7.5 26C11 25 15 25.5 18 28C21 25.5 25 25 28.5 26L28.5 9C25 8 21 8.5 18 11Z', strokeLinejoin: 'round' }),
        h('path', { d: 'M11 21v3M14.5 18v6M18 15v9M22 20l2.5-2.5 2 1.5 3-3.5', strokeLinecap: 'round', strokeLinejoin: 'round' }))
    }

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => {
          const offs = [
            ctx.locale.register(LOCALE_NS, 'zh', zh),
            ctx.locale.register(LOCALE_NS, 'en', en),
            ctx.locale.register(LOCALE_NS, 'zh-TW', zh), // v1: zh-TW 复用简体词典
          ]
          return () => { for (const off of offs) off() }
        }, 'dsh-usage-ledger: dictionaries')
        t = ctx.locale.bind(LOCALE_NS)
        // goBack：宿主无导航历史，自己记前一个 panel（参照 token-total）。
        let previousPanelId = null
        let lastPanelId = ctx.layout.panelInfo.getSnapshot().activePanelId
        ctx.effect(() => ctx.layout.panelInfo.subscribe(() => {
          const next = ctx.layout.panelInfo.getSnapshot().activePanelId
          if (next === 'usage-ledger' && lastPanelId !== 'usage-ledger') previousPanelId = lastPanelId
          lastPanelId = next
        }), 'dsh-usage-ledger: panel history')
        const goBack = () => {
          if (previousPanelId === null || previousPanelId === 'usage-ledger') { ctx.layout.selectPanel(null); return }
          try { ctx.layout.selectPanel(previousPanelId) } catch { ctx.layout.selectPanel(null) }
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: 'usage-ledger', order: 31, label: () => t('nav'), locale: LOCALE_NS,
        }, SidebarIcon))
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'usage-ledger', locale: LOCALE_NS, inject: () => ({ goBack }),
        }, PanelPage))
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config', key: 'dsh-usage-ledger', locale: LOCALE_NS,
        }, Section))
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'usage-ledger-usage', order: 21, label: () => t('tab'), locale: LOCALE_NS,
        }, SessionUsageView))
      },
    }
  },
})

/**
 * F-C hand-check sample (see src/client/fc.check.mjs for the executable copy):
 * points (0,0) (1,0) (2,10) (3,0), uniform x.
 *   secants d = [0, 10, -10]
 *   m0 = 0; m3 = -10; m1 = 0 (d0=0 → zero rule); m2 = 0 (sign change 10 vs -10)
 *   limiter: segment 1..2: a = m1/d1 = 0, b = m2/d1 = 0, s = 0 ≤ 9 → unchanged.
 * Every tangent is 0 except m3, so each Hermite segment eases between its
 * endpoint values with no derivative pushing past them: segment values stay
 * within [min, max] of their endpoints — monotone, zero overshoot, unlike
 * Catmull-Rom whose m2 = (y3-y1)/2 = 0 but m1 = (y2-y0)/2 = 5 would overshoot
 * below y=0 on segment 0..1 (negative tokens are nonsense). Rendered path:
 *   M0,0 C0.33,0 0.67,0 1,0 C1.33,0 1.67,10 2,10 C2.33,10 2.67,2.33 3,0
 * (node fc.check.mjs samples 101 points/segment for 7 datasets; all in-range.)
 */
