"use client";

import { useState } from "react";
import DuoProgress from "./DuoProgress";
import Reader, { type ReaderPara } from "./Reader";

/**
 * 阅读器外壳：进度条独立在正文卡片外（多邻国式），
 * Reader 通过 onCollect 回调上报收词数。
 */
export default function ReaderShell({
  textId,
  paragraphs,
  savedLemmas,
  goal,
}: {
  textId: string;
  paragraphs: ReaderPara[];
  savedLemmas: Set<string>;
  goal: number;
}) {
  const [collected, setCollected] = useState(savedLemmas.size);

  return (
    <>
      <div className="mb-5">
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

      <div className="duo-card px-8 py-9 md:px-10">
        <Reader
          textId={textId}
          paragraphs={paragraphs}
          savedLemmas={savedLemmas}
          onCollect={() => setCollected((c) => c + 1)}
        />
      </div>
    </>
  );
}
