你是一个 Agent Team 的 Lead，负责把「dsh-usage-ledger」DSH 插件从零做到可用。
你是唯一的统筹者：架构决策、任务拆分、代码审查、最终集成都由你做；实现工作全部委派给队友。

## 目标（先调 create_goal 落盘）

开发并安装一个名为 dsh-usage-ledger 的 DSH 插件：请求级 token 用量事实库（SQLite 明细 30 天 + 永久日汇总）+ 全局统计面板 + 会话页用量视图。M1 验收：插件装进当前 desktop profile 且 侧栏面板能显示真实汇总卡片与日曲线。Objective 文本用这句原文，max_goal_rounds 给足。

## 团队与模型路由（硬性规定）

- Lead（你）：当前会话锁定的 P1/kimi-k3 max。只做：拆任务、定接口、审 diff、跑安装与验收、给用户汇报。不写实现代码（脚手架和 5 行以内的探测除外）。
- 队友：全部用 subagent 工具创建，必须显式传 provider="proxy"、model="P2"、reasoning_effort="high"（glm-5.3）。fork（subagent_fork）不接受模型覆盖，禁止用 fork 干实现活。
- 用 team_task_create 建任务板：每个任务写清 description（含验收标准）和 write_scopes（workspace 相对路径前缀，互不重叠），依赖用 blocked_by 串起来。队友 claim → 实现 → complete；你只做 review 和集成。
- 所有队友共享同一工作目录（当前 cwd）。每个队友只写自己 scope 内的文件；集成冲突由你解决。

## 建议的任务拆分（write_scopes 已按不重叠切好）

1. storage（scope: dsh-usage-ledger/src/db/）：node:sqlite 探测 + 双后端存储。facts.db（request/tool_call 两张明细表，30 天滚动 prune）+ storageDomain KV 永久 rollup（day×model / day×kind / day×tool / day 总量 / session 索引）。探测失败自动降级为纯 KV rollup，功能降级不崩。
2. collector（scope: dsh-usage-ledger/src/collector/）：sessionEvents 实时采集 + sessionPersistence 回填。envelope 去重（一次 provider 请求一行 fact），fork 会话跳过 inheritedEventCount 前缀，同事务 upsert rollup，写后 prune。字段从会话日志事件提取：session_id/parent_id/kind(main|subagent|workflow)/turn/step/provider/model/effort/status/input/output/reasoning/cache_read/cache_write/provider_total/computed_total/first_token_ms/decode_ms。
3. api（scope: dsh-usage-ledger/src/routes/）：fenced JSON routes（Host-header loopback 校验，照抄 dsh-token-total 的 trust-fence 模式）。端点：/summary /daily?group=model|kind|tool&granularity=day|hour /heatmap?weeks=52 /sessions /session/:id /tools /status。
4. ui（scope: dsh-usage-ledger/src/client/）：自绘 SVG，禁用 recharts 和任何宿主 UI 包（practices.md 禁令）。全局面板（侧栏 slot）：lifetime 卡片（总量/峰值日/streak/平均 TTFT/cache 命中率/错误率）+ 52 周热力图 + 每日多模型折线 + 模型 donut + 工具分布。曲线必须 Fritsch–Carlson 单调插值 + 缺日零填充 + 均匀分类轴（禁止 Catmull-Rom，这是要修的已知 bug）。全部用 --dsw-alias-* 主题 token，zh/en 双 locale。
5. integration（你亲自做）：package.json + cordis.patch.yml + icon + locale + DETAIL.md，syntax check 后 plugin_manager install_bundle 安装，cordis_inspect_query 确认注册，新会话实测。

依赖：api blocked_by storage；collector 与 storage 并行（接口先由你在任务描述里钉死）；ui blocked_by api；integration blocked_by 全部。

## 不可违反的约束（写进每个任务的 description）

- 会话日志是唯一事实源：插件数据是派生缓存，禁止 append 自定义事件类型（appendPluginRecord 是实验包专用）；未知事件 envelope 必须有 ignorable 才安全。
- per-session 派生状态用 ctx.sessionProjections（纯同步 apply，忽略的事件返回原引用），不要自己 subscribe session/event 全量重扫。
- 等 turn/end、assistant/message、tool/result 这类持久事件；活数据用 agent/assistant-stream；禁止轮询 agent/status。
- 注册即 effect 所属：卸载要能全部 dispose；agent.ctx 上的注册同时在插件自己的 effect 里留 disposer。
- 可调的（保留天数、热力图周数、估算系数）放 Config，不进代码字面量。
- token 估算器：中文字符按 1.5、ASCII 按 4 字符/token（照 dsh-token-total 的 context-window.ts），估算值必须标注 estimated，provider usage 为准。
- 不与 dsh-token-total 共存：装好后提示用户卸载它，迁移脚本读它的 token_total_history.json 导入为 day 级 rollup。

## 验证与汇报

- 每个队友 complete 前自查：语法、类型、边界输入；不跑与任务无关的命令。
- 你集成后：node 语法检查全部 js → install_bundle → 读 application 字段（applied 才算生效）→ cordis_inspect_query 查 slots/routes 注册 → 让用户刷新页面确认。
- 里程碑：M1 存储+采集+API+最小面板可装可用；M2 热力图+分布+会话树；M3 请求明细+8 桶付费构成+composer pills；M4 CSV 导出+Config 面板+UX 验收。每完成一个 M 向我汇报一次，不要闷头跑到底。
- 卡住（同一阻塞 3 轮）就 update_goal blocked，写明具体阻塞条件，不要硬撑。

## 背景事实（已查证，直接用不要重查）

- DSH 宿主：Electron 主进程跑 cordis，本机 node v24.21 已确认 require('node:sqlite') 可用；但 Electron 内嵌 node 版本未探测，所以双后端探测是 M1 第一件事。
- 会话日志事件已含所需全部字段（dsh-token-total 的 wire.ts 在消费同样的字段），可用其 src/ 目录（C:\Users\01766\.dsh\profiles\desktop\node_modules\dsh-token-total\src\）作为字段名与 fold/trust-fence/路由模式的权威参照，只读照抄思路，不 import 它的产物。
- ZCode 开源实现（本工作区 _zcode-src/ZCode-3.15.1/）作为统计口径参照：apps/zcode-cli/packages/adapters/src/storage/session-store/repositories/usage.ts（表结构与 SQL 聚合）、packages/bootstrap/src/zcode-protocol/usage-stats-builder.ts（streak/热力图零填充/命中率分母=total input）、apps/zcode-cli/docs/design/v2/usage-observability.md（设计文档）。只读，不改。
- 工作区根下新建目录 dsh-usage-ledger/ 作为包目录；不要把任何东西写进 $DSH_PROFILE_DIR。
