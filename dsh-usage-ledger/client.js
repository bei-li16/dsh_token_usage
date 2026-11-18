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
      sumTitle: '总览', totalTokens: '总 tokens', todayTokens: '今日消耗', requests: '请求数', failures: '失败',
      errorRate: '错误率', cacheHit: '缓存命中率', avgTtft: '平均首 token',
      decodeSpeed: '解码速度', streak: '连续活跃', streakUnit: '天', peakDay: '峰值日',
      activeDays: '活跃天数', inputTok: '输入', outputTok: '输出',
      cacheReadTok: '缓存读', cacheWriteTok: '缓存写', turns: '轮次', toolCalls: '工具调用',
      dailyTitle: '每日用量（按模型）', rToday: '今天', r7: '7 天', r30: '30 天', r90: '90 天',
      heatTitle: '活跃热力图', less: '少', more: '多',
      hmDay: '每日', hmWeek: '每周', hmCum: '累计',
      donutTitle: '模型占比', other: '其他',
      toolsTitle: '工具分布', tName: '工具', tCalls: '次数', tFail: '失败率', tAvg: '平均耗时',
      sessTitle: '会话', sName: '名称', sKind: '类型', sDays: '活跃区间', sReq: '请求', sTok: 'tokens',
      kindMain: '主会话', kindSub: '子代理', kindWorkflow: '工作流',
      svTotals: '会话汇总（含子孙）', svTools: '工具调用',
      svDegraded: '明细已超保留期或不可用，仅显示永久汇总。',
      svLive: '实时更新', svAsOf: '统计截至', svRefresh: '刷新',
      svTokens: 'Tokens', svChildren: '子会话', svModels: '模型', svModel: '模型', svHit: '命中率',
      svCacheHitShort: '缓存命中', svTokPerSec: 'tok/s', svUnknownModel: '(unknown)',
      svNoChildren: '暂无子会话', svNoModels: '暂无模型数据',
      svTokSpeed: 'token 速度', svScope: '本会话及所有子代理 · 历史日志累计',
      currentContextTitle: '当前上下文', contextUsedShort: '上下文已用',
      contextWindowTotal: '{used} / {window} tokens', contextWindowTotalUnknown: '{used} tokens',
      statsTitle: 'Token 统计', statsTotal: '总用量', statsCacheHit: '缓存命中',
      statsIncludesThinking: '含思考', statsEmpty: '本会话还没有可统计的 token',
      bucketSystemPrompt: '系统提示词', bucketUser: '用户消息', bucketSkill: '技能注入',
      bucketToolResult: '工具结果', bucketToolDef: '工具定义', bucketInjected: '注入内容',
      bucketAssistant: '助手消息', bucketOutput: '输出',
      tokPerS: 't/s',
      reqWord: '次请求', recordFail: '条写入失败',
      sessTotal: '共 {n} 个会话',
      dwToday: '（今天）', donutRange: '（近 {n}）',
    }
    const en = {
      nav: 'Usage ledger', tab: 'Usage', back: 'Back', loading: 'Loading…',
      loadError: 'Failed to load', retry: 'Retry', empty: 'No data yet', na: '—',
      degraded: 'Detail unavailable; showing permanent rollup only (KV mode).',
      backfill: 'Backfilling history',
      sumTitle: 'Overview', totalTokens: 'Total tokens', todayTokens: 'Today', requests: 'Requests', failures: 'Failures',
      errorRate: 'Error rate', cacheHit: 'Cache hit rate', avgTtft: 'Avg first token',
      decodeSpeed: 'Decode speed', streak: 'Active streak', streakUnit: 'd', peakDay: 'Peak day',
      activeDays: 'Active days', inputTok: 'Input', outputTok: 'Output',
      cacheReadTok: 'Cache read', cacheWriteTok: 'Cache write', turns: 'Turns', toolCalls: 'Tool calls',
      dailyTitle: 'Daily usage by model', rToday: 'Today', r7: '7d', r30: '30d', r90: '90d',
      heatTitle: 'Activity heatmap', less: 'Less', more: 'More',
      hmDay: 'Daily', hmWeek: 'Weekly', hmCum: 'Cumulative',
      donutTitle: 'Model share', other: 'Other',
      toolsTitle: 'Tool usage', tName: 'Tool', tCalls: 'Calls', tFail: 'Failure rate', tAvg: 'Avg duration',
      sessTitle: 'Sessions', sName: 'Name', sKind: 'Kind', sDays: 'Active span', sReq: 'Requests', sTok: 'tokens',
      kindMain: 'Main', kindSub: 'Subagent', kindWorkflow: 'Workflow',
      svTotals: 'Session totals (incl. descendants)', svTools: 'Tool calls',
      svDegraded: 'Detail has aged out of retention or is unavailable; permanent rollup only.',
      svLive: 'Live', svAsOf: 'as of', svRefresh: 'Refresh',
      svTokens: 'Tokens', svChildren: 'Sub-sessions', svModels: 'Models', svModel: 'Model', svHit: 'Hit',
      svCacheHitShort: 'cache hit', svTokPerSec: 'tok/s', svUnknownModel: '(unknown)',
      svNoChildren: 'No sub-sessions', svNoModels: 'No model data',
      svTokSpeed: 'Token speed', svScope: 'This session and all subagents · Historical log totals',
      currentContextTitle: 'Current context', contextUsedShort: 'context used',
      contextWindowTotal: '{used} / {window} tokens', contextWindowTotalUnknown: '{used} tokens',
      statsTitle: 'Token stats', statsTotal: 'Total usage', statsCacheHit: 'Cache hit',
      statsIncludesThinking: 'incl. thinking', statsEmpty: 'No token spend recorded for this session yet',
      bucketSystemPrompt: 'System prompt', bucketUser: 'User messages', bucketSkill: 'Skill injection',
      bucketToolResult: 'Tool results', bucketToolDef: 'Tool definitions', bucketInjected: 'Injected content',
      bucketAssistant: 'Assistant messages', bucketOutput: 'Output',
      tokPerS: 't/s',
      reqWord: 'requests', recordFail: 'write failures',
      sessTotal: '{n} sessions',
      dwToday: ' (Today)', donutRange: ' (last {n})',
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
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
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
    // live-header clock for the session tab's "as of" poll stamp: HH:MM:SS
    const fmtClock = (ms) => {
      const d = new Date(ms)
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
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
.ul-secTitle{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}
.ul-count{display:inline-flex;align-items:center;justify-content:center;min-width:20px;height:18px;padding:0 7px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;font-variant-numeric:tabular-nums}
.ul-hit{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-primary))}
/* 命中率分档配色对齐 token-total：≥80 绿 / ≥50 黄 / <50 红 / null 灰。 */
.ul-hitWarn{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-label-secondary))}
.ul-hitBad{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary))}
.ul-mdNameCell{display:flex;align-items:center;gap:6px;min-width:0}
.ul-mdLogo{width:16px;height:16px;border-radius:5px;display:inline-flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;line-height:1;color:var(--dsw-alias-bg-base);background:color-mix(in srgb,var(--dsw-tone-1) 65%,transparent);flex:0 0 auto}
.ul-cards{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px}
.ul-card{box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);min-width:0}
.ul-cardLabel{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-tertiary);margin-bottom:4px}
/* Metric-card icon badge: tone-colored glyph on a 14% tint of the same hue
   (aligned with token-total's session cards: blue requests / purple tokens /
   teal input / orange output+speed / green hit rate). */
