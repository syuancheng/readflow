import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * P57a：讲解请求的用量记录。
 * - parseUsage 把 DeepSeek / OpenAI 兼容 / Claude 三种 usage 统一；缺失记 undefined（不是 0）
 * - logExplain 记录段落与「同段第几次」；recordExplainUsage 只在有数据时写，缺失保持 NULL
 */
const DB = path.join(os.tmpdir(), `rf-explain-usage-${process.pid}.db`);
for (const suffix of ["", "-wal", "-shm"]) {
  const f = DB + suffix;
  if (fs.existsSync(f)) fs.writeFileSync(f, "");
}
process.env.DB_PATH = DB;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const store = require("../../src/lib/learner-store") as typeof import("../../src/lib/learner-store");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { parseUsage } = require("../../src/lib/providers") as typeof import("../../src/lib/providers");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3");
const db = new Database(DB);

test("parseUsage：DeepSeek 的 prompt_cache_hit_tokens", () => {
  assert.deepEqual(parseUsage({ prompt_tokens: 3000, completion_tokens: 120, prompt_cache_hit_tokens: 2560 }), {
    promptTokens: 3000,
    completionTokens: 120,
    cacheHitTokens: 2560,
  });
});

test("parseUsage：OpenAI 兼容的 prompt_tokens_details.cached_tokens", () => {
  assert.deepEqual(parseUsage({ prompt_tokens: 500, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 128 } }), {
    promptTokens: 500,
    completionTokens: 50,
    cacheHitTokens: 128,
  });
});

test("parseUsage：Claude 的输入不含缓存，要加回去；命中是 cache_read_input_tokens", () => {
  assert.deepEqual(
    parseUsage({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 80 }),
    { promptTokens: 1050, completionTokens: 80, cacheHitTokens: 900 },
  );
});

test("parseUsage：没有命中字段时命中数是 undefined，不是 0；空输入返回空对象", () => {
  assert.equal(parseUsage({ prompt_tokens: 10, completion_tokens: 2 }).cacheHitTokens, undefined);
  assert.deepEqual(parseUsage(undefined), {});
  assert.deepEqual(parseUsage(null), {});
});

test("parseUsage：非法值（负数、字符串）被忽略", () => {
  assert.deepEqual(parseUsage({ prompt_tokens: -1, completion_tokens: "5" as unknown as number }), {
    promptTokens: undefined,
    completionTokens: undefined,
    cacheHitTokens: undefined,
  });
});

function row(id: string) {
  return db.prepare("SELECT * FROM explain_events WHERE id = ?").get(id) as Record<string, unknown>;
}

test("logExplain 记录段落与同段第几次；同一用户同一段递增，换段或换用户重新计数", () => {
  const base = { askKind: "default" as const, via: "reader" as const, word: "artifact" };
  const a1 = store.logExplain({ ...base, userId: "u1", paraId: "p1" });
  const a2 = store.logExplain({ ...base, userId: "u1", paraId: "p1" });
  const b1 = store.logExplain({ ...base, userId: "u1", paraId: "p2" });
  const c1 = store.logExplain({ ...base, userId: "u2", paraId: "p1" });
  const none = store.logExplain({ ...base, userId: "u1" });
  assert.equal(row(a1).para_click_n, 1);
  assert.equal(row(a2).para_click_n, 2);
  assert.equal(row(b1).para_click_n, 1);
  assert.equal(row(c1).para_click_n, 1);
  assert.equal(row(none).para_click_n, null);
  assert.equal(row(a1).layout, "v1");
  assert.equal(row(a1).para_id, "p1");
});

test("recordExplainUsage 写入三个数；缺失的字段保持 NULL；完全没有数据时不改", () => {
  const id = store.logExplain({ askKind: "default", via: "reader", word: "x", userId: "u3", paraId: "p9" });
  store.recordExplainUsage("u3", id, {});
  assert.equal(row(id).prompt_tokens, null);
  store.recordExplainUsage("u3", id, { promptTokens: 2000, completionTokens: 90 });
  assert.equal(row(id).prompt_tokens, 2000);
  assert.equal(row(id).completion_tokens, 90);
  assert.equal(row(id).cache_hit_tokens, null); // 没拿到命中数 → NULL，不是 0
  store.recordExplainUsage("u3", id, { promptTokens: 2000, cacheHitTokens: 1536 });
  assert.equal(row(id).cache_hit_tokens, 1536);
});

test("recordExplainUsage 不能写别人的事件", () => {
  const id = store.logExplain({ askKind: "default", via: "reader", word: "x", userId: "u4" });
  store.recordExplainUsage("someone-else", id, { promptTokens: 1 });
  assert.equal(row(id).prompt_tokens, null);
});
