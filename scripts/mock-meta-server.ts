#!/usr/bin/env tsx
/**
 * Starts the fake Meta Graph API server for local end-to-end testing.
 * Set MOCK_META=true and MOCK_META_PORT to match in .env, then run
 * this alongside the worker/web app — see docs/LOCAL.md.
 */
import { loadRootDotenv } from "../packages/core/src/bootstrap.js";
loadRootDotenv();

import { createMockMetaServer } from "../packages/meta/src/testing/mock-server.js";

const PORT = Number(process.env.MOCK_META_PORT ?? 8787);
const { server } = createMockMetaServer();

server.listen(PORT, () => {
  console.log(`[mock-meta] listening on http://localhost:${PORT}`);
  console.log(`[mock-meta] set MOCK_META=true and MOCK_META_PORT=${PORT} in .env to use it`);
});
