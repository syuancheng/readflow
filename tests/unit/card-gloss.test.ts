import { test } from "node:test";
import assert from "node:assert/strict";
import { cardGloss, shortGloss } from "../../src/lib/gloss";

/**
 * P10 控制变量：同一段 AI 释义全文，两条下游拿到不同东西。
 * contexts.ai_gloss = 全文（回看批注要原样）；
 * user_words.translation / 墨墨卡片背面 = cardGloss() 提炼的短释义。
 * 句子地图贴死在原句上，脱离语境就没有意义，绝不能进卡片。
 */

const FULL = `这里的 **stopping** 不是「停止一次」，而是分类器反复把某类操作拦下来；routine 指「你环境里本来就常做的事」，所以整句在说「误报反而变多了」。

选中的 stopping 是表语里的动名词核心。

🧩 主系表 · 表语含定语从句
The opposite problem（主语） is（系动词） the classifier repeatedly stopping something（表语） ….
⚠️ is 后面是表语，不是宾语从句；that's routine 修饰 something。`;

test("主体段保留，Markdown 强调记号被清掉", () => {
  const short = cardGloss(FULL, 200);
  assert.ok(short, "应提炼出短释义");
  assert.match(short, /误报反而变多了/);
  assert.doesNotMatch(short, /\*\*/, "未闭合的星号不该进卡片");
  assert.doesNotMatch(short, /`/);
});

test("句子地图整块不进卡片：emoji 标签 / 成分标注原句 / 易错点", () => {
  const short = cardGloss(FULL, 200) ?? "";
  assert.doesNotMatch(short, /🧩/);
  assert.doesNotMatch(short, /⚠️/);
  assert.doesNotMatch(short, /主系表/);
  assert.doesNotMatch(short, /The opposite problem/, "被标注的英文原句不该进卡片背面");
  assert.doesNotMatch(short, /（主语）/);
  assert.doesNotMatch(short, /（系动词）/);
  assert.doesNotMatch(short, /that's routine/, "地图里的后续说明也不该跟进来");
  assert.notEqual(short, FULL, "卡片释义不等于 AI 全文");
  assert.ok(short.length < FULL.length / 2, "应明显短于全文");
});

test("降级提示与流式报错文案不是释义，不能写进词库", () => {
  assert.equal(cardGloss("⚠️ 还没有配置 AI 模型。\n\n点击右上角头像 → 设置"), undefined);
  assert.equal(cardGloss("前半段答案\n\n[Error: rate limited]"), undefined);
});

test("回归：主体段里顺手写的一处「（主语 …）」不能让整段释义被丢掉", () => {
  // 真调 DeepSeek 时观察到：老师偶尔会在第一段用全角括号补一句成分说明。
  // 旧规则只要看到「（主语」就删整行，结果卡片背面只剩第二段的语法说明。
  const raw = `dates back to 是个固定搭配，意思是「可追溯到」（主语 The tradition 是单数），别拆开理解。

这里作谓语，后面接宾语。`;
  const card = cardGloss(raw, 200) ?? "";
  assert.match(card, /可追溯到/, "主体段必须保留");
  assert.match(card, /主语 The tradition/, "顺带的成分说明仍是释义的一部分");
});

test("句子地图的原句行（多处成分标注）即便没有 emoji 标记也要剔除", () => {
  const raw = "先解释这句。\nThe problem（主语） is（系动词） clear（表语）.";
  assert.equal(cardGloss(raw, 200), "先解释这句。");
});

test("空输入 / 只有句子地图 / 只有小标题 → undefined，由调用方用占位符", () => {
  assert.equal(cardGloss(undefined), undefined);
  assert.equal(cardGloss(""), undefined);
  assert.equal(cardGloss("   \n  "), undefined);
  assert.equal(cardGloss("🧩 主系表\nA（主语） is（系动词） B（表语）."), undefined);
  assert.equal(cardGloss("**通常意思**\n**在这里的意思**\n**其他用法**"), undefined);
});

test("长度有上限，超出截断且带省略号", () => {
  const out = cardGloss("啊".repeat(300), 100);
  assert.equal(out, `${"啊".repeat(100)}…`);
  assert.equal(cardGloss("短释义", 100), "短释义");
});

test("旧版三段式 / 字面量 \\n / 代码块也能收敛成一行", () => {
  assert.equal(cardGloss("**在这里的意思**\\n这里指河岸，不是银行"), "这里指河岸，不是银行");
  const withFence = cardGloss("```\ncode\n```\n真正的释义在这一行", 100);
  assert.equal(withFence, "真正的释义在这一行");
  assert.equal(cardGloss(FULL, 200)?.includes("\n"), false, "卡片背面应是一行，避免做卡时被拆成多个列表项");
});

test("P13：句子地图的 ==主干== 记号不进卡片背面或插件小标签", () => {
  const raw = `over rich states and artifacts 在这里是「对丰富的状态与产物（的控制）」，不是「在…之上」。

🧩 主系表 · 表语带介词短语
==A recurring pattern== ==is== ==simple control== over rich states and artifacts.`;
  const card = cardGloss(raw, 200) ?? "";
  assert.match(card, /对丰富的状态与产物/, "第一屏的选区译法才是卡片要的内容");
  assert.doesNotMatch(card, /==/, "下划线记号不能裸着进卡片");
  assert.doesNotMatch(card, /🧩/);
  assert.equal(shortGloss("==受益于==\\n下一行"), "受益于");
});

test("回归：插件用的 shortGloss 不受影响", () => {
  assert.equal(shortGloss("n. 提示\\nvt. 提示，暗示"), "n. 提示");
  assert.equal(shortGloss(null), "");
});
