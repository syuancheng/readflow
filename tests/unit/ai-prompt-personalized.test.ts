import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildSystemPrompt, buildUserMessage } from "../../src/lib/ai";
import { SUGGESTION_PREFIX } from "../../src/lib/cards/suggestion";

// 单测编译到 .unit/ 后 __dirname 会变，统一从仓库根（npm test 的工作目录）读快照
const snapshot = (name: string) =>
  fs.readFileSync(path.join(process.cwd(), "tests/unit/fixtures", name), "utf8");

const ZH_BEFORE = snapshot("ai-system-zh-before-p32.txt");
const EN_BEFORE = snapshot("ai-system-en-before-p32.txt");

/**
 * P33（spec §7.1）：系统提示词末尾追加「制卡建议」段——个性化开关 on/off 都追加。
 * 「P32 逐字不变」的语义随之更新为「去掉制卡建议段后逐字一致」。
 * 这是用户确认的有意改动：快照 = P32 之前的提示词 + 制卡建议段。
 */
const CARD_RULE_ZH = /【制卡建议（可选，只在最后一行）】[\s\S]*$/.source;
function withoutCardRule(p: string): string {
  return p
    .replace(/(【制卡建议（可选，只在最后一行）】|Card suggestion \(optional, last line only\):)[\s\S]*$/, "")
    .replace(/\n+$/, "");
}

/** 两段文字逐行比较，返回不同的行（行数必须一致） */
function changedLines(after: string, before: string): { before: string; after: string }[] {
  const a = after.split("\n");
  const b = before.split("\n");
  assert.equal(a.length, b.length, "行数不能变");
  return a.flatMap((line, i) => (line === b[i] ? [] : [{ before: b[i], after: line }]));
}

const BASE = {
  word: "is",
  context: "The opposite problem is the classifier repeatedly stopping something.",
  prefix: "The opposite problem ",
  suffix: " the classifier repeatedly stopping something that's routine in your setup.",
};

test("开关关闭时：讲解深度部分与 P32 改动前逐字一致；末尾多了制卡建议段（P33 有意追加）", () => {
  for (const [p, before] of [
    [buildSystemPrompt("en", false, "steer"), ZH_BEFORE],
    [buildSystemPrompt("en", true, "steer"), EN_BEFORE],
    [buildSystemPrompt("en", false, "steer", { personalized: false }), ZH_BEFORE],
    [buildSystemPrompt("en", true, "steer", { personalized: false }), EN_BEFORE],
  ] as [string, string][]) {
    assert.ok(p.includes("制卡建议"), "P33 后提示词必须含制卡建议段");
    assert.ok(p.includes("制卡建议："));
    assert.equal(withoutCardRule(p), before.replace(/\n+$/, ""), "去掉制卡建议段后必须与 P32 快照逐字一致");
  }
});

test("P33：cardsEnabled=false 时不追加制卡建议段，与 P32 快照逐字一致", () => {
  assert.equal(buildSystemPrompt("en", false, "steer", { cardsEnabled: false }), ZH_BEFORE);
  assert.equal(buildSystemPrompt("en", true, "steer", { cardsEnabled: false }), EN_BEFORE);
});

test("P33：制卡建议段在提示词最后，且建议行规则（30 字、最后一行、之后无内容）写明", () => {
  const p = buildSystemPrompt("en", false, "steer");
  const rule = p.slice(p.indexOf("【制卡建议"));
  assert.ok(rule.includes("制卡建议："), "规则里要有输出格式「制卡建议：」");
  assert.ok(rule.includes("30 个字"));
  assert.ok(rule.includes("最后一行"));
  assert.ok(rule.includes("不值得做时什么都不输出"));
  assert.ok(rule.includes("建议行之后不能再有任何内容"));
  assert.ok(p.trimEnd().endsWith("建议行之后不能再有任何内容。"), "制卡建议段必须是提示词的最后一段");
});

