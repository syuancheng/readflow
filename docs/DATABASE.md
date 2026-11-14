# ReadFlow 数据存储总览

> 整理时间：2026-11-14。字段以本机真实数据库 `data/readflow.db` 的实际表结构为准（`PRAGMA table_info`），不是照抄代码。
> 示例行取自本机真实数据，**密钥、密码哈希、手机号、Token 已脱敏**；很长的文字截断后用 `…` 表示。
> 时间字段都是**毫秒时间戳**（例如 `1794619336977` = 2026-11-14 09:22）。
> 布尔值用整数 `0 / 1` 存。

## 一览

| 存储 | 类型 | 位置 | 说明 |
|---|---|---|---|
| 主库 `readflow.db` | 关系型（SQLite） | `data/readflow.db` | 17 张表，见第 1 部分（2026-11-14 从 20 张整理而来） |
| 词典库 `ecdict.db` | 关系型（SQLite），只读 | `data/dict/ecdict.db` | 1 张表，见第 2 部分 |
| `settings` 表 | 关系型表，但用法是 KV | 主库内 | 见第 3.1 节 |
| 服务端进程内存 | KV（JavaScript `Map`），重启即清空 | Node 进程 | 见第 3.2 节 |
| 图片缓存 | KV（文件） | `data/img-cache/` | 见第 3.3 节 |
| 浏览器 localStorage | KV | 用户浏览器 | 见第 3.4 节 |
| 浏览器插件存储 | KV（`chrome.storage`） | 用户浏览器插件 | 见第 3.5 节 |

`users.id` 是所有「属于某个用户」的数据的归属键。`user_id = 'local'` 是一个哨兵值，表示「站级 / 主账号的默认配置」，**不是任何账号的 id**。

---

## 1. 主库 `data/readflow.db`

按业务分组：账号 → 文章 → 词库与批注 → 学习档案 → 做卡与推送 → 每日次数。

### 1.1 账号

#### `users` 账号（本机 1 行）

| 列 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| id | TEXT 主键 | | | 账号 id（UUID） |
| username | TEXT | 是 | | 登录用户名 |
| password_hash | TEXT | 是 | | 密码哈希（scrypt），不存明文 |
| display_name | TEXT | | | 显示名 |
| is_owner | INTEGER | 是 | 0 | 1 = 主账号（站长） |
| created_at | INTEGER | 是 | | 注册时间 |
| phone | TEXT | | | 手机号（唯一） |
| invite_code | TEXT | | | 注册时用的邀请码；主账号为空 |

索引：`phone` 唯一。

示例：
| id | username | password_hash | display_name | is_owner | created_at | phone | invite_code |
|---|---|---|---|---|---|---|---|
| f6905e4a-… | syuan | scrypt$1c7…（脱敏） | syuan | 1 | 1794277706824 | 177****7917 | （空） |

#### `sessions` 登录会话（1 行）

| 列 | 类型 | 必填 | 说明 |
|---|---|---|---|
| token_hash | TEXT 主键 | | 会话 Cookie 的哈希（浏览器里存的是原值，库里只存哈希） |
| user_id | TEXT | 是 | 属于哪个账号 |
| expires_at | INTEGER | 是 | 过期时间 |
| created_at | INTEGER | 是 | 登录时间 |

示例：`14b25bb6…（脱敏） | f6905e4a-… | 1796980234770（2026-12-11 过期） | 1794388234770`

#### `invites` 邀请码（3 行）

| 列 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| code | TEXT 主键 | | | 邀请码，如 `CY8P-PXF4` |
| created_by | TEXT | 是 | | 谁生成的（账号 id） |
| note | TEXT | | | 备注（给谁的） |
| max_uses | INTEGER | 是 | 1 | 最多能用几次 |
| used_count | INTEGER | 是 | 0 | 已用几次 |
| revoked | INTEGER | 是 | 0 | 1 = 已作废 |
| created_at | INTEGER | 是 | | 生成时间 |

示例：`CY8P-PXF4 | f6905e4a-… | 202舍友 | 1 | 0 | 1 | 1794388253800`

#### `extension_tokens` 浏览器插件 Token（1 行，每个账号最多 1 个）

| 列 | 类型 | 必填 | 说明 |
|---|---|---|---|
| user_id | TEXT 主键 | | 账号 id |
| token_hash | TEXT | 是 | Token 的哈希（明文只在生成那一次显示） |
| token_hint | TEXT | 是 | Token 末 4 位，设置页展示用 |
| created_at | INTEGER | 是 | 生成时间 |
| last_used_at | INTEGER | | 插件最近一次使用时间 |

