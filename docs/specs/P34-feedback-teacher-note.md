# P34 实现说明：讲解反馈直接进讲解 + 每晚整理老师笔记

| 项 | 内容 |
|---|---|
| 对应 PRD | `docs/prd/P34-feedback-teacher-note.md`（F1–F6；Q1–Q10 已确认，数值实现成常量） |
| 依赖 | P32 个性化讲解、P33 讲解末尾「制卡建议」行；数据现状见 `docs/DATABASE.md` |
| 前端设计规范 | **《写给大家看的设计书》前端强制规范**（技能 `non-designer-frontend`，141 条规则，编号如 `P-04`、`C-01`）＋ 项目自己的 `docs/design-system.md`。两者冲突时按 §8.9 例外登记表执行 |

---

## 0. 硬性约束（任何一条不满足都不算完成）

### 0.1 代码与框架
- 先读 `AGENTS.md`：本项目是 Next.js 16。本说明用到的 `src/instrumentation.ts` 以 `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/instrumentation.md` 为准：`register()` 在每个服务实例启动时调用一次，必须先完成才开始处理请求。
- `route.ts` 只导出 HTTP 方法和 `runtime` / `dynamic`；共用逻辑放 `src/lib/`。
- 每个接口在服务端确认身份（网站 `currentUser()`，插件 `requireExtensionUser()`），所有读写校验数据属于当前用户。
- 不新增 npm 依赖；不删除已有的表和字段，只新增。

### 0.2 前端设计规范（必须满足，验收见 §8）
本期所有**新增和改动的界面**必须满足 `non-designer-frontend` 技能的五道门槛，缺一项不得宣称完成：

1. **先读规则**：写界面代码前，读技能的 `references/book-rules-full.md`、`principles-frontend.md`、`color-frontend.md`、`typography-frontend.md`、`page-playbooks.md`。
2. **设计简报**：按 §8.1–§8.8 实现；交付时把简报连同验收结论保存为 `docs/design/P34-DESIGN.md`。
3. **只用令牌**：颜色、字号、字重、间距、圆角只用 `src/styles/tokens.css` 的变量（项目的令牌唯一来源，等价于技能的 `assets/design-tokens.css`）；`npm test` 第一步的 `scripts/check-tokens.mjs` 必须通过。
4. **自动检查**：对本期新增 / 改动的界面源文件运行技能的 `scripts/check_design.py`，`HARD = 0`（范围见 §8.10）。
5. **人工验收**：逐条填写技能 `references/acceptance-checklist.md` 的 A–K 全部行与例外登记表，附在 `docs/design/P34-DESIGN.md`。任何一行留空不得交付。

### 0.3 测试
- 新增纯函数要单测，并纳入 `npm run test:coverage`（行 ≥ 90%、分支 ≥ 85%、函数 ≥ 90%）。
- 单测已用 `DB_PATH=.unit/unit-test.db` 隔离，**不得碰 `data/readflow.db`**。
- 端到端用隔离库 + 临时端口 + 假模型。
- 回归：`npm test`、`npm run test:coverage`、空库构建、`test:word-library`、`test:invite`、`test:account`、`test:extension`、`e2e-personalized`、`e2e-cards`、`e2e-cards-ui` 全部通过，无残留进程。

---

## 1. 数据模型

全部在启动时幂等创建。新增 `src/db/ensure-answers.ts`，在 `ensure-auth.ts` 里调用（与 `ensure-usage.ts` 同样做法）。

### 1.1 新表 `explain_answers`：每段回答的原文（F1）

```sql
CREATE TABLE IF NOT EXISTS explain_answers (
  event_id    TEXT PRIMARY KEY REFERENCES explain_events(id) ON DELETE CASCADE, -- 就是 answerId
  user_id     TEXT NOT NULL,
  context_id  TEXT,                 -- 对应批注；可能晚于回答写入（见 §2.2）
  ask_label   TEXT,                 -- 前端显示的「你问：…」标题；默认讲解为 NULL
  answer_text TEXT NOT NULL,        -- 完整回答原文（含末尾「制卡建议：」行，用时再拆）
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_explain_answers_context ON explain_answers(context_id, created_at);
CREATE INDEX IF NOT EXISTS idx_explain_answers_user ON explain_answers(user_id, created_at);
```

- 只在讲解**完整结束**（`handleExplain` 里 `streamDone === true`）时写入；失败、被中止的不写。
- `ask_label`：前端在讲解请求里多传 `askLabel`（白名单：字符串、去首尾空白、截到 60 字）。

