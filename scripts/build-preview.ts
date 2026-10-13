#!/usr/bin/env tsx
/**
 * Builds a self-contained preview page for a delivery folder (index.json + one post.json per post), e.g. POST-F/05_FINAL.
 * Read-only: it never touches the database, Instagram or Vercel. Images are referenced by relative path, so open the
 * result from the same folder (double-click preview.html).
 *
 *   node --import tsx scripts/build-preview.ts [folder]      (default: POST-F/05_FINAL)
 *
 * Per post it checks (1) the delivery spec's text rules and (2) what our system and Meta's rules mean for the DM flow,
 * and prints a verdict. Nothing is silently fixed: a violation is shown, with the reason.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dir = resolve(process.argv[2] ?? join(root, "POST-F", "05_FINAL"));

type Level = "ok" | "warn" | "block" | "manual";
interface Check { group: string; level: Level; label: string; detail: string }

interface Slide { order: number; file: string; role: string; width: number; height: number }
interface PostJson {
  post_id: string; brand: string; caption: string; hashtags: string[]; slides: Slide[]; guide_url: string; guide_title: string;
  dm_flow: { trigger: string; keyword: string; match: string; steps: { step: number; text: string; link?: string }[] };
  brand_assets: { avatar: string; guide_cover: string };
  [k: string]: unknown;
}

const read = (p: string): string => readFileSync(p, "utf8");
const readJson = <T>(p: string): T => JSON.parse(read(p)) as T;

const AI_TELLS = ["elevate", "unleash", "unlock", "game-changer", "game changer", "delve", "seamless", "effortless", "in today's", "whether you're", "look no further", "dive in", "next level", "revolutionize", "embark", "journey", "tapestry", "testament", "not just a", "stunning", "breathtaking", "captivating", "imagine a world", "say goodbye", "say hello to"];
const BANNED_EMOJI = ["✨", "🚀", "🔥", "💯"];
const AUTOMATED = /(automat|bot\b|assistant)/i;

function textRules(label: string, text: string, out: Check[]): void {
  const add = (level: Level, what: string, detail: string) => out.push({ group: "Spec text rules", level, label: `${label}: ${what}`, detail });
  if (/[—–]/.test(text)) add("block", "long dash", "Contains an em or en dash. Use a comma or 'to'.");
  if (/[“”‘’]/.test(text)) add("block", "curly quotes", "Use straight quotes only.");
  if ((text.match(/"/g) ?? []).length % 2 === 1) add("block", "unbalanced quotes", "An opening quote has no closing quote.");
  if (text.includes("…")) add("block", "ellipsis character", "Rewrite it, or use three dots.");
  if (/[^\S\n]{2,}/.test(text) || /[ \t]+$/m.test(text)) add("block", "stray spaces", "Double or trailing spaces.");
  if (/\b(TBD|TODO)\b|\[[^\]]*\]|<[a-z][^>]*>/i.test(text)) add("block", "placeholder", "Looks like a placeholder was left in.");
  const lower = text.toLowerCase();
  for (const w of AI_TELLS) if (lower.includes(w)) add("block", `AI-sounding word "${w}"`, "Rewrite in plain, short words.");
  for (const e of BANNED_EMOJI) if (text.includes(e)) add("block", `emoji ${e}`, "Not allowed by the voice rules.");
  if (text.includes("!!")) add("block", "double exclamation", "Not allowed by the voice rules.");
  if (lower.includes("adgod")) add("block", "mentions adgod", "Never mention it.");
}

function checkPost(p: PostJson, folder: string): { items: Check[]; counts: Record<Level, number>; verdict: "ready" | "warnings" | "blocked" } {
  const items: Check[] = [];
  const add = (group: string, level: Level, label: string, detail: string) => items.push({ group, level, label, detail });

  // ---- Files and structure
  const missing = p.slides.filter((s) => !existsSync(join(folder, s.file)));
  if (missing.length) add("Files", "block", "Missing slide files", missing.map((m) => m.file).join(", "));
  else add("Files", "ok", "All slide files exist", `${p.slides.length} slides.`);
  if (p.slides.length < 2 || p.slides.length > 10) add("Files", "block", "Slide count", `${p.slides.length} slides. A carousel needs 2 to 10.`);
  if (p.slides.some((s) => s.width !== 1080 || s.height !== 1080)) add("Files", "warn", "Slide size", "Not every slide is 1080x1080.");
  for (const f of [p.brand_assets.guide_cover]) if (!existsSync(join(folder, f))) add("Files", "block", "Missing guide cover", f);
  const stale = ["pinned_comment", "dm_reply", "comment_keyword"].filter((k) => k in p);
  if (stale.length) add("Files", "block", "Old v1 fields present", stale.join(", "));

  // ---- Spec text rules
  textRules("caption", p.caption, items);
  p.dm_flow.steps.forEach((s) => textRules(`DM step ${s.step}`, s.text, items));
  if (p.hashtags.length > 10) add("Spec text rules", "block", "Hashtags", `${p.hashtags.length} hashtags. The spec allows 10.`);
  if (!p.caption.includes("follow and comment PROMPT, i'll send you all the prompts")) add("Spec text rules", "block", "Caption call to action", "The exact line 'follow and comment PROMPT, i'll send you all the prompts' is missing.");
  const [s1, s2] = p.dm_flow.steps;
  if (p.dm_flow.steps.length !== 2 || !s1 || !s2) add("Spec text rules", "block", "DM steps", "Must be exactly 2 steps.");
  else {
    if (/https?:\/\//i.test(s1.text)) add("Spec text rules", "block", "Link in step 1", "The link belongs only in step 2.");
    if (!s2.link || s2.link !== p.guide_url || !s2.text.includes(p.guide_url)) add("Spec text rules", "block", "Link in step 2", "Step 2 must carry the guide link, identical to guide_url.");
  }
  if ([...p.caption].length > 2200) add("Instagram limits", "block", "Caption length", `${[...p.caption].length} characters. The limit is 2,200.`);
  else add("Instagram limits", "ok", "Caption length", `${[...p.caption].length} of 2,200 characters.`);

  // ---- What Meta's rules and our system mean for this DM flow
  // Message 1 as it will really be sent is the short version the owner chose ("click below for the ... prompts").
  const sent1 = `click below for the ${p.brand} prompts`;
  if (!AUTOMATED.test(sent1)) add("Meta and system", "warn", "Message 1 does not say it is automated", "Your choice: Meta recommends automated messages say so, and requires it where the law does. It is not a technical blocker.");
  add("Meta and system", "ok", "One reply per comment, then the tap", "Meta allows ONE reply to a comment. Message 1 carries a button; message 2 (the link) is only sent after the person taps it, which counts as responding.");
  add("Meta and system", "ok", "Guide link", `Confirmed live by you: ${p.guide_url}. (The hub page is not live, which does not matter for the DM.)`);
  add("Meta and system", "ok", "Public reply and follow gate", "Both stay off for launch. Public replies need several variants first; follow gating is a spam-policy risk.");
  add("Meta and system", "manual", "Meta app is Live", "In the Meta app's top bar. Development mode delivers no real webhooks.");
  add("Meta and system", "manual", "Test with a stranger", "Comment PROMPT from an account with no role on your app. Meta says comment webhooks need Advanced Access; whether Live mode alone is enough is unverified.");

  const counts: Record<Level, number> = { ok: 0, warn: 0, block: 0, manual: 0 };
  for (const i of items) counts[i.level] += 1;
  return { items, counts, verdict: counts.block > 0 ? "blocked" : counts.warn > 0 ? "warnings" : "ready" };
}

function main(): void {
  const indexPath = join(dir, "index.json");
  if (!existsSync(indexPath)) {
    console.error(`No index.json in ${dir}. Pass the delivery folder, e.g. POST-F/05_FINAL.`);
    process.exit(1);
  }
  const index = readJson<{ account: string; posting_order: string[]; posts: { post_id: string; folder: string }[] }>(indexPath);

  const posts = index.posts.map((entry) => {
    const folder = join(dir, entry.folder);
    const p = readJson<PostJson>(join(folder, "post.json"));
    const keyword = p.dm_flow.keyword;
    const s1 = p.dm_flow.steps[0]?.text ?? "";
    const s2 = p.dm_flow.steps[1]?.text ?? "";
    // The opening message the system will actually send: the spec's message 1 with the automation disclosure in front,
    // plus a button. Shown to the owner as a proposal, never applied silently.
    const openingDm = `click below for the ${p.brand} prompts`;
    const guideMdPath = join(folder, "prompt_guide.md");
    return {
      ...p,
      folder: entry.folder,
      guide_md: existsSync(guideMdPath) ? read(guideMdPath) : "",
      mapping: { keywords: [keyword], matchMode: "WHOLE_WORD", openingDm, buttonLabel: "send prompts", linkDm: s2, link: p.guide_url },
      checks: checkPost(p, folder)
    };
  });

  const data = {
    builtAt: new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC",
    order: index.posting_order,
    brand: { avatar: "_brand/avatar.png" },
    posts
  };
  // "<" is escaped so no post text can close the script tag.
  const json = JSON.stringify(data).replace(/</g, "\\u003c");
  const template = read(join(root, "scripts", "preview", "template.html"));
  const out = join(dir, "preview.html");
  writeFileSync(out, template.replace("/*__DATA__*/null", () => json));

  console.log(`Preview written: ${out}\n`);
  for (const p of posts) {
    const c = p.checks.counts;
    console.log(`${p.post_id.padEnd(20)} ${p.checks.verdict.toUpperCase().padEnd(9)} ${c.block} blockers, ${c.warn} warnings, ${c.manual} to check by hand`);
    for (const i of p.checks.items.filter((x) => x.level === "block" || x.level === "warn")) console.log(`   [${i.level}] ${i.label}`);
  }
}

main();
