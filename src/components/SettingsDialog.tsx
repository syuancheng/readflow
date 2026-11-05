"use client";

import { useEffect, useState } from "react";
import type { ProviderId } from "@/lib/config";
import { withRetry } from "@/lib/retry";
import {
  normalizeEndpoint,
  presetFor,
  validateForm,
  type FormErrors,
  type FormValues,
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
};

type Tab = "models" | "markji" | "extension";
type Editor = { mode: "add" | "edit"; id: ProviderId; picked: boolean };

const NAV: { id: Tab; icon: string; title: string; desc: string }[] = [
  { id: "models", icon: "AI", title: "模型服务", desc: "API Key 与接口地址" },
  { id: "markji", icon: "墨", title: "墨墨记单词", desc: "开放 API Token" },
  { id: "extension", icon: "扩", title: "浏览器插件", desc: "词表同步 Token" },
];

const ICON: Record<ProviderId, { ch: string; bg: string }> = {
  deepseek: { ch: "D", bg: "#4d6bfe" },
  openai: { ch: "G", bg: "#0f9d76" },
  claude: { ch: "C", bg: "#d97757" },
  qwen: { ch: "通", bg: "#615ced" },
  custom: { ch: "自", bg: "#78909c" },
};

const emptyForm = (): FormValues => ({ apiKey: "", endpoint: "", model: "" });

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

/**
 * 设置中心（右上角头像 → 设置）。
 *
 * 信息架构对齐 WorkBuddy：左侧分组导航 + 右侧内容；模型以列表呈现，
 * 「添加模型」才展开表单——先选提供商（自动带出接口地址/默认模型名），
 * 再补 API Key，逐字段校验，可测试连接，最后保存。
 */
