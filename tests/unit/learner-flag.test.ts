import assert from "node:assert/strict";
import test from "node:test";
import { isPersonalizedOn, PERSONALIZED_KEY } from "../../src/lib/learner/flag";
import { narrowAskKind, ASK_KINDS } from "../../src/lib/learner/ask-kind";
import { SETTINGS_KEYS } from "../../src/lib/config";

test("环境变量 READFLOW_PERSONALIZED=off 优先于站点设置", () => {
  assert.equal(isPersonalizedOn({ [PERSONALIZED_KEY]: "on" }, { READFLOW_PERSONALIZED: "off" }), false);
  assert.equal(isPersonalizedOn({ [PERSONALIZED_KEY]: "off" }, { READFLOW_PERSONALIZED: "off" }), false);
});

test("站点开关 off / on，以及没设过时默认 on", () => {
  assert.equal(isPersonalizedOn({ [PERSONALIZED_KEY]: "off" }, {}), false);
  assert.equal(isPersonalizedOn({ [PERSONALIZED_KEY]: "on" }, {}), true);
  assert.equal(isPersonalizedOn({}, {}), true);
  assert.equal(isPersonalizedOn(null, null), true);
  assert.equal(isPersonalizedOn({ [PERSONALIZED_KEY]: "off" }, { READFLOW_PERSONALIZED: "on" }), false, "env 只有 off 才强制关");
});

test("flag 用的键名与 config.ts 的 SETTINGS_KEYS 是同一个", () => {
  assert.equal(PERSONALIZED_KEY, SETTINGS_KEYS.aiPersonalized);
});

test("askKind 白名单与缺省值", () => {
  assert.deepEqual([...ASK_KINDS], [
    "auto", "default", "word_only", "whole_sentence", "structure", "example", "custom",
  ]);
  for (const k of ASK_KINDS) assert.equal(narrowAskKind(k), k);
  assert.equal(narrowAskKind(undefined), "default");
  assert.equal(narrowAskKind("nope"), "default");
  assert.equal(narrowAskKind(42), "default");
});
