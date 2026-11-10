/**
 * P20 账户体系端到端验证（登录 + 双账号隔离 + 越权 + 登出）。
 *
 *   node scripts/e2e-account.mjs
 *
 * 关键点：**绝不碰真实库**。脚本用临时 DB + 临时端口（默认 3107）另起一个
 * `next start`，跑完杀进程、删库。因此需要先 `npm run build`。
 * 这样既能验证完整登录链路，也不需要替用户在真实库里建账号。
 *
 * 覆盖：
 *   1. 未登录重定向 / 401；首次建号；关闭开放注册
 *   2. 伪造 cookie / 弱密码 / 登录失败限速
 *   3. 双账号文章、词库、个人资料互不串；越权读写一律 404
 *   4. 改密码踢掉旧会话；登出后失效
 *   5. 真实浏览器登录表单能跳回首页
 */
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.E2E_PORT || 3107);
const BASE = `http://127.0.0.1:${PORT}`;
const OWNER = "e2e_owner";
const OWNER_PASS = "owner-pass-2026";
const OWNER_NEW_PASS = "owner-pass-new-2026";
const BOB = "e2e_bob";
const BOB_PASS = "bob-pass-2026";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "readflow-auth-e2e-"));
const DB_PATH = path.join(tmpDir, "test.db");
const results = [];
let serverLog = "";

function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function api(pathname, { method = "GET", body, cookie, redirect = "manual" } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, cookie: cookieFrom(res), location: res.headers.get("location") ?? "" };
}

function cookieFrom(res) {
  const raw = res.headers.get("set-cookie") ?? "";
  const m = raw.match(/readflow_session=([^;]+)/);
  return m ? `readflow_session=${m[1]}` : "";
}