示例：`f6905e4a-… | f7a3c764…（脱敏） | Nyrd | 1794447662474 | 1794450680406`

### 1.2 文章

#### `texts` 文章（5 行）

| 列 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| id | TEXT 主键 | | | 文章 id |
| user_id | TEXT | 是 | 'local' | 属于哪个账号 |
| title | TEXT | 是 | | 标题 |
| source_type | TEXT | 是 | | 来源：`paste` 粘贴 / `file` 文件 / `url` 网址 / `web` 插件摘录 |
| source_url | TEXT | | | 原网址 |
| language | TEXT | 是 | 'en' | 语言 |
| word_count | INTEGER | 是 | 0 | 词数 |
| created_at | INTEGER | 是 | | 导入时间 |
| cefr_level | TEXT | | | 难度等级，如 `B2` |
| cefr_score | REAL | | | 难度分数 |
| cefr_detail | TEXT | | | 难度计算明细（JSON） |
| cefr_method | TEXT | | | 难度算法版本，如 `heuristic-v1` |
| cefr_overridden | INTEGER | 是 | 0 | 1 = 用户手动改过难度 |
| source_format | TEXT | 是 | 'plain' | 原文格式：`plain` / `markdown` / `html` |
| source_raw | TEXT | | | 原文全文（重新解析用） |
| category | TEXT | | | 分类，如「技术文档」 |
| read_idx | INTEGER | | | 读到第几段 |
| read_ratio | REAL | | | 阅读进度 0–1 |
| completed_at | INTEGER | | | 标记「已读完」的时间；空 = 没标 |

示例：
| id | user_id | title | source_type | source_url | word_count | cefr_level | cefr_score | cefr_method | source_format | category | read_idx | read_ratio |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| d8a24a5a-… | f6905e4a-… | When AI builds itself | url | https://www.anthropic.com/institute/recursive-self-improveme… | 5127 | B2 | 51.32 | heuristic-v1 | html | 技术文档 | 2 | 0.0 |

（其余：language=en，created_at=1794060755516，cefr_overridden=0，source_raw 长 43895 字，completed_at 空）

#### `paragraphs` 段落（623 行）

| 列 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| id | TEXT 主键 | | | 段落 id |
| text_id | TEXT | 是 | | 属于哪篇文章 |
| idx | INTEGER | 是 | | 第几段（从 0 开始） |
| content | TEXT | 是 | | 段落纯文本，也是批注坐标 `start/end` 的基准 |
| block_type | TEXT | 是 | 'paragraph' | 块类型：`paragraph` 段落 / `heading` 标题 / `list_item` 列表项 / `quote` 引用 / `code` 代码 / `figure` 图片 / `math` 公式 / `table_cell` 表格单元格 / `hr` 分隔线 |
| block_meta | TEXT | | | 块的附加信息（JSON，例如标题级别、图片地址） |
| inline_ranges | TEXT | | | 行内样式区间（JSON：加粗、链接、行内代码的位置） |

索引：`(text_id, idx)`。

示例：`eec7023e-… | d8a24a5a-… | 0 | For most of AI's history, humans drove every step in its development cycle. But… | paragraph | {} | []`

#### `section_summaries` 分段小结（0 行）

| 列 | 类型 | 必填 | 说明 |
|---|---|---|---|
| id | TEXT 主键 | | |
| text_id | TEXT | 是 | 哪篇文章 |
| start_idx | INTEGER | 是 | 从第几段 |
| end_idx | INTEGER | 是 | 到第几段 |
| content | TEXT | 是 | AI 写的小结 |
| created_at | INTEGER | 是 | |

索引：`(text_id, end_idx)` 唯一。本机还没有数据，示例略。

### 1.3 词库与批注

#### `user_words` 词库里的词（43 行）

| 列 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| id | TEXT 主键 | | | 词条 id |
| user_id | TEXT | 是 | 'local' | 属于哪个账号 |
| lemma | TEXT | 是 | | 词形还原后的原形（`running` → `run`），同一账号内唯一 |
| display_form | TEXT | 是 | | 第一次查到时的样子 |
| pos | TEXT | | | 词性 |
| phonetic | TEXT | | | 音标 |
| translation | TEXT | 是 | | 词典释义（来自 ECDICT） |
| note | TEXT | | | 用户备注 |
| created_at | INTEGER | 是 | | 第一次收词时间 |
| status | TEXT | 是 | 'learning' | 学习状态（现在只用 `learning`） |
| starred | INTEGER | 是 | 0 | 1 = 星标 |
| is_phrase | INTEGER | 是 | 0 | 1 = 短语 |

