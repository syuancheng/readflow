/**
 * 右栏输入框上方的快捷问题（P44）。纯函数，只用相对路径 import（单测编译到 .unit）。
 *
 * 原来写在 Reader.tsx 里叫 askOptions，躲在「✨ 问 AI ▾」菜单后面；现在直接摆在输入框上方。
 * 提示词、askKind、整句提问的参数都和原来逐字相同——这里只是换了个地方，不改讲解行为。
 * 「做成卡片」不走 /api/explain，不在这里（由输入区单独追加）。
 */
import type { AskKind } from "./learner/types";

/** 一次向 AI 提问的参数（原 Reader.tsx 的 AskReq） */
export type AskReq = {
  /** 问题标题，显示为用户气泡里的文字；首次讲解为空 */
  ask?: string;
  /** 送给模型的具体问题 */
  prompt?: string;
  /** 整句提问时送给模型的选区（整句原文） */
  word?: string;
  wholeSentence?: boolean;
  /** 这次讲解的种类，随 /api/explain 送给服务端记事件 */
  askKind?: AskKind;
};

export type AskPreset = { key: string; label: string; req: AskReq };

export type AskPresetInput = {
  /** 选中的是短语（含空格）而不是单词 */
  isPhrase: boolean;
  /** 选中的就是整句 */
  isWholeSentence: boolean;
  /** 已经有首次讲解了 */
  hasDefault: boolean;
  /** 选中的词 / 短语 */
  quote: string;
  /** 选区所在的整句 */
  sentence: string;
};

export function buildAskPresets(input: AskPresetInput): AskPreset[] {
  const { isPhrase, isWholeSentence, hasDefault, quote, sentence } = input;
  const list: AskPreset[] = [];

  if (!hasDefault) {
    list.push({
      key: "default",
      label: isPhrase ? "这个短语在这句里什么意思" : "这个词在这句里什么意思",
      req: { askKind: "default" },
    });
  }

  if (!isWholeSentence) {
    list.push({
      key: "whole_sentence",
      label: "整句没看懂",
      req: {
        ask: "整句没看懂",
        askKind: "whole_sentence",
        word: sentence,
        wholeSentence: true,
        prompt:
          "这句话里的词我基本都认识，但整句没看懂。第一行按「释义：」格式给出整句的中文翻译；" +
          "然后用一两行点明这句难在哪里（结构、指代、搭配或背景知识），帮我下次自己能拆开；必要时再给句子地图。",
      },
    });
  }

  list.push(
    {
      key: "structure",
      label: "讲讲句子结构",
      req: {
        ask: "讲讲句子结构",
        askKind: "structure",
        prompt: `讲讲这句话的结构：主干（主语、谓语、宾语或表语）是什么，「${quote}」在其中充当什么、修饰谁。`,
      },
    },
    {
      key: "example",
      label: "再给个例句",
      req: {
        ask: "再给个例句",
        askKind: "example",
        prompt: `用「${quote}」在这句里的这个意思，再给一个简单的英文例句，并附中文翻译。`,
      },
    },
    {
      key: "domain",
      label: "从内容角度讲讲",
      req: {
        ask: "从内容角度讲讲",
        askKind: "domain",
        // 整句提问：讲的是这句话，不是划中的那个词
        word: sentence,
        wholeSentence: true,
        prompt:
          "这句话我已经知道中文意思了。请先跳出英语学习本身，从这篇文章讲的内容出发，" +
          "讲讲这句话涉及的概念、做法或设计取舍，以及作者为什么这么写、它在文章的论证里起什么作用。",
      },
    },
  );

  return list;
}
