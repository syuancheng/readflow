/**
 * Readlang 对齐改造的端到端验证（批注栏版）。
 *
 * 用法：BASE=http://127.0.0.1:3103 node scripts/e2e-readlang.mjs
 *
 * 覆盖：
 *  A. 点词 → 右侧批注栏出现释义卡（黄金分割双栏）
 *  B. 自动收词开 → 点词即入库（API 计数 +1）
 *  C. 再点同一词 → 批注卡收起且词被移除（delete on deselect）
 *  D. 自动收词关 → 只出批注卡不入库，手动收词可用
 *  E. 批注卡内含 AI 释义入口
 *  E2. 拖选整句（起点在词中间）→ 吸附到完整词并出批注卡
 *  F. 词库页：状态筛选 / 星标 / 标记已掌握 / 搜索
 *  G. 词库「跳到原文」→ URL 带 ?p= 且目标段落高亮
 */
import { chromium } from "playwright";

const BASE = process.env.BASE || "http://127.0.0.1:3103";
const TEXT_ID = process.env.TEXT_ID || "6d5fab15-5422-4dcd-991d-51c52eb633c1";

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function wordCount() {
  const r = await fetch(`${BASE}/api/words`);
  const j = await r.json();
  const arr = j.words ?? j;
  return { total: arr.length, words: arr };
}

/** 测试结束后删掉本脚本造的词，保持用户数据干净 */
async function cleanup(keepIds) {
  const { words } = await wordCount();
  for (const w of words) {
    if (!keepIds.has(w.id)) {
      await fetch(`${BASE}/api/words/${w.id}`, { method: "DELETE" }).catch(() => {});
    }
  }
}

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 } });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

