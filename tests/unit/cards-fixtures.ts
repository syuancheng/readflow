import type { CardSpec } from "../../src/lib/cards/spec";
import type { ValidateCtx } from "../../src/lib/cards/validate";

export const SENTENCE = "The ephemeral joy faded quickly.";

/**
 * 基准卡：原句高亮 + 单选题块。
 * 出题层已禁用选择题，但解析器 / 渲染器 / 编辑器仍保留对旧卡和历史卡的处理能力，
 * 这组 fixture 用来测那部分底层能力（校验层会拒绝它，见 cards-validate.test.ts）。
 */
export function baseChoiceCard(over: Partial<CardSpec> = {}): CardSpec {
  return {
    kind: "situation_say",
    target: "ephemeral 的语境义",
    front: [
      { t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "highlight" } },
      { t: "instruction", text: "ephemeral is closest in meaning to" },
      {
        t: "choice",
        options: [
          { text: "brief", correct: true },
          { text: "large", correct: false },
          { text: "loud", correct: false },
        ],
      },
    ],
    back: { answer: [{ t: "text", text: "brief" }], explanation: [{ t: "text", text: "短暂的" }] },
    ...over,
  };
}

/** 基准卡：原句挖空（底层渲染/解析能力用；出题层已禁用） */
export function baseClozeCard(over: Partial<CardSpec> = {}): CardSpec {
  return {
    kind: "rephrase",
    target: "补全 ephemeral",
    front: [
      { t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "blank" } },
      { t: "instruction", text: "填出完整的词" },
    ],
    back: { answer: [{ t: "fill", answer: "ephemeral" }] },
    ...over,
  };
}

export function ctx(over: Partial<ValidateCtx> = {}): ValidateCtx {
  return {
    originalSentence: SENTENCE,
    quote: "ephemeral",
    glossZh: "短暂的",
    charLimit: 1800,
    ...over,
  };
}

// ---------- P35 使用类卡的基准（都能通过全部校验） ----------

export function backTranslateCard(over: Partial<CardSpec> = {}): CardSpec {
  return {
    kind: "back_translate",
    target: "用 ephemeral 说出原句",
    front: [
      { t: "text", text: "那种短暂的喜悦很快就消失了。" },
      { t: "instruction", text: "用英文说出这句话" },
    ],
    hints: [{ t: "text", text: "ephemeral" }],
    back: {
      answer: [{ t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "highlight" } }],
    },
    ...over,
  };
}

export function situationCard(over: Partial<CardSpec> = {}): CardSpec {
  return {
    kind: "situation_say",
    target: "在场景里用 ephemeral",
    front: [
      { t: "text", text: "朋友说他升职后的兴奋只持续了几天。" },
      { t: "instruction", text: "用 ephemeral 说一句" },
    ],
    back: {
      answer: [
        { t: "sentence", source: "paraphrase", text: "His excitement was ephemeral." },
        { t: "text", text: "他的兴奋很短暂。" },
        { t: "sentence", source: "paraphrase", text: "The thrill of the promotion proved ephemeral." },
        { t: "text", text: "升职带来的兴奋转瞬即逝。" },
      ],
    },
    ...over,
  };
}

export function rephraseCard(over: Partial<CardSpec> = {}): CardSpec {
  return {
    kind: "rephrase",
    target: "用 ephemeral 改写",
    front: [
      { t: "sentence", source: "paraphrase", text: "The happiness did not last long." },
      { t: "instruction", text: "用 ephemeral 改写这句话" },
    ],
    back: {
      answer: [{ t: "sentence", source: "paraphrase", text: "The happiness was ephemeral." }],
    },
    ...over,
  };
}

export function usageCard(over: Partial<CardSpec> = {}): CardSpec {
  return {
    kind: "usage",
    target: "ephemeral 的常见搭配",
    front: [
      { t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "highlight" } },
      { t: "instruction", text: "它常和哪些词连用？先自己想两个" },
    ],
    back: {
      answer: [
        { t: "text", text: "ephemeral pleasure" },
        { t: "sentence", source: "paraphrase", text: "Ephemeral pleasures rarely satisfy us." },
        { t: "text", text: "短暂的快乐很难让人满足。" },
        { t: "text", text: "ephemeral nature" },
        { t: "sentence", source: "paraphrase", text: "Everyone noticed the ephemeral nature of fame." },
        { t: "text", text: "大家都注意到名气转瞬即逝。" },
      ],
    },
    ...over,
  };
}
