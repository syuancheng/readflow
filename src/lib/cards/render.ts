/**
 * 渲染器（P33 spec §6）：CardSpec → 墨墨语法。纯函数。
 * 版式固定（AI 改不了）：标签行 / 分区标题 / 答案线位置都由这里拼。
 * 音频在草稿阶段写占位符 @AUDIO:<hash>@，推送时 str.replace 成真实 file.id
 * （不能用模板字符串：墨墨语法里全是方括号和 #，spec §6.3）。
 */
import { isProductive, type CardSpec, type Block } from "./spec";
import { audioKey, audioPlaceholder, speakable, type Voice } from "./audio";
import { esc, oneLine, TAG_COLORS } from "./markup";
import { kindLabel } from "./labels";
import { lintCard } from "./lint";

export type RenderOpts = {
  /**
   * 考试风格标签。不传（undefined）时用 spec.examStyle；显式传 null 表示不显示。
   * 该值由系统按问卷算好后写进 spec.examStyle（style.ts），AI 写的不算数。
   */
  examStyle?: string | null;
  sourceTitle: string;
  /** hash → 草稿占位符会写成 @AUDIO:<hash>@；键是 audio 块的稳定 hash（阶段二填） */
  audioIds?: Record<string, string>;
  /**
   * P35 句子音频：传了就给背面每句英文（answer / explanation 的句子块、补充例句）
   * 在同一行末尾追加 `[Audio#M,ID/@AUDIO:<key>@#]`；不传或 null 不加。正面和提示层永远不加。
   */
  audio?: Voice | null;
};

/** 使用类卡背面「参考说法」分区的说明行（P35 PRD F1） */
export const REFERENCE_NOTE = "说法不唯一：意思对、用上了目标词，就算说对了";
export const REFERENCE_NOTE_AI = `AI 补充 · ${REFERENCE_NOTE}`;

/** 使用类卡的说明行：参考说法里有 AI 写的句子时注明「AI 补充」 */
export function referenceNoteOf(spec: CardSpec): string {
  const ai = spec.back.answer.some((b) => b.t === "sentence" && b.source === "paraphrase");
  return ai ? REFERENCE_NOTE_AI : REFERENCE_NOTE;
}

/** 这句英文的音频标签（带前导空格）；不配音时返回空串 */
function audioTagFor(text: string, opts: RenderOpts): string {
  if (!opts.audio || !speakable(text)) return "";
  return ` ${audioPlaceholder(audioKey(text, opts.audio))}`;
}

// ---------- 行内渲染 ----------

/** 渲染一个句子块：高亮 / 挖空 / 前缀露出的标记处理 */
function renderSentence(b: Extract<Block, { t: "sentence" }>, blankNo: number): string {
  const text = b.text;
  const m = b.mark;
  if (!m) return esc(text);
  const before = esc(text.slice(0, m.start));
  const covered = text.slice(m.start, m.end);
  const after = esc(text.slice(m.end));
  if (m.as === "highlight") {
    return `${before}[T#B,${TAG_COLORS.highlight}#${esc(covered)}]${after}`;
  }
  if (m.as === "prefix") {
    const keep = Math.min(m.keep ?? 1, covered.length);
    const head = esc(covered.slice(0, keep));
    const rest = covered.slice(keep);
    return `${before}${head}[F#${blankNo}#${esc(rest)}]${after}`;
  }
  return `${before}[F#${blankNo}#${esc(covered)}]${after}`;
}

/** 普通段落的 emphasis（每段最多 4 处，超出只保留前 4 处——spec §6.1） */
function renderTextWithEmphasis(b: Extract<Block, { t: "text" }>): string {
  const raw = b.text;
  const parts = (b.emphasis ?? []).slice(0, 4).filter((e) => e && raw.includes(e));
  if (parts.length === 0) return esc(raw);
  let out = "";
  let rest = raw;
  let guard = 0;
  while (guard++ < 8) {
    // 找「当前剩余文本里最先出现的那个 emphasis」
    let bestIdx = -1;
    let bestPart = "";
    for (const p of parts) {
      const i = rest.indexOf(p);
      if (i >= 0 && (bestIdx < 0 || i < bestIdx)) {
        bestIdx = i;
        bestPart = p;
      }
    }
    if (bestIdx < 0) break;
    out += esc(rest.slice(0, bestIdx));
    out += `[T#B,${TAG_COLORS.emphasis}#${esc(bestPart)}]`;
    rest = rest.slice(bestIdx + bestPart.length);
  }
  out += esc(rest);
  return out;
}

