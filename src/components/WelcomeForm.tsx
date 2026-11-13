"use client";

/** P32 F1：注册后的问卷页交互（提交 / 以后再说）。 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import SurveyForm from "./SurveyForm";
import type { SurveyAnswers } from "@/lib/learner/survey";

export default function WelcomeForm({ next }: { next: string }) {
  const router = useRouter();
  const [answers, setAnswers] = useState<SurveyAnswers>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function finish(skip: boolean) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch(skip ? "/api/learner/dismiss" : "/api/learner", {
        method: skip ? "POST" : "PUT",
        headers: { "Content-Type": "application/json" },
        body: skip ? undefined : JSON.stringify({ survey: answers }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.error ?? "保存失败");
      }
      router.replace(next);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "网络异常，请稍后重试");
      setBusy(false);
    }
  }

  return (
    <>
      <SurveyForm value={answers} onChange={setAnswers} />
      {error && <p className="text-sm mt-4" style={{ color: "var(--rf-danger-text)" }}>{error}</p>}
      <div className="flex flex-wrap gap-3 mt-8">
        <button
          type="button"
          className="duo-btn duo-btn-primary"
          disabled={busy}
          onClick={() => void finish(false)}
        >
          {busy ? "请稍候…" : "开始阅读"}
        </button>
        <button
          type="button"
          className="duo-btn duo-btn-white"
          disabled={busy}
          onClick={() => void finish(true)}
        >
          以后再说
        </button>
      </div>
    </>
  );
}
