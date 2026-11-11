"use client";

/**
 * 设置 →「邀请朋友」（P28，只有主账号看得到）。
 * 生成邀请码、复制注册链接、看谁用了、作废。朋友打开链接就能在 /register 注册。
 */
import { useEffect, useState } from "react";

type Invite = {
  code: string;
  note: string | null;
  maxUses: number;
  usedCount: number;
  revoked: boolean;
  createdAt: number;
  usedBy: string[];
};

export default function InvitePanel() {
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [maxUses, setMaxUses] = useState(1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function call(init?: RequestInit, query = "") {
    const res = await fetch(`/api/invites${query}`, init);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error ?? "操作失败");
    return data as { invites: Invite[]; code?: string };
  }

  useEffect(() => {
    call()
      .then((d) => setInvites(d.invites))
      .catch((e) => setMsg({ ok: false, text: String(e.message ?? e) }));
  }, []);

  const linkOf = (code: string) => `${window.location.origin}/register?code=${code}`;

  async function copy(text: string, what: string) {
    try {
      await navigator.clipboard.writeText(text);
      setMsg({ ok: true, text: `已复制${what}` });
    } catch {
      setMsg({ ok: false, text: `复制失败，请手动复制：${text}` });
    }
  }

  async function create() {
    setBusy(true);
    setMsg(null);
    try {
      const d = await call({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ maxUses, note }),
      });
      setInvites(d.invites);
      setNote("");
      if (d.code) await copy(linkOf(d.code), `新的注册链接（邀请码 ${d.code}）`);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "生成失败" });
    } finally {
      setBusy(false);
    }
  }

  async function revoke(code: string) {
    if (!window.confirm(`作废邀请码 ${code}？已经用它注册的账号不受影响。`)) return;
    try {
      const d = await call({ method: "DELETE" }, `?code=${encodeURIComponent(code)}`);
      setInvites(d.invites);
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : "作废失败" });
    }
  }

  return (
    <section className="st-section">
      <div className="st-panel">
        <div className="st-panel-row">
          <div>
            <h3 className="st-panel-title">邀请朋友</h3>
            <p className="st-panel-desc">
              ReadFlow 不开放注册。生成一个邀请码，把注册链接发给朋友，对方打开就能注册。
              朋友没填自己的模型 Key 时用你的，每人每天有免费次数上限；墨墨 Token 每人填自己的。
            </p>
          </div>
        </div>

        <div className="st-invite-form">
          <label className="st-label">
            可以注册几次
            <select className="st-input" value={maxUses} onChange={(e) => setMaxUses(Number(e.target.value))}>
              {[1, 3, 5, 10].map((n) => (
                <option key={n} value={n}>
                  {n} 次
                </option>
              ))}
            </select>
          </label>
          <label className="st-label st-invite-note">
            备注（可选）
            <input
              className="st-input"
              value={note}
              maxLength={40}
              placeholder="比如：给小王"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button className="st-btn st-btn-primary" disabled={busy} onClick={() => void create()}>
            {busy ? "生成中…" : "生成邀请码"}
          </button>
        </div>

        {msg && <div className={`st-notice ${msg.ok ? "st-notice-ok" : "st-notice-err"}`}>{msg.text}</div>}

        {invites === null ? (
          <p className="st-help">读取中…</p>
        ) : invites.length === 0 ? (
          <p className="st-help">还没有邀请码。</p>
        ) : (
          <ul className="st-invites">
            {invites.map((iv) => {
              const usedUp = iv.usedCount >= iv.maxUses;
              const state = iv.revoked ? "已作废" : usedUp ? "已用完" : "可用";
              return (
                <li key={iv.code} className={`st-invite${iv.revoked || usedUp ? " st-invite-off" : ""}`}>
                  <div className="st-invite-main">
                    <code className="st-invite-code">{iv.code}</code>
                    <span className={`st-invite-state${state === "可用" ? " st-invite-state-on" : ""}`}>{state}</span>
                    <span className="st-invite-meta">
                      已用 {iv.usedCount}/{iv.maxUses}
                      {iv.note ? ` · ${iv.note}` : ""}
                      {iv.usedBy.length ? ` · 注册者：${iv.usedBy.join("、")}` : ""}
                    </span>
                  </div>
                  {!iv.revoked && !usedUp && (
                    <div className="st-invite-actions">
                      <button className="st-btn st-btn-ghost" onClick={() => void copy(linkOf(iv.code), "注册链接")}>
                        复制链接
                      </button>
                      <button className="st-btn st-btn-quiet" onClick={() => void copy(iv.code, "邀请码")}>
                        复制邀请码
                      </button>
                      <button className="st-btn st-btn-danger" onClick={() => void revoke(iv.code)}>
                        作废
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
