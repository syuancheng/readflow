/**
 * P43 端到端：① 做卡完成后右上角弹通知，「查看」在新标签页打开；② 词在括号里时上下文锚点只取括号里面。
 * 隔离库 + 端口 3160（假模型 3161）；做卡接口（generate / state）在浏览器里拦截模拟，不调真模型。
 * 截图写到 .verify/card-toast/（1440 / 390 各一张）。
 *   node scripts/e2e-card-toast.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3160, MODEL = 3161;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "card-toast");
const DB = path.join(TMP, "readflow.db");
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
let pass = 0, fail = 0;
const check = (n, ok, d = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  — ${d}` : ""}`); };

// 假模型：词典没命中时点词会自动请 AI；这里随便流式回一句
const model = http.createServer((req, res) => {
  let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: { content: "释义：测试" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "s", object: "chat.completion.chunk", created: 0, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
    res.write("data: [DONE]\n\n"); res.end();
  });
});
await new Promise((r) => model.listen(MODEL, "127.0.0.1", r));

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, DB_PATH: DB, NODE_ENV: "production", NO_PROXY: "127.0.0.1", no_proxy: "127.0.0.1" },
});
let log = ""; server.stdout.on("data", (d) => (log += d)); server.stderr.on("data", (d) => (log += d));
for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/api/auth/status`)).ok) break; } catch {} await new Promise((r) => setTimeout(r, 500)); }

const api = async (p, { cookie, method = "GET", body } = {}) => {
  const r = await fetch(BASE + p, { method, headers: { ...(cookie ? { cookie: `readflow_session=${cookie}` } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let data = null; try { data = JSON.parse(t); } catch {}
  return { status: r.status, data };
};

const PAREN = "I've talked about these many times, and synthesized them into my own model, but here's the 80/20 of the 9 stages as a refresher (because repetition helps reveal things you didn't notice before, and there are new people reading these letters):";

let browser;
try {
  const setup = await fetch(`${BASE}/api/auth/setup`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "toast_owner", password: "toast-owner-2026", phone: "13800138043" }) });
  const cookie = setup.headers.get("set-cookie").match(/readflow_session=([^;]+)/)[1];
  await api("/api/settings", { cookie, method: "PUT", body: { activeProvider: "custom", providers: { custom: { apiKey: "k", model: "m", baseUrl: `http://127.0.0.1:${MODEL}/v1` } } } });
  const t = await api("/api/texts", { cookie, method: "POST", body: { title: "Toast text", text: [
    "Behavior is complex. We understand why people reprogram their habits slowly.",
    PAREN,
    "Another paragraph about discipline and patience helps everybody improve.",
  ].join("\n\n") } });
  const textId = t.data.id ?? t.data.textId;

  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();

  // ---- 做卡接口模拟：第 1、3 次生成做成 2 张，第 2 次失败 ----
  let generates = 0;
  const lastCall = new Map(); // contextId -> 生成开始之后被查了几次状态
  const started = new Map(); // contextId -> 第几次生成
  await page.route("**/api/cards/generate", async (route) => {
    generates++;
    const body = JSON.parse(route.request().postData() || "{}");
    started.set(body.contextId, generates);
    lastCall.set(body.contextId, 0);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, setId: `set-${generates}` }) });
  });
  await page.route("**/api/cards/state*", async (route) => {
    const cid = new URL(route.request().url()).searchParams.get("contextId");
    const n = started.get(cid);
    let body = { enabled: true, state: "none", setId: null, count: 0, error: null, wordId: null };
    if (n) {
      const seen = (lastCall.get(cid) ?? 0) + 1;
      lastCall.set(cid, seen);
      body = seen <= 3
        ? { enabled: true, state: "generating", setId: `set-${n}`, count: 0, error: null, wordId: null }
        : n === 2
          ? { enabled: true, state: "failed", setId: `set-${n}`, count: 0, error: "模型没有返回合法的 JSON", wordId: null }
          : { enabled: true, state: "ready", setId: `set-${n}`, count: 2, error: null, wordId: "w-e2e" };
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  await page.goto(`${BASE}/texts/${textId}`, { waitUntil: "networkidle" });
  const word = (w) => page.locator(".w", { hasText: new RegExp(`^${w}$`) }).first();

  // ===== 括号里的词：上下文锚点只取括号里面 =====
  await word("reveal").scrollIntoViewIfNeeded();
  await word("reveal").click();
  await page.getByText("上下文锚点").first().click();
  await page.waitForTimeout(400);
  const anchorText = (await page.locator("body").innerText());
  const pre = anchorText.match(/前文\s*([^\n]*)/)?.[1] ?? "";
  const suf = anchorText.match(/后文\s*([^\n]*)/)?.[1] ?? "";
  check("A1 括号里的词：前文只取括号里面（不含括号外的主句和左括号）", pre.trim() === "because repetition helps" && !pre.includes("refresher") && !pre.includes("("), `前文=${JSON.stringify(pre)}`);
  check("A2 括号里的词：后文到括号结束，不含右括号和冒号", suf.trim().startsWith("things you didn't notice before") && suf.trim().endsWith("reading these letters") && !suf.includes(")"), `后文=${JSON.stringify(suf)}`);
  await page.keyboard.press("Escape"); // 收起右栏

  // ===== 做卡完成通知 =====
  await word("understand").scrollIntoViewIfNeeded();
  await word("understand").click();
  const makeBtn = page.getByRole("button", { name: /做成卡片/ });
  await makeBtn.waitFor({ timeout: 15000 });
  await page.waitForFunction(() => { const b = [...document.querySelectorAll("button")].find((x) => /做成卡片/.test(x.textContent || "")); return b && !b.disabled; }, null, { timeout: 15000 });
  await makeBtn.click();
  await page.getByText(/做卡 \d+%/).waitFor({ timeout: 8000 });
  check("N1 点「做成卡片」后按钮进入生成中", true);

  // 不等它做完：切到另一个词（右栏的按钮会卸载）
  await word("complex").scrollIntoViewIfNeeded();
  await word("complex").click();
  await page.waitForTimeout(600);
  const early = await page.locator(".rf-toast").count();
  check("N2 切到别的词时还没做完：没有提前弹通知", early === 0, `通知数=${early}`);

  const toast = page.locator(".rf-toast-ready");
  await toast.waitFor({ timeout: 30000 });
  const txt = (await toast.innerText()).replace(/\n/g, " ");
  check("N3 做完后（右栏已经在看别的词）弹出通知：「已做成 2 张卡」+ 词", /已做成 2 张卡/.test(txt) && /understand/.test(txt), txt);
  const link = toast.getByRole("link", { name: "查看" });
  check("N4 「查看」在新标签页打开卡片列表（地址、target 正确）", (await link.getAttribute("href")) === "/words?status=pending&word=w-e2e" && (await link.getAttribute("target")) === "_blank", `${await link.getAttribute("href")} ${await link.getAttribute("target")}`);
  const box = await page.locator(".rf-toasts").boundingBox();
  check("N5 通知在右上角：贴右边 16px、在顶栏下方", box && Math.abs(1440 - (box.x + box.width) - 16) <= 2 && box.y >= 64, JSON.stringify(box));
  await page.screenshot({ path: path.join(TMP, "toast-1440.png") });

  const [popup] = await Promise.all([ctx.waitForEvent("page", { timeout: 8000 }), link.click()]);
  check("N6 点「查看」真的开了一个新标签页，原来的阅读页还在", popup.url().includes("/words") && page.url().includes(`/texts/${textId}`), popup.url());
  await popup.close();
  await page.waitForTimeout(300);
  check("N7 点了「查看」后这条通知消失", (await page.locator(".rf-toast-ready").count()) === 0);

  // ===== 失败的通知 + 手动关闭 =====
  await word("discipline").scrollIntoViewIfNeeded();
  await word("discipline").click();
  await page.waitForFunction(() => { const b = [...document.querySelectorAll("button")].find((x) => /做成卡片/.test(x.textContent || "")); return b && !b.disabled; }, null, { timeout: 15000 });
  await page.getByRole("button", { name: /做成卡片/ }).click();
  await word("patience").scrollIntoViewIfNeeded();
  await word("patience").click();
  const bad = page.locator(".rf-toast-failed");
  await bad.waitFor({ timeout: 30000 });
  const badTxt = (await bad.innerText()).replace(/\n/g, " ");
  check("N8 做卡失败也会通知：标题 + 词 + 原因，没有「查看」按钮", /做卡失败/.test(badTxt) && /discipline/.test(badTxt) && /JSON/.test(badTxt) && (await bad.getByRole("link").count()) === 0, badTxt);
  await bad.getByRole("button", { name: "关闭通知" }).click();
  await page.waitForTimeout(200);
  check("N9 点叉可以手动关掉通知", (await page.locator(".rf-toast").count()) === 0);

  // ===== 窄屏：同样的流程，通知必须完整落在屏幕里、页面不横向溢出 =====
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await word("improve").scrollIntoViewIfNeeded();
  await word("improve").click();
  await page.waitForFunction(() => { const b = [...document.querySelectorAll("button")].find((x) => /做成卡片/.test(x.textContent || "")); return b && !b.disabled; }, null, { timeout: 15000 });
  await page.getByRole("button", { name: /做成卡片/ }).click();
  await word("everybody").scrollIntoViewIfNeeded();
  await word("everybody").click();
  await page.locator(".rf-toast-ready").waitFor({ timeout: 30000 });
  const mb = await page.locator(".rf-toasts").boundingBox();
  check("N10 390px：通知完整落在屏幕里（左右各留 16px、在顶栏下方）", mb && mb.x >= 15 && mb.x + mb.width <= 391 - 15 && mb.y >= 64, JSON.stringify(mb));
  await page.screenshot({ path: path.join(TMP, "toast-390.png") });
  check("N10b 390px 页面无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  check("N11 服务端日志没有异常", !/unhandled|TypeError|ReferenceError/i.test(log));
} catch (e) { fail++; console.log("FAIL  脚本异常:", e?.stack ?? e); }
finally {
  await browser?.close();
  server.kill("SIGTERM"); model.close();
  console.log(`\n${pass} passed, ${fail} failed  截图：${TMP}`);
  process.exit(fail ? 1 : 0);
}
