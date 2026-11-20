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
| `para_id` | TEXT | 选区所在段落 id（来自请求的 anchor.paragraphId） |
| `para_click_n` | INTEGER | 同一用户同一段落里的第几次讲解请求，含追问（统计段落窗口收益；写入时查同段已有事件数 +1） |

### 2.2 取数

- `streamExplain`（`ai.ts:565`）当前只产出文本块。给 `src/lib/providers.ts` 的流式调用增加 usage 回传（做卡的 `completeJson` 已有 `cacheHitTokens`，`providers.ts:286-342`，流式路径同款解析），经回调交给 `handleExplain`，在流结束后更新对应 `explain_events` 行。
- 失败/取消的请求不记（拿不到 usage）。
- 记录失败只写日志，绝不影响讲解（沿用 `logExplain` 的写法，`explain-handler.ts:121`）。

### 2.3 统计脚本

`scripts/prompt-cache-report.mjs`：读库，输出按 `layout`、`ask_kind`、`para_click_n`（1 / 2 / 3+）分组的：请求数、平均输入 token、命中率（Σ命中 / Σ输入）、折算成本（命中按 1/10）。输出 markdown 表，写入 `.verify/p57/`。

### 2.4 实现说明（已完成）

- 流式请求在 OpenAI 兼容分支加了 `stream_options: { include_usage: true }`，Claude 分支从 `message_start` / `message_delta` 取用量；统一由 `parseUsage`（`providers.ts`）解析，经 `onUsage` 回调交给 `handleExplain`，流**成功结束**后调用 `recordExplainUsage` 写库。
- 报告：`node scripts/prompt-cache-report.mjs [--db …] [--days 7]`，输出写到 `.verify/p57/report.md`。

### 2.5 验收

- 点一次词，库里有 token 数；取消请求不留脏数据；`prompt_cache_hit_tokens` 缺失时记 NULL，不记 0。
- 基线：先跑一周（或造一批请求）拿 v1 命中率，写进 `docs/design/P57-…` 的「基线」一节。

## 3. P57b 结构

### 3.1 新模块

`src/lib/prompt/`（纯函数，只用相对路径 import，前后端与单测共用，沿用 `history-compress.ts` 的约定）：

| 文件 | 导出 | 说明 |
|---|---|---|
| `layers.ts` | `buildL0()` / `buildL1(...)` / `buildL2(...)` / `buildL3(...)` / `buildTail(...)` / `assembleExplain(params): ChatTurn[]` | 每层是纯函数，输入只含该层依赖的数据 |
| `sentence-window.ts` | `sentenceWindowOf(paragraphs, paraIdx, start, end)` | 返回 `{ prev, sentence, next }` |
| `profile-split.ts` | `splitLearnerBlock(input)` → `{ stable, volatile }` | 拆分档案文本 |

`explainTurns`（`ai.ts:536`）在 `layout=v2` 时委托 `assembleExplain`；v1 保持原样，逐字不变（快照测试仍覆盖）。

### 3.2 各层输入与输出

| 层 | 输入（只能含这些） | 输出 |
|---|---|---|
| L0 | 无 | 常量字符串 |
| L1 | `teachingRules`、`stableProfile` | 固定模板；两者都为空则整层省略 |
| L2 | `title`、`category` | 固定模板；都为空则省略 |
| L3 | `sentenceWindow` | 固定模板；见 §3.3 |
| L4 | 历史 | 见 §3.5 |
| L5 | 变体、易变档案、选区、所在句、观察、问题、引用 | 见 §3.6 |

**不变量（单测要断言）**：
1. L0 在任何输入下相同。
2. L1 的字节只取决于 `teachingRules` 与 `stableProfile`；改 `volatile`、选区、问题，不变。
3. L2 只取决于标题与分类。
4. L3 只取决于段落原文（及网格规则），**与选区、点击顺序、askKind 无关**。
5. 改 L5 的任意输入，L0~L4 的拼接字节不变。
6. 变体开关（个性化、制卡、monolingual、domain、structure）只影响 L5。

### 3.3 句子窗口 `sentenceWindowOf`（2026-11-20 评审后取代原"段落窗口"）

```
输入：paragraphs[], paraIdx, start, end
输出：{ prev, sentence, next }   // 都是原文顺序
  prev      所在句之前约 150 词（整句，可跨到上一段；每句 ≤ 600 字符）
  sentence  选区所在句（跨句合并；≤ 1500 字符）
  next      同一段里紧接着的一句（段末则为空，不跨段；≤ 600 字符）
```

复用 `contextLayersOf` 求所在句与前文，只多加"同段后一句"；原先的网格切块与超长段落处理整体删除。阅读页与插件都经服务端 `sentenceWindowFor` 计算，保证同输入同输出。设计依据见设计文档 §3.5。

### 3.4 请求体与白名单

