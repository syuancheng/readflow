import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须在 import settings-store 之前指定一个临时库，避免碰到真实数据
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "readflow-settings-"));
process.env.DB_PATH = path.join(tmpDir, "settings-test.db");

type Store = {
  getSetting: (key: string) => string | null;
  setSetting: (key: string, value: string) => void;
  deleteSetting: (key: string) => void;
  allSettings: () => Record<string, string>;
};
let store: Store;

before(async () => {
  // 动态 require，确保上面的 DB_PATH 先生效
  store = (await import("../../src/lib/settings-store")) as unknown as Store;
});

test("settings 读写：set → get", () => {
  store.setSetting("unit.key", "value-1");
  assert.equal(store.getSetting("unit.key"), "value-1");
  assert.equal(store.getSetting("unit.missing"), null);
});

test("settings 覆盖写：同 key 后值生效", () => {
  store.setSetting("unit.key", "value-2");
  assert.equal(store.getSetting("unit.key"), "value-2");
});

test("settings 全表读取含所有键", () => {
  store.setSetting("unit.key", "value-2");
  store.setSetting("markji.token", "mjm-test");
  assert.deepEqual(store.allSettings(), {
    "unit.key": "value-2",
    "markji.token": "mjm-test",
  });
});

test("settings 删除", () => {
  store.deleteSetting("markji.token");
  assert.equal(store.getSetting("markji.token"), null);
});

test("参数化 SQL：含引号的 Key/值不会被拼接破坏", () => {
  const tricky = "sk-' OR 1=1 --";
  store.setSetting("unit.injection", tricky);
  assert.equal(store.getSetting("unit.injection"), tricky);
  assert.equal(store.getSetting("unit.fake"), null);
});
