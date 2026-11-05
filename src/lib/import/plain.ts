import { splitParagraphs } from "../split";
import type { Block } from "./types";

/** 纯文本适配器：行为与改造前完全一致，保证新闻 / 小说零回归。 */
export function parsePlain(raw: string): Block[] {
  return splitParagraphs(raw).map((text) => ({
    kind: "paragraph" as const,
    text,
    ranges: [],
    meta: {},
  }));
}
