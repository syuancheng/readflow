"use client";

import { maskPhone } from "@/lib/phone";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_PROFILE,
  initialsFrom,
  normalizeProfile,
  PROFILE_CHANGED_EVENT,
  type Profile,
} from "@/lib/profile-form";
import type { NavId } from "@/lib/settings-form";
import SettingsDialog from "./SettingsDialog";

/**
 * 右上角用户菜单（仿 Readlang）：头像按钮 + 下拉面板。
 * P20 接上账户体系后，面板同时是「账号入口」：显示当前登录名、改密码、退出。
 *
 * 昵称 / 头像 / 签名仍来自 /api/settings 的 profile，但现在是**按账号隔离**的
 * 个人资料（settings 表的 profile.* 行不回退站级）。设置中心保存后广播
 * readflow.profile，这里即时同步，不用刷新页面。
 */
type Me = { username: string; displayName: string; phone: string | null; isOwner: boolean };

// 新增 UI 一律内联样式：globals.css 在增量构建里丢过新规则，别再踩
const inputStyle: React.CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "12px 12px",
  border: "1px solid var(--rf-border-strong)",
  borderRadius: "var(--rf-radius-md)",
  fontSize: "var(--rf-text-sm)",
  fontFamily: "inherit",
  outline: "none",
};

const backdropStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 60,
  display: "grid",
  placeItems: "center",
  padding: 24,
  background: "rgba(0,0,0,0.35)",
};

const modalStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 380,
  padding: "24px 24px",
  borderRadius: "var(--rf-radius-lg)",
  background: "var(--rf-bg-surface)",
  color: "var(--duo-ink)",
  boxShadow: "var(--rf-shadow-lg)",
};

