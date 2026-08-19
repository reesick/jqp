import { loadEnv, NonRetryableError, RetryableError } from "@jqp/core";
import { getSupabaseClient } from "./client.js";

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-");
}

function guessContentType(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop();
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "png") return "image/png";
  return "application/octet-stream";
}

export interface UploadPostMediaParams {
  campaignId: string; // folder name, e.g. POST_001
  sequence: number;
  originalFilename: string;
  fileBuffer: Buffer;
}

export interface UploadPostMediaResult {
  storagePath: string;
  publicUrl: string;
}

/**
 * Uploads one image to the instagram-media bucket at a deterministic
 * path ({campaignId}/{sequence}-{sanitizedName}) and returns its public
 * HTTPS URL. Upsert:true so re-running the publisher after a crash
 * (plan section 66) overwrites the same object instead of erroring or
 * creating a duplicate.
 */
export async function uploadPostMedia(params: UploadPostMediaParams): Promise<UploadPostMediaResult> {
  const env = loadEnv();
  const client = getSupabaseClient();
  const safeName = sanitizeFilename(params.originalFilename);
  const storagePath = `${params.campaignId}/${params.sequence}-${safeName}`;

  const { error } = await client.storage.from(env.SUPABASE_STORAGE_BUCKET).upload(storagePath, params.fileBuffer, {
    contentType: guessContentType(safeName),
    upsert: true
  });

  if (error) {
    throw new RetryableError(`Failed to upload ${storagePath} to Supabase Storage: ${error.message}`, "STORAGE_UPLOAD_ERROR", {
      storagePath
    });
  }

  const { data } = client.storage.from(env.SUPABASE_STORAGE_BUCKET).getPublicUrl(storagePath);

  return { storagePath, publicUrl: data.publicUrl };
}

/**
 * Signed-URL alternative to the public bucket (plan section 18,
 * "Option B"). Not used by default — see supabase/migrations/0003_storage.sql
 * for why Option A (public bucket) is V1's choice — but kept available
 * if you later decide the bucket should be private.
 */
export async function getSignedMediaUrl(storagePath: string, expiresInSeconds = 3600): Promise<string> {
  const env = loadEnv();
  const client = getSupabaseClient();
  const { data, error } = await client.storage.from(env.SUPABASE_STORAGE_BUCKET).createSignedUrl(storagePath, expiresInSeconds);

  if (error || !data) {
    throw new RetryableError(`Failed to create signed URL for ${storagePath}: ${error?.message}`, "STORAGE_SIGN_ERROR", { storagePath });
  }

  return data.signedUrl;
}

/**
 * Sanity check that runs an actual unauthenticated GET against the
 * public URL we're about to hand Meta. Catches bucket/policy
 * misconfiguration (RLS not applied, bucket not actually public)
 * immediately with a clear error, instead of surfacing three steps
 * later as an opaque Meta container ERROR (plan section 11).
 */
export async function preflightMediaUrl(publicUrl: string): Promise<void> {
  let response: Response;
  try {
    response = await fetch(publicUrl, { method: "GET" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new RetryableError(`Could not reach media URL ${publicUrl}: ${message}`, "STORAGE_PREFLIGHT_NETWORK_ERROR", { publicUrl });
  }

  if (!response.ok) {
    throw new NonRetryableError(`Media URL ${publicUrl} is not publicly reachable (HTTP ${response.status}). Check the bucket's public-read policy (supabase/migrations/0003_storage.sql).`, "STORAGE_PREFLIGHT_UNREACHABLE", { publicUrl, status: response.status });
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    throw new NonRetryableError(`Media URL ${publicUrl} did not return an image content-type (got "${contentType}")`, "STORAGE_PREFLIGHT_BAD_CONTENT_TYPE", {
      publicUrl,
      contentType
    });
  }
}

export { sanitizeFilename, guessContentType };
