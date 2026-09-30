#!/usr/bin/env tsx
/**
 * jqp MCP server — lets Claude Code operate the system.
 *
 * Runs locally over stdio (Claude Code starts it from .mcp.json). It calls the
 * same library code as the dashboard, so every rule the dashboard enforces
 * (status checks, message cleaning, queueing) applies here too.
 *
 * Safety model:
 *  - Read-only tools are always safe.
 *  - Anything that publishes to Instagram or turns on live DM sending needs an
 *    explicit `confirm: true` argument, so an assistant cannot do it by accident.
 *  - Ingest is limited to POSTS_ROOT when that is set.
 *  - Nothing here can read or print secrets; results contain ids, statuses and copy.
 */

// stdout IS the MCP protocol channel. The project logger writes info logs with
// console.log, which would corrupt the stream, so send everything to stderr.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);

import { existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
for (const p of [".env"]) {
  const full = resolve(repoRoot, p);
  if (existsSync(full)) loadDotenv({ path: full });
}

const { closeDb } = await import("@jqp/core");
const {
  getCampaignByPostId,
  getPost,
  getSystemSnapshot,
  ingestPostFolder,
  listCampaigns,
  listFailedPosts,
  listPosts,
  listRecentEvents,
  normalizeMessageText,
  resetPostForRetry,
  upsertCampaign
} = await import("@jqp/publisher");
const { enqueuePublishPost, enqueueSyncCampaign, stopBoss } = await import("@jqp/queue");

const server = new McpServer({ name: "jqp", version: "0.1.0" });

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(message: string, extra?: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ error: message, ...extra }, null, 2) }], isError: true };
}

/** Wraps a handler so a thrown error becomes a readable tool error instead of crashing the server. */
function safe<A>(fn: (args: A) => Promise<ToolResult>): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Connection strings can appear in driver errors; never pass them on.
      return fail(message.replace(/postgres(ql)?:\/\/\S+/gi, "[db-url]").slice(0, 400));
    }
  };
}

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;
const CONFIRM = z.literal(true).describe("Must be exactly true. Confirms the user asked for this action.");

// --------------------------------------------------------------------
// Read-only tools
// --------------------------------------------------------------------

server.registerTool(
  "system_health",
  {
    title: "System health",
    description:
      "Checks whether jqp is working: database, OpenReply, the Redis message queue, the DM worker, DM delivery rate, hourly send limit, Instagram token and failed posts. Call this first when something seems wrong.",
    inputSchema: {},
    annotations: READ_ONLY
  },
  safe(async () => {
    const snap = await getSystemSnapshot();
    return ok({
      checkedAt: snap.generatedAt,
      allHealthy: snap.services.every((s) => s.state === "ok"),
      services: snap.services.map((s) => ({ name: s.label, state: s.state, detail: s.detail })),
      dmLast24h: snap.dm.last24h,
      dmSentThisHour: snap.dm.lastHourSent,
      topDmFailureReasons: snap.dm.topFailures,
      failedPosts: snap.failedPosts
    });
  })
);

server.registerTool(
  "list_posts",
  {
    title: "List posts",
    description: "Lists posts (newest first) with their status. Status DISCOVERED means ingested and ready to publish; PUBLISHED is live on Instagram; FAILED or VALIDATION_FAILED needs attention.",
    inputSchema: {
      status: z.string().optional().describe("Only posts with this exact status, e.g. DISCOVERED, PUBLISHED, FAILED"),
      limit: z.number().int().min(1).max(50).default(20)
    },
    annotations: READ_ONLY
  },
  safe(async ({ status, limit }) => {
    const posts = await listPosts();
    const rows = posts
      .filter((p) => !status || p.status === status)
      .slice(0, limit)
      .map((p) => ({
        id: p.id,
        name: p.campaign_id,
        status: p.status,
        error: p.error_message,
        publishedAt: p.published_at,
        instagramMediaId: p.instagram_media_id
      }));
    return ok({ count: rows.length, posts: rows });
  })
);

server.registerTool(
  "get_post",
  {
    title: "Get a post",
    description: "Returns one post with its caption, status, error (if any) and its DM campaign (if one is configured).",
    inputSchema: { postId: z.string().uuid() },
    annotations: READ_ONLY
  },
  safe(async ({ postId }) => {
    const post = await getPost(postId);
    if (!post) return fail("No post with that id.");
    const campaign = await getCampaignByPostId(postId);
    return ok({
      id: post.id,
      name: post.campaign_id,
      status: post.status,
      error: post.error_message,
      caption: post.caption,
      publishedAt: post.published_at,
      campaign: campaign
        ? {
            enabled: campaign.enabled,
            keywords: campaign.trigger_keywords,
            matchMode: campaign.match_mode,
            dmMessage: campaign.dm_message,
            destinationUrl: campaign.destination_url,
            twoStep: campaign.opening_dm_enabled,
            openingMessage: campaign.opening_dm_message,
            buttonLabel: campaign.opening_dm_button_label,
            syncStatus: campaign.sync_status,
            syncError: campaign.sync_error
          }
        : null
    });
  })
);

