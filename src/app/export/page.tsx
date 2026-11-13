import { redirect } from "next/navigation";

/** 旧的导出页已并入词库的「待推送」（P33 PRD Q2）；老书签 / 老链接统一跳过去 */
export default function ExportPage() {
  redirect("/words?status=pending");
}
