/**
 * 旧 E2E 脚本的登录辅助（P20）。
 *
 * middleware 上线后，所有页面与非公开 API 都需要 session cookie。原来的
 * e2e-readlang / e2e-auto-explain / e2e-gloss-persist / e2e-spine-render /
 * e2e-extension 全是「裸跑」，不注入登录态就会得到一整片假阴性。
 *
 * 用法（每个脚本开头，必须在任何 fetch / goto 之前）：
 *   import { ensureAuth, authCookies } from "./e2e-auth.mjs";
 *   await ensureAuth(BASE);                       // patch Node 侧 fetch
 *   await ctx.addCookies(authCookies(BASE));     // Playwright 侧注入
 *
 * 账号来自环境变量 E2E_USER / E2E_PASS。**不会自动建号**：真实用户库里
 * 替谁创建账号都不合适。想跑干净的隔离回归请用 npm run test:account
 * （临时 DB + 临时端口，自己建号、自己清理）。
 */
const COOKIE_NAME = "readflow_session";
let cookieHeader = "";

export async function ensureAuth(BASE) {
  const nativeFetch = globalThis.fetch;
  const status = await nativeFetch(`${BASE}/api/auth/status`)
    .then((r) => r.json())
    .catch((e) => {
      throw new Error(`连不上 ${BASE}/api/auth/status：${e.message}`);
    });
  if (status.needsSetup) {
    throw new Error(
      `目标库还没建账号。请先在浏览器完成 /setup，再用 E2E_USER / E2E_PASS 指定该账号；` +
        `或跑 npm run test:account（临时库，自动建号）。`,
    );
  }

  const username = process.env.E2E_USER || "e2e_owner";
  const password = process.env.E2E_PASS || "owner-pass-2026";
  const res = await nativeFetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    throw new Error(
      `E2E 登录失败（${res.status}）。用 E2E_USER / E2E_PASS 指定正确账号；` +
        `注意连续失败 5 次会被限速 60 秒。响应：${await res.text()}`,
    );
  }
  const raw = res.headers.get("set-cookie") ?? "";
  const m = raw.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!m) throw new Error("登录响应里没有 session cookie");
  cookieHeader = `${COOKIE_NAME}=${m[1]}`;

  // 旧脚本里有大量 Node 侧 fetch(BASE + "/api/...")，逐个改参数不现实，
  // 统一在这里给指向目标服务的请求补 Cookie。
  globalThis.fetch = (input, init = {}) => {
    const url = typeof input === "string" ? input : input && typeof input === "object" && "url" in input ? input.url : "";
    if (url.startsWith(BASE)) {
      const headers = new Headers(init.headers ?? {});
      if (!headers.has("cookie")) headers.set("cookie", cookieHeader);
      return nativeFetch(input, { ...init, headers });
    }
    return nativeFetch(input, init);
  };
  return cookieHeader;
}

/** Playwright context.addCookies 用；只作用于目标域名，不外泄给文章里的外链图片。 */
export function authCookies(BASE) {
  if (!cookieHeader) throw new Error("请先 await ensureAuth(BASE)");
  const u = new URL(BASE);
  return [
    {
      name: COOKIE_NAME,
      value: cookieHeader.slice(COOKIE_NAME.length + 1),
      domain: u.hostname,
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
      secure: false,
    },
  ];
}
