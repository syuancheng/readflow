/**
 * E2E：AI 释义「点了就该存下来、下次点开不用再问一次」。
 *
 * 背景（用户实测 bug）：点词 A（不用 AI）→ 点新词 B 并出 AI 释义 → 点回 A，
 * B 的答案还在卡片上看过，但 contexts.ai_gloss 是 NULL，翻回去还得重新问模型。
 * 根因是旧客户端要自己先找到 contextId，找不到就静默 return。
 *
 * 同一个概念混淆还造成第二个 bug（delegate）：全局词库里收过的词，在当前文章
 * 点开时 savedMap 命中直接 return，本文这一处永远没有 context、进不了「已存批注」。
 * 两组 bug 现在都由服务端按锚点幂等裁决（/api/contexts/gloss 与 /api/contexts/ensure）。
 *
 * 四组控制变量：
 *   1. 原始操作序列：A（词典命中）→ B（词典未命中、自动问 AI）→ 回 A → 再点 B
 *   2. B 已在全局词库、但在新文章里没有 context：点词不再自动收词，服务端必须补建
 *   3. 自动收词关闭：点词不落库，服务端仍必须把答案存下来
 *   4. delegate 案例：全局已收过的词在新文章第一次点开也要进「已存批注」，
 *      且同一锚点重复 ensure 只能有 1 条 context（只读 SQLite 校验）
 *
 * 运行前需要生产服务在 3000 端口，且是最新构建：
 *   npm run test:gloss-persist
 */
import { chromium } from "playwright";
import { createRequire } from "node:module";
import { ensureAuth, authCookies } from "./e2e-auth.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
// 只读校验 context 是否重复（/api/annotations 按词条去重，看不出重复插入）。
// 把 BASE 指向临时库服务时，用 E2E_DB 指到同一个库，否则会读到真实库。
const db = new Database(
  process.env.E2E_DB ?? new URL("../data/readflow.db", import.meta.url).pathname,
  { readonly: true },
);

const BASE = process.env.READFLOW_BASE ?? "http://127.0.0.1:3000";
const stamp = Date.now().toString(36);
// 生造词保证 ECDICT 查不到、全局词库里也没有（每次运行都不同）
const B = `quasimorphic${stamp}`;
const D = `flurblesome${stamp}`;
const BODY_A = `The meticulous widget sits inside a ${B} pipeline that keeps states and artifacts in sync over a long run. The harness should not carry the entire workflow in context.`;
const BODY_B = `A ${B} pipeline keeps states and artifacts in sync over a long run.`;
const BODY_D = `A ${D} pipeline keeps states and artifacts in sync over a long run.`;

const j = async (r) => {
  try {
    return await r.json();
  } catch {
    return {};
  }
};
const ok = (cond, msg) => {
  if (!cond) throw new Error(`断言失败：${msg}`);
  console.log(`  ✓ ${msg}`);
};

await ensureAuth(BASE);
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await ctx.addCookies(authCookies(BASE));
const page = await ctx.newPage();

let explainCount = 0;
page.on("request", (r) => {
  if (r.url().includes("/api/explain")) explainCount += 1;
});
page.on("pageerror", (e) => console.log(`  ! pageerror: ${e.message}`));

const createdTextIds = [];
const createdWordIds = new Set();