/**
 * 通用块渲染。blankNo 是当前卡的挖空编号（paragraph_cloze 从 1 递增）。
 * ctx.back：背面的块（句子后面配音频）；ctx.noAiTag：使用类卡的参考说法分区，
 * 「AI 补充」由分区说明行统一写一次，不再逐句标。
 */
function renderBlock(
  b: Block,
  blankNo: number,
  opts: RenderOpts,
  ctx: { back?: boolean; noAiTag?: boolean } = {},
): string | null {
  switch (b.t) {
    case "sentence": {
      const s = renderSentence(b, blankNo);
      // AI 补充的句子必须带「AI 补充」标记（spec §5.2 第 8 条）
      const tagged = b.source === "paraphrase" && !ctx.noAiTag ? `${s} [T#${TAG_COLORS.source}#（AI 补充）]` : s;
      return ctx.back ? tagged + audioTagFor(b.text, opts) : tagged;
    }
    case "instruction":
      return `[P#L#[T#${TAG_COLORS.source}#${oneLine(b.text)}]]`;
    case "text":
      return renderTextWithEmphasis(b);
    case "fill": {
      const hint = b.hint ? `[T#${TAG_COLORS.source}#（提示：${oneLine(b.hint)}）] ` : "";
      return `${hint}[F#${blankNo}#${esc(b.answer)}]`;
    }
    case "choice": {
      const head = b.multi ? "[Choice#multi#" : "[Choice##";
      const lines = b.options.map((o) => (o.correct ? `* ${esc(o.text)}` : `- ${esc(o.text)}`));
      return [head, ...lines, "]"].join("\n");
    }
    case "audio": {
      // 阶段一：listening 关闭，正常不会有 audio 块；渲染成占位符供阶段二替换
      const id = opts.audioIds?.[b.text] ?? `@AUDIO:${b.text}`;
      return b.of === "sentence"
        ? `[Audio#M,ID/${id}#▶ 播放整句]`
        : `[Audio#M,ID/${id}#▶ 单词]`;
    }
  }
}

/** 顶部标签行：题型（绿底白字）+ 考试风格（紫）+ 来源（灰），每张卡固定三种颜色 */
function tagLine(spec: CardSpec, opts: RenderOpts): string {
  const k = kindLabel(spec.kind, spec.customLabel);
  const tags: string[] = [
    `[T#B,${TAG_COLORS.kindText},${TAG_COLORS.kindBg}# ${k.emoji} ${esc(k.label)} ]`,
  ];
  const style = effectiveStyle(spec, opts);
  if (style) {
    tags.push(`[T#B,${TAG_COLORS.styleText},${TAG_COLORS.styleBg}# ${esc(style)} ]`);
  }
  if (opts.sourceTitle) {
    tags.push(`[T#${TAG_COLORS.source}#${esc(opts.sourceTitle.slice(0, 40))}]`);
  }
  return `[P#L#${tags.join("")}]`;
}

/** 实际显示的考试风格：显式传入优先，其次 spec 里系统写入的；空串当作没有 */
function effectiveStyle(spec: CardSpec, opts: RenderOpts): string | null {
  const v = opts.examStyle !== undefined ? opts.examStyle : spec.examStyle ?? null;
  return v && v.trim() ? v.trim() : null;
}

function section(title: string, body: string[]): string[] {
  const content = body.filter(Boolean);
  if (content.length === 0) return [];
  return [`[P#L#[T#B#${title}]]`, ...content];
}

/** 分区小标题的固定 emoji（PRD F3「卡片外观」） */
export const SECTIONS = {
  hint: "🧭 提示",
  answer: "✅ 答案",
  reference: "🗣 参考说法",
  explanation: "💡 解析",
  sentenceMeaning: "📝 整句意思",
  structure: "🔍 句子主干",
  example: "📌 补充例句",
  audio: "🔊 发音",
} as const;

// ---------- 主渲染 ----------