try {
  // ---------- A/B：点词出气泡 + 自动入库 ----------
  await page.goto(`${BASE}/texts/${TEXT_ID}`, { waitUntil: "load" });
  await page.waitForTimeout(600);

  // 确保自动收词是开的
  await page.evaluate(() => localStorage.setItem("readflow.autoSave", "1"));
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(600);

  const before = await wordCount();
  const keepIds = new Set(before.words.map((w) => w.id));
  const known = before.words.flatMap((w) => [w.displayForm.toLowerCase(), w.lemma.toLowerCase()]);
  console.log(`\n-- 起始词库 ${before.total} 词 --`);

  // 找一个正经英文单词（长度 >= 5 且纯字母，且词库里还没有）来点
  const target = await page.evaluate((knownArr) => {
    const set = new Set(knownArr);
    const ws = [...document.querySelectorAll(".reading-body .w")];
    const el = ws.find(
      (e) =>
        /^[A-Za-z]{5,}$/.test(e.textContent || "") &&
        !set.has((e.textContent || "").toLowerCase()),
    );
    if (!el) return null;
    el.setAttribute("data-e2e", "1");
    return el.textContent;
  }, known);
  if (!target) throw new Error("找不到可点的单词（词库里已全部收录？）");
  console.log(`  点词目标: ${target}`);

  await page.locator('[data-e2e="1"]').scrollIntoViewIfNeeded();
  await page.locator('[data-e2e="1"]').click();
  await page.waitForTimeout(900);

  const noteVisible = await page.locator(".reader-note").isVisible().catch(() => false);
  const noteTitle = noteVisible
    ? (await page.locator(".reader-note p.font-extrabold").first().innerText()).trim().slice(0, 60)
    : "";
  check("A 点词在右侧批注栏出现释义卡", noteVisible, noteTitle);

  await page.waitForTimeout(600);
  const afterSave = await wordCount();
  check(
    "B 自动收词：点词即入库",
    afterSave.total === before.total + 1,
    `${before.total} → ${afterSave.total}`,
  );

  // ---------- C：再点一次 = 收起 + 删词 ----------
  await page.locator('[data-e2e="1"]').click();
  await page.waitForTimeout(900);
  const noteGone = !(await page.locator(".reader-note").isVisible().catch(() => false));
  check("C1 再点一次批注卡收起", noteGone);

  const afterDeselect = await wordCount();
  check(
    "C2 delete-on-deselect：收起即移除该词",
    afterDeselect.total === before.total,
    `${afterSave.total} → ${afterDeselect.total}`,
  );

  // ---------- E：批注卡自带词典与 AI 入口 ----------
  await page.locator('[data-e2e="1"]').click();
  await page.waitForTimeout(900);
  const aiBtn = await page.locator('.reader-note button:has-text("AI")').count();
  const saveBtnEarly = await page
    .locator('[aria-label="收进词库"], [aria-label="已在词库，点击移出"]')
    .count();
  check(
    "E 批注卡内含 AI 释义入口与收词按钮",
    aiBtn > 0 && saveBtnEarly > 0,
    `AI按钮=${aiBtn} 收词按钮=${saveBtnEarly}`,
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  // E 步骤（自动收词仍开着）会顺带收词，清掉，保证 D 阶段起点干净
  await cleanup(keepIds);

  // ---------- D：关掉自动收词 ----------
  await page.evaluate(() => localStorage.setItem("readflow.autoSave", "0"));
  await page.reload({ waitUntil: "load" });
  await page.waitForTimeout(600);
  const pillText = await page.locator(".autosave-pill").innerText();
  check("D0 开关显示关闭态", pillText.includes("关"), pillText.replace(/\n/g, " "));

  const beforeOff = await wordCount();
  const t2 = await page.evaluate(([TARGET, knownArr]) => {
    const set = new Set([...knownArr, String(TARGET).toLowerCase()]);
    const ws = [...document.querySelectorAll(".reading-body .w")];
    const el = ws.find(
      (e) =>
        /^[A-Za-z]{6,}$/.test(e.textContent || "") &&
        !set.has((e.textContent || "").toLowerCase()),
    );
    if (!el) return null;
    el.setAttribute("data-e2e", "2");
    return el.textContent;
  }, [target, known]);
  await page.locator('[data-e2e="2"]').scrollIntoViewIfNeeded();
  await page.locator('[data-e2e="2"]').click();
  await page.waitForTimeout(900);
  const b2 = await page.locator(".reader-note").isVisible().catch(() => false);
  const afterOff = await wordCount();
  check("D1 关闭后仍显示批注卡", b2, `点击 ${t2}`);
  check("D2 关闭后不自动入库", afterOff.total === beforeOff.total, `${beforeOff.total} → ${afterOff.total}`);

  // 在批注卡里手动收词
  const saveBtn = page.locator('[aria-label="收进词库"]');
  if (await saveBtn.count()) {
    await saveBtn.click();
    await page.waitForTimeout(900);
    const afterManual = await wordCount();
    check("D3 弹层手动收词生效", afterManual.total === beforeOff.total + 1, `${beforeOff.total} → ${afterManual.total}`);
  } else {
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll(".reader-note button")].map((b) => b.getAttribute("aria-label")),
    );
    check("D3 弹层手动收词生效", false, `找不到「收进词库」按钮，实际按钮: ${labels.join(",")}`);
  }

  // ---------- E2：拖选整句 + 词边界吸附 ----------
  const dragOk = await (async () => {
    const box = await page.evaluate(() => {
      const el = [...document.querySelectorAll("[data-pid]")].find((e) =>
        e.textContent.includes("This post only focuses"),
      );
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const ws = [...el.querySelectorAll(".w")];
      const find = (t) => ws.find((e) => e.textContent.trim().startsWith(t))?.getBoundingClientRect().toJSON();
      return { This: find("This"), engineering: find("engineering") };
    });
    if (!box?.This || !box?.engineering) return null;
    await page.waitForTimeout(200);
    const T = box.This, E = box.engineering;
    // 故意从 "This" 中间按下（复现用户的操作）
    await page.mouse.move(T.x + T.width / 2, T.y + T.height / 2);
    await page.mouse.down();
    await page.mouse.move(E.x + E.width - 1, E.y + E.height / 2, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(800);
    const sel = await page.evaluate(() => window.getSelection()?.toString());
    const pop = await page.evaluate(() => !!document.querySelector(".reader-note"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    return { sel, pop };
  })();
  check(
    "E2 拖选整句（起点在词中间）吸附到完整词",
    dragOk?.sel === "This post only focuses on prompt engineering" && dragOk?.pop === true,
    JSON.stringify(dragOk?.sel?.slice(0, 50)),
  );

  // ---------- F：词库页 ----------
  await page.goto(`${BASE}/words`, { waitUntil: "load" });
  await page.waitForTimeout(700);
  const chips = await page.locator(".duo-filter-chip").allInnerTexts();
  check("F1 词库有状态筛选", chips.length >= 5, chips.join(" / "));

  const rowCount0 = await page.locator("ul li.duo-text-item").count();
  // 星标第一个词
  await page.locator(".word-action-btn").first().click();
  await page.waitForTimeout(500);
  const starredNow = await page.evaluate(() =>
    document.querySelectorAll(".word-action-btn")[0].textContent.trim(),
  );
  check("F2 星标切换", starredNow === "★", `图标=${starredNow}`);

  // 标记已掌握
  await page.locator(".word-action-btn").nth(1).click();
  await page.waitForTimeout(500);
  const learnedChip = await page.evaluate(() => {
    const c = [...document.querySelectorAll(".duo-filter-chip")].find((e) =>
      e.textContent.includes("已掌握"),
    );
    return c?.textContent.trim();
  });
  check("F3 标记已掌握后计数更新", /已掌握\s*[1-9]/.test(learnedChip || ""), learnedChip || "");

  // 搜索
  await page.locator('input[placeholder*="搜索"]').fill("zzzzzznope");
  await page.waitForTimeout(400);
  const emptyShown = await page.locator(".duo-empty").isVisible().catch(() => false);
  check("F4 搜索无结果显示空态", emptyShown);
  await page.locator('input[placeholder*="搜索"]').fill("");
  await page.waitForTimeout(300);

  // ---------- G：跳回原文 ----------
  const jump = page.locator("text=跳到原文").first();
  const hasJump = await jump.count();
  if (hasJump) {
    await jump.click();
    await page.waitForTimeout(1400);
    const url = page.url();
    const flashed = await page.evaluate(
      () => document.querySelectorAll(".para-flash").length,
    );
    check("G1 跳到原文带段落定位参数", url.includes("?p="), url.slice(-60));
    check("G2 目标段落高亮", flashed > 0, `para-flash=${flashed}`);
  } else {
    check("G1 跳到原文链接存在", false, "词库里没有带 context 的词");
  }

  // ---------- 汇总 ----------
  await cleanup(keepIds);
  const left = await wordCount();
  console.log(`\n(已清理测试数据，词库恢复为 ${left.total} 词)`);

  const failed = results.filter((r) => !r.pass);
  console.log(`\n===== ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    console.log("失败项:");
    for (const f of failed) console.log("  -", f.name, f.detail);
  }
} catch (e) {
  console.error("E2E 崩溃:", e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
}
