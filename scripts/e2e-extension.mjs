/**
 * 插件端到端（P30）：每人一个插件 Token + 「导入当前网页」。
 *
 * 隔离库 + 临时端口（3133），跑完删库，不碰真实数据。需要先 npm run build。
 *   node scripts/e2e-extension.mjs        （HEADFUL=1 有界面运行）
 *
 * A 段（接口）：旧版站级 Token 迁成站长的、两人 Token 互相隔离、插件查词 / AI 走 Token、
 *              插件导入与 URL 导入落库结果一致、重复导入、各种拒绝。
 * B 段（真实浏览器）：Chromium 加载 extension/，popup 填配置 → 同步 → 在网页上点「导入到 ReadFlow」。
 *              环境不支持 MV3 Service Worker 时 B 段 SKIP，不算失败。
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
const EXT = path.join(ROOT, "extension");
const PORT = 3133;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "extension");
const DB = path.join(TMP, "readflow.db");
const PROFILE = path.join(TMP, "chrome-profile");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const q = (sql, ...args) => {
  const d = new Database(DB, { readonly: true });
  try { return d.prepare(sql).all(...args); } finally { d.close(); }
};

// ---------- 测试网页 ----------
const ARTICLE = `<!doctype html><html><head><title>Harness notes | Example Blog</title>
<script>window.__tracking = 1;</script><style>body{font-family:serif}</style></head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<article>
  <h1>Harness notes</h1>
  <p>Every database needs a careful owner and a clear history of changes, because a database without history is hard to trust.</p>
  <p>The harness perceives context, stores artifacts, and evaluates results before it decides what to do next in the loop.</p>
  <h2>Why it matters</h2>
  <ul><li>Models orchestrate tools.</li><li>Logs explain failures.</li></ul>
  <pre><code>npm run build\nnpm test</code></pre>
  <figure><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" data-src="/img/real.png" alt="diagram"><figcaption>The loop</figcaption></figure>
  <p>Finally, a database should be boring: predictable, observable, and easy to restore after a bad deploy.</p>
</article>
<footer>© Example</footer></body></html>`;
const DOC_HTML = `<!doctype html><html><head><title>Docs page</title>
<link rel="alternate" type="text/markdown" href="/doc.md"></head><body><main>
<p>This HTML body is only a fallback and should not be what gets imported when markdown exists.</p></main></body></html>`;
const DOC_MD = "# Official markdown\n\nThis paragraph came from the official markdown source of the page.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n";

// 点击查词：固定版式，方便点到「行尾空白」「段落间距」「链接」
const CLICK_PAGE = `<!doctype html><html><head><title>Click test</title>
<style>body{margin:40px;width:640px;font:20px/32px Georgia,serif}p{margin:0 0 48px}</style></head><body>
<p id="short">A short line ending in a word</p>
<p id="long">Stuffing disparate instructions into one prompt keeps the context window crowded and careful.</p>
<p id="withlink">As we have <a id="lnk" href="#later">previously explained</a> in the guide.</p>
<p id="later">The end.</p>
</body></html>`;

// P31 查词：没导入过的网页，点词会挂到「网页摘录」上。词都挑词典里有的、且不在朋友词表里的，
// 免得被高亮成 .rf-hl（点高亮走的是「回看」，不是「查词」）。
const P31_PAGE = `<!doctype html><html><head><title>Quiet rehearsal notes</title>
<style>body{margin:40px;width:720px;font:20px/34px Georgia,serif}p{margin:0 0 40px}</style></head><body>
<p id="p31a">The orchestra rehearsed quietly before the concert began.</p>
<p id="p31b">A careful engineer will scrutinize the deployment pipeline twice.</p>
</body></html>`;

const site = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
  // 假模型：OpenAI 兼容的流式端点。P31 的「自动 AI 讲解」必须在这里跑，
  // 不能真的连外部模型（e2e 要能离线、可重复、不花钱）。
  if (u === "/v1/chat/completions") {
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
    const parts = ["释义：**rehearsed quietly** 在这句里是", "「安静地排练」", "的意思。\n\n- 假模型第 1 行\n- 假模型第 2 行"];
    for (const part of parts) {
      res.write(
        `data: ${JSON.stringify({
          id: "fake-1",
          object: "chat.completion.chunk",
          created: 0,
          model: "fake-model",
          choices: [{ index: 0, delta: { content: part }, finish_reason: null }],
        })}\n\n`,
      );
    }
    res.write("data: [DONE]\n\n");
    return res.end();
  }
  if (u === "/p31") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(P31_PAGE);
  }
  if (u === "/click") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(CLICK_PAGE);
  }
  if (u === "/article" || u === "/article2") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(ARTICLE);
  }
  if (u === "/doc") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(DOC_HTML);
  }
  if (u === "/doc.md") {
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8" });
    return res.end(DOC_MD);
  }
  res.writeHead(404);
  res.end("nope");
});
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const SITE = `http://127.0.0.1:${site.address().port}`;

// ---------- 隔离服务器 ----------
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, DB_PATH: DB, NODE_ENV: "production", NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const cookieOf = (res) => res.headers.get("set-cookie")?.match(/readflow_session=([^;]+)/)?.[1];
async function api(pathname, { cookie, token, method = "GET", body, raw } = {}) {
  const headers = {};
  if (cookie) headers.cookie = `readflow_session=${cookie}`;
  if (token !== undefined) headers["x-readflow-token"] = token;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 流式 / 纯文本 */ }
  return { status: res.status, data, text, headers: res.headers };
}
const paras = (textId) =>
  q("select content, block_type from paragraphs where text_id = ? order by idx", textId)
    .map((p) => `${p.block_type}|${p.content}`);

