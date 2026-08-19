import { NextResponse } from "next/server";
import { getPost, listPostMedia } from "@jqp/publisher";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const post = await getPost(id);
    if (!post) return NextResponse.json({ success: false, error: "Not found" }, { status: 404 });
    const media = await listPostMedia(id);
    return NextResponse.json({ success: true, data: { post, media } });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: `Database unavailable: ${message}` }, { status: 503 });
  }
}
