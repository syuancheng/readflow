/**
 * 阅读器长文基准测试。
 *
 * 用法（先起生产服务，dev 模式的数字不代表真实性能）：
 *   npm run build && npm start
 *   SAMPLE=/path/to/article.txt npm run bench          # 造样例 + 4 倍压力文本并测量
 *   BASE=http://127.0.0.1:3000 CPU=4 ROUNDS=3 npm run bench
 *
 * 环境变量：
 *   BASE     服务地址，默认 http://127.0.0.1:3000
 *   SAMPLE   用于造压测文本的纯文本文件（必须含空行分段）。给了就（重新）创建 [bench] 文本
 *   CPU      CDP CPU 降速倍数，默认 1；4 约等于中端手机
 *   ROUNDS   每个场景跑几轮取中位数，默认 2
 *   COLLECT  =1 时额外测「收词」开销。注意这会真的往词库写一个词
 *   KEEP     =1 时结束后不删除 [bench] 文本
 *
 * 原理：往 /api/texts 塞带 [bench] 前缀的文本，用系统 Chrome（channel: "chrome"，
 * 不需要下载浏览器）无头打开阅读页，量 TTFB / 水合 / 点击弹层 / 滚动帧间隔 / 长任务，
 * 结束后把 [bench] 文本删干净，不污染正式数据。
 */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

const BASE = process.env.BASE ?? "http://127.0.0.1:3000";
const CPU = Number(process.env.CPU ?? 1);
const ROUNDS = Number(process.env.ROUNDS ?? 2);
const COLLECT = process.env.COLLECT === "1";
const KEEP = process.env.KEEP === "1";
const SAMPLE = process.env.SAMPLE;