async function createText(title, text, format = "plain") {
  const d = await j(
    await fetch(`${BASE}/api/texts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, text, format }),
    }),
  );
  if (!d.id) throw new Error(`创建文本失败：${JSON.stringify(d)}`);
  createdTextIds.push(d.id);
  return d.id;
}
async function annotations(textId) {
  const d = await j(await fetch(`${BASE}/api/annotations?textId=${textId}`));
  return d.annotations ?? [];
}
async function waitForGloss(textId, quote, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const a = (await annotations(textId)).find((x) => x.quote.trim() === quote);
    if (a?.aiGloss) return a;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`等不到 ${quote} 的 AI 释义落库（${timeout}ms）`);
}
const rectOf = (word) =>
  page.evaluate((w) => {
    const el = [...document.querySelectorAll("[data-pid] .w")].find(
      (e) => e.textContent.trim() === w,
    );
    if (!el) return null;
    el.scrollIntoView({ block: "center" });
    return el.getBoundingClientRect().toJSON();
  }, word);
async function clickWord(w) {
  const r = await rectOf(w);
  if (!r) throw new Error(`找不到词 span: ${w}`);
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
}
async function openReader(textId, autoSave = true) {
  await page.goto(`${BASE}/texts/${textId}`, { waitUntil: "load" });
  await page.evaluate(
    (v) => localStorage.setItem("readflow.autoSave", v),
    autoSave ? "1" : "0",
  );
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(700);
  const hydrated = await page.evaluate(() => {
    const el = document.querySelector("[data-pid] .w");
    return Boolean(el && Object.keys(el).some((k) => k.startsWith("__reactProps$")));
  });
  if (!hydrated) throw new Error("页面没有 hydrate，交互验证会假阴性");
}
async function collectWords(textId) {
  const d = await j(await fetch(`${BASE}/api/words?textId=${textId}`));
  for (const w of d.words ?? []) createdWordIds.add(w.id);
}

try {
  // 找一个「词典命中、但全局词库里没有」的 A，保证第一下不会触发 AI
  const allWords = await j(await fetch(`${BASE}/api/words`));
  const globalLemmas = new Set((allWords.words ?? []).map((w) => w.lemma.toLowerCase()));
  let A = "";
  for (const candidate of ["meticulous", "perspicacious", "resilient", "obsolete", "diligent"]) {
    if (globalLemmas.has(candidate)) continue;
    const d = await j(await fetch(`${BASE}/api/dict?word=${encodeURIComponent(candidate)}`));
    if (d.entry) {
      A = candidate;
      break;
    }
  }
  if (!A) throw new Error("找不到合适的词典命中词做 A");
  const BODY = BODY_A.replace("meticulous", A);
  console.log(`A=${A}（词典命中）  B=${B}（词典未命中）  D=${D}`);

  // ===== 场景 1：用户原始操作序列 =====
  console.log("\n[场景 1] 原始操作：A → B(AI) → 回 A → 再点 B");
  const text1 = await createText(`[E2E] gloss persist 1 ${stamp}`, BODY);
  await openReader(text1);
  const before1 = explainCount;
  await clickWord(A);
  await page.waitForTimeout(1200);
  ok(explainCount === before1, "词典命中的 A 不触发 /api/explain");

  await clickWord(B);
  const a1 = await waitForGloss(text1, B);
  ok(a1.aiGloss.length > 30, `B 的 AI 释义已落库（${a1.aiGloss.length} 字）`);
  const afterB = explainCount;

  await clickWord(A);
  await page.waitForTimeout(900);
  const back = (await annotations(text1)).find((x) => x.quote.trim() === B);
  ok(Boolean(back?.aiGloss), "点回 A 之后 B 的释义仍在数据库里");
  ok(explainCount === afterB, "点回 A 没有再次请求 AI");

  await clickWord(B);
  await page.waitForTimeout(1400);
  const reopenMd = await page.evaluate(
    () => document.querySelector(".reader-note .rf-md")?.innerText ?? "",
  );
  ok(reopenMd.length > 30, "再点 B 直接看到已存释义");
  ok(explainCount === afterB, "再点 B 不需要重新查一次 AI");
  const listText = await page.evaluate(() => document.querySelector(".rf-annots-list")?.innerText ?? "");
  ok(listText.includes("已存 AI 释义"), "已存批注列表出现「已存 AI 释义」标记");
  await collectWords(text1);

  // ===== 场景 2：词已在全局词库、本文没有 context =====
  console.log("\n[场景 2] 同一个 B 出现在新文章（点词不再自动收词）");
  const text2 = await createText(`[E2E] gloss persist 2 ${stamp}`, BODY_B);
  await openReader(text2);
  ok((await annotations(text2)).length === 0, "新文章初始没有 B 的批注");
  await clickWord(B);
  const a2 = await waitForGloss(text2, B);
  ok(a2.aiGloss.length > 30, `服务端补建批注并写入释义（${a2.aiGloss.length} 字）`);
  await collectWords(text2);

  // ===== 场景 3：自动收词关闭 =====
  console.log("\n[场景 3] 自动收词关闭时点 D");
  const text3 = await createText(`[E2E] gloss persist 3 ${stamp}`, BODY_D);
  await openReader(text3, false);
  await clickWord(D);
  const a3 = await waitForGloss(text3, D);
  ok(a3.aiGloss.length > 30, `自动收词关闭时释义仍被保存（${a3.aiGloss.length} 字）`);
  await collectWords(text3);

  // ===== 场景 4：全局已收过的词，在另一篇文章里也要能进「已存批注」 =====
  // 复刻用户实测的 delegate 案例：词在别的文章收过，点开时 savedMap 命中，
  // 旧逻辑直接 return，于是当前文章永远没有这一处的 context。
  console.log(`\n[场景 4] 全局已收过的 ${A} 在另一篇文章里点开（delegate 案例）`);
  const text4 = await createText(
    `[E2E] gloss persist 4 ${stamp}`,
    `The ${A} widget keeps states and artifacts in sync over a long run.`,
  );
  const globals = await j(await fetch(`${BASE}/api/words`));
  ok(
    (globals.words ?? []).some((w) => w.lemma.toLowerCase() === A),
    `${A} 已在全局词库（但在本文将是第一次出现）`,
  );
  ok((await annotations(text4)).length === 0, "新文章初始没有批注");
  await openReader(text4);
  const before4 = explainCount;
  await clickWord(A);
  await page.waitForTimeout(1200);
  ok(explainCount === before4, "词典命中，不触发 AI");
  ok(
    (await annotations(text4)).some((x) => x.quote.trim() === A),
    "本文「已存批注」里出现了这个全局已收过的词",
  );

  const detail = await j(await fetch(`${BASE}/api/texts/${text4}`));
  const para = (detail.paragraphs ?? []).find((p) => p.content.includes(A));
  const start = para.content.indexOf(A);
  const end = start + A.length;
  const anchorBody = {
    word: A,
    quote: A,
    textId: text4,
    paragraphId: para.id,
    start,
    end,
    prefix: "",
    suffix: "",
  };
  for (let i = 0; i < 2; i++) {
    await fetch(`${BASE}/api/contexts/ensure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(anchorBody),
    });
  }
  const n = db
    .prepare("select count(*) n from contexts where text_id=? and start=? and end=?")
    .get(text4, start, end).n;
  ok(n === 1, `同一锚点重复 ensure 仍只有 1 条 context（实际 ${n}）`);
  await collectWords(text4);

  console.log("\n全部通过 ✓");
} catch (e) {
  console.error(`\nE2E 失败：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  for (const id of createdWordIds) {
    await fetch(`${BASE}/api/words/${id}`, { method: "DELETE" }).catch(() => {});
  }
  for (const id of createdTextIds) {
    await fetch(`${BASE}/api/texts/${id}`, { method: "DELETE" }).catch(() => {});
  }
  db.close();
  await browser.close();
}
