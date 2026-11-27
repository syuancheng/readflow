# PRD：ReadFlow MCP Server（跨 AI 客户端读写学习数据与个人英语档案）

| 项 | 内容 |
|---|---|
| 编号 | P61 |
| 状态 | 评审中（待确认后进入开发） |
| 关联模块 | `src/app/api/mcp/route.ts`、`src/lib/mcp/`、`src/lib/mcp-tokens.ts`、`src/components/SettingsDialog.tsx`、`src/db/schema.ts` |
| 依赖与衔接 | **P30**（插件 Token 哈希存储模式）、**P32/P34**（学习档案 `learner_profiles`）、**P60**（阅读词数与听力时长战绩）、文章导入管线 |
| 目标客户端 | 本地及开发者 AI 客户端优先（Claude Desktop、Cursor、Antigravity、Gemini CLI 等）；协议兼容未来扩展 OAuth 2.1 |

---

## 1. 背景与价值

用户在日常英语学习中会高频使用外部强 AI 客户端（Claude、ChatGPT、Gemini、Cursor 等）进行文章搜集、改写、答疑和复盘，但目前 ReadFlow 的所有读写操作都必须切回浏览器手动完成：

1. **听力记录有操作摩擦**：在 AI 里复盘完一段听力，还要专门打开 `/stats?tab=listening` 手动填表，容易漏记。
2. **文章导入链路长**：让 AI 生成、润色或改写好一篇英文文章后，还需手动复制 → 切回 ReadFlow → 粘贴导入。
3. **外部 AI 不了解用户的真实英语背景**：ReadFlow 已经沉淀了用户的 CEFR 水平、词汇量、备考目标、老师笔记、教学偏好、正在学的生词库以及阅读/听力战绩，但外部 AI 读不到这些上下文，导致改写文章难度不准、无法顺带复现生词。

通过提供标准的 **ReadFlow MCP Server**，可将 ReadFlow 升级为跨 AI 客户端共享的**个人英语学习数据底座**，跑通高价值闭环：
> 外部 AI 读取你的英语背景与生词 → 按你的 `i+1` 难度定制/改写英文文章并自然融入生词 → 一键推送至 ReadFlow 书架 → 精读完点「标记已读完」回流阅读词数；听完音频随口一句通过 AI 自动记入听力时长。

---

## 2. 目标与非目标

### 目标
1. **标准远程 MCP 端点（Streamable HTTP）**：在 ReadFlow 服务端直接暴露 `/api/mcp`，本地及开发者客户端无需安装额外本地脚本，配置 URL + Bearer Token 即可直接连接。
2. **首批 5 个高内聚 Tool**：覆盖「读背景（档案 / 战绩 / 生词）」与「写数据（记听力 / 导文章）」两大类核心场景。
3. **个人级 Token 管理 UI**：在设置弹窗中提供「MCP 接入」区块，支持生成、查看接入配置片段（一键复制 JSON）、查看最近使用时间及随时重置/吊销，严格按 `user.id` 隔离数据。
4. **复用现有业务口径**：导入文章复用现有分段、词数与 CEFR 评级逻辑；听力记录复用 P60 的浮点分钟校验与统计逻辑，确保数据 100% 一致。

### 非目标（本期不做）
- 不做 ChatGPT / Claude 网页端所需的完整 OAuth 2.1 动态注册授权流（留作 P61b 按需扩展）；
- 不做删除文章、删除生词、修改密码等高危破坏性操作；
- 不做音频文件上传或 TTS 生成（属 P59 范围）。

---

## 3. 协议与接入架构

### 3.1 传输协议
- 端点：`POST /api/mcp`（及按 MCP Streamable HTTP 规范处理 `GET`/`DELETE` 返回合理状态码，采用无状态 JSON-RPC 2.0 响应模式，适配 Next.js Route Handler 与 Nginx 反代）。
- 协议版本：兼容 MCP `2025-03-26` / `2024-11-05`，支持标准方法：
  - `initialize`
  - `notifications/initialized`
  - `ping`
  - `tools/list`
  - `tools/call`
- 鉴权方式：`Authorization: Bearer <token>`（同时兼容 `x-readflow-mcp-token` 备用头），无效或缺失返回 `401 Unauthorized`。

