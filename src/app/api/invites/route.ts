/**
 * 邀请码管理（P28），只有 owner 能用。
 *   GET    /api/invites                    列出全部邀请码（含用了几次、谁用的）
 *   POST   /api/invites  { maxUses, note } 生成一个新码
 *   DELETE /api/invites?code=XXXX-XXXX     作废（已注册的账号不受影响）
 */
import { NextResponse } from "next/server";
import { currentUser } from "@/lib/auth";
import { createInvite, listInvites, normalizeInviteCode, revokeInvite } from "@/lib/invites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function owner() {
  const user = await currentUser();
  if (!user) return { error: NextResponse.json({ error: "请先登录" }, { status: 401 }) };
  if (!user.isOwner) return { error: NextResponse.json({ error: "只有主账号可以管理邀请码" }, { status: 403 }) };
  return { user };
}

export async function GET() {
  const { error } = await owner();
  if (error) return error;
  return NextResponse.json({ ok: true, invites: listInvites() });
}

export async function POST(req: Request) {
  const { user, error } = await owner();
  if (error) return error;
  let body: { maxUses?: unknown; note?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* 空 body 用默认值 */
  }
  const maxUses = typeof body.maxUses === "number" ? body.maxUses : 1;
  const note = typeof body.note === "string" ? body.note : null;
  const code = createInvite(user.id, maxUses, note);
  return NextResponse.json({ ok: true, code, invites: listInvites() });
}

export async function DELETE(req: Request) {
  const { error } = await owner();
  if (error) return error;
  const code = normalizeInviteCode(new URL(req.url).searchParams.get("code"));
  if (!code || !revokeInvite(code)) return NextResponse.json({ error: "没有这个邀请码" }, { status: 404 });
  return NextResponse.json({ ok: true, invites: listInvites() });
}
