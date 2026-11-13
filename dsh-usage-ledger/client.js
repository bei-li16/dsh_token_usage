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
      donutTitle: '模型占比', other: '其他',
      toolsTitle: '工具分布', tName: '工具', tCalls: '次数', tFail: '失败率', tAvg: '平均耗时',
      sessTitle: '会话', sName: '名称', sKind: '类型', sDays: '活跃区间', sReq: '请求', sTok: 'tokens',
      kindMain: '主会话', kindSub: '子代理', kindWorkflow: '工作流',
      svTotals: '会话汇总（含子孙）', svRecords: '请求明细', svTools: '工具调用',
      svDegraded: '明细已超保留期或不可用，仅显示永久汇总。',
      cTime: '时间', cModel: '模型', cStatus: '状态', cTok: 'tokens', cTtft: '首 token', cSpeed: '速度',
      stRunning: '进行中', stCompleted: '完成', stFailed: '失败', stInterrupted: '中断',
      tokPerS: 'tok/s',
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
      donutTitle: 'Model share', other: 'Other',
      toolsTitle: 'Tool usage', tName: 'Tool', tCalls: 'Calls', tFail: 'Failure rate', tAvg: 'Avg duration',
      sessTitle: 'Sessions', sName: 'Name', sKind: 'Kind', sDays: 'Active span', sReq: 'Requests', sTok: 'tokens',
      kindMain: 'Main', kindSub: 'Subagent', kindWorkflow: 'Workflow',
      svTotals: 'Session totals (incl. descendants)', svRecords: 'Request records', svTools: 'Tool calls',
      svDegraded: 'Detail has aged out of retention or is unavailable; permanent rollup only.',
      cTime: 'Time', cModel: 'Model', cStatus: 'Status', cTok: 'tokens', cTtft: 'TTFT', cSpeed: 'Speed',
      stRunning: 'Running', stCompleted: 'Completed', stFailed: 'Failed', stInterrupted: 'Interrupted',
      tokPerS: 'tok/s',
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

    /** Status with 1s polling while backfill.running; timers cleared on stop/unmount. */
    function useStatus() {
      const [status, setStatus] = React.useState(null)
      React.useEffect(() => {
        let stopped = false
        let timer = null
        let ac = null
        const tick = () => {
          ac = new AbortController()
          post('status', {}, ac.signal).then((s) => {
            if (stopped) return
            setStatus(s)
            if (s && s.backfill && s.backfill.running) timer = setTimeout(tick, 1000)
          }, () => { /* status bar stays hidden on error */ })
        }
        tick()
        return () => { stopped = true; if (timer) clearTimeout(timer); if (ac) ac.abort() }
      }, [])
      return status
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
.ul-legend{display:flex;flex-wrap:wrap;gap:8px}
.ul-chip{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:999px;padding:2px 10px;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}
.ul-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ul-chipOff{opacity:.45}
.ul-swatch{width:10px;height:10px;border-radius:3px;flex:0 0 auto}
.ul-heatWrap{overflow-x:auto}
.ul-heat{width:100%;height:auto;display:block}
.ul-heat0{fill:color-mix(in srgb,var(--dsw-tone-1) 8%,transparent)}
.ul-heat1{fill:color-mix(in srgb,var(--dsw-tone-1) 25%,transparent)}
.ul-heat2{fill:color-mix(in srgb,var(--dsw-tone-1) 45%,transparent)}
.ul-heat3{fill:color-mix(in srgb,var(--dsw-tone-1) 65%,transparent)}
.ul-heat4{fill:color-mix(in srgb,var(--dsw-tone-1) 85%,transparent)}
.ul-heatLegend{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ul-heatKey{width:11px;height:11px;border-radius:3px;display:inline-block}
.ul-donutRow{display:flex;flex-wrap:wrap;align-items:center;gap:20px}
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
.ul-cellBad{color:var(--dsw-alias-danger-label,var(--dsw-alias-label-secondary))}
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

    // ── lifetime summary cards (/summary) ──────────────────────────────────
    function SummaryCards() {
      const state = useApi('summary', {}, [])
      if (state.loading || state.error) return h(LoadState, { state })
      const s = state.data
      if (!s) return h('div', { className: 'ul-note' }, t('empty'))
      return h('section', { className: 'ul-sec' },
        h('div', { className: 'ul-secTitle' }, t('sumTitle')),
        h('div', { className: 'ul-cards' },
          h(Card, { label: t('totalTokens'), value: fmtTok(s.tokens), sub: `${t('inputTok')} ${fmtTok(s.inputTokens)} · ${t('outputTok')} ${fmtTok(s.outputTokens)}` }),
          h(Card, { label: t('requests'), value: fmtInt(s.requests), sub: `${t('failures')} ${fmtInt(s.failures)} · ${t('errorRate')} ${fmtPct(s.errorRate)}` }),
          h(Card, { label: t('cacheHit'), value: fmtPct(s.cacheHitRate), sub: `${t('cacheReadTok')} ${fmtTok(s.cacheReadTokens)} · ${t('cacheWriteTok')} ${fmtTok(s.cacheWriteTokens)}` }),
          h(Card, { label: t('avgTtft'), value: fmtMs(s.avgFirstTokenMs) }),
          h(Card, { label: t('decodeSpeed'), value: fmtSpeed(s.tokensPerSecond) }),
          h(Card, { label: t('streak'), value: `${fmtInt(s.streakDays)} ${t('streakUnit')}`, sub: `${t('activeDays')} ${fmtInt(s.activeDays)}` }),
          s.peakDay ? h(Card, { label: t('peakDay'), value: fmtTok(s.peakDay.tokens), sub: s.peakDay.day }) : null))
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

    function LineChart({ keys, granularity, series }) {
      const W = 720; const H = 240; const padL = 46; const padR = 8; const padT = 12; const padB = 22
      const n = keys.length
      let max = 0
      for (const s of series) for (const v of s.values) if (v > max) max = v
      if (max <= 0) max = 1
      const x = (i) => (n === 1 ? padL + (W - padL - padR) / 2 : padL + (i * (W - padL - padR)) / (n - 1))
      const y = (v) => padT + (H - padT - padB) * (1 - v / max)
      const labelOf = (key) => (granularity === 'hour' ? `${key.slice(-2)}:00` : key.slice(5) || key)
      const tickEvery = Math.max(1, Math.ceil(n / 8))
      const grid = [0, 0.5, 1]
      return h('svg', { className: 'ul-chart', viewBox: `0 0 ${W} ${H}`, role: 'img' },
        grid.map((g) => h('g', { key: g },
          h('line', { x1: padL, x2: W - padR, y1: y(max * g), y2: y(max * g), stroke: 'var(--dsw-alias-border-l2)', strokeWidth: 1, vectorEffect: 'non-scaling-stroke' }),
          h('text', { x: padL - 6, y: y(max * g) + 3, textAnchor: 'end', fontSize: 10, fill: 'var(--dsw-alias-label-tertiary)' }, fmtTok(max * g)))),
        series.map((s) => {
          const pts = s.values.map((v, i) => ({ x: x(i), y: y(v) }))
          return h('g', { key: s.key },
            h('path', { d: fcCurvePath(pts), fill: 'none', stroke: s.color, strokeWidth: 2, vectorEffect: 'non-scaling-stroke', strokeLinejoin: 'round', strokeLinecap: 'round' }),
            pts.map((p, i) => h('circle', { key: i, cx: p.x, cy: p.y, r: 5, fill: 'transparent' },
              h('title', null, `${keys[i]} · ${s.key}: ${fmtTok(s.values[i])}`)),
            ))
        }),
        keys.map((key, i) => (i % tickEvery === 0 || i === n - 1
          ? h('text', { key, x: x(i), y: H - 6, textAnchor: 'middle', fontSize: 10, fill: 'var(--dsw-alias-label-tertiary)' }, labelOf(key))
          : null)))
    }

    function DailySection() {
      const [rangeId, setRangeId] = React.useState('30')
      const [hidden, setHidden] = React.useState({})
      const range = RANGES.find((r) => r.id === rangeId) || RANGES[2]
      const to = dayKeyOf(new Date())
      const fromDate = new Date(); fromDate.setDate(fromDate.getDate() - (range.days - 1))
      const body = { from: dayKeyOf(fromDate), to, group: 'model', granularity: range.granularity }
      const state = useApi('daily', body, [rangeId])
      const data = state.data
      const keys = data ? data.buckets.map((b) => b.key) : []
      const totals = data ? data.groupTotals.slice(0, 6) : []
      const series = totals
        .map((g, gi) => ({
          key: g.key,
          color: PALETTE[gi % PALETTE.length],
          values: data.buckets.map((b) => (b.groups && typeof b.groups[g.key] === 'number' ? b.groups[g.key] : 0)), // defensive zero-fill
        }))
        .filter((s) => !hidden[s.key])
      return h('section', { className: 'ul-sec' },
        h('div', { className: 'ul-toolbar' },
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
              h(LineChart, { keys, granularity: range.granularity, series }),
              h('div', { className: 'ul-legend' },
                totals.map((g, gi) => h('button', {
                  key: g.key, type: 'button',
                  className: hidden[g.key] ? 'ul-chip ul-chipOff' : 'ul-chip',
                  onClick: () => setHidden((prev) => ({ ...prev, [g.key]: !prev[g.key] })),
                },
                  h('span', { className: 'ul-swatch', style: { background: PALETTE[gi % PALETTE.length] } }),
                  g.key)))))
    }

    // ── 52-week heatmap (/heatmap) ─────────────────────────────────────────
    function HeatmapSection() {
      const state = useApi('heatmap', { weeks: 52 }, [])
      if (state.loading || state.error) return h(LoadState, { state })
      const data = state.data
      if (!data || !data.days || data.days.length === 0) return h('div', { className: 'ul-note' }, t('empty'))
      const cell = 11; const gap = 3; const step = cell + gap
      const cols = Math.ceil(data.days.length / 7)
      const W = cols * step
      const H = 7 * step
      const max = data.maxTokens > 0 ? data.maxTokens : 1
      const level = (tokens) => {
        if (tokens <= 0) return 0
        const r = tokens / max
        return r < 0.25 ? 1 : r < 0.5 ? 2 : r < 0.75 ? 3 : 4
      }
      return h('section', { className: 'ul-sec' },
        h('div', { className: 'ul-secTitle' }, t('heatTitle')),
        h('div', { className: 'ul-heatWrap' },
          h('svg', { className: 'ul-heat', viewBox: `0 0 ${W} ${H}`, style: { maxWidth: `${W}px` }, role: 'img' },
            data.days.map((d, i) => h('rect', {
              key: d.day,
              x: Math.floor(i / 7) * step, y: (i % 7) * step,
              width: cell, height: cell, rx: 3,
              class: `ul-heat${level(d.tokens)}`,
            }, h('title', null, `${d.day}: ${fmtTok(d.tokens)} · ${fmtInt(d.requests)}`))))),
        h('div', { className: 'ul-heatLegend' },
          h('span', null, t('less')),
          [0, 1, 2, 3, 4].map((lv) => h('span', { key: lv, className: `ul-heatKey ul-heat${lv}` })),
          h('span', null, t('more'))))
    }

    // ── model donut (/daily?group=model groupTotals, 30d window) ──────────
    function DonutSection() {
      const to = dayKeyOf(new Date())
      const fromDate = new Date(); fromDate.setDate(fromDate.getDate() - 29)
      const state = useApi('daily', { from: dayKeyOf(fromDate), to, group: 'model', granularity: 'day' }, [])
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
      const R = 48; const C = 2 * Math.PI * R
      let acc = 0
      return h('section', { className: 'ul-sec' },
        h('div', { className: 'ul-secTitle' }, t('donutTitle')),
        h('div', { className: 'ul-donutRow' },
          h('svg', { width: 132, height: 132, viewBox: '0 0 132 132', role: 'img' },
            h('circle', { cx: 66, cy: 66, r: R, fill: 'none', stroke: 'var(--dsw-alias-bg-layer-1)', strokeWidth: 18 }),
            slices.map((s) => {
              const frac = s.tokens / sum
              const off = acc
              acc += frac
              return h('circle', {
                key: s.key, cx: 66, cy: 66, r: R, fill: 'none',
                stroke: s.color, strokeWidth: 18,
                strokeDasharray: `${Math.max(0, frac * C - 1.5)} ${C - Math.max(0, frac * C - 1.5)}`,
                strokeDashoffset: -off * C + C / 4,
              }, h('title', null, `${s.key}: ${fmtTok(s.tokens)} (${(frac * 100).toFixed(1)}%)`))
            })),
          h('div', { className: 'ul-donutLegend' },
            slices.map((s) => h('div', { key: s.key, className: 'ul-donutItem' },
              h('span', { className: 'ul-swatch', style: { background: s.color } }),
              h('span', { className: 'ul-donutName' }, s.key),
              h('span', { className: 'ul-donutPct' }, `${((s.tokens / sum) * 100).toFixed(1)}%`))))))
    }

    // ── tool distribution (/tools) ─────────────────────────────────────────
    function ToolsSection() {
      const state = useApi('tools', {}, [])
      if (state.loading || state.error) return h(LoadState, { state })
      const data = state.data
      const tools = data ? data.tools.slice(0, 12) : []
      if (!data || tools.length === 0) return h('div', { className: 'ul-note' }, t('empty'))
      return h('section', { className: 'ul-sec' },
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
    function SessionsSection() {
      const state = useApi('sessions', { limit: 30 }, [])
      if (state.loading || state.error) return h(LoadState, { state })
      const data = state.data
      const rows = data ? data.rows : []
      if (!data || rows.length === 0) return h('div', { className: 'ul-note' }, t('empty'))
      return h('section', { className: 'ul-sec' },
        h('div', { className: 'ul-secTitle' }, t('sessTitle')),
        h('div', { className: 'ul-table ul-sessHead' },
          h('span', null, t('sName')), h('span', null, t('sKind')),
          h('span', null, t('sDays')), h('span', null, t('sReq')), h('span', null, t('sTok'))),
        rows.map((row) => h('div', { key: row.id, className: 'ul-table ul-sessRow' },
          h('span', { className: 'ul-cellName', title: row.id }, row.name || row.id),
          h('span', null, t(KIND_LABEL[row.kind] || 'kindMain')),
          h('span', { className: 'ul-cellDim' }, row.firstDay === row.lastDay ? row.firstDay : `${row.firstDay} ~ ${row.lastDay}`),
          h('span', { className: 'ul-cellNum2' }, fmtInt(row.requests)),
          h('span', { className: 'ul-cellNum2' }, fmtTok(row.tokens)))))
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
                      }))),
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
      if (status.degraded) parts.push(t('degraded'))
      if (status.backfill && status.backfill.running) {
        parts.push(`${t('backfill')} ${status.backfill.done}/${status.backfill.total}…`)
      }
      if (parts.length === 0) return null
      return h('div', { className: 'ul-banner' }, parts.join(' '))
    }

    function PanelBody({ showBack, goBack }) {
      const status = useStatus()
      return h('div', { className: 'ul-page' },
        h('style', null, CSS),
        showBack ? h('div', { className: 'ul-backRow' },
          h('button', { type: 'button', className: 'ul-back', onClick: goBack }, `← ${t('back')}`)) : null,
        h('div', { className: 'ul-panel' },
          h(StatusBanner, { status }),
          h(SummaryCards),
          h(DailySection),
          h(HeatmapSection),
          h(DonutSection),
          h(ToolsSection),
          h(SessionsSection)))
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
