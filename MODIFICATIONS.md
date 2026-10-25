# MODIFICATIONS — TT工作台 (TT-Workbench) 相对上游的修改清单

> 基线上游:`WAINAO-Haaper/talos-plugin` @ commit `fb365d0`(v0.4.9,2026-10-13)。
> 本清单满足 TALOS Personal Use Source License 1.0 第 2 节"modified files are clearly identified"的要求,由 `git diff --name-status fb365d0 HEAD` 精确生成。
> **未修改**:`LICENSE`、`THIRD-PARTY-NOTICES.md`、`THIRD-PARTY-LICENSES.txt`、`MaShanZheng-*`、全部 vendor 快照(逐字节一致,已由 .gitattributes 钉死)。

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

## 刻意保留(合规或合同要求)

1. `LICENSE` / `THIRD-PARTY-NOTICES.md` / `THIRD-PARTY-LICENSES.txt` / `MaShanZheng-*` — 许可证与第三方声明逐字保留(license 第 2 节要求)。
2. 命令 id `talos-ask` — canonical 注册表合同要求逐字稳定(`src/main.ts` 注释、`src/canonical/*`、7 个测试共同锁定);Obsidian 命令面板实际显示"TT工作台: 全库问答"。
3. `.talos/` 数据目录、`.talos/private` 等保护区路径 — 既有用户数据与安全策略兼容层。
4. vault 内 `TALOS系统/`、`TALOS中枢/` 目录约定 — 用户 Vault 侧数据结构,不属于插件品牌。
5. CSS 类名 `talos-*` 前缀(约 4091 处)与 `VIEW_TYPE_TALOS` 等内部标识符 — 内部 ABI,52 个测试文件依赖;批量重命名属高风险重写,已列入 `ROADMAP.md` 批次三评估。
6. 死代码链(本地 ASR 整链、背景动画三件套等) — 本批次不删(有供应链测试依赖),已列入 `ROADMAP.md` 批次二。
