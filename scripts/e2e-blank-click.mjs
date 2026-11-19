/**
 * 回归：点词查词后，点正文空白不该清掉翻译卡和绿色标记。
 *
 *   node scripts/e2e-blank-click.mjs
 *
 * 背景：正文 onClick 原先有一句「点非词区域就 close()」。学生查完词继续读、
 * 顺手点一下空白，翻译卡和 w-anchor 立刻消失；慢网络下持久批注（w-annotated）
 * 还没异步回来，看起来就是「白查了」，刷新后又冒出来，非常迷惑。
 * 修复后点空白什么都不做，收起只走「再点同一个词」和 Esc。
 *
 * 覆盖：
 *   1. 点词：w-anchor + 右栏面板出现，落库后 w-annotated 也在
 *   2. 点正文空白：w-anchor、w-annotated、面板三者都保留
 *   3. 再点同一个词：收起（w-anchor 与面板消失），持久绿线 w-annotated 仍在
 *   4. 重新点词后按 Esc：收起，同样只清 w-anchor
 *
 * 自建隔离库 + 临时端口（3124），跑完删库，不碰真实数据。需要先 npm run build。
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
const PORT = 3124;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "blank-click");
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
    body: JSON.stringify({ username: "blank_owner", password: "blank-pass-2026", phone: "13800138004" }),
  });
  const cookie = setupRes.headers.get("set-cookie")?.match(/readflow_session=([^;]+)/)?.[1];
  if (!cookie) { log("建号失败: " + (await setupRes.text())); process.exit(1); }

  const BODY = Array.from({ length: 12 }, (_, i) =>
    `Paragraph ${i + 1}: the skill database tracks the history of previous skills and context functions. ` +
    `A meta-level agent performs agentic crossover over prior skills to create a new skill given a task. ` +
    `Instructions context instructions context instructions context.`,
  ).join("\n\n");
  const mkRes = await fetch(`${BASE}/api/texts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie: `readflow_session=${cookie}` },
    body: JSON.stringify({ title: "[E2E] blank click", text: BODY }),
  });
  const mk = await mkRes.json();
  const textId = mk.id ?? mk.text?.id;
  if (!textId) { log("建文失败: " + JSON.stringify(mk)); process.exit(1); }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/texts/${textId}`, { waitUntil: "networkidle" });
  await page.waitForSelector(".reading-body .w", { timeout: 10000 });

  // 找一个文档中部、可点的词，打标记
  await page.evaluate(() => {
    const ws = [...document.querySelectorAll(".reading-body .w")].filter(
      (e) => /^[A-Za-z]{4,}$/.test(e.textContent || ""),
    );
    for (const w of ws) {
      const r = w.getBoundingClientRect();
      if (r.top > 150 && r.top < 450) { w.setAttribute("data-probe", "1"); return; }
    }
    ws[0]?.setAttribute("data-probe", "1");
  });

  const state = () =>
    page.evaluate(() => {
      const w = document.querySelector('[data-probe="1"]');
      return {
        anchor: !!w?.classList.contains("w-anchor"),
        annotated: !!w?.classList.contains("w-annotated"),
        panel:
          [...document.querySelectorAll("textarea")].some((t) =>
            (t.placeholder || "").includes("我有别的问题"),
          ) || !!document.querySelector(".reader-note, .pick-card, [class*='note-card']"),
      };
    });
  const clickWord = async () => {
    const p = await page.evaluate(() => {
      const r = document.querySelector('[data-probe="1"]').getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.click(p.x, p.y);
  };

  // 1) 点词
  await clickWord();
  await page.waitForTimeout(400);
  let s = await state();
  check("点词：出现选中高亮", s.anchor, JSON.stringify(s));
  check("点词：右栏出现翻译卡", s.panel, JSON.stringify(s));
  check("点词落库后出现持久绿线", s.annotated, JSON.stringify(s));

  // 2) 点正文空白：三者都应保留
  const blank = await page.evaluate(() => {
    const paras = [...document.querySelectorAll(".reading-body [data-pid]")];
    for (const p of paras) {
      const r = p.getBoundingClientRect();
      if (r.top > 150 && r.top < 700) return { x: Math.round(r.right - 6), y: Math.round(r.top + 8) };
    }
    const first = paras[0]?.getBoundingClientRect();
    return first ? { x: Math.round(first.right - 6), y: Math.round(first.top + 8) } : null;
  });
  if (!blank) throw new Error("找不到正文空白点");
  await page.mouse.click(blank.x, blank.y);
  await page.waitForTimeout(200);
  s = await state();
  check("点空白：选中高亮保留", s.anchor, JSON.stringify(s));
  check("点空白：持久绿线保留", s.annotated, JSON.stringify(s));
  check("点空白：翻译卡保留", s.panel, JSON.stringify(s));

  // 3) 再点同一个词 = 收起（持久绿线仍在）
  await clickWord();
  await page.waitForTimeout(200);
  s = await state();
  check("再点同一词：选中高亮收起", !s.anchor, JSON.stringify(s));
  check("再点同一词：翻译卡收起", !s.panel, JSON.stringify(s));
  check("再点同一词：持久绿线仍在", s.annotated, JSON.stringify(s));

  // 4) 重新点词后按 Esc = 收起
  await clickWord();
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  s = await state();
  check("按 Esc：选中高亮收起", !s.anchor, JSON.stringify(s));
  check("按 Esc：翻译卡收起", !s.panel, JSON.stringify(s));
  check("按 Esc：持久绿线仍在", s.annotated, JSON.stringify(s));

  await browser.close();
  log(`\n合计 PASS=${pass} FAIL=${fail}`);
  process.exitCode = fail ? 1 : 0;
} catch (e) {
  log("脚本异常: " + (e?.stack ?? e));
  process.exitCode = 1;
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 500));
  rmSync(TMP, { recursive: true, force: true });
}
