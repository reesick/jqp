import { config } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Loads the monorepo root .env file regardless of the current working
 * directory. Needed because `npm run <script> --workspace apps/worker`
 * (and similar) sets process.cwd() to the WORKSPACE directory
 * (apps/worker), not the repo root — verified empirically, not
 * assumed — so a plain `dotenv.config()` would silently look in the
 * wrong place. Resolves relative to this file's own location instead:
 * packages/core/src(or dist)/bootstrap.(ts|js) is always exactly two
 * directories below the repo root.
 *
 * Not exported from index.ts on purpose — this performs file I/O as a
 * side effect and should only run in Node entrypoints (apps/worker,
 * scripts/*) that explicitly opt in, never as a side effect of
 * importing @jqp/core's normal API surface.
 *
 * No-ops safely if the file doesn't exist (e.g. Render/Vercel, where
 * env vars are injected by the platform and no .env file exists).
 */
export function loadRootDotenv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const rootEnvPath = resolve(here, "../../../.env");
  if (existsSync(rootEnvPath)) {
    config({ path: rootEnvPath });
  }
}
