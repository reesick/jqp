import { listCampaigns, listPosts } from "@jqp/publisher";
import { StatusBadge } from "../../components/status-badge";
import { CampaignForm } from "../../components/campaign-form";
import { CampaignToggle } from "../../components/campaign-toggle";
import { EmptyState } from "../../components/empty-state";
import { FolderOpen, Zap } from "../../components/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Automations" };

export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ postId?: string }> }) {
  const { postId } = await searchParams;
  const [campaigns, posts] = await Promise.all([listCampaigns(), listPosts()]);
  const existing = postId ? campaigns.find((c) => c.post_id === postId) : undefined;

  const list = (
    <section key="list" className={postId ? "u-mt-lg" : undefined}>
      <h3 className="section-label">Comment → DM automations</h3>
      {campaigns.length === 0 ? (
        <EmptyState
          icon={<Zap size={24} />}
          title="No automations yet."
          hint="Turn Instagram comments into automatic DMs. Create one below."
        />
      ) : (
        campaigns.map((c) => (
          <div className="entity-card" key={c.id}>
            <div className="entity-main">
              <div className="entity-title">
                <a href={`/campaigns?postId=${c.post_id}`}>{c.campaign_id}</a>
              </div>
              <div className="entity-meta">
                <span className="mono">{c.trigger_keywords.join(", ") || "(any word)"}</span>
              </div>
              {c.sync_error ? (
                <div className="entity-note">
                  Couldn&rsquo;t sync to the DM engine: {c.sync_error}. Saving the automation again retries the sync.
                </div>
              ) : null}
            </div>
            <StatusBadge status={c.enabled ? c.sync_status : "PAUSED"} />
            <CampaignToggle campaign={c} />
          </div>
        ))
      )}
    </section>
  );

  const form = (
    <section key="form" className={postId ? undefined : "u-mt-lg"}>
      <h3 className="section-label">{existing ? "Edit automation" : "New automation"}</h3>
      <p className="muted page-intro-static">
        Configure the keyword-triggered DM for a post. It only syncs to the DM engine once its post is published and
        the automation is enabled.
      </p>
      {posts.length === 0 ? (
        <EmptyState
          icon={<FolderOpen size={24} />}
          title="No posts to automate yet."
          hint="Ingest a post folder on the Posts page first."
        />
      ) : (
        <CampaignForm posts={posts} defaultPostId={postId} existing={existing} />
      )}
    </section>
  );

  return (
    <>
      <div className="page-header">
        <h1>Automations</h1>
      </div>
      {postId ? [form, list] : [list, form]}
    </>
  );
}
