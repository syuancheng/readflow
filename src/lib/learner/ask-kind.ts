/** 讲解事件的 askKind 白名单（P32 §5.3）。缺省 'default'，非法值一律不信任。 */
import type { AskKind } from "./types";

export const ASK_KINDS: readonly AskKind[] = [
  "auto", "default", "word_only", "whole_sentence", "structure", "example", "custom",
];

export function narrowAskKind(v: unknown): AskKind {
  return typeof v === "string" && (ASK_KINDS as readonly string[]).includes(v)
    ? (v as AskKind)
    : "default";
}