test("开关打开时：中文人设换成 L1–L4 深度指引，旧的「同句第 2/3 次」硬规则不再出现", () => {
  const p = buildSystemPrompt("en", false, "steer", { personalized: true });
  assert.ok(p.includes("L1 只给这句里的意思") && p.includes("L4 再加句子地图"));
  assert.ok(p.includes("偏好简洁的学生最多加「整句大意：」"));
  assert.ok(!p.includes("同句连续请教"), "个性化模式下提示词里不再有「同句连续请教」");
  assert.ok(p.includes("阅读目的会影响义项选择"));
  assert.ok(p.includes("第一行永远是「释义：」"), "个性化不能打乱释义第一行");
  assert.ok(p.includes("【答案深度由你判断，不要问我】"));
  const depth = p.slice(p.indexOf("【答案深度"), p.indexOf("【硬性禁止】"));
  assert.ok(!depth.includes("第 2 次请教") && !depth.includes("第 3 次及以上"), "深度段里的旧硬规则换成画像判断");
  // 深度段之前只有 3 行不同——全是按「同句第几次」给整句大意的旧例外，其余一个字没动
  const changed = changedLines(p.slice(0, p.indexOf("【答案深度")), ZH_BEFORE.slice(0, ZH_BEFORE.indexOf("【答案深度")));
  assert.equal(changed.length, 3, JSON.stringify(changed.map((c) => c.after)));
  for (const c of changed) assert.ok(/同句已问过|同句第 2 次/.test(c.before), c.before);
  for (const c of changed) assert.ok(!/同句已问过|同句第 2 次|第 3 次/.test(c.after), c.after);
  assert.ok(p.includes("必须用「整句大意：」这个标记开头") && p.includes("概括一句话"), "整句大意必须是概括、不能逐字翻译的约束要保留");
  assert.equal(p.slice(p.indexOf("【硬性禁止】"), p.indexOf("【制卡建议")), ZH_BEFORE.slice(ZH_BEFORE.indexOf("【硬性禁止】")).replace(/\n+$/, "") + "\n\n");
  assert.ok(p.includes("制卡建议"), "个性化打开时制卡建议也要在");
});

test("开关打开时：monolingual 人设同样换成个性化深度指引，且不破坏后面的硬性禁止", () => {
  const p = buildSystemPrompt("en", true, "steer", { personalized: true });
  assert.ok(p.includes("student profile") && p.includes("L1 gives only the meaning"));
  assert.ok(p.includes("Do not output your reasoning."), "英文人设不能丢掉「不输出推理过程」的约束");
  assert.ok(!p.includes("Second ask on the same sentence"));
  const changedEn = changedLines(p.slice(0, p.indexOf("Depth is yours")), EN_BEFORE.slice(0, EN_BEFORE.indexOf("Depth is yours")));
  assert.equal(changedEn.length, 2, JSON.stringify(changedEn.map((c) => c.after)));
  for (const c of changedEn) assert.ok(/2nd/.test(c.before) && !/2nd|3rd/.test(c.after), c.after);
  assert.ok(!p.includes("repeat count") && !p.includes("keeps asking about the same sentence"));
  assert.equal(
    p.slice(p.indexOf("Never: phonetic symbols"), p.indexOf("Card suggestion")),
    EN_BEFORE.slice(EN_BEFORE.indexOf("Never: phonetic symbols")).replace(/\n+$/, "") + "\n\n",
  );
  assert.ok(p.includes("Card suggestion"), "英文人设也要有制卡建议段");
});

test("学生档案放在 user 消息最前面；为空时 user 消息和改动前逐字相同", () => {
  const before = buildUserMessage(BASE);
  assert.equal(buildUserMessage({ ...BASE, learnerBlock: "" }), before);
  assert.equal(buildUserMessage({ ...BASE, learnerBlock: "   " }), before);
  const withBlock = buildUserMessage({ ...BASE, learnerBlock: "学生档案（…）：\n- 估计水平：B2" });
  assert.ok(withBlock.startsWith("学生档案（…）："));
  assert.equal(withBlock.slice("学生档案（…）：\n- 估计水平：B2".length + 2), before);
  assert.ok(withBlock.indexOf("学生档案") < withBlock.indexOf("用户选中"));
});

// 让 linter 不抱怨未使用的导入（CARD_RULE_ZH 仅作文档说明保留）
void CARD_RULE_ZH;
void SUGGESTION_PREFIX;

test("个性化模式下观察块不再告诉模型「同句第几次」；关闭时照旧；之前问过的选区仍保留（用来避免重复）", () => {
  const signals = {
    source: "word" as const, position: "middle" as const, selectionWords: 1, sentenceWords: 12, coverage: 0.1,
    sentence: "x", sentenceStart: 0, sentenceEnd: 1, repeatCount: 2, priorAsks: [{ selection: "deliberately" }],
  };
  const on = buildUserMessage({ ...BASE, signals, personalized: true });
  assert.ok(!on.includes("同句连续请教"));
  assert.ok(on.includes("之前问过的选区") && on.includes("deliberately"));
  const off = buildUserMessage({ ...BASE, signals, personalized: false });
  assert.ok(off.includes("同句连续请教: 第 2 次"));
  assert.equal(buildUserMessage({ ...BASE, signals }), off, "不传 personalized 等同关闭，保持旧行为");
});

test("P34：个性化深度指引写明怎么用「最近的反馈」；关闭时提示词不变", () => {
  const zh = buildSystemPrompt("en", false, "steer", { personalized: true });
  assert.ok(zh.includes("「最近的反馈」") && zh.includes("向被评「刚好」的那次讲法靠拢") && zh.includes("以最近的为准"));
  const en = buildSystemPrompt("en", true, "steer", { personalized: true });
  assert.ok(en.includes("最近的反馈") && en.includes("follow the recent feedback"));
  assert.ok(!buildSystemPrompt("en", false, "steer", { personalized: false }).includes("最近的反馈"));
});
