import assert from "node:assert/strict";
import test from "node:test";
import {
  checkApiKey,
  checkEndpoint,
  checkModel,
  normalizeEndpoint,
  presetFor,
  validateForm,
} from "../../src/lib/settings-form";

test("选提供商自动带出接口地址与默认模型名", () => {
  assert.deepEqual(presetFor("deepseek"), {
    endpoint: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  });
  assert.equal(presetFor("openai").model, "gpt-4o-mini");
  assert.equal(presetFor("qwen").endpoint, "https://dashscope.aliyuncs.com/compatible-mode/v1");
  assert.equal(presetFor("claude").endpoint, "https://api.anthropic.com/v1");
  // 自定义没有预设，需要用户自己填全
  assert.deepEqual(presetFor("custom"), { endpoint: "", model: "" });
});

test("API Key 校验：空 / 空格 / 全角 / 太短 / 正常", () => {
  assert.equal(checkApiKey(""), "请输入 API Key");
  assert.equal(checkApiKey("   "), "请输入 API Key");
  assert.equal(checkApiKey("sk-123 456"), "API Key 格式不正确，请去掉空格、换行和全角字符");
  assert.equal(checkApiKey("ｓｋ－１２３４５６７８"), "API Key 格式不正确，请去掉空格、换行和全角字符");
  assert.equal(checkApiKey("abc"), "API Key 看起来太短，请检查是否复制完整");
  assert.equal(checkApiKey("sk-00000000000000000000000000000000"), null);
  // 编辑已有配置时留空 = 不修改
  assert.equal(checkApiKey("", true), null);
  assert.equal(checkApiKey("   ", true), null);
  assert.equal(checkApiKey("bad key", true), "API Key 格式不正确，请去掉空格、换行和全角字符");
});

test("接口地址校验与归一化", () => {
  assert.equal(checkEndpoint(""), "请输入接口地址");
  assert.equal(checkEndpoint("api.deepseek.com/v1"), "接口地址必须以 http:// 或 https:// 开头");
  assert.equal(
    checkEndpoint("https://api.deepseek.com/v1/chat/completions"),
    "请填写接口基地址，末尾不要带 /chat/completions",
  );
  assert.equal(checkEndpoint("https://api.deepseek.com/v1"), null);
  assert.equal(checkEndpoint("http://127.0.0.1:11434/v1"), null);
  assert.equal(normalizeEndpoint("  https://api.deepseek.com/v1///  "), "https://api.deepseek.com/v1");
  assert.equal(normalizeEndpoint("http://localhost:11434/v1/"), "http://localhost:11434/v1");
});

test("模型名称不能为空", () => {
  assert.equal(checkModel(""), "请输入模型名称");
  assert.equal(checkModel("  "), "请输入模型名称");
  assert.equal(checkModel("deepseek-chat"), null);
});

test("新建配置必须填 Key，编辑配置可留空", () => {
  const base = {
    apiKey: "",
    endpoint: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
  };
  assert.deepEqual(validateForm(base, { editing: false }), { apiKey: "请输入 API Key" });
  assert.deepEqual(validateForm(base, { editing: true }), {});

  const broken = {
    apiKey: "sk-123 456",
    endpoint: "https://api.deepseek.com/v1/chat/completions",
    model: "",
  };
  assert.deepEqual(validateForm(broken, { editing: false }), {
    apiKey: "API Key 格式不正确，请去掉空格、换行和全角字符",
    endpoint: "请填写接口基地址，末尾不要带 /chat/completions",
    model: "请输入模型名称",
  });
});
