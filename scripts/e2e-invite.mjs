/**
 * P28 回归：邀请码注册 + 每人自己的墨墨 Token / AI Key + 站点模型每日免费次数 + 顶部导航高亮。
 * 隔离库 + 临时端口（3127），跑完删库。需要先 npm run build。
 * 站点模型指向本机一个不通的端口：只验证「放不放行、扣不扣次数」，不调真实模型、不花钱。
 *
 *   node scripts/e2e-invite.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3127;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "invite");
const DB = path.join(TMP, "readflow.db");

const log = (m) => console.log(m);
let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass++; else fail++;
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const env = { ...process.env, DB_PATH: DB, NODE_ENV: "production", READFLOW_AI_DAILY_QUOTA: "2", NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" };
for (const k of ["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DASHSCOPE_API_KEY", "MARKJI_TOKEN", "MAIMEMO_TOKEN"]) delete env[k];
const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  cwd: ROOT,
  env,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d.toString()));
server.stderr.on("data", (d) => (serverLog += d.toString()));

async function waitServer() {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(`${BASE}/api/auth/status`)).status) return true;
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
const q = (sql, ...args) => {
  const d = new Database(DB, { readonly: true });
  try { return d.prepare(sql).get(...args); } finally { d.close(); }
};
const cookieOf = (res) => res.headers.get("set-cookie")?.match(/readflow_session=([^;]+)/)?.[1];
const api = async (cookie, url, init = {}) => {
  const res = await fetch(`${BASE}${url}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie: `readflow_session=${cookie}` } : {}), ...init.headers },
  });
  return res;
};
const json = async (res) => res.json().catch(() => ({}));
/** 只看放没放行：拿到状态码就断开流，不等模型（站点模型故意指向不通的端口） */
const explain = async (cookie) => {
  const ctl = new AbortController();
  const res = await api(cookie, "/api/explain", {
    method: "POST",
    body: JSON.stringify({ word: "tracks", context: "The database tracks history." }),
    signal: ctl.signal,
  });
  const status = res.status;
  const body = status === 200 ? null : await json(res);
  ctl.abort();
  return { status, body };
};