索引：`(user_id, lemma)` 唯一。

示例：`7b98f9e9-… | f6905e4a-… | functionality | functionality | （空） | ,fʌŋkәʃә'næliti | [计] 功能性, 泛函性\n[化] 官能度 | （空） | 1794619272119 | learning | 0 | 0`

#### `contexts` 批注：词在某篇文章某一处的记录（44 行）

一个词在不同文章、不同位置查过，就有多条批注。**AI 讲解的原文就存在这里的 `ai_gloss`**。

| 列 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| id | TEXT 主键 | | | 批注 id（前端叫 contextId） |
| user_word_id | TEXT | 是 | | 属于哪个词条 |
| text_id | TEXT | 是 | | 哪篇文章 |
| paragraph_id | TEXT | 是 | | 哪一段 |
| start / end | INTEGER | 是 | | 在段落文本里的字符位置 |
| quote | TEXT | 是 | | 选中的原文 |
| prefix / suffix | TEXT | 是 | | 选区前后的文字（定位用，也用来拼整句） |
| ai_gloss | TEXT | | | **这处批注的整段 AI 对话**：第一次讲解 + 每次追问，按顺序拼在一起，追问以 `【追问】问题` 开头一行分隔。不含每段回答的 id |
| created_at | INTEGER | 是 | | 查词时间 |
| dict_entry | TEXT | | | 查词当时的词典结果快照（JSON），回看时直接用 |
| via | TEXT | 是 | 'reader' | `reader` 阅读页 / `extension` 插件 |

索引：`user_word_id`、`paragraph_id`。

示例：
| id | user_word_id | text_id | paragraph_id | start | end | quote | prefix | suffix | ai_gloss | via |
|---|---|---|---|---|---|---|---|---|---|---|
| 19581895-… | 7b98f9e9-… | d40bb21d-… | a7a74c2e-… | 339 | 352 | functionality | Over the past few months, Claude Code ha… | I have no use for. | 释义：功能⏎⏎这里指软件提供的各种功能、特性，不是「功能性」这种抽象性质。…（⏎ 表示换行） | reader |

（created_at=1794619272119；dict_entry=`{"entry":{"word":"functionality","phonetic":…}}`）

#### `exports` 导出 / 推送到卡片应用的记录（0 行）

| 列 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| id | TEXT 主键 | | | |
| user_word_id | TEXT | 是 | | 哪个词 |
| target | TEXT | 是 | 'markji' | 推到哪个应用 |
| deck_id | TEXT | 是 | | 墨墨牌组 |
| chapter_id | TEXT | | | 墨墨章节 |
| card_id | TEXT | | | 墨墨里的卡片 id |
| card_type | TEXT | 是 | 'qa' | 卡型。旧导出：`qa` / `cloze` / `choice`；P33 起：`exam:<cards.id>`（一个词多张卡靠它区分） |
| status | TEXT | 是 | 'pending' | `done` 成功 / `failed` 失败 |
| error | TEXT | | | 失败原因 |
| pushed_at | INTEGER | | | 推送成功时间 |

索引：`(user_word_id, target, deck_id, card_type)` 唯一。词库里的「已导出」就是看这张表。本机还没推过，示例（构造）：
`a1b2… | 7b98f9e9-… | markji | mkjd_… | mkjch_… | mc-123 | exam:6233a8ab-… | done | （空） | 1794620000000`

### 1.4 学习档案（P32 个性化讲解）

#### `learner_profiles` 学习档案（1 行，每个账号 1 行）

