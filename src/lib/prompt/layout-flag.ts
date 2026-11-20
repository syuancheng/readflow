/**
 * P57b：提示词结构开关（服务端，会读库，不属于要单测编译的纯函数目录）。
 *
 * 优先级：环境变量 READFLOW_PROMPT_LAYOUT=v1|v2 > 站级设置行 prompt.layout > 默认 v1。
 * 站级设置的改法（owner 在服务器上执行一次）：
 *   sqlite3 data/readflow.db "INSERT OR REPLACE INTO settings (user_id,key,value) VALUES ('__global__','prompt.layout','v2')"
 * 出问题把值改回 v1 即可回退，下一次请求立刻生效，不用重启。
 */
import { sqlite } from "@/db/sqlite";
import { GLOBAL_USER } from "@/db/ensure-auth";

export type PromptLayout = "v1" | "v2";

export function promptLayout(): PromptLayout {
  const env = process.env.READFLOW_PROMPT_LAYOUT;
  if (env === "v1" || env === "v2") return env;
  try {
    const row = sqlite
      .prepare("SELECT value FROM settings WHERE user_id = ? AND key = 'prompt.layout'")
      .get(GLOBAL_USER) as { value?: string } | undefined;
    return row?.value === "v2" ? "v2" : "v1";
  } catch {
    return "v1";
  }
}

/** 按 textId + 锚点从库里取句子窗口（只取这个用户自己的文章）。取不到返回 null，调用方回退到客户端传来的上下文 */
import { sentenceWindowOf, type SentenceWindow } from "./sentence-window";

export function sentenceWindowFor(
  userId: string,
  textId: string | undefined,
  anchor: { paragraphId: string; start: number; end: number } | undefined,
): SentenceWindow | null {
  if (!textId || !anchor) return null;
  try {
    const rows = sqlite
      .prepare(
        `SELECT p.id AS id, p.content AS content
           FROM paragraphs p JOIN texts t ON t.id = p.text_id
          WHERE p.text_id = ? AND t.user_id = ?
          ORDER BY p.idx`,
      )
      .all(textId, userId) as { id: string; content: string }[];
    const at = rows.findIndex((r) => r.id === anchor.paragraphId);
    if (at < 0) return null;
    const win = sentenceWindowOf(rows, at, anchor.start, anchor.end);
    return win.sentence ? win : null;
  } catch (err) {
    console.error("[prompt] 读取段落窗口失败，回退到客户端上下文:", err);
    return null;
  }
}
