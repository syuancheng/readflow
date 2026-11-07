import assert from "node:assert/strict";
import test from "node:test";
import { stripUnclosedSpine } from "../../src/lib/markdown-inline";

/**
 * P13：句子地图用 ==主干== 标下划线。流式输出每帧整体重解析，
 * 模型刚写到 `==simple` 的那一帧会露出半边标记，下一帧补上又突然变下划线。
 * 修补只在渲染层做，不能改存进数据库的 AI 全文。
 */

test("成对标记原样保留，不动已经闭合的下划线", () => {
  const line = "==A recurring pattern== ==is== ==simple control== over rich states and artifacts.";
  assert.equal(stripUnclosedSpine(line), line);
});

test("流式半帧：行尾孤立的那半边 == 被抹掉，文字不丢", () => {
  assert.equal(
    stripUnclosedSpine("==A recurring pattern== ==is== ==simple"),
    "==A recurring pattern== ==is== simple",
  );
  assert.equal(stripUnclosedSpine("==A recurring pattern"), "A recurring pattern");
});

test("多行各自独立判断，上一行的标记不会跑去配下一行", () => {
  assert.equal(
    stripUnclosedSpine("第一屏是选区的意思\n==主干== 原样保留\n==还没写完"),
    "第一屏是选区的意思\n==主干== 原样保留\n还没写完",
  );
});

test("没有标记的文本与单个等号不受影响", () => {
  assert.equal(stripUnclosedSpine(""), "");
  assert.equal(stripUnclosedSpine("普通一行中文说明。"), "普通一行中文说明。");
  assert.equal(stripUnclosedSpine("x = 1, y = 2"), "x = 1, y = 2");
});

test("P15 ==成分：主干== 与旧 ==主干== 同样受未闭合修补保护", () => {
  // 成对保持
  assert.equal(
    stripUnclosedSpine("==主语：A recurring pattern== ==谓语：is== ==表语：simple control=="),
    "==主语：A recurring pattern== ==谓语：is== ==表语：simple control==",
  );
  // 行尾半边被抹掉，成分名与主干文字都不丢
  assert.equal(
    stripUnclosedSpine("==主语：A recurring pattern== ==谓语：is== ==表语：simple"),
    "==主语：A recurring pattern== ==谓语：is== 表语：simple",
  );
});
