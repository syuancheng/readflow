"use client";

import { useEffect, useState } from "react";
import DuoProgress from "./DuoProgress";
import Reader, { type ReaderPara, type SavedWordInfo } from "./Reader";

/**
 * 阅读器外壳：进度条独立在正文卡片外（多邻国式），
 * Reader 通过 onCollect 回调上报收词数。
 * 「自动收词」开关存 localStorage，默认开启（对齐 Readlang 的点词即存）。
 */
export default function ReaderShell({
  textId,
  paragraphs,
  savedWords,
  focusParaId,
  goal,
}: {
  textId: string;
  paragraphs: ReaderPara[];
  savedWords: SavedWordInfo[];
  focusParaId?: string;
  goal: number;
}) {
  const [collected, setCollected] = useState(savedWords.length);
  const [autoSave, setAutoSave] = useState(true);

  useEffect(() => {
    setAutoSave(localStorage.getItem("readflow.autoSave") !== "0");
  }, []);

  function toggleAutoSave() {
    setAutoSave((v) => {
      const next = !v;
      localStorage.setItem("readflow.autoSave", next ? "1" : "0");
      return next;
    });
  }

  return (
    <>
      <div className="mb-5 flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <DuoProgress
            value={collected}
            max={goal}
            label="今日目标"
            hint={
              collected >= goal
                ? "太棒了，今天的目标已完成！"
                : `再收集 ${goal - collected} 个词就完成今天的目标`
            }
          />
        </div>
        <button
          className="autosave-pill"
          onClick={toggleAutoSave}
          title="开启后，点词会自动收进词库（对齐 Readlang）；关闭则只在深入弹层里手动收词"
        >
          <span
            className="autosave-dot"
            style={{ background: autoSave ? "var(--duo-green)" : "var(--duo-ink-faint)" }}
          />
          自动收词 {autoSave ? "开" : "关"}
        </button>
      </div>

      <div className="duo-card px-8 py-9 md:px-10">
        <Reader
          textId={textId}
          paragraphs={paragraphs}
          savedWords={savedWords}
          focusParaId={focusParaId}
          autoSave={autoSave}
          onCollect={() => setCollected((c) => c + 1)}
        />
      </div>
    </>
  );
}
