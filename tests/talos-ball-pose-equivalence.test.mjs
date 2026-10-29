import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { createPoseManifest } from "./helpers/talos-ball-pose-equivalence.mjs";

const vendorRoot = new URL("../src/quyuan/talos-ball/runtime/vendor/talos-ball-runtime/", import.meta.url);
// `URL.pathname` 在 win32 上是 `/C:/...` 形态，交给 fs 会拼出非法路径；
// 这里取真实的文件系统路径。
const vendorRootPath = fileURLToPath(vendorRoot);
const expected = JSON.parse(
  await readFile(
    new URL("./fixtures/talos-ball-pose-manifest.json", import.meta.url),
    "utf8"
  )
);

test("all 32 deterministic pose traces match the pinned upstream baseline", async () => {
  const actual = await createPoseManifest(vendorRootPath);
  assert.deepEqual(actual, expected);
});
