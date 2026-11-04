import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PROVIDERS,
  SETTINGS_KEYS,
  isMaskedValue,
  maskSecret,
  providerStatuses,
  resolveMarkjiToken,
  resolveProvider,
} from "../../src/lib/config";

const env = (v: Record<string, string | undefined> = {}) => v;

test("maskSecret 只留后四位，短密钥不外泄", () => {
  assert.equal(maskSecret("sk-1234567890abcdef"), "••••cdef");
  assert.equal(maskSecret("short"), "••••");
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret(null), "");
  assert.equal(isMaskedValue("••••cdef"), true);
  assert.equal(isMaskedValue("sk-real-key"), false);
});

test("环境变量兜底：没在设置页配置时仍能识别已有 Key", () => {
  const rows = providerStatuses({}, env({ DEEPSEEK_API_KEY: "sk-env-deepseek-9999" }));
  const deepseek = rows.find((r) => r.id === "deepseek")!;
  assert.equal(deepseek.configured, true);
  assert.equal(deepseek.source, "env");
  assert.equal(deepseek.maskedKey, "••••9999");
  assert.equal(deepseek.model, "deepseek-chat");
});

test("设置页的值覆盖环境变量，且 source 标为 db", () => {
  const rows = providerStatuses(
    {
      [SETTINGS_KEYS.providerKey("openai")]: "sk-from-db-1234",
      [SETTINGS_KEYS.providerModel("openai")]: "gpt-4o",
      [SETTINGS_KEYS.providerBaseUrl("openai")]: "https://proxy.example/v1",
    },
    env({ OPENAI_API_KEY: "sk-env-0000" }),
  );
  const openai = rows.find((r) => r.id === "openai")!;
  assert.equal(openai.source, "db");
  assert.equal(openai.maskedKey, "••••1234");
  assert.equal(openai.model, "gpt-4o");
  assert.equal(openai.baseUrl, "https://proxy.example/v1");
});

test("勾选哪个用哪个：activeProvider 优先于列表顺序和环境变量", () => {
  const settings = {
    [SETTINGS_KEYS.activeProvider]: "claude",
    [SETTINGS_KEYS.providerKey("deepseek")]: "sk-deepseek-1111",
    [SETTINGS_KEYS.providerKey("qwen")]: "sk-qwen-2222",
  };
  const resolved = resolveProvider(settings, env({ ANTHROPIC_API_KEY: "sk-ant-3333" }));
  assert.equal(resolved?.id, "claude");
  assert.equal(resolved?.model, "claude-sonnet-4-5-20250929");
  assert.equal(resolved?.protocol, "anthropic");
  assert.equal(resolved?.apiKey, "sk-ant-3333");
});

test("显式指定（测试连接）覆盖勾选", () => {
  const settings = {
    [SETTINGS_KEYS.activeProvider]: "claude",
    [SETTINGS_KEYS.providerKey("deepseek")]: "sk-deepseek-1111",
    [SETTINGS_KEYS.providerKey("qwen")]: "sk-qwen-2222",
  };
  assert.equal(resolveProvider(settings, env(), "qwen")?.id, "qwen");
});

test("勾选了但没配 Key → 返回 null，不静默换模型", () => {
  const settings = { [SETTINGS_KEYS.activeProvider]: "claude" };
  assert.equal(resolveProvider(settings, env()), null);
});

test("什么都没配 → null；只配了一个 → 自动用它", () => {
  assert.equal(resolveProvider({}, env()), null);
  const one = resolveProvider(
    { [SETTINGS_KEYS.providerKey("qwen")]: "sk-qwen-2222" },
    env(),
  );
  assert.equal(one?.id, "qwen");
});

test("自定义端点必须填全 baseUrl 与 model", () => {
  const partial = { [SETTINGS_KEYS.providerKey("custom")]: "sk-local-1111" };
  assert.equal(resolveProvider(partial, env(), "custom"), null);
  const full = {
    ...partial,
    [SETTINGS_KEYS.providerBaseUrl("custom")]: "http://127.0.0.1:11434/v1",
    [SETTINGS_KEYS.providerModel("custom")]: "qwen3:8b",
  };
  const r = resolveProvider(full, env(), "custom");
  assert.equal(r?.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(r?.model, "qwen3:8b");
});

test("provider 元数据完整且 id 唯一", () => {
  assert.equal(new Set(PROVIDERS.map((p) => p.id)).size, PROVIDERS.length);
  for (const p of PROVIDERS) {
    assert.ok(p.label && p.hint, `${p.id} 缺文案`);
    assert.ok(p.protocol === "openai" || p.protocol === "anthropic");
  }
});

test("墨墨 Token：设置页优先，env 兜底", () => {
  assert.equal(resolveMarkjiToken({}, env()), null);
  assert.equal(resolveMarkjiToken({}, env({ MARKJI_TOKEN: "mjm-env" })), "mjm-env");
  assert.equal(
    resolveMarkjiToken(
      { [SETTINGS_KEYS.markjiToken]: "mjm-db" },
      env({ MARKJI_TOKEN: "mjm-env" }),
    ),
    "mjm-db",
  );
});
