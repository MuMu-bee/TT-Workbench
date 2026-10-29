import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 测试文件放在 tests/ 目录，文件名 *.test.ts
    include: ["tests/**/*.test.ts", "tests/**/*.test.mjs"],
    environment: "node",
    // 直接运行 .ts 源文件，无需转译
    deps: {
      optimizer: { ssr: { enabled: false }, web: { enabled: false } },
    },
    // `npx vitest run --coverage` 生成覆盖率；只统计插件源码
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      reporter: ["text-summary", "json-summary"],
      // Q-TES7：覆盖率门槛。数字来源一律可复跑：
      //  - 全局 lines: 37 —— 报告实测的全局行覆盖（已排除 5 个失败文件）为 37.89%
      //    (5774/15237)。取整到 37，先让「覆盖率不可见」变成「不可回退」。
      //    （本仓库当前同口径实测为 49.07%，7790/15875，只允许上升。）
      //  - src/agent-workbench/security/** lines: 78 —— 报告实测该目录行覆盖 78.2%。
      //  - src/agent-workbench/storage/** lines: 81 —— 报告实测该目录行覆盖 81.3%。
      //    （落地时同口径实测 security 79.4%、storage 96.7%，均在阈值之上。）
      // 只写 lines：报告没有给这两个目录的 statements 值，不得杜撰。
      // 阈值生效的校验载具是单文件跑，不是全量跑：
      //   NO_COLOR=1 npx vitest run --coverage --coverage.thresholds.lines=99 \
      //     --coverage.reportsDirectory=<临时目录> tests/voice-panel-labels.test.ts
      // 命中阈值会输出 `does not meet global threshold` 且退出码为 1。全量跑在测试
      // 有失败时 vitest 根本不产出 coverage summary，阈值不会被评估，不能当判据。
      thresholds: {
        lines: 37,
        "src/agent-workbench/security/**": { lines: 78 },
        "src/agent-workbench/storage/**": { lines: 81 },
      },
    },
  },
});
