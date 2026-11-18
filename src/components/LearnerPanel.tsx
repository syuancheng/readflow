"use client";

/**
 * P32：设置 →「学习档案」。
 * 上半「我的情况」是问卷（阶段一）与反馈行开关（阶段二）；
 * 下半「AI 眼中的你」是阶段三：水平与依据、主要难点、老师笔记、偏好风格，
 * 以及「这不准确」编辑笔记、「清空 AI 记忆」二次确认。
 *
 * 紫色系只给 AI 的判断和笔记（design-system §1.1），全面板不引入绿色主按钮。
 */
import { formatNoteTime } from "@/lib/learner/nightly";
import { useCallback, useEffect, useState } from "react";
import SurveyForm from "./SurveyForm";
import type { SurveyAnswers } from "@/lib/learner/survey";
import { STYLE_LABEL } from "@/lib/learner/survey";
import { DIFFICULTY_LABEL } from "@/lib/learner/profile-text";
import { NOTE_MAX_CHARS } from "@/lib/learner/note";
import type { TeachingRules } from "@/lib/learner/teaching-rules";
import type { FeedbackReason } from "@/lib/learner/feedback-reason";
import { LEARNER_CHANGED_EVENT } from "@/lib/settings-form";

const CEFR_OPTIONS = ["A1", "A2", "B1", "B2", "C1", "C2"];

type LevelPayload = {
  cefr: string | null;
  vocab: number | null;
  basis: string | null;
  basisText: string;
};

type NoteReason = "no_model" | { waiting: number } | null;

type LearnerPayload = {
  survey: SurveyAnswers | null;
  showFeedback: boolean;
  level: LevelPayload | null;
  difficulties: string[];
  note: string | null;
  noteUpdatedAt: number | null;
  /** P34：nightly 每晚整理 / user 你修改过 / null 老数据 */
  noteUpdateKind: "nightly" | "user" | null;
  noteReason: NoteReason;
  teachingRules: TeachingRules;
  levelOverride: { cefr: string | null; vocab: number | null };
  noteHistory: { id: string; note: string; kind: string; createdAt: number }[];
  feedbackReasons: readonly FeedbackReason[];
};

/** PRD F6 的两种原因文案，逐字使用；N=0 是「条件已满足但还没生成」的边界 */
function noteReasonText(reason: NoteReason): string {
  if (reason === "no_model") {
    return "老师笔记需要可用的 AI 模型：在 设置 → 模型 里填一个 Key 即可开启";
  }
  // P34：老师笔记改为每晚整理，新的提问和反馈合计攒够 10 次当晚才整理（P36：划一次词就算一次提问）
  if (reason && reason.waiting > 0) {
    return `再攒 ${reason.waiting} 次提问或反馈，AI 老师当晚就会写下第一份观察`;
  }
  return "AI 老师今晚会写下第一份观察";
}

/** P34：笔记下方的更新说明：每晚整理 · 今天 03:00 / 你修改过 · AI 老师整理时会参考 / 更新于 … */
function noteMetaText(p: Pick<LearnerPayload, "noteUpdatedAt" | "noteUpdateKind">): string {
  if (p.noteUpdateKind === "user") return "你修改过 · AI 老师整理时会参考这段内容";
  if (!p.noteUpdatedAt) return "你修改过 · AI 老师整理时会参考这段内容";
  const when = formatNoteTime(p.noteUpdatedAt, Date.now());
  return p.noteUpdateKind === "nightly" ? `每晚整理 · ${when}` : `更新于 ${when}`;
}

/** 词汇量显示成 ±15% 的区间，取整到百位（实现说明 §4.3） */
function vocabRange(v: number | null): string {
  if (v == null) return "还看不出来";
  const lo = Math.round((v * 0.85) / 100) * 100;
  const hi = Math.round((v * 1.15) / 100) * 100;
  return `约 ${lo}–${hi}`;
}

