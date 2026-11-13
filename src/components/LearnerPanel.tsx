"use client";

/**
 * P32：设置 →「学习档案」上半部分（阶段一）。
 * 「AI 眼中的你」下半部分在阶段三补，这里先留出面板结构。
 */
import { useEffect, useState } from "react";
import SurveyForm from "./SurveyForm";
import type { SurveyAnswers } from "@/lib/learner/survey";

type LearnerPayload = {
  survey: SurveyAnswers | null;
  showFeedback: boolean;
};

export default function LearnerPanel() {
  const [loading, setLoading] = useState(true);
  const [answers, setAnswers] = useState<SurveyAnswers>({});
  const [showFeedback, setShowFeedback] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    void fetch("/api/learner")
      .then((r) => r.json())
      .then((d: LearnerPayload) => {
        if (!alive) return;
        setAnswers(d.survey ?? {});
        setShowFeedback(d.showFeedback !== false);
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

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
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="st-section">
      <div className="st-panel">
        <div className="st-panel-row">
          <div>
            <h3 className="st-panel-title">我的情况</h3>
          </div>
          <button type="button" className="duo-btn-sm duo-btn-white" disabled={busy || loading} onClick={() => void save()}>
            保存
          </button>
        </div>
        {loading ? <p className="st-loading">读取中…</p> : <SurveyForm value={answers} onChange={setAnswers} />}
        {saved && <p className="text-sm mt-4">已保存</p>}
        {error && <p className="text-sm mt-4" style={{ color: "var(--rf-danger-text)" }}>{error}</p>}
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
              });
            }}
          >
            <span className="st-switch-knob" />
          </button>
        </div>
      </div>
    </section>
  );
}
