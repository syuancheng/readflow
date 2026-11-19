import assert from "node:assert/strict";
import test from "node:test";
import {
  cardBlockVisible,
  cardPresetState,
  cardProgress,
  nearBottom,
  showFeedback,
  suggestionActionable,
  suggestionHolderIndex,
  type TurnLite,
} from "../../src/lib/chat-view";

const done = (over: Partial<TurnLite> = {}): TurnLite => ({ text: "释义：好。", status: "done", answerId: "a1", ...over });

test("showFeedback：只有首次讲解显示", () => {
  assert.equal(showFeedback(done(), true), true);
  assert.equal(showFeedback(done({ ask: "整句没看懂" }), true), false);
});

test("showFeedback：没开启 / 没有 answerId / 未完成 / 失败文案都不显示", () => {
  assert.equal(showFeedback(done(), false), false);
  assert.equal(showFeedback(done({ answerId: undefined }), true), false);
  assert.equal(showFeedback(done({ status: "streaming" }), true), false);
  assert.equal(showFeedback(done({ status: "error" }), true), false);
  assert.equal(showFeedback(done({ text: "[Error: 请求失败]" }), true), false);
});

test("suggestionHolderIndex：最近一条完成的回答带建议才显示", () => {
  const withSug = done({ text: "正文\n制卡建议：这个词很常用" });
  assert.equal(suggestionHolderIndex([done(), withSug]), 1);
  assert.equal(suggestionHolderIndex([withSug, done({ ask: "再给个例句" })]), -1);
});

test("suggestionHolderIndex：多条带建议只取最后一条；进行中和失败的不算", () => {
  const a = done({ text: "A\n制卡建议：甲" });
  const b = done({ text: "B\n制卡建议：乙", ask: "x" });
  assert.equal(suggestionHolderIndex([a, b]), 1);
  assert.equal(suggestionHolderIndex([a, done({ status: "streaming", text: "C\n制卡建议：丙" })]), 0);
  assert.equal(suggestionHolderIndex([a, done({ text: "[Error: 请求失败]" })]), 0);
  assert.equal(suggestionHolderIndex([]), -1);
  assert.equal(suggestionHolderIndex([done({ status: "loading", text: "" })]), -1);
});

test("做卡状态：状态块 / 快捷项 / 建议行各自的显示条件", () => {
  const all = ["none", "generating", "ready", "failed", "pushed"] as const;
  assert.deepEqual(all.map(cardBlockVisible), [false, true, true, true, true]);
  assert.deepEqual(all.map(cardPresetState), ["enabled", "disabled", "hidden", "hidden", "hidden"]);
  assert.deepEqual(all.map(suggestionActionable), [true, false, false, true, false]);
});

test("cardProgress：随时间上升、最高 95%、预计剩余不为负", () => {
  assert.deepEqual(cardProgress(0), { pct: 0, eta: 45 });
  assert.ok(cardProgress(20).pct > 55 && cardProgress(20).pct < 70);
  assert.equal(cardProgress(600).pct, 95);
  assert.equal(cardProgress(600).eta, 0);
  assert.equal(cardProgress(-5).pct, 0);
});

test("nearBottom：在底部附近才算", () => {
  assert.equal(nearBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }), true);
  assert.equal(nearBottom({ scrollHeight: 1000, scrollTop: 100, clientHeight: 400 }), false);
  assert.equal(nearBottom({ scrollHeight: 1000, scrollTop: 530, clientHeight: 400 }), true);
  assert.equal(nearBottom({ scrollHeight: 1000, scrollTop: 530, clientHeight: 400 }, 40), false);
});
