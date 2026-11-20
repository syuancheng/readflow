/**
 * 设计走查截图：把主要页面和状态截下来，供设计审查用（不是测试）。
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
const PORT = 3174, MODEL = 3175, MJ = 3176, TTS = 3177;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "audit-run");
const DB = path.join(TMP, "readflow.db");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };

const S = "The ephemeral joy faded quickly.";
const cards = {
  cards: [
    { kind: "rephrase", target: "t", front: [
      { t: "sentence", source: "original", text: S, mark: { start: 4, end: 13, as: "highlight" } },
      { t: "instruction", text: "不用 ephemeral，换个说法把这句话再说一遍" }],
      back: { answer: [{ t: "sentence", source: "paraphrase", text: "The brief joy faded quickly." }, { t: "text", text: "短暂的喜悦很快消失了。" }], explanation: [{ t: "text", text: "转瞬即逝" }] } },
    { kind: "custom", customLabel: "提示卡", target: "t2", front: [{ t: "sentence", source: "original", text: S, mark: { start: 4, end: 13, as: "highlight" } }, { t: "instruction", text: "回忆这个词怎么拼" }],
      hints: [{ t: "text", text: "首字母 e" }], back: { answer: [{ t: "text", text: "ephemeral" }] } },
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
let ttsCalls = 0, ttsAuth = "", ttsVoice = "";
const tts = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    if (req.method === "GET") { res.writeHead(200, { "content-type": "audio/wav" }); return res.end(WAV); }
    ttsCalls++; ttsAuth = req.headers.authorization ?? "";
    const text = JSON.parse(b || "{}").input?.text ?? "";
    ttsVoice = JSON.parse(b || "{}").input?.voice ?? "";
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
  const OUT = path.join(ROOT, ".verify", "audit");
  fs.mkdirSync(OUT, { recursive: true });
  const shot = (page, name, full = false) => page.screenshot({ path: path.join(OUT, name), fullPage: full });
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  // 未登录页
  const anon = await c.newPage();
  await anon.goto(`${BASE}/login`, { waitUntil: "networkidle" });
  await shot(anon, "01-login.png");
  await c.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const page = await c.newPage();
  // 再造几篇文章，让首页 / 词库有内容
  await api("/api/texts", { cookie, method: "POST", body: { title: "What I learned building an opinionated and minimal coding agent", text: "Agents can copy mistakes. Start with a lint rule that prevents new occurrences, then clean up the old examples the next agent might copy.\n\nGive the agent a way to verify the resulting behavior." } });
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await shot(page, "02-home.png", true);
  await page.goto(`${BASE}/welcome`, { waitUntil: "networkidle" });
  await shot(page, "03-welcome.png", true);
  await page.goto(`${BASE}/stats`, { waitUntil: "networkidle" });
  await shot(page, "04-stats.png", true);
  await page.goto(`${BASE}/words`, { waitUntil: "networkidle" });
  await shot(page, "05-words.png");
  await page.goto(`${BASE}/words?status=pending`, { waitUntil: "networkidle" });
  await shot(page, "06-pending.png");
  // 推送：选牌组 / 章节 → 推送全部 → 推送完成
  await page.locator("select.duo-input").first().selectOption({ label: "测试牌组" });
  await page.waitForTimeout(400);
  await page.locator("select.duo-input").nth(1).selectOption({ index: 1 });
  await page.getByRole("button", { name: /推送全部/ }).click();
  await page.getByText(/推送完成/).waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  await shot(page, "07-pushed.png");
  // 阅读页：点词 + AI 回答
  const list = await api("/api/texts", { cookie });
  const tid = textId;
  await page.goto(`${BASE}/texts/${tid}`, { waitUntil: "networkidle" });
  await shot(page, "08-reading.png");
  const bx = await page.evaluate(() => { const r = [...document.querySelectorAll(".reading-body .w")].find((e) => e.textContent === "ephemeral").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
  await page.mouse.click(bx.x, bx.y);
  await page.waitForTimeout(1200);
  await shot(page, "09-reading-pick.png");
  // 设置弹窗
  await page.goto(`${BASE}/`, { waitUntil: "networkidle" });
  await page.locator(".duo-avatar, [aria-label*='账户'], button:has-text('SC')").first().click().catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, "10-menu.png");
  console.log("shots ok");
} catch (e) { fail++; console.log("FAIL  脚本异常:", e?.stack ?? e); }
finally {
  await browser?.close();
  server.kill("SIGTERM"); model.close(); mj.close(); tts.close();
  setTimeout(() => process.exit(0), 300);
}
