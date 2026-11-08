import katex from "katex";
// mhchem 扩展：注册 \ce{…}（化学式），覆盖化学类论文
import "katex/contrib/mhchem";

/**
 * 常用但 KaTeX 不内置的宏（各领域论文的高频写法）。
 * 定义成「展开到等价写法」，不与 KaTeX 内置命令冲突；写错/未知的命令
 * 仍走 throwOnError:false 的红色原文降级，不会崩页面。
 */
const MACROS: Record<string, string> = {
  "\\bm": "\\boldsymbol{#1}",
  "\\argmax": "\\arg\\max",
  "\\argmin": "\\arg\\min",
  "\\norm": "\\left\\Vert #1 \\right\\Vert",
  "\\abs": "\\left\\vert #1 \\right\\vert",
  "\\E": "\\mathbb{E}",
  "\\R": "\\mathbb{R}",
  "\\Prob": "\\mathrm{P}",
};

/**
 * LaTeX → HTML（KaTeX）。
 *
 * 纯函数、无环境依赖：SSR 和客户端对同一输入产出完全相同的字符串，
 * 不会引入 hydration 差异（这也是不选 MathJax 的原因之一）。
 * throwOnError: false → 坏公式原地显示红色错误提示而不是抛异常崩页面。
 */
export function renderMath(tex: string, display: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: false,
      strict: "ignore",
      macros: { ...MACROS },
    });
  } catch {
    return "";
  }
}
