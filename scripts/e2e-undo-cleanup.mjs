/**
 * 回归验证「撤销」的两条路径都会把正文标记一起清掉。
 * 隔离库 + 临时端口，跑完删库。
 *
 * 背景（P24 修的 bug）：「再点同一个词」这条 delete-on-deselect 路径调了
 * unsaveWord() 却没刷新批注列表，服务端删了 context、前端 annotations 还是旧快照，
 * 于是正文里的绿色划线和行内中文标签留在原地 —— 看着像「词删了但标记还在」。
 * 卡片里的显式「撤销」按钮一直带刷新，所以只有手势那条路径出问题。
 *
 * 关键断言：
 *   1. 点词后库里应该有 context（正文出现绿色划线）
 *   2. 点「撤销」后，右栏卡片消失
 *   3. 点「撤销」后，库里 context 应该被删掉
 *   4. 点「撤销」后，正文的绿色划线 / 行内标签应该消失 ← 本次要验证的
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
const TMP = path.join(ROOT, ".verify", "undo-repro");
const DB = path.join(TMP, "readflow.db");

function log(m) { console.log(m); }
let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) { pass++; log(`PASS  ${name}${detail ? "  — " + detail : ""}`); }
  else { fail++; log(`FAIL  ${name}${detail ? "  — " + detail : ""}`); }
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

process.env.DB_PATH = DB;
process.env.PORT = String(PORT);
process.env.NODE_ENV = "production";

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, DB_PATH: DB, NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d.toString(); });
server.stderr.on("data", (d) => { serverLog += d.toString(); });

async function waitServer() {
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/status`);
      if (r.status) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

const db = () => new Database(DB, { readonly: true });

try {
  if (!(await waitServer())) {
    log("服务器没起来:\n" + serverLog.slice(-3000));
    process.exit(1);
  }

  // 建号
  const setupRes = await fetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "undo_owner", password: "undo-pass-2026", phone: "13800138001" }),
  });
  const setupBody = await setupRes.json();
  if (!setupRes.ok) { log("setup 失败: " + JSON.stringify(setupBody)); process.exit(1); }
  const cookie = setupRes.headers.get("set-cookie")?.match(/readflow_session=([^;]+)/)?.[1];
  if (!cookie) { log("没拿到 cookie: " + JSON.stringify(setupBody)); process.exit(1); }
  const cookieHeader = `readflow_session=${cookie}`;

  // 造一篇文章
  const BODY = "The skill database tracks the history of previous skills and context functions. A meta-level agent performs agentic crossover over prior skills to create a new skill given a task.";
  const textRes = await fetch(`${BASE}/api/texts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({ title: "[E2E] undo repro", text: BODY }),
  });
  const textBody = await textRes.json();
  if (!textRes.ok) { log("建文章失败: " + JSON.stringify(textBody)); process.exit(1); }
  const textId = textBody.id ?? textBody.text?.id;

  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/texts/${textId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".reading-body", { timeout: 15000 });
  await page.waitForTimeout(800);

  // 点 "crossover"（截图里的那个词）
  const target = "crossover";
  const box = await page.evaluate((w) => {
    const el = [...document.querySelectorAll(".reading-body .w")].find((b) =>
      (b.textContent ?? "").toLowerCase() === w.toLowerCase());
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, target);
  if (!box) { log("找不到目标词 " + target); process.exit(1); }
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(1500);

  // --- 状态 1：点词后 ---
  let rows = db().prepare("select count(*) c from contexts where text_id = ?").get(textId);
  check("点词后库里建了 context", rows.c > 0, `contexts=${rows.c}`);
  const annCount1 = await page.locator(".w-annotated").count();
  check("点词后正文出现绿色划线", annCount1 > 0, `.w-annotated=${annCount1}`);

  // 找到「撤销」按钮
  const undoBtn = page.locator(".rf-undo");
  const hasUndo = await undoBtn.count();
  check("卡片里有「撤销」按钮", hasUndo > 0, `count=${hasUndo}`);

  if (hasUndo === 0) {
    log("没有撤销按钮，跳过");
  } else {
    await undoBtn.first().click();
    await page.waitForTimeout(1800);

    // --- 状态 2：撤销后 ---
    rows = db().prepare("select count(*) c from contexts where text_id = ?").get(textId);
    const words = db().prepare("select count(*) c from user_words").get();
    check("撤销后库里 context 被删了", rows.c === 0, `contexts=${rows.c}`);
    check("撤销后 user_words 也被删了", words.c === 0, `user_words=${words.c}`);

    const asideText = await page.locator(".reader-aside").innerText().catch(() => "");
    // 卡片收起后右栏只剩占位提示（「点击文中单词…」），不是空白 —— 断言「没有 AI 释义残留」
    const stillGloss = await page.locator(".reader-aside .rf-ai-gloss, .reader-aside .rf-gloss").count();
    check("撤销后右栏不再显示释义", stillGloss === 0, `释义块=${stillGloss}, 右栏字数=${asideText.trim().length}`);

    const annCount2 = await page.locator(".w-annotated").count();
    const glossCount2 = await page.locator("[data-gloss]").count();
    check("撤销后正文绿色划线消失", annCount2 === 0, `.w-annotated=${annCount2}`);
    check("撤销后正文行内中文标签消失", glossCount2 === 0, `[data-gloss]=${glossCount2}`);

    if (annCount2 > 0 || glossCount2 > 0) {
      log("   >>> 复现成功：数据已删，但正文标记还在 <<<");
      const html = await page.evaluate(() => {
        const el = document.querySelector(".w-annotated");
        return el ? el.outerHTML : "";
      });
      log("   DOM 样本: " + html.slice(0, 400));
    }
  }

  // ============ 场景 2：再点同一个词（delete-on-deselect）============
  log("\n[场景 2] 再点一次同一个词 = 收起并撤销");
  const text2Res = await fetch(`${BASE}/api/texts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: cookieHeader },
    body: JSON.stringify({ title: "[E2E] undo repro 2", text: BODY }),
  });
  const text2Body = await text2Res.json();
  const textId2 = text2Body.id ?? text2Body.text?.id;

  await page.goto(`${BASE}/texts/${textId2}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".reading-body", { timeout: 15000 });
  await page.waitForTimeout(800);

  const box2 = await page.evaluate((w) => {
    const el = [...document.querySelectorAll(".reading-body .w")].find((b) =>
      (b.textContent ?? "").toLowerCase() === w.toLowerCase());
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, target);
  await page.mouse.click(box2.x, box2.y);
  await page.waitForTimeout(1500);

  let r2 = db().prepare("select count(*) c from contexts where text_id = ?").get(textId2);
  check("再点场景：点词后建了 context", r2.c > 0, `contexts=${r2.c}`);
  const ann2a = await page.locator(".w-annotated").count();
  check("再点场景：点词后正文有划线", ann2a > 0, `.w-annotated=${ann2a}`);

  // 再点一次同一个词
  await page.mouse.click(box2.x, box2.y);
  await page.waitForTimeout(1800);

  r2 = db().prepare("select count(*) c from contexts where text_id = ?").get(textId2);
  const words2 = db().prepare("select count(*) c from user_words").get();
  check("再点场景：库里 context 被删了", r2.c === 0, `contexts=${r2.c}`);
  check("再点场景：user_words 也被删了", words2.c === 0, `user_words=${words2.c}`);

  const ann2b = await page.locator(".w-annotated").count();
  const gloss2b = await page.locator("[data-gloss]").count();
  check("再点场景：正文绿色划线消失", ann2b === 0, `.w-annotated=${ann2b}`);
  check("再点场景：正文行内中文标签消失", gloss2b === 0, `[data-gloss]=${gloss2b}`);

  if (ann2b > 0 || gloss2b > 0) {
    log("   >>> 复现成功：数据已删，但正文标记还在 <<<");
    const html = await page.evaluate(() => {
      const el = document.querySelector(".w-annotated");
      return el ? el.outerHTML : "";
    });
    log("   DOM 样本: " + html.slice(0, 400));
  }

  await browser.close();
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  rmSync(TMP, { recursive: true, force: true });
}

log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
