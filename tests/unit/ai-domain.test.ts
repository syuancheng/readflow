import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDomainSystemPrompt,
  buildSystemPrompt,
  buildUserMessage,
  explainTurns,
} from "../../src/lib/ai";
import { ASK_KINDS, narrowAskKind } from "../../src/lib/learner/ask-kind";
import { ASK_LABEL } from "../../src/lib/learner/note";

/**
 * P40「从内容角度讲讲这句」：领域专家是第二个老师，不是改写第一个老师。
 * 核心性质：默认讲解 / 其他追问的提示词必须逐字不变，领域人设只在 askKind=domain 生效。
 */

const BASE = {
  word: "splitting tool results",
  context: "Another abstraction is splitting tool results into a portion handed to the LLM.",
  prefix: "Another abstraction I haven't seen is ",
  suffix: " into a portion handed to the LLM.",
};

test("domain 已进白名单，有中文标签", () => {
  assert.ok(ASK_KINDS.includes("domain"));
  assert.equal(narrowAskKind("domain"), "domain");
  assert.equal(ASK_LABEL.domain, "从内容角度讲讲");
});

test("领域人设与英语老师人设是两套，互不覆盖", () => {
  const teacher = buildSystemPrompt("en", false, BASE.word);
  const expert = buildDomainSystemPrompt();
  assert.notEqual(expert, teacher);
  assert.ok(teacher.includes("英语为母语") && teacher.includes("懂中文"));
  assert.ok(!expert.includes("英语为母语"), "领域专家不再是英语老师");
  assert.ok(expert.includes("专业技术人员"));
  assert.ok(expert.includes("不确定的具体内容直接标注"), "必须约束编造");
  assert.ok(expert.includes("不写「释义：」行"), "不能占用正文词上方的释义行");
});

test("explainTurns：只有 askKind=domain 换人设，其余逐字不变", () => {
  const baseTurns = explainTurns({ ...BASE, cardsEnabled: false });
  assert.equal(baseTurns[0].content, buildSystemPrompt("en", false, BASE.word, { cardsEnabled: false }));

  for (const kind of ["auto", "default", "word_only", "whole_sentence", "structure", "example", "custom"]) {
    const turns = explainTurns({ ...BASE, askKind: kind, cardsEnabled: false });
    assert.equal(turns[0].content, baseTurns[0].content, `${kind} 不该换人设`);
  }

  const domain = explainTurns({ ...BASE, askKind: "domain", cardsEnabled: false });
  assert.equal(domain[0].content, buildDomainSystemPrompt());
  assert.equal(domain[1].content, baseTurns[1].content, "没带领域信息时 user 消息应与默认逐字相同");
});

test("领域信息注入只在给了 domainBlock 时发生，且放在最前面", () => {
  const plain = buildUserMessage(BASE);
  const withDomain = buildUserMessage({
    ...BASE,
    askKind: "domain",
    domainBlock: "标题：Pi Mono 工具拆分\n用户设定分类：技术文档",
  });
  assert.ok(plain.startsWith("用户选中:"), "默认消息开头不变");
  assert.ok(withDomain.startsWith("这篇文章：\n标题：Pi Mono 工具拆分"));
  assert.ok(withDomain.includes("用户设定分类：技术文档"));
  assert.equal(withDomain.match(/这篇文章：/g)?.length, 1, "领域块只注入一次");
  assert.ok(withDomain.endsWith(plain.split("\n").slice(-1)[0]), "结尾的问题行不受影响");

  const empty = buildUserMessage({ ...BASE, domainBlock: "   " });
  assert.equal(empty, plain, "空领域块不能插入任何字符");
});

test("领域专家的人设讲的是整句，不再围着选区词打转", () => {
  const p = buildDomainSystemPrompt();
  assert.ok(p.includes("那是一整个句子，也就是你要讲的对象"));
  assert.ok(!p.includes("从选区里的术语推断"), "判断领域也按整句，不再按选区");
  assert.ok(p.includes("从这句话里的术语推断"));
});

test("领域追问的 user 消息保留学生问题与选区上下文", () => {
  const msg = buildUserMessage({
    ...BASE,
    askKind: "domain",
    domainBlock: "标题：法律解释指南\n用户设定分类：论文",
    prompt: "这句话我已经知道中文意思了。请从专业领域讲讲。",
  });
  assert.ok(msg.includes('用户选中: "splitting tool results"'));
  assert.ok(msg.includes('前文: "Another abstraction'));
  assert.ok(msg.includes("学生的问题: 这句话我已经知道中文意思了"));
});
