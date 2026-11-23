# 阅读器发音改造：接有道真人音频，支持英音/美音

> 状态：**待评审，未实现**。用户 2026-11-23 拍板用「有道 dictvoice 网页接口」方案。
> 目标：把阅读器查词/短语/句子的发音，从浏览器 `speechSynthesis` 合成音换成词典级真人录音，并提供全局英美音切换；失败时自动回退现有浏览器朗读。

---

## 1. 背景与现状

项目目前有**两套互不相干**的发音系统：

| | 系统 A：浏览器朗读 | 系统 B：卡片云端配音 |
|---|---|---|
| 用途 | 阅读器查词、词库、插件 | 卡片背面英文句子 |
| 引擎 | `speechSynthesis`（设备本地音色） | 阿里云百炼 `qwen3-tts-flash` |
| 代码 | `src/lib/speak.ts` | `src/lib/tts.ts` + `src/lib/cards/tts-api.ts` |

本次只改**系统 A**。现状问题：

1. `speak(quote)` 读的是用户划选的原文，音色取自设备，**硬性优先 en-US**（`speak.ts:41,45,112,124`），无英美音切换。
2. 导入 ECDICT 时丢弃了 audio 字段（`scripts/import-ecdict.mjs:4`），词典只提供音标文本（`dict.ts:163-173`），没有任何真人音频。
3. 音标与发音不同源：`normalizePhonetic()`（`text.ts:60-74`）把空格分隔的英美变体砍成只剩第一个。
4. 同一文本在阅读器（浏览器 Samantha）和卡片（百炼 Jennifer）里声音不一致。

## 2. 方案选型（已定）

主流词典（有道/剑桥/牛津）的发音本质是**预录真人音频按「词 + 口音」索引**，不是现场 TTS。有道网页版接口实测可用：

```
http://dict.youdao.com/dictvoice?type=1&audio=water   → 英音 mp3
http://dict.youdao.com/dictvoice?type=0&audio=water   → 美音 mp3
```

实测结论（2026-11-23）：

- HTTP 200，`audio/mpeg`，64kbps / 48kHz 单声道，单词/短语/整句都能念。
- `type=1` = 英音，`type=0` 与 `type=2` 返回同一文件（美音）；网上「0/1」与「1/2」两种说法各对一半。
- 无 Key、无签名，GET 直接取。

**取舍（已知风险）**：这是有道网页内部接口，未公开、无 SLA、无授权协议，随时可能变更或关闭。缓解措施：服务端缓存 + 失败自动回退浏览器朗读，接口挂掉时功能降级但不失效。有道官方开放平台 API（`ai.youdao.com`）是付费 TTS、只有男女声无英美音，解决不了本需求，故不采用。

## 3. 总体设计

```
用户点喇叭
   │
   ├─ 站内 /api/pronounce?text=<原文>&accent=us|gb
   │      │
   │      ├─ 命中本地缓存 → 直接返回 mp3
   │      └─ 未命中 → 请求有道 dictvoice → 落盘缓存 → 返回 mp3
   │
   ├─ 成功 → new Audio(blob) 播放
   └─ 失败（非 200 / 超时 / 空音频）→ 回退 speak(text) 浏览器朗读
```

**为什么必须服务端代理**：有道是 `http://`，站点在 HTTPS 下前端直连会被 mixed-content 拦截；且服务端可做缓存、限流、失败兜底、避免暴露第三方接口给客户端。

## 4. 详细改动

### 4.1 设置项：全局英美音（新增）

| 步骤 | 文件 | 改动 |
|---|---|---|
| 键注册 | `src/lib/config.ts:76-101` | `SETTINGS_KEYS` 加 `pronunciationAccent: "pronunciation.accent"` |
| 默认值 | 消费端 | 无集中 default map（项目惯例）；读不到时默认 `"us"` |
| GET | `src/app/api/settings/route.ts:46-110` | 返回 `pronunciationAccent`（owner/普通账号都返回，这是个人偏好） |
| PUT | `src/app/api/settings/route.ts:119-142, 148-214` | `PutBody` 加字段；校验仅 `"us"\|"gb"`，按**个人** userId 写入（不是站级） |
| UI | `src/components/SettingsDialog.tsx:51-74, 1172-1185` | `SettingsPayload` 加字段；在现有「阅读页发音音色」区加「美音 / 英音」二选一切换，复用 `put({...})` 即时生效。**个人级**：写本人 userId，每个账号各自选择 |
| 搜索 | `src/lib/settings-form.ts:129` | reading 组 keywords 补「英音」「美音」「口音」 |