- `ExplainParams`（`ai.ts:66`）新增 `sentenceWindow?: { prev; sentence; next }`（服务端计算为准，客户端不传；回退用 `windowFromLayers`）。
- v2 时服务端优先用 `sentenceWindowFor` 的结果；缺失则按 v1 的 `contextLayers` 回退，不报错。
- 也可由服务端按 `textId + anchor` 自己算（更可信，且客户端传的值无法污染缓存）。**推荐**：服务端算，客户端只传 `textId`、`paragraphId`、`anchor`；`windowFromLayers` 作为兼容回退。落地时二选一，在评审时确认。

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

- `cards/generate.ts buildRun` 无缓存分支（`generate.ts:262` 附近）：目前传 `contextLayers: { sentence, nearContext: [] }`；后续可改为用 `sentenceWindowOf`（做卡上下文里已有 `paragraphOf(ctx)`，见 `cards/store.ts`），与讲解同一前缀。
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

### 3.10 P57b 实现说明（已完成，与上文的差异）

- **开关**：环境变量 `READFLOW_PROMPT_LAYOUT=v1|v2` 优先，其次站级设置行 `prompt.layout`（user_id=`local`），默认 v1；读取在每次请求时发生，改完立即生效。见 `src/lib/prompt/layout-flag.ts`（含一行 SQL）。
- **L0 不带深度变体（2026-11-20 修订）**：答案深度只有**一份**文字——「没有档案：按选区判断；有档案：按档案、反馈、观察判断」，写在 L0 里，有没有档案、个性化开不开，L0 都逐字相同。不再有"替代上文"。
- **领域视角是 L0 里的一节（2026-11-20 修订）**："从内容角度讲讲这句"的全文写在 L0 的【特殊问法】一节，写明只有最后一条消息以触发行「【本轮：从内容角度讲讲这句】」开头时才用，且那一轮上文的释义行、句子地图、答案深度、制卡建议都不适用；尾部只放这一行触发行。拆句方法仍在尾部。L0 因此变长（约 4.5k 字符），但全站共用、命中缓存。
- 制卡规则永远在 L0，关闭时尾部加一行"本次不要输出制卡建议行"。
- **档案拆分与设计稿不同**：「估计水平」依赖提问次数、会随每次提问变化，所以**放在易变段（尾部）**；稳定段只含身份、阅读目的、备考、讲解风格、老师笔记。`buildLearnerBlock` 新增 `part: "stable" | "volatile"`，不传则与原来逐字一致。
- **句子窗口（2026-11-20 评审后改）**：不再取整个段落。`sentenceWindowFor(userId, textId, anchor)`（只取该用户自己的文章）返回 `{ prev, sentence, next }`：前文约 150 词（可跨到上一段）、所在句、**同段**后一句（段末没有，不跨段）；每段有字符上限（所在句 1500，前文每句/后一句 600）。取不到则用客户端的两层上下文折成窗口（`windowFromLayers`，没有后一句）。原先的网格切块方案已删除。
- **做卡**：讲解缓存新增 `learnerBlock` 字段（v2 的档案分在两处，不能再从第一条 user 里抠）；无缓存命中的重算分支仍按 v1 拼（做卡命中缓存时直接复用讲解的 messages，不受影响）。
- **历史分块压缩**：`planHistory(input, budget, { blockSize })`；v2 用 3。阅读页界面的"更早的对话已压缩"提示仍按默认规则算，块内可能与服务端略有出入，只影响提示。
- **测试**：`tests/unit/prompt-layers.test.ts`（前缀不变量、窗口、档案拆分、历史分块）与 `scripts/e2e-prompt-layout.mjs`（假模型模拟前缀缓存，对比 v1/v2，13 项）。

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
| `prompt-layers.test.ts`（句子窗口部分） | 三段结构、同段后一句、段末无后一句不跨段、首段无前文、跨句选区、同句同窗口、无标点超长文本与单句超长受字符上限约束 |
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
| 整段上下文导致越界翻译 | L5 加"只讲所在句"；评测统计；不达标则去掉后一句（`sentenceWindowOf` 的 `next` 置空） |
| 变体移尾后遵循度下降 | T-D 与评测覆盖；必要时把关键变体指令重复一句在 L5 末尾 |
| 阅读页/插件窗口不一致 | 共用 `sentenceWindowFor` + T-F |
| 命中率提升不如预期 | 度量先行，按 `layout` 对比；v1 开关随时回退 |
| 站点开关误开 | 默认 v1；灰度按用户 id |

## 8. 文件清单（预计）

新增：`src/lib/prompt/{layers,sentence-window,l0-v2}.ts`、`scripts/prompt-cache-report.mjs`、`scripts/prompt-eval.mjs`、`tests/unit/prompt-*.test.ts`、`tests/fixtures/prompt-eval/`。

修改：`src/lib/ai.ts`、`src/lib/sentence.ts`、`src/lib/explain-handler.ts`、`src/lib/providers.ts`、`src/lib/learner-store.ts`、`src/lib/learner/profile-text.ts`、`src/lib/history-compress.ts`、`src/lib/extension-record.ts`、`src/lib/cards/generate.ts`、`src/components/Reader.tsx`、`src/db/ensure-auth.ts`（迁移）、`src/db/schema.ts`、设置项 `prompt.layout`。
