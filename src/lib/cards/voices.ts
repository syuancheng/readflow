/**
 * 卡片句子音频用的模型和音色（P35 spec §5.1）。
 * Jennifer：百炼 Qwen3-TTS 音色列表里标明「美式英语女声」的音色（2026-11-16 查阅
 * https://www.alibabacloud.com/help/en/model-studio/qwen-tts-voice-list）。
 * 改音色或模型会让所有句子的 audioKey 变化（重新合成一遍），不影响已推送的卡。
 */
import type { Voice } from "./audio";

export const VOICE: Voice = { model: "qwen3-tts-flash", voice: "Jennifer" };
