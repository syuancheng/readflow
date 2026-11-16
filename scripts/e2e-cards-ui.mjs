/**
 * P33 阶段一·前端冒烟：待推送视图（预览 / 翻面 / 修改 / 推送栏）、设置、阅读页按钮。
 * 隔离库 + 端口 3140（假模型 3141、假墨墨 3142、假百炼 3143）；截图写到 .verify/cards-ui/，1440 / 390 各一张。
 * P35：第三张是「情景说一句」，参考说法后面有 ▶；其中一句故意合成失败（⊘ + 推送后「有 1 张卡没配上音频」）。
 *   node scripts/e2e-cards-ui.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3140, MODEL = 3141, MJ = 3142, TTS = 3143;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "cards-ui");
const DB = path.join(TMP, "readflow.db");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };

const S = "The ephemeral joy faded quickly.";
const cards = {
  cards: [
    { kind: "context_meaning", target: "t", front: [
      { t: "sentence", source: "original", text: S, mark: { start: 4, end: 13, as: "highlight" } },
      { t: "instruction", text: "ephemeral is closest in meaning to" },
      { t: "choice", options: [{ text: "brief", correct: true }, { text: "large", correct: false }, { text: "loud", correct: false }] }],
      back: { answer: [{ t: "text", text: "brief" }], explanation: [{ t: "text", text: "转瞬即逝" }] } },
    { kind: "layered_cloze", target: "t2", front: [{ t: "sentence", source: "original", text: S, mark: { start: 4, end: 13, as: "blank" } }],
      hints: [{ t: "text", text: "首字母 e" }], back: { answer: [{ t: "fill", answer: "ephemeral" }] } },
    { kind: "situation_say", target: "在场景里用 ephemeral", front: [
      { t: "text", text: "朋友说他升职后的兴奋只持续了几天。" }, { t: "instruction", text: "用 ephemeral 说一句" }],
      back: { answer: [
        { t: "sentence", source: "paraphrase", text: "His excitement turned out to be ephemeral." }, { t: "text", text: "他的兴奋原来很短暂。" },
        { t: "sentence", source: "paraphrase", text: "Fame is ephemeral, so never chase it." }, { t: "text", text: "名气转瞬即逝，别去追。" },
        { t: "sentence", source: "paraphrase", text: "That burst of joy was ephemeral." }, { t: "text", text: "那阵高兴转瞬即逝。" }] } },
    { kind: "back_translate", target: "用 ephemeral 说出原句", front: [
      { t: "text", text: "那种短暂的喜悦很快就消失了。" }, { t: "instruction", text: "用英文说出这句话" }],
      hints: [{ t: "text", text: "ephemeral" }],
      back: { answer: [{ t: "sentence", source: "original", text: S, mark: { start: 4, end: 13, as: "highlight" } }] } },
    { kind: "usage", target: "ephemeral 的常见搭配", front: [
      { t: "sentence", source: "original", text: S, mark: { start: 4, end: 13, as: "highlight" } },
      { t: "instruction", text: "它常和哪些词连用？先自己想两个" }],
      back: { answer: [
        { t: "text", text: "ephemeral pleasure" }, { t: "sentence", source: "paraphrase", text: "Ephemeral pleasures rarely satisfy us." }, { t: "text", text: "短暂的快乐很难让人满足。" },
        { t: "text", text: "ephemeral nature" }, { t: "sentence", source: "paraphrase", text: "Everyone noticed the ephemeral nature of fame." }, { t: "text", text: "大家都注意到名气转瞬即逝。" }] } },
  ],
};
// 假百炼：含 never 的句子合成失败；其余返回 1 秒静音 wav（够看到「播放中」）
const WAV = (() => {
  const n = 16000, b = Buffer.alloc(44 + n);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n, 40);
  return b;
})();
let ttsCalls = 0, ttsAuth = "";
const tts = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    if (req.method === "GET") { res.writeHead(200, { "content-type": "audio/wav" }); return res.end(WAV); }
    ttsCalls++; ttsAuth = req.headers.authorization ?? "";
    const text = JSON.parse(b || "{}").input?.text ?? "";
    res.writeHead(text.includes("never") ? 500 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(text.includes("never") ? { code: "InternalError", message: "boom" } : { output: { audio: { url: `http://127.0.0.1:${TTS}/a/${ttsCalls}.wav` } } }));
  });
});
const model = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", async () => {
    const body = JSON.parse(b || "{}");
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const p of ["释义：短暂的\n", "形容转瞬即逝。\n", "制卡建议：技术文档高频形容词，与 generalization 同源，值得放在一起记，别和名词混了"])
        res.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: p }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "stop", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`); // 真实模型都会发结束标记，缺了会被当成「中途断开」
      res.write("data: [DONE]\n\n"); return res.end();
    }
    const sys = body.messages?.[0]?.content ?? "";
    if (!sys.includes("检查一道选择题")) await new Promise((r) => setTimeout(r, 1200)); // 让「正在做卡…」能被看到
    const content = sys.includes("检查一道选择题") ? JSON.stringify({ possible: [1] }) : JSON.stringify(cards);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "f", object: "chat.completion", created: 0, model: "m", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: {} }));
  });
});
const chapters = [{ id: "ch1", name: "章节一", card_ids: [] }];
let made = 0, uploads = 0;
const pushed = [];
const mj = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    const m = req.url.split("?")[0].replace("/open/api/v1/markji", "");
    const send = (data) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ success: true, errors: [], data })); };
    if (m === "/decks") return send({ decks: [{ id: "d1", name: "测试牌组" }] });
    if (m === "/decks/d1/chapters" && req.method === "GET") return send({ chapters: chapters.map((c) => ({ ...c, deck_id: "d1" })) });
    if (m === "/files" && req.method === "POST") { uploads++; return send({ file: { id: `mkjfUi${uploads}` } }); }
    if (/cards$/.test(m) && req.method === "POST") { made++; pushed.push(JSON.parse(b).card.content); return send({ card: { id: `c${made}`, content: JSON.parse(b).card.content } }); }
    res.writeHead(404); res.end("{}");
  });
});
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, DB_PATH: DB, NODE_ENV: "production", MARKJI_BASE_URL: `http://127.0.0.1:${MJ}/open/api/v1/markji`, DASHSCOPE_API_KEY: "fake-dashscope", READFLOW_TTS_BASE_URL: `http://127.0.0.1:${TTS}`, NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
});
let log = ""; server.stdout.on("data", (d) => (log += d)); server.stderr.on("data", (d) => (log += d));
const api = async (p, { cookie, method = "GET", body } = {}) => {
  const r = await fetch(BASE + p, { method, headers: { ...(cookie ? { cookie: `readflow_session=${cookie}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let data = null; try { data = JSON.parse(t); } catch {}
  return { status: r.status, data, headers: r.headers };
};
const shots = (n) => path.join(TMP, n);
// 元素截图前先滚到视口中间，避免 390px 下被底部固定导航挡住
const shotEl = async (loc, n) => { await loc.evaluate((e) => e.scrollIntoView({ block: "center" })); await loc.screenshot({ path: shots(n) }); };
let browser;
try {
  await new Promise((r) => model.listen(MODEL, "127.0.0.1", r));
  await new Promise((r) => mj.listen(MJ, "127.0.0.1", r));
  await new Promise((r) => tts.listen(TTS, "127.0.0.1", r));
  for (let i = 0; i < 90; i++) { try { await fetch(`${BASE}/api/auth/status`); break; } catch { await new Promise((r) => setTimeout(r, 400)); } }
  const setup = await fetch(`${BASE}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "ui_owner", password: "ui-owner-2026", phone: "13800138071" }) });
  const cookie = setup.headers.get("set-cookie").match(/readflow_session=([^;]+)/)[1];
  await api("/api/settings", { cookie, method: "PUT", body: { activeProvider: "custom", providers: { custom: { apiKey: "k", model: "m", baseUrl: `http://127.0.0.1:${MODEL}/v1` } }, markjiToken: "tok" } });
  const t = await api("/api/texts", { cookie, method: "POST", body: { title: "Word list demo", text: S } });
  const textId = t.data.id ?? t.data.textId;
  const det = await api(`/api/texts/${textId}`, { cookie });
  const ctx = await api("/api/contexts/ensure", { cookie, method: "POST", body: { word: "ephemeral", textId, paragraphId: det.data.paragraphs[0].id, start: 4, end: 13, quote: "ephemeral", prefix: "The ", suffix: " joy faded quickly.", aiGloss: "释义：短暂的" } });
  const g = await api("/api/cards/generate", { cookie, method: "POST", body: { contextId: ctx.data.contextId } });
  for (let i = 0; i < 40; i++) { const s = await api(`/api/cards/sets/${g.data.setId}`, { cookie }); if (s.data?.set?.status === "ready") break; await new Promise((r) => setTimeout(r, 300)); }

  browser = await chromium.launch();
  for (const width of [1440, 390]) {
    const c = await browser.newContext({ viewport: { width, height: 900 } });
    await c.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
    const page = await c.newPage();
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

    await page.goto(`${BASE}/words?status=pending`, { waitUntil: "networkidle" });
    check(`U1 ${width}px 待推送筛选项带数量，打开 ?status=pending 直接定位`, (await page.locator(".wl-side-item-on", { hasText: "待推送" }).innerText()).includes("1"), await page.locator(".wl-side-item-on").first().innerText());
    check(`U2 ${width}px 推送栏：牌组 / 章节 / 按文章建章节 / 唯一的绿色主按钮「推送全部」`, (await page.getByRole("button", { name: /推送全部/ }).count()) === 1 && (await page.locator(".duo-btn-primary:visible").count()) === 1);
    await page.getByRole("button", { name: /ephemeral/ }).click();
    await page.locator(".cp-card").first().waitFor();
    check(`U3 ${width}px 展开词：显示 5 张卡预览，标签行含题型`, (await page.locator(".cp-card").count()) === 5 && (await page.locator(".cp-tag-kind").first().innerText()).length > 0);
    // 翻面：正面 → 看提示 → 看答案
    const layered = page.locator(".cp-card").nth(1);
    await layered.getByRole("button", { name: "看提示" }).click();
    const hint = await layered.locator(".cp-body").innerText();
    await layered.getByRole("button", { name: "看答案" }).click();
    const back = await layered.locator(".cp-body").innerText();
    check(`U4 ${width}px 分层卡翻面：提示层 → 答案`, hint.includes("首字母 e") && back.includes("ephemeral"), `${hint.slice(0, 20)} | ${back.slice(0, 30)}`);
    // P35：情景说一句 → 看答案：「🗣 参考说法」+ 说明行 + 每句英文后面一个 ▶
    const sit = page.locator(".cp-card").nth(2);
    await sit.getByRole("button", { name: "看答案" }).click();
    const playBtns = sit.locator(".rf-audio-btn");
    const sitText = await sit.locator(".cp-body").innerText();
    const geo = await sit.evaluate((card) => {
      const btns = [...card.querySelectorAll(".rf-audio-btn")].map((b) => b.getBoundingClientRect());
      const tails = [...card.querySelectorAll(".rf-say-tail")].map((t) => t.getClientRects().length);
      return { sizes: [...new Set(btns.map((r) => `${Math.round(r.width)}x${Math.round(r.height)}`))], tails };
    });
    check(`P1 ${width}px 参考说法：标题、说明行、三句英文各带一个 32×32 的 ▶，▶ 和最后一个词不分行`,
      sitText.includes("🗣 参考说法") && sitText.includes("说法不唯一") && (await playBtns.count()) === 3 &&
        JSON.stringify(geo.sizes) === '["32x32"]' && geo.tails.every((n) => n === 1) &&
        (await playBtns.first().getAttribute("aria-label")).startsWith("播放：His excitement"),
      JSON.stringify(geo));
    check(`P2 ${width}px 正面没有播放按钮（免得读出答案）`, (await page.locator(".cp-card").nth(0).locator(".rf-audio-btn").count()) === 0);
    await playBtns.first().click();
    const playing = await playBtns.first().evaluate((b) => new Promise((r) => {
      const t0 = Date.now();
      const tick = () => (b.getAttribute("aria-pressed") === "true" ? r(true) : Date.now() - t0 > 4000 ? r(false) : setTimeout(tick, 50));
      tick();
    }));
    check(`P3 ${width}px 点 ▶：变成 ■、aria-pressed=true`, playing && (await playBtns.first().innerText()).includes("■"));
    await page.screenshot({ path: shots(`p35-playing-${width}.png`), fullPage: true });
    await playBtns.nth(1).click();
    await sit.locator(".rf-audio-btn:disabled").waitFor({ timeout: 8000 }).catch(() => {});
    const failedBtn = sit.locator(".rf-audio-btn").nth(1);
    check(`P4 ${width}px 合成失败的句子：▶ 变成 ⊘、禁用、title「音频暂时没生成」；同时只播一段（第一句已停）`,
      (await failedBtn.isDisabled()) && (await failedBtn.innerText()).includes("⊘") && (await failedBtn.getAttribute("title")) === "音频暂时没生成" &&
        (await playBtns.first().getAttribute("aria-pressed")) === "false");
    await page.screenshot({ path: shots(`p35-failed-${width}.png`), fullPage: true });
    // 截图（spec §9.11）：情景卡背面；同一张卡里三种状态（待播放 / 播放中 / 失败）；回译三层；搭配与用法背面
    await shotEl(sit, `preview-situation-${width}.png`);
    await playBtns.first().click();
    await page.waitForFunction(() => document.querySelector(".rf-audio-on") !== null, null, { timeout: 4000 }).catch(() => {});
    const states = await sit.evaluate((card) => [...card.querySelectorAll(".rf-audio-btn")].map((b) => b.innerText.trim()));
    check(`P4b ${width}px 同一张卡里同时有 ■ 播放中 / ⊘ 失败 / ▶ 待播放，三个按钮尺寸和位置规则一致`, JSON.stringify(states) === '["■","⊘","▶"]', JSON.stringify(states));
    if (width === 1440) await shotEl(sit, "preview-audio-states-1440.png");
    const bt = page.locator(".cp-card").nth(3);
    const btShots = [];
    await shotEl(bt, `preview-back-translate-front-${width}.png`);
    btShots.push(await bt.locator(".rf-audio-btn").count());
    await bt.getByRole("button", { name: "看提示" }).click();
    await shotEl(bt, `preview-back-translate-hint-${width}.png`);
    btShots.push(await bt.locator(".rf-audio-btn").count());
    await bt.getByRole("button", { name: "看答案" }).click();
    await shotEl(bt, `preview-back-translate-back-${width}.png`);
    btShots.push(await bt.locator(".rf-audio-btn").count());
    check(`P2b ${width}px 回译卡：正面、提示层没有 ▶，背面原句带 1 个 ▶`, JSON.stringify(btShots) === "[0,0,1]", JSON.stringify(btShots));
    const us = page.locator(".cp-card").nth(4);
    await us.getByRole("button", { name: "看答案" }).click();
    const usAlign = await us.evaluate((card) => {
      const body = card.querySelector(".cp-body").getBoundingClientRect().left;
      const lefts = [...card.querySelectorAll(".cp-title, .rf-ref-note, .rf-ref-group > *")].map((e) => Math.round(e.getBoundingClientRect().left - body));
      return [...new Set(lefts)];
    });
    check(`P1b ${width}px 搭配与用法：标题、说明、搭配、英文、中文全部落在内容区左边缘（只有一条对齐线）；2 个 ▶`,
      usAlign.length === 1 && (await us.locator(".rf-audio-btn").count()) === 2, JSON.stringify(usAlign));
    await shotEl(us, `preview-usage-${width}.png`);
    check(`U5 ${width}px 无横向溢出`, await overflow());
    await page.screenshot({ path: shots(`pending-${width}.png`), fullPage: true });

    await page.getByRole("button", { name: "修改" }).first().click();
    await page.locator(".ce-form").waitFor();
    check(`U6 ${width}px 修改表单：原句只读并提示`, (await page.locator(".ce-readonly").count()) >= 1 && (await page.locator(".ce-form").innerText()).includes("原句来自文章，不能修改"));
    const instr = page.locator(".ce-form textarea").first();
    await instr.fill("ephemeral most nearly means");
    await page.getByRole("button", { name: "保存" }).click();
    await page.locator(".ce-form").waitFor({ state: "detached" });
    check(`U7 ${width}px 保存后回到预览，内容已更新`, (await page.locator(".cp-card").first().innerText()).includes("most nearly means"));
    await page.getByRole("button", { name: "修改" }).first().click();
    await page.locator(".ce-form textarea").first().fill("意思是短暂的吗");
    await page.getByRole("button", { name: "保存" }).click();
    await page.locator(".ce-form [role=alert]").waitFor();
    check(`U8 ${width}px 校验不过：中文原因显示在表单顶部`, (await page.locator(".ce-form [role=alert]").innerText()).includes("中文意思"));
    await page.screenshot({ path: shots(`editor-${width}.png`), fullPage: true });
    await page.getByRole("button", { name: "取消" }).click();
    await c.close();
  }

  // 推送：选牌组 + 章节 → 推送全部 → 进度 → 词从待推送消失
  const c2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await c2.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const p2 = await c2.newPage();
  await p2.goto(`${BASE}/words?status=pending`, { waitUntil: "networkidle" });
  await p2.locator(".pc-bar select").first().selectOption("d1");
  await p2.locator(".pc-bar select").nth(1).selectOption("ch1");
  await p2.getByRole("button", { name: /推送全部/ }).click();
  await p2.getByText(/推送完成/).waitFor({ timeout: 30000 });
  await p2.screenshot({ path: shots("pushed-1440.png"), fullPage: true });
  await shotEl(p2.locator(".pc-progress"), "push-audio-missing-1440.png");
  await p2.setViewportSize({ width: 390, height: 844 });
  await shotEl(p2.locator(".pc-progress"), "push-audio-missing-390.png");
  check("P5b 390px 推送结果无横向溢出", await p2.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await p2.setViewportSize({ width: 1440, height: 900 });
  const progress = await p2.locator(".pc-progress").innerText();
  check("U9 推送完成：显示「已推送 5 / 共 5」，假墨墨收到 5 张", progress.includes("已推送 5 / 共 5") && made === 5, `made=${made}`);
  check("P5 推送：情景卡三句里两句带真实音频标签、失败那句不带；推送结果显示「有 1 张卡没配上音频」",
    progress.includes("有 1 张卡没配上音频") && (await p2.locator(".rf-audio-missing").count()) === 1 &&
      pushed[2]?.includes("[Audio#M,ID/mkjfUi") && !pushed.some((c) => c.includes("@AUDIO")) && (pushed[2].match(/\[Audio#/g) ?? []).length === 2,
    `${progress.replace(/\n/g, " ")} | ${pushed[2]?.slice(-160)}`);
  check("U10 推完后待推送为空", (await p2.getByText("没有待推送的卡片").count()) === 1);

  // 阅读页：点一个新词 → 讲解里的建议行被藏起来、理由显示在按钮上方 → 做成卡片 → 状态变化
  const t2 = await api("/api/texts", { cookie, method: "POST", body: { title: "Reader demo", text: S } });
  const textId2 = t2.data.id ?? t2.data.textId;
  const c3 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await c3.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const p3 = await c3.newPage();
  await p3.goto(`${BASE}/texts/${textId2}`, { waitUntil: "networkidle" });
  await p3.getByText("ephemeral", { exact: false }).first().click();
  await p3.getByRole("button", { name: /问 AI/ }).click();
  await p3.getByRole("button", { name: "这个词在这句里什么意思" }).click();
  await p3.locator(".rf-card-suggest").waitFor({ timeout: 20000 }).catch(async (e) => { await p3.screenshot({ path: shots("reader-fail.png") }); console.log("页面文本:", (await p3.locator("body").innerText()).slice(0, 400)); throw e; });
  const answerText = await p3.locator(".rf-md").first().innerText();
  check("R1 讲解正文里没有「制卡建议」那一行；理由超过 30 字也完整显示（不截断、没有省略号）", !answerText.includes("制卡建议") && (await p3.locator(".rf-card-suggest").innerText()).includes("💡 建议做成卡片：技术文档高频形容词，与 generalization 同源，值得放在一起记，别和名词混了"), answerText.slice(0, 60));
  const btn = p3.getByRole("button", { name: "＋ 做成卡片" });
  check("R2 有建议时「做成卡片」有紫色点缀（不是绿色），且是和「问 AI」同一套按钮底盘", (await btn.getAttribute("class")).includes("rf-card-btn-suggest") && (await btn.getAttribute("class")).includes("duo-btn-white"));
  const hs = await Promise.all([p3.getByRole("button", { name: /问 AI/ }), btn].map((l) => l.evaluate((e) => Math.round(e.getBoundingClientRect().height))));
  check("R2b 「问 AI」与「做成卡片」同高", hs[0] === hs[1], `高度=${hs}`);
  const bar = await p3.locator(".rf-card-suggest").evaluate((e) => ({ order: getComputedStyle(e).order, bg: getComputedStyle(e).backgroundColor }));
  check("R2c 建议条在按钮组上方（order:-1）且是浅紫底", bar.order === "-1" && bar.bg === "rgb(245, 236, 255)", JSON.stringify(bar));
  await p3.screenshot({ path: shots("reader-suggest-1440.png") });
  const box = await btn.boundingBox();
  await p3.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await p3.mouse.down();
  const pressed = await btn.evaluate((e) => getComputedStyle(e).transform);
  await p3.mouse.up({ button: "left" }).catch(() => {});
  check("R2d 按下时有下沉反馈（:active 位移）", pressed !== "none", pressed);
  await p3.getByText("正在做卡…").waitFor({ timeout: 3000 });
  check("R3 点击后马上变成「正在做卡…」，同一个位置、带转圈、禁用并标 aria-busy", (await p3.locator(".rf-card-btn .rf-spin").count()) === 1 && (await p3.locator(".rf-card-btn[aria-busy=true]").count()) === 1);
  await p3.getByText(/已做成 5 张卡/).waitFor({ timeout: 30000 });
  check("R4 生成完成：「✓ 已做成 5 张卡 · 查看」，查看指向待推送并带上词", (await p3.getByRole("link", { name: "查看" }).getAttribute("href")).startsWith("/words?status=pending&word="));
  await p3.screenshot({ path: shots("reader-done-1440.png") });
  await c3.close();
  const c4 = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await c4.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const p4 = await c4.newPage();
  await p4.goto(`${BASE}/texts/${textId2}`, { waitUntil: "networkidle" });
  await p4.screenshot({ path: shots("reader-390-before.png") });
  await p4.mouse.click(150, 141);
  await p4.getByText(/已做成 5 张卡/).waitFor({ timeout: 15000 });
  check("R5 390px：回到已生成的词，按钮状态保持「已做成 5 张卡」，无横向溢出", await p4.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await p4.screenshot({ path: shots("reader-done-390.png") });
  await c4.close();

  // 问卷：下拉 + 复选框（不是药丸）
  for (const width of [1440, 390]) {
    const cs = await browser.newContext({ viewport: { width, height: 900 } });
    await cs.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
    const ps = await cs.newPage();
    await ps.goto(`${BASE}/welcome`, { waitUntil: "networkidle" });
    const nSel = await ps.locator("select.rf-survey-select").count();
    await ps.locator("#survey-exam").selectOption({ label: "大学英语六级" });
    const scoreShown = await ps.locator("#survey-examScore").count();
    await ps.locator("#survey-exam").selectOption({ label: "高考" });
    const scoreHidden = await ps.locator("#survey-examScore").count();
    const boxes = ps.locator(".rf-survey-check input[type=checkbox]");
    await boxes.nth(0).check();
    await boxes.nth(2).check();
    const checked = await ps.locator(".rf-survey-check-on").count();
    check(`S1 ${width}px 问卷用下拉 + 复选框：单选题 4 个下拉（身份 / 考试 / 阅读感受 / 讲解风格），阅读目的是复选框`, nSel === 4 && (await boxes.count()) === 6 && (await ps.locator(".duo-filter-chip").count()) === 0, `下拉=${nSel} 复选框=${await boxes.count()}`);
    check(`S2 ${width}px 选了六级才出现分数段，换成高考就收起；复选框可多选且选中有灰底`, scoreShown === 1 && scoreHidden === 0 && checked === 2);
    check(`S3 ${width}px 只有一个绿色主按钮，无横向溢出`, (await ps.locator(".duo-btn-primary:visible").count()) === 1 && (await ps.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)));
    const look = await ps.evaluate(() => {
      const title = document.querySelector(".rf-survey-q-title");
      const sel = document.querySelector("select.rf-survey-select");
      const checks = [...document.querySelectorAll(".rf-survey-check")];
      const lefts = [...new Set(checks.map((c) => Math.round(c.getBoundingClientRect().left)))];
      return {
        titleW: getComputedStyle(title).fontWeight,
        selW: getComputedStyle(sel).fontWeight,
        selWidth: Math.round(sel.getBoundingClientRect().width),
        checkBorder: getComputedStyle(checks[0]).borderTopWidth,
        cols: lefts.length,
        sameLeft: Math.round(sel.getBoundingClientRect().left) === Math.min(...lefts),
      };
    });
    check(`S4 ${width}px 四项原则：题目粗（700）答案常规（400）；下拉限宽 ≤400；复选项无边框、排成 ${width >= 640 ? 2 : 1} 列并与下拉左对齐`,
      look.titleW === "700" && look.selW === "400" && look.selWidth <= 400 && look.checkBorder === "0px" && look.cols === (width >= 640 ? 2 : 1) && look.sameLeft,
      JSON.stringify(look));
    await ps.screenshot({ path: shots(`survey-${width}.png`), fullPage: true });

    // 设置 →「学习档案」：同一个组件；保存按钮在表单最下面、与表单左对齐
    await ps.goto(BASE, { waitUntil: "networkidle" });
    await ps.click(".pm-trigger");
    await ps.getByRole("menuitem", { name: /设置/ }).click();
    await ps.getByRole("button", { name: "学习档案" }).click();
    await ps.locator(".st-main .rf-survey").waitFor(); // 档案读完才渲染表单
    const pos = await ps.evaluate(() => {
      const form = document.querySelector(".st-main .rf-survey");
      const save = document.querySelector(".st-main .rf-survey-actions button");
      const f = form.getBoundingClientRect(), b = save.getBoundingClientRect();
      return { below: b.top >= f.bottom, sameLeft: Math.round(b.left) === Math.round(f.left), text: save.textContent };
    });
    check(`S5 ${width}px 设置里的「保存」在表单下面、与表单左对齐`, pos.below && pos.sameLeft && pos.text === "保存", JSON.stringify(pos));
    await ps.locator(".st-main .rf-survey").scrollIntoViewIfNeeded();
    await ps.screenshot({ path: shots(`settings-survey-${width}.png`) });
    await cs.close();
  }

  // 设置：「模型」页只放模型——语音合成模型和 Key 在这里；三个开关在「AI 功能」页（主账号可见）
  const c5 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await c5.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const p5 = await c5.newPage();
  await p5.goto(BASE, { waitUntil: "networkidle" });
  await p5.click(".pm-trigger");
  await p5.getByRole("menuitem", { name: /设置/ }).click();
  const ttsStatus = p5.getByTestId("tts-status");
  await ttsStatus.waitFor();
  const modelsSwitches = await p5.locator(".st-main [role=switch]").count();
  const statusText = (await ttsStatus.innerText()).replace(/\n/g, " ");
  check("P6 「模型」页没有开关，有「语音合成模型」，当前用环境变量的 Key", modelsSwitches === 0 && (await p5.getByRole("heading", { name: "语音合成模型" }).count()) === 1 && statusText.includes("DASHSCOPE_API_KEY"), `switches=${modelsSwitches} ${statusText}`);
  await p5.locator(".st-main").screenshot({ path: shots("settings-models-1440.png") });

  await p5.locator("#st-tts-key").fill("sk-p37-own-key-123456");
  await p5.getByRole("button", { name: "保存", exact: true }).click();
  await p5.waitForFunction(() => document.querySelector('[data-testid="tts-status"]')?.textContent?.includes("本页填写的 Key"));
  const saved = await api("/api/settings", { cookie });
  check("P6a 填 Key 保存后接口返回 source=setting、Key 已脱敏", saved.data.tts?.source === "setting" && saved.data.tts.maskedKey !== "sk-p37-own-key-123456" && saved.data.tts.configured === true, JSON.stringify(saved.data.tts));
  await p5.getByRole("button", { name: "清除", exact: true }).click();
  await p5.waitForFunction(() => document.querySelector('[data-testid="tts-status"]')?.textContent?.includes("DASHSCOPE_API_KEY"));
  const cleared = await api("/api/settings", { cookie });
  check("P6c 点「清除」后回退到环境变量的 Key；之前的配音请求带的是环境变量 Key", cleared.data.tts?.source === "env" && ttsCalls > 0 && ttsAuth === "Bearer fake-dashscope", `${JSON.stringify(cleared.data.tts)} calls=${ttsCalls} auth=${ttsAuth}`);

  await p5.locator(".st-nav-item", { hasText: "AI 功能" }).click();
  const sw = p5.getByRole("switch", { name: "卡片句子配音" });
  await sw.waitFor();
  const featureSwitches = await p5.locator(".st-main [role=switch]").count();
  check("P6b 「AI 功能」页有三个开关，配音开关默认开", featureSwitches === 3 && (await sw.getAttribute("aria-checked")) === "true", `switches=${featureSwitches}`);
  await sw.click();
  await p5.waitForFunction(() => document.querySelector('[aria-label="卡片句子配音"]')?.getAttribute("aria-checked") === "false");
  const after = await api("/api/settings", { cookie });
  await p5.getByRole("switch", { name: "做卡" }).click();
  await p5.waitForFunction(() => document.querySelector('[aria-label="卡片句子配音"]')?.disabled === true);
  check("P7 关掉配音后接口返回 off；关掉做卡时配音开关禁用", after.data.cardsAudio === "off" && (await sw.isDisabled()));
  await p5.locator(".st-main").screenshot({ path: shots("settings-features-1440.png") });
  await api("/api/settings", { cookie, method: "PUT", body: { cardsEnabled: "on", cardsAudio: "on" } });
  await p5.setViewportSize({ width: 390, height: 844 });
  await p5.reload({ waitUntil: "networkidle" });
  await p5.click(".pm-trigger");
  await p5.getByRole("menuitem", { name: /设置/ }).click();
  await p5.getByTestId("tts-status").scrollIntoViewIfNeeded();
  await p5.screenshot({ path: shots("settings-models-390.png") });
  check("P7b 390px 设置无横向溢出", await p5.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await c5.close();

  // 设置：会员档位 + 做卡开关
  await p2.goto(`${BASE}/words`, { waitUntil: "networkidle" });
  const st = await api("/api/settings", { cookie, method: "PUT", body: { cardsEnabled: "off" } });
  await p2.reload({ waitUntil: "networkidle" });
  check("U11 做卡关闭：词库没有「待推送」筛选", (await p2.locator(".wl-side-item", { hasText: "待推送" }).count()) === 0 && st.data.cardsEnabled === "off");
  await api("/api/settings", { cookie, method: "PUT", body: { cardsEnabled: "on" } });
  check("U12 服务端日志没有异常", !/unhandled|TypeError|ReferenceError/i.test(log));
} catch (e) { fail++; console.log("FAIL  脚本异常:", e?.stack ?? e); }
finally {
  await browser?.close();
  server.kill("SIGTERM"); model.close(); mj.close(); tts.close();
  console.log(`\n${pass} passed, ${fail} failed  截图：${TMP}`);
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}