.ul-cardLabel{display:flex;align-items:center;gap:6px}
.ul-cardIcon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;color:var(--ul-ic,var(--dsw-alias-label-tertiary));background:color-mix(in srgb,var(--ul-ic,var(--dsw-alias-label-tertiary)) 14%,transparent);flex:0 0 auto}
.ul-icBlue{--ul-ic:var(--dsw-tone-1,#4d6bfe)}
.ul-icGreen{--ul-ic:var(--dsw-tone-2,#00b96b)}
.ul-icOrange{--ul-ic:var(--dsw-tone-3,#e07b39)}
.ul-icPurple{--ul-ic:var(--dsw-tone-4,#975bf1)}
.ul-icTeal{--ul-ic:var(--dsw-tone-5,#0d8a8a)}
.ul-icPink{--ul-ic:var(--dsw-tone-6,#d34591)}
.ul-icRed{--ul-ic:#e5646e}
body[data-ds-dark-theme] .ul-icRed{--ul-ic:#f0737c}
.ul-cardValue{font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ul-cardSub{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* Full-width strip, every cell the SAME width (flex-basis 0 → truly equal),
   so the band aligns left/right with the cards above and below it. */
.ul-band{display:flex;flex-wrap:wrap;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.ul-bandItem{flex:1 1 0;min-width:0;box-sizing:border-box;padding:12px 14px;position:relative;cursor:default}
.ul-bandItem+.ul-bandItem{border-left:1px solid var(--dsw-alias-border-l2)}
.ul-bandValue{font-size:19px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ul-bandLabel{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-tertiary);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
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
.ul-tip{position:absolute;z-index:20;pointer-events:none;box-sizing:border-box;min-width:132px;max-width:260px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-bg-layer-1));box-shadow:0 4px 16px rgba(0,0,0,.24);font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary)}
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
/* Level-0 = neutral gray (label color at low alpha), clearly separate from
   the accent ramp so "no usage" never reads as a light blue cell. Levels
   1-4 start at 35% accent so level-1 is unmistakably "has data". */
.ul-heat0{fill:color-mix(in srgb,var(--dsw-alias-label-primary) 7%,transparent)}
.ul-heat1{fill:color-mix(in srgb,var(--dsw-tone-1) 35%,transparent)}
.ul-heat2{fill:color-mix(in srgb,var(--dsw-tone-1) 55%,transparent)}
.ul-heat3{fill:color-mix(in srgb,var(--dsw-tone-1) 75%,transparent)}
.ul-heat4{fill:color-mix(in srgb,var(--dsw-tone-1) 95%,transparent)}
.ul-heatLegend{display:flex;align-items:center;gap:4px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ul-heatKey{width:12px;height:12px;border-radius:3px;display:inline-block}
.ul-donutRow{display:flex;flex-direction:column;align-items:center;gap:14px}
.ul-donutWrap{position:relative;flex:0 0 auto}
.ul-donutLegend{width:100%;display:grid;grid-template-columns:1fr 1fr;gap:6px 14px;min-width:0}
.ul-donutItem{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ul-donutName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
.ul-donutPct{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ul-table{display:grid;align-items:center;gap:4px 12px;font-size:12px}
.ul-toolHead,.ul-toolRow{grid-template-columns:minmax(80px,1.2fr) minmax(90px,1.6fr) 60px 70px}
.ul-toolHead{color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:6px}
.ul-toolRow{padding:5px 0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 50%,transparent);color:var(--dsw-alias-label-secondary)}
.ul-cellName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary)}
.ul-cellNum{font-variant-numeric:tabular-nums;display:flex;align-items:center;gap:8px;justify-content:flex-end}
.ul-barWrap{flex:1;height:6px;border-radius:3px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ul-bar{display:block;height:100%;border-radius:3px;background:color-mix(in srgb,var(--dsw-tone-1) 70%,transparent)}
.ul-sessHead,.ul-sessRow{grid-template-columns:minmax(96px,1.6fr) 52px minmax(88px,1fr) 46px 62px}
.ul-sessHead{color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:6px}
.ul-sessRow{padding:5px 0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 50%,transparent);color:var(--dsw-alias-label-secondary)}
.ul-cellDim{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ul-cellNum2{font-variant-numeric:tabular-nums;text-align:right}
.ul-session{display:flex;flex-direction:column;color:var(--dsw-alias-label-primary);font:inherit;container-type:inline-size}
/* Centered, width-capped page (token-total .page): the conversation tab's
   content never sprawls edge-to-edge; containers above enable @container
   breakpoints that track the CONTENT width, not the viewport. */
.ul-svPage{box-sizing:border-box;width:100%;max-width:1160px;margin:0 auto;padding:24px 26px 32px;display:flex;flex-direction:column;gap:18px}
/* two tables side by side (token-total .mid): sub-sessions | models, each
   half width; one column when the content gets narrow */
.ul-mid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:18px;align-items:stretch}
@container (max-width:1050px){
  .ul-mid{grid-template-columns:minmax(0,1fr)}
  .ul-cards{grid-template-columns:repeat(3,minmax(0,1fr))}
}
@container (max-width:700px){
  .ul-svPage{padding:18px 14px 24px}
  .ul-cards{grid-template-columns:repeat(2,minmax(0,1fr))}
}
.ul-svHead{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px}
.ul-svLive{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ul-liveDot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-success-primary,var(--dsw-tone-1));flex:0 0 auto}
.ul-svAsOf{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.ul-svRefresh{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:6px;padding:2px 10px;cursor:pointer;font:inherit;font-size:12px}
.ul-svRefresh:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ul-chHead,.ul-chRow{grid-template-columns:minmax(88px,1.5fr) 46px 64px 56px 56px 62px minmax(56px,1fr)}
.ul-chHead{color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:6px}
.ul-chRow{padding:5px 0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 50%,transparent);color:var(--dsw-alias-label-secondary)}
.ul-mdHead,.ul-mdRow{grid-template-columns:minmax(110px,1.8fr) 52px minmax(64px,1fr) minmax(64px,1fr) minmax(64px,1fr) minmax(64px,1fr) 62px}
.ul-mdHead{color:var(--dsw-alias-label-tertiary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:6px}
.ul-mdRow{padding:5px 0;border-bottom:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 50%,transparent);color:var(--dsw-alias-label-secondary)}
.ul-scopeNote{font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:-4px}
/* ── the two live cards: current context + token stats (token-total) ─────
   Each bucket sets --ul-bucket, and the swatch, ring segment, bar segment
   and legend value all read that one variable. Hues are this plugin's own
   (artwork exception, same as PALETTE). */
.ul-svGrid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px;align-items:stretch}
@container (max-width:880px){.ul-svGrid{grid-template-columns:1fr}}
.ul-ucCard{display:flex;flex-direction:column;min-width:0;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}
.ul-ucHead{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:12px 14px 0}
.ul-ucTitle{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap}
.ul-ucModel{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.ul-ucCache{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ul-ucCache b{margin-left:2px;font-weight:600;color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-primary));font-variant-numeric:tabular-nums}
.ul-ucBody{flex:1 1 auto;box-sizing:border-box;padding:12px 14px 14px;display:flex;flex-direction:column}
.ul-ucTotalRow{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.ul-ucTotal{font-size:20px;font-weight:650;letter-spacing:-.3px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;white-space:nowrap}
.ul-ucShare{flex:none;font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.ul-ucShare b{color:var(--dsw-alias-label-secondary);font-weight:600;font-variant-numeric:tabular-nums}
.ul-ucBar{display:flex;width:100%;height:10px;margin:12px 0 14px;border-radius:999px;overflow:hidden;background:var(--dsw-alias-border-l1)}
.ul-ucBarSeg{height:100%;flex:none;background:var(--ul-bucket)}
.ul-ucBarEmpty{display:block;width:100%;height:100%;background:repeating-linear-gradient(90deg,var(--dsw-alias-border-l2) 0 4px,transparent 4px 8px)}
.ul-ucStats{display:flex;align-items:center;gap:16px}
.ul-ucRingWrap{position:relative;flex:none;width:116px;height:116px}
.ul-ucRingTrack{fill:none;stroke:var(--dsw-alias-border-l1)}
.ul-ucRingSeg{fill:none;stroke:var(--ul-bucket)}
.ul-ucRingCenter{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;text-align:center;pointer-events:none}
.ul-ucRingTotal{font-size:17px;font-weight:650;letter-spacing:-.3px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.ul-ucRingCaption{font-size:10px;color:var(--dsw-alias-label-tertiary)}
.ul-ucLegend{flex:1 1 auto;min-width:0;display:grid;grid-template-rows:repeat(4,auto);grid-auto-flow:column;gap:7px 16px}
@container (max-width:520px){.ul-ucStats{flex-wrap:wrap;justify-content:center}.ul-ucLegend{grid-template-rows:none;grid-auto-flow:row;grid-template-columns:minmax(0,1fr);width:100%}}
.ul-mdLogoDot{border-radius:50%}
.ul-ucRow{display:grid;grid-template-columns:7px minmax(0,1fr) auto auto;align-items:center;gap:6px;min-width:0;font-size:11px}
.ul-ucSwatch{width:7px;height:7px;border-radius:50%;background:var(--ul-bucket)}
.ul-ucName{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}
.ul-ucPct{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.ul-ucVal{color:var(--ul-bucket);font-variant-numeric:tabular-nums;font-weight:500;text-align:right;white-space:nowrap}
.ul-ucSuffix{color:var(--dsw-alias-label-tertiary);font-weight:400}
.ul-ucEmpty{margin:16px 0 18px;text-align:center;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.ul-tone-systemPrompt{--ul-bucket:#6f6bf5}
.ul-tone-user{--ul-bucket:#2bb673}
.ul-tone-skill{--ul-bucket:#16b8a6}
.ul-tone-toolResult{--ul-bucket:#4d6bfe}
.ul-tone-toolDef{--ul-bucket:#f0a53a}
.ul-tone-injected{--ul-bucket:#a75ff0}
.ul-tone-assistant{--ul-bucket:#7c8cff}
.ul-tone-output{--ul-bucket:#ef5da8}
body[data-ds-dark-theme] .ul-tone-systemPrompt{--ul-bucket:#9b96ff}
body[data-ds-dark-theme] .ul-tone-user{--ul-bucket:#3ed08a}
body[data-ds-dark-theme] .ul-tone-skill{--ul-bucket:#2fd6c2}
body[data-ds-dark-theme] .ul-tone-toolResult{--ul-bucket:#7d95ff}
body[data-ds-dark-theme] .ul-tone-toolDef{--ul-bucket:#f5b861}
body[data-ds-dark-theme] .ul-tone-injected{--ul-bucket:#c184ff}
body[data-ds-dark-theme] .ul-tone-assistant{--ul-bucket:#9aabff}
body[data-ds-dark-theme] .ul-tone-output{--ul-bucket:#ff85c0}
.ul-toolMini{display:flex;flex-wrap:wrap;gap:8px}
.ul-foldGrid{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
@media (max-width:1100px){.ul-foldGrid{grid-template-columns:1fr}}
.ul-mixGrid{display:grid;grid-template-columns:minmax(280px,1fr) minmax(0,2fr);gap:14px;align-items:stretch}
@media (max-width:1100px){.ul-mixGrid{grid-template-columns:1fr}}
.ul-foldCard{display:flex;flex-direction:column;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);min-width:0;overflow:hidden}
.ul-foldHead{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:12px 14px;cursor:pointer;user-select:none;border-radius:10px}
.ul-foldHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ul-chev{color:var(--dsw-alias-label-tertiary);transition:transform .15s ease;display:inline-flex}
.ul-chevOpen{transform:rotate(90deg)}
.ul-foldBody{padding:0 14px 12px;max-height:306px;overflow-y:auto;overflow-x:hidden}
`

    // ── shared bits ────────────────────────────────────────────────────────
    /** Tiny line icon for a metric card (stroke follows currentColor). */
    const CARD_ICON_D = {
      requests: 'M4 9h16M4 15h16M10 3 8 21M16 3l-2 18', // '#'
      tokens: 'M4 8c0-2.2 3.6-4 8-4s8 1.8 8 4-3.6 4-8 4-8-1.8-8-4Zm0 0v8c0 2.2 3.6 4 8 4s8-1.8 8-4V8', // db
      input: 'M12 3v12M7 10l5 5 5-5M4 21h16', // ↓
      output: 'M12 21V9M7 14l5-5 5 5M4 3h16', // ↑
      hit: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z', // ◎
      speed: 'M13 2 4 14h7l-1 8 9-12h-7l1-8Z', // ⚡
      today: 'M7 3v4M17 3v4M4 9h16M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z', // calendar
      clock: 'M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18ZM12 7v5l3 2', // ttft
      flame: 'M12 22a7 7 0 0 0 7-7c0-2-1-3.9-2.5-5.5C15 8 13.5 6.5 13 3c-3 2-6 5.5-6 9a7 7 0 0 0 7 10Z', // streak
      bars: 'M5 20v-6M11 20V6M17 20v-9M3 20h18', // peak day
    }
    const cardIcon = (d) => h('svg', {
      width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
      stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    }, h('path', { d }))

    function LoadState({ state }) {
      if (state.loading) return h('div', { className: 'ul-note' }, t('loading'))
      if (state.error) {
        return h('div', { className: 'ul-error' },
          h('span', null, `${t('loadError')}: ${state.error.message}`),
          h('button', { type: 'button', onClick: () => state.retry() }, t('retry')))
      }
      return null
    }

    function Card({ label, value, sub, title, icon, tone }) {
      return h('div', { className: 'ul-card' },
        h('div', { className: 'ul-cardLabel' },
          icon ? h('span', { className: tone ? `ul-cardIcon ${tone}` : 'ul-cardIcon' }, icon) : null,
          label),
        h('div', { className: 'ul-cardValue', title }, value),
        sub ? h('div', { className: 'ul-cardSub' }, sub) : null)
    }

    // One strip item of the overview band: big value on top, small label
    // below, and NOTHING truncated — full precision lives in the hover card
    // (detail rows with per-metric color dots). Vertical 1px dividers come
    // from CSS (.ul-bandItem + .ul-bandItem), so the first item has none.
    function BandItem({ label, value, detail, icon, tone }) {
      const [hov, setHov] = React.useState(false)
      return h('div', {
        className: 'ul-bandItem',
        onMouseEnter: () => setHov(true),
        onMouseLeave: () => setHov(false),
      },
        h('div', { className: 'ul-bandValue' }, value),
        h('div', { className: 'ul-bandLabel' },
          icon ? h('span', { className: tone ? `ul-cardIcon ${tone}` : 'ul-cardIcon' }, icon) : null,
          label),
        hov && Array.isArray(detail) && detail.length > 0
          ? h(ChartTip, { style: { left: '50%', top: 'calc(100% + 6px)', transform: 'translateX(-50%)', whiteSpace: 'nowrap' } },
            detail.map((r) => h(TipRow, { key: `${r.name}:${r.value}`, color: r.color ?? null },
              h('span', { className: 'ul-tipName' }, r.name),
              h('span', { className: 'ul-tipVal' }, r.value))))
          : null)
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
      // 空/加载/错误态也保住区块框架（标题在，内容换 LoadState/empty）。
      if (state.loading || state.error || !state.data) {
        return h('section', { className: 'ul-sec' },
          h('div', { className: 'ul-secTitle' }, t('sumTitle')),
          state.loading || state.error ? h(LoadState, { state }) : h('div', { className: 'ul-note' }, t('empty')))
      }
      const s = state.data
      const tokRow = (color, name, v) => ({ color, name, value: `${fmtInt(v)} tokens` })
      return h('section', { className: 'ul-sec' },
        h('div', { className: 'ul-secTitle' }, t('sumTitle')),
        h('div', { className: 'ul-band' },
          h(BandItem, { label: t('totalTokens'), icon: cardIcon(CARD_ICON_D.tokens), tone: 'ul-icPurple', value: fmtTok(s.tokens), detail: [
            tokRow(PALETTE[0], t('inputTok'), s.inputTokens),
            tokRow(PALETTE[1], t('outputTok'), s.outputTokens),
            tokRow(PALETTE[4], t('cacheReadTok'), s.cacheReadTokens),
            tokRow(PALETTE[2], t('cacheWriteTok'), s.cacheWriteTokens),
          ] }),
          h(BandItem, { label: t('todayTokens'), icon: cardIcon(CARD_ICON_D.today), tone: 'ul-icTeal', value: fmtTok(s.todayTokens ?? 0), detail: [
            tokRow(null, t('todayTokens'), s.todayTokens ?? 0),
            { color: null, name: t('requests'), value: fmtInt(s.todayRequests ?? 0) },
          ] }),
          h(BandItem, { label: t('requests'), icon: cardIcon(CARD_ICON_D.requests), tone: 'ul-icBlue', value: fmtInt(s.requests), detail: [
            { color: null, name: t('requests'), value: fmtInt(s.requests) },
            { color: PALETTE[3], name: t('failures'), value: fmtInt(s.failures) },
            { color: null, name: t('errorRate'), value: fmtPct(s.errorRate) },
          ] }),
          h(BandItem, { label: t('cacheHit'), icon: cardIcon(CARD_ICON_D.hit), tone: 'ul-icGreen', value: fmtPct(s.cacheHitRate), detail: [
            { color: null, name: t('cacheHit'), value: fmtPct(s.cacheHitRate) },
            tokRow(PALETTE[4], t('cacheReadTok'), s.cacheReadTokens),
            tokRow(PALETTE[2], t('cacheWriteTok'), s.cacheWriteTokens),
          ] }),
          h(BandItem, { label: t('avgTtft'), icon: cardIcon(CARD_ICON_D.clock), tone: 'ul-icPink', value: fmtMs(s.avgFirstTokenMs), detail: [
            { color: null, name: t('avgTtft'), value: s.avgFirstTokenMs === null ? t('na') : `${fmtInt(s.avgFirstTokenMs)} ms` },
          ] }),
          h(BandItem, { label: t('decodeSpeed'), icon: cardIcon(CARD_ICON_D.speed), tone: 'ul-icOrange', value: fmtSpeed(s.tokensPerSecond), detail: [
            { color: null, name: t('decodeSpeed'), value: fmtSpeed(s.tokensPerSecond) },
          ] }),
          h(BandItem, { label: t('streak'), icon: cardIcon(CARD_ICON_D.flame), tone: 'ul-icRed', value: `${fmtInt(s.streakDays)} ${t('streakUnit')}`, detail: [
            { color: null, name: t('streak'), value: `${fmtInt(s.streakDays)} ${t('streakUnit')}` },
            { color: null, name: t('activeDays'), value: `${fmtInt(s.activeDays)} ${t('streakUnit')}` },
          ] }),
          s.peakDay ? h(BandItem, { label: t('peakDay'), icon: cardIcon(CARD_ICON_D.bars), tone: 'ul-icBlue', value: fmtTok(s.peakDay.tokens), detail: [
            { color: null, name: t('peakDay'), value: `${fmtInt(s.peakDay.tokens)} tokens` },
            { color: null, name: '', value: s.peakDay.day },
          ] }) : null))
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

    function LineChart({ keys, granularity, degraded, series, animKey, rate }) {
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
      // Cache hit-rate overlay: fixed 0..100 scale on a secondary right axis
      // (token-total's hourly trend shows the same overlay line).
      const yRate = (v) => padT + (H - padT - padB) * (1 - v / 100)
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
      // Hit-rate overlay path: one continuous dashed polyline through known
      // buckets — null buckets (no prompt tokens that day) are SKIPPED, not
      // broken at, so the line never shatters into floating segments.
      let ratePath = ''
      if (rate) {
        for (let i = 0; i < n; i++) {
          const v = rate.values[i]
          if (typeof v !== 'number') continue
          ratePath += `${ratePath === '' ? 'M' : 'L'}${rnd(x(i))},${rnd(yRate(v))}`
        }
      }
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
          ratePath !== ''
            ? h('path', { d: ratePath, fill: 'none', stroke: 'var(--dsw-alias-label-tertiary)', strokeWidth: 1.5, strokeDasharray: '5 4', vectorEffect: 'non-scaling-stroke' })
            : null,
          ratePath !== ''
            ? [0, 50, 100].map((p) => h('text', { key: `r${p}`, x: W - 2, y: yRate(p) + 3, textAnchor: 'end', fontSize: 9, fill: 'var(--dsw-alias-label-tertiary)' }, `${p}%`))
            : null,
          // Hover markers: one dot per series WITH VALUE at the hovered bucket
          // (zero-value dots would pile on the baseline; zero rows are noise).
          hi !== null ? series.filter((s) => (s.values[hi] ?? 0) > 0).map((s) => h('circle', {
            key: `d${s.key}`, cx: x(hi), cy: y(s.values[hi] ?? 0), r: 3.5,
            fill: s.color, stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke',
          })) : null,
          hi !== null && rate && typeof rate.values[hi] === 'number'
            ? h('circle', { cx: x(hi), cy: yRate(rate.values[hi]), r: 3, fill: 'var(--dsw-alias-label-tertiary)', stroke: 'var(--dsw-alias-bg-base)', strokeWidth: 1 })
            : null,
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
            series.filter((s) => (s.values[hi] ?? 0) > 0).map((s) => h(TipRow, { key: s.key, color: s.color },
              h('span', { className: 'ul-tipName' }, s.name ?? s.key),
              h('span', { className: 'ul-tipVal' }, `${fmtTok(s.values[hi])} tokens`))),
            rate && typeof rate.values[hi] === 'number'
              ? h('div', { className: 'ul-tipRow' },
                h('span', { className: 'ul-tipName' }, rate.label),
                h('span', { className: 'ul-tipVal' }, fmtPct(rate.values[hi])))
              : null)
          : null)
    }

    function DailySection({ tick, rangeId, onRange }) {
      const [hidden, setHidden] = React.useState({})
      const range = RANGES.find((r) => r.id === rangeId) || RANGES[2]
      const to = dayKeyOf(new Date())
      const fromDate = new Date(); fromDate.setDate(fromDate.getDate() - (range.days - 1))
      const body = { from: dayKeyOf(fromDate), to, group: 'model', granularity: range.granularity }
      const state = useApi('daily', body, [rangeId, tick])
      const data = state.data
      const keys = data ? data.buckets.map((b) => b.key) : []
      // Route refs → selector display names (groupNames, host-resolved); raw ref is the fallback.
      const names = data?.groupNames ?? {}
      const nameOf = (k) => names[k] ?? k
      // Models with zero tokens in the range are hidden entirely (no legend noise).
      const totals = data ? data.groupTotals.filter((g) => g.tokens > 0) : []
      const top = totals.slice(0, 6)
      const rest = totals.slice(6)
      const restTokens = rest.reduce((a, g) => a + g.tokens, 0)
      // top-6 series + a grey "other" rollup so line totals match the cards.
      const legendItems = top.map((g, gi) => ({ key: g.key, name: nameOf(g.key), color: PALETTE[gi % PALETTE.length] }))
      if (restTokens > 0) legendItems.push({ key: t('other'), name: t('other'), color: PALETTE[6] })
      const valOf = (b, k) => (b.groups && typeof b.groups[k] === 'number' ? b.groups[k] : 0) // defensive zero-fill
      const series = data
        ? legendItems
          .map((it, li) => ({
            key: it.key,
            name: it.name,
            color: it.color,
            values: li === legendItems.length - 1 && restTokens > 0
              ? data.buckets.map((b) => rest.reduce((a, g) => a + valOf(b, g.key), 0))
              : data.buckets.map((b) => valOf(b, it.key)),
          }))
          .filter((s) => !hidden[s.key])
        : []
      // Cache hit-rate overlay (per bucket; null where no prompt tokens).
      const rateValues = data ? data.buckets.map((b) => (typeof b.cacheHitRate === 'number' ? b.cacheHitRate : null)) : []
      const rate = rateValues.some((v) => typeof v === 'number') ? { values: rateValues, label: t('cacheHit') } : null
      return h('section', { className: 'ul-chartCard' },
        h('div', { className: 'ul-cardHead' },
          h('div', { className: 'ul-secTitle' }, t('dailyTitle')),
          h('div', { className: 'ul-seg' },
            RANGES.map((r) => h('button', {
              key: r.id, type: 'button',
              className: r.id === rangeId ? 'ul-segBtn ul-segActive' : 'ul-segBtn',
              onClick: () => onRange(r.id),
            }, t(r.label))))),
        state.loading || state.error
          ? h(LoadState, { state })
          : !data || totals.length === 0
            ? h('div', { className: 'ul-note' }, t('empty'))
            : h(React.Fragment, null,
              h(LineChart, { keys, granularity: range.granularity, degraded: !!data.degraded, series, animKey: data, rate }),
              h('div', { className: 'ul-legend' },
                legendItems.map((it) => h('button', {
                  key: it.key, type: 'button',
                  className: hidden[it.key] ? 'ul-chip ul-chipOff' : 'ul-chip',
                  onClick: () => setHidden((prev) => ({ ...prev, [it.key]: !prev[it.key] })),
                },
                  h('span', { className: 'ul-swatch', style: { background: it.color } }),
                  it.name)))))
    }

    // ── 52-week heatmap (/heatmap) ─────────────────────────────────────────
    // GitHub-style FULL-RECTANGLE grid: rows = weekday (Monday on top, labeled
    // in a left gutter), columns = weeks; every cell of the rectangle renders
    // — out-of-range and future days as level-0 — so the grid is always a
    // clean slab with no ragged holes. Geometry is measured: a ResizeObserver
    // sizes square cells to the container width (no fixed natural width).
    // Day-tokens heatmap (the day/week/cum mode segment was removed in favor
    // of the 少→多 level legend). The geometry core
    // (heatGeometry/heatRowOf/heatMonthLabels) is mirrored verbatim in
    // src/client/heatgeo.check.mjs with node assertions.
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
      // 少→多 level legend in the card head (replaces the day/week/cum mode
      // segment; the heatmap is day-tokens only now).
      const legend = h('div', { className: 'ul-heatLegend' },
        h('span', null, t('less')),
        [0, 1, 2, 3, 4].map((lv) => h('span', { key: lv, className: `ul-heatKey ul-heat${lv}` })),
        h('span', null, t('more')))
      const stateData = state.data
      const dataBad = !stateData || !stateData.days || stateData.days.length === 0
        || Number.isNaN(heatDayMs(stateData.days[0].day))
      // Empty/loading/error states keep the card frame + title + legend.
      if (state.loading || state.error || dataBad) {
        return h('section', { className: 'ul-chartCard' },
          h('div', { className: 'ul-cardHead' }, h('div', { className: 'ul-secTitle' }, t('heatTitle')), legend),
          state.loading || state.error ? h(LoadState, { state }) : h('div', { className: 'ul-note' }, t('empty')))
      }
      const data = stateData
      const today = dayKeyOf(new Date())
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
      // Day tokens only (the mode segment was replaced by the level legend).
      const valueOf = (c) => (c.d === null ? 0 : c.d.tokens)
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
          legend),
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
              : null)))
    }

    // ── model donut (/daily?group=model groupTotals, 30d window) ──────────
    const DONUT_R = 48
    const DONUT_C = 2 * Math.PI * DONUT_R
    function DonutSection({ tick, rangeId }) {
      // The donut follows the shared range selector (was: fixed 30-day window).
      const range = RANGES.find((r) => r.id === rangeId) || RANGES[2]
      const to = dayKeyOf(new Date())
      const fromDate = new Date(); fromDate.setDate(fromDate.getDate() - (range.days - 1))
      const state = useApi('daily', { from: dayKeyOf(fromDate), to, group: 'model', granularity: 'day' }, [rangeId, tick])
      const rangeSuffix = range.id === 'today' ? t('dwToday') : t('donutRange').replace('{n}', t(range.label))
      const [hover, setHover] = React.useState(null) // { i, x, y } in wrap px
      const wrapRef = React.useRef(null)
      const arcsRef = React.useRef({})
      // Adaptive donut size: measure the card and the (2-col) legend so the
      // donut fills the vertical space left over — more slices → shorter
      // donut; few slices → it grows. Recomputed on data change and resize.
      const cardRef = React.useRef(null)
      const legendRef = React.useRef(null)
      const [donutPx, setDonutPx] = React.useState(0)
      React.useLayoutEffect(() => {
        const el = cardRef.current
        if (!el) return undefined
        const compute = () => {
          const card = el.getBoundingClientRect()
          const legendH = legendRef.current ? legendRef.current.getBoundingClientRect().height : 60
          const byHeight = card.height - 22 - 14 - legendH - 30 // title + gaps + paddings
          const byWidth = card.width * 0.58
          const px = Math.max(110, Math.min(320, Math.min(byWidth, byHeight)))
          setDonutPx((prev) => (Math.abs(prev - px) > 2 ? px : prev))
        }
        compute()
        if (typeof ResizeObserver !== 'function') return undefined
        const ro = new ResizeObserver(compute)
        ro.observe(el)
        return () => ro.disconnect()
      }, [state.data])
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
      const data = state.data
      const totals = data ? data.groupTotals.filter((g) => g.tokens > 0) : []
      // Empty/loading/error states keep the card frame + title.
      if (state.loading || state.error || !data || totals.length === 0) {
        return h('section', { className: 'ul-chartCard', ref: cardRef },
          h('div', { className: 'ul-secTitle' }, `${t('donutTitle')}${rangeSuffix}`),
          state.loading || state.error ? h(LoadState, { state }) : h('div', { className: 'ul-note' }, t('empty')))
      }
      const names = data.groupNames ?? {}
      const top = totals.slice(0, 5)
      const rest = totals.slice(5)
      const restTokens = rest.reduce((a, g) => a + g.tokens, 0)
      const slices = top.map((g, i) => ({ key: g.key, name: names[g.key] ?? g.key, tokens: g.tokens, color: PALETTE[i % PALETTE.length] }))
      if (restTokens > 0) slices.push({ key: t('other'), name: t('other'), tokens: restTokens, color: PALETTE[6] })
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
      return h('section', { className: 'ul-chartCard', ref: cardRef },
        h('div', { className: 'ul-secTitle' }, `${t('donutTitle')}${rangeSuffix}`),
        h('div', { className: 'ul-donutRow' },
          h('div', { className: 'ul-donutWrap', ref: wrapRef, style: donutPx > 0 ? { width: donutPx } : undefined },
            h('svg', {
              viewBox: '0 0 132 132', role: 'img',
              style: { width: '100%', height: 'auto', display: 'block' },
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
                  h('span', { className: 'ul-tipName ul-tipStrong' }, hs.name)),
                h('div', { className: 'ul-tipRow' },
                  `${fmtTok(hs.tokens)} tokens · ${((hs.tokens / sum) * 100).toFixed(1)}%`))
              : null),
          h('div', { className: 'ul-donutLegend', ref: legendRef },
            slices.map((s) => h('div', { key: s.key, className: 'ul-donutItem' },
              h('span', { className: 'ul-swatch', style: { background: s.color } }),
              h('span', { className: 'ul-donutName' }, s.name),
              h('span', { className: 'ul-donutPct' }, `${((s.tokens / sum) * 100).toFixed(1)}%`))))))
    }

    // ── foldable side-by-side cards (tools + sessions) ─────────────────────
    // Collapsed by default; the table child mounts (and fetches) only on first
    // expand. The open body shows exactly ~10 rows and scrolls internally —
    // a FIXED cap (dynamic viewport measurement overshot on tall screens and
    // pushed the whole page into a scrollbar).
    function FoldCard({ title, children }) {
      const [open, setOpen] = React.useState(false)
      return h('section', { className: 'ul-foldCard' },
        h('div', {
          className: 'ul-foldHead', role: 'button', tabIndex: 0,
          'aria-expanded': open,
          onClick: () => setOpen((v) => !v),
          onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v) } },
        },
          h('div', { className: 'ul-secTitle' }, title),
          h('span', { className: open ? 'ul-chev ul-chevOpen' : 'ul-chev', 'aria-hidden': true },
            h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('path', { d: 'M9 6l6 6-6 6' })))),
        open ? h('div', { className: 'ul-foldBody' }, children) : null)
    }

    // ── tool distribution (/tools) ─────────────────────────────────────────
    function ToolsTable({ tick }) {
      const state = useApi('tools', {}, [tick])
      if (state.loading || state.error) return h(LoadState, { state })
      const data = state.data
      const tools = data ? data.tools.slice(0, 12) : []
      if (!data || tools.length === 0) return h('div', { className: 'ul-note' }, t('empty'))
      return h(React.Fragment, null,
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
    function SessionsTable({ tick }) {
      const state = useApi('sessions', { limit: 30 }, [tick])
      if (state.loading || state.error) return h(LoadState, { state })
      const data = state.data
      const rows = data ? data.rows : []
      if (!data || rows.length === 0) return h('div', { className: 'ul-note' }, t('empty'))
      return h(React.Fragment, null,
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
    /** Serialized 2s polling for the session usage tab (token-total's
     *  use-session-detail pattern): at most ONE in-flight request, a
     *  visibilitychange wake-up (becoming visible refetches immediately; the
     *  timer chain itself keeps polling while hidden, exactly like the
     *  reference hook), a manual refresh that never stalls behind an
     *  in-flight poll, the last successful read's wall-clock stamp, and full
     *  cleanup on unmount / session change.
     *  useApi stays single-shot for every other panel; this hook is the only
     *  poller (mirrors useStatus's timer discipline). */
    const SESSION_POLL_MS = 2000
    function useSessionUsage(sessionId) {
      const [state, setState] = React.useState({ data: null, error: null, loading: true, updatedAt: null })
      const refreshRef = React.useRef(null)
      React.useEffect(() => {
        // stale data from a previous session never flashes: reset first
        setState((s) => (s.data === null ? s : { data: null, error: null, loading: true, updatedAt: null }))
        let active = true
        let pending = false
        let wantedNow = false
        let timer = null
        let ac = null
        const request = () => {
          if (!active || pending || !sessionId) return
          if (timer) { clearTimeout(timer); timer = null }
          pending = true
          ac = new AbortController()
          post('session', { id: sessionId }, ac.signal).then(
            (data) => { if (active) setState({ data, error: null, loading: false, updatedAt: Date.now() }) },
            (error) => {
              if (error && error.name === 'AbortError') return
              // keep the last good data (token-total keeps the previous
              // detail); only the "as of" stamp stops advancing
              if (active) setState((s) => ({ ...s, error, loading: false }))
            },
          ).finally(() => {
            pending = false
            // A refresh pressed mid-poll skips the interval and refetches as
            // soon as the in-flight answer lands, so the click never stalls.
            if (active) timer = setTimeout(request, wantedNow ? 0 : SESSION_POLL_MS)
            wantedNow = false
          })
        }
        const wake = () => { if (document.visibilityState === 'visible') request() }
        refreshRef.current = () => { if (pending) wantedNow = true; else request() }
        document.addEventListener('visibilitychange', wake)
        request()
        return () => {
          active = false
          refreshRef.current = null
          if (ac) ac.abort()
          if (timer) clearTimeout(timer)
          document.removeEventListener('visibilitychange', wake)
        }
      }, [sessionId])
      return { ...state, refresh: () => refreshRef.current && refreshRef.current() }
    }

    // cache hit rate from the three prompt buckets: cacheRead / (input +
    // cacheRead + cacheWrite) × 100 — null when there is no prompt volume.
    const hitRateOf = (input, read, write) => {
      const denom = (input || 0) + (read || 0) + (write || 0)
      return denom > 0 ? ((read || 0) / denom) * 100 : null
    }
    const fmtSec = (ms) => (typeof ms === 'number' && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : t('na'))

    // ── the two live cards: current context + token stats (token-total) ────
    // Fixed bucket order (context = first 7, composition = all 8); zero rows
    // are kept so both cards' legends stay aligned. Each bucket carries its
    // own hue via a --ul-bucket class (swatch/ring/segment/value read one var).
    const BUCKET_ORDER = ['systemPrompt', 'user', 'skill', 'toolResult', 'toolDef', 'injected', 'assistant', 'output']
    const BUCKET_LABEL = {
      systemPrompt: 'bucketSystemPrompt', user: 'bucketUser', skill: 'bucketSkill',
      toolResult: 'bucketToolResult', toolDef: 'bucketToolDef', injected: 'bucketInjected',
      assistant: 'bucketAssistant', output: 'bucketOutput',
    }
    const BUCKET_TONE = {
      systemPrompt: 'ul-tone-systemPrompt', user: 'ul-tone-user', skill: 'ul-tone-skill',
      toolResult: 'ul-tone-toolResult', toolDef: 'ul-tone-toolDef', injected: 'ul-tone-injected',
      assistant: 'ul-tone-assistant', output: 'ul-tone-output',
    }
    // rows in fixed order, missing buckets zero-filled, output excluded for
    // the 7-bucket context card
    const bucketRows = (buckets, keys) => keys.map((key) => ({
      key, tokens: (buckets ?? []).find((b) => b && b.key === key)?.tokens ?? 0,
    }))
    const CONTEXT_KEYS = BUCKET_ORDER.filter((k) => k !== 'output')
    const approxTok = (n) => `≈${fmtTok(n)}`

    /** One legend row: swatch, name, share percent, approximate value. */
    function UcLegendRow({ row, percent, suffix }) {
      return h('div', { className: `ul-ucRow ${BUCKET_TONE[row.key]}` },
        h('span', { className: 'ul-ucSwatch', 'aria-hidden': true }),
        h('span', { className: 'ul-ucName' }, t(BUCKET_LABEL[row.key])),
        h('span', { className: 'ul-ucPct' }, fmtPct(percent)),
        h('span', { className: 'ul-ucVal', title: fmtInt(row.tokens) },
          approxTok(row.tokens),
          suffix ? h('span', { className: 'ul-ucSuffix' }, ` · ${suffix}`) : null))
    }

    // Ring geometry: a 116 px donut with a 15 px stroke (DonutSection style).
    const UC_RING_SIZE = 116
    const UC_RING_STROKE = 15
    const UC_RING_R = (UC_RING_SIZE - UC_RING_STROKE) / 2 - 2
    const UC_RING_C = 2 * Math.PI * UC_RING_R

    /** Donut of bucket shares with the billed total in the middle. Segments
     *  stroke one circle, offset by the running length; a hairline gap keeps
     *  adjacent hues apart, and a segment never shrinks below 0.6 px. */
    function UcRing({ rows, total, center, centerTitle, caption }) {
      let offset = 0
      return h('div', { className: 'ul-ucRingWrap' },
        h('svg', { width: UC_RING_SIZE, height: UC_RING_SIZE, viewBox: `0 0 ${UC_RING_SIZE} ${UC_RING_SIZE}`, role: 'img', 'aria-label': caption },
          h('circle', { className: 'ul-ucRingTrack', cx: UC_RING_SIZE / 2, cy: UC_RING_SIZE / 2, r: UC_RING_R, strokeWidth: UC_RING_STROKE }),
          h('g', { transform: `rotate(-90 ${UC_RING_SIZE / 2} ${UC_RING_SIZE / 2})` },
            rows.filter((row) => row.tokens > 0).map((row) => {
              const length = total > 0 ? (row.tokens / total) * UC_RING_C : 0
              const visible = Math.max(length - 1.2, 0.6)
              const seg = h('circle', {
                key: row.key, className: `ul-ucRingSeg ${BUCKET_TONE[row.key]}`,
                cx: UC_RING_SIZE / 2, cy: UC_RING_SIZE / 2, r: UC_RING_R, strokeWidth: UC_RING_STROKE,
                strokeDasharray: `${visible} ${UC_RING_C - visible}`,
                strokeDashoffset: -offset,
              })
              offset += length
              return seg
            }))),
        h('div', { className: 'ul-ucRingCenter' },
          h('strong', { className: 'ul-ucRingTotal', title: centerTitle }, center),
          h('span', { className: 'ul-ucRingCaption' }, caption)))
    }

    /** Left card: the live window's composition, its occupancy and the cap.
     *  The headline is the billed prompt when the log has one (exact), else
     *  the replay estimate (contextReading semantics from token-total). */
    function ContextCard({ context }) {
      const rows = bucketRows(context.buckets, CONTEXT_KEYS)
      const drawn = rows.reduce((a, r) => a + r.tokens, 0)
      const used = typeof context.promptTokens === 'number' && Number.isFinite(context.promptTokens)
        ? context.promptTokens
        : context.totalTokens
      const hasWindow = typeof context.contextWindow === 'number' && context.contextWindow > 0
      const capacity = hasWindow ? context.contextWindow : drawn
      const occupied = capacity > 0 ? Math.min(100, (used / capacity) * 100) : 0
      const windowPct = hasWindow && used >= 0 ? Math.min(100, (used / context.contextWindow) * 100) : null
      const share = (n) => (drawn > 0 ? (n / drawn) * 100 : 0)
      return h('section', { className: 'ul-ucCard' },
        h('div', { className: 'ul-ucHead' },
          h('div', { className: 'ul-ucTitle' }, t('currentContextTitle')),
          h('span', { className: 'ul-ucModel', title: `${context.provider} / ${context.model}` },
            [context.provider, context.model].filter(Boolean).join(' · ') || t('na'))),
        h('div', { className: 'ul-ucBody' },
          h('div', { className: 'ul-ucTotalRow' },
            h('span', { className: 'ul-ucTotal', title: fmtInt(used) },
              (hasWindow ? t('contextWindowTotal') : t('contextWindowTotalUnknown'))
                .replace('{used}', fmtTok(used)).replace('{window}', hasWindow ? fmtTok(context.contextWindow) : '')),
            windowPct !== null ? h('span', { className: 'ul-ucShare' },
              h('b', null, fmtPct(windowPct)), ` ${t('contextUsedShort')}`) : null),
          // One stacked strip across the whole window: a bucket's width is its
          // share of the drawn content scaled by how full the window is, so
          // the tinted run stops where "used" stops; the rest is free room.
          h('div', { className: 'ul-ucBar' },
            drawn > 0
              ? rows.map((row) => row.tokens > 0
                ? h('span', { key: row.key, className: `ul-ucBarSeg ${BUCKET_TONE[row.key]}`, style: { width: `${(share(row.tokens) * occupied) / 100}%` } })
                : null)
              : h('span', { className: 'ul-ucBarEmpty' })),
          h('div', { className: 'ul-ucLegend' },
            rows.map((row) => h(UcLegendRow, { key: row.key, row, percent: share(row.tokens) })))))
    }

    /** Right card: every request's replayed content plus the billed output.
     *  Cache-hit badge comes from the exact totals, two decimals. */
    function StatsCard({ composition }) {
      const hasComp = composition !== null && composition !== undefined
      const rows = bucketRows(composition?.buckets, BUCKET_ORDER)
      const total = rows.reduce((a, r) => a + r.tokens, 0)
      const billed = composition?.billedTokens ?? 0
      const hit = hasComp
        ? hitRateOf(composition.totals.inputTokens, composition.totals.cacheReadTokens, composition.totals.cacheWriteTokens)
        : null
      return h('section', { className: 'ul-ucCard' },
        h('div', { className: 'ul-ucHead' },
          h('div', { className: 'ul-ucTitle' }, t('statsTitle')),
          hit !== null ? h('span', { className: 'ul-ucCache' },
            `${t('statsCacheHit')} `, h('b', null, `${hit.toFixed(2)}%`)) : null),
        h('div', { className: 'ul-ucBody' },
          !hasComp
            ? h('div', { className: 'ul-ucEmpty' }, t('statsEmpty'))
            : h('div', { className: 'ul-ucStats' },
                h(UcRing, { rows, total, center: fmtTok(billed), centerTitle: fmtInt(billed), caption: t('statsTotal') }),
                h('div', { className: 'ul-ucLegend' },
                  rows.map((row) => h(UcLegendRow, {
                    key: row.key, row, percent: total > 0 ? (row.tokens / total) * 100 : 0,
                    suffix: row.key === 'output' ? t('statsIncludesThinking') : null,
                  }))))))
    }

    /** The pair: context on the left, stats on the right. No context →
     *  single stats card; neither → nothing at all. */
    function UsageCards({ context, composition }) {
      if (context == null) {
        if (composition == null) return null
        return h('div', { className: 'ul-svGrid' }, h(StatsCard, { composition }))
      }
      return h('div', { className: 'ul-svGrid' },
        h(ContextCard, { context }),
        h(StatsCard, { composition }))
    }

    // 命中率单元格：分档配色对齐 token-total（≥80 绿 / ≥50 黄 / <50 红 /
    // null 灰）。表格列传入 className 保留数字对齐样式。
    const hitClassOf = (rate) => (rate === null ? 'ul-cellDim' : rate >= 80 ? 'ul-hit' : rate >= 50 ? 'ul-hitWarn' : 'ul-hitBad')
    function HitCell({ rate, className = '' }) {
      return h('span', { className: `${className} ${hitClassOf(rate)}`.trim() },
        rate === null ? t('na') : fmtPct(rate))
    }

    function SessionUsageView({ sessionId }) {
      const { data, error, loading, refresh, updatedAt } = useSessionUsage(sessionId)
      // Freshness header: the view polls continuously, so it always shows a
      // live dot with the time of the last successful read, plus a manual
      // refresh that refetches immediately (token-total's head row).
      const head = h('div', { className: 'ul-svHead' },
        h('span', { className: 'ul-svLive' },
          h('span', { className: 'ul-liveDot' }),
          t('svLive'),
          updatedAt !== null ? h('span', { className: 'ul-svAsOf' }, `${t('svAsOf')} ${fmtClock(updatedAt)}`) : null),
        h('button', { type: 'button', className: 'ul-svRefresh', onClick: refresh },
          h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
            h('path', { d: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8' }),
            h('path', { d: 'M21 3v5h-5' })),
          t('svRefresh')))
      if (!data) {
        return h('div', { className: 'ul-session' },
          h('style', null, CSS),
          h('div', { className: 'ul-svPage' },
            head,
            h('div', { className: 'ul-scopeNote' }, t('svScope')),
            loading || error
              ? h(LoadState, { state: { loading, error, retry: refresh } })
              : h('div', { className: 'ul-note' }, t('empty'))))
      }
      const d = data
      const hit = hitRateOf(d.totals.inputTokens, d.totals.cacheReadTokens, d.totals.cacheWriteTokens)
      const failRate = d.requests > 0 ? ((d.failures / d.requests) * 100).toFixed(1) : '0.0'
      // degraded: children come from the permanent KV rollups, so they stay;
      // byModel needs SQLite detail, so it is empty (banner explains).
      const children = d.children ?? []
      const byModel = d.degraded ? [] : d.byModel ?? []
      const hitOf = (r) => hitRateOf(r.inputTokens, r.cacheReadTokens, r.cacheWriteTokens)
      return h('div', { className: 'ul-session' },
        h('style', null, CSS),
        h('div', { className: 'ul-svPage' },
          head,
          h('div', { className: 'ul-scopeNote' }, t('svScope')),
          error ? h('div', { className: 'ul-error' },
            h('span', null, `${t('loadError')}: ${error.message}`),
            h('button', { type: 'button', onClick: refresh }, t('retry'))) : null,
          // six metric cards, aligned with token-total's Metrics row (no
          // section title — the original goes straight into the cards)
          h('section', { className: 'ul-sec' },
            h('div', { className: 'ul-cards' },
              h(Card, {
                label: t('requests'), icon: cardIcon(CARD_ICON_D.requests), tone: 'ul-icBlue',
                value: fmtInt(d.requests), sub: `${t('failures')} ${fmtInt(d.failures)} · ${failRate}%`,
              }),
              h(Card, {
                label: t('svTokens'), icon: cardIcon(CARD_ICON_D.tokens), tone: 'ul-icPurple',
                value: fmtTok(d.totals.tokens), title: fmtInt(d.totals.tokens),
                sub: `${fmtInt(d.totals.tokens)} ${t('sTok')}`,
              }),
              h(Card, {
                label: t('inputTok'), icon: cardIcon(CARD_ICON_D.input), tone: 'ul-icTeal',
                value: fmtTok(d.totals.inputTokens), title: fmtInt(d.totals.inputTokens), sub: fmtInt(d.totals.inputTokens),
              }),
              h(Card, {
                label: t('outputTok'), icon: cardIcon(CARD_ICON_D.output), tone: 'ul-icOrange',
                value: fmtTok(d.totals.outputTokens), title: fmtInt(d.totals.outputTokens), sub: fmtInt(d.totals.outputTokens),
              }),
              h(Card, {
                label: t('cacheHit'), icon: cardIcon(CARD_ICON_D.hit), tone: 'ul-icGreen',
                value: h(HitCell, { rate: hit }),
                sub: hit === null ? null : `${fmtTok(d.totals.cacheReadTokens)} ${t('svCacheHitShort')}`,
              }),
              h(Card, {
                label: t('decodeSpeed'), icon: cardIcon(CARD_ICON_D.speed), tone: 'ul-icOrange',
                value: d.tokensPerSecond == null ? t('na') : `${Math.round(d.tokensPerSecond)} ${t('svTokPerSec')}`,
                sub: `${t('avgTtft')} ${fmtSec(d.avgFirstTokenMs)}`,
              }))),
          d.degraded ? h('div', { className: 'ul-banner' }, t('svDegraded')) : null,
          // sub-session | models: side by side, half width each (token-total .mid)
          h('div', { className: 'ul-mid' },
            h('section', { className: 'ul-sec' },
              h('div', { className: 'ul-secTitle' }, t('svChildren'),
                h('span', { className: 'ul-count' }, fmtInt(children.length))),
              children.length === 0
                ? h('div', { className: 'ul-note' }, t('svNoChildren'))
                : h(React.Fragment, null,
                    h('div', { className: 'ul-table ul-chHead' },
                      h('span', null, t('sName')), h('span', null, t('sReq')), h('span', null, t('sTok')),
                      h('span', null, t('svHit')), h('span', null, t('avgTtft')), h('span', null, t('svTokSpeed')), h('span', null, t('sKind'))),
                    children.map((c) => h('div', { key: c.id, className: 'ul-table ul-chRow' },
                      h('span', { className: 'ul-cellName', title: c.name || c.id }, c.name || c.id),
                      h('span', { className: 'ul-cellNum2' }, fmtInt(c.requests)),
                      h('span', { className: 'ul-cellNum2' }, fmtTok(c.tokens)),
                      h(HitCell, { className: 'ul-cellNum2', rate: hitOf(c) }),
                      h('span', { className: 'ul-cellNum2' }, fmtSec(c.avgFirstTokenMs)),
                      h('span', { className: 'ul-cellNum2' }, c.tokensPerSecond == null ? t('na') : fmtSpeed(c.tokensPerSecond)),
                      h('span', null, t(KIND_LABEL[c.kind] || 'kindMain')))))),
            h('section', { className: 'ul-sec' },
              h('div', { className: 'ul-secTitle' }, t('svModels'),
                h('span', { className: 'ul-count' }, fmtInt(byModel.length))),
              byModel.length === 0
                ? h('div', { className: 'ul-note' }, t('svNoModels'))
                : h(React.Fragment, null,
                    h('div', { className: 'ul-table ul-mdHead' },
                      h('span', null, t('svModel')), h('span', null, t('sReq')),
                      h('span', null, t('inputTok')), h('span', null, t('outputTok')),
                      h('span', null, t('cacheReadTok')), h('span', null, t('cacheWriteTok')),
                      h('span', null, t('svHit'))),
                    byModel.map((m) => {
                      // display name when the wire carries one, route id otherwise;
                      // neither resolvable → the unknown placeholder, never "?"
                      const hasName = typeof m.name === 'string' && m.name.trim()
                      const hasModel = typeof m.model === 'string' && m.model.trim()
                      const name = hasName ? m.name : (hasModel ? m.model : t('svUnknownModel'))
                      // logo = first letter/digit badge; unknown row gets a
                      // colored dot instead
                      const letter = hasName || hasModel
                        ? ((name.match(/[a-z0-9]/i) || ['?'])[0]).toUpperCase()
                        : null
                      return h('div', { key: `${m.provider}/${m.model}`, className: 'ul-table ul-mdRow' },
                        h('span', { className: 'ul-mdNameCell' },
                          h('span', {
                            className: letter === null ? 'ul-mdLogo ul-mdLogoDot' : 'ul-mdLogo', 'aria-hidden': true,
                          }, letter),
                          h('span', { className: 'ul-cellName', title: m.model || name }, name)),
                        h('span', { className: 'ul-cellNum2' }, fmtInt(m.requests)),
                        h('span', { className: 'ul-cellNum2' }, fmtTok(m.inputTokens)),
                        h('span', { className: 'ul-cellNum2' }, fmtTok(m.outputTokens)),
                        h('span', { className: 'ul-cellNum2' }, fmtTok(m.cacheReadTokens)),
                        h('span', { className: 'ul-cellNum2' }, fmtTok(m.cacheWriteTokens)),
                        h(HitCell, { className: 'ul-cellNum2', rate: hitOf(m) }))
                    })))),
          // the two live cards close the page (tool chips removed on user request)
          h(UsageCards, { context: d.context ?? null, composition: d.composition ?? null })))
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
      // Range selector is shared by the daily line chart AND the donut.
      const [rangeId, setRangeId] = React.useState('today')
      return h('div', { className: 'ul-page' },
        h('style', null, CSS),
        showBack ? h('div', { className: 'ul-backRow' },
          h('button', { type: 'button', className: 'ul-back', onClick: goBack }, `← ${t('back')}`)) : null,
        h('div', { className: 'ul-panel' },
          h(StatusBanner, { status }),
          h(SummaryCards, { tick: refreshTick }),
          h(HeatmapSection, { tick: refreshTick }),
          h('div', { className: 'ul-mixGrid' },
            h(DonutSection, { tick: refreshTick, rangeId }),
            h(DailySection, { tick: refreshTick, rangeId, onRange: setRangeId })),
          h('div', { className: 'ul-foldGrid' },
            h(FoldCard, { title: t('toolsTitle') }, h(ToolsTable, { tick: refreshTick })),
            h(FoldCard, { title: t('sessTitle') }, h(SessionsTable, { tick: refreshTick })))))
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
