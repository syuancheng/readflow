/**
 * P27 回归：词库按文章筛选（词只归最近那篇）+ 导出状态（未导出 / 已导出，标签注明应用）。
 * 隔离库 + 临时端口（3125），跑完删库。需要先 npm run build。
 *
 *   node scripts/e2e-word-library.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3125;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "word-library");
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
const q = (sql, ...args) => {
  const d = new Database(DB, { readonly: true });
  try { return d.prepare(sql).get(...args); } finally { d.close(); }
};

try {
  if (!(await waitServer())) { log("服务器没起来:\n" + serverLog.slice(-3000)); process.exit(1); }
  const setupRes = await fetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "lib_owner", password: "lib-pass-2026", phone: "13800138004" }),
  });
  const cookie = setupRes.headers.get("set-cookie")?.match(/readflow_session=([^;]+)/)?.[1];
  if (!cookie) { log("建号失败: " + (await setupRes.text())); process.exit(1); }
  const mkText = async (title, text) => {
    const r = await fetch(`${BASE}/api/texts`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: `readflow_session=${cookie}` },
      body: JSON.stringify({ title, text }),
    });
    return (await r.json()).id;
  };
  const textA = await mkText("Article Alpha", "The skill database tracks the history of previous skills.");
  const textB = await mkText("Article Beta", "Every database needs a history of changes and a careful owner.");

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  await ctx.addCookies([{ name: "readflow_session", value: cookie, domain: "127.0.0.1", path: "/" }]);
  const page = await ctx.newPage();
  // 不调真实模型
  await page.route("**/api/explain", (route) =>
    route.fulfill({ status: 200, headers: { "Content-Type": "text/event-stream; charset=utf-8" }, body: "释义：模拟" }),
  );

  const clickWord = async (textId, word) => {
    await page.goto(`${BASE}/texts/${textId}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".reading-body .w", { timeout: 15000 });
    await page.waitForTimeout(700);
    const b = await page.evaluate((w) => {
      const el = [...document.querySelectorAll(".reading-body .w")].find((x) => x.textContent === w);
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, word);
    await page.mouse.click(b.x, b.y);
    await page.waitForTimeout(1500);
  };
  // A: database, skill；B（之后）：database, owner —— database 归 B
  await clickWord(textA, "database");
  await clickWord(textA, "skill");
  await clickWord(textB, "database");
  await clickWord(textB, "owner");
  const nCtx = q("select count(*) c from contexts").c;
  check("0 准备：4 条查词记录，3 个词", nCtx === 4 && q("select count(*) c from user_words").c === 3, `contexts=${nCtx}`);

  // 模拟导出：skill 导出了墨墨看词猜义 + 挖空（成功），owner 只有失败记录
  const w = new Database(DB);
  const idOf = (lemma) => w.prepare("select id from user_words where lemma = ?").get(lemma).id;
  const ins = w.prepare(
    "insert into exports (id, user_word_id, target, deck_id, card_type, status, pushed_at) values (?, ?, 'markji', 'deck1', ?, ?, ?)",
  );
  ins.run(randomUUID(), idOf("skill"), "qa", "done", Date.now());
  ins.run(randomUUID(), idOf("skill"), "cloze", "done", Date.now());
  ins.run(randomUUID(), idOf("owner"), "qa", "failed", null);
  w.close();

  await page.goto(`${BASE}/words`, { waitUntil: "load" });
  await page.waitForTimeout(700);
  // 折叠的行里，生词是原句片段里加粗的那个
  const item = (word) => page.locator("li.wl-row", { has: page.locator(".wl-snippet b", { hasText: new RegExp(`^${word}$`, "i") }) });
  const rows = (sorted = true) =>
    page.evaluate((s) => {
      const r = [...document.querySelectorAll("li.wl-row .wl-snippet b")].map((b) => b.textContent.trim().toLowerCase());
      return s ? r.sort() : r;
    }, sorted);
  const side = (label) => page.locator(".wl-side-item", { hasText: label }).first();
  const sideTexts = await page.locator(".wl-side-item").allInnerTexts();
  const flat = sideTexts.map((t) => t.replace(/\s+/g, " ").trim());
  check(
    "1 左侧筛选：全部 / 星标 / 未导出 / 已导出，没有学习中 / 已掌握",
    flat.includes("全部 3") && flat.includes("未导出 2") && flat.includes("已导出 1") && flat.some((t) => t.startsWith("★ 星标")) &&
      flat.every((t) => !t.includes("已掌握") && !t.includes("学习中")),
    flat.join(" / "),
  );
  const tag = item("skill").locator(".wl-export-tag");
  const tagText = await tag.innerText().catch(() => "");
  const tagTitle = (await tag.getAttribute("title").catch(() => "")) ?? "";
  check("2 已导出的词带小标签，悬停可见卡片类型", tagText.includes("墨墨") && tagTitle.includes("看词猜义") && tagTitle.includes("挖空填空"), `${tagText} | ${tagTitle}`);
  check("3 只有失败记录的词不算已导出", (await item("owner").locator(".wl-export-tag").count()) === 0);

  await side("已导出").click();
  await page.waitForTimeout(300);
  check("4 「已导出」只剩 skill", JSON.stringify(await rows()) === '["skill"]', JSON.stringify(await rows()));
  await side("未导出").click();
  await page.waitForTimeout(300);
  check("5 「未导出」是 database、owner", JSON.stringify(await rows()) === '["database","owner"]', JSON.stringify(await rows()));
  await side("全部").click();

  const arts = (await page.locator(".wl-side-articles .wl-side-item").allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  check("6 文章列表：两篇文章带词数，最近的在前", arts[1] === "📖 Article Beta 2" && arts[2] === "📖 Article Alpha 1", arts.join(" / "));
  await page.locator(".wl-side-articles .wl-side-item", { hasText: "Article Alpha" }).click();
  await page.waitForTimeout(300);
  check("7 选 Alpha：只有 skill（database 已归最近的 Beta）", JSON.stringify(await rows()) === '["skill"]', JSON.stringify(await rows()));
  await page.locator(".wl-side-articles .wl-side-item", { hasText: "Article Beta" }).click();
  await page.waitForTimeout(300);
  check("8 选 Beta：database、owner", JSON.stringify(await rows()) === '["database","owner"]', JSON.stringify(await rows()));
  const dbRow = await item("database").innerText();
  check(
    "9 database 一行：原句片段来自 Beta、中文简短、来源链接",
    dbRow.includes("Every") && !dbRow.includes("The skill") && dbRow.includes("数据库") && dbRow.includes("Article Beta"),
    dbRow.replace(/\s+/g, " ").slice(0, 90),
  );
  await page.locator(".wl-side-articles .wl-side-item", { hasText: "全部文章" }).click();
  await page.waitForTimeout(300);

  // 点一行展开详情
  await item("database").locator(".wl-snippet").click();
  await page.waitForTimeout(300);
  const detail = await item("database").locator(".wl-detail").innerText().catch(() => "");
  check("10 点一行展开：音标、完整释义、原句、删除", detail.includes("/") && detail.includes("数据库") && detail.includes("Every database needs") && detail.includes("删除"), detail.replace(/\s+/g, " ").slice(0, 80));

  // 排序
  await page.selectOption('select[aria-label="排序"]', "alpha");
  await page.waitForTimeout(300);
  check("11 字母顺序排序", JSON.stringify(await rows(false)) === '["database","owner","skill"]', JSON.stringify(await rows(false)));
  await page.selectOption('select[aria-label="排序"]', "recent");

  if (process.env.SHOT_DIR) {
    await item("owner").locator(".wl-check").click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(process.env.SHOT_DIR, "word-library.png"), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(process.env.SHOT_DIR, "word-library-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 860 });
    await item("owner").locator(".wl-check").click();
    await page.waitForTimeout(200);
  }

  // ---- 旧的导出入口已并入「待推送」（P33）----
  const pendBtn = page.locator(".wl-export-btn");
  check(
    "14 工具栏没有「导出到墨墨」，换成「待推送」按钮",
    (await pendBtn.count()) === 1 && (await pendBtn.innerText()).includes("待推送") && (await page.locator("text=导出到墨墨").count()) === 0,
    await pendBtn.innerText(),
  );
  await pendBtn.click();
  await page.waitForSelector("text=没有待推送的卡片");
  check("15 点「待推送」切到待推送视图，左侧该项高亮", (await page.locator(".wl-side-item-on", { hasText: "待推送" }).count()) === 1);
  await page.goto(`${BASE}/export`, { waitUntil: "load" });
  check("16 旧的 /export 页面跳转到 /words?status=pending", new URL(page.url()).pathname === "/words" && new URL(page.url()).searchParams.get("status") === "pending", page.url());
  const gone = await page.evaluate(async () => {
    const r = await fetch("/api/export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ types: ["qa"], wordIds: ["x"] }) });
    return { status: r.status, body: await r.json() };
  });
  check("17 旧的 /api/export 一律返回 410，提示改去待推送", gone.status === 410 && gone.body.error.includes("待推送"), JSON.stringify(gone));
  await page.goto(`${BASE}/words`, { waitUntil: "load" });
  await page.waitForTimeout(600);
  await item("database").locator(".wl-snippet").click();
  check("18 词的详情里不再有「导出这个词」", (await item("database").locator(".wl-export-one").count()) === 0 && (await page.locator("text=导出这个词").count()) === 0);
  await item("database").locator(".wl-snippet").click();

  // 批量：勾两个 → 加星标
  await item("owner").locator(".wl-check").click();
  await item("skill").locator(".wl-check").click();
  await page.locator(".wl-tool-btn", { hasText: "批量操作" }).click();
  await page.locator(".wl-menu button", { hasText: "加星标" }).click();
  await page.waitForTimeout(800);
  const starredDb = q("select count(*) c from user_words where starred = 1").c;
  const starSide = (await side("星标").innerText()).replace(/\s+/g, " ");
  check("21 批量加星标：两个词都加上、计数更新", starredDb === 2 && starSide.includes("2"), `库里星标=${starredDb} 侧栏=${starSide}`);

  // 批量删除（确认框点确定）
  page.once("dialog", (d) => d.accept());
  await page.locator(".wl-tool-btn", { hasText: "批量操作" }).click();
  await page.locator(".wl-menu button", { hasText: "删除" }).click();
  await page.waitForTimeout(1000);
  const left = q("select group_concat(lemma) l from user_words").l;
  check("22 批量删除：选中的两个词删掉，只剩 database", left === "database" && JSON.stringify(await rows()) === '["database"]', `库里=${left}`);

  await browser.close();
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  rmSync(TMP, { recursive: true, force: true });
}
log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
