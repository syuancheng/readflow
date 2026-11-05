import assert from "node:assert/strict";
import test from "node:test";
import {
  applyModelOption,
  checkApiKey,
  checkEndpoint,
  checkModel,
  CUSTOM_MODEL_OPTION,
  docsUrlFor,
  filterNavGroups,
  isPresetModel,
  modelOptionsFor,
  NAV_GROUPS,
  normalizeEndpoint,
  presetFor,
  PROVIDER_SELECT_LABEL,
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

test("导航搜索：空查询给全部分组，命中标题/关键字才保留", () => {
  assert.equal(filterNavGroups("").length, NAV_GROUPS.length);
  assert.equal(filterNavGroups("   ").length, NAV_GROUPS.length);

  const byTitle = filterNavGroups("墨墨");
  assert.equal(byTitle.length, 1);
  assert.deepEqual(byTitle[0].items.map((i) => i.id), ["markji"]);

  // 关键字命中：英文 / 别名 / 大小写
  assert.deepEqual(filterNavGroups("API KEY").flatMap((g) => g.items.map((i) => i.id)), ["models"]);
  assert.deepEqual(filterNavGroups("chrome").flatMap((g) => g.items.map((i) => i.id)), [
    "extension",
  ]);
  assert.deepEqual(filterNavGroups("隐私").flatMap((g) => g.items.map((i) => i.id)), ["storage"]);
  assert.deepEqual(filterNavGroups("头像").flatMap((g) => g.items.map((i) => i.id)), ["profile"]);

  // 账户分组确实有「个人资料」这一项，且不影响按「墨墨」搜索的结果
  assert.ok(NAV_GROUPS.some((g) => g.items.some((i) => i.id === "profile" && i.title === "个人资料")));

  // 空分组必须被剔除，不留一个空标题
  assert.deepEqual(filterNavGroups("不存在的设置项"), []);
});

test("供应商下拉：每家都有展示名、文档链接与模型候选", () => {
  const ids = ["deepseek", "openai", "claude", "qwen", "custom"] as const;
  for (const id of ids) {
    assert.ok(PROVIDER_SELECT_LABEL[id].length > 0, `${id} 缺展示名`);
    assert.match(docsUrlFor(id), /^https:\/\//, `${id} 文档链接不合法`);
    assert.ok(modelOptionsFor(id).length >= 2, `${id} 候选模型太少`);
    assert.ok(modelOptionsFor(id).every((m) => m.trim().length > 0));
  }
  // 预设默认模型永远排第一，且不重复
  assert.equal(modelOptionsFor("deepseek")[0], "deepseek-chat");
  assert.equal(new Set(modelOptionsFor("deepseek")).size, modelOptionsFor("deepseek").length);
  // 自定义端点没有预设地址/模型，候选仍可手填
  assert.equal(modelOptionsFor("custom")[0], "qwen3:8b");
});

test("模型名下拉：预设判定与自定义项取值", () => {
  assert.equal(isPresetModel("deepseek", "deepseek-chat"), true);
  assert.equal(isPresetModel("deepseek", "my-finetuned-model"), false);
  assert.equal(isPresetModel("custom", ""), false);

  assert.equal(applyModelOption("deepseek-reasoner", "whatever", "deepseek-chat"), "deepseek-reasoner");
  assert.equal(applyModelOption(CUSTOM_MODEL_OPTION, "  my-model  ", "deepseek-chat"), "my-model");
  assert.equal(applyModelOption("", "", "deepseek-chat"), "deepseek-chat");
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
