"use client";

import { useState } from "react";
import { SECTIONS, groupReference, type PreviewModel, type PreviewSide } from "@/lib/cards/render";
import AudioButton from "./AudioButton";

/**
 * 卡片预览（P33 §8.2）：按墨墨里的样子显示标签行、正面、提示层、背面分区。
 * 点「翻面」在 正面 → 提示 → 背面 之间切换（没有提示层就只在正反面之间切）。
 * 挖空显示成下划线；选择题显示选项，翻到背面时标出正确答案。
 */
type Side = "front" | "hint" | "back";

type Line = PreviewSide["lines"][number];

/**
 * 一行英文句子：句末跟「（AI 补充）」和 ▶（P35）。
 * ▶ 不能单独掉到下一行开头：把最后一个词（或 AI 标记）和按钮包进不换行的 span（设计简报 §9.8）。
 */
function SentenceText({ line }: { line: Line }) {
  const tail = (
    <>
      {line.ai && <span className="cp-ai">（AI 补充）</span>}
      {line.audioKey && <AudioButton audioKey={line.audioKey} text={line.text} />}
    </>
  );
  if (!line.ai && !line.audioKey) return <>{line.text}</>;
  if (line.ai) {
    return (
      <>
        {line.text} <span className="rf-say-tail">{tail}</span>
      </>
    );
  }
  const cut = line.text.lastIndexOf(" ");
  return (
    <>
      {cut > 0 ? line.text.slice(0, cut + 1) : ""}
      <span className="rf-say-tail">
        {cut > 0 ? line.text.slice(cut + 1) : line.text}
        {tail}
      </span>
    </>
  );
}

/** 使用类卡的参考说法：按组排版，英文主文字色、中文次要灰 */
function ReferenceGroups({ side }: { side: PreviewSide }) {
  return (
    <div className="rf-ref-list">
      {groupReference(side.lines).map((g, i) => (
        <div className="rf-ref-group" key={i}>
          {g.map((l, j) =>
            l.sentence || (/[A-Za-z]/.test(l.text) && !/[\u3400-\u9fff]/.test(l.text)) ? (
              <p className="cp-line" key={j}>
                <SentenceText line={l} />
              </p>
            ) : (
              <p className="rf-ref-zh" key={j}>
                {l.text}
              </p>
            ),
          )}
        </div>
      ))}
    </div>
  );
}

function Lines({ side, answers }: { side: PreviewSide; answers: boolean }) {
  return (
    <>
      {side.lines.map((l, i) => {
        if (l.choices) {
          return (
            <ul className="cp-choices" key={i}>
              {l.choices.options.map((o, j) => (
                <li key={j} className={answers && o.correct ? "cp-choice cp-choice-right" : "cp-choice"}>
                  <span aria-hidden>{answers ? (o.correct ? "✓" : "·") : l.choices?.multi ? "☐" : "○"}</span>
                  <span>{o.text}</span>
                  {answers && o.correct && <span className="cp-sr"> （正确答案）</span>}
                </li>
              ))}
            </ul>
          );
        }
        // 背面里的填空块直接显示答案；正面保持下划线
        if (answers && l.blanks && l.blanks.length > 0) {
          return (
            <p className="cp-line" key={i}>
              {l.blanks.map((b) => (
                <b key={b.no}>{b.answer}</b>
              ))}
            </p>
          );
        }
        return (
          <p className="cp-line" key={i}>
            <SentenceText line={l} />
          </p>
        );
      })}
    </>
  );
}

export default function CardPreview({ preview, notice }: { preview: PreviewModel; notice?: string | null }) {
  const [side, setSide] = useState<Side>("front");
  const hasHint = preview.hints !== null;
  const order: Side[] = hasHint ? ["front", "hint", "back"] : ["front", "back"];
  const next = order[(order.indexOf(side) + 1) % order.length];
  const flipLabel = next === "front" ? "回到正面" : next === "hint" ? "看提示" : "看答案";
  const b = preview.back;
  const frontChoices: PreviewSide = { lines: preview.front.lines.filter((l) => l.choices) };

  return (
    <div className="cp-card">
      {notice && <div className="st-notice st-notice-err cp-notice">需要检查：{notice}</div>}
      <div className="cp-tags">
        <span className="cp-tag cp-tag-kind">
          {preview.tags.emoji} {preview.tags.label}
        </span>
        {preview.tags.style && <span className="cp-tag cp-tag-style">{preview.tags.style}</span>}
        {preview.tags.source && <span className="cp-tag cp-tag-source">{preview.tags.source}</span>}
      </div>

      <div className="cp-body" aria-live="polite">
        {side === "front" && <Lines side={preview.front} answers={false} />}
        {side === "hint" && preview.hints && (
          <>
            <p className="cp-title">{SECTIONS.hint}</p>
            <Lines side={preview.hints} answers={false} />
          </>
        )}
        {side === "back" && (
          <>
            <p className="cp-title">{b.answerTitle}</p>
            {b.referenceNote ? (
              <>
                <p className="rf-ref-note">{b.referenceNote}</p>
                <ReferenceGroups side={b.answer} />
              </>
            ) : (
              <>
                <Lines side={frontChoices} answers />
                <Lines side={b.answer} answers />
              </>
            )}
            {b.explanation && (
              <>
                <p className="cp-title">{SECTIONS.explanation}</p>
                <Lines side={b.explanation} answers />
              </>
            )}
            {b.sentenceMeaning && (
              <>
                <p className="cp-title">{SECTIONS.sentenceMeaning}</p>
                <p className="cp-line">{b.sentenceMeaning}</p>
              </>
            )}
            {b.structure && (
              <>
                <p className="cp-title">{SECTIONS.structure}</p>
                <p className="cp-line">{b.structure}</p>
              </>
            )}
            {b.example && (
              <>
                <p className="cp-title">{SECTIONS.example}</p>
                <p className="cp-line">
                  {b.example.en}{" "}
                  <span className="rf-say-tail">
                    <span className="cp-ai">（AI 补充）</span>
                    {b.example.audioKey && <AudioButton audioKey={b.example.audioKey} text={b.example.en} />}
                  </span>
                </p>
                <p className="cp-line">{b.example.zh}</p>
              </>
            )}
            {b.audio.length > 0 && (
              <>
                <p className="cp-title">{SECTIONS.audio}</p>
                <p className="cp-line">{b.audio.map((a) => (a === "word" ? "▶ 单词" : "▶ 整句")).join("　")}</p>
              </>
            )}
          </>
        )}
      </div>

      <button type="button" className="duo-btn-sm duo-btn-white cp-flip" aria-pressed={side !== "front"} onClick={() => setSide(next)}>
        {flipLabel}
      </button>
    </div>
  );
}
