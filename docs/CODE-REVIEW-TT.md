# TALOS v0.4.9 全方位代码审查报告(TT-Workbench 定制基线)

> 审查对象:`WAINAO-Haaper/talos-plugin` @ commit `fb365d0`(v0.4.9,2026-10-13)
> 审查方式:三路并行源码审查(agent-workbench 模块 / quyuan+ai 模块 / 控制台 UI+插件核心)+ 本地构建与测试基线验证。全部结论均给出文件级判定依据,无推测。
> 规模事实:src 232 个 TS 文件 / 42,774 行;tests 148 个文件;CI 五道门(lint/typecheck/test/license-audit/build)。

## 〇、基线事实

| 项 | 结果 | 依据 |
|---|---|---|
| 上游 CI(Ubuntu) | 最近 3 次运行全部 success | `gh run list` 实测 |
| 本地测试(Windows) | 926 通过 / 16 失败(14 文件) | `npx vitest run` 实测 |
| 本地失败根因 | `core.autoclrf=true` 且仓库无 `.gitattributes`,checkout 时 LF→CRLF 破坏 vendor 文件字节级 SHA-256 校验(如 `talos-ball-runtime-integrity` 的 ball.js 哈希不匹配) | `git config core.autocrlf`=true;`od -c` 显示 vendor JS 为 CRLF;仓库无 .gitattributes |
| 结论 | 仓库本身健康;16 个失败为 Windows 开发环境换行符差异,非代码缺陷 | 上述三项交叉验证 |

## 一、功能冗余板块

| # | 板块 | 问题描述 | 影响范围 | 判定依据 |
|---|---|---|---|---|
| R1 | `agent-workbench/core/runtime-supervisor.ts`(27行) | `RuntimeSupervisor` 全仓库(src+tests)零引用,完全死代码 | 维护噪音 | grep 全仓库仅自身定义处 |
| R2 | `agent-workbench/security/provider-egress-bridge.ts`(21行) | `ProviderEgressBridge` 零引用,完全死代码 | 同上 | grep 全仓库仅自身定义处 |
| R3 | `agent-workbench/core/workbench-controller.ts`(131行)、`core/conversation-management-service.ts`(30行) | 仅被测试引用,生产装配清单(`plugin/quyuan-workbench-init.ts`)不含;与 `AgentExecutionCoordinator`/`native-conversation-view` 职责重复,属并行演化旧路径,测试在为死路径续命 | 约160行+2个测试文件 | grep 引用关系;装配清单比对 |
| R4 | quyuan 背景动画三件套:`background-field.ts`(113行)、`grid-scan-field.ts`(574行)、`letter-glitch-field.ts`(255行) | 生产不可达死代码;且 `settings.ts:150,251`、`main.ts:492-493` 仍维护 `quyuanBackground` 悬空设置项,`styles.quyuan-shell.css:1662-1666` 残留样式注释 | 约942行死代码 + 无效UI选项 | import 图谱从 `src/main.ts` 不可达;连测试都零引用(除链内互引) |
| R5 | quyuan 本地 ASR 整链:`local-asr.ts`、`cloud-asr.ts`、`vad-mic.ts`(697行)、`vad-turn.ts`、`silero-vad.ts`、`bundled-local-voice-runtime.ts`、`sherpa-local-asr-runtime.ts`(394行) + `vendor/local-voice-runtime/`(138,569B 文本快照) | 生产麦克风路径已独占 Qwen Realtime WebRTC(`voice-panel.ts:234` 注释自述),整链仅被供应链测试引用 | 约1850行 + 138KB vendor | import 图谱验证;`voice-panel.ts:234` 注释 |
| R6 | `quyuan/voice-tool-gateway.ts`(115行) | 仅 `tests/voice-mode-fallback.test.ts` 引用;`tests/voice-readonly-policy.test.ts:17` 甚至断言 broker 不包含它 | 115行 | grep 引用关系 |
| R7 | 无调用导出成员 | `execution-request.ts imageBlocks()`、`ohmypi-rpc-adapter followUp()/messages()`、`codex-app-server-adapter rollback()`、`claude-agent-sdk-adapter runAuxiliary()`(仅测试调用)、`native-composer getValue/setValue` | API 面误导 | grep 逐一验证 |
| R8 | 失效文档指针 | `quyuan/_README.md` 描述与现行实现不符;`jarvis/voiceio.ts:6` 注释称走 LocalAsr(已切 Realtime);`talos-ball/runtime/runtime.ts:14` attribution 路径写错、`:17` adoptedAt 与 SOURCE_ATTRIBUTION.md 不一致 | 文档可信度 | 逐处比对现行实现 |

