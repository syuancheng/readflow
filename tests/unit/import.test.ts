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
