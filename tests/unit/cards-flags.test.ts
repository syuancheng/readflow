import assert from "node:assert/strict";
import test from "node:test";
import { CHAR_LIMITS, cardsEnabled, charLimitFor, listeningEnabled } from "../../src/lib/cards/flags";

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const old = process.env.READFLOW_CARDS;
  if (value === undefined) delete process.env.READFLOW_CARDS;
  else process.env.READFLOW_CARDS = value;
  try {
    return fn();
  } finally {
    if (old === undefined) delete process.env.READFLOW_CARDS;
    else process.env.READFLOW_CARDS = old;
  }
}

test("做卡默认开；站点设置 off 关闭；环境变量 off 强制关闭", () => {
  withEnv(undefined, () => {
    assert.equal(cardsEnabled({}), true);
    assert.equal(cardsEnabled({ "cards.enabled": "on" }), true);
    assert.equal(cardsEnabled({ "cards.enabled": "off" }), false);
  });
  withEnv("off", () => assert.equal(cardsEnabled({ "cards.enabled": "on" }), false));
});

test("听力零件默认关；设置 on 才开；环境变量 off 一票否决", () => {
  withEnv(undefined, () => {
    assert.equal(listeningEnabled({}), false);
    assert.equal(listeningEnabled({ "cards.listening": "on" }), true);
  });
  withEnv("off", () => assert.equal(listeningEnabled({ "cards.listening": "on" }), false));
});

test("字数上限：普通 1800，专业 4000；档位缺失按普通", () => {
  assert.deepEqual(CHAR_LIMITS, { basic: 1800, pro: 4000 });
  assert.equal(charLimitFor("pro"), 4000);
  assert.equal(charLimitFor("basic"), 1800);
  assert.equal(charLimitFor(null), 1800);
  assert.equal(charLimitFor(undefined), 1800);
  assert.equal(charLimitFor("weird"), 1800);
});
