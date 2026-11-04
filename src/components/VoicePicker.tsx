"use client";

import { useEffect, useState } from "react";
import { listEnglishVoices, setPreferredVoice, speak } from "@/lib/speak";

/**
 * 音色选择器：喇叭图标点了不满意就自己挑。
 * 只列本地英文音色（网络音色连不上服务端会静默失败，不展示）。
 * 选择结果存 localStorage，切换时立即用新音色读一个示例词。
 */
export default function VoicePicker() {
  const [voices, setVoices] = useState<{ name: string; lang: string }[]>([]);
  const [value, setValue] = useState("");

  useEffect(() => {
    function load() {
      const list = listEnglishVoices();
      if (list.length > 0) setVoices(list);
    }
    load();
    // voices 列表异步加载
    window.speechSynthesis?.addEventListener?.("voiceschanged", load);
    setValue(localStorage.getItem("readflow.voice") ?? "");
    return () => window.speechSynthesis?.removeEventListener?.("voiceschanged", load);
  }, []);

  if (voices.length === 0) return null;

  return (
    <select
      className="voice-picker"
      title="发音音色（挑一个听着顺耳的，会记住）"
      aria-label="发音音色"
      value={value}
      onChange={(e) => {
        const name = e.target.value;
        setValue(name);
        setPreferredVoice(name || null);
        speak("Hello, this is how I sound.");
      }}
    >
      <option value="">🔊 自动音色</option>
      {voices.map((v) => (
        <option key={v.name} value={v.name}>
          {v.name} · {v.lang.replace("_", "-")}
        </option>
      ))}
    </select>
  );
}
