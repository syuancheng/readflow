import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import BottomNav from "@/components/BottomNav";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Lexreader — 读你喜欢的，记住不会的",
  description: "上传文本，边读边查，生词带上下文收进词库，再推到墨墨记忆卡。",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <header className="duo-nav sticky top-0 z-30">
          <div className="max-w-6xl mx-auto px-6 h-16 flex items-center gap-8">
            <Link href="/" className="flex items-center gap-2 font-extrabold text-[18px] tracking-tight">
              <span
                className="inline-flex items-center justify-center w-8 h-8 rounded-xl text-white text-[16px]"
                style={{ background: "var(--duo-green)", borderBottom: "3px solid var(--duo-green-dark)" }}
              >
                L
              </span>
              <span className="duo-hide-mobile">Lexreader</span>
            </Link>
            <nav className="flex items-center gap-2 text-ink-soft ml-2 duo-hide-mobile">
              <Link href="/" className="duo-nav-link">
                我的文本
              </Link>
              <Link href="/words" className="duo-nav-link">
                我的词库
              </Link>
              <Link href="/stats" className="duo-nav-link">
                战绩
              </Link>
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <BottomNav />
      </body>
    </html>
  );
}
