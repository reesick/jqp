import { listCampaigns, listPosts } from "@jqp/publisher";
import { StatusBadge } from "../../components/status-badge";
import { CampaignForm } from "../../components/campaign-form";
import { EmptyState } from "../../components/empty-state";
import { MessageSquare, FolderOpen, Inbox } from "../../components/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Campaigns" };

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ postId?: string }> }) {
  const { postId } = await searchParams;
  const [campaigns, posts] = await Promise.all([listCampaigns(), listPosts()]);
  const existing = postId ? campaigns.find((c) => c.post_id === postId) : undefined;

  return (
    <>
      <div className="page-header">
        <div>
          <span className="eyebrow">
            <MessageSquare size={12} /> DM automation
          </span>
          <h1>Campaigns</h1>
        </div>
      </div>
      <p className="muted page-intro">
        Configure the keyword-triggered DM for a post. A campaign only syncs to OpenReply once its post is published
        and the campaign is enabled.
      </p>

      {posts.length === 0 ? (
        <EmptyState icon={<FolderOpen size={28} />} title="No posts yet — ingest one from the Posts page first." />
      ) : (
        <div className="card">
          <div className="card-title">{existing ? "Edit campaign" : "New campaign"}</div>
          <CampaignForm posts={posts} defaultPostId={postId} existing={existing} />
        </div>
      )}

      <div className="card-title u-mt-lg">All campaigns</div>
      {campaigns.length === 0 ? (
        <EmptyState icon={<Inbox size={28} />} title="No campaigns configured yet." />
      ) : (
        campaigns.map((c) => (
          <div className="entity-card" key={c.id}>
            <div className="entity-main">
              <div className="entity-title">
                <a href={`/campaigns?postId=${c.post_id}`}>{c.campaign_id}</a>
              </div>
              <div className="entity-meta">
                <span className="mono">{c.trigger_keywords.join(", ") || "(any word)"}</span>
                <span>{c.enabled ? "Enabled" : "Disabled"}</span>
              </div>
              {c.sync_error ? <div className="error-box">{c.sync_error}</div> : null}
            </div>
            <StatusBadge status={c.sync_status} />
          </div>
        ))
      )}
    </>
  );
}
