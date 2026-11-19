import assert from "node:assert/strict";
import test from "node:test";
import { groupByArticle } from "../../src/lib/word-groups";

const titles: Record<string, string> = { a: "文章 A", b: "文章 B" };
const titleOf = (k: string | null) => (k ? (titles[k] ?? "已删除的文章") : "未归属");

test("groupByArticle：按文章分组，组的顺序是每篇第一个词出现的顺序，组内保持原顺序", () => {
  const words = [
    { id: 1, articleKey: "b" },
    { id: 2, articleKey: "a" },
    { id: 3, articleKey: "b" },
    { id: 4, articleKey: "a" },
  ];
  const g = groupByArticle(words, titleOf);
  assert.deepEqual(g.map((x) => [x.key, x.title, x.items.map((i) => i.id)]), [
    ["b", "文章 B", [1, 3]],
    ["a", "文章 A", [2, 4]],
  ]);
});

test("groupByArticle：没有归属的词单独成组；已删除的文章用调用方给的标题；空输入返回空", () => {
  const g = groupByArticle([{ articleKey: null }, { articleKey: "zzz" }], titleOf);
  assert.deepEqual(g.map((x) => x.title), ["未归属", "已删除的文章"]);
  assert.deepEqual(groupByArticle([], titleOf), []);
});
