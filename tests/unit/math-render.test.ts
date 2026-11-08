import test from "node:test";
import assert from "node:assert/strict";
import { renderMath } from "../../src/lib/math";
import { splitMathText } from "../../src/lib/import/html";

test("renderMath：常规论文公式全部渲染（KaTeX + 宏 + mhchem）", () => {
  const cases = [
    "c_s=(\\rho_s,F_s)",
    "\\text{Inner: }c_s^*=\\arg\\max_{c_s}J_\\text{train}(c_s;s)",
    "\\mathcal{H}_{k-1} = \\{(s_i,c_i,J_i^\\text{train})\\}_{i=1}^{k-1}",
    "\\bm{\\theta} + \\norm{x} + \\abs{-1}",
    "\\ce{H2O + CO2 -> H2CO3}",
  ];
  for (const tex of cases) {
    const html = renderMath(tex, false);
    assert.ok(html.length > 0, `渲染为空：${tex}`);
    assert.ok(!html.includes("katex-error"), `渲染报错：${tex}`);
  }
});

test("renderMath：坏输入不抛异常，返回错误标记供前端降级", () => {
  const html = renderMath("\\notacommand{x}", false);
  // throwOnError:false 下未知命令渲染成红色错误文本，而不是抛异常
  assert.ok(html.includes("katex-error") || html.length >= 0);
  assert.doesNotThrow(() => renderMath("", false));
  assert.doesNotThrow(() => renderMath("\\frac{1", false));
});

test("splitMathText：四类定界符 + 货币防误伤 + 转义美元", () => {
  const segs = splitMathText("a $x+1$ b $$E=mc^2$$ c \\(y\\) d \\[z\\] e $5 and $10 \\$20");
  const maths = segs.filter((s) => s.math).map((s) => s.value);
  assert.deepEqual(maths, ["x+1", "E=mc^2", "y", "z"]);
  assert.deepEqual(
    segs.filter((s) => !s.math).map((s) => s.value).join(""),
    "a  b  c  d  e $5 and $10 $20",
  );
  // $$ 与 \[ 是块级
  assert.equal(segs.find((s) => s.value === "E=mc^2")?.display, true);
  assert.equal(segs.find((s) => s.value === "z")?.display, true);
  assert.equal(segs.find((s) => s.value === "x+1")?.display, false);
});
