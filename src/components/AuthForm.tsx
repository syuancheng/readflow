"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * 登录 / 首次建号 / 邀请码注册的共用表单。
 * 不开放注册：/setup 只在没有任何账号时可用（建主账号）；
 * 之后新用户必须拿主账号发的邀请码到 /register 注册（P28）。
 */
export default function AuthForm({ mode }: { mode: "login" | "setup" | "register" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [inviteCode, setInviteCode] = useState(() => params.get("code") ?? "");
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  /** 建主账号与邀请码注册都是「新建账号」：要手机号、要确认密码 */
  const isNew = mode !== "login";

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!alive || !s) return;
        // 没有账号只能去建号；已有账号不能直接访问 /setup
        if (s.needsSetup && mode !== "setup") router.replace("/setup");
        else if (!s.needsSetup && mode === "setup") router.replace("/login");
        else setChecking(false);
      })
      .catch(() => setChecking(false));
    return () => {
      alive = false;
    };
  }, [mode, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (mode === "register" && !inviteCode.trim()) {
      setError("请填写邀请码");
      return;
    }
    if (!username.trim() || !password) {
      setError(isNew ? "请填写用户名和密码" : "请填写用户名或手机号，以及密码");
      return;
    }
    if (isNew && !phone.trim()) {
      setError("请填写手机号");
      return;
    }
    if (isNew && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          mode === "setup"
            ? { username: username.trim(), phone: phone.trim(), password, displayName: username.trim() }
            : mode === "register"
              ? { inviteCode: inviteCode.trim(), username: username.trim(), phone: phone.trim(), password }
              : { account: username.trim(), password },
        ),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data?.error ?? "操作失败，请重试");
        return;
      }
      const next = params.get("next");
      router.replace(next && next.startsWith("/") ? next : "/");
      router.refresh();
    } catch {
      setError("网络异常，请稍后重试");
    } finally {
      setBusy(false);
    }
  }

  const isSetup = mode === "setup";

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: 24,
        background: "var(--duo-bg, #fff)",
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 400,
          padding: "32px 30px",
          border: "2px solid var(--duo-border, #e5e5e5)",
          borderRadius: 18,
          background: "#fff",
          boxShadow: "0 6px 0 var(--duo-border, #e5e5e5)",
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 800, letterSpacing: "0.08em", color: "var(--duo-blue, #1cb0f6)" }}>
          READFLOW
        </div>
        <h1 style={{ fontSize: 26, fontWeight: 800, margin: "10px 0 6px", color: "var(--duo-ink, #3c3c3c)" }}>
          {isSetup ? "创建你的账号" : mode === "register" ? "用邀请码注册" : "欢迎回来"}
        </h1>
        <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--duo-ink-soft, #777)", marginBottom: 22 }}>
          {isSetup
            ? "这是站点的第一个账号（主账号），你现有的文章、词库和设置会自动归到它名下。之后新用户凭你发的邀请码注册。"
            : mode === "register"
              ? "ReadFlow 目前只接受邀请注册。填上朋友发给你的邀请码，建一个自己的账号。"
              : "登录后继续阅读。"}
        </p>

        <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
          {mode === "register" && (
            <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
              邀请码
              <input
                autoComplete="off"
                autoCapitalize="characters"
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                placeholder="8 位，例如 K7QM-3XPA"
                disabled={checking || busy}
                style={{ ...inputStyle, letterSpacing: "0.08em", fontWeight: 700 }}
              />
            </label>
          )}
          <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
            {isNew ? "用户名" : "用户名 / 手机号"}
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={isNew ? "中英文、数字均可" : "输入用户名或手机号"}
              disabled={checking || busy}
              style={inputStyle}
            />
          </label>
          {isNew && (
            <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
              手机号
              <input
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="11 位手机号，以后可用它登录"
                disabled={checking || busy}
                style={inputStyle}
              />
              <span style={{ fontSize: 12, fontWeight: 500, color: "var(--duo-ink-faint, #afafaf)" }}>
                只用作登录名，不会发送验证码。
              </span>
            </label>
          )}
          <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
            密码
            <input
              type="password"
              autoComplete={isNew ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isNew ? "至少 8 位" : "输入密码"}
              disabled={checking || busy}
              style={inputStyle}
            />
          </label>
          {isNew && (
            <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
              确认密码
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="再输入一次"
                disabled={checking || busy}
                style={inputStyle}
              />
            </label>
          )}

          {error && (
            <p style={{ margin: 0, fontSize: 13, color: "#d33", fontWeight: 600 }} role="alert">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={checking || busy}
            style={{
              marginTop: 4,
              padding: "12px 16px",
              border: "none",
              borderRadius: 12,
              background: "var(--duo-blue, #1cb0f6)",
              color: "#fff",
              fontSize: 15,
              fontWeight: 800,
              cursor: checking || busy ? "not-allowed" : "pointer",
              opacity: checking || busy ? 0.6 : 1,
            }}
          >
            {busy ? "请稍候…" : isSetup ? "创建并进入" : mode === "register" ? "注册并进入" : "登录"}
          </button>
        </form>

        {mode === "login" && (
          <>
            <p style={{ marginTop: 18, fontSize: 14, fontWeight: 700, textAlign: "center" }}>
              还没有账号？
              <Link href="/register" style={{ color: "var(--duo-blue, #1cb0f6)" }}>
                有邀请码，去注册 →
              </Link>
            </p>
            <p style={{ marginTop: 10, fontSize: 12, color: "var(--duo-ink-faint, #afafaf)", lineHeight: 1.6 }}>
              忘记密码？请联系邀请你的人（站点管理员）帮你重置。
            </p>
          </>
        )}
        {mode === "register" && (
          <p style={{ marginTop: 18, fontSize: 14, fontWeight: 700, textAlign: "center" }}>
            已经有账号了？
            <Link href="/login" style={{ color: "var(--duo-blue, #1cb0f6)" }}>
              去登录 →
            </Link>
          </p>
        )}
      </div>
    </main>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "10px 12px",
  border: "2px solid var(--duo-border, #e5e5e5)",
  borderRadius: 10,
  fontSize: 14,
  fontFamily: "inherit",
  outline: "none",
};