async function api(path, init) {
  const res = await fetch(BASE + path, init);
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

// ---------- 准备 [bench] 文本 ----------

if (SAMPLE) {
  const raw = readFileSync(SAMPLE, "utf8");
  const words = (raw.match(/[A-Za-z0-9'’-]+/g) ?? []).length;
  if (words < 500) throw new Error(`样例太短（${words} 词），至少 500 词才有测量意义`);

  // 先清掉旧 bench 文本，保证规模与本次样例一致
  for (const t of (await api("/api/texts")).texts) {
    if (t.title.startsWith("[bench]")) await api(`/api/texts/${t.id}`, { method: "DELETE" });
  }

  const cases = [{ label: `sample ${words}w`, multiplier: 1 }];
  // 4 倍压力版：同一段落分布重复 4 次，控制变量只放大规模
  cases.push({ label: `stress x4 ${words * 4}w`, multiplier: 4 });

  for (const c of cases) {
    const text = Array.from({ length: c.multiplier }, () => raw.trim()).join("\n\n");
    const r = await api("/api/texts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `[bench] ${c.label}`, text }),
    });
    c.id = r.id;
    c.words = r.wordCount;
  }
  console.error(`已创建 bench 文本：${cases.map((c) => `${c.label}=${c.id}`).join(", ")}`);
} else {
  // 不给 SAMPLE 就复用库里现成的 [bench] 文本
  const existing = (await api("/api/texts")).texts.filter((t) => t.title.startsWith("[bench]"));
  if (existing.length === 0) throw new Error("库里没有 [bench] 文本，请先用 SAMPLE=xxx.txt 跑一次");
}

const cases = (await api("/api/texts")).texts
  .filter((t) => t.title.startsWith("[bench]"))
  .map((t) => ({ id: t.id, label: `${t.title.replace("[bench] ", "")} (${t.wordCount}w)` }));

// ---------- 测量 ----------

function median(a) {
  const s = [...a].sort((x, y) => x - y);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

async function runOnce(textId) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  if (CPU > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU });

  await page.addInitScript(() => {
    window.__lt = [];
    try {
      new PerformanceObserver((l) => {
        for (const e of l.getEntries()) window.__lt.push(e.duration);
      }).observe({ entryTypes: ["longtask"] });
    } catch {}
  });

  await page.goto(`${BASE}/texts/${textId}`, { waitUntil: "load", timeout: 120000 });
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0];
    return {
      ttfb: Math.round(n.responseStart),
      load: Math.round(n.loadEventEnd),
      htmlKB: Math.round(n.decodedBodySize / 1024),
    };
  });

  // 水合探测：轮询点击直到弹层能被 React 响应（load 之后的部分），TTFI = load + hydrate
  const hydrate = await page.evaluate(async () => {
    const first = document.querySelector(".reading-body .w");
    if (!first) return -1;
    const t = performance.now();
    for (let i = 0; i < 400; i++) {
      first.click();
      await new Promise((r) => setTimeout(r, 20));
      if (document.querySelector(".duo-popover")) {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        await new Promise((r) => setTimeout(r, 10));
        return performance.now() - t;
      }
    }
    return -2;
  });

  const dom = await page.evaluate(() => ({
    elements: document.querySelectorAll("*").length,
    wordSpans: document.querySelectorAll(".w").length,
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null,
  }));

  // 点词 → 弹层插入 DOM / 下一帧 的耗时，取首/25%/50%/75%/尾五个词的中位数
  const click = await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const spans = document.querySelectorAll(".w");
    const idx = [0, 0.25, 0.5, 0.75, spans.length - 1].map((f) => spans[Math.floor(spans.length * f)]).filter(Boolean);
    const out = [];
    for (const el of idx) {
      el.scrollIntoView({ block: "center" });
      await sleep(30);
      const r = await new Promise((resolve) => {
        const t = performance.now();
        let tDom = 0;
        const obs = new MutationObserver(() => {
          if (!tDom && document.querySelector(".duo-popover")) tDom = performance.now() - t;
        });
        obs.observe(document.body, { childList: true, subtree: true });
        el.click();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            obs.disconnect();
            resolve({ dom: tDom, paint: performance.now() - t });
          }),
        );
      });
      out.push(r);
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      await sleep(50);
    }
    return out;
  });

  // 收词开销（可选，会真的写库）：点「+」→ savedSet 变化触发全段落 reconcile → 下一帧
  let collect = null;
  if (COLLECT) {
    collect = await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const spans = document.querySelectorAll(".w");
      const el = spans[Math.floor(spans.length * 0.6)];
      el.scrollIntoView({ block: "center" });
      await sleep(30);
      el.click();
      await sleep(80);
      const btn = document.querySelector(".duo-icon-btn");
      if (!btn) return null;
      const t = performance.now();
      btn.click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return Math.round((performance.now() - t) * 10) / 10;
    });
  }

  // 滚动帧间隔：连续 120 帧、每帧滚 140px
  const scroll = await page.evaluate(async () => {
    window.scrollTo(0, 0);
    await new Promise((r) => requestAnimationFrame(r));
    const frames = [];
    let last = performance.now();
    for (let i = 0; i < 120; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      window.scrollBy(0, 140);
      const now = performance.now();
      frames.push(now - last);
      last = now;
    }
    const s = frames.slice(5).sort((a, b) => a - b);
    const p = (q) => Math.round(s[Math.floor(s.length * q)] * 10) / 10;
    return { p50: p(0.5), p95: p(0.95), max: Math.round(s[s.length - 1] * 10) / 10 };
  });

  const lt = await page.evaluate(() => window.__lt ?? []);
  const tbt = Math.round(lt.reduce((s, d) => s + Math.max(0, d - 50), 0));

  await ctx.close();
  return {
    ...nav,
    ttfi: nav.load + Math.round(hydrate),
    hydrate: Math.round(hydrate),
    ...dom,
    clickDom: Math.round(median(click.map((c) => c.dom)) * 10) / 10,
    clickPaint: Math.round(median(click.map((c) => c.paint)) * 10) / 10,
    collect,
    scrollP95: scroll.p95,
    scrollMax: scroll.max,
    longTasks: lt.length,
    tbt,
  };
}

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const results = [];
for (const c of cases) {
  for (let i = 0; i < ROUNDS; i++) {
    const r = await runOnce(c.id);
    results.push({ label: c.label, ...r });
    console.log(`[cpu=${CPU}x] ${c.label} #${i + 1} ${JSON.stringify(r)}`);
  }
}
await browser.close();

const pick = (r, k) => k.split(".").reduce((o, kk) => o?.[kk], r);
const summary = cases.map((c) => {
  const rs = results.filter((r) => r.label === c.label);
  const avg = (k) => Math.round(median(rs.map((r) => pick(r, k))) * 10) / 10;
  const row = {
    scenario: c.label,
    ttfb: avg("ttfb"),
    ttfi: avg("ttfi"),
    htmlKB: avg("htmlKB"),
    elements: avg("elements"),
    heapMB: avg("heapMB"),
    clickDom: avg("clickDom"),
    clickPaint: avg("clickPaint"),
    scrollP95: avg("scrollP95"),
    longTasks: avg("longTasks"),
    tbt: avg("tbt"),
  };
  if (COLLECT) row.collect = avg("collect");
  return row;
});
console.log(`\n=== SUMMARY (cpu=${CPU}x, rounds=${ROUNDS}) ===`);
console.table(summary);

// ---------- 清理 ----------

if (!KEEP && SAMPLE) {
  for (const c of cases) await api(`/api/texts/${c.id}`, { method: "DELETE" }).catch(() => {});
  console.error("bench 文本已清理（KEEP=1 可保留）");
}
