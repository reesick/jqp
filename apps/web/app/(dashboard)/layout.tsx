import { headers } from "next/headers";
import { Sidebar } from "../components/sidebar";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const headerList = await headers();
  const pathname = headerList.get("x-pathname") ?? "/";
  // Best-effort active-link detection — falls back to no highlight if the
  // header isn't present (middleware sets it; see apps/web/middleware.ts).
  const active = ["/", "/posts", "/campaigns", "/dm-activity", "/settings"].find((p) => (p === "/" ? pathname === "/" : pathname.startsWith(p))) ?? "/";

  return (
    <div className="app-shell">
      <Sidebar active={active} />
      <main className="main">{children}</main>
    </div>
  );
}
