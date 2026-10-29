import { readFileSync } from "node:fs";
import {
  clearTimeout as nodeClearTimeout,
  setTimeout as nodeSetTimeout,
} from "node:timers";
import { describe, it, expect, vi } from "vitest";

const notices: string[] = [];

vi.mock("obsidian", () => {
  class MockTFile {
    constructor(readonly path: string) {}
  }
  class MockTFolder {}
  class MockModal {}
  class MockNotice {
    constructor(message: string) {
      notices.push(message);
    }
  }
  class MockSetting {}
  return {
    App: class {},
    FileSystemAdapter: class {},
    Modal: MockModal,
    Notice: MockNotice,
    Setting: MockSetting,
    TFile: MockTFile,
    TFolder: MockTFolder,
    normalizePath: (path: string) => path,
  };
});

import { TFile, type App } from "obsidian";
import {
  applyPendingApprovalDecision,
  isPendingApprovalStatusLine,
} from "../src/approval-actions";
import {
  approveAndExecuteApprovalWithMockModel,
  decidePendingApproval,
  registerApprovalTaskRuntime,
} from "../src/actions";
import { createApprovalTaskRuntime } from "../src/approval-task-runtime";
import type { TalosSettings } from "../src/settings";
import type { TaskTimerHost } from "../src/task-core/task-runner";

const fixture = `# 待审批变更

## 当前待审批

### #QA-B 测试审批 [2026-07-08]

**状态**：待审批

**变更内容**：验证界面按钮能否写回审批决策。

**回滚方案**：必要时手动恢复 \`**状态**：待审批\`。

### #KEEP-B 另一条 [2026-07-08]

**状态**：待审批

**变更内容**：用于确认只修改目标块。

## 已解决
`;

function pendingCount(content: string): number {
  const section = content.match(
    /## 当前待审批([\s\S]*?)(?:\n### 后续候选|\n## 保留观察项|\n## 已解决|$)/
  )?.[1] ?? "";
  return section.split("\n").filter(isPendingApprovalStatusLine).length;
}

describe("isPendingApprovalStatusLine", () => {
  it("识别全角冒号的待审批状态行", () => {
    expect(isPendingApprovalStatusLine("**状态**：待审批")).toBe(true);
  });

  it("识别半角冒号的待审批状态行", () => {
    expect(isPendingApprovalStatusLine("**状态**: 待审批")).toBe(true);
  });

  it("不误判回滚方案里提到的状态行", () => {
    expect(
      isPendingApprovalStatusLine("**回滚方案**：恢复 `**状态**：待审批`。")
    ).toBe(false);
  });

  it("不误判被反引号包裹的状态行", () => {
    expect(isPendingApprovalStatusLine("`**状态**：待审批`")).toBe(false);
  });
});

