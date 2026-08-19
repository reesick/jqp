import Link from "next/link";
import { listPosts, listCampaigns, getDashboardStats } from "@jqp/publisher";
import { LayoutDashboard, ImageIcon, MessageSquare, Send, Settings, LogOut } from "./icons";
import { LogoMark } from "./logo-mark";

const LINKS = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/posts", label: "Posts", icon: ImageIcon },
  { href: "/campaigns", label: "Campaigns", icon: MessageSquare },
  { href: "/dm-activity", label: "DM Activity", icon: Send },
  { href: "/settings", label: "Settings", icon: Settings }
];

export async function Sidebar({ active }: { active: string }) {
  const [posts, campaigns, stats] = await Promise.all([listPosts(), listCampaigns(), getDashboardStats()]);
  const counts: Record<string, number> = {
    "/posts": posts.length,
    "/campaigns": campaigns.filter((c) => c.enabled).length,
    "/dm-activity": stats.dm.totalSent
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <LogoMark />
        <span>jqp</span>
      </div>
      <nav className="sidebar-nav">
        {LINKS.map((link) => {
          const Icon = link.icon;
          return (
            <Link key={link.href} href={link.href} className={`sidebar-link${active === link.href ? " active" : ""}`}>
              <Icon size={16} />
              {link.label}
              {counts[link.href] !== undefined ? <span className="count">{counts[link.href]}</span> : null}
            </Link>
          );
        })}
      </nav>
      <div className="sidebar-footer">
        <form action="/api/auth/logout" method="post">
          <button type="submit" className="ghost sidebar-logout">
            <LogOut size={14} />
            Log out
          </button>
        </form>
      </div>
    </aside>
  );
}
