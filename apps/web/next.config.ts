import type { NextConfig } from "next";
import { loadRootDotenv } from "@jqp/core/bootstrap";

// Next.js only auto-loads .env files from its OWN directory
// (apps/web/.env*). This repo keeps a single .env at the monorepo
// root instead, so load it explicitly here — next.config.ts runs in
// Node before anything else, including `next dev`'s own env loading,
// so this populates process.env in time for both dev and build.
loadRootDotenv();

const nextConfig: NextConfig = {
  // @jqp/* workspace packages are plain TS compiled to dist/ — nothing
  // Next-specific needed here, but transpilePackages keeps things safe
  // if a package is ever imported before its dist/ is built.
  transpilePackages: ["@jqp/core", "@jqp/meta", "@jqp/storage", "@jqp/queue", "@jqp/publisher"]
};

export default nextConfig;
