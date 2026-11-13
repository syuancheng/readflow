/**
 * P33 阶段一·后端端到端（做卡：生成 / 校验 / 复核 / 换一道 / 额度 / 开关）。
 *
 * 隔离库 + 临时端口 3137（假模型 3138），跑完删库，不碰 data/readflow.db。
 * 假模型是本地 OpenAI 兼容端点：不调真实模型、不花钱，并记下每次请求的 messages，
 * 用来断言「做卡接着讲解的对话走（前缀逐字一致）」「重出带上一版和原因」等。
 *
 *   node scripts/e2e-cards.mjs      （需要先 next build；构建前设 DB_PATH 指向临时空库）
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
const SITE_PORT = 3138;
const SITE = `http://127.0.0.1:${SITE_PORT}`;
const TMP = path.join(ROOT, ".verify", "cards");
const DB = path.join(TMP, "readflow.db");

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  if (ok) pass++; else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
};
const dbAll = (sql, ...args) => {
  const d = new Database(DB, { readonly: true });
  try { return d.prepare(sql).all(...args); } finally { d.close(); }
};
const dbRun = (sql, ...args) => {
  const d = new Database(DB);
  try { return d.prepare(sql).run(...args); } finally { d.close(); }
};

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

// ---------- 假模型 ----------
const SENTENCE = "The ephemeral joy faded quickly.";
const choiceCard = (over = {}) => ({
  kind: "context_meaning",
  target: "ephemeral 的语境义",
  front: [
    { t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "highlight" } },
    { t: "instruction", text: "ephemeral is closest in meaning to" },
    { t: "choice", options: [{ text: "brief", correct: true }, { text: "large", correct: false }, { text: "loud", correct: false }] },
  ],
  back: { answer: [{ t: "text", text: "brief" }], explanation: [{ t: "text", text: "ephemeral 指转瞬即逝的" }] },
  ...over,
});
const layeredCard = () => ({
  kind: "layered_cloze",
  target: "ephemeral 拼写",
  front: [{ t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "blank" } }],
  hints: [{ t: "text", text: "首字母 e，意思是转瞬即逝" }],
  back: { answer: [{ t: "fill", answer: "ephemeral" }] },
});
// 泄露目标词的坏卡：挖空卡正面又写出了完整的词
const leakyCard = () => ({
  ...layeredCard(),
  kind: "word_completion",
  hints: undefined,
  front: [
    { t: "sentence", source: "original", text: SENTENCE, mark: { start: 4, end: 13, as: "blank" } },
    { t: "instruction", text: "填出 Ephemeral" },
  ],
});

const calls = []; // { kind: 'explain'|'cards'|'review'|'redo'|'regen', messages }
let cardsMode = "good";          // good | bad (永远不合格) | garbage (非 JSON) | leak-then-good
let leakServed = false;
let reviewMode = "ok";           // ok | multi (说有多个可行答案)
let slowMs = 0;

const classify = (messages) => {
  const sys = messages[0]?.content ?? "";
  const last = messages[messages.length - 1]?.content ?? "";
  if (sys.includes("检查一道选择题")) return "review";
  if (last.includes("这张卡不合格")) return "redo";
  if (last.includes("请换一道")) return "regen";
  if (last.includes("请为这个词出考试题型的记忆卡")) return "cards";
  return "explain";
};

const fake = http.createServer((req, res) => {
  if (req.url.split("?")[0] !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
  let buf = "";
  req.on("data", (d) => (buf += d));
  req.on("end", async () => {
    let body = {};
    try { body = JSON.parse(buf); } catch { /* 畸形请求 */ }
    const messages = body.messages ?? [];
    const kind = classify(messages);
    calls.push({ kind, messages, stream: body.stream === true, json: body.response_format?.type === "json_object" });

    if (body.stream === true) {
      res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" });
      for (const part of ["释义：短暂的\n", "ephemeral 形容转瞬即逝。\n", "制卡建议：正好在你词汇量的边缘"]) {
        res.write(`data: ${JSON.stringify({ id: "f", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [{ index: 0, delta: { content: part }, finish_reason: null }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
    let content;
    if (kind === "review") {
      content = JSON.stringify({ possible: reviewMode === "ok" ? [1] : [1, 2] });
    } else if (cardsMode === "garbage") {
      content = "这不是 JSON";
    } else if (cardsMode === "bad") {
      content = JSON.stringify({ cards: [leakyCard()] });
    } else if (cardsMode === "leak-then-good" && kind === "cards" && !leakServed) {
      leakServed = true;
      content = JSON.stringify({ cards: [leakyCard(), choiceCard()] });
    } else if (kind === "regen") {
      content = JSON.stringify({ cards: [choiceCard({ target: "换一道后的卡" })] });
    } else {
      content = JSON.stringify({ cards: [choiceCard(), layeredCard()] });
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "f", object: "chat.completion", created: 0, model: "fake-model",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 200, prompt_cache_hit_tokens: 800 },
    }));
  });
});

const server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
  cwd: ROOT,
  env: { ...process.env, DB_PATH: DB, NODE_ENV: "production", NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1" },
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
  const res = await fetch(BASE + pathname, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* 流式 */ }
  return { status: res.status, data, text, headers: res.headers };
}

/** 建一篇文章并在 ephemeral 上留一条批注，返回 { textId, contextId } */
async function seedContext(cookie, title) {
  const t = await api("/api/texts", { cookie, method: "POST", body: { title, text: SENTENCE } });
  const textId = t.data?.id ?? t.data?.textId ?? t.data?.text?.id;
  const detail = await api(`/api/texts/${textId}`, { cookie });
  const para = detail.data?.paragraphs?.[0];
  const ctx = await api("/api/contexts/ensure", {
    cookie, method: "POST",
    body: {
      word: "ephemeral", textId, paragraphId: para.id, start: 4, end: 13, quote: "ephemeral",
      prefix: "The ", suffix: " joy faded quickly.",
      aiGloss: "释义：短暂的\nephemeral 形容转瞬即逝。",
    },
  });
  return { textId, contextId: ctx.data?.contextId };
}

async function waitSet(cookie, setId, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const r = await api(`/api/cards/sets/${setId}`, { cookie });
    if (r.data?.set?.status && r.data.set.status !== "generating") return r.data;
    if (Date.now() - t0 > timeoutMs) return r.data;
    await new Promise((r2) => setTimeout(r2, 250));
  }
}
const usageOf = (userId) => dbAll("SELECT count FROM card_usage WHERE user_id = ?", userId)[0]?.count ?? 0;
const callsOf = (kind) => calls.filter((c) => c.kind === kind);

try {
  await new Promise((resolve) => fake.listen(SITE_PORT, "127.0.0.1", resolve));
  let up = false;
  for (let i = 0; i < 90 && !up; i++) {
    try { await fetch(`${BASE}/api/auth/status`); up = true; } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  if (!up) throw new Error("服务器没起来:\n" + serverLog.slice(-2000));

  // ===== 账号与模型 =====
  const setup = await fetch(`${BASE}/api/auth/setup`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "p33_owner", password: "p33-owner-2026", phone: "13800138061" }),
  });
  const owner = cookieOf(setup);
  if (!owner) throw new Error("建站长失败");
  await api("/api/settings", {
    cookie: owner, method: "PUT",
    body: { activeProvider: "custom", providers: { custom: { apiKey: "fake-key", model: "fake-model", baseUrl: `${SITE}/v1` } } },
  });
  const ownerId = dbAll("SELECT id FROM users WHERE username = 'p33_owner'")[0].id;

  // 备考问卷：六级 → 考试风格应落成「四六级 · …」
  await api("/api/learner", {
    cookie: owner, method: "PUT",
    body: { survey: { identity: "work_3_10", exam: "cet6", goals: ["exam"], readingFeel: "occasional", stylePref: "balanced" } },
  });

  const code = (await api("/api/invites", { cookie: owner, method: "POST", body: { maxUses: 1, note: "p33" } })).data.code;
  await api("/api/auth/register", {
    method: "POST", body: { inviteCode: code, username: "p33_friend", phone: "13800138062", password: "p33-friend-2026" },
  });
  const friend = cookieOf(await fetch(`${BASE}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: "p33_friend", password: "p33-friend-2026" }),
  }));
  const friendId = dbAll("SELECT id FROM users WHERE username = 'p33_friend'")[0].id;

  const o = await seedContext(owner, "Owner text");
  const f = await seedContext(friend, "Friend text");
  check("A0 种子数据就绪（文章 + 批注）", Boolean(o.contextId && f.contextId), `owner=${o.contextId} friend=${f.contextId}`);

  // ===== 未登录 / 越权 =====
  const anon = await api("/api/cards/generate", { method: "POST", body: { contextId: o.contextId } });
  check("B1 未登录 → 401", anon.status === 401, `status=${anon.status}`);
  const cross = await api("/api/cards/generate", { cookie: friend, method: "POST", body: { contextId: o.contextId } });
  check("B2 别人的批注 → 404，且没有建出组", cross.status === 404 && dbAll("SELECT id FROM card_sets WHERE user_id = ?", friendId).length === 0, `status=${cross.status}`);
  const noCtx = await api("/api/cards/generate", { cookie: owner, method: "POST", body: {} });
  check("B3 缺 contextId → 400", noCtx.status === 400);

  // ===== 讲解 → 缓存 → 做卡（前缀复用）=====
  const ex = await api("/api/explain", {
    cookie: owner, method: "POST",
    body: { word: "ephemeral", context: SENTENCE, prefix: "The ", suffix: " joy faded quickly.", language: "en", monolingual: false, askKind: "auto", contextId: o.contextId, textId: o.textId },
  });
  const answerId = ex.headers.get("x-rf-answer-id");
  check("C0 讲解成功并返回 answerId，系统提示词含制卡建议规则", ex.status === 200 && Boolean(answerId) && (callsOf("explain")[0]?.messages[0]?.content ?? "").includes("制卡建议"), `status=${ex.status}`);
  await new Promise((r) => setTimeout(r, 300)); // 等流结束后缓存写入

  const g1 = await api("/api/cards/generate", { cookie: owner, method: "POST", body: { contextId: o.contextId, answerId } });
  check("C1 generate 立刻返回 generating", g1.status === 200 && g1.data?.status === "generating" && Boolean(g1.data?.setId) && g1.data?.reused === false, JSON.stringify(g1.data));
  const r1 = await waitSet(owner, g1.data.setId);
  check("C2 生成完成：ready，2 张草稿卡", r1?.set?.status === "ready" && r1.cards.length === 2 && r1.cards.every((c) => c.status === "draft"), `status=${r1?.set?.status} cards=${r1?.cards?.length}`);

  const explainMsgs = callsOf("explain")[0].messages;
  const genCall = callsOf("cards")[0];
  const prefixSame = explainMsgs.every((m, i) => genCall.messages[i]?.role === m.role && genCall.messages[i]?.content === m.content);
  const assistantTurn = genCall.messages[explainMsgs.length];
  check("C3 缓存命中：做卡请求的前缀与讲解逐字一致，随后是讲解全文（含建议行）和出题指令",
    prefixSame && assistantTurn?.role === "assistant" && assistantTurn.content.includes("制卡建议：") &&
    genCall.messages.length === explainMsgs.length + 2 && genCall.json,
    `前缀一致=${prefixSame} 总轮数=${genCall.messages.length}`);
  check("C4 token 统计写进组（缓存命中 800 / 提示 1000 / 输出 200）",
    r1.set.cacheHitTokens === 800 && r1.set.promptTokens === 1000 && r1.set.completionTokens === 200,
    JSON.stringify([r1.set.cacheHitTokens, r1.set.promptTokens, r1.set.completionTokens]));

  const [c0, c1] = r1.cards;
  check("C5 选择题复核通过：没有 needs_review；复核请求不含正确答案标记", c0.needsReview === null && callsOf("review").length === 1 &&
    !callsOf("review")[0].messages[1].content.includes("correct"), `review=${c0.needsReview}`);
  check("C6 内容是墨墨语法：标签行 / 高亮 / 一条答案线", c0.content.startsWith("[P#L#") && c0.content.includes("[T#B,!1cb0f6#ephemeral]") &&
    c0.content.split("\n").filter((l) => l === "---").length === 1, c0.content.slice(0, 120));
  check("C7 考试风格由系统按问卷写入：六级 →「四六级 · 词汇题」", c0.content.includes("四六级 · 词汇题"), c0.content.split("\n")[0]);
  const lines1 = c1.content.split("\n");
  const sepIdx = lines1.map((l, i) => (l === "---" ? i : -1)).filter((i) => i >= 0);
  check("C8 带提示的卡：两条答案线，提示在两条之间、正面不含提示",
    sepIdx.length === 2 && lines1.slice(0, sepIdx[0]).join("\n").indexOf("首字母") < 0 && lines1.slice(sepIdx[0], sepIdx[1]).join("\n").includes("首字母"),
    `答案线位置=${sepIdx}`);
  check("C9 站点模型的用户额度：站长自己不计数", usageOf(ownerId) === 0, `usage=${usageOf(ownerId)}`);

  // ===== 去重 =====
  const g2 = await api("/api/cards/generate", { cookie: owner, method: "POST", body: { contextId: o.contextId } });
  check("D1 同一批注再点：返回已有的组（reused），不再调模型", g2.data?.setId === g1.data.setId && g2.data?.reused === true && callsOf("cards").length === 1, JSON.stringify(g2.data));

  // ===== 待推送列表 =====
  const pend = await api("/api/cards/pending", { cookie: owner });
  check("E1 待推送列表按文章分组，含 2 张草稿", pend.status === 200 && pend.data?.total === 2 && pend.data.texts?.[0]?.words?.[0]?.cards?.length === 2, JSON.stringify(pend.data)?.slice(0, 150));
  const pendF = await api("/api/cards/pending", { cookie: friend });
  check("E2 别人看不到我的草稿", pendF.data?.total === 0);

  // ===== 修改 =====
  const spec0 = JSON.parse(dbAll("SELECT spec FROM cards WHERE id = ?", c0.id)[0].spec);
  const edited = { ...spec0, front: spec0.front.map((b) => (b.t === "instruction" ? { ...b, text: "ephemeral most nearly means" } : b)) };
  dbRun("UPDATE cards SET needs_review = '测试用标记' WHERE id = ?", c0.id);
  const p1 = await api(`/api/cards/${c0.id}`, { cookie: owner, method: "PATCH", body: { spec: edited } });
  const row0 = dbAll("SELECT edited, needs_review, content FROM cards WHERE id = ?", c0.id)[0];
  check("F1 改题干：通过校验，edited=1，needs_review 被清掉，内容重新渲染", p1.status === 200 && row0.edited === 1 && row0.needs_review === null && row0.content.includes("most nearly means"), `status=${p1.status} ${p1.text.slice(0, 80)}`);
  const tamper = { ...spec0, front: spec0.front.map((b) => (b.t === "sentence" ? { ...b, text: "The ephemeral joy faded slowly." } : b)) };
  const p2 = await api(`/api/cards/${c0.id}`, { cookie: owner, method: "PATCH", body: { spec: tamper } });
  check("F2 改原句 → 400（原句不能改）", p2.status === 400 && p2.text.includes("原句"), `status=${p2.status} ${p2.text.slice(0, 80)}`);
  const leak = { ...spec0, front: [...spec0.front, { t: "instruction", text: "意思是短暂的" }] };
  const p3 = await api(`/api/cards/${c0.id}`, { cookie: owner, method: "PATCH", body: { spec: leak } });
  check("F3 题干写出中文意思 → 400，数据库不变", p3.status === 400 && dbAll("SELECT content FROM cards WHERE id = ?", c0.id)[0].content === row0.content, `status=${p3.status}`);
  const p4 = await api(`/api/cards/${c0.id}`, { cookie: friend, method: "PATCH", body: { spec: edited } });
  check("F4 别人改我的卡 → 404", p4.status === 404);
  const huge = { ...spec0, back: { ...spec0.back, explanation: [{ t: "text", text: "字".repeat(1900) }] } };
  const p5 = await api(`/api/cards/${c0.id}`, { cookie: owner, method: "PATCH", body: { spec: huge } });
  check("F5 超过 1800 字 → 400（普通会员上限）", p5.status === 400 && p5.text.includes("卡片太长"), p5.text.slice(0, 100));
  const pm = await api("/api/settings", { cookie: owner, method: "PUT", body: { markjiMembership: "pro" } });
  const p6 = await api(`/api/cards/${c0.id}`, { cookie: owner, method: "PATCH", body: { spec: huge } });
  check("F6 站长自己切到专业版后，同样的卡能保存（上限 4000）；会员档位只属于本人", pm.data?.markjiMembership === "pro" && p6.status === 200 &&
    (await api("/api/settings", { cookie: friend })).data?.markjiMembership === "basic", `status=${p6.status}`);
  await api("/api/settings", { cookie: owner, method: "PUT", body: { markjiMembership: "basic" } });
  await api(`/api/cards/${c0.id}`, { cookie: owner, method: "PATCH", body: { spec: edited } });

  // ===== 换一道 =====
  const before = callsOf("regen").length;
  const rg = await api(`/api/cards/${c0.id}/regenerate`, { cookie: owner, method: "POST" });
  const regenCall = callsOf("regen")[before];
  const msgText = regenCall?.messages.map((m) => m.content).join("\n") ?? "";
  check("G1 换一道成功：原卡 discarded，新卡 draft，regen_count=1", rg.status === 200 &&
    dbAll("SELECT status FROM cards WHERE id = ?", c0.id)[0].status === "discarded" &&
    dbAll("SELECT COUNT(*) n FROM cards WHERE set_id = ? AND status = 'draft'", g1.data.setId)[0].n === 2 &&
    dbAll("SELECT regen_count FROM card_sets WHERE id = ?", g1.data.setId)[0].regen_count === 1, `status=${rg.status} ${rg.text.slice(0, 80)}`);
  check("G2 换一道的请求带着这个词的完整上下文（原句、讲解、上一张卡）", Boolean(regenCall) && msgText.includes(SENTENCE) && msgText.includes("ephemeral 形容转瞬即逝") && msgText.includes("context_meaning"), `轮数=${regenCall?.messages.length}`);
  check("G3 换一道不计入每天额度", usageOf(ownerId) === 0);
  const newDraft = dbAll("SELECT id FROM cards WHERE set_id = ? AND status = 'draft' ORDER BY seq", g1.data.setId).map((r) => r.id);
  let last = rg;
  for (let i = 0; i < 5; i++) {
    const id = dbAll("SELECT id FROM cards WHERE set_id = ? AND status = 'draft' ORDER BY seq DESC LIMIT 1", g1.data.setId)[0].id;
    last = await api(`/api/cards/${id}/regenerate`, { cookie: owner, method: "POST" });
    if (last.status !== 200) break;
  }
  check("G4 每组最多换 5 次：第 6 次 → 429", last.status === 429, `status=${last.status}`);
  const delId = newDraft[0];
  const del = await api(`/api/cards/${delId}`, { cookie: owner, method: "DELETE" });
  check("G5 删除 = 软删（discarded），之后不能再删", del.status === 200 && dbAll("SELECT status FROM cards WHERE id = ?", delId)[0].status === "discarded" &&
    (await api(`/api/cards/${delId}`, { cookie: owner, method: "DELETE" })).status === 400);

  // ===== 校验失败 → 带原因重出一次 =====
  cardsMode = "leak-then-good";
  const o2 = await seedContext(owner, "Owner text 2");
  const redoBefore = callsOf("redo").length;
  const gl = await api("/api/cards/generate", { cookie: owner, method: "POST", body: { contextId: o2.contextId } });
  const rl = await waitSet(owner, gl.data.setId);
  const redoCall = callsOf("redo")[redoBefore];
  const redoText = redoCall?.messages.map((m) => m.content).join("\n") ?? "";
  check("H1 一张坏卡（泄露目标词）被重出，另一张好卡照常入库；组 ready", rl?.set?.status === "ready" && rl.cards.length === 2, `status=${rl?.set?.status} cards=${rl?.cards?.length}`);
  check("H2 重出请求接着原对话：带上一版输出（JSON）和不合格原因", Boolean(redoCall) && redoText.includes("填出 Ephemeral") && redoText.includes("完整的目标词") && redoText.includes(SENTENCE), `轮数=${redoCall?.messages.length}`);

  // ===== 选择题复核：有歧义 → 重出一次 → 仍有歧义则标 needs_review =====
  cardsMode = "good";
  reviewMode = "multi";
  const o3 = await seedContext(owner, "Owner text 3");
  const g3 = await api("/api/cards/generate", { cookie: owner, method: "POST", body: { contextId: o3.contextId } });
  const r3 = await waitSet(owner, g3.data.setId);
  const choiceCard3 = r3?.cards?.find((c) => c.content.includes("[Choice#"));
  check("I1 复核认为有多个答案：重出后仍然如此 → 保留草稿并标 needs_review", r3?.set?.status === "ready" && Boolean(choiceCard3?.needsReview), `needsReview=${choiceCard3?.needsReview}`);
  reviewMode = "ok";

  // ===== 失败不扣次数；站点模型用户的额度 =====
  cardsMode = "garbage";
  const gf = await api("/api/cards/generate", { cookie: friend, method: "POST", body: { contextId: f.contextId } });
  const rf = await waitSet(friend, gf.data.setId);
  check("J1 模型一直返回非 JSON：组 failed，带中文原因；额度没被扣", rf?.set?.status === "failed" && Boolean(rf.set.error) && usageOf(friendId) === 0,
    `status=${rf?.set?.status} error=${rf?.set?.error} usage=${usageOf(friendId)}`);
  cardsMode = "bad";
  const gb = await api("/api/cards/generate", { cookie: friend, method: "POST", body: { contextId: f.contextId } });
  const rb = await waitSet(friend, gb.data.setId);
  check("J2 重出后仍不合格：组 failed，额度没被扣", rb?.set?.status === "failed" && usageOf(friendId) === 0, `status=${rb?.set?.status} usage=${usageOf(friendId)}`);

  cardsMode = "good";
  const gOk = await api("/api/cards/generate", { cookie: friend, method: "POST", body: { contextId: f.contextId } });
  check("J3 生成中就已占用一个名额（并发请求不会一起冲过上限）", usageOf(friendId) === 1, `usage=${usageOf(friendId)}`);
  const rOk = await waitSet(friend, gOk.data.setId);
  check("J4 成功后计 1 次", rOk?.set?.status === "ready" && usageOf(friendId) === 1);

  dbRun("UPDATE card_usage SET count = 30 WHERE user_id = ?", friendId);
  const f2 = await seedContext(friend, "Friend text 2");
  const gq = await api("/api/cards/generate", { cookie: friend, method: "POST", body: { contextId: f2.contextId } });
  check("J5 当天已做 30 个词 → 429，提示里写明次数", gq.status === 429 && /30/.test(gq.data?.error ?? ""), `status=${gq.status} ${gq.data?.error}`);
  const forced = await api("/api/cards/generate", { cookie: friend, method: "POST", body: { contextId: f.contextId, force: true } });
  check("J6 force 重做也受额度限制", forced.status === 429);
  dbRun("UPDATE card_usage SET count = 29 WHERE user_id = ?", friendId);
  slowMs = 0;

  // ===== 卡死的 generating 组会过期，不会永远挡住去重 =====
  dbRun("UPDATE card_usage SET count = 0 WHERE user_id = ?", friendId);
  const f3 = await seedContext(friend, "Friend text 3");
  dbRun(
    `INSERT INTO card_sets (id, user_id, user_word_id, context_id, text_id, status, created_at, updated_at)
     SELECT 'stale-set', ?, w.id, ?, c.text_id, 'generating', ?, ? FROM contexts c JOIN user_words w ON w.id = c.user_word_id WHERE c.id = ?`,
    friendId, f3.contextId, Date.now() - 10 * 60 * 1000, Date.now() - 10 * 60 * 1000, f3.contextId,
  );
  dbRun("INSERT INTO card_usage (user_id, day, count) VALUES (?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET count = 1", friendId,
    new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" }));
  const gs = await api("/api/cards/generate", { cookie: friend, method: "POST", body: { contextId: f3.contextId } });
  const stale = dbAll("SELECT status FROM card_sets WHERE id = 'stale-set'")[0];
  check("K1 10 分钟前卡住的 generating 组被标 failed，新请求另起一组并正常生成", stale.status === "failed" && gs.data?.reused === false && gs.data?.setId !== "stale-set", `stale=${stale.status} reused=${gs.data?.reused}`);
  await waitSet(friend, gs.data.setId);

  // ===== 开关与权限 =====
  const fOff = await api("/api/settings", { cookie: friend, method: "PUT", body: { cardsEnabled: "off" } });
  check("L1 普通账号改站级做卡开关 → 403", fOff.status === 403);
  const oOff = await api("/api/settings", { cookie: owner, method: "PUT", body: { cardsEnabled: "off" } });
  const gOff = await api("/api/cards/generate", { cookie: owner, method: "POST", body: { contextId: o.contextId, force: true } });
  const exOff = await api("/api/explain", { cookie: owner, method: "POST", body: { word: "ephemeral", context: SENTENCE, language: "en", askKind: "auto" } });
  const lastExplain = callsOf("explain").at(-1).messages[0].content;
  check("L2 站长关掉做卡：generate → 403；之后的讲解提示词不再带制卡建议规则",
    oOff.data?.cardsEnabled === "off" && gOff.status === 403 && exOff.status === 200 && !lastExplain.includes("制卡建议"), `generate=${gOff.status}`);
  await api("/api/settings", { cookie: owner, method: "PUT", body: { cardsEnabled: "on" } });
  const bad = await api("/api/settings", { cookie: owner, method: "PUT", body: { cardsListening: "maybe" } });
  check("L3 开关取值非法 → 400", bad.status === 400);

  // ===== 听力开关默认关：出题指令里没有音频零件 =====
  const cardsPrompt = callsOf("cards")[0].messages.at(-1).content;
  check("M1 听力默认关：出题指令不含音频零件；备考风格段落在", !cardsPrompt.includes("整句音频") && cardsPrompt.includes("因人而异") && cardsPrompt.includes("四六级"), `整句音频=${cardsPrompt.includes("整句音频")} 因人而异=${cardsPrompt.includes("因人而异")} 四六级=${cardsPrompt.includes("四六级")}`);

  // ===== 失败日志里没有残留进程错误 =====
  check("N1 服务端日志没有未捕获异常", !/unhandled|TypeError|ReferenceError/i.test(serverLog), serverLog.split("\n").filter((l) => /unhandled|TypeError|ReferenceError/i.test(l)).slice(0, 2).join(" | "));
} catch (err) {
  fail++;
  console.log("FAIL  脚本异常:", err?.stack ?? err);
} finally {
  server.kill("SIGTERM");
  await new Promise((r) => fake.close(r));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
