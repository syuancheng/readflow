/**
 * 考试风格（P33 PRD F3「怎么因人而异」/「卡片外观」）。纯函数。
 *
 * 卡面上的「考试风格」标签由系统决定，不交给 AI 自由发挥：
 * - 问卷里勾选了「考试备考」才显示这个标签（PRD：没有考试目标时不显示）；
 * - 风格族优先看 P39 的「在备考哪个考试」：雅思 / 托福 / 四六级 / 考研；
 *   没选（或选了专四专八、高考、其他）再看「考过的最高一级考试」：四六级 / 考研 / 雅思托福；
 *   其它或没填，默认以托福和雅思为主（PRD）。
 * 单测把本目录编译成 CommonJS 直接运行，这里只能用相对路径 import。
 */
import { targetExamText, type SurveyAnswers } from "../learner/survey";

export type ExamFamily = "toefl_ielts" | "ielts" | "toefl" | "cet" | "kaoyan";

/** 问卷 → 风格族；没有备考目标返回 null（不显示标签，提示词里也不强调考试风格） */
export function examFamilyOf(survey: SurveyAnswers | null | undefined): ExamFamily | null {
  if (!survey?.goals?.includes("exam")) return null;
  switch (survey.targetExam) {
    case "ielts":
      return "ielts";
    case "toefl":
      return "toefl";
    case "cet4":
    case "cet6":
      return "cet";
    case "kaoyan":
      return "kaoyan";
  }
  switch (survey.exam) {
    case "cet4":
    case "cet6":
      return "cet";
    case "kaoyan":
      return "kaoyan";
    default:
      return "toefl_ielts";
  }
}

/**
 * 输出类题型 → 海外考试里对应的能力名（用户 2026-11-16 定稿：只参考雅思托福，不参考国内考试）。
 * 旧的「词汇题 / 补全题 / 判断题」等识别题型已移除，不再有对应标签。
 */
const KIND_QUESTION: Record<string, string> = {
  back_translate: "口译",
  situation_say: "口语",
  rephrase: "改写",
  usage: "搭配",
};

/** 雅思风格更强的题型；其余按托福算 */
const IELTS_KINDS = new Set<string>([]);

const FAMILY_NAME: Record<ExamFamily, string> = {
  toefl_ielts: "托福 / 雅思",
  ielts: "雅思",
  toefl: "托福",
  cet: "四六级",
  kaoyan: "考研",
};

/** 卡面标签文字，例如「托福 · 词汇题」；不适用返回 null */
export function examStyleLabel(family: ExamFamily | null, kind: string): string | null {
  if (!family) return null;
  const q = KIND_QUESTION[kind];
  if (!q) return null;
  const exam =
    family === "toefl_ielts" ? (IELTS_KINDS.has(kind) ? "雅思" : "托福") : FAMILY_NAME[family];
  return `${exam} · ${q}`;
}

/** 给出题提示词的一段话：怎么按这个学生的目标、水平配题 */
export function stylePromptLines(
  family: ExamFamily | null,
  survey: SurveyAnswers | null | undefined,
): string {
  const lines: string[] = ["因人而异："];
  if (family) {
    lines.push(`- 学生在备考，目标是${FAMILY_NAME[family]}：把题目场景和参考说法往雅思口语 / 托福口语写作的真实任务上靠，例如日常话题、校园场景、观点陈述。`);
    const target = targetExamText(survey);
    if (target) lines.push(`- 备考目标：${target}。例句的难度和用词向这个目标靠拢。`);
  }
  const feel = survey?.readingFeel;
  if (feel === "every_sentence") {
    lines.push("- 学生读英文很吃力：题目指令用中文；背面多给整句意思；情景说一句的场景和参考说法用简单的词，每句参考说法不超过 12 个词。");
  } else if (feel === "fluent") {
    lines.push("- 学生读英文基本无障碍：题目指令可用英文；背面只给要点，多给他自己组织语言的空间。");
  } else {
    lines.push("- 按学生档案里的水平自行判断：水平低时指令用中文、参考说法简单；水平高时指令可用英文、参考说法更地道。");
  }
  lines.push("- 已经做过卡又查到的词，优先出情景说一句或换个说法，不要重复上一次的题型。");
  return lines.join("\n");
}