## 二、需要重构的板块

| # | 板块 | 问题描述 | 影响范围 | 判定依据 |
|---|---|---|---|---|
| F1 | `quyuan/voice-panel.ts`(1470行) | 单类承担 UI/状态机/Realtime回调/TTS/持久化/审批卡;`mount()` 约292行、`buildRealtime()` 约160行、`respond()` 约105行;无行为测试,仅 readFileSync 源码文本断言 | 语音页可维护性与可测性 | 行号实测;tests 覆盖检查 |
| F2 | `quyuan/qwen-realtime-voice.ts`(1140行) | `handleServerEvent()` 143行 if 链、`handleFunctionCall()` 80行 | 同上 | 行号实测 |
| F3 | `agent-workbench/ui/talos-agent-workbench.ts:166-465` | `build()` 单函数约300行,构建9组UI | 工作台UI | 行号实测 |
| F4 | `agent-workbench/core/agent-execution-coordinator.ts:193-432` | `execute()` 生成器约240行,准备/事件循环/异常内联 | 执行核心 | 行号实测 |
| F5 | 重复逻辑 | `FrameSubscription` 类逐行双份(json-line/omp RPC);`parseEnvBlock` 双份;`record/stringValue` 助手10处;`withTimeout` 4份;`QuyuanBackgroundType`、`TalosBallTheme` 双定义;Realtime 模型/音色白名单三处硬编码 | 漏改即运行时被另一处拒绝 | grep 逐一验证 |
| F6 | 架构:contracts 边界被穿透 | `adapters/api/direct-api-runtime-adapter.ts:1-4` 与 `legacy/legacy-codex-credential-migrator.ts:2-4` 绕过 contracts 直连 `ai/provider/*` | 模块无法独立复用 | import 语句实测 |
| F7 | 架构:permissionMode 契约被架空 | 契约三档("ask"/"scoped"/"vault-full"),但 Claude 恒传 "default"、Codex 固定 "on-request" 不读该字段、OhMyPi 折叠为两档;实际授权统一由 ApprovalBroker 执行 | 契约与实现不符,误导读者 | 三适配器逐处核对 |
| F8 | 架构:service 下钻 store | `agent-workbench-service.ts:292-359` 直接操作 `conversations.store.load/updateManifest`,越过 coordinator 封装 | 分层失效 | 行号实测 |
| F9 | 测试形式 | 多处以 `readFileSync` 读源码做字符串断言(voice-panel、agent-workbench-baseline 等),重构即碎 | 回归价值低 | tests 抽样 |

## 三、需要优化的板块

