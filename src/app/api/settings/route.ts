import { NextResponse } from "next/server";
import {
  PROVIDERS,
  SETTINGS_KEYS,
  isMaskedValue,
  maskSecret,
  providerStatuses,
  resolveMarkjiToken,
  resolveProvider,
} from "@/lib/config";
import {
  allSettings,
  deleteSetting,
  ownSettings,
  setSetting,
} from "@/lib/settings-store";
import { GLOBAL_USER } from "@/db/ensure-auth";
import { hasOwnModel } from "@/lib/user-secrets";
import { aiUsedToday, dailyAiQuota } from "@/lib/ai-quota";
import { currentUser } from "@/lib/auth";
import { extensionTokenStatus, issueExtensionToken, revokeExtensionToken } from "@/lib/extension-tokens";
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
 * 插件 Token 只存哈希，这里只给状态（末 4 位、生成 / 最近使用时间），
 * 明文只在 PUT regenerateExtensionToken 的那次响应里出现一次。
 */
export async function GET() {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "请先登录" }, { status: 401 });
  // 站级默认（AI / 墨墨 / 插件）+ 本人覆盖；profile.* 不回退站级。
  // 必须与 PUT 写入时用同一个 userId，否则「保存成功但读回默认值」。
  const settings = allSettings(user.id);

  // P28：普通账号只看到、只改自己的模型 Key 和墨墨 Token（主账号的站级密钥一概不露），
  // 没填自己的 Key 时用站点模型、按天限次，这里一并返回额度情况
  if (!user.isOwner) {
    const own = ownSettings(user.id);
    const ownMarkji = own[SETTINGS_KEYS.markjiToken]?.trim() || null;
    return NextResponse.json({
      ok: true,
      activeProvider: own[SETTINGS_KEYS.activeProvider] ?? null,
      providers: providerStatuses(own, {}),
      markji: { configured: Boolean(ownMarkji), maskedToken: maskSecret(ownMarkji), fromEnv: false },
      extension: extensionTokenStatus(user.id),
      canEditSite: false,
      aiQuota: {
        ownKey: hasOwnModel(user.id),
        siteAvailable: resolveProvider(allSettings(), process.env) !== null,
        limit: dailyAiQuota(),
        usedToday: aiUsedToday(user.id),
      },
      profile: profileFromSettings(settings),
    });
  }

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
    // P30：插件 Token 每人一个，只代表本人
    extension: extensionTokenStatus(user.id),
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
  revokeExtensionToken?: boolean;
  /** 本地个人资料：提交完整四字段，空串表示恢复默认值 */
  profile?: Partial<Profile>;
  profileReset?: boolean;
};

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
  // 主账号改站级行（所有人共用的默认模型、主账号自己的墨墨、插件 Token）；
  // 普通账号改自己的行（P28）：自己的模型 Key、自己的墨墨 Token，碰不到站级密钥。
  // 插件 Token（P30）是每人自己的，任何账号都能生成 / 作废自己的，不受 scope 影响。
  const scope = user.isOwner ? GLOBAL_USER : user.id;
  if (body.activeProvider !== undefined) {
    if (body.activeProvider === null || body.activeProvider === "") {
      deleteSetting(SETTINGS_KEYS.activeProvider, scope);
    } else if (PROVIDERS.some((p) => p.id === body.activeProvider)) {
      setSetting(SETTINGS_KEYS.activeProvider, body.activeProvider, scope);
    } else {
      return NextResponse.json({ error: "未知的模型 provider" }, { status: 400 });
    }
  }

  if (body.providers && typeof body.providers === "object") {
    for (const [id, patch] of Object.entries(body.providers)) {
      if (!PROVIDERS.some((p) => p.id === id) || !patch || typeof patch !== "object") continue;
      if (patch.clear === true) {
        deleteSetting(SETTINGS_KEYS.providerKey(id), scope);
        deleteSetting(SETTINGS_KEYS.providerModel(id), scope);
        deleteSetting(SETTINGS_KEYS.providerBaseUrl(id), scope);
        continue;
      }
      const apiKey = str(patch.apiKey);
      if (apiKey && !isMaskedValue(apiKey)) setSetting(SETTINGS_KEYS.providerKey(id), apiKey, scope);
      const model = str(patch.model);
      if (model) setSetting(SETTINGS_KEYS.providerModel(id), model, scope);
      const baseUrl = str(patch.baseUrl);
      if (baseUrl) setSetting(SETTINGS_KEYS.providerBaseUrl(id), baseUrl, scope);
    }
  }

  if (body.markjiClear === true) {
    deleteSetting(SETTINGS_KEYS.markjiToken, scope);
  } else {
    const token = str(body.markjiToken);
    if (token && !isMaskedValue(token)) setSetting(SETTINGS_KEYS.markjiToken, token, scope);
  }

  let newExtensionToken: string | null = null;
  if (body.regenerateExtensionToken === true) {
    newExtensionToken = issueExtensionToken(user.id);
  } else if (body.revokeExtensionToken === true) {
    revokeExtensionToken(user.id);
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

  const res = await GET();
  if (!newExtensionToken) return res;
  // 新 Token 的明文只在这一次响应里返回，设置页提示用户立刻复制
  return NextResponse.json({ ...(await res.json()), newExtensionToken });
}