export function renderCard(spec: CardSpec, opts: RenderOpts): string {
  const lines: string[] = [];
  lines.push(tagLine(spec, opts));

  // 正面块；挖空编号从 1 递增（paragraph_cloze 支持多空）
  let blankNo = 0;
  for (const b of spec.front) {
    if (b.t === "sentence" && b.mark && (b.mark.as === "blank" || b.mark.as === "prefix")) blankNo++;
    if (b.t === "fill") blankNo++;
    const rendered = renderBlock(b, blankNo, opts);
    if (rendered !== null && rendered !== "") lines.push(rendered);
  }

  // 提示层（墨墨的分层揭示）：正面 → `---` → 提示 → `---` → 背面。
  // 复习时先只看到题目，点一下出提示，再点一下出答案。
  // 不带提示的卡只有一条 `---`。
  if (spec.hints && spec.hints.length > 0) {
    lines.push("---");
    lines.push(
      ...section(
        SECTIONS.hint,
        spec.hints.map((b) => renderBlock(b, blankNo, opts) ?? ""),
      ),
    );
  }

  lines.push("---");

  // 背面分区。使用类卡：标题换成「🗣 参考说法」，第一行是灰色说明（P35 PRD F1）
  const productive = isProductive(spec.kind);
  const answerLines = spec.back.answer.map(
    (b) => renderBlock(b, blankNo, opts, { back: true, noAiTag: productive }) ?? "",
  );
  if (productive) {
    lines.push(
      ...section(SECTIONS.reference, [`[T#${TAG_COLORS.source}#${referenceNoteOf(spec)}]`, ...answerLines]),
    );
  } else {
    lines.push(...section(SECTIONS.answer, answerLines));
  }
  if (spec.back.explanation) {
    lines.push(
      ...section(SECTIONS.explanation, spec.back.explanation.map((b) => renderBlock(b, blankNo, opts, { back: true }) ?? "")),
    );
  }
  if (spec.back.sentenceMeaning) {
    lines.push(...section(SECTIONS.sentenceMeaning, [esc(spec.back.sentenceMeaning)]));
  }
  if (spec.back.structure) {
    lines.push(...section(SECTIONS.structure, [esc(spec.back.structure)]));
  }
  if (spec.back.example) {
    lines.push(
      ...section(SECTIONS.example, [
        `${esc(spec.back.example.en)} [T#${TAG_COLORS.source}#（AI 补充）]${audioTagFor(spec.back.example.en, opts)}`,
        esc(spec.back.example.zh),
      ]),
    );
  }
  if (spec.back.audio && spec.back.audio.length > 0) {
    const audioParts = spec.back.audio.map((a) => {
      const id = opts.audioIds?.[a] ?? `@AUDIO:${a}`;
      return `[Audio#M,ID/${id}#${a === "word" ? "▶ 单词" : "▶ 整句"}]`;
    });
    lines.push(...section(SECTIONS.audio, [audioParts.join(" ")]));
  }

  return lines.join("\n") + "\n";
}

// ---------- 预览模型（给网页用，spec §6.2） ----------

export type PreviewModel = {
  tags: { emoji: string; label: string; style: string | null; source: string | null };
  front: PreviewSide;
  hints: PreviewSide | null;
  back: {
    /** 分区标题：认识类「✅ 答案」，使用类「🗣 参考说法」 */
    answerTitle: string;
    /** 使用类卡的说明行；认识类为 null */
    referenceNote: string | null;
    answer: PreviewSide;
    explanation: PreviewSide | null;
    sentenceMeaning: string | null;
    structure: string | null;
    example: { en: string; zh: string; ai: true; audioKey?: string } | null;
    audio: string[];
  };
};

/** 预览侧的一段：文本行 + 挖空（带答案）+ 选择（带正确标记） */
export type PreviewSide = {
  lines: {
    text: string;
    blanks?: { answer: string; no: number }[];
    choices?: { options: { text: string; correct: boolean }[]; multi: boolean };
    emphasis?: string[];
    /** AI 写的句子（显示「AI 补充」） */
    ai?: boolean;
    /** 这一行是英文句子块（参考说法分组用） */
    sentence?: boolean;
    /** P35：这句英文的音频 key（只在背面、开了配音时有） */
    audioKey?: string;
  }[];
};

function previewKey(text: string, audio: Voice | null | undefined): string | undefined {
  return audio && speakable(text) ? audioKey(text, audio) : undefined;
}

