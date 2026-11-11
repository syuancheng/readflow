/**
 * 「词典查不到就自动问 AI」的浏览器级验证。
 *
 * 用法：BASE=http://127.0.0.1:3000 node scripts/e2e-auto-explain.mjs
 *
 * 必须在**生产构建**的 3000 上跑：`next dev` 页面可能没 hydrate，点词/拖选
 * 完全不触发 React 事件，会得到「没有请求」的假阴性。脚本开头会检查 hydration。
 *
 * 覆盖：
 *  A. 词典命中的单词 → 不自动发 /api/explain（成本闸门仍在）
 *  B. 词典查不到的短语 → 不用点按钮，自动 POST /api/explain 并流式出释义
 *  C. 释义写回批注；词库里只有短释义，句子地图没进卡片背面
 *  D. 回看一条没有 AI 释义的旧批注 → 不自动发请求，手动入口仍在
 *
 * 结束时删掉自己造的文本与词，不污染用户库。
 */
import { chromium } from "playwright";
import { ensureAuth, authCookies } from "./e2e-auth.mjs";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
await ensureAuth(BASE);
const TITLE = `[E2E] auto-explain ${Date.now()}`;
const BODY =
  "The tradition dates back to a small book written in 1920. It is still useful today.";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const j = async (r) => {
  try {
    return await r.json();
  } catch {
    return {};
  }
};

let textId;
let explainCount = 0;
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies(authCookies(BASE));
const page = await ctx.newPage();
page.on("request", (req) => {
  if (req.url().includes("/api/explain")) explainCount += 1;
});
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

async function cleanup() {
  if (!textId) return;
  const { words = [] } = await j(await fetch(`${BASE}/api/words?textId=${textId}`));
  for (const w of words) {
    await fetch(`${BASE}/api/words/${w.id}`, { method: "DELETE" }).catch(() => {});
  }
  await fetch(`${BASE}/api/texts/${textId}`, { method: "DELETE" }).catch(() => {});
}

