import type { NextConfig } from "next";
import { loadRootDotenv } from "@jqp/core/bootstrap";

// Next.js only auto-loads .env files from its OWN directory
// (apps/web/.env*). This repo keeps a single .env at the monorepo
// root instead, so load it explicitly here — next.config.ts runs in
// Node before anything else, including `next dev`'s own env loading,
// so this populates process.env in time for both dev and build.
loadRootDotenv();

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // The app renders no remote images; turning the optimizer off removes an
  // unauthenticated route (/_next/image bypasses the auth middleware).
  images: { unoptimized: true },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" }
        ]
      }
    ];
  },
  // @jqp/* workspace packages are plain TS compiled to dist/ — nothing
  // Next-specific needed here, but transpilePackages keeps things safe
  // if a package is ever imported before its dist/ is built.
  transpilePackages: ["@jqp/core", "@jqp/meta", "@jqp/storage", "@jqp/queue", "@jqp/publisher"]
};

export default nextConfig;
