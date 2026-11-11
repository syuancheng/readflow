import { NextResponse } from "next/server";
import { listChapters, listDecks, MarkjiError } from "@/lib/markji";
import { markjiTokenFor } from "@/lib/user-secrets";
import { currentUser } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/markji/decks           → 牌组列表
 * GET /api/markji/decks?deckId=x  → 该牌组下的章节列表
 *
 * 为什么要代理这两个读接口：token 只在服务端，浏览器不能碰。
 * 也因为墨墨开放 API **不能建牌组/章节** —— 用户只能从已有的里面选。
 */
export async function GET(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ ok: false, error: "请先登录" }, { status: 401 });
  // P28：每个账号用自己的墨墨 Token，普通账号不回退主账号的
  const token = markjiTokenFor(user);
  if (!token) {
    return NextResponse.json(
      {
        ok: false,
        error: "未配置墨墨 Token。请在右上角头像 → 设置 → 墨墨记单词里填入你的开放 API Token。",
      },
      { status: 200 },
    );
  }

  const deckId = new URL(req.url).searchParams.get("deckId");

  try {
    if (deckId) {
      const chapters = await listChapters(deckId, token);
      return NextResponse.json({ ok: true, chapters });
    }
    const decks = await listDecks(token);
    return NextResponse.json({ ok: true, decks });
  } catch (err) {
    const msg = err instanceof MarkjiError ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }
}
