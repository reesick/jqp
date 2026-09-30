import Link from "next/link";
import { getStats } from "../lib/data";
import { LayoutDashboard, ImageIcon, Zap, Activity, Settings, LogOut } from "./icons";
import { LogoMark } from "./logo-mark";
import { PaletteHint } from "./command-palette";

// Labels follow DESIGN.md; URLs are unchanged so bookmarks and OAuth
// redirects keep working.
const LINKS = [
  { href: "/", label: "Home", icon: LayoutDashboard },
  { href: "/posts", label: "Posts", icon: ImageIcon },
  { href: "/campaigns", label: "Automations", icon: Zap },
  { href: "/dm-activity", label: "Activity", icon: Activity },
  { href: "/settings", label: "Settings", icon: Settings }
];

export async function Sidebar({ active }: { active: string }) {
  // Counts come from the same aggregate the overview uses (deduped per
  // request), so the sidebar no longer scans whole tables on every page.
  const stats = await getStats().catch(() => null);
  const counts: Record<string, number> = stats
    ? { "/posts": stats.posts.total, "/campaigns": stats.campaigns.enabled, "/dm-activity": stats.dm.totalSent }
    : {};

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <LogoMark />
        <span>jqp</span>
      </div>
      <nav className="sidebar-nav" aria-label="Primary">
        {LINKS.map((link) => {
          const Icon = link.icon;
          const isActive = active === link.href;
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`sidebar-link${isActive ? " active" : ""}`}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon size={16} aria-hidden="true" />
              {link.label}
              {counts[link.href] !== undefined ? <span className="count">{counts[link.href]}</span> : null}
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <PaletteHint />
        <form action="/api/auth/logout" method="post">
          <button type="submit" className="ghost sidebar-logout">
            <LogOut size={14} aria-hidden="true" />
            Log out
          </button>
        </form>
      </div>
    </aside>
  );
}
