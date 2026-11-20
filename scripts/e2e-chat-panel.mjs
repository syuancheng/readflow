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
    const sug = /为什么用/.test(b); // 自己提的那个问题的回答末尾带制卡建议
    if (sug) { chunk("这是一段回答。\n"); chunk("制卡建议：技术文档高频词，与 generalization 同源，值得放在一起记，别和名词混了"); end(); return; }
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

  // 常用问题在输入框左边「＋」菜单里：点「＋」→ 选一项
  const ask = async (label) => {
    await page.locator(".rf-composer-plus").click();
    await page.locator(".rf-menu-item", { hasText: new RegExp(`^${label}$`) }).click();
  };

  await page.goto(`${BASE}/texts/${textId}`, { waitUntil: "networkidle" });
  await page.locator(".w", { hasText: /^database$/ }).first().click();
  await page.locator(".rf-composer").waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);

  // ===== 版面 =====
  check("C1 输入区是一个圆角容器：左「＋」、中输入框；没有输入时右边没有发送按钮，也没有语音按钮", (await page.locator(".rf-composer-plus").count()) === 1 && (await page.locator(".rf-composer-send").count()) === 0 && (await page.locator(".rf-quick").count()) === 0);
  await page.locator(".rf-composer-plus").click();
  const chips = await page.locator(".rf-menu-item").allInnerTexts();
  check("C1b 点「＋」展开常用问题：含「这个词在这句里什么意思」「整句没看懂」「做成卡片」，底部是一个提示词为「添加常用问题」的输入框（没有多余的说明和大按钮）", ["这个词在这句里什么意思", "整句没看懂", "做成卡片"].every((x) => chips.includes(x)) && (await page.locator(".rf-menu-input").getAttribute("placeholder")) === "添加常用问题" && (await page.locator(".rf-menu-empty, .rf-menu-save, .rf-menu-addbtn").count()) === 0, chips.join(" / "));
  const menuBox = await page.evaluate(() => { const m = document.querySelector(".rf-menu").getBoundingClientRect(), c = document.querySelector(".rf-composer").getBoundingClientRect(); return { w: Math.round(m.width), cw: Math.round(c.width), row: Math.round(document.querySelector(".rf-menu-item").getBoundingClientRect().height) }; });
  check("C1e 菜单里没有「我的常用问题」小标题", (await page.locator(".rf-menu-title").count()) === 0 && !(await page.locator(".rf-menu").innerText()).includes("我的常用问题"));
  check("C1d 菜单窄而紧凑：宽度 ≤ 288px 且比输入区窄，每行高度 ≤ 32px", menuBox.w <= 288 && menuBox.w < menuBox.cw && menuBox.row <= 32, JSON.stringify(menuBox));
  await page.screenshot({ path: path.join(SHOTS, "chat-menu-1440.png") });
  await page.keyboard.press("Escape");
  check("C1c 按 Esc 收起菜单", (await page.locator(".rf-menu").count()) === 0);
  const line = await page.evaluate(() => getComputedStyle(document.querySelector(".rf-composer")).borderTopWidth);
  const shape = await page.evaluate(() => ({ box: getComputedStyle(document.querySelector(".rf-composer-box")).borderTopLeftRadius, plus: getComputedStyle(document.querySelector(".rf-composer-plus")).borderTopLeftRadius }));
  check("C2b 输入框是方一点的圆角（12px），里面的按钮 8px，不再是胶囊形", shape.box === "12px" && shape.plus === "8px", JSON.stringify(shape));
  check("C2a 输入框上面没有多余的横线", line === "0px", line);
  const lay = await page.evaluate(() => {
    const a = document.querySelector(".reader-aside").getBoundingClientRect();
    const c = document.querySelector(".rf-composer").getBoundingClientRect();
    return { gap: Math.round(a.bottom - c.bottom), inView: c.bottom <= innerHeight };
  });
  check("C2 输入区固定在右栏底部、在可视区域内", lay.gap <= 24 && lay.inView, JSON.stringify(lay));
  await page.locator(".rf-composer-input").fill("abc");
  const sendShown = (await page.locator(".rf-composer-send").count()) === 1;
  const sbox = await page.evaluate(() => { const b = document.querySelector(".rf-composer-box").getBoundingClientRect(), x = document.querySelector(".rf-composer-send").getBoundingClientRect(); return { right: Math.round(b.right - x.right), mid: Math.abs((b.top + b.bottom) / 2 - (x.top + x.bottom) / 2) }; });
  await page.locator(".rf-composer-input").fill("");
  check("C3 输入文字后右边出现圆形发送按钮（贴右边内侧、单行时垂直居中），清空后消失", sendShown && sbox.right <= 8 && sbox.mid <= 2 && (await page.locator(".rf-composer-send").count()) === 0, JSON.stringify(sbox));

  // ===== 词典区 =====
  check("C4 词典区没有英文释义（已去掉）", (await page.locator(".rf-en-def, .rf-en-def-text").count()) === 0 && !(await page.locator(".rf-chat-log").innerText()).includes("英文释义"));
  const order = await page.evaluate(() => {
    const anc = document.querySelector(".rf-anchor");
    const prev = anc.previousElementSibling;
    return { afterDict: Boolean(prev && /数据库/.test(prev.textContent || "")), collapsed: !anc.open };
  });
  check("C5 「上下文锚点」紧跟在词典释义下面（不在最底部），默认收起", order.afterDict && order.collapsed, JSON.stringify(order));
  const stray = await page.locator(".rf-chat-log button", { hasText: /追问|问 AI|AI 释义|整句没看懂|做成卡片/ }).count();
  check("C6 对话区里没有独立的 AI 操作按钮（都在输入区）", stray === 0, `数量=${stray}`);
  const titleBtns = await page.evaluate(() => [...document.querySelectorAll(".rf-chat-log > div:first-child button")].map((x) => x.getAttribute("aria-label") || x.textContent.trim()).filter((x) => x !== "发音" && !/^\//.test(x)));
  check("C7 右栏标题行只剩「取消记录」", titleBtns.join("|") === "取消记录", titleBtns.join("|"));
  await page.screenshot({ path: path.join(SHOTS, "chat-initial-1440.png") });

  // ===== 对话 =====
  await ask("这个词在这句里什么意思");
  await page.locator(".rf-ai-reply .rf-feedback-row").waitFor({ timeout: 15000 });
  const b1 = await page.locator(".rf-bubble-user").allInnerTexts();
  check("C8 手动点「这个词在这句里什么意思」：右边也出现这句话（不能只出现回答），下面有「这次讲得」反馈", b1.join("|") === "这个词在这句里什么意思" && (await page.locator(".rf-feedback-row").count()) === 1, b1.join("|"));
  await ask("再给个例句");
  await page.locator(".rf-bubble-user", { hasText: "再给个例句" }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll(".rf-ai-reply").length === 2 && !document.querySelector(".rf-chat-status"), null, { timeout: 15000 });
  check("C9 追问：右边用户气泡 + 左边回答；追问的回答下面没有反馈（只有首次讲解有）", (await page.locator(".rf-feedback-row").count()) === 1);
  check("C9b 对话还短（2 轮）时没有「已压缩」提示；输入框限制 500 字", (await page.locator(".rf-compress-note").count()) === 0 && (await page.locator(".rf-composer-input").getAttribute("maxlength")) === "500");
  const g = await page.evaluate(() => {
    const logR = document.querySelector(".rf-chat-log").getBoundingClientRect();
    const b = document.querySelector(".rf-bubble-user"), r = document.querySelectorAll(".rf-ai-reply")[1];
    return { bubbleRight: Math.round(logR.right - b.getBoundingClientRect().right), bubbleBg: getComputedStyle(b).backgroundColor, replyBg: getComputedStyle(r).backgroundColor, replyW: Math.round(r.getBoundingClientRect().width), logW: Math.round(logR.width) };
  });
  check("C10 用户气泡靠右、浅灰底；AI 回答无底色、满宽", g.bubbleRight <= 20 && g.bubbleBg !== "rgba(0, 0, 0, 0)" && g.replyBg === "rgba(0, 0, 0, 0)" && g.replyW >= g.logW - 24, JSON.stringify(g));

  // 回答期间：快捷问题和发送暂停；往上翻时不抢滚动
  await ask("讲讲句子结构");
  await page.locator(".rf-chat-status").waitFor({ timeout: 5000 });
  await page.locator(".rf-composer-plus").click();
  const dis = await page.evaluate(() => [...document.querySelectorAll(".rf-menu-group:first-child .rf-menu-item")].every((b) => b.disabled));
  await page.keyboard.press("Escape");
  check("C11 AI 回答期间菜单里的问题全部暂停", dis);
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

  // ===== 制卡建议：这条回答末尾的一张带按钮的小卡片 =====
  const sugCard = page.locator(".rf-suggest-card");
  const answerText = await page.locator(".rf-ai-reply").last().locator(".rf-md").innerText();
  const sug = await sugCard.evaluate((e) => ({ inLast: e.closest(".rf-ai-reply") === [...document.querySelectorAll(".rf-ai-reply")].at(-1), afterBody: Boolean(e.previousElementSibling?.classList.contains("rf-md")), primaryBg: getComputedStyle(e.querySelector(".rf-btn-solid")).backgroundColor, buttons: [...e.querySelectorAll("button")].map((b) => b.textContent) }));
  check("C13b 制卡建议是这条回答末尾的小卡片，有明确的两个按钮：实心「做成卡片」+ 描边「暂不需要」；理由完整显示", (await sugCard.count()) === 1 && sug.inLast && sug.afterBody && sug.buttons.join("|") === "做成卡片|暂不需要" && sug.primaryBg !== "rgba(0, 0, 0, 0)" && (await sugCard.innerText()).includes("别和名词混了"), JSON.stringify(sug));
  check("C13c 正文里没有「制卡建议」那一行", !answerText.includes("制卡建议"), answerText.slice(0, 40));
  await page.screenshot({ path: path.join(SHOTS, "chat-suggest-1440.png") });
  await sugCard.getByRole("button", { name: "暂不需要" }).click();
  check("C13d 点「暂不需要」：这张建议卡片消失", (await page.locator(".rf-suggest-card").count()) === 0);
  await page.locator(".rf-composer-input").fill("为什么用 skills？");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".rf-ai-reply").length === 5 && !document.querySelector(".rf-chat-status"), null, { timeout: 15000 });
  await page.locator(".rf-suggest-card").waitFor({ timeout: 5000 });

  // ===== 做成卡片：像一次工具调用 =====
  await page.locator(".rf-suggest-card .rf-btn-solid").click();
  await page.locator('.rf-run-block[data-state="generating"]').waitFor({ timeout: 5000 });
  check("C14a 开始做卡后建议卡片消失", (await page.locator(".rf-suggest-card").count()) === 0);
  check("C14 点建议里的「做成卡片」：右边出现用户消息，左边出现进行中的状态块", (await page.locator(".rf-bubble-user").last().innerText()) === "做成卡片" && (await page.locator(".rf-run-block .rf-progress-ring").count()) === 1);
  const failed = page.locator('.rf-run-block[data-state="failed"]');
  await failed.waitFor({ timeout: 20000 });
  check("C15 失败：原因留在对话里，有「重试」", /做卡失败：模型没有返回合法的 JSON/.test(await failed.innerText()) && (await failed.getByRole("button", { name: "重试" }).count()) === 1);
  await page.screenshot({ path: path.join(SHOTS, "chat-card-failed-1440.png") });
  await failed.getByRole("button", { name: "重试" }).click();
  await page.locator('.rf-run-block[data-state="generating"]').waitFor({ timeout: 5000 });
  const ready = page.locator('.rf-run-block[data-state="ready"]');
  await ready.waitFor({ timeout: 20000 });
  check("C16 重试后成功：「已做成 3 张卡 · 查看」，新标签页打开", (await ready.innerText()).includes("已做成 3 张卡") && (await ready.getByRole("link").getAttribute("target")) === "_blank");
  await page.locator(".rf-composer-plus").click();
  const afterItems = await page.locator(".rf-menu-item").allInnerTexts();
  await page.keyboard.press("Escape");
  check("C17 做完后菜单里的「做成卡片」消失，状态块里没有「再做一组」", !afterItems.includes("做成卡片") && (await ready.getByRole("button").count()) === 0, afterItems.join(" / "));
  await ask("整句没看懂");
  await page.waitForFunction(() => document.querySelectorAll(".rf-ai-reply").length === 7 && !document.querySelector(".rf-chat-status"), null, { timeout: 15000 });
  const seq = await page.evaluate(() => [...document.querySelectorAll(".rf-chat-turns .rf-bubble-user")].map((b) => b.textContent));
  check("C18 做卡之后再追问：状态块留在原位，新追问接在后面", seq.join("|") === "这个词在这句里什么意思|再给个例句|讲讲句子结构|为什么用 tracks？|为什么用 skills？|做成卡片|整句没看懂", seq.join("|"));
  // 引用 AI 回答里的一段话再提问：气泡里是 Claude Code 式的左竖线引用，不是带「AI」方块的卡片
  await page.evaluate(() => {
    const md = [...document.querySelectorAll(".rf-ai-reply .rf-md")].at(-1);
    const range = document.createRange();
    range.selectNodeContents(md);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    md.closest(".rf-ai-reply").dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await page.locator(".rf-selection-ask-btn").click();
  await page.locator(".rf-composer-input").fill("这一段是什么意思？");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => document.querySelectorAll(".rf-ai-reply").length === 8 && !document.querySelector(".rf-chat-status"), null, { timeout: 15000 });
  const qb = await page.evaluate(() => {
    const bubble = [...document.querySelectorAll(".rf-chat-turns .rf-bubble-user")].at(-1);
    const q = bubble.querySelector(".rf-bubble-quote");
    if (!q) return null;
    const cs = getComputedStyle(q);
    const root = getComputedStyle(document.documentElement);
    return {
      text: q.textContent.trim().slice(0, 12),
      borderLeft: cs.borderLeftWidth,
      borderColor: cs.borderLeftColor,
      weight: cs.fontWeight,
      color: cs.color,
      noBadge: !bubble.querySelector(".rf-bubble-quote-badge") && !/Selected Text/.test(bubble.textContent),
      height: Math.round(q.getBoundingClientRect().height),
      question: bubble.textContent.includes("这一段是什么意思？"),
    };
  });
  check("C36 引用 AI 回答里的话再提问：气泡里是带左竖线的引用（3px、次要色、非粗体），没有「AI」方块和「Selected Text」，最多两行", qb && qb.borderLeft === "3px" && Number(qb.weight) <= 400 && qb.noBadge && qb.question && qb.height <= 50, JSON.stringify(qb));
  const note = await page.evaluate(() => {
    const n = document.querySelector(".rf-compress-note");
    const replies = [...document.querySelectorAll(".rf-chat-turns .rf-ai-reply")];
    const firstReply = replies[0], third = replies.at(-3);
    return { count: document.querySelectorAll(".rf-compress-note").length, text: n?.textContent ?? "", afterFirst: Boolean(n && firstReply && (firstReply.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING)), beforeRecent: Boolean(n && third && (n.compareDocumentPosition(third) & Node.DOCUMENT_POSITION_FOLLOWING)) };
  });
  check("C18b 对话超过「首次讲解 + 最近 3 轮」后出现一行提示：更早的对话已压缩，位置在首次讲解之后、最近几轮之前", note.count === 1 && /已压缩/.test(note.text) && note.afterFirst && note.beforeRecent, JSON.stringify(note));
  await page.screenshot({ path: path.join(SHOTS, "chat-card-ready-1440.png") });

  // ===== 我的常用问题：添加、使用、刷新后还在、删除 =====
  await page.locator(".rf-composer-plus").click();
  await page.locator(".rf-menu-input").fill("有什么近义词？");
  await page.getByRole("button", { name: "保存常用问题" }).click();
  await page.locator(".rf-menu-row", { hasText: "有什么近义词？" }).waitFor({ timeout: 5000 });
  check("C20a0 点输入框右边的勾保存：出现在列表里，输入框清空", (await page.locator(".rf-menu-input").inputValue()) === "");
  await page.locator(".rf-menu-del").click();
  await page.waitForTimeout(300);
  await page.locator(".rf-menu-input").fill("有什么近义词？");
  await page.keyboard.press("Enter");
  await page.locator(".rf-menu-row", { hasText: "有什么近义词？" }).waitFor({ timeout: 5000 });
  await page.locator(".rf-menu-input").fill("有什么近义词？");
  await page.keyboard.press("Enter");
  const dupErr = await page.locator(".rf-menu-error").innerText();
  check("C20a 常用问题：能添加；重复添加给出提示", /已经在常用问题里/.test(dupErr), dupErr);
  await page.screenshot({ path: path.join(SHOTS, "chat-menu-custom-1440.png") });
  await page.locator(".rf-menu-row .rf-menu-item", { hasText: "有什么近义词？" }).click();
  await page.waitForFunction(() => [...document.querySelectorAll(".rf-bubble-user")].at(-1)?.textContent === "有什么近义词？" && !document.querySelector(".rf-chat-status"), null, { timeout: 15000 });
  check("C20b 点自己的常用问题：和手打一样，右边出现这句话、AI 回答", true);
  const saved = await api("/api/quick-questions", { cookie });
  check("C20c 常用问题存在服务器（按账号）", saved.data?.items?.length === 1 && saved.data.items[0].text === "有什么近义词？", JSON.stringify(saved.data));
  await page.locator(".rf-composer-plus").click();
  await page.getByRole("button", { name: /删除常用问题：有什么近义词/ }).click();
  await page.waitForTimeout(400);
  const after = await api("/api/quick-questions", { cookie });
  check("C20d 删除后列表和服务器都没有了", (await page.locator(".rf-menu-row").count()) === 0 && after.data?.items?.length === 0);
  await page.keyboard.press("Escape");
  const anon = await fetch(`${BASE}/api/quick-questions`);
  check("C20e 没登录读不到常用问题（401）", anon.status === 401);

  // ===== 回看：对话串、做卡状态都能还原 =====
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const bx = await page.evaluate(() => { const r = [...document.querySelectorAll(".reading-body .w")].find((e) => e.textContent === "database").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(bx.x, bx.y);
  await page.locator(".rf-composer").waitFor();
  await page.waitForTimeout(1500);
  const re = await page.evaluate(() => ({ bubbles: document.querySelectorAll(".rf-bubble-user").length, block: document.querySelector(".rf-run-block")?.getAttribute("data-state") }));
  check("C19 回看：首次讲解的默认问题、追问都在，做卡状态块也恢复（放在对话最后）", re.bubbles === 9 && re.block === "ready", JSON.stringify(re));

  // ===== 自动触发的回答（词典查不到的短语）：右边同样有一条用户问题 =====
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const pts = await page.evaluate(() => { const w = [...document.querySelectorAll(".reading-body .w")]; const r = (t) => { const b = w.find((e) => e.textContent === t).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; }; return { a: r("skill"), b: r("history") }; });
  await page.mouse.move(pts.a.x, pts.a.y); await page.mouse.down(); await page.mouse.move(pts.b.x, pts.b.y, { steps: 6 }); await page.mouse.up();
  await page.waitForFunction(() => document.querySelectorAll(".rf-ai-reply").length >= 1 && !document.querySelector(".rf-chat-status"), null, { timeout: 15000 });
  const autoBubbles = await page.locator(".rf-bubble-user").allInnerTexts();
  check("C22 自动触发的回答（拖选短语，词典没有）：右边也有统一的用户问题", autoBubbles[0] === "这个短语在这句里什么意思" && (await page.locator(".rf-ai-reply").count()) >= 1, autoBubbles.join("|"));
  await page.screenshot({ path: path.join(SHOTS, "chat-auto-1440.png") });

  // ===== 双栏各自滚动：正文的滚动条在两栏之间，AI 栏的滚动条在窗口最右边 =====
  const longBody = Array.from({ length: 40 }, (_, i) => `Paragraph ${i + 1} talks about database tracks and skills over time, with enough words to wrap onto several lines in the article column.`).join("\n\n");
  const lt = await api("/api/texts", { cookie, method: "POST", body: { title: "Long text", text: longBody } });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${BASE}/texts/${lt.data.id ?? lt.data.textId}`, { waitUntil: "networkidle" });
  const pane = await page.evaluate(() => {
    const m = document.querySelector(".reader-main"), a = document.querySelector(".reader-aside");
    return {
      pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      mainScrolls: getComputedStyle(m).overflowY === "auto" && m.scrollHeight > m.clientHeight,
      mainBar: m.offsetWidth - m.clientWidth,
      asideRightGap: Math.round(innerWidth - a.getBoundingClientRect().right),
      mainRight: Math.round(m.getBoundingClientRect().right), asideLeft: Math.round(a.getBoundingClientRect().left),
    };
  });
  check("C23 宽屏双栏：整页不滚动，正文自己是滚动区，AI 栏贴到窗口最右边，两栏紧挨着（中间没有空档）", !pane.pageScrolls && pane.mainScrolls && pane.asideRightGap <= 1 && Math.abs(pane.asideLeft - pane.mainRight) <= 1, JSON.stringify(pane));
  const card = await page.evaluate(() => { const c = getComputedStyle(document.querySelector(".reader-article-card")); return { b: c.borderTopWidth, shadow: c.boxShadow }; });
  check("C23a 宽屏下正文外面没有卡片框（只剩两栏之间一条分隔线）", card.b === "0px" && card.shadow === "none", JSON.stringify(card));
  const sb = await page.evaluate(() => ({ html: getComputedStyle(document.documentElement, "::-webkit-scrollbar").width, main: getComputedStyle(document.querySelector(".reader-main"), "::-webkit-scrollbar").width, aside: getComputedStyle(document.querySelector(".reader-aside"), "::-webkit-scrollbar").width }));
  check("C23b 全站滚动条统一做窄（6px）：整页、正文栏、AI 栏都一样", sb.html === "6px" && sb.main === "6px" && sb.aside === "6px", JSON.stringify(sb));
  await page.evaluate(() => { const m = document.querySelector(".reader-main"); m.scrollTo({ top: m.scrollHeight }); });
  await page.waitForTimeout(900);
  const prog = await page.evaluate(() => parseFloat(document.querySelector(".rf-tb-progress i").style.width));
  check("C23c 正文滚到底：顶栏读进度走到 100%（读进度跟着正文滚动区走）", prog >= 99, `进度=${prog}`);
  await page.evaluate(() => { document.querySelector(".reader-main").scrollTo({ top: 0 }); });
  await page.waitForTimeout(700);
  const prog0 = await page.evaluate(() => parseFloat(document.querySelector(".rf-tb-progress i").style.width));
  check("C23d 滚回顶部：读进度回到 0", prog0 <= 1, `进度=${prog0}`);
  await page.screenshot({ path: path.join(SHOTS, "chat-panes-1440.png") });
  // ===== 回到顶部（阅读页宽屏：挂在正文栏里） =====
  check("C26a 还在顶部时没有回到顶部按钮", (await page.locator(".rf-totop").count()) === 0);
  await page.evaluate(() => document.querySelector(".reader-main").scrollTo({ top: 900 }));
  await page.locator(".rf-totop-in").waitFor({ timeout: 3000 });
  await page.screenshot({ path: path.join(SHOTS, "chat-totop-1440.png") });
  const inMain = await page.evaluate(() => Boolean(document.querySelector(".rf-totop-in")?.closest(".reader-main")));
  // 按钮整个在正文右侧的空白里，不压在文章上
  const clear = await page.evaluate(() => {
    const b = document.querySelector(".rf-totop-in").getBoundingClientRect();
    const rects = [...document.querySelectorAll(".reader-main .reading-body, .reader-main pre, .reader-main p, .reader-main table")].map((e) => e.getBoundingClientRect());
    const maxRight = Math.max(...rects.map((r) => r.right));
    const sc = document.querySelector(".reader-main").getBoundingClientRect();
    return { btnLeft: b.left, contentRight: maxRight, btnRight: b.right, scrollerRight: sc.right };
  });
  check("C26c 回到顶部按钮不压在文章上（按钮左边缘在正文最右边缘之右），也没超出正文栏", clear.btnLeft >= clear.contentRight && clear.btnRight <= clear.scrollerRight, JSON.stringify(clear));
  await page.locator(".rf-totop-in").click();
  await page.waitForFunction(() => document.querySelector(".reader-main").scrollTop < 5, null, { timeout: 5000 });
  await page.waitForTimeout(300);
  check("C26 往下滚后出现回到顶部按钮（在正文栏里，不压 AI 栏）；点一下滚回最上面，按钮消失", inMain && (await page.locator(".rf-totop").count()) === 0);
  // ===== 回到顶部（整页滚动：窄屏阅读页） =====
  await page.setViewportSize({ width: 768, height: 700 });
  await page.goto(`${BASE}/texts/${lt.data.id ?? lt.data.textId}`, { waitUntil: "networkidle" });
  await page.evaluate(() => window.scrollTo(0, 1500));
  await page.locator(".rf-totop:not(.rf-totop-in)").waitFor({ timeout: 3000 });
  const fixedPos = await page.evaluate(() => getComputedStyle(document.querySelector(".rf-totop")).position);
  await page.locator(".rf-totop").click();
  await page.waitForFunction(() => window.scrollY < 5, null, { timeout: 5000 });
  check("C27 整页滚动的页面：右下角固定的回到顶部按钮，点一下滚回最上面", fixedPos === "fixed");
  await page.setViewportSize({ width: 1440, height: 900 });

  // ===== 页脚：ICP 备案号 =====
  const footerOnReader = await page.locator(".rf-site-footer").isVisible();
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const foot = page.locator(".rf-site-footer a");
  check("C24 普通页面底部有 ICP 备案号，链接到 beian.miit.gov.cn（新标签页）；阅读页宽屏不显示页脚", (await foot.innerText()) === "陕ICP备2026034202号" && (await foot.getAttribute("href")) === "https://beian.miit.gov.cn/" && (await foot.getAttribute("target")) === "_blank" && !footerOnReader, `阅读页可见=${footerOnReader}`);
  const home = await page.evaluate(() => {
    const card = [...document.querySelectorAll(".duo-card")].find((c) => c.textContent.includes("导入文本"));
    const col = card?.parentElement;
    const cs = col ? getComputedStyle(col) : null;
    return { hasStats: document.body.innerText.includes("我的战绩"), position: cs?.position, overflowY: cs?.overflowY, pageScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1 };
  });
  check("C25 首页只留「导入文本」：没有「我的战绩」，右栏不钉住、不自己滚动（整页只有一条滚动条）", !home.hasStats && home.position === "static" && home.overflowY === "visible", JSON.stringify(home));
  await page.screenshot({ path: path.join(SHOTS, "footer-home-1440.png"), fullPage: true });

  // ===== P53：图标统一（没有彩色 emoji）、表单控件统一（不是浏览器自带的样子） =====
  const emojiRe = /\p{Emoji_Presentation}/u;
  const found = {};
  for (const [name, url] of [["首页", "/"], ["战绩", "/stats"], ["词库", "/words"], ["问卷", "/welcome"]]) {
    await page.goto(`${BASE}${url}`, { waitUntil: "networkidle" });
    found[name] = (await page.locator("body").innerText()).match(new RegExp(emojiRe.source, "gu")) ?? [];
  }
  check("C29 首页、战绩、词库、问卷里没有彩色 emoji（都是统一的线条图标）", Object.values(found).every((a) => a.length === 0), JSON.stringify(found));
  await page.goto(`${BASE}/welcome`, { waitUntil: "networkidle" });
  const ctl = await page.evaluate(() => {
    const sel = document.querySelector("select"), cb = document.querySelector("input[type=checkbox]");
    const gs = (e) => getComputedStyle(e);
    return { selAppearance: gs(sel).appearance, selArrow: gs(sel).backgroundImage.includes("svg"), cbAppearance: gs(cb).appearance, cbRadius: gs(cb).borderTopLeftRadius };
  });
  await page.locator("input[type=checkbox]").first().check();
  await page.waitForTimeout(300);
  const checkedBg = await page.evaluate(() => getComputedStyle(document.querySelector("input[type=checkbox]")).backgroundColor);
  check("C30 下拉和复选框是统一的自绘样式（去掉浏览器默认外观，选中是墨绿填充）", ctl.selAppearance === "none" && ctl.selArrow && ctl.cbAppearance === "none" && ctl.cbRadius === "4px" && checkedBg === "rgb(21, 58, 41)", JSON.stringify({ ...ctl, checkedBg }));
  await page.screenshot({ path: path.join(SHOTS, "controls-welcome.png") });

  // ===== P54：首页文本行精简、问卷版式 =====
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const rowLook = await page.evaluate(() => ({
    dots: document.querySelectorAll(".duo-level-dot").length,
    badgesInRows: document.querySelectorAll(".text-list-item .duo-badge").length,
    meta: document.querySelectorAll(".text-list-item .tl-meta").length,
    rows: document.querySelectorAll(".text-list-item").length,
  }));
  const navLine = await page.evaluate(() => getComputedStyle(document.querySelector(".duo-nav-link-active")).boxShadow);
  check("C31a 顶部导航当前页的指示条是品牌绿", navLine.includes("88, 204, 2"), navLine);
  check("C31 首页文本行：没有序号方块；来源、分类、难度、已读状态是小标签（可以有颜色）", rowLook.dots === 0 && rowLook.badgesInRows >= rowLook.rows && rowLook.meta === rowLook.rows && rowLook.rows > 0, JSON.stringify(rowLook));
  await page.goto(`${BASE}/welcome`, { waitUntil: "networkidle" });
  const wbox = await page.locator(".duo-card").first().boundingBox();
  check("C32 问卷是一个窄的居中栏（≤ 640px、左右对称），不再只占左半边", wbox && wbox.width <= 640 && Math.abs(wbox.x - (1440 - wbox.width - wbox.x)) <= 2, JSON.stringify(wbox));
  await page.screenshot({ path: path.join(SHOTS, "welcome-1440.png") });

  // ===== 头像有颜色（不是黑白灰）、原生下拉弹层是浅色 =====
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const av = await page.evaluate(() => ({ bg: getComputedStyle(document.querySelector(".pm-avatar")).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme }));
  const grays = ["rgb(60, 60, 60)", "rgb(38, 38, 38)", "rgb(107, 107, 107)", "rgb(42, 51, 38)", "rgb(28, 35, 25)"];
  check("C33 头像是有颜色的（按昵称稳定地挑一种，不是黑白灰）；页面声明浅色 color-scheme（原生下拉弹层是白的）", !grays.includes(av.bg) && /^rgb\(\d+, \d+, \d+\)$/.test(av.bg) && av.scheme === "light", JSON.stringify(av));

  // ===== 导入时可以选分类 =====
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  const ph = await page.locator('button[aria-label="文章分类"]').innerText();
  await page.locator('button[aria-label="文章分类"]').click();
  const opts = [ph, ...(await page.locator('ul[aria-label="文章分类"] button').allInnerTexts())];
  const listBg = await page.locator('ul[aria-label="文章分类"]').evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.locator('ul[aria-label="文章分类"] button', { hasText: "技术文档" }).click();
  await page.locator("textarea").first().fill("A short imported text about databases and agents, imported with a category chosen in the form.");
  await page.getByRole("button", { name: /导入并开始阅读/ }).click();
  await page.waitForURL(/\/texts\//, { timeout: 20000 });
  const imported = await api("/api/texts", { cookie });
  const mine = (imported.data?.texts ?? []).find((t) => t.title.startsWith("A short imported text"));
  check("C34 导入文本时可以选分类：下拉里第一项是提示「选择分类（可选）」、后面是预设分类，选了「技术文档」就存成「技术文档」（不再全是未分类）", opts[0] === "选择分类（可选）" && opts.includes("技术文档") && opts.some((o) => o.includes("自定义")) && listBg === "rgb(255, 255, 255)" && mine?.category === "技术文档", JSON.stringify({ opts, listBg, category: mine?.category }));

  // 自定义分类
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.locator('button[aria-label="文章分类"]').click();
  await page.locator('ul[aria-label="文章分类"] button', { hasText: "自定义" }).click();
  await page.locator('input[aria-label="自定义分类"]').fill("读书笔记");
  await page.locator("textarea").first().fill("Another imported text about custom categories and notebooks, for the custom category check.");
  await page.getByRole("button", { name: /导入并开始阅读/ }).click();
  await page.waitForURL(/\/texts\//, { timeout: 20000 });
  const imported2 = await api("/api/texts", { cookie });
  const mine2 = (imported2.data?.texts ?? []).find((t) => t.title.startsWith("Another imported text"));
  check("C35 导入时可以自定义分类：选「＋ 自定义…」输入「读书笔记」，导入后分类就是「读书笔记」", mine2?.category === "读书笔记", JSON.stringify({ category: mine2?.category }));

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
