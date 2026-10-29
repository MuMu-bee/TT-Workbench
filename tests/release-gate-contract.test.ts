import type { App } from "obsidian";
import { TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import type { TalosSettings } from "../src/settings";
import { collectWarRoom } from "../src/data/talos";
import { viewSource as readViewSource, expectSourceContains, expectSourceNotContains } from "./helpers/source-text";

vi.mock("obsidian", () => ({
  TFile: class MockTFile {
    path = "04-项目/TALOS系统/tasks.md";
  },
  normalizePath: (path: string) => path,
}));

const view = readViewSource();

describe("unified TALOS release-gate contract", () => {
  it("accepts exactly G1-G7 and presents them in canonical order", () => {
    expectSourceContains("src/data/talos.ts", 
      'const PRODUCT_GATE_IDS = ["G1", "G2", "G3", "G4", "G5", "G6", "G7"] as const;'
    );
    expectSourceContains("src/data/talos.ts", "PRODUCT_GATE_ID_SET.has(id)");
    expectSourceContains("src/data/talos.ts", "PRODUCT_GATE_IDS.flatMap");
    expect(view).toContain('"统一七门", "G1–G7"');
    expect(view).not.toContain('"前置闸门", "G1 / G2 / G3"');
  });

  it("deduplicates and orders real gate input while ignoring unknown gates", async () => {
    const file = Reflect.construct(TFile, []);
    if (!(file instanceof TFile)) throw new Error("mock TFile construction failed");
    Object.defineProperty(file, "path", {
      value: "04-项目/TALOS系统/tasks.md",
      configurable: true,
    });
    const raw = [
      "- [ ] **G7** 许可待批准",
      "- [~] **G2** 确认式问答",
      "- [x] **G8** 未知门不得进入",
      "- [x] **G1** Provider 子证据",
      "- [x] **G2** 重复门不得覆盖第一次状态",
      "- [x] **PUB-W A** 内容发布动作",
    ].join("\n");
    const app = {
      vault: {
        getAbstractFileByPath: () => file,
        cachedRead: async () => raw,
      },
    } as unknown as App;
    const settings = {
      talosTasksPath: file.path,
      freezeStartDate: "",
    } as TalosSettings;

    const result = await collectWarRoom(app, settings);

    expect(result.gates.map((gate) => gate.id)).toEqual(["G1", "G2", "G7"]);
    expect(result.gates.map((gate) => gate.state)).toEqual(["done", "ready", "todo"]);
    expect(result.pubActions.map((action) => action.id)).toEqual(["PUB-W A"]);
  });

  it("keeps content publishing separate from product release authority", () => {
    expect(view).toContain('"内容发布动作", "PUB-W · 非产品发布门"');
    expectSourceContains("README.md", "PUB-W 属于内容发布工作流");
    expectSourceContains("README.md", "formal_release_allowed=false");
    expectSourceNotContains("README.md", "G1–G3 + PUB-W");
    expectSourceNotContains("README.md", "G1-G3 + PUB-W");
  });

  it("records real-provider evidence as partial without overclaiming", () => {
    expectSourceContains("docs/qa/wp7-real-provider-acceptance.md", "- 状态：PARTIAL");
    expectSourceContains("docs/qa/wp7-real-provider-acceptance.md", "这些子项只足以把 G1 维持为 `partial`");
    expectSourceNotContains("docs/qa/wp7-real-provider-acceptance.md", "- 状态：NOT STARTED");
    expectSourceNotContains("docs/qa/wp7-real-provider-acceptance.md", "G1 为 `pass`");
  });

  it("uses the component-bound minimum Obsidian version", () => {
    expectSourceContains("README.md", "Obsidian **≥ 1.11.4**");
    expectSourceNotContains("README.md", "Obsidian **≥ 1.8.0**");
  });
});
