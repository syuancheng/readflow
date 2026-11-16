import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildSystemPrompt, buildUserMessage, streamExplain } from "../../src/lib/ai";
import { SUGGESTION_PREFIX } from "../../src/lib/cards/suggestion";

// 单测编译到 .unit/ 后 __dirname 会变，统一从仓库根（npm test 的工作目录）读快照
const snapshot = (name: string) =>
  fs.readFileSync(path.join(process.cwd(), "tests/unit/fixtures", name), "utf8");

// P36：个性化关闭时的提示词快照（固定深度，没有「同句第几次」规则）。
// 快照之前是「P32 改动前」，P36 有意改了深度段和三处例外（用户 2026-11-16 决定）。
const ZH_BEFORE = snapshot("ai-system-zh-p36.txt");
const EN_BEFORE = snapshot("ai-system-en-p36.txt");

/**
 * P33（spec §7.1）：系统提示词末尾追加「制卡建议」段——个性化开关 on/off 都追加。
 * 「P32 逐字不变」的语义随之更新为「去掉制卡建议段后逐字一致」。
 * 这是用户确认的有意改动：快照 = P32 之前的提示词 + 制卡建议段。
 */
const CARD_RULE_ZH = /【制卡建议（可选，只在最后一行）】[\s\S]*$/.source;
function withoutCardRule(p: string): string {
  return p
    .replace(/(【制卡建议（可选，只在最后一行）】|Card suggestion \(optional, last line only\):)[\s\S]*$/, "")
    .replace(/\n+$/, "");
}

/** 两段文字逐行比较，返回不同的行（行数必须一致） */
function changedLines(after: string, before: string): { before: string; after: string }[] {
  const a = after.split("\n");
  const b = before.split("\n");
  assert.equal(a.length, b.length, "行数不能变");
  return a.flatMap((line, i) => (line === b[i] ? [] : [{ before: b[i], after: line }]));
}

const BASE = {
  word: "is",
  context: "The opposite problem is the classifier repeatedly stopping something.",
  prefix: "The opposite problem ",
  suffix: " the classifier repeatedly stopping something that's routine in your setup.",
};

test("开关关闭时：与 P36 快照逐字一致；末尾多了制卡建议段（P33 有意追加）", () => {
  for (const [p, before] of [
    [buildSystemPrompt("en", false, "steer"), ZH_BEFORE],
    [buildSystemPrompt("en", true, "steer"), EN_BEFORE],
    [buildSystemPrompt("en", false, "steer", { personalized: false }), ZH_BEFORE],
    [buildSystemPrompt("en", true, "steer", { personalized: false }), EN_BEFORE],
  ] as [string, string][]) {
    assert.ok(p.includes("制卡建议"), "P33 后提示词必须含制卡建议段");
    assert.ok(p.includes("制卡建议："));
    assert.equal(withoutCardRule(p), before.replace(/\n+$/, ""), "去掉制卡建议段后必须与 P36 快照逐字一致");
  }
});

test("P33：cardsEnabled=false 时不追加制卡建议段，与 P36 快照逐字一致", () => {
  assert.equal(buildSystemPrompt("en", false, "steer", { cardsEnabled: false }), ZH_BEFORE);
  assert.equal(buildSystemPrompt("en", true, "steer", { cardsEnabled: false }), EN_BEFORE);
});

test("P33：制卡建议段在提示词最后，且建议行规则（30 字、最后一行、之后无内容）写明", () => {
  const p = buildSystemPrompt("en", false, "steer");
  const rule = p.slice(p.indexOf("【制卡建议"));
  assert.ok(rule.includes("制卡建议："), "规则里要有输出格式「制卡建议：」");
  assert.ok(rule.includes("30 个字"));
  assert.ok(rule.includes("最后一行"));
  assert.ok(rule.includes("不值得做时什么都不输出"));
  assert.ok(rule.includes("建议行之后不能再有任何内容"));
  assert.ok(p.trimEnd().endsWith("建议行之后不能再有任何内容。"), "制卡建议段必须是提示词的最后一段");
});

