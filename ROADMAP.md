# ROADMAP — TT工作台 (TT-Workbench) 后续批次路线

> 依据 `docs/CODE-REVIEW-TT.md` 的审查结论排期。原则:每批次独立可验收,行为不变者优先,高风险重写置后并单独立项。

## 批次二:冗余清理与性能优化(行为不变)—— 🟡 主体完成(1.2.0)，Windows 兼容化待 CI matrix 闭环

> **已完成**：死链删除(本地ASR整链/背景动画三件套/voice-tool-gateway/conversation-management-service)、悬空 quyuanBackground 设置项、P1 历史搜索防抖+投影缓存、P2 索引增量维护、P3 @建议防抖+TTL缓存、P4 回合级工具结果清理、P5 审计轮转、R7 零调用导出、R8 失效文档全部落地;新增 tests/perf-and-rotation.test.ts 锁定。
>
> **未闭环**：上游测试 Windows 兼容化。**行数口径下的实测已 0 失败**（本轮同提交 `Test Files 172 passed (172)` / `Tests 1158 passed (1158)`），但状态标记保持 🟡 而非 ✅：这条验收的判据是「由 CI 双 OS matrix 长期强制」，而 Windows leg 目前仍带 `continue-on-error`（见 Q-TES6 的两阶段计划）。等 Windows leg 去掉 `continue-on-error` 并在真实 CI 上跑过一次，才能把本批次改回 ✅。

| 项 | 来源 | 动作 | 验收标准 |
|---|---|---|---|
| 上游测试 Windows 兼容化 | 已知平台差异 | 修复 `new URL().pathname` 拼接(改用 `fileURLToPath`)、路径断言改 `path.normalize` 比较 | `npx vitest run` 在 Windows 与 Ubuntu 均 0 失败。由 CI 双 OS matrix 强制（见 Q-TES6）。判据的两次实测：①审计时点 Windows 侧 `Tests 4 failed \| 890 passed (894)`、`Test Files 5 failed \| 139 passed (144)`，**当时未达成**；②本轮同提交 `Test Files 172 passed (172)` / `Tests 1158 passed (1158)`、**0 失败**。该达标不只依赖测试修，还依赖产品侧脱敏修复（composition 的 win32 根相对路径）与 voice-vault-tools 的排序收敛，两项均已落地 |
| 本地 ASR 死链清理 | 审查 R5/R6 | 删除或显式标注 test-only 保留(vad-mic/silero-vad/sherpa 链 + local-voice-runtime vendor + voice-tool-gateway),同步处理供应链测试 | 删除后 build+test 全绿;bundle 不含 sherpa 快照 |
| 背景动画三件套与悬空设置 | 审查 R4 | 删除 background-field/grid-scan-field/letter-glitch-field 及 `quyuanBackground` 设置项与残留样式 | 设置页无失效选项;测试全绿 |
| 仅测试引用的旧路径 | 审查 R3 | 决策 workbench-controller/conversation-management-service 去留,删除并为替代路径补行为测试 | 装配清单与测试引用一致 |
| 无调用导出成员 | 审查 R7 | 删除 imageBlocks/followUp/messages/rollback/getValue/setValue 等 | lint 无未用导出;测试全绿 |
| 历史搜索防抖 | 审查 P1 | 输入防抖 250ms + manifest 级索引先行 | 输入期间 IO 次数≤每键1次索引读取 |
| manifest 索引增量维护 | 审查 P2 | updateManifest 只写单个索引项,启动时全量重建一次 | 单回合写 IO 由 O(N) 降为 O(1)(代码审查+基准) |
| @ 文件建议防抖与缓存 | 审查 P3 | 250ms 防抖 + 文件列表缓存(vault 事件失效) | 大库输入无逐键全量扫描 |
| toolResults 泄漏 | 审查 P4 | 回合结束后清理对应 sessionId 条目 | 长会话内存平稳(泄漏测试) |
| 审计 JSONL 轮转 | 审查 P5 | 超过大小上限轮转为 .bak 或按月分文件 | 审计目录文件数/体积有上界 |
| 失效文档修复 | 审查 R8 | 重写 quyuan/_README.md、jarvis/voiceio.ts:6 注释、talos-ball attribution 路径与日期 | 文档与实现一致(逐条核对) |
| 重复助手收敛 | 审查 F5 | FrameSubscription/parseEnvBlock/record/stringValue/withTimeout 提取到 shared | 每类助手仅一处定义 |

## 批次三:结构重构(行为不变,测试先行)—— 🟡 部分完成(1.3.0)

