"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 顶部导航 tab（我的文本 / 我的词库 / 战绩）。
 * 导出入口唯一：词库页右上角的「导出到墨墨」按钮，顶部/底部导航都不再重复放。
 * 阅读页（/texts/*）沉浸阅读，隐藏全部 tab，只留 logo 和右上角头像菜单。
 */
export default function NavTabs() {
  const pathname = usePathname();
  if (pathname?.startsWith("/texts")) return null;

  return (
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
  );
}
