import assert from "node:assert/strict";
import test from "node:test";
import { CARDS_SAFETY_MAX, isProductive, parseCardGen, parseJsonLoose, PRODUCTIVE_KINDS } from "../../src/lib/cards/spec";
import { baseChoiceCard, baseClozeCard, backTranslateCard, rephraseCard, situationCard, usageCard } from "./cards-fixtures";

const wrap = (...cards: unknown[]) => JSON.stringify({ cards });

test("合法输出：1 张和 3 张都能解析", () => {
  const one = parseCardGen(wrap(baseChoiceCard()));
  assert.equal(one.ok, true);
  const three = parseCardGen(wrap(baseChoiceCard(), baseClozeCard(), baseClozeCard()));
  assert.equal(three.ok && three.cards.length, 3);
});

test("不是 JSON / 顶层不是对象 / 没有卡片 → 失败并给中文原因", () => {
  for (const raw of ["not json", "[]", "null", JSON.stringify({ cards: [] }), JSON.stringify({})]) {
    const r = parseCardGen(raw);
    assert.equal(r.ok, false, raw);
    if (!r.ok) assert.ok(r.reason.length > 0);
  }
});

test("P35：张数由 AI 决定——6 张照常解析，超过保险上限 8 张只保留前 8 张", () => {
  const six = parseCardGen(wrap(...Array.from({ length: 6 }, () => baseClozeCard())));
  assert.equal(six.ok && six.cards.length, 6);
  assert.equal(six.ok && six.dropped, undefined);
  assert.equal(CARDS_SAFETY_MAX, 8);
  const many = parseCardGen(wrap(...Array.from({ length: 11 }, () => baseClozeCard())));
  assert.equal(many.ok && many.cards.length, 8);
  assert.equal(many.ok && many.dropped, 3);
});

test("五种输出题型都能解析，PRODUCTIVE_KINDS 含全部保留题型", () => {
  const r = parseCardGen(wrap(backTranslateCard(), situationCard(), rephraseCard(), usageCard(), { ...rephraseCard(), kind: "custom" }));
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(r.cards.map((c) => c.kind), ["back_translate", "situation_say", "rephrase", "usage", "custom"]);
  assert.deepEqual([...PRODUCTIVE_KINDS].sort(), ["back_translate", "custom", "rephrase", "situation_say", "usage"]);
  assert.equal(isProductive("rephrase"), true);
  assert.equal(isProductive("custom"), true);
  // 识别/填空类题型已从白名单移除，解析直接失败
  assert.equal(isProductive("context_meaning"), false);
  const old = parseCardGen(wrap({ ...situationCard(), kind: "context_meaning" }));
  assert.equal(old.ok, false);
});

test("未知字段被丢弃，卡片本身保留", () => {
  const r = parseCardGen(wrap({ ...baseClozeCard(), css: "x", front: [{ t: "instruction", text: "a", color: "red" }] }));
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal("css" in r.cards[0], false);
    assert.deepEqual(r.cards[0].front[0], { t: "instruction", text: "a" });
  }
});

test("必要字段类型不对 → 整体失败", () => {
  const bad: unknown[] = [
    { ...baseClozeCard(), kind: "nope" },
    { ...baseClozeCard(), target: 5 },
    { ...baseClozeCard(), front: [] },
    { ...baseClozeCard(), front: [{ t: "video", text: "x" }] },
    { ...baseClozeCard(), front: [{ t: "sentence", source: "made-up", text: "x" }] },
    { ...baseClozeCard(), hints: [{ t: "text" }] },
    { ...baseClozeCard(), back: null },
    { ...baseClozeCard(), back: { answer: [{ t: "text", text: "x" }], example: { en: "a" } } },
    { ...baseClozeCard(), back: { answer: [{ t: "text", text: "x" }], audio: ["music"] } },
    { ...baseChoiceCard(), front: [{ t: "choice", options: [{ text: "a" }] }] },
    { ...baseChoiceCard(), front: [{ t: "choice", options: [] }] },
    { ...baseClozeCard(), back: { answer: [{ t: "fill" }] } },
    { ...baseClozeCard(), back: { answer: [{ t: "audio", of: "song", text: "x" }] } },
    { ...baseClozeCard(), front: [null] },
  ];
  for (const c of bad) assert.equal(parseCardGen(wrap(c)).ok, false, JSON.stringify(c).slice(0, 80));
  assert.equal(parseCardGen(wrap("string")).ok, false);
});

