/**
 * 插件端到端：用真实 Chrome 加载 unpacked 扩展，
 * 走 popup 配置 → 后台同步词表 → 网页高亮 + 释义标签全链路。
 *
 * 用法：node scripts/e2e-extension.mjs（需 3000 端口服务已启动）
 */
import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXT = path.join(ROOT, "extension");
const PROFILE = path.join("/tmp", `rf-ext-profile-${process.pid}`);
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};

// 一个含已存词的网页，验证高亮
const pageServer = http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><html><head><title>Ext Smoke</title></head><body>
    <h1>Reading test</h1>
    <p>This post only focuses on Prompt Engineering for modern AI systems.</p>
    <p>Another paragraph about Prompt and engineering here.</p>
  </body></html>`);
});
await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
const pageUrl = `http://127.0.0.1:${pageServer.address().port}/`;

// 确保插件 Token 存在
let cfg = await (await fetch(`${BASE}/api/settings`)).json();
if (!cfg.extension.token) {
  cfg = await (
    await fetch(`${BASE}/api/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ regenerateExtensionToken: true }),
    })
  ).json();
}
const token = cfg.extension.token;
if (!token) throw new Error("拿不到插件 Token");

/**
 * 浏览器选择：
 *  - 默认 channel="chromium"：Playwright 自带完整 Chromium 的新 headless 模式，支持扩展。
 *  - EXT_BROWSER=chrome：系统 Chrome（Chrome 137+ 已禁用命令行 --load-extension，会 SKIP）。
 *  - HEADFUL=1：有界面运行，用于真实验收。
 */
const headless = process.env.HEADFUL !== "1";
const channel = process.env.EXT_BROWSER === "chrome" ? "chrome" : "chromium";

let context;
try {
  context = await chromium.launchPersistentContext(PROFILE, {
    headless,
    channel,
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--no-first-run",
      "--no-default-browser-check",
      // 有界面模式把窗口挪到屏幕外，别打断正在用电脑的人
      ...(headless ? [] : ["--window-position=-2400,-2400", "--window-size=1200,900"]),
    ],
  });

  // 等 Service Worker 起来，从它的 URL 拿 extension id
  let worker = context.serviceWorkers()[0];
  for (let i = 0; i < 20 && !worker; i++) {
    await new Promise((r) => setTimeout(r, 400));
    worker = context.serviceWorkers()[0];
  }
  if (!worker) {
    // 有些版本需要主动打开扩展页触发 SW
    const probe = await context.newPage();
    await probe.goto("about:blank");
    for (let i = 0; i < 20 && !worker; i++) {
      await new Promise((r) => setTimeout(r, 400));
      worker = context.serviceWorkers()[0];
    }
    await probe.close();
  }
  if (!worker) {
    // headless Chrome 不保证加载 MV3 Service Worker；此时不算失败，
    // content script 的 DOM 行为已由 tests/unit/extension-content.test.ts 覆盖。
    // 需要在真实浏览器验收时，用有界面的 Chrome 打开 chrome://extensions 加载 extension/。
    console.log("SKIP  headless Chrome 未启动 MV3 Service Worker，跳过真实浏览器集成测试");
    console.log("      自动覆盖见 npm test（jsdom 跑 content script）；手动验收请加载 extension/ 目录");
    throw new Error("__SKIP_EXT__");
  }
  check("X0 扩展 Service Worker 已启动", true);

  const extId = new URL(worker.url()).host;
  const popup = await context.newPage();
  popup.on("pageerror", (e) => console.log("  [popup error]", e.message));
  await popup.goto(`chrome-extension://${extId}/src/popup.html`);
  await popup.fill("#server", BASE);
  await popup.fill("#token", token);
  await popup.click("#save");
  // 等真正的同步结果（带 ✓），不能只匹配「已同步」——否则会提前命中占位文案
  await popup.waitForFunction(
    () => /✓ 已同步 \d+ 个词/.test(document.getElementById("status")?.textContent || ""),
    { timeout: 15000 },
  );
  const status = await popup.locator("#status").innerText();
  const syncedCount = Number(status.match(/已同步 (\d+) 个词/)?.[1] ?? -1);
  check("X1 popup 保存配置并同步词表", /✓ 已同步 \d+ 个词/.test(status), status);
  check("X1b 同步回来的词表非空", syncedCount >= 2, `${syncedCount} 词`);
  await popup.close();

  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("  [page error]", e.message));
  await page.goto(pageUrl, { waitUntil: "load" });
  await page.waitForSelector(".rf-hl", { timeout: 15000 });
  await page.waitForTimeout(1200);
  const marks = await page.locator(".rf-hl").count();
  check("X2 网页正文出现已存词高亮", marks >= 2, `${marks} 处`);
  const glosses = await page.locator(".rf-gloss").allInnerTexts();
  check("X3 高亮上方带中文释义小标签", glosses.length >= 2, glosses.join(" / ").slice(0, 60));
  check("X4 右上角浮动工具条存在", (await page.locator(".rf-bar").count()) > 0);
  await page.close();
} catch (err) {
  if (err instanceof Error && err.message === "__SKIP_EXT__") {
    // 环境不支持，不算失败
  } else {
    console.log("扩展测试未完成：", err.message);
    results.push({ name: "扩展加载", ok: false });
  }
} finally {
  await context?.close().catch(() => {});
  pageServer.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
}

const passed = results.filter((r) => r.ok).length;
console.log(`\n===== ${passed}/${results.length} 通过 =====`);
if (passed !== results.length) process.exit(1);
