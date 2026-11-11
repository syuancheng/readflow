import { Suspense } from "react";
import type { Metadata } from "next";
import AuthForm from "@/components/AuthForm";

export const metadata: Metadata = { title: "注册 · ReadFlow" };

/**
 * 邀请码注册（P28）：不开放注册，必须带主账号发的邀请码；
 * 链接里带 ?code= 时自动填好。AuthForm 用了 useSearchParams，需要 Suspense 边界。
 */
export default function RegisterPage() {
  return (
    <Suspense fallback={null}>
      <AuthForm mode="register" />
    </Suspense>
  );
}
