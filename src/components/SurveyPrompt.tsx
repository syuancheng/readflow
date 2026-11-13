"use client";

/** P32 F1：老用户在首页看到的可关闭提示卡片。 */
import { useState } from "react";
import Link from "next/link";

export default function SurveyPrompt() {
  const [show, setShow] = useState(true);
  if (!show) return null;

  async function dismiss() {
    setShow(false);
    try {
      await fetch("/api/learner/dismiss", { method: "POST" });
    } catch {
      // 关闭动作先生效，接口失败也不把卡片再弹回来骚扰用户
    }
  }

  return (
    <div className="duo-card rf-survey-prompt">
      <span>花 30 秒告诉 AI 老师你的英语情况</span>
      <div className="flex items-center gap-2">
        <Link href="/welcome?next=/" className="duo-btn-sm duo-btn-white">
          去填写
        </Link>
        <button type="button" className="rf-survey-close" aria-label="关闭提示" onClick={() => void dismiss()}>
          ×
        </button>
      </div>
    </div>
  );
}
