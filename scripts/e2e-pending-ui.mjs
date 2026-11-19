/**
 * P51：词库「待推送」页的新版式（一层、无外框、操作在卡片头部右侧、按钮不再是 3D 实体）。
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
const PORT = 3170, MODEL = 3171, MJ = 3172, TTS = 3173;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "pending-ui");
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
  const SHOTS = path.join(ROOT, ".verify", "p51", "shots");
  fs.mkdirSync(SHOTS, { recursive: true });
  const c = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await c.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const page = await c.newPage();
  await page.goto(`${BASE}/words?status=pending`, { waitUntil: "networkidle" });
  const title = await page.locator(".pc-text-title").innerText();
  check("V1 文章分组标题是纯文字（没有 📖 图标）", title.includes("Word list demo") && !/[📖📚]/u.test(title), title);
  await page.getByRole("button", { name: /ephemeral/ }).click();
  await page.locator(".cp-card").first().waitFor();
  const n = await page.locator(".cp-card").count();
  const look = await page.evaluate(() => {
    const card = document.querySelector(".cp-card"), gs = (el) => getComputedStyle(el);
    const second = document.querySelectorAll(".pc-card")[1];
    return {
      border: gs(card).borderTopWidth, bg: gs(card).backgroundColor,
      divider: second ? gs(second).borderTopWidth : "none",
      headTags: document.querySelectorAll(".cp-head .cp-tags").length, headActions: document.querySelectorAll(".cp-head .cp-actions").length,
      sourceTag: document.querySelectorAll(".cp-tag-source").length,
      actionBtns: [...document.querySelector(".cp-actions").querySelectorAll("button")].map((b) => b.textContent.trim()),
      flatBtn: gs(document.querySelector(".cp-actions .rf-btn-text")).borderBottomWidth,
      flipClass: document.querySelector(".cp-flip").className,
      thick: document.querySelectorAll(".cp-card .duo-btn-white, .cp-card .duo-btn-sm").length,
      primary: [...document.querySelectorAll(".duo-btn-primary")].map((b) => b.textContent.trim()),
      kindBg: gs(document.querySelector(".cp-tag-kind")).backgroundColor,
    };
  });
  check(`V2 ${n} 张卡都是一层：没有外框、没有底色；卡与卡之间只有一条 1px 分隔线`, n >= 3 && look.border === "0px" && look.bg === "rgba(0, 0, 0, 0)" && look.divider === "1px", JSON.stringify({ n, ...look }));
  check("V3 头部：左边题型标签、右边「修改 · 换一道 · 删除」文字按钮；每张卡不再重复文章标题", look.headTags >= 1 && look.headActions >= 1 && look.sourceTag === 0 && look.actionBtns.join("|") === "修改|换一道|删除" && look.flatBtn === "0px");
  check("V4 「看提示 / 看答案」是描边小按钮，卡片里没有 3D 厚按钮；整页唯一的实心按钮是「推送全部」", look.flipClass.includes("rf-btn-quiet") && look.thick === 0 && look.primary.length === 1 && look.primary[0].includes("推送全部"), JSON.stringify(look.primary));
  check("V5 题型标签是中性底（不再是绿色实心）", look.kindBg !== "rgb(88, 204, 2)" && look.kindBg !== "rgb(58, 143, 0)", look.kindBg);
  const vis = await page.evaluate(() => [...document.querySelectorAll(".cp-card")].filter((e) => e.getBoundingClientRect().bottom <= innerHeight).length);
  check("V6 密度：一屏（1440×900，含推送栏）至少完整看到 2 张卡", vis >= 2, `一屏完整可见 ${vis} 张`);
  await page.screenshot({ path: path.join(SHOTS, "pending-1440.png") });
  // 功能没丢：修改能打开编辑器，取消能关闭
  await page.locator(".cp-actions").first().getByRole("button", { name: "修改" }).click();
  await page.locator(".ce-form").waitFor({ timeout: 5000 });
  const ed = await page.evaluate(() => ({ thick: document.querySelectorAll(".ce-form .duo-btn-white, .ce-form .duo-btn-sm").length }));
  await page.screenshot({ path: path.join(SHOTS, "pending-edit-1440.png") });
  await page.locator(".ce-form").getByRole("button", { name: "取消" }).click();
  check("V7 「修改」打开编辑器、「取消」关闭；编辑器里的按钮也不再是 3D 厚按钮", (await page.locator(".ce-form").count()) === 0 && ed.thick === 0);
  await page.locator(".cp-flip").first().click();
  check("V8 「看提示」「看答案」翻面仍然可用", (await page.locator(".cp-flip").first().getAttribute("aria-pressed")) === "true");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  check("V9 390px 无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await page.screenshot({ path: path.join(SHOTS, "pending-390.png") });
  check("V10 服务端日志没有异常", !/unhandled|TypeError|ReferenceError/i.test(log));
} catch (e) { fail++; console.log("FAIL  脚本异常:", e?.stack ?? e); }
finally {
  await browser?.close();
  server.kill("SIGTERM"); model.close(); mj.close(); tts.close();
  console.log(`\n${pass} passed, ${fail} failed  截图：.verify/p51/shots`);
  setTimeout(() => process.exit(fail ? 1 : 0), 300);
}
