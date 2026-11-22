/**
 * 分类同步回归：预设 + 库中自定义分类必须在「编辑弹窗 / 导入下拉 / 筛选行」三处一致。
 * 隔离库 + 端口 3164；只验证分类 UI，不调模型。需先 npm run build。
 *   node scripts/e2e-category-sync.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3164;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "category-sync");
const DB = path.join(TMP, "readflow.db");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, DB_PATH: DB, NODE_ENV: "production", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
});
let log = ""; server.stdout.on("data", (d) => (log += d)); server.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/auth/status`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }
const api = async (p, { cookie, method = "GET", body } = {}) => {
  const r = await fetch(BASE + p, { method, headers: { ...(cookie ? { cookie: `readflow_session=${cookie}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let data = null; try { data = JSON.parse(t); } catch {}
  return { status: r.status, data };
};

let browser;
try {
  const setup = await fetch(`${BASE}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "cat_owner", password: "cat-owner-2026", phone: "13800138045" }) });
  const cookie = setup.headers.get("set-cookie").match(/readflow_session=([^;]+)/)[1];

  // 造两篇文章：一篇用预设「技术文档」，一篇用自定义「托福」。
  // 这样筛选行、编辑弹窗、导入下拉都应看到 7 预设 + 托福。
  await api("/api/texts", { cookie, method: "POST", body: { title: "TOEFL practice", category: "托福", text: "The skill database tracks the history of previous skills and context functions. A meta-level agent performs agentic crossover over prior skills to create a new skill." } });
  await api("/api/texts", { cookie, method: "POST", body: { title: "Tech doc", category: "技术文档", text: "A meta-level agent performs agentic crossover over prior skills to create a new skill given a task and prior context." } });

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(BASE, { waitUntil: "networkidle" });

  // 1) 筛选行：应包含「托福」（库里用过），且不含没数据的「文学」
  const filterChips = await page.locator(".tm-filter-row button").allInnerTexts();
  check("筛选行含自定义分类「托福」", filterChips.includes("托福"), JSON.stringify(filterChips));
  check("筛选行不显示无数据的预设「文学」", !filterChips.includes("文学"), JSON.stringify(filterChips));

  // 2) 编辑弹窗：分类 chip 应含「托福」
  await page.locator(".duo-text-edit").first().click();
  await page.locator(".tm-modal").waitFor();
  const dialogChips = await page.locator(".tm-cats button").allInnerTexts();
  check("编辑弹窗含自定义分类「托福」", dialogChips.includes("托福"), JSON.stringify(dialogChips));
  check("编辑弹窗含全部 7 个预设分类", ["技术文档","文学","博客","新闻","论文","教程","其他"].every((c) => dialogChips.includes(c)), JSON.stringify(dialogChips));
  await page.locator(".tm-close").click();

  // 3) 导入下拉：应含「托福」
  await page.locator('button[aria-label="文章分类"]').click();
  const dropdownOpts = await page.locator('ul[aria-label="文章分类"] button').allInnerTexts();
  check("导入下拉含自定义分类「托福」", dropdownOpts.includes("托福"), JSON.stringify(dropdownOpts));
  check("导入下拉含全部 7 个预设分类", ["技术文档","文学","博客","新闻","论文","教程","其他"].every((c) => dropdownOpts.includes(c)), JSON.stringify(dropdownOpts));
} catch (e) {
  fail++;
  console.log("ERROR", e.message, "\n", log.slice(-1500));
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
