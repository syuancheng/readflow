import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_MODEL_MARKER,
  NO_MODEL_NOTICE,
  isNotAGloss,
  shouldAutoExplain,
} from "../../src/lib/explain-policy";
import { cardGloss } from "../../src/lib/gloss";

/**
 * 词典查不到就自动问 AI：控制变量验证「省掉一次点击」没有把成本闸门一起拆掉。
 * 基准 = 词典未命中的新选区；每次只改一个变量，看它是否还自动发请求。
 */
const BASE = { dictHit: false, hasInitialGloss: false, fromAnnotation: false };

test("基准：词典查不到的新选区 → 自动开始 AI 释义", () => {
  assert.equal(shouldAutoExplain(BASE), true);
});

test("控制变量一：只把词典改成命中 → 不自动，命中词典的点击仍不花钱", () => {
  assert.equal(shouldAutoExplain({ ...BASE, dictHit: true }), false);
});

test("控制变量二：只加已存 AI 释义 → 不自动，回看时原样展示", () => {
  assert.equal(shouldAutoExplain({ ...BASE, hasInitialGloss: true }), false);
});

test("控制变量三：只改成「从已存批注回看」 → 不自动，不替用户烧一次请求", () => {
  assert.equal(shouldAutoExplain({ ...BASE, fromAnnotation: true }), false);
});

test("三个例外同时成立仍不自动；纯函数不改动入参", () => {
  const input = { dictHit: true, hasInitialGloss: true, fromAnnotation: true };
  assert.equal(shouldAutoExplain(input), false);
  assert.deepEqual(input, { dictHit: true, hasInitialGloss: true, fromAnnotation: true });
});

const REAL_GLOSS = `这里的 stopping 是表语里的动名词核心，指分类器反复把某类操作拦下来。

🧩 主系表 · 表语含定语从句
The opposite problem（主语） is（系动词） the classifier repeatedly stopping something（表语） ….
⚠️ is 后面是表语，不是宾语从句。`;

test("真释义（含 🧩/⚠️ 句子地图）不是降级提示，可以写回批注", () => {
  assert.equal(isNotAGloss(REAL_GLOSS), false, "不能因为出现 ⚠️ 就误判成「没配模型」");
  assert.ok(cardGloss(REAL_GLOSS), "词库侧仍能提炼出短释义");
});

test("无模型引导文案：服务端文案与前端标记零漂移，且不进批注、不进卡片背面", () => {
  assert.ok(NO_MODEL_NOTICE.includes(NO_MODEL_MARKER), "服务端提示必须带前端识别标记");
  assert.equal(isNotAGloss(NO_MODEL_NOTICE), true);
  assert.equal(cardGloss(NO_MODEL_NOTICE), undefined);
});

test("报错文案 / 空文本不是释义", () => {
  assert.equal(isNotAGloss("[Error: rate limited]"), true);
  assert.equal(isNotAGloss(""), true);
  assert.equal(isNotAGloss(null), true);
  assert.equal(isNotAGloss(undefined), true);
});
