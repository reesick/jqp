import { NextRequest, NextResponse } from "next/server";
import { listPosts, ingestPostFolder } from "@jqp/publisher";
import { apiError } from "../_lib/api-error";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const posts = await listPosts();
    return NextResponse.json({ success: true, data: posts });
  } catch (err) {
    return apiError("posts_list_failed", err, { status: 503, publicMessage: "Database unavailable." });
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
    // Ingest errors are usually the operator's own input (bad folder path,
    // wrong filenames, unreadable image), so the message is genuinely useful
    // to them — but it can also carry a filesystem path, so it still goes
    // through the same sanitiser in production.
    return apiError("post_ingest_failed", err, { status: 400, publicMessage: "Could not ingest that folder." });
  }
}