沿用现有 `VoicePicker`，但**重新定位为「备用音色」**：有道 `dictvoice` 只能选英美音（`type=0/1`），**没有音色选择**，它管不了男声/女声；VoicePicker 选的是用户设备本地的浏览器音色，只在有道失败回退到浏览器朗读时生效。UI 上把它的说明改成「真人发音不可用时生效的备用音色」，放在英美音切换下方。

澄清：有道接口**不支持选音色**，只支持英美音；VoicePicker 与有道无关，是浏览器朗读的音色。

### 4.2 新服务端模块 `src/lib/dictvoice.ts`（新建）

职责：请求有道、缓存、返回音频。

- `DICTVOICE_BASE`：默认 `http://dict.youdao.com/dictvoice`，可用 `READFLOW_DICTVOICE_BASE_URL` 覆盖（E2E 用本地 mock）。
- `fetchDictVoice(text, accent)`:
  - `type = accent === "gb" ? 1 : 0`
  - `URLSearchParams({ type, audio: text })`，文本先 trim，长度上限 **200 字符**（有道对长句支持有限，超出直接回退）
  - `fetch(url, { signal: AbortSignal.timeout(8_000) })`，仿 `tts.ts:81-83`
  - 校验 `res.ok` + `content-type` 含 `audio/` + `content-length > 0`，否则抛错
- 缓存键：`"dv:" + audioKey(normalizeAudioText(text), { model: "youdao", voice: accent })`，复用 `src/lib/cards/audio.ts:23-28` 的哈希（含 model+voice，英美音天然分开存）。
- 落盘：`tts/<key>.mp3`，复用 `audioDir()`（`tts.ts:27-29`）、`.tmp` 写后 `renameSync` 原子落盘、`storedAudio(key)` 读（`:51-56`）。
- 写表：复用 `tts_audio`，`model="youdao-dictvoice"`、`voice="us"|"gb"`、`mime="audio/mpeg"`（`:105-126` 的 UPSERT 逻辑抽成共用函数或直接仿写）。
- 并发合并：`inflight: Map<key, Promise>` 仿 `tts.ts:60-73`，避免同词并发打多次有道。
- 不重试：有道是免费内部接口，失败一次即回退，不做 `withRetry`（避免被封）。

### 4.3 新 API `src/app/api/pronounce/route.ts`（新建）

- `GET(text, accent)`：`currentUser()` 校验登录（proxy 也会挡无 cookie，`src/proxy.ts:34-35`）。
- 参数白名单：`text` trim 后 ≤200 字符；`accent` 仅 `us|gb`，非法按 `us`。
- 调 `dictvoice.ts` 的 `ensureDictAudio(text, accent)`。
- 成功：`new NextResponse(bytes, { headers: { "Content-Type": "audio/mpeg", "Cache-Control": "private, max-age=86400" } })`。
- 失败：返回 **503**（前端据此回退），日志只打前 40 字符文本，不打 Key。

### 4.4 前端发音函数（改造 `src/lib/speak.ts`）

- 保留 `speak()` 作为**回退路径**不变（含所有 Chrome bug 兜底），导出名不动，避免大范围改动。
- 新增 `speakWithDict(text, accent)`:
  1. `const url = /api/pronounce?text=...&accent=...`
  2. `fetch(url)` → `res.ok` → `await res.blob()` → `new Audio(URL.createObjectURL(blob))` → `play()`
  3. `catch` 或 `res.status === 503` → 调 `speak(text)` 回退
  4. **用户手势窗口**：`audio.play()` 返回 Promise，若因异步丢失手势被拒（`NotAllowedError`），立即回退 `speak(text)`；不预取、不静音解锁（复杂度不值）。
  5. **竞态**：模块级 `let current: { seq: number; audio?: HTMLAudioElement }`，新调用先 `current.audio?.pause()` 并递增 seq，旧请求返回时 seq 不符就丢弃。