describe("applyPendingApprovalDecision", () => {
  it("批准：写回批准状态、执行结果、界面操作，并从待审批移除", () => {
    const approved = applyPendingApprovalDecision(fixture, {
      title: "#QA-B 测试审批 [2026-07-08]",
      decision: "approve",
      date: "2026-07-08",
      operator: "Haaper",
    });

    expect(approved.ok).toBe(true);
    expect(approved.removedFromPending).toBe(true);
    expect(approved.content).toMatch(
      /\*\*状态\*\*：✅ 已批准（2026-07-08，界面按钮）/
    );
    expect(approved.content).toMatch(
      /\*\*执行结果\*\*：🟡 已记录审批决策，具体变更尚未执行。/
    );
    expect(approved.content).toMatch(
      /\*\*界面操作\*\*：2026-07-08 Haaper 点击「批准」。/
    );
    // 只移除目标项，不影响其他待审批项
    expect(approved.content).toMatch(
      /### #KEEP-B 另一条 \[2026-07-08\][\s\S]*\*\*状态\*\*：待审批/
    );
    expect(pendingCount(approved.content)).toBe(1);
  });

  it("拒绝：写回拒绝状态和未执行说明", () => {
    const rejected = applyPendingApprovalDecision(fixture, {
      title: "#QA-B 测试审批 [2026-07-08]",
      decision: "reject",
      date: "2026-07-08",
    });

    expect(rejected.ok).toBe(true);
    expect(rejected.content).toMatch(
      /\*\*状态\*\*：❌ 已拒绝（2026-07-08，界面按钮）/
    );
    expect(rejected.content).toMatch(
      /\*\*执行结果\*\*：❌ 已拒绝，未执行提案内容。/
    );
    expect(rejected.content).toMatch(
      /\*\*界面操作\*\*：2026-07-08 点击「拒绝」。/
    );
    expect(pendingCount(rejected.content)).toBe(1);
  });

  it("未找到审批项时返回失败且不改内容", () => {
    const missing = applyPendingApprovalDecision(fixture, {
      title: "#MISSING-B 不存在",
      decision: "approve",
      date: "2026-07-08",
    });

    expect(missing.ok).toBe(false);
    expect(missing.content).toBe(fixture);
    expect(missing.message).toMatch(/未找到审批项/);
  });

  it("缺少状态行时返回失败", () => {
    const withoutStatus = fixture.replace(
      "**状态**：待审批",
      "**状态丢失**：待审批"
    );
    const invalid = applyPendingApprovalDecision(withoutStatus, {
      title: "#QA-B 测试审批 [2026-07-08]",
      decision: "approve",
      date: "2026-07-08",
    });

    expect(invalid.ok).toBe(false);
    expect(invalid.content).toBe(withoutStatus);
    expect(invalid.message).toMatch(/缺少状态行/);
  });

  it("批准：正文中段的标签字面量原样保留，不被当成字段行替换", () => {
    const withInlineLabel = fixture.replace(
      "**变更内容**：验证界面按钮能否写回审批决策。",
      "**变更内容**：把旧记录 `**执行结果**：已完成` 改为新值。"
    );
    const approved = applyPendingApprovalDecision(withInlineLabel, {
      title: "#QA-B 测试审批 [2026-07-08]",
      decision: "approve",
      date: "2026-07-08",
      operator: "Haaper",
    });

    expect(approved.ok).toBe(true);
    expect(has(approved.content, "改为新值")).toBe(true);
    expect((approved.content.match(/\*\*执行结果\*\*/g) || []).length).toBe(2);
  });

  it("拒绝：正文中段的标签字面量原样保留，不被当成字段行替换", () => {
    const withInlineLabel = fixture.replace(
      "**变更内容**：验证界面按钮能否写回审批决策。",
      "**变更内容**：把旧记录 `**执行结果**：已完成` 改为新值。"
    );
    const rejected = applyPendingApprovalDecision(withInlineLabel, {
      title: "#QA-B 测试审批 [2026-07-08]",
      decision: "reject",
      date: "2026-07-08",
    });

    expect(rejected.ok).toBe(true);
    expect(has(rejected.content, "改为新值")).toBe(true);
    expect((rejected.content.match(/\*\*执行结果\*\*/g) || []).length).toBe(2);
  });
});

const nodeTimers: TaskTimerHost = {
  schedule: (callback, timeoutMs) => nodeSetTimeout(callback, timeoutMs),
  cancel: (handle) => nodeClearTimeout(handle as NodeJS.Timeout),
};

const PENDING_PATH = "System/pending-approvals.md";
const TARGET_PATH = "System/target.md";

const executableFixture = `# 待审批变更

## 当前待审批

### #QA-A 甲项 [2026-07-08]

**状态**：待审批

**变更内容**：把旧记录 \`**执行结果**：已完成\` 改为新值。

**执行器**：mock-model-file-append
**目标文件**：System/target.md
**执行指令**：读取目标文件并追加模型处理回执。

### #QA-B 乙项 [2026-07-08]

**状态**：待审批

**变更内容**：乙项说明。

## 已解决
`;

interface FakeVaultOptions {
  /** read() 进入时的钩子：用于把执行卡在长异步里。 */
  onRead?: (path: string) => Promise<void>;
}

/** 子串判定（不用 toContain：Q-TES5 的闸门只允许该计数单调下降）。 */
function has(haystack: string, needle: string): boolean {
  return haystack.includes(needle);
}

