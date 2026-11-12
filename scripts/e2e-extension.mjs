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

const site = http.createServer((req, res) => {
  const u = req.url.split("?")[0];
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
    const cardState = () =>
      cp.evaluate(() => {
        const c = document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-card");
        return { open: Boolean(c?.classList.contains("on")), word: c?.querySelector(".rf-card-head b")?.textContent || "", body: c?.querySelector(".rf-card-body")?.textContent || "" };
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
    await cp.waitForFunction(() => document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-card.on"), null, { timeout: 8000 }).catch(() => {});
    const s3 = await cardState();
    check("C3 点在单词上：弹出这个词的卡片", s3.open && s3.word === "careful", `${s3.open} ${s3.word}`);

    await cp.mouse.click(short.right - 40, (short.top + short.bottom) / 2);
    await cp.waitForTimeout(500);
    check("C4 卡片开着时点空白：卡片关掉", !(await cardState()).open);

    const lnk = await wordPoint("lnk", "explained");
    await cp.mouse.click(lnk.x, lnk.y);
    await cp.waitForTimeout(600);
    check("C5 点链接：只跳转，不弹查词卡片", !(await cardState()).open && cp.url().endsWith("#later"), cp.url());

    const disp = await wordPoint("long", "disparate");
    await cp.mouse.dblclick(disp.x, disp.y);
    await cp.waitForFunction(() => document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-card.on"), null, { timeout: 8000 }).catch(() => {});
    await cp.waitForFunction(() => !/查询中/.test(document.getElementById("rf-ext-host")?.shadowRoot?.querySelector(".rf-card-body")?.textContent || "查询中"), null, { timeout: 8000 }).catch(() => {});
    const s6 = await cardState();
    check("C6 双击选中一个词：弹出卡片", s6.open && s6.word === "disparate", `${s6.open} ${s6.word}`);
    check("C7 卡片释义里没有字面的 \\n", s6.body.length > 0 && !s6.body.includes("\\n"), s6.body.slice(0, 60));
    await cp.close();

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
