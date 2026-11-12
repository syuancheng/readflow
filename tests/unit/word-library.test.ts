/**
 * P27 词库：词只归到最近查它的那篇文章；导出状态按卡片应用汇总。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DELETED_ARTICLE,
  articleOptions,
  contextsOfArticle,
  exportBadges,
  latestArticle,
} from "../../src/lib/word-library";

const c = (id: string, textId: string | null, textTitle: string | null, createdAt: number) => ({
  id,
  textId,
  textTitle,
  createdAt,
});

test("词归到最近查它的那篇文章", () => {
  const ctxs = [c("1", "A", "文章 A", 100), c("2", "B", "文章 B", 300), c("3", "A", "文章 A", 200)];
  assert.deepEqual(latestArticle(ctxs), {
    key: "B",
    title: "文章 B",
    deleted: false,
    kind: "article",
  });
  assert.equal(latestArticle([]), null);
});

test("最近那篇是网页摘录：kind = web（P31 词库用 🌐 区分）", () => {
  const ctxs = [
    { ...c("1", "A", "文章 A", 100), sourceType: "url" },
    { ...c("2", "W", "某个网页", 300), sourceType: "web" },
  ];
  assert.deepEqual(latestArticle(ctxs), {
    key: "W",
    title: "某个网页",
    deleted: false,
    kind: "web",
  });
});

test("最近那篇被删了：归到「已删除的文章」", () => {
  const ctxs = [c("1", "A", "文章 A", 100), c("2", "B", null, 300)];
  assert.deepEqual(latestArticle(ctxs), {
    key: DELETED_ARTICLE,
    title: "已删除的文章",
    deleted: true,
    kind: "article",
  });
});

test("原句只取归属文章里的，最新在前，最多 3 条", () => {
  const ctxs = [
    c("a1", "A", "文章 A", 100),
    c("b1", "B", "文章 B", 200),
    c("b2", "B", "文章 B", 400),
    c("b3", "B", "文章 B", 300),
    c("b4", "B", "文章 B", 250),
  ];
  const art = latestArticle(ctxs);
  assert.deepEqual(contextsOfArticle(ctxs, art).map((x) => x.id), ["b2", "b3", "b4"]);
  assert.deepEqual(contextsOfArticle(ctxs, null), []);
});

test("文章下拉：按词数计、最近活跃在前、已删除的放最后", () => {
  const A = { key: "A", title: "文章 A", deleted: false, kind: "article" as const };
  const B = { key: "B", title: "文章 B", deleted: false, kind: "article" as const };
  const W = { key: "W", title: "网页摘录", deleted: false, kind: "web" as const };
  const D = {
    key: DELETED_ARTICLE,
    title: "已删除的文章",
    deleted: true,
    kind: "article" as const,
  };
  const opts = articleOptions([
    { article: A, lastAt: 100 },
    { article: D, lastAt: 999 },
    { article: B, lastAt: 300 },
    { article: A, lastAt: 200 },
    { article: W, lastAt: 400 },
    { article: null, lastAt: 1 },
  ]);
  assert.deepEqual(opts, [
    { key: "W", title: "网页摘录", count: 1, kind: "web" },
    { key: "B", title: "文章 B", count: 1, kind: "article" },
    { key: "A", title: "文章 A", count: 2, kind: "article" },
    { key: DELETED_ARTICLE, title: "已删除的文章", count: 1, kind: "article" },
  ]);
});

test("导出标签：只算成功的，按应用分组，卡片类型按固定顺序", () => {
  const badges = exportBadges([
    { target: "markji", cardType: "cloze", status: "done" },
    { target: "markji", cardType: "qa", status: "done" },
    { target: "markji", cardType: "choice", status: "failed" },
    { target: "anki", cardType: "qa", status: "done" },
  ]);
  assert.deepEqual(badges, [
    { target: "markji", app: "墨墨", cardTypes: ["看词猜义", "挖空填空"] },
    { target: "anki", app: "Anki", cardTypes: ["看词猜义"] },
  ]);
  assert.deepEqual(exportBadges([{ target: "markji", cardType: "qa", status: "failed" }]), []);
});

test("原句片段：生词单独拿出来，两侧按词截断、补省略号", async () => {
  const { snippetAround } = await import("../../src/lib/word-library");
  const sent =
    "I explicitly mention deployment system because the layer between the raw model and the real-world context matters.";
  const sn = snippetAround(sent, "layer", 20);
  assert.equal(sn.hit, "layer");
  assert.ok(sn.before.startsWith("…") && !sn.before.startsWith("… "), sn.before);
  assert.ok(sn.after.endsWith("…"), sn.after);
  // 大小写不敏感，保留原文大小写
  assert.equal(snippetAround("Explicitly said.", "explicitly").hit, "Explicitly");
  // 短句不截断
  assert.deepEqual(snippetAround("A short one.", "short"), { before: "A ", hit: "short", after: " one." });
  // 找不到选区：退回开头，不加粗
  assert.equal(snippetAround("Nothing here.", "zzz").hit, "");
});
