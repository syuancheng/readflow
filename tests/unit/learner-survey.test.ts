import assert from "node:assert/strict";
import test from "node:test";
import {
  SURVEY_QUESTIONS,
  EXAM_SCORE_BANDS,
  normalizeSurvey,
  surveyPrior,
  showScoreQuestion,
  clampVocab,
  cefrOfVocab,
  VOCAB_MIN,
  VOCAB_MAX,
  type SurveyAnswers,
  type Exam,
} from "../../src/lib/learner/survey";

const labels = (id: string) =>
  SURVEY_QUESTIONS.find((q) => q.id === id)?.options.map((o) => o.label) ?? [];

test("题目文案逐字取自 PRD F1，Q1/Q2/Q3/Q4/Q5 的选项一个不少", () => {
  assert.deepEqual(
    SURVEY_QUESTIONS.map((q) => [q.id, q.title]),
    [
      ["identity", "你现在是？"],
      ["exam", "你考过的最高一级英语考试？"],
      ["examScore", "大概考了多少分？"],
      ["goals", "你读英文主要为了什么？"],
      ["readingFeel", "平时读英文文章的感觉？"],
      ["stylePref", "你希望 AI 老师怎么讲？"],
    ],
  );
  assert.deepEqual(labels("identity"), [
    "初中生", "高中生", "大学生", "研究生", "已工作 1–3 年", "已工作 3–10 年", "已工作 10 年以上", "其他",
  ]);
  assert.deepEqual(labels("exam"), [
    "还没考过", "高考", "大学英语四级", "大学英语六级", "考研英语", "雅思或托福", "专四或专八",
  ]);
  assert.deepEqual(labels("goals"), [
    "技术文档和编程", "学术论文", "新闻时事", "工作邮件和资料", "考试备考", "小说和兴趣阅读",
  ]);
  assert.deepEqual(labels("readingFeel"), [
    "几乎每句都要查", "每段查几个词", "偶尔查个生词", "基本无障碍",
  ]);
  assert.deepEqual(labels("stylePref"), [
    "讲细一点，多讲语法和结构", "适中", "越简洁越好，点到为止",
  ]);
  assert.equal(SURVEY_QUESTIONS.find((q) => q.id === "goals")?.multi, true, "Q3 是唯一的多选题");
});

test("Q2a：高考、考研英语、还没考过不显示；其余按产品确认的文案", () => {
  for (const exam of ["none", "gaokao", "kaoyan"] as Exam[]) {
    assert.equal(showScoreQuestion(exam), false, `${exam} 不该出现 Q2a`);
    assert.deepEqual(EXAM_SCORE_BANDS[exam], []);
  }
  const cet = ["425 以下", "425–499", "500–549", "550 以上", "不记得了"];
  assert.deepEqual(EXAM_SCORE_BANDS.cet4.map((b) => b.label), cet);
  assert.deepEqual(EXAM_SCORE_BANDS.cet6.map((b) => b.label), cet);
  assert.deepEqual(EXAM_SCORE_BANDS.ielts_toefl.map((b) => b.label), [
    "雅思 6 以下", "雅思 6–6.5", "雅思 7 以上", "托福 80 以下", "托福 80–99", "托福 100 以上", "不记得了",
  ]);
  assert.deepEqual(EXAM_SCORE_BANDS.tem.map((b) => b.label), ["专四", "专八"]);
  assert.equal(showScoreQuestion("ielts_toefl"), true);
});

test("normalizeSurvey 丢弃非法值和多余字段，goals 去重", () => {
  assert.deepEqual(
    normalizeSurvey({
      identity: "college", exam: "cet6", examScore: "cet_550plus",
      goals: ["tech", "tech", "nope", "news"], readingFeel: "occasional",
      stylePref: "concise", nickname: "不该带进来",
    }),
    {
      identity: "college", exam: "cet6", examScore: "cet_550plus",
      goals: ["tech", "news"], readingFeel: "occasional", stylePref: "concise",
    },
  );
  assert.deepEqual(normalizeSurvey(null), {});
  assert.deepEqual(normalizeSurvey("x"), {});
  assert.deepEqual(normalizeSurvey({ identity: "nope", goals: "tech" }), {});
});

test("normalizeSurvey：分数段必须属于当前这门考试，改了 Q2 就丢掉旧档位", () => {
  const a = normalizeSurvey({ exam: "cet6", examScore: "cet_550plus" });
  assert.equal(a.examScore, "cet_550plus");
  const b = normalizeSurvey({ exam: "cet6", examScore: "ielts_7plus" });
  assert.equal(b.examScore, undefined, "雅思档位不能算到六级上");
  const c = normalizeSurvey({ exam: "gaokao", examScore: "unknown" });
  assert.equal(c.examScore, undefined, "不显示 Q2a 的考试不该存分数段");
  const d = normalizeSurvey({ examScore: "unknown" });
  assert.equal(d.examScore, undefined, "没选考试就不该存分数段");
});

