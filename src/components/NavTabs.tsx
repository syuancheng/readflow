"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 顶部导航 tab（我的文本 / 我的词库 / 战绩）。
 * 当前所在的 tab 用绿色圆角块标出来（导出页从词库进入，算在「我的词库」下）。
 * 导出入口在词库工具栏「导出选中的词到墨墨」，顶部/底部导航都不再重复放。
 * 阅读页（/texts/*）沉浸阅读，隐藏全部 tab，只留 logo 和右上角头像菜单。
 */
const TABS = [
  { href: "/", label: "我的文本", match: (p: string) => p === "/" },
  { href: "/words", label: "我的词库", match: (p: string) => p.startsWith("/words") || p.startsWith("/export") },
  { href: "/stats", label: "战绩", match: (p: string) => p.startsWith("/stats") },
];

export default function NavTabs() {
  const pathname = usePathname() ?? "/";
  if (pathname.startsWith("/texts")) return null;

  return (
    <nav className="flex items-center gap-2 text-ink-soft ml-2 duo-hide-mobile" aria-label="主导航">
      {TABS.map((t) => {
        const active = t.match(pathname);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`duo-nav-link${active ? " duo-nav-link-active" : ""}`}
            aria-current={active ? "page" : undefined}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
