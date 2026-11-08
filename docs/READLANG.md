# Readlang 对齐研究

> 2026-11-03。目标：除 Flashcard/复习外，ReadFlow 尽量与 Readlang 的交互和功能保持一致。
> 证据来源：Readlang 官网与定价页、官方博客（2013–2026）、官方论坛（含作者 Steve 的回复）、
> 以及用无头浏览器进入 readlang.com **trial 模式**实测公开文库阅读器的真实 DOM 与交互。

## 一、Readlang 的核心机制（实测 + 文档证据）

### 1. 点词交互：内联译文 + 自动入库

- 每个词是 `<span data-p="序号">`，点击后**译文以内联方式出现在词的正上方**（绿色小字），
  词本身变成绿色小块；**再点一次译文收起**。不走弹窗。（trial 实测 DOM：
  译文是 `<span class="translation">`，插在词后）
- **每次点译都自动存入 word list**，连同整句 context。没有"收藏"按钮——保存是默认行为。
  论坛里用户的抱怨也印证这点（"auto save is cool, but maybe I just want to check a word
  but not import it"）。
- 缓解手段：设置里可开 **Delete on deselect**——再点一次收起译文的同时直接删除该词；
  以及对已存词点击弹出的浮层里有 **Mark as remembered / Edit / Delete**。
- 拖选多词 = 短语翻译（免费版限 6 词/天、10 条/天），短语与单词**存在同一个 word list**，
  没有独立的"句库"。社区 2025 年请求拆分词/短语视图，作者未做。

### 2. 已收词的回访：自动高亮 + 历史语境

- 新文本里，** previously 翻译过的词自动加下划线高亮**；点它弹出"译文 + 历史所有 context 句子"，
  可 Mark as remembered / Edit / Delete（官方博客 Auto Highlight Words As You Read, 2015）。
- 同一个词多次点译，**所有 context 句子都保留**（Multiple Contexts, 2013），复习时随机展示、可轮换。

### 3. 单词列表：状态机 + 收藏 + 筛选

- 筛选标签（论坛实测截图）：**All Words / Starred / Not Starred / Scheduled / Not Started /
  Learning / Learned / Deleted**。
- **Learned = SRS 间隔 > 1 周**（最快连续 3 次答对达成）——即"掌握"是由复习数据推导的，不靠手动标记。
- Starred（收藏）是手动标记，用于挑出重点词。
- 词表支持搜索；每行展开可见多条 context；可编辑译文。

### 4. 词 → 原文跳转：有，但只到"文章级"

- flashcard / word list 里的 context 可以点回**原文**，但只会打开"你上次读到的地方"，
  **不能定位到具体那一段**。作者 2024 年在论坛明确回复：按页定位"not possible right now"，
  因为数据存储方式所限。

### 5. 阅读器：分页制，不是滚动

- 正文分页，底部一栏：**◀ | 进度百分比 | ▶(Read Aloud 播放) | ▶**；点左右边缘或方向键翻页。
- 点进度百分比弹出菜单：**Go to start / Go to furthest read location / Go to specific location**
  （trial 实测文案："Location 0 / 380"）——即每篇文章记住"最远读到哪"。
- 文章有状态：**Reading queue（在读）/ Completed（读完）/ Abandoned（弃读）**（官方博客 2015）。
- 侧栏（顶部标签）：**Explain / Dictionary / Guide / Words / Settings**——AI 解释和词典是侧栏，
  不弹在正文上；Settings（AA）管字体、颜色、翻译样式、语音、语速。

### 6. 发音：两层

| 功能 | 名称 | 可用性 |
|---|---|---|
| 点词后**自动朗读**该词/短语 | Auto-Pronounce（2015 年叫 Speaking Mode） | 付费档（用设备语音或云端高质量语音，视计划而定） |
| **整篇朗读** + 逐词高亮（卡拉OK式） | Read Aloud（2023） | 免费可用浏览器语音；Premium Plus 才有云端高质量语音 |
| 点击触发**手动**朗读 | — | 免费可用 |

