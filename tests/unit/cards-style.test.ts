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
});

test("提示词段落：随备考目标和阅读感受变化", () => {
  const withExam = stylePromptLines("cet", { goals: ["exam"], readingFeel: "every_sentence" });
  assert.ok(withExam.includes("四六级") && withExam.includes("很吃力"));
  const none = stylePromptLines(null, { readingFeel: "fluent" });
  assert.ok(none.includes("托福和雅思") && none.includes("无障碍"));
  const unknown = stylePromptLines("kaoyan", null);
  assert.ok(unknown.includes("考研") && unknown.includes("自行判断"));
  assert.ok(withExam.includes("已经做过卡又查到的词"));
});
