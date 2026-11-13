import assert from "node:assert/strict";
import test from "node:test";
import { CACHE_MAX, CACHE_TTL_MS, ExplainCache, explainCache, type CacheEntry } from "../../src/lib/cards/explain-cache";

const entry = (over: Partial<Omit<CacheEntry, "at">> = {}): Omit<CacheEntry, "at"> => ({
  userId: "u1",
  contextId: "c1",
  messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }],
  assistantText: "答",
  provider: "deepseek",
  model: "m",
  ...over,
});

test("常量：10 分钟 / 500 条（PRD F2）", () => {
  assert.equal(CACHE_TTL_MS, 600_000);
  assert.equal(CACHE_MAX, 500);
});

test("写入后命中，返回完整 messages 和讲解全文", () => {
  const c = new ExplainCache();
  c.put("a1", entry());
  const hit = c.get("a1", "u1", "c1");
  assert.equal(hit?.assistantText, "答");
  assert.equal(hit?.messages.length, 2);
});

test("用户或记录不匹配 → 不命中，但缓存还在", () => {
  const c = new ExplainCache();
  c.put("a1", entry());
  assert.equal(c.get("a1", "u2", "c1"), null);
  assert.equal(c.get("a1", "u1", "c2"), null);
  assert.ok(c.get("a1", "u1", "c1"));
});

test("不存在的 id → null", () => {
  assert.equal(new ExplainCache().get("zzz", "u1", "c1"), null);
});

test("超过 10 分钟不再命中，并被清掉", () => {
  let now = 1_000_000;
  const c = new ExplainCache(CACHE_TTL_MS, CACHE_MAX, () => now);
  c.put("a1", entry());
  now += CACHE_TTL_MS;
  assert.ok(c.get("a1", "u1", "c1"), "刚好 10 分钟还算");
  now += 1;
  assert.equal(c.get("a1", "u1", "c1"), null);
  assert.equal(c.size(), 0);
});

test("满了淘汰最久没用的；命中会刷新位置（LRU）", () => {
  const c = new ExplainCache(CACHE_TTL_MS, 3);
  c.put("a", entry());
  c.put("b", entry());
  c.put("c", entry());
  assert.ok(c.get("a", "u1", "c1")); // a 变成最新
  c.put("d", entry());
  assert.equal(c.get("b", "u1", "c1"), null, "b 最久没用，被淘汰");
  assert.ok(c.get("a", "u1", "c1"));
  assert.ok(c.get("c", "u1", "c1"));
  assert.ok(c.get("d", "u1", "c1"));
  assert.equal(c.size(), 3);
});

test("更新已有的 key 不会把别人挤掉", () => {
  const c = new ExplainCache(CACHE_TTL_MS, 3);
  c.put("a", entry());
  c.put("b", entry());
  c.put("c", entry());
  c.put("c", entry({ assistantText: "新" }));
  assert.equal(c.size(), 3);
  assert.ok(c.get("a", "u1", "c1"));
  assert.equal(c.get("c", "u1", "c1")?.assistantText, "新");
});

test("单例：同一个实例", () => {
  assert.equal(explainCache(), explainCache());
});
