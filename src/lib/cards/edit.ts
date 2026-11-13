/**
 * 卡片修改表单用的纯函数（P33 §8.2）：表单只改文字，不碰墨墨语法，
 * 这里负责「改了句子文字之后，标记位置跟着挪」和「选择题的增删、换正确答案」。
 * 纯函数，单测编译，只用相对路径 import。
 */
import type { Block, CardSpec } from "./spec";

type SentenceBlock = Extract<Block, { t: "sentence" }>;
type ChoiceBlock = Extract<Block, { t: "choice" }>;

export const CHOICE_MIN = 3;
export const CHOICE_MAX = 5;

/**
 * 改写句的文字改了以后，让标记（高亮 / 挖空）跟着被盖住的那个词走：
 * 在新文字里找原来盖住的字；找到就更新位置，找不到就去掉标记（让校验去判断是否还合格）。
 * 原句（source = original）不允许改，调用方不会走到这里。
 */
export function retextSentence(b: SentenceBlock, text: string): SentenceBlock {
  if (!b.mark) return { ...b, text };
  const covered = b.text.slice(b.mark.start, b.mark.end);
  if (!covered) return { ...b, text, mark: undefined };
  // 优先保留离原位置最近的一处
  let best = -1;
  for (let i = text.indexOf(covered); i >= 0; i = text.indexOf(covered, i + 1)) {
    if (best < 0 || Math.abs(i - b.mark.start) < Math.abs(best - b.mark.start)) best = i;
  }
  if (best < 0) {
    const { mark: _drop, ...rest } = b;
    void _drop;
    return { ...rest, text };
  }
  return { ...b, text, mark: { ...b.mark, start: best, end: best + covered.length } };
}

/** 单选：选中的那个变成唯一正确；多选：切换这一项 */
export function setCorrect(b: ChoiceBlock, index: number): ChoiceBlock {
  const options = b.options.map((o, i) => ({
    ...o,
    correct: b.multi ? (i === index ? !o.correct : o.correct) : i === index,
  }));
  return { ...b, options };
}

export function addOption(b: ChoiceBlock): ChoiceBlock {
  if (b.options.length >= CHOICE_MAX) return b;
  return { ...b, options: [...b.options, { text: "", correct: false }] };
}

export function removeOption(b: ChoiceBlock, index: number): ChoiceBlock {
  if (b.options.length <= CHOICE_MIN) return b;
  const options = b.options.filter((_, i) => i !== index);
  // 删掉的是唯一的正确答案：单选时把第一项补成正确，免得提交后必然校验失败
  if (!b.multi && !options.some((o) => o.correct)) options[0] = { ...options[0], correct: true };
  return { ...b, options };
}

/** 单选 ↔ 多选：切到单选时只保留第一个正确答案 */
export function setMulti(b: ChoiceBlock, multi: boolean): ChoiceBlock {
  if (multi) return { ...b, multi: true };
  const first = b.options.findIndex((o) => o.correct);
  const { multi: _drop, ...rest } = b;
  void _drop;
  return { ...rest, options: b.options.map((o, i) => ({ ...o, correct: i === Math.max(0, first) })) };
}

/** 替换 spec 里某一区的第 i 个块（不改原对象） */
export type Area = "front" | "hints" | "answer" | "explanation";

export function replaceBlock(spec: CardSpec, area: Area, index: number, next: Block): CardSpec {
  const swap = (list: Block[] | undefined) => (list ?? []).map((b, i) => (i === index ? next : b));
  switch (area) {
    case "front":
      return { ...spec, front: swap(spec.front) };
    case "hints":
      return { ...spec, hints: swap(spec.hints) };
    case "answer":
      return { ...spec, back: { ...spec.back, answer: swap(spec.back.answer) } };
    case "explanation":
      return { ...spec, back: { ...spec.back, explanation: swap(spec.back.explanation) } };
  }
}
