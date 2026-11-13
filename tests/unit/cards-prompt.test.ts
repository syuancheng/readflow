import assert from "node:assert/strict";
import test from "node:test";
import { buildCardPrompt } from "../../src/lib/cards/prompt";

const base = { learnerBlock: "", listeningEnabled: false, otherTextLookups: 0, cardedBefore: false };

test("包含 PRD 原则、零件清单、示例菜单、JSON 格式", () => {
  const p = buildCardPrompt(base);
  for (const needle of ["出题必须遵守的原则", "你能用的零件", "示例菜单", "只输出 JSON", "1~3 张卡", "原句一字不改", "不泄露答案"]) {
    assert.ok(p.includes(needle), needle);
  }
});

test("听力开关：关闭时不出现音频零件和听力卡型；打开时出现", () => {
  const off = buildCardPrompt(base);
  assert.ok(!off.includes("单词音频") && !off.includes("听句填空"));
  assert.ok(!off.includes("音频"), "听力关闭时整份指令里不能出现「音频」二字");
  const on = buildCardPrompt({ ...base, listeningEnabled: true });
  assert.ok(on.includes("单词音频") && on.includes("听句填空") && on.includes("听音选词"));
  assert.ok(on.includes("或整句音频"));
});

test("学生档案放在最前面；为空时不留空行", () => {
  assert.ok(buildCardPrompt({ ...base, learnerBlock: "学生档案：小明" }).startsWith("学生档案：小明\n\n"));
  assert.ok(buildCardPrompt(base).startsWith("请为这个词出考试题型的记忆卡"));
});

test("观察信息：其他文章查过 N 次 / 已做过卡", () => {
  const none = buildCardPrompt(base);
  assert.ok(!none.includes("观察："));
  const p = buildCardPrompt({ ...base, otherTextLookups: 2, cardedBefore: true });
  assert.ok(p.includes("观察：") && p.includes("其他文章里也查过 2 次") && p.includes("更难的回想类题目"));
});

test("考试风格段落：传了才出现，放在 JSON 格式之前", () => {
  const p = buildCardPrompt({ ...base, styleLines: "因人而异（PRD F3）：\n- x" });
  assert.ok(p.indexOf("因人而异") > 0 && p.indexOf("因人而异") < p.indexOf("只输出 JSON"));
  assert.ok(!buildCardPrompt(base).includes("因人而异"));
});

test("提示层说明：分层揭示，提示不能写出答案；examStyle 由系统决定", () => {
  const p = buildCardPrompt(base);
  assert.ok(p.includes("点一下出提示，再点一下出答案"));
  assert.ok(p.includes("examStyle 不用填"));
});

test("同样输入输出逐字相同（前缀缓存的前提）", () => {
  assert.equal(buildCardPrompt({ ...base, learnerBlock: "a" }), buildCardPrompt({ ...base, learnerBlock: "a" }));
});
