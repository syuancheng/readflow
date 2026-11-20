import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth";
import { getLearner, needsSurvey } from "@/lib/learner-store";
import WelcomeForm from "@/components/WelcomeForm";

export const dynamic = "force-dynamic";

/** P32 F1：注册成功后、进入首页前的问卷。已填过或已跳过的用户直接跳走。 */
export default async function WelcomePage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const user = await currentUser();
  if (!user) redirect("/login");
  const sp = await searchParams;
  const next =
    typeof sp.next === "string" && sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : "/";
  if (!needsSurvey(getLearner(user.id))) redirect(next);

  return (
    <div className="rf-container rf-page">
      {/* 一个窄的居中栏：问卷是一列表单，铺满 1150px 宽会让右半边空着 */}
      <div className="mx-auto" style={{ maxWidth: 600 }}>
        <h1 className="rf-home-hero">让 AI 老师更懂你</h1>
        <p className="text-sm text-ink-soft mt-2">花 30 秒，讲解会更贴合你的水平。每题都可以跳过。</p>
        <div className="duo-card p-6 mt-8">
          <WelcomeForm next={next} />
        </div>
      </div>
    </div>
  );
}
