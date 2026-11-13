/**
 * P32 学习画像的共享类型。纯类型 + 常量，不碰数据库、不发请求。
 * 单测会把本目录编译成 CommonJS 直接运行，因此这里只能用相对路径 import。
 */
import type { CefrLevel } from "../cefr";

export type Cefr = CefrLevel;

/** 「问 AI」的种类：讲解事件与反馈都靠它区分（P32 §5.3） */
export type AskKind =
  | "auto"
  | "default"
  | "word_only"
  | "whole_sentence"
  | "structure"
  | "example"
  | "custom";

export type Feedback = "shallow" | "right" | "deep";

export type LearnerLevel = {
  vocab: number | null;
  cefr: Cefr | null;
  /** 依据：问卷 / 行为推断 / 两者混合，给「AI 眼中的你」用 */
  basis?: "survey" | "behavior" | "mixed" | null;
};

/** F2 行为推断结果（阶段二计算，阶段一只用到 lookups / feedback 的空值形态） */
export type BehaviorStats = {
  lookups: number;
  vocab: number | null;
  cefr: Cefr | null;
  typicalTextCefr: Cefr | null;
  difficulties: ("long_sentence" | "vocabulary" | "phrases")[];
  followupRate: number | null;
  feedback: { shallow: number; right: number; deep: number };
};

export type LearnerEvent = {
  kind: "lookup" | "explain";
  askKind?: AskKind;
  freqRank: number | null;
  isPhrase: boolean;
  repeatCount: number | null;
  textCefr: string | null;
  feedback: Feedback | null;
  createdAt: number;
  contextId: string | null;
};

export const EMPTY_BEHAVIOR_STATS: BehaviorStats = {
  lookups: 0,
  vocab: null,
  cefr: null,
  typicalTextCefr: null,
  difficulties: [],
  followupRate: null,
  feedback: { shallow: 0, right: 0, deep: 0 },
};
