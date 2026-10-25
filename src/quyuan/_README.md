# Quyuan

> TT工作台内部的屈原人格、治理与语音层；通用文字对话由 `src/agent-workbench/` 原生实现。

## 当前边界

**人格与治理（生产活跃）**
- `contract.ts`：不可缩水的通用 Agent 能力合同。
- `persona-context.ts`：首轮对话前完整加载 PERSONA、persona-memory、CONTEXT；缺一即失败。
- `governance.ts`：写库前的铁律判定，不依赖具体 Provider。
- `workbench-adapter.ts`：与 provider-neutral runtime 的稳定适配契约。
- `module.ts`：把人格、治理与工作台适配器编排为一个屈原模块。

**实时语音（生产活跃，服务端可插拔）**
- `voice-panel.ts`：语音面板（固定 dock + 字幕 + 唤醒词），生产麦克风路径为 Qwen Realtime WebRTC 独占。
- `qwen-realtime-voice.ts`：Realtime 会话状态机（WebRTC + 数据通道 + 工具调用）。
- `realtime-provider.ts`：**服务端抽象**——`dashscope`（百炼 Qwen 预设）或 `openai-compatible`（自定义 Realtime 端点，两步握手）。
- `runtime-policy.ts`：语音只读边界与联网搜索授权策略。
- `voice-vault-tools.ts` / `voice-data-map.ts`：只读 Vault 工具与数据地图。
- `voice-turn-admission.ts`：回合准入（忙碌拒绝、打断）。
- `native-voice-driver.ts`：文字只读查询通道。

**视觉层**
- `talos-ball/`：TalosBall 0.3.0 固定运行时（vendor 快照 + 契约 + 控制器），完整性与 288 帧等价门由测试锁定。
- `voice-character-stage.ts`、`voice-particle-field.ts`：语音状态视觉。

## 已移除（不再存在）

- 本地 ASR 整链：`local-asr`、`vad-mic`、`vad-turn`、`silero-vad`、`bundled-local-voice-runtime`、`sherpa-local-asr-runtime`、`vendor/local-voice-runtime`（TT 1.2.0，审查 R5）。
- 背景动画三件套：`background-field`、`grid-scan-field`、`letter-glitch-field`（TT 1.2.0，审查 R4）。
- `voice-tool-gateway`（TT 1.2.0，审查 R6）、`cloud-asr` 兼容桩（TT 1.2.0）。

## 样式

`styles.quyuan-shell.css`（插件根目录）：完整 Agent 工作台不自带固定浅色宣纸变量；开启全库同步时消费 `body[data-talos-vault-theme]` 的七主题令牌，关闭同步时继承 Obsidian 当前明暗主题。主题色、文字、边框、圆角与 `color-scheme` 共用同一来源，切换无需重建视图。
