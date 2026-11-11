/**
 * P23 行内中文短释义：真实浏览器验证（临时库 + 临时端口，不碰真实数据）。
 *
 *   node scripts/e2e-inline-gloss.mjs      # 需要先 npm run build
 *
 * 覆盖：
 *   1. AI 语境义 → 标签显示「失控增长」
 *   2. 词典义兜底 → 标签来自 user_words.translation
 *   3. 伪元素不进 DOM 文本节点：段落 textContent 与库里的 content 逐字一致
 *   4. 点击划线仍能在右栏打开详解（pointer-events 穿透生效）
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.env.E2E_PORT || 3109);
const BASE = `http://127.0.0.1:${PORT}`;
const BODY = "The system can grow out of control when feedback loops are ignored.";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "readflow-inline-"));
const DB_PATH = path.join(tmpDir, "test.db");
const results = [];

function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

let log = "";
const server = spawn(
  process.execPath,
  [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT)],
  {
    cwd: ROOT,
    env: { ...process.env, DB_PATH, NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
server.stdout.on("data", (d) => (log += d.toString()));
server.stderr.on("data", (d) => (log += d.toString()));

let cookie = "";
async function api(pathname, { method = "GET", body } = {}) {
  const headers = {};
  if (body) headers["Content-Type"] = "application/json";
  if (cookie) headers.cookie = cookie;
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const raw = res.headers.get("set-cookie") ?? "";
  const m = raw.match(/readflow_session=([^;]+)/);
  if (m) cookie = `readflow_session=${m[1]}`;
  return { status: res.status, data: await res.json().catch(() => ({})) };
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
  throw new Error(`临时服务未就绪：\n${log.slice(-1500)}`);
}

let browser;
try {
  await waitReady();

  // 1. 建号 + 导入文本
  const setup = await api("/api/auth/setup", {
    method: "POST",
    body: { username: "inline_owner", password: "inline-pass-2026", phone: "13800138000" },
  });
  check("首次建号成功", setup.status === 200, `status=${setup.status}`);

  const created = await api("/api/texts", {
    method: "POST",
    body: { title: "[E2E] inline gloss", text: BODY, format: "plain" },
  });
  const textId = created.data.id;
  check("导入文本成功", Boolean(textId), JSON.stringify(created.data).slice(0, 120));

  const detail = await api(`/api/texts/${textId}`);
  const para = (detail.data.paragraphs ?? [])[0];
  check("拿到段落坐标", Boolean(para?.id), "");

  // 2. 给短语注入 AI 语境义（不经过前端点词，直接写回）
  const phrase = "grow out of control";
  const s = para.content.indexOf(phrase);
  const e = s + phrase.length;
  const ai = await api("/api/contexts/gloss", {
    method: "POST",
    body: {
      word: phrase,
      quote: phrase,
      textId,
      paragraphId: para.id,
      start: s,
      end: e,
      prefix: para.content.slice(0, s),
      suffix: para.content.slice(e),
      aiGloss: "「失控增长」——在这里形容系统规模随反馈回路不断放大。",
    },
  });
  check("AI 释义写回成功", ai.status === 200, `status=${ai.status}`);

  // 3. 再给一个单词建批注（无 aiGloss → 走词典义）
  const word = "feedback";
  const ws = para.content.indexOf(word);
  const we = ws + word.length;
  await api("/api/contexts/ensure", {
    method: "POST",
    body: {
      word,
      quote: word,
      textId,
      paragraphId: para.id,
      start: ws,
      end: we,
      prefix: para.content.slice(0, ws),
      suffix: para.content.slice(we),
    },
  });

  const ann = await api(`/api/annotations?textId=${textId}`);
  const glossRows = (ann.data.annotations ?? []).filter((a) => a.aiGloss || a.translation);
  check(
    "/api/annotations 同时带出 aiGloss 与 translation",
    glossRows.length === 2 && glossRows.some((a) => Boolean(a.translation)),
    `${glossRows.length} 条，translation=${glossRows.filter((a) => a.translation).length} 条`,
  );

  // 4. 浏览器里看标签
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const host = new URL(BASE).hostname;
  await ctx.addCookies([
    { name: "readflow_session", value: cookie.split("=")[1], domain: host, path: "/" },
  ]);
  const page = await ctx.newPage();
  await page.goto(`${BASE}/texts/${textId}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-pid] .w", { timeout: 15000 });
  await page.waitForTimeout(600);

  const tagged = await page.locator(".w-annotated-l[data-gloss]").count();
  check("正文出现带短释义的划线左端标记", tagged >= 1, `${tagged} 个`);

  const first = page.locator(".w-annotated-l[data-gloss]").first();
  const gloss = await first.getAttribute("data-gloss");
  check("AI 语境义提炼成短中文", gloss === "失控增长", String(gloss));

  const before = await first.evaluate((el) => getComputedStyle(el, "::before").content);
  check("CSS 伪元素真的渲染出中文", before.includes("失控增长"), before);

  // 5. 锚点契约：伪元素绝不能进 DOM 文本节点
  const domText = await page
    .locator(`[data-pid="${para.id}"]`)
    .evaluate((el) => el.textContent ?? "");
  check(
    "段落 textContent 与库里的 content 逐字一致（锚点未污染）",
    domText === para.content,
    `DOM=${domText.length} 字 / DB=${para.content.length} 字`,
  );

  // 6. 点击穿透：仍能打开右栏详解。
  // 与其它 E2E 一致用坐标点击（Playwright 的 actionability 检查会被文章卡片挡住，
  // 但真实鼠标事件不受影响），并确认右栏摊开的正是这条批注的 AI 释义。
  const box = await first.boundingBox();
  if (!box) throw new Error("拿不到划线词的位置");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  const asideText = await page.locator(".reader-aside").innerText().catch(() => "");
  check("点击划线仍能展开右侧详解", asideText.includes("失控增长"), asideText.slice(0, 80));

  await page.close();
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
  console.log("serverLog 尾部：\n" + log.slice(-1500));
  process.exit(1);
}
