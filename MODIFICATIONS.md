# MODIFICATIONS — TT工作台 (TT-Workbench) 相对上游的修改清单

> 基线上游:`WAINAO-Haaper/talos-plugin` @ commit `fb365d0`(v0.4.9,2026-10-13)。
> 本清单满足 TALOS Personal Use Source License 1.0 第 2 节"modified files are clearly identified"的要求,由 `git diff --name-status fb365d0 HEAD` 精确生成。
> **未修改**:`LICENSE`、`THIRD-PARTY-NOTICES.md`、`THIRD-PARTY-LICENSES.txt`、`MaShanZheng-*`、全部 vendor 快照(逐字节一致,已由 .gitattributes 钉死)。
> **阅读口径**:本文件按批次追加,同一事项在不同批次可能更新状态;出现冲突时以**最新批次**的小节为准。

## 新增文件(2)

| 文件 | 内容 |
|---|---|
| `.gitattributes` | 统一 LF 换行;`LICENSE`、`THIRD-PARTY-*`、vendor 快照按字节豁免转换(修复 Windows checkout 破坏 vendor SHA-256 完整性校验的问题) |
| `docs/CODE-REVIEW-TT.md` | 定制基线全方位代码审查报告(冗余/重构/优化/重写四类,含行级判定依据) |

## 删除文件(2)——审查结论 R1/R2:全仓库零引用死代码

| 文件 | 依据 |
|---|---|
| `src/agent-workbench/core/runtime-supervisor.ts` | `RuntimeSupervisor` 在 src/ 与 tests/ 中零引用 |
| `src/agent-workbench/security/provider-egress-bridge.ts` | `ProviderEgressBridge` 在 src/ 与 tests/ 中零引用 |

## 修改文件(50)

### 身份与元数据(6)

| 文件 | 修改内容 |
|---|---|
| `manifest.json` | 插件 id `talos`→`tt-workbench`,名称 `TALOS`→`TT工作台`,版本 `1.0.0`,描述注明"基于 TALOS 定制",作者注明原项目作者 |
| `package.json` | 包名 `tt-workbench`,版本 `1.0.0`,描述与 keywords 更新 |
| `versions.json` | 追加 `"1.0.0": "1.11.4"`(上游历史条目原样保留) |
| `AGENTS.md` | 插件标识段更新为 tt-workbench / TT工作台 / 1.0.0,注明定制来源 |
| `.github/workflows/ci.yml` | 构建产物名 `talos-build`→`tt-workbench-build`(流程步骤未改) |
| `esbuild.config.mjs` | bundle banner 顶部新增 TT-Workbench fork 声明;原 TALOS 许可横幅逐字保留 |

### UI 标题与用户可见文案(33)

全部为"指代插件自身"的字符串品牌化(TALOS→TT/TT工作台);**vault 数据语境**(`04-项目/TALOS系统/`、`TALOS中枢/`、`.talos/`)与 **TalosBall 资产名**(`TALOS Ball`)按合同保留:

