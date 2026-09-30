import Link from "next/link";
import { getRecentDms, getTokenHealth, listCampaigns, listFailedPosts, listRecentPosts } from "@jqp/publisher";
import { getStats } from "../lib/data";
import { ActionButton } from "../components/action-button";
import { StatusBadge } from "../components/status-badge";
import { AlertTriangle, CheckCircle2, RotateCw } from "../components/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Home" };

const TZ = "Asia/Kolkata";

function greeting(): string {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: TZ }).format(new Date()));
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export default async function OverviewPage() {
  const [stats, recentDms, recentPosts, failedPosts, campaigns, tokenHealth] = await Promise.all([
    getStats(),
    getRecentDms(5),
    listRecentPosts(3),
    listFailedPosts(3),
    listCampaigns(),
    getTokenHealth()
  ]);

  const tokenIssue = tokenHealth.expiring.length > 0 || tokenHealth.lastRefreshError !== null;
  const attentionCount = stats.posts.failed + stats.dm.totalFailed + (tokenIssue ? 1 : 0);
  const latest = recentPosts[0];
  const today = new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: TZ }).format(new Date());
  const activeCampaigns = campaigns.filter((c) => c.enabled);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{greeting()}</h1>
          <div className="muted u-mt-xxs">{today}</div>
        </div>
      </div>

      {attentionCount === 0 ? (
        <p className="home-status">
          <CheckCircle2 size={14} /> Everything is running normally
        </p>
      ) : (
        <p className="home-status warn">
          <AlertTriangle size={14} /> {attentionCount} {attentionCount === 1 ? "thing needs" : "things need"} your attention
        </p>
      )}

      {attentionCount > 0 ? (
        <section className="home-section">
          <h3 className="section-label">Needs attention</h3>
          {failedPosts.map((post) => (
            <div className="entity-card" key={post.id}>
              <div className="entity-main">
                <div className="entity-title">
                  <Link href={`/posts/${post.id}`}>{post.campaign_id}</Link>
                </div>
                <div className="entity-meta">
                  <span>{post.error_message ?? "Publishing failed"}</span>
                  <span>{ago(post.updated_at)}</span>
                </div>
              </div>
              <ActionButton href={`/api/posts/${post.id}/retry`} label="Retry" icon={<RotateCw size={13} />} secondary />
            </div>
          ))}
          {stats.dm.totalFailed > 0 ? (
            <div className="entity-card">
              <div className="entity-main">
                <div className="entity-title">Comment → DM</div>
                <div className="entity-meta">
                  <span>
                    {stats.dm.totalFailed} {stats.dm.totalFailed === 1 ? "message" : "messages"} failed to send
                  </span>
                </div>
              </div>
              <Link href="/dm-activity?status=FAILED">Review</Link>
            </div>
          ) : null}
          {tokenIssue ? (
            <div className="entity-card">
              <div className="entity-main">
                <div className="entity-title">Instagram connection</div>
                <div className="entity-meta">
                  <span>
                    {tokenHealth.lastRefreshError
                      ? "Automatic token refresh failed"
                      : `Token expires in ${tokenHealth.expiring[0]?.daysLeft ?? "?"} days`}
                  </span>
                </div>
              </div>
              <Link href="/settings">Fix</Link>
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="home-section">
        <h3 className="section-label">Latest post</h3>
        {latest ? (
          <div className="entity-card">
            <div className="entity-main">
              <div className="entity-title">
                <Link href={`/posts/${latest.id}`}>{latest.campaign_id}</Link>
              </div>
              <div className="entity-meta">
                <span>{latest.published_at ? `Published ${ago(latest.published_at)}` : `Added ${ago(latest.created_at)}`}</span>
              </div>
            </div>
            <StatusBadge status={latest.status} />
          </div>
        ) : (
          <p className="muted">
            No posts yet. <Link href="/posts">Add your first carousel →</Link>
          </p>
        )}
      </section>

      <section className="home-section">
        <h3 className="section-label">Automations</h3>
        {activeCampaigns.length === 0 ? (
          <p className="muted">
            No automations running. <Link href="/campaigns">Set one up →</Link>
          </p>
        ) : (
          activeCampaigns.slice(0, 5).map((c) => (
            <div className="entity-card" key={c.id}>
              <div className="entity-main">
                <div className="entity-title">
                  <Link href="/campaigns">{c.campaign_id}</Link>
                </div>
                <div className="entity-meta mono">{c.trigger_keywords.join(", ") || "no keywords"}</div>
              </div>
              <StatusBadge status={c.sync_status} />
            </div>
          ))
        )}
        {activeCampaigns.length > 0 ? (
          <div className="muted u-mt-xs">
            {stats.dm.sentLast7Days} DMs sent in the last 7 days · {stats.dm.totalSent} total
          </div>
        ) : null}
      </section>

      <section className="home-section">
        <h3 className="section-label">Recent activity</h3>
        {recentDms.length === 0 ? (
          <p className="muted">No matched comments yet. Once a campaign is live, activity shows up here.</p>
        ) : (
          <ul className="timeline">
            {recentDms.map((dm) => (
              <li key={dm.id} className={dm.status === "SENT" ? "done" : ""}>
                <span className={`timeline-dot${dm.status === "FAILED" ? " err" : ""}`} />
                <span>
                  <strong>{dm.commenterName ?? "Someone"}</strong> commented <span className="mono">{dm.commentText}</span>
                  {dm.status === "SENT" ? " · DM sent" : ` · ${dm.status.replaceAll("_", " ").toLowerCase()}`}
                </span>
                <span className="mono timeline-time">{ago(dm.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="u-mt-xs">
          <Link href="/dm-activity">All activity →</Link>
        </div>
      </section>
    </>
  );
}
