"use client";

import { useEffect, useRef, useState } from "react";
import type { ProviderId } from "@/lib/config";
import { PROVIDERS } from "@/lib/config";
import { withRetry } from "@/lib/retry";
import {
  DEFAULT_PROFILE,
  initialsFrom,
  normalizeProfile,
  PROFILE_CHANGED_EVENT,
  PROFILE_LIMITS,
  validateProfile,
  type Profile,
  type ProfileErrors,
} from "@/lib/profile-form";
import VoicePicker from "./VoicePicker";
import {
  applyModelOption,
  CUSTOM_MODEL_OPTION,
  docsUrlFor,
  filterNavGroups,
  isPresetModel,
  modelOptionsFor,
  normalizeEndpoint,
  presetFor,
  PROVIDER_SELECT_LABEL,
  validateForm,
  type FormErrors,
  type FormValues,
  type NavId,
} from "@/lib/settings-form";

export type ProviderRow = {
  id: ProviderId;
  label: string;
  hint: string;
  protocol: string;
  configured: boolean;
  maskedKey: string;
  model: string;
  baseUrl: string;
  source: "db" | "env" | "none";
};

type SettingsPayload = {
  ok: boolean;
  activeProvider: string | null;
  providers: ProviderRow[];
  markji: { configured: boolean; maskedToken: string; fromEnv: boolean };
  extension: { token: string | null };
  profile?: Profile;
};

type Editor = { mode: "add" | "edit"; id: ProviderId };
type Note = { kind: "ok" | "err"; text: string };

const ICON: Record<ProviderId, { ch: string; bg: string }> = {
  deepseek: { ch: "D", bg: "#4d6bfe" },
  openai: { ch: "G", bg: "#0f9d76" },
  claude: { ch: "C", bg: "#d97757" },
  qwen: { ch: "通", bg: "#615ced" },
  custom: { ch: "自", bg: "#78909c" },
};

const emptyForm = (): FormValues => ({ apiKey: "", endpoint: "", model: "" });