- `src/view.ts` — 视图标题"TT工作台控制台"、加载失败标题、控制台错误日志、状态桥面板标题、"已填入 TT 对话"提示
- `src/main.ts` — Ribbon"打开 TT工作台控制台"、3 处错误消息、AI 对话失败日志、初始化提示;移除因插件 id 更名而失效的 `eslint-disable` 指令(保留 canonical 合同注释)
- `src/plugin/chat-sidebar-view.ts` — 侧栏标题"TT 对话"与加载失败标题
- `src/agent-workbench/ui/talos-agent-recovery-view.ts` — 恢复视图标题"TT AI 对话"
- `src/settings.ts` — 设置主标题"TT 系统控制台"、分类 aria-label、经典/Lens 选项文案、主题描述、状态桥开关、导入 fork 声明常量;页脚追加 `TT_WORKBENCH_FORK_NOTICE`(原版权行保留)
- `src/legal.ts` — 新增 `TT_WORKBENCH_FORK_NOTICE` 导出(原三个版权常量逐字保留)
- `src/ui/welcome-easter-egg.ts` — 欢迎页三段文案改为 TT工作台 定位与上游署名说明;联系区块改为"原项目与作者(TALOS)";标题与 aria-label 更新;上游仓库链接保留
- `src/ui/view-chrome.ts` — 品牌字块 `TALOS\nDATA\nCORE`→`TT\n...`、页脚"TT WORKBENCH · AURORA EDITION"、标题解析正则兼容 `TT工作台|TT|TALOS` 前缀
- `src/ui/lens/lens-console.ts` — Lens 品牌字"TT工作台"
- `src/ui/lens/lens-overview.ts` — 状态桥关闭提示
- `src/ui/navigation-model.ts` — "TT 产品"导航项与"TT 发布闸门"副标题
- `src/ui/pages/workspace-pages.ts` — 设置页标题、Harness/语音挂载日志、恢复视图提示、"TT 产品"/"TT 资产"页题
- `src/ui/pages/today-page.ts` — 执行卡"TT 本地运行时"与"同一 TT runner"
- `src/ui/provider-center.ts`、`src/ui/console-action-panel.ts` — aria-label
- `src/ui/quick-note.ts` — 快速笔记 tag `[TT, quick-note]`
- `src/data/navigation.ts` — "TT 资产"标签(匹配上述页题)
- `src/actions.ts` — 三处决策记录 `operator: "TALOS"`→`"TT"`
- `src/inbox-triage.ts` — "AI 控制台"规则 hint
- `src/action-core/builtin-actions.ts` — 刷新动作描述
- `src/agent-workbench/ui/*`(7 文件) — 会话默认名"TT 会话"、空态问候、回复者名"TT"、aria-label、composer 占位符、本地预览白名单提示、命名空间/生命周期错误消息、"TT Exports"导出目录
- `src/agent-workbench/core/*`(2)、`src/agent-workbench/discovery/desktop-runtime-factory.ts`、`src/agent-workbench/transports/claude-sdk-port.ts` — 错误消息与权限拒绝提示
- `src/quyuan/voice-panel.ts` — 屈原人格默认文本、工具说明、审计/生命周期日志(aria 中的 TalosBall 资产名保留)
- `src/quyuan/voice-character-stage.ts`、`src/quyuan/voice-data-map.ts` — 日志与错误消息
- `src/bootstrap/vault-bootstrap.ts` — 命令摘要
- `src/plugin/inline-edit-command.ts` — "TT 行内编辑"命令名(命令 id 未改)
- `src/plugin/plugin-support.ts` — 问答弹窗标题
- `src/plugin/action-runtime.ts` — 行动记录文件标题
- `src/plugin/provider-runtime.ts` — 审批拒绝提示
- `src/plugin/first-run.ts` — 首次运行提示与日志
- `src/plugin/quyuan-diagnostics.ts` — 诊断报告标题/tags/正文品牌化
- `src/plugin/quyuan-workbench-init.ts` — 平台错误与初始化日志
- `src/harness/dsh-process-manager.ts` — supervisor 日志

### 测试同步(3)

| 文件 | 修改内容 |
|---|---|
| `tests/chat-message-roles.test.ts` | 源码文本断言同步为 `name.textContent = "TT";` |
| `tests/claudian-sidebar-layout.test.ts` | 源码文本断言同步为 `titleText.textContent = "TT"` |
| `tests/voice-readonly-policy.test.ts` | 语音只读策略断言同步为 TT 品牌(策略工具清单语义不变) |

## 1.1.0 — 运行时收敛与 Provider/语音重设计(相对 1.0.0)

### 删除(运行时链)

- `src/agent-workbench/adapters/claude/`、`adapters/codex/`:Claude Agent SDK 与 Codex app-server 适配器
- `transports/claude-sdk-port.ts`、`claude-sdk-entry.ts`、`codex-process-port.ts`、`json-line-rpc-connection.ts`:对应传输层
- `security/codex-permission-profile.ts`:由 `security/vault-protected-subpaths.ts`(新增)取代并扩展为通用模块
- `scripts/check-claude-sdk-split.mjs`、`patches/apply-sdk-electron-patch.mjs`:SDK 拆包守卫与 Electron 补丁
- `@anthropic-ai/claude-agent-sdk` 依赖与 postinstall;esbuild 收敛为单一 main.js 入口
- `agent-workbench/core/workbench-controller.ts` 及其测试(1.0.0 审查 R3:仅测试引用的旧路径)

