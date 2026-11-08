import type { Metadata } from "next";
import { DM_Sans, Geist_Mono, Outfit } from "next/font/google";
import "./globals.css";
import "katex/dist/katex.min.css";
import BottomNav from "@/components/BottomNav";
import SiteHeader from "@/components/SiteHeader";

/**
 * 字体分工（2026-11-08）：DM Sans 负责正文与标题，Outfit 只给站点顶部导航
 * （.duo-nav），阅读器英文正文仍走 --font-serif 衬线以保持长文可读性。
 * 等宽保留 Geist Mono（代码块 / 公式）。两者都不含中文字形，中文回退 PingFang SC。
 */
const dmSans = DM_Sans({ variable: "--font-dm-sans", subsets: ["latin"] });
const outfit = Outfit({ variable: "--font-outfit", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ReadFlow — 读你喜欢的，记住不会的",
  description: "上传文本，边读边查，生词带上下文收进词库，再推到墨墨记忆卡。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="zh-CN"
      className={`${dmSans.variable} ${outfit.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SiteHeader />
        <main className="flex-1">{children}</main>
        <BottomNav />
      </body>
    </html>
  );
}
