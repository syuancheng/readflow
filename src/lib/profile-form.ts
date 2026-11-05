/**
 * 本地个人资料（A 档）：不引入账号体系。
 *
 * 昵称 / 名称 / 个性签名 / 头像都只是展示用的本机资料，写入 settings 表的
 * profile.* 键。没有登录、没有密码、没有第三方绑定，也不做任何云端同步。
 * 这里全部是纯函数（不碰 DB / DOM / Next），便于单测与前后端共用。
 */
import { SETTINGS_KEYS, type SettingsMap } from "./config";

export type Profile = {
  /** 昵称：右上角菜单主标题、头像占位文字的来源 */
  displayName: string;
  /** 名称：可选的真实姓名，仅在资料页展示 */
  fullName: string;
  /** 个性签名：右上角菜单副标题 */
  bio: string;
  /** 头像：128×128 的 data URL；空串表示使用文字头像 */
  avatar: string;
};

export type ProfileErrors = Partial<Record<keyof Profile, string>>;

/** 资料保存后广播，右上角 Profile 菜单无需刷新即时同步 */
export const PROFILE_CHANGED_EVENT = "readflow.profile";

/** 与「改之前」完全一致的展示值，作为未配置时的兜底，避免升级后名字突然变了 */
export const DEFAULT_PROFILE: Profile = {
  displayName: "Siyuan Cheng",
  fullName: "",
  bio: "学英语 · 读原文",
  avatar: "",
};

export const PROFILE_LIMITS = {
  displayName: 24,
  fullName: 40,
  bio: 80,
  /** data URL 存进 SQLite 前先压到 128px，200k 足够且能挡住误传大文件 */
  avatar: 200_000,
} as const;

/** 只接受浏览器压出来的内联图片，杜绝 javascript: / 外链 / 任意字符串 */
export const AVATAR_DATA_URL = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;

export function isAvatarImage(value: string): boolean {
  return value.length <= PROFILE_LIMITS.avatar && AVATAR_DATA_URL.test(value);
}

function clean(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, limit);
}

/** 任何来源（DB / 表单 / 事件 payload）都收敛成一份完整可用的资料 */
export function normalizeProfile(input: Partial<Profile> | null | undefined): Profile {
  const avatar = clean(input?.avatar, PROFILE_LIMITS.avatar);
  return {
    displayName: clean(input?.displayName, PROFILE_LIMITS.displayName) || DEFAULT_PROFILE.displayName,
    fullName: clean(input?.fullName, PROFILE_LIMITS.fullName),
    bio: clean(input?.bio, PROFILE_LIMITS.bio) || DEFAULT_PROFILE.bio,
    // 非法头像直接丢弃，不能让 <img src> 拿到任意协议
    avatar: avatar && isAvatarImage(avatar) ? avatar : "",
  };
}

/** 从 settings 全表读资料；空键＝用默认值 */
export function profileFromSettings(map: SettingsMap): Profile {
  return normalizeProfile({
    displayName: map[SETTINGS_KEYS.profileName],
    fullName: map[SETTINGS_KEYS.profileFullName],
    bio: map[SETTINGS_KEYS.profileBio],
    avatar: map[SETTINGS_KEYS.profileAvatar],
  });
}

/** 写入用：空值返回空串，调用方据此 deleteSetting（读取时自然回退默认值） */
export function profileToSettingsPatch(p: Profile): Record<string, string> {
  const n = normalizeProfile(p);
  return {
    [SETTINGS_KEYS.profileName]: n.displayName === DEFAULT_PROFILE.displayName ? "" : n.displayName,
    [SETTINGS_KEYS.profileFullName]: n.fullName,
    [SETTINGS_KEYS.profileBio]: n.bio === DEFAULT_PROFILE.bio ? "" : n.bio,
    [SETTINGS_KEYS.profileAvatar]: n.avatar,
  };
}

export function validateProfile(p: Profile): ProfileErrors {
  const errors: ProfileErrors = {};
  if (!p.displayName.trim()) errors.displayName = "请输入昵称";
  if (p.displayName.length > PROFILE_LIMITS.displayName) errors.displayName = "昵称最长 24 个字";
  if (p.fullName.length > PROFILE_LIMITS.fullName) errors.fullName = "名称最长 40 个字";
  if (p.bio.length > PROFILE_LIMITS.bio) errors.bio = "签名最长 80 个字";
  if (p.avatar && !isAvatarImage(p.avatar)) errors.avatar = "头像图片格式不正确";
  return errors;
}

/**
 * 文字头像：中文取第一个字，英文取首字母（两个单词时取两个首字母）。
 * emoji 昵称原样取第一个 emoji，避免拆成乱码代理对。
 */
export function initialsFrom(name: string): string {
  const s = name.trim();
  if (!s) return "?";
  const first = Array.from(s)[0];
  if (/\p{Extended_Pictographic}/u.test(first)) return first;
  if (/[a-z]/i.test(first)) {
    const words = s.split(/\s+/).filter(Boolean);
    if (words.length > 1 && /[a-z]/i.test(words[1][0])) {
      return (words[0][0] + words[1][0]).toUpperCase();
    }
    return first.toUpperCase();
  }
  return first;
}
