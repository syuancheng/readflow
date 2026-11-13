/**
 * 卡片校验（P33 spec §5.2，PRD §5 的 11 条原则）。纯函数，逐条单测。
 * 校验失败 → 生成流程重出一次；仍失败 → 组级 failed（或选择题标记 needs_review）。
 */
import type { CardSpec, Block } from "./spec";
import { renderCardChecked } from "./render";

export type ValidateCtx = {
  /** 这条记录所在句子（buildAnchor 的 prefix + quote + suffix） */
  originalSentence: string;
  /** 目标词或短语 */
  quote: string;
  /** 这个词在这句里的中文意思（讲解「释义：」那一行，或词典第一个义项） */
  glossZh: string | null;
  listeningEnabled: boolean;
  /** 1800 或 4000（PRD Q7，用户已确认文档里的 4500 是错的） */
  charLimit: number;
  /** 来源标题（渲染进标签行，计入字数）；不传按空 */
  sourceTitle?: string;
};

export type ValidateResult = { ok: true } | { ok: false; reasons: string[] };

/**
 * 收集一个块里所有用户可见文字（audio 块的 text 不显示，不计入泄露检查）。
 * 句子里被挖空 / 只露前缀的部分先遮掉，剩下的才是学生真正看得到的。
 */
function visibleText(blocks: Block[] | undefined): string {
  if (!blocks) return "";
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.t === "sentence") parts.push(maskedSentence(b));
    else if (b.t === "instruction" || b.t === "text") parts.push(b.text);
    else if (b.t === "fill") parts.push(b.hint ?? "");
    else if (b.t === "choice") parts.push(b.options.map((o) => o.text).join(" "));
  }
  return parts.join("\n");
}

function maskedSentence(b: Extract<Block, { t: "sentence" }>): string {
  const m = b.mark;
  if (!m || (m.as !== "blank" && m.as !== "prefix")) return b.text;
  if (m.start < 0 || m.end > b.text.length || m.start >= m.end) return b.text;
  const keep = m.as === "prefix" ? Math.min(m.keep ?? 0, m.end - m.start) : 0;
  return `${b.text.slice(0, m.start + keep)}＿${b.text.slice(m.end)}`;
}

/** 可见文字里是否出现目标词（大小写不敏感；单词额外认词形变化） */
function leaksQuote(text: string, quote: string): boolean {
  const q = quote.trim();
  if (!q) return false;
  if (text.toLowerCase().includes(q.toLowerCase())) return true;
  if (/^[A-Za-z'-]+$/.test(q)) {
    return (text.match(/[A-Za-z]+/g) ?? []).some((w) => sameWord(w, q));
  }
  return false;
}

/**
 * 一个词可能的词干集合：去掉常见屈折后缀，并补上英文常见的拼写变化
 * （running → run 双写辅音、making → make 吃掉 e、studies → study）。
 * 太宽会把答案遮死，太窄会把 running / run 当成不同的词；词干至少 3 个字母。
 */
function stemsOf(word: string): Set<string> {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  const out = new Set<string>([w]);
  const add = (base: string, suffix: string) => {
    if (base.length < 3) return;
    out.add(base);
    out.add(`${base}e`);
    if (/([^aeiou])\1$/.test(base)) out.add(base.slice(0, -1));
    if (suffix === "ies" || suffix === "ied") out.add(`${base}y`);
  };
  for (const suffix of ["ies", "ied", "ing", "est", "ed", "es", "er", "ly", "s"]) {
    if (w.endsWith(suffix) && w.length > suffix.length) add(w.slice(0, -suffix.length), suffix);
  }
  return out;
}

function sameWord(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/[^a-z]/g, "");
  const y = b.toLowerCase().replace(/[^a-z]/g, "");
  if (!x || !y) return false;
  if (x === y) return true;
  const sy = stemsOf(y);
  for (const stem of stemsOf(x)) if (sy.has(stem)) return true;
  return false;
}

