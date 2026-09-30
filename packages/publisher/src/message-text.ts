/**
 * Makes message copy safe to send as an Instagram DM.
 *
 * Instagram renders DMs as plain text. Nothing in the send path mangles what it
 * is given, so the defects come from what goes IN: copy written by a person or
 * an AI assistant in Markdown, or an API caller that sends a literal backslash-n
 * instead of a newline. All of it would reach the recipient verbatim as stray
 * asterisks, hashes, backslashes and "\n". This runs on every campaign write
 * (repository.upsertCampaign), so the dashboard form, the REST API and the
 * Claude Code tools all get the same protection.
 *
 * It only removes formatting syntax. It does not reword anything, and it leaves
 * URLs and {placeholders} untouched.
 */

export interface NormalizeOptions {
  /** Collapse to one line (button labels, which Meta renders on a single line). */
  singleLine?: boolean;
}

export function normalizeMessageText(input: string, opts: NormalizeOptions = {}): string {
  let text = input;

  // Escaped whitespace typed as characters (common from JSON built by hand or by an LLM).
  text = text.replace(/\\r\\n|\\n|\\r/g, "\n").replace(/\\t/g, " ");

  // Real line endings -> "\n".
  text = text.replace(/\r\n?/g, "\n");

  // [label](https://url) -> "label https://url": Instagram will not render the link syntax.
  text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, "$1 $2");

  // Emphasis and code markers around words: **bold**, __bold__, *italic*, _italic_, `code`, ~~strike~~.
  text = text.replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, "$2");
  text = text.replace(/(^|[\s(])\*(?=\S)([^*\n]*?\S)\*(?=$|[\s).,!?:;])/g, "$1$2");
  text = text.replace(/(^|[\s(])_(?=\S)([^_\n]*?\S)_(?=$|[\s).,!?:;])/g, "$1$2");
  text = text.replace(/`([^`\n]+)`/g, "$1");

  // Line-leading Markdown: headings, blockquotes, and "- " / "* " bullets -> a real bullet.
  text = text.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");
  text = text.replace(/^[ \t]*>[ \t]?/gm, "");
  text = text.replace(/^[ \t]*[-*+][ \t]+/gm, "• ");

  // Horizontal rules and stray double hyphens used as dashes.
  text = text.replace(/^[ \t]*([-*_])([ \t]*\1){2,}[ \t]*$/gm, "");
  // Only when spaced on both sides, so "a--b" inside a URL or slug is never touched.
  text = text.replace(/(?<=[ \t])--+(?=[ \t])/g, "–");

  // Zero-width characters and non-breaking spaces that copy/paste drags in.
  text = text.replace(new RegExp("[\u200B-\u200D\uFEFF]", "g"), "").replace(new RegExp("\u00A0", "g"), " ");

  // Tidy whitespace: trailing spaces, more than one blank line in a row, outer trim.
  text = text.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();

  if (opts.singleLine) text = text.replace(/\s*\n+\s*/g, " ").replace(/ {2,}/g, " ").trim();

  return text;
}

/** Like normalizeMessageText, but passes null/undefined through. */
export function normalizeOptionalMessage(input: string | null | undefined, opts: NormalizeOptions = {}): string | null {
  if (input === null || input === undefined) return null;
  const out = normalizeMessageText(input, opts);
  return out.length > 0 ? out : null;
}
