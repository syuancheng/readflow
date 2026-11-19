import { randomUUID } from "node:crypto";
import { sqlite } from "@/db/sqlite";

export type QuickQuestion = { id: string; text: string };

/** 这个账号的常用问题，先加的在前 */
export function listQuickQuestions(userId: string): QuickQuestion[] {
  return sqlite
    .prepare("SELECT id, text FROM quick_questions WHERE user_id = ? ORDER BY created_at, rowid")
    .all(userId) as QuickQuestion[];
}

export function addQuickQuestion(userId: string, text: string): QuickQuestion {
  const id = randomUUID();
  sqlite
    .prepare("INSERT INTO quick_questions (id, user_id, text, created_at) VALUES (?, ?, ?, ?)")
    .run(id, userId, text, Date.now());
  return { id, text };
}

/** 只能删自己的；删到了返回 true */
export function removeQuickQuestion(userId: string, id: string): boolean {
  return sqlite.prepare("DELETE FROM quick_questions WHERE id = ? AND user_id = ?").run(id, userId).changes > 0;
}