let context;
try {
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try { await fetch(`${BASE}/api/auth/status`); up = true; } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  if (!up) throw new Error("服务器没起来:\n" + serverLog.slice(-2000));

  // ===== A. 接口 =====
  const setup = await fetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "ext_owner", password: "ext-owner-2026", phone: "13800138031" }),
  });
  const owner = cookieOf(setup);
  if (!owner) throw new Error("建站长失败");

  // A1 旧版「站级共用 Token」：插件里已经填好的值升级后继续能用，且明文从库里删掉
  const LEGACY = "legacy0token0abcdef0123456789";
  {
    const d = new Database(DB);
    d.prepare("INSERT OR REPLACE INTO settings (user_id, key, value, updated_at) VALUES ('local', 'extension.token', ?, ?)").run(LEGACY, Date.now());
    d.close();
  }
  const legacyWords = await api("/api/extension/words", { token: LEGACY });
  const legacyLeft = q("select count(*) n from settings where key = 'extension.token'")[0].n;
  const ownerRow = q("select user_id, token_hint from extension_tokens")[0];
  check(
    "A1 旧版站级 Token 自动迁成站长本人的，继续可用；明文已从库里删除",
    legacyWords.status === 200 && legacyLeft === 0 && ownerRow?.token_hint === LEGACY.slice(-4),
    `status=${legacyWords.status} 残留明文=${legacyLeft} hint=${ownerRow?.token_hint}`,
  );

  // A2 站长重新生成：新 Token 生效、旧的立即失效、设置读回只有状态没有明文
  const regen = await api("/api/settings", { cookie: owner, method: "PUT", body: { regenerateExtensionToken: true } });
  const ownerTok = regen.data?.newExtensionToken;
  const view = await api("/api/settings", { cookie: owner });
  const oldNow = await api("/api/extension/words", { token: LEGACY });
  const newNow = await api("/api/extension/words", { token: ownerTok });
  check(
    "A2 重新生成后新 Token 可用、旧的立即 401；读回设置不含明文",
    /^rfx_/.test(ownerTok ?? "") && oldNow.status === 401 && newNow.status === 200 &&
      view.data.extension.hasToken === true && !view.text.includes(ownerTok),
    `new=${newNow.status} old=${oldNow.status} 状态=${JSON.stringify(view.data.extension)}`,
  );

  // A3 受邀的朋友有自己的 Token，词表互相看不到
  const inv = await api("/api/invites", { cookie: owner, method: "POST", body: { maxUses: 1, note: "ext" } });
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ inviteCode: inv.data.code, username: "ext_friend", phone: "13800138032", password: "ext-friend-2026" }),
  });
  const friend = cookieOf(reg);
  const fRegen = await api("/api/settings", { cookie: friend, method: "PUT", body: { regenerateExtensionToken: true } });
  const friendTok = fRegen.data?.newExtensionToken;
  const saved = await api("/api/extension/words", {
    token: friendTok,
    method: "POST",
    body: { word: "database", sentence: "Every database needs a careful owner.", url: `${SITE}/elsewhere`, title: "Elsewhere" },
  });
  const ownerList = await api("/api/extension/words", { token: ownerTok });
  const friendList = await api("/api/extension/words", { token: friendTok });
  check(
    "A3 朋友用自己的 Token 收词，只进自己的词库；站长的词表里没有",
    fRegen.status === 200 && saved.status === 200 &&
      friendList.data.words.some((w) => w.lemma === "database") &&
      !ownerList.data.words.some((w) => w.lemma === "database"),
    `friend=${friendList.data.words.length} 词 owner=${ownerList.data.words.length} 词`,
  );

  // A4 插件查词 / AI 释义走 Token（不再依赖登录 cookie），带跨域头
  const dict = await api(`/api/extension/dict?word=databases`, { token: friendTok });
  const explain = await api("/api/extension/explain", { token: friendTok, method: "POST", body: { word: "database", context: "Every database needs a careful owner." } });
  const dictNoTok = await api(`/api/extension/dict?word=database`, { token: "bad" });
  check(
    "A4 插件查词 / AI 释义凭 Token 可用（不再 401），坏 Token 被拒，响应带跨域头",
    dict.status !== 401 && explain.status !== 401 && dictNoTok.status === 401 &&
      dict.headers.get("access-control-allow-origin") === "*" && explain.headers.get("access-control-allow-origin") === "*",
    `dict=${dict.status} explain=${explain.status} bad=${dictNoTok.status}`,
  );

  // A5 插件导入 = URL 导入：同一个页面，两条路径落库的段落一模一样
  const viaUrl = await api("/api/texts", { cookie: owner, method: "POST", body: { url: `${SITE}/article` } });
  const viaExt = await api("/api/extension/import", { token: ownerTok, method: "POST", body: { url: `${SITE}/article?ext=1`, title: "Harness notes | Example Blog", html: ARTICLE } });
  const pUrl = paras(viaUrl.data.id);
  const pExt = paras(viaExt.data.id);
  check(
    "A5 插件导入与 URL 导入的段落和块类型完全一致",
    viaUrl.status === 200 && viaExt.status === 200 && pUrl.length > 3 && JSON.stringify(pUrl) === JSON.stringify(pExt),
    `url=${pUrl.length} 段 ext=${pExt.length} 段 ${pUrl.length !== pExt.length ? "" : pUrl.filter((x, i) => x !== pExt[i]).slice(0, 1).join("")}`,
  );
  const extRow = q("select title, source_type, source_url, user_id from texts where id = ?", viaExt.data.id)[0];
  check(
    "A6 插件导入的文章：标题与 URL 导入一致、来源「网页」、记下原网址、归 Token 的主人",
    extRow.title === viaUrl.data.title && extRow.source_type === "url" && extRow.source_url === `${SITE}/article?ext=1` &&
      extRow.user_id === q("select id from users where username = 'ext_owner'")[0].id,
    JSON.stringify(extRow),
  );
  check(
    "A7 脚本 / 导航 / 页脚没混进正文",
    !pExt.some((p) => /__tracking|Home|© Example|font-family/.test(p)),
    pExt.find((p) => /__tracking|Home|© Example/.test(p)) ?? "",
  );

  // A8 页面声明了官方 Markdown：插件带上 markdown 时优先用它
  const md = await api("/api/extension/import", { token: ownerTok, method: "POST", body: { url: `${SITE}/doc`, html: DOC_HTML, markdown: DOC_MD } });
  const pMd = paras(md.data.id);
  check(
    "A8 有官方 Markdown 时用 Markdown（表格保留，HTML 兜底正文不进来）",
    md.data.sourceFormat === "markdown" && pMd.some((p) => p.includes("official markdown source")) &&
      pMd.some((p) => p.startsWith("table")) && !pMd.some((p) => p.includes("only a fallback")),
    pMd.join(" / ").slice(0, 120),
  );

  // A9 重复导入：默认返回已有那篇；force 再导入一份
  const dup = await api("/api/extension/import", { token: ownerTok, method: "POST", body: { url: `${SITE}/article?ext=1`, html: ARTICLE } });
  const again = await api("/api/extension/import", { token: ownerTok, method: "POST", body: { url: `${SITE}/article?ext=1`, html: ARTICLE, force: true } });
  check(
    "A9 同一网址再导入 → 提示已导入过（同一篇）；选「再导入一份」才新建",
    dup.data.duplicate === true && dup.data.id === viaExt.data.id && again.data.duplicate === false && again.data.id !== viaExt.data.id,
    `dup=${dup.data.duplicate} same=${dup.data.id === viaExt.data.id} force=${again.data.duplicate}`,
  );
  // 朋友导入同一网址不受站长那篇影响
  const fImport = await api("/api/extension/import", { token: friendTok, method: "POST", body: { url: `${SITE}/article?ext=1`, html: ARTICLE } });
  check("A10 去重只看自己的文章：朋友导入同一网址是新的一篇、进朋友名下", fImport.data.duplicate === false && q("select user_id from texts where id = ?", fImport.data.id)[0].user_id !== extRow.user_id);

  // A11 各种拒绝
  const noTok = await api("/api/extension/import", { token: "nope", method: "POST", body: { url: `${SITE}/article`, html: ARTICLE } });
  const badUrl = await api("/api/extension/import", { token: ownerTok, method: "POST", body: { url: "chrome://settings", html: ARTICLE } });
  const empty = await api("/api/extension/import", { token: ownerTok, method: "POST", body: { url: `${SITE}/x`, html: "" } });
  const huge = await api("/api/extension/import", { token: ownerTok, method: "POST", body: { url: `${SITE}/big`, html: "<p>" + "a".repeat(5.5 * 1024 * 1024) + "</p>" } });
  const noText = await api("/api/extension/import", { token: ownerTok, method: "POST", body: { url: `${SITE}/blank`, html: "<html><body><nav>menu</nav></body></html>" } });
  check(
    "A11 坏 Token 401 / 非网页 400 / 空页面 400 / 超大 413 / 提不出正文 422，且都有中文原因",
    noTok.status === 401 && badUrl.status === 400 && empty.status === 400 && huge.status === 413 && noText.status === 422 &&
      [noTok, badUrl, empty, huge, noText].every((r) => /[一-鿿]/.test(r.data?.error ?? "")),
    `${noTok.status} ${badUrl.status} ${empty.status} ${huge.status} ${noText.status}`,
  );

  // A12 在已整篇导入的网页上划词收词：挂到单独的「网页摘录」上，不往导入的文章末尾加段落
  const before = paras(viaExt.data.id).length;
  await api("/api/extension/words", { token: ownerTok, method: "POST", body: { word: "owner", sentence: "Every database needs a careful owner.", url: `${SITE}/article?ext=1`, title: "x" } });
  const after = paras(viaExt.data.id).length;
  const snippet = q("select source_type from texts where source_url = ? and source_type = 'web'", `${SITE}/article?ext=1`);
  check("A12 划词收词不会改动已导入的文章（另建网页摘录）", before === after && snippet.length === 1, `段落 ${before} → ${after}，摘录 ${snippet.length}`);

  // A13 长文章导入要快：查词典必须走大小写不敏感索引，否则每个词全表扫 77 万行，
  // 1700 词的文章光估难度就要 20 多秒，插件导入会超时（P30 实测）
  const dictPath = path.join(ROOT, "data", "dict", "ecdict.db");
  if (fs.existsSync(dictPath)) {
    const dictDb = new Database(dictPath, { readonly: true });
    const vocab = dictDb.prepare("select word from ecdict where frq between 500 and 20000 and word glob '[a-z]*' and length(word) > 3 limit 900").all().map((r) => r.word);
    dictDb.close();
    const sentences = [];
    for (let i = 0; i < 160; i++) {
      const w = (k) => vocab[(i * 7 + k * 13) % vocab.length];
      sentences.push(`The ${w(0)} of every ${w(1)} can ${w(2)} the ${w(3)} when ${w(4)} ${w(5)} and ${w(6)} ${w(7)} together ${w(8)} ${w(9)}.`);
    }
    const longHtml = `<html><head><title>Long read</title></head><body><article><h1>Long read</h1>${sentences
      .reduce((acc, s, i) => (i % 4 === 0 ? acc.push([s]) : acc[acc.length - 1].push(s), acc), [])
      .map((g) => `<p>${g.join(" ")}</p>`)
      .join("")}</article></body></html>`;
    const t0 = Date.now();
    const long = await api("/api/extension/import", { token: ownerTok, method: "POST", body: { url: `${SITE}/long`, html: longHtml } });
    const ms = Date.now() - t0;
    const idx = (() => {
      const d = new Database(dictPath, { readonly: true });
      try { return d.prepare("select 1 from sqlite_master where name = 'idx_ecdict_word_nocase'").get(); } finally { d.close(); }
    })();
    check(
      "A13 约 2000 词的长文章 5 秒内导入完成（词典已有大小写不敏感索引）",
      long.status === 200 && long.data.wordCount > 1500 && ms < 5000 && Boolean(idx),
      `${long.data?.wordCount} 词，用时 ${ms}ms，索引=${Boolean(idx)}`,
    );
  } else {
    console.log("SKIP  A13 本机没有 ECDICT 词典");
  }

  // ===== B. 真实浏览器加载插件 =====
  const headless = process.env.HEADFUL !== "1";
  try {
    context = await chromium.launchPersistentContext(PROFILE, {
      headless,
      channel: "chromium",
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check",
        ...(headless ? [] : ["--window-position=-2400,-2400", "--window-size=1200,900"])],
    });
  } catch (e) {
    console.log("SKIP  B 段：浏览器起不来 —", e.message.split("\n")[0]);
  }
  let worker = context?.serviceWorkers()[0];
  for (let i = 0; context && i < 25 && !worker; i++) {
    await new Promise((r) => setTimeout(r, 400));
    worker = context.serviceWorkers()[0];
  }
  if (!context || !worker) {
    console.log("SKIP  B 段：这个环境没有启动扩展的 Service Worker（A 段已覆盖接口），手动验收请加载 extension/");
  } else {
    const extId = new URL(worker.url()).host;
    const article = await context.newPage();
    await article.goto(`${SITE}/article2`, { waitUntil: "load" });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/src/popup.html`);
    const tabId = await popup.evaluate(async (u) => (await chrome.tabs.query({ url: `${u}*` }))[0]?.id, `${SITE}/article2`);
    await popup.goto(`chrome-extension://${extId}/src/popup.html?tabId=${tabId}`);
    await popup.evaluate(() => { document.getElementById("settings").open = true; });
    await popup.fill("#server", BASE);
    await popup.fill("#token", friendTok);
    await popup.click("#save");
    await popup.waitForFunction(() => /✓ 已同步 \d+ 个词/.test(document.getElementById("status")?.textContent || ""), { timeout: 15000 });
    check("B1 popup 用朋友的 Token 保存并同步词表", true, await popup.locator("#status").innerText());

    // 让网页上出现已存词高亮 + 中文小标签，验证导入时会被剔除
    await article.reload({ waitUntil: "load" });
    await article.waitForSelector(".rf-hl", { timeout: 15000 }).catch(() => {});
    const glossTexts = await article.locator(".rf-gloss").allInnerTexts();
    check("B2 网页上的已存词被高亮（带中文小标签）", glossTexts.length > 0, glossTexts.slice(0, 2).join(" / "));
    // 中文小标签默认收起，鼠标停上去才出现（常显会盖住上一行的字）
    const opacityOf = () => article.evaluate(() => getComputedStyle(document.querySelector(".rf-gloss")).opacity);
    const atRest = await opacityOf();
    await article.locator(".rf-hl").first().hover();
    await article.waitForTimeout(300);
    const onHover = await opacityOf();
    const hoverBox = await article.evaluate(() => {
      const r = document.querySelector(".rf-hl:hover .rf-gloss")?.getBoundingClientRect();
      return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
    });
    await article.mouse.move(5, 5);
    await article.waitForTimeout(300);
    const afterLeave = await opacityOf();
    check("B2b 中文小标签平时隐藏、悬停才显示、移开又收起", atRest === "0" && onHover === "1" && afterLeave === "0", `平时=${atRest} 悬停=${onHover} 移开=${afterLeave}`);
    check("B2c 悬停时小标签横着排成一行（不会被挤成一个字一行）", Boolean(hoverBox) && hoverBox.w > hoverBox.h * 2 && hoverBox.h < 30, JSON.stringify(hoverBox));

    const pageTitle = await popup.locator("#page-title").innerText();
    check("B3 popup 显示要导入的网页标题", pageTitle.includes("Harness notes"), pageTitle);
    await popup.click("#import");
    await popup.waitForFunction(() => /已导入|导入失败/.test(document.getElementById("import-msg")?.textContent || ""), { timeout: 20000 });
    const msg = await popup.locator("#import-msg").innerText();
    const openHref = await popup.locator("#open").getAttribute("href");
    check("B4 点「导入到 ReadFlow」成功，给出打开链接", msg.includes("✓ 已导入") && /\/texts\//.test(openHref ?? ""), msg);

    const importedId = openHref?.split("/texts/")[1];
    const pB = importedId ? paras(importedId) : [];
    const gloss = glossTexts.find((g) => g.trim());
    check(
      "B5 导入的正文完整，且没有混进插件的高亮小标签",
      pB.some((p) => p.includes("Every database needs a careful owner")) && (!gloss || !pB.some((p) => p.includes(gloss))),
      `${pB.length} 段`,
    );
    const fig = importedId ? q("select block_meta from paragraphs where text_id = ? and block_type = 'figure'", importedId)[0] : null;
    check("B6 懒加载图片拿到的是真实地址（data-src），不是占位图", Boolean(fig?.block_meta?.includes("/img/real.png")), fig?.block_meta?.slice(0, 120) ?? "没有图片块");

    await popup.click("#import");
    await popup.waitForFunction(() => /已经导入过/.test(document.getElementById("import-msg")?.textContent || ""), { timeout: 20000 });
    check("B7 同一网页再点一次 → 提示已导入过，并出现「再导入一份」", await popup.locator("#force").isVisible());

    // ---- C. 点击查词：只有真的点在单词上才弹卡片 ----
    const cp = await context.newPage();
    await cp.setViewportSize({ width: 1000, height: 800 });
    await cp.goto(`${SITE}/click`, { waitUntil: "load" });
    await cp.waitForFunction(() => Boolean(document.getElementById("rf-ext-host")), null, { timeout: 15000 });
    // P31 起查词 UI 从「小卡片」换成右侧滑出的侧栏，选择器跟着改，断言的行为不变
    const cardState = () =>
      cp.evaluate(() => {
        const c = document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-panel");
        return {
          open: Boolean(c?.classList.contains("on")),
          word: c?.querySelector(".rf-word")?.textContent || "",
          body: c?.querySelector(".rf-dict")?.textContent || "",
        };
      });
    /** 某个元素里某个词在屏幕上的中心点 */
    const wordPoint = (id, word) =>
      cp.evaluate(([id, word]) => {
        const el = document.getElementById(id);
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const n = walker.currentNode;
          const i = n.nodeValue.indexOf(word);
          if (i >= 0) {
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + word.length);
            const b = r.getBoundingClientRect();
            return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
          }
        }
        return null;
      }, [id, word]);
    const box = (id) => cp.evaluate((id) => { const b = document.getElementById(id).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; }, id);

    const short = await box("short");
    await cp.mouse.click(short.right - 40, (short.top + short.bottom) / 2); // 行尾是单词时，右边的空白（修复前会吸附到 word 上）
    await cp.waitForTimeout(500);
    check("C1 点行尾右边的空白：不弹查词卡片", !(await cardState()).open);

    await cp.mouse.click(short.left + 60, short.bottom + 24); // 两段之间的间距
    await cp.waitForTimeout(500);
    check("C2 点段落之间的空白：不弹查词卡片", !(await cardState()).open);

    const careful = await wordPoint("long", "careful");
    await cp.mouse.click(careful.x, careful.y);
    await cp.waitForFunction(() => document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-panel.on"), null, { timeout: 8000 }).catch(() => {});
    // 侧栏先开壳、再填内容；等记录回来再继续，后面的「点空白关闭」才是稳态行为
    await cp
      .waitForFunction(() => {
        const d = document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-dict")?.textContent || "";
        return d.length > 0 && !d.includes("查词典中");
      }, null, { timeout: 8000 })
      .catch(() => {});
    // 侧栏先开壳、再填内容；等记录回来再继续，后面的「点空白关闭」才是稳态行为
    await cp
      .waitForFunction(() => {
        const d = document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-dict")?.textContent || "";
        return d.length > 0 && !d.includes("查词典中");
      }, null, { timeout: 8000 })
      .catch(() => {});
    const s3 = await cardState();
    check("C3 点在单词上：弹出这个词的卡片", s3.open && s3.word === "careful", `${s3.open} ${s3.word}`);

    // 侧栏固定在右侧 380px，点「行尾右边」会点在侧栏上；这里改点左边页边距
    const c4x = short.left - 20, c4y = (short.top + short.bottom) / 2;
    await cp.mouse.click(c4x, c4y);
    await cp.waitForTimeout(500);
    const c4 = await cardState();
    const c4at = await cp.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el ? `${el.tagName}#${el.id}` : "null"; }, [c4x, c4y]);
    check("C4 卡片开着时点空白：卡片关掉", !c4.open, `open=${c4.open} word=${c4.word} at=${c4x},${c4y}=${c4at}`);

    const lnk = await wordPoint("lnk", "explained");
    await cp.mouse.click(lnk.x, lnk.y);
    await cp.waitForTimeout(600);
    check("C5 点链接：只跳转，不弹查词卡片", !(await cardState()).open && cp.url().endsWith("#later"), cp.url());

    const disp = await wordPoint("long", "disparate");
    await cp.mouse.dblclick(disp.x, disp.y);
    await cp.waitForFunction(() => document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-panel.on"), null, { timeout: 8000 }).catch(() => {});
    await cp.waitForFunction(() => !/查词典中/.test(document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-dict")?.textContent || "查词典中"), null, { timeout: 8000 }).catch(() => {});
    const s6 = await cardState();
    check("C6 双击选中一个词：弹出卡片", s6.open && s6.word === "disparate", `${s6.open} ${s6.word}`);
    check("C7 卡片释义里没有字面的 \\n", s6.body.length > 0 && !s6.body.includes("\\n"), s6.body.slice(0, 60));
    await cp.close();

    // ---- D. P31：插件查词 = 网站阅读页查词（侧栏 / 自动记录 / 取消 / 自动讲解 / 挂靠文章）----
    const friendId = q("select id from users where username = 'ext_friend'")[0].id;
    const PHRASE = "rehearsed quietly";

    // 假模型：把「自定义端点」指到本地测试服务器，AI 讲解走它，不碰真实模型
    {
      const d = new Database(DB);
      const put = d.prepare(
        "INSERT OR REPLACE INTO settings (user_id, key, value, updated_at) VALUES ('local', ?, ?, ?)",
      );
      for (const [k, v] of [
        ["ai.activeProvider", "custom"],
        ["ai.custom.apiKey", "fake-key"],
        ["ai.custom.model", "fake-model"],
        ["ai.custom.baseUrl", `${SITE}/v1`],
      ]) put.run(k, v, Date.now());
      d.close();
    }

    const panelOf = (page) =>
      page.evaluate(() => {
        const root = document.getElementById("rf-ext-host")?.shadowRoot;
        const panel = root?.querySelector(".rf-panel");
        const rect = panel?.getBoundingClientRect();
        const chips = panel?.querySelectorAll(".rf-ask-chip");
        return {
          on: Boolean(panel?.classList.contains("on")),
          word: panel?.querySelector(".rf-word")?.textContent?.trim() || "",
          dict: panel?.querySelector(".rf-dict")?.textContent || "",
          options: chips ? [...chips].map((b) => (b.textContent || "").trim()) : [],
          turns: [...(panel?.querySelectorAll(".rf-turn-text") ?? [])].map((e) => e.textContent || ""),
          turnHtml: panel?.querySelector(".rf-turn-text")?.innerHTML || "",
          width: rect ? Math.round(rect.width) : 0,
          left: rect ? Math.round(rect.left) : 0,
        };
      });
    /** 整页找某个词在屏幕上的点（用于点文章里的词） */
    const pointOfWord = (page, word) =>
      page.evaluate((word) => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          const n = walker.currentNode;
          if (n.parentElement?.closest("#rf-ext-host")) continue;
          const i = (n.nodeValue || "").indexOf(word);
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + word.length);
          const b = r.getBoundingClientRect();
          if (b.width <= 0) continue;
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        }
        return null;
      }, word);

    const p31 = await context.newPage();
    await p31.setViewportSize({ width: 1100, height: 850 });
    await p31.goto(`${SITE}/p31`, { waitUntil: "load" });
    await p31.waitForFunction(() => Boolean(document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-bar")), null, { timeout: 15000 });
    const layoutBefore = await p31.evaluate(() => Math.round(document.getElementById("p31a").getBoundingClientRect().width));

    // D1 单击一个词 → 侧栏打开，词条 + 词典释义都在
    const rehearsed = await pointOfWord(p31, "rehearsed");
    await p31.mouse.click(rehearsed.x, rehearsed.y);
    const d1ok = await p31
      .waitForFunction(() => {
        const p = document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-panel.on");
        const dict = p?.querySelector(".rf-dict")?.textContent || "";
        return p?.querySelector(".rf-word")?.textContent?.trim() === "rehearsed" && dict && !dict.includes("查词典中");
      }, null, { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    // 侧栏是 200ms 滑入动画，等它到位再量位置（否则量到的是还没滑进来的坐标）
    await p31
      .waitForFunction(() => {
        const p = document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-panel");
        return Boolean(p) && Math.round(p.getBoundingClientRect().left) === 1100 - 380;
      }, null, { timeout: 4000 })
      .catch(() => {});
    const d1 = await panelOf(p31);
    check(
      "D1 单击网页上的词：右侧侧栏打开，显示词条与词典释义（原形徽章也在）",
      d1ok && d1.word === "rehearsed" && d1.dict.includes("排练") && d1.dict.includes("rehearse"),
      `on=${d1.on} word=${d1.word} dict=${d1.dict.replace(/\s+/g, " ").slice(0, 60)}`,
    );

    // D2 覆盖式侧栏：宽 380，贴右边，网页布局一点没被挤
    const layoutAfter = await p31.evaluate(() => Math.round(document.getElementById("p31a").getBoundingClientRect().width));
    check(
      "D2 侧栏是覆盖式滑出的 380px 右栏，不挤压网页布局",
      d1.width === 380 && Math.abs(d1.left + d1.width - 1100) <= 1 && layoutAfter === layoutBefore,
      `宽=${d1.width} 左=${d1.left} 段落宽 ${layoutBefore}→${layoutAfter}`,
    );

    // D3 自动记录：DB 多一条 via='extension' 的 context，挂在「网页摘录」上
    const rec = q(
      `select c.id, c.user_word_id, c.prefix, c.suffix, c.quote, t.source_type, t.source_url, t.title
         from contexts c join texts t on t.id = c.text_id join user_words uw on uw.id = c.user_word_id
        where uw.user_id = ? and c.quote = ? order by c.created_at desc limit 1`,
      friendId,
      "rehearsed",
    )[0];
    check(
      "D3 点完就自动记下来：via='extension'，挂在没导入过的这个网址的网页摘录上",
      rec?.source_type === "web" && rec?.source_url === `${SITE}/p31` && Boolean(rec?.prefix) && Boolean(rec?.suffix),
      JSON.stringify(rec ? { ...rec, prefix: rec.prefix.slice(0, 20) } : null),
    );
    const vid = q("select via from contexts where id = ?", rec?.id ?? "")[0]?.via;
    check("D3b 这条记录标成 via='extension'（词库据此显示「🧩 插件」）", vid === "extension", String(vid));

    // D4 取消记录 → 这条 context 删掉；这个词没有别的记录，词条也一起删
    await p31.evaluate(() => document.getElementById("rf-ext-host").shadowRoot.querySelector(".rf-cancel").click());
    const d4closed = await p31
      .waitForFunction(() => !document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-panel.on"), null, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    const leftCtx = q("select count(*) n from contexts where id = ?", rec?.id ?? "")[0].n;
    const leftWord = q("select count(*) n from user_words where id = ?", rec?.user_word_id ?? "")[0].n;
    // 取消后网页上的高亮也要跟着消失（resync 是异步的，等一会儿）
    const hlGone = await p31
      .waitForFunction(() => document.querySelectorAll('.rf-hl[data-rf-text="rehearsed"]').length === 0, null, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    check(
      "D4 「取消记录」：侧栏关掉，这条记录和词条一起删掉，网页高亮也消失",
      d4closed && leftCtx === 0 && leftWord === 0 && hlGone,
      `关闭=${d4closed} 记录=${leftCtx} 词条=${leftWord} 高亮已清=${hlGone}`,
    );

    // D5 拖选一个词典查不到的短语 → 自动请 AI（假模型），讲完写进 contexts.ai_gloss
    const phraseRect = await p31.evaluate((phrase) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        if (n.parentElement?.closest("#rf-ext-host")) continue;
        const i = (n.nodeValue || "").indexOf(phrase);
        if (i < 0) continue;
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + phrase.length);
        const rects = [...r.getClientRects()].filter((b) => b.width > 0);
        if (!rects.length) continue;
        const first = rects[0], last = rects[rects.length - 1];
        return { x1: first.left + 2, y1: first.top + first.height / 2, x2: last.right - 2, y2: last.top + last.height / 2 };
      }
      return null;
    }, PHRASE);
    await p31.mouse.move(phraseRect.x1, phraseRect.y1);
    await p31.mouse.down();
    await p31.mouse.move(phraseRect.x2, phraseRect.y2, { steps: 15 });
    await p31.mouse.up();
    const selected = await p31
      .waitForFunction(() => {
        const p = document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-panel.on");
        return p?.querySelector(".rf-word")?.textContent?.trim() === "rehearsed quietly";
      }, null, { timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!selected) {
      // 某些环境里拖选后不会补一个 click，这里补一次（选区还在）
      await p31.evaluate((p) => {
        document.querySelector("#p31a").dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: p.x2, clientY: p.y2 }));
      }, phraseRect);
    }
    const d5on = selected || (await p31
      .waitForFunction(() => document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-panel.on .rf-word")?.textContent?.trim() === "rehearsed quietly", null, { timeout: 8000 })
      .then(() => true)
      .catch(() => false));
    await p31
      .waitForFunction(() => {
        const dict = document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-dict")?.textContent || "";
        return dict.length > 0 && !dict.includes("查词典中");
      }, null, { timeout: 8000 })
      .catch(() => {});
    const d5 = await panelOf(p31);
    check(
      "D5 拖选短语：侧栏打开，词典查不到就提示交给 AI",
      d5on && d5.word === PHRASE && d5.dict.includes("短语不在词典中"),
      `on=${d5on} word=${d5.word} dict=${d5.dict.replace(/\s+/g, " ").slice(0, 40)}`,
    );

    const aiDone = await p31
      .waitForFunction(() => {
        const t = [...(document.getElementById("rf-ext-host")?.shadowRoot?.querySelectorAll(".rf-turn-text") ?? [])]
          .map((e) => e.textContent || "")
          .join(" ");
        return t.includes("假模型") && !t.includes("生成中");
      }, null, { timeout: 25000 })
      .then(() => true)
      .catch(() => false);
    let savedGloss = null;
    for (let i = 0; i < 30 && !savedGloss; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const row = q("select ai_gloss from contexts where quote = ? order by created_at desc limit 1", PHRASE)[0];
      if (row?.ai_gloss) savedGloss = row.ai_gloss;
    }
    const d5b = await panelOf(p31);
    check(
      "D5b 词典没命中就自动请 AI：流式回答渲染在侧栏，讲完存进 contexts.ai_gloss",
      aiDone && Boolean(savedGloss) && savedGloss.includes("假模型") && d5b.turnHtml.includes("<b>"),
      `流式=${aiDone} 落库=${Boolean(savedGloss)} 长度=${savedGloss?.length ?? 0}`,
    );

    // D6 「问 AI」的选项文案与网站阅读页一字不差。
    // 这里同一句里已经问过两次（先 rehearse 再这个短语），所以会多出「只讲这个词」一项，
    // 最后三项与状态无关，顺序固定。
    const ASK_LABELS = ["这个短语在这句里什么意思", "这个词在这句里什么意思", "只讲这个词，不讲整句", "整句没看懂", "讲讲句子结构", "再给个例句"];
    const TAIL_LABELS = ["整句没看懂", "讲讲句子结构", "再给个例句"];
    const readerSrc = fs.readFileSync(path.join(ROOT, "src/components/Reader.tsx"), "utf8");
    const sameAsReader = d5b.options.every((l) => ASK_LABELS.includes(l)) && ASK_LABELS.every((l) => readerSrc.includes(`"${l}"`));
    check(
      "D6 「问 AI」选项与阅读页一致（文案逐字相同、顺序一致）",
      sameAsReader && JSON.stringify(d5b.options.slice(-3)) === JSON.stringify(TAIL_LABELS) && d5b.options.length >= 3,
      d5b.options.join(" / "),
    );

    // D7 已整篇导入过的网页：点词挂到那篇文章上，坐标必须落在段落原文里
    await article.bringToFront(); // 后台标签页收不到鼠标事件
    const imp = await pointOfWord(article, "perceives");
    await article.mouse.click(imp.x, imp.y);
    const d7on = await article
      .waitForFunction(() => document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-panel.on .rf-word")?.textContent?.trim() === "perceives", null, { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    // 侧栏一打开就先把词显示出来，记录还在路上；等词典区渲染完再查库
    await article
      .waitForFunction(() => {
        const dict = document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-dict")?.textContent || "";
        return dict.length > 0 && !dict.includes("查词典中");
      }, null, { timeout: 10000 })
      .catch(() => {});
    // 侧栏一打开就先把词显示出来，记录还在路上；等词典区渲染完再查库
    await article
      .waitForFunction(() => {
        const dict = document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-dict")?.textContent || "";
        return dict.length > 0 && !dict.includes("查词典中");
      }, null, { timeout: 10000 })
      .catch(() => {});
    const artCtx = q(
      `select c.text_id, c.start as s, c."end" as e, c.quote, t.source_type, p.content
         from contexts c join texts t on t.id = c.text_id join paragraphs p on p.id = c.paragraph_id
         join user_words uw on uw.id = c.user_word_id
        where uw.user_id = ? and c.quote = 'perceives' order by c.created_at desc limit 1`,
      friendId,
    )[0];
    check(
      "D7 已导入过的网页上点词：挂到导入的那篇文章，坐标满足 content.slice(start, end) === quote",
      d7on && artCtx?.source_type === "url" && artCtx?.text_id === importedId &&
        Boolean(artCtx?.content?.slice(artCtx.s, artCtx.e) === "perceives"),
      `面板=${d7on} 点=${imp?.x},${imp?.y} ${artCtx?.source_type ?? "无记录"} same=${artCtx?.text_id === importedId} slice=${artCtx?.content?.slice(artCtx?.s ?? 0, artCtx?.e ?? 0)}`,
    );

    // D8 词库页：插件记的有「🧩 插件」，网页摘录的来源链接是文本片段 + 新标签页
    const wordsPage = await api("/words", { cookie: friend });
    const pageHtml = wordsPage.text;
    const anchors = [...pageHtml.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].filter(([, , inner]) => inner.includes("Quiet rehearsal notes"));
    const fragAnchor = anchors.find(([, attrs]) => attrs.includes("#:~:text=") && attrs.includes('target="_blank"'));
    check(
      "D8 词库页：插件记的词带「🧩 插件」；摘录来源是 #:~:text= 文本片段链接、新标签页打开",
      pageHtml.includes("🧩") && Boolean(fragAnchor) && /#:~:text=[^"]*rehearsed%20quietly/.test(fragAnchor?.[1] ?? ""),
      `status=${wordsPage.status} 🧩=${pageHtml.includes("🧩")} 外链=${Boolean(fragAnchor)} ${(fragAnchor?.[1] ?? "").slice(0, 120)}`,
    );

    // D9 网页摘录不算「我的文本」：首页与书架接口里都不出现
    const home = await api("/", { cookie: friend });
    const shelf = await api("/api/texts", { cookie: friend });
    check(
      "D9 首页「我的文本」与书架接口都不显示网页摘录",
      !home.text.includes("Quiet rehearsal notes") &&
        !shelf.data.texts.some((t) => t.sourceType === "web") &&
        shelf.data.texts.some((t) => t.id === importedId),
      `首页出现=${home.text.includes("Quiet rehearsal notes")} 书架=${shelf.data.texts.length} 篇`,
    );
    await p31.close();

    if (process.env.SHOT_DIR) {
      await article.setViewportSize({ width: 900, height: 420 });
      await article.screenshot({ path: path.join(process.env.SHOT_DIR, "gloss-rest.png") });
      await article.locator(".rf-hl").nth(1).hover();
      await article.waitForTimeout(300);
      await article.screenshot({ path: path.join(process.env.SHOT_DIR, "gloss-hover.png") });
      await popup.setViewportSize({ width: 372, height: 300 });
      await popup.screenshot({ path: path.join(process.env.SHOT_DIR, "extension-popup.png"), fullPage: true });
    }
  }
} catch (err) {
  fail++;
  console.log("FAIL  测试中断：", err.message);
} finally {
  await context?.close().catch(() => {});
  server.kill();
  site.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
