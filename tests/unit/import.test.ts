import test from "node:test";
import assert from "node:assert/strict";
import { makeBuilder } from "../../src/lib/import/builder";
import { detectFormat, markdownSignals } from "../../src/lib/import/detect";
import { groupBlocks } from "../../src/lib/import/group";
import { parsePlain } from "../../src/lib/import/plain";
import { parseMarkdown } from "../../src/lib/import/markdown";
import { parseHtmlBlocks } from "../../src/lib/import/html";
import { parsePasted, proseTexts, pruneBlocks } from "../../src/lib/import";
import {
  cleanInfoString,
  isProse,
  parseBlockMeta,
  parseInlineRanges,
  type BlockMeta,
} from "../../src/lib/import/types";
import { splitParagraphs } from "../../src/lib/split";
import { tokenize } from "../../src/lib/tokenize";

/** 模拟 Mintlify "Copy page" 出来的官方 Markdown：把各类结构都塞进去。 */
const DOC = [
  "> ## Documentation Index",
  "> Fetch the complete documentation index at: https://example.com/llms.txt",
  "",
  "# Best practices",
  "",
  "A **bold** word and a [link](https://example.com/a) plus `inline`.",
  "",
  "## Deterministic and non-deterministic instructions",
  "",
  "| | A | B |",
  "| :- | :- | :- |",
  "| What to do | Your prompt | Hooks |",
  "",
  "```text theme={null}",
  "pnpm tsc --noEmit",
  "echo done",
  "```",
  "",
  "> [!NOTE]",
  "> >",
  "> > Setup for a [whole team](https://example.com/team).",
  "",
  "- first item",
  "- second item",
  "",
  "1. one",
  "2. two",
].join("\n");

test("TextBuilder：range 记的是摊平后文本的下标，不是源码坐标", () => {
  const b = makeBuilder();
  b.add("A ");
  b.range("strong", () => b.add("bold"));
  b.add(" word");
  const block = b.build("paragraph");
  assert.equal(block.text, "A bold word");
  assert.deepEqual(block.ranges, [{ start: 2, end: 6, kind: "strong" }]);
  assert.equal(block.text.slice(2, 6), "bold");
});

test("TextBuilder：空区间不落库", () => {
  const b = makeBuilder();
  b.range("em", () => {});
  assert.deepEqual(b.build("paragraph").ranges, []);
});

test("cleanInfoString：Mintlify 的 ```text theme={null} 只取 text", () => {
  assert.equal(cleanInfoString("text theme={null}"), "text");
  assert.equal(cleanInfoString("JSON"), "json");
  assert.equal(cleanInfoString("{theme}"), null);
  assert.equal(cleanInfoString(null), null);
});

test("detectFormat：纯文本新闻不被误判", () => {
  const news = "The rain fell all night.\n\nBy morning the streets were empty.";
  assert.equal(detectFormat(news), "plain");
});

test("detectFormat：只有一个弱特征（列表）也不误判", () => {
  assert.equal(detectFormat("- milk\n- eggs"), "plain");
});

test("detectFormat：官方 Markdown 被识别，并列出命中特征", () => {
  assert.equal(detectFormat(DOC), "markdown");
  const s = markdownSignals(DOC);
  assert.ok(s.includes("heading"));
  assert.ok(s.includes("fence"));
  assert.ok(s.includes("table"));
  assert.ok(s.includes("callout"));
});

test("parsePlain：与改造前的 splitParagraphs 逐字一致（零回归）", () => {
  const raw = "First paragraph.\n\nSecond paragraph with two lines.\nStill second.";
  const blocks = parsePlain(raw);
  assert.deepEqual(
    blocks.map((b) => b.text),
    splitParagraphs(raw),
  );
  assert.ok(blocks.every((b) => b.kind === "paragraph" && b.ranges.length === 0));
});

test("控制变量一：只改强调语法，可见文本必须完全不动", () => {
  const styled = parseMarkdown("A **bold** word.")[0];
  const plain = parseMarkdown("A bold word.")[0];
  assert.equal(styled.text, plain.text, "样式不能改变锚点坐标基准");
  assert.equal(styled.ranges.length, 1);
  assert.equal(styled.ranges[0].kind, "strong");
  assert.equal(plain.ranges.length, 0);
});

