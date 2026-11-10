import { Suspense } from "react";
import type { Metadata } from "next";
import AuthForm from "@/components/AuthForm";

export const metadata: Metadata = { title: "登录 · ReadFlow" };

/**
 * AuthForm 用了 useSearchParams 读取 ?next=，Next 静态预渲染要求它待在
 * Suspense 边界内，否则 build 会直接报 missing-suspense-with-csr-bailout。
 */
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <AuthForm mode="login" />
    </Suspense>
  );
}
