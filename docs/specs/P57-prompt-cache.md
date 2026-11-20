# P57 实现规格：讲解提示词分层与前缀缓存

> 配套设计：[docs/design/P57-PROMPT-CACHE-DESIGN.md](../design/P57-PROMPT-CACHE-DESIGN.md)　状态：待评审　模型：DeepSeek（自动前缀缓存）

## 1. 范围与分期

| 期 | 范围 | 改动类型 |
|---|---|---|
| P57a | 讲解请求记录 token 与命中数；基线统计脚本 | 只加记录，提示词与请求完全不变 |
| P57b | 分层 L0~L5；变体移尾；段落窗口；稳定/易变档案拆分；L4 分块压缩；站点开关 | 结构变，文字不变 |
| P57c | 提示词去重、统一口径、加例子；评测集与回归脚本 | 行为变，需评测 |
| P57d | 历史逐字重放（可选） | 存储 + 小行为改动 |

每期独立上线、独立可回滚；P57b 起由站点开关 `prompt.layout = v1 | v2` 控制（默认 v1，灰度后切 v2），两套并存直到评测通过。

## 2. P57a 度量

### 2.1 数据

`explain_events` 新增列（`ensure-auth.ts:100` 附近用 `addColumnIfMissing`，与 `feedback_reason` 同款迁移）：

| 列 | 类型 | 说明 |
|---|---|---|
| `prompt_tokens` | INTEGER | 本次输入 token |
| `cache_hit_tokens` | INTEGER | 命中 token（DeepSeek `prompt_cache_hit_tokens`，OpenAI 兼容 `prompt_tokens_details.cached_tokens`） |
| `completion_tokens` | INTEGER | 输出 token |
| `layout` | TEXT | `v1`/`v2`，对比两套用 |
| `para_click_n` | INTEGER | 同一用户同一段落里的第几次讲解请求（统计段落窗口收益；写入时查同段已有事件数） |

### 2.2 取数

- `streamExplain`（`ai.ts:565`）当前只产出文本块。给 `src/lib/providers.ts` 的流式调用增加 usage 回传（做卡的 `completeJson` 已有 `cacheHitTokens`，`providers.ts:286-342`，流式路径同款解析），经回调交给 `handleExplain`，在流结束后更新对应 `explain_events` 行。
- 失败/取消的请求不记（拿不到 usage）。
- 记录失败只写日志，绝不影响讲解（沿用 `logExplain` 的写法，`explain-handler.ts:121`）。

### 2.3 统计脚本

`scripts/prompt-cache-report.mjs`：读库，输出按 `layout`、`ask_kind`、`para_click_n`（1 / 2 / 3+）分组的：请求数、平均输入 token、命中率（Σ命中 / Σ输入）、折算成本（命中按 1/10）。输出 markdown 表，写入 `.verify/p57/`。

### 2.4 验收

- 点一次词，库里有 token 数；取消请求不留脏数据；`prompt_cache_hit_tokens` 缺失时记 NULL，不记 0。
- 基线：先跑一周（或造一批请求）拿 v1 命中率，写进 `docs/design/P57-…` 的「基线」一节。

## 3. P57b 结构

### 3.1 新模块

`src/lib/prompt/`（纯函数，只用相对路径 import，前后端与单测共用，沿用 `history-compress.ts` 的约定）：

| 文件 | 导出 | 说明 |
|---|---|---|
| `layers.ts` | `buildL0()` / `buildL1(...)` / `buildL2(...)` / `buildL3(...)` / `buildTail(...)` / `assembleExplain(params): ChatTurn[]` | 每层是纯函数，输入只含该层依赖的数据 |
| `paragraph-window.ts` | `paragraphWindowOf(paragraphs, paraIdx, start, end)` | 返回 `{ prevTail: string, body: string, sentence: string }` |
| `profile-split.ts` | `splitLearnerBlock(input)` → `{ stable, volatile }` | 拆分档案文本 |

