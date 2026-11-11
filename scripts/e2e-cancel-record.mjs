/**
 * P25 回归：查词 → 回看零请求 → 「取消记录」后正文标记全部消失。
 * 隔离库 + 临时端口（3123），跑完删库，不碰真实数据。需要先 npm run build。
 *
 *   node scripts/e2e-cancel-record.mjs
 *
 * 覆盖：
 *   1. 点词：落库、正文出现绿色划线和上方中文
 *   2. 再点一次同一个词：只收起右栏，记录不删
 *   3. 点绿色划线回看：右栏直接摊开存下的词典结果，/api/dict 与 /api/explain 一次都不请求
 *   4. 右栏只有一个操作「取消记录」：点了之后右栏、划线、上方中文一起消失，词条删除
 *   5. 同一个词在另一篇文章也有记录：只删本文这一处，另一篇的记录和词条保留
 *   6. 短语：拖选落库后，点短语里的某个词回看整条、零请求；取消记录后整条消失
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "cancel-record");
const DB = path.join(TMP, "readflow.db");

const log = (m) => console.log(m);
let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass++; else fail++;
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, DB_PATH: DB, NODE_ENV: "production", NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d.toString()));
server.stderr.on("data", (d) => (serverLog += d.toString()));

async function waitServer() {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`${BASE}/api/auth/status`)).status) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
const q = (sql, ...args) => {
  const d = new Database(DB, { readonly: true });
  try { return d.prepare(sql).get(...args); } finally { d.close(); }
};

try {
  if (!(await waitServer())) {
    log("服务器没起来:\n" + serverLog.slice(-3000));
    process.exit(1);
  }

  const setupRes = await fetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "cancel_owner", password: "cancel-pass-2026", phone: "13800138002" }),
  });
  const cookie = setupRes.headers.get("set-cookie")?.match(/readflow_session=([^;]+)/)?.[1];
  if (!cookie) { log("建号失败: " + (await setupRes.text())); process.exit(1); }
  const cookieHeader = `readflow_session=${cookie}`;

  const BODY =
    "The skill database tracks the history of previous skills and context functions. " +
    "A meta-level agent performs agentic crossover over prior skills to create a new skill given a task.";
  const mkText = async (title) => {
    const r = await fetch(`${BASE}/api/texts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: cookieHeader },
      body: JSON.stringify({ title, text: BODY }),
    });
    const j = await r.json();
    return j.id ?? j.text?.id;
  };
  const textA = await mkText("[E2E] cancel A");
  const textB = await mkText("[E2E] cancel B");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  const reqs = [];
  page.on("request", (r) => {
    if (/\/api\/(dict|explain)/.test(r.url())) reqs.push(r.url());
  });

  const open = async (id) => {
    await page.goto(`${BASE}/texts/${id}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".reading-body .w", { timeout: 15000 });
    await page.waitForTimeout(800);
  };
  const boxOf = (word) =>
    page.evaluate((w) => {
      const el = [...document.querySelectorAll(".reading-body .w")].find((b) => b.textContent === w);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, l: r.left + 2, r: r.right - 2 };
    }, word);
  const marksOf = (word) =>
    page.evaluate((w) => {
      const el = [...document.querySelectorAll(".reading-body .w")].find((b) => b.textContent === w);
      return { annotated: !!el?.classList.contains("w-annotated"), gloss: document.querySelectorAll("[data-gloss]").length };
    }, word);
  const cardOpen = () => page.locator(".reader-note").isVisible().catch(() => false);

  // ---- 1. 点词 ----
  await open(textA);
  let b = await boxOf("database");
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(1500);
  let ctxA = q("select count(*) c from contexts where text_id = ?", textA).c;
  let m = await marksOf("database");
  check("1 点词：落库，正文出现绿色划线和上方中文", ctxA === 1 && m.annotated && m.gloss > 0, `contexts=${ctxA} 划线=${m.annotated} 中文=${m.gloss}`);
  const snap = q("select dict_entry d from contexts where text_id = ?", textA)?.d ?? "";
  check("1b 词典结果快照随记录存下", snap.includes('"entry"') && snap.includes("translation"), snap.slice(0, 60));

  // ---- 2. 再点同一个词：只收起 ----
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(1000);
  ctxA = q("select count(*) c from contexts where text_id = ?", textA).c;
  check("2 再点一次：右栏收起，记录不删", !(await cardOpen()) && ctxA === 1, `卡片=${await cardOpen()} contexts=${ctxA}`);

  // ---- 3. 回看：零请求 ----
  reqs.length = 0;
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(1200);
  const cardText = await page.locator(".reader-note").innerText().catch(() => "");
  check(
    "3 点绿色划线回看：摊开存下的词典释义，零次词典 / AI 请求",
    (await cardOpen()) && reqs.length === 0 && /[一-龥]/.test(cardText) && !cardText.includes("查词典中"),
    `请求=${reqs.length} 卡片=${cardText.replace(/\s+/g, " ").slice(0, 50)}`,
  );

  // ---- 4. 只有一个按钮：取消记录 ----
  const btns = await page.evaluate(() =>
    [...document.querySelectorAll(".reader-note > div:first-child button")].map((x) => x.getAttribute("aria-label") || x.textContent.trim()),
  );
  check("4a 右栏标题行只剩一个操作「取消记录」", btns.filter((x) => x !== "发音" && !/^\//.test(x)).join("|") === "取消记录", btns.join(" | "));
  await page.locator('[aria-label="取消记录"]').click();
  await page.waitForTimeout(1500);
  ctxA = q("select count(*) c from contexts where text_id = ?", textA).c;
  let words = q("select count(*) c from user_words").c;
  m = await marksOf("database");
  check(
    "4 取消记录：右栏收起、划线和上方中文消失、词条删除",
    !(await cardOpen()) && !m.annotated && m.gloss === 0 && ctxA === 0 && words === 0,
    `卡片=${await cardOpen()} 划线=${m.annotated} 中文=${m.gloss} contexts=${ctxA} 词条=${words}`,
  );

  // ---- 5. 别的文章也有记录：只删本文这一处 ----
  await open(textB);
  b = await boxOf("history");
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(1500);
  await open(textA);
  b = await boxOf("history");
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(1500);
  await page.locator('[aria-label="取消记录"]').click();
  await page.waitForTimeout(1500);
  const leftA = q("select count(*) c from contexts where text_id = ?", textA).c;
  const leftB = q("select count(*) c from contexts where text_id = ?", textB).c;
  words = q("select count(*) c from user_words where lemma = 'history'").c;
  check("5 两篇都查过：取消本文记录后，另一篇的记录和词条保留", leftA === 0 && leftB === 1 && words === 1, `A=${leftA} B=${leftB} 词条=${words}`);

  // ---- 6. 短语：拖选 → 点短语里的词回看整条 → 取消 ----
  const s = await boxOf("meta-level");
  const e = await boxOf("agent");
  await page.mouse.move(s.l, s.y);
  await page.mouse.down();
  await page.mouse.move(e.r, e.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(2000);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const phraseRow = q("select quote from contexts where text_id = ? and quote like '% %'", textA);
  check("6a 拖选短语落库", !!phraseRow, phraseRow?.quote ?? "无");
  reqs.length = 0;
  await page.mouse.click(e.x, e.y);
  await page.waitForTimeout(1200);
  const title = (await page.locator(".reader-note p.font-extrabold").first().innerText().catch(() => "")).trim();
  check("6b 点短语里的词：回看整条短语，零请求", title === phraseRow?.quote && reqs.length === 0, `标题=${title} 请求=${reqs.length}`);
  await page.locator('[aria-label="取消记录"]').click();
  await page.waitForTimeout(1500);
  const phraseLeft = q("select count(*) c from contexts where text_id = ? and quote like '% %'", textA).c;
  const annLeft = await page.locator(".w-annotated").count();
  check("6c 取消短语记录：整条划线消失", phraseLeft === 0 && annLeft === 0, `contexts=${phraseLeft} 划线=${annLeft}`);

  await browser.close();
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  rmSync(TMP, { recursive: true, force: true });
}

log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
