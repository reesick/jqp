import { headers } from "next/headers";
import { Sidebar } from "../components/sidebar";
import { ToastProvider } from "../components/toast";
import { CommandPalette } from "../components/command-palette";

// Routes keep their original URLs; only the labels changed (Campaigns ->
// Automations, DM Activity -> Activity). See components/sidebar.tsx.
const NAV_ROUTES = ["/posts", "/campaigns", "/dm-activity", "/settings"];

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const headerList = await headers();
  const pathname = headerList.get("x-pathname") ?? "/";
  // Best-effort active-link detection — falls back to Home if the header
  // isn't present (middleware sets it; see apps/web/middleware.ts).
  const active = NAV_ROUTES.find((p) => pathname === p || pathname.startsWith(`${p}/`)) ?? "/";

  return (
    <ToastProvider>
      <div className="app-shell">
        <Sidebar active={active} />
        <main className="main">{children}</main>
      </div>
      <CommandPalette />
    </ToastProvider>
  );
}