`explainTurns`（`ai.ts:536`）在 `layout=v2` 时委托 `assembleExplain`；v1 保持原样，逐字不变（快照测试仍覆盖）。

### 3.2 各层输入与输出

| 层 | 输入（只能含这些） | 输出 |
|---|---|---|
| L0 | 无 | 常量字符串 |
| L1 | `teachingRules`、`stableProfile` | 固定模板；两者都为空则整层省略 |
| L2 | `title`、`category` | 固定模板；都为空则省略 |
| L3 | `paragraphWindow` | 固定模板；见 §3.3 |
| L4 | 历史 | 见 §3.5 |
| L5 | 变体、易变档案、选区、所在句、观察、问题、引用 | 见 §3.6 |

**不变量（单测要断言）**：
1. L0 在任何输入下相同。
2. L1 的字节只取决于 `teachingRules` 与 `stableProfile`；改 `volatile`、选区、问题，不变。
3. L2 只取决于标题与分类。
4. L3 只取决于段落原文（及网格规则），**与选区、点击顺序、askKind 无关**。
5. 改 L5 的任意输入，L0~L4 的拼接字节不变。
6. 变体开关（个性化、制卡、monolingual、domain、structure）只影响 L5。

### 3.3 段落窗口 `paragraphWindowOf`

```
输入：paragraphs[], paraIdx, start, end
输出：
  prevTail   前面各段末尾约 150 词（整句，原文顺序；沿用 NEAR_CONTEXT_MAX_WORDS）
  body       当前段落（≤ 300 词整段；> 300 词按固定网格取块）
  sentence   选区所在句（跨句选区合并，沿用 contextLayersOf 的逻辑）
```

- 网格：从段首起，按句子累加到约 120 词为一块；块号只由段落原文决定。取"含所在句的块"加"相邻后一块"（如存在）。
- 标题段、代码块、表格段：`body` 只含本段，不取后文；`prevTail` 照常。
- 复用：把 `contextLayersOf`（`sentence.ts:166`）里的 `splitSentences`、`wordsOf`、`NEAR_CONTEXT_MAX_WORDS` 提出来共用；旧函数保留（v1 与单测还在用）。
- 阅读页（`Reader.tsx` 约 1516 行）与插件（`extension-record.ts:80-91`）都改调 `paragraphWindowOf`，保证同段同输出。

### 3.4 请求体与白名单

- `ExplainParams`（`ai.ts:66`）新增 `paragraphWindow?: { prevTail: string; body: string; sentence: string }`；`narrowParagraphWindow` 白名单校验（长度上限：prevTail 2000、body 4000、sentence 1000 字符，与 `narrowContextLayers` 同款，`ai.ts:246`）。
- v2 时服务端优先用 `paragraphWindow`；缺失则按 v1 的 `contextLayers` 回退，不报错。
- 也可由服务端按 `textId + anchor` 自己算（更可信，且客户端传的值无法污染缓存）。**推荐**：服务端算，客户端只传 `textId`、`paragraphId`、`anchor`；`paragraphWindow` 字段作为兼容回退。落地时二选一，在评审时确认。

### 3.5 L4 历史分块压缩

在 `history-compress.ts` 的 `planHistory` 之上改：

- 现状：最近 `HISTORY_RECENT_TURNS = 3` 轮完整，更早压成要点。每多一轮，最老的"近期"一轮翻转为要点。
- 改为：以 `BLOCK = 3` 为单位。第 `n` 轮时，轮次序号 `k` 的完整/要点状态由 `floor((n - 1) / BLOCK)` 决定，**状态只在 n 跨过块边界时变化一次**，而不是每轮变。
- 首次讲解仍然钉住完整。
- 历史条目格式：user = `学生的问题: …`（确定性），assistant = 去掉制卡建议行和句子地图行后的文本（规则不变）。
- 总预算兜底规则不变。

