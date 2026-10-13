#!/usr/bin/env tsx
/**
 * Turns posts from a delivery folder (index.json + post.json, e.g. POST-F/05_FINAL) into posts the system can publish:
 * copies the slides into posts/<post_id>/ (the layout the ingest expects), writes caption.md from post.json, registers
 * the post as DISCOVERED, and creates its comment-to-DM campaign switched OFF.
 *
 *   node --import tsx scripts/stage-post-kit.ts --post 01_dot-and-key --dry-run     (shows the plan, changes nothing)
 *   node --import tsx scripts/stage-post-kit.ts --post 01_dot-and-key                (stages one post)
 *   node --import tsx scripts/stage-post-kit.ts --all                                 (stages every post in posting order)
 *   options: --dir <delivery folder>   --keyword PROMPT   --button "send prompts"
 *
 * It never publishes and never enables a campaign. Re-running is safe: the same folder never creates a second post.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRootDotenv } from "@jqp/core/bootstrap";
loadRootDotenv();
import { closeDb, loadEnv } from "@jqp/core";
import { ingestPostFolder, upsertCampaign } from "@jqp/publisher";
import { fail } from "./lib/env-update.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(`--${n}`);
const value = (n: string): string | undefined => {
  const i = args.indexOf(`--${n}`);
  const v = i >= 0 ? args[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
};

interface PostJson {
  post_id: string;
  brand: string;
  caption: string;
  slides: { order: number; file: string }[];
  guide_url: string;
  dm_flow: { keyword: string; steps: { step: number; text: string }[] };
}

async function stageOne(dir: string, folder: string, dry: boolean): Promise<void> {
  const src = join(dir, folder);
  const post = JSON.parse(readFileSync(join(src, "post.json"), "utf8")) as PostJson;
  const keyword = value("keyword") ?? post.dm_flow.keyword;
  const button = value("button") ?? "send prompts";
  const openingDm = `click below for the ${post.brand} prompts`;
  const linkDm = post.dm_flow.steps[1]?.text ?? "";
  if (!linkDm.includes(post.guide_url)) fail(`${folder}: DM step 2 does not contain the guide link. Fix post.json first.`);
  const slides = [...post.slides].sort((a, b) => a.order - b.order);
  const missing = slides.filter((s) => !existsSync(join(src, s.file)));
  if (missing.length) fail(`${folder}: missing slide files: ${missing.map((m) => m.file).join(", ")}`);

  const out = join(root, "posts", post.post_id);
  console.log(`\n${post.post_id} (${post.brand})`);
  console.log(`  slides: ${slides.length} -> ${out}`);
  console.log(`  caption: ${[...post.caption].length} characters`);
  console.log(`  keyword: ${keyword} (whole word, any case)`);
  console.log(`  message 1: "${openingDm}"  button: "${button}"`);
  console.log(`  message 2: "${linkDm.replace(/\n/g, " | ")}"`);
  console.log("  campaign: created OFF; public reply off; follow not required");
  if (dry) return;

  mkdirSync(out, { recursive: true });
  for (const s of slides) copyFileSync(join(src, s.file), join(out, s.file));
  writeFileSync(join(out, "caption.md"), post.caption.endsWith("\n") ? post.caption : post.caption + "\n");
  const row = await ingestPostFolder(out);
  const campaign = await upsertCampaign({
    postId: row.id,
    triggerKeywords: [keyword],
    matchMode: "WHOLE_WORD",
    dmMessage: linkDm,
    destinationUrl: null,
    publicReplyEnabled: false,
    publicReplyMessage: null,
    openingDmEnabled: true,
    openingDmMessage: openingDm,
    openingDmButtonLabel: button,
    enabled: false
  });
  console.log(`  ✓ post ${row.id} is ${row.status}; campaign ${campaign.id} saved, enabled=${campaign.enabled}`);
}

async function main(): Promise<void> {
  const dir = resolve(value("dir") ?? join(root, "POST-F", "05_FINAL"));
  const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8")) as { posting_order: string[] };
  const wanted = flag("all") ? index.posting_order : value("post") ? [value("post") as string] : [];
  if (wanted.length === 0) fail("Pass --post <post_id> or --all.");
  const dry = flag("dry-run");
  if (!dry) loadEnv();
  for (const folder of wanted) await stageOne(dir, folder, dry);
  console.log(dry ? "\n(dry run: nothing was written)" : "\nDone. Nothing was published and no campaign is enabled.");
}

main()
  .catch((err) => fail(err instanceof Error ? err.message : String(err)))
  .finally(() => closeDb());