### 新增

- `src/quyuan/realtime-provider.ts`:Realtime 语音 Provider 抽象(百炼预设 + OpenAI 兼容,端点校验/密钥引用/白名单单一事实源)
- `src/agent-workbench/security/vault-protected-subpaths.ts`:通用 Vault 保护区(OhMyPi 沙箱首次启用 deniedVaultSubpaths + denyDotEnvFiles)

### 重设计

- `contracts/runtime-adapter.ts`:RuntimeId 收窄为 "ohmypi"(历史 claude/codex 会话按未知运行时只读降级)
- `contracts/provider-profile.ts`:校验只接受 ohmypi 运行时
- `config/talos-provider-profiles.ts`:注册表只产出 anthropic-api / openai-compatible 两个 Direct API profile(均挂 ohmypi)
- `discovery/desktop-runtime-factory.ts`:删除 claude/codex 构造分支;providerEnvironmentForRuntime 对 ohmypi 返回空环境(密钥由 OhMyPi 自身配置管理)
- `discovery/runtime-discovery-service.ts`、`node-runtime-probe-host.ts`:仅 OhMyPi 规格
- `core/agent-workbench-service.ts`、`storage/workbench-settings-store.ts`:默认运行时与出口白名单收敛
- `ui/talos-agent-workbench.ts`、`ui/model-switcher-presentation.ts`、`ui/runtime-install-card.ts`:运行时切换器/模型展示单运行时化
- `plugin/provider-runtime.ts`、`ui/provider-center.ts`:Windows Direct API 回退与 engineProvider 映射改指 ohmypi facade
- `plugin/custom-api-modal.ts`、`config/custom-api.ts`:自定义 API 目标改为 Direct API 语义(openai 走 openaiBaseUrl/openaiApiKey)
- `plugin/quyuan-voice-tools.ts`:exchangeQuyuanRealtimeSdp 双 Provider 实现(百炼单步 / OpenAI 兼容两步握手,失败关闭)
- `quyuan/qwen-realtime-voice.ts`:exchangeSdp 传递 voice;qwen 专用 ASR 转写模型条件下发
- `quyuan/voice-panel.ts`:会话参数解析统一走 realtime-provider;审计 providerId 动态化
- `settings.ts`:新增 quyuanRealtimeProviderKind/Endpoint/SecretRef 字段与设置 UI;codex 系字段转迁移兼容
- `jarvis/engine-types.ts`:以本地结构类型取代 @anthropic-ai/claude-agent-sdk 类型导入

### 测试

- 删除:agent-workbench-adapters / agent-workbench-jsonl-rpc / claude-sdk-lazy-load / sdk-electron-patch / agent-workbench-model-switcher(随适配链)
- 重写:provider-profiles(单运行时注册表契约)、discovery×2(ohmypi 状态覆盖)、settings(同值 selectRuntime 语义)、security/native-runtime-policy(OhMyPi 沙箱防护)、custom-api / provider-center / facade-adapter(ohmypi 目标)、voice-readonly-policy(新密钥读取路径)

**破坏性变更**:Claude 与 Codex 本机运行时不再可用;相关旧设置字段仅作数据迁移兼容,不再参与装配。

## 1.2.0 — 审查结论落地(批次二:冗余清理与性能优化,相对 1.1.0)

### 删除文件(20)

**本地 ASR 死链(生产不可达,审查 R5/R6)**
- `src/quyuan/local-asr.ts`、`cloud-asr.ts`、`vad-mic.ts`、`vad-turn.ts`、`silero-vad.ts`、`bundled-local-voice-runtime.ts`、`sherpa-local-asr-runtime.ts`
- `src/quyuan/vendor/local-voice-runtime/`(6 文件,138KB 文本快照)
- `src/quyuan/voice-tool-gateway.ts`

**背景动画三件套(审查 R4,含悬空设置项)**
- `src/quyuan/background-field.ts`、`grid-scan-field.ts`、`letter-glitch-field.ts`

**仅测试引用的旧路径(审查 R3)**
- `src/agent-workbench/core/conversation-management-service.ts`

