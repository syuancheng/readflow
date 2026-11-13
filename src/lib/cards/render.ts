/**
 * 渲染器（P33 spec §6）：CardSpec → 墨墨语法。纯函数。
 * 版式固定（AI 改不了）：标签行 / 分区标题 / 答案线位置都由这里拼。
 * 音频在草稿阶段写占位符 @AUDIO:<hash>@，推送时 str.replace 成真实 file.id
 * （不能用模板字符串：墨墨语法里全是方括号和 #，spec §6.3）。
 */
import type { CardSpec, Block } from "./spec";
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
};

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

/** 通用块渲染。blankNo 是当前卡的挖空编号（paragraph_cloze 从 1 递增） */
function renderBlock(b: Block, blankNo: number, opts: RenderOpts): string | null {
  switch (b.t) {
    case "sentence": {
      const s = renderSentence(b, blankNo);
      // AI 补充的句子必须带「AI 补充」标记（spec §5.2 第 8 条）
      return b.source === "paraphrase" ? `${s} [T#${TAG_COLORS.source}#（AI 补充）]` : s;
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
const SECTIONS = {
  hint: "🧭 提示",
  answer: "✅ 答案",
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

  // 背面分区
  lines.push(...section(SECTIONS.answer, spec.back.answer.map((b) => renderBlock(b, blankNo, opts) ?? "")));
  if (spec.back.explanation) {
    lines.push(...section(SECTIONS.explanation, spec.back.explanation.map((b) => renderBlock(b, blankNo, opts) ?? "")));
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
        `${esc(spec.back.example.en)} [T#${TAG_COLORS.source}#（AI 补充）]`,
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
    answer: PreviewSide;
    explanation: PreviewSide | null;
    sentenceMeaning: string | null;
    structure: string | null;
    example: { en: string; zh: string; ai: true } | null;
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
  }[];
};

function previewSide(blocks: Block[]): PreviewSide {
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
        lines.push({ text, ...(blanks ? { blanks } : {}), ...(b.source === "paraphrase" ? { emphasis: [] } : {}) });
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
      answer: previewSide(spec.back.answer),
      explanation: spec.back.explanation ? previewSide(spec.back.explanation) : null,
      sentenceMeaning: spec.back.sentenceMeaning ?? null,
      structure: spec.back.structure ?? null,
      example: spec.back.example ? { ...spec.back.example, ai: true } : null,
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
