/**
 * P26 回归：中文悬停才显示 / 「问 AI」对话串追加不覆盖。
 * P36：同一句问了几次不再决定要不要问 AI——词典查得到就不自动问，由学生点「问 AI」。
 * 隔离库 + 临时端口（3124），跑完删库；/api/explain 由 Playwright 拦截返回模拟回答，
 * 不调真实模型、不花钱，同时能检查每次请求带了什么。需要先 npm run build。
 *
 *   node scripts/e2e-ask-thread.mjs
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
const PORT = 3124;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "ask-thread");
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
  if (!(await waitServer())) { log("服务器没起来:\n" + serverLog.slice(-3000)); process.exit(1); }
  const setupRes = await fetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "ask_owner", password: "ask-pass-2026", phone: "13800138003" }),
  });
  const cookie = setupRes.headers.get("set-cookie")?.match(/readflow_session=([^;]+)/)?.[1];
  if (!cookie) { log("建号失败: " + (await setupRes.text())); process.exit(1); }
  const BODY =
    "The skill database tracks the history of previous skills and context functions. " +
    "A meta-level agent performs agentic crossover over prior skills to create a new skill given a task.";
  const textRes = await fetch(`${BASE}/api/texts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `readflow_session=${cookie}` },
    body: JSON.stringify({ title: "[E2E] ask thread", text: BODY }),
  });
  const textId = (await textRes.json()).id;

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();

  // 模拟模型：按请求内容回一段固定文本，记下每次请求体
  const asks = [];
  await page.route("**/api/explain", async (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    asks.push(body);
    const tag = body.prompt ? body.prompt.slice(0, 6) : `默认·第${body.signals?.repeatCount ?? "?"}次`;
    await route.fulfill({
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
      body: `释义：模拟中文\n这是对「${body.word}」的模拟回答（${tag}）。`,
    });
  });

  const open = async () => {
    await page.goto(`${BASE}/texts/${textId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".reading-body .w", { timeout: 15000 });
    await page.waitForTimeout(800);
  };
  const boxOf = (word) =>
    page.evaluate((w) => {
      const el = [...document.querySelectorAll(".reading-body .w")].find((b) => b.textContent === w);
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, word);
  const labelOpacity = (word) =>
    page.evaluate((w) => {
      const el = [...document.querySelectorAll(".reading-body .w")].find((b) => b.textContent === w);
      return el?.hasAttribute("data-gloss") ? getComputedStyle(el, "::before").opacity : "无标签";
    }, word);
  const cardText = () => page.locator(".reader-note").innerText().catch(() => "");

  // ---- 1. 第一个词（词典查得到）：不调模型 ----
  await open();
  let b = await boxOf("database");
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(1500);
  check("1 同句第一个词，词典查得到：不调模型", asks.length === 0, `请求=${asks.length}`);
  check("1b 正在看的这条：上方中文显示", (await labelOpacity("database")) === "1", `opacity=${await labelOpacity("database")}`);

  // ---- 2. 中文默认收起，悬停才显示 ----
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(400);
  const hidden = await labelOpacity("database");
  await page.mouse.move(b.x, b.y);
  await page.waitForTimeout(400);
  const shown = await labelOpacity("database");
  check("2 中文默认收起，鼠标停在划线上才显示", hidden === "0" && shown === "1", `平时=${hidden} 悬停=${shown}`);

  // ---- 3. 「问 AI」：一个按钮，展开有选项 + 输入框 ----
  await page.mouse.click(b.x, b.y); // 回看
  await page.waitForTimeout(800);
  const askBtn = page.locator('.reader-note button:has-text("问 AI")');
  const legacy = await page.locator('.reader-note button:has-text("追问"), .reader-note button:text-is("✨ AI 释义")').count();
  check("3a 右栏只有一个「问 AI」入口（原「AI 释义」「追问」已合并）", (await askBtn.count()) === 1 && legacy === 0, `旧按钮=${legacy}`);
  await askBtn.click();
  const chips = await page.locator(".rf-ask-chip").allInnerTexts();
  const hasInput = await page.locator(".rf-ask-menu input").count();
  check("3b 展开后有选项和输入框", chips.includes("整句没看懂") && chips.length >= 3 && hasInput === 1, chips.join(" / "));

  // ---- 4. 整句没看懂：追加在词典下面 ----
  await page.locator('.rf-ask-chip:has-text("整句没看懂")').click();
  await page.waitForTimeout(1200);
  const last = asks.at(-1);
  let card = await cardText();
  check(
    "4 整句没看懂：按整句提问，回答追加在词典释义下面",
    last?.word?.startsWith("The skill database tracks") && card.includes("数据库") && card.includes("你问：整句没看懂"),
    `word=${last?.word?.slice(0, 30)}…`,
  );

  // ---- 5. 再问一次：前一段不被覆盖 ----
  await askBtn.click();
  await page.locator('.rf-ask-chip:has-text("再给个例句")').click();
  await page.waitForTimeout(1200);
  await askBtn.click();
  await page.locator(".rf-ask-menu input").fill("这里为什么用 tracks？");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  card = await cardText();
  const turns = (card.match(/你问：/g) ?? []).length;
  check(
    "5 连问三次：三段都在、词典还在，按顺序追加",
    turns === 3 && card.includes("数据库") && card.indexOf("整句没看懂") < card.indexOf("再给个例句") && card.includes("你问：这里为什么用 tracks？"),
    `追问段数=${turns}`,
  );
  if (process.env.SHOT_DIR) {
    await askBtn.click();
    await page.locator(".reader-note").screenshot({ path: path.join(process.env.SHOT_DIR, "ask-thread.png") });
    await askBtn.click();
  }
  const stored = q("select ai_gloss g from contexts where text_id = ? and quote = 'database'", textId)?.g ?? "";
  check("5b 整串存进这条记录", (stored.match(/【追问】/g) ?? []).length === 3, `【追问】×${(stored.match(/【追问】/g) ?? []).length}`);

  // ---- 6. 回看：原样还原，零请求 ----
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const before = asks.length;
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(1000);
  card = await cardText();
  check("6 回看：三段追问原样还原，零请求", asks.length === before && (card.match(/你问：/g) ?? []).length === 3, `新请求=${asks.length - before}`);

  // ---- 7. P36：同句第二个词（词典查得到）：不再自动问 AI，由学生自己点「问 AI」 ----
  await page.keyboard.press("Escape");
  b = await boxOf("tracks");
  const n7 = asks.length;
  const lookups7 = q("select count(*) n from explain_events where kind = 'lookup'")?.n ?? 0;
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(1500);
  card = await cardText();
  const lookups7b = q("select count(*) n from explain_events where kind = 'lookup'")?.n ?? 0;
  check(
    "7 同句第二个词、词典查得到：不调模型（问了几次不再决定要不要问 AI）；这次划选照样记成一次提问",
    asks.length === n7 && !card.includes("AI 释义") && lookups7b === lookups7 + 1,
    `新请求=${asks.length - n7} 查词事件 +${lookups7b - lookups7}`,
  );
  await askBtn.click();
  const chips7 = await page.locator(".rf-ask-chip").allInnerTexts();
  check(
    "7b 「问 AI」里有「这个词在这句里什么意思」，没有「只讲这个词，不讲整句」",
    chips7.includes("这个词在这句里什么意思") && !chips7.some((c) => c.includes("只讲这个词")),
    chips7.join(" / "),
  );
  await page.locator('.rf-ask-chip:has-text("这个词在这句里什么意思")').click();
  await page.waitForTimeout(1200);
  const a7 = asks.slice(n7)[0];
  check(
    "7c 自己点了才问：请求不带「第几次」，但带上之前问过的词（只用来避免重复）",
    a7 && a7.signals?.priorAsks?.some((p) => p.selection === "database") && a7.askKind === "default",
    `prior=${JSON.stringify(a7?.signals?.priorAsks)} askKind=${a7?.askKind}`,
  );

  // ---- 8. 刷新后同句第三个词：仍然不自动问 ----
  await open();
  b = await boxOf("history");
  const n8 = asks.length;
  await page.mouse.click(b.x, b.y);
  await page.waitForTimeout(1500);
  check("8 刷新后同句第三个词、词典查得到：仍然不调模型", asks.length === n8, `新请求=${asks.length - n8}`);

  // ---- 9. 词典查不到的短语：照旧自动问（不然右栏是空的） ----
  await page.keyboard.press("Escape");
  const from = await boxOf("skill");
  const to = await boxOf("database");
  const n9 = asks.length;
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(1500);
  const a9 = asks.slice(n9)[0];
  check("9 拖选短语（词典没有）：自动问 AI", a9?.word === "skill database" && a9.askKind === "auto", `word=${a9?.word} askKind=${a9?.askKind}`);

  await browser.close();
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  rmSync(TMP, { recursive: true, force: true });
}
log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