try {
  const created = await j(
    await fetch(`${BASE}/api/texts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: TITLE, text: BODY, format: "plain" }),
    }),
  );
  textId = created.id;
  if (!textId) throw new Error(`创建测试文本失败：${JSON.stringify(created)}`);

  await page.goto(`${BASE}/texts/${textId}`, { waitUntil: "load" });
  // P23：自动收词开关已移除，点词恒定落库，不需要再设置 localStorage
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(800);

  // 没 hydrate 的话下面所有交互都是假的，先挡住
  const hydrated = await page.evaluate(() => {
    const el = document.querySelector("[data-pid] .w");
    return Boolean(el && Object.keys(el).some((k) => k.startsWith("__reactProps$")));
  });
  check("页面已 hydrate（生产构建交互验证的前提）", hydrated);
  if (!hydrated) throw new Error("页面未 hydrate，后续断言不可信");

  /** 按词文本取一个 .w 的屏幕矩形 */
  const rectOf = (word, nth = 0) =>
    page.evaluate(
      ({ word, nth }) => {
        const els = [...document.querySelectorAll("[data-pid] .w")].filter(
          (e) => e.textContent.trim() === word,
        );
        const el = els[nth];
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        return el.getBoundingClientRect().toJSON();
      },
      { word, nth },
    );

  // ---------- A：词典命中的单词，不该自动烧 AI ----------
  const tradition = await rectOf("tradition");
  await page.mouse.click(tradition.x + tradition.width / 2, tradition.y + tradition.height / 2);
  await page.waitForTimeout(1500);
  const cardA = await page.evaluate(() => {
    const card = document.querySelector(".reader-note");
    return { open: Boolean(card), text: card?.innerText ?? "" };
  });
  check(
    "A1 点词典命中的词 → 弹出释义卡且显示词典结果",
    cardA.open && !cardA.text.includes("词典未收录") && !cardA.text.includes("查词典中"),
    cardA.text.slice(0, 90).replace(/\n/g, " / "),
  );
  check("A2 词典命中 → 没有自动发 /api/explain（80% 点击仍不花钱）", explainCount === 0, `count=${explainCount}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // ---------- B：拖选词典查不到的短语，自动问 AI ----------
  const first = await rectOf("dates");
  const last = await rectOf("to");
  if (!first || !last) throw new Error("没找到 dates / to 的词 span");
  await page.waitForTimeout(200);
  await page.mouse.move(first.x + 2, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(last.x + last.width - 2, last.y + last.height / 2, { steps: 10 });
  await page.mouse.up();

  const quote = await page.evaluate(() => {
    const t = document.querySelector(".reader-note p")?.textContent?.trim() ?? "";
    return t;
  });
  check("B1 拖选得到「dates back to」短语", quote.includes("dates back to"), quote);

  // 关键：期间完全没点过「✨ AI 释义」按钮，请求是词典回调自己发起的
  await page.waitForTimeout(600);
  const autoFired = explainCount > 0;
  check("B2 不点按钮，自动发出 /api/explain 请求", autoFired, `count=${explainCount}`);
  const manualBtnGone = await page.evaluate(
    () => ![...document.querySelectorAll(".reader-note button")].some((b) => b.textContent.includes("✨ AI 释义")),
  );
  check("B3 手动「✨ AI 释义」按钮已被自动流程取代", manualBtnGone);

  // 等真实模型流式结束（本机配了 DeepSeek；没配则会显示引导文案）
  await page.waitForFunction(
    () => {
      const card = document.querySelector(".reader-note");
      if (!card) return false;
      const t = card.innerText;
      if (t.includes("正在思考") || t.includes("生成中")) return false;
      const body = card.querySelector(".rf-md")?.innerText ?? "";
      return body.length > 20 || t.includes("配置好模型后重试") || t.includes("重试");
    },
    { timeout: 90000 },
  );
  const answer = await page.evaluate(() => document.querySelector(".reader-note .rf-md")?.innerText ?? "");
  check(
    "B4 流式输出了实质答案（不是空卡 / 不是无模型引导 / 不是报错）",
    answer.length > 20 && !answer.includes("还没有配置 AI 模型") && !answer.includes("[Error:"),
    `${answer.length} 字：${answer.slice(0, 70).replace(/\n/g, " / ")}`,
  );

  // ---------- C：写回批注，且卡片背面只有短释义 ----------
  await page.waitForTimeout(1200);
  const { annotations = [] } = await j(await fetch(`${BASE}/api/annotations?textId=${textId}`));
  const phraseAnnot = annotations.find((a) => a.quote.includes("dates back to"));
  check("C1 AI 全文写回 contexts.ai_gloss（回看不用重问）", Boolean(phraseAnnot?.aiGloss && phraseAnnot.aiGloss.length > 20), `${phraseAnnot?.aiGloss?.length ?? 0} 字`);

  const { words = [] } = await j(await fetch(`${BASE}/api/words?textId=${textId}`));
  const phraseWord = words.find((w) => (w.displayForm ?? "").includes("dates back to"));
  const translation = phraseWord?.translation ?? "";
  check(
    "C2 词库只有短释义：句子地图 / 成分标注 / emoji 没进卡片背面",
    Boolean(translation) &&
      !/(🧩|⚠️|🔗|（主语）|（系动词）)/.test(translation) &&
      translation.length <= 101, // cardGloss cap=100 + 省略号
    translation.slice(0, 90),
  );

  // ---------- D：回看旧批注不自动烧请求 ----------
  const before = explainCount;
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(800);
  // 列表已移除：点正文里那条已存批注的绿色标记来回看
  const opened = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-pid] .w.w-annotated")].find((b) =>
      (b.textContent ?? "").toLowerCase().includes("tradition"),
    );
    if (!el) return false;
    el.click();
    return true;
  });
  await page.waitForTimeout(1500);
  const manualBtn = await page.evaluate(() =>
    [...document.querySelectorAll(".reader-note button")].some((b) => b.textContent.includes("✨ AI 释义")),
  );
  check("D1 点正文绿色标记能打开这条词典命中、无 AI 释义的旧批注", opened);
  check("D2 回看旧批注 → 不自动发 /api/explain", explainCount === before, `before=${before} after=${explainCount}`);
  check("D3 手动「✨ AI 释义」入口仍可用（不把回看路径堵死）", manualBtn);
} catch (e) {
  check("脚本执行无异常", false, e instanceof Error ? e.message : String(e));
} finally {
  await cleanup();
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