test("截断：target ≤30 字，customLabel ≤6 字；examStyle 空串当作没有", () => {
  const r = parseCardGen(
    wrap({ ...baseClozeCard(), kind: "custom", target: "a".repeat(50), customLabel: "一二三四五六七八", examStyle: "" }),
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.cards[0].target.length, 30);
    assert.equal(r.cards[0].customLabel, "一二三四五六");
    assert.equal(r.cards[0].examStyle, null);
  }
});

test("mark：取整、keep 至少为 1；非法 mark 被丢弃但句子保留", () => {
  const r = parseCardGen(
    wrap({
      ...baseClozeCard(),
      front: [
        { t: "sentence", source: "original", text: "abcdef", mark: { start: 1.9, end: 4.2, as: "prefix", keep: 0.2 } },
        { t: "sentence", source: "paraphrase", text: "x", mark: { start: "a", end: 2, as: "blank" } },
        { t: "sentence", source: "paraphrase", text: "y", mark: { start: 0, end: 1, as: "bold" } },
      ],
    }),
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    const [a, b, c] = r.cards[0].front as { mark?: unknown }[];
    assert.deepEqual(a.mark, { start: 1, end: 4, as: "prefix", keep: 1 });
    assert.equal(b.mark, undefined);
    assert.equal(c.mark, undefined);
  }
});

test("可选块：hints/explanation 为 null 当作没有；audio 保留；多选标记保留；emphasis 只留字符串", () => {
  const r = parseCardGen(
    wrap({
      ...baseChoiceCard(),
      hints: null,
      front: [
        { t: "sentence", source: "original", text: "s" },
        { t: "choice", multi: true, options: [{ text: "a", correct: true }, { text: "b", correct: true }] },
        { t: "fill", answer: "x", hint: "h" },
        { t: "audio", of: "sentence", text: "s" },
      ],
      back: {
        answer: [{ t: "text", text: "a", emphasis: ["a", 3] }],
        explanation: null,
        audio: ["word", "sentence"],
        example: { en: "e", zh: "z" },
        structure: "S+V",
        sentenceMeaning: "m",
      },
    }),
  );
  assert.equal(r.ok, true);
  if (r.ok) {
    const c = r.cards[0];
    assert.equal(c.hints, undefined);
    assert.equal(c.back.explanation, undefined);
    assert.deepEqual(c.back.audio, ["word", "sentence"]);
    assert.deepEqual((c.back.answer[0] as { emphasis?: string[] }).emphasis, ["a"]);
    assert.equal((c.front[1] as { multi?: boolean }).multi, true);
  }
});

// ---------- 2026-11-15：正式服务报「模型没有返回合法的 JSON」 ----------

test("模型把 JSON 包在 ```json 代码块里 / 前后多写一句话 → 仍能解析", () => {
  const body = wrap(baseClozeCard());
  for (const raw of ["```json\n" + body + "\n```", "```\n" + body + "\n```", "好的，卡片如下：\n" + body + "\n希望有帮助。"]) {
    const r = parseCardGen(raw);
    assert.equal(r.ok, true, raw.slice(0, 20));
  }
});

test("JSON 被截断（写到一半）→ 仍然失败，不会把半截当成功", () => {
  const body = wrap(baseClozeCard(), baseClozeCard());
  const r = parseCardGen(body.slice(0, Math.floor(body.length * 0.7)));
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "模型没有返回合法的 JSON");
});

test("空内容单独给原因", () => {
  const r = parseCardGen("   ");
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, "模型返回了空内容");
});

test("parseJsonLoose：原样 / 代码块 / 夹在文字里都取得出；取不出返回 undefined", () => {
  assert.deepEqual(parseJsonLoose('{"possible":[1]}'), { possible: [1] });
  assert.deepEqual(parseJsonLoose('```json\n{"possible":[2]}\n```'), { possible: [2] });
  assert.deepEqual(parseJsonLoose('答案：{"possible":[1,3]}。'), { possible: [1, 3] });
  assert.equal(parseJsonLoose("没有 JSON"), undefined);
  assert.equal(parseJsonLoose('{"possible":[1'), undefined);
});
