/** POST /api/auth/logout —— 吊销当前 session 并清 cookie。 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { revokeSession, SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  revokeSession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(sessionCookieOptions(req, null));
  return res;
}