server.registerTool(
  "list_campaigns",
  {
    title: "List DM campaigns",
    description: "Lists every comment-to-DM campaign with its keywords, whether it is enabled, and whether it has synced to OpenReply.",
    inputSchema: {},
    annotations: READ_ONLY
  },
  safe(async () => {
    const rows = await listCampaigns();
    return ok({
      count: rows.length,
      campaigns: rows.map((c) => ({
        postId: c.post_id,
        post: c.campaign_id,
        postStatus: c.post_status,
        enabled: c.enabled,
        keywords: c.trigger_keywords,
        syncStatus: c.sync_status,
        syncError: c.sync_error
      }))
    });
  })
);

server.registerTool(
  "recent_problems",
  {
    title: "Recent problems",
    description: "Failed posts and recorded errors from the last 7 days. Contains no personal data.",
    inputSchema: {},
    annotations: READ_ONLY
  },
  safe(async () => {
    const [failed, events] = await Promise.all([listFailedPosts(10), listRecentEvents({ limit: 20, levels: ["warn", "error"] })]);
    return ok({
      failedPosts: failed.map((p) => ({ id: p.id, name: p.campaign_id, status: p.status, error: p.error_message })),
      events: events.map((e) => ({ at: e.created_at, level: e.level, code: e.code, message: e.message }))
    });
  })
);

server.registerTool(
  "preview_dm",
  {
    title: "Preview a DM",
    description:
      "Shows exactly what a DM will look like after cleaning (Markdown like **bold**, literal \\n and -- are removed because Instagram shows them as-is) and warns about length. Use before configuring a campaign.",
    inputSchema: { text: z.string().min(1), kind: z.enum(["message", "opening", "button"]).default("message") },
    annotations: READ_ONLY
  },
  safe(async ({ text, kind }) => {
    const cleaned = normalizeMessageText(text, { singleLine: kind === "button" });
    const limit = kind === "button" ? 20 : kind === "opening" ? 640 : 1000;
    const warnings: string[] = [];
    if (cleaned.length > limit) warnings.push(`${cleaned.length} characters; the limit for this kind is ${limit}. It would be cut off.`);
    if (kind === "opening" && !/(automat|bot|assistant)/i.test(cleaned)) warnings.push("Opening message does not say it is automated. Meta expects automated messages to disclose that.");
    if (cleaned !== text) warnings.push("Formatting characters were removed or converted. The cleaned text is what will be sent.");
    return ok({ cleaned, characters: cleaned.length, limit, warnings });
  })
);

// --------------------------------------------------------------------
// Actions
// --------------------------------------------------------------------

