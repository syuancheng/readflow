"use client";

/**
 * P35：卡片预览里英文句子后面的播放按钮（spec §8.1，设计简报 §9）。
 * - 跟在句末、和句子同一行；一张卡里所有按钮尺寸、颜色、位置一致（R-03 新增重复元素）。
 * - 四种状态：待播放 ▶ / 加载中（12px 转圈）/ 播放中 ■ / 失败 ⊘（禁用，title 说明原因）。
 * - 同一时间只播一段：模块级保存当前的 Audio，播新的之前先停旧的。
 * - 第一次点击才请求 /api/tts/<key>，不预加载。
 */
import { useEffect, useRef, useState } from "react";

type State = "idle" | "loading" | "playing" | "error";

let current: { audio: HTMLAudioElement; stop: () => void } | null = null;

export default function AudioButton({ audioKey, text }: { audioKey: string; text: string }) {
  const [state, setState] = useState<State>("idle");
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      const a = audioRef.current;
      if (a) {
        a.pause();
        if (current?.audio === a) current = null;
      }
    };
  }, []);

  function stop() {
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.currentTime = 0;
    }
    if (current?.audio === a) current = null;
    setState("idle");
  }

  async function toggle() {
    if (state === "playing" || state === "loading") {
      stop();
      return;
    }
    if (current && current.audio !== audioRef.current) current.stop();
    let a = audioRef.current;
    if (!a) {
      a = new Audio(`/api/tts/${audioKey}`);
      a.preload = "none";
      a.addEventListener("ended", () => {
        if (current?.audio === a) current = null;
        setState("idle");
      });
      a.addEventListener("error", () => {
        if (current?.audio === a) current = null;
        setState("error");
      });
      audioRef.current = a;
    }
    current = { audio: a, stop };
    setState("loading");
    try {
      await a.play();
      setState("playing");
    } catch {
      if (current?.audio === a) current = null;
      setState("error");
    }
  }

  const short = text.length > 30 ? `${text.slice(0, 30)}…` : text;
  const failed = state === "error";
  return (
    <button
      type="button"
      className={`rf-audio-btn${state === "playing" ? " rf-audio-on" : ""}`}
      aria-label={`播放：${short}`}
      aria-pressed={state === "playing"}
      aria-busy={state === "loading"}
      disabled={failed}
      title={failed ? "音频暂时没生成" : undefined}
      onClick={() => void toggle()}
    >
      {state === "loading" ? (
        <span className="rf-spin rf-audio-spin" aria-hidden />
      ) : (
        <span aria-hidden>{state === "playing" ? "■" : failed ? "⊘" : "▶"}</span>
      )}
    </button>
  );
}