| # | 板块 | 问题描述 | 影响范围 | 判定依据 |
|---|---|---|---|---|
| P1 | `native-conversation-view.ts:236,777-832` | 历史搜索每敲一键全量加载所有会话全部事件并 JSON.parse,无防抖(有竞态保护) | 会话多时明显卡顿 | 行号实测 |
| P2 | `portable-conversation-store.ts:158-161,223-239` | 每次 `updateManifest` 全量重建索引(列全部会话目录+读盘);每回合至少3次 O(N会话) 扫描 | IO 写放大 | 调用链 grep 验证 |
| P3 | `native-composer.ts:162,266-282` | @文件建议每键全量遍历 `getMarkdownFiles()`,无防抖 | 大库输入延迟线性增长 | 行号实测 |
| P4 | `ai/provider/api-agent-runtime.ts:90,121-133` | `toolResults` Map 只增不减,实例存活期无清理 | 长会话内存缓慢泄漏 | 全文检索无清理路径 |
| P5 | `jsonl-security-audit-sink.ts:7-11`、`provider-egress/usage-audit-store` | JSONL 审计无限追加,无轮转/上限 | 磁盘无界增长 | grep 无 rotation/truncate |
| P6 | `voice-panel.ts:183-191` | 每条语音消息整体序列化40条快照并全量重写 settings data.json | 高频对话写放大 | 行号实测 |
| P7 | `voice-vault-search.ts:160-227` | search_vault 默认最多读3000个md全文做规范化匹配,excerpt 二次规范化 | 大库单问数千次读取(有界但重) | 行号实测 |
| P8 | `voice-panel.ts:292-298` | 粒子场(约6700粒子,自持rAF)与 TalosBall vendor 引擎双动画同屏(各自有节流缓解) | 持续渲染开销 | 两条 rAF 链路验证 |
| P9 | 工程化:无 `.gitattributes` | Windows checkout 换行符转换破坏字节级完整性校验,16个测试平台性失败 | Windows 开发者体验 | 基线事实(〇节) |
| P10 | 魔法值 | 回退模型 `"gpt-5.5"` 双处硬编码;`MAX_OPEN_CONVERSATIONS=6` 与字面量6并存;头部高度 `?? 52`;3200/220ms 未命名定时器;egress 默认主机名硬编码 | 漏改风险 | grep 逐处验证 |

## 四、需要重写的板块

**判定:无必须整模块重写的板块。** 依据:
1. 核心行为正确且契约测试存在(926项通过;上游CI绿);
2. 超长文件(voice-panel 1470行、qwen-realtime-voice 1140行)属"结构重构"范畴(F1/F2),行为合同(talos-ball 状态合同、语音只读策略)无需变更;
3. 唯一接近"重写"的是**失效文档与源码文本断言测试**(R8/F9)——文档按现行实现重写,文本断言测试逐步改为行为测试。

## 五、安全审查结论(总体:设计良好,失败关闭到位)

**正面(已验证)**:
- 沙箱失败关闭:非 macOS 返回 unsupported 并禁 CLI Execute(`process-sandbox.ts:45-75`、`desktop-runtime-factory.ts:148-150`);Claude SDK 强制 `failIfUnavailable`;
- 密钥:不入 settings(`assertSafeWorkbenchSettings` 拒绝敏感键值),走 SecretStorage,审计/UI/导入三处脱敏;
- 路径:`vault-boundary.ts` realpath+symlink回溯+NFKC+永久禁区;conversationId 白名单正则;eventId 用 sha256 落盘;拒绝 `..`;
- 出口代理仅绑 127.0.0.1,CONNECT 前逐目标授权;
- 语音联网搜索双层授权(客户端字面触发+服务端复核,忽略模型工具参数)。

**关注项(非现行漏洞)**:
1. `codex-app-server-adapter.ts:196-207` 会话以 `danger-full-access` 建立,仅靠 turn 层收紧+外部沙箱单层防线;
2. `node-runtime-probe-host.ts:41-43` Windows shim 仅校验可执行路径不含 shell 元字符,未校验 args(当前 args 全为静态常量,无可利用输入);
3. `anthropic-model-client.ts:158` 浏览器直连头意味着密钥在渲染进程内存(浏览器直连方案的固有属性)。

## 六、审查结论 → 改造映射

| 审查结论 | 本次定制批次(TT-Workbench 1.0.0) | 后续批次 |
|---|---|---|
| P9 无 .gitattributes | ✅ 新增并 renormalize | — |
| R1/R2 零引用死文件 | ✅ 删除并验证 | — |
| 品牌耦合(见品牌化清单) | ✅ 全面品牌化 | — |
| R3-R7 冗余链/死导出 | 路线图立项 | 批次二 |
| F1-F9 重构项 | 路线图立项 | 批次三+ |
| P1-P8、P10 优化项 | 路线图立项(按影响排序) | 批次二/三 |
| R8/F9 失效文档/脆断言 | 路线图立项 | 批次二 |
