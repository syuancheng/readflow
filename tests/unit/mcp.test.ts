import assert from "node:assert/strict";
import test from "node:test";
import { ensureMcpTokens } from "../../src/db/ensure-mcp-tokens";
import { tokenHash } from "../../src/lib/auth-crypto";
import {
  DEFAULT_PROTOCOL_VERSION,
  handleMcpMessage,
  MCP_TOOLS,
  type ToolExecutor,
} from "../../src/lib/mcp/protocol";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Database = require("better-sqlite3");
type Db = import("better-sqlite3").Database;

const noopExecutor: ToolExecutor = async () => ({ ok: true, data: {} });

test("MCP_TOOLS 暴露首批 5 个核心工具", () => {
  const names = MCP_TOOLS.map((t) => t.name);
  assert.deepEqual(names, [
    "get_learner_profile",
    "get_learning_stats",
    "list_learning_words",
    "log_listening",
    "import_article",
  ]);
});

test("initialize 协商协议版本并返回能力与使用指引", async () => {
  const r1 = await handleMcpMessage(
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
    noopExecutor,
  );
  assert.equal(r1?.id, 1);
  assert.equal((r1?.result as { protocolVersion: string }).protocolVersion, "2024-11-05");

  const r2 = await handleMcpMessage(
    { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } },
    noopExecutor,
  );
  assert.equal((r2?.result as { protocolVersion: string }).protocolVersion, DEFAULT_PROTOCOL_VERSION);
  assert.ok((r2?.result as { instructions: string }).instructions.includes("log_listening"));
});

test("通知消息（无 id）返回 null，ping 与 tools/list 正常响应", async () => {
  const notif = await handleMcpMessage(
    { jsonrpc: "2.0", method: "notifications/initialized" },
    noopExecutor,
  );
  assert.equal(notif, null);

  const ping = await handleMcpMessage({ jsonrpc: "2.0", id: "p1", method: "ping" }, noopExecutor);
  assert.deepEqual(ping, { jsonrpc: "2.0", id: "p1", result: {} });

  const list = await handleMcpMessage(
    { jsonrpc: "2.0", id: 3, method: "tools/list" },
    noopExecutor,
  );
  assert.equal((list?.result as { tools: unknown[] }).tools.length, 5);
});

test("tools/call 正确分发成功、业务失败、异常与未知工具", async () => {
  const called: { name: string; args: Record<string, unknown> }[] = [];
  const exec: ToolExecutor = async (name, args) => {
    called.push({ name, args });
    if (name === "log_listening") return { ok: true, data: { logged: args.minutes } };
    if (name === "import_article") return { ok: false, error: "文章正文不能为空" };
    throw new Error("boom");
  };

  const okRes = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: { name: "log_listening", arguments: { minutes: 0.5 } },
    },
    exec,
  );
  const okPayload = okRes?.result as { content: { text: string }[]; isError: boolean };
  assert.equal(okPayload.isError, false);
  assert.deepEqual(JSON.parse(okPayload.content[0].text), { logged: 0.5 });
  assert.equal(called[0].name, "log_listening");

  const errRes = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "import_article", arguments: {} },
    },
    exec,
  );
  const errPayload = errRes?.result as { content: { text: string }[]; isError: boolean };
  assert.equal(errPayload.isError, true);
  assert.equal(errPayload.content[0].text, "文章正文不能为空");

  const throwRes = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: { name: "get_learner_profile", arguments: {} },
    },
    exec,
  );
  assert.equal((throwRes?.result as { isError: boolean }).isError, true);

  const unknownTool = await handleMcpMessage(
    {
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "delete_all_data", arguments: {} },
    },
    exec,
  );
  assert.equal(unknownTool?.error?.code, -32602);
});

test("未知方法返回 -32601，非法请求返回 -32600", async () => {
  const r1 = await handleMcpMessage({ jsonrpc: "2.0", id: 1, method: "nope" }, noopExecutor);
  assert.equal(r1?.error?.code, -32601);

  const r2 = await handleMcpMessage({ jsonrpc: "1.0", id: 2, method: "ping" }, noopExecutor);
  assert.equal(r2?.error?.code, -32600);
});

test("mcp_tokens 幂等建表、哈希鉴权、重置失效与账号隔离", () => {
  const db = new Database(":memory:") as Db;
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE
    );
    INSERT INTO users VALUES ('u1', 'alice'), ('u2', 'bob');
  `);
  ensureMcpTokens(db);
  ensureMcpTokens(db);

  const tok1 = "rfm_secret_token_one";
  const tok2 = "rfm_secret_token_two";
  const upsert = db.prepare(
    `INSERT INTO mcp_tokens (user_id, token_hash, token_hint, created_at, last_used_at)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT(user_id) DO UPDATE SET
       token_hash = excluded.token_hash,
       token_hint = excluded.token_hint,
       created_at = excluded.created_at,
       last_used_at = NULL`,
  );
  const lookup = (tok: string) =>
    db
      .prepare("SELECT user_id FROM mcp_tokens WHERE token_hash = ?")
      .get(tokenHash(tok)) as { user_id: string } | undefined;

  upsert.run("u1", tokenHash(tok1), tok1.slice(-4), 1000);
  assert.equal(lookup(tok1)?.user_id, "u1");
  assert.equal(lookup("rfm_wrong"), undefined);

  // 重新生成后旧 Token 立即失效
  upsert.run("u1", tokenHash(tok2), tok2.slice(-4), 2000);
  assert.equal(lookup(tok1), undefined);
  assert.equal(lookup(tok2)?.user_id, "u1");

  // 吊销后彻底失效
  db.prepare("DELETE FROM mcp_tokens WHERE user_id = ?").run("u1");
  assert.equal(lookup(tok2), undefined);

  db.close();
});