async function waitReady() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${BASE}/api/auth/status`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`临时服务 ${BASE} 未就绪。serverLog:\n${serverLog.slice(-2000)}`);
}

const server = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT)],
  {
    cwd: ROOT,
    env: {
      ...process.env,
      DB_PATH,
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
server.stdout.on("data", (d) => (serverLog += d.toString()));
server.stderr.on("data", (d) => (serverLog += d.toString()));

let browser;
try {
  await waitReady();

  // ---- 1. 未登录守门 ----
  const s = await api("/api/auth/status");
  check("公开 /api/auth/status 报 needsSetup", s.status === 200 && s.data.needsSetup === true, JSON.stringify(s.data));
  const home = await api("/");
  check("未登录访问首页被重定向到 /login", [302, 307, 308].includes(home.status) && home.location.includes("/login"), `${home.status} → ${home.location}`);
  const noAuthApi = await api("/api/words");
  check("未登录 API 返回 401", noAuthApi.status === 401, `status=${noAuthApi.status}`);
  const publicImg = await api("/api/auth/login", { method: "POST", body: { username: OWNER, password: OWNER_PASS } });
  check("空库登录失败（尚未建号）", publicImg.status === 401, `status=${publicImg.status}`);

  // ---- 2. 首次建号 ----
  const weak = await api("/api/auth/setup", { method: "POST", body: { username: OWNER, password: "123" } });
  check("弱密码被拒绝", weak.status === 400, weak.data.error ?? "");
  const setup = await api("/api/auth/setup", {
    method: "POST",
    body: { username: OWNER, password: OWNER_PASS, displayName: "E2E Owner" },
  });
  check("首次建号成功并下发 session cookie", setup.status === 200 && Boolean(setup.cookie), `status=${setup.status}`);
  const cookieA = setup.cookie;
  const again = await api("/api/auth/setup", { method: "POST", body: { username: "intruder", password: "intruder-pass" } });
  check("已有账号后 /setup 拒绝建号（关闭开放注册）", again.status === 403, `status=${again.status}`);

  const me = await api("/api/auth/me", { cookie: cookieA });
  check("/api/auth/me 返回 owner 身份", me.data.user?.username === OWNER && me.data.user?.isOwner === true, JSON.stringify(me.data.user ?? {}));
  const forged = await api("/api/auth/me", { cookie: "readflow_session=forged-token" });
  check("伪造 cookie 解析不出用户", forged.data.user === null, JSON.stringify(forged.data));

  // ---- 3. 第二个账号（同时验证 add-user 运维脚本）----
  const add = spawnSync(
    process.execPath,
    [path.join(ROOT, ".verify/scripts/account.js"), "add", BOB, `--password=${BOB_PASS}`],
    { cwd: ROOT, env: { ...process.env, DB_PATH }, encoding: "utf8" },
  );
  check("add-user 脚本在指定 DB 建号成功", add.status === 0, (add.stdout || add.stderr || "").trim().slice(0, 120));
  const loginB = await api("/api/auth/login", { method: "POST", body: { username: BOB, password: BOB_PASS } });
  check("第二账号可登录且不是 owner", loginB.status === 200 && loginB.data.user?.isOwner === false, `status=${loginB.status}`);
  const cookieB = loginB.cookie;

  // ---- 4. 各自建文章，验证列表隔离 ----
  const mkText = (cookie, title) =>
    api("/api/texts", {
      method: "POST",
      cookie,
      body: { title, text: "The meticulous widget keeps its state in sync over a long run." },
    });
  const tA = await mkText(cookieA, "[E2E] Alice 的文章");
  const tB = await mkText(cookieB, "[E2E] Bob 的文章");
  check("两个账号都能导入文章", tA.status === 200 && tB.status === 200, `A=${tA.status} B=${tB.status}`);
  const idA = tA.data.id ?? tA.data.text?.id;
  const idB = tB.data.id ?? tB.data.text?.id;
  check("导入接口返回 textId", Boolean(idA && idB), `A=${idA} B=${idB}`);

  const listA = await api("/api/texts", { cookie: cookieA });
  const listB = await api("/api/texts", { cookie: cookieB });
  const rowA = listA.data.texts ?? [];
  const rowB = listB.data.texts ?? [];
  check("A 看不到 B 的文章", rowA.length === 1 && rowA[0].id === idA, `A 见到 ${rowA.length} 篇`);
  check("B 看不到 A 的文章", rowB.length === 1 && rowB[0].id === idB, `B 见到 ${rowB.length} 篇`);

  // ---- 5. 越权读写一律 404 ----
  const peek = await api(`/api/texts/${idA}`, { cookie: cookieB });
  check("B 读 A 的文章 → 404", peek.status === 404, `status=${peek.status}`);
  const patch = await api(`/api/texts/${idA}`, { method: "PATCH", cookie: cookieB, body: { title: "被篡改" } });
  check("B 改 A 的文章 → 404", patch.status === 404, `status=${patch.status}`);
  const ann = await api(`/api/annotations?textId=${idA}`, { cookie: cookieB });
  check("B 读 A 的批注 → 404", ann.status === 404, `status=${ann.status}`);
  const sum = await api(`/api/summarize?textId=${idA}`, { cookie: cookieB });
  check("B 读 A 的分段小结 → 404", sum.status === 404, `status=${sum.status}`);
  const del = await api(`/api/texts/${idA}`, { method: "DELETE", cookie: cookieB });
  check("B 删 A 的文章 → 404", del.status === 404, `status=${del.status}`);
  const stillThere = await api(`/api/texts/${idA}`, { cookie: cookieA });
  check("A 的文章仍然存在", stillThere.status === 200, `status=${stillThere.status}`);

  // ---- 6. 词库隔离（直接插库，避开 WordAnchor 的段落依赖）----
  const db = new Database(DB_PATH);
  const ins = db.prepare(
    "INSERT INTO user_words (id, user_id, lemma, display_form, translation, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const ownerId = db.prepare("SELECT id FROM users WHERE username = ?").get(OWNER).id;
  const bobId = db.prepare("SELECT id FROM users WHERE username = ?").get(BOB).id;
  ins.run("w-a", ownerId, "alpha", "alpha", "阿尔法", Date.now());
  ins.run("w-b", bobId, "bravo", "bravo", "布拉沃", Date.now());
  db.close();
  const wordsA = await api("/api/words", { cookie: cookieA });
  const wordsB = await api("/api/words", { cookie: cookieB });
  const listWA = wordsA.data.words ?? wordsA.data ?? [];
  const listWB = wordsB.data.words ?? wordsB.data ?? [];
  check("A 的词库只有自己的词", Array.isArray(listWA) && listWA.length === 1 && listWA[0].lemma === "alpha", `A=${listWA.length}`);
  check("B 的词库只有自己的词", Array.isArray(listWB) && listWB.length === 1 && listWB[0].lemma === "bravo", `B=${listWB.length}`);

  // ---- 7. 个人资料按账号隔离，站级密钥共享 ----
  const putA = await api("/api/settings", {
    method: "PUT",
    cookie: cookieA,
    body: { profile: { displayName: "Alice-Only" } },
  });
  check(
    "A 保存个人资料成功且 PUT 回显新昵称",
    putA.status === 200 && putA.data.profile?.displayName === "Alice-Only",
    `status=${putA.status} 回显=${putA.data.profile?.displayName}`,
  );
  const profA = await api("/api/settings", { cookie: cookieA });
  const profB = await api("/api/settings", { cookie: cookieB });
  check("A 读回自己的昵称", profA.data.profile?.displayName === "Alice-Only", String(profA.data.profile?.displayName));
  check("B 读不到 A 的昵称", profB.data.profile?.displayName !== "Alice-Only", String(profB.data.profile?.displayName));

  // ---- 8. 登录限速 ----
  let last = 0;
  for (let i = 0; i < 6; i++) {
    const r = await api("/api/auth/login", { method: "POST", body: { username: OWNER, password: "wrong-password" } });
    last = r.status;
  }
  check("连续失败后登录被限速 429", last === 429, `最后一次 status=${last}`);

  // ---- 9. 改密码踢掉旧会话 ----
  const changed = await api("/api/auth/password", {
    method: "POST",
    cookie: cookieA,
    body: { currentPassword: OWNER_PASS, newPassword: OWNER_NEW_PASS },
  });
  check("修改密码成功", changed.status === 200, `status=${changed.status}`);
  const oldSession = await api("/api/auth/me", { cookie: cookieA });
  check("改密码后旧 session 失效", oldSession.data.user === null, JSON.stringify(oldSession.data));
  const newSession = await api("/api/auth/me", { cookie: changed.cookie });
  check("改密码后本机新 session 可用", newSession.data.user?.username === OWNER, JSON.stringify(newSession.data.user ?? {}));

  // ---- 10. 登出 ----
  const out = await api("/api/auth/logout", { method: "POST", cookie: changed.cookie });
  check("登出接口返回成功", out.status === 200, `status=${out.status}`);
  const afterOut = await api("/api/auth/me", { cookie: changed.cookie });
  check("登出后 session 被吊销", afterOut.data.user === null, JSON.stringify(afterOut.data));

  // ---- 11. 真实浏览器：登录表单 ----
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("input[autocomplete='username']", { timeout: 10000 });
  await page.fill("input[autocomplete='username']", BOB);
  await page.fill("input[autocomplete='current-password']", BOB_PASS);
  await page.click("button[type='submit']");
  await page.waitForURL(`${BASE}/`, { timeout: 15000 }).catch(() => {});
  check("浏览器登录成功并跳回首页", new URL(page.url()).pathname === "/", page.url());
  await page.close();

  // ---- 12. 复用同一个临时服务，验证「带登录态时阅读链路仍 hydrate」----
  // 旧 E2E 脚本全部靠 e2e-auth.mjs 注入 cookie；这里顺带验证 helper 本身可用。
  const smoke = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts/e2e-spine-render.mjs")],
    {
      cwd: ROOT,
      env: { ...process.env, BASE, E2E_USER: BOB, E2E_PASS: BOB_PASS },
      encoding: "utf8",
      timeout: 180000,
    },
  );
  const smokeOut = `${smoke.stdout ?? ""}${smoke.stderr ?? ""}`.trim();
  check(
    "登录态下阅读链路冒烟（e2e-spine-render + e2e-auth）",
    smoke.status === 0,
    smoke.status === 0 ? smokeOut.split("\n").slice(-1)[0] : smokeOut.slice(-500),
  );
} catch (err) {
  check("E2E 执行无异常", false, String(err?.stack ?? err));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.kill("SIGTERM");
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log("失败项：" + failed.map((r) => r.name).join("、"));
  console.log("serverLog 尾部：\n" + serverLog.slice(-1500));
  process.exit(1);
}
