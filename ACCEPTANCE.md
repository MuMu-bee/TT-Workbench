# ACCEPTANCE — TT工作台 (TT-Workbench) 1.0.0 验收清单

> 验收日期:2026-10-25。基线:上游 `fb365d0`(v0.4.9)。验收环境:Windows 11 x64 / Node 22 / 权威环境为仓库 CI(Ubuntu)。

| # | 验收标准 | 验证方式 | 结果 |
|---|---|---|---|
| A1 | 原项目 `LICENSE` 逐字保留 | `git diff fb365d0 HEAD -- LICENSE` 输出为空;.gitattributes 将 LICENSE 钉为 `-text` 防止换行改写 | ✅ 通过(0 diff) |
| A2 | 插件 id / 包名统一为 `tt-workbench` | `manifest.json` id 与 `package.json` name 均为 `tt-workbench`;`versions.json` 含 1.0.0 | ✅ 通过 |
| A3 | UI 标题与命令名无残留"TALOS"自指 | 全 src 字符串字面量扫描:剩余 39 处均属保留类别(署名/TalosBall 资产/vault 数据路径/死代码链),见 MODIFICATIONS.md"刻意保留"节;ribbon、视图标题、设置页、欢迎页均已品牌化 | ✅ 通过 |
| A4 | typecheck 与 lint 通过 | `npx tsc --noEmit --skipLibCheck` 退出码 0;`npx eslint .` 0 error 0 warning | ✅ 通过 |
| A5 | 测试通过数 ≥ 基线(926)且无基线外新失败 | `npx vitest run`:937 通过 / 5 失败;5 项失败与品牌化前完全一致,均为上游测试自身 Windows 兼容问题(路径拼接 `C:\C:`、反斜杠断言、PATH 探测),上游 CI(Ubuntu)同批测试通过 | ✅ 通过 |
| A6 | 构建与许可证审计通过 | `npm run build`:108 生产包许可证审计 + typecheck + 样式构建(981KB→849KB) + esbuild production + peer-status 守卫 + claude-sdk split 守卫全部 pass;三个 selftest(quyuan/approval-actions/approval-executor)通过 | ✅ 通过 |
| A7 | 原作者署名保留于三处以上 | ① `src/legal.ts` `TALOS_COPYRIGHT_NOTICE`(版权常量逐字保留) ② `README.md` "与 TALOS 的关系"+"许可"章节 ③ `esbuild.config.mjs` banner ④ 设置页页脚 `TALOS_SETTINGS_COPYRIGHT_DESC` ⑤ 欢迎页"原项目与作者(TALOS)"区块 ⑥ `MODIFICATIONS.md` 基线声明 | ✅ 通过 |
| A8 | GitHub 公开仓库 CI 绿 | 仓库 `TT-Workbench` 推送后 GitHub Actions 五道门(lint/typecheck/test/selftests/license/build)运行结论见下方"CI 记录" | ✅ 通过(见下) |
| A9 | 修改文件逐文件可追溯 | `MODIFICATIONS.md` 由 `git diff --name-status fb365d0 HEAD` 生成:2 新增 / 2 删除 / 49 修改,与实际 diff 一致 | ✅ 通过 |
| A10 | 分发不施加额外限制、不收费 | README"许可"章节明确:同一许可、无新增限制、无任何费用;仓库无付费入口 | ✅ 通过 |

## CI 记录

- 仓库:[MuMu-bee/TT-Workbench](https://github.com/MuMu-bee/TT-Workbench)(public,main)
- 1.0.0 品牌化批次:权威运行 [run 40196315122](https://github.com/MuMu-bee/TT-Workbench/actions/runs/40196315122) @ `758ecbd`:**success**(945 项测试全绿)。首次运行 40195720207 的 2 项文本断言失败已修复(758ecbd)。
- 1.1.0 运行时收敛批次:推送过程中修复三处 CI 环境问题(① lockfile 失同步→重建;② npm 11 生成 lock 在 CI 触发 EBADPLATFORM→CI 升级 Node 24 与本地工具链一致;③ 许可清单随 lock 过期→重生成),权威运行 @ `4ae5fa4`:**success**,Job "Lint · Typecheck · Test · License · Build" 全部通过。
- 交付过程说明:1.0.0 交付期间本地网络对 GitHub 大包上传持续重置,曾启用 git-data API 兜底通道;网络恢复后以完整 `git push` 交付全量历史。1.1.0 批次直接 git push 成功。

## 1.1.0 运行时收敛批次验收(2026-10-25)

| # | 验收标准 | 结果 |
|---|---|---|
| B1 | 原生运行时仅剩 OhMyPi:RuntimeId 契约 = "ohmypi",Claude/Codex 适配链(适配器/传输/SDK依赖/独立bundle/守卫脚本)全部删除 | ✅ 代码检索 0 残留;typecheck 通过 |
| B2 | Provider 注册表仅产出挂载 ohmypi 的 anthropic-api / openai-compatible 两个 Direct API profile;旧 codex 凭据不再生成 profile(回归测试钉死) | ✅ |
| B3 | 屈原语音 Realtime 服务端可插拔:dashscope 预设语义不变;openai-compatible 走两步握手(/sessions 临时凭据 → SDP 交换);端点 HTTPS/loopback 校验、SecretStorage 密钥、出库审计与一次性授权保留 | ✅ 单元测试+类型验证 |
| B4 | OhMyPi 沙箱获得与原 Codex 分支同级的 Vault 保护区拒绝与 .env 拒绝 | ✅ security/native-runtime-policy 测试锁定 |
| B5 | 五道门:typecheck/lint/测试(886 通过,4 项为既有 Windows 平台差异)/102 包许可证审计/生产构建(main.js 0.83MB,无 SDK 残留) | ✅ 本地全绿 |
| B6 | CI(Ubuntu,Node 24)全绿 @ `4ae5fa4` | ✅ |
| B7 | 文档同步:README(运行时/语音/安装清单)、CHANGELOG 1.1.0、MODIFICATIONS 1.1.0 节 | ✅ |
| B8 | 破坏性变更明示:Claude/Codex 本机运行时不再可用(codex 系设置字段转迁移兼容) | ✅ CHANGELOG/README 注明 |

## 已知平台差异(非缺陷,不在验收排除范围)

上游测试在 Windows 本地存在 5 项与代码无关的失败(上游 CI 全绿):
1. `chat-egress-wiring.test.ts` — `new URL("../").pathname` 在 Windows 产生 `C:\C:\...` 拼接 bug(测试自身缺陷);
2. `agent-workbench-composition.test.ts` — 用 POSIX 风格 `\synthetic-home` 做路径包含断言,未考虑 win32 反斜杠规范化;
3. `agent-workbench-desktop-runtime-discovery.test.ts` — 依赖受控 PATH 的 GUI shell 探测,Windows 桌面环境差异;
4. `talos-ball-pose-equivalence.test.mjs` — 依赖字节级文件读取的确定性基线,受 CRLF 历史影响;
5. `voice-vault-tools.test.ts` — 同类平台计数差异。
处置:已列入 ROADMAP 批次二(上游测试 Windows 兼容化);权威验收以 CI(Ubuntu)为准。
