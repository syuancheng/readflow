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
  console.log(`\n-- 起始词库 ${before.total} 词: ${before.words.map((w) => w.lemma).join(", ")} --`);

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

  // ---------- C3/C4：批注卡内的显式「撤销」按钮 ----------
  await page.locator('[data-e2e="1"]').click();
  await page.waitForTimeout(900);
  const undoVisible = await page.locator(".rf-undo").isVisible().catch(() => false);
  check("C3 首次自动收词出现撤销按钮", undoVisible);
  if (undoVisible) {
    await page.locator(".rf-undo").click();
    await page.waitForTimeout(900);
    const afterUndo = await wordCount();
    const noteGone2 = !(await page.locator(".reader-note").isVisible().catch(() => false));
    check(
      "C4 点击撤销删除词条并收起批注",
      afterUndo.total === before.total && noteGone2,
      `${afterUndo.total} 词，卡片收起=${noteGone2}`,
    );
  }

  // ---------- E：批注卡自带词典与 AI 入口 ----------
  await page.locator('[data-e2e="1"]').click();
  await page.waitForTimeout(900);
  const aiBtn = await page.locator('.reader-note button:has-text("AI")').count();
  const saveBtnEarly = await page
    .locator('[aria-label="收进词库"], [aria-label="已在词库，点击删除"]')
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

  // ---------- D：关掉自动收词（开关已收进设置中心 → 阅读设置；阅读页无顶栏 → 去首页操作再回来） ----------
  await page.evaluate(() => localStorage.setItem("readflow.autoSave", "0"));
  await page.goto(`${BASE}/`, { waitUntil: "load" });
  await page.click(".pm-trigger");
  await page.waitForSelector(".pm-dropdown", { timeout: 5000 });
  const menuSwitch = await page.locator(".pm-dropdown .pm-switch").count();
  check("D0 右上角菜单不再放阅读开关（已迁到设置中心）", menuSwitch === 0, `${menuSwitch} 个`);
  await page.locator('.pm-row:has-text("设置")').click();
  await page.waitForSelector(".st-modal", { timeout: 5000 });
  await page.locator('.st-nav-item:has-text("阅读设置")').click();
  await page.waitForSelector("#st-reading-panel", { timeout: 5000 });
  const switchOn = await page
    .locator("#st-autosave .st-switch")
    .evaluate((e) => e.classList.contains("on"));
  check("D0b 阅读设置里自动收词显示关闭态", !switchOn, switchOn ? "on" : "off");

  await page.locator("#st-autosave").click();
  const switchedOn = await page
    .locator("#st-autosave .st-switch")
    .evaluate((e) => e.classList.contains("on"));
  const storedOn = await page.evaluate(() => localStorage.getItem("readflow.autoSave"));
  check("D0c 切换开关立即写入本地", switchedOn && storedOn === "1", `localStorage=${storedOn}`);
  await page.locator("#st-autosave").click();
  const storedOff = await page.evaluate(() => localStorage.getItem("readflow.autoSave"));
  check("D0d 再切回关闭", storedOff === "0", `localStorage=${storedOff}`);

  await page.locator(".st-head .st-close").click();
  await page.waitForTimeout(150);

  // ---------- H：Profile 设置页（WorkBuddy 风格导航 + 添加模型弹窗） ----------
  await page.click(".pm-trigger");
  await page.locator('.pm-row:has-text("设置")').click();
  await page.waitForSelector(".st-modal", { timeout: 5000 });
  await page.waitForSelector(".st-provider", { timeout: 5000 });
  const providerCards = await page.locator(".st-provider").count();
  check("H1 Profile 设置页列出可选模型", providerCards >= 5, `${providerCards} 个 provider`);
  const navMarkji = await page.locator('.st-nav-item:has-text("墨墨记单词")').count();
  const navExt = await page.locator('.st-nav-item:has-text("浏览器插件")').count();
  const navProfile = await page.locator('.st-nav-item:has-text("个人资料")').count();
  const navReading = await page.locator('.st-nav-item:has-text("阅读设置")').count();
  check("H2 设置页含墨墨 Token 与插件 Token 分组", navMarkji > 0 && navExt > 0);
  check("H2a 设置中心新增「个人资料」导航项", navProfile === 1, `${navProfile} 项`);
  check("H2a2 设置中心新增「阅读设置」导航项", navReading === 1, `${navReading} 项`);

  // 关闭 × 应该离弹窗上下/左右边界至少 18px，不再压在圆角线上
  const closeBox = await page.locator(".st-head .st-close").boundingBox();
  const modalBox = await page.locator(".st-modal").boundingBox();
  const gapTop = closeBox.y - modalBox.y;
  const gapRight = modalBox.x + modalBox.width - (closeBox.x + closeBox.width);
  check(
    "H2c 关闭按钮不贴弹窗边界",
    gapTop >= 18 && gapRight >= 18,
    `上 ${gapTop.toFixed(1)}px / 右 ${gapRight.toFixed(1)}px`,
  );

  await page.locator("#st-search").fill("墨墨");
  const filteredNav = await page.locator(".st-nav-item").count();
  check("H2b 搜索设置项可过滤导航", filteredNav === 1, `${filteredNav} 项`);
  await page.locator("#st-search").fill("音色");
  const filteredReading = await page.locator(".st-nav-item").count();
  const readingHit = await page.locator('.st-nav-item:has-text("阅读设置")').count();
  check(
    "H2b2 搜索「音色」命中阅读设置",
    filteredReading === 1 && readingHit === 1,
    `${filteredReading} 项`,
  );
  await page.locator("#st-search").fill("");
  await page.locator('.st-nav-item:has-text("模型")').first().click();

  await page.locator(".st-add-btn").click();
  await page.waitForSelector(".st-editor", { timeout: 5000 });
  const providerOptions = await page.locator("#st-provider option").count();
  check("H3 添加模型用供应商下拉，内置 5 家", providerOptions >= 5, `${providerOptions} 项`);
  const fieldLabels = await page.locator(".st-editor .st-label").allInnerTexts();
  check(
    "H3b 弹窗主字段为供应商 / API Key / 模型名称",
    ["供应商", "API Key", "模型名称"].every((t) => fieldLabels.some((l) => l.includes(t))),
    fieldLabels.join(" | "),
  );
  const testBtn = await page.locator(".st-test-btn").count();
  const docsLink = await page.locator(".st-docs").count();
  check("H3c 带独立测试连接与查看文档", testBtn === 1 && docsLink === 1);

  const presetModel = await page.locator("#st-model").inputValue();
  check("H4 选 DeepSeek 自动带出默认模型名", presetModel === "deepseek-chat", presetModel);
  await page.locator(".st-advanced").click();
  const presetEndpoint = await page.locator("#st-endpoint").inputValue();
  check("H4b 高级设置里自动带出接口地址", presetEndpoint.includes("api.deepseek.com"), presetEndpoint);

  await page.locator("#st-provider").selectOption("qwen");
  const qwenModel = await page.locator("#st-model").inputValue();
  const qwenEndpoint = await page.locator("#st-endpoint").inputValue();
  check(
    "H4c 换供应商自动换成对应预设",
    qwenModel === "qwen-plus" && qwenEndpoint.includes("dashscope"),
    `${qwenModel} / ${qwenEndpoint}`,
  );
  await page.locator("#st-provider").selectOption("deepseek");

  await page.locator(".st-select-arrow-btn").click();
  await page.waitForSelector(".st-menu", { timeout: 3000 });
  const modelOptions = await page.locator(".st-menu-item").count();
  check("H5 模型名称可下拉选（含自定义项）", modelOptions >= 3, `${modelOptions} 项`);
  await page.locator('.st-menu-item:has-text("deepseek-reasoner")').click();
  const chosenModel = await page.locator("#st-model").inputValue();
  check("H5b 选中候选写回模型名称", chosenModel === "deepseek-reasoner", chosenModel);

  await page.locator(".st-editor .st-close").click();

  // ---------- H7：个人资料（本地版 A 档） ----------
  await page.locator('.st-nav-item:has-text("个人资料")').click();
  await page.waitForSelector("#st-pf-name", { timeout: 5000 });
  const badges = await page.locator(".st-pf-badge").count();
  const wechatWhy = await page.locator('.st-pf-item:has-text("绑定微信")').innerText();
  check("H7 账号与安全列出 4 项本地版未启用能力", badges === 4, `${badges} 项`);
  check(
    "H7b 微信绑定如实说明资质、费用与备案成本",
    /资质|¥300/.test(wechatWhy) && /备案|回调域/.test(wechatWhy),
  );

  await page.locator("#st-pf-name").fill("E2E 测试昵称");
  await page.locator("#st-pf-bio").fill("正在跑端到端测试");
  await page.locator('button:text-is("保存资料")').click();
  await page.waitForTimeout(400);
  const savedName = await page.locator("#st-pf-name").inputValue();
  check("H7c 昵称 / 名称 / 签名可编辑保存", savedName === "E2E 测试昵称", savedName);

  await page.locator(".st-head .st-close").click();
  await page.click(".pm-trigger");
  await page.waitForSelector(".pm-dropdown", { timeout: 5000 });
  const menuName = await page.locator(".pm-name").innerText();
  const menuSub = await page.locator(".pm-sub").innerText();
  check(
    "H7d 右上角昵称与签名即时同步（无需刷新）",
    menuName === "E2E 测试昵称" && menuSub === "正在跑端到端测试",
    `${menuName} / ${menuSub}`,
  );
  await page.click(".pm-trigger");

  // 收尾：清掉 E2E 写入的资料，恢复用户看到的样子
  const resetRes = await fetch(`${BASE}/api/settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profileReset: true }),
  });
  const resetJson = await resetRes.json();
  check(
    "H7e 资料可恢复默认",
    resetJson.profile?.displayName === "Siyuan Cheng" && resetJson.profile?.avatar === "",
  );

  // ---------- I：导出入口全站唯一 ----------
  await page.goto(`${BASE}/words`, { waitUntil: "load" });
  const topExport = await page.locator('.duo-nav-link:has-text("导出")').count();
  const bottomExport = await page.locator('.duo-bottom-link:has-text("导出")').count();
  const wordExport = await page.locator('a:has-text("导出到墨墨")').count();
  check(
    "I1 顶部与底部导航都不再有导出项",
    topExport === 0 && bottomExport === 0,
    `top=${topExport} bottom=${bottomExport}`,
  );
  check("I2 词库页保留唯一导出按钮", wordExport === 1, `${wordExport} 个`);
  await page.click(".pm-trigger");
  const restoredName = await page.locator(".pm-name").innerText();
  check("I3 清资料后右上角恢复默认昵称", restoredName === "Siyuan Cheng", restoredName);
  await page.click(".pm-trigger");

  await page.goto(`${BASE}/texts/${TEXT_ID}`, { waitUntil: "load" });
  await page.waitForTimeout(600);

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

  // ---------- J：分段小结（按累计词数分区，标记只落在自然段末尾） ----------
  await page.goto(`${BASE}/texts/${TEXT_ID}`, { waitUntil: "load" });
  await page.waitForTimeout(700);

  const secCount = await page.locator(".rf-sec").count();
  check("J1 文章按词数插入分段小结标记", secCount >= 1, `${secCount} 个标记`);

  // 硬约束：标记必须是某个 <p data-pid> 的下一个兄弟节点 → 段落绝不被切开
  const boundaryOk = await page.evaluate(() => {
    const marks = [...document.querySelectorAll(".rf-sec")];
    return marks.length > 0 && marks.every((m) => {
      const prev = m.previousElementSibling;
      return !!prev && prev.tagName === "P" && prev.hasAttribute("data-pid");
    });
  });
  check("J2 标记只落在自然段边界上，不拆分自然段", boundaryOk);

  const markTitle = await page.locator(".rf-sec-btn").first().getAttribute("title");
  check(
    "J3 标记提示含区间与词数",
    /第 \d+–\d+ 段 · \d+ 词/.test(markTitle || ""),
    markTitle || "(无)",
  );

  await page.locator(".rf-sec-btn").first().click();
  await page.waitForSelector(".rf-sec-panel", { timeout: 5000 });
  check("J4 点击标记在标记下方展开小结面板", await page.locator(".rf-sec-panel").first().isVisible());

  // 等流式输出落地（命中缓存则几乎立即出结果；未配置模型则出现配置提示）
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector(".rf-sec-panel");
        if (!el) return false;
        const t = el.innerText || "";
        return t.trim().length > 0 && !t.includes("正在读这一部分…");
      },
      { timeout: 30000 },
    )
    .catch(() => {});

  const panelText = await page.locator(".rf-sec-panel").first().innerText();
  const noticeShown = panelText.includes("还没有配置 AI 模型");
  const bodyText = panelText
    .replace("这一部分讲了什么", "")
    .replace(/第 \d+–\d+ 段 · \d+ 词/, "")
    .replace(/重新生成|收起/g, "")
    .trim();
  check(
    "J5 面板给出小结内容（或未配置模型的提示）",
    bodyText.length > 10,
    bodyText.slice(0, 50).replace(/\n/g, " "),
  );

  const cachedList = await (await fetch(`${BASE}/api/summarize?textId=${TEXT_ID}`)).json();
  const cachedCount = (cachedList.summaries ?? []).length;
  check(
    "J6 小结落库与面板一致（提示态不写缓存）",
    noticeShown ? cachedCount === 0 : cachedCount >= 1,
    `提示=${noticeShown} 缓存=${cachedCount}`,
  );

  const badRange = await fetch(`${BASE}/api/summarize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ textId: TEXT_ID, startIdx: 99, endIdx: 98 }),
  });
  check("J7 非法区间返回 400", badRange.status === 400, `status=${badRange.status}`);

  const listRes = await fetch(`${BASE}/api/summarize?textId=${TEXT_ID}`);
  const listJson = await listRes.json().catch(() => ({}));
  check("J8 小结列表接口可用", listRes.ok && Array.isArray(listJson.summaries));

  await page.locator('.rf-sec-panel .rf-sec-act:text-is("收起")').first().click();
  await page.waitForTimeout(200);
  check("J9 可收起小结面板", (await page.locator(".rf-sec-panel").count()) === 0);

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