**测试**
- `tests/local-voice-supply-chain.test.ts`、`tests/voice-mode-fallback.test.ts`

### 修改

| 文件 | 内容 |
|---|---|
| `settings.ts` / `main.ts` | 移除 `quyuanBackground` 字段、类型与规范化分支(悬空 UI 选项) |
| `ui/native-conversation-view.ts` | P1:搜索输入 250ms 防抖;`cachedHistoryProjection` 以 updatedAt 为键缓存投影(上限 256 条);destroy 清理定时器与缓存 |
| `storage/portable-conversation-store.ts` | P2:新增 `readIndex/upsertIndexEntry/removeIndexEntry`;create/updateManifest/discardEmpty/list 改单条索引维护,不再每次 rebuildIndex |
| `ui/native-composer.ts` | P3:输入 200ms 防抖;`cachedMarkdownFiles` 5s TTL 缓存;删除零调用 getValue/setValue |
| `ai/provider/api-agent-runtime.ts` | P4:`scopeCacheKeys` 记录回合内缓存键,回合 finally 统一清理 toolResults |
| `ai/privacy/provider-egress-audit-store.ts`、`provider-usage-audit-store.ts`、`agent-workbench/security/jsonl-security-audit-sink.ts` | P5:接入轮转(4MB → `.1` 备份,不删记录) |
| `contracts/execution-request.ts`、`adapters/ohmypi/ohmypi-rpc-adapter.ts` | 删除零调用导出 imageBlocks / followUp |
| `jarvis/voiceio.ts`、`quyuan/_README.md` | R8:修正失效文档,README 按现行实现重写并列出"已移除"清单 |

### 新增

- `src/ai/privacy/audit-rotation.ts`:审计文件轮转模块(纯函数 + 可注入 IO,便于测试)
- `tests/perf-and-rotation.test.ts`:8 项测试锁定 P1–P5(含"写 manifest 不触发全目录 list"的可量化断言)

### 测试调整

- `tests/voice-lifecycle.test.ts`:移除依赖死链的两个 describe(麦克风生命周期、本地 ASR 序列化)与相关夹具
- `tests/voice-readonly-policy.test.ts`:ASR 不可达断言改为"文件不存在"
- `tests/agent-workbench-legacy-import.test.ts`:会话管理用例改由 ConversationService 原生 API 覆盖

**量化结果**:src 由 232 文件/42,774 行降至 213 文件/38,992 行(净减 19 文件、3,782 行);测试 859→867 通过。

## 1.3.0 — 批次三:结构重构(行为不变,相对 1.2.0)

### 新增

| 文件 | 内容 |
|---|---|
| `src/agent-workbench/contracts/provider-port.ts` | Provider 端口契约:ProviderPort / ProviderAskRequest / ProviderPortFactoryInput / DirectApiProviderFactory |
| `src/quyuan/voice-panel-labels.ts` | 面板标签与状态纯函数(模型/音色/权限/引擎文案、待机状态推导、Provider 类型) |
| `src/quyuan/voice-confirm-card.ts` | 破坏性操作二次确认卡自包含组件(原 voice-panel 内联 50 行) |
| `tests/voice-panel-labels.test.ts` | 9 项行为测试(标签兜底、引擎文案、权限标签、状态推导、确认卡超时/播报开关) |

### 修改

| 文件 | 内容 |
|---|---|
| `adapters/api/direct-api-runtime-adapter.ts` | F6:主体不再直连 ai/provider;实现引用集中到末尾默认工厂,`createProvider` 可注入替换;mapEvent 改用 ProviderAskEvent |
| `contracts/runtime-adapter.ts` | F7:permissionMode 加说明性注释(ApprovalBroker 为唯一授权层),不使用 @deprecated |
| `core/conversation-service.ts` | F8:新增 patchManifest / updateSelection / loadProjection / listManifests |
| `core/agent-workbench-service.ts` | F8:6 处 store 直访改为经 ConversationService(create/list/load/switch/persist/fork) |
| `quyuan/voice-panel.ts` | F1:modelLabel/permissionLabel/ttsLabel/renderEngineBtn/restingState/askConfirm 改为委托新模块;移除不再使用的 import |
| `tests/agent-workbench-native-ui-contract.test.ts` | switchConversationRuntime 文本断言随 F8 更新为锁定新语义 |