export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("models");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [form, setForm] = useState<FormValues>(emptyForm());
  const [errors, setErrors] = useState<FormErrors>({});
  const [showKey, setShowKey] = useState(false);
  const [markjiInput, setMarkjiInput] = useState("");
  const [showMarkji, setShowMarkji] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function load() {
    try {
      const payload = (await request("/api/settings")) as SettingsPayload;
      setData(payload);
      setActive(payload.activeProvider);
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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // 二级表单开着时先关表单，再按一次才退出设置
      if (editor) setEditor(null);
      else onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editor, onClose]);

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
      return payload;
    } catch (err) {
      setNotice({ kind: "err", text: `保存失败：${err instanceof Error ? err.message : String(err)}` });
      return null;
    } finally {
      setBusy(null);
    }
  }

  // ---------- 模型服务 ----------

  function openAdd() {
    setNotice(null);
    setErrors({});
    setShowKey(false);
    setForm(emptyForm());
    setEditor({ mode: "add", id: "deepseek", picked: false });
  }

  function pickProvider(id: ProviderId) {
    const preset = presetFor(id);
    setEditor({ mode: "add", id, picked: true });
    setForm({ apiKey: "", endpoint: preset.endpoint, model: preset.model });
    setErrors({});
  }

  function openEdit(p: ProviderRow) {
    setNotice(null);
    setErrors({});
    setShowKey(false);
    setEditor({ mode: "edit", id: p.id, picked: true });
    setForm({ apiKey: "", endpoint: p.baseUrl, model: p.model });
  }

  function closeEditor() {
    setEditor(null);
    setErrors({});
  }

  function patchForm(field: keyof FormValues, value: string) {
    setForm((prev) => ({ ...prev, [field]: value }));
    setErrors((prev) => ({ ...prev, [field]: undefined }));
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
    if (Object.keys(errs).length > 0) return false;

    const patch: Record<string, string> = {
      baseUrl: normalizeEndpoint(form.endpoint),
      model: form.model.trim(),
    };
    if (form.apiKey.trim()) patch.apiKey = form.apiKey.trim();
    return Boolean(await put({ providers: { [editor.id]: patch } }));
  }

  async function saveAndClose() {
    if (await saveForm()) {
      closeEditor();
      setNotice({ kind: "ok", text: "模型配置已保存" });
    }
  }

  async function testForm() {
    if (!editor) return;
    if (!(await saveForm())) return;
    const id = editor.id;
    setBusy(`test:${id}`);
    try {
      const res = (await request("/api/settings/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: "ai", providerId: id }),
      })) as { ok: boolean; detail?: string; error?: string };
      setNotice(
        res.ok
          ? { kind: "ok", text: res.detail ?? "连接成功" }
          : { kind: "err", text: res.error ?? "连接失败" },
      );
    } catch (err) {
      setNotice({ kind: "err", text: `测试失败：${err instanceof Error ? err.message : String(err)}` });
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

  const current = data?.providers.find((p) => p.id === active) ?? null;
  const editingRow = editor ? data?.providers.find((p) => p.id === editor.id) : null;
  const isBusy = busy !== null;

  return (
    <div
      className="st-overlay"
      onMouseDown={() => {
        if (editor) setEditor(null);
        else onClose();
      }}
    >
      <div
        className="st-modal"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="st-head">
          <div>
            <h2 className="st-title">设置</h2>
            <p className="st-sub">配置只保存在本机数据库，不会上传云端</p>
          </div>
          <button className="st-close" onClick={onClose} aria-label="关闭设置">×</button>
        </div>

        <div className="st-layout">
          <nav className="st-nav" aria-label="设置分组">
            {NAV.map((n) => (
              <button
                key={n.id}
                className={`st-nav-item ${tab === n.id ? "st-nav-item-on" : ""}`}
                onClick={() => {
                  setTab(n.id);
                  setNotice(null);
                }}
              >
                <span className="st-nav-icon">{n.icon}</span>
                <span className="st-nav-text">
                  <b>{n.title}</b>
                  <small>{n.desc}</small>
                </span>
              </button>
            ))}
            <div className="st-nav-foot">
              <b>仅保存在本机</b>
              <span>API Key 写入本机 SQLite，不会上传云端，也不会写回 .env。</span>
            </div>
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
                {tab === "models" && (
                  <section className="st-section">
                    <div className="st-current">
                      <div>
                        <span className="st-current-label">当前使用</span>
                        <b className="st-current-name">
                          {current?.label ?? "尚未选择模型"}
                        </b>
                        <span className="st-current-hint">
                          {current
                            ? `${current.model} · ${current.configured ? "配置完整" : "配置不完整"}`
                            : "添加并勾选一个模型后，AI 释义才会启用"}
                        </span>
                      </div>
                      <button className="duo-btn duo-btn-primary st-add-btn" onClick={openAdd}>
                        + 添加模型
                      </button>
                    </div>

                    <div className="st-section-head">
                      <h3>模型服务</h3>
                      <span>勾选一个作为当前使用，配几个都行</span>
                    </div>

                    <div className="st-providers">
                      {data?.providers.map((p) => {
                        const selected = active === p.id;
                        return (
                          <div key={p.id} className={`st-provider ${selected ? "st-provider-on" : ""}`}>
                            <span className="st-provider-icon" style={{ background: ICON[p.id].bg }}>
                              {ICON[p.id].ch}
                            </span>
                            <span className="st-provider-name">
                              <b>{p.label}</b>
                              <span>{p.hint}</span>
                            </span>
                            <span className="st-provider-meta">
                              <span className={`st-badge ${p.configured ? "st-badge-on" : ""}`}>
                                {p.configured ? (p.source === "env" ? "环境变量" : "已配置") : "未配置"}
                              </span>
                              {p.maskedKey && <code>{p.maskedKey}</code>}
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
                              <button className="st-mini-btn" onClick={() => openEdit(p)}>
                                编辑
                              </button>
                            </span>
                          </div>
                        );
                      })}
                    </div>

                    <div className="st-security">
                      <b>请妥善保管 API Key</b>：它关联您的账户与额度，请勿分享给他人在共享环境中填写。
                      自定义模型产生的费用由您向服务商支付；接入前请确认服务商可信。
                    </div>
                  </section>
                )}

                {tab === "markji" && (
                  <section className="st-section">
                    <div className="st-section-head">
                      <h3>墨墨记单词</h3>
                      <span>导出记忆卡时使用的开放 API Token</span>
                    </div>
                    <div className="st-card">
                      <div className="st-field">
                        <label className="st-label" htmlFor="st-markji-token">
                          开放 API Token
                          <span>每个用户填自己的，留空表示不修改已保存的值</span>
                        </label>
                        <div className="st-input-row">
                          <input
                            id="st-markji-token"
                            className="duo-input st-input"
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
                          <button className="st-mini-btn" onClick={() => setShowMarkji(!showMarkji)}>
                            {showMarkji ? "隐藏" : "显示"}
                          </button>
                        </div>
                        <p className="st-help">
                          获取路径：墨墨 App → 我的 → 更多设置 → 实验功能 → 开放 API。
                          {data?.markji.fromEnv ? "当前值来自 .env，需在该文件中删除才能清除。" : ""}
                        </p>
                      </div>
                      <div className="st-card-actions">
                        <button className="st-mini-btn" disabled={isBusy} onClick={() => void verifyMarkji()}>
                          {busy === "test:markji" ? "验证中…" : "验证并保存"}
                        </button>
                        <button className="st-mini-btn" disabled={isBusy} onClick={() => void saveMarkji()}>
                          保存
                        </button>
                        {data?.markji.configured && !data.markji.fromEnv && (
                          <button
                            className="st-mini-btn st-mini-btn-quiet"
                            disabled={isBusy}
                            onClick={() => void clearMarkji()}
                          >
                            清除
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="st-security">
                      <b>写入不可逆</b>：导出卡片前请先看预览。Token 仅保存在本机数据库，不会上传云端。
                    </div>
                  </section>
                )}

                {tab === "extension" && (
                  <section className="st-section">
                    <div className="st-section-head">
                      <h3>浏览器插件</h3>
                      <span>把 Token 填进插件 popup 里即可同步词表</span>
                    </div>
                    <div className="st-card">
                      <div className="st-field">
                        <label className="st-label">
                          同步 Token
                          <span>插件用它读写你的词库，重新生成会使旧 Token 立即失效</span>
                        </label>
                        <div className="st-input-row">
                          <code className="st-token">{data?.extension.token ?? "尚未生成"}</code>
                          {data?.extension.token && (
                            <button
                              className="st-mini-btn"
                              onClick={() => void navigator.clipboard?.writeText(data.extension.token!)}
                            >
                              复制
                            </button>
                          )}
                          <button
                            className="st-mini-btn st-mini-btn-quiet"
                            disabled={isBusy}
                            onClick={() => void regenerateToken()}
                          >
                            {data?.extension.token ? "重新生成" : "生成"}
                          </button>
                        </div>
                      </div>
                    </div>
                    <p className="st-help">
                      服务地址填 http://localhost:3000（或你的部署域名）。插件目录：项目下的 extension/，
                      在 chrome://extensions 开启开发者模式后「加载已解压的扩展程序」。
                    </p>
                  </section>
                )}
              </>
            )}
          </div>
        </div>

        <div className="st-foot">
          <span className="st-foot-hint">保存后立即生效，无需重启</span>
          <button className="duo-btn st-done" onClick={onClose}>完成</button>
        </div>

        {editor && (
          <div className="st-editor" role="dialog" aria-modal="true" aria-label="模型配置">
            <div className="st-editor-head">
              <div>
                <h3>{editor.mode === "add" ? "添加模型" : `编辑 ${editingRow?.label ?? editor.id}`}</h3>
                <p>{editor.picked ? "补全配置后即可测试连接并保存" : "先选提供商，自动带出接口地址与默认模型名"}</p>
              </div>
              <button className="st-close" onClick={closeEditor} aria-label="关闭">×</button>
            </div>

            <div className="st-editor-body">
              {!editor.picked ? (
                <div className="st-pick">
                  <p className="st-pick-intro">
                    内置主流厂商预设，选中后自动带出接口地址与默认模型名，通常只需补 API Key。
                    服务不在列表里可选「自定义 / 本地模型」。
                  </p>
                  <div className="st-pick-grid">
                    {data?.providers.map((p) => (
                      <button key={p.id} className="st-pick-card" onClick={() => pickProvider(p.id)}>
                        <span className="st-provider-icon" style={{ background: ICON[p.id].bg }}>
                          {ICON[p.id].ch}
                        </span>
                        <b>{p.label}</b>
                        <small>{p.hint}</small>
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <div className="st-chosen">
                    <span className="st-provider-icon" style={{ background: ICON[editor.id].bg }}>
                      {ICON[editor.id].ch}
                    </span>
                    <span className="st-provider-name">
                      <b>{editingRow?.label ?? editor.id}</b>
                      <span>提供商 · {editingRow?.protocol === "anthropic" ? "Anthropic 原生接口" : "OpenAI 兼容接口"}</span>
                    </span>
                    {editor.mode === "add" && (
                      <button
                        className="st-mini-btn"
                        onClick={() => setEditor({ ...editor, picked: false })}
                      >
                        更换
                      </button>
                    )}
                  </div>

                  <div className="st-field">
                    <label className="st-label" htmlFor="st-endpoint">
                      接口地址
                      <span>基地址即可，SDK 会自动补 /chat/completions</span>
                    </label>
                    <input
                      id="st-endpoint"
                      className="duo-input st-input"
                      placeholder="https://api.example.com/v1"
                      value={form.endpoint}
                      onChange={(e) => patchForm("endpoint", e.target.value)}
                    />
                    {errors.endpoint && <p className="st-field-err">{errors.endpoint}</p>}
                  </div>

                  <div className="st-field">
                    <label className="st-label" htmlFor="st-api-key">
                      API Key
                      <span>
                        {editor.mode === "edit" && editingRow?.maskedKey
                          ? `已保存 ${editingRow.maskedKey}，留空表示不修改`
                          : "从服务商控制台获取，请勿分享给他人"}
                      </span>
                    </label>
                    <div className="st-input-row">
                      <input
                        id="st-api-key"
                        className="duo-input st-input"
                        type={showKey ? "text" : "password"}
                        autoComplete="off"
                        placeholder="sk-..."
                        value={form.apiKey}
                        onChange={(e) => patchForm("apiKey", e.target.value)}
                      />
                      <button className="st-mini-btn" onClick={() => setShowKey(!showKey)}>
                        {showKey ? "隐藏" : "显示"}
                      </button>
                    </div>
                    {errors.apiKey && <p className="st-field-err">{errors.apiKey}</p>}
                  </div>

                  <div className="st-field">
                    <label className="st-label" htmlFor="st-model">
                      模型名称
                      <span>服务端实际使用的 model ID</span>
                    </label>
                    <input
                      id="st-model"
                      className="duo-input st-input"
                      placeholder="deepseek-chat"
                      value={form.model}
                      onChange={(e) => patchForm("model", e.target.value)}
                    />
                    {errors.model && <p className="st-field-err">{errors.model}</p>}
                  </div>

                  <div className="st-security">
                    <b>仅保存在本机</b>：API Key 写入本机 SQLite，不会上传云端，也不会写回 .env。
                    自定义模型产生的费用由您向服务商支付，接入前请确认服务商可信。
                  </div>

                  {editor.mode === "edit" && editingRow?.configured && (
                    <button className="st-remove" onClick={() => void removeProvider()} disabled={isBusy}>
                      移除此模型配置
                    </button>
                  )}
                </>
              )}
            </div>

            {editor.picked && (
              <div className="st-editor-foot">
                <button className="st-mini-btn" disabled={isBusy} onClick={() => void testForm()}>
                  {busy?.startsWith("test:") ? "测试中…" : "测试连接"}
                </button>
                <span className="st-foot-hint">校验通过后才可保存</span>
                <button className="st-mini-btn" onClick={closeEditor}>取消</button>
                <button
                  className="duo-btn duo-btn-primary st-save"
                  disabled={isBusy}
                  onClick={() => void saveAndClose()}
                >
                  {busy === "saving" ? "保存中…" : "保存"}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
