/**
 * P32 §8.5：三个人设的人工评审材料。
 *
 * 隔离库 + 临时端口 3137（假模型 3138），跑完删库，不碰 data/readflow.db。
 * 建立 PRD §8 的小林 / 老陈 / 小王三个账号，写入问卷与各自的历史查词事件，
 * 对固定的 10 个查词场景在个性化开关 on / off 下各跑一次讲解，
 * 输出 .verify/personas/report.md（每个场景一张表，含讲解原文与字数）。
 *
 * 默认只用本地假模型，不联网、不花钱。
 * 产品负责人本地评审时可用 EVAL_PROVIDER / EVAL_API_KEY / EVAL_MODEL 指定真实模型；
 * Key 只从环境变量读取，绝不写进代码、报告或提交。
 *
 *   node scripts/eval-personas.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3137;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL_PORT = 3138;
const MODEL_URL = `http://127.0.0.1:${MODEL_PORT}`;
const TMP = path.join(ROOT, ".verify", "personas", "eval");
const DB = path.join(TMP, "readflow.db");
const REPORT = path.join(ROOT, ".verify", "personas", "report.md");

const REAL = Boolean(process.env.EVAL_API_KEY && process.env.EVAL_MODEL && process.env.EVAL_PROVIDER);
const MODEL_LABEL = REAL
  ? `真实模型 ${process.env.EVAL_MODEL}（EVAL_PROVIDER=${process.env.EVAL_PROVIDER}）`
  : "本地假模型（未设置 EVAL_* ，仅用于验证脚本链路与报告格式）";

fs.mkdirSync(TMP, { recursive: true });
fs.mkdirSync(path.dirname(REPORT), { recursive: true });

/** 假模型：按「学生档案」里的偏好给出不同长度的示范讲解，让报告能看出差异 */
function fakeAnswer(system, user) {
  const personalized = user.startsWith("学生档案（");
  if (!personalized) return "释义：测试。\n假模型在开关关闭时按固定规则回答，不带任何学生档案。";
  if (user.includes("希望讲解：越简洁越好")) return "释义：产物。";
  if (user.includes("希望讲解：讲细一点")) {
    return "释义：产物。\n整句大意：这次构建生成了一个可用的产物。\n句子地图：==主语：The build== ==谓语：produced==。\n例句：The pipeline emits an artifact.";
  }
  return "释义：产物。\n整句大意：这次构建生成了一个可用的产物。";
}

