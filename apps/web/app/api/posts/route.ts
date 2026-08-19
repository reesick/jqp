import { NextRequest, NextResponse } from "next/server";
import { listPosts, ingestPostFolder } from "@jqp/publisher";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const posts = await listPosts();
    return NextResponse.json({ success: true, data: posts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: `Database unavailable: ${message}` }, { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  const folderPath = body?.folderPath;
  if (!folderPath || typeof folderPath !== "string") {
    return NextResponse.json({ success: false, error: "folderPath is required" }, { status: 400 });
  }

  try {
    const post = await ingestPostFolder(folderPath);
    return NextResponse.json({ success: true, data: post }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
