"use client";

import { useEffect, useState } from "react";
import type { ProviderId } from "@/lib/config";
import { withRetry } from "@/lib/retry";

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

type Draft = { apiKey: string; model: string; baseUrl: string };
const emptyDraft = (): Draft => ({ apiKey: "", model: "", baseUrl: "" });

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

export default function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState<SettingsPayload | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, Draft>>({});
  const [markjiInput, setMarkjiInput] = useState("");
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

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
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function patchDraft(id: string, field: keyof Draft, value: string) {
    setDraft((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? emptyDraft()), [field]: value },
    }));
  }

  /** 保存（可顺带把刚勾选的 provider 一起设为生效） */
  async function persist(activeOverride?: string | null, extra?: Record<string, unknown>) {
    setSaving(true);
    setNotice(null);
    const providers: Record<string, Draft> = {};
    for (const [id, d] of Object.entries(draft)) {
      if (d.apiKey.trim() || d.model.trim() || d.baseUrl.trim()) providers[id] = d;
    }
    const body: Record<string, unknown> = {
      activeProvider: activeOverride === undefined ? active : activeOverride,
      providers,
      ...(markjiInput.trim() ? { markjiToken: markjiInput.trim() } : {}),
      ...extra,
    };
    try {
      const payload = (await request("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })) as SettingsPayload;
      setData(payload);
      setActive(payload.activeProvider);
      setDraft({});
      setMarkjiInput("");
      return true;
    } catch (err) {
      setNotice({ kind: "err", text: `保存失败：${err instanceof Error ? err.message : String(err)}` });
      return false;
    } finally {
      setSaving(false);
    }
  }

  /** 勾选即生效：立即落库 */
  async function selectProvider(id: string) {
    setActive(id);
    const ok = await persist(id);
    if (ok) setNotice({ kind: "ok", text: `已切换到 ${id}，之后的 AI 释义都会用它` });
  }

  async function testProvider(id: string) {
    setTesting(id);
    setNotice(null);
    const saved = await persist();
    if (!saved) {
      setTesting(null);
      return;
    }
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
      setTesting(null);
    }
  }

  async function testMarkji() {
    setTesting("markji");
    setNotice(null);
    const saved = await persist();
    if (!saved) {
      setTesting(null);
      return;
    }
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
      setTesting(null);
    }
  }

  async function regenerateToken() {
    const ok = await persist(undefined, { regenerateExtensionToken: true });
    if (ok) setNotice({ kind: "ok", text: "已生成新的插件 Token，旧的立即失效" });
  }

  async function clearMarkji() {
    setMarkjiInput("");
    const ok = await persist(undefined, { markjiClear: true });
    if (ok) setNotice({ kind: "ok", text: "已清除墨墨 Token" });
  }

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
          <div>
            <h2 className="st-title">设置</h2>
            <p className="st-sub">配置只保存在本机数据库，不会上传</p>
          </div>
          <button className="st-close" onClick={onClose} aria-label="关闭设置">×</button>
        </div>

        {notice && (
          <div className={`st-notice ${notice.kind === "ok" ? "st-notice-ok" : "st-notice-err"}`}>
            {notice.text}
          </div>
        )}

        <div className="st-body">
          {loading ? (
            <p className="text-[14px] font-bold text-ink-faint p-4">读取配置中…</p>
          ) : (
            <>
              <section className="st-section">
                <div className="st-section-head">
                  <h3>AI 模型</h3>
                  <span>勾选一个作为当前使用的模型，配几个都行</span>
                </div>
                <div className="st-providers">
                  {data?.providers.map((p) => {
                    const d = draft[p.id] ?? emptyDraft();
                    const selected = active === p.id;
                    return (
                      <div key={p.id} className={`st-provider ${selected ? "st-provider-on" : ""}`}>
                        <div className="st-provider-top">
                          <button
                            className={`st-radio ${selected ? "st-radio-on" : ""}`}
                            onClick={() => void selectProvider(p.id)}
                            role="radio"
                            aria-checked={selected}
                            aria-label={`使用 ${p.label}`}
                          >
                            {selected ? "✓" : ""}
                          </button>
                          <div className="st-provider-name">
                            <b>{p.label}</b>
                            <span>{p.hint}</span>
                          </div>
                          <span className="st-tag">
                            {p.configured
                              ? p.source === "env" ? "环境变量" : "已配置"
                              : "未配置"}
                          </span>
                          <button
                            className="st-mini-btn"
                            disabled={testing !== null || saving}
                            onClick={() => void testProvider(p.id)}
                          >
                            {testing === p.id ? "测试中…" : "测试连接"}
                          </button>
                        </div>
                        <div className="st-fields">
                          <input
                            className="duo-input st-input"
                            type="password"
                            autoComplete="off"
                            placeholder={p.maskedKey ? `已保存 ${p.maskedKey}（留空不修改）` : "API Key"}
                            value={d.apiKey}
                            onChange={(e) => patchDraft(p.id, "apiKey", e.target.value)}
                          />
                          <input
                            className="duo-input st-input"
                            placeholder={p.model || "模型名"}
                            value={d.model}
                            onChange={(e) => patchDraft(p.id, "model", e.target.value)}
                          />
                          {(p.id === "custom" || d.baseUrl) && (
                            <input
                              className="duo-input st-input st-input-wide"
                              placeholder="Base URL，如 http://127.0.0.1:11434/v1"
                              value={d.baseUrl || p.baseUrl}
                              onChange={(e) => patchDraft(p.id, "baseUrl", e.target.value)}
                            />
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="st-section">
                <div className="st-section-head">
                  <h3>墨墨记单词</h3>
                  <span>每个用户填自己的开放 API Token</span>
                </div>
                <div className="st-fields st-fields-row">
                  <input
                    className="duo-input st-input"
                    type="password"
                    autoComplete="off"
                    placeholder={
                      data?.markji.configured
                        ? `已保存 ${data.markji.maskedToken}${data.markji.fromEnv ? "（来自环境变量）" : ""}（留空不修改）`
                        : "墨墨开放 API Token"
                    }
                    value={markjiInput}
                    onChange={(e) => setMarkjiInput(e.target.value)}
                  />
                  <button className="st-mini-btn" disabled={testing !== null} onClick={() => void testMarkji()}>
                    {testing === "markji" ? "验证中…" : "验证"}
                  </button>
                  {data?.markji.configured && !data.markji.fromEnv && (
                    <button className="st-mini-btn st-mini-btn-quiet" onClick={() => void clearMarkji()}>
                      清除
                    </button>
                  )}
                </div>
                <p className="st-help">
                  获取路径：墨墨 App → 我的 → 更多设置 → 实验功能 → 开放 API。不填则回落到环境变量。
                </p>
              </section>

              <section className="st-section">
                <div className="st-section-head">
                  <h3>浏览器插件</h3>
                  <span>把它填进插件的 Token 一栏</span>
                </div>
                <div className="st-fields st-fields-row">
                  <code className="st-token">{data?.extension.token ?? "尚未生成"}</code>
                  {data?.extension.token && (
                    <button
                      className="st-mini-btn"
                      onClick={() => void navigator.clipboard?.writeText(data.extension.token!)}
                    >
                      复制
                    </button>
                  )}
                  <button className="st-mini-btn st-mini-btn-quiet" onClick={() => void regenerateToken()}>
                    {data?.extension.token ? "重新生成" : "生成"}
                  </button>
                </div>
              </section>
            </>
          )}
        </div>

        <div className="st-foot">
          <span className="st-foot-hint">改动会立即生效，无需重启</span>
          <button className="duo-btn duo-btn-primary st-save" disabled={saving} onClick={() => void persist()}>
            {saving ? "保存中…" : "保存全部"}
          </button>
        </div>
      </div>
    </div>
  );
}
