"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * 登录 / 首次建号的共用表单（P20）。
 * 关闭开放注册：唯一建号入口是 /setup，且只有 users 表为空时接口才接受。
 */
export default function AuthForm({ mode }: { mode: "login" | "setup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch("/api/auth/status")
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => {
        if (!alive || !s) return;
        // 没有账号只能去建号；已有账号不能直接访问 /setup
        if (s.needsSetup && mode === "login") router.replace("/setup");
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
    if (!username.trim() || !password) {
      setError("请填写用户名和密码");
      return;
    }
    if (mode === "setup" && password !== confirm) {
      setError("两次输入的密码不一致");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          password,
          ...(mode === "setup" ? { displayName: username.trim() } : {}),
        }),
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
          {isSetup ? "创建你的账号" : "欢迎回来"}
        </h1>
        <p style={{ fontSize: 13.5, lineHeight: 1.6, color: "var(--duo-ink-soft, #777)", marginBottom: 22 }}>
          {isSetup
            ? "这是本机的第一个账号，你现有的文章、词库和设置会自动归到它名下。之后不再开放自由注册。"
            : "登录后继续阅读。数据全部保存在这台电脑里，不经过任何第三方服务。"}
        </p>

        <form onSubmit={submit} style={{ display: "grid", gap: 14 }}>
          <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
            用户名
            <input
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="中英文、数字均可"
              disabled={checking || busy}
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 6, fontSize: 13, fontWeight: 700 }}>
            密码
            <input
              type="password"
              autoComplete={isSetup ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isSetup ? "至少 8 位" : "输入密码"}
              disabled={checking || busy}
              style={inputStyle}
            />
          </label>
          {isSetup && (
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
            {busy ? "请稍候…" : isSetup ? "创建并进入" : "登录"}
          </button>
        </form>

        {!isSetup && (
          <p style={{ marginTop: 18, fontSize: 12, color: "var(--duo-ink-faint, #afafaf)", lineHeight: 1.6 }}>
            忘记密码？在项目目录运行 <code>npm run reset-password -- 用户名</code> 重置。
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
