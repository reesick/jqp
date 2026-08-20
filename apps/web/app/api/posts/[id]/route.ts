import { NextResponse } from "next/server";
import { getPost, listPostMedia } from "@jqp/publisher";
import { apiError } from "../../_lib/api-error";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const post = await getPost(id);
    if (!post) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
    const media = await listPostMedia(id);
    return NextResponse.json({ success: true, data: { post, media } });
  } catch (err) {
    return apiError("post_fetch_failed", err, { status: 503, publicMessage: "Database unavailable.", fields: { postId: id } });
  }
}