- **口音由服务端读个人设置**（实现阶段的简化）：`/api/pronounce` 用 `getSetting(SETTINGS_KEYS.pronunciationAccent, user.id)` 决定 `us|gb`，前端不传 accent、不缓存状态。设置保存后下次发音即生效，彻底避免前后端状态同步问题。

### 4.5 调用点改造（3 处；插件永久不做）

| 位置 | 改动 |
|---|---|
| `Reader.tsx:1958-1966`（音标按钮）、`:1967-1989`（喇叭按钮） | `onClick={() => void speakWithDict(quote, accent)}`，`accent` 由组件从 props/设置拿；`canSpeak` 常量保留（有道失败仍要浏览器兜底，无 speechSynthesis 时按钮也不该消失——改为恒显示，失败静默） |
| `WordList.tsx:420-431` | 同上，`void speakWithDict(w.displayForm, accent)`，保留 `e.stopPropagation()` |
| `VoicePicker.tsx:35-40` | **试听保持 `speak()` 听本地音色**（实现阶段修正）：它是「备用音色」选择器，试听就该听被选中的备用音色；若改成真人音就失去试听意义。`listEnglishVoices()` 不变，只在设置页把标签/说明改成「备用音色」 |
| `extension/src/content.js` | **不做**：用户 2026-11-23 明确「以后所有需求都不做插件」。插件端保持现状（浏览器朗读），不再投入 |

### 4.6 不做的改动（明确边界）

- **不动卡片配音**（系统 B）：那是有 Key 的付费 TTS，本次需求是阅读器发音；英美音对卡片配音的支持另立需求。
- **不动音标显示**：`normalizePhonetic()` 的双变体处理与本需求无直接耦合，且改它会影响大量快照测试；若后续要做「英美音标各显示一条」另立需求。
- **不引入新 npm 依赖**。

## 5. 测试策略

| 层 | 内容 |
|---|---|
| 纯函数单测（新建 `tests/unit/dictvoice.test.ts`） | `type` 映射（us→0 / gb→1）、文本 trim/200 字截断、accent 白名单、URL 参数构造、缓存 key 英美音不同 |
| API 路由 | 用本地 mock HTTP 服务（`READFLOW_DICTVOICE_BASE_URL` 指向它）验证：命中缓存、落盘、503 回退信号、参数非法 |
| 回归 | `npm test`（含 check-tokens）、`npm run typecheck`、隔离库 `next build` |
| 手动冒烟 | 本机启动，查单词/短语/句子各点一次喇叭，切英美音对比；断开 mock 验证回退浏览器朗读 |

不调真实有道接口做自动化测试（外部依赖不稳定），仅实现阶段手工验证一次。

## 6. 风险与降级

| 风险 | 处理 |
|---|---|
| 有道接口变更/关闭 | 服务端缓存兜底已有词；新词 503 → 前端自动回退浏览器朗读 |
| 有道返回非音频/空文件 | 校验 content-type 与 content-length，按失败处理 |
| 请求超时 | 8s AbortSignal.timeout，按失败处理 |
| 第三方版权 | 音频仅缓存服务端供本站播放，不分发、不提供下载；设置页注明发音来源有道 |
| 用户手势丢失导致 `play()` 被拒 | 立即回退 `speak()`（同步路径，仍在手势窗口内） |
| 长句有道念不出 | 文本 >200 字符直接回退；实际词典接口对整句支持较好，200 足够 |
| 插件端仍是浏览器音 | 用户明确以后都不做插件，插件端不在本需求及后续需求范围 |

## 7. 交付清单（实现完成后核对）

- [ ] 设置项「美音 / 英音」可在设置页切换、即时生效、个人级持久化
- [ ] 阅读器查词/短语/句子、词库、VoicePicker 试听均走真人音频并有回退
- [ ] 服务端缓存生效，同词同口音只请求一次有道
- [ ] `/api/pronounce` 登录校验、参数白名单、503 回退信号、口音从个人设置读
- [ ] 单测覆盖纯函数；`npm test` / typecheck / 隔离库 build 全通过
- [ ] 插件端限制已记录

## 8. 已确认的决策（2026-11-23）

1. 英美音设置 = **个人级**，每账号自己选（非站级）。
2. `VoicePicker` 保留，重新定位为「备用音色」（真人发音不可用时生效）；有道接口不支持选音色，只支持英美音。
3. **插件端永久不做**：用户明确「以后我们所有需求都不做插件」。
