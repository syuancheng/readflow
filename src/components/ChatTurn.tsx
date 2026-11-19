"use client";

import { useState } from "react";
import FeedbackRow from "@/components/FeedbackRow";
import MarkdownText from "@/components/MarkdownText";
import { shownText } from "@/lib/chat-view";
import { isNotAGloss } from "@/lib/explain-policy";
import type { Feedback } from "@/lib/learner/types";

export type ChatTurnData = {
  ask?: string;
  text: string;
  status: "loading" | "streaming" | "done" | "error";
  answerId?: string;
  feedback?: Feedback;
  feedbackReason?: string | null;
  feedbackError?: string;
};

/**
 * 对话流里的一轮（P44）：用户的提问靠右（浅灰气泡），AI 的回答在左边、满宽、没有气泡。
 * 每条回答都有一条用户问题（首次讲解是统一的默认问题）；首次讲解下面有「太浅 / 刚好 / 太深」，追问的回答下面没有反馈。
 * 制卡建议显示在这条回答的末尾：一张带明确按钮的小卡片（做成卡片 / 暂不需要），像 Claude Code 问「要不要合并」那样。
 */
export default function ChatTurn({
  turn,
  question,
  showFeedback,
  suggestion,
  onMakeCard,
  onRetry,
  onRate,
  onReason,
}: {
  turn: ChatTurnData;
  /** 这条回答对应的用户问题：显示在右边。每条 AI 回答都有，首次讲解用统一的默认问题 */
  question: string;
  showFeedback: boolean;
  /** 这条回答末尾的制卡建议理由；不显示传 null */
  suggestion: string | null;
  onMakeCard: () => void;
  onRetry: () => void;
  onRate: (r: Feedback) => void;
  onReason: (r: string | null) => void;
}) {
  // 「暂不需要」只对这一条建议生效：关掉后这条回答下面不再出现
  const [dismissed, setDismissed] = useState(false);
  const failed = turn.status === "error" || (turn.status === "done" && isNotAGloss(turn.text));
  return (
    <div className="rf-chat-turn">
      <div className="rf-bubble-user">{question}</div>
      <div className="rf-ai-reply">
        {(turn.status === "loading" || turn.status === "streaming" || failed) && (
          <div className="rf-chat-status">
            {turn.status === "loading" && <span>正在思考…</span>}
            {turn.status === "streaming" && <span className="rf-chat-status-live">生成中…</span>}
            {failed && (
              <button type="button" className="rf-ask-mini" onClick={onRetry}>
                {turn.status === "error" ? "重试" : "配置好模型后重试"}
              </button>
            )}
          </div>
        )}
        <div className="rf-md text-sm leading-relaxed text-ink">
          <MarkdownText text={shownText(turn)} />
          {turn.status === "streaming" && <span className="rf-stream-caret" aria-hidden />}
        </div>
        {suggestion && !dismissed && (
          <div className="rf-suggest-card" role="group" aria-label="制卡建议">
            <p className="rf-suggest-text">
              <b>建议做成卡片</b>
              {suggestion}
            </p>
            <div className="rf-suggest-actions">
              <button type="button" className="rf-btn-solid" onClick={onMakeCard}>
                做成卡片
              </button>
              <button type="button" className="rf-btn-quiet" onClick={() => setDismissed(true)}>
                暂不需要
              </button>
            </div>
          </div>
        )}
        {showFeedback && (
          <FeedbackRow
            value={turn.feedback}
            reason={turn.feedbackReason}
            error={turn.feedbackError}
            onRate={onRate}
            onReason={onReason}
          />
        )}
      </div>
    </div>
  );
}
