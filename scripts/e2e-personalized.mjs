/**
 * P32 个性化 AI 讲解端到端（阶段一）。
 *
 * 隔离库 + 临时端口 3135（假模型 3136），跑完删库，不碰 data/readflow.db。
 * 假模型是本地 OpenAI 兼容端点，不调用真实模型、不花钱。
 * 截图写到 .verify/personas/shots/，1440px 与 390px 各一张。
 *
 *   node scripts/e2e-personalized.mjs
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
const PORT = 3135;
const BASE = `http://127.0.0.1:${PORT}`;
const SITE_PORT = 3136;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const TMP = path.join(ROOT, ".verify", "personalized");
const DB = path.join(TMP, "readflow.db");
const SHOTS = path.join(ROOT, ".verify", "personas", "shots");
const LEGACY_ZH = fs.readFileSync(
  path.join(ROOT, "tests/unit/fixtures/ai-system-zh-before-p32.txt"),
  "utf8",
);

// P33：系统提示词末尾多了制卡建议段（有意追加），比对 P32 快照时先去掉
const stripCardRule = (p) => p.replace(/\n*【制卡建议（可选，只在最后一行）】[\s\S]*$/, "").replace(/\n+$/, "");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const q = (sql, ...args) => {
  const d = new Database(DB, { readonly: true });
  try { return d.prepare(sql).all(...args); } finally { d.close(); }
};
const dbRun = (sql, ...args) => {
  const d = new Database(DB);
  try { return d.prepare(sql).run(...args); } finally { d.close(); }
};
const nap = (ms) => new Promise((r) => setTimeout(r, ms));
/** P34：触发一次每晚整理（删掉「今天已跑过」的标记，等调度器跑完再写回） */
async function runNightly(timeout = 20000) {
  dbRun("DELETE FROM settings WHERE user_id = 'local' AND key = 'learner.nightlyRunDay'");
  for (let i = 0; i < timeout / 200; i++) {
    await nap(200);
    if (q("select 1 from settings where user_id = 'local' and key = 'learner.nightlyRunDay'").length) return true;
  }
  return false;
}

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- 假模型：记下每次请求的 messages，供断言使用 ----------
// 流式 = 讲解（沿用原来的 lastCall 语义）；非流式 = 后台生成老师笔记。
// 两类分开记，避免后台笔记调用把 lastCall 顶掉，让既有断言全部保持有效。
const modelCalls = [];
const noteCalls = [];
const FAKE_NOTE =
  "词汇量约六千，技术语境的理解强于日常词汇；常在带长定语从句的句子上卡住，偏好简短直接的解释，很少追问例句，对介词搭配不太敏感。";
// L 段用来复现「模型一直返回不合格笔记」：Markdown 会被 validateNote 拒绝
const BAD_NOTE = "**不合格的笔记**";
let badNoteMode = false;
// P34：讲解流的内容与延迟可调（测句子地图特征、测中途中止）
let explainParts = ["释义：测试", "\n假模型讲解"];
let streamDelayMs = 0;
const fake = http.createServer((req, res) => {
  if (req.url.split("?")[0] === "/v1/chat/completions") {
    let buf = "";
    req.on("data", (d) => (buf += d));
    req.on("end", async () => {
      let body = {};
      try { body = JSON.parse(buf); } catch { /* 忽略畸形请求 */ }
      const streaming = body.stream === true;
      if (!streaming) {
        noteCalls.push({ messages: body.messages ?? [], stream: false });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "fake-note",
          object: "chat.completion",
          created: 0,
          model: "fake-model",
          choices: [{ index: 0, message: { role: "assistant", content: badNoteMode ? BAD_NOTE : FAKE_NOTE }, finish_reason: "stop" }],
        }));
        return;
      }
      modelCalls.push({ messages: body.messages ?? [], stream: true });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      for (const part of explainParts) {
        if (streamDelayMs) await new Promise((r) => setTimeout(r, streamDelayMs));
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  cwd: ROOT,
  env: {
    ...process.env,
    DB_PATH: DB,
    NODE_ENV: "production",
    // P34：每晚整理在测试里「随时到点」，每秒检查一次；测试删掉 learner.nightlyRunDay 就会再跑一次
    READFLOW_NIGHTLY_HOUR: "0",
    READFLOW_NIGHTLY_INTERVAL_MS: "1000",
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const cookieOf = (res) => res.headers.get("set-cookie")?.match(/readflow_session=([^;]+)/)?.[1];
async function api(pathname, { cookie, token, method = "GET", body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = `readflow_session=${cookie}`;
  if (token !== undefined) headers["x-readflow-token"] = token;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 流式响应 */ }
  return { status: res.status, data, text, headers: res.headers };
}

async function explain(cookie, extra = {}) {
  return api("/api/explain", {
    cookie,
    method: "POST",
    body: {
      word: "artifact",
      context: "The build produced a useful artifact.",
      language: "en",
      monolingual: false,
      askKind: "auto",
      ...extra,
    },
  });
}

function lastCall() {
  return modelCalls[modelCalls.length - 1] ?? { messages: [] };
}

const shot = async (page, name, width, scrollSelector = null) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.waitForTimeout(250);
  // 设置弹窗的右栏（.st-main）是内部滚动容器，fullPage 截图只会拍到它当前滚动到的位置。
  // 需要先滚动到目标区域，否则「AI 眼中的你」在图片下方根本没进画面。
  // 每次 shot 都重设视口，所以滚动必须在 setViewportSize 之后各做一次。
  if (scrollSelector) {
    await page.evaluate((sel) => {
      document.querySelector(sel)?.scrollIntoView({ block: "start" });
    }, scrollSelector);
    await page.waitForTimeout(150);
    const inView = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const modal = document.querySelector(".st-modal");
      if (!el || !modal) return false;
      const a = el.getBoundingClientRect(), b = modal.getBoundingClientRect();
      return a.top < b.bottom && a.bottom > b.top;
    }, scrollSelector);
    check(`截图 ${name} ${width}px 已把 ${scrollSelector} 滚动到可见区域`, inView);
  }
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  const file = path.join(SHOTS, `${name}-${width}.png`);
  await page.screenshot({ path: file, fullPage: true });
  check(`截图 ${name} ${width}px 无横向溢出`, overflow.scroll <= overflow.client,
    `${overflow.scroll} > ${overflow.client} → ${file}`);
  // 390px 下弹窗右栏比新面板矮，fullPage 图只能拍到面板上半（按钮在下方可滚动处）。
  // 再存一张面板特写：把面板底部滚进视口后再截元素，保证两种宽度都能完整看到老师笔记和两个操作按钮。
  if (scrollSelector) {
    const panelFile = path.join(SHOTS, `${name}-${width}-panel.png`);
    // 390px 下整个面板比设置弹窗的右栏（.st-main）还高，元素截图必然裁掉底部，
    // 所以改成「滚到面板底部 → 截当前视口的可视矩形」：保证老师笔记下半和两个操作按钮都入画。
    await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return;
      const scroller = el.closest(".st-main") ?? el.parentElement;
      if (!scroller || scroller === el) return;
      // 滚到面板底部（而不是顶部），底部按钮才会进入可见区。
      const target = el.offsetTop + el.offsetHeight - scroller.clientHeight;
      scroller.scrollTop = Math.max(0, target);
    }, scrollSelector);
    await page.waitForTimeout(150);
    const box = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      const scroller = el?.closest(".st-main");
      if (!el || !scroller) return null;
      const r = el.getBoundingClientRect();
      const s = scroller.getBoundingClientRect();
      // 取「面板与滚动容器的交集」在视口里的矩形，就是实际能看到的部分
      const top = Math.max(r.top, s.top);
      const bottom = Math.min(r.bottom, s.bottom);
      if (bottom <= top) return null;
      return { x: Math.max(0, r.left), y: Math.max(0, top), width: Math.min(r.width, window.innerWidth), height: bottom - top };
    }, scrollSelector);
    if (box) {
      await page.screenshot({ path: panelFile, clip: box });
    } else {
      await page.locator(scrollSelector).screenshot({ path: panelFile });
    }
  }
  return file;
};

