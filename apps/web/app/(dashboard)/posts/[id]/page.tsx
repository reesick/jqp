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

  // Instagram's published limits for a carousel caption: 2,200 characters, 30 hashtags, 2 to 10 slides.
  const captionChars = [...(post.caption ?? "")].length;
  const hashtagCount = (post.caption?.match(/#[\p{L}\p{N}_]+/gu) ?? []).length;
  const captionWarnings: string[] = [];
  if (captionChars > 2200) captionWarnings.push("The caption is over 2,200 characters, so Instagram would reject it.");
  if (hashtagCount > 30) captionWarnings.push("More than 30 hashtags: Instagram would reject the caption.");
  if (media.length < 2) captionWarnings.push("A carousel needs at least 2 images.");
  if (media.length > 10) captionWarnings.push("A carousel can have at most 10 images.");
  if (/[—–]/.test(post.caption ?? "")) captionWarnings.push("The caption has a long dash, which reads as AI-written. See the content guide.");

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
        <div className="page-actions">
          {post.status === "DISCOVERED" ? (
            <ActionButton href={`/api/posts/${post.id}/publish`} label="Publish" icon={<Rocket size={14} />} confirmMessage="Publish this post to your connected Instagram account now? It goes live for everyone and cannot be undone from here." />
          ) : null}
          {failed ? <ActionButton href={`/api/posts/${post.id}/retry`} label="Retry" icon={<RotateCw size={14} />} /> : null}
        </div>
      </div>

      {post.error_message ? (
        <div className="error-box" role="alert">
          {failed ? "Publishing failed: " : ""}
          {post.error_message}
          {failed ? " Fix the cause if it is in the folder or caption, then use Retry." : ""}
        </div>
      ) : null}

      <div className="card">
        <div className="card-title">Post preview</div>
        <div className="post-preview">
          {media.some((m) => m.public_url) ? (
            <div className="post-preview-strip">
              {media.map((m) =>
                m.public_url ? (
                  <img key={m.id} src={m.public_url} alt={`Slide ${m.sequence}`} loading="lazy" />
                ) : null
              )}
            </div>
          ) : (
            <p className="muted u-text-sm">
              {media.length} {media.length === 1 ? "image" : "images"} in the folder ({media.map((m) => m.original_filename).join(", ") || "none"}). Pictures appear here once they are uploaded, which happens when you publish.
            </p>
          )}
          <p className="post-caption">{post.caption || "(no caption)"}</p>
          <p className="muted u-text-sm">
            {captionChars} of 2,200 characters, {hashtagCount} of 30 hashtags, {media.length} of 10 slides
          </p>
          {captionWarnings.length > 0 ? (
            <ul className="dm-warnings">
              {captionWarnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Pipeline progress</div>
        {post.status === "PUBLISHED" && post.instagram_media_id ? (
          <p className="muted u-mt-sm">
            Instagram media ID: <span className="mono">{post.instagram_media_id}</span>
          </p>
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
                <td className="mono">{m.sequence}</td>
                <td className="mono">{m.original_filename}</td>
                <td>{m.public_url ? "Yes" : "Not yet"}</td>
                <td>
                  <StatusBadge status={m.container_status} dense />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="card-title">Comment → DM automation</div>
        {campaign ? (
          <>
            <p>
              Keywords: <span className="mono">{campaign.trigger_keywords.join(", ") || "(any word)"}</span>
            </p>
            <p className="entity-meta u-mt-xxs u-align-center">
              <StatusBadge status={campaign.enabled ? "RUNNING" : "PAUSED"} />
              <span className="muted">·</span>
              DM engine sync <StatusBadge status={campaign.sync_status} />
            </p>
            {campaign.sync_error ? (
              <div className="error-box" role="alert">
                Couldn&rsquo;t sync to the DM engine: {campaign.sync_error}. Saving the automation again retries the sync.
              </div>
            ) : null}
            <p className="u-mt-xs">
              <Link href={`/campaigns?postId=${post.id}`}>Edit automation &rarr;</Link>
            </p>
          </>
        ) : (
          <p className="muted">
            No automation yet. Turn comments on this post into DMs. <Link href={`/campaigns?postId=${post.id}`}>Create one &rarr;</Link>
          </p>
        )}
      </div>
    </>
  );
}
