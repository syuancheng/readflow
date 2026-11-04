"use client";

import { useEffect, useRef, useState } from "react";
import VoicePicker from "./VoicePicker";
import SettingsDialog from "./SettingsDialog";

/**
 * 右上角用户菜单（仿 Readlang）：头像按钮 + 下拉面板。
 * 面板里放「系统设置」：自动收词开关、发音音色。
 * 状态存 localStorage（readflow.autoSave），变更时广播
 * readflow.autosave 自定义事件，阅读页 Reader 监听后即时生效。
 */
export default function ProfileMenu() {
  const [open, setOpen] = useState(false);
  const [autoSave, setAutoSave] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setAutoSave(localStorage.getItem("readflow.autoSave") !== "0");
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

  return (
    <div className="profile-menu" ref={rootRef}>
      <button
        className="pm-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="个人菜单"
      >
        <span className="pm-avatar" aria-hidden>
          S
        </span>
        <span className="pm-caret" aria-hidden>
          ▾
        </span>
      </button>

      {open && (
        <div className="pm-dropdown" role="menu">
          <div className="pm-head">
            <p className="pm-name">Siyuan Cheng</p>
            <p className="pm-sub">学英语 · 读原文</p>
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
          <button
            className="pm-row"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              setSettingsOpen(true);
            }}
          >
            <span className="pm-row-label">
              ⚙ 设置
              <span className="pm-row-hint">AI 模型 · 墨墨 · 浏览器插件</span>
            </span>
            <span className="pm-row-arrow" aria-hidden>›</span>
          </button>
        </div>
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