server.registerTool(
  "ingest_post_folder",
  {
    title: "Ingest a post folder",
    description:
      "Registers a local folder of images (1.jpg … 10.jpg, optional caption.md) as a post in DISCOVERED state, ready to publish. Does not publish. Safe to repeat: the same folder never creates a duplicate.",
    inputSchema: { folderPath: z.string().min(1).describe("Absolute path to the post folder on this computer") },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  safe(async ({ folderPath }) => {
    const root = process.env.POSTS_ROOT?.trim();
    if (root) {
      const abs = resolve(folderPath);
      const base = resolve(root);
      if (abs !== base && !abs.startsWith(base + sep)) return fail(`Folder must be inside POSTS_ROOT (${base}).`);
    }
    const post = await ingestPostFolder(folderPath);
    return ok({ id: post.id, name: post.campaign_id, status: post.status, error: post.error_message, next: post.status === "DISCOVERED" ? "Call publish_post with this id and confirm: true when the user wants it live." : "Fix the error above, then ingest again." });
  })
);

server.registerTool(
  "configure_campaign",
  {
    title: "Set up a comment-to-DM campaign",
    description:
      "Creates or updates the DM automation for a post: when someone comments one of the keywords, they get the DM. Message text is cleaned automatically. With enabled=true on a PUBLISHED post it goes live immediately, so that requires confirm: true. On a post that is not published yet it is saved and goes live after publishing.",
    inputSchema: {
      postId: z.string().uuid(),
      keywords: z.array(z.string().min(1)).min(1).max(20).describe("Trigger words, e.g. [\"LINK\", \"GUIDE\"]"),
      dmMessage: z.string().min(1).max(1000).describe("The DM that contains the link or content"),
      destinationUrl: z.string().url().startsWith("https://").optional(),
      matchMode: z.enum(["WHOLE_WORD", "PARTIAL", "EXACT"]).default("WHOLE_WORD"),
      twoStep: z
        .object({
          openingMessage: z.string().min(1).max(640).describe("Short first message. Say it is automated."),
          buttonLabel: z.string().min(1).max(20)
        })
        .optional()
        .describe("Recommended: send a short message with a button first; dmMessage is sent after the tap."),
      publicReply: z.string().min(1).max(300).optional().describe("Optional public reply under the comment"),
      enabled: z.boolean().default(false),
      confirm: CONFIRM.optional()
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  safe(async (args) => {
    const post = await getPost(args.postId);
    if (!post) return fail("No post with that id.");

    const goesLiveNow = args.enabled && post.status === "PUBLISHED";
    if (goesLiveNow && args.confirm !== true) {
      return fail("This post is already published, so enabling the campaign starts sending real DMs immediately. Ask the user, then call again with confirm: true.");
    }

    const keywords = args.keywords.map((k) => k.trim()).filter(Boolean);
    if (keywords.length === 0) return fail("At least one non-empty keyword is required, otherwise the campaign would never match a comment.");

    const campaign = await upsertCampaign({
      postId: args.postId,
      triggerKeywords: keywords,
      matchMode: args.matchMode,
      dmMessage: args.dmMessage,
      destinationUrl: args.destinationUrl ?? null,
      publicReplyEnabled: Boolean(args.publicReply),
      publicReplyMessage: args.publicReply ?? null,
      openingDmEnabled: Boolean(args.twoStep),
      openingDmMessage: args.twoStep?.openingMessage ?? null,
      openingDmButtonLabel: args.twoStep?.buttonLabel ?? null,
      enabled: args.enabled
    });

    let sync = "saved";
    if (campaign.enabled && post.status === "PUBLISHED") {
      await enqueueSyncCampaign({ campaignId: campaign.id });
      sync = "queued: the local worker must be running to push it to OpenReply";
    } else if (campaign.enabled) {
      sync = "will sync automatically after the post is published";
    }

    const warnings: string[] = [];
    if (args.twoStep && !/(automat|bot|assistant)/i.test(args.twoStep.openingMessage)) warnings.push("The opening message does not say it is automated. Meta expects that disclosure.");
    if (!args.twoStep) warnings.push("No two-step flow: the link is sent straight away. The two-step flow (short message plus button) is the compliance-friendlier option.");

    return ok({
      campaignId: campaign.id,
      enabled: campaign.enabled,
      sync,
      saved: {
        keywords: campaign.trigger_keywords,
        dmMessage: campaign.dm_message,
        openingMessage: campaign.opening_dm_message,
        buttonLabel: campaign.opening_dm_button_label,
        publicReply: campaign.public_reply_message
      },
      warnings
    });
  })
);

server.registerTool(
  "publish_post",
  {
    title: "Publish a post to Instagram",
    description:
      "Queues a DISCOVERED post to be published to Instagram. This posts publicly on the connected account, so only call it when the user has clearly asked for it, and pass confirm: true. The local publish worker (npm run dev:worker) must be running for it to go out.",
    inputSchema: { postId: z.string().uuid(), confirm: CONFIRM },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  safe(async ({ postId }) => {
    const post = await getPost(postId);
    if (!post) return fail("No post with that id.");
    if (post.status !== "DISCOVERED") return fail(`Post is ${post.status}, not DISCOVERED. Use retry_post if it failed; a published post cannot be published again.`);
    const jobId = await enqueuePublishPost({ postId });
    return ok({ queued: true, jobId, note: "It publishes when the local worker picks it up. Check get_post for the status." });
  })
);

server.registerTool(
  "retry_post",
  {
    title: "Retry a failed post",
    description: "Resets a FAILED or VALIDATION_FAILED post and queues it again. Call get_post first and fix the cause (for example a bad image) or it will fail the same way. Requires confirm: true.",
    inputSchema: { postId: z.string().uuid(), confirm: CONFIRM },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
  },
  safe(async ({ postId }) => {
    const post = await getPost(postId);
    if (!post) return fail("No post with that id.");
    if (post.status !== "FAILED" && post.status !== "VALIDATION_FAILED") return fail(`Post is ${post.status}; only FAILED or VALIDATION_FAILED posts can be retried.`);
    await resetPostForRetry(postId);
    const jobId = await enqueuePublishPost({ postId });
    return ok({ queued: true, jobId });
  })
);

// --------------------------------------------------------------------

async function shutdown(): Promise<void> {
  await stopBoss().catch(() => undefined);
  await closeDb().catch(() => undefined);
  process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await server.connect(new StdioServerTransport());
console.error("jqp MCP server ready");
