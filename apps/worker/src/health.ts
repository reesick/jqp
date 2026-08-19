import { createServer, type Server } from "node:http";
import { rootLogger } from "@jqp/core";

/**
 * Minimal health endpoint for Render's health check — no Express, one
 * route, nothing fancy. `setReady(false)` during startup/shutdown so
 * Render doesn't route traffic (or, for a background worker, doesn't
 * consider it healthy) before the queue listeners are actually attached.
 */
export function startHealthServer(port: number): { server: Server; setReady: (ready: boolean) => void } {
  let ready = false;

  const server = createServer((req, res) => {
    if (req.url === "/" || req.url === "/health") {
      res.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: ready ? "ok" : "starting" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    rootLogger.info("health_server_listening", { port });
  });

  return { server, setReady: (value: boolean) => { ready = value; } };
}