### 3.6 L5 尾部模板

固定顺序（缺项则整行省略，不留空行）：

```
[变体指令]        制卡关闭 / monolingual / 拆句方法 / 领域视角
[易变学习信息]    最近评价、统计
所在句: "…"
用户选中: "…"
观察（客观信号，不是结论）：…
学生的问题: …
[引用]
```

- 拆句方法与领域视角由原 `buildSentenceStructureMethodPrompt`（`ai.ts:222`）与 `buildDomainSystemPrompt`（`ai.ts:177`）的文字改写为尾部指令块；领域视角不再整套换人设，沿用原有"不写释义行、250 字内"等约束。
- 取消"领域人设替换 system"后，必须验证领域回答不再出现「释义：」行（见 §7 T-D）。

### 3.7 做卡与插件

- `cards/generate.ts buildRun` 无缓存分支（`generate.ts:262` 附近）：目前传 `contextLayers: { sentence, nearContext: [] }`；改为用 `paragraphWindowOf`（做卡上下文里已有 `paragraphOf(ctx)`，见 `cards/store.ts`），与讲解同一前缀。
- 命中缓存分支：复用 `cached.messages`，不变。
- `learnerBlockOfMessages`（`generate.ts`）从缓存 messages 里取学习档案的方式随之调整（档案拆成 L1 稳定段 + L5 易变段）。

### 3.8 学习档案拆分

`learnerBlockFor`（`learner-store.ts:197`）返回增加 `stable` 与 `volatile`（`block` 保留给 v1）：

| 段 | 内容 |
|---|---|
| stable | 身份、考试及分数段、阅读目的、讲解风格偏好、等级、长期老师笔记 |
| volatile | 最近评价（太浅/刚好/太深）、统计数字（`recent-feedback.ts`、`stats`） |

`buildLearnerBlock`（`learner/profile-text.ts`）拆成两个纯函数；v1 仍用合并版，保证快照不变。

### 3.9 站点开关

- `settings` 站级行 `prompt.layout`，默认 `v1`；`handleExplain` 读取（沿用 `siteCardsSettings` 的读法，`explain-handler.ts` 里的 `cardsOn`）。
- 账号级灰度：可按用户 id 取模，先对 owner 账号开启，看度量再放量。

## 4. P57c 内容改写

- 独立文件 `src/lib/prompt/l0-v2.ts`，v1 的 `legacySystemPrompt` 不动。
- 改动清单：见设计文档 §6。
- 评测集 `tests/fixtures/prompt-eval/`：从库里脱敏抽 40~60 条真实问答（选区、所在句、askKind、旧回答、反馈），覆盖：单词、短语、整句、被动、倒装、长句、领域、拆句、追问。
- 评测脚本 `scripts/prompt-eval.mjs`：新旧 L0 各跑一遍（用真实模型，带 `--dry` 只打印请求），输出：
  - 协议合格率：首行以「释义：」开头；地图行 `==成分：…==` 成对；末行「制卡建议：」格式（`splitCardSuggestion` 能解析）。
  - 越界翻译率：用规则 + 抽样人工看（回答里出现未选中句子的整句译文）。
  - 平均输出长度。
  - 需要人工对照的并排表（写 `.verify/p57/eval.md`），由用户盲评。
- 通过线：协议合格率 ≥ v1；越界翻译率 ≤ v1；人工盲评不劣于 v1。

## 5. P57d 历史重放（可选）

- `explain_answers` 增加 `sent_user_message TEXT`、`raw_text TEXT`（`saveAnswer` 里写入）。
- 追问请求只传 answer id 列表，服务端按序重放"当时实际发出的 user + 原始 assistant"，历史字节与上一轮完全一致。
- 冲突：历史里的制卡建议行/句子地图行不再去掉（否则字节不同），token 稍增；是否值得，看 P57b 后 L4 的实测命中率与历史占比再决定。

