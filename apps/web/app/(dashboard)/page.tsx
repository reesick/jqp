import Link from "next/link";
import { getRecentDms, listRecentPosts } from "@jqp/publisher";
import { getStats } from "../lib/data";
import { StatusBadge } from "../components/status-badge";
import { LayoutDashboard, Rocket, Radio, Send, AlertTriangle } from "../components/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const [stats, recentDms, recentPosts] = await Promise.all([getStats(), getRecentDms(6), listRecentPosts(5)]);
  const needsAttention = stats.posts.failed + stats.dm.totalFailed;

  return (
    <>
      <div className="page-header">
        <div>
          <span className="eyebrow">
            <LayoutDashboard size={12} /> Overview
          </span>
          <h1>Good to see you</h1>
        </div>
      </div>

      <div className="stat-grid">
        <div className="stat-tile">
          <Rocket className="stat-tile-icon" size={18} />
          <div className="stat-label">Posts published</div>
          <div className="stat-value">{stats.posts.published}</div>
          <div className="stat-sub">{stats.posts.total} total</div>
        </div>
        <div className="stat-tile">
          <Radio className="stat-tile-icon" size={18} />
          <div className="stat-label">Active campaigns</div>
          <div className="stat-value">{stats.campaigns.enabled}</div>
          <div className="stat-sub">{stats.campaigns.synced} synced to OpenReply</div>
        </div>
        <div className="stat-tile">
          <Send className="stat-tile-icon" size={18} />
          <div className="stat-label">DMs sent</div>
          <div className="stat-value">{stats.dm.totalSent}</div>
          <div className="stat-sub">{stats.dm.sentLast7Days} in the last 7 days</div>
        </div>
        <div className="stat-tile">
          <AlertTriangle className="stat-tile-icon" size={18} />
          <div className="stat-label">Needs attention</div>
          <div className={`stat-value${needsAttention > 0 ? " danger" : ""}`}>{needsAttention}</div>
          <div className="stat-sub">{stats.posts.failed} failed posts · {stats.dm.totalFailed} failed DMs</div>
        </div>
      </div>

      <div className="overview-grid">
        <div className="card">
          <div className="card-title">Recent posts</div>
          {recentPosts.length === 0 ? (
            <p className="muted u-text-sm">
              No posts yet. <Link href="/posts">Ingest a folder →</Link>
            </p>
          ) : (
            <div className="list-tight">
              {recentPosts.map((post) => (
                <div className="entity-card" key={post.id}>
                  <div className="entity-main">
                    <div className="entity-title">
                      <Link href={`/posts/${post.id}`}>{post.campaign_id}</Link>
                    </div>
                    <div className="entity-meta">
                      <span>{new Date(post.created_at).toLocaleDateString()}</span>
                      {post.instagram_media_id ? <span className="mono">{post.instagram_media_id}</span> : null}
                    </div>
                  </div>
                  <StatusBadge status={post.status} />
                </div>
              ))}
            </div>
          )}
          <p className="u-mt-xs">
            <Link href="/posts">View all posts →</Link>
          </p>
        </div>

        <div className="card">
          <div className="card-title">Recent DM activity</div>
          {recentDms.length === 0 ? (
            <p className="muted u-text-sm">
              No comments matched yet. Once a campaign is live, matched comments show up here in real time.
            </p>
          ) : (
            <ul className="timeline">
              {recentDms.map((dm) => (
                <li key={dm.id} className={dm.status === "SENT" ? "done" : ""}>
                  <span className="timeline-dot" />
                  <span>
                    <strong>{dm.commenterName ?? "someone"}</strong> commented <span className="mono">{dm.commentText}</span>
                    {dm.status === "SENT" ? " — DM sent" : ` — ${dm.status.toLowerCase()}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="u-mt-xs">
            <Link href="/dm-activity">View all →</Link>
          </p>
        </div>
      </div>
    </>
  );
}
