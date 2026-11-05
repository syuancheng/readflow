"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { describeSignals, detectFormat } from "@/lib/import/detect";
import type { ImportFormatChoice } from "@/lib/import/types";

type Mode = "paste" | "file" | "url";

const TABS: { key: Mode; label: string; icon: string }[] = [
  { key: "paste", label: "粘贴", icon: "📋" },
  { key: "file", label: "上传", icon: "📁" },
  { key: "url", label: "网页", icon: "🔗" },
];

const FORMATS: { key: ImportFormatChoice; label: string }[] = [
  { key: "auto", label: "自动识别" },
  { key: "plain", label: "纯文本" },
  { key: "markdown", label: "Markdown" },
];

export default function ImportForm() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("paste");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [format, setFormat] = useState<ImportFormatChoice>("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // 纯前端探测，只用于给用户看提示；服务端会用自己的 detectFormat 再判一次
  const signals = useMemo(() => describeSignals(body), [body]);
  const autoFormat = useMemo(() => (body.trim() ? detectFormat(body) : null), [body]);

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const content = await file.text();
    setBody(content);
    if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
    // .md 文件默认按 Markdown，但用户仍可手动改回纯文本
    if (/\.(md|markdown)$/i.test(file.name)) setFormat("markdown");
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
          format: mode === "url" ? undefined : format,
          sourceType: mode === "file" ? "file" : "paste",
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "导入失败");

      setTitle("");
      setBody("");
      setUrl("");
      setFormat("auto");
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
          placeholder="把英文文章粘进来；也支持直接粘贴 Markdown，标题、列表、表格、代码块都会保留"
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
      )}

      {mode !== "url" && (
        <div className="rf-format-row mb-3">
          <span className="text-[12px] font-bold text-ink-faint shrink-0">格式</span>
          <div className="flex gap-1.5 flex-wrap">
            {FORMATS.map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => setFormat(f.key)}
                className={`rf-format-chip ${format === f.key ? "rf-format-chip-active" : ""}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {body.trim() && (
            <span className="text-[12px] font-medium text-ink-faint">
              {signals ? `检测到：${signals}` : "未检测到排版标记"}
              {format === "auto" && autoFormat
                ? ` · 将按${autoFormat === "markdown" ? " Markdown" : "纯文本"}解析`
                : ""}
            </span>
          )}
        </div>
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
          {mode === "url" ? "自动提取网页正文，优先取官方 Markdown" : "支持 .txt / .md / 粘贴 Markdown"}
        </p>
        <button type="submit" className="duo-btn duo-btn-primary" disabled={busy}>
          {busy ? "处理中…" : "导入并开始阅读"}
        </button>
      </div>
    </form>
  );
}
