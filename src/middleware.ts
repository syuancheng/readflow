/**
 * 登录守门（P20）。
 *
 * 只做「有没有 session cookie」这一层粗判断 —— middleware 默认跑在
 * Edge runtime，用不了 node:crypto 也连不了 SQLite。**真正的校验在 Node 侧**
 * 的 lib/auth.ts currentUser()：伪造 / 过期 / 已吊销的 cookie 会在那里被挡，
 * 所有页面与 API 都必须调用它，不能把这里当成安全边界。
 *
 * 公开入口：/login、/setup、/api/auth/*（status 判断是否需要首次建号）。
 * 插件链路用站级 extension token 鉴权、图片代理不含用户数据，两者不拦。
 */
import { NextResponse, type NextRequest } from "next/server";

const SESSION_COOKIE = "readflow_session";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasCookie = Boolean(req.cookies.get(SESSION_COOKIE)?.value);

  if (pathname.startsWith("/api/auth/")) return NextResponse.next();
  if (pathname.startsWith("/api/extension/") || pathname === "/api/img") return NextResponse.next();

  if (pathname === "/login" || pathname === "/setup") {
    // 已登录就不该再看到登录页；/setup 保持可访问由接口自己判 hasAnyUser
    if (hasCookie && pathname === "/login") {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  if (hasCookie) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "请先登录" }, { status: 401 });
  }
  const url = new URL("/login", req.url);
  if (pathname !== "/") url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // 静态资源、字体、favicon 不进 middleware
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf|css|js|map)$).*)",
  ],
};