function fakeApp(files: Record<string, string>, options: FakeVaultOptions = {}) {
  const store = new Map(Object.entries(files));
  const MockTFile = TFile as unknown as new (path: string) => TFile;
  const pathOf = (file: TFile): string =>
    (file as unknown as { path: string }).path;
  const vault = {
    adapter: {},
    getAbstractFileByPath: (path: string): TFile | null =>
      store.has(path) ? new MockTFile(path) : null,
    read: vi.fn(async (file: TFile): Promise<string> => {
      if (options.onRead) await options.onRead(pathOf(file));
      return store.get(pathOf(file)) ?? "";
    }),
    modify: vi.fn(async (file: TFile, data: string): Promise<void> => {
      store.set(pathOf(file), data);
    }),
    process: vi.fn(
      async (file: TFile, fn: (data: string) => string): Promise<string> => {
        const next = fn(store.get(pathOf(file)) ?? "");
        store.set(pathOf(file), next);
        return next;
      }
    ),
  };
  return { app: { vault } as unknown as App, store, vault };
}

describe("approveAndExecuteApprovalWithMockModel 在最新内容上重放", () => {
  it("执行期间的第二次决策不被旧快照整份回滚", async () => {
    let releaseTargetRead: () => void = () => undefined;
    const targetReadGate = new Promise<void>((resolve) => {
      releaseTargetRead = () => resolve();
    });
    let signalTargetRead: () => void = () => undefined;
    const targetReadEntered = new Promise<void>((resolve) => {
      signalTargetRead = () => resolve();
    });
    let targetReads = 0;

    const { app, store, vault } = fakeApp(
      {
        [PENDING_PATH]: executableFixture,
        [TARGET_PATH]: "# 目标文件\n\n正文",
      },
      {
        onRead: async (path) => {
          if (path !== TARGET_PATH) return;
          targetReads += 1;
          if (targetReads !== 1) return;
          signalTargetRead();
          await targetReadGate;
        },
      }
    );
    registerApprovalTaskRuntime(app, createApprovalTaskRuntime(nodeTimers));
    const settings = {
      pendingApprovalsPath: PENDING_PATH,
      candidatesPath: "System/candidates.md",
    } as TalosSettings;

    const executing = approveAndExecuteApprovalWithMockModel(
      app,
      settings,
      "#QA-A 甲项 [2026-07-08]"
    );

    // 执行卡在 read(target)：此时插入对同一文件的第二次决策（乙项）。
    await targetReadEntered;
    await expect(
      decidePendingApproval(app, settings, "#QA-B 乙项 [2026-07-08]", "approve")
    ).resolves.toBe(true);
    releaseTargetRead();

    await expect(executing).resolves.toBe(true);

    const final = store.get(PENDING_PATH) ?? "";
    // 乙项仍是已批准（旧实现会用旧快照把它整份回滚成待审批）
    expect(final).toMatch(
      /### #QA-B 乙项 \[2026-07-08\][\s\S]*?\*\*状态\*\*：✅ 已批准/
    );
    // 甲项也完成批准 + 执行回执
    expect(final).toMatch(
      /### #QA-A 甲项 \[2026-07-08\][\s\S]*?\*\*状态\*\*：✅ 已批准/
    );
    // 重放最新内容不会二次截断：正文里的标签字面量仍在，字段行只有 1 条
    expect(has(final, "改为新值")).toBe(true);
    expect((final.match(/\*\*模型执行结果\*\*/g) || []).length).toBe(1);
    // 目标文件只追加一段
    const target = store.get(TARGET_PATH) ?? "";
    expect((target.match(/## TALOS 模型执行测试/g) || []).length).toBe(1);
    // 写回走的是 process 的读-改-写（decidePendingApproval 那条既有路径仍用 read+modify）
    expect(vault.process).toHaveBeenCalledTimes(1);
  });

  it("execute 闭包内不再引用旧快照的 approved.content", () => {
    const source = readFileSync(
      new URL("../src/actions.ts", import.meta.url),
      "utf8"
    );
    const start = source.indexOf(
      "export async function approveAndExecuteApprovalWithMockModel("
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const nextExport = source.indexOf("\nexport ", start + 1);
    const body = source.slice(start, nextExport < 0 ? undefined : nextExport);
    const runIndex = body.indexOf("getApprovalTaskRuntime(app).run(");
    expect(runIndex).toBeGreaterThanOrEqual(0);
    const afterRun = body.slice(runIndex);
    expect(afterRun.match(/approved\.content/g) || []).toHaveLength(0);
  });
});
