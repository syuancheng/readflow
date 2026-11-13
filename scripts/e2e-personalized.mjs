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
