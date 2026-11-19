/**
 * P44 端到端：阅读页右栏对话式（底部输入区 + 快捷问题 + 靠右的用户气泡 + 做卡状态块）。
 * 隔离库 + 端口 3162（假模型 3163）；做卡接口在浏览器里拦截模拟，不调真模型。
 * 截图写到 .verify/p44/shots/。需要先 npm run build。
 *   node scripts/e2e-chat-panel.mjs
 */
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3162, MODEL = 3163;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "chat-panel");
const SHOTS = path.join(ROOT, ".verify", "p44", "shots");
const DB = path.join(TMP, "readflow.db");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };

// 假模型：「例句」那条慢一点（用来测「回答期间快捷问题暂停」和「往上翻时不抢滚动」）
const model = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const slow = /讲讲句子结构/.test(b);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (t) => res.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: t }, finish_reason: null }] })}\n\n`);
    const end = () => { res.write(`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`); res.write("data: [DONE]\n\n"); res.end(); };
    chunk("释义：测试讲解。\n");
    if (slow) { setTimeout(() => { chunk("这是一段较长的回答。\n".repeat(30)); end(); }, 1500); }
    else { chunk("这是一段回答。\n".repeat(8)); end(); }
  });
});
await new Promise((r) => model.listen(MODEL, "127.0.0.1", r));

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
  const setup = await fetch(`${BASE}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "chat_owner", password: "chat-owner-2026", phone: "13800138044" }) });
  const cookie = setup.headers.get("set-cookie").match(/readflow_session=([^;]+)/)[1];
  await api("/api/settings", { cookie, method: "PUT", body: { activeProvider: "custom", providers: { custom: { apiKey: "k", model: "m", baseUrl: `http://127.0.0.1:${MODEL}/v1` } } } });
  const t = await api("/api/texts", { cookie, method: "POST", body: { title: "Chat text", text: "The skill database tracks the history of previous skills and context functions. A meta-level agent performs agentic crossover over prior skills to create a new skill given a task." } });
  const textId = t.data.id ?? t.data.textId;

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();

  // 做卡接口模拟：第 1 次生成失败，第 2 次成功
  let gens = 0, seen = 0;
  await page.route("**/api/cards/generate", async (route) => { gens++; seen = 0; await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, setId: `set-${gens}` }) }); });
  await page.route("**/api/cards/state*", async (route) => {
    let body = { enabled: true, state: "none", setId: null, count: 0, error: null, wordId: null };
    if (gens > 0) {
      seen++;
      body = seen <= 2 ? { enabled: true, state: "generating", setId: `set-${gens}`, count: 0, error: null, wordId: null }
        : gens === 1 ? { enabled: true, state: "failed", setId: "set-1", count: 0, error: "模型没有返回合法的 JSON", wordId: null }
        : { enabled: true, state: "ready", setId: `set-${gens}`, count: 3, error: null, wordId: "w-chat" };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(`${BASE}/texts/${textId}`, { waitUntil: "networkidle" });
  await page.locator(".w", { hasText: /^database$/ }).first().click();
  await page.locator(".rf-composer").waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);

  // ===== 版面 =====
  const chips = await page.locator(".rf-quick-chip").allInnerTexts();
  check("C1 底部输入区：快捷问题直接可见（不用展开），含「整句没看懂」和「做成卡片」", chips.includes("整句没看懂") && chips.includes("做成卡片") && chips.includes("这个词在这句里什么意思"), chips.join(" / "));
  const lay = await page.evaluate(() => {
    const a = document.querySelector(".reader-aside").getBoundingClientRect();
    const c = document.querySelector(".rf-composer").getBoundingClientRect();
    return { gap: Math.round(a.bottom - c.bottom), inView: c.bottom <= innerHeight };
  });
  check("C2 输入区固定在右栏底部、在可视区域内", lay.gap <= 8 && lay.inView, JSON.stringify(lay));
  await page.locator(".rf-composer-input").fill("abc");
  const hidden = (await page.locator(".rf-quick").count()) === 0;
  await page.locator(".rf-composer-input").fill("");
  check("C3 开始输入时快捷问题收起，清空后重新出现", hidden && (await page.locator(".rf-quick").count()) === 1);

  // ===== 词典区 =====
  const en = page.locator(".rf-en-def-text");
  check("C4 英文释义默认展开（直接可见、不是折叠项）", (await en.count()) === 1 && (await en.isVisible()) && (await page.locator("details", { hasText: "英文释义" }).count()) === 0);
  const order = await page.evaluate(() => {
    const def = document.querySelector(".rf-en-def"), anc = document.querySelector(".rf-anchor");
    const log = document.querySelector(".rf-chat-log");
    return { after: Boolean(def.compareDocumentPosition(anc) & Node.DOCUMENT_POSITION_FOLLOWING), collapsed: !anc.open, lastInLog: log.lastElementChild === anc };
  });
  check("C5 「上下文锚点」紧跟在英文释义下面（不在最底部），默认收起", order.after && order.collapsed, JSON.stringify(order));
  const stray = await page.locator(".rf-chat-log button", { hasText: /追问|问 AI|AI 释义|整句没看懂|做成卡片/ }).count();
  check("C6 对话区里没有独立的 AI 操作按钮（都在输入区）", stray === 0, `数量=${stray}`);
  const titleBtns = await page.evaluate(() => [...document.querySelectorAll(".rf-chat-log > div:first-child button")].map((x) => x.getAttribute("aria-label") || x.textContent.trim()).filter((x) => x !== "发音"));
  check("C7 右栏标题行只剩「取消记录」", titleBtns.join("|") === "取消记录", titleBtns.join("|"));
  await page.screenshot({ path: path.join(SHOTS, "chat-initial-1440.png") });

  // ===== 对话 =====
  await page.getByRole("button", { name: "这个词在这句里什么意思" }).click();
  await page.locator(".rf-ai-reply .rf-feedback-row").waitFor({ timeout: 15000 });
  check("C8 首次讲解：没有用户气泡，下面有「这次讲得」反馈", (await page.locator(".rf-bubble-user").count()) === 0 && (await page.locator(".rf-feedback-row").count()) === 1);
  await page.getByRole("button", { name: "再给个例句" }).click();
  await page.locator(".rf-bubble-user", { hasText: "再给个例句" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".rf-ai-reply").length === 2 && !document.querySelector(".rf-chat-status"), null, { timeout: 15000 });
  check("C9 追问：右边用户气泡 + 左边回答；追问的回答下面没有反馈（只有首次讲解有）", (await page.locator(".rf-feedback-row").count()) === 1);
  const g = await page.evaluate(() => {
    const logR = document.querySelector(".rf-chat-log").getBoundingClientRect();
    const b = document.querySelector(".rf-bubble-user"), r = document.querySelectorAll(".rf-ai-reply")[1];
    return { bubbleRight: Math.round(logR.right - b.getBoundingClientRect().right), bubbleBg: getComputedStyle(b).backgroundColor, replyBg: getComputedStyle(r).backgroundColor, replyW: Math.round(r.getBoundingClientRect().width), logW: Math.round(logR.width) };
  });
  check("C10 用户气泡靠右、浅灰底；AI 回答无底色、满宽", g.bubbleRight <= 12 && g.bubbleBg !== "rgba(0, 0, 0, 0)" && g.replyBg === "rgba(0, 0, 0, 0)" && g.replyW >= g.logW - 12, JSON.stringify(g));

  // 回答期间：快捷问题和发送暂停；往上翻时不抢滚动
  await page.getByRole("button", { name: "讲讲句子结构" }).click();
  await page.locator(".rf-chat-status").waitFor({ timeout: 5000 });
  const dis = await page.evaluate(() => [...document.querySelectorAll(".rf-quick-chip")].every((b) => b.disabled));
  check("C11 AI 回答期间快捷问题全部暂停", dis);
  await page.evaluate(() => { document.querySelector(".rf-chat-log").scrollTop = 0; });
  await page.waitForFunction(() => !document.querySelector(".rf-chat-status"), null, { timeout: 15000 });
  const top = await page.evaluate(() => document.querySelector(".rf-chat-log").scrollTop);
  check("C12 用户往上翻时，新内容不抢滚动", top < 60, `scrollTop=${top}`);
  await page.locator(".rf-composer-input").fill("为什么用 tracks？");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".rf-ai-reply").length === 4 && !document.querySelector(".rf-chat-status"), null, { timeout: 15000 });
  const bottom = await page.evaluate(() => { const l = document.querySelector(".rf-chat-log"); return { over: l.scrollHeight > l.clientHeight, atBottom: l.scrollHeight - l.scrollTop - l.clientHeight < 8 }; });
  check("C13 自己发消息后停在底部（对话溢出时输入区仍在原处）", bottom.over && bottom.atBottom, JSON.stringify(bottom));
  await page.screenshot({ path: path.join(SHOTS, "chat-thread-1440.png") });

  // ===== 做成卡片：像一次工具调用 =====
  await page.getByRole("button", { name: "做成卡片" }).click();
  await page.locator('.rf-run-block[data-state="generating"]').waitFor({ timeout: 5000 });
  check("C14 点「做成卡片」：右边出现用户消息，左边出现进行中的状态块", (await page.locator(".rf-bubble-user").last().innerText()) === "做成卡片" && (await page.locator(".rf-run-block .rf-progress-ring").count()) === 1);
  const failed = page.locator('.rf-run-block[data-state="failed"]');
  await failed.waitFor({ timeout: 20000 });
  check("C15 失败：原因留在对话里，有「重试」", /做卡失败：模型没有返回合法的 JSON/.test(await failed.innerText()) && (await failed.getByRole("button", { name: "重试" }).count()) === 1);
  await page.screenshot({ path: path.join(SHOTS, "chat-card-failed-1440.png") });
  await failed.getByRole("button", { name: "重试" }).click();
  await page.locator('.rf-run-block[data-state="generating"]').waitFor({ timeout: 5000 });
  const ready = page.locator('.rf-run-block[data-state="ready"]');
  await ready.waitFor({ timeout: 20000 });
  check("C16 重试后成功：「已做成 3 张卡 · 查看」，新标签页打开", (await ready.innerText()).includes("已做成 3 张卡") && (await ready.getByRole("link").getAttribute("target")) === "_blank");
  check("C17 做完后「做成卡片」快捷项消失（状态块里有「再做一组」）", !(await page.locator(".rf-quick-chip").allInnerTexts()).includes("做成卡片") && (await ready.getByRole("button", { name: "再做一组" }).count()) === 1);
  await page.getByRole("button", { name: "整句没看懂" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".rf-ai-reply").length === 6 && !document.querySelector(".rf-chat-status"), null, { timeout: 15000 });
  const seq = await page.evaluate(() => [...document.querySelectorAll(".rf-chat-turns .rf-bubble-user")].map((b) => b.textContent));
  check("C18 做卡之后再追问：状态块留在原位，新追问接在后面", seq.join("|") === "再给个例句|讲讲句子结构|为什么用 tracks？|做成卡片|整句没看懂", seq.join("|"));
  await page.screenshot({ path: path.join(SHOTS, "chat-card-ready-1440.png") });

  // ===== 回看：对话串、做卡状态都能还原 =====
  await page.keyboard.press("Escape");
  await page.locator(".w", { hasText: /^database$/ }).first().click();
  await page.locator(".rf-composer").waitFor();
  await page.waitForTimeout(1500);
  const re = await page.evaluate(() => ({ bubbles: document.querySelectorAll(".rf-bubble-user").length, block: document.querySelector(".rf-run-block")?.getAttribute("data-state") }));
  check("C19 回看：追问都在，做卡状态块也恢复（放在对话最后）", re.bubbles === 5 && re.block === "ready", JSON.stringify(re));

  // ===== 窄屏：不要求手机体验，只保证不横向溢出 =====
  await page.setViewportSize({ width: 768, height: 900 });
  await page.waitForTimeout(400);
  check("C20 768px 页面无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  check("C21 服务端日志没有异常", !/unhandled|TypeError|ReferenceError/i.test(log));
} catch (e) { fail++; console.log("FAIL  脚本异常:", e?.stack ?? e); }
finally {
  await browser?.close();
  server.kill("SIGTERM"); model.close();
  console.log(`\n${pass} passed, ${fail} failed  截图：${SHOTS}`);
  process.exit(fail ? 1 : 0);
}