### 1.2 `learner_profiles` 新增一列

| 列 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `note_update_kind` | TEXT | NULL | 最近一次笔记的来源：`nightly`（每晚整理）/ `user`（用户手改）。老数据为 NULL，界面按「更新于 …」显示 |

用 `addColumnIfMissing` 加列。

### 1.3 站级设置

| key（`settings`，`user_id = 'local'`） | 值 | 说明 |
|---|---|---|
| `learner.nightlyRunDay` | `2026-11-14` | 每晚整理最近一次**完成**的日期（北京时间），防止同一天做两次 |

### 1.4 清理规则
- 删除一个词时（`/api/words/[id]` 的事务）：额外删除 `context_id` 属于这个词的批注的 `explain_answers` 行。
- 「清空 AI 记忆」：不删数据，但最近反馈与笔记只取 `created_at > memory_reset_at` 的记录（与 `loadEvents` 同口径）。
- 过期删除（讲解记录 30 天、查词记录 90 天）见 §4.5。

---

## 2. F1：存回答原文，并对上批注

### 2.1 服务端（`src/lib/explain-handler.ts`）
- 讲解流正常结束后，在写讲解缓存的同一位置（`streamDone && answerId`）插入一行 `explain_answers`。写入失败只记日志，绝不影响讲解。
- 同时补全这条讲解事件的 `lemma`（`src/lib/dict.ts` 的 `lemma(word)`）和 `text_id`（请求里的 `textId`，经归属校验）。现在这两列对讲解事件全为空。

### 2.2 讲解记录对上批注（修复：本机 16 条讲解只有 2 条带批注 id）
原因：阅读页查词时，`/api/contexts/ensure`（保存批注）和自动讲解几乎同时发出；自动讲解在 `PickCard` 的词典回调里触发，闭包里的 `pick` 还没有 `contextId`。三处修复，任一处成功即可对上：
1. **前端**：`PickCard` 用 `contextIdRef` 保存最新的 `pick.contextId`，`triggerAI` 从 ref 读。讲解请求总是带上锚点 `{ textId, paragraphId, start, end }`。
2. **讲解结束时兜底**：请求里没有 `contextId` 时，按 `(user_id, text_id, paragraph_id, start, end)` 在 `contexts` 里查，查到就写进讲解事件和回答。查不到不报错。
3. **保存批注时兜底**：`/api/contexts/ensure` 成功后，把同一用户、同一锚点、`context_id` 为空、10 分钟内的讲解事件和回答补上 `context_id`。

---

## 3. F2：三种反馈各取最近一次，直接进讲解

### 3.1 常量（`src/lib/learner/recent-feedback.ts`，纯函数模块）

| 常量 | 值 | 说明 |
|---|---|---|
| `RECENT_FEEDBACK_KINDS` | `["shallow", "right", "deep"]` | 每种评价各取最近一次，最多 3 行（PRD Q5） |
| `RECENT_FEEDBACK_FOR_PROFILE` | 3 | 最近 30 天有几次反馈就算「有可依据的档案」 |
| `RECENT_FEEDBACK_DAYS` | 30 | 只用 30 天内的反馈（与讲解记录保留期一致） |

### 3.2 取数（`src/lib/learner-store.ts`）
对 `shallow` / `right` / `deep` 各取一条：`explain_events` 中 `kind = 'explain'`、`user_id = ?`、`feedback = ?`、`created_at > memory_reset_at`、`feedback_at > now − RECENT_FEEDBACK_DAYS 天`，按 `feedback_at` 取最新一条。**不按文章过滤**（不带 `text_id` 条件），反馈可以来自任何文章；`LEFT JOIN explain_answers` 取回答原文与 `ask_label`。三条合在一起再按 `feedback_at` 从新到旧排序。某一种没有就少一行。用一条 SQL（窗口函数 `ROW_NUMBER() OVER (PARTITION BY feedback ORDER BY feedback_at DESC)`）或三条小查询均可。

### 3.3 讲解特征（纯函数 `answerTraits(text, askKind)`，单测）
从回答原文里直接判断，不调用 AI：
1. 先用 `splitCardSuggestion` 去掉末尾「制卡建议：」行，再去掉第一行「释义：…」。
2. `hasMap`：含句子地图的成分标注（`==成分：原文==` 形式）。
3. `hasWholeMeaning`：含「整句大意：」。
4. `hasExample`：`askKind === 'example'`，或正文含「例句」。
5. `length`：剩余文字中**中文说明**的字数（不计带 `==` 的地图行与英文原句），四舍五入到 10。