test("开关打开时：中文人设换成 L1–L4 深度指引，旧的「同句第 2/3 次」硬规则不再出现", () => {
  const p = buildSystemPrompt("en", false, "steer", { personalized: true });
  assert.ok(p.includes("L1 只给这句里的意思") && p.includes("L4 再加句子地图"));
  assert.ok(p.includes("偏好简洁的学生最多加「整句大意：」"));
  assert.ok(!p.includes("同句连续请教"), "个性化模式下提示词里不再有「同句连续请教」");
  assert.ok(p.includes("阅读目的会影响义项选择"));
  assert.ok(p.includes("第一行永远是「释义：」"), "个性化不能打乱释义第一行");
  assert.ok(p.includes("【答案深度由你判断，不要问我】"));
  const depth = p.slice(p.indexOf("【答案深度"), p.indexOf("【硬性禁止】"));
  assert.ok(!depth.includes("每次都按选区本身判断"), "固定深度段整段换成画像判断");
  // P36：深度段之前，开和关逐字一致（「同句第几次」的例外两种模式都已去掉）
  assert.equal(changedLines(p.slice(0, p.indexOf("【答案深度")), ZH_BEFORE.slice(0, ZH_BEFORE.indexOf("【答案深度"))).length, 0);
  assert.ok(p.includes("必须用「整句大意：」这个标记开头") && p.includes("概括一句话"), "整句大意必须是概括、不能逐字翻译的约束要保留");
  assert.equal(p.slice(p.indexOf("【硬性禁止】"), p.indexOf("【制卡建议")), ZH_BEFORE.slice(ZH_BEFORE.indexOf("【硬性禁止】")).replace(/\n+$/, "") + "\n\n");
  assert.ok(p.includes("制卡建议"), "个性化打开时制卡建议也要在");
});

test("开关打开时：monolingual 人设同样换成个性化深度指引，且不破坏后面的硬性禁止", () => {
  const p = buildSystemPrompt("en", true, "steer", { personalized: true });
  assert.ok(p.includes("student profile") && p.includes("L1 gives only the meaning"));
  assert.ok(p.includes("Do not output your reasoning."), "英文人设不能丢掉「不输出推理过程」的约束");
  assert.ok(!p.includes("Second ask on the same sentence"));
  assert.ok(!p.includes("Depth (default)"), "固定深度段整段换成画像判断");
  assert.equal(changedLines(p.slice(0, p.indexOf("Depth is yours")), EN_BEFORE.slice(0, EN_BEFORE.indexOf("Depth (default)"))).length, 0);
  assert.ok(!p.includes("repeat count") && !p.includes("keeps asking about the same sentence"));
  assert.equal(
    p.slice(p.indexOf("Never: phonetic symbols"), p.indexOf("Card suggestion")),
    EN_BEFORE.slice(EN_BEFORE.indexOf("Never: phonetic symbols")).replace(/\n+$/, "") + "\n\n",
  );
  assert.ok(p.includes("Card suggestion"), "英文人设也要有制卡建议段");
});

test("学生档案放在 user 消息最前面；为空时 user 消息和改动前逐字相同", () => {
  const before = buildUserMessage(BASE);
  assert.equal(buildUserMessage({ ...BASE, learnerBlock: "" }), before);
  assert.equal(buildUserMessage({ ...BASE, learnerBlock: "   " }), before);
  const withBlock = buildUserMessage({ ...BASE, learnerBlock: "学生档案（…）：\n- 估计水平：B2" });
  assert.ok(withBlock.startsWith("学生档案（…）："));
  assert.equal(withBlock.slice("学生档案（…）：\n- 估计水平：B2".length + 2), before);
  assert.ok(withBlock.indexOf("学生档案") < withBlock.indexOf("用户选中"));
});

