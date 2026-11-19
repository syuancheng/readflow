import { ICP_NUMBER, ICP_URL } from "@/lib/site-info";

/**
 * 页脚：只放工信部要求显示的 ICP 备案号，链接到 beian.miit.gov.cn（新标签页）。
 * 阅读页宽屏是固定高度的两栏，放不下页脚，由样式在那里隐藏（见 p44-chat.css）。
 */
export default function SiteFooter() {
  return (
    <footer className="rf-site-footer">
      <div className="rf-container">
        <a href={ICP_URL} target="_blank" rel="noopener noreferrer">
          {ICP_NUMBER}
        </a>
      </div>
    </footer>
  );
}
