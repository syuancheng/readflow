/**
 * P32 F1 学习档案问卷：题目、选项、白名单校验、问卷 → 起始水平。
 *
 * 这是问卷的**唯一来源**：/welcome、设置里的「学习档案」、服务端校验、单测都从这里读，
 * 不允许在别处再抄一份文案。所有面向用户的中文文案逐字取自 PRD F1（Q2a 用 2026-11-13
 * 产品负责人确认的版本）。
 *
 * 纯函数：不碰数据库、不发请求，只能用相对路径 import。
 */
import type { Cefr } from "./types";

export type Identity =
  | "middle" | "high" | "college" | "graduate"
  | "work_1_3" | "work_3_10" | "work_10_plus" | "other";
export type Exam = "none" | "gaokao" | "cet4" | "cet6" | "kaoyan" | "ielts_toefl" | "tem";
export type Goal = "tech" | "academic" | "news" | "work" | "exam" | "novels";
export type ReadingFeel = "every_sentence" | "few_per_paragraph" | "occasional" | "fluent";
export type StylePref = "detailed" | "balanced" | "concise";

export type SurveyAnswers = {
  identity?: Identity;
  exam?: Exam;
  examScore?: string; // EXAM_SCORE_BANDS 里的 key，"unknown" 表示不记得了
  goals?: Goal[]; // Q3，唯一的多选题
  readingFeel?: ReadingFeel;
  stylePref?: StylePref;
};

export type SurveyOption = { key: string; label: string };

export type SurveyQuestion = {
  id: "identity" | "exam" | "examScore" | "goals" | "readingFeel" | "stylePref";
  /** 中文题目（逐字取自 PRD） */
  title: string;
  options: SurveyOption[];
  /** Q3 是唯一的多选题 */
  multi?: boolean;
  /** Q2a：高考 / 考研英语 / 还没考过不显示 */
  hideForExams?: Exam[];
};

/** Q2a 的分数段。四级/六级同档；雅思托福共用一道题但档位分开；专四专八选的是哪一种考试 */
export const EXAM_SCORE_BANDS: Record<Exam, SurveyOption[]> = {
  none: [],
  gaokao: [],
  kaoyan: [],
  cet4: [
    { key: "cet_lt425", label: "425 以下" },
    { key: "cet_425_499", label: "425–499" },
    { key: "cet_500_549", label: "500–549" },
    { key: "cet_550plus", label: "550 以上" },
    { key: "unknown", label: "不记得了" },
  ],
  cet6: [
    { key: "cet_lt425", label: "425 以下" },
    { key: "cet_425_499", label: "425–499" },
    { key: "cet_500_549", label: "500–549" },
    { key: "cet_550plus", label: "550 以上" },
    { key: "unknown", label: "不记得了" },
  ],
  ielts_toefl: [
    { key: "ielts_lt6", label: "雅思 6 以下" },
    { key: "ielts_6_6_5", label: "雅思 6–6.5" },
    { key: "ielts_7plus", label: "雅思 7 以上" },
    { key: "toefl_lt80", label: "托福 80 以下" },
    { key: "toefl_80_99", label: "托福 80–99" },
    { key: "toefl_100plus", label: "托福 100 以上" },
    { key: "unknown", label: "不记得了" },
  ],
  tem: [
    { key: "tem4", label: "专四" },
    { key: "tem8", label: "专八" },
  ],
};