### 3.2 Token 安全设计（复用 P30 `extension_tokens` 模式）
- 新增 `mcp_tokens` 表（结构与 `extension_tokens` 对齐）：
  ```sql
  CREATE TABLE IF NOT EXISTS mcp_tokens (
    user_id      TEXT PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    token_hint   TEXT NOT NULL,     -- 末 4 位，便于识别
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER            -- 节流更新（每分钟最多写一次）
  );
  ```
- Token 格式：`rfm_` + 24 字节 `base64url` 随机串。
- 仅存 `sha256` 哈希，明文只在生成瞬间展示一次；重新生成立即覆盖旧哈希使旧 Token 失效；支持一键吊销。

### 3.3 客户端配置示例（设置页提供一键复制）
```json
{
  "mcpServers": {
    "readflow": {
      "url": "https://<你的域名>/api/mcp",
      "headers": {
        "Authorization": "Bearer rfm_xxxxxxxx"
      }
    }
  }
}
```

---

## 4. 首批 5 个 MCP Tool 详细定义

### 4.1 读类工具（3 个）

#### Tool 1：`get_learner_profile`
- **用途**：获取当前用户的英语学习背景知识，供 AI 了解用户水平、备考目标与偏好，用于定制文章难度、改写材料或规划学习。
- **输入参数**：无（`{}`）。
- **返回结构（JSON）**：
  - `level`：当前有效 CEFR 级别（优先用户手填覆盖 `levelOverrideCefr`，否则推断值）及估计词汇量；
  - `survey`：学习目标、备考考试（如托福/雅思）、兴趣领域、自评薄弱项；
  - `teacherNote`：ReadFlow 长期沉淀的「老师笔记」（AI 总结的学习特点与薄弱点）；
  - `teachingRules`：用户自定义的偏好规则（希望做 / 不要做）；
  - `recentReadingSummary`：近期常读分类与平均难度。

#### Tool 2：`get_learning_stats`
- **用途**：获取当前用户的阅读词数与听力时长战绩，供 AI 复盘进度、给出反馈或制定今日任务。
- **输入参数**：
  - `dimension`（可选，`"all" | "reading" | "listening"`，默认 `"all"`）
- **返回结构（JSON）**：
  - `reading`：`todayWords`、`weekWords`、`monthWords`、`totalWords`、`completedCount`、`streakDays`、`bestStreak`、最近 5 篇已完读文章（标题、词数、CEFR、完读日期）；
  - `listening`：`todayMinutes`、`weekMinutes`、`monthMinutes`、`totalMinutes`、`logCount`、`streakDays`、`bestStreak`、最近 5 条听力记录。

#### Tool 3：`list_learning_words`
- **用途**：获取用户正在学习或星标的生词列表，方便 AI 在改写/创作英文文章或例句时自然复现这些词汇。
- **输入参数**：
  - `status`（可选，`"learning" | "learned" | "all"`，默认 `"learning"`）
  - `starredOnly`（可选，`boolean`，默认 `false`）
  - `limit`（可选，`number`，范围 `1–100`，默认 `30`）
- **返回结构（JSON）**：
  - `total`：符合条件的总数；
  - `words`：数组，每项含 `lemma`、`displayForm`、`pos`、`translation`、`starred`、`isPhrase`、`createdAt`。

---

### 4.2 写类工具（2 个）

#### Tool 4：`log_listening`
- **用途**：通过自然语言对话直接记录听力有效净时长（支持浮点数，如 `0.5` 表示 30 秒）。
- **输入参数**：
  - `minutes`（必填，`number`，`0.1 <= minutes <= 600`，支持浮点数）
  - `mode`（可选，`"intensive" | "extensive"`，默认 `"intensive"`）
  - `logDate`（可选，`YYYY-MM-DD`，默认服务端本地今天，不可晚于今天）
  - `note`（可选，`string`，材料名或主题，最长 200 字）
- **返回结构（JSON）**：
  - `log`：刚写入的记录详情（`id`、`logDate`、`minutes`、`mode`、`note`）；
  - `summary`：更新后的今日听懂时长、本月听懂时长、累计听懂时长与连续听力天数（方便 AI 在回复中直接给用户即时正向反馈）。

