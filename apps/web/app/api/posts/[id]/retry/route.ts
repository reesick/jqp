import { NextResponse } from "next/server";
import { getPost, resetPostForRetry } from "@jqp/publisher";
import { enqueuePublishPost } from "@jqp/queue";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const post = await getPost(id);
  if (!post) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });

  if (post.status !== "FAILED" && post.status !== "VALIDATION_FAILED") {
    return NextResponse.json({ success: false, error: `Post is in status ${post.status}, not a failed state.` }, { status: 409 });
  }

  // A post that already has an Instagram media id is live; resetting it would publish a second copy.
  // After a failure that says Instagram may already show the post, a person has to confirm they checked the profile.
  const body = (await request.json().catch(() => null)) as { confirmNotLive?: boolean } | null;
  const reset = await resetPostForRetry(id, { confirmNotLive: body?.confirmNotLive === true });
  if (!reset) {
    return NextResponse.json(
      { success: false, error: "This post was not reset: it is already on Instagram, or its failure says Instagram may already show it (look at the profile, then retry with confirmNotLive), or it changed state just now." },
      { status: 409 }
    );
  }
  const jobId = await enqueuePublishPost({ postId: id }, { retry: true });
  return NextResponse.json({ success: true, data: { jobId, alreadyQueued: jobId === null } });
}