try {
  if (!(await waitServer())) { log("服务器没起来:\n" + serverLog.slice(-3000)); process.exit(1); }

  // ---- 主账号 ----
  const setup = await api(null, "/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ username: "owner_p28", password: "owner-pass-2026", phone: "13800138010" }),
  });
  const owner = cookieOf(setup);
  if (!owner) { log("建主账号失败"); process.exit(1); }
  // 站点模型（指向不通的端口）+ 主账号的墨墨 Token
  await api(owner, "/api/settings", {
    method: "PUT",
    body: JSON.stringify({
      activeProvider: "custom",
      providers: { custom: { apiKey: "site-key-123456", baseUrl: "http://127.0.0.1:9/v1", model: "fake-model" } },
      markjiToken: "owner-markji-token-abcdef",
    }),
  });

  // ---- 1. 邀请码 ----
  const created = await json(await api(owner, "/api/invites", { method: "POST", body: JSON.stringify({ maxUses: 1, note: "给小王" }) }));
  const code = created.code;
  check("1 主账号生成邀请码（形如 XXXX-XXXX）", /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code ?? ""), code);

  const wrong = await api(null, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ inviteCode: "AAAA-BBBB", username: "nobody", phone: "13800138011", password: "friend-pass-2026" }),
  });
  check("2 邀请码不对：拒绝注册", wrong.status === 400 && (await json(wrong)).error.includes("邀请码"), String(wrong.status));

  // ---- 3. 浏览器里走注册页 ----
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "load" });
  const regLink = await page.locator('a[href="/register"]').count();
  check("3 登录页有「有邀请码，去注册」入口", regLink === 1);
  await page.goto(`${BASE}/register?code=${code}`, { waitUntil: "load" });
  await page.waitForTimeout(600);
  const prefilled = await page.locator('input[placeholder*="K7QM"]').inputValue();
  check("4 注册链接自动填好邀请码", prefilled === code, prefilled);
  await page.locator('input[autocomplete="username"]').fill("friend_p28");
  await page.locator('input[type="tel"]').fill("13800138012");
  await page.locator('input[type="password"]').nth(0).fill("friend-pass-2026");
  await page.locator('input[type="password"]').nth(1).fill("friend-pass-2026");
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {});
  const friendRow = q("select id, is_owner, invite_code from users where username = 'friend_p28'");
  check("5 注册成功：建了普通账号、记下邀请码、直接进首页", !!friendRow && friendRow.is_owner === 0 && friendRow.invite_code === code && page.url() === `${BASE}/`, page.url());
  const friend = (await ctx.cookies()).find((c) => c.name === "readflow_session")?.value;

  const reuse = await api(null, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ inviteCode: code, username: "third_p28", phone: "13800138013", password: "third-pass-2026" }),
  });
  check("6 一次性邀请码用过就不能再用", reuse.status === 400 && (await json(reuse)).error.includes("用完"), String(reuse.status));

  const list = await json(await api(owner, "/api/invites"));
  const iv = list.invites?.find((x) => x.code === code);
  check("7 主账号能看到这个码被谁用了", iv?.usedCount === 1 && iv.usedBy.includes("friend_p28"), JSON.stringify(iv));
  check("8 普通账号不能管理邀请码", (await api(friend, "/api/invites")).status === 403);

  // ---- 9. 墨墨 Token 每人一份 ----
  const fs1 = await json(await api(friend, "/api/settings"));
  check("9 普通账号看不到主账号的墨墨 Token / 模型 Key", fs1.markji?.configured === false && fs1.providers.every((p) => !p.configured) && fs1.canEditSite === false, JSON.stringify(fs1.markji));
  const decks = await json(await api(friend, "/api/markji/decks"));
  check("10 普通账号没填墨墨 Token：不能读牌组（不回退主账号的）", decks.ok === false && decks.error.includes("未配置"), decks.error);
  const friendWordId = "w-friend";
  const exp = await api(friend, "/api/export", { method: "POST", body: JSON.stringify({ deckId: "d", chapterId: "c", types: ["qa"], wordIds: [friendWordId] }) });
  check("11 普通账号没填墨墨 Token：不能导出", exp.status === 400 && (await json(exp)).error.includes("墨墨 Token"), String(exp.status));
  await api(friend, "/api/settings", { method: "PUT", body: JSON.stringify({ markjiToken: "friend-markji-token-zzzz" }) });
  const ownerTok = q("select value from settings where user_id = 'local' and key = 'markji.token'")?.value;
  const friendTok = q("select value from settings where user_id = ? and key = 'markji.token'", friendRow.id)?.value;
  check("12 普通账号填的墨墨 Token 存在自己名下，主账号的不变", friendTok === "friend-markji-token-zzzz" && ownerTok === "owner-markji-token-abcdef");
  check("13 普通账号不能重置插件 Token", (await api(friend, "/api/settings", { method: "PUT", body: JSON.stringify({ regenerateExtensionToken: true }) })).status === 403);

  // ---- 14. 站点模型每日免费次数（本测试设为 2 次） ----
  const r1 = await explain(friend);
  const r2 = await explain(friend);
  const r3 = await explain(friend);
  check("14 用站点模型：前 2 次放行，第 3 次提示今天的免费次数用完", r1.status === 200 && r2.status === 200 && r3.status === 429 && r3.body.error.includes("免费 AI 讲解次数"), `${r1.status} ${r2.status} ${r3.status}`);
  const fs2 = await json(await api(friend, "/api/settings"));
  check("15 设置里能看到额度：已用 2 / 2", fs2.aiQuota?.usedToday === 2 && fs2.aiQuota.limit === 2 && fs2.aiQuota.ownKey === false, JSON.stringify(fs2.aiQuota));
  const o = [await explain(owner), await explain(owner), await explain(owner)];
  check("16 主账号不限次数", o.every((x) => x.status === 200), o.map((x) => x.status).join(" "));
  await api(friend, "/api/settings", {
    method: "PUT",
    body: JSON.stringify({ activeProvider: "custom", providers: { custom: { apiKey: "friend-own-key-9999", baseUrl: "http://127.0.0.1:9/v1", model: "own-model" } } }),
  });
  const r4 = await explain(friend);
  const fs3 = await json(await api(friend, "/api/settings"));
  check("17 填了自己的 Key：不再受次数限制", r4.status === 200 && fs3.aiQuota.ownKey === true, `${r4.status}`);
  const siteKey = q("select value from settings where user_id = 'local' and key = 'ai.custom.apiKey'")?.value;
  check("18 普通账号的 Key 存在自己名下，站点的 Key 不变", siteKey === "site-key-123456" && q("select value from settings where user_id = ? and key = 'ai.custom.apiKey'", friendRow.id)?.value === "friend-own-key-9999");

  // ---- 19. 作废 ----
  const code2 = (await json(await api(owner, "/api/invites", { method: "POST", body: JSON.stringify({ maxUses: 3 }) }))).code;
  await api(owner, `/api/invites?code=${code2}`, { method: "DELETE" });
  const revoked = await api(null, "/api/auth/register", {
    method: "POST",
    body: JSON.stringify({ inviteCode: code2.toLowerCase().replace("-", " "), username: "fourth_p28", phone: "13800138014", password: "fourth-pass-2026" }),
  });
  check("19 作废的邀请码不能注册（输入大小写、空格不敏感也照样拦）", revoked.status === 400 && (await json(revoked)).error.includes("作废"), String(revoked.status));

  // ---- 20. 顶部导航高亮 + 不重复的标题 ----
  for (const [url, label] of [["/words", "我的词库"], ["/stats", "战绩"], ["/", "我的文本"]]) {
    await page.goto(`${BASE}${url}`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    const current = await page.locator('nav[aria-label="主导航"] a[aria-current="page"]').allInnerTexts();
    check(`20 ${url}：顶部导航只高亮「${label}」`, current.length === 1 && current[0].trim() === label, current.join(","));
  }
  await page.goto(`${BASE}/words`, { waitUntil: "load" });
  check("21 词库页不再重复写「我的词库」大标题", (await page.locator("h1", { hasText: "我的词库" }).count()) === 0);
  await page.goto(`${BASE}/stats`, { waitUntil: "load" });
  check("22 战绩页不再重复写「我的战绩」大标题", (await page.locator("h1", { hasText: "战绩" }).count()) === 0);
  if (process.env.SHOT_DIR) {
    await page.goto(`${BASE}/words`, { waitUntil: "load" });
    await page.screenshot({ path: path.join(process.env.SHOT_DIR, "nav-words.png") });
    const anon = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const p2 = await anon.newPage();
    await p2.goto(`${BASE}/register?code=K7QM-3XPA`, { waitUntil: "load" });
    await p2.waitForTimeout(500);
    await p2.screenshot({ path: path.join(process.env.SHOT_DIR, "register.png") });
  }

  await browser.close();
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  rmSync(TMP, { recursive: true, force: true });
}
log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