### 未完成(转入 ROADMAP 后续)

- F1 的 "voice-panel ≤800 行" 未达成:剩余主体为 `mount()`(约290行连续 DOM 构建)与 `buildRealtime()`(157行,强耦合面板状态),需面板状态容器方能安全拆分。
- F2(qwen-realtime-voice 事件表化)、F3/F4(build/execute 拆分)未开始。

## 1.4.1 — 审查问题清单落地(文档与验收记录批次,相对 1.4.0)

### 新增文件

| 文件 | 内容 |
|---|---|
| `scripts/check-file-size.mjs` + `scripts/file-size-baseline.json` | Q-ARC12:体量棘轮门(单文件 ≤800 行、函数 ≤100 行的目标模式 + 防回涨的基线模式),接入 `npm run check:file-size` 与 CI |
| `scripts/run-chat-gate-fixtures.mjs` + `fixtures/chat-gate/{pass,fail-no-finish}/` | Q-TES9:把 chat-gate 从手工门变成合成夹具门(正例 exit 0 / 反例 exit 1),接入 CI |
| `tests/doc-consistency.test.ts` | Q-DOC1–Q-DOC18 的文档一致性守卫(版本四处一致、tab 名、主题数、安装清单、G 闸门口径、**.md 制表符守卫**等) |
| `tests/file-size-and-chat-gate.test.ts` | 体量门与 chat-gate 夹具的断言 |
| `tests/security-audit-sink-and-handoff.test.ts` | Q-TES7:为 `security/jsonl-security-audit-sink.ts` 与 `core/context-handoff-service.ts` 补行为用例(此前 0% 覆盖) |
| `tests/voice-panel-dom-probe.test.ts` | Q-ARC12 第 2 步:拆分前的 DOM 探针(证明面板可在 node 里 mount) |

### 修改

| 文件 | 内容 |
|---|---|
| `package.json` | 新增 `typecheck:tests`、`check:file-size`、`test:chat-gate:fixture` 三个脚本 |
| `tests/tsconfig.json` | 只补 `compilerOptions.noEmit`(不加 `references`:主 tsconfig 无 `composite`,会报 TS6306/TS6310) |
| `vitest.config.ts` | 新增 `coverage.thresholds`(全局 lines 37、security 78、storage 81,只锁报告给出的 lines 值) |
| `.github/workflows/ci.yml` | 新增 Typecheck tests / Coverage / Chat gate fixtures / File size 四个 step;产物清单删掉 `claude-sdk.cjs` 并加存在性断言 |
| `src/settings.ts` | `TALOS_SETTING_TABS` 与 `TalosSettingTabDefinition` 导出,供文档守卫 import |
| `src/agent-workbench/security/process-sandbox.ts` | 用户提示里的 tab 名改为「对话与模型」 |
| `src/quyuan/local-voice-supply-chain.ts` | 文件头补「0 引用,仅作供应链边界的类型留档」 |
| `AGENTS.md` | 安装目录改 `plugins/tt-workbench/`;清除 `CLAUDE.md`/`refresh-dashboard.py` 死引用;统计口径真源指回 `src/data/schema.ts`;写明本仓库不定义 G4–G7 |
| `README.md` | Q-DOC1/2/3/4/5/6/9/10 的正文修正(平台矩阵、产物清单、9 文件安装清单、tab 名、八套主题、版本徽章、发布状态口径、执行链路指向) |
| `ACCEPTANCE.md` | Q-TES2/Q-TES4/Q-DOC2/Q-DOC18:composition 归因改为产品缺陷并单列「已知产品缺陷」;A5 判据改为同提交实测;A6 去掉已不存在的 split 守卫;`1.3.1` 实机路径改占位符(修掉吃掉反斜杠的制表符) |
| `ROADMAP.md` | Q-DOC17:批次二三种说法收敛为一条;行数写 `wc -l` 实测值;批次二/三表格回填体量门与类型门 |
| `CHANGELOG.md` | Q-DOC15:页脚「最近」改为全文最大条目日期 2026-10-25;Q-DOC4:两处历史 tab 名加括注(不改原文) |
| `docs/design-qa.md` | Q-DOC8:同日 `passed`/`failed` 冲突加取消标注与双向指认,补文件级判定口径;陈旧测试计数标注为历史快照 |
| `docs/multi-channel-execution.md` | Q-DOC10:顶部加失效横幅与失效证据 |
| `docs/qa/wp7-upgrade-rollback.md` | Q-DOC11:`contracts/wp6-plugin-baseline.json` 改为「以本文档记录为准,仓库内无独立 json 副本」 |
| `docs/qa/wp7-mock-acceptance.md` | Q-DOC12:`quyuan-v2.selftest.mjs` 判为未落地;更正 self-test 输出串 |
| `docs/qa/g3-multiformat-preview-acceptance.md` | Q-DOC14:Preview 入口改到对话输入栏;补入口核对命令与常量比对说明 |
| `docs/qa/wp7-obsidian-acceptance.md` | 陈旧测试计数标注为历史快照 |
| `docs/TALOS-标准化方案.md` | Q-DOC13:补完成度回填与第七节四条逐条状态 |
| `docs/superpowers/plans/2026-07-24-wp7-unified-ai-console.md` | Q-DOC12:规划稿里的 `quyuan-v2.selftest.mjs` 标注未落地 |
| `agent-workbench-chat-gate.selftest.mjs` | Q-TES9:`RUNTIME_IDS` 收窄为 `ohmypi`;更正报错文案;补「不需要真实 Vault」的说明 |
| `src/quyuan/qwen-realtime-voice.ts` | Q-ARC12 第 5 步(F2):`handleServerEvent()` 事件表化——新增 `SERVER_EVENT_HANDLERS` 表与 13 个 `onXxx()` 具名方法,分派器本身由 161 行降到 5 行;各分支体逐字搬迁,行为不变(22 项行为用例全绿) |