const IDENTITY_OPTIONS: SurveyOption[] = [
  { key: "middle", label: "初中生" },
  { key: "high", label: "高中生" },
  { key: "college", label: "大学生" },
  { key: "graduate", label: "研究生" },
  { key: "work_1_3", label: "已工作 1–3 年" },
  { key: "work_3_10", label: "已工作 3–10 年" },
  { key: "work_10_plus", label: "已工作 10 年以上" },
  { key: "other", label: "其他" },
];
const EXAM_OPTIONS: SurveyOption[] = [
  { key: "none", label: "还没考过" },
  { key: "gaokao", label: "高考" },
  { key: "cet4", label: "大学英语四级" },
  { key: "cet6", label: "大学英语六级" },
  { key: "kaoyan", label: "考研英语" },
  { key: "ielts_toefl", label: "雅思或托福" },
  { key: "tem", label: "专四或专八" },
];
const GOAL_OPTIONS: SurveyOption[] = [
  { key: "tech", label: "技术文档和编程" },
  { key: "academic", label: "学术论文" },
  { key: "news", label: "新闻时事" },
  { key: "work", label: "工作邮件和资料" },
  { key: "exam", label: "考试备考" },
  { key: "novels", label: "小说和兴趣阅读" },
];
const FEEL_OPTIONS: SurveyOption[] = [
  { key: "every_sentence", label: "几乎每句都要查" },
  { key: "few_per_paragraph", label: "每段查几个词" },
  { key: "occasional", label: "偶尔查个生词" },
  { key: "fluent", label: "基本无障碍" },
];
const STYLE_OPTIONS: SurveyOption[] = [
  { key: "detailed", label: "讲细一点，多讲语法和结构" },
  { key: "balanced", label: "适中" },
  { key: "concise", label: "越简洁越好，点到为止" },
];

export const SURVEY_QUESTIONS: SurveyQuestion[] = [
  { id: "identity", title: "你现在是？", options: IDENTITY_OPTIONS },
  { id: "exam", title: "你考过的最高一级英语考试？", options: EXAM_OPTIONS },
  {
    id: "examScore",
    title: "大概考了多少分？",
    options: EXAM_SCORE_BANDS.cet6, // 默认展示六级；渲染时按 Q2 用 EXAM_SCORE_BANDS 覆盖
    hideForExams: ["none", "gaokao", "kaoyan"],
  },
  { id: "goals", title: "你读英文主要为了什么？", options: GOAL_OPTIONS, multi: true },
  { id: "readingFeel", title: "平时读英文文章的感觉？", options: FEEL_OPTIONS },
  { id: "stylePref", title: "你希望 AI 老师怎么讲？", options: STYLE_OPTIONS },
];

/** Q2a 该不该出现（高考 / 考研英语 / 还没考过不显示） */
export function showScoreQuestion(exam: Exam | undefined): boolean {
  if (!exam) return false;
  const q = SURVEY_QUESTIONS.find((x) => x.id === "examScore");
  return !q?.hideForExams?.includes(exam);
}

const labelMap = (options: SurveyOption[]) => new Map(options.map((o) => [o.key, o.label]));
export const IDENTITY_LABEL = labelMap(IDENTITY_OPTIONS);
export const EXAM_LABEL = labelMap(EXAM_OPTIONS);
export const GOAL_LABEL = labelMap(GOAL_OPTIONS);
export const FEEL_LABEL = labelMap(FEEL_OPTIONS);
export const STYLE_LABEL = labelMap(STYLE_OPTIONS);

/** 白名单校验：非法值和多余字段一律丢弃，绝不把客户端传来的怪值写进 DB */
export function normalizeSurvey(input: unknown): SurveyAnswers {
  if (!input || typeof input !== "object") return {};
  const o = input as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, options: SurveyOption[]): T | undefined =>
    typeof v === "string" && options.some((x) => x.key === v) ? (v as T) : undefined;

  const out: SurveyAnswers = {};
  const identity = pick<Identity>(o.identity, IDENTITY_OPTIONS);
  if (identity) out.identity = identity;
  const exam = pick<Exam>(o.exam, EXAM_OPTIONS);
  if (exam) out.exam = exam;
  const readingFeel = pick<ReadingFeel>(o.readingFeel, FEEL_OPTIONS);
  if (readingFeel) out.readingFeel = readingFeel;
  const stylePref = pick<StylePref>(o.stylePref, STYLE_OPTIONS);
  if (stylePref) out.stylePref = stylePref;

  if (Array.isArray(o.goals)) {
    const goals = o.goals.filter(
      (g): g is Goal => typeof g === "string" && GOAL_OPTIONS.some((x) => x.key === g),
    );
    const unique = [...new Set(goals)];
    if (unique.length > 0) out.goals = unique;
  }

  // 分数段必须属于当前这门考试，避免「改了 Q2 但旧分数段还留着」造成换算错档
  if (exam && showScoreQuestion(exam) && typeof o.examScore === "string") {
    if (EXAM_SCORE_BANDS[exam].some((b) => b.key === o.examScore)) out.examScore = o.examScore;
  }
  return out;
}