/** 把选中的图片裁成正方形并压到 128px，输出内联 data URL（不落文件、不上传） */
function compressAvatar(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取图片失败"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("这个图片格式浏览器打不开"));
      img.onload = () => {
        const size = 128;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return reject(new Error("浏览器不支持图片处理"));
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size, size);
        const side = Math.min(img.width, img.height);
        ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

/** 本地版不提供的账号能力，以及各自的真实门槛（不画假按钮） */
const ACCOUNT_FEATURES = [
  {
    name: "绑定微信",
    why: "需企业/组织主体的开放平台「网站应用」+ 开发者资质认证（约 ¥300/年、按年复审）、已 ICP 备案的公网域名与 HTTPS 授权回调域、应用审核与扫码联调；个人主体基本申请不下来。",
  },
  { name: "绑定邮箱", why: "需要可用的邮件发送服务，以及验证邮件、找回流程。" },
  { name: "绑定手机号", why: "需要短信服务：实名资质、签名与模板审核、按条计费。" },
  { name: "修改登录密码", why: "当前没有用户表、密码哈希与会话机制，密码无从校验。" },
];

/** 网络请求统一重试（限流/断网/网关错误），4xx 不重试 */
async function request(url: string, init?: RequestInit): Promise<unknown> {
  return withRetry(
    async () => {
      const res = await fetch(url, init);
      if (!res.ok) {
        const msg = await res.text().catch(() => "");
        throw Object.assign(new Error(msg || `HTTP ${res.status}`), { status: res.status });
      }
      return res.json();
    },
    { attempts: 3, baseDelayMs: 400 },
  );
}

/** 细线图标，颜色跟随 currentColor */
function SvgIcon({ name, size = 18 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  switch (name) {
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="7" />
          <path d="m20 20-3.5-3.5" />
        </svg>
      );
    case "model":
      return (
        <svg {...common}>
          <path d="M12 3 4 7.5v9L12 21l8-4.5v-9L12 3Z" />
          <path d="m4 7.5 8 4.5 8-4.5M12 12v9" />
        </svg>
      );
    case "book":
      return (
        <svg {...common}>
          <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5V5.5Z" />
          <path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5A2.5 2.5 0 0 1 4 20.5Z" />
        </svg>
      );
    case "puzzle":
      return (
        <svg {...common}>
          <path d="M10 3h4v2.2a2 2 0 1 0 4 0V5h3v4h-1.8a2 2 0 1 0 0 4H21v4h-3v-1.8a2 2 0 1 0-4 0V17h-4v-2.8a2 2 0 1 0 0-4V13H3V9h1.2a2 2 0 1 0 4 0H10V3Z" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 3 4.5 6v5.5c0 4.4 3 7.7 7.5 9.5 4.5-1.8 7.5-5.1 7.5-9.5V6L12 3Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "user":
      return (
        <svg {...common}>
          <circle cx="12" cy="8" r="3.6" />
          <path d="M4.8 20a7.2 7.2 0 0 1 14.4 0" />
        </svg>
      );
    case "speaker":
      return (
        <svg {...common}>
          <path d="M4 9.5h3.2L12 5.5v13L7.2 14.5H4a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Z" />
          <path d="M16 9.2a4 4 0 0 1 0 5.6M18.8 6.6a7.6 7.6 0 0 1 0 10.8" />
        </svg>
      );
    case "eye":
      return (
        <svg {...common}>
          <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12Z" />
          <circle cx="12" cy="12" r="2.8" />
        </svg>
      );
    case "eye-off":
      return (
        <svg {...common}>
          <path d="M3 3 21 21" />
          <path d="M10.6 6.8A9.8 9.8 0 0 1 12 6.7c6 0 9.5 5.3 9.5 5.3a15 15 0 0 1-3 3.5M6.2 8.2A15.6 15.6 0 0 0 2.5 12S6 17.3 12 17.3c1 0 1.9-.1 2.7-.4" />
          <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
        </svg>
      );
    case "chevron":
      return (
        <svg {...common}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      );
    case "cloud":
      return (
        <svg {...common}>
          <path d="M7 18h10.5a3.5 3.5 0 0 0 .3-7A5.5 5.5 0 0 0 7.2 9.6 4.2 4.2 0 0 0 7 18Z" />
        </svg>
      );
    case "external":
      return (
        <svg {...common} width={14} height={14}>
          <path d="M14 4h6v6M20 4l-8 8" />
          <path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5" />
        </svg>
      );
    default:
      return null;
  }
}

const NAV_ICON: Record<NavId, string> = {
  profile: "user",
  models: "model",
  markji: "book",
  reading: "speaker",
  extension: "puzzle",
  storage: "shield",
};

/**
 * 设置中心（右上角头像 → 设置）。
 *
 * 视觉与信息架构对齐 WorkBuddy 设置页：搜索框 + 分组导航 + 右侧内容；
 * 「添加模型」是独立居中弹窗：供应商下拉 → API Key（显隐 + 测试连接）→ 模型名称，
 * 底部只有取消 / 保存，接口地址这类高级项默认折叠。
 */
export default function SettingsDialog({
  onClose,
  initialTab = "models",
}: {
  onClose: () => void;
  /** Profile 菜单里的「个人资料」入口可以直接落到对应导航项 */
  initialTab?: NavId;
}) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [tab, setTab] = useState<NavId>(initialTab);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [form, setForm] = useState<FormValues>(emptyForm());
  const [errors, setErrors] = useState<FormErrors>({});
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [customModel, setCustomModel] = useState("");
  const [testNote, setTestNote] = useState<Note | null>(null);
  const [markjiInput, setMarkjiInput] = useState("");
  const [showMarkji, setShowMarkji] = useState(false);
  const [notice, setNotice] = useState<Note | null>(null);
  const [profileDraft, setProfileDraft] = useState<Profile>(DEFAULT_PROFILE);
  const [profileErrors, setProfileErrors] = useState<ProfileErrors>({});
  const [autoSave, setAutoSave] = useState(true);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  async function load() {
    try {
      const payload = (await request("/api/settings")) as SettingsPayload;
      setData(payload);
      setActive(payload.activeProvider);
      if (payload.profile) setProfileDraft(normalizeProfile(payload.profile));
    } catch (err) {
      setNotice({ kind: "err", text: `读取配置失败：${String(err)}` });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 阅读偏好存 localStorage（与阅读页 Reader 共用同一份约定）
  useEffect(() => {
    setAutoSave(localStorage.getItem("readflow.autoSave") !== "0");
  }, []);

  /** 立即生效：写 localStorage + 广播，阅读页监听后即时切换，不用刷新 */
  function toggleAutoSave() {
    setAutoSave((v) => {
      const next = !v;
      localStorage.setItem("readflow.autoSave", next ? "1" : "0");
      window.dispatchEvent(new CustomEvent("readflow.autosave", { detail: next }));
      return next;
    });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (modelMenuOpen) setModelMenuOpen(false);
      else if (editor) setEditor(null);
      else onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editor, modelMenuOpen, onClose]);

  /** 统一写配置：每次只提交本次操作涉及的字段，保存后立即生效 */
  async function put(body: Record<string, unknown>): Promise<SettingsPayload | null> {
    setBusy("saving");
    try {
      const payload = (await request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })) as SettingsPayload;
      setData(payload);
      setActive(payload.activeProvider);
      if (payload.profile) {
        const p = normalizeProfile(payload.profile);
        setProfileDraft(p);
        // 右上角菜单与顶栏头像即时同步，不用刷新页面
        window.dispatchEvent(new CustomEvent(PROFILE_CHANGED_EVENT, { detail: p }));
      }
      return payload;
    } catch (err) {
      setNotice({ kind: "err", text: `保存失败：${err instanceof Error ? err.message : String(err)}` });
      return null;
    } finally {
      setBusy(null);
    }
  }

  // ---------- 模型服务 ----------

  function openAdd(id: ProviderId = "deepseek") {
    setNotice(null);
    setErrors({});
    setTestNote(null);
    setShowKey(false);
    setModelMenuOpen(false);
    setShowAdvanced(id === "custom");
    setForm({ apiKey: "", ...presetFor(id) });
    setEditor({ mode: "add", id });
  }

  function changeProvider(id: ProviderId) {
    if (!editor) return;
    setEditor({ ...editor, id });
    setForm({ apiKey: "", ...presetFor(id) });
    setErrors({});
    setTestNote(null);
    setModelMenuOpen(false);
    if (id === "custom") setShowAdvanced(true);
  }

  function openEdit(p: ProviderRow) {
    setNotice(null);
    setErrors({});
    setTestNote(null);
    setShowKey(false);
    setModelMenuOpen(false);
    setShowAdvanced(p.id === "custom" || Boolean(p.baseUrl && p.baseUrl !== presetFor(p.id).endpoint));
    setEditor({ mode: "edit", id: p.id });
    setForm({ apiKey: "", endpoint: p.baseUrl, model: p.model });
  }

  function closeEditor() {
    setEditor(null);
    setErrors({});
    setTestNote(null);
    setModelMenuOpen(false);
  }

  function patchForm(field: keyof FormValues, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
    setTestNote(null);
  }

  function chooseModel(option: string) {
    patchForm("model", applyModelOption(option, customModel, form.model));
    setModelMenuOpen(false);
    if (option === CUSTOM_MODEL_OPTION) modelInputRef.current?.focus();
  }

  async function selectProvider(id: ProviderId) {
    const label = data?.providers.find((p) => p.id === id)?.label ?? id;
    const payload = await put({ activeProvider: id });
    if (payload) setNotice({ kind: "ok", text: `已切换到 ${label}，之后的 AI 释义都会用它` });
  }

  /** 只保存表单，不关闭（测试连接时复用同一份配置） */
  async function saveForm(): Promise<boolean> {
    if (!editor) return false;
    const errs = validateForm(form, { editing: editor.mode === "edit" });
    setErrors(errs);
    if (Object.keys(errs).length > 0) {
      // 接口地址默认折叠，校验失败时展开，否则错误提示用户看不到
      if (errs.endpoint) setShowAdvanced(true);
      return false;
    }

    const patch: Record<string, string> = {
      baseUrl: normalizeEndpoint(form.endpoint),
      model: form.model.trim(),
    };
    if (form.apiKey.trim()) patch.apiKey = form.apiKey.trim();
    return Boolean(await put({ providers: { [editor.id]: patch } }));
  }

  async function saveAndClose() {
    if (!editor) return;
    const shouldActivate = editor.mode === "add" && !active;
    const id = editor.id;
    if (!(await saveForm())) return;
    if (shouldActivate) await put({ activeProvider: id });
    closeEditor();
    setNotice({ kind: "ok", text: shouldActivate ? "已添加模型并设为当前使用" : "模型配置已保存" });
  }

  async function testForm() {
    if (!editor) return;
    if (!(await saveForm())) return;
    const id = editor.id;
    setBusy(`test:${id}`);
    setTestNote(null);
    try {
      const res = (await request("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "ai", providerId: id }),
      })) as { ok: boolean; detail?: string; error?: string };
      setTestNote(
        res.ok
          ? { kind: "ok", text: res.detail ?? "连接成功" }
          : { kind: "err", text: res.error ?? "连接失败" },
      );
    } catch (err) {
      setTestNote({ kind: "err", text: `测试失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(null);
    }
  }

  async function removeProvider() {
    if (!editor) return;
    const id = editor.id;
    const payload = await put({
      providers: { [id]: { clear: true } },
      activeProvider: active === id ? null : active,
    });
    if (payload) {
      closeEditor();
      setNotice({ kind: "ok", text: "已移除该模型配置" });
    }
  }

  async function clearAllModels() {
    if (!window.confirm("清空所有模型的 API Key 与配置？墨墨与插件 Token 不受影响，此操作不可撤销。"))
      return;
    const providers = Object.fromEntries(PROVIDERS.map((p) => [p.id, { clear: true }]));
    const payload = await put({ providers, activeProvider: null });
    if (payload) setNotice({ kind: "ok", text: "已清空所有模型配置" });
  }

  // ---------- 墨墨 / 插件 ----------

  async function saveMarkji(): Promise<boolean> {
    if (!markjiInput.trim()) {
      setNotice({ kind: "err", text: "请输入墨墨开放 API Token" });
      return false;
    }
    const payload = await put({ markjiToken: markjiInput.trim() });
    if (payload) setMarkjiInput("");
    return Boolean(payload);
  }

  async function verifyMarkji() {
    // 输入框有值就先保存再验证；没值则直接验证已保存的 Token
    if (markjiInput.trim() && !(await saveMarkji())) return;
    setBusy("test:markji");
    try {
      const res = (await request("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "markji" }),
      })) as { ok: boolean; detail?: string; error?: string };
      setNotice(
        res.ok
          ? { kind: "ok", text: res.detail ?? "墨墨连接成功" }
          : { kind: "err", text: res.error ?? "墨墨验证失败" },
      );
    } catch (err) {
      setNotice({ kind: "err", text: `验证失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setBusy(null);
    }
  }

  async function clearMarkji() {
    setMarkjiInput("");
    const payload = await put({ markjiClear: true });
    if (payload) setNotice({ kind: "ok", text: "已清除墨墨 Token" });
  }

  async function regenerateToken() {
    const payload = await put({ regenerateExtensionToken: true });
    if (payload) setNotice({ kind: "ok", text: "已生成新的插件 Token，旧的立即失效" });
  }

  // ---------- 个人资料（本地展示用，不涉及账号体系） ----------

  function patchProfile(field: keyof Profile, value: string) {
    setProfileDraft((prev) => ({ ...prev, [field]: value }));
    setProfileErrors((prev) => ({ ...prev, [field]: undefined }));
  }

  async function onAvatarFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setNotice({ kind: "err", text: "请选择图片文件" });
      return;
    }
    try {
      patchProfile("avatar", await compressAvatar(file));
      setNotice(null);
    } catch (err) {
      setNotice({ kind: "err", text: err instanceof Error ? err.message : "头像处理失败" });
    }
  }

  async function saveProfile() {
    const errs = validateProfile(profileDraft);
    setProfileErrors(errs);
    if (Object.keys(errs).length > 0) {
      setNotice({ kind: "err", text: "请先修正资料里的错误" });
      return;
    }
    const payload = await put({ profile: normalizeProfile(profileDraft) });
    if (payload) setNotice({ kind: "ok", text: "个人资料已保存，右上角即时更新" });
  }

  async function resetProfile() {
    if (!window.confirm("恢复默认昵称、签名并移除头像？")) return;
    const payload = await put({ profileReset: true });
    if (payload) setNotice({ kind: "ok", text: "已恢复默认资料" });
  }

  const current = data?.providers.find((p) => p.id === active) ?? null;
  const isBusy = busy !== null;
  const groups = filterNavGroups(query);
  const options = editor ? modelOptionsFor(editor.id) : [];

  return (
    <div className="st-overlay" onMouseDown={onClose}>
      <div
        className="st-modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="st-head">
          <button className="st-close" onClick={onClose} aria-label="关闭设置">
            <span className="st-close-x">×</span>
          </button>
        </div>

        <div className="st-layout">
          <nav className="st-nav" aria-label="设置分组">
            <label className="st-search">
              <SvgIcon name="search" size={16} />
              <input
                id="st-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索设置项"
                aria-label="搜索设置项"
              />
            </label>
            {groups.map((g) => (
              <div className="st-nav-group" key={g.title}>
                <div className="st-nav-group-title">{g.title}</div>
                {g.items.map((it) => (
                  <button
                    key={it.id}
                    className={`st-nav-item ${tab === it.id ? "st-nav-item-on" : ""}`}
                    onClick={() => {
                      setTab(it.id);
                      setNotice(null);
                    }}
                  >
                    <SvgIcon name={NAV_ICON[it.id]} size={17} />
                    <span>{it.title}</span>
                  </button>
                ))}
              </div>
            ))}
            {groups.length === 0 && <p className="st-nav-empty">没有匹配的设置项</p>}
          </nav>

          <div className="st-main">
            {notice && (
              <div className={`st-notice ${notice.kind === "ok" ? "st-notice-ok" : "st-notice-err"}`}>
                {notice.text}
              </div>
            )}

            {loading ? (
              <p className="st-loading">读取配置中…</p>
            ) : (
              <>
                {tab === "profile" && (
                  <section className="st-section">
                    <div className="st-panel">
                      <div className="st-panel-row">
                        <div>
                          <h3 className="st-panel-title">个人资料</h3>
                          <p className="st-panel-desc">
                            只用于右上角菜单的展示，保存在本机数据库；不涉及登录，也不会上传云端。
                          </p>
                        </div>
                      </div>

                      <div className="st-pf-avatar-row">
                        <div
                          id="st-pf-avatar"
                          className="st-pf-avatar"
                          data-avatar={profileDraft.avatar ? "image" : "initials"}
                          style={
                            profileDraft.avatar
                              ? { backgroundImage: `url("${profileDraft.avatar}")` }
                              : undefined
                          }
                        >
                          {!profileDraft.avatar && initialsFrom(profileDraft.displayName)}
                        </div>
                        <div className="st-pf-avatar-actions">
                          <input
                            ref={avatarInputRef}
                            id="st-pf-avatar-file"
                            type="file"
                            accept="image/*"
                            hidden
                            onChange={(e) => {
                              void onAvatarFile(e.target.files?.[0]);
                              e.target.value = "";
                            }}
                          />
                          <div className="st-card-actions st-pf-avatar-btns">
                            <button
                              className="st-btn st-btn-ghost"
                              onClick={() => avatarInputRef.current?.click()}
                            >
                              上传头像
                            </button>
                            {profileDraft.avatar && (
                              <button
                                className="st-btn st-btn-quiet"
                                onClick={() => patchProfile("avatar", "")}
                              >
                                移除
                              </button>
                            )}
                          </div>
                          <p className="st-help">
                            支持 PNG / JPEG / WebP / GIF，自动裁成 128×128 并压缩，只存本机。
                          </p>
                        </div>
                      </div>

                      <div className="st-field">
                        <label className="st-label" htmlFor="st-pf-name">
                          昵称 <span>（显示在右上角菜单）</span>
                        </label>
                        <div className="st-input-shell">
                          <input
                            id="st-pf-name"
                            className="st-input"
                            maxLength={PROFILE_LIMITS.displayName}
                            value={profileDraft.displayName}
                            onChange={(e) => patchProfile("displayName", e.target.value)}
                          />
                        </div>
                        {profileErrors.displayName && (
                          <p className="st-field-err">{profileErrors.displayName}</p>
                        )}
                      </div>

                      <div className="st-field">
                        <label className="st-label" htmlFor="st-pf-fullname">
                          名称 <span>（真实姓名，选填）</span>
                        </label>
                        <div className="st-input-shell">
                          <input
                            id="st-pf-fullname"
                            className="st-input"
                            maxLength={PROFILE_LIMITS.fullName}
                            placeholder="例如 Siyuan Cheng"
                            value={profileDraft.fullName}
                            onChange={(e) => patchProfile("fullName", e.target.value)}
                          />
                        </div>
                        {profileErrors.fullName && (
                          <p className="st-field-err">{profileErrors.fullName}</p>
                        )}
                      </div>

                      <div className="st-field">
                        <label className="st-label" htmlFor="st-pf-bio">
                          个性签名 <span>（昵称下方的一行说明）</span>
                        </label>
                        <div className="st-input-shell">
                          <input
                            id="st-pf-bio"
                            className="st-input"
                            maxLength={PROFILE_LIMITS.bio}
                            value={profileDraft.bio}
                            onChange={(e) => patchProfile("bio", e.target.value)}
                          />
                        </div>
                        {profileErrors.bio && <p className="st-field-err">{profileErrors.bio}</p>}
                      </div>

                      <div className="st-card-actions">
                        <button
                          className="st-btn st-btn-primary"
                          disabled={isBusy}
                          onClick={() => void saveProfile()}
                        >
                          {busy === "saving" ? "保存中…" : "保存资料"}
                        </button>
                        <button
                          className="st-btn st-btn-quiet"
                          disabled={isBusy}
                          onClick={() => void resetProfile()}
                        >
                          恢复默认
                        </button>
                      </div>
                    </div>

                    <div className="st-panel st-pf-account">
                      <div className="st-panel-row">
                        <div>
                          <h3 className="st-panel-title">账号与安全</h3>
                          <p className="st-panel-desc">
                            本应用是单人本地版：没有用户表、登录与会话，词库和设置都在这台机器的
                            SQLite 里。以下是尚未开放的能力与真实门槛，不做点了没反应的假按钮。
                          </p>
                        </div>
                      </div>
                      <ul className="st-pf-list">
                        {ACCOUNT_FEATURES.map((f) => (
                          <li className="st-pf-item" key={f.name}>
                            <div className="st-pf-item-head">
                              <b>{f.name}</b>
                              <span className="st-pf-badge">本地版未启用</span>
                            </div>
                            <p>{f.why}</p>
                          </li>
                        ))}
                      </ul>
                      <p className="st-pf-note">
                        要启用这些能力，需要先引入完整账号体系（用户表、会话、鉴权、数据隔离）并把数据迁到云端，
                        这与「所有数据只保存在本机」直接冲突；其中微信登录的资质与备案成本按周计算，
                        不适合混在个人资料页里做。
                      </p>
                    </div>
                  </section>
                )}

                {tab === "models" && (
                  <section className="st-section">
                    <div className="st-panel">
                      <div className="st-panel-row">
                        <div>
                          <h3 className="st-panel-title">自定义模型</h3>
                          <p className="st-panel-desc">
                            模型添加后会自动写入到本机{" "}
                            <code>data/readflow.db</code> 的 settings 表中。
                          </p>
                        </div>
                        <button className="st-add-btn" onClick={() => openAdd()}>
                          添加模型
                        </button>
                      </div>

                      <div className="st-current-line">
                        当前使用
                        <b>{current?.label ?? "尚未选择模型"}</b>
                        {current && <span>{current.model}</span>}
                      </div>

                      <div className="st-providers">
                        {(data?.providers ?? []).map((p) => {
                          const selected = active === p.id;
                          return (
                            <div
                              key={p.id}
                              className={`st-provider ${selected ? "st-provider-on" : ""}`}
                            >
                              <span
                                className="st-provider-icon"
                                style={{ background: ICON[p.id].bg }}
                              >
                                {ICON[p.id].ch}
                              </span>
                              <span className="st-provider-name">
                                <b>{p.label}</b>
                                <span>
                                  {p.configured ? `${p.model} · ${p.maskedKey}` : p.hint}
                                </span>
                              </span>
                              <span className="st-provider-actions">
                                <button
                                  className={`st-use ${selected ? "st-use-on" : ""}`}
                                  disabled={!p.configured || isBusy}
                                  onClick={() => void selectProvider(p.id)}
                                  role="radio"
                                  aria-checked={selected}
                                  aria-label={`使用 ${p.label}`}
                                >
                                  {selected ? "使用中" : "设为使用"}
                                </button>
                                <button
                                  className="st-mini-btn"
                                  onClick={() => (p.configured ? openEdit(p) : openAdd(p.id))}
                                >
                                  {p.configured ? "编辑" : "配置"}
                                </button>
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <p className="st-security">
                      请妥善保管 API Key：它关联您的账户与额度。密钥只保存在本机数据库、接口返回时一律脱敏；
                      自定义模型产生的费用由您向服务商支付，接入前请确认服务商可信。
                    </p>
                  </section>
                )}

                {tab === "reading" && (
                  <section className="st-section" id="st-reading-panel">
                    <div className="st-panel">
                      <div className="st-panel-row">
                        <div>
                          <h3 className="st-panel-title">阅读设置</h3>
                          <p className="st-panel-desc">
                            影响阅读页的收词与朗读，改动立即生效，不需要点保存。
                          </p>
                        </div>
                      </div>

                      <button
                        id="st-autosave"
                        className="st-reading-row"
                        role="switch"
                        aria-checked={autoSave}
                        onClick={toggleAutoSave}
                      >
                        <span className="st-reading-text">
                          <b>自动收词</b>
                          <span>点词 / 划句后自动存入词库；关掉后只在批注卡里手动收词</span>
                        </span>
                        <span className={`st-switch ${autoSave ? "on" : ""}`} aria-hidden>
                          <span className="st-switch-knob" />
                        </span>
                      </button>

                      <div className="st-reading-row st-reading-row-static">
                        <span className="st-reading-text">
                          <b>发音音色</b>
                          <span>朗读单词与释义时使用的本地英文音色，切换后立即试听</span>
                        </span>
                        <div className="st-reading-voice">
                          <VoicePicker />
                          <span className="st-reading-voice-empty">此设备没有可用的本地英文音色</span>
                        </div>
                      </div>
                    </div>
                    <p className="st-security">
                      这两项保存在这台电脑的浏览器里（localStorage），不上传云端；换浏览器或清空站点数据会恢复默认。
                    </p>
                  </section>
                )}

                {tab === "markji" && (
                  <section className="st-section">
                    <div className="st-panel">
                      <div className="st-panel-row">
                        <div>
                          <h3 className="st-panel-title">墨墨记单词</h3>
                          <p className="st-panel-desc">导出记忆卡时使用的开放 API Token。</p>
                        </div>
                      </div>
                      <div className="st-field">
                        <label className="st-label" htmlFor="st-markji-token">
                          开放 API Token
                        </label>
                        <div className="st-input-shell">
                          <input
                            id="st-markji-token"
                            className="st-input"
                            type={showMarkji ? "text" : "password"}
                            autoComplete="off"
                            placeholder={
                              data?.markji.configured
                                ? `已保存 ${data.markji.maskedToken}${data.markji.fromEnv ? "（来自环境变量）" : ""}`
                                : "墨墨开放 API Token"
                            }
                            value={markjiInput}
                            onChange={(e) => setMarkjiInput(e.target.value)}
                          />
                          <button
                            className="st-eye"
                            onClick={() => setShowMarkji(!showMarkji)}
                            aria-label={showMarkji ? "隐藏 Token" : "显示 Token"}
                          >
                            <SvgIcon name={showMarkji ? "eye-off" : "eye"} size={17} />
                          </button>
                        </div>
                        <p className="st-help">
                          获取路径：墨墨 App → 我的 → 更多设置 → 实验功能 → 开放 API。
                          {data?.markji.fromEnv ? "当前值来自 .env，需在该文件中删除才能清除。" : ""}
                        </p>
                      </div>
                      <div className="st-card-actions">
                        <button
                          className="st-btn st-btn-ghost"
                          disabled={isBusy}
                          onClick={() => void verifyMarkji()}
                        >
                          {busy === "test:markji" ? "验证中…" : "验证并保存"}
                        </button>
                        <button
                          className="st-btn st-btn-primary"
                          disabled={isBusy}
                          onClick={() => void saveMarkji()}
                        >
                          保存
                        </button>
                        {data?.markji.configured && !data.markji.fromEnv && (
                          <button className="st-btn st-btn-quiet" disabled={isBusy} onClick={() => void clearMarkji()}>
                            清除
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="st-security">
                      导出卡片前请先看预览：墨墨开放 API 不支持删卡，写入后只能在 App 端手动删除。
                    </p>
                  </section>
                )}

                {tab === "extension" && (
                  <section className="st-section">
                    <div className="st-panel">
                      <div className="st-panel-row">
                        <div>
                          <h3 className="st-panel-title">浏览器插件</h3>
                          <p className="st-panel-desc">把 Token 填进插件 popup 里即可同步词表。</p>
                        </div>
                      </div>
                      <div className="st-field">
                        <label className="st-label">同步 Token</label>
                        <div className="st-input-row">
                          <code className="st-token">{data?.extension.token ?? "尚未生成"}</code>
                          {data?.extension.token && (
                            <button
                              className="st-btn st-btn-ghost"
                              onClick={() => void navigator.clipboard?.writeText(data.extension.token!)}
                            >
                              复制
                            </button>
                          )}
                          <button
                            className="st-btn st-btn-quiet"
                            disabled={isBusy}
                            onClick={() => void regenerateToken()}
                          >
                            {data?.extension.token ? "重新生成" : "生成"}
                          </button>
                        </div>
                        <p className="st-help">重新生成会使旧 Token 立即失效。</p>
                      </div>
                    </div>
                    <p className="st-security">
                      服务地址填 http://localhost:3000（或你的部署域名）。插件目录：项目下的 extension/，
                      在 chrome://extensions 开启开发者模式后「加载已解压的扩展程序」。
                    </p>
                  </section>
                )}

                {tab === "storage" && (
                  <section className="st-section">
                    <div className="st-panel">
                      <div className="st-panel-row">
                        <div>
                          <h3 className="st-panel-title">本机数据</h3>
                          <p className="st-panel-desc">所有配置只保存在这台机器上。</p>
                        </div>
                      </div>
                      <ul className="st-facts">
                        <li>数据库：<code>data/readflow.db</code>（SQLite，WAL 模式）</li>
                        <li>API Key 与 Token 写入 settings 表，接口返回时只给后四位掩码</li>
                        <li>不会写回 .env，也不会上传到任何云端服务</li>
                        <li>浏览器插件通过独立的同步 Token 鉴权，可随时重新生成</li>
                      </ul>
                      <div className="st-card-actions">
                        <button className="st-btn st-btn-danger" disabled={isBusy} onClick={() => void clearAllModels()}>
                          清空所有模型配置
                        </button>
                      </div>
                    </div>
                    <p className="st-security">
                      清空只影响模型 API Key、接口地址与模型名；词库、文章、墨墨与插件 Token 均保留。
                    </p>
                  </section>
                )}
              </>
            )}
          </div>
        </div>
      </div>

      {/* 添加 / 编辑模型：独立居中弹窗 */}
      {editor && (
        <div
          className="st-editor-overlay"
          onMouseDown={(e) => {
            // 阻止冒泡到外层设置遮罩，否则点弹窗会把整个设置一起关掉
            e.stopPropagation();
            if (e.target === e.currentTarget) closeEditor();
          }}
        >
          <div
            className="st-editor"
            role="dialog"
            aria-modal="true"
            aria-label={editor.mode === "add" ? "添加模型" : "编辑模型"}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="st-editor-head">
              <h3>{editor.mode === "add" ? "添加模型" : `编辑 ${PROVIDER_SELECT_LABEL[editor.id]}`}</h3>
              <button className="st-close" onClick={closeEditor} aria-label="关闭">
                <span className="st-close-x">×</span>
              </button>
            </div>

            <div className="st-editor-body">
              <div className="st-field">
                <div className="st-field-head">
                  <label className="st-label" htmlFor="st-provider">
                    供应商 <span>（支持 OpenAI 兼容 / Anthropic 协议）</span>
                  </label>
                  <a
                    className="st-docs"
                    href={docsUrlFor(editor.id)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    查看文档 <SvgIcon name="external" />
                  </a>
                </div>
                <div className="st-select-wrap">
                  <span className="st-select-lead">
                    <SvgIcon name="cloud" size={19} />
                  </span>
                  <select
                    id="st-provider"
                    className="st-select"
                    value={editor.id}
                    disabled={editor.mode === "edit"}
                    onChange={(e) => changeProvider(e.target.value as ProviderId)}
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {PROVIDER_SELECT_LABEL[p.id]}
                      </option>
                    ))}
                  </select>
                  <span className="st-select-arrow">
                    <SvgIcon name="chevron" size={17} />
                  </span>
                </div>
                {editor.mode === "edit" && (
                  <p className="st-help">编辑时不可更换供应商；需要更换请先移除后重新添加。</p>
                )}
              </div>

              <div className="st-field">
                <label className="st-label" htmlFor="st-api-key">
                  API Key
                </label>
                <div className="st-key-row">
                  <div className="st-input-shell">
                    <input
                      id="st-api-key"
                      className="st-input"
                      type={showKey ? "text" : "password"}
                      autoComplete="off"
                      placeholder={
                        editor.mode === "edit" && data?.providers.find((p) => p.id === editor.id)?.maskedKey
                          ? `已保存 ${data.providers.find((p) => p.id === editor.id)!.maskedKey}，留空表示不修改`
                          : "输入你的 API Key"
                      }
                      value={form.apiKey}
                      onChange={(e) => patchForm("apiKey", e.target.value)}
                    />
                    <button
                      className="st-eye"
                      onClick={() => setShowKey(!showKey)}
                      aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
                    >
                      <SvgIcon name={showKey ? "eye-off" : "eye"} size={17} />
                    </button>
                  </div>
                  <button className="st-test-btn" disabled={isBusy} onClick={() => void testForm()}>
                    {busy?.startsWith("test:") ? "测试中…" : "测试连接"}
                  </button>
                </div>
                {errors.apiKey && <p className="st-field-err">{errors.apiKey}</p>}
                {testNote && (
                  <p className={testNote.kind === "ok" ? "st-test-ok" : "st-field-err"}>
                    {testNote.text}
                  </p>
                )}
              </div>

              <div className="st-field">
                <label className="st-label" htmlFor="st-model">
                  模型名称
                </label>
                <div className="st-select-wrap">
                  <input
                    id="st-model"
                    ref={modelInputRef}
                    className="st-select st-select-input"
                    value={form.model}
                    placeholder="选择或输入模型名称"
                    onChange={(e) => patchForm("model", e.target.value)}
                  />
                  {form.model && !isPresetModel(editor.id, form.model) && (
                    <span className="st-custom-tag">自定义</span>
                  )}
                  <button
                    className="st-select-arrow st-select-arrow-btn"
                    aria-label="选择模型名称"
                    onClick={() => {
                      setCustomModel(form.model);
                      setModelMenuOpen((v) => !v);
                    }}
                  >
                    <SvgIcon name="chevron" size={17} />
                  </button>
                  {modelMenuOpen && (
                    <div className="st-menu" role="listbox">
                      {options.map((m, i) => (
                        <button key={m} className="st-menu-item" onClick={() => chooseModel(m)}>
                          {m}
                          {i === 0 && <small>默认</small>}
                        </button>
                      ))}
                      <div className="st-menu-sep" />
                      <button
                        className="st-menu-item"
                        onClick={() => chooseModel(CUSTOM_MODEL_OPTION)}
                      >
                        自定义模型名…
                      </button>
                    </div>
                  )}
                </div>
                {errors.model && <p className="st-field-err">{errors.model}</p>}
              </div>

              <button className="st-advanced" onClick={() => setShowAdvanced((v) => !v)}>
                <span className={showAdvanced ? "st-advanced-arrow open" : "st-advanced-arrow"}>
                  <SvgIcon name="chevron" size={15} />
                </span>
                高级设置 · 接口地址
              </button>
              {showAdvanced && (
                <div className="st-field st-advanced-field">
                  <label className="st-label" htmlFor="st-endpoint">
                    接口地址
                  </label>
                  <div className="st-input-shell">
                    <input
                      id="st-endpoint"
                      className="st-input"
                      placeholder="https://api.example.com/v1"
                      value={form.endpoint}
                      onChange={(e) => patchForm("endpoint", e.target.value)}
                    />
                  </div>
                  {errors.endpoint && <p className="st-field-err">{errors.endpoint}</p>}
                  <p className="st-help">填写基地址即可，SDK 会自动补 /chat/completions。</p>
                </div>
              )}
            </div>

            <div className="st-editor-foot">
              {editor.mode === "edit" && (
                <button className="st-remove" onClick={() => void removeProvider()} disabled={isBusy}>
                  移除此模型配置
                </button>
              )}
              <span className="st-editor-foot-spacer" />
              <button className="st-btn st-btn-ghost" onClick={closeEditor}>
                取消
              </button>
              <button
                className="st-btn st-btn-primary"
                disabled={isBusy}
                onClick={() => void saveAndClose()}
              >
                {busy === "saving" ? "保存中…" : "保存"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
