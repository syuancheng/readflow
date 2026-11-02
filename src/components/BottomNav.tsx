"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/", label: "阅读", icon: "📖" },
  { href: "/words", label: "词库", icon: "⚡" },
  { href: "/stats", label: "战绩", icon: "🏆" },
];

export default function BottomNav() {
  const path = usePathname();

  return (
    <nav className="duo-bottom-nav">
      <div className="max-w-md mx-auto flex items-stretch justify-around px-3">
        {ITEMS.map((item) => {
          const active =
            item.href === "/" ? path === "/" || path.startsWith("/texts") : path.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`duo-bottom-link ${active ? "duo-bottom-link-active" : ""}`}
            >
              <span className="text-[22px] leading-none mb-1">{item.icon}</span>
              <span className="text-[12px] font-bold">{item.label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
