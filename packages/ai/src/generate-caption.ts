import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { loadEnv, NonRetryableError, RetryableError } from "@jqp/core";

/**
 * Caption generation via AWS Bedrock — deliberately kept OUTSIDE the
 * publishing pipeline (plan section 7: "AI failure does NOT prevent
 * manual posting"). This module is never imported by
 * packages/publisher or apps/worker. It's a standalone pre-step: run
 * it (via scripts/generate-caption.ts, or call generateCaption()
 * directly) to WRITE caption.md before you ever ingest the folder.
 * Once caption.md exists, the Posting Engine reads it verbatim and
 * never calls this module — see packages/publisher/src/scanner.ts.
 *
 * Uses Bedrock's model-agnostic Converse API (not Bedrock Agents —
 * plan section 8: Agents Classic is in maintenance mode and closed to
 * new customers as of 30 July 2026, and this task never needed agents
 * anyway, just one inference call).
 */

let client: BedrockRuntimeClient | undefined;

function getClient(): BedrockRuntimeClient {
  if (client) return client;
  const env = loadEnv();
  client = new BedrockRuntimeClient({
    region: env.AWS_REGION,
    // Explicit creds only if provided — omitting these lets the SDK fall
    // back to a shared ~/.aws/credentials profile or an IAM role instead.
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY } }
      : {})
  });
  return client;
}

export interface GenerateCaptionParams {
  brief: string;
  hashtagCount?: number;
  tone?: string;
}

/**
 * Generates one caption from a brief. Throws AI_DISABLED (NonRetryable)
 * if AI_ENABLED is false — callers should treat that as "use manual
 * captions", not retry it.
 */
export async function generateCaption(params: GenerateCaptionParams): Promise<string> {
  const env = loadEnv();
  if (!env.AI_ENABLED) {
    throw new NonRetryableError("AI_ENABLED is false — set it to true and configure AWS_REGION/BEDROCK_MODEL_ID to use caption generation.", "AI_DISABLED");
  }

  const { brief, hashtagCount = 3, tone = "casual, engaging" } = params;
  const prompt = [
    `Write a single Instagram caption for this post. Tone: ${tone}.`,
    `Include exactly ${hashtagCount} relevant hashtags at the end.`,
    `Output ONLY the caption text — no preamble, no quotes, no markdown.`,
    ``,
    `Brief: ${brief}`
  ].join("\n");

  try {
    const response = await getClient().send(
      new ConverseCommand({
        modelId: env.BEDROCK_MODEL_ID,
        messages: [{ role: "user", content: [{ text: prompt }] }],
        inferenceConfig: { maxTokens: 400, temperature: 0.8 }
      })
    );

    const text = response.output?.message?.content?.[0]?.text;
    if (!text) {
      throw new RetryableError("Bedrock returned no text content", "BEDROCK_EMPTY_RESPONSE");
    }
    return text.trim();
  } catch (err) {
    if (err instanceof RetryableError || err instanceof NonRetryableError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new RetryableError(`Bedrock request failed: ${message}`, "BEDROCK_REQUEST_ERROR");
  }
}