/** 没考过时用身份估基础词汇量（实现说明 §4.1 的第一行） */
const VOCAB_BY_IDENTITY: Record<Identity, number | null> = {
  middle: 1500,
  high: 2500,
  college: 4000,
  graduate: 5000,
  work_1_3: 4000,
  work_3_10: 4000,
  work_10_plus: 4000,
  other: null,
};

/** 四级/六级分数段 → 基础词汇量 */
const CET4_SCORES: Record<string, number> = {
  cet_lt425: 3500, cet_425_499: 4000, cet_500_549: 4500, cet_550plus: 5000, unknown: 4000,
};
const CET6_SCORES: Record<string, number> = {
  cet_lt425: 4500, cet_425_499: 5500, cet_500_549: 6500, cet_550plus: 7500, unknown: 5500,
};
/** 雅思与托福三档分别对应 5000 / 6500 / 8000，「不记得了」取中间档 */
const IELTS_TOEFL_SCORES: Record<string, number> = {
  ielts_lt6: 5000, ielts_6_6_5: 6500, ielts_7plus: 8000,
  toefl_lt80: 5000, toefl_80_99: 6500, toefl_100plus: 8000,
  unknown: 6500,
};

function baseVocab(a: SurveyAnswers): number | null {
  switch (a.exam) {
    case undefined:
    case "none":
      return a.identity ? VOCAB_BY_IDENTITY[a.identity] : null;
    case "gaokao":
      return 3000;
    case "cet4":
      return a.examScore ? CET4_SCORES[a.examScore] ?? 4000 : 4000;
    case "cet6":
      return a.examScore ? CET6_SCORES[a.examScore] ?? 5500 : 5500;
    case "kaoyan":
      return 5500;
    case "ielts_toefl":
      return a.examScore ? IELTS_TOEFL_SCORES[a.examScore] ?? 6500 : 6500;
    case "tem":
      return a.examScore === "tem8" ? 9000 : 7000;
    default:
      return null;
  }
}

/** Q4 的自评系数 */
const FEEL_FACTOR: Record<ReadingFeel, number> = {
  every_sentence: 0.8,
  few_per_paragraph: 1.0,
  occasional: 1.15,
  fluent: 1.3,
};

export const VOCAB_MIN = 1500;
export const VOCAB_MAX = 15000;

export function clampVocab(v: number): number {
  return Math.max(VOCAB_MIN, Math.min(VOCAB_MAX, Math.round(v)));
}

/** 词汇量 → CEFR：<2500 A2，2500–4000 B1，4000–6500 B2，6500–10000 C1，>10000 C2 */
export function cefrOfVocab(vocab: number): Cefr {
  if (vocab < 2500) return "A2";
  if (vocab < 4000) return "B1";
  if (vocab < 6500) return "B2";
  if (vocab <= 10000) return "C1";
  return "C2";
}

/**
 * 问卷 → 起始水平。先由 Q2 / Q2a 给出基础词汇量，再按 Q1、Q4 调整，最后夹在 1500–15000。
 * 全部未填（或基础值无法确定）时返回 null，此时讲解行为等同于没有画像。
 */
export function surveyPrior(a: SurveyAnswers): { vocab: number | null; cefr: Cefr | null } {
  const base = baseVocab(a);
  if (base === null) return { vocab: null, cefr: null };

  let vocab = base;
  if (a.readingFeel) vocab *= FEEL_FACTOR[a.readingFeel];
  const senior = a.identity === "work_3_10" || a.identity === "work_10_plus";
  const workGoals = a.goals?.some((g) => g === "tech" || g === "work") ?? false;
  if (senior && workGoals) vocab *= 1.1;

  vocab = clampVocab(vocab);
  return { vocab, cefr: cefrOfVocab(vocab) };
}
