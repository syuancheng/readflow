"use client";

import { useState } from "react";
import type { Block, CardSpec } from "@/lib/cards/spec";
import {
  addOption, CHOICE_MAX, CHOICE_MIN, removeOption, replaceBlock, retextSentence, setCorrect, setMulti, type Area,
} from "@/lib/cards/edit";
import { SECTIONS } from "@/lib/cards/render";

/**
 * 卡片修改表单（P33 §8.2）：按块显示成表单，不让用户碰墨墨语法。
 * 文章原句只读；保存调用 PATCH /api/cards/:id，校验不过把服务端的中文原因显示在表单顶部。
 */
export default function CardEditor({
  cardId,
  initial,
  onSaved,
  onCancel,
}: {
  cardId: string;
  initial: CardSpec;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [spec, setSpec] = useState<CardSpec>(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const setBlock = (area: Area, i: number, b: Block) => setSpec((s) => replaceBlock(s, area, i, b));

  async function save() {
    setSaving(true);
    setErrors([]);
    try {
      const res = await fetch(`/api/cards/${cardId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spec }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setErrors(Array.isArray(data?.reasons) && data.reasons.length ? data.reasons : [data?.error ?? "保存失败"]);
        return;
      }
      onSaved();
    } catch {
      setErrors(["网络不通，稍后再试"]);
    } finally {
      setSaving(false);
    }
  }

  const area = (title: string, which: Area, blocks: Block[] | undefined) =>
    blocks && blocks.length > 0 ? (
      <fieldset className="ce-area">
        <legend>{title}</legend>
        {blocks.map((b, i) => (
          <BlockField key={i} block={b} label={`${title} ${i + 1}`} onChange={(nb) => setBlock(which, i, nb)} />
        ))}
      </fieldset>
    ) : null;

  const back = spec.back;
  return (
    <form
      className="ce-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      {errors.length > 0 && (
        <div className="st-notice st-notice-err" role="alert">
          {errors.map((r, i) => (
            <div key={i}>{r}</div>
          ))}
        </div>
      )}
      {area("正面", "front", spec.front)}
      {area(SECTIONS.hint, "hints", spec.hints)}
      {area(SECTIONS.answer, "answer", back.answer)}
      {area(SECTIONS.explanation, "explanation", back.explanation)}
      <fieldset className="ce-area">
        <legend>其它</legend>
        <label className="ce-label">
          {SECTIONS.sentenceMeaning}
          <textarea
            className="duo-input ce-text"
            rows={2}
            value={back.sentenceMeaning ?? ""}
            onChange={(e) => setSpec({ ...spec, back: { ...back, sentenceMeaning: e.target.value || undefined } })}
          />
        </label>
        <label className="ce-label">
          {SECTIONS.structure}
          <textarea
            className="duo-input ce-text"
            rows={2}
            value={back.structure ?? ""}
            onChange={(e) => setSpec({ ...spec, back: { ...back, structure: e.target.value || undefined } })}
          />
        </label>
        {back.example && (
          <>
            <label className="ce-label">
              {SECTIONS.example}（英文）
              <input
                className="duo-input"
                value={back.example.en}
                onChange={(e) => setSpec({ ...spec, back: { ...back, example: { en: e.target.value, zh: back.example!.zh } } })}
              />
            </label>
            <label className="ce-label">
              {SECTIONS.example}（中文）
              <input
                className="duo-input"
                value={back.example.zh}
                onChange={(e) => setSpec({ ...spec, back: { ...back, example: { en: back.example!.en, zh: e.target.value } } })}
              />
            </label>
          </>
        )}
      </fieldset>
      <div className="ce-actions">
        <button type="submit" className="duo-btn-sm duo-btn-white" disabled={saving}>
          {saving ? "保存中…" : "保存"}
        </button>
        <button type="button" className="duo-btn-sm duo-btn-white" onClick={onCancel} disabled={saving}>
          取消
        </button>
      </div>
    </form>
  );
}

function BlockField({ block, label, onChange }: { block: Block; label: string; onChange: (b: Block) => void }) {
  switch (block.t) {
    case "sentence":
      return block.source === "original" ? (
        <div className="ce-label">
          <span>{label}（文章原句）</span>
          <p className="ce-readonly">{block.text}</p>
          <span className="ce-hint">原句来自文章，不能修改</span>
        </div>
      ) : (
        <label className="ce-label">
          {label}（改写句）
          <textarea
            className="duo-input ce-text"
            rows={2}
            value={block.text}
            onChange={(e) => onChange(retextSentence(block, e.target.value))}
          />
        </label>
      );
    case "instruction":
    case "text":
      return (
        <label className="ce-label">
          {label}
          <textarea
            className="duo-input ce-text"
            rows={block.t === "text" ? 3 : 2}
            value={block.text}
            onChange={(e) => onChange({ ...block, text: e.target.value })}
          />
        </label>
      );
    case "fill":
      return (
        <div className="ce-label">
          <label>
            {label}（填空答案）
            <input className="duo-input" value={block.answer} onChange={(e) => onChange({ ...block, answer: e.target.value })} />
          </label>
          <label>
            提示（可不填）
            <input
              className="duo-input"
              value={block.hint ?? ""}
              onChange={(e) => onChange({ ...block, hint: e.target.value || undefined })}
            />
          </label>
        </div>
      );
    case "audio":
      return (
        <p className="ce-hint">
          {label}：{block.of === "sentence" ? "整句音频" : "单词音频"}（不能在这里修改）
        </p>
      );
    case "choice":
      return (
        <div className="ce-label">
          <span>{label}（选择题）</span>
          <label className="ce-inline">
            <input type="checkbox" checked={block.multi === true} onChange={(e) => onChange(setMulti(block, e.target.checked))} />
            多选
          </label>
          {block.options.map((o, i) => (
            <div className="ce-option" key={i}>
              <input
                type={block.multi ? "checkbox" : "radio"}
                name={`${label}-correct`}
                checked={o.correct}
                onChange={() => onChange(setCorrect(block, i))}
                aria-label={`选项 ${i + 1} 是正确答案`}
              />
              <input
                className="duo-input"
                value={o.text}
                aria-label={`选项 ${i + 1}`}
                onChange={(e) => onChange({ ...block, options: block.options.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)) })}
              />
              <button
                type="button"
                className="duo-btn-sm duo-btn-white"
                aria-label={`删除选项 ${i + 1}`}
                disabled={block.options.length <= CHOICE_MIN}
                onClick={() => onChange(removeOption(block, i))}
              >
                删
              </button>
            </div>
          ))}
          <button
            type="button"
            className="duo-btn-sm duo-btn-white"
            disabled={block.options.length >= CHOICE_MAX}
            onClick={() => onChange(addOption(block))}
          >
            ＋ 加一个选项
          </button>
        </div>
      );
  }
}
