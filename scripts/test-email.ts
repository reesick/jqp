#!/usr/bin/env tsx
/**
 * Sends one test email through the same path the failure alerts use.
 *
 *   npm run test-email
 *
 * Needs ALERT_EMAIL_TO, ALERT_EMAIL_FROM and either ALERT_SMTP_* or a Resend key
 * in the root .env. Prints success or the reason it failed, never a credential.
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

const envFile = resolve(process.cwd(), ".env");
if (existsSync(envFile)) loadDotenv({ path: envFile });

async function main(): Promise<void> {
  const { sendAlertEmail } = await import("../packages/publisher/src/alerts.js");

  const result = await sendAlertEmail("jqp: test email", [
    "This is a test from `npm run test-email`.",
    "If you can read this, failure alerts will reach you.",
    "",
    `Sent at ${new Date().toISOString()}`
  ]);

  if (result.sent) {
    console.log("✓ Test email accepted by the mail server. Check the inbox (and spam) of ALERT_EMAIL_TO.");
  } else {
    console.error(`✗ Not sent: ${result.reason}`);
    process.exitCode = 1;
  }
}

void main();