export default function LearnerPanel() {
  const [loading, setLoading] = useState(true);
  const [answers, setAnswers] = useState<SurveyAnswers>({});
  const [showFeedback, setShowFeedback] = useState(true);
  const [payload, setPayload] = useState<LearnerPayload | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // 「这不准确」编辑态
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [noteSaved, setNoteSaved] = useState(false);
  const [resetBusy, setResetBusy] = useState(false);

  // 2026-11-18：教学规则 / 手填水平 / 笔记历史
  const [rulesCan, setRulesCan] = useState("");
  const [rulesCannot, setRulesCannot] = useState("");
  const [overrideCefr, setOverrideCefr] = useState("");
  const [overrideVocab, setOverrideVocab] = useState("");
  const [rulesBusy, setRulesBusy] = useState(false);
  const [rulesSaved, setRulesSaved] = useState(false);
  const [rulesError, setRulesError] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/learner");
      if (!res.ok) throw new Error("读取失败");
      const d = (await res.json()) as LearnerPayload;
      setPayload(d);
      setAnswers(d.survey ?? {});
      setShowFeedback(d.showFeedback !== false);
      setRulesCan((d.teachingRules?.can ?? []).join("\n"));
      setRulesCannot((d.teachingRules?.cannot ?? []).join("\n"));
      setOverrideCefr(d.levelOverride?.cefr ?? "");
      setOverrideVocab(d.levelOverride?.vocab != null ? String(d.levelOverride.vocab) : "");
    } catch {
      /* 读不到就保持原状，不影响设置里其它面板 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const res = await fetch("/api/learner", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ survey: answers, showFeedback }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "保存失败");
      setSaved(true);
      await load();
      window.dispatchEvent(new Event(LEARNER_CHANGED_EVENT));
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  function startEdit() {
    setDraft(payload?.note ?? "");
    setNoteError("");
    setNoteSaved(false);
    setEditing(true);
  }

  async function saveNoteEdit() {
    setNoteBusy(true);
    setNoteError("");
    try {
      const res = await fetch("/api/learner", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note: draft }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "保存失败");
      const d = (await res.json()) as LearnerPayload; // PUT 返回的就是 GET 的完整结构
      setPayload(d);
      setEditing(false);
      setNoteSaved(true);
      window.dispatchEvent(new Event(LEARNER_CHANGED_EVENT));
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : "网络异常，请稍后重试");
    } finally {
      setNoteBusy(false);
    }
  }

  async function saveRules() {
    setRulesBusy(true);
    setRulesSaved(false);
    setRulesError("");
    try {
      const vocab = overrideVocab.trim() ? Number(overrideVocab) : null;
      if (vocab !== null && (!Number.isFinite(vocab) || vocab < 500 || vocab > 30000)) {
        throw new Error("词汇量请填 500 到 30000 之间的数字");
      }
      const res = await fetch("/api/learner", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          teachingRules: {
            can: rulesCan.split("\n").map((s) => s.trim()).filter(Boolean),
            cannot: rulesCannot.split("\n").map((s) => s.trim()).filter(Boolean),
          },
          levelOverride: { cefr: overrideCefr || null, vocab },
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "保存失败");
      const d = (await res.json()) as LearnerPayload;
      setPayload(d);
      setRulesSaved(true);
      window.dispatchEvent(new Event(LEARNER_CHANGED_EVENT));
    } catch (err) {
      setRulesError(err instanceof Error ? err.message : "网络异常，请稍后重试");
    } finally {
      setRulesBusy(false);
    }
  }

  async function restoreNoteVersion(id: string) {
    setNoteBusy(true);
    setNoteError("");
    try {
      const res = await fetch("/api/learner", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ restoreNoteId: id }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "恢复失败");
      const d = (await res.json()) as LearnerPayload;
      setPayload(d);
      setEditing(false);
      setNoteSaved(true);
      window.dispatchEvent(new Event(LEARNER_CHANGED_EVENT));
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : "网络异常，请稍后重试");
    } finally {
      setNoteBusy(false);
    }
  }

  async function clearMemory() {
    const ok = window.confirm(
      "清空后，AI 老师会忘掉对你的观察和行为推断，从问卷重新开始。查词记录不会删除。确定要清空吗？",
    );
    if (!ok) return;
    setResetBusy(true);
    setNoteError("");
    try {
      const res = await fetch("/api/learner/reset", { method: "POST" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? "清空失败");
      await res.arrayBuffer(); // 消费成功响应体，连接才能归还池子
      setEditing(false);
      setNoteSaved(false);
      await load();
      window.dispatchEvent(new Event(LEARNER_CHANGED_EVENT));
    } catch (err) {
      setNoteError(err instanceof Error ? err.message : "网络异常，请稍后重试");
    } finally {
      setResetBusy(false);
    }
  }

  const level = payload?.level ?? null;
  const difficulties = (payload?.difficulties ?? []).slice(0, 3);
  const styleLabel = STYLE_LABEL.get(payload?.survey?.stylePref ?? "") ?? "还没填写问卷";

  return (
    <section className="st-section">
      <div className="st-panel">
        <div className="rf-survey-head">
          <h3 className="st-panel-title">我的情况</h3>
          <p className="st-panel-desc">AI 老师据此判断讲多深、讲什么。每题都可以跳过。</p>
        </div>
        {loading ? <p className="st-loading">读取中…</p> : <SurveyForm value={answers} onChange={setAnswers} />}
        {/* 亲密性：保存按钮放在它要提交的表单最下面，结果提示紧挨着按钮 */}
        <div className="rf-survey-actions">
          <button type="button" className="duo-btn duo-btn-sm duo-btn-white" disabled={busy || loading} onClick={() => void save()}>
            {busy ? "保存中…" : "保存"}
          </button>
          {saved && <span className="rf-survey-status" role="status">已保存</span>}
          {error && (
            <span className="rf-survey-status rf-survey-status-err" role="alert">
              {error}
            </span>
          )}
        </div>
      </div>

      <div className="st-panel">
        <div className="st-reading-row st-reading-row-static">
          <span className="st-reading-text">
            <b>讲解下方显示「太浅 · 刚好 · 太深」</b>
          </span>
          <button
            type="button"
            className={`st-switch ${showFeedback ? "on" : ""}`}
            role="switch"
            aria-checked={showFeedback}
            aria-label="讲解下方显示太浅 刚好 太深"
            onClick={() => {
              const next = !showFeedback;
              setShowFeedback(next);
              setSaved(false);
              void fetch("/api/learner", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ showFeedback: next }),
              })
                .then((res) => res.arrayBuffer()) // 消费响应体，避免连接占着不放
                .then(() => {
                  // 让阅读页立刻重读开关，不用等下次打开文章
                  window.dispatchEvent(new Event(LEARNER_CHANGED_EVENT));
                });
            }}
          >
            <span className="st-switch-knob" />
          </button>
        </div>
      </div>

      {/* ---------- 下半部分：AI 眼中的你（F6） ---------- */}
      <div className="st-panel" id="st-learner-ai-view">
        <div className="st-panel-row">
          <div>
            <h3 className="st-panel-title">AI 眼中的你</h3>
          </div>
        </div>

        {loading || !payload ? (
          <p className="st-loading">读取中…</p>
        ) : (
          <>
            <div className="rf-learner-row rf-learner-ai">
              <b>估计水平：{level?.cefr ?? "还看不出来"}，词汇量 {vocabRange(level?.vocab ?? null)}</b>
            </div>
            <p className="st-help">依据：{level?.basisText ?? "还没有足够的信息"}</p>

            <div className="rf-learner-row">
              <span className="text-xs">手填水平</span>
              <select
                className="rf-survey-select"
                aria-label="手填水平"
                value={overrideCefr}
                onChange={(e) => { setOverrideCefr(e.target.value); setRulesSaved(false); }}
              >
                <option value="">让系统判断</option>
                {CEFR_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
              <input
                className="duo-input rf-override-vocab"
                type="number"
                min={500}
                max={30000}
                placeholder="词汇量"
                aria-label="手填词汇量"
                value={overrideVocab}
                onChange={(e) => { setOverrideVocab(e.target.value); setRulesSaved(false); }}
              />
              <span className="text-xs">手填后优先于推断值</span>
            </div>

            <div className="rf-learner-row">
              <span className="text-xs">主要难点</span>
              {difficulties.length ? (
                difficulties.map((d) => (
                  <span key={d} className="duo-filter-chip rf-learner-ai">
                    {DIFFICULTY_LABEL[d as keyof typeof DIFFICULTY_LABEL] ?? d}
                  </span>
                ))
              ) : (
                <span className="text-xs">暂时没有明显的难点</span>
              )}
            </div>

            <div className="rf-learner-row">
              <span className="text-xs">希望讲解</span>
              <span className="text-sm">{styleLabel}</span>
            </div>

            <div className="rf-learner-row">
              <span className="text-xs">老师笔记</span>
            </div>

            {editing ? (
              <div className="rf-learner-edit">
                <textarea
                  className="duo-input rf-learner-input"
                  value={draft}
                  rows={4}
                  maxLength={NOTE_MAX_CHARS}
                  aria-label="老师笔记"
                  onChange={(e) => setDraft(e.target.value)}
                />
                <p className="rf-learner-count">{draft.length} / {NOTE_MAX_CHARS} 字</p>
                <div className="rf-learner-actions">
                  <button
                    type="button"
                    className="st-btn st-btn-ghost"
                    disabled={noteBusy || draft.trim().length === 0}
                    onClick={() => void saveNoteEdit()}
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    className="st-btn st-btn-ghost"
                    disabled={noteBusy}
                    onClick={() => { setEditing(false); setNoteError(""); }}
                  >
                    取消
                  </button>
                </div>
              </div>
            ) : payload.note ? (
              <>
                <div className="rf-learner-note">{payload.note}</div>
                {/* P34：更新说明移到紫色笔记块下方（亲密性：块与说明 8px，同组），写明来源 */}
                <p className="rf-note-meta">{noteMetaText(payload)}</p>
              </>
            ) : (
              <p className="st-help">{noteReasonText(payload.noteReason)}</p>
            )}

            {noteSaved && <p className="st-help">已保存</p>}
            {noteError && <p className="st-help" style={{ color: "var(--rf-danger-text)" }}>{noteError}</p>}

            <div className="rf-learner-row">
              <span className="text-xs">希望老师做的（每行一条）</span>
            </div>
            <textarea
              className="duo-input rf-learner-input"
              rows={3}
              value={rulesCan}
              aria-label="希望老师做的"
              placeholder="例如：主动补充常用的欧美习惯用语"
              onChange={(e) => { setRulesCan(e.target.value); setRulesSaved(false); }}
            />
            <div className="rf-learner-row">
              <span className="text-xs">希望老师不要做的（每行一条）</span>
            </div>
            <textarea
              className="duo-input rf-learner-input"
              rows={3}
              value={rulesCannot}
              aria-label="希望老师不要做的"
              placeholder="例如：不要一次性给出整句翻译"
              onChange={(e) => { setRulesCannot(e.target.value); setRulesSaved(false); }}
            />
            <div className="rf-learner-actions">
              <button type="button" className="st-btn st-btn-primary" disabled={rulesBusy} onClick={() => void saveRules()}>
                {rulesBusy ? "保存中…" : "保存讲解要求"}
              </button>
              {rulesSaved && <span className="rf-survey-status" role="status">已保存</span>}
            </div>
            {rulesError && <p className="st-help" style={{ color: "var(--rf-danger-text)" }}>{rulesError}</p>}
            <p className="st-help">这些要求优先于 AI 的观察，每晚整理不会改写它们。</p>

            {payload.noteHistory.length > 0 && (
              <details className="rf-note-history">
                <summary>笔记历史（{payload.noteHistory.length}）</summary>
                <div className="rf-note-history-list">
                  {payload.noteHistory.slice(0, 10).map((h) => (
                    <div key={h.id} className="rf-note-history-item">
                      <span>{formatNoteTime(h.createdAt, Date.now())} · {h.kind === "user" ? "你修改过" : h.kind === "restore" ? "恢复" : "每晚整理"}</span>
                      <button type="button" className="st-btn st-btn-ghost" disabled={noteBusy} onClick={() => void restoreNoteVersion(h.id)}>
                        恢复这一版
                      </button>
                    </div>
                  ))}
                </div>
              </details>
            )}

            {!editing && (
              <div className="rf-learner-actions">
                <button type="button" className="st-btn st-btn-ghost" onClick={startEdit}>
                  这不准确
                </button>
                <button
                  type="button"
                  className="st-btn st-btn-danger"
                  disabled={resetBusy}
                  onClick={() => void clearMemory()}
                >
                  清空 AI 记忆
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
