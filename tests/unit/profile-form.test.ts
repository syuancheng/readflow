import assert from "node:assert/strict";
import test from "node:test";
import { SETTINGS_KEYS } from "../../src/lib/config";
import {
  DEFAULT_PROFILE,
  initialsFrom,
  isAvatarImage,
  normalizeProfile,
  profileFromSettings,
  profileToSettingsPatch,
  validateProfile,
} from "../../src/lib/profile-form";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

test("空配置回退到与旧版一致的默认展示值", () => {
  assert.deepEqual(profileFromSettings({}), DEFAULT_PROFILE);
  assert.deepEqual(normalizeProfile(null), DEFAULT_PROFILE);
  assert.deepEqual(normalizeProfile(undefined), DEFAULT_PROFILE);
});

test("资料从 settings 表读写，默认值不落库", () => {
  assert.deepEqual(
    profileFromSettings({
      [SETTINGS_KEYS.profileName]: "  小城  ",
      [SETTINGS_KEYS.profileFullName]: "Siyuan Cheng",
      [SETTINGS_KEYS.profileBio]: "在读原文",
      [SETTINGS_KEYS.profileAvatar]: PNG,
    }),
    { displayName: "小城", fullName: "Siyuan Cheng", bio: "在读原文", avatar: PNG },
  );

  const patch = profileToSettingsPatch({
    displayName: DEFAULT_PROFILE.displayName,
    fullName: "",
    bio: DEFAULT_PROFILE.bio,
    avatar: "",
  });
  assert.equal(patch[SETTINGS_KEYS.profileName], "");
  assert.equal(patch[SETTINGS_KEYS.profileBio], "");
  assert.equal(patch[SETTINGS_KEYS.profileAvatar], "");
});

test("字段超长统一截断，昵称与签名空值回退默认", () => {
  const p = normalizeProfile({
    displayName: " ".repeat(3) + "a".repeat(60),
    fullName: "b".repeat(90),
    bio: "",
    avatar: "x".repeat(201_000),
  });
  assert.equal(p.displayName.length, 24);
  assert.equal(p.fullName.length, 40);
  assert.equal(p.bio, DEFAULT_PROFILE.bio);
  assert.equal(p.avatar, ""); // 超长图片直接丢弃
});

test("头像只接受内联图片 data URL", () => {
  assert.equal(isAvatarImage(PNG), true);
  assert.equal(isAvatarImage("data:image/jpeg;base64,/9j/AAAA"), true);
  assert.equal(isAvatarImage("https://example.com/a.png"), false);
  assert.equal(isAvatarImage("javascript:alert(1)"), false);
  assert.equal(isAvatarImage("data:text/html;base64,PHNjcmlwdD4="), false);
  assert.equal(isAvatarImage("data:image/png;base64,<script>"), false);
  assert.equal(normalizeProfile({ avatar: "https://evil.example/a.png" }).avatar, "");
});

test("校验：昵称必填、长度与头像格式", () => {
  assert.deepEqual(validateProfile(normalizeProfile({ displayName: "小城" })), {});
  assert.equal(
    validateProfile({ ...DEFAULT_PROFILE, displayName: "  " }).displayName,
    "请输入昵称",
  );
  assert.equal(
    validateProfile({ ...DEFAULT_PROFILE, displayName: "x".repeat(30) }).displayName,
    "昵称最长 24 个字",
  );
  assert.equal(
    validateProfile({ ...DEFAULT_PROFILE, avatar: "https://x.com/a.png" }).avatar,
    "头像图片格式不正确",
  );
});

test("文字头像：中文首字 / 英文首字母 / emoji 不被拆坏", () => {
  assert.equal(initialsFrom("小城"), "小");
  assert.equal(initialsFrom("siyuan"), "S");
  assert.equal(initialsFrom("Siyuan Cheng"), "SC");
  assert.equal(initialsFrom("  alice  "), "A");
  assert.equal(initialsFrom(""), "?");
  assert.equal(initialsFrom("📚 读书"), "📚");
});
