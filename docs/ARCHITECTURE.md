# ReadFlow 技术实现文档

> 面向要改这个仓库的人（包括三个月后的自己）。
> 产品定位与背景见 [`../README.md`](../README.md)。

**版本**：本地单机可用（P0–P4、P6、P8 CEFR 粗估、P9 结构化导入已完成）
**代码规模**：`src/` + `scripts/` 约 6k 行（TypeScript / TSX / CSS）
**最后核对的运行环境**：Node 24.x，Next.js 16.4.3，React 19.3.0

---

## 目录

1. [系统总览](#1-系统总览)
2. [数据模型](#2-数据模型)
3. [链路一：文本导入](#3-链路一文本导入)
4. [链路二：点词命中与锚定](#4-链路二点词命中与锚定)
5. [链路三：三层递进释义](#5-链路三三层递进释义)
6. [链路四：收词与去重](#6-链路四收词与去重)
7. [链路五：统计与游戏化](#7-链路五统计与游戏化)
8. [关键取舍与论证](#8-关键取舍与论证)
9. [踩坑记录](#9-踩坑记录)
10. [Readlang 逆向结论](#10-readlang-逆向结论)
11. [链路六：导出墨墨记忆卡](#11-链路六导出墨墨记忆卡)
12. [验证方法](#12-验证方法)
13. [代码地图与改动指引](#13-代码地图与改动指引)

---

## 1. 系统总览

单进程 Next.js 应用，同一个 Node 进程里同时提供 SSR 页面和 API，数据落在两个 SQLite 文件上。

```
                    ┌──────────────────── 浏览器 ────────────────────┐
                    │  首页 / 阅读页 / 词库 / 战绩（SSR + 少量客户端）│
                    └───────────────┬────────────────────────────────┘
                                    │ HTTP（同源，无鉴权）
┌───────────────────────────────────▼────────────────────────────────┐
│ Next.js（Node runtime）                                            │
│                                                                    │
│  Server Components            API Routes                           │
│  ├ page.tsx（列表+统计）      ├ /api/texts      导入 / 列表 / 删除  │
│  ├ texts/[id]（段落+已收词）  ├ /api/words      收词 / 列表 / 删除  │
│  ├ words/page.tsx             ├ /api/dict       词典查询            │
│  └ stats/page.tsx             └ /api/explain    AI 流式释义         │
│                                                                    │
│  lib/                                                              │
│  ├ split.ts      切段      tokenize.ts  分词 + 锚点                │
│  ├ readability.ts URL→正文  dict.ts      ECDICT 查询               │
│  ├ ai.ts         DeepSeek  stats.ts      按天聚合                  │
└──────┬──────────────────────────────┬──────────────────────┬───────┘
       │                              │                      │
┌──────▼──────────┐        ┌──────────▼─────────┐   ┌────────▼────────┐
│ data/readflow  │        │ data/dict/ecdict.db│   │ api.deepseek.com│
│ 用户数据 + 词典 │        │ 只读，77 万词条    │   │ OpenAI 兼容接口 │
│ 索引（可写）    │        │ query_only = ON    │   │ 流式 SSE        │
└─────────────────┘        └────────────────────┘   └─────────────────┘
```

**两条不变量**（改代码时不要破坏）：

1. **段落是锚定与渲染的唯二坐标原点。** 段落不重新导入就永远不变；所有位置信息都以 `(paragraph_id, 段内偏移)` 表达。
2. **服务端与客户端渲染必须逐字符一致。** 任何依赖环境的分词/排序/格式化都会炸 hydration（见 9.1）。

---

## 2. 数据模型

定义在 `src/db/schema.ts`，建表 SQL 内联在 `src/db/index.ts`（两处必须同步，见 8.5）。

```
texts ──1:N──> paragraphs
  │
  └──(逻辑引用)
        │
user_words ──1:N──> contexts ──> (text_id, paragraph_id, 位置, quote, prefix, suffix)
  │
  └──1:N──> exports（导出幂等记录：word + deck + card_type 唯一）
```

### 2.1 表定义

| 表 | 关键字段 | 说明 |
|---|---|---|
| `texts` | `id`(uuid), `user_id`, `title`, `source_type`(paste/file/url), `source_url`, `language`, `word_count`, `created_at`(ms), `cefr_level`, `cefr_score`, `cefr_detail`(JSON), `cefr_method`, `cefr_overridden`, `source_format`(plain/markdown/html), `source_raw` | 一篇文章；难度字段可空（3.4）；`source_raw` 存原始源，供换解析器时无损重跑（3.5，>2MB 不落库） |
| `paragraphs` | `id`(uuid), `text_id`, `idx`, `content`, `block_type`, `block_meta`(JSON), `inline_ranges`(JSON) | **锚定基准**。`content` 只存可见纯文本，是 `contexts.start/end` 唯一坐标基准；后三列只描述排版，不参与定位。索引 `(text_id, idx)` |
| `user_words` | `id`(uuid), `user_id`, `lemma`, `display_form`, `pos`, `phonetic`, `translation`, `note`, `created_at` | 唯一索引 `(user_id, lemma)` —— 一个词只存一行 |
| `contexts` | `id`, `user_word_id`, `text_id`, `paragraph_id`, `start`, `end`, `quote`, `prefix`, `suffix`, `ai_gloss`, `created_at` | 每次收词一条，**刻意不去重** |
| `exports` | `id`, `user_word_id`, `deck_id`, `chapter_id`, `card_id`, `card_type`, `status`, `error`, `pushed_at` | 唯一索引 `(user_word_id, deck_id, card_type)`，导出幂等的物理保证（11.5） |
| `settings` | `key`, `value`, `updated_at` | 键值配置：记住上次选的牌组/章节 |

### 2.2 为什么 `contexts` 是独立表而不是 JSON 字段

一个词会在多篇文章、多个位置出现。如果做成 `user_words.occurrences` 的 JSON 数组：

- 无法用 SQL 做「这篇文里我收了哪些词」（阅读页高亮要这个）；
- 无法按天统计收集量（战绩页要这个）；
- 并发收词时要读-改-写整个 JSON，容易丢更新。

独立成表后，这两个查询都是一次 join，收词是纯 append。

### 2.3 `exchange` 字段：词形还原的免费午餐

ECDICT 每个词条带一个 `exchange` 字段，格式：

```
went          →  "0:go/1:p"        原形 go，变形类型 p（过去式）
children      →  "0:child/1:s"     复数
better        →  "0:good/1:r"      比较级
```

`src/lib/dict.ts` 的 `lemma()` 用一行正则就从 exchange 里拿到了原形——**不需要任何 NLP 库、不需要规则表**。这是整个项目性价比最高的一个发现。

⚠️ 但这行正则踩过两个坑，都是实测数据才暴露的：

```
1. `0:` 不一定在首位
   went      "0:go/1:p"        （0: 在首位）
   glistened "1:pd/0:glisten"  （0: 在第二段）← 原来的 ^0: 正则直接失配
   glasses   "1:s3/0:glass"
   → 改成 /(?:^|\/)0:([^\/]+)/

2. 有些变形词 exchange 是空的，只在中文释义里留了指针
   was → exchange = null，translation = "be的过去式"
   → 退一步解析中文，正则必须锚在开头，否则
     "下雨（rain的过去式）" 里括号内的补充说明会被误当成原形来源
```

`lookup()` 的三步：

```
1. 先算原形：exchange 的 0: 段 → 中文指针 → 自己
2. 是变形词（lemma ≠ 自己）就查原形词条，然后决定展示哪条释义：
   - 变形词自己是正经词条（有柯林斯星级 / 牛津核心词 / 词频）→ 用自己的
     glasses 眼镜、better 较好的、running 赛跑 —— 这些义项丢了很亏
   - 释义是「xx 的过去式」这种指针 → 用原形的（went → go）
   - 释义和原形释义**没有汉字重合** → 用自己的
     leaves 的 exchange 指向 leave「离开」，但它自己的释义是「树叶」；
     直接用原形会把阅读时的意思讲错
   - 其余 → 用原形的（glistened → glisten、studies → study）
3. 原形查不到 → 用直查结果；都没有则 entry = null（前端切第 2 层走 AI）
```

**旧实现（已废弃）**：用 `translation.length > 10` 猜「有没有实义释义」。结果是 `glistened`
的 "v. 湿物闪耀, 闪亮( glisten的过去式和过去分词 )" 被当成独立词条，lemma 存成了
`glistened` —— 词库里 glisten / glistened 分成两条，卡片标题也是变形。

改完之后**历史数据要用 `npm run backfill:lemma` 对齐**（默认 dry-run，加 `--apply` 才写库）：
它按新规则重算每个词的 lemma，顺带刷新指针式释义；lemma 撞上已有词时合并
（上下文和导出记录一起迁过去，导出记录撞唯一键则丢弃）。

---

## 3. 链路一：文本导入

```
ImportForm（客户端）
  ├ 粘贴：textarea         ┐
  ├ 上传：File.text()      ├ format: auto | plain | markdown（前端只做提示）
  └ 网页：只传 URL         ┘
        │
        ▼  POST /api/texts { title?, text?, url?, format?, sourceType? }
src/app/api/texts/route.ts
  1. 有 url → extractFromUrl()：优先站点官方 .md，否则 Readability 正文 HTML（3.1）
              ├ markdown → parseMarkdown()
              └ html     → parseHtmlBlocks()
     无 url → parsePasted(raw, format)：服务端独立探测 → parseMarkdown() / parsePlain()
  2. 得到 Block[]（统一 IR，3.5）；空 → 400；无标题 → 取首段可见文本前 40 字
  3. parts = proseTexts(blocks)  ← 只留自然语言正文，代码/hr/figure 不进统计
  4. countWords(parts) + estimateCefrForParts(parts)  ← 事务外，失败不影响导入（3.4）
  5. db.transaction：插 texts（cefr_* + source_format/source_raw）
                    + 批量插 paragraphs（content + block_type/block_meta/inline_ranges）
  6. 返回 { id, title, paragraphCount, wordCount, sourceFormat, blockKinds, cefr* }
        │
        ▼  前端 router.push(`/texts/${id}`)
```

### 3.1 URL 提取（`lib/readability.ts`）

**先问站点要结构化源，再考虑自己刮。** Mintlify / Docusaurus 一类文档站会在 HTML 里放：

```html
<link rel="alternate" type="text/markdown" href="/docs/en/best-practices.md">
```

同时页面上有「Copy page」按钮——它复制出来的就是这份官方 Markdown。所以 `extractFromUrl()` 的顺序是：

1. `fetch`（桌面 UA，20s 超时）→ `new JSDOM(html)`；
2. 找 `link[rel~="alternate"][type="text/markdown"]`，解析成绝对 URL 后再 `fetch` 一次；
3. **双保险校验**：`content-type` 含 `text/markdown` 且正文有 Markdown 特征，才认它是 Markdown。否则 HTML 404 页会被误当正文；
4. 拿到官方 `.md` → `{ markdown, html: null }`，交给 `parseMarkdown()`；
5. 没有官方源 → `Readability.parse()` 拿 `article.content` 的**内容 HTML**，交给 `parseHtmlBlocks()`（3.5）。

返回类型从旧的 `{ title, text }` 改成 `{ title, markdown, html, sourceUrl }`。**旧版 `htmlToParagraphs()` 已删除**：它按块级元素取 `textContent` 再用 `\n\n` 拼回纯文本，这一步会永久丢掉表格的行列关系、`<pre>` 里的换行和链接的 href。现在 HTML 交给 `jsdom` 直接遍历 DOM 生成 Block[]，不经过 Turndown 这类二次有损转换。

失败信息是给人看的：「没能从这个页面提取出正文（可能是登录墙或纯前端渲染）」。

### 3.2 切段（`lib/split.ts`）

```
原文 → 归一化换行(\r\n→\n) → trim
  ① 按空行切（\n\s*\n+）
  ② 按单换行切（\n+）
  若 ① 只得 1 段且 ② 得 > 3 段 → 判定为「单换行文本」（小说/字幕）→ 用 ②
```

每段再归一化：多空格压成一个、内部换行变空格、trim。

**这条路现在只服务纯文本输入**（`parsePlain()`，见 3.5）。Markdown / HTML 走 AST 或 DOM，不再经过切段与归一化——正是「内部换行变空格」这一步，以前把表格和代码块压成了不可恢复的一行。

`splitParagraphs` 是**所有位置语义的起点**：切段规则一改，历史 `contexts` 的段内偏移全部失效（`paragraph_id` 还在，但同一个 id 对应的 content 可能变了）。所以**不要动切段逻辑，除非接受旧锚点失效**——真要改，用 `resolveAnchor()` 的降级路径兜住。

### 3.3 词数统计

英文按空白、CJK 按字。用于列表展示与每日目标计算（`goal = max(20, round(wordCount * 0.05))`）。

结构化导入后，输入是 `proseTexts(blocks)` 而不是全部 Block：`code` / `hr` / `figure` 被 `isProse()` 过滤掉。`/api/summarize` 的分段小结和 `Reader.planSections()` 用同一套过滤规则，保证 `startIdx/endIdx` 仍能对上段落下标。这也解释了 3.4 里技术文档按 Markdown 导入时词数下降的原因。

### 3.4 CEFR 难度粗估（导入时算一次）

**问题定义。** CEFR 是描述「人」的能力框架，不是文本标准。分级读物是作者按词汇大纲 / 语法大纲**写**到某一级；我们要做的是反过来，拿任意文本**测**它大概需要什么水平才读得动。这是预测问题，不是认证，级别边界天然模糊。Readlang 的做法是服务端在导入时算好 metrics、前端只显示一句 *"Rough estimate of the CEFR level required based on the vocabulary and complexity of the text"*，我们照抄这个信息架构（也是用户确认的第一版方案）。学术界用 XGBoost + 200 多项特征约 70.9% 准确率、Top-2 95%；单用 Flesch 这类可读性公式只有 31–42%。所以：**词汇是主判据，句法只当修正项**。

**代码分层。**

```
src/lib/cefr.ts         纯函数：不碰 DB、不依赖 Node 模块，可单测
  ├ wordsOf / splitSentences     确定性切词切句
  ├ analyzeFeatures(parts, rankOf)  ← 词典查询由调用方注入
  └ scoreFeatures(features)      → level / score / confidence / adjacentLevel / detail
src/lib/cefr-dict.ts    服务端适配：frequencyRank() 接 ECDICT + 按词形缓存 + try/catch
src/db/ensure-cefr.ts   给老库 ALTER 补列（应用启动与回填脚本共用同一份定义）
src/components/CefrBadge.tsx  纯 CSS hover 弹层，服务端组件
```

**词汇路（权重 0.7）。** ECDICT 的 `frq` 是 COCA 词频排名（1 最常用，最大 47062；77 万词条里只有 42231 个有排名）。一篇文本要读得动，绝大部分**词次**必须落在学习者已掌握的高频词里。按词次取平均 `log(rank)`，再叠加低频词（`rank > 8000`）占比：

```
logScore   = clamp((meanLogRank - 4.2) / 2.8) × 100     4.2≈rank 67，7.0≈rank 1100
rareScore  = clamp(rareRatio / 0.35) × 100
vocabScore = 0.75 × logScore + 0.25 × rareScore
```

取 `log` 是因为排名跨 4 个数量级，直接平均会被少数极生僻词拖飞。两个必须绕开的数据坑：

1. **变形词本身没有 `frq`**（`was` / `are` / `said` 都是 null），不还原成原形会把最普通的功能词当生僻词，实测能把短篇的高频覆盖率拉低十几个点 → `frequencyRank()` 查不到时按 `lemma` 规则（`exchange` 的 `0:` 或中文指针）回查原形。
2. **LaTeX / 公式 / 单字母变量不是词汇**：`Scaling Laws` 那篇有 685 个 `n / d / c / beta / frac`，过滤掉后平均句长才从 20.2 回到合理区间 → `wordsOf()` 丢掉所有单字母 token。

**复杂度路（权重 0.3）。** `complexityScore = 0.5×lenScore + 0.35×longScore + 0.15×subScore`，分别由平均句长（8→0 分、28→100 分）、≥25 词长句占比（35% 饱和）、含从句/衔接标记的句子占比（50% 饱和）线性映射。切句用纯正则 + 学术缩写白名单（`et al.` / `e.g.` / `Dr.`），刻意不用 `Intl.Segmenter`：结果要落库，不同 ICU 版本必须给出同一个值。

最终 `score = 0.7×vocabScore + 0.3×complexityScore`，6 级等分 0–100（每级约 16.67 分）。

**落库而非只存级别。** `texts` 存 `cefr_level`、`cefr_score`（连续分，算法升级可离线重算）、`cefr_detail`（JSON：三档词汇占比、句法统计、置信度、caveats）、`cefr_method`（`heuristic-v1`）、`cefr_overridden`。相邻级别与置信度不单独占列：前者由 `adjacentOfScore(score)` 纯函数推出，后者写进 detail JSON。

**置信度是工程判断，不是模型概率**：词数 <150 / 句数 <8 / 未收录词 >25% → `low`；词数 ≥500 且句数 ≥25 且未收录 ≤10% → `high`；其余 `medium`。未收录词多是专有名词、术语、公式符号的信号，会高估难度，所以弹层里直接把这条偏差写出来。

**实测校准（本机 4 篇真实文本，`npm run backfill:cefr`）**：

| 文本 | 词/句 | 平均 log(rank) | 低频词占比 | 平均句长 | 结果 |
|---|---|---|---|---|---|
| The Night Rain | 87 / 6 | 4.80 | 12.6% | 14.5 | **A2** 23.9 分，置信度低 |
| Prompt Engineering — Lilian Weng | 3546 / 215 | 6.35 | 24.3% | 16.5 | **B2** 65.6 分（接近 C1） |
| Best practices for Claude Code | 8223 / 356 | 5.98 | 22.3% | 23.1 | **B2** 66.7 分（接近 C1） |
| Scaling Laws, Carefully | 4535 / 213 | 6.35 | 24.8% | 21.3 | **C1** 71.4 分 |

词汇路把短篇故事与技术长文分开（4.80 vs 6.0–6.35），复杂度路把技术长文之间再分开（16.5 / 21.3 / 23.1 词/句）——这正是双路设计的预期效果。注意 Best practices 词汇更简单（5.98）但句子更长，两条路互相抵消后落在 B2 上沿：这正是我们保留连续分和明细、而不是只显示一个字母的原因。单测里用「控制变量」锁住这个性质：只改词汇难度时复杂度分必须完全不动，只改断句时词汇分必须完全不动。

**展示。** 首页列表与阅读页标题下各一个低调徽章；悬停（或键盘聚焦）用纯 CSS 展开明细。不用 click 是因为列表整行是一个 `<Link>`，嵌套可点击元素会互相打架；组件也因此不需要 `"use client"`。文案明确写「粗略估计」「不是 CEFR 官方评级」。

**回填与重算。** `npm run backfill:cefr` 默认 DRY-RUN；`node .verify/scripts/backfill-cefr.js --apply` 写入，加 `--force` 用当前算法重算全部（`cefr_overridden = 1` 的行永远跳过）。脚本加载 `src/db/ensure-cefr.ts` 自行补列，不依赖服务已重启。改完代码记得 `npm run build && bash scripts/service.sh restart` —— 本机跑的是 `next start` 生产构建。

### 3.5 结构化导入：Block IR（P9）

**问题定义。** 用户把 Claude Code 官方文档的「Copy page」粘进来，看到的是一张糊成一段的表格、一坨带围栏标记的 JSON 代码块和全部消失的标题层级。第一反应容易是「URL 抓取把 HTML 压平了」，但查库发现那篇是 `source_type = "paste"`、`source_url = null` —— 用户粘贴的本来就是**完整正确的官方 Markdown**。是我们把它当纯文本吞了：

```
官方 .md → splitParagraphs() → normalize() 把段内换行压成空格 → paragraphs.content 只剩纯文本
         → Reader.tsx 对纯文本 tokenize() → 没有任何结构信息可渲染
```

根因不在 CSS，也不在渲染：**结构信息在入库那一刻被丢弃了**。旧 `content` 里 `| | Non-deterministic ... |` 已经无法反推原来的行列，所以旧文章不可逆，按约定不做迁移工具，只能重新导入。

**为什么不是三套解析器。** 需求是同时兼容「新闻只有段落 / 论文有图表 / AI 博客有代码块」。如果按体裁写三套分支，等于把「格式」和「内容类型」耦合：一篇带表格的新闻会走错分支，MDX 里一个代码块又得再开特例。正确切法是按**输入格式**分层，与体裁无关：

```
                  ┌ 粘贴/上传 Markdown ─ remark-parse + remark-gfm ─┐
  多种输入 ───────┼ URL 官方 .md ───────────────────────────────────┼→ Block[] ─→ 一套渲染后端
                  ├ URL 普通网页 ─ Readability HTML → jsdom ────────┤   (Reader.tsx)
                  └ 纯文本 ─────── splitParagraphs() ───────────────┘
                        统一中间表示 IR
```

**IR 契约（`src/lib/import/types.ts`）。** 一个 Block 只有四个字段：

```ts
type Block = {
  kind: "heading" | "paragraph" | "list_item" | "table_cell" | "quote" | "code" | "hr" | "figure";
  text: string;          // 用户可见纯文本，不含任何 Markdown / HTML 标记
  ranges: InlineRange[]; // 相对 text 的 [start, end) 样式/链接区间
  meta: BlockMeta;       // depth / listId / tableId / row / col / lang / callout / skip
};
```

三条不变量，破坏任何一条都会让锚点错位：

1. **一个 Block = 一条 `paragraphs` 记录 = 一个 `data-pid` 容器。** 表格每个 cell、列表每个 item 各自独立成 Block，`idx` 连续。
2. **`text` 是唯一坐标基准。** `contexts.start/end`、`tokenize()` 的 `data-s/data-e`、`Range.toString()` 的段落偏移全部相对它。样式和结构信息只能进 `ranges` / `meta`，绝不进 `text`。
3. **`ranges` 只加 className，不插入字符。** 单测锁住控制变量：`A **bold** word.` 与 `A bold word.` 的 `text` 必须完全相同、只有 `ranges` 不同；`# Title` 与 `## Title` 的 `text` 必须完全相同、只有 `meta.depth` 不同。CSS 里的 callout 标签用 `::before` + `attr(data-label)`，因为**伪元素不进入 DOM 文本** —— 用真标签会被 `Range.toString()` 算进段落偏移。

**适配器分工。**

| 文件 | 职责 | 关键取舍 |
|---|---|---|
| `builder.ts` | `TextBuilder` 把 inline 节点摊平成 `text`，`range(fn)` 在追加前后记长度差 | 段间补空格必须在追加**之前**做，否则 `range.start/end` 与最终文本错位 |
| `markdown.ts` | `unified().use(remarkParse).use(remarkGfm)` 直接读 mdast | 不走 Markdown→HTML→文本的有损往返；`cleanInfoString()` 把 MDX 的 info string（如 `text theme={null}`）处理成合法语言名；`[!NOTE]` 只进 `meta.callout` 不进可见文本；过滤 Mintlify 的 `Documentation Index ... llms.txt` 隐藏块 |
| `html.ts` | `jsdom` 遍历 Readability 正文 HTML | 保住 `<table>` 行列与 `<pre>` 换行；忽略 `script/style/nav/svg/form/button` 与 `sr-only`；相对链接用 `JSDOM({url})` 的 `el.href` 解析成绝对地址 |
| `plain.ts` | 复用 `splitParagraphs()` | 新闻 / 小说行为与改造前逐字一致，零回归 |
| `detect.ts` | 保守探测 | **至少 1 个强特征（heading/fence/table/callout/link）+ 总共 ≥2 类特征**才判 Markdown。小说里一个 `#`、一段单列表都不能误判；前端用同一函数做提示，服务端独立再判一次，不信任前端 |
| `group.ts` | `groupBlocks()` 纯函数把 cell/item 重组成 `<table>` / `<ul>` / `<ol>` | 不用随机 id、不依赖 ICU，服务端与客户端结果一致（8.1 的 hydration 约束延续到这里） |

**落库与迁移。** `texts` 加 `source_format`（plain/markdown/html）与 `source_raw`（原始源，>2MB 不落库，供以后换解析器无损重跑）；`paragraphs` 加 `block_type`、`block_meta` JSON、`inline_ranges` JSON。`src/db/ensure-blocks.ts` 与 `ensure-cefr.ts` 一样是**共享轻量迁移模块**：应用启动和离线脚本必须补出完全相同的列，避免两处表结构漂移。它刻意不 import `src/db/index.ts` —— `schema.ts` 里的 `export const exports` 在 CommonJS 编译链会撞保留字（9 节同类坑）。

旧库没有这三列，`ALTER TABLE ... DEFAULT 'paragraph'` 让老段落自动降级成普通段落，旧文章照常打开、`contexts` 锚点全部有效。

**渲染（`Reader.tsx`）。** `renderTokens()` 仍以 `tokenize(p.content)` 为骨架，词 span 带 `data-s/data-e`，`ranges` 只叠加 `.rf-i-strong` / `.rf-i-em` / `.rf-i-code` 等 class；链接跨多个 token 时用单个 `<a class="rf-inline-link">` 包住它们，点击时 `e.preventDefault()`，保证**点词优先弹释义而不是跳走**。`SingleBlock` 按 `blockType` 渲染 `h2–h6` / `blockquote` / `pre` / `hr` / `figure` / `li` / `p`，`GroupView` 负责表格与列表重组。代码块**不生成 `.w` span**：`pnpm`、`__init__`、`settings.json` 不是要背的单词。

**非正文过滤。** `NON_PROSE_KINDS = ["code","hr","figure"]`，`isProse()` 同时被三处使用：导入时的 `proseTexts()`（词数 / CEFR）、`/api/summarize` 的分段小结、`Reader.planSections()`。三处规则必须一致，否则 `startIdx/endIdx` 会指向错误的段。

**控制变量实验：同一篇文档，只换解析器。** 拿 `https://code.claude.com/docs/en/best-practices.md`（52,515 bytes / 635 行）分别强制 `plain` 与 `markdown` 导入：

| 指标 | 强制纯文本 | Markdown 结构化 | Δ |
|---|---|---|---|
| CEFR | **B2** / 66.65 | **B1** / 47.55 | −19.10 |
| 词数 | 8223 | 6798 | −1425 |
| 未登录词占比 | 16.36% | 9.52% | −6.84pp |
| 生僻词占比 | 22.34% | 14.31% | −8.03pp |
| COCA 前 1000 覆盖 | 59.76% | 68.18% | +8.42pp |
| 平均句长 | 23.1 | 20.29 | −2.81 |

强制纯文本精确复现了旧文章的 B2 / 66.65，说明估级算法本身没变。差掉的 1425 个「词」是代码标识符、URL、表格分隔语法 —— 旧路径把它们当成 ECDICT 查不到的生僻英文词，难度被虚高。所以 **B1 是去掉噪声后更真实的结果，不是回归**；`cefr_detail` 里那条「16% 的词不在 COCA 内，难度可能被高估」的 caveat 也随之消失。这个副作用必须写进文档，否则用户重新导入旧文章看到级别掉一级会以为是 bug。

**验证结果。** `tests/unit/import.test.ts` 21 个单测（含上述两个控制变量、range 不越界、`tokenize()` 坐标严格对齐、`parsePlain()` 与 `splitParagraphs()` 逐字一致、JSON 解析失败降级）。官方 Markdown 离线解析出 306 个 Block（28 heading / 20 quote / 103 paragraph / 100 list_item / 40 table_cell / 15 code），range 越界 0、可见文本残留 Markdown 标记 0；真实 HTML 路径 355 个 Block，table_cell 40 / code 15 / list_item 100 与 Markdown 路径对齐。真实浏览器 DOM 检查：3 张 `<table>`（首表 6 行、3 表头 cell、15 表体 cell、可横向滚动）、15 个 `<pre>`（10 个多行、最长 13 行）、19 个 callout、28 个列表 / 100 个 item、79 个链接、306 个 `data-pid` 容器，代码块内 `.w` 为 0，可见文本里管道行与代码围栏均为 0。E2E 覆盖粘贴自动识别、详情 API、SSR 标签、表格 cell 内点词收词后 `content.slice(start,end) === quote`、导出 dryRun 卡片无 Markdown 残留、纯文本零回归、URL 官方 Markdown 优先、旧文章仍可打开。

**已知边界（故意不做）。** `colspan`/`rowspan`、嵌套表格、脚注、LaTeX 数学、语法高亮配色、图片本身不还原（图片保留占位文字）；给 agent 看的隐藏 `llms.txt` 索引块会被过滤；旧文章不迁移。

---

## 4. 链路二：点词命中与锚定

这是唯一有真正技术含量的一段，全部在 `src/components/Reader.tsx`。

### 4.1 渲染：段落 → span

`Tokens`（`memo` 包裹）把每段可见文本 `tokenize()` 成 token 数组，词 token 渲染成 `<span class="w" data-s data-e>`，非词 token（空格、标点）用裸 `<span>`；`inlineRanges` 只往词 span 上叠 `.rf-i-*` class，链接用 `<a class="rf-inline-link">` 跨多个词包一层。

```tsx
tokenize("She sat on the river bank.")
→ [{text:"She",s:0,e:3,word:true}, {text:" ",s:3,e:4,word:false}, ...]
```

外层 `GroupView` 先跑纯函数 `groupBlocks()`，把连续的同 `listId` / `tableId` Block 重组；`SingleBlock` 再按 `blockType` 选标签（`h2–h6` / `p` / `li` / `blockquote` / `pre` / `hr` / `figure`）。无论外面套 `<table><tr><td>` 还是 `<ul><li>`，**`data-pid` 仍在最内层那个装词的容器上**，`onClick` 的 `closest("[data-pid]")` 与 4.2 的锚点计算完全不用改（详见 3.5）。

- 一段 100 词 ≈ 200 个 DOM 节点。视口内 10 段也就 2000 个，无压力。
- `Tokens` 用 `memo` + `useMemo` 按 `content` 缓存分词结果，同段落不会重复切；代码块不生成 `.w`。

### 4.2 单击

```ts
onClick(e) {
  if (选区非折叠) return;                    // 拖选时不抢事件
  wordEl = e.target.closest(".w")           // 没点到词 → 关弹层
  pEl   = wordEl.closest("[data-pid]")      // 找所属段落
  s = +wordEl.dataset.s; en = +wordEl.dataset.e
  → buildAnchor(p.content, s, en)
  → setPick({ ..., x: rect.left + rect.width/2, y: rect.bottom })
}
```
再点同一个词会 toggle 关闭（比较 `paragraphId + start + end`）。

### 4.3 拖选短语

```ts
onMouseUp() {
  range = selection.getRangeAt(0)
  pEl   = paraOf(range.commonAncestorContainer)   // 向上找 [data-pid]
  起点和终点必须在同一段内（跨段直接放弃，避免语义歧义）
  start = offsetIn(pEl, range.startContainer, range.startOffset)
  end   = offsetIn(pEl, range.endContainer,   range.endOffset)
}

// 核心工具：把 DOM (node, offset) 换算成段内字符偏移
function offsetIn(container, node, offset) {
  const r = document.createRange();
  r.selectNodeContents(container);
  r.setEnd(node, offset);
  return r.toString().length;      // 借浏览器自己算，不用手写遍历
}
```

> 这里没有用 `caretRangeFromPoint(x, y)`——拖选已经给了 Range，反而更准；单击则直接读 span 上的 `data-s/data-e`，不依赖坐标命中。

### 4.4 锚点三件套（`lib/tokenize.ts`）

```ts
buildAnchor(paragraph, start, end) → {
  start, end,
  quote:  paragraph.slice(s, e),
  prefix: paragraph.slice(max(0, s-40), s),      // 前 40 字符
  suffix: paragraph.slice(e, e+40),              // 后 40 字符
}
```

对应 W3C Web Annotation 的 `TextPositionSelector`（偏移）+ `TextQuoteSelector`（引用文本 + 前后文）。

`resolveAnchor()` 的降级阶梯：

```
① paragraph.slice(start, end) === quote        → 直接信任偏移（快）
② 全文搜 prefix+quote+suffix                   → 命中即定位（能扛住前后文整体位移）
③ 只搜 quote，且必须全文唯一                   → 命中（能扛住前后文被改）
④ 都不行                                       → null
```

返回 `null` 时调用方应当「显示原句但禁用跳转」，**绝不能退化成跳到第一个匹配**——跳错位置比不跳更糟。

> 现状：`resolveAnchor` 已实现但目前没有调用方（阅读页走 SSR，用不到回跳）。它是为「词库页点词回原文」准备的，接上之前不要删。

### 4.5 弹层定位

难点：弹层高度会随 AI 流式内容增长，不能预先知道。

```ts
W = 360
left = clamp(x, W/2+16, vw - W/2 - 16)          // 水平夹在视口内
ESTIMATED_H = 420                                // 保守预估
flipUp = y + 12 + ESTIMATED_H > vh - 16          // 下方放不下就翻到上方
top = flipUp ? max(16, y - 12 - 320) : y + 12
maxHeight = min(vh - top - 16, 560)              // 硬约束：永不溢出视口
```

内部用「标题栏固定 / 内容区 `flex:1 + overflow-y:auto` / 底栏固定」的三段式：

```
┌─ 标题栏（词 + 音标 + 收词 + 关闭）   flex:0
├─ 释义区（词典 / AI / 追问输入）      flex:1, overflow-y:auto
├─ 底栏（AI 释义 / 追问按钮）          flex:0  ← 内容再长也不会被挤走
└─ <details> 锚点调试信息（前文/后文/位置）
```

这一版把弹层高度从 ~430px 压到 ~317px（−26%），长内容下也不会溢出（实测 `overflowsViewport: false`）。

---

## 5. 链路三：三层递进释义

### 5.1 时序

```
点词
 │
 ├─▶ GET /api/dict?word=bank ──▶ ECDICT（<5ms）
 │        │
 │        ├ 有结果 → 渲染第 1 层（音标 / 中文释义 / 英文释义折叠 / 柯林斯星级）
 │        │          底栏按钮文案 = 「🤖 AI 深度释义」
 │        └ 无结果 或 是短语 → 渲染「词典未收录」
 │                   底栏按钮文案 = 「🔍 用 AI 解释」（引导升级）
 │
 └─▶ 用户点按钮 / 追问
        GET /api/explain?word=&context=&language=en&monolingual=false[&prompt=]
        → ReadableStream 逐块 enqueue
        → 前端 res.body.getReader() + TextDecoder 逐块 setState
        → 光标动画 + 内容区自动滚动
```

**为什么不是打开弹层就自动调 AI？** 因为 80% 的点词词典就够，自动调 = 每次点击都烧钱、都在等首字。用户主动点按钮是成本闸门，也是 Readlang 的设计（Explain 是显式的第二个动作）。

### 5.2 context 是怎么来的

```ts
function sentenceOf(anchor) {
  const prefixSent = anchor.prefix.replace(/^.*[.!?]\s*/, "");  // 砍掉前一句
  const suffixSent = anchor.suffix.replace(/\s*[.!?].*$/, "");   // 砍掉后一句
  return `${prefixSent}${anchor.quote}${suffixSent}`.trim() || anchor.quote;
}
```

只取**当前这一句**。这是刻意的取舍，理由见 8.2。

### 5.3 Prompt 结构（`lib/ai.ts`）

| 模式 | system | user |
|---|---|---|
| 默认（中文解释） | 你是一位语言教师，帮助中文母语者学习英语…重点解释当前语境下的含义…用 Markdown 输出 | 请解释 "bank" 在下面这句话中的含义："…" 请给出：词性、当前语境下的意思、用法说明 |
| monolingual | Explain words and phrases IN ENGLISH…focus on the one that fits the context | Explain the word "bank" as used in this sentence… |
| 追问（prompt） | 同上 | `Word/phrase: "bank"\nContext sentence: "…"\nQuestion: 这个词还有别的用法吗？` |

**追问时 word 和 context 仍然带上**——这是「上下文感知追问」和「泛泛问一个词」的区别。

参数：`model: deepseek-chat`、`stream: true`、`temperature: 0.3`（释义要准不要发散）、`max_tokens: 800`。

无 `DEEPSEEK_API_KEY` 时 `getClient()` 返回 `null`，generator 直接 yield 一段提示文案并 return——**不抛错、不白屏**。前端看到的就是一段普通文本。

### 5.4 流式的实现细节

服务端（`api/explain/route.ts`）：

```ts
new ReadableStream({
  async start(c) {
    for await (const chunk of streamExplain(params)) c.enqueue(encoder.encode(chunk));
    c.close();
  }
})
→ headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform" }
```

客户端：

```ts
const reader = res.body.getReader();
const decoder = new TextDecoder();
let text = "";
while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  text += decoder.decode(value, { stream: true });   // stream:true 处理多字节字符被切断
  setAiText(text);
}
```

两点注意：

- `decode(value, { stream: true })` 是必须的。中文字符 3 字节，可能被切在两个 chunk 中间，不加会出乱码。
- **Content-Type 写的是 `text/event-stream`，但 body 没有 `data:` 帧**。前端直接读 `res.body` 所以能用；若要换成标准 `EventSource`，需要在服务端加 `data: ` 前缀 + `\n\n` 分隔，并在客户端按事件解析。这是已知的不一致（README 限制章节也记了）。

---

## 6. 链路四：收词与去重

```
弹层「+」按钮
  │  onSave(aiStatus === "done" ? aiText : undefined)   ← AI 释义顺带存成 ai_gloss
  ▼
POST /api/words { word, textId, paragraphId, start, end, quote, prefix, suffix, aiGloss? }
  │
  ├ 校验 textId / paragraphId 存在（404 兜底）
  ├ lookup(word) → lemmaForm / phonetic / translation / pos
  │   translation 优先级：词典释义 > aiGloss 前 500 字 > "(待补充释义)"
  ├ db.transaction:
  │    ├ 按 lemma 查 user_words
  │    │    ├ 命中 → 更新（更好的 phonetic / translation 覆盖旧的）
  │    │    └ 未命中 → 插入
  │    └ 无条件 insert contexts（同一词不同位置 = 多条）
  └ 返回 { lemma, displayForm, translation }
  ▼
前端：setSavedSet(add lemma + displayForm) → 立即高亮 + celebrate("+1 词") + 进度条 +1
```

**幂等性**：重复收同一个词 → `user_words` 仍 1 行，`contexts` 多 1 行。这是设计意图（同一个词在不同文章里出现，每处上下文都值得保留），实测已验证。

**高亮**：`Para` 用 `savedLemmas.has(text.toLowerCase())` 判断。这里按**显示形式**匹配而非 lemma——因为前端不做词形还原（那是词典层的事）。所以收 `rained` 后，文章里的 `rain` 不会立刻高亮。接受这个精度损失，换取「前端零依赖」。

**删除**：`DELETE /api/words/{id}` 显式删 contexts 再删词（`onDelete: cascade` 在 better-sqlite3 下不一定触发，不赌）；带 `?contextId=` 时只删单条上下文。

---

## 7. 链路五：统计与游戏化

`lib/stats.ts` 一次查询拿全：

```sql
-- 文本数与总词数（texts 聚合）
-- 收词总数（user_words 计数）
-- 按天聚合（contexts join user_words，group by date(created_at/1000,'unixepoch','localtime')）
```

`created_at` 存 epoch 毫秒，转本地日期必须 `/1000` 再 `'localtime'`，否则跨时区会把今天算成昨天。

- **每日目标**：`max(20, round(wordCount * 0.05))` —— 读 400 词的文章目标 20 词，读 4000 词的目标 200 词。按文章长度自适应，避免短文本永远「完不成」。
- **streak**：从今天往回数连续有收集的天数（`stats/page.tsx` 内联计算）。
- **XP**：`todayCount * 10`，纯展示，没有经济系统。

游戏化只做**反馈**，不做**惩罚**：没有掉命、没有 streak 断签警告。这是产品判断（见 README 2.3），不是没做完。

---

## 8. 关键取舍与论证

### 8.1 为什么不用 `Intl.Segmenter`

它有中文分词、词边界更准，但**结果依赖运行环境的 ICU 版本**：Node 侧和 Chrome 侧可能切得不一样。SSR 渲染出的 DOM 结构与客户端 hydrate 时不一致 → React 19 直接丢弃整棵树重建（hydration mismatch），长文本下表现为闪烁、点击错位，甚至事件绑定失效。

现在用一条正则（`tokenize.ts` 的 `TOKEN_RE`），覆盖拉丁扩展（含带变音符号的 `\u00C0-\u024F`）、连字符/撇号复合词、以及 CJK 单字。**同一输入永远同一输出**，这是能在长文本上跑通的前提。

代价：中日韩按字切。要做中文阅读，必须换成一个纯 JS、跨环境确定性的分词器（如 `jieba-wasm` 固定词表版本）。

### 8.2 为什么 context 只用一句话，不用整段/整篇

| 级别 | token 成本 | 释义质量 | 结论 |
|---|---|---|---|
| 句子 | 1x | ⭐⭐⭐⭐ | ✅ 默认 |
| 段落 | 3–5x | ⭐⭐⭐⭐½ | ❌ 边际收益不值 |
| 全文 | 50–100x | ⭐⭐⭐⭐½ | ❌ 完全不值 |

一个句子已经是完整语义单元（搭配、语法角色、情境都在里面）。段落只在「代词指代」「跨句因果」这类场景有增量价值，而增量大约 5%、成本 +300%，还会拉高首字延迟——首字延迟直接杀死「点词即出」的手感。

Readlang 十年也选了同一档。真要补，正确做法是**追问时**把段落作为附加 context，而不是默认带。

### 8.3 为什么用 OpenAI SDK 调 DeepSeek

DeepSeek 官方文档第一句就是：API 格式兼容 OpenAI/Anthropic，改配置即可用 OpenAI SDK 访问。它自己没有独立的 Chat SDK。

我们只需要「发一次 chat completion，流式拿文本」——这就是个 HTTP 客户端的事。引入 LangChain / Vercel AI SDK / DeepSeek Harness 都属于用电梯送快递。

（顺带澄清一个易混点：**OpenAI SDK 不是 Agent Runtime**。它不跑 Agent Loop、不自动执行 tool call、不管多轮状态。我们当前的释义和未来的导墨墨都不需要 Agent Loop——都是「用户点按钮 → 确定性代码 → 拼参数调 API」。什么时候需要？当用户能用自然语言下复合指令时，比如「把我昨天读的文章里的动词都导出」。）

### 8.4 为什么 SQLite + 内联建表 SQL

- 单用户、单机、数据量在万级 → 任何服务端数据库都是过度设计。
- 备份 = `cp data/readflow.db`；迁移 = 拷两个文件。
- 不用 migration 框架：`CREATE TABLE IF NOT EXISTS` 内联在 `db/index.ts`，启动即建表，克隆下来 `npm run dev` 就能跑。

代价：schema 变更需要在 `schema.ts` 和 `SCHEMA_SQL` 两处同步改，且没有版本记录。表结构稳定前可以接受；一旦有真实用户数据，应切到 `drizzle-kit generate/migrate`。

### 8.5 为什么建表要重试

Next dev 热重载会让多个模块实例几乎同时求值 `db/index.ts`。`CREATE TABLE IF NOT EXISTS` 幂等，但**并发写会撞锁**。于是加 5 次指数退避重试（100/200/400/800ms）。

> 这段现在的退避用的是忙等 `while (Date.now() < until) {}`，会阻塞事件循环。正确写法是同步 sleep（`Atomics.wait`）或把初始化改成 lazy + async。属于「能用但不优雅」，改的时候注意别引入新的初始化竞态。

### 8.6 词典库与用户库分成两个文件

`data/dict/ecdict.db` 以 `readonly + query_only = ON` 打开，`data/readflow.db` 可写。

好处：词典是「可再生的大文件」（94MB，脚本 3 秒重建），用户数据是「不可再生的小文件」（64KB）。分开后可以单独备份/删除/替换，也不会因为词典写入把用户库锁住。

---

## 9. 踩坑记录

这些坑都真实踩过，写下来避免重复踩。

### 9.1 hydration 失败（长文）

**现象**：长文（1.3 万词）页面报 hydration mismatch，整棵树重建。
**原因**：`Intl.Segmenter` 在 Node 与 Chrome 上切分结果不同。
**修法**：换确定性正则分词（8.1）。

### 9.2 SQLite `disk I/O error`

**现象**：改代码后所有页面 500，报 `disk I/O error`；`-wal` / `-shm` 文件消失，磁盘空间充足。
**误判过程**：先怀疑 WAL 不被 sandbox 支持（实测可用）→ 再怀疑多进程并发写（实测并发写正常）→ 最后定位到 **Next dev 热重载累积的僵尸连接**，dev server 进程本身持有已损坏的连接。
**修法**：重启 dev server 即恢复。同时加了防御（都保留）：

- 连接挂 `globalThis.__readflowSqlite` 单例，热重载不新建连接；
- `busy_timeout = 10000`；
- 建表 SQL 退避重试；
- `synchronous = NORMAL`（WAL 下安全且快）。

**教训**：出现「之前好的、改完就挂、重启就好」的数据库错误，先怀疑 dev server 状态，再怀疑代码。

### 9.3 `http_proxy` 拦截 localhost

**现象**：Chrome CDP 连不上、Node `fetch('http://localhost:3000')` 502、脚本超时。
**原因**：本机设了 `http_proxy`，`localhost` 也被代理。
**修法**：`NO_PROXY=localhost,127.0.0.1`；curl 用 `--noproxy '*'`。写任何本地验证脚本时默认带上。

### 9.4 Chrome 156 的 `/json/new` 端点

**现象**：截图/自动化脚本创建 tab 失败。
**原因**：新版 Chrome 对该端点的方法/可用性有变化（PUT→GET，headless 下行为不同），程序化创建 target 更稳的方式是走 browser-level CDP 的 `Target.createTarget`。
**结论**：自动化优先用 `Target.createTarget` + 页面自己的 WebSocket（Node 22+ 内置 `WebSocket`，不用引 ws 库）。

### 9.5 弹层被视口截断

**现象**：点击页面上方的词，弹层往上翻时标题栏被切掉。
**原因**：只处理了「下方空间不够」，没处理「上方空间也不够」；且用 `bottom` 定位时高度自适应无法预先计算。
**修法**：去掉 `bottom`，统一 `top + maxHeight` 的纯 CSS 约束（4.5）。

### 9.6 按钮过大挤占内容

**现象**：两个 49px 高的大按钮吃掉 110px，弹层里 AI 长文本几乎没地方显示。
**修法**：收词降级为标题栏 30×30 图标按钮；AI 按钮进固定底栏；新增 `.duo-btn-sm`（padding 7×12、字号 13、圆角 10）。总高 430 → 317px。

### 9.7 `next dev` 页面没 hydrate，交互验证全是假阴性

**现象**：结构化导入改造后，用 Playwright 在 `next dev`（3100）点词，右栏始终停在空态。给 `.reading-body` 挂原生 `click` 监听能收到事件（target 是 `.w`、`closest("[data-pid]")` 也有值），但 React 的 `onClick` 完全不执行。普通段落与表格 cell 表现一致，控制台没有 JS 报错——很容易误判成「表格渲染破坏了点词委托」。

**排查（控制变量）**：在同一台机器上对比两个端口，检查元素上是否有 React 挂的 `__reactProps$*` / `__reactFiber$*` 键：

| 端口 | 运行方式 | `__reactProps` |
|---|---|---|
| 3100 | `next dev` | `[]`（未 hydrate） |
| 3000 | `next start`（生产构建） | 有 |

dev 控制台同时刷 `ws://127.0.0.1:3100/_next/hmr` 握手失败 `ERR_INVALID_HTTP_RESPONSE`。给 Chromium 加 `--no-proxy-server` 仍不恢复，说明是这台机器上 dev HMR 通道的问题，**不是交互代码的回归**。

**结论 / 验证纪律**：

1. 判断 hydration 是否完成，看 `__reactProps$*` 键，不要靠「等固定 1–2 秒」。
2. **SSR 结构、API、单元与离线解析可以在 dev 跑；交互级验证必须在 `npm run build && bash scripts/service.sh restart` 之后、对生产 3000 跑。**
3. 任何「点击没反应」的结论，先拿普通段落做对照，再怀疑新代码。

---

## 10. Readlang 逆向结论

从它的 `app.js` 与官方博客整理，作为我们设计的参照系。

### 10.1 接口

| 层 | 接口 | 参数 | 返回 |
|---|---|---|---|
| 1. Translate | `POST /api/translate` | `{source, target, q, context}` | `{translations: []}` |
| 2. Context Translation | 同上（服务端切换） | 同上，`context` 为整句 | 同上 |
| 3. Explain | `GET /api/smartDictionary` | `query, context, language, explanationLanguage` | **SSE 纯文本流** |
| 3b. Ask AI | `GET /api/smartDictionary/askAI` | `language, word, context, prompt` | 纯文本 |

细节：

- `context` 不是可选参数，每次调用都带，值是**点击位置所在的那一句**。
- Explain 的 `explanationLanguage` 双模式：`showInFirstLanguage ? 用户母语 : 目标语言` —— 后者就是「用英语解释英语」。
- 状态码语义：`204` = 该词已有缓存（dismissed），`403` = 触发限额。免费版每天 10 次 Explain。
- 缓存：内存 `RA(key)` 读 / `LA(key, result)` 写；`cacheOnly: true` 只查缓存（词库页回看用）。
- 模型分层：Premium 用 GPT-4o mini，Premium Plus 用 GPT-4o。

### 10.2 卡片体系（博客《The Readlang Method for Learning Vocab》）

只有两种练习形式，但它们是**同一张卡的两个阶段**：

| 模式 | 正面 | 回忆目标 |
|---|---|---|
| Passive | 目标语言词 + 上下文句 | 母语释义 |
| Active | 上下文句**挖空** + 释义 | 原词 / 短语 |

流程：抽高频词 → Passive 答对 → 翻成 Active（cloze）→ Active 也答对才移出牌组 → 全部完成显示各词下次复习日期。

**没有选择题、没有匹配题。**

### 10.3 我们与它的差异

| 行为 | Readlang | 我们 | 理由 |
|---|---|---|---|
| 第一反应 | Translate API | ECDICT 本地词典 | 免费、<5ms、只做中→英所以词典够用 |
| 词典不够 | 用户点 Explain | 用户点「AI 解释」 | 同为显式升级 |
| AI 解释 | SSE，可目标语言/母语 | 同 | 保留 monolingual |
| 整句/短语 | Translate API | 直接 AI | 词典查不了短语 |
| Ask AI | 独立输入框 | 独立输入框 | 可追问 |
| 卡片类型 | 2 种（问答 + cloze） | 3 种（+选择题） | 墨墨原生支持选择题，是超额能力 |

关键判断：Readlang 不做本地词典是因为它要覆盖 119 种语言对，没有词典能全覆盖；我们只做中→英，77 万词条的 ECDICT 白捡，能省掉约 80% 的 AI 调用。**架构照抄，成本结构按自己的场景优化。**

---

## 11. 链路六：导出墨墨记忆卡

### 11.1 墨墨开放 API 的真实边界（推翻了原设计）

最初的设计是「我们建章节，逐张塞卡」。实测发现这条路走不通 —— **开放 API 只能写卡片和媒体**：

| 想做的事 | 能不能做 | 后果 |
|---|---|---|
| 建 / 改 / 删 **牌组** | ❌ | 牌组必须在 App 或网页端手工建 |
| 建 / 改 / 删 **章节** | ❌ | 章节也必须手工建 |
| 删 **卡片** | ❌ | 推错的卡片只能在 App 里手删 |
| 建卡片 | ✅ | 只能追加到已有章节 |

所以设计从「我们负责建结构」改成了「**用户选结构，我们只负责写**」：导出页做成「牌组下拉 → 章节下拉 → 选卡片类型 → 预览 → 写入」。

另外两个实测坑（写错会直接 4xx）：

- **创建卡片的请求体必须省略 `deck` / `chapter`**。文档标它们必填，但服务端按 24 位 ObjectId 校验，而开放 API 从不暴露 ObjectId → 传了必报 `not a valid ObjectId`。牌组和章节由 URL 路径决定。
- **不要传 `order`**。它是相对整个章节的 0 基插入索引；往非空章节从 0 递增会把新卡全插到旧卡前面。省略即按提交顺序追加到末尾。

### 11.2 三种卡片

| 卡片 | 正面 | 背面 | 语法要点 |
|---|---|---|---|
| `qa` 看词猜义（≈ Passive） | 词 + 音标 + 出处 + 原句（词标蓝） | 释义（首行红、其余灰） | `[P#H1,center#…]` 标题 + `---` 答案线 |
| `cloze` 挖空填空（≈ Active） | 原句挖空 + 释义提示 | 原词 + 释义 | 句中 `[F#1#word]` |
| `choice` 选择题（Readlang 没有） | 原句挖空 + 4 个候选词 | 答案 + 释义 | `[Choice##` + `* `/`- ` 选项 + 独占一行的 `]` |

三种都是**确定性拼装**：词、音标、释义、原句全部来自数据库，干扰项来自 ECDICT，**不经过 AI**。

### 11.3 原句从哪来（别用 40 字符的前后文）

`contexts` 只存了 `prefix/suffix` 各 40 字符 —— 长句会被截断成半句，卡片正面就废了。所以导出时回到 `paragraphs.content` 重新定位：

```
resolveAnchor(段落原文, {start, end, quote, prefix, suffix})   ← 三级降级定位
  → 命中：sentenceAround(段落原文, s, e)                       ← 按 . ! ? 向两侧扩成整句
  → 未命中：这个词直接标失败，不生成卡（宁缺，不要做出一张引用了错句子的卡）
```

`sentenceAround` 同时返回目标词在句内的偏移，供模板精确地「把词包起来 / 替换成空格」——不能靠 `replace(word, ...)` 字符串替换，一个词在一句里出现两次就会替换错位置。

### 11.4 卡片语法是最容易翻车的地方

Markji 语法写错**不会报错**，只会静默渲染成一团乱码，而且卡片删不掉。所以做了两道闸：

**第一道：`cardgen.ts` 里的 `lintCard()`（发送前）**

- 有且只有一条 `---`（答案线）
- 方括号配对（跳过 `\[` 转义）
- 没有残留 Markdown 强调标记、代码围栏或 HTML 标签
- `[P#…]` / `[Choice#…]` / `[E##…]` 这类块级标签必须顶格

**第二道：写库前人工看预览**

`POST /api/export { dryRun: true }` 返回真正要发送的原始语法全文，页面用 `<pre>` 摊开。

开发期间还有第三道：`npm run verify:cards` 会把生成的卡片写到 `/tmp/cards`，可以逐张过 `markji.py lint`（官方语法校验器）。实测 9 张全部通过。

最容易踩的三个具体坑：

1. **ECDICT 的释义用字面量 `\n`（反斜杠 + n）分隔多行**，不是真实换行。不还原会渲染出 `n. 夜\n[法] 夜` 这种东西 → `lib/text.ts` 的 `normalizeTranslation()`。
2. **释义里有中括号**（`[医] 库`、`[法] 夜`），普通文字里的 `[` `]` 必须转义成 `\[` `\]`，否则提前闭合外层标签 → `esc()`。
3. **干扰项不能纯随机**。77 万词条里随机抽会抽到 `piasters` / `batisse` 这种，选项一眼假。用 `frq`（COCA 词频排名）过滤出常用词，再按「同词性 + 长度 ±2」筛。

### 11.5 幂等：不是防御性编程，是唯一的安全网

墨墨没有删除接口，重复推送 = 往牌组里堆垃圾且无法清理。所以幂等做在数据库层，而不是靠调用方的 if：

```
exports 唯一索引 (user_word_id, deck_id, card_type)
   ↓
推送前：查出该牌组内所有 status=done 的键 → 命中即 skipped
推送后：insert ... onConflictDoUpdate → done + card_id + pushed_at
失败：  → failed + error（下次可重试，因为不是 done）
```

`card_type` 是后加的列 —— 老库（`exports` 只有 word+deck 唯一键）由 `db/index.ts` 的 `migrate()` 补列并重建索引，可重复执行。

### 11.6 限速与配额

```
createCard() 内部串行闸门：writeChain.then(() => sleep(600ms) → fetch)
```
600ms 对应「10 秒 20 次」的硬上限（500ms 理论值留了余量）。另外按天计数封顶 600 条，超了就在结果里逐条标失败并提示明天继续。

**串行而不是并发**是有意的：并发抢频控会得到 429，重试还会打乱顺序；串行虽然慢（3 张卡 ≈ 2 秒），但结果可预测。

### 11.7 一个词的失败不应该拖垮整批

错误分两类处理：

- **5xx / 网络抖动** → 记 `failed`，继续下一个词（下次可重试）
- **4xx（401 令牌失效、400 参数错）** → 立刻停止整批并返回错误。继续跑只会刷出一堆同样的失败记录，还白占配额。

---

## 12. 验证方法

现在有四层：单测与类型检查、离线验证、API/SSR 回归、真实浏览器交互。改完代码至少跑第一层。

### 12.1 单测与类型检查

```bash
npm run typecheck   # tsc --noEmit，必须零错误
npm test            # tsc -p tsconfig.unit.json + node --test .unit/tests/unit/*.test.js
```

单测覆盖 CEFR 与结构化导入，都用**控制变量**锁性质：`src/lib/cefr.ts` 里只改词汇难度时复杂度分必须不动；`tests/unit/import.test.ts` 里 `A **bold** word.` 与 `A bold word.` 的可见文本必须完全相同、`# Title` 与 `## Title` 亦然，且所有 inline range 不越界、`parsePlain()` 与 `splitParagraphs()` 逐字一致。

### 12.2 离线验证卡片（P4 之后新增）

```bash
npm run verify:cards      # 收词 → 生成三种卡片 → 语法自检 → 输出到 /tmp/cards
npm run verify:markji     # 用自研客户端只读列牌组/章节，验证鉴权与信封解析
```

`verify:cards` 走的是真实的 DB 数据与真实模板，跑完可以再逐张过官方校验器：

```bash
python3 ~/.workbuddy/skills/markji/scripts/markji.py lint /tmp/cards/xxx-qa.txt
```

这样即使不启动 dev server、不写入墨墨，也能确认模板语法合法。

### 12.3 API 级回归（curl，注意绕代理）

```bash
curl -s --noproxy '*' "http://localhost:3000/api/dict?word=went"     # 期望 lemmaForm: "go"
curl -s --noproxy '*' "http://localhost:3000/api/dict?word=bank"     # 期望多义项
curl -s --noproxy '*' "http://localhost:3000/api/dict?word=river%20bank"  # 期望 entry: null
curl -s --noproxy '*' "http://localhost:3000/api/explain?word=bank&context=..."  # 无 key 时应返回提示文案
curl -s --noproxy '*' "http://localhost:3000/api/export"             # 导出状态：tokenReady / 各类计数
curl -s --noproxy '*' "http://localhost:3000/api/markji/decks"       # 牌组列表（token 有效时）
curl -s --noproxy '*' -X POST http://localhost:3000/api/export \
  -H 'content-type: application/json' \
  -d '{"types":["qa","cloze","choice"],"dryRun":true}'               # 只看卡片原文，不写入
for p in / /words /export /stats /texts/<id>; do curl -s -o /dev/null -w "$p %{http_code}\n" --noproxy '*' "http://localhost:3000$p"; done
```

收词幂等的验证：同一个词 POST 两次，然后查 `user_words` 应为 1 行、`contexts` 应为 2 行。
导出幂等的验证：同一批 dryRun 后再 dryRun，第二次 `summary.skipped` 应等于上次的 `pushed`。

### 12.4 交互级（CDP 驱动真实 Chrome）

启动带调试端口的 Chrome，用 `Target.createTarget` 开页，`Runtime.evaluate` 里直接点 `.w` 元素、读弹层 DOM 尺寸：

```
点击 .w → 弹层出现 → 标题为词 → 收词按钮存在
点收词 → 进度条 0/20 → 1/20 → 文案「再收集 19 个」→「+1 词」飘出
注入超长文本到 AI 区 → overflowsViewport === false
```

**经验**：小窗口下 `vh` 可能只有 469px，弹层 `maxHeight` 的实测值会跟着变——验证时要打印 `vh`、`top`、`clientHeight`，不要只看截图。

**注意**：Next 16 dev 启动时会清理 `.next/dev/logs`，如果进程被限制删除（沙箱、只读盘），dev server 会直接退出，报 `safe-delete broker denied delete`。这种情况下要换个终端/不受限的环境启动，而不是改代码。

### 12.5 结构化导入专项（P9）

改 `src/lib/import/**`、`Reader.tsx` 的渲染分组、或 `globals.css` 的 `.rf-*` 样式时，按这个顺序验：

```bash
npm test                       # 21 个 import 单测 + CEFR / 锚点 / 卡片单测
npm run typecheck
tsc -p tsconfig.verify.json    # 离线脚本的 CommonJS 编译链（别把 src/db/index.ts 拉进来）
```

再拿真实源做离线解析（`https://code.claude.com/docs/en/best-practices.md`，52KB / 635 行，含 GFM 表格、MDX info string、callout、空锚点链接、`llms.txt` 隐藏块），核对四个数：**306 个 Block**、**range 越界 0**、**可见文本残留 Markdown 标记 0**、**prose parts 290**。HTML 路径用抓下来的原始页面核对 table_cell / code / list_item 数量与 Markdown 路径对齐。

API / SSR 回归（可在 dev 跑）与交互验证（**必须在生产 3000 跑，见 9.7**）清单：

| 检查 | 期望 |
|---|---|
| `POST /api/texts` 粘贴官方 Markdown | `sourceFormat: "markdown"`，`blockKinds` 含 40 table_cell / 15 code / ≥100 list_item |
| `GET /api/texts/{id}` | `inlineRanges` 全部 `0 ≤ start < end ≤ content.length`；非 code 段落不以标题、表格、引用或代码围栏标记开头 |
| SSR HTML | 含 `rf-table` / `<thead` / `rf-pre` / `<pre` / `rf-h2` / `rf-callout` / `rf-list` / `rf-inline-link`，且不含 `\| :- \|` |
| 浏览器 DOM | 3 张 `<table>`、15 个 `<pre>`（10 个多行）、19 个 callout、306 个 `data-pid`，`pre .w === 0` |
| 表格 cell 内点词 → 收词 | `content.slice(start, end) === quote`，右栏出释义卡 |
| `/api/export` dryRun | 卡片正文不含强调标记、代码围栏等 Markdown 残留 |
| 纯文本导入 | `sourceFormat: "plain"`，全部 `blockType === "paragraph"` |
| URL 导入 | `text.sourceFormat === "markdown"` 且 `sourceRaw` 含标题 —— 证明走了官方 `.md` |
| 旧文章 | 仍能打开，`block_type` 默认 `paragraph`，原有锚点有效 |

所有 E2E 脚本都在 `finally` 里删掉自己创建的文本与词，不污染用户库。

---

### 12.6 真实写卡（不可逆，只在用户明确同意后跑）

```bash
npm run push:one -- list                                   # 列牌组/章节（只读）
npm run push:one -- push <词> qa <deckId> <chapterId> --dry # 只打印全文，不写
npm run push:one -- push <词> qa <deckId> <chapterId>       # 真写一张
```

`scripts/push-one.ts` 复用 `buildCard` / `lintCard` / `createCard`，和 `/api/export` 走同一套逻辑，
只是把取数写短。它存在的原因是：某些受限环境里 dev server 起不来（Next 启动时要删
`.next/dev/cache/**/*.del`，会被安全策略拒绝），但「墨墨到底收不收这张卡」只能用真实请求验证。

写之前的闸门和路由一致：语法自检不过不写、`exports` 里已有 `done` 记录就直接拒绝
（除非 `--force`）。**墨墨没有删除端点，写错只能去 App 里手删**，所以这两道闸门不能省。

```bash
# 改了词典规则或卡片版式之后，把已经推上去的卡一起修好
npm run push:one -- retouch <词> <qa|cloze|choice> <deckId>
```

`retouch` 从 `exports` 查回 card_id，按当前数据重新生成全文，再走更新接口
**全量替换**（更新接口和 create 不同：请求体要带 deck_id/card_id，且 content 是替换不是补丁）。
内容没变就直接跳过。

已验证过的结果（2026-11-02）：写入后 `GET /decks/{deck}/cards/{card}` 回读的 content
与提交内容逐字一致，`grammar_version` 为 3，章节卡片数 +1。

## 13. 代码地图与改动指引

| 想改什么 | 改哪里 | 注意 |
|---|---|---|
| 换 AI 供应商 | `lib/ai.ts` 的 `getClient()`（baseURL/apiKey/model） | 保持 OpenAI 兼容即可，其余不用动 |
| 改 prompt | `lib/ai.ts` 的 `buildSystemPrompt` / `buildUserMessage` | monolingual 分支和 prompt 分支要同步 |
| 加词典字段 | `lib/dict.ts` 的 SELECT + `DictEntry` + `Reader.tsx` 的 `DictView` | 三处同步 |
| 改分词规则 | `lib/tokenize.ts` 的 `TOKEN_RE` | 必须保持确定性（不能依赖环境） |
| 改切段规则 | `lib/split.ts` | ⚠️ 会让历史锚点失效，先读 3.2 |
| 改卡片版式 | `lib/cardgen.ts` 的 `buildQaCard` / `buildClozeCard` / `buildChoiceCard` | 改完必须跑 `npm run verify:cards` + 官方 lint |
| 加卡片类型 | `CARD_TYPES` 数组 + `buildCard()` 分支 + `exports.card_type` 取值 | 幂等键含 card_type，新类型天然不冲突 |
| 换卡片样式参数 | `cardgen.ts` 顶部的 `GREY` / `RED` / `BLUE` | 颜色是不带 `#` 的 6 位小写十六进制 |
| 加页面 | `src/app/<route>/page.tsx` + `duo-card` 等现成类 | 记得挂进 `layout.tsx` 与 `BottomNav.tsx` |
| 改视觉 | `src/app/globals.css` 的 CSS 变量 + `.duo-*` 类 | 颜色改变量，别硬编码 |
| 加表/字段 | `db/schema.ts` **和** `db/index.ts` 的 `SCHEMA_SQL` + `migrate()` | 三处必须一致（8.4 / 11.5） |
| 改词典还原规则 | `lib/dict.ts` 的 `lemma()` / `lookup()` | 改完跑 `npm run backfill:lemma`，否则历史数据是旧规则 |
| 改音标显示 | `lib/text.ts` 的 `normalizePhonetic()` | ECDICT 用 `'`/`,` 表示重音，别再把它当普通标点 |

### 建议优先修的三件事

1. `explain` 的 SSE 帧格式（5.4）——现在能用但是「假 SSE」，早晚要接标准事件流。
2. `db/index.ts` 的忙等退避（8.5）——阻塞事件循环，改动小、收益明确。
3. 导出改成后台任务（11.6）——现在是同步串行，词一多请求就长；应该有 job 表 + 进度轮询。

（`lookup()` 的 lemma 判断已于 2026-11-02 修掉，见 2.3。）