| 列 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| user_id | TEXT 主键 | | | 账号 id |
| survey | TEXT | | | 问卷答案（JSON） |
| survey_completed_at | INTEGER | | | 提交问卷的时间 |
| survey_dismissed_at | INTEGER | | | 点「以后再说」的时间 |
| show_feedback | INTEGER | 是 | 1 | 讲解下方是否显示「太浅 / 刚好 / 太深」 |
| stats | TEXT | | | 行为推断结果缓存（JSON：查词数、词汇量、难点、追问率、反馈次数） |
| stats_updated_at | INTEGER | | | 推断缓存时间；超过 6 小时重算 |
| note | TEXT | | | 老师笔记全文（≤300 字） |
| note_updated_at | INTEGER | | | 笔记更新时间 |
| note_user_edited | INTEGER | 是 | 0 | 1 = 用户手动改过笔记 |
| note_lookup_cursor | INTEGER | 是 | 0 | 上次更新笔记时的查词总数（「再查 25 次」从这里数） |
| note_last_error | TEXT | | | 上次生成笔记失败的原因 |
| memory_reset_at | INTEGER | 是 | 0 | 「清空 AI 记忆」的时间；之前的事件不再计入 |
| updated_at | INTEGER | 是 | | |

示例：
- survey：`{"identity":"work_3_10","exam":"cet6","readingFeel":"few_per_paragraph","stylePref":"balanced","goals":["tech","work"],"examScore":"cet_425_499"}`
- stats：`{"lookups":18,"vocab":null,"cefr":null,"typicalTextCefr":"B2","difficulties":[],"followupRate":null,"feedback":{"shallow":2,"right":2,"deep":0}}`
- note：`该生近期查词较频繁，以单词为主，也涉及短语，常在同一句内反复查询……`
- 其余：show_feedback=1，note_user_edited=0，note_lookup_cursor=26，memory_reset_at=0

#### `explain_events` 查词 / 讲解事件（42 行）

每次**查词**记一条 `lookup`，每次**请 AI 讲解**记一条 `explain`。`explain` 这条的 id 就是「这段回答」的 id（前端叫 answerId），反馈写在这一行上。**这张表不存 AI 回答的原文**。

| 列 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| id | TEXT 主键 | | | 事件 id；对 `explain` 来说就是 answerId |
| user_id | TEXT | 是 | | 账号 id |
| kind | TEXT | 是 | | `lookup` 查词 / `explain` 讲解 |
| ask_kind | TEXT | | | 讲解的种类（仅 explain）：`auto` 词典查不到时自动讲 / `default` 这个词在这句里什么意思 / `word_only` 只讲这个词 / `whole_sentence` 整句没看懂 / `structure` 句子结构 / `example` 再给个例句 / `custom` 自己写的问题 |
| via | TEXT | 是 | 'reader' | `reader` / `extension` |
| word | TEXT | | | 选中的文字 |
| lemma | TEXT | | | 原形（目前只有 lookup 会填；本机 16 条 explain 全为空） |
| freq_rank | INTEGER | | | 词频排名（lookup 填，用于推断词汇量） |
| is_phrase | INTEGER | 是 | 0 | 是否短语 |
| dict_hit | INTEGER | | | 词典是否收录 |
| repeat_count | INTEGER | | | 同一句里第几次请教 |
| text_id | TEXT | | | 哪篇文章（lookup 填；本机 16 条 explain 全为空） |
| text_cefr | TEXT | | | 那篇文章的难度 |
| context_id | TEXT | | | 对应哪条批注（`contexts.id`）。lookup 都有；**本机 16 条 explain 里只有 2 条有** |
| feedback | TEXT | | | 「太浅 / 刚好 / 太深」：`shallow` / `right` / `deep`，改选会覆盖 |
| feedback_at | INTEGER | | | 点反馈的时间 |
| created_at | INTEGER | 是 | | 事件时间（explain 在**请求开始**时就写，讲解失败或被打断也会有这一条） |
| carded_before | INTEGER | | | P33：当时这个词是否已有推送成功的卡片 |

索引：`(user_id, created_at)`。

示例（explain）：
| id | user_id | kind | ask_kind | via | word | is_phrase | dict_hit | repeat_count | context_id | feedback | created_at |
|---|---|---|---|---|---|---|---|---|---|---|---|
| d23116e1-… | f6905e4a-… | explain | word_only | reader | functionality | 0 | 1 | 0 | 19581895-… | （空） | 1794619336977 |

示例（lookup）：
| id | kind | word | lemma | freq_rank | dict_hit | text_id | text_cefr | context_id | created_at |
|---|---|---|---|---|---|---|---|---|---|
| 7da4a5a2-… | lookup | functionality | functionality | 16436 | 1 | d40bb21d-… | B2 | 19581895-… | 1794619272121 |

### 1.5 做卡与推送（P33）

#### `card_sets` 一次「做成卡片」= 一组（3 行）