### 3.4 写成档案里的几行（纯函数 `formatRecentFeedback`，单测）
```
- 最近的反馈（三种评价各最近一次，从新到旧）：
  · 单词，自动讲解：约 180 字，画了句子地图 → 太深
  · 短语，这个词在句里的意思：约 60 字 → 刚好
  · 单词，只讲这个词 → 太浅          （老讲解没有回答原文：只写提问种类与评价）
```
- 单词 / 短语按 `is_phrase` 或选中文字是否含空格判断；提问种类用 `note.ts` 现有的 `ASK_LABEL`，有 `ask_label` 时优先用它（截到 12 字）。
- **不写出英文原词**（与老师笔记「不要列出具体单词」一致）。

### 3.5 放进学生档案（`src/lib/learner/profile-text.ts`）
- `buildLearnerBlock` 增加输入 `recentFeedback: string[]`（上面的几行），放在「以往反馈」之后、「老师笔记」之前。
- `LEARNER_BLOCK_MAX_CHARS` 600 → **720**（最近反馈最多 3 行，约 100–150 字）。超长时截短顺序：老师笔记 → 常见难点 → 以往反馈（统计）→ 最近的反馈（从最旧的一条开始整行去掉）。
- `hasUsableProfile` 增加条件：最近 30 天的反馈次数 ≥ `RECENT_FEEDBACK_FOR_PROFILE`（数次数，不是数行数）。
- `learnerBlockFor(userId)` 负责取数并传入。讲解缓存里存的是当时的完整对话，做卡复用缓存时自然带着这段内容，不需要改做卡代码。

### 3.6 讲解提示词（`src/lib/ai.ts`）
在个性化深度指引 `DEPTH_GUIDANCE_ZH` / `DEPTH_GUIDANCE_EN` 末尾各加一句（个性化关闭时的旧提示词不变，现有快照测试保持逐字一致）：
- 中文：「学生档案里的『最近的反馈』是学生对你最近几次讲解的评价，三种评价各一条：向被评『刚好』的那次讲法靠拢，避开被评『太深』那次的做法（例如句子地图、篇幅长），补上被评『太浅』那次缺的部分；最近的反馈与『以往反馈』统计不一致时，以最近的为准。」
- 英文：等义的一句。

---

## 4. F3：每晚整理老师笔记

### 4.1 调度器
- 新增 `src/instrumentation.ts`：`register()` 里仅当 `process.env.NEXT_RUNTIME === "nodejs"` 且不在构建阶段（`process.env.NEXT_PHASE !== "phase-production-build"`）时，动态 `import("./lib/nightly-note")` 并调用 `startNightlyScheduler()`。
- `startNightlyScheduler()`：启动后立即检查一次，之后每 10 分钟检查一次；进程内只启动一个（`globalThis` 标记，防开发模式热重载重复启动）。
- 纯函数 `nightlyDue(now, lastRunDay, hour)`（单测）：北京时间当前小时 ≥ `hour`，且 `lastRunDay` 不是今天 → 该跑。这同时覆盖「凌晨没开机、启动后补做」。
- 常量：`NIGHTLY_HOUR = 3`、`NIGHTLY_MIN_NEW_EVENTS = 10`、`EXPLAIN_RETENTION_DAYS = 30`、`EXPLAIN_RETENTION_MAX_DAYS = 90`、`LOOKUP_RETENTION_DAYS = 90`（PRD Q6 / Q7 / Q9）。测试可用环境变量 `READFLOW_NIGHTLY_HOUR`、`READFLOW_NIGHTLY_INTERVAL_MS` 覆盖。

### 4.2 一次整理的流程
1. 先做 §4.5 的过期删除。
2. 选出需要整理的用户（纯函数 `nightlyEligible`，单测）：个性化开启，且自上次笔记更新（`note_updated_at`，从没有笔记则从 `memory_reset_at`）以来，**新动静合计 ≥ `NIGHTLY_MIN_NEW_EVENTS`**。新动静 = 新的查词事件 + 新的讲解事件 + `feedback_at` 晚于上次更新的反馈（含改选）。不满 10 次的跳过，次数留到下次继续累计。
3. 逐个用户串行生成，用户之间间隔 2 秒；沿用 `note-generator.ts` 的 `running` 集合（同一用户同时只跑一个）、失败冷却（1 小时）。单个失败只记该用户的 `note_last_error`，不影响其他人。
4. 全部跑完（不论成败）写 `learner.nightlyRunDay = 今天`。进程中途退出则下次启动重跑，已成功的用户因条件不再满足而跳过。
5. 用站点模型，不调用 `consumeAiQuota`（与现在一致）。

