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

  await resetPostForRetry(id);
  const jobId = await enqueuePublishPost({ postId: id });
  return NextResponse.json({ success: true, data: { jobId } });
}
