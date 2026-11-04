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
  const settings = allSettings();
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
    extension: {
      token: getSetting(SETTINGS_KEYS.extensionToken),
    },
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
};

/**
 * PUT /api/settings
 * 保存配置。脱敏值原样回传时忽略（防止把 "••••abcd" 写进 DB）。
 */
export async function PUT(req: Request) {
  let body: PutBody;
  try {
    body = (await req.json()) as PutBody;
  } catch {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "请求格式错误" }, { status: 400 });
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

  return GET();
}