## 刻意保留(合规或合同要求)

1. `LICENSE` / `THIRD-PARTY-NOTICES.md` / `THIRD-PARTY-LICENSES.txt` / `MaShanZheng-*` — 许可证与第三方声明逐字保留(license 第 2 节要求)。
2. 命令 id `talos-ask` — canonical 注册表合同要求逐字稳定(`src/main.ts` 注释、`src/canonical/*`、7 个测试共同锁定);Obsidian 命令面板实际显示"TT工作台: 全库问答"。
3. `.talos/` 数据目录、`.talos/private` 等保护区路径 — 既有用户数据与安全策略兼容层。
4. vault 内 `TALOS系统/`、`TALOS中枢/` 目录约定 — 用户 Vault 侧数据结构,不属于插件品牌。
5. CSS 类名 `talos-*` 前缀(约 4091 处)与 `VIEW_TYPE_TALOS` 等内部标识符 — 内部 ABI,52 个测试文件依赖;批量重命名属高风险重写,已列入 `ROADMAP.md` 批次三评估。
6. 死代码链(本地 ASR 整链、背景动画三件套等) — 已于 1.2.0 删除(见本文件 1.2.0 节);`src/quyuan/local-voice-supply-chain.ts` 为 0 引用残留文件,按下方第 7 条保留并标注。
7. `src/quyuan/local-voice-supply-chain.ts`(209 行) — **0 引用,保留为供应链边界的类型留档**。`grep -rn "local-voice-supply-chain" src/ tests/` 无命中。它导出 `LOCAL_VOICE_ASSET_PROTOCOL_VERSION`、`ALLOWED_LOCAL_VOICE_MODEL_HOSTS`、`LocalAsrTranscriber` 等供应链约束类型;删除会缩小未来的供应链约束面,故默认保留。若后续决定删除,验收改判为「`ls` 报 No such file 且 `npm run build` 仍退出码 0」。
8. `TALOS-Favicon-64-v1.png` — 仅供 `prototype/overview-operations-qa.html` 与 `prototype/quyuan-voice-particle-qa.html` 的 QA 预览引用,代码零读取(`grep -rn Favicon src/` = 0),**不属分发必需**;分发包的资产清单见 `README.md` 安装章节(9 个文件,含被 `src/ui/welcome-easter-egg.ts:18` 读取的 `TALOS-Mascot-Character-Transparent-v1.png`)。
