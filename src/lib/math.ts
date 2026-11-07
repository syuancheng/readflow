import katex from "katex";

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
    });
  } catch {
    return "";
  }
}
