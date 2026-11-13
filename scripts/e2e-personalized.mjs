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

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const q = (sql, ...args) => {
  const d = new Database(DB, { readonly: true });
  try { return d.prepare(sql).all(...args); } finally { d.close(); }
};

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

// ---------- 假模型：记下每次请求的 messages，供断言使用 ----------
const modelCalls = [];
const fake = http.createServer((req, res) => {
  if (req.url.split("?")[0] === "/v1/chat/completions") {
    let buf = "";
    req.on("data", (d) => (buf += d));
    req.on("end", () => {
      let body = {};
      try { body = JSON.parse(buf); } catch { /* 忽略畸形请求 */ }
      modelCalls.push({ messages: body.messages ?? [], stream: body.stream !== false });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      for (const part of ["释义：测试", "\n假模型讲解"]) {
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

const shot = async (page, name, width) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await page.waitForTimeout(250);
  const overflow = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  const file = path.join(SHOTS, `${name}-${width}.png`);
  await page.screenshot({ path: file, fullPage: true });
  check(`截图 ${name} ${width}px 无横向溢出`, overflow.scroll <= overflow.client,
    `${overflow.scroll} > ${overflow.client} → ${file}`);
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
  const chip = (label) => ownerPage.getByRole("button", { name: label, exact: true });
  await chip("已工作 3–10 年").click();
  await chip("大学英语六级").click();
  await chip("550 以上").click();
  await chip("技术文档和编程").click();
  await chip("偶尔查个生词").click();
  await chip("越简洁越好，点到为止").click();
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
    sysOff === LEGACY_ZH && !userOff.includes("学生档案"),
    `status=${off.status} sysSame=${sysOff === LEGACY_ZH} hasBlock=${userOff.includes("学生档案")}`);
  const offWelcome = await api("/api/learner", { cookie: oldCookie });
  check("E2 开关关闭不影响问卷收集（问卷数据照常读得到）", offWelcome.status === 200,
    `status=${offWelcome.status} personalized=${offWelcome.data?.personalized}`);
  const forbidden = await api("/api/settings", { cookie: friendCookie, method: "PUT", body: { aiPersonalized: "on" } });
  check("E3 非站长发送 aiPersonalized 返回 403", forbidden.status === 403, `status=${forbidden.status}`);
  await api("/api/settings", { cookie: owner, method: "PUT", body: { aiPersonalized: "on" } });

  // 环境变量强制关闭：重启太重，这里只断言纯函数（单测已覆盖），接口层保持设置值

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
    await shot(ownerPage, "feedback-reader", 1440);
    await shot(ownerPage, "feedback-reader", 390);

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
    const feedbackId = rightRows.at(-1)?.id;
    const forbiddenFeedback = await api("/api/explain/feedback", {
      cookie: friendCookie, method: "POST", body: { answerId: feedbackId, rating: "shallow" },
    });
    check("G8 别人的 answerId 反馈返回 404", forbiddenFeedback.status === 404,
      `status=${forbiddenFeedback.status}`);

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