let browser;
try {
  await new Promise((resolve) => fake.listen(SITE_PORT, "127.0.0.1", resolve));
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try { await fetch(`${BASE}/api/auth/status`); up = true; } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  if (!up) throw new Error("服务器没起来:\n" + serverLog.slice(-2000));

  // ===== 账号 =====
  const setup = await fetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "p32_owner", password: "p32-owner-2026", phone: "13800138051" }),
  });
  const owner = cookieOf(setup);
  if (!owner) throw new Error("建站长失败");

  // 站点模型指向假服务
  const cfg = await api("/api/settings", {
    cookie: owner,
    method: "PUT",
    body: {
      activeProvider: "custom",
      providers: { custom: { apiKey: "fake-key-for-test", model: "fake-model", baseUrl: `${SITE}/v1` } },
    },
  });
  check("A0 假模型已生效（站点配置写回成功）", cfg.status === 200 && cfg.data?.activeProvider === "custom",
    `status=${cfg.status} provider=${cfg.data?.activeProvider}`);

  const invite = async () => (await api("/api/invites", { cookie: owner, method: "POST", body: { maxUses: 1, note: "p32" } })).data.code;
  const codeFriend = await invite();
  const codeOld = await invite();
  await api("/api/auth/register", {
    method: "POST",
    body: { inviteCode: codeOld, username: "p32_old", phone: "13800138052", password: "p32-old-2026" },
  });
  const oldCookie = cookieOf(await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "p32_old", password: "p32-old-2026" }),
  }));

  browser = await chromium.launch();

  // ===== B. 注册 → /welcome → 全部跳过 =====
  const ctxFriend = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const reg = await ctxFriend.newPage();
  await reg.goto(`${BASE}/register`, { waitUntil: "networkidle" });
  const inputs = reg.locator("form input");
  await inputs.nth(0).fill(codeFriend);
  await inputs.nth(1).fill("p32_friend");
  await inputs.nth(2).fill("13800138053");
  await inputs.nth(3).fill("p32-friend-2026");
  await inputs.nth(4).fill("p32-friend-2026");
  await reg.getByRole("button", { name: "注册并进入" }).click();
  const jumped = await reg.waitForURL(/\/welcome/, { timeout: 10000 }).then(() => true).catch(() => false);
  check("B1 邀请码注册成功后自动跳到 /welcome", jumped, `url=${reg.url()}`);
  await shot(reg, "welcome", 1440);
  await shot(reg, "welcome", 390);
  await reg.getByRole("button", { name: "以后再说" }).click();
  const home = await reg.waitForURL((u) => u.pathname === "/", { timeout: 10000 }).then(() => true).catch(() => false);
  check("B2 全部跳过也能进首页，首页不再出现提示卡片",
    home && !(await reg.locator(".rf-survey-prompt").count()),
    `url=${reg.url()} 卡片=${await reg.locator(".rf-survey-prompt").count()}`);
  const friendCookie = (await reg.context().cookies()).find((c) => c.name === "readflow_session")?.value;
  const friendLearner = await api("/api/learner", { cookie: friendCookie });
  check("B3 跳过后 needsSurvey 变为 false", friendLearner.data?.needsSurvey === false,
    `needsSurvey=${friendLearner.data?.needsSurvey}`);
  await ctxFriend.close();

  // ===== C. 老用户首页卡片 =====
  const ctxOld = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctxOld.addCookies([{ name: "readflow_session", value: oldCookie, domain: "127.0.0.1", path: "/" }]);
  const oldPage = await ctxOld.newPage();
  await oldPage.goto(BASE, { waitUntil: "networkidle" });
  const cardBefore = await oldPage.locator(".rf-survey-prompt").count();
  const cardStyle = await oldPage.locator(".rf-survey-prompt").evaluate((el) => ({
    padding: getComputedStyle(el).paddingLeft,
    linkClass: el.querySelector("a")?.className ?? "",
  }));
  check("C0 提示卡片有内边距，且「去填写」带基础的 .duo-btn 类",
    parseFloat(cardStyle.padding) >= 16 && /(^|\s)duo-btn(\s|$)/.test(cardStyle.linkClass),
    `padding=${cardStyle.padding} class=${cardStyle.linkClass}`);

  // A 修复的「修复前」对照图：在同一个页面上把 DOM 还原成旧状态再截，随后 reload 恢复
  await oldPage.evaluate(() => {
    const card = document.querySelector(".rf-survey-prompt");
    const link = card?.querySelector("a");
    if (card) card.style.padding = "0";
    if (link) link.className = "duo-btn-sm duo-btn-white";
  });
  for (const w of [1440, 390]) {
    await oldPage.setViewportSize({ width: w, height: 900 });
    await oldPage.screenshot({ path: path.join(SHOTS, `home-prompt-${w}-before.png`), fullPage: true });
  }
  await oldPage.reload({ waitUntil: "networkidle" });
  await shot(oldPage, "home-prompt", 1440);
  await shot(oldPage, "home-prompt", 390);
  await oldPage.getByRole("button", { name: "关闭提示" }).click();
  await oldPage.reload({ waitUntil: "networkidle" });
  const cardAfter = await oldPage.locator(".rf-survey-prompt").count();
  check("C1 老用户首页出现提示卡片，点 × 后不再出现", cardBefore === 1 && cardAfter === 0,
    `before=${cardBefore} after=${cardAfter}`);
  await ctxOld.close();

  // ===== D. 问卷 → 画像交给模型 =====
  const ctxOwner = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctxOwner.addCookies([{ name: "readflow_session", value: owner, domain: "127.0.0.1", path: "/" }]);
  const ownerPage = await ctxOwner.newPage();
  await ownerPage.goto(`${BASE}/welcome?next=/`, { waitUntil: "networkidle" });
  // 问卷是表单控件：单选用下拉框，阅读目的用复选框
  await ownerPage.locator("#survey-identity").selectOption({ label: "已工作 3–10 年" });
  await ownerPage.locator("#survey-exam").selectOption({ label: "大学英语六级" });
  await ownerPage.locator("#survey-examScore").selectOption({ label: "550 以上" });
  await ownerPage.getByLabel("技术文档和编程").check();
  await ownerPage.locator("#survey-readingFeel").selectOption({ label: "偶尔查个生词" });
  await ownerPage.locator("#survey-stylePref").selectOption({ label: "越简洁越好，点到为止" });
  await ownerPage.getByRole("button", { name: "开始阅读" }).click();
  await ownerPage.waitForURL((u) => u.pathname === "/", { timeout: 10000 }).catch(() => {});
  const ownerLearner = await api("/api/learner", { cookie: owner });
  check("D1 问卷保存成功，needsSurvey 变假，水平与阅读目的可读",
    ownerLearner.data?.needsSurvey === false &&
    ownerLearner.data?.survey?.exam === "cet6" &&
    ownerLearner.data?.survey?.goals?.includes("tech") &&
    ownerLearner.data?.level?.cefr != null,
    `survey=${JSON.stringify(ownerLearner.data?.survey)} level=${JSON.stringify(ownerLearner.data?.level)}`);

  const explainOn = await explain(owner);
  const sysOn = lastCall().messages[0]?.content ?? "";
  const userOn = lastCall().messages[1]?.content ?? "";
  check("D2 开关 on：system 换成 L1–L4 深度指引，user 消息最前面带学生档案",
    sysOn.includes("L1 只给这句里的意思") &&
    userOn.startsWith("学生档案（") &&
    userOn.includes("主要阅读：技术文档和编程") &&
    userOn.includes("希望讲解：越简洁越好"),
    `sys=${sysOn.includes("L1")} user=${userOn.slice(0, 60)}`);
  // 六级 550+ = 7500 × 偶尔 1.15 × 工作 3–10 年+技术 1.1 = 9487 → C1
  check("D3 画像里的水平来自问卷换算表（C1）", userOn.includes("估计水平：C1"),
    userOn.split("\n").find((l) => l.includes("估计水平")) ?? "无");
  const answerId = explainOn.headers.get("x-rf-answer-id");
  const ev = q("select id, ask_kind, via from explain_events where id = ?", answerId ?? "");
  check("D4 响应头有 X-RF-Answer-Id，且事件落库（ask_kind=auto / via=reader）",
    Boolean(answerId) && ev.length === 1 && ev[0].ask_kind === "auto" && ev[0].via === "reader",
    `id=${answerId} 事件=${JSON.stringify(ev)}`);

  // 插件链路：Token 认证、同样带档案、via=extension、CORS 暴露响应头
  const regen = await api("/api/settings", { cookie: owner, method: "PUT", body: { regenerateExtensionToken: true } });
  const token = regen.data?.newExtensionToken;
  const ext = await api("/api/extension/explain", {
    token,
    method: "POST",
    body: { word: "artifact", context: "The build produced a useful artifact.", askKind: "auto" },
  });
  const extUser = lastCall().messages[1]?.content ?? "";
  const extId = ext.headers.get("x-rf-answer-id");
  const extEv = q("select via from explain_events where id = ?", extId ?? "");
  check("D5 插件 Token 讲解同样带档案，via=extension，响应头可读",
    ext.status === 200 && extUser.includes("学生档案（") && extEv[0]?.via === "extension" &&
    (ext.headers.get("access-control-expose-headers") ?? "").includes("X-RF-Answer-Id"),
    `status=${ext.status} via=${extEv[0]?.via} expose=${ext.headers.get("access-control-expose-headers")}`);

  // ===== E. 开关与权限 =====
  const off = await api("/api/settings", { cookie: owner, method: "PUT", body: { aiPersonalized: "off" } });
  await explain(owner);
  const sysOff = lastCall().messages[0]?.content ?? "";
  const userOff = lastCall().messages[1]?.content ?? "";
  check("E1 站长关闭开关后，system 与 P32 改动前逐字相同，user 不再带档案",
    off.status === 200 && off.data?.aiPersonalized === "off" &&
    stripCardRule(sysOff) === LEGACY_ZH.replace(/\n+$/, "") && !userOff.includes("学生档案"),
    `status=${off.status} sysSame=${stripCardRule(sysOff) === LEGACY_ZH.replace(/\n+$/, "")} hasBlock=${userOff.includes("学生档案")}`);
  const offWelcome = await api("/api/learner", { cookie: oldCookie });
  check("E2 开关关闭不影响问卷收集（问卷数据照常读得到）", offWelcome.status === 200,
    `status=${offWelcome.status} personalized=${offWelcome.data?.personalized}`);
  const forbidden = await api("/api/settings", { cookie: friendCookie, method: "PUT", body: { aiPersonalized: "on" } });
  check("E3 非站长发送 aiPersonalized 返回 403", forbidden.status === 403, `status=${forbidden.status}`);
  await api("/api/settings", { cookie: owner, method: "PUT", body: { aiPersonalized: "on" } });

  // 环境变量强制关闭：重启太重，这里只断言纯函数（单测已覆盖），接口层保持设置值

  // ===== E+. 「同句第几次」：有档案时不再出现，没有档案时作为兜底 =====
  const REPEAT_SIGNALS = { source: "word", position: "middle", selectionWords: 1, sentenceWords: 7, coverage: 0.15, sentence: "The build produced a useful artifact.", sentenceStart: 0, sentenceEnd: 37, repeatCount: 2, priorAsks: [{ selection: "build" }] };
  await explain(owner, { signals: REPEAT_SIGNALS });
  const sysHas = lastCall().messages[0]?.content ?? "";
  const userHas = lastCall().messages[1]?.content ?? "";
  check("E4 有档案（填过问卷）：提示词和观察里都没有「同句第几次」，之前问过的选区仍保留",
    userHas.startsWith("学生档案（") && !userHas.includes("同句连续请教") && userHas.includes("之前问过的选区") &&
    !sysHas.includes("同句连续请教") && !sysHas.includes("第 2 次请教") && !sysHas.includes("同句已问过 ≥2 次时"),
    `观察含次数=${userHas.includes("同句连续请教")} 系统含次数=${sysHas.includes("同句连续请教")}`);
  // 朋友：跳过了问卷、也没有查词记录 → 没有可依据的档案 → 这次请求按个性化关闭处理（旧规则兜底）
  await explain(friendCookie, { signals: REPEAT_SIGNALS });
  const sysNo = lastCall().messages[0]?.content ?? "";
  const userNo = lastCall().messages[1]?.content ?? "";
  check("E5 没有档案（跳过问卷、无查词记录）：退回旧规则——提示词与 P32 前逐字相同，观察里带「同句连续请教: 第 2 次」",
    stripCardRule(sysNo) === LEGACY_ZH.replace(/\n+$/, "") && !userNo.includes("学生档案") && userNo.includes("同句连续请教: 第 2 次"),
    `系统相同=${stripCardRule(sysNo) === LEGACY_ZH.replace(/\n+$/, "")} 含档案=${userNo.includes("学生档案")} 含次数=${userNo.includes("同句连续请教: 第 2 次")}`);

  // ===== F. 设置 →「学习档案」面板截图 =====
  await ownerPage.goto(BASE, { waitUntil: "networkidle" });
  await ownerPage.click(".pm-trigger");
  await ownerPage.getByRole("menuitem", { name: /设置/ }).click();
  await ownerPage.getByRole("button", { name: "学习档案" }).click();
  await ownerPage.waitForTimeout(500);
  check("F1 设置里能打开「学习档案」并看到问卷与反馈开关",
    (await ownerPage.locator(".st-panel-title", { hasText: "我的情况" }).count()) === 1 &&
    (await ownerPage.getByRole("switch", { name: /太浅/ }).count()) === 1);
  await shot(ownerPage, "learner-settings", 1440);
  await shot(ownerPage, "learner-settings", 390);

  // ===== G. 阶段二：行为推断 + 反馈行 =====
  const doc = await api("/api/texts", {
    cookie: owner,
    method: "POST",
    body: {
      title: "P32 feedback text",
      text: "The artifact was stored in a quiet archive. A careful engineer will scrutinize the deployment pipeline twice.",
      format: "plain",
    },
  });
  const textId = doc.data?.id;
  const para = q("select id, content from paragraphs where text_id = ? order by idx", textId)[0];
  const at = String(para?.content ?? "").toLowerCase().indexOf("artifact");
  check("G0 导入测试文章成功", Boolean(textId) && at >= 0, `textId=${textId} at=${at}`);
  const anchorBody = {
    word: "artifact", textId, paragraphId: para.id, quote: "artifact",
    start: at, end: at + 8,
    prefix: para.content.slice(0, at), suffix: para.content.slice(at + 8),
  };
  for (let i = 0; i < 30; i++) {
    await api("/api/contexts/ensure", { cookie: owner, method: "POST", body: anchorBody });
  }
  // 画像缓存 6 小时：清掉缓存让它按新事件重算（测试库内直接改，文档 §8.3 场景 7 同法）
  {
    const d = new Database(DB);
    d.prepare("UPDATE learner_profiles SET stats = NULL, stats_updated_at = NULL WHERE user_id = (SELECT id FROM users WHERE username = 'p32_owner')").run();
    d.close();
  }
  const learner2 = await api("/api/learner", { cookie: owner });
  check("G1 30 次查词后给出行为推断，依据写着「最近 30 次查词」",
    learner2.data?.stats?.lookups === 30 && /最近 30 次查词/.test(learner2.data?.level?.basisText ?? ""),
    `lookups=${learner2.data?.stats?.lookups} basis=${learner2.data?.level?.basisText}`);
  const lookupEvents = q("select count(*) n from explain_events where kind = 'lookup' and text_id = ?", textId)[0].n;
  check("G2 查词事件带 text_id / context_id，且归属本人", lookupEvents === 30,
    `事件=${lookupEvents}`);

  // 客户端伪造别人的 textId / 不存在的 contextId：写入前必须被换成 null
  const otherDoc = await api("/api/texts", {
    cookie: oldCookie, method: "POST",
    body: { title: "别人的文章", text: "Another artifact is here.", format: "plain" },
  });
  const forged = await explain(owner, { textId: otherDoc.data?.id, contextId: "not-a-real-context" });
  const forgedId = forged.headers.get("x-rf-answer-id");
  const forgedRow = q("select text_id, context_id from explain_events where id = ?", forgedId ?? "")[0];
  check("G3 contextId / textId 不属于本人时存 null",
    Boolean(forgedRow) && forgedRow.text_id === null && forgedRow.context_id === null,
    JSON.stringify(forgedRow));

  // 阅读页：点词 → 问 AI → 反馈行
  await ownerPage.setViewportSize({ width: 1440, height: 900 });
  await ownerPage.goto(`${BASE}/texts/${textId}`, { waitUntil: "load" });
  await ownerPage.waitForTimeout(900);
  const rect = await ownerPage.evaluate(() => {
    const el = [...document.querySelectorAll("[data-pid] .w")].find((e) => e.textContent.trim() === "artifact");
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    return el.getBoundingClientRect().toJSON();
  });
  check("G4 阅读页已 hydrate，能定位到测试词", Boolean(rect), JSON.stringify(rect));
  if (rect) {
    await ownerPage.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await ownerPage.waitForTimeout(1200);
    await ownerPage.locator('.reader-note button:has-text("问 AI")').click();
    await ownerPage.locator(".rf-ask-chip").first().click();
    const feedbackVisible = await ownerPage
      .waitForSelector(".reader-note .rf-feedback-row", { timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    check("G5 完成的讲解下面显示「这次讲得：太浅 · 刚好 · 太深」",
      feedbackVisible && (await ownerPage.locator(".reader-note .rf-feedback-btn").count()) === 3,
      `可见=${feedbackVisible}`);
    await shot(ownerPage, "feedback-unrated", 1440);
    await shot(ownerPage, "feedback-unrated", 390);

    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    await ownerPage.locator('.reader-note .rf-feedback-btn:has-text("太深")').click();
    await ownerPage.waitForTimeout(600);
    const deepRows = q("select id, feedback from explain_events where feedback = 'deep'");
    check("G6 点「太深」写进 explain_events", deepRows.length >= 1, JSON.stringify(deepRows.slice(-1)));
    await ownerPage.locator('.reader-note .rf-feedback-btn:has-text("刚好")').click();
    await ownerPage.waitForTimeout(600);
    const rightRows = q("select id, feedback from explain_events where feedback = 'right'");
    check("G7 改选「刚好」覆盖同一个 answerId",
      rightRows.length >= 1 && q("select feedback from explain_events where id = ?", rightRows.at(-1)?.id)[0]?.feedback === "right" &&
      q("select count(*) n from explain_events where feedback = 'deep'")[0].n === 0,
      `right=${rightRows.length} deep=${q("select count(*) n from explain_events where feedback = 'deep'")[0].n}`);
    const fbState = await ownerPage.evaluate(() => {
      const btns = [...document.querySelectorAll(".reader-note .rf-feedback-btn")];
      const on = btns.filter((b) => b.getAttribute("aria-pressed") === "true");
      const cs = on[0] ? getComputedStyle(on[0]) : null;
      return {
        on: on.map((b) => b.textContent.trim()),
        check: on[0]?.querySelector(".rf-feedback-check")?.textContent ?? null,
        color: cs?.color,
        checks: document.querySelectorAll(".reader-note .rf-feedback-check").length,
      };
    });
    check("G7b 选中的反馈变绿（#3f7f00）并在前面出现「✓」，其它两个没有勾",
      fbState.on.join() === "✓刚好" && fbState.check === "✓" && fbState.color === "rgb(63, 127, 0)" && fbState.checks === 1, JSON.stringify(fbState));
    await shot(ownerPage, "feedback-rated", 1440);
    await shot(ownerPage, "feedback-rated", 390);
    await ownerPage.setViewportSize({ width: 1440, height: 900 });
    const feedbackId = rightRows.at(-1)?.id;
    const forbiddenFeedback = await api("/api/explain/feedback", {
      cookie: friendCookie, method: "POST", body: { answerId: feedbackId, rating: "shallow" },
    });
    check("G8 别人的 answerId 反馈返回 404", forbiddenFeedback.status === 404,
      `status=${forbiddenFeedback.status}`);

    // P34 F4：回看时反馈行照常显示，保留当时的选择（刚好），而且可以改
    const answerRow = q("select context_id, answer_text from explain_answers where event_id = ?", feedbackId ?? "")[0];
    check("G7c 讲解结束后存下了回答原文，并对上了批注",
      Boolean(answerRow?.context_id) && String(answerRow?.answer_text).includes("假模型讲解"), JSON.stringify(answerRow));
    await ownerPage.reload({ waitUntil: "load" });
    await ownerPage.waitForTimeout(900);
    const rectR = await ownerPage.evaluate(() => {
      const el = [...document.querySelectorAll("[data-pid] .w")].find((e) => e.textContent.trim() === "artifact");
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      return el.getBoundingClientRect().toJSON();
    });
    if (rectR) {
      await ownerPage.mouse.click(rectR.x + rectR.width / 2, rectR.y + rectR.height / 2);
      const recallRow = await ownerPage.waitForSelector(".reader-note .rf-feedback-row", { timeout: 8000 }).then(() => true).catch(() => false);
      const pressed = await ownerPage.evaluate(() =>
        [...document.querySelectorAll(".reader-note .rf-feedback-btn[aria-pressed=true]")].map((b) => b.textContent.trim()));
      check("G7d 回看：反馈行照常显示，保留当时选的「✓刚好」", recallRow && pressed.join() === "✓刚好", `可见=${recallRow} 选中=${pressed}`);
      await shot(ownerPage, "feedback-recall", 1440);
      await shot(ownerPage, "feedback-recall", 390);
      await ownerPage.setViewportSize({ width: 1440, height: 900 });
      await ownerPage.locator('.reader-note .rf-feedback-btn:has-text("太浅")').click();
      await ownerPage.waitForTimeout(600);
      check("G7e 回看时可以改选：改成「太浅」后库里被覆盖",
        q("select feedback from explain_events where id = ?", feedbackId ?? "")[0]?.feedback === "shallow");
    }

    // 关掉本人开关后，重新问一次也不再显示反馈行
    await api("/api/learner", { cookie: owner, method: "PUT", body: { showFeedback: false } });
    await ownerPage.reload({ waitUntil: "load" });
    await ownerPage.waitForTimeout(900);
    const rect2 = await ownerPage.evaluate(() => {
      const el = [...document.querySelectorAll("[data-pid] .w")].find((e) => e.textContent.trim() === "artifact");
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      return el.getBoundingClientRect().toJSON();
    });
    if (rect2) {
      await ownerPage.mouse.click(rect2.x + rect2.width / 2, rect2.y + rect2.height / 2);
      await ownerPage.waitForTimeout(1200);
      await ownerPage.locator('.reader-note button:has-text("问 AI")').click();
      await ownerPage.locator(".rf-ask-chip").first().click();
      await ownerPage.waitForFunction(
        () => (document.querySelector(".reader-note .rf-md")?.textContent ?? "").includes("假模型讲解"),
        null, { timeout: 12000 },
      ).catch(() => {});
      check("G9 关闭「讲解下方显示反馈行」后不再出现", (await ownerPage.locator(".reader-note .rf-feedback-row").count()) === 0);
    }
    await api("/api/learner", { cookie: owner, method: "PUT", body: { showFeedback: true } });
  }

  // ================= H. P34：每晚整理老师笔记（新动静攒够 10 次） =================
  const ownerId = q("select id from users where username = 'p32_owner'")[0].id;
  const profile = () => q("select * from learner_profiles where user_id = ?", ownerId)[0];
  const update = dbRun;
  const sleep = nap;
  /** 让每晚整理只可能选中这一个用户：其他人的「上次整理」挪到 10 年后，新动静就是 0 */
  const onlyEligible = (userId) => {
    update("INSERT OR IGNORE INTO learner_profiles (user_id, updated_at) SELECT id, ? FROM users", Date.now());
    update("UPDATE learner_profiles SET note_updated_at = ? WHERE user_id != ?", Date.now() + 10 * 365 * 86400_000, userId);
  };
  onlyEligible(ownerId);

  // 上一份笔记是 25 小时前写的；G 段之后又有 30 次查词 → 新动静 ≥ 10
  const OLD_NOTE = "旧的观察：常查长句，喜欢简短解释。";
  update(
    `UPDATE learner_profiles SET note = ?, note_updated_at = ?, note_update_kind = 'nightly',
       note_user_edited = 0, note_last_error = NULL, stats = NULL, stats_updated_at = NULL
     WHERE user_id = ?`,
    OLD_NOTE, Date.now() - 25 * 3600 * 1000, ownerId,
  );
  const newEventsBefore = q(
    "select count(*) n from explain_events where user_id = ? and created_at > ?", ownerId, profile().note_updated_at,
  )[0].n;
  check("H0 前置：自上次整理以来新动静 ≥ 10", newEventsBefore >= 10, `新动静=${newEventsBefore}`);

  const usageBefore = q("select coalesce(sum(count),0) n from daily_usage where kind = 'ai' and user_id = ?", ownerId)[0].n;
  const noteCallsBefore = noteCalls.length;
  const explainCallsBefore = modelCalls.length;
  const ranH = await runNightly();
  const hRow = profile();
  check("H1 每晚整理改写了老师笔记（改写而非追加），长度 ≤300 字",
    ranH && Boolean(hRow.note) && hRow.note !== OLD_NOTE && hRow.note.length <= 300 && !hRow.note.includes(OLD_NOTE),
    `跑完=${ranH} 长度=${hRow.note?.length} 内容=${String(hRow.note).slice(0, 28)}`);
  check("H2 来源记为 nightly、错误清空、用户编辑标记归 0",
    hRow.note_update_kind === "nightly" && hRow.note_last_error === null && hRow.note_user_edited === 0 && hRow.note_updated_at > Date.now() - 60_000,
    `kind=${hRow.note_update_kind} err=${hRow.note_last_error} edited=${hRow.note_user_edited}`);
  const noteSystem = noteCalls.at(-1)?.messages?.[0]?.content ?? "";
  const noteUser = noteCalls.at(-1)?.messages?.[1]?.content ?? "";
  check("H3 整理走非流式调用；提示词写明不列单词、以统计为准、每晚整理、来自所有文章，并带「带回答的反馈」一节",
    noteCalls.length > noteCallsBefore && noteCalls.at(-1)?.stream === false &&
    noteSystem.includes("不要列出具体单词") && noteSystem.includes("以统计数据为准") &&
    noteSystem.includes("每晚整理") && noteSystem.includes("所有文章") && noteUser.includes("【带回答的反馈"),
    `笔记调用=${noteCalls.length - noteCallsBefore}`);
  const usageAfter = q("select coalesce(sum(count),0) n from daily_usage where kind = 'ai' and user_id = ?", ownerId)[0].n;
  const noteGenSrc = fs.readFileSync(path.join(ROOT, "src/lib/note-generator.ts"), "utf8");
  check("H4 整理笔记不扣每日免费 AI 次数，也不走讲解（无流式调用），源码没有调用扣额度函数",
    usageAfter === usageBefore && modelCalls.length === explainCallsBefore &&
    !/consumeAiQuota\s*\(/.test(noteGenSrc) && !/from\s+["'][^"']*ai-quota/.test(noteGenSrc),
    `ai 次数 ${usageBefore} → ${usageAfter}`);
  const hLearner = await api("/api/learner", { cookie: owner });
  check("H5 GET /api/learner 返回笔记全文、更新时间与来源 nightly",
    hLearner.data?.note === hRow.note && typeof hLearner.data?.noteUpdatedAt === "number" && hLearner.data?.noteUpdateKind === "nightly",
    `kind=${hLearner.data?.noteUpdateKind}`);

  // 门槛：刚整理完再加 9 次查词 → 不整理；第 10 次后才整理
  {
    const d = new Database(DB);
    const ins = d.prepare("INSERT INTO explain_events (id, user_id, kind, via, word, created_at) VALUES (?, ?, 'lookup', 'reader', 'artifact', ?)");
    d.transaction(() => { for (let i = 0; i < 9; i++) ins.run(`h8-lookup-${i}`, ownerId, Date.now() + 1000 + i); })();
    d.close();
  }
  const callsBefore9 = noteCalls.length;
  const at9 = profile().note_updated_at;
  await runNightly();
  check("H8 新动静只有 9 次：当晚不整理（不调用模型，笔记时间不变）",
    noteCalls.length === callsBefore9 && profile().note_updated_at === at9, `调用=${noteCalls.length - callsBefore9}`);
  update("INSERT INTO explain_events (id, user_id, kind, via, word, created_at) VALUES ('h8-lookup-9', ?, 'lookup', 'reader', 'artifact', ?)", ownerId, Date.now() + 2000);
  const waiting = (await api("/api/learner", { cookie: owner })).data?.noteReason;
  await runNightly();
  check("H9 攒够第 10 次后整理", noteCalls.length === callsBefore9 + 1 && profile().note_updated_at > at9, `调用=${noteCalls.length - callsBefore9} reason=${JSON.stringify(waiting)}`);

  // 普通账号（用站点 Key）：整理笔记不扣他的免费额度
  const friendId = q("select id from users where username = 'p32_friend'")[0].id;
  {
    const d = new Database(DB);
    const ins = d.prepare(
      "INSERT INTO explain_events (id, user_id, kind, via, word, created_at) VALUES (?, ?, 'lookup', 'reader', 'artifact', ?)",
    );
    d.transaction(() => {
      for (let i = 0; i < 25; i++) ins.run(`h4b-lookup-${i}`, friendId, Date.now() - i * 1000);
    })();
    d.close();
  }
  update("UPDATE learner_profiles SET note_updated_at = NULL WHERE user_id = ?", friendId);
  onlyEligible(friendId);
  const usageFBefore = q("select coalesce(sum(count),0) n from daily_usage where kind = 'ai' and user_id = ?", friendId)[0].n;
  const noteCallsFBefore = noteCalls.length;
  await runNightly();
  const friendNote = q("select note from learner_profiles where user_id = ?", friendId)[0]?.note ?? null;
  const usageFAfter = q("select coalesce(sum(count),0) n from daily_usage where kind = 'ai' and user_id = ?", friendId)[0].n;
  check("H4b 普通账号的笔记由每晚整理生成，不扣他的免费额度",
    Boolean(friendNote) && noteCalls.length > noteCallsFBefore && usageFAfter === usageFBefore,
    `笔记=${Boolean(friendNote)} 笔记调用=${noteCalls.length - noteCallsFBefore} 额度增量=${usageFAfter - usageFBefore}`);

  // 站点没配模型：不生成、不写错误、返回 no_model
  update("DELETE FROM settings WHERE key = 'ai.custom.apiKey'");
  update(
    `UPDATE learner_profiles SET note = NULL, note_updated_at = NULL, note_update_kind = NULL,
       note_last_error = NULL WHERE user_id = ?`, ownerId,
  );
  const noModelLearner = await api("/api/learner", { cookie: owner });
  check("H6 站点没配模型时 GET /api/learner 返回原因 no_model",
    noModelLearner.data?.noteReason === "no_model", JSON.stringify(noModelLearner.data?.noteReason));
  const callsBeforeNoModel = noteCalls.length;
  update("UPDATE learner_profiles SET note_updated_at = NULL WHERE user_id = ?", ownerId);
  onlyEligible(ownerId);
  update("UPDATE learner_profiles SET note_updated_at = NULL WHERE user_id = ?", ownerId);
  await runNightly();
  const afterNoModel = profile();
  check("H7 站点没配模型时不生成笔记，也不写 note_last_error",
    afterNoModel.note === null && afterNoModel.note_last_error === null &&
    noteCalls.length === callsBeforeNoModel,
    `note=${afterNoModel.note} err=${afterNoModel.note_last_error} 调用=${noteCalls.length - callsBeforeNoModel}`);
  await api("/api/settings", {
    cookie: owner, method: "PUT",
    body: {
      activeProvider: "custom",
      providers: { custom: { apiKey: "fake-key-for-test", model: "fake-model", baseUrl: `${SITE}/v1` } },
    },
  });

  // ================= I. 场景 8：编辑笔记 + 清空 AI 记忆 =================
  const CUSTOM_NOTE = "我自己改的观察：偏好一句话讲完，别展开语法。";
  const putNote = await api("/api/learner", { cookie: owner, method: "PUT", body: { note: CUSTOM_NOTE } });
  check("I1 编辑笔记保存成功，note_user_edited = 1",
    putNote.status === 200 && putNote.data?.note === CUSTOM_NOTE && profile().note_user_edited === 1,
    `status=${putNote.status} edited=${profile().note_user_edited}`);
  const badNote = await api("/api/learner", { cookie: owner, method: "PUT", body: { note: "**加粗笔记**" } });
  check("I2 带 Markdown 的笔记被拒绝（400），原笔记不变",
    badNote.status === 400 && profile().note === CUSTOM_NOTE, `status=${badNote.status}`);
  await explain(owner);
  const userWithNote = lastCall().messages[1]?.content ?? "";
  check("I3 下一次讲解的学生档案里带着用户改过的笔记（作为参考保留）",
    userWithNote.includes("- 老师笔记：") && userWithNote.includes(CUSTOM_NOTE),
    userWithNote.split("\n").find((l) => l.includes("老师笔记")) ?? "无");

  // 新界面截图（1440px / 390px）：带老师笔记的「AI 眼中的你」，shot() 会断言无横向溢出
  await ownerPage.setViewportSize({ width: 1440, height: 900 });
  await ownerPage.goto(BASE, { waitUntil: "networkidle" });
  await ownerPage.click(".pm-trigger");
  await ownerPage.getByRole("menuitem", { name: /设置/ }).click();
  await ownerPage.getByRole("button", { name: "学习档案" }).click();
  await ownerPage.waitForTimeout(700);
  check("I3a 「AI 眼中的你」渲染出可编辑的笔记块与两个操作按钮",
    (await ownerPage.locator("#st-learner-ai-view .rf-learner-note").count()) === 1 &&
    (await ownerPage.getByRole("button", { name: "这不准确" }).count()) === 1 &&
    (await ownerPage.getByRole("button", { name: "清空 AI 记忆" }).count()) === 1);
  const noteBg = await ownerPage.locator("#st-learner-ai-view .rf-learner-note")
    .evaluate((el) => getComputedStyle(el).backgroundColor);
  check("I3b 笔记块用紫色系底色 --rf-ai-soft（rgb 245,236,255）",
    noteBg === "rgb(245, 236, 255)", noteBg);
  await shot(ownerPage, "learner-ai-view", 1440, "#st-learner-ai-view");
  await shot(ownerPage, "learner-ai-view", 390, "#st-learner-ai-view");
  const metaText = () => ownerPage.locator("#st-learner-ai-view .rf-note-meta").innerText().catch(() => "");
  check("I3c 用户改过的笔记下方写「你修改过 · AI 老师整理时会参考这段内容」",
    (await metaText()) === "你修改过 · AI 老师整理时会参考这段内容", await metaText());
  // 把来源换成「每晚整理」、时间设成今天上海时间 03:00，重新打开面板
  {
    const shDay = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
    const at3 = Date.parse(`${shDay}T03:00:00+08:00`);
    update("UPDATE learner_profiles SET note_update_kind = 'nightly', note_updated_at = ? WHERE user_id = ?", at3, ownerId);
  }
  await ownerPage.locator(".st-head .st-close").click();
  await ownerPage.click(".pm-trigger");
  await ownerPage.getByRole("menuitem", { name: /设置/ }).click();
  await ownerPage.getByRole("button", { name: "学习档案" }).click();
  await ownerPage.waitForTimeout(700);
  check("I3d 每晚整理的笔记下方写「每晚整理 · 今天 03:00」", (await metaText()) === "每晚整理 · 今天 03:00", await metaText());
  await shot(ownerPage, "learner-note-meta", 1440, "#st-learner-ai-view");
  await shot(ownerPage, "learner-note-meta", 390, "#st-learner-ai-view");
  // 关掉设置弹窗，后面 J/K 段要用阅读页
  await ownerPage.locator(".st-head .st-close").click();
  await ownerPage.waitForTimeout(200);

  const eventsBefore = q("select count(*) n from explain_events")[0].n;
  const resetRes = await api("/api/learner/reset", { cookie: owner, method: "POST" });
  const afterReset = profile();
  check("I4 清空 AI 记忆：笔记与推断缓存清空、游标归零、重置时间前移",
    resetRes.status === 200 && resetRes.data?.ok === true &&
    afterReset.note === null && afterReset.stats === null && afterReset.note_lookup_cursor === 0 &&
    afterReset.memory_reset_at > 0,
    `note=${afterReset.note} stats=${afterReset.stats} cursor=${afterReset.note_lookup_cursor} resetAt=${afterReset.memory_reset_at}`);
  check("I5 清空不删查词记录（explain_events 条数不变）",
    q("select count(*) n from explain_events")[0].n === eventsBefore,
    `${eventsBefore} → ${q("select count(*) n from explain_events")[0].n}`);
  const learnerAfterReset = await api("/api/learner", { cookie: owner });
  check("I6 清空后水平依据不再引用历史查词，从问卷重新开始",
    !/最近 \d+ 次查词/.test(learnerAfterReset.data?.level?.basisText ?? "") &&
    learnerAfterReset.data?.note === null,
    `basis=${learnerAfterReset.data?.level?.basisText}`);
  await explain(owner);
  const userAfterReset = lastCall().messages[1]?.content ?? "";
  check("I7 清空后下一次讲解的档案里不再有旧笔记内容",
    !userAfterReset.includes(CUSTOM_NOTE) && !userAfterReset.includes(FAKE_NOTE) &&
    !userAfterReset.includes("- 老师笔记："),
    userAfterReset.slice(0, 80));

  // ================= J. 补漏 1：站点开关 off → 两端反馈行都不显示 =================
  await api("/api/settings", { cookie: owner, method: "PUT", body: { aiPersonalized: "off" } });
  const lOff = await api("/api/learner", { cookie: owner });
  check("J1 站点开关 off 时 /api/learner 返回 personalized=false",
    lOff.data?.personalized === false, `personalized=${lOff.data?.personalized}`);
  // 插件侧栏：content.js 只在 payload.feedbackEnabled 为真时渲染反馈行
  const jBlock = "A careful engineer will scrutinize the deployment pipeline twice.";
  const jAt = jBlock.indexOf("scrutinize");
  const extRec = await api("/api/extension/record", {
    token, method: "POST",
    body: { word: "scrutinize", block: jBlock, start: jAt, end: jAt + "scrutinize".length, url: "https://example.com/p31" },
  });
  const contentSrc = fs.readFileSync(path.join(ROOT, "extension/src/content.js"), "utf8");
  check("J2 站点开关 off 时插件侧栏不显示反馈行（payload.feedbackEnabled=false + 渲染契约）",
    extRec.status === 200 && extRec.data?.feedbackEnabled === false &&
    /if \(!panelState\?\.feedbackEnabled[\s\S]{0,120}return ""/.test(contentSrc),
    `status=${extRec.status} feedbackEnabled=${extRec.data?.feedbackEnabled}`);

  await ownerPage.setViewportSize({ width: 1440, height: 900 });
  await ownerPage.goto(`${BASE}/texts/${textId}`, { waitUntil: "load" });
  await ownerPage.waitForTimeout(900);
  const jRect = await ownerPage.evaluate(() => {
    const el = [...document.querySelectorAll("[data-pid] .w")].find((e) => e.textContent.trim() === "artifact");
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    return el.getBoundingClientRect().toJSON();
  });
  if (jRect) {
    await ownerPage.mouse.click(jRect.x + jRect.width / 2, jRect.y + jRect.height / 2);
    await ownerPage.waitForTimeout(1200);
    await ownerPage.locator('.reader-note button:has-text("问 AI")').click();
    await ownerPage.locator(".rf-ask-chip").first().click();
    const jAnswerDone = await ownerPage.waitForFunction(
      () => (document.querySelector(".reader-note .rf-md")?.textContent ?? "").includes("假模型讲解"),
      null, { timeout: 12000 },
    ).then(() => true).catch(() => false);
    const jRows = await ownerPage.locator(".reader-note .rf-feedback-row").count();
    // 必须先确认讲解真的完成了，否则「不显示」有可能是回答根本没渲染出来的假阴性
    check("J3 站点开关 off 时阅读页不显示反馈行（先确认讲解已完成）",
      jAnswerDone && jRows === 0, `回答完成=${jAnswerDone} 行数=${jRows}`);
  }
  await api("/api/settings", { cookie: owner, method: "PUT", body: { aiPersonalized: "on" } });

  // ================= K. 补漏 3：设置弹窗关闭后重读开关，关反馈行立刻生效 =================
  const dialogSrc = fs.readFileSync(path.join(ROOT, "src/components/SettingsDialog.tsx"), "utf8");
  const readerSrcK = fs.readFileSync(path.join(ROOT, "src/components/Reader.tsx"), "utf8");
  check("K1 设置弹窗关闭时广播学习档案变更事件",
    /handleClose[\s\S]{0,220}LEARNER_CHANGED_EVENT/.test(dialogSrc));
  check("K2 阅读页监听该事件并重新读取开关，不再只在挂载时读一次",
    /addEventListener\(LEARNER_CHANGED_EVENT, refresh\)/.test(readerSrcK) && /refresh\(\)/.test(readerSrcK));

  await ownerPage.goto(`${BASE}/texts/${textId}`, { waitUntil: "load" });
  await ownerPage.waitForTimeout(900);
  const kRect = await ownerPage.evaluate(() => {
    const el = [...document.querySelectorAll("[data-pid] .w")].find((e) => e.textContent.trim() === "artifact");
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    return el.getBoundingClientRect().toJSON();
  });
  if (kRect) {
    await ownerPage.mouse.click(kRect.x + kRect.width / 2, kRect.y + kRect.height / 2);
    await ownerPage.waitForTimeout(1200);
    await ownerPage.locator('.reader-note button:has-text("问 AI")').click();
    await ownerPage.locator(".rf-ask-chip").first().click();
    await ownerPage.waitForSelector(".reader-note .rf-feedback-row", { timeout: 12000 }).catch(() => {});
    const rowsBefore = await ownerPage.locator(".reader-note .rf-feedback-row").count();
    await api("/api/learner", { cookie: owner, method: "PUT", body: { showFeedback: false } });
    // 模拟设置弹窗关闭：不刷新页面，只广播事件
    await ownerPage.evaluate(() => window.dispatchEvent(new Event("readflow.learner")));
    await ownerPage.waitForTimeout(700);
    const rowsAfter = await ownerPage.locator(".reader-note .rf-feedback-row").count();
    check("K3 关反馈行后不刷新页面、只关设置弹窗，反馈行立刻消失",
      rowsBefore > 0 && rowsAfter === 0, `${rowsBefore} → ${rowsAfter}`);
  }
  await api("/api/learner", { cookie: owner, method: "PUT", body: { showFeedback: true } });

  // ============ L. P32-修复：失败后的重试风暴（假模型一直返回不合格笔记） ============
  // 用全新账号，避免 H/I 段已经消耗的尝试次数影响计数。
  await sleep(600); // 等前几段的后台笔记任务都结束，别污染 noteCalls
  const codeRetry = await invite();
  await api("/api/auth/register", {
    method: "POST",
    body: { inviteCode: codeRetry, username: "p32_retry", phone: "13800138059", password: "p32-retry-2026" },
  });
  const retryCookie = cookieOf(await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "p32_retry", password: "p32-retry-2026" }),
  }));
  const retryId = q("select id from users where username = 'p32_retry'")[0].id;
  {
    const d = new Database(DB);
    const ins = d.prepare(
      "INSERT INTO explain_events (id, user_id, kind, via, word, created_at) VALUES (?, ?, 'lookup', 'reader', 'artifact', ?)",
    );
    d.transaction(() => {
      for (let i = 0; i < 30; i++) ins.run(`l-lookup-${i}`, retryId, Date.now() - i * 1000);
    })();
    d.close();
  }
  onlyEligible(retryId);
  update("UPDATE learner_profiles SET note_updated_at = NULL WHERE user_id = ?", retryId);
  badNoteMode = true;
  const noteCallsLBefore = noteCalls.length;
  for (let i = 0; i < 8; i++) await runNightly(); // 每次整理都会再试一次 p32_retry
  const noteCallsL = noteCalls.length - noteCallsLBefore;
  const retryRow = q("select * from learner_profiles where user_id = ?", retryId)[0];
  check("L1 假模型持续返回不合格笔记：连续 8 次满足条件的整理只调用模型 1 次（失败冷却）",
    noteCallsL === 1, `模型调用=${noteCallsL}（去掉冷却应为 8）`);
  check("L2 失败写 note_last_error，笔记仍为空",
    retryRow.note === null && Boolean(retryRow.note_last_error),
    `note=${retryRow.note} err=${retryRow.note_last_error}`);
  check("L3 后台笔记入口确实有失败冷却闸门（源码契约）",
    /if \(noteBlockReason\(/.test(noteGenSrc) && /settleNoteAttempt\s*\(/.test(noteGenSrc));
  badNoteMode = false;


  // ============ P. P34：回答原文 / 对上批注 / 最近反馈进讲解 / 统计刷新 / 过期删除 ============
  badNoteMode = false;
  const pDoc = await api("/api/texts", {
    cookie: owner, method: "POST",
    body: { title: "P34 text A", text: "The design should be deliberately simple and generic to enable generalization.", format: "plain" },
  });
  const pText = pDoc.data?.id;
  const pPara = q("select id, content from paragraphs where text_id = ? order by idx", pText)[0];
  const pAt = pPara.content.indexOf("generic");
  const pAnchor = { paragraphId: pPara.id, start: pAt, end: pAt + 7 };

  // P1：讲解比批注先发出 → 讲解结束时还对不上；保存批注后补上
  const early = await explain(owner, { word: "generic", textId: pText, anchor: pAnchor });
  const earlyId = early.headers.get("x-rf-answer-id");
  const earlyBefore = q("select context_id, text_id, lemma from explain_events where id = ?", earlyId)[0];
  const earlyAns = q("select context_id, answer_text from explain_answers where event_id = ?", earlyId)[0];
  const ens = await api("/api/contexts/ensure", {
    cookie: owner, method: "POST",
    body: { word: "generic", textId: pText, paragraphId: pPara.id, quote: "generic", start: pAt, end: pAt + 7,
      prefix: pPara.content.slice(0, pAt), suffix: pPara.content.slice(pAt + 7) },
  });
  const pCtx = ens.data?.contextId;
  const earlyAfter = q("select context_id from explain_events where id = ?", earlyId)[0];
  const earlyAnsAfter = q("select context_id from explain_answers where event_id = ?", earlyId)[0];
  check("P1 讲解先于批注：讲解记录带上了文章 id 与原形；保存批注后讲解记录与回答都补上批注 id",
    earlyBefore?.context_id === null && earlyBefore?.text_id === pText && earlyBefore?.lemma === "generic" &&
    Boolean(earlyAns?.answer_text) && earlyAfter?.context_id === pCtx && earlyAnsAfter?.context_id === pCtx,
    JSON.stringify({ earlyBefore, earlyAfter, earlyAnsAfter, pCtx }));

  // P2：批注已存在、请求没带 contextId 但带了锚点 → 讲解结束时按锚点对上；追问三次各存一行，带「你问」标题
  const asks = [];
  for (const label of ["只讲这个词", "再给个例句", "讲讲句子结构"]) {
    const r = await explain(owner, { word: "generic", textId: pText, anchor: pAnchor, askLabel: label, prompt: label });
    asks.push(r.headers.get("x-rf-answer-id"));
  }
  const askRows = q(`select event_id, context_id, ask_label from explain_answers where event_id in (${asks.map(() => "?").join(",")}) order by created_at`, ...asks);
  check("P2 按锚点对上批注；追问三次存三行，顺序与「你问」标题正确",
    askRows.length === 3 && askRows.every((r) => r.context_id === pCtx) && askRows.map((r) => r.ask_label).join("|") === "只讲这个词|再给个例句|讲讲句子结构",
    JSON.stringify(askRows));

  // P3：讲解中途中止 → 不存回答
  streamDelayMs = 400;
  const ctl = new AbortController();
  const abortedP = fetch(`${BASE}/api/explain`, {
    method: "POST", signal: ctl.signal,
    headers: { "content-type": "application/json", cookie: `readflow_session=${owner}` },
    body: JSON.stringify({ word: "generic", context: "x", language: "en", askKind: "auto", textId: pText, anchor: pAnchor }),
  }).then(async (r) => { const id = r.headers.get("x-rf-answer-id"); await r.body?.getReader().read().catch(() => {}); return id; }).catch(() => null);
  await nap(300);
  ctl.abort();
  const abortedId = await abortedP;
  streamDelayMs = 0;
  await nap(1500);
  const abortedEvent = q("select id from explain_events where user_id = ? and kind = 'explain' order by created_at desc limit 1", ownerId)[0]?.id;
  check("P3 讲解中途中止：讲解记录有，回答原文不存",
    Boolean(abortedEvent) && q("select count(*) n from explain_answers where event_id = ?", abortedEvent)[0].n === 0,
    `event=${abortedEvent} header=${abortedId}`);

  // P4：在文章 A 点「太深」（那次讲解带句子地图）→ 在别的文章查词时，讲解档案里带这一条（不限文章，不写英文原词）
  update("UPDATE explain_events SET feedback = NULL, feedback_at = NULL WHERE user_id = ?", ownerId);
  explainParts = ["释义：通用的\n", "这里 generic 和 simple 并列，都是 design 的表语，讲得比较长的一段说明。\n", "==主语：The design== ==系动词：should be== ==表语：simple and generic==\n", "制卡建议：技术文档高频词"];
  const mapAns = await explain(owner, { word: "generic", textId: pText, anchor: pAnchor });
  const mapId = mapAns.headers.get("x-rf-answer-id");
  explainParts = ["释义：测试", "\n假模型讲解"];
  await api("/api/explain/feedback", { cookie: owner, method: "POST", body: { answerId: mapId, rating: "deep" } });
  await explain(owner); // 默认 word=artifact，不带文章 → 「别的文章」
  const blockOf = (msg) => {
    const i = msg.indexOf("- 最近的反馈");
    if (i < 0) return "";
    return msg.slice(i, msg.indexOf("用户选中:") > i ? msg.indexOf("用户选中:") : undefined);
  };
  const b1 = blockOf(lastCall().messages[1]?.content ?? "");
  check("P4 在别的文章查词：讲解档案带「画了句子地图 → 太深」，不含英文原词",
    /单词，自动讲解：约 \d+ 字，画了句子地图 → 太深/.test(b1) && !/generic|design/i.test(b1), b1.replace(/\n/g, " | "));

  // 再点一次「太深」（另一次讲解）→ 只留较新的那条；三种都点过 → 正好 3 行
  const r2 = (await explain(owner, { word: "generic", textId: pText, anchor: pAnchor, askLabel: "再给个例句", askKind: "example" })).headers.get("x-rf-answer-id");
  await nap(20);
  await api("/api/explain/feedback", { cookie: owner, method: "POST", body: { answerId: r2, rating: "deep" } });
  const r3 = (await explain(owner, { word: "generic", textId: pText, anchor: pAnchor })).headers.get("x-rf-answer-id");
  await api("/api/explain/feedback", { cookie: owner, method: "POST", body: { answerId: r3, rating: "right" } });
  const r4 = (await explain(owner, { word: "generic", textId: pText, anchor: pAnchor })).headers.get("x-rf-answer-id");
  await api("/api/explain/feedback", { cookie: owner, method: "POST", body: { answerId: r4, rating: "shallow" } });
  await explain(owner);
  const b3 = blockOf(lastCall().messages[1]?.content ?? "");
  const items = b3.split("\n").filter((l) => l.startsWith("  · "));
  check("P5 三种评价各最近一次：正好 3 行；两次「太深」只留较新的（再给个例句那次）",
    items.length === 3 && items.filter((l) => l.endsWith("太深")).length === 1 && items.some((l) => l.includes("再给个例句") && l.endsWith("太深")),
    items.join(" | "));

  // 31 天前的反馈不再进讲解
  update("UPDATE explain_events SET feedback_at = ? WHERE user_id = ? AND feedback IS NOT NULL", Date.now() - 31 * 86400_000, ownerId);
  await explain(owner);
  check("P6 31 天前的反馈不进讲解", blockOf(lastCall().messages[1]?.content ?? "") === "");
  update("UPDATE explain_events SET feedback = NULL, feedback_at = NULL WHERE user_id = ?", ownerId);

  // P7（F5）：统计缓存立即刷新——第 5 个「太深」（过半）后下一次讲解出现「以往反馈：「太深」偏多」
  update("UPDATE learner_profiles SET stats = NULL, stats_updated_at = NULL WHERE user_id = ?", ownerId);
  await api("/api/learner", { cookie: owner }); // 先算一次并缓存（此时没有反馈）
  for (let i = 0; i < 5; i++) {
    const id = (await explain(owner)).headers.get("x-rf-answer-id");
    await api("/api/explain/feedback", { cookie: owner, method: "POST", body: { answerId: id, rating: "deep" } });
  }
  await explain(owner);
  check("P7 点完反馈统计立即刷新：下一次讲解档案含「以往反馈：「太深」偏多」",
    (lastCall().messages[1]?.content ?? "").includes("以往反馈：「太深」偏多"));

  // P8（F6）：过期删除——已整理过的讲解 31 天前删除、29 天前保留；未整理的 31 天保留、91 天删除；查词 89 天保留、91 天删除
  const day = 86400_000;
  const mk = (id, kind, ageDays) => update(
    "INSERT INTO explain_events (id, user_id, kind, via, word, created_at) VALUES (?, ?, ?, 'reader', 'old', ?)", id, ownerId, kind, Date.now() - ageDays * day);
  onlyEligible("nobody"); // 先把所有人的整理时间推到未来，再单独设置本组用到的两个账号
  // 主账号：上次整理在 20 天前 → 早于它的讲解都算「已整理过」
  update("UPDATE learner_profiles SET note = 'x', note_updated_at = ? WHERE user_id = ?", Date.now() - 20 * day, ownerId);
  mk("old-e31-done", "explain", 31);
  mk("old-e29-done", "explain", 29);
  update("INSERT INTO explain_answers (event_id, user_id, context_id, ask_label, answer_text, created_at) VALUES ('old-e31-done', ?, NULL, NULL, 'x', ?)", ownerId, Date.now() - 31 * day);
  mk("old-l89", "lookup", 89);
  mk("old-l91", "lookup", 91);
  mk("old-e91", "explain", 91);
  // 朋友账号：从没整理过 → 31 天前的讲解还没被吸收，保留
  update("INSERT OR IGNORE INTO learner_profiles (user_id, updated_at) VALUES (?, ?)", friendId, Date.now());
  update("UPDATE learner_profiles SET note_updated_at = NULL WHERE user_id = ?", friendId);
  update("INSERT INTO explain_events (id, user_id, kind, via, word, created_at) VALUES ('f-e31', ?, 'explain', 'reader', 'old', ?)", friendId, Date.now() - 31 * day);
  await runNightly();
  const exists = (id) => q("select 1 from explain_events where id = ?", id).length === 1;
  check("P8 过期删除：已整理的讲解 31 天删 / 29 天留；从没整理的 31 天留、91 天删；查词 89 天留 / 91 天删；回答原文随之删除",
    !exists("old-e31-done") && exists("old-e29-done") && exists("f-e31") && !exists("old-e91") &&
    exists("old-l89") && !exists("old-l91") && q("select count(*) n from explain_answers where event_id = 'old-e31-done'")[0].n === 0,
    JSON.stringify({ e31: exists("old-e31-done"), e29: exists("old-e29-done"), f31: exists("f-e31"), e91: exists("old-e91"), l89: exists("old-l89"), l91: exists("old-l91") }));
  const lAfter = await api("/api/learner", { cookie: owner });
  check("P9 删除后学习档案与讲解正常", lAfter.status === 200 && (await explain(owner)).status === 200);

  await ctxOwner.close();
} catch (err) {
  fail++;
  console.log("FAIL  测试中断：", err.stack ?? err.message);
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  fake.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
console.log(`截图目录：${SHOTS}`);
process.exit(fail ? 1 : 0);
