import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  PROVIDERS,
  SETTINGS_KEYS,
  isMaskedValue,
  maskSecret,
  providerStatuses,
  resolveMarkjiToken,
} from "@/lib/config";
import {
  allSettings,
  deleteSetting,
  getSetting,
  setSetting,
} from "@/lib/settings-store";
import { currentUser } from "@/lib/auth";
import {
  isAvatarImage,
  normalizeProfile,
  profileFromSettings,
  profileToSettingsPatch,
  type Profile,
} from "@/lib/profile-form";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_LEN = 2048;
const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.trim() && v.length <= MAX_LEN ? v.trim() : undefined;

/**
 * GET /api/settings
 * 返回配置状态。API Key 与墨墨 Token 一律脱敏，永不下发明文；
 * 插件 Token 例外——用户需要复制它到插件里，只能在这里看到。
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  // 站级默认（AI / 墨墨 / 插件）+ 本人覆盖；profile.* 不回退站级。
  // 必须与 PUT 写入时用同一个 userId，否则「保存成功但读回默认值」。
  const settings = allSettings(user.id);
  const markji = resolveMarkjiToken(settings, process.env);
  return NextResponse.json({
    ok: true,
    activeProvider: settings[SETTINGS_KEYS.activeProvider] ?? null,
    providers: providerStatuses(settings, process.env),
    markji: {
      configured: Boolean(markji),
      maskedToken: maskSecret(markji),
      fromEnv: !settings[SETTINGS_KEYS.markjiToken] && Boolean(markji),
    },
    // 插件 Token 能读写 owner 的整个词库（插件链路无 cookie、数据归 owner），
    // 只能给 owner 看；其它账号拿到它就等于拿到了 owner 的词库。
    extension: {
      token: user.isOwner ? getSetting(SETTINGS_KEYS.extensionToken) : null,
    },
    canEditSite: user.isOwner,
    profile: profileFromSettings(settings),
  });
}

type ProviderPatch = {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  clear?: boolean;
};

type PutBody = {
  activeProvider?: string | null;
  providers?: Record<string, ProviderPatch>;
  markjiToken?: string;
  markjiClear?: boolean;
  regenerateExtensionToken?: boolean;
  /** 本地个人资料：提交完整四字段，空串表示恢复默认值 */
  profile?: Partial<Profile>;
  profileReset?: boolean;
};

/** 这次请求是否会改动站级密钥（脱敏回传值不算改动）。 */
function touchesSiteSecrets(body: PutBody): boolean {
  if (body.activeProvider !== undefined) return true;
  if (body.markjiClear === true || body.regenerateExtensionToken === true) return true;
  const token = str(body.markjiToken);
  if (token && !isMaskedValue(token)) return true;
  if (body.providers && typeof body.providers === "object") {
    for (const patch of Object.values(body.providers)) {
      if (!patch || typeof patch !== "object") continue;
      if (patch.clear === true || str(patch.model) || str(patch.baseUrl)) return true;
      const key = str(patch.apiKey);
      if (key && !isMaskedValue(key)) return true;
    }
  }
  return false;
}

/**
 * PUT /api/settings
 * 保存配置。脱敏值原样回传时忽略（防止把 "••••abcd" 写进 DB）。
 */
export async function PUT(req: Request) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }

  // 密钥类配置（AI / 墨墨 / 插件 Token）是站级共享，不传 userId 即写站级行。
  // 这样所有账号共用一份额度配置，插件链路（无 cookie）也能读到同一个 token。
  // 正因为是共享的，只有 owner 能改：否则任何账号都能换掉别人在用的 Key、
  // 把墨墨导出指到自己的账户，或重置插件 Token 拿到 owner 的词库。
  if (!user.isOwner && touchesSiteSecrets(body)) {
    return NextResponse.json({ error: "只有主账号可以修改模型、墨墨与插件配置" }, { status: 403 });
  }
  if (body.activeProvider !== undefined) {
    if (body.activeProvider === null || body.activeProvider === "") {
      deleteSetting(SETTINGS_KEYS.activeProvider);
    } else if (PROVIDERS.some((p) => p.id === body.activeProvider)) {
      setSetting(SETTINGS_KEYS.activeProvider, body.activeProvider);
    } else {
      return NextResponse.json({ error: "未知的模型 provider" }, { status: 400 });
    }
  }

  if (body.providers && typeof body.providers === "object") {
    for (const [id, patch] of Object.entries(body.providers)) {
      if (!PROVIDERS.some((p) => p.id === id) || !patch || typeof patch !== "object") continue;
      if (patch.clear === true) {
        deleteSetting(SETTINGS_KEYS.providerKey(id));
        deleteSetting(SETTINGS_KEYS.providerModel(id));
        deleteSetting(SETTINGS_KEYS.providerBaseUrl(id));
        continue;
      }
      const apiKey = str(patch.apiKey);
      if (apiKey && !isMaskedValue(apiKey)) setSetting(SETTINGS_KEYS.providerKey(id), apiKey);
      const model = str(patch.model);
      if (model) setSetting(SETTINGS_KEYS.providerModel(id), model);
      const baseUrl = str(patch.baseUrl);
      if (baseUrl) setSetting(SETTINGS_KEYS.providerBaseUrl(id), baseUrl);
    }
  }

  if (body.markjiClear === true) {
    deleteSetting(SETTINGS_KEYS.markjiToken);
  } else {
    const token = str(body.markjiToken);
    if (token && !isMaskedValue(token)) setSetting(SETTINGS_KEYS.markjiToken, token);
  }

  if (body.regenerateExtensionToken === true) {
    setSetting(SETTINGS_KEYS.extensionToken, randomUUID().replace(/-/g, ""));
  }

  const PROFILE_KEYS = [
    SETTINGS_KEYS.profileName,
    SETTINGS_KEYS.profileFullName,
    SETTINGS_KEYS.profileBio,
    SETTINGS_KEYS.profileAvatar,
  ];
  // profile.* 是纯个人数据，必须写到本人行：settings-store 对它不回退站级，
  // 否则 A 改昵称会覆盖所有人的、或读到 owner 的资料。
  if (body.profileReset === true) {
    for (const key of PROFILE_KEYS) deleteSetting(key, user.id);
  } else if (body.profile && typeof body.profile === "object") {
    // 头像不是普通字符串：必须在归一化（会静默丢弃非法值）之前显式挡掉
    const rawAvatar = body.profile.avatar;
    if (rawAvatar !== undefined && rawAvatar !== "" && !isAvatarImage(rawAvatar)) {
      return NextResponse.json({ error: "头像只能是压缩后的内联 PNG/JPEG/WebP 图片" }, { status: 400 });
    }
    const patch = profileToSettingsPatch(normalizeProfile(body.profile));
    for (const [key, value] of Object.entries(patch)) {
      if (value) setSetting(key, value, user.id);
      else deleteSetting(key, user.id);
    }
  }

  return GET();
}
