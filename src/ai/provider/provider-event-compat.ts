import type { AskEvent } from "./types";
import type { ProviderAskEvent } from "../../agent-workbench/contracts/provider-port";

/**
 * Q-ARC5：契约形状漂移的编译期守卫。
 *
 * 背景：`contracts/provider-port.ts` 的 `ProviderAskEvent` 是 `ai/provider/types` 里
 * `AskEvent` 的**复制形状**（contracts 不得反向 import 实现层，见 `provider-port.ts:1-12`
 * 自述的「adapters → contracts ← ai/provider」方向）。复制形状本身没错，错在没有东西
 * 盯着它——于是 `AskEvent` 长出 `tool-skipped` 后契约没跟上，direct-api 适配器
 * 只好用双重类型断言把差异抹平，`mapEvent` 静默丢弃该事件。
 *
 * 这个文件把「复制形状仍是 `AskEvent` 的父类型」变成编译期断言：
 * 实现层新增 variant / 把可选字段改必填，都会在这里报错，而不是等到运行时静默丢弃。
 *
 * 为什么放在 `src/ai/provider/` 而不是计划原写的 `src/agent-workbench/adapters/shared/`：
 * 本仓库的 `scripts/check-module-boundaries.mjs` 把 `adapters|legacy → ai/provider` 明确
 * 列为**违规**（6 条存量已按 `reviewBy` 逐个进白名单），且 `tests/module-boundaries.test.ts`
 * 用 `toHaveLength(6)` 钉住这个数字。计划里「adapters 层已合法 import ai/provider」的前提
 * 在本仓库不成立——那里能 import 的只有被白名单登记的三条具体 specifier。
 * 反过来 `src/ai/provider/ → agent-workbench/contracts` 已是被接受的既有方向
 * （`agent-workbench-provider-adapter.ts:1,6`），本文件沿用这条方向，
 * 因此不新增任何边界违规、也不需要动白名单与那个 6。
 *
 * 守卫强度与原计划等价：断言仍然是「实现层 AskEvent 必须覆盖契约 ProviderAskEvent」，
 * 只是把断言放在了允许看到两侧的那一层。
 */

/**
 * `Impl` 是否为 `Contract` 的子类型。
 *
 * 上游新增一个契约没有的 variant 时，`AskEvent` 不再是 `ProviderAskEvent` 的子类型，
 * 这里的 `true` 会变成 `never`，`Covers<...> = true` 随即报 TS2322（实测报错信息为
 * `Type 'true' is not assignable to type 'never'`）。
 */
type Covers<Contract, Impl> = [Impl] extends [Contract] ? true : never;

/**
 * `_providerAskEventCovers: true` 是断言本身，不是无用变量：
 * 从契约删掉 `tool-skipped` 分支后这里立刻编译失败（本轮实测 `npx tsc --noEmit --skipLibCheck`
 * 退出码 2、报 TS2322），那就是「漂移由编译期挡住而不是运行时静默」的落地形式。
 */
const _providerAskEventCovers: Covers<ProviderAskEvent, AskEvent> = true;

export { _providerAskEventCovers };
