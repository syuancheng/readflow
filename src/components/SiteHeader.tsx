"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import LogoMark from "@/components/LogoMark";
import NavTabs from "@/components/NavTabs";
import ProfileMenu from "@/components/ProfileMenu";

/**
 * 全局顶栏（logo + 导航 tab + 头像菜单）。
 * 阅读页（/texts/*）整条隐藏——那里只留「← 返回我的文本」一个入口。
 * 登录 / 首次建号页也隐藏：此时还没有登录态，头像菜单会白请求 /api/settings。
 */
export default function SiteHeader() {
  const pathname = usePathname();
  if (pathname?.startsWith("/texts")) return null;
  if (pathname === "/login" || pathname === "/setup" || pathname === "/register" || pathname === "/welcome") return null;

  return (
    <header className="duo-nav sticky top-0 z-30">
      <div className="rf-container h-16 flex items-center gap-8">
        <Link href="/" className="flex items-center gap-2 font-extrabold text-xl tracking-tight">
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
