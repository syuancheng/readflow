import assert from "node:assert/strict";
import test from "node:test";
import { examFamilyOf, examStyleLabel, stylePromptLines } from "../../src/lib/cards/style";

test("没有考试目标 → 没有风格族，也不显示标签（PRD）", () => {
  assert.equal(examFamilyOf(null), null);
  assert.equal(examFamilyOf({}), null);
  assert.equal(examFamilyOf({ goals: ["tech"], exam: "cet4" }), null);
  assert.equal(examStyleLabel(null, "context_meaning"), null);
});

test("勾选了备考：四六级 / 考研各归各，其余默认托福雅思", () => {
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "cet4" }), "cet");
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "cet6" }), "cet");
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "kaoyan" }), "kaoyan");
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "ielts_toefl" }), "toefl_ielts");
  assert.equal(examFamilyOf({ goals: ["exam"] }), "toefl_ielts");
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "gaokao" }), "toefl_ielts");
});

test("标签文字：雅思味更重的题型用雅思，其余托福；没有对应题名的题型不加", () => {
  assert.equal(examStyleLabel("toefl_ielts", "context_meaning"), "托福 · 词汇题");
  assert.equal(examStyleLabel("toefl_ielts", "paraphrase_fill"), "雅思 · 填空题");
  assert.equal(examStyleLabel("toefl_ielts", "true_false_ng"), "雅思 · 判断题");
  assert.equal(examStyleLabel("cet", "word_completion"), "四六级 · 补全题");
  assert.equal(examStyleLabel("kaoyan", "sentence_understanding"), "考研 · 句子题");
  assert.equal(examStyleLabel("kaoyan", "layered_cloze"), null);
  assert.equal(examStyleLabel("kaoyan", "custom"), null);
  // P35：使用类卡永远不带考试风格标签
  for (const k of ["back_translate", "situation_say", "rephrase", "usage"]) assert.equal(examStyleLabel("toefl_ielts", k), null);
});

test("提示词段落：随备考目标和阅读感受变化", () => {
  const withExam = stylePromptLines("cet", { goals: ["exam"], readingFeel: "every_sentence" });
  assert.ok(withExam.includes("四六级") && withExam.includes("很吃力"));
  assert.ok(withExam.includes("最后再加一张") && withExam.includes("12 个词"));
  assert.ok(withExam.includes("考试题：难点是长句结构"));
  const none = stylePromptLines(null, { readingFeel: "fluent" });
  assert.ok(none.includes("不出考试题型") && none.includes("无障碍"));
  assert.ok(!none.includes("考试题：难点"));
  const unknown = stylePromptLines("kaoyan", null);
  assert.ok(unknown.includes("考研") && unknown.includes("自行判断"));
  assert.ok(withExam.includes("已经做过卡又查到的词") && withExam.includes("情景说一句"));
});

test("P39 「在备考哪个考试」优先于「考过的最高一级考试」", () => {
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "cet6", targetExam: "ielts" }), "ielts");
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "cet6", targetExam: "toefl" }), "toefl");
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "ielts_toefl", targetExam: "cet4" }), "cet");
  assert.equal(examFamilyOf({ goals: ["exam"], targetExam: "kaoyan" }), "kaoyan");
  // 专四专八 / 高考 / 其他：回到原来的规则
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "cet4", targetExam: "tem8" }), "cet");
  assert.equal(examFamilyOf({ goals: ["exam"], targetExam: "other" }), "toefl_ielts");
  assert.equal(examFamilyOf({ goals: ["tech"], targetExam: "ielts" }), null);
  // 明确选了雅思 / 托福：所有题型都标这门考试
  assert.equal(examStyleLabel("ielts", "context_meaning"), "雅思 · 词汇题");
  assert.equal(examStyleLabel("toefl", "true_false_ng"), "托福 · 判断题");
  assert.equal(examStyleLabel("ielts", "usage"), null);
});

test("P39 做卡提示词带上备考目标；没选考试就不加这一行", () => {
  const s = { goals: ["exam" as const], targetExam: "ielts" as const, targetScore: "ielts_6_5" };
  const withTarget = stylePromptLines("ielts", s);
  assert.ok(withTarget.includes("雅思风格的考试题"), withTarget);
  assert.ok(withTarget.includes("- 备考目标：雅思，目标 6.5 分。考试题的难度和用词向这个目标靠拢。"), withTarget);
  assert.ok(!stylePromptLines("toefl_ielts", { goals: ["exam"] }).includes("备考目标"));
  assert.ok(!stylePromptLines(null, { goals: ["tech"] }).includes("备考目标"));
});