// 让 linter 不抱怨未使用的导入（CARD_RULE_ZH 仅作文档说明保留）
void CARD_RULE_ZH;
void SUGGESTION_PREFIX;

test("P36：观察块不再告诉模型「同句第几次」（开关开和关都一样）；之前问过的选区仍保留（用来避免重复）", () => {
  const signals = {
    source: "word" as const, position: "middle" as const, selectionWords: 1, sentenceWords: 12, coverage: 0.1,
    sentence: "x", sentenceStart: 0, sentenceEnd: 1, repeatCount: 3, priorAsks: [{ selection: "deliberately" }],
  };
  for (const personalized of [true, false, undefined]) {
    const msg = buildUserMessage({ ...BASE, signals, personalized });
    assert.ok(!msg.includes("同句连续请教") && !msg.includes("第 3 次"), String(personalized));
    assert.ok(msg.includes("之前问过的选区") && msg.includes("deliberately"), String(personalized));
  }
});

test("P36：开关关闭时是固定深度——没有任何按「同句第几次」加深的规则，整句和结构交给按钮", () => {
  const zh = buildSystemPrompt("en", false, "steer");
  for (const banned of ["同句已问过 ≥2", "同句已问过多次", "同句第 2 次", "第 2 次请教", "第 3 次及以上", "二次扩面", "二次/三次", "同句连续请教"]) {
    assert.ok(!zh.includes(banned), banned);
  }
  assert.ok(zh.includes("每次都按选区本身判断") && zh.includes("「整句没看懂」") && zh.includes("「讲讲句子结构」"));
  assert.ok(zh.includes("这句被问过几次不决定讲多深"));
  const en = buildSystemPrompt("en", true, "steer");
  for (const banned of ["repeat count", "2nd", "3rd", "Second ask", "Third or later"]) assert.ok(!en.includes(banned), banned);
  assert.ok(en.includes("never decides depth"));
});

test("P34：个性化深度指引只传反馈信号与三档的用意，不给分档操作手册；关闭时提示词不变", () => {
  const zh = buildSystemPrompt("en", false, "steer", { personalized: true });
  assert.ok(zh.includes("「最近的反馈」") && zh.includes("设这三档只为提醒你一件事") && zh.includes("以最近的为准"));
  assert.ok(zh.includes("「太浅」是讲完他还是没懂") && zh.includes("「太深」是你讲得太透、他没机会自己想"));
  assert.ok(!zh.includes("向被评「刚好」的那次讲法靠拢"), "不该再说向某次靠拢");
  assert.ok(!zh.includes("避开被评「太深」"), "不该再说避开某次做法");
  const en = buildSystemPrompt("en", true, "steer", { personalized: true });
  assert.ok(en.includes("最近的反馈") && en.includes("follow the recent feedback"));
  assert.ok(en.includes("not an instruction list"), "英文版同样明确这不是操作清单");
  assert.ok(!en.includes("move toward the answer rated"), "英文版不该再说向某次靠拢");
  assert.ok(!buildSystemPrompt("en", false, "steer", { personalized: false }).includes("最近的反馈"));
});

test("讲解请求不设输出上限：OpenAI 兼容接口的请求体里没有 max_tokens（2026-11-15）", async () => {
  const original = globalThis.fetch;
  let sent: Record<string, unknown> = {};
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body ?? "{}"));
    const enc = new TextEncoder();
    const chunk = (d: object) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, ...d }] })}\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(chunk({ delta: { content: "释义：好" }, finish_reason: null })));
        c.enqueue(enc.encode(chunk({ delta: {}, finish_reason: "stop" })));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    let out = "";
    for await (const s of streamExplain(
      { word: "artifact", context: "x", detailed: true, personalized: true },
      { settings: { "ai.activeProvider": "deepseek", "ai.deepseek.apiKey": "sk-test" }, env: {} },
    )) out += s;
    assert.equal(out, "释义：好");
    assert.equal("max_tokens" in sent, false);
  } finally {
    globalThis.fetch = original;
  }
});
