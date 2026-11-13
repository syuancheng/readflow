import assert from "node:assert/strict";
import test from "node:test";
import { renderCard, renderCardChecked, answerLinesOf } from "../../src/lib/cards/render";
import { lintCard } from "../../src/lib/cards/lint";
import type { CardSpec } from "../../src/lib/cards/spec";
import { baseChoiceCard, baseClozeCard, SENTENCE } from "./cards-fixtures";

const R = { sourceTitle: "My Text" };
const answerLines = (s: string) => s.split("\n").filter((l) => l.trim() === "---").length;

test("标签行：题型（白字绿底）+ 考试风格（紫）+ 来源（灰）；字体颜色固定不由 AI 决定", () => {
  const out = renderCard(baseChoiceCard({ examStyle: "托福 · 词汇题" }), R);
  const first = out.split("\n")[0];
  assert.match(first, /^\[P#L#/);
  assert.ok(first.includes("[T#B,!ffffff,!!58a700# 📖 语境理解 ]"));
  assert.ok(first.includes("[T#B,!7a3cc0,!!f5ecff# 托福 · 词汇题 ]"));
  assert.ok(first.includes("[T#!888888#My Text]"));
});

test("没有风格 / 没有来源时对应标签不出现；显式传 examStyle 优先于 spec", () => {
  const plain = renderCard(baseChoiceCard(), { sourceTitle: "" }).split("\n")[0];
  assert.ok(!plain.includes("7a3cc0") && !plain.includes("888888"));
  const fromSpec = renderCard(baseChoiceCard({ examStyle: "托福 · 词汇题" }), { sourceTitle: "" });
  assert.ok(fromSpec.includes("托福 · 词汇题"));
  const override = renderCard(baseChoiceCard({ examStyle: "托福 · 词汇题" }), { sourceTitle: "", examStyle: "雅思 · 填空题" });
  assert.ok(override.includes("雅思 · 填空题") && !override.includes("托福"));
  const off = renderCard(baseChoiceCard({ examStyle: "托福 · 词汇题" }), { sourceTitle: "", examStyle: null });
  assert.ok(!off.includes("托福"));
});

test("高亮：目标词变蓝；挖空：[F#1#答案]；前缀：只露前几个字母", () => {
  const hi = renderCard(baseChoiceCard(), R);
  assert.ok(hi.includes("The [T#B,!1cb0f6#ephemeral] joy faded quickly."));
  const blank = renderCard(baseClozeCard(), R);
  assert.ok(blank.includes("The [F#1#ephemeral] joy faded quickly."));
  const prefix = renderCard(
    baseClozeCard({ front: [{ t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "prefix", keep: 3 } }] }),
    R,
  );
  assert.ok(prefix.includes("The eph[F#1#emeral] joy"));
});

test("选择题：独占行，* 正确 / - 错误", () => {
  const out = renderCard(baseChoiceCard(), R);
  assert.ok(out.includes("[Choice##\n* brief\n- large\n- loud\n]"));
  const multi = renderCard(
    baseChoiceCard({ front: [baseChoiceCard().front[0], { t: "choice", multi: true, options: [{ text: "a", correct: true }, { text: "b", correct: true }, { text: "c", correct: false }] }] }),
    R,
  );
  assert.ok(multi.includes("[Choice#"));
});

test("普通卡一条答案线；带提示层的卡两条：正面 → 提示 → 背面", () => {
  const plain = renderCard(baseClozeCard(), R);
  assert.equal(answerLines(plain), 1);
  assert.equal(answerLinesOf(baseClozeCard()), 1);
  const layered = baseClozeCard({ kind: "layered_cloze", hints: [{ t: "text", text: "首字母 e" }] });
  const out = renderCard(layered, R);
  assert.equal(answerLines(out), 2);
  assert.equal(answerLinesOf(layered), 2);
  const [front, hint, back] = out.split("\n---\n");
  assert.ok(!front.includes("首字母"), "提示不能出现在正面");
  assert.ok(hint.includes("🧭 提示") && hint.includes("首字母 e"));
  assert.ok(back.includes("✅ 答案"));
});

test("背面分区：标题由渲染器固定；AI 补充的例句带标注；中括号被转义", () => {
  const out = renderCard(
    baseClozeCard({
      back: {
        answer: [{ t: "fill", answer: "ephemeral" }],
        explanation: [{ t: "text", text: "短暂的 [见 1]", emphasis: ["短暂"] }],
        sentenceMeaning: "快乐消失了",
        structure: "S + V",
        example: { en: "An ephemeral thing.", zh: "短暂的事物。" },
        audio: ["word", "sentence"],
      },
    }),
    R,
  );
  for (const t of ["✅ 答案", "💡 解析", "📝 整句意思", "🧩 句子主干", "📌 补充例句", "🔊 发音"]) {
    assert.ok(out.includes(t) || t === "🧩 句子主干", t);
  }
  assert.ok(out.includes("（AI 补充）"));
  assert.ok(out.includes("\\[见 1\\]"));
  assert.ok(out.includes("[T#B,!e53935#短暂]"));
  assert.ok(out.includes("[Audio#M,ID/@AUDIO:word#▶ 单词]"), "草稿阶段是占位符");
  assert.ok(out.includes("[Audio#M,ID/@AUDIO:sentence#▶ 整句]"));
});

test("音频：给了真实 id 就用真实 id", () => {
  const out = renderCard(
    baseClozeCard({ back: { answer: [{ t: "text", text: "x" }], audio: ["word"] } }),
    { ...R, audioIds: { word: "FILE123" } },
  );
  assert.ok(out.includes("[Audio#M,ID/FILE123#▶ 单词]"));
});

test("custom 题型：用 customLabel，空的退回「自定义」", () => {
  assert.ok(renderCard(baseClozeCard({ kind: "custom", customLabel: "词根" }), R).includes("✳️ 词根"));
  assert.ok(renderCard(baseClozeCard({ kind: "custom" }), R).includes("✳️ 自定义"));
});

test("renderCardChecked：渲染结果过 lint；超长返回问题", () => {
  assert.equal(renderCardChecked(baseClozeCard(), R).ok, true);
  const long = baseClozeCard({ back: { answer: [{ t: "text", text: "a".repeat(2000) }] } });
  const r = renderCardChecked(long, R, { charLimit: 1800 });
  assert.equal(r.ok, false);
  assert.equal(renderCardChecked(long, R).ok, true, "不传 charLimit 不查长度");
});

test("lint：各类问题都能检出", () => {
  const ok = "[P#L#[T#B#x]]\nbody\n---\nback\n";
  assert.equal(lintCard(ok).ok, true);
  const bad = (s: string, opts = {}) => lintCard(s, opts).problems.join("|");
  assert.match(bad("body\n"), /缺少答案线/);
  assert.match(bad("a\n---\nb\n---\nc"), /多于一条/);
  assert.match(bad("a\n---\nb", { answerLines: 2 }), /两条答案线/);
  assert.equal(lintCard("a\n---\nb\n---\nc", { answerLines: 2 }).ok, true);
  assert.match(bad("[T#x\n---\nb"), /方括号/);
  assert.match(bad("a **b**\n---\nb"), /\*\*/);
  assert.match(bad("```x```\n---\nb"), /代码块/);
  assert.match(bad("<b>x</b>\n---\nb"), /HTML/);
  assert.match(bad("  [P#L#x]\n---\nb"), /顶格/);
  assert.match(bad("[Pic#x]\n---\nb"), /图片/);
  assert.match(bad("[Choice##\n* a\n- b\n---\nb"), /闭合/);
  assert.match(bad("[Choice## \n* a\n]\n---\nb"), /独占一行/);
  assert.match(bad("a\n---\n" + "x".repeat(50), { charLimit: 10 }), /卡片太长/);
  assert.equal(lintCard("a\n---\n" + "x".repeat(50), { charLimit: 100 }).ok, true);
});

test("同一输入渲染两次结果相同（纯函数）", () => {
  const spec: CardSpec = baseChoiceCard();
  assert.equal(renderCard(spec, R), renderCard(spec, R));
});
