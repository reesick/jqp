#!/usr/bin/env tsx
/**
 * Starts the jqp MCP server exactly as Claude Code would (stdio), lists its
 * tools and calls a few that are safe and read-only.
 *
 *   npm run mcp:selftest
 *
 * Proves the protocol wiring works before you register the server with Claude Code.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "apps/mcp/src/index.ts"], cwd: process.cwd(), stderr: "pipe" });
const client = new Client({ name: "selftest", version: "0.0.0" });

let failures = 0;
function check(name: string, pass: boolean, detail = ""): void {
  if (!pass) failures += 1;
  console.log(`  ${pass ? "✓ PASS" : "✗ FAIL"} ${name}${detail ? `  — ${detail}` : ""}`);
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("");
}

async function main(): Promise<void> {
  console.log("jqp MCP self-test");
  await client.connect(transport);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  const expected = ["configure_campaign", "get_post", "ingest_post_folder", "list_campaigns", "list_posts", "preview_dm", "publish_post", "recent_problems", "retry_post", "system_health"];
  check("server starts and lists tools", names.length === expected.length, names.join(", "));
  check("every expected tool is present", expected.every((n) => names.includes(n)));

  const publish = tools.find((t) => t.name === "publish_post");
  const required = (publish?.inputSchema as { required?: string[] } | undefined)?.required ?? [];
  check("publish_post requires confirm", required.includes("confirm"));

  const preview = await client.callTool({ name: "preview_dm", arguments: { text: "Hey! **Here** is the guide\\nEnjoy -- it is free", kind: "message" } });
  const parsed = JSON.parse(textOf(preview)) as { cleaned: string };
  check("preview_dm strips markdown, escaped newlines and --", parsed.cleaned === "Hey! Here is the guide\nEnjoy – it is free", JSON.stringify(parsed.cleaned));

  const noConfirm = await client.callTool({ name: "publish_post", arguments: { postId: "00000000-0000-0000-0000-000000000000" } }).catch((e: unknown) => ({ isError: true, content: [{ type: "text", text: String(e) }] }));
  check("publish_post without confirm is refused", (noConfirm as { isError?: boolean }).isError === true);

  const health = await client.callTool({ name: "system_health", arguments: {} });
  const h = textOf(health);
  check("system_health responds with a report", (health as { isError?: boolean }).isError !== true && h.includes("services"), `${h.length} chars`);

  await client.close();
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Self-test crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