### 4.3 提示词（纯函数 `buildNightlyNotePrompt`，单测）
- 沿用现有 `buildNotePrompt` 的结构（统计 → 最近提问摘要 → 旧笔记），增加「【带回答的反馈】」一节：这个用户**所有文章**里最近最多 30 组（不按文章过滤），每组写提问种类、单词 / 短语、`answerTraits` 的特征、回答开头 300 字（去掉建议行）、评价。
- 要求「完整重写，合并重复、去掉已经过时的判断」；仍遵守 300 字、不列英文单词、以统计为准、保留用户手改内容。
- 成功：`note`、`note_updated_at = now`、`note_update_kind = 'nightly'`、`note_user_edited = 0`。`note_lookup_cursor` 不再使用（保留列，不再写入）：过期删除会让「查词总数」变小，基于总数的游标不再可靠，新动静一律按时间计算。
- 用户在设置里手改笔记时写 `note_update_kind = 'user'`（`editNote`）。

### 4.4 移除旧触发
- 删除 `explain-handler.ts` 里的 `void maybeUpdateNote(user.id)`，以及 `shouldUpdateNote`（25 次 + 24 小时）和 `lookupCountSince` 的这两处用法。`maybeUpdateNote` 改为供每晚整理调用的 `generateNoteNow(userId, kind)`。
- `note-throttle.ts`：保留失败冷却；「每天最多 3 次」只约束同一天内的重试（每晚整理本身一天一次），常量不变。
- `GET /api/learner` 的 `noteReason`：去掉 `need_more_lookups`，改为 `{ waiting: N }`（N = 还差几次新动静才会在当晚整理，0 表示今晚会整理），设置页文案「再攒 N 次查词或反馈，当晚会整理」或「今晚会整理一次」。

### 4.5 过期删除（PRD F6）
保留期按用途定（PRD F6 的表）。每晚整理开始时执行一次，一个事务内完成，日志记录各删了多少行。纯函数 `retentionCutoffs(now)` 算出三个截止时间（单测）。

```sql
-- 讲解记录：超过 30 天且已被整理进老师笔记的
DELETE FROM explain_events
 WHERE kind = 'explain' AND created_at < :explainCutoff            -- now − 30 天
   AND created_at < (SELECT COALESCE(note_updated_at, 0) FROM learner_profiles p WHERE p.user_id = explain_events.user_id);
-- 讲解记录：无论是否整理过，超过 90 天的（防止个性化关闭、从不整理的账号一直积累）
DELETE FROM explain_events WHERE kind = 'explain' AND created_at < :explainMaxCutoff;  -- now − 90 天
-- 查词记录：超过 90 天的（与 P32 行为推断的 90 天窗口一致）
DELETE FROM explain_events WHERE kind = 'lookup' AND created_at < :lookupCutoff;       -- now − 90 天
```

- `explain_answers` 通过外键 `ON DELETE CASCADE` 一起删除（连接已开 `foreign_keys = ON`）；再加一条「`event_id` 不在 `explain_events` 里」的兜底删除，防外键未生效。
- 不删批注（`contexts`）、词库、文章、卡片。
- 影响核对：
  - 行为推断（P32）只读 90 天内的查词，不受影响；它统计的反馈次数随讲解记录变为约 30 天，「以往反馈」统计行随之覆盖约 30 天。
  - 老师笔记按时间计算新动静（§4.3），不依赖总数。
  - 回看时被删掉讲解记录的段落配不上 `answerId`，不显示反馈行。
  - 「已做过卡又查过」（P33 F7，阶段三）若要数 90 天以前的次数，需另行存储，本期不涉及。

---

## 5. F4：回看时也能评价和修改反馈