const calls = [];
const fake = http.createServer((req, res) => {
  if (req.url.split("?")[0] !== "/v1/chat/completions" && req.url.split("?")[0] !== "/chat/completions") {
    res.writeHead(404);
    return res.end();
  }
  let buf = "";
  req.on("data", (d) => (buf += d));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(buf); } catch { /* 忽略畸形请求 */ }
    const messages = body.messages ?? [];
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const user = messages.find((m) => m.role === "user")?.content ?? "";
    if (body.stream === true) {
      const answer = fakeAnswer(system, user);
      calls.push({ system, user, answer });
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      res.write(`data: ${JSON.stringify({ id: "eval", object: "chat.completion.chunk", created: 0, model: "eval", choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    // 后台老师笔记的非流式调用：给一段合法笔记，避免污染评审用的流式回答
    const note = "偏好在真实语境里理解词义，遇到长定语从句时容易卡住，讲解长度以简短为宜。";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "eval-note", object: "chat.completion", created: 0, model: "eval",
      choices: [{ index: 0, message: { role: "assistant", content: note }, finish_reason: "stop" }],
    }));
  });
});

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  cwd: ROOT,
  env: {
    ...process.env,
    DB_PATH: DB,
    NODE_ENV: "production",
    NO_PROXY: "localhost,127.0.0.1",
    no_proxy: "localhost,127.0.0.1",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));

const cookieOf = (res) => res.headers.get("set-cookie")?.match(/readflow_session=([^;]+)/)?.[1];
async function api(pathname, { cookie, method = "GET", body } = {}) {
  const headers = {};
  if (cookie) headers.cookie = `readflow_session=${cookie}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(BASE + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 流式响应 */ }
  return { status: res.status, data, text };
}

/** 三个人设，问卷答案逐字对应 PRD §8 */
const PERSONAS = [
  {
    key: "xiaolin",
    name: "小林",
    desc: "大二，四级 425–499，读新闻，「每段查几个词」，讲解适中",
    survey: { identity: "college", exam: "cet4", examScore: "cet_425_499", goals: ["news"], readingFeel: "few_per_paragraph", stylePref: "balanced" },
    lookups: { n: 40, freqRank: 3200, wholeSentence: 8, repeat: 2 },
  },
  {
    key: "laochen",
    name: "老陈",
    desc: "工作 3–10 年，六级 550 以上，读技术文档，「偶尔查个生词」，越简洁越好",
    survey: { identity: "work_3_10", exam: "cet6", examScore: "cet_550plus", goals: ["tech"], readingFeel: "occasional", stylePref: "concise" },
    lookups: { n: 40, freqRank: 12500, wholeSentence: 0, repeat: 1 },
  },
  {
    key: "xiaowang",
    name: "小王",
    desc: "高三，考过高考，备考，「几乎每句都要查」，讲细一点",
    survey: { identity: "high", exam: "gaokao", goals: ["exam"], readingFeel: "every_sentence", stylePref: "detailed" },
    lookups: { n: 40, freqRank: 900, wholeSentence: 12, repeat: 3 },
  },
];

/** 固定的 10 个查词场景：单词、短语、同句连续第 2 / 3 次各若干 */
const S1 = "The build produced a useful artifact after the long deployment pipeline finished.";
const S2 = "A relative clause that modifies the subject often confuses a careful reader.";
const SCENARIOS = [
  { name: "1. 生僻单词（同句第 1 次）", word: "artifact", sentence: S1, askKind: "auto", repeat: 1 },
  { name: "2. 同句第 2 次查词", word: "produced", sentence: S1, askKind: "auto", repeat: 2 },
  { name: "3. 同句第 3 次查词", word: "useful", sentence: S1, askKind: "auto", repeat: 3 },
  { name: "4. 拖选短语", word: "a useful artifact", sentence: S1, askKind: "default", repeat: 1, select: true },
  { name: "5. 技术语境里的常用词", word: "build", sentence: S1, askKind: "auto", repeat: 1 },
  { name: "6. 长句里的单词", word: "deployment", sentence: S1, askKind: "default", repeat: 2 },
  { name: "7. 定语从句里的单词", word: "relative", sentence: S2, askKind: "auto", repeat: 1 },
  { name: "8. 同句第 2 次（长句）", word: "modifies", sentence: S2, askKind: "auto", repeat: 2 },
  { name: "9. 同句第 3 次（长句）", word: "confuses", sentence: S2, askKind: "auto", repeat: 3 },
  { name: "10. 拖选长片段", word: "a relative clause that modifies the subject", sentence: S2, askKind: "default", repeat: 1, select: true },
];

async function explain(cookie, sc) {
  const before = calls.length;
  await api("/api/explain", {
    cookie,
    method: "POST",
    body: {
      word: sc.word,
      context: sc.sentence,
      language: "en",
      monolingual: false,
      askKind: sc.askKind,
      signals: {
        source: sc.select ? "select" : "word",
        position: "middle",
        selectionWords: sc.word.trim().split(/\s+/).length,
        sentenceWords: sc.sentence.trim().split(/\s+/).length,
        coverage: sc.select ? 0.5 : 0.1,
        sentence: sc.sentence,
        sentenceStart: 0,
        sentenceEnd: sc.sentence.length,
        repeatCount: sc.repeat,
        dictHit: false,
      },
    },
  });
  return calls.length > before ? calls.at(-1).answer : "";
}

function esc(s) {
  return String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

try {
  if (!REAL) await new Promise((resolve) => fake.listen(MODEL_PORT, "127.0.0.1", resolve));

  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try { await fetch(`${BASE}/api/auth/status`); up = true; } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  if (!up) throw new Error("服务器没起来:\n" + serverLog.slice(-2500));

  // 站点模型：默认假服务；提供 EVAL_* 时切到真实模型（Key 不落盘、不进报告）
  const setup = await fetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "eval_owner", password: "eval-owner-2026", phone: "13800138061" }),
  });
  const owner = cookieOf(setup);
  if (!owner) throw new Error("建站长失败: " + (await setup.text().catch(() => "")));
  const providerBody = REAL
    ? {
        activeProvider: "custom",
        providers: {
          custom: { apiKey: process.env.EVAL_API_KEY, model: process.env.EVAL_MODEL, baseUrl: process.env.EVAL_PROVIDER },
        },
      }
    : {
        activeProvider: "custom",
        providers: { custom: { apiKey: "fake-key", model: "eval-fake", baseUrl: `${MODEL_URL}/v1` } },
      };
  await api("/api/settings", { cookie: owner, method: "PUT", body: providerBody });

  // 三个账号：站长 + 两个邀请码注册的普通账号
  const cookies = { xiaolin: owner };
  for (const p of PERSONAS.slice(1)) {
    const inv = await api("/api/invites", { cookie: owner, method: "POST", body: { maxUses: 1, note: "eval" } });
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inviteCode: inv.data?.code,
        username: `eval_${p.key}`,
        phone: `1380013806${p.key === "laochen" ? "2" : "3"}`,
        password: "eval-user-2026",
      }),
    });
    if (!reg.ok) throw new Error(`建账号 ${p.name} 失败: ${await reg.text()}`);
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account: `eval_${p.key}`, password: "eval-user-2026" }),
    });
    cookies[p.key] = cookieOf(login);
    if (!cookies[p.key]) throw new Error(`登录 ${p.name} 失败`);
  }

  // 问卷 + 历史查词事件（直接写隔离库，避免为造数据而发 120 次请求）
  const d = new Database(DB);
  const insertEvent = d.prepare(
    `INSERT INTO explain_events
       (id, user_id, kind, ask_kind, via, word, lemma, freq_rank, is_phrase, repeat_count, created_at)
     VALUES (?, ?, 'lookup', NULL, 'reader', 'artifact', 'artifact', ?, 0, ?, ?)`,
  );
  for (const p of PERSONAS) {
    const saved = await api("/api/learner", { cookie: cookies[p.key], method: "PUT", body: { survey: p.survey } });
    if (!saved.data || saved.data.survey?.stylePref !== p.survey.stylePref) {
      throw new Error(`写入 ${p.name} 问卷失败: ${JSON.stringify(saved.data?.survey)}`);
    }
    const row = d.prepare("select id from users where username = ?").get(
      p.key === "xiaolin" ? "eval_owner" : `eval_${p.key}`,
    );
    d.transaction(() => {
      for (let i = 0; i < p.lookups.n; i++) {
        insertEvent.run(
          `ev-${p.key}-${i}`, row.id, p.lookups.freqRank + (i % 7) * 100,
          p.lookups.repeat, Date.now() - i * 60_000,
        );
      }
      for (let i = 0; i < p.lookups.wholeSentence; i++) {
        d.prepare(
          `INSERT INTO explain_events (id, user_id, kind, ask_kind, via, word, is_phrase, repeat_count, created_at)
           VALUES (?, ?, 'explain', 'whole_sentence', 'reader', 'sentence', 0, 1, ?)`,
        ).run(`ev-${p.key}-ws-${i}`, row.id, Date.now() - i * 60_000);
      }
    })();
  }
  d.close();

  // 开关 on / off 各跑一遍 10 个场景 × 3 个人设
  const results = {};
  for (const mode of ["on", "off"]) {
    const set = await api("/api/settings", { cookie: owner, method: "PUT", body: { aiPersonalized: mode } });
    if (set.status !== 200) throw new Error(`切换开关 ${mode} 失败: ${set.status}`);
    for (const p of PERSONAS) {
      for (const sc of SCENARIOS) {
        const answer = await explain(cookies[p.key], sc);
        results[`${p.key}|${mode}|${sc.name}`] = answer;
      }
    }
  }
  await api("/api/settings", { cookie: owner, method: "PUT", body: { aiPersonalized: "on" } });

  // 报告
  const lines = [
    "# P32 个性化 AI 讲解 · 三个人设人工评审材料",
    "",
    `生成时间：${new Date().toISOString()}`,
    "",
    `模型：${MODEL_LABEL}`,
    "",
    REAL
      ? "对照 PRD §4「他需要什么」逐场景评审：小林需要结构拆解、老陈只要一行、小王需要中文意思加例句。"
      : "> ⚠️ **本报告由本地假模型生成，只用于验证脚本链路和报告格式，不能用于 PRD §4 的产品评审。** 假模型按「学生档案」里的偏好返回不同长度的示意文本；产品负责人需设置 `EVAL_PROVIDER` / `EVAL_API_KEY` / `EVAL_MODEL` 后重跑，才能得到真实讲解。",
    "",
    "## 人设与数据",
    "",
    "| 人设 | 问卷（PRD §8） | 历史查词 |",
    "|---|---|---|",
    ...PERSONAS.map((p) =>
      `| ${p.name} | ${p.desc} | ${p.lookups.n} 次查词，词频排名约 ${p.lookups.freqRank}；「整句没看懂」${p.lookups.wholeSentence} 次 |`,
    ),
    "",
    "每张表里的「开关」列：`on` = 个性化讲解（带学生档案），`off` = 回退到旧的按同句次数决定深度。",
    "字数为讲解原文的字符数（含换行）。",
    "",
  ];
  for (const sc of SCENARIOS) {
    lines.push(`## 场景 ${sc.name}`, "");
    lines.push(`- 选区：\`${sc.word}\``, `- 原句：${sc.sentence}`, `- 问法：\`${sc.askKind}\`，同句第 ${sc.repeat} 次`, "");
    lines.push("| 人设 | 开关 | 讲解原文 | 字数 |", "|---|---|---|---|");
    for (const p of PERSONAS) {
      for (const mode of ["on", "off"]) {
        const text = results[`${p.key}|${mode}|${sc.name}`] ?? "";
        lines.push(`| ${p.name} | ${mode} | ${esc(text) || "（无回答）"} | ${text.length} |`);
      }
    }
    lines.push("");
  }
  lines.push(
    "## 评审要点",
    "",
    "1. `on` 与 `off` 下，三个人设的讲解深度是否拉开差距，且方向与 PRD §4 一致。",
    "2. 第一行「释义：」格式在所有场景下都保持不变（正文小标签 / 词库 / 墨墨卡片依赖它）。",
    "3. 偏好「越简洁越好」的读者即使同句连续查 3 次，也不该主动出现句子地图。",
    "",
  );
  fs.writeFileSync(REPORT, lines.join("\n"), "utf8");
  console.log(`报告：${REPORT}`);
  console.log(`模型：${MODEL_LABEL}`);
  console.log(`场景 ${SCENARIOS.length} × 人设 ${PERSONAS.length} × 开关 2 = ${SCENARIOS.length * PERSONAS.length * 2} 次讲解`);
  console.log("DONE");
} catch (err) {
  console.error("FAILED:", err.stack ?? err.message);
  process.exitCode = 1;
} finally {
  server.kill();
  if (!REAL) fake.close();
  fs.rmSync(TMP, { recursive: true, force: true });
}
