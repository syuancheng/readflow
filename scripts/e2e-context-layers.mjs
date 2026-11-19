/**
 * 回归：两层上下文真的随每一轮 /api/explain 请求发出去。
 *
 *   node scripts/e2e-context-layers.mjs
 *
 * 单测只证明纯函数和消息结构对；这个脚本用真实浏览器证明「前端点词 → 请求体」
 * 这一环没掉链子，且追问时前缀稳定（两次请求的 contextLayers 逐字相同）。
 *
 * 覆盖：
 *   1. 选一个单词（plain），请求体 contextLayers.sentence = 所在句
 *   2. contextLayers.nearContext 跨段拿到三句外的先行词 loaf cake
 *   3. wholeSentence 分支（整句没看懂）也带同样的两层，不再是空 prefix/suffix
 *   4. 追问一次，两次请求的 contextLayers 逐字相同 → system 前缀命中缓存
 *
 * 自建隔离库 + 临时端口（3125），跑完删库，不碰真实数据。需要先 npm run build。
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
const PORT = 3125;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "context-layers");
const DB = path.join(TMP, "readflow.db");

const log = (m) => console.log(m);
let pass = 0, fail = 0;
function check(name, ok, detail = "") {
  if (ok) pass++; else fail++;
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, DB_PATH: DB, NODE_ENV: "production", NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" },
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

try {
  if (!(await waitServer())) {
    log("服务器没起来:\n" + serverLog.slice(-3000));
    process.exit(1);
  }

  const setupRes = await fetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "layers_owner", password: "layers-pass-2026", phone: "13800138007" }),
  });
  const cookie = setupRes.headers.get("set-cookie")?.match(/readflow_session=([^;]+)/)?.[1];
  if (!cookie) { log("建号失败: " + (await setupRes.text())); process.exit(1); }

  // 对话体：每句一段，plain one 的先行词 loaf cake 在三段之外
  const DIALOGUE = [
    "Woman: So I was thinking a loaf cake.",
    "Man: The bakery has banana bread.",
    "Woman: That could work.",
    "Man: Get the plain one.",
  ];
  const BODY = DIALOGUE.join("\n\n");
  const mkRes = await fetch(`${BASE}/api/texts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `readflow_session=${cookie}` },
    body: JSON.stringify({ title: "[E2E] context layers", text: BODY }),
  });
  const mk = await mkRes.json();
  const textId = mk.id ?? mk.text?.id;
  if (!textId) { log("建文失败: " + JSON.stringify(mk)); process.exit(1); }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();

  // 抓每一条 /api/explain 的请求体
  const bodies = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/explain") && r.method() === "POST") {
      try { bodies.push(JSON.parse(r.postData() || "{}")); } catch { /* 忽略 */ }
    }
  });

  await page.goto(`${BASE}/texts/${textId}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".reading-body .w", { timeout: 10000 });

  // 给最后一段的 plain 打标记
  await page.evaluate(() => {
    const paras = [...document.querySelectorAll(".reading-body [data-pid]")];
    const last = paras[paras.length - 1];
    const ws = [...(last?.querySelectorAll(".w") ?? [])];
    const target = ws.find((e) => e.textContent === "plain");
    if (target) target.setAttribute("data-probe", "1");
  });
  const hasProbe = await page.locator('[data-probe="1"]').count();
  check("找到目标词 plain", hasProbe > 0);

  const clickProbe = async () => {
    const p = await page.evaluate(() => {
      const r = document.querySelector('[data-probe="1"]').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.click(p.x, p.y);
  };

  // 1+2) 点词 → 打开「＋」菜单 → 点「这个词在这句里什么意思」主动发起 AI
  await clickProbe();
  await page.waitForTimeout(300);
  await page.locator(".rf-composer-plus").click();
  await page.locator('.rf-menu-item:has-text("这个词在这句里什么意思")').click();
  await page.waitForTimeout(700);
  check("发出了解释请求", bodies.length > 0, `共 ${bodies.length} 条`);
  const first = bodies[0];
  const layers = first?.contextLayers;
  check("请求体带 contextLayers", Boolean(layers), JSON.stringify(first).slice(0, 200));
  check("layer1 所在句正确", layers?.sentence === "Man: Get the plain one.", layers?.sentence);
  check(
    "layer2 跨三段拿到先行词 loaf cake",
    Array.isArray(layers?.nearContext) && layers.nearContext.some((s) => s.includes("loaf cake")),
    JSON.stringify(layers?.nearContext),
  );
  check("layer2 倒序且带说话人标签", layers?.nearContext?.[0] === "Woman: That could work.");
  check("新路径不再传旧 prefix/suffix", !("prefix" in first) && !("suffix" in first));

  // 3) 整句没看懂（wholeSentence 分支）也带同样的两层，不再是空 prefix/suffix
  await page.locator(".rf-composer-plus").click();
  await page.locator('.rf-menu-item:has-text("整句没看懂")').click();
  await page.waitForTimeout(600);
  const whole = bodies[bodies.length - 1];
  check("整句没看懂请求也带 contextLayers", Boolean(whole?.contextLayers));
  check(
    "整句分支的 layer2 同样含 loaf cake",
    Array.isArray(whole?.contextLayers?.nearContext) &&
      whole.contextLayers.nearContext.some((s) => s.includes("loaf cake")),
    JSON.stringify(whole?.contextLayers?.nearContext),
  );
  check("整句分支不再传旧 prefix/suffix", !("prefix" in whole) && !("suffix" in whole));

  // 4) 逐轮前缀稳定：首次与整句这轮的 contextLayers 逐字相同
  check(
    "两次请求的 contextLayers 逐字相同（缓存前缀稳定）",
    JSON.stringify(whole?.contextLayers) === JSON.stringify(first?.contextLayers),
  );

  await browser.close();
  log(`\n结果: ${pass} PASS / ${fail} FAIL`);
  if (fail > 0) process.exitCode = 1;
} catch (err) {
  log("脚本异常: " + (err?.stack || err));
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
}