### 5.1 接口
- `GET /api/explain/answers?contextId=` → `{ answers: [{ answerId, askLabel, text, feedback, feedbackAt }] }`：当前用户、这条批注的回答，按 `created_at` 升序。插件不加。
- `POST /api/explain/feedback` 规则不变：随时可写、可改，以最后一次为准（PRD Q8）。只需保证回看时拿到的 `answerId` 属于当前用户（现有 `setFeedback` 已校验）。

### 5.2 前端匹配规则（纯函数 `attachAnswers`，在 `src/lib/ai-thread.ts`，单测）
回看时仍以批注里存的整段对话（`contexts.ai_gloss`）为准渲染，**不改变现有回看内容**：
1. 用现有 `parseThread` 把 `ai_gloss` 拆成若干段。
2. 对每一段，在 answers 里找「去掉首尾空白后文字完全相同」且尚未被占用的回答，按顺序一一配对；配上的段带上 `answerId` 和 `feedback`。
3. 配不上的段（改动前的老讲解）没有 `answerId`，不显示反馈行。

单测覆盖：全部配上、新老混合、文字相同的两段按顺序各配一个、没有 answers、answers 比段多。

### 5.3 反馈行（`src/components/FeedbackRow.tsx`，从 `Reader.tsx` 搬出，讲解当时与回看共用）

| 状态 | 什么时候 | 显示 |
|---|---|---|
| **未评价** | 讲解当时还没点，或回看时当时没点过 | 「这次讲得：太浅 · 刚好 · 太深」，三个都是按钮 |
| **已评价** | 讲解当时点过，或回看时已有反馈 | 选中项绿色 + ✓，另两个仍是按钮，随时可改 |

- 「讲解下方显示反馈行」关闭或站点个性化关闭时都不显示（与现在一致）。
- 保存失败时恢复原状，原因放在 `title`（与现在一致）。
- 讲解记录已过期删除的老讲解（见 §4.5），配不上 `answerId`，不显示反馈行。

---

## 6. F5：统计立即刷新
- `setFeedback` 成功后把该用户 `learner_profiles.stats_updated_at` 置为 NULL，下次读档案时重算。

---

## 7. 设置页改动（`LearnerPanel.tsx`）
- 「AI 眼中的你」笔记下方的更新说明按来源显示：`nightly` →「每晚整理 · {时间}」，`user` →「你修改过 · {时间}」，NULL（老数据）→「更新于 {时间}」。
- 时间格式（纯函数 `formatNoteTime`，单测）：今天 →「今天 03:00」，昨天 →「昨天 21:10」，更早 →「11月12日 03:00」。
- 还没有笔记时的说明改为「今晚会整理一次」。

---

## 8. 界面设计简报与验收（`non-designer-frontend` 规范）

本期改动两处界面：**U1 讲解下方的反馈行**（未评价 / 已评价两种状态，讲解当时与回看共用）、**U2「AI 眼中的你」笔记下方的更新说明**。两者都是既有页面内的局部组件，不新增页面、提示条或弹窗。

### 8.1 中心点（C-02 / TIP-03 / PR-01）
- 阅读页右栏的中心点是**讲解正文**。U1 是讲解的附属信息，视觉权重必须低于讲解正文（C-06）：字号小于正文、不使用绿色主按钮、无阴影、无边框。
- 设置页「AI 眼中的你」的中心点是**笔记正文**（紫色块）；U2 是笔记的说明，权重低于笔记。

### 8.2 分组 · 亲密性（P-01 ~ P-11）

| 组 | 成员 | 组内间距 | 与相邻组的间距 |
|---|---|---|---|
| 一段讲解 | 「你问：…」/ 回答正文 / U1 反馈行 | `--rf-space-2`（8px） | 段与段之间 `--rf-space-4`（16px，沿用现有 `mt-4`） |
| U1 内部 | 「这次讲得：」/ 三个选项 | `--rf-space-1`（4px） | — |
| 笔记 + U2 | 紫色笔记块 / 更新说明 | `--rf-space-2`（8px） | 与下方操作按钮 `--rf-space-4`（16px） |

- 组内间距小于组间间距（P-05）；U1 紧贴所属讲解的末尾（P-01、P-04）。
- 不新增边框、卡片或框里套框（P-10、TIP-15、APX-12）。U2 从紫色块**里面**移到块的**下方**，作为一行文字，不再挤在块内。
- 视线路径：「你问：…」→ 回答正文 → 反馈行 → 下一段讲解。DOM 顺序与视觉顺序一致（P-09）。