function previewSide(
  blocks: Block[],
  back: { audio?: Voice | null; noAiTag?: boolean } | null = null,
): PreviewSide {
  let blankNo = 0;
  const lines: PreviewSide["lines"] = [];
  for (const b of blocks) {
    switch (b.t) {
      case "sentence": {
        let text = b.text;
        let blanks: { answer: string; no: number }[] | undefined;
        if (b.mark && (b.mark.as === "blank" || b.mark.as === "prefix")) {
          blankNo++;
          const covered = b.text.slice(b.mark.start, b.mark.end);
          const keep = b.mark.as === "prefix" ? Math.min(b.mark.keep ?? 1, covered.length) : 0;
          text = b.text.slice(0, b.mark.start + keep) + "_".repeat(Math.max(1, covered.length - keep)) + b.text.slice(b.mark.end);
          blanks = [{ answer: covered.slice(keep), no: blankNo }];
        }
        const key = back ? previewKey(b.text, back.audio) : undefined;
        lines.push({
          text,
          sentence: true,
          ...(blanks ? { blanks } : {}),
          ...(b.source === "paraphrase" && !back?.noAiTag ? { ai: true } : {}),
          ...(key ? { audioKey: key } : {}),
        });
        break;
      }
      case "instruction":
        lines.push({ text: b.text });
        break;
      case "text":
        lines.push({ text: b.text, ...(b.emphasis?.length ? { emphasis: b.emphasis.slice(0, 4) } : {}) });
        break;
      case "fill":
        blankNo++;
        lines.push({ text: b.hint ? `（提示：${b.hint}）____` : "____", blanks: [{ answer: b.answer, no: blankNo }] });
        break;
      case "choice":
        lines.push({ text: "", choices: { options: b.options, multi: b.multi === true } });
        break;
      case "audio":
        lines.push({ text: b.of === "sentence" ? "▶ 播放整句" : "▶ 播放单词" });
        break;
    }
  }
  return { lines };
}

export function renderPreview(spec: CardSpec, opts: RenderOpts): PreviewModel {
  const k = kindLabel(spec.kind, spec.customLabel);
  const productive = isProductive(spec.kind);
  const exampleKey = spec.back.example ? previewKey(spec.back.example.en, opts.audio) : undefined;
  const style = effectiveStyle(spec, opts);
  return {
    tags: {
      emoji: k.emoji,
      label: k.label,
      style,
      source: opts.sourceTitle ? opts.sourceTitle.slice(0, 40) : null,
    },
    front: previewSide(spec.front),
    hints: spec.hints && spec.hints.length > 0 ? previewSide(spec.hints) : null,
    back: {
      answerTitle: productive ? SECTIONS.reference : SECTIONS.answer,
      referenceNote: productive ? referenceNoteOf(spec) : null,
      answer: previewSide(spec.back.answer, { audio: opts.audio, noAiTag: productive }),
      explanation: spec.back.explanation ? previewSide(spec.back.explanation, { audio: opts.audio }) : null,
      sentenceMeaning: spec.back.sentenceMeaning ?? null,
      structure: spec.back.structure ?? null,
      example: spec.back.example
        ? { ...spec.back.example, ai: true, ...(exampleKey ? { audioKey: exampleKey } : {}) }
        : null,
      audio: spec.back.audio ?? [],
    },
  };
}

/** 这张卡渲染后应该有几条答案线（带提示层的两条） */
export function answerLinesOf(spec: CardSpec): 1 | 2 {
  return spec.hints && spec.hints.length > 0 ? 2 : 1;
}

/**
 * 渲染 + lint 的组合入口：生成 / 修改 / 换一道统一用它，保证渲染结果都过自检。
 * charLimit 传了就连字数上限一起检查（PRD Q7：普通 1800 / 专业 4000）。
 */
export function renderCardChecked(
  spec: CardSpec,
  opts: RenderOpts,
  limits: { charLimit?: number } = {},
): { ok: true; content: string } | { ok: false; problems: string[] } {
  const content = renderCard(spec, opts);
  const lint = lintCard(content, { answerLines: answerLinesOf(spec), charLimit: limits.charLimit });
  if (!lint.ok) return { ok: false, problems: lint.problems };
  return { ok: true, content };
}

/**
 * P35：把使用类卡背面的参考说法分组，一组 = 搭配（如有）+ 英文句 + 中文。
 * 预览按组排版：组内 4px、组间 12px（设计简报 §9.2）。
 * 规则：当前组里已经有英文句时，遇到下一句英文、或一行纯英文（搭配，如 fall behind on sth），就开新组。
 */
export function groupReference(lines: PreviewSide["lines"]): PreviewSide["lines"][] {
  const groups: PreviewSide["lines"][] = [];
  let cur: PreviewSide["lines"] = [];
  let hasSentence = false;
  const englishOnly = (t: string) => /[A-Za-z]/.test(t) && !/[㐀-鿿]/.test(t);
  for (const l of lines) {
    const startsNew = hasSentence && (l.sentence === true || (!l.choices && !l.blanks && englishOnly(l.text)));
    if (startsNew) {
      groups.push(cur);
      cur = [];
      hasSentence = false;
    }
    cur.push(l);
    if (l.sentence) hasSentence = true;
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}