## 6. 测试矩阵

### 6.1 单测（`tests/unit/`）

| 用例 | 断言 |
|---|---|
| `prompt-layers.test.ts` | §3.2 的 6 条不变量；开关组合（个性化 × 制卡 × monolingual × domain × structure）下 L0~L4 字节不变，只有 L5 变 |
| `paragraph-window.test.ts` | 整段、超长段落网格切块（同块内不同句输出相同）、标题/代码块不取后文、首段无前文、末段无后文、跨段前文取整句、中文/混排分句 |
| `profile-split.test.ts` | stable 与 volatile 不重叠；合并后与 v1 `buildLearnerBlock` 的信息集一致 |
| `history-compress.test.ts`（更新） | 分块压缩：第 4、5、6 轮的历史前缀逐字相同，只在跨块边界时变；首次讲解钉住 |
| `explain-turns-v2.test.ts` | v2 的 messages 结构；v1 快照不变；v2 对"同段不同词"产生相同的前 N 条 messages |
| `explain-usage.test.ts` | usage 解析：DeepSeek 与 OpenAI 兼容两种字段；缺失记 NULL |

### 6.2 e2e（Playwright，沿用 `scripts/e2e-*.mjs` 隔离库的做法）

| 用例 | 步骤 |
|---|---|
| T-A 命中梯度 | 用假的流式模型服务器按请求内容哈希回放命中数（模拟前缀缓存）；同段点两个词，第二次命中 ≥ L0~L3 前缀 |
| T-B 开关不破前缀 | 同一条批注里切个性化/制卡开关再点，L0~L3 仍然命中（对比 v1 为零命中） |
| T-C 拆句不破前缀 | 先问"整句没看懂"，再点"讲讲句子结构"，L0~L4 命中 |
| T-D 领域路径 | 点"从内容角度讲讲"，回答里不出现「释义：」行；请求前缀与默认讲解相同 |
| T-E 回退 | `prompt.layout=v1` 时请求与改前逐字相同 |
| T-F 插件 | 插件记录同一段落得到与阅读页相同的 L3 |

### 6.3 回归

`npm test`、`scripts/check-tokens.mjs`、`e2e-ask-thread`、`e2e-chat-panel`、`e2e-card-toast`、`e2e-inline-gloss`、`e2e-cards-ui`（做卡命中缓存分支）全过；v1 提示词快照一字不变。

## 7. 风险与回滚

| 风险 | 回滚/缓解 |
|---|---|
| 整段上下文导致越界翻译 | L5 加"只讲所在句"；评测统计；不达标则把 `body` 退成"所在句 + 前后各一句"（`paragraphWindowOf` 内一个参数） |
| 变体移尾后遵循度下降 | T-D 与评测覆盖；必要时把关键变体指令重复一句在 L5 末尾 |
| 阅读页/插件窗口不一致 | 共用 `paragraphWindowOf` + T-F |
| 命中率提升不如预期 | 度量先行，按 `layout` 对比；v1 开关随时回退 |
| 站点开关误开 | 默认 v1；灰度按用户 id |

## 8. 文件清单（预计）

新增：`src/lib/prompt/{layers,paragraph-window,profile-split,l0-v2}.ts`、`scripts/prompt-cache-report.mjs`、`scripts/prompt-eval.mjs`、`tests/unit/prompt-*.test.ts`、`tests/fixtures/prompt-eval/`。

修改：`src/lib/ai.ts`、`src/lib/sentence.ts`、`src/lib/explain-handler.ts`、`src/lib/providers.ts`、`src/lib/learner-store.ts`、`src/lib/learner/profile-text.ts`、`src/lib/history-compress.ts`、`src/lib/extension-record.ts`、`src/lib/cards/generate.ts`、`src/components/Reader.tsx`、`src/db/ensure-auth.ts`（迁移）、`src/db/schema.ts`、设置项 `prompt.layout`。
