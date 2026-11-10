import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 必须在 import settings-store 之前指定一个临时库，避免碰到真实数据
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "readflow-settings-"));
process.env.DB_PATH = path.join(tmpDir, "settings-test.db");

type Store = {
  getSetting: (key: string, userId?: string) => string | null;
  setSetting: (key: string, value: string, userId?: string) => void;
  deleteSetting: (key: string, userId?: string) => void;
  allSettings: (userId?: string) => Record<string, string>;
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

// ===== P20：站级默认 + 用户覆盖 =====

test("密钥类配置：本人覆盖优先，站级行不被改写", () => {
  store.setSetting("ai.model", "gpt-4o-mini"); // 不传 userId = 站级默认
  assert.equal(store.getSetting("ai.model", "user-a"), "gpt-4o-mini", "无覆盖时回退站级");
  store.setSetting("ai.model", "deepseek-chat", "user-a");
  assert.equal(store.getSetting("ai.model", "user-a"), "deepseek-chat");
  assert.equal(store.getSetting("ai.model", "user-b"), "gpt-4o-mini", "A 的覆盖不影响 B");
  assert.equal(store.getSetting("ai.model"), "gpt-4o-mini", "站级行本身未被改写");
});

test("profile.* 绝不回退站级，否则 A 会看到 owner 的昵称", () => {
  store.setSetting("profile.displayName", "站级残留昵称");
  assert.equal(store.getSetting("profile.displayName", "user-a"), null);
  store.setSetting("profile.displayName", "Alice", "user-a");
  assert.equal(store.getSetting("profile.displayName", "user-a"), "Alice");
  assert.equal(store.getSetting("profile.displayName", "user-b"), null);
  assert.equal(store.getSetting("profile.displayName"), "站级残留昵称", "站级行仍在，只是不给账号看");
});

test("allSettings(userId)：合并站级默认与本人覆盖，且不泄漏站级 profile", () => {
  const a = store.allSettings("user-a");
  assert.equal(a["ai.model"], "deepseek-chat");
  assert.equal(a["profile.displayName"], "Alice");
  const b = store.allSettings("user-b");
  assert.equal(b["ai.model"], "gpt-4o-mini");
  assert.equal(b["profile.displayName"], undefined, "站级 profile 不能下发给账号");
});

test("删除个人覆盖后回退站级，删除站级不影响已有覆盖", () => {
  store.deleteSetting("ai.model", "user-a");
  assert.equal(store.getSetting("ai.model", "user-a"), "gpt-4o-mini");
  store.deleteSetting("profile.displayName", "user-a");
  assert.equal(store.getSetting("profile.displayName", "user-a"), null);
});