export default function ProfileMenu() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<NavId>("models");
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [me, setMe] = useState<Me | null>(null);
  const [pwOpen, setPwOpen] = useState(false);
  const [pwCurrent, setPwCurrent] = useState("");
  const [pwNew, setPwNew] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwMsg, setPwMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/settings")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive && data?.profile) setProfile(normalizeProfile(data.profile));
      })
      .catch(() => {
        /* 离线时保留默认展示值即可 */
      });
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive && data?.user) {
          setMe({
            username: data.user.username,
            displayName: data.user.displayName ?? data.user.username,
            phone: typeof data.user.phone === "string" ? data.user.phone : null,
            isOwner: Boolean(data.user.isOwner),
          });
        }
      })
      .catch(() => {
        /* 登录态由 proxy + currentUser() 兜底，这里只影响菜单展示 */
      });
    function onProfileChanged(e: Event) {
      setProfile(normalizeProfile((e as CustomEvent<Profile>).detail));
    }
    window.addEventListener(PROFILE_CHANGED_EVENT, onProfileChanged);
    return () => {
      alive = false;
      window.removeEventListener(PROFILE_CHANGED_EVENT, onProfileChanged);
    };
  }, []);

  // 点击菜单外部 / 按 Esc 关闭
  useEffect(() => {
    if (!open && !pwOpen) return;
    function onDown(e: MouseEvent) {
      if (open && rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      setOpen(false);
      setPwOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, pwOpen]);

  function openSettings(tab: NavId) {
    setOpen(false);
    setSettingsTab(tab);
    setSettingsOpen(true);
  }

  async function logout() {
    setOpen(false);
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      // 服务端已吊销 session；清掉客户端可能缓存的页面再回登录页
      router.replace("/login");
      router.refresh();
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwMsg(null);
    if (!pwCurrent || !pwNew) {
      setPwMsg({ text: "请填写原密码和新密码", ok: false });
      return;
    }
    setPwBusy(true);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: pwCurrent, newPassword: pwNew }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPwMsg({ text: data?.error ?? "修改失败，请重试", ok: false });
        return;
      }
      setPwCurrent("");
      setPwNew("");
      // 接口会重发本设备的 session，同时吊销其它设备，无需重新登录
      setPwMsg({ text: "密码已更新，其它设备的登录态已失效", ok: true });
    } catch {
      setPwMsg({ text: "网络异常，请稍后重试", ok: false });
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <div className="profile-menu" ref={rootRef}>
      <button
        className="pm-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="个人菜单"
      >
        <span
          className="pm-avatar"
          data-avatar={profile.avatar ? "image" : "initials"}
          style={profile.avatar ? { backgroundImage: `url("${profile.avatar}")` } : undefined}
          aria-hidden
        >
          {!profile.avatar && initialsFrom(profile.displayName)}
        </span>
        <span className="pm-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="pm-dropdown" role="menu">
          <div className="pm-head">
            <p className="pm-name">{profile.displayName}</p>
            <p className="pm-sub">{profile.bio || DEFAULT_PROFILE.bio}</p>
            {me && (
              <p style={{ margin: "8px 0 0", fontSize: "var(--rf-text-xs)", fontWeight: 700, color: "var(--duo-ink-faint)" }}>
                @{me.username}
                {me.phone ? ` · ${maskPhone(me.phone)}` : ""}
                {me.isOwner ? " · 主账号" : ""}
              </p>
            )}
          </div>

          <p className="pm-section-title">账户</p>
          <button className="pm-row" role="menuitem" onClick={() => openSettings("profile")}>
            <span className="pm-row-label">
              👤 个人资料
              <span className="pm-row-hint">昵称 · 头像 · 签名</span>
            </span>
            <span className="pm-row-arrow" aria-hidden>›</span>
          </button>
          <button className="pm-row" role="menuitem" onClick={() => openSettings("models")}>
            <span className="pm-row-label">
              ⚙ 设置
              <span className="pm-row-hint">AI 模型 · 墨墨 · 浏览器插件</span>
            </span>
            <span className="pm-row-arrow" aria-hidden>›</span>
          </button>
          <button
            className="pm-row"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setPwMsg(null);
              setPwOpen(true);
            }}
          >
            <span className="pm-row-label">
              🔑 账号与安全
              <span className="pm-row-hint">修改密码</span>
            </span>
            <span className="pm-row-arrow" aria-hidden>›</span>
          </button>
          <button className="pm-row" role="menuitem" onClick={logout}>
            <span className="pm-row-label">
              ↪ 退出登录
              <span className="pm-row-hint">下次进入需要重新输入密码</span>
            </span>
            <span className="pm-row-arrow" aria-hidden>›</span>
          </button>
        </div>
      )}

      {settingsOpen && (
        <SettingsDialog initialTab={settingsTab} onClose={() => setSettingsOpen(false)} />
      )}

      {pwOpen && (
        <div style={backdropStyle} onClick={() => setPwOpen(false)}>
          <div style={modalStyle} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <h2 style={{ fontSize: "var(--rf-text-xl)", fontWeight: 700, margin: "0 0 8px" }}>修改密码</h2>
            <p style={{ fontSize: "var(--rf-text-sm)", lineHeight: 1.6, color: "var(--duo-ink-soft)", margin: "0 0 20px" }}>
              新密码至少 8 位。修改后其它设备会被强制登出，本机保持登录。
            </p>
            <form onSubmit={changePassword} style={{ display: "grid", gap: 16 }}>
              <label style={{ display: "grid", gap: 8, fontSize: "var(--rf-text-sm)", fontWeight: 700 }}>
                原密码
                <input
                  type="password"
                  autoComplete="current-password"
                  value={pwCurrent}
                  onChange={(e) => setPwCurrent(e.target.value)}
                  disabled={pwBusy}
                  style={inputStyle}
                />
              </label>
              <label style={{ display: "grid", gap: 8, fontSize: "var(--rf-text-sm)", fontWeight: 700 }}>
                新密码
                <input
                  type="password"
                  autoComplete="new-password"
                  value={pwNew}
                  onChange={(e) => setPwNew(e.target.value)}
                  placeholder="至少 8 位"
                  disabled={pwBusy}
                  style={inputStyle}
                />
              </label>
              {pwMsg && (
                <p
                  role="status"
                  style={{ margin: 0, fontSize: "var(--rf-text-sm)", fontWeight: 600, color: pwMsg.ok ? "var(--rf-success-text)" : "var(--rf-danger-text)" }}
                >
                  {pwMsg.text}
                </p>
              )}
              <div style={{ display: "flex", gap: 12, marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => setPwOpen(false)}
                  style={{
                    flex: 1,
                    padding: "12px 16px",
                    border: "1px solid var(--rf-border-strong)",
                    borderRadius: "var(--rf-radius-md)",
                    background: "var(--rf-bg-surface)",
                    fontSize: "var(--rf-text-sm)",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  关闭
                </button>
                <button
                  type="submit"
                  disabled={pwBusy}
                  style={{
                    flex: 1,
                    padding: "12px 16px",
                    border: "none",
                    borderBottom: "4px solid var(--rf-accent-edge)",
                    borderRadius: "var(--rf-radius-md)",
                    background: "var(--rf-accent)",
                    color: "var(--rf-text-inverse)",
                    fontSize: "var(--rf-text-sm)",
                    fontWeight: 700,
                    cursor: pwBusy ? "not-allowed" : "pointer",
                    opacity: pwBusy ? 0.6 : 1,
                  }}
                >
                  {pwBusy ? "请稍候…" : "保存"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