| 列 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| id | TEXT 主键 | | | 组 id |
| user_id | TEXT | 是 | | 账号 id |
| user_word_id | TEXT | 是 | | 哪个词 |
| context_id | TEXT | 是 | | 哪条批注 |
| text_id | TEXT | 是 | | 哪篇文章 |
| status | TEXT | 是 | | `generating` 生成中 / `ready` 完成 / `failed` 失败 |
| error | TEXT | | | 失败原因 |
| merged_from | TEXT | | | 「一段多空」合并来源（阶段三，现在不用） |
| regen_count | INTEGER | 是 | 0 | 换一道的次数（最多 5） |
| cache_hit_tokens | INTEGER | | | 模型返回的缓存命中 token 数 |
| prompt_tokens / completion_tokens | INTEGER | | | 输入 / 输出 token 数 |
| created_at / updated_at | INTEGER | 是 | | |

索引：`(user_id, created_at)`。

示例：`ee369607-… | f6905e4a-… | f0414fff-… | e9eccd33-… | 798c1367-… | ready | （空） | （空） | 0 | 1664 | 3501 | 477 | 1794578494927 | 1794578499989`

#### `cards` 卡片（4 行）

| 列 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| id | TEXT 主键 | | | 卡片 id |
| set_id | TEXT | 是 | | 属于哪一组（组删了卡跟着删） |
| user_id | TEXT | 是 | | 账号 id |
| seq | INTEGER | 是 | | 组内顺序 |
| spec | TEXT | 是 | | AI 设计的卡片结构（JSON：题型、正面、提示层、背面） |
| content | TEXT | 是 | | 渲染好的墨墨语法，推送的就是它 |
| status | TEXT | 是 | | `draft` 草稿 / `pushing` 推送中 / `pushed` 已推送 / `withdrawn` 已撤回 / `discarded` 已删除（软删） |
| needs_review | TEXT | | | 需要人工检查的原因；空 = 不需要 |
| edited | INTEGER | 是 | 0 | 1 = 用户改过 |
| markji_deck_id / markji_chapter_id / markji_card_id | TEXT | | | 推送后在墨墨里的位置 |
| push_error | TEXT | | | 推送失败原因 |
| pushed_at / withdrawn_at | INTEGER | | | 推送 / 撤回时间 |
| created_at / updated_at | INTEGER | 是 | | |

索引：`(user_id, status)`。

示例：
- 前几列：`6233a8ab-… | ee369607-… | f6905e4a-… | 0`
- spec：`{"kind":"context_meaning","target":"around 在此句中的引申义","front":[{"t":"sentence","source":"original","text":"Much recent wo…`
- content：`[P#L#[T#B,!ffffff,!!58a700# 📖 语境理解 ][T#!888888#Harness Engineering for Self-Improvement]]⏎Much recent work on auto-resea…`
- status=draft，needs_review 空，edited=0，墨墨相关列都为空

#### `push_jobs` 推送任务（0 行）

| 列 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| id | TEXT 主键 | | | 任务 id |
| user_id | TEXT | 是 | | 账号 id |
| deck_id | TEXT | 是 | | 推到哪个牌组 |
| chapter_mode | TEXT | 是 | | `fixed` 固定章节 / `per_article` 按文章建章节 |
| chapter_id | TEXT | | | 固定章节的 id |
| card_ids | TEXT | 是 | | 这次要推的卡（JSON 数组，按顺序） |
| done / failed | INTEGER | 是 | 0 | 已成功 / 已失败的张数 |
| status | TEXT | 是 | | `running` / `paused` / `done` / `error` |
| error | TEXT | | | 任务级错误（例如到了每日 600 条上限） |
| created_at / updated_at | INTEGER | 是 | | |

示例（构造）：`b7c1… | f6905e4a-… | mkjd_… | fixed | mkjch_… | ["6233a8ab-…","9f2e…"] | 2 | 0 | done | （空） | 1794620000000 | 1794620003000`

> 阶段二的 `tts_audio`（语音合成结果）和 `markji_media`（音频在墨墨里的 file.id）原本提前建好了，但一直为空、代码也不读写，2026-11-14 已删除，做阶段二时再建。

### 1.6 每日次数

#### `daily_usage` 每日次数（原来的 `ai_usage` + `card_usage` 合并而来）