test("控制变量二：只改标题层级，可见文本必须完全不动", () => {
  const h1 = parseMarkdown("# Title")[0];
  const h2 = parseMarkdown("## Title")[0];
  assert.equal(h1.text, h2.text);
  assert.equal(h1.text, "Title");
  assert.equal(h1.meta.depth, 1);
  assert.equal(h2.meta.depth, 2);
});

test("parseMarkdown：块类型分布正确，隐藏的 agent 索引被过滤", () => {
  const blocks = pruneBlocks(parseMarkdown(DOC));
  const kinds = blocks.map((b) => b.kind);
  assert.equal(blocks[0].text, "Best practices", "开头不该是隐藏的 Documentation Index");
  assert.equal(kinds.filter((k) => k === "heading").length, 2);
  assert.equal(kinds.filter((k) => k === "table_cell").length, 6); // 2 行 × 3 列
  assert.equal(kinds.filter((k) => k === "code").length, 1);
  assert.equal(kinds.filter((k) => k === "quote").length, 1);
  assert.equal(kinds.filter((k) => k === "list_item").length, 4);
});

test("parseMarkdown：可见文本里不残留 Markdown 标记", () => {
  const blocks = pruneBlocks(parseMarkdown(DOC));
  for (const b of blocks) {
    if (b.kind === "code") continue;
    assert.ok(!/^\s*(#|\||>|```)/.test(b.text), `块里残留了标记：${b.text.slice(0, 40)}`);
    assert.ok(!b.text.includes("**"), "加粗标记不该出现在可见文本里");
  }
});

test("parseMarkdown：表格 cell 带完整坐标，且空表头 cell 保留", () => {
  const cells = parseMarkdown(DOC).filter((b) => b.kind === "table_cell");
  assert.equal(cells[0].text, "");
  assert.equal(cells[0].meta.tableId, "t0");
  assert.equal(cells[0].meta.row, 0);
  assert.equal(cells[0].meta.col, 0);
  assert.equal(cells[0].meta.header, true);
  assert.equal(cells[0].meta.colCount, 3);
  assert.equal(cells[4].text, "Your prompt");
});

test("parseMarkdown：代码块保留换行，MDX 属性不进 lang", () => {
  const code = parseMarkdown(DOC).find((b) => b.kind === "code")!;
  assert.equal(code.text, "pnpm tsc --noEmit\necho done");
  assert.equal(code.meta.lang, "text");
  assert.ok(!code.text.includes("```"));
});

test("parseMarkdown：[!NOTE] 只作为 meta，链接 range 仍保留", () => {
  const q = parseMarkdown(DOC).find((b) => b.kind === "quote")!;
  assert.equal(q.meta.callout, "NOTE");
  assert.equal(q.text, "Setup for a whole team.");
  assert.ok(!q.text.includes("[!NOTE]"));
  const link = q.ranges.find((r) => r.kind === "link");
  assert.equal(link?.href, "https://example.com/team");
  assert.equal(q.text.slice(link!.start, link!.end), "whole team");
});

test("parseMarkdown：标题里的空锚点链接不产生可见空格链接", () => {
  const h = parseMarkdown("## [ ](#anchor) Give Claude a check to run")[0];
  assert.equal(h.text, "Give Claude a check to run");
  assert.ok(!h.ranges.some((r) => r.kind === "link" && r.href === "#anchor"));
});

test("所有 inline range 不越界，tokenize 坐标与可见文本严格对齐", () => {
  const blocks = pruneBlocks(parseMarkdown(DOC));
  for (const b of blocks) {
    for (const r of b.ranges) {
      assert.ok(r.start >= 0 && r.end <= b.text.length && r.start < r.end, `range 越界：${b.text}`);
    }
    for (const t of tokenize(b.text)) {
      assert.equal(b.text.slice(t.start, t.end), t.text);
    }
  }
});

test("parseHtmlBlocks：HTML 路径产出与 Markdown 路径同构的表格与代码块", () => {
  const html = [
    "<h1>Title</h1>",
    "<p>Hello <strong>world</strong> and <a href=\"/docs/a\">a link</a>.</p>",
    "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
    "<pre><code class=\"language-bash\">echo hi\necho bye</code></pre>",
    "<ul><li>one</li><li>two</li></ul>",
  ].join("");
  const blocks = parseHtmlBlocks(html, "https://example.com/docs/page");

  assert.equal(blocks.filter((b) => b.kind === "table_cell").length, 4);
  assert.equal(blocks.filter((b) => b.kind === "list_item").length, 2);
  const code = blocks.find((b) => b.kind === "code")!;
  assert.equal(code.text, "echo hi\necho bye");
  assert.equal(code.meta.lang, "bash");

  const p = blocks.find((b) => b.kind === "paragraph")!;
  const link = p.ranges.find((r) => r.kind === "link");
  assert.equal(link?.href, "https://example.com/docs/a", "相对链接要按 baseUrl 解析成绝对地址");
  assert.equal(p.text.slice(link!.start, link!.end), "a link");
  assert.ok(p.ranges.some((r) => r.kind === "strong"));
});

test("groupBlocks：表格 cell 与列表 item 分别重组，普通段落独立成组", () => {
  const cell = (idx: number, row: number, col: number, tableId: string) => ({
    idx,
    blockType: "table_cell",
    blockMeta: { tableId, row, col, colCount: 2 } satisfies BlockMeta,
  });
  const li = (idx: number, listId: string) => ({
    idx,
    blockType: "list_item",
    blockMeta: { listId, ordered: false, listDepth: 0 } satisfies BlockMeta,
  });
  const groups = groupBlocks([
    cell(0, 0, 0, "t0"),
    cell(1, 0, 1, "t0"),
    cell(2, 1, 0, "t0"),
    cell(3, 1, 1, "t0"),
    li(4, "l0"),
    li(5, "l0"),
    { idx: 6, blockType: "paragraph", blockMeta: {} },
  ]);

  assert.equal(groups.length, 3);
  assert.equal(groups[0].type, "table");
  if (groups[0].type === "table") {
    assert.equal(groups[0].rows.length, 2);
    assert.equal(groups[0].rows[0].length, 2);
  }
  assert.equal(groups[1].type, "list");
  assert.equal(groups[2].type, "single");
});

test("proseTexts：代码块不进词数 / CEFR / 小结", () => {
  const blocks = pruneBlocks(parseMarkdown(DOC));
  const parts = proseTexts(blocks);
  assert.ok(!parts.some((p) => p.includes("pnpm tsc")));
  assert.ok(parts.includes("What to do"), "表格单元格是自然语言，应当计入");
  assert.equal(isProse({ kind: "code" }), false);
  assert.equal(isProse({ kind: "table_cell" }), true);
});

test("parsePasted：手动指定格式优先于自动探测", () => {
  assert.equal(parsePasted(DOC, "plain").format, "plain");
  assert.equal(parsePasted(DOC, "plain").blocks.every((b) => b.kind === "paragraph"), true);
  assert.equal(parsePasted("Just a sentence.").format, "plain");
  assert.equal(parsePasted(DOC).format, "markdown");
});

test("JSON 元数据解析失败时降级为空，不让阅读页崩", () => {
  assert.deepEqual(parseBlockMeta("not json"), {});
  assert.deepEqual(parseBlockMeta(null), {});
  assert.deepEqual(parseInlineRanges("[]"), []);
  assert.deepEqual(parseInlineRanges("{oops"), []);
});

// ===== 数学公式（remark-math）=====

test("parseMarkdown：块级公式 $$…$$ 独立成 math 块，不进词数 / CEFR", () => {
  const src = [
    "Consider the objective:",
    "",
    "$$J_\\theta(\\phi) = \\mathbb{E}[r]$$",
    "",
    "And then more text.",
  ].join("\n");
  const blocks = pruneBlocks(parseMarkdown(src));
  const math = blocks.find((b) => b.kind === "math")!;
  assert.ok(math, "应有 math 块");
  assert.equal(math.text, "J_\\theta(\\phi) = \\mathbb{E}[r]");
  assert.equal(math.meta.display, true);
  assert.equal(isProse({ kind: "math" }), false);
  assert.ok(!proseTexts(blocks).some((p) => p.includes("\\mathbb")), "公式不该进 prose 统计");
});

test("parseMarkdown：行内公式保留 LaTeX 源文本并标成 math 区间，统计时剔除", () => {
  const blocks = parseMarkdown("The state $s \\in \\mathcal{S}$ is discrete.");
  const p = blocks[0];
  assert.equal(p.kind, "paragraph");
  assert.equal(p.text, "The state s \\in \\mathcal{S} is discrete.");
  const m = p.ranges.find((r) => r.kind === "math")!;
  assert.ok(m, "应有 math 区间");
  assert.equal(p.text.slice(m.start, m.end), "s \\in \\mathcal{S}");
  const parts = proseTexts(blocks);
  assert.ok(!parts.some((t) => t.includes("\\in")), "行内公式不该进词数 / CEFR");
  assert.ok(parts.some((t) => t.includes("The state")), "公式外的正文照常计入");
});

test("控制变量三：加不加公式，公式外正文的可见文本与坐标不动", () => {
  const withMath = parseMarkdown("Value $x + 1$ end.")[0];
  const noMath = parseMarkdown("Value placeholder end.")[0];
  assert.equal(withMath.text.startsWith("Value "), true);
  assert.equal(withMath.text.endsWith(" end."), true);
  // 公式只替换中间一段，前缀 "Value " 与后缀 " end." 的坐标完全一致
  assert.equal(withMath.text.indexOf("Value"), noMath.text.indexOf("Value"));
});

// ===== 配图（figure）=====

test("parseMarkdown：配图独占一段 → figure 块；混有文字的图片仍是行内占位", () => {
  const src = [
    "Intro text.",
    "",
    "![Pipeline overview](https://example.com/pipeline.png)",
    "",
    "See ![inline icon](https://example.com/icon.png) here.",
  ].join("\n");
  const blocks = pruneBlocks(parseMarkdown(src));
  const fig = blocks.find((b) => b.kind === "figure")!;
  assert.ok(fig, "应有 figure 块");
  assert.equal(fig.meta.src, "https://example.com/pipeline.png");
  assert.equal(fig.text, "Pipeline overview");
  assert.equal(isProse({ kind: "figure" }), false);
  const para = blocks.find((b) => b.text.startsWith("See "))!;
  const img = para.ranges.find((r) => r.kind === "image");
  assert.ok(img, "行内图片仍是 image 区间占位");
  assert.equal(para.text.slice(img!.start, img!.end), "inline icon");
});

test("parseMarkdown：相对路径图片按 baseUrl 解析成绝对地址", () => {
  const blocks = parseMarkdown("![a](/img/a.png)", "https://example.com/posts/1");
  assert.equal(blocks[0].kind, "figure");
  assert.equal(blocks[0].meta.src, "https://example.com/img/a.png");
});

test("parseMarkdown：带链接的配图 [![alt](img)](link) 也提升为 figure", () => {
  const blocks = parseMarkdown("[![logo](https://example.com/logo.png)](https://example.com/)");
  assert.equal(blocks[0].kind, "figure");
  assert.equal(blocks[0].meta.src, "https://example.com/logo.png");
  assert.equal(blocks[0].text, "logo");
});

// ===== HTML 路径：公式与配图 =====

test("parseHtmlBlocks：KaTeX 渲染产物还原成 LaTeX（块级 math 块 + 行内 math 区间）", () => {
  const html = [
    '<p>State <span class="katex"><math><semantics><mrow><mi>s</mi></mrow><annotation encoding="application/x-tex">s</annotation></semantics></math></span> matters.</p>',
    '<div><span class="katex-display"><span class="katex"><math display="block"><semantics><mrow><mi>J</mi></mrow><annotation encoding="application/x-tex">J = r</annotation></semantics></math></span></span></div>',
  ].join("");
  const blocks = parseHtmlBlocks(html);
  const mathBlock = blocks.find((b) => b.kind === "math")!;
  assert.ok(mathBlock, "应有块级 math");
  assert.equal(mathBlock.text, "J = r");
  assert.equal(mathBlock.meta.display, true);
  const p = blocks.find((b) => b.kind === "paragraph")!;
  const mr = p.ranges.find((r) => r.kind === "math");
  assert.ok(mr, "行内 KaTeX 应还原成 math 区间");
  assert.equal(p.text.slice(mr!.start, mr!.end), "s");
  assert.ok(!p.text.includes("annotation"), "MathML 内部标记不该混进可见文本");
});

test("parseHtmlBlocks：MathJax v2 的 math/tex script 还原成公式", () => {
  const html = [
    '<p>Inline <script type="math/tex">x^2</script> here.</p>',
    '<script type="math/tex; mode=display">y = f(x)</script>',
  ].join("");
  const blocks = parseHtmlBlocks(html);
  const p = blocks.find((b) => b.kind === "paragraph")!;
  const mr = p.ranges.find((r) => r.kind === "math");
  assert.ok(mr, "行内 math/tex 应还原成 math 区间");
  assert.equal(p.text.slice(mr!.start, mr!.end), "x^2");
  const mathBlock = blocks.find((b) => b.kind === "math")!;
  assert.ok(mathBlock, "mode=display 应独立成 math 块");
  assert.equal(mathBlock.text, "y = f(x)");
  assert.equal(mathBlock.meta.display, true);
});

test("parseHtmlBlocks：figure / 纯图段落 → figure 块，figcaption 与绝对地址都在", () => {
  const html = [
    '<figure><img src="/img/diagram.png" alt="flow"><figcaption>The agent loop</figcaption></figure>',
    '<p><img src="https://cdn.example.com/a.png" alt="solo"></p>',
    '<p>Text with <img src="https://cdn.example.com/b.png" alt="tiny"> inside.</p>',
  ].join("");
  const blocks = parseHtmlBlocks(html, "https://example.com/page");
  const figs = blocks.filter((b) => b.kind === "figure");
  assert.equal(figs.length, 2);
  assert.equal(figs[0].meta.src, "https://example.com/img/diagram.png");
  assert.equal(figs[0].text, "The agent loop");
  assert.equal(figs[1].meta.src, "https://cdn.example.com/a.png");
  assert.equal(figs[1].text, "solo");
  const para = blocks.find((b) => b.text.includes("Text with"))!;
  assert.ok(para.ranges.some((r) => r.kind === "image"), "混有文字的图片仍是行内占位");
});

test("figure / math 块的坐标契约：inline range 不越界，tokenize 与文本对齐（含公式文档）", () => {
  const src = [
    "The loss is $L(\\theta)$ over steps $t = 1, \\dots, T$.",
    "",
    "$$\\min_\\theta \\; \\mathbb{E}[L(\\theta)]$$",
    "",
    "![curve](https://example.com/curve.png)",
    "",
    "Final paragraph.",
  ].join("\n");
  const blocks = pruneBlocks(parseMarkdown(src));
  for (const b of blocks) {
    for (const r of b.ranges) {
      assert.ok(r.start >= 0 && r.end <= b.text.length && r.start < r.end, `range 越界：${b.text}`);
    }
    if (b.kind !== "math" && b.kind !== "figure") {
      for (const t of tokenize(b.text)) {
        assert.equal(b.text.slice(t.start, t.end), t.text);
      }
    }
  }
  assert.equal(blocks.filter((b) => b.kind === "math").length, 1);
  assert.equal(blocks.filter((b) => b.kind === "figure").length, 1);
});

// ===== P17：HTML 路径的裸 $ 定界符扫描（Readability 丢掉 MathJax JS 后的形态）=====

test("parseHtmlBlocks：行内 $…$ 识别为 math 区间，定界符不进可见文本", () => {
  const html = "<p>An MCE skill $s \\in \\mathcal{S}$ defines $c_s=(\\rho_s,F_s)$ and maps.</p>";
  const blocks = parseHtmlBlocks(html);
  const p = blocks[0];
  assert.equal(p.kind, "paragraph");
  assert.equal(p.text, "An MCE skill s \\in \\mathcal{S} defines c_s=(\\rho_s,F_s) and maps.");
  const maths = p.ranges.filter((r) => r.kind === "math");
  assert.equal(maths.length, 2);
  assert.equal(p.text.slice(maths[0].start, maths[0].end), "s \\in \\mathcal{S}");
  assert.equal(p.text.slice(maths[1].start, maths[1].end), "c_s=(\\rho_s,F_s)");
  assert.notEqual(maths[0].display, true, "单美元是行内公式");
});

test("parseHtmlBlocks：整段 $$…$$ 提升为 math 块（display）", () => {
  const html = "<p>$$c_s^*=\\arg\\max_{c_s}J_\\text{train}(c_s;s)$$</p>";
  const blocks = parseHtmlBlocks(html);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "math");
  assert.equal(blocks[0].meta.display, true);
  assert.ok(blocks[0].text.includes("\\arg\\max"));
});

test("parseHtmlBlocks：\\(…\\) 行内与 \\[…\\] 块级（LaTeX 原生定界符）", () => {
  const html = "<p>Value \\(x^2+y^2\\) inline.</p><p>\\[E = mc^2\\]</p>";
  const blocks = parseHtmlBlocks(html);
  const p = blocks.find((b) => b.kind === "paragraph")!;
  const mr = p.ranges.find((r) => r.kind === "math")!;
  assert.equal(p.text.slice(mr.start, mr.end), "x^2+y^2");
  const math = blocks.find((b) => b.kind === "math")!;
  assert.equal(math.meta.display, true);
  assert.equal(math.text, "E = mc^2");
});

test("parseHtmlBlocks：货币 $5 and $10 不被误判为公式；\\$ 转义保留字面美元", () => {
  const html = "<p>It costs $5 and $10 total. He paid \\$20 cash.</p>";
  const p = parseHtmlBlocks(html)[0];
  assert.equal(p.ranges.filter((r) => r.kind === "math").length, 0, "货币不是公式");
  assert.equal(p.text, "It costs $5 and $10 total. He paid $20 cash.");
});

test("parseHtmlBlocks：真实段落（含列表）里的公式逐条还原", () => {
  const html = [
    "<p>An MCE skill $s \\in \\mathcal{S}$ defines a context function $c_s=(\\rho_s,F_s)$, where:</p>",
    "<ul><li>$\\rho_s = \\{\\rho_1,\\dots,\\rho_m\\}$ are static components.</li>",
    "<li>$F_s = \\{F_1,\\dots,F_k\\}$ are dynamic operators.</li></ul>",
  ].join("");
  const blocks = parseHtmlBlocks(html);
  const paras = blocks.filter((b) => b.kind === "paragraph" || b.kind === "list_item");
  const allMaths = paras.flatMap((b) => b.ranges.filter((r) => r.kind === "math"));
  assert.equal(allMaths.length, 4);
  const li = blocks.find((b) => b.kind === "list_item")!;
  const mr = li.ranges.find((r) => r.kind === "math")!;
  assert.equal(li.text.slice(mr.start, mr.end), "\\rho_s = \\{\\rho_1,\\dots,\\rho_m\\}");
});

test("parseHtmlBlocks：图片懒加载——data-src / srcset / picture source 都能拿到真地址", () => {
  const html = [
    '<p><img src="data:image/gif;base64,R0lGODlhAQABAAAAADs=" data-src="https://cdn.example.com/real.jpg" alt="lazy"></p>',
    '<img srcset="https://cdn.example.com/a-300.png 300w, https://cdn.example.com/a-800.png 800w" alt="set">',
    '<picture><source srcset="https://cdn.example.com/b-400.webp 400w"><img src="https://cdn.example.com/b.png" alt="pic"></picture>',
  ].join("");
  const blocks = parseHtmlBlocks(html, "https://example.com/page");
  const figs = blocks.filter((b) => b.kind === "figure");
  assert.equal(figs.length, 3);
  assert.equal(figs[0].meta.src, "https://cdn.example.com/real.jpg", "data-src 覆盖 1x1 占位");
  assert.equal(figs[1].meta.src, "https://cdn.example.com/a-800.png", "srcset 取最大档");
  assert.equal(figs[2].meta.src, "https://cdn.example.com/b.png", "有真 src 时不用 source 档");
});

test("parseHtmlBlocks：data:image 内联图地址原样保留（无防盗链问题）", () => {
  const html = '<img src="data:image/svg+xml;base64,PHN2Zy8+" alt="tiny">';
  const fig = parseHtmlBlocks(html)[0];
  assert.equal(fig.meta.src, "data:image/svg+xml;base64,PHN2Zy8+");
});