> 已完成:F6 contracts 端口化(provider-port)、F7 permissionMode 契约注释对齐、F8 service 经 ConversationService 访问 store、F1 部分拆分(labels + confirm-card 抽取,配 9 项行为测试)、**F2 `handleServerEvent()` 事件表化**。
> 未完成:voice-panel ≤800 行(需引入面板状态容器,独立立项)、F3/F4 build/execute 拆分。体量门槛已落地为棘轮门 `scripts/check-file-size.mjs`(+ `scripts/file-size-baseline.json`),接入 `npm run check:file-size` 与 CI;`node scripts/check-file-size.mjs --targets` 按 800/100 硬阈值判定,未达标项仍会红。
> **实测行数**(`wc -l`,本文件同提交):`src/quyuan/voice-panel.ts` 1470→1534 行、`src/quyuan/qwen-realtime-voice.ts` 1142→1208 行(F2 事件表化把 161 行的 `handleServerEvent()` 拆成 1 个 5 行分派器 + 13 个具名方法,单文件总行数因方法签名与事件表增加 66 行,但**函数体量从 161 降到 5**)。上游基线 1470 行,voice-panel 的当前值高于它——1.x 期间新增的能力是净增代码。
> **拆分前置探针已通过**:`tests/voice-panel-dom-probe.test.ts` 用 `vi.mock("obsidian")` + `mini-dom` 宿主在 node 里实例化并 `mount()` 了 `QuyuanVoicePanel`(不抛异常、根节点已挂、`unmount()` 可收口)。因此后续拆分可按**行为**断言验收,**不需要**走「强约束源码文本断言」的回退形态。

| 项 | 来源 | 动作 | 验收标准 |
|---|---|---|---|
| voice-panel.ts 拆分 | 审查 F1 | 1534 行拆为 panel/state/persistence/approval-card 子模块;先补行为测试 | 单文件 ≤800 行(当前 1534,**未达成**);行为测试替代 readFileSync 文本断言。门槛:`npm run check:file-size`(棘轮)`--targets`(目标) |
| qwen-realtime-voice 拆分 | 审查 F2 | handleServerEvent 事件表化 —— **已完成**:`SERVER_EVENT_HANDLERS` 表 + 13 个 `onXxx()` 具名方法,`handleServerEvent()` 由 161 行降到 5 行 | 函数 ≤100 行(**已达成**:`handleServerEvent()` 5 行);单文件 ≤800 行(当前 1208,**未达成**,剩余为连接/超时/音频管线的其他方法) |
| agent-workbench build()/execute() 拆分 | 审查 F3/F4 | build 按 UI 组拆(`build()` 现 160-459,300 行);execute 按准备/循环/终止拆(`execute()` 现 237-490,254 行) | 函数 ≤100 行(**未达成**:`build()` 300 行、`execute()` 254 行、`mount()` 308 行仍超限);契约测试全绿。契约测试类型门已接入:`npm run typecheck:tests`(基线由 87 error 降到 0),CI 紧随 `Typecheck` 之后作为独立 step |
| contracts 边界修复 | 审查 F6 | adapters/api 与 legacy 经 contracts 或端口接口访问 ai/provider | 模块依赖方向检查脚本通过。已落地 `scripts/check-module-boundaries.mjs`（主规则 = adapters/legacy 不得直连 ai/provider），接入 `npm run build` 与 CI（`npm run check:boundaries`）。现存 6 条 F6 未完成依赖在 `scripts/module-boundaries-baseline.json` 白名单内并带 issue+reviewBy，清空白名单即报 6 条违规、退出码 1 |
| permissionMode 契约对齐 | 审查 F7 | 契约与适配器实现二选一对齐(倾向:文档化 ApprovalBroker 为唯一授权层,契约字段标注 deprecated) | 契约注释与实现一致 |
| service 下钻封装 | 审查 F8 | service 经 coordinator 访问 store | coordinator 外无 store 直访 |

## 批次四:评估后再定(高风险)

| 项 | 来源 | 说明 |
|---|---|---|
| `talos-*` CSS 类名与 `VIEW_TYPE_TALOS` 等内部标识符重命名 | 品牌化补全 | 约 4091 处类名 + 52 个测试文件依赖;需一次性原子重命名 + 全量回归,收益仅限外观一致性。默认不做,除非出现真实维护痛点 |
| Codex `danger-full-access` 双层防线 | 审查 S1 | turn 层已收紧 + 外部沙箱;评估在 resumeSession 后强制 turn 校验 |
| Windows shim args 校验 | 审查 S3 | 当前 args 为静态常量;若未来引入动态 args,先加元字符校验 |
| 双动画同屏与语音 settings 写放大 | 审查 P6/P8 | 需真机性能矩阵(上游同样未完成),配合上游节奏处理 |

## 交付节奏

- 每批次一个 PR/一组提交,验收标准逐条回填 ACCEPTANCE.md;
- 持续追踪上游 release,功能性改动经 rebase 合入,保持 fork 可持续演进;
- 任何对外分发同步更新 MODIFICATIONS.md。
