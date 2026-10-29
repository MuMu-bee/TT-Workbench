# TT工作台 (TT-Workbench) for Obsidian

![version](https://img.shields.io/badge/version-1.4.0-2f6feb)
![obsidian](https://img.shields.io/badge/Obsidian-1.11.4%2B-7c3aed)
![platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-111827)
![license](https://img.shields.io/badge/license-Personal%20Use%20Source%20Available-FAD861)

> 把 Obsidian Vault 变成可观察、可治理、可执行的个人 AI 工作台。

**TT工作台（TT-Workbench）** 是基于 **TALOS for Obsidian v0.4.9** 深度定制的独立发行版：一个桌面端 Obsidian 原生插件，把散落在 Vault 里的任务、项目、知识、收件箱、健康记录和发布状态汇总为一个实时控制台，并把多智能体对话、审批治理和「屈原」实时语音放进同一套工作流。

## 与 TALOS 的关系(署名与合规)

- 上游项目：**TALOS for Obsidian**，作者 **外脑玩家 Haaper**，仓库 [WAINAO-Haaper/talos-plugin](https://github.com/WAINAO-Haaper/talos-plugin)。
- 本仓库是个人非商业用途的定制 fork，遵循 **TALOS Personal Use Source License 1.0** 分发：原项目 `LICENSE`、`THIRD-PARTY-NOTICES.md`、`THIRD-PARTY-LICENSES.txt` 及全部版权与署名**完整保留、逐字未改**。
- 全部修改逐文件记录于 [`MODIFICATIONS.md`](MODIFICATIONS.md)；审查依据见 [`docs/CODE-REVIEW-TT.md`](docs/CODE-REVIEW-TT.md)；验收结论见 [`ACCEPTANCE.md`](ACCEPTANCE.md)。
- 本项目为 **Source Available（源码开放）**，不是 OSI 定义的 Open Source。不收取任何费用。

## 界面预览

以下截图来自上游 TALOS v0.4.x（TT工作台保留同一控制台架构）。点击图片可查看原始尺寸。

| 指挥总览 · Bauhaus | AI 对话 · DeepSeek Harness |
|---|---|
| [![TALOS 指挥总览](docs/screenshots/v0.4.1/overview-bauhaus.png)](docs/screenshots/v0.4.1/overview-bauhaus.png) | [![TALOS AI 对话与 DeepSeek Harness](docs/screenshots/v0.4.1/ai-chat-deepseek-harness.png)](docs/screenshots/v0.4.1/ai-chat-deepseek-harness.png) |
| 屈原语音 · TalosBall 0.3.0 | 设置 · 主题与模型 |
| [![TalosBall 语音状态视觉](docs/screenshots/v0.4.4/voice-workspace-talosball.png)](docs/screenshots/v0.4.4/voice-workspace-talosball.png) | [![TALOS 设置与主题](docs/screenshots/v0.4.1/settings-themes.png)](docs/screenshots/v0.4.1/settings-themes.png) |
| 收件箱治理 | 全库视图 |
| [![TALOS 收件箱治理](docs/screenshots/v0.4.1/inbox-governance.png)](docs/screenshots/v0.4.1/inbox-governance.png) | [![TALOS 全库视图](docs/screenshots/v0.4.1/vault-overview.png)](docs/screenshots/v0.4.1/vault-overview.png) |

## 产品全景

| 工作区 | 你可以做什么 |
|---|---|
| **指挥总览** | 查看今日焦点、知识规模、系统健康、发布闭环、重要事项、审批队列和任务进度。 |
| **AI 对话** | 在原生多会话工作台与嵌入式 DeepSeek Harness 中切换项目、模型和会话。 |
| **屈原语音** | 使用 Qwen Realtime 进行唤醒、连续对话、实时转写与语音回复；语音工具默认只读。 |
| **收件箱治理** | 按积压年龄、主题聚类和最近进入情况整理内容，并进入归档、消化或地图视图。 |
| **全库视图** | 查看内容分布、README 完整性、库健康、活跃天数、项目地图和笔记热力图。 |
| **统一设置** | 配置界面、目录映射、数据源、智能体、模型、SecretStorage 和语音服务。 |

## 核心能力

- **实时 Vault 控制台**：基于 Obsidian `ItemView` 原生渲染；打开即统计，文件变化后事件驱动刷新。
- **行动与治理**：将焦点、待办、审批、偏好候选、发布门和健康信号放在同一个决策面板中。
- **多智能体工作台**：单一原生运行时 OhMyPi（1.1.0 起收敛），叠加 Anthropic Messages / OpenAI 兼容两类 Direct API Provider；提供会话恢复、分叉、压缩、附件、工具调用、diff、MCP、Skills 和子智能体界面。
- **DeepSeek Harness**：在控制台内打开隔离的 Harness 工作区，保留项目与多会话导航，并由插件管理本地进程和健康状态。
- **屈原实时语音**：支持语音唤醒、持续监听、实时转写、音频回复、文本只读查询和 TALOS Ball 状态舞台；1.1.0 起服务端可插拔——默认阿里百炼 Qwen Realtime，或接入任意 OpenAI Realtime 兼容 WebRTC 端点（两步握手，密钥仍只存 SecretStorage）。
- **只读语音工具**：语音可查询 Vault 状态、统计和进度；不会暴露写库或命令执行工具。只有明确说出「联网搜索」或「上网查」时，才会发送当前问题进行联网检索。
- **八套视觉主题**：Aurora 原版、Nebula 深色宇宙稿、Animal Island 小岛主题、数据流 · 动态终端、柔光浮雕 · Neumorphism、几何现代主义 · Bauhaus（默认）、Executive Brief 商务简约（浅色）、Paper 纸感墨水（浅色）；可选择只应用于控制台或同步到整个 Vault。Macintosh 与 Swiss Modernism 已移除（2026-10-08），旧设置按直角硬边框语义并入 Bauhaus（`src/settings.ts` 的 `normalizeVisualTheme` 迁移分支）。
- **安全默认值**：API 密钥只写入 Obsidian SecretStorage；审计记录脱敏；缺少可验证 OS 沙箱时，写入型 Execute 会失败关闭（唯一例外是用户在设置页显式开启的 Windows 无隔离执行后端，见下方平台矩阵）。
- **无损升级**：迁移按 schema 分步执行；首次启动可补齐缺失的基线人格与注册文件，但不会覆盖已有内容。

## 平台状态

沿袭上游 v0.4.6+ 的跨平台边界（同一套代码，不伪装安全能力一致）：

| 平台 | 当前状态 | AI 执行边界 |
|---|---|---|
| **macOS** | 主要支持平台 | 本机 OhMyPi 可在可验证的 macOS Seatbelt 沙箱内运行；沙箱不可用时 Execute 失败关闭。 |
| **Windows 10/11 x64** | 部署与兼容支持 | 推荐使用 SecretStorage 中配置的 Direct API Provider。**默认 Plan-only**（不启动本机 CLI、不执行工具）；在设置页显式开启「Windows 无隔离执行（每条命令审批）」（`windowsApprovalOnlyExecution`，默认 `false`，`src/settings.ts:241`）后，本机 CLI 会执行——**没有操作系统级隔离**（`osIsolation: false`），智能体以当前用户权限运行，审批卡与明文审计是唯一控制手段。`.cmd` / `.bat` 仅用于安全发现，路径包含 shell 元字符时拒绝启动。 |
| **其他桌面系统** | 非当前交付重点 | 没有可验证 OS 沙箱时，本机智能体 Execute 失败关闭。 |

> Windows 该后端的边界与验收依据见 [`ACCEPTANCE.md`](ACCEPTANCE.md) 的「1.4.0 Windows 无隔离执行后端验收」小节（F1–F9 与风险边界）。该后端**不是沙盒**，不要按沙盒预期使用。

- Obsidian **≥ 1.11.4**；目标硬件对齐上游（8 GB 内存 + SSD 的 M1 Air / 4 核 x64 级别）。

## 安装

TT工作台不进入 Obsidian 社区插件商店，遵循上游许可从本仓库 Releases 以源码/构建产物非商业分发。

1. 从 Release 下载安装包（或自行执行 `npm run build` 产出 `main.js` / `styles.css`）。
2. 将其放入 `<你的 Vault>/.obsidian/plugins/tt-workbench/`。
3. 重启 Obsidian，打开「设置 → 社区插件」，启用 **TT工作台**。
4. 进入「TT工作台设置 → 对话与模型」，配置本机运行时或把 API 密钥保存到 SecretStorage，并选择 Provider 与模型。

设置页共四个 tab：「界面 / 库与数据 / 对话与模型 / 屈原 · 语音」（真源是 `src/settings.ts` 导出的 `TALOS_SETTING_TABS`）。

手动安装需包含：`main.js`、`manifest.json`、`styles.css`、`LICENSE`、`THIRD-PARTY-NOTICES.md`、`THIRD-PARTY-LICENSES.txt`、`MaShanZheng-Regular.ttf`、`MaShanZheng-OFL.txt`、`TALOS-Mascot-Character-Transparent-v1.png`。

> `TALOS-Mascot-Character-Transparent-v1.png` 的消费点是 `src/ui/welcome-easter-egg.ts:18` 的 `const FALLBACK_MASCOT = "TALOS-Mascot-Character-Transparent-v1.png"`，`:78-79` 用 `app.vault.adapter.exists(mascot)` 判定；缺它时开屏彩蛋静默降级为无头像。

> 升级前建议备份 Vault。覆盖插件文件时不要删除或替换 `data.json`、`.talos/` 和已有的人格、身份文件。
> 从上游 TALOS 迁移：数据目录（`.talos/`）与命令协议（`talos-ask`）保持兼容，卸载 TALOS 后安装本插件即可沿用既有数据；两插件不要同时启用。

### 发布状态说明（承袭上游）

本仓库的插件版本发布不改变上游的统一产品发布门，`formal_release_allowed=false` 由上游维护；PUB-W 属于内容发布工作流，不是产品发布门。TT工作台作为个人非商业定制发行版，不宣称上游产品的正式放行状态。上游的发布闸门口径不在本仓库内定义，故本仓库不据此判定发布资格。

## 快速上手

1. 点击 Obsidian 左侧栏的 TT 图标，打开统一控制台。
2. 在「总览」确认今日焦点、系统健康、审批队列和待处理事项。
3. 在「AI 对话」选择工作区、Provider、模型与工作流。Windows 默认 Plan 模式；如需本机执行，须在设置页显式开启无隔离执行后端并自行评估风险。
4. 在「屈原语音」配置百炼地域、Qwen Realtime 模型和音色；说出唤醒词后开始连续对话。
5. 在「收件箱」处理积压，在「全库视图」检查内容分布、README 完整性和创建热力图。
6. 在「设置」选择主题、映射目录，并决定是否把 TT 主题同步到整个 Vault。

## 安全与隐私

- 云端 API 密钥、Token 和语音长期凭据只保存在 Obsidian SecretStorage，不写入普通插件配置。
- 本机 CLI 使用现有登录态，SecretStorage 值不会进入模型上下文、日志、诊断报告或发布包。
- Direct API 通道只提供文本规划，不暴露本机工具。
- 本机执行必须通过 OS 级沙箱；无法验证隔离时拒绝 Execute。唯一例外是用户在设置页显式开启的 Windows 无隔离执行后端（该后端 `osIsolation: false`，不是隔离）。
- 文件写入受 Vault 边界、受保护路径、审批策略和审计记录共同约束。
- 实时语音只注册有限的只读 Vault 工具；联网搜索需要明确口令。

当前的执行链路实现在 `src/agent-workbench/`：`contracts/` 定义端口与事件契约，`adapters/` 与 `transports/` 落地 OhMyPi 原生运行时与 Direct API 两类通道，`ui/` 提供工作台界面。升级与回滚验收见 [`docs/qa/wp7-upgrade-rollback.md`](docs/qa/wp7-upgrade-rollback.md)。

## 开发与验证

```bash
npm install
npm test
npm run typecheck
npm run typecheck:tests
npm run lint
npm run licenses:check
npm run build
```

生产构建会执行许可证审计、TypeScript 检查、样式合并和 esbuild 打包。任何分发包必须包含安装章节列出的 9 个文件（见安装章节的清单，不再重复枚举）。

功能硬门有两种跑法：`npm run test:chat-gate:fixture` 用 `fixtures/chat-gate/` 的合成夹具跑（CI 用这条，正例 exit 0 / 反例 exit 1）；`npm run test:chat-gate <vaultRoot>` 是可选的真实 Vault 补充跑法，需要把 `<vaultRoot>` 作为参数传入，无参时以 `FAIL 用法：…` 退出码 2 结束。

### 源码结构

- `src/main.ts`：插件生命周期、命令与装配；语音工具、诊断、Provider 等拆在 `src/plugin/`。
- `src/view.ts`：控制台 ItemView 与导航；业务页面、图表和审批区拆在 `src/ui/pages/`、`src/ui/charts/` 与 `src/ui/view-*.ts`。
- `src/agent-workbench/`：多智能体会话、运行时适配、审批、安全、存储和 UI。
- `src/harness/`：DeepSeek Harness 嵌入、进程管理和健康检查。
- `src/quyuan/`：人格、Qwen Realtime 语音、只读工具和 TALOS Ball 舞台。
- `src/data/`：全库统计、导航、项目与发布状态采集。
- `tests/`：跨平台、安全、迁移、语音、Provider 和 UI 契约回归。
- `docs/CODE-REVIEW-TT.md`：定制基线的全方位代码审查报告。
- `MODIFICATIONS.md` / `ACCEPTANCE.md` / `ROADMAP.md`：定制修改清单、验收结论与后续路线。

## 许可

> Copyright © 2026 外脑玩家 Haaper. 源码对个人非商业用途开放；商业使用须事先获得书面授权。

- `LICENSE`：TALOS 自有材料采用 **TALOS Personal Use Source License 1.0**（逐字保留，未做任何修改）。个人非商业使用、学习、修改及按同一许可非商业分享无需付费；任何商业使用必须事先取得书面授权。该许可属于 Source Available，不是 OSI 批准的开源许可证。本 fork 的分发遵循同一许可，未施加任何额外限制，亦不收取任何费用。
- 商业授权联系（上游作者）：微信 `wadeonly`；邮箱 `han747266@gmail.com`。
- `THIRD-PARTY-NOTICES.md`：第三方组件、视觉参考和商业条款摘要。
- `THIRD-PARTY-LICENSES.txt`：由 lockfile 自动生成的生产依赖许可证包。
- `MaShanZheng-Regular.ttf` / `MaShanZheng-OFL.txt`：屈原标题字体及 SIL OFL 1.1 许可证。
- **TALOS Ball**：语音中心视觉使用 TalosBall 0.3.0；来源与发布门见 [TALOS Ball provenance](docs/talos-ball-provenance.md)。

完整变更记录见 [`CHANGELOG.md`](CHANGELOG.md)；上游原始说明以 [上游仓库 README](https://github.com/WAINAO-Haaper/talos-plugin#readme) 为准。
