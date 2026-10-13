import { NextResponse } from "next/server";
import { getPost, resetPostForRetry } from "@jqp/publisher";
import { enqueuePublishPost } from "@jqp/queue";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const post = await getPost(id);
  if (!post) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });

  if (post.status !== "FAILED" && post.status !== "VALIDATION_FAILED") {
    return NextResponse.json({ success: false, error: `Post is in status ${post.status}, not a failed state.` }, { status: 409 });
  }

  // A post that already has an Instagram media id is live; resetting it would publish a second copy.
  const reset = await resetPostForRetry(id);
  if (!reset) {
    return NextResponse.json(
      { success: false, error: "This post is already on Instagram (or changed state just now), so it was not reset. Check the profile before trying again." },
      { status: 409 }
    );
  }
  const jobId = await enqueuePublishPost({ postId: id });
  return NextResponse.json({ success: true, data: { jobId, alreadyQueued: jobId === null } });
}
