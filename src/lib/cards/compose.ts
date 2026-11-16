/**
 * 组卡检查（P35 spec §4.3 第 3 步）。纯函数。
 * 张数由 AI 决定，这里**不裁剪**；只检查两件事：
 * - 一张使用类卡都没有 → 整组重出一次（仍没有就照常保存，不让整组失败）；
 * - 有考试目标却没有任何认识类卡 → 只记日志。
 */
import { isProductive, type CardSpec } from "./spec";

export const NEED_PRODUCTIVE_REASON = "至少要有一张使用类卡（回译、情景说一句、换个说法或搭配与用法）";

export type Composition = { needsRedo: boolean; missingExam: boolean };

export function checkComposition(cards: Pick<CardSpec, "kind">[], hasExamTarget: boolean): Composition {
  const productive = cards.filter((c) => isProductive(c.kind)).length;
  return {
    needsRedo: cards.length > 0 && productive === 0,
    missingExam: hasExamTarget && productive === cards.length,
  };
}