### 8.3 对齐（A-01 ~ A-11）
- 唯一主对齐线：右栏内容区的**左边缘**（与讲解正文、「你问：…」同一条线）。U1 的「这次讲得：」左对齐到这条线。
- 设置页：U2 的左边缘与紫色笔记块的左边缘对齐。
- 唯一文本对齐方式：**左对齐**。不使用居中、两端对齐、绝对定位（A-01、A-04、A-05、A-07）。

### 8.4 重复（R-01 ~ R-09）
- **加强已有重复**：
  - 讲解当时与回看用同一个 `FeedbackRow` 组件、同一套类名；选中态（成功绿 + ✓ + 浅绿底）与现状一致。
  - 回看时的已评价状态与讲解当时完全相同，不另设样式。
  - U2 复用设置页现有次要说明文字的样式（`--rf-text-secondary`、`--rf-text-sm`），与「依据：…」等说明同一形态。
  - 圆角只用已有的 `--rf-radius-xs`（反馈按钮）与 `--rf-radius-md`（笔记块），不出现新圆角值（C-08）。
- **新增重复元素**：无。

### 8.5 对比（C-01 ~ C-09 / TX-01 ~ TX-11）

| 相邻元素 | 字号 | 对比维度 |
|---|---|---|
| U1 选中项 vs 未选中项 | 12 / 12 | 颜色（成功绿 vs 次要灰）+ 字重（**700 vs 400**）+ 形状（✓ 与浅绿底） |
| U1「这次讲得：」vs 选项 | 12 / 12 | 字重（400 vs 400 相同）+ 结构（标签 vs 可点项，选项有悬停底色）——两者同属一组，刻意保持相同 |
| U1 整行 vs 上方讲解正文 | 12 / 14 | 见例外 E-06（产品要求反馈行保持小而不显眼） |
| U2 vs 笔记正文 | 14 / 14 | 结构（块外 vs 紫色块内）+ 颜色（次要灰 vs AI 紫） |

- **反馈行字重要改**：现状未选中 600、选中 700，属于「400 对 500」式的相近字重（C-03、TX-02）。改为未选中 400、选中 700（`--rf-weight-regular` / `--rf-weight-bold`）。
- 不新增分隔线（C-09）；不出现 12 对 14 以外的新字号对。

### 8.6 配色关系（COL-01 ~ COL-13）
- 沿用项目固定调色板（COL-13），本期**不新增任何颜色**。
- 关系：**互补**——主色黄绿（`--rf-green-*`：品牌、主操作、成功）与紫（`--rf-purple-*`：AI 产出）在色轮上近似相对；大面积为中性灰白。本期 U1 用成功绿，U2 用中性灰。
- 对比度（COL-08，`工程化判据` 正文 ≥ 4.5:1），按 WCAG 相对亮度公式实测（2026-11-14）：

| 文字 | 背景 | 对比度 |
|---|---|---|
| `--rf-success-text` #3f7f00 | `--rf-success-soft` #f1fbe7 | 4.64 : 1 |
| `--rf-text-secondary` #6b6b6b | 白 #ffffff | 5.33 : 1 |
| `--rf-text-primary` #3c3c3c（悬停时的文字色） | `--rf-bg-hover` #f7f7f7（悬停底色） | 10.30 : 1 |
| `--rf-text-secondary` #6b6b6b（万一悬停只改底色） | `--rf-bg-hover` #f7f7f7 | 4.97 : 1 |

  余量小：实现时**不得**改用更浅的灰、加透明度或把字号再调小。
- 暖色面积：本期无暖色（COL-09 满足）。

### 8.7 字体（TC / TF / TX / T）
- 字族：项目唯一正文字族 `--rf-font-sans`（DM Sans + 苹方，六类中的**无衬线体**），不新增字族；单一字族属于「协调」方案（TF-01），层级靠颜色 / 字重 / 结构建立（§8.5）。
- 不使用 Times Roman / Arial / Helvetica / Sand（TC-04）；无 Script / Decorative。
- 排版细节：中文全角标点与「」引号；省略号用 `…`（T-04）；无下划线（T-06）；不全大写（T-05）；U2 加 `text-wrap: pretty`（T-08）。

