"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import LogoMark from "@/components/LogoMark";
import NavTabs from "@/components/NavTabs";
import ProfileMenu from "@/components/ProfileMenu";

/**
 * 全局顶栏（logo + 导航 tab + 头像菜单）。
 * 阅读页（/texts/*）整条隐藏——那里只留「← 返回我的文本」一个入口。
 */
export default function SiteHeader() {
  const pathname = usePathname();
  if (pathname?.startsWith("/texts")) return null;

  return (
    <header className="duo-nav sticky top-0 z-30">
      <div className="max-w-6xl mx-auto px-6 h-16 flex items-center gap-8">
        <Link href="/" className="flex items-center gap-2 font-extrabold text-[18px] tracking-tight">
          <LogoMark size={32} />
          <span className="duo-hide-mobile">ReadFlow</span>
        </Link>
        <NavTabs />
        <div className="ml-auto">
          <ProfileMenu />
        </div>
      </div>
    </header>
  );
}
