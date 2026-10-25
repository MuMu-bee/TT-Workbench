# ROADMAP — TT工作台 (TT-Workbench) 后续批次路线

> 依据 `docs/CODE-REVIEW-TT.md` 的审查结论排期。原则:每批次独立可验收,行为不变者优先,高风险重写置后并单独立项。

## 批次二:冗余清理与性能优化(行为不变)—— ✅ 已于 1.2.0 完成

> 完成情况:死链删除(本地ASR整链/背景动画三件套/voice-tool-gateway/conversation-management-service)、悬空 quyuanBackground 设置项、P1 历史搜索防抖+投影缓存、P2 索引增量维护、P3 @建议防抖+TTL缓存、P4 回合级工具结果清理、P5 审计轮转、R7 零调用导出、R8 失效文档全部落地;新增 tests/perf-and-rotation.test.ts 锁定。上游测试 Windows 兼容化未做(与本次定制无关,仍为平台差异)。

| 项 | 来源 | 动作 | 验收标准 |
|---|---|---|---|
| 上游测试 Windows 兼容化 | 已知平台差异 | 修复 `new URL().pathname` 拼接(改用 `fileURLToPath`)、路径断言改 `path.normalize` 比较 | `npx vitest run` 在 Windows 与 Ubuntu 均 0 失败 |
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

> 已完成:F6 contracts 端口化(provider-port)、F7 permissionMode 契约注释对齐、F8 service 经 ConversationService 访问 store、F1 部分拆分(labels + confirm-card 抽取,配 9 项行为测试,voice-panel 1470→1440 行)。
> 未完成:voice-panel ≤800 行(需引入面板状态容器,独立立项)、F2 事件表化、F3/F4 build/execute 拆分。

| 项 | 来源 | 动作 | 验收标准 |
|---|---|---|---|
| voice-panel.ts 拆分 | 审查 F1 | 1470 行拆为 panel/state/persistence/approval-card 子模块;先补行为测试 | 单文件 ≤800 行;行为测试替代 readFileSync 文本断言 |
| qwen-realtime-voice 拆分 | 审查 F2 | handleServerEvent 事件表化 | 单文件 ≤800 行 |
| agent-workbench build()/execute() 拆分 | 审查 F3/F4 | build 按 UI 组拆;execute 按准备/循环/终止拆 | 函数 ≤100 行;契约测试全绿 |
| contracts 边界修复 | 审查 F6 | adapters/api 与 legacy 经 contracts 或端口接口访问 ai/provider | 模块依赖方向检查脚本通过 |
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
