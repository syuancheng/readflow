/**
 * E2E：P13 句子地图的 ==主干== 下划线渲染。
 *
 * 为什么不用真模型跑：模型是否给句子地图是它自己的判断（轻答可以不给），
 * 拿它验证渲染器会得到不稳定的假阴性。这里改成通过 /api/contexts/gloss
 * 确定性注入一条带 ==...== 的 aiGloss，再从「已存批注」回看检查 DOM。
 *
 * 运行前需要生产服务在 3000 端口，且是最新构建：
 *   npm run test:spine-render
 */
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://127.0.0.1:3000";
const stamp = Date.now().toString(36);
const TITLE = `[E2E] spine render ${stamp}`;
const WORD = "meticulous";
const BODY = `The ${WORD} widget keeps states in sync over a long run.`;
const GLOSS = `「一丝不苟的」——在这里形容 widget，不是形容人。

🧩 主系表 · 主语带定语
==主语：The meticulous widget== ==谓语：keeps== ==表语：states in sync== over a long run.`;

const j = async (r) => {
  try {
    return await r.json();
  } catch {
    return {};
  }
};
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

let textId = "";
let wordId = "";
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

try {
  const created = await j(
    await fetch(`${BASE}/api/texts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: TITLE, text: BODY, format: "plain" }),
    }),
  );
  textId = created.id ?? "";
  if (!textId) throw new Error(`创建文本失败：${JSON.stringify(created)}`);

  const detail = await j(await fetch(`${BASE}/api/texts/${textId}`));
  const para = (detail.paragraphs ?? []).find((p) => p.content.includes(WORD));
  if (!para) throw new Error("找不到目标段落");
  const start = para.content.indexOf(WORD);
  const end = start + WORD.length;

  const saved = await j(
    await fetch(`${BASE}/api/contexts/gloss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        word: WORD,
        quote: WORD,
        textId,
        paragraphId: para.id,
        start,
        end,
        prefix: "",
        suffix: "",
        aiGloss: GLOSS,
      }),
    }),
  );
  wordId = saved.wordId ?? "";
  if (!wordId) throw new Error(`写回批注失败：${JSON.stringify(saved)}`);

  await page.goto(`${BASE}/texts/${textId}`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  const hydrated = await page.evaluate(() => {
    const el = document.querySelector("[data-pid] .w");
    return Boolean(el && Object.keys(el).some((k) => k.startsWith("__reactProps$")));
  });
  check("页面已 hydrate（生产构建交互验证的前提）", hydrated);

  const opened = await page.evaluate((w) => {
    const btn = [...document.querySelectorAll(".rf-annot-open")].find((b) =>
      (b.textContent ?? "").includes(w),
    );
    if (!btn) return false;
    btn.click();
    return true;
  }, WORD);
  check("能从「已存批注」打开这条注入的释义", opened);
  await page.waitForTimeout(700);

  const dom = await page.evaluate(() => {
    const card = document.querySelector(".reader-note");
    const spineEls = [...(card?.querySelectorAll(".rf-md-spine") ?? [])];
    const roleEls = [...(card?.querySelectorAll(".rf-md-role") ?? [])];
    return {
      spines: spineEls.map((e) => e.textContent.trim()),
      roles: roleEls.map((e) => e.textContent.trim()),
      decoration: spineEls.length ? getComputedStyle(spineEls[0]).textDecorationLine : "",
      roleSize: roleEls.length ? getComputedStyle(roleEls[0]).fontSize : "",
      cardText: card?.innerText ?? "",
      rawMarkers: (card?.innerText.match(/==/g) ?? []).length,
    };
  });
  check("三处主干都被渲染成 .rf-md-spine", dom.spines.length === 3, JSON.stringify(dom.spines));
  check("主干成分标签渲染成 .rf-md-role", dom.roles.length === 3, JSON.stringify(dom.roles));
  check(
    "成分标签内容正确（主语/谓语/表语）",
    ["主语", "谓语", "表语"].every((r) => dom.roles.includes(r)),
    JSON.stringify(dom.roles),
  );
  check("下划线样式真的生效", dom.decoration.includes("underline"), dom.decoration);
  check("成分标签字号小于主干（小标签）", parseFloat(dom.roleSize) < 13, dom.roleSize);
  check("页面不露出裸 == 记号", dom.rawMarkers === 0, `raw=${dom.rawMarkers}`);
  check("第一屏的选区译法仍在", dom.cardText.includes("一丝不苟的"));

  const { words = [] } = await j(await fetch(`${BASE}/api/words?textId=${textId}`));
  const translation = (words.find((w) => (w.displayForm ?? "").includes(WORD)) ?? {}).translation ?? "";
  check(
    "卡片背面没有 == 或句子地图",
    !translation.includes("==") && !translation.includes("🧩"),
    translation.slice(0, 70),
  );
} catch (e) {
  check("脚本执行无异常", false, e instanceof Error ? e.message : String(e));
} finally {
  if (wordId) await fetch(`${BASE}/api/words/${wordId}`, { method: "DELETE" }).catch(() => {});
  if (textId) await fetch(`${BASE}/api/texts/${textId}`, { method: "DELETE" }).catch(() => {});
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
