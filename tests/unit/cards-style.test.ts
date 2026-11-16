import assert from "node:assert/strict";
import test from "node:test";
import { examFamilyOf, examStyleLabel, stylePromptLines } from "../../src/lib/cards/style";

test("没有考试目标 → 没有风格族，也不显示标签（PRD）", () => {
  assert.equal(examFamilyOf(null), null);
  assert.equal(examFamilyOf({}), null);
  assert.equal(examFamilyOf({ goals: ["tech"], exam: "cet4" }), null);
  assert.equal(examStyleLabel(null, "situation_say"), null);
});

test("勾选了备考：四六级 / 考研各归各，其余默认托福雅思", () => {
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "cet4" }), "cet");
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "cet6" }), "cet");
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "kaoyan" }), "kaoyan");
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "ielts_toefl" }), "toefl_ielts");
  assert.equal(examFamilyOf({ goals: ["exam"] }), "toefl_ielts");
  assert.equal(examFamilyOf({ goals: ["exam"], exam: "gaokao" }), "toefl_ielts");
});

test("标签文字：输出题型按海外考试能力命名；识别题型已无对应标签", () => {
  assert.equal(examStyleLabel("toefl_ielts", "back_translate"), "托福 · 口译");
  assert.equal(examStyleLabel("toefl_ielts", "situation_say"), "托福 · 口语");
  assert.equal(examStyleLabel("toefl_ielts", "rephrase"), "托福 · 改写");
  assert.equal(examStyleLabel("ielts", "usage"), "雅思 · 搭配");
  assert.equal(examStyleLabel("toefl", "custom"), null);
  // 旧的识别题型不再有标签
  for (const k of ["context_meaning", "word_completion", "true_false_ng"]) {
    assert.equal(examStyleLabel("toefl_ielts", k), null, k);
  }
});

test("提示词段落：围绕雅思托福真实任务与阅读感受，不出识别题", () => {
  const withExam = stylePromptLines("ielts", { goals: ["exam"], readingFeel: "every_sentence" });
  assert.ok(withExam.includes("雅思") && withExam.includes("很吃力"));
  assert.ok(withExam.includes("雅思口语 / 托福口语写作的真实任务") && withExam.includes("12 个词"));
  assert.ok(!withExam.includes("干扰项"));
  const none = stylePromptLines(null, { readingFeel: "fluent" });
  assert.ok(none.includes("无障碍"));
  const unknown = stylePromptLines("kaoyan", null);
  assert.ok(unknown.includes("自行判断"));
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
  // 输出题型按备考的考试标；识别题型一律无标签
  assert.equal(examStyleLabel("ielts", "back_translate"), "雅思 · 口译");
  assert.equal(examStyleLabel("toefl", "situation_say"), "托福 · 口语");
  assert.equal(examStyleLabel("ielts", "context_meaning"), null);
});

test("P39 做卡提示词带上备考目标；没选考试就不加这一行", () => {
  const s = { goals: ["exam" as const], targetExam: "ielts" as const, targetScore: "ielts_6_5" };
  const withTarget = stylePromptLines("ielts", s);
  assert.ok(withTarget.includes("雅思口语 / 托福口语写作的真实任务"), withTarget);
  assert.ok(withTarget.includes("- 备考目标：雅思，目标 6.5 分。例句的难度和用词向这个目标靠拢。"), withTarget);
  assert.ok(!stylePromptLines("toefl_ielts", { goals: ["exam"] }).includes("备考目标"));
  assert.ok(!stylePromptLines(null, { goals: ["tech"] }).includes("备考目标"));
});
