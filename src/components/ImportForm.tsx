"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

type Mode = "paste" | "file" | "url";

const TABS: { key: Mode; label: string; icon: string }[] = [
  { key: "paste", label: "粘贴", icon: "📋" },
  { key: "file", label: "上传", icon: "📁" },
  { key: "url", label: "网页", icon: "🔗" },
];

export default function ImportForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("paste");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setBody(content);
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (mode === "url" && !url.trim()) return setError("请填写网页地址");
    if (mode !== "url" && !body.trim()) return setError("请先填入正文");

    setBusy(true);
    try {
      const res = await fetch("/api/texts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || undefined,
          url: mode === "url" ? url.trim() : undefined,
          text: mode === "url" ? undefined : body,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "导入失败");

      setTitle("");
      setBody("");
      setUrl("");
      if (fileRef.current) fileRef.current.value = "";
      router.push(`/texts/${data.id}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="duo-card p-6">
      <h2 className="text-[18px] font-extrabold mb-4">导入文本</h2>

      {/* Tab 切换 */}
      <div className="flex gap-2 mb-5">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => {
              setMode(t.key);
              setError(null);
            }}
            className={`duo-tab ${mode === t.key ? "duo-tab-active" : ""}`}
          >
            <span>{t.icon}</span>
            {t.label}
          </button>
        ))}
      </div>

      <input
        className="duo-input mb-3"
        placeholder="标题（可留空，会自动取开头）"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />

      {mode === "url" ? (
        <input
          className="duo-input mb-3"
          placeholder="https://example.com/article"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
      ) : mode === "file" ? (
        <div className="mb-3">
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            onChange={onPickFile}
            className="block w-full text-[13px] text-ink-soft file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-2 file:border-[var(--duo-border)] file:bg-white file:text-[14px] file:font-bold file:text-ink-soft hover:file:border-[var(--duo-blue)] cursor-pointer"
          />
          {body && (
            <p className="mt-2 text-[13px] font-medium text-ink-faint">
              已读入 {body.length.toLocaleString()} 个字符
            </p>
          )}
        </div>
      ) : (
        <textarea
          className="duo-input mb-3 resize-y"
          rows={7}
          placeholder="把英文文章粘进来，空行分段"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      )}

      {error && (
        <div
          className="mb-3 text-[14px] font-bold px-4 py-3 rounded-xl"
          style={{
            background: "var(--duo-red-soft)",
            color: "var(--duo-red)",
          }}
        >
          {error}
        </div>
      )}

      <div className="flex items-center justify-between mt-2">
        <p className="text-[13px] font-medium text-ink-faint">
          {mode === "url" ? "自动提取网页正文" : "支持 .txt / .md"}
        </p>
        <button type="submit" className="duo-btn duo-btn-primary" disabled={busy}>
          {busy ? "处理中…" : "导入并开始阅读"}
        </button>
      </div>
    </form>
  );
}
