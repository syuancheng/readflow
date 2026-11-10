import { Suspense } from "react";
import type { Metadata } from "next";
import AuthForm from "@/components/AuthForm";

export const metadata: Metadata = { title: "创建账号 · ReadFlow" };

/**
 * 关闭开放注册：这是唯一的建号入口，且 /api/auth/setup 只在 users 表为空时
 * 接受请求。已建号后 AuthForm 会自己把用户送去 /login。
 */
export default function SetupPage() {
  return (
    <Suspense fallback={null}>
      <AuthForm mode="setup" />
    </Suspense>
  );
}
