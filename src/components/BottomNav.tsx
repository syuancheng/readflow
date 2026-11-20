"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import Icon from "@/components/Icon";

// 导出走词库页右上角按钮，避免顶部/底部再加一个重复入口
const ITEMS = [
  { href: "/", label: "阅读", icon: "book" as const },
  { href: "/words", label: "词库", icon: "bookmark" as const },
  { href: "/stats", label: "战绩", icon: "chart" as const },
];

export default function BottomNav() {
  const path = usePathname();
  // 登录 / 建号页是独立全屏表单，不该出现底部主导航
  if (path === "/login" || path === "/setup" || path === "/register" || path === "/welcome") return null;

  return (
    <nav className="duo-bottom-nav">
      <div className="max-w-md mx-auto flex items-stretch justify-around px-3">
        {ITEMS.map((item) => {
          const active =
            item.href === "/"
              ? path === "/" || path.startsWith("/texts")
              : item.href === "/words"
                ? path.startsWith("/words")
                : path.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`duo-bottom-link ${active ? "duo-bottom-link-active" : ""}`}
              aria-current={active ? "page" : undefined}
            >
              <span className="mb-1"><Icon name={item.icon} size={22} /></span>
              <span className="text-xs font-bold">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
