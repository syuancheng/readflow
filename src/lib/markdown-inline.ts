/**
 * AI 释义流式渲染的行内标记修补。
 *
 * P13 起句子地图用 `==主干==` 标下划线。流式输出时每帧整体重解析，
 * 模型写到 `==A recurring pattern` 就推过来的那一帧，配对标记还没闭合；
 * 直接渲染会看到裸的 `==`，等下一帧补上又突然变成下划线，视觉上会闪。
 *
 * 这里只在**渲染前**把行尾孤立的那半边标记抹掉，不改动存进数据库的原文。
 * 同一套逻辑对中英文人设、`**` 之外的成对标记都适用，但暂时只处理 `==`：
 * 加粗沿用 prompt 里「尽量少用」的规避方式，控制变量少一个。
 */
export function stripUnclosedSpine(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const count = (line.match(/==/g) ?? []).length;
      if (count % 2 === 0) return line;
      const last = line.lastIndexOf("==");
      return line.slice(0, last) + line.slice(last + 2);
    })
    .join("\n");
}