### 7. 其他（供参考，暂不对齐）

- 公开文库按难度分级、EPUB / MP3 导入（MP3 自动 AI 转写+同步字幕）、YouTube 视频同步字幕。
- 导出：Anki / CSV；词表可导入导出。
- Streak 修复（付费）。

## 二、ReadFlow 现状对照

| 能力 | Readlang | ReadFlow 现状 | 差距 |
|---|---|---|---|
| 点词查义 | 内联译文，词上方小字 | 弹层卡片 | 交互模型不同（见决策点） |
| 收词策略 | **自动**入库，再点删除（可开关） | 手动点"+" | 缺自动入库 + 取消机制 |
| 短语 | 拖选即存，与单词同库 | 拖选可查可存（同库） | 基本一致，缺词/短语筛选 |
| 已收词回访 | 自动下划线高亮，点击看历史语境 | 已收词高亮（绿），点击弹释义 | 缺"历史语境列表"展示 |
| 词库状态 | Learning / Learned / Deleted + Starred | 无状态、无收藏 | 缺状态机与筛选 |
| 词→原文跳转 | 有，但只到"上次读到处" | 词库页只有文字，无跳转 | 我们存了 paragraph_id，**能做成精确跳段**（反超） |
| 阅读进度 | 分页 + 最远读到 + 百分比 | 无 | 缺（原 P6b） |
| 文章状态 | 在读/读完/弃读 | 无 | 缺 |
| 发音 | 点词自动读（付费）+ 整篇朗读（免费） | 手动点喇叭（刚加） | 缺自动朗读开关、整篇朗读 |
| AI 解释 | 侧栏 Explain 标签 | 弹层内 | 位置不同，功能等价 |
| 词典 | 侧栏 Dictionary | 弹层内（ECDICT） | 等价 |
| Flashcard | SRS 练习 | 不做（导出墨墨替代） | 按用户要求排除 |

## 三、对齐计划（建议分三期）

### Phase 1 — 交互内核（对应本次三个问题）
1. **点词自动入库**：查词即存（含短语），弹层里的"+"变成"已存 ✓（再点删除）"；
   设置加"仅查询，不自动收录"开关。
2. **内联译文**：点词后在词上方浮出小号译文（不挤占版式，绝对定位），再点收起；
   弹层保留为"深入"入口（词典全文 / AI / 追问），双击或点词旁小图标打开。
3. **词库改造**：状态（未开始/学习中/已掌握/已删除）+ Starred + 搜索 + 词/短语筛选；
   已删除词可恢复。Learned 暂时手动标记（我们无 SRS 数据，无法推导）。
4. **词 → 原文精确跳转**：context 行加"跳到原文"链接，`/texts/{id}?p={paragraphId}`
   打开阅读页并滚动定位到该段（不再做闪烁高亮）——比 Readlang 的"只能回到上次位置"更强。

### Phase 2 — 阅读体验
5. 阅读进度：每篇记"最远读到段落"，文章列表显示百分比，打开自动续读（原 P6b）。
6. 整篇朗读：Web Speech 逐句朗读 + 当前句高亮，播放/暂停条吸底。
7. 文章状态：在读 / 读完 / 弃读 + 列表分组。

### Phase 3 — 锦上添花
8. 已收词"历史语境"浮层（点已收词直接看全部 context + 标记已掌握/删除）。
9. EPUB 导入、难度估算（我们已有 readability.ts 的底子）。

## 四、数据模型需要的小改动

- `user_words` 加 `status`（new / learning / learned / deleted）、`starred`（0/1）、
  `is_phrase`（可由 display_form 含空格推导，存列更稳）。
- `texts` 加 `status`（reading / completed / abandoned）、`last_para_idx` / `max_para_idx`。
- 不需要新表：contexts 已具备"一词多语境"，跳转所需的 paragraph_id 已在。
