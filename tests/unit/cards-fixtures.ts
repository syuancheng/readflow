import type { CardSpec } from "../../src/lib/cards/spec";
import type { ValidateCtx } from "../../src/lib/cards/validate";

export const SENTENCE = "The ephemeral joy faded quickly.";

/** 能通过全部校验的基准卡：原句高亮 + 单选题 */
export function baseChoiceCard(over: Partial<CardSpec> = {}): CardSpec {
  return {
    kind: "context_meaning",
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

/** 能通过全部校验的基准卡：原句挖空 */
export function baseClozeCard(over: Partial<CardSpec> = {}): CardSpec {
  return {
    kind: "word_completion",
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
    listeningEnabled: false,
    charLimit: 1800,
    ...over,
  };
}
