/**
 * 组卡检查（纯函数）。用户 2026-11-16 定稿：全部题型都是输出类，
 * 卡的目的只有两个——积累能在口语/写作里用出来的表达、强化难点句型的输出。
 * 旧的「有没有使用类卡」「有考试目标但没有认识类卡」检查已无意义，移除。
 * 张数由 AI 决定，这里不裁剪。
 */

export const NEED_PRODUCTIVE_REASON = "卡必须让用户输出英文（回译、情景说一句、换个说法或搭配与用法）";

export type Composition = { needsRedo: boolean; missingExam: boolean };

export function checkComposition(
  _cards: { kind: string }[],
  _hasExamTarget: boolean,
): Composition {
  // 所有保留题型都是输出类；空卡片组由解析阶段拦截
  return { needsRedo: false, missingExam: false };
}