export function validateCard(spec: CardSpec, ctx: ValidateCtx): ValidateResult {
  const reasons: string[] = [];

  // ---------- 1. 以句子为本 ----------
  const frontHasSentence =
    spec.front.some((b) => b.t === "sentence") ||
    spec.front.some((b) => b.t === "audio" && b.of === "sentence");
  if (!frontHasSentence) {
    reasons.push("正面必须有一个句子（原句、改写句或整句音频）");
  }

  // ---------- 2. 原句一字不改 ----------
  for (const b of spec.front) {
    if (b.t === "sentence" && b.source === "original") {
      if (!ctx.originalSentence.trim().includes(b.text.trim())) {
        reasons.push("原句必须和文章原文逐字一致");
      }
    }
  }
  for (const b of [...(spec.hints ?? []), ...spec.back.answer, ...(spec.back.explanation ?? [])]) {
    if (b.t === "sentence" && b.source === "original") {
      if (!ctx.originalSentence.trim().includes(b.text.trim())) {
        reasons.push("原句必须和文章原文逐字一致（提示层 / 背面也一样）");
      }
    }
  }

  // ---------- 3. 标记位置正确 ----------
  const blanksOf = (blocks: Block[] | undefined) =>
    (blocks ?? []).flatMap((b) => {
      if (b.t === "sentence" && b.mark) return [{ block: b, mark: b.mark }];
      return [];
    });
  for (const { block, mark } of [...blanksOf(spec.front), ...blanksOf(spec.hints)]) {
    if (mark.start < 0 || mark.end > block.text.length || mark.start >= mark.end) {
      reasons.push("标记区间必须落在句子范围内");
      continue;
    }
    const covered = block.text.slice(mark.start, mark.end).trim();
    if ((mark.as === "blank" || mark.as === "prefix") && covered && !sameWord(covered, ctx.quote)) {
      reasons.push("挖空盖住的部分必须是目标词或它的词形变化");
    }
  }

  // ---------- 4. 正面不泄露答案 ----------
  const frontText = visibleText(spec.front) + "\n" + visibleText(spec.hints);
  if (ctx.glossZh && ctx.glossZh.trim() && frontText.includes(ctx.glossZh.trim())) {
    reasons.push("题干不能出现目标词的中文意思");
  }
  const hasBlank =
    blanksOf(spec.front).some((x) => x.mark.as === "blank" || x.mark.as === "prefix") ||
    spec.front.some((b) => b.t === "fill");
  if (hasBlank && leaksQuote(frontText, ctx.quote)) {
    reasons.push("挖空类卡片的正面不能出现完整的目标词");
  }

  // ---------- 5. 选择题 ----------
  const choices = [...spec.front, ...(spec.hints ?? [])].filter(
    (b): b is Extract<Block, { t: "choice" }> => b.t === "choice",
  );
  for (const c of choices) {
    const texts = c.options.map((o) => o.text);
    if (c.options.length < 3 || c.options.length > 5) {
      reasons.push("选择题选项必须在 3~5 个之间");
    }
    if (new Set(texts.map((t) => t.trim().toLowerCase())).size !== texts.length) {
      reasons.push("选择题选项不能重复");
    }
    const correctCount = c.options.filter((o) => o.correct).length;
    if (c.multi && correctCount < 2) reasons.push("多选题至少要有 2 个正确答案");
    if (!c.multi && correctCount !== 1) reasons.push("单选题有且只能有一个正确答案");
  }

  // ---------- 6. 只考一个点 ----------
  if (!spec.back.answer || spec.back.answer.length === 0) {
    reasons.push("背面必须有答案");
  }
  if (choices.length > 1) {
    reasons.push("一张卡最多一个选择块");
  }
  const blankGroups = blanksOf(spec.front).length + (spec.front.some((b) => b.t === "fill") ? 1 : 0);
  if (spec.kind !== "paragraph_cloze" && blankGroups > 1) {
    reasons.push("一张卡最多一组挖空（一段多空卡除外）");
  }

  // ---------- 7. 听力 ----------
  const allBlocks = [...spec.front, ...(spec.hints ?? []), ...spec.back.answer, ...(spec.back.explanation ?? [])];
  if (!ctx.listeningEnabled && allBlocks.some((b) => b.t === "audio")) {
    reasons.push("听力零件未开放");
  }
  if (spec.kind === "listen_choose") {
    const frontSentence = spec.front.find((b) => b.t === "sentence");
    if (frontSentence) reasons.push("听音选词的正面不能显示句子文字");
  }
  if (spec.kind === "listen_fill") {
    const frontSentence = spec.front.find((b) => b.t === "sentence");
    if (frontSentence && leaksQuote(maskedSentence(frontSentence), ctx.quote)) {
      reasons.push("听句填空的正面必须把目标词挖空");
    }
  }
  if (spec.kind === "listen_fill" && !spec.front.some((b) => b.t === "audio" && b.of === "sentence")) {
    reasons.push("听句填空的正面必须有整句音频");
  }
  if (spec.kind === "listen_choose" && !spec.front.some((b) => b.t === "audio")) {
    reasons.push("听音选词的正面必须有音频");
  }

  // ---------- 8~11：作用在 AI 文本和渲染结果上 ----------
  const aiTexts = [
    ...allBlocks.filter((b) => b.t !== "audio").map((b) => (b as { text: string }).text),
    ...allBlocks.flatMap((b) => (b.t === "text" && b.emphasis ? b.emphasis : [])),
    ...allBlocks.flatMap((b) => (b.t === "choice" ? b.options.map((o) => o.text) : [])),
    ...allBlocks.flatMap((b) => (b.t === "fill" ? [b.answer, b.hint ?? ""] : [])),
    spec.back.sentenceMeaning ?? "",
    spec.back.structure ?? "",
    spec.back.example ? `${spec.back.example.en}\n${spec.back.example.zh}` : "",
    spec.target,
    spec.customLabel ?? "",
  ].join("\n");
  if (/\[Pic#/.test(aiTexts)) reasons.push("卡片里不允许出现图片");
  if (/\[(T|P|F|E|Card)#|\[Choice|\[Audio/.test(aiTexts)) {
    reasons.push("题目内容里不允许出现墨墨标签语法");
  }
  if (/^---\s*$/m.test(aiTexts)) reasons.push("题目内容里不允许出现答案线");

  // 渲染后再自检一遍：标签配对、答案线条数、字数上限都在这里一次性查
  if (reasons.length === 0) {
    const rendered = renderCardChecked(
      spec,
      { sourceTitle: ctx.sourceTitle ?? "" },
      { charLimit: ctx.charLimit },
    );
    if (!rendered.ok) reasons.push(...rendered.problems);
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
