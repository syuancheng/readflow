# P45 实现说明：追问上下文压缩

需求见 `docs/prd/P45-history-compression.md`。不改数据库、不改接口格式、不改提示词（只在历史前加一句省略说明）。

## 1. 代码
- `src/lib/history-compress.ts`（新，纯函数，只用相对路径 import）
  - 常量：`HISTORY_RECENT_TURNS=3`、`HISTORY_FULL_MAX_CHARS=2000`、`HISTORY_DIGEST_MAX_CHARS=300`、`HISTORY_BUDGET_TOKENS=6000`、`HISTORY_RECENT_FLOOR_CHARS=1200`、`HISTORY_PINNED_FLOOR_CHARS=800`、`HISTORY_ASK_MAX_CHARS=60`。
  - `estimateTokens`（中文 ×1.5，其余 ÷4）、`cleanAnswer`（去制卡建议行与含两个以上 `==` 的句子地图行；全被清掉则退回原文）、`clipMiddle`（超长从中间截，恰好 max 字）、`digestOf`（取开头两行，超长加「…」）。
  - `planHistory(turns, budget)` → `{ tiers, turns, omitted }`；`tiers` 是每轮的档位（`pinned` / `full` / `digest` / `dropped`）。档位按位置定；预算循环的顺序是：丢最早的 `digest` → 缩短最早的 `full` 到 1200 字 → 缩短首轮到 800 字 → 停（已到底）。
  - `firstCompressedIndex(tiers)`：界面用，第一条被压缩的下标。
- `src/lib/ai.ts`：`narrowHistory` 的收包上限放宽为 30 轮 / 每条 4000 字（只防请求体过大）；`historyTurns` 改为先 `planHistory`；有 `omitted` 时在最前加一条 `system`：「（这处批注上更早的 N 轮对话已省略，下面只保留了要点和最近的几轮。）」；新增 `EXPLAIN_PROMPT_MAX_CHARS`。轮数不超过「1 + 最近 3」时，内容与原来逐字一致。
- `src/lib/explain-handler.ts`：`prompt` 截断到 500 字。
- `src/lib/ask-presets.ts`：导出 `ASK_MAX_CHARS = 500`（前后端共用）。
- `src/components/Reader.tsx`：用同一个 `planHistory` 算出被压缩的轮次，在 `ChatTurn` 前渲染 `.rf-compress-note`（`role="note"`）；`AskComposer.tsx` 的输入框加 `maxLength`。
- `src/styles/p44-chat.css`：`.rf-compress-note`（12px、次要灰，左对齐，沿用令牌；不新增色值、字号）。

## 2. 测试
- 单测：`tests/unit/history-compress.test.ts`（估算、清理、从中间截、要点、三档、位置固定则前缀不变、超预算的丢弃顺序与到底行为、空输入）；`tests/unit/ai-history.test.ts` 更新为新语义（要点前缀、省略说明、单条 2000 字）。
- E2E：`e2e-chat-panel.mjs` C9b（短对话无提示、输入框 500 字）、C18b（超过 4 轮后出现提示，位置在首次讲解之后、最近 3 轮之前）。

## 3. 设计说明（界面）
只新增一行淡色小字，没有新颜色、字号、边框。中心点仍是最新回答；提示是附属信息（12px、次要灰），和气泡 / 回答间距沿用轮间 24px；左对齐，落在主对齐线上。无例外。
