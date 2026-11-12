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
const OWNER_PHONE = "13800138000";
const BOB_PHONE = "13900139000";
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
  const weak = await api("/api/auth/setup", { method: "POST", body: { username: OWNER, phone: OWNER_PHONE, password: "123" } });
  check("弱密码被拒绝", weak.status === 400, weak.data.error ?? "");
  const noPhone = await api("/api/auth/setup", { method: "POST", body: { username: OWNER, password: OWNER_PASS } });
  const badPhone = await api("/api/auth/setup", { method: "POST", body: { username: OWNER, phone: "12345", password: OWNER_PASS } });
  check("建号必须填合法手机号", noPhone.status === 400 && badPhone.status === 400, `缺=${noPhone.status} 错=${badPhone.status}`);
  // 两个不同用户名并发建号：入口检查与写库之间隔着 await，只能有一个成功
  const [setup1, setup2] = await Promise.all([
    api("/api/auth/setup", {
      method: "POST",
      body: { username: OWNER, phone: OWNER_PHONE, password: OWNER_PASS, displayName: "E2E Owner" },
    }),
    api("/api/auth/setup", {
      method: "POST",
      body: { username: "e2e_racer", phone: OWNER_PHONE, password: OWNER_PASS, displayName: "E2E Owner" },
    }),
  ]);
  const winners = [setup1, setup2].filter((r) => r.status === 200);
  {
    const raceDb = new Database(DB_PATH);
    const n = raceDb.prepare("SELECT count(*) AS n FROM users").get().n;
    // 后面的用例都按 OWNER 登录：抢到的是 racer 就改名，session 绑的是 user id 不受影响
    raceDb.prepare("UPDATE users SET username = ? WHERE username = 'e2e_racer'").run(OWNER);
    raceDb.close();
    check("并发建号只会成功一个，库里只有一个账号", winners.length === 1 && n === 1, `成功 ${winners.length} 个，users=${n}`);
  }
  const setup = winners[0] ?? setup1;
  check("首次建号成功并下发 session cookie", setup.status === 200 && Boolean(setup.cookie), `status=${setup.status}`);
  const cookieA = setup.cookie;
  const again = await api("/api/auth/setup", { method: "POST", body: { username: "intruder", phone: "13600136000", password: "intruder-pass" } });
  check("已有账号后 /setup 拒绝建号（关闭开放注册）", again.status === 403, `status=${again.status}`);

  const me = await api("/api/auth/me", { cookie: cookieA });
  check("/api/auth/me 返回 owner 身份", me.data.user?.username === OWNER && me.data.user?.isOwner === true, JSON.stringify(me.data.user ?? {}));
  const forged = await api("/api/auth/me", { cookie: "readflow_session=forged-token" });
  check("伪造 cookie 解析不出用户", forged.data.user === null, JSON.stringify(forged.data));

  // ---- 3. 第二个账号（同时验证 add-user 运维脚本）----
  const add = spawnSync(
    process.execPath,
    [path.join(ROOT, ".verify/scripts/account.js"), "add", BOB, `--phone=${BOB_PHONE}`, `--password=${BOB_PASS}`],
    { cwd: ROOT, env: { ...process.env, DB_PATH }, encoding: "utf8" },
  );
  check("add-user 脚本在指定 DB 建号成功", add.status === 0, (add.stdout || add.stderr || "").trim().slice(0, 120));
  const loginB = await api("/api/auth/login", { method: "POST", body: { username: BOB, password: BOB_PASS } });
  check("第二账号可登录且不是 owner", loginB.status === 200 && loginB.data.user?.isOwner === false, `status=${loginB.status}`);
  const cookieB = loginB.cookie;
  const byPhone = await api("/api/auth/login", { method: "POST", body: { account: "139 0013 9000", password: BOB_PASS } });
  check(
    "可用手机号登录（带空格也能识别），且登到同一个账号",
    byPhone.status === 200 && byPhone.data.user?.username === BOB && byPhone.data.user?.phone === BOB_PHONE,
    `status=${byPhone.status} user=${byPhone.data.user?.username}`,
  );
  const ownerMe = await api("/api/auth/me", { cookie: cookieA });
  check("/api/auth/me 带回本人手机号", ownerMe.data.user?.phone === OWNER_PHONE, String(ownerMe.data.user?.phone));

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

  // ---- 6b. 收词 / 批注写入的跨账号隔离 ----
  const paraOf = async (cookie, id) => (await api(`/api/texts/${id}`, { cookie })).data.paragraphs?.[0]?.id;
  const pA = await paraOf(cookieA, idA);
  const pB = await paraOf(cookieB, idB);
  const SENT = "The meticulous widget keeps its state in sync over a long run.";
  const at = SENT.indexOf("widget");
  const anchorOf = (textId, paragraphId) => ({
    word: "widget",
    quote: "widget",
    textId,
    paragraphId,
    start: at,
    end: at + 6,
    prefix: SENT.slice(0, at),
    suffix: SENT.slice(at + 6),
  });
  const saveA = await api("/api/words", { method: "POST", cookie: cookieA, body: anchorOf(idA, pA) });
  const saveB = await api("/api/words", { method: "POST", cookie: cookieB, body: anchorOf(idB, pB) });
  check(
    "同一个词两个账号各收各的，不串到对方词条",
    saveA.status === 200 && saveB.status === 200 && saveA.data.wordId !== saveB.data.wordId && saveB.data.created === true,
    `A=${saveA.data.wordId} B=${saveB.data.wordId} B.created=${saveB.data.created}`,
  );
  const bWords = (await api("/api/words", { cookie: cookieB })).data.words ?? [];
  check("B 的词库里有自己收的 widget", bWords.some((w) => w.lemma === "widget" && w.id === saveB.data.wordId), `B=${bWords.map((w) => w.lemma)}`);

  const intrude = await api("/api/words", { method: "POST", cookie: cookieB, body: anchorOf(idA, pA) });
  check("B 往 A 的文章收词 → 404", intrude.status === 404, `status=${intrude.status}`);
  const intrudeGloss = await api("/api/contexts/gloss", {
    method: "POST",
    cookie: cookieB,
    body: { ...anchorOf(idA, pA), aiGloss: "B 写的释义" },
  });
  check("B 往 A 的文章写 AI 释义 → 404", intrudeGloss.status === 404, `status=${intrudeGloss.status}`);
  const intrudeEnsure = await api("/api/contexts/ensure", { method: "POST", cookie: cookieB, body: anchorOf(idA, pA) });
  check("B 在 A 的文章补建批注 → 404", intrudeEnsure.status === 404, `status=${intrudeEnsure.status}`);

  const peekWords = await api(`/api/words?textId=${idA}`, { cookie: cookieB });
  check("B 按 A 的 textId 列词拿不到 A 的词", (peekWords.data.words ?? []).length === 0, `B 见到 ${(peekWords.data.words ?? []).length} 个`);

  const delCross = await api(`/api/words/${saveB.data.wordId}?contextId=${saveA.data.contextId}`, {
    method: "DELETE",
    cookie: cookieB,
  });
  const annA = (await api(`/api/annotations?textId=${idA}`, { cookie: cookieA })).data.annotations ?? [];
  check(
    "B 借自己的词条删不掉 A 的批注",
    annA.length === 1 && annA[0].id === saveA.data.contextId,
    `delete status=${delCross.status}，A 批注 ${annA.length} 条`,
  );

  // ---- 6c. 只带假 cookie 穿过 proxy 的请求，必须被路由自己挡下 ----
  const FAKE = "readflow_session=forged-token";
  const fakeExplain = await api("/api/explain", { method: "POST", cookie: FAKE, body: { word: "widget" } });
  const fakeDict = await api("/api/dict?word=widget", { cookie: FAKE });
  const fakeDecks = await api("/api/markji/decks", { cookie: FAKE });
  const fakeTest = await api("/api/settings/test", { method: "POST", cookie: FAKE, body: { target: "ai" } });
  const fakeImg = await fetch(`${BASE}/api/img?u=${encodeURIComponent("https://example.com/a.png")}`, {
    headers: { cookie: FAKE },
  });
  check(
    "假 cookie 调 explain / dict / 牌组 / 测试连接 / 图片代理 → 401",
    [fakeExplain.status, fakeDict.status, fakeDecks.status, fakeTest.status, fakeImg.status].every((st) => st === 401),
    `explain=${fakeExplain.status} dict=${fakeDict.status} decks=${fakeDecks.status} test=${fakeTest.status} img=${fakeImg.status}`,
  );
  const loopImg = await fetch(`${BASE}/api/img?u=${encodeURIComponent(`${BASE}/icon.svg`)}`, {
    headers: { cookie: cookieA },
  });
  check("图片代理拒绝代理本机 / 内网地址", loopImg.status === 403, `status=${loopImg.status}`);

  // ---- 6d. P28：非 owner 的墨墨 Token / 模型 Key 写到自己名下，碰不到站级；P30 插件 Token 每人一个 ----
  const bSetToken = await api("/api/settings", { method: "PUT", cookie: cookieB, body: { markjiToken: "b-token-123" } });
  const bRegen = await api("/api/settings", { method: "PUT", cookie: cookieB, body: { regenerateExtensionToken: true } });
  const bTest = await api("/api/settings/test", { method: "POST", cookie: cookieB, body: { target: "ai" } });
  const tokDb = new Database(DB_PATH, { readonly: true });
  const siteTok = tokDb.prepare("SELECT value FROM settings WHERE user_id = 'local' AND key = 'markji.token'").get()?.value;
  const bOwnTok = tokDb
    .prepare("SELECT s.value FROM settings s JOIN users u ON u.id = s.user_id WHERE u.username = ? AND s.key = 'markji.token'")
    .get(BOB)?.value;
  tokDb.close();
  check(
    "非 owner 改墨墨 Token 只写自己名下 / 能生成自己的插件 Token / 测试模型不借用站点的",
    bSetToken.status === 200 && bOwnTok === "b-token-123" && siteTok !== "b-token-123" &&
      bRegen.status === 200 && Boolean(bRegen.data.newExtensionToken) && bTest.data.ok === false,
    `token=${bSetToken.status} 自己名下=${bOwnTok} 站级=${siteTok} regen=${bRegen.status} test.ok=${bTest.data.ok}`,
  );
  const aRegen = await api("/api/settings", { method: "PUT", cookie: cookieA, body: { regenerateExtensionToken: true } });
  const bView = await api("/api/settings", { cookie: cookieB });
  const aTok = aRegen.data.newExtensionToken;
  const bTok = bRegen.data.newExtensionToken;
  const aWords = await fetch(`${BASE}/api/extension/words`, { headers: { "x-readflow-token": aTok ?? "" } });
  check(
    "两人各有自己的插件 Token，互不相同；读回设置只给状态不给明文",
    aRegen.status === 200 && Boolean(aTok) && aTok !== bTok && aWords.status === 200 &&
      bView.data.extension?.hasToken === true && !JSON.stringify(bView.data).includes(bTok ?? "§"),
    `A=${aRegen.status} 不同=${aTok !== bTok} A 词表=${aWords.status} B 状态=${JSON.stringify(bView.data.extension)}`,
  );

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