| 列 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| user_id | TEXT 主键之一 | 是 | | 账号 id |
| day | TEXT 主键之一 | 是 | | 上海时区的日期，如 `2026-11-14` |
| kind | TEXT 主键之一 | 是 | | `ai` 每日免费 AI 讲解次数（上限 30） / `card` 每日做卡次数（上限 30 个词） |
| count | INTEGER | 是 | 0 | 当天已用次数 |

只给「用站点模型」的普通账号计数；主账号和自带 Key 的账号不计，所以本机为空。做卡失败会退还次数。

示例（构造）：`ab12… | 2026-11-14 | ai | 7`

---

## 2. 词典库 `data/dict/ecdict.db`（只读）

开源词典 ECDICT 导入的，77 万词条。查词、词形还原、词频都从这里来。

#### `ecdict`

| 列 | 类型 | 说明 |
|---|---|---|
| word | TEXT 主键 | 词 |
| phonetic | TEXT | 音标 |
| definition | TEXT | 英文释义 |
| translation | TEXT | 中文释义（多行，`\n` 分隔） |
| pos | TEXT | 词性分布 |
| collins | INTEGER | 柯林斯星级 |
| oxford | INTEGER | 是否牛津 3000 核心词 |
| tag | TEXT | 考试标签，如 `ielts gre` |
| bnc / frq | INTEGER | 英国国家语料库词频 / 当代语料库词频 |
| exchange | TEXT | 词形变化，如 `s:generics` |

索引：`exchange`、`word`（不区分大小写）。

示例：`generic | dʒi'nerik | n. a wine that is a blend of several varieties of… | a. 属类的, 一般的\n[计] 一般的 | （空） | 1 | （空） | ielts gre | 8145 | 6445 | s:generics`

---

## 3. 非关系型 / KV 存储

### 3.1 `settings` 表（关系型表，按 KV 用）

结构：`user_id`（默认 'local'）+ `key` 为主键，`value` 是字符串，另有 `updated_at`。

- **Key** = `(user_id, key)`
- **Value** = 字符串
- `user_id = 'local'` 是站级行（主账号的配置、所有人共用的默认值）；真实账号 id 是这个人自己的配置。读取时个人行优先，没有再回退站级行；`profile.*`、`markji.membership`、`markji.cardsDeck` 等个人偏好只读本人行，不回退。

| key | 站级 / 个人 | value 示例 | 说明 |
|---|---|---|---|
| `ai.activeProvider` | 都可以 | `deepseek` | 当前用哪个模型服务 |
| `ai.<服务>.apiKey` | 都可以 | （脱敏） | 模型 API Key，如 `ai.deepseek.apiKey` |
| `ai.<服务>.model` | 都可以 | `deepseek-chat` | 模型名 |
| `ai.<服务>.baseUrl` | 都可以 | `https://api.deepseek.com/v1` | 接口地址 |
| `ai.personalized` | 站级 | `on` / `off` | 个性化讲解总开关，默认 on |
| `cards.enabled` | 站级 | `on` / `off` | 做卡总开关，默认 on |
| `cards.listening` | 站级 | `on` / `off` | 听力卡开关，默认 off（阶段二） |
| `markji.token` | 都可以 | （脱敏） | 墨墨开放 API Token |
| `markji.membership` | 个人 | `basic` / `pro` | 墨墨会员等级，决定每张卡字数上限 1800 / 4000 |
| `markji.cardsDeck` | 个人 | `mkjd_…` | 上次推送选的牌组 |
| `markji.cardsChapter` | 个人 | `mkjch_…` | 上次推送选的章节 |
| `markji.cardsChapterMode` | 个人 | `fixed` / `per_article` | 上次推送的章节方式 |
| `profile.displayName` / `profile.fullName` / `profile.bio` / `profile.avatar` | 个人 | `syuan` / … / 头像图片数据 | 个人资料 |
| `extension.token` | 站级 | | 旧版的插件 Token。P30 起改用 `extension_tokens` 表；读到旧值会自动迁到主账号名下并删除这一行 |
| `markji.deck` / `markji.chapter` | 站级 | `mkjd_…` / `mkjch_…` | **旧导出功能留下的**，代码里已不再读写 |

本机现有 9 行：`markji.deck`、`markji.chapter`、`ai.deepseek.apiKey/model/baseUrl`、`ai.activeProvider`、`ai.openai.apiKey/model/baseUrl`，全部是站级行。

### 3.2 服务端进程内存（重启即清空）