test("换算表：Q2 没考过 / 不填时由 Q1 决定基础词汇量", () => {
  const byIdentity: Record<string, number | null> = {
    middle: 1500, high: 2500, college: 4000, graduate: 5000,
    work_1_3: 4000, work_3_10: 4000, work_10_plus: 4000, other: null,
  };
  for (const [identity, vocab] of Object.entries(byIdentity)) {
    assert.equal(surveyPrior({ identity: identity as SurveyAnswers["identity"] }).vocab, vocab, `身份 ${identity}`);
    assert.equal(surveyPrior({ exam: "none", identity: identity as SurveyAnswers["identity"] }).vocab, vocab, `还没考过 + ${identity}`);
  }
});

test("换算表：高考 3000、四级五档、六级五档", () => {
  assert.equal(surveyPrior({ exam: "gaokao" }).vocab, 3000);
  const cet4: Record<string, number> = {
    cet_lt425: 3500, cet_425_499: 4000, cet_500_549: 4500, cet_550plus: 5000, unknown: 4000,
  };
  const cet6: Record<string, number> = {
    cet_lt425: 4500, cet_425_499: 5500, cet_500_549: 6500, cet_550plus: 7500, unknown: 5500,
  };
  for (const [score, vocab] of Object.entries(cet4)) assert.equal(surveyPrior({ exam: "cet4", examScore: score }).vocab, vocab, `四级 ${score}`);
  for (const [score, vocab] of Object.entries(cet6)) assert.equal(surveyPrior({ exam: "cet6", examScore: score }).vocab, vocab, `六级 ${score}`);
});

test("换算表：考研 5500；雅思托福三档 5000/6500/8000，「不记得了」取中间档", () => {
  assert.equal(surveyPrior({ exam: "kaoyan" }).vocab, 5500);
  const bands: Record<string, number> = {
    ielts_lt6: 5000, ielts_6_6_5: 6500, ielts_7plus: 8000,
    toefl_lt80: 5000, toefl_80_99: 6500, toefl_100plus: 8000, unknown: 6500,
  };
  for (const [score, vocab] of Object.entries(bands)) {
    assert.equal(surveyPrior({ exam: "ielts_toefl", examScore: score }).vocab, vocab, `雅思托福 ${score}`);
  }
});

test("换算表：专四 7000、专八 9000", () => {
  assert.equal(surveyPrior({ exam: "tem", examScore: "tem4" }).vocab, 7000);
  assert.equal(surveyPrior({ exam: "tem", examScore: "tem8" }).vocab, 9000);
});

test("Q4 系数：每句都查 ×0.8、每段几个 ×1.0、偶尔 ×1.15、无障碍 ×1.3", () => {
  assert.equal(surveyPrior({ identity: "college", readingFeel: "every_sentence" }).vocab, 3200);
  assert.equal(surveyPrior({ identity: "college", readingFeel: "few_per_paragraph" }).vocab, 4000);
  assert.equal(surveyPrior({ identity: "college", readingFeel: "occasional" }).vocab, 4600);
  assert.equal(surveyPrior({ identity: "college", readingFeel: "fluent" }).vocab, 5200);
});

test("工作 3 年以上且读技术文档 / 工作资料，再 ×1.1", () => {
  assert.equal(surveyPrior({ identity: "work_3_10", goals: ["tech"] }).vocab, 4400);
  assert.equal(surveyPrior({ identity: "work_10_plus", goals: ["work"] }).vocab, 4400);
  assert.equal(surveyPrior({ identity: "work_1_3", goals: ["tech"] }).vocab, 4000, "1–3 年不加");
  assert.equal(surveyPrior({ identity: "work_3_10", goals: ["news"] }).vocab, 4000, "阅读目的不符不加");
});

test("上下限 1500 / 15000，以及 CEFR 的分档边界", () => {
  assert.equal(VOCAB_MIN, 1500);
  assert.equal(VOCAB_MAX, 15000);
  assert.equal(clampVocab(1200), 1500);
  assert.equal(clampVocab(16000), 15000);
  assert.equal(surveyPrior({ identity: "middle", readingFeel: "every_sentence" }).vocab, 1500, "1500×0.8 被下限接住");
  assert.deepEqual(
    [1500, 2499, 2500, 3999, 4000, 6499, 6500, 10000, 10001].map(cefrOfVocab),
    ["A2", "A2", "B1", "B1", "B2", "B2", "C1", "C1", "C2"],
  );
});

test("全部未填时返回 null，不产生任何画像", () => {
  assert.deepEqual(surveyPrior({}), { vocab: null, cefr: null });
  assert.deepEqual(surveyPrior({ stylePref: "concise" }), { vocab: null, cefr: null }, "只填风格不足以估词汇量");
  assert.deepEqual(surveyPrior({ identity: "other" }), { vocab: null, cefr: null });
});
