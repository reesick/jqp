import Link from "next/link";
import { listPosts } from "@jqp/publisher";
import { StatusBadge } from "../../components/status-badge";
import { IngestForm } from "../../components/ingest-form";
import { ActionButton } from "../../components/action-button";
import { EmptyState } from "../../components/empty-state";
import { Inbox, Rocket, RotateCw } from "../../components/icons";

export const dynamic = "force-dynamic";
export const metadata = { title: "Posts" };

export default async function PostsPage() {
  const posts = await listPosts();

  return (
    <>
      <div className="page-header">
        <h1>Posts</h1>
      </div>

      <IngestForm />

      <h3 className="section-label u-mt-lg">All posts</h3>
      {posts.length === 0 ? (
        <EmptyState
          icon={<Inbox size={24} />}
          title="No posts yet."
          hint="Add a folder above. It needs 1.jpg, 2.jpg, … and a caption.md."
        />
      ) : (
        posts.map((post) => (
          <div className="entity-card" key={post.id}>
            <div className="entity-main">
              <div className="entity-title">
                <Link href={`/posts/${post.id}`}>{post.campaign_id}</Link>
              </div>
              <div className="entity-meta">
                <span className="mono">{new Date(post.created_at).toLocaleString()}</span>
                {post.instagram_media_id ? <span className="mono">{post.instagram_media_id}</span> : null}
              </div>
              {post.error_message && (post.status === "FAILED" || post.status === "VALIDATION_FAILED") ? (
                <div className="entity-note">{post.error_message}</div>
              ) : null}
            </div>
            <StatusBadge status={post.status} />
            {post.status === "DISCOVERED" ? (
              <ActionButton href={`/api/posts/${post.id}/publish`} label="Publish" icon={<Rocket size={14} />} />
            ) : post.status === "FAILED" || post.status === "VALIDATION_FAILED" ? (
              <ActionButton href={`/api/posts/${post.id}/retry`} label="Retry" icon={<RotateCw size={14} />} secondary />
            ) : null}
          </div>
        ))
      )}
    </>
  );
}