#### Tool 5：`import_article`
- **用途**：将英文文章直接上传到用户的 ReadFlow 书架，支持传入正文（如 AI 改写或生成的文章）或网页 URL。
- **输入参数**：
  - `title`（选填，`string`，正文导入时若不传则自动从首行/标题提取，最长 200 字）
  - `content`（与 `url` 二选一，`string`，支持纯文本或 Markdown 正文）
  - `url`（与 `content` 二选一，`string`，合法 `http/https` 链接，走 ReadFlow 现有网页抓取与正文提取管线）
  - `category`（选填，`string`，如 `新闻` / `技术文档` / `博客` / `论文` / `文学` / `教程` / `其他`，最长 30 字）
- **返回结构（JSON）**：
  - `id`：文章 ID；
  - `title`：最终标题；
  - `wordCount`：统计词数；
  - `cefrLevel`：自动粗估的 CEFR 难度（如 `B2`，若无法评估为 `null`）；
  - `category`：分类；
  - `readUrl`：相对路径 `/texts/<id>`（以及若配置了站点域名则附完整可点击链接）。

---

## 5. 设置页 UI 规范（强制遵循 `docs/design-system.md`）

在现有设置弹窗（`SettingsDialog.tsx`）的账号/插件接入区域下方，新增轻量 **「MCP 接入」** 区块：
- **不嵌套多余灰框**：用 1px `--rf-border` 分隔线区分区块，严格左对齐；
- **状态展示**：
  - 未生成态：一行简短说明（「连接 Claude Desktop、Cursor、Antigravity 等 AI 客户端，通过对话记录听力、导入文章与读取学习档案」）+ 「生成 MCP Token」中性按钮；
  - 已生成态：显示 `已启用（尾号 ····XXXX）` + 最近使用时间 + 「重新生成」/「吊销」轻量操作；
  - 生成瞬间：一次性展示明文 Token 与可直接粘贴的 JSON 配置片段，附「复制配置」按钮及「关闭后将不再显示明文」温和提示；
- **令牌约束**：严格通过 `npm run check:tokens`（零裸 hex、零紫色、禁用 `font-medium`/`font-black`、间距为 4px 阶梯）。

---

## 6. 边界规则与安全考量

1. **严格多账号隔离**：所有 Tool 执行前必须通过 Bearer Token 解析出唯一 `AuthUser`，所有读写查询强制携带 `userId = user.id`。
2. **输入大小与防滥用**：
   - `import_article` 限制正文长度上限（与现有网页导入上限保持一致），URL 抓取复用现有 SSRF 防护与超时控制；
   - `log_listening` 复用 `src/lib/listening.ts` 的 `validateListeningInput`，保证与网页端规则完全一致。
3. **错误友好**：参数错误时按 MCP 规范返回 `isError: true` 与清晰中文/结构化错误原因，方便 AI 自动修正参数重试。
4. **Nginx 兼容**：`/api/mcp` 走标准 JSON POST 响应，无需长连接 SSE，天然兼容现有 Nginx 配置，无需改动服务器基础设施。

---

## 7. 验收标准（Definition of Done）

1. **协议连通**：使用 `curl` 或真实 MCP 客户端（Cursor / Claude Desktop / Antigravity）连接 `POST /api/mcp`，`initialize`、`tools/list`、`tools/call` 均正常响应；无 Token 或错误 Token 返回 `401`。
2. **读能力闭环**：调用 `get_learner_profile`、`get_learning_stats`、`list_learning_words` 返回当前登录账号真实数据，且不包含其他账号数据。
3. **写能力闭环**：
   - 调用 `log_listening({ minutes: 0.5, note: "30秒精听" })` 后，刷新 `/stats?tab=listening` 立即看到 `+0.5 分钟` 且统计一致；
   - 调用 `import_article({ title: "...", content: "..." })` 后，刷新 ReadFlow 书架立即出现该文章并带有正确词数与 CEFR 评级。
4. **Token 生命周期**：设置页生成 Token、一键复制配置、重新生成后旧 Token 立即返回 `401`、吊销后立即失效。
5. **工程验收**：`npm run check:tokens`、`npm run typecheck`、`npm test` 全部通过（需补齐 MCP Token 生命周期、JSON-RPC 协议分发与 5 个 Tool 的单元测试）。
