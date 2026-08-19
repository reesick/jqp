import Link from "next/link";
import { notFound } from "next/navigation";
import { getPost, listPostMedia, getCampaignByPostId } from "@jqp/publisher";
import { StatusBadge } from "../../../components/status-badge";
import { ActionButton } from "../../../components/action-button";
import { Rocket, RotateCw } from "../../../components/icons";

export const dynamic = "force-dynamic";

const STEP_ORDER = [
  "DISCOVERED",
  "VALIDATING",
  "UPLOADING",
  "CREATING_CHILDREN",
  "WAITING_FOR_CHILDREN",
  "CREATING_CAROUSEL",
  "WAITING_FOR_CAROUSEL",
  "PUBLISHING",
  "PUBLISHED"
];

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const post = await getPost(id);
  return { title: post?.campaign_id ?? "Post" };
}

export default async function PostDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const post = await getPost(id);
  if (!post) notFound();

  const [media, campaign] = await Promise.all([listPostMedia(id), getCampaignByPostId(id)]);
  const currentStepIndex = STEP_ORDER.indexOf(post.status);
  const failed = post.status === "FAILED" || post.status === "VALIDATION_FAILED";

  return (
    <>
      <div className="page-header">
        <div>
          <p className="u-text-sm u-mb-xxs">
            <Link href="/posts">&larr; All posts</Link>
          </p>
          <h1>{post.campaign_id}</h1>
          <div className="entity-meta u-mt-xxs">
            <StatusBadge status={post.status} />
            <span className="mono">{post.folder_path}</span>
          </div>
        </div>
        <div>
          {post.status === "DISCOVERED" ? (
            <ActionButton href={`/api/posts/${post.id}/publish`} label="Publish" icon={<Rocket size={14} />} />
          ) : null}
          {failed ? <ActionButton href={`/api/posts/${post.id}/retry`} label="Retry" icon={<RotateCw size={14} />} /> : null}
        </div>
      </div>

      {post.error_message ? <div className="error-box">{post.error_message}</div> : null}

      <div className="card">
        <div className="card-title">Pipeline progress</div>
        {post.status === "PUBLISHED" && post.instagram_media_id ? (
          <p className="muted mono u-mt-sm">Instagram Media ID: {post.instagram_media_id}</p>
        ) : null}
        <ul className="timeline">
          {STEP_ORDER.map((step, i) => (
            <li key={step} className={i <= currentStepIndex || post.status === "PUBLISHED" ? "done" : ""}>
              <span className="timeline-dot" />
              <span>{step.replaceAll("_", " ")}</span>
            </li>
          ))}
          {failed ? (
            <li>
              <span className="timeline-dot err" />
              <span>{post.status.replaceAll("_", " ")}</span>
            </li>
          ) : null}
        </ul>
      </div>

      <div className="card">
        <div className="card-title">Media ({media.length})</div>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Filename</th>
              <th>Uploaded</th>
              <th>Container status</th>
            </tr>
          </thead>
          <tbody>
            {media.map((m) => (
              <tr key={m.id}>
                <td>{m.sequence}</td>
                <td>{m.original_filename}</td>
                <td>{m.public_url ? "✓" : "—"}</td>
                <td>
                  <StatusBadge status={m.container_status} dense />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-title">DM campaign</div>
        {campaign ? (
          <>
            <p>
              Keywords: <span className="mono">{campaign.trigger_keywords.join(", ") || "(any word)"}</span>
            </p>
            <p className="entity-meta u-mt-xxs u-align-center">
              <StatusBadge status={campaign.enabled ? "PUBLISHED" : "DISCOVERED"} />
              {campaign.enabled ? "enabled" : "disabled"}
              <span className="muted">·</span>
              sync <StatusBadge status={campaign.sync_status} />
            </p>
            {campaign.sync_error ? <div className="error-box">{campaign.sync_error}</div> : null}
            <p className="u-mt-xs">
              <Link href={`/campaigns?postId=${post.id}`}>Edit campaign &rarr;</Link>
            </p>
          </>
        ) : (
          <p className="muted">
            No campaign configured yet. <Link href={`/campaigns?postId=${post.id}`}>Create one &rarr;</Link>
          </p>
        )}
      </div>
    </>
  );
}