### 8.8 媒介与状态
- **窄屏（390px）**：U1 一行放得下（约 160px 宽），不换行；U2 允许换行并保持左对齐；无横向滚动。
- **状态**：U1 的两种状态见 §5.3；三个选项始终是按钮，有悬停（浅灰底）、按下（缩小，沿用现有）、键盘焦点环（沿用全站 `:focus-visible`）。
- **动效**：选中时 ✓ 的弹出动画沿用现有，`prefers-reduced-motion: reduce` 时不播放（已实现）。
- **深色模式、打印**：产品没有（例外 E-05）。
- 「言之有理」（PR-03）：回看时不加「补评」「修改」之类的说明文字或图标——与讲解当时完全一样的反馈行，本身就说明可以点、可以改。

### 8.9 例外登记表

| 编号 | 被覆盖规则 | 类别 | 原因 | 补偿手段 |
|---|---|---|---|---|
| E-01 | TX-02、TC-04（字重覆盖 300–900）、验收 G12 | 用户既有设计系统 | `docs/design-system.md` 只允许 400 / 600 / 700 / 800，`check-tokens.mjs` 强制 | 本期只用 400 与 700，并始终叠加颜色或结构维度（§8.5） |
| E-02 | C-01、TX-01（相邻字号比 ≥ 1.5） | 用户既有设计系统 | 项目字号阶梯 12 / 14 / 16 / 18 / 20 / 24 / 32，相邻比 < 1.5 | 本期界面内同组元素一律同字号，靠颜色 + 字重 + 结构区分 |
| E-03 | COL-10（硬编码颜色） | 用户既有设计系统（检查器误报） | `tokens.css` 本身就是调色板的唯一来源 | 只在 `tokens.css` 定义颜色；本期界面文件不出现任何颜色值 |
| E-04 | 现有文件里已存在的 HARD 项（`globals.css` 的 C-09 线宽 3 / 4 / 5px、P-05 的 1 / 2px 微调、T-08 未全局 `text-wrap`；`Reader.tsx`、`LearnerPanel.tsx` 的既有项） | 用户要求（本期范围限定） | 本期之前就存在，不属于本需求 | 本期不新增任何一项（§8.10 前后对比）；另开「全站设计规范整改」任务 |
| E-05 | 验收 F8（深色模式）、F9 / TIP-04（打印） | 媒介映射 | 产品没有深色模式和打印样式 | 不适用；以后增加深色模式时对 U1 / U2 重新验证 COL-08 |
| E-06 | C-01、TX-01（反馈行 12px 紧跟 14px 讲解正文） | 用户要求 | 产品确认反馈行「小、不显眼是对的」（2026-11-14） | 叠加颜色（次要灰）、结构（「这次讲得：」前缀 + 8px 组内间距）、字重（未选中 400）拉开层级；选中项另用成功绿 + ✓ |

### 8.10 自动检查的范围与做法
- 本期新增样式全部写进**新文件** `src/styles/p34-feedback.css`（在 `globals.css` 末尾 `@import`）；`globals.css` 里原有的 `.rf-feedback-*` 规则搬进新文件并按 §8.5 改字重，`globals.css` 不再新增规则。
- 检查范围：`src/styles/p34-feedback.css`、`src/components/FeedbackRow.tsx` —— 复制到一个临时目录后运行 `python3 <技能目录>/scripts/check_design.py <临时目录>`，要求 **`HARD = 0`**；`REVIEW` 项逐条在 `docs/design/P34-DESIGN.md` 写结论。
- 改动的既有文件 `Reader.tsx`、`LearnerPanel.tsx`、`globals.css`：改动前后各跑一次，**HARD 数量不得增加**，两次结果附在 `docs/design/P34-DESIGN.md`（存量见 E-04）。
- `npm test` 里的 `check-tokens.mjs` 必须通过。

### 8.11 人工验收
交付时在 `docs/design/P34-DESIGN.md` 中：
1. 附 §8.1–§8.8 简报，写明实际取值；对比度若令牌未变，引用 §8.6 的实测值，令牌变了则重测。
2. 逐行填写技能 `references/acceptance-checklist.md` 的 A–K 全部行（通过 / 不通过 / 例外 E-xx），重点：
   - 眯眼测试：右栏视觉停顿点 ≤ 5（P-03）。
   - 在 1440px 与 390px 截图上画出右栏左边缘对齐线，「你问：…」、讲解正文、反馈行都落在线上（A-03、A-09）。
   - 焦点仍是讲解正文，反馈行没有抢走注意力（C-06）。
   - 讲解当时与回看时的反馈行并排截图，确认外观完全一致（R-02）。
