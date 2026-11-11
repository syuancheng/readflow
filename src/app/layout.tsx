import type { Metadata } from "next";
import { DM_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";
import "katex/dist/katex.min.css";
import BottomNav from "@/components/BottomNav";
import SiteHeader from "@/components/SiteHeader";

/**
 * 字体（设计规范 v1，docs/design-system.md）：全站只用 DM Sans 一套西文字族，
 * 含导航与阅读器正文；等宽 Geist Mono 只给代码块 / 公式；音标用系统字体
 * （--rf-font-ipa）。DM Sans 不含中文字形，中文回退 PingFang SC。
 */
const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ReadFlow — 读你喜欢的，记住不会的",
  description: "上传文本，边读边查，生词带上下文收进词库，再推到墨墨记忆卡。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="zh-CN"
      className={`${dmSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <BottomNav />
      </body>
    </html>
  );
}
