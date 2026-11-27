/**
 * ReadFlow MCP 协议层（JSON-RPC 2.0 + Streamable HTTP，纯函数，无 DB 依赖）。
 *
 * 兼容 MCP 2025-03-26 与 2024-11-05，适配 Claude Desktop、Cursor、Antigravity、Gemini CLI 等客户端。
 */

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;
export const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
};

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: "get_learner_profile",
    description:
      "获取当前用户的英语学习背景档案（CEFR 水平、估计词汇量、备考目标、长期老师笔记、教学偏好规则及近期阅读分布）。当你需要按用户真实英语水平改写文章、推荐材料或制定学习计划时，应先调用此工具。",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "get_learning_stats",
    description:
      "获取当前用户的英语学习战绩：阅读已完读词数（今日/本周/本月/累计、已完读篇数、连续天数与最近完读文章）以及听力彻底听懂净时长（分钟，今日/本周/本月/累计、连续天数与最近记录）。",
    inputSchema: {
      type: "object",
      properties: {
        dimension: {
          type: "string",
          enum: ["all", "reading", "listening"],
          description: "查询维度：all（默认，阅读+听力）、reading（仅阅读）、listening（仅听力）",
        },
      },
    },
  },
  {
    name: "list_learning_words",
    description:
      "获取当前用户在 ReadFlow 中正在学习或星标的生词列表，便于在改写英文文章、造句或复习时自然复现这些词汇。",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["learning", "learned", "all"],
          description: "词汇状态筛选，默认 learning（正在学）",
        },
        starredOnly: {
          type: "boolean",
          description: "是否只返回星标重点词，默认 false",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "最多返回条数（1–100），默认 30",
        },
      },
    },
  },
  {
    name: "log_listening",
    description:
      "记录一次彻底听懂的英语听力净时长（分钟，支持浮点数，例如 0.5 表示 30 秒、12.5 表示 12 分半），写入 ReadFlow 听力战绩并返回更新后的今日/累计统计。",
    inputSchema: {
      type: "object",
      properties: {
        minutes: {
          type: "number",
          minimum: 0.1,
          maximum: 600,
          description: "彻底听懂的净时长（分钟），支持浮点数，如 0.5、5、15",
        },
        mode: {
          type: "string",
          enum: ["intensive", "extensive"],
          description: "练习类型：intensive（精听，默认）或 extensive（泛听）",
        },
        logDate: {
          type: "string",
          description: "记录日期 YYYY-MM-DD（选填，默认今天，不可晚于今天，可用于补录）",
        },
        note: {
          type: "string",
          description: "选填备注，如材料名或主题（最长 200 字）",
        },
      },
      required: ["minutes"],
    },
  },
  {
    name: "import_article",
    description:
      "将一篇英文文章导入到当前用户的 ReadFlow 书架，自动完成分段、词数统计与 CEFR 难度评估。支持直接传入正文（纯文本或 Markdown，例如你刚改写或生成的文章）或网页 URL（content 与 url 二选一）。",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "文章标题（选填，不传时自动从正文首行或网页标题提取，最长 200 字）",
        },
        content: {
          type: "string",
          description: "英文文章正文（纯文本或 Markdown）；与 url 二选一",
        },
        url: {
          type: "string",
          description: "文章网页链接（http/https）；与 content 二选一",
        },
        category: {
          type: "string",
          description: "文章分类（选填，如 新闻 / 技术文档 / 博客 / 论文 / 文学 / 教程 / 其他，最长 30 字）",
        },
      },
    },
  },
];

export type McpToolName = (typeof MCP_TOOLS)[number]["name"];

export type ToolExecResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolExecResult>;

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

const SERVER_INFO = {
  name: "readflow",
  version: "1.0.0",
};

const SERVER_INSTRUCTIONS =
  "ReadFlow 是用户的个人英语精读与听力战绩工具。你可以先调用 get_learner_profile / list_learning_words 了解用户的英语水平、备考目标与在学生词，再据此改写或推荐合适难度的英文文章并通过 import_article 推送到书架；用户汇报听懂了多少分钟音频时，调用 log_listening 记录（支持浮点分钟如 0.5 表示 30 秒）。";

function errorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * 处理单条 JSON-RPC 2.0 消息。
 * 若为通知（无 id），返回 null（HTTP 层应返回 202 Accepted）。
 */
export async function handleMcpMessage(
  raw: unknown,
  executor: ToolExecutor,
): Promise<JsonRpcResponse | null> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return errorResponse(null, -32600, "Invalid Request");
  }

  const msg = raw as {
    jsonrpc?: unknown;
    id?: unknown;
    method?: unknown;
    params?: unknown;
  };

  const hasId = "id" in msg && msg.id !== undefined;
  const id =
    typeof msg.id === "string" || typeof msg.id === "number" || msg.id === null
      ? msg.id
      : null;

  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return errorResponse(id, -32600, "Invalid JSON-RPC 2.0 request");
  }

  // 通知消息（例如 notifications/initialized）：无需响应体
  if (!hasId) {
    return null;
  }

  const params =
    msg.params && typeof msg.params === "object" && !Array.isArray(msg.params)
      ? (msg.params as Record<string, unknown>)
      : {};

  switch (msg.method) {
    case "initialize": {
      const requested =
        typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(
        requested,
      )
        ? requested
        : DEFAULT_PROTOCOL_VERSION;
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions: SERVER_INSTRUCTIONS,
        },
      };
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: MCP_TOOLS } };

    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      if (!name || !MCP_TOOLS.some((t) => t.name === name)) {
        return errorResponse(id, -32602, `Unknown tool: ${name || "(empty)"}`);
      }
      const args =
        params.arguments &&
        typeof params.arguments === "object" &&
        !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};

      try {
        const res = await executor(name, args);
        if (!res.ok) {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [{ type: "text", text: res.error }],
              isError: true,
            },
          };
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }],
            isError: false,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : "工具执行失败";
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: message }],
            isError: true,
          },
        };
      }
    }

    default:
      return errorResponse(id, -32601, `Method not found: ${msg.method}`);
  }
}
