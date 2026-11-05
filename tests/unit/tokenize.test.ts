import assert from "node:assert/strict";
import test from "node:test";
import { buildAnchor, resolveAnchor } from "../../src/lib/tokenize";

/**
 * 锚点前后文必须截到句子边界（句号/问号/叹号/省略号结束一句），
 * 绝不从词中间剁——老版固定 ±40 字符窗口曾把 thus 剁成 hus（用户实测发现）。
 */
const PARA =
  "It is an empirical science and the effect of prompt engineering methods can vary a lot among models, thus requiring heavy experimentation and heuristics. This post only focuses on prompt engineering.";

test("句中词：prefix 从句首起，含完整的 thus，不从词中间截断", () => {
  const at = PARA.indexOf("heuristics");
  const a = buildAnchor(PARA, at, at + "heuristics".length);
  assert.ok(a.prefix.startsWith("It is an empirical science"), `prefix 应从句首开始：${a.prefix}`);
  assert.ok(a.prefix.includes("thus requiring"), `thus 必须完整：${a.prefix}`);
  // 不从词中间剁：thus 的 t 必须带在 prefix 里（句首到句内的连续文本）
  assert.ok(/(?:^|\s|,)thus /.test(a.prefix), "thus 必须以完整单词出现");
  assert.equal(a.suffix, ".", "heuristics 是句尾词，后文只有句号");
});

test("句首词：prefix 为空，suffix 到句号为止", () => {
  const at = PARA.indexOf("It is");
  const a = buildAnchor(PARA, at, at + 2);
  assert.equal(a.prefix, "");
  assert.ok(a.suffix.startsWith(" is an empirical"), `后文应是句内剩余部分：${a.suffix}`);
  assert.ok(a.suffix.endsWith("."), "后文必须止于句末标点");
  assert.ok(!a.suffix.includes("This post"), "后文不能越过句子边界吃进下一句");
});

test("跨句选区：prefix/suffix 覆盖首尾两句", () => {
  const s = PARA.indexOf("heuristics");
  const e = PARA.indexOf("focuses on") + "focuses on".length;
  const a = buildAnchor(PARA, s, e);
  assert.ok(a.quote.includes("This post"), "选区应横跨两句话");
  assert.ok(a.prefix.startsWith("It is an empirical science"), "prefix 从第一句句首起");
  assert.ok(a.suffix.endsWith("."), "suffix 到最后一句句末止");
});

test("新锚点与 resolveAnchor 往返：offset 失效后靠 prefix+quote+suffix 定位", () => {
  const at = PARA.indexOf("heuristics");
  const a = buildAnchor(PARA, at, at + "heuristics".length);
  // 模拟文本偏移：段落前面加了一句，老 offset 全部失准
  const shifted = `Prompt engineering matters. ${PARA}`;
  const hit = resolveAnchor(shifted, a);
  assert.ok(hit, "必须能重新定位");
  assert.equal(shifted.slice(hit.start, hit.end), "heuristics");
});
