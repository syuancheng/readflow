"use client";

import Reader, { type ReaderPara, type SavedWordInfo } from "./Reader";

/**
 * 阅读器外壳：黄金分割双栏（文章 61.8% + 批注栏 38.2%）。
 * 「今日目标」进度条已按用户要求移除；「自动收词」开关移入右侧批注栏，
 * 状态与 localStorage 均由 Reader 管理。
 */
export default function ReaderShell({
  textId,
  paragraphs,
  savedWords,
  focusParaId,
}: {
  textId: string;
  paragraphs: ReaderPara[];
  savedWords: SavedWordInfo[];
  focusParaId?: string;
}) {
  return (
    <Reader
      textId={textId}
      paragraphs={paragraphs}
      savedWords={savedWords}
      focusParaId={focusParaId}
    />
  );
}
