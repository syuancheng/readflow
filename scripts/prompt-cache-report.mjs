#!/usr/bin/env node
/**
 * P57a：讲解请求的前缀缓存命中率报告。
 *
 *   node scripts/prompt-cache-report.mjs [--db data/readflow.db] [--days 7] [--out .verify/p57/report.md]
 *
 * 只读数据库。按 提示词结构(layout) / 问法(ask_kind) / 同段第几次(para_click_n) 分组，输出：
 * 请求数、平均输入 token、命中率（Σ命中 / Σ输入）、折算成本（命中部分按 1/10 计）。
 * 命中数为 NULL 的请求（接口没返回）单独计数、不计入命中率，避免把「没数据」当成「0 命中」。
 */
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const dbPath = opt("--db", process.env.DB_PATH || "data/readflow.db");
const days = Number(opt("--days", "7"));
const out = opt("--out", ".verify/p57/report.md");

const db = new Database(dbPath, { readonly: true });
const since = Date.now() - days * 24 * 3600 * 1000;
const rows = db
  .prepare(
    `SELECT layout, ask_kind, para_click_n, prompt_tokens, cache_hit_tokens, completion_tokens
       FROM explain_events
      WHERE kind = 'explain' AND created_at >= ? AND prompt_tokens IS NOT NULL`,
  )
  .all(since);

const bucket = (n) => (n == null ? "（无段落）" : n >= 3 ? "3+" : String(n));
function group(keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    const g = m.get(k) ?? { n: 0, prompt: 0, hit: 0, withHit: 0, promptWithHit: 0, noHit: 0, completion: 0 };
    g.n++;
    g.prompt += r.prompt_tokens;
    g.completion += r.completion_tokens ?? 0;
    if (r.cache_hit_tokens == null) g.noHit++;
    else {
      g.withHit++;
      g.hit += r.cache_hit_tokens;
      g.promptWithHit += r.prompt_tokens;
    }
    m.set(k, g);
  }
  return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
const cost = (g) => (g.promptWithHit ? `${(((g.promptWithHit - g.hit) + g.hit * 0.1) / g.promptWithHit * 100).toFixed(0)}%` : "—");
function table(title, keyName, keyFn) {
  const lines = [`## ${title}`, "", `| ${keyName} | 请求数 | 平均输入 token | 命中率 | 折算成本（原价=100%） | 没返回命中数 |`, "|---|---|---|---|---|---|"];
  for (const [k, g] of group(keyFn)) {
    lines.push(`| ${k} | ${g.n} | ${Math.round(g.prompt / g.n)} | ${pct(g.hit, g.promptWithHit)} | ${cost(g)} | ${g.noHit} |`);
  }
  return lines.join("\n");
}

const total = group(() => "全部")[0]?.[1];
const md = [
  `# 讲解请求前缀缓存命中率（最近 ${days} 天）`,
  "",
  `数据库：${dbPath}　生成：${new Date().toISOString()}　请求数：${rows.length}`,
  "",
  total ? `**整体命中率 ${pct(total.hit, total.promptWithHit)}**，折算成本 ${cost(total)}（命中部分按 1/10 计）。` : "最近没有带用量的讲解请求。",
  "",
  table("按提示词结构", "layout", (r) => r.layout ?? "v1"),
  "",
  table("按问法", "ask_kind", (r) => r.ask_kind ?? "default"),
  "",
  table("按同段第几次讲解请求", "第 N 次", (r) => bucket(r.para_click_n)),
  "",
].join("\n");

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, md);
console.log(md);
console.log(`\n已写入 ${out}`);