3. 截图（隔离库 + 假模型）：`.verify/p34/` 下 `feedback-unrated-{1440,390}.png`、`feedback-rated-{1440,390}.png`、`feedback-recall-{1440,390}.png`、`learner-note-meta-{1440,390}.png`。
4. 附例外登记表（§8.9）；有新增例外按同格式登记。

---

## 9. 测试

### 9.1 单元测试（`tests/unit/`）
| 文件 | 覆盖 |
|---|---|
| `learner-recent-feedback.test.ts` | `answerTraits`（地图 / 整句大意 / 例句 / 字数；去掉建议行与释义行；没有原文）、`formatRecentFeedback`（不含英文原词、`ask_label` 优先且截 12 字、从新到旧、每种评价一条最多 3 行、缺某种时少一行） |
| `learner-profile-text.test.ts`（扩展） | 「最近的反馈」位置；720 字上限；截短顺序（笔记 → 难点 → 统计 → 最近反馈从最旧整行去掉）；`hasUsableProfile` 的 2 / 3 次反馈边界 |
| `ai-prompt-personalized.test.ts`（扩展） | 个性化深度指引含「最近的反馈」用法一句；个性化关闭时与旧快照逐字一致 |
| `learner-note-nightly.test.ts` | `nightlyDue`（北京时间 02:59 / 03:00、跨日、已跑过）、`nightlyEligible`（有新反馈、新事件 9 / 10 次、个性化关闭）、`buildNightlyNotePrompt`（30 组上限、结构顺序、不含英文原词） |
| `learner-retention.test.ts` | `retentionCutoffs`：讲解 30 天 / 90 天、查词 90 天三个截止时间的边界 |
| `ai-thread.test.ts`（扩展） | `attachAnswers` 五种情况 |
| `learner-note-time.test.ts` | `formatNoteTime` 今天 / 昨天 / 更早 |
| `db-answers.test.ts` | 新表与新列：空库创建、老库加列、重复执行不变 |
| `learner-note.test.ts`、`learner-note-throttle.test.ts`（改写） | 删除 25 次 + 24 小时的用例；保留 `validateNote` 与失败冷却 |

纯函数只用相对路径 import，并加入 `tsconfig.unit.json`。

### 9.2 端到端（`scripts/e2e-personalized.mjs` 扩展；假模型）
1. F1：讲解先于批注保存 → 补上 `context_id`；追问三次 → 三行回答；中止 → 无回答行。
2. F2：在文章 A 点「太深」（那次假模型回答带句子地图）→ 在**文章 B** 查词时，讲解请求的学生档案含「画了句子地图 → 太深」（不限文章）；31 天前的反馈不出现；再点一次「太深」→ 只出现较新的那一条；三种都点过 → 正好 3 行；档案里不含英文原词。
3. F3：`READFLOW_NIGHTLY_HOUR` 设为当前北京小时、`READFLOW_NIGHTLY_INTERVAL_MS` 设为 1000 启动 → 新动静满 10 次的用户被整理、`note_update_kind = nightly`；只有 9 次的用户不调模型；`learner.nightlyRunDay` 写入；再等一个周期不重复。
4. F4：不点 → 切走 → 回来，三项可点，补点「刚好」后再回来是选中状态；再改选「太浅」，库里被覆盖，下一次讲解的「最近的反馈」跟着变。
5. F5：第 5 个「太深」（过半）后下一次讲解的档案含「以往反馈：「太深」偏多」。
6. F6：已整理过的讲解记录改到 31 天前 → 删除（连同回答原文），29 天前保留；没整理过的 31 天前保留、91 天前删除；查词记录 89 天前保留、91 天前删除；删除后词库、回看、行为推断、做卡正常。
7. 改写原 H0–H7、L1–L3 中依赖「25 次查词 + 24 小时」的用例。
8. 截图与 `check_design.py` 门槛按 §8.10、§8.11。

---

## 10. 交付要求
- 提交说明按 F1–F6 列出改动，附：测试结果；`check_design.py` 结果（新文件 `HARD = 0`、改动的既有文件前后 HARD 数）；`docs/design/P34-DESIGN.md` 路径。
- 更新 `docs/DATABASE.md`：新表 `explain_answers`、`learner_profiles.note_update_kind`、站级设置 `learner.nightlyRunDay`、保留期（讲解记录 30 天 / 未整理的最多 90 天、查词记录 90 天）、`note_lookup_cursor` 不再使用。
- 不推送、不部署，等产品确认。