| 名字（代码位置） | Key | Value | 用途 |
|---|---|---|---|
| 讲解缓存 `explainCache`（`src/lib/cards/explain-cache.ts`） | answerId | `{ userId, contextId, messages（发给模型的完整对话）, assistantText（讲解全文）, provider, model, at }` | 做卡时接着讲解对话走、命中模型缓存；10 分钟过期、最多 500 条 |
| 墨墨限速器 `limiters`（`src/lib/cards/pusher.ts`） | 账号 id | 最近一分钟内的请求时间戳列表 | 保证 10 秒 20 次、60 秒 40 次、间隔 ≥0.5 秒 |
| 推送执行器 `runners`（同上） | 推送任务 id | 正在执行的任务 | 每个任务只跑一个执行器；重启后查询状态时接着跑 |
| 老师笔记尝试状态 `attempts`（`src/lib/note-generator.ts`） | 账号 id | `{ dayKey: "2026-11-14", attempts: 1, lastFailureAt: null }` | 失败后冷却 1 小时、每天最多尝试 3 次 |
| 登录失败计数 `failures`（`src/lib/auth.ts`） | 用户名（或可信反代下的 IP） | `{ count: 3, until: 1794620000000 }` | 连续失败 5 次锁 60 秒 |

### 3.3 图片缓存 `data/img-cache/`（文件）

- **Key** = 图片原网址的 sha256 前 32 位，作为文件名，如 `a2c48c6cdb4fc94f999404b0a1072c2d`
- **Value** = 两个文件：`<key>.png`（图片本身）和 `<key>.meta`（`{"type":"image/png","file":"…/a2c48c….png"}`）
- 用途：文章里的外链图片经 `/api/img` 代理后缓存；单张上限 15MB，总量超过 300MB 从旧到新清理。本机现有 1 张。

### 3.4 浏览器 localStorage（只在这台浏览器里）

| Key | Value 示例 | 用途 |
|---|---|---|
| `readflow.voice` | `Samantha` | 朗读用的音色名；空 = 用默认 |

### 3.5 浏览器插件存储（`chrome.storage`）

| 区域 | Key | Value 示例 | 用途 |
|---|---|---|---|
| sync（随 Chrome 账号同步） | `serverUrl` | `http://127.0.0.1:3000` | ReadFlow 服务器地址 |
| sync | `token` | （脱敏） | 插件 Token |
| sync | `enabled` | `true` | 是否在网页上标出生词 |
| sync | `language` | `en` | 语言 |
| local（只在本机） | `words` | `[{ id, lemma, displayForm, phonetic, pos, translation, gloss, isPhrase, example }]` | 从服务器同步下来的词表，用来在网页上标生词、悬停显示中文 |
| local | `syncedAt` | `1794619000000` | 上次同步时间 |
| local | `syncError` | `""` / `还没填插件 Token` | 上次同步的错误 |

---

## 4. 检查时值得注意的几点

1. **AI 回答原文只存在 `contexts.ai_gloss`**，是一条批注的整段对话；`explain_events` 不存原文，也不知道自己对应 `ai_gloss` 里的哪一段（之前讨论的「回看时反馈按钮消失」「把问题 + 回答 + 反馈一起给 AI」都卡在这里）。
2. **`explain` 事件大多连批注 id 都没有**：本机 16 条 explain 事件里，只有 2 条带 `context_id`，`lemma` 和 `text_id` 则全部为空（26 条 lookup 都齐全）。多半是因为讲解请求在批注落库、拿到 id 之前就发出了（还没逐一核实）。这意味着现在连「按批注把讲解和回答联合起来」都做不到，要先解决。
3. `explain` 事件在请求**开始**时就写入，讲解失败或被打断也会留一条，所以它的条数可能多于 `ai_gloss` 里实际保存的回答段数。本机 16 条 explain 里 5 条有反馈。
4. `settings` 里的 `markji.deck`、`markji.chapter` 是旧导出功能的遗留，代码已不再读写。
5. **数据库层声明了外键、并且都是级联删除**（删父行，子行跟着删）：`paragraphs → texts`、`section_summaries → texts`、`contexts → user_words`、`exports → user_words`、`sessions → users`、`cards → card_sets`。其余归属关系（大多数表的 `user_id`、`explain_events`、`card_sets` 等）**没有外键**，靠代码按 `user_id` 校验；删掉一个词或一篇文章时，这些表里的相关行不会自动删除。
