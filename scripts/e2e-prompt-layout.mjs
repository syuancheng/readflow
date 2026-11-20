/**
 * P57b：提示词分层（layout=v2）与前缀缓存。
 * 隔离库 + 本地假模型（OpenAI 兼容流式接口）：假模型记下每次请求的 messages，
 * 按「与上一次请求逐字相同的最长前缀」模拟缓存命中，并在最后一块里回传 usage。
 * 用真实服务端的 /api/explain，所以能验证真实拼出来的请求，而不是单测里的纯函数。
 *
 *   node scripts/e2e-prompt-layout.mjs        # 需要先 npm run build
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
import { spawn } from "node:child_process";
import http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 3180;
const MODEL_PORT = 3181;
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(ROOT, ".verify", "prompt-layout");
const DB = path.join(TMP, "readflow.db");

let pass = 0, fail = 0;
const log = (m) => console.log(m);
function check(name, ok, detail = "") {
  if (ok) pass++; else fail++;
  log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

// ---- 假模型：记录请求，模拟前缀缓存 ----
const requests = []; // { messages, hit, prompt }
let last = "";
const flat = (messages) => messages.map((m) => `<${m.role}>${m.content}`).join("\n");
function commonPrefixLen(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
const modelServer = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const j = JSON.parse(body || "{}");
    const text = flat(j.messages || []);
    const hit = commonPrefixLen(last, text);
    last = text;
    requests.push({ messages: j.messages, hit, prompt: text.length, streamOptions: j.stream_options });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    chunk({ choices: [{ delta: { content: "释义：模拟\n模拟回答。" } }] });
    chunk({ choices: [{ delta: {}, finish_reason: "stop" }] });
    chunk({ choices: [], usage: { prompt_tokens: text.length, completion_tokens: 20, prompt_cache_hit_tokens: hit } });
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
await new Promise((r) => modelServer.listen(MODEL_PORT, "127.0.0.1", r));

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
let serverLog = "";
function startServer(layout) {
  const s = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, DB_PATH: DB, NODE_ENV: "production", NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1", READFLOW_PROMPT_LAYOUT: layout },
    stdio: ["ignore", "pipe", "pipe"],
  });
  s.stdout.on("data", (d) => (serverLog += d.toString()));
  s.stderr.on("data", (d) => (serverLog += d.toString()));
  return s;
}
async function waitServer() {
  for (let i = 0; i < 90; i++) {
    try { if ((await fetch(`${BASE}/api/auth/status`)).status) return true; } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}
const dbq = (sql, ...a) => {
  const d = new Database(DB, { readonly: true });
  try { return d.prepare(sql).all(...a); } finally { d.close(); }
};

let server = startServer("v2");
try {
  if (!(await waitServer())) { log("服务器没起来:\n" + serverLog.slice(-3000)); process.exit(1); }
  const setupRes = await fetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "layout_owner", password: "layout-pass-2026", phone: "13800138011" }),
  });
  const cookie = setupRes.headers.get("set-cookie")?.match(/readflow_session=([^;]+)/)?.[1];
  if (!cookie) { log("建号失败: " + (await setupRes.text())); process.exit(1); }
  const H = { "Content-Type": "application/json", cookie: `readflow_session=${cookie}` };

  // 把模型指到假服务器（站级设置，owner 用）
  const d = new Database(DB);
  const put = d.prepare("INSERT OR REPLACE INTO settings (user_id,key,value,updated_at) VALUES ('local',?,?,?)");
  const now = Date.now();
  put.run("ai.activeProvider", "custom", now);
  put.run("ai.custom.apiKey", "sk-fake-key-for-e2e", now);
  put.run("ai.custom.baseUrl", `http://127.0.0.1:${MODEL_PORT}/v1`, now);
  put.run("ai.custom.model", "fake-model", now);
  d.close();

  const P1 = "Agents loop over tools. Each call returns a result.";
  const P2 = "The model decides what to do next. It may call a tool again. That is the whole idea. The loop ends when the model stops.";
  const P3 = "A later paragraph that must never leak into the window of the second one.";
  const textRes = await fetch(`${BASE}/api/texts`, {
    method: "POST", headers: H,
    body: JSON.stringify({ title: "How agents work", category: "技术文档", text: `${P1}\n\n${P2}\n\n${P3}` }),
  });
  const textId = (await textRes.json()).id;
  const paras = dbq("SELECT id, idx, content FROM paragraphs WHERE text_id = ? ORDER BY idx", textId);
  const p2 = paras[1];
  // 阅读页现在会带的两层上下文（v1 用它；v2 以服务端按 anchor 算的段落窗口为准）
  const SENT = [...P1.match(/[^.]+\./g), ...P2.match(/[^.]+\./g)].map((x) => x.trim());
  const layersFor = (start) => {
    const sentenceText = P2.slice(0, start + 1).match(/[^.]*\.?$/)?.[0] ?? "";
    const k = SENT.findIndex((x) => P2.indexOf(x) <= start && start < P2.indexOf(x) + x.length && P2.includes(x));
    const idx = k >= 0 ? k : SENT.length - 1;
    return { sentence: SENT[idx] ?? sentenceText.trim(), nearContext: SENT.slice(0, idx).reverse() };
  };
  const ask = async (word, start, end, extra = {}) => {
    const before = requests.length;
    const res = await fetch(`${BASE}/api/explain`, {
      method: "POST", headers: H,
      body: JSON.stringify({
        word, context: "", language: "en", monolingual: false, textId,
        anchor: { paragraphId: p2.id, start, end }, askKind: "default", contextLayers: layersFor(start), ...extra,
      }),
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 300));
    return requests.slice(before)[0];
  };
  const at = (s) => P2.indexOf(s);

  // ---- 同一句里点两个词（前缀应全部命中），再换另一句 ----
  const r1 = await ask("decides", at("decides"), at("decides") + 7);
  const r1b = await ask("model", at("model"), at("model") + 5);
  const r2 = await ask("tool", at("tool"), at("tool") + 4);
  const sys = (r) => r.messages.filter((m) => m.role === "system");
  const tailStart = (r) => flat(r.messages).lastIndexOf("<user>");
  const l3Start = (r) => flat(r.messages).indexOf("【文章上下文");
  check("V1 v2 结构：第一条 system 是人设，没有拆句/领域内容", r1.messages[0].role === "system" && /英语为母语/.test(r1.messages[0].content));
  const l3 = sys(r1).find((m) => m.content.includes("【文章上下文"))?.content ?? "";
  check("V2 上下文层：前文（上一段）+ 所在句 + 同段后一句；不含更后面的句子，不跨段取后文",
    /Agents loop over tools/.test(l3) && /The model decides what to do next\./.test(l3) && /后一句[^]*It may call a tool again\./.test(l3) && !l3.includes("That is the whole idea") && !l3.includes("later paragraph"), l3.slice(-200));
  check("V3 文章层带标题与分类", sys(r1).some((m) => /How agents work/.test(m.content) && /技术文档/.test(m.content)));
  check("V4 同一句里点第二个词：命中覆盖了除尾部之外的全部前缀", r1b.hit >= tailStart(r1b) - 5, `hit=${r1b.hit} 尾部起点=${tailStart(r1b)}`);
  check("V4b 换到另一句：人设 / 用户层 / 文章层仍然命中，只有上下文层重算", r2.hit >= l3Start(r2) - 5 && r2.hit < tailStart(r2), `hit=${r2.hit} 上下文层起点=${l3Start(r2)}`);
  check("V5 尾部（user）含所在句与选中词", /所在句: "It may call a tool again\./.test(r2.messages.at(-1).content) && /用户选中: "tool"/.test(r2.messages.at(-1).content));

  // ---- 切换问法：拆句 / 领域，前缀不变 ----
  const r3 = await ask("tool", at("tool"), at("tool") + 4, { askKind: "structure" });
  check("V6 点「讲讲句子结构」：前缀仍然全部命中（拆句方法在尾部）", r3.hit >= tailStart(r3) - 5 && /带学生拆开这个长句/.test(r3.messages.at(-1).content), `hit=${r3.hit}/${tailStart(r3)}`);
  const r4 = await ask("tool", at("tool"), at("tool") + 4, { askKind: "domain" });
  check("V7 点「从内容角度讲讲」：前缀仍然全部命中，且人设没被换掉", r4.hit >= tailStart(r4) - 5 && r4.messages[0].content === r1.messages[0].content && /资深的专业技术人员/.test(r4.messages.at(-1).content), `hit=${r4.hit}/${tailStart(r4)}`);

  // ---- 用量落库 ----
  const ev = dbq("SELECT layout, para_click_n, prompt_tokens, cache_hit_tokens FROM explain_events ORDER BY created_at");
  check("V8 用量落库：每次请求都有 prompt/命中 token，layout=v2，同段次数递增", ev.length === 5 && ev.every((e) => e.layout === "v2" && e.prompt_tokens > 0) && ev.map((e) => e.para_click_n).join() === "1,2,3,4,5", JSON.stringify(ev));
  check("V9 请求带了 stream_options.include_usage", requests.every((r) => r.streamOptions?.include_usage === true));
  check("V10 命中数是模型回传的真实值（第二次起 > 0）", ev[1].cache_hit_tokens > 0 && ev[0].cache_hit_tokens === 0, JSON.stringify(ev.map((e) => e.cache_hit_tokens)));

  // ---- 对照：v1 同样的两次点击 ----
  server.kill();
  await new Promise((r) => setTimeout(r, 800));
  last = "";
  server = startServer("v1");
  if (!(await waitServer())) { log("v1 服务器没起来"); process.exit(1); }
  const a1 = await ask("decides", at("decides"), at("decides") + 7);
  const a2 = await ask("tool", at("tool"), at("tool") + 4);
  const a3 = await ask("tool", at("tool"), at("tool") + 4, { askKind: "structure" });
  check("V11 回退到 v1：请求与原来一致（上下文在第 2 条 system 里，没有 v2 的上下文层）", a1.messages.length === 3 && a1.messages.some((m) => m.content.includes("【文章上下文：两处不同")) && !a1.messages.some((m) => m.content.includes("【文章上下文：三处不同")), `messages=${a1.messages.length}`);
  log(`      对照（点「讲讲句子结构」）：v1 命中 ${a3.hit}/${a3.prompt} 字符；v2 命中 ${r3.hit}/${r3.prompt} 字符`);
  check("V12 v2 点「讲讲句子结构」命中的字符数 > v1（v1 的拆句方法插在前面，断了后面的缓存）", r3.hit > a3.hit, `v2=${r3.hit} v1=${a3.hit}`);
  const bad = serverLog.split("\n").filter((l) => /\b(Error|TypeError|SqliteError|unhandled)\b/.test(l));
  check("V13 服务端日志没有异常", bad.length === 0, bad.slice(0, 3).join(" | "));
} catch (e) {
  fail++;
  log("异常: " + (e?.stack || e));
} finally {
  server.kill();
  modelServer.close();
  log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
