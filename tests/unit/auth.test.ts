/**
 * P20 账户体系的纯函数层单测。
 *
 * 只测 auth-crypto.ts（不碰 DB / Next），覆盖密码哈希、会话令牌与过期判断。
 * 会话表读写、跨用户越权这类需要请求上下文的，交给 scripts/e2e-account.mjs。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkPassword,
  checkUsername,
  hashPassword,
  isSessionExpired,
  newSessionToken,
  newUserId,
  SESSION_TTL_MS,
  tokenHash,
  verifyPassword,
} from "../../src/lib/auth-crypto";

test("用户名：合法值（中文 / 数字 / _ . -）", () => {
  for (const v of ["alice", "张三", "a_1", "a.b-c", "  alice  "]) {
    assert.equal(checkUsername(v).ok, true, `${v} 应通过`);
  }
});

test("用户名：空 / 过短 / 过长 / 空格 / 特殊字符一律拒绝", () => {
  for (const v of [undefined, null, "", "a", "x".repeat(33), "a b", "a@b", "a/b", 42]) {
    assert.equal(checkUsername(v).ok, false, `${String(v)} 应被拒绝`);
  }
});

test("密码：至少 8 位，过长拒绝", () => {
  assert.equal(checkPassword("12345678").ok, true);
  assert.equal(checkPassword("1234567").ok, false);
  assert.equal(checkPassword("").ok, false);
  assert.equal(checkPassword("x".repeat(257)).ok, false);
  assert.equal(checkPassword(undefined).ok, false);
});

test("密码哈希：scrypt$<salt>$<hash> 结构，salt 每次不同", () => {
  const a = hashPassword("correct horse");
  const b = hashPassword("correct horse");
  const parts = a.split("$");
  assert.equal(parts.length, 3);
  assert.equal(parts[0], "scrypt");
  assert.equal(Buffer.from(parts[1], "hex").length, 16);
  assert.equal(Buffer.from(parts[2], "hex").length, 64);
  assert.notEqual(a, b, "同一密码两次哈希必须不同（随机 salt）");
  assert.ok(!a.includes("correct horse"), "明文不能出现在哈希串里");
});

test("密码校验：正确密码通过，错误密码 / 篡改 / 损坏格式返回 false 而不抛错", () => {
  const stored = hashPassword("s3cret-pass");
  assert.equal(verifyPassword("s3cret-pass", stored), true);
  assert.equal(verifyPassword("s3cret-pas", stored), false);
  assert.equal(verifyPassword("", stored), false);
  assert.equal(verifyPassword("s3cret-pass", undefined), false);
  assert.equal(verifyPassword("s3cret-pass", null), false);
  assert.equal(verifyPassword("s3cret-pass", ""), false);
  assert.equal(verifyPassword("x", "plaintext"), false);
  assert.equal(verifyPassword("x", "scrypt$zz$zz"), false);
  assert.equal(verifyPassword("x", "scrypt$$"), false);
  assert.equal(verifyPassword("x", `scrypt$${"00".repeat(16)}$${"00".repeat(64)}`), false);
  // 登录接口对不存在的用户名会用一段伪哈希做等价计算，它也必须是合法格式且校验失败
  const dummy = `scrypt$${"00".repeat(16)}$${"00".repeat(64)}`;
  assert.equal(verifyPassword("anything", dummy), false);
});

test("会话令牌：base64url、唯一、只以 sha256 哈希落库", () => {
  const a = newSessionToken();
  const b = newSessionToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
  assert.ok(a.length >= 40);
  assert.equal(tokenHash(a), tokenHash(a), "哈希必须确定");
  assert.notEqual(tokenHash(a), tokenHash(b));
  assert.notEqual(tokenHash(a), a, "库里绝不能存原始 token");
  assert.match(tokenHash(a), /^[0-9a-f]{64}$/);
});

test("会话过期：边界值、非数字、30 天 TTL", () => {
  const now = 1_700_000_000_000;
  assert.equal(isSessionExpired(now - 1, now), true);
  assert.equal(isSessionExpired(now, now), true, "恰好到期即失效");
  assert.equal(isSessionExpired(now + 1, now), false);
  assert.equal(isSessionExpired(Number.NaN, now), true);
  assert.equal(isSessionExpired(Number.POSITIVE_INFINITY, now), true);
  assert.equal(SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000);
});

test("用户 id 是随机 UUID，不会撞车", () => {
  const ids = new Set(Array.from({ length: 20 }, () => newUserId()));
  assert.equal(ids.size, 20);
  assert.match([...ids][0], /^[0-9a-f-]{36}$/);
});
