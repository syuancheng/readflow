"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_PROFILE,
  initialsFrom,
  normalizeProfile,
  PROFILE_CHANGED_EVENT,
  type Profile,
} from "@/lib/profile-form";
import type { NavId } from "@/lib/settings-form";
import VoicePicker from "./VoicePicker";
import SettingsDialog from "./SettingsDialog";

/**
 * 右上角用户菜单（仿 Readlang）：头像按钮 + 下拉面板。
 * 面板里放「系统设置」：自动收词开关、发音音色。
 * 状态存 localStorage（readflow.autoSave），变更时广播
 * readflow.autosave 自定义事件，阅读页 Reader 监听后即时生效。
 *
 * 昵称 / 头像 / 签名来自 /api/settings 的 profile（本机资料，无账号体系）；
 * 设置中心保存后广播 readflow.profile，这里即时同步，不用刷新页面。
 */
export default function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const [autoSave, setAutoSave] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<NavId>("models");
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setAutoSave(localStorage.getItem("readflow.autoSave") !== "0");
  }, []);

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
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function toggleAutoSave() {
    setAutoSave((v) => {
      const next = !v;
      localStorage.setItem("readflow.autoSave", next ? "1" : "0");
      window.dispatchEvent(new CustomEvent("readflow.autosave", { detail: next }));
      return next;
    });
  }

  function openSettings(tab: NavId) {
    setOpen(false);
    setSettingsTab(tab);
    setSettingsOpen(true);
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
          </div>

          <p className="pm-section-title">系统设置</p>

          <button className="pm-row" onClick={toggleAutoSave} role="menuitemcheckbox" aria-checked={autoSave}>
            <span className="pm-row-label">
              自动收词
              <span className="pm-row-hint">点词/划句后自动存入词库</span>
            </span>
            <span className={`pm-switch ${autoSave ? "on" : ""}`} aria-hidden>
              <span className="pm-switch-knob" />
            </span>
          </button>

          <div className="pm-row pm-row-static">
            <span className="pm-row-label">
              发音音色
              <span className="pm-row-hint">切换后立即试听</span>
            </span>
            <VoicePicker />
          </div>

          <p className="pm-section-title">账户</p>
          <button className="pm-row" role="menuitem" onClick={() => openSettings("profile")}>
            <span className="pm-row-label">
              👤 个人资料
              <span className="pm-row-hint">昵称 · 头像 · 签名 · 账号与安全</span>
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
        </div>
      )}

      {settingsOpen && (
        <SettingsDialog
          initialTab={settingsTab}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
