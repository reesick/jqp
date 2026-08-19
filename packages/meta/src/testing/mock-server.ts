import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * Fake Meta Graph API implementing just enough of the real surface
 * (container create/poll, carousel, publish, permalink, private/
 * public replies, Instagram Login OAuth) for the full publish
 * pipeline to run against it end-to-end. Shared by:
 *  - scripts/mock-meta-server.ts (manual local runs, docs/LOCAL.md)
 *  - this package's own integration test (mock-server.test.ts)
 *
 * Does NOT mock Supabase Storage — only the Meta side.
 */

const VERSION_PREFIX = /^\/v\d+\.\d+\//;

interface ContainerState {
  status: "IN_PROGRESS" | "FINISHED";
  pollCount: number;
}

// Polls-to-finish before a container reports FINISHED — exercises the
// pipeline's IN_PROGRESS -> FINISHED loop realistically instead of
// finishing instantly on the first check.
const POLLS_TO_FINISH = 2;

function json(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<{ raw: string; params: URLSearchParams }> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const contentType = req.headers["content-type"] ?? "";
  if (contentType.includes("application/json")) {
    try {
      return { raw, params: new URLSearchParams(JSON.parse(raw || "{}")) };
    } catch {
      return { raw, params: new URLSearchParams() };
    }
  }
  return { raw, params: new URLSearchParams(raw) };
}

/**
 * Merges query-string params with any body params. This client
 * (packages/meta/src/client.ts) encodes every POST param into the URL
 * query string rather than a request body — the same convention the
 * real Graph API accepts — so query params take precedence; body
 * params are only a fallback for endpoints that do send a real body
 * (the OAuth code-exchange POST does, via application/x-www-form-urlencoded).
 */
async function getParams(req: IncomingMessage, url: URL): Promise<URLSearchParams> {
  const { params: bodyParams } = await readBody(req);
  const merged = new URLSearchParams(bodyParams);
  for (const [key, value] of url.searchParams) merged.set(key, value);
  return merged;
}

export interface MockMetaServer {
  server: Server;
  /** Resets all in-memory container/media state between test cases. */
  reset: () => void;
  port: () => number;
}

export function createMockMetaServer(): MockMetaServer {
  let counter = 0;
  function nextId(prefix: string): string {
    counter += 1;
    return `${prefix}_${counter}_${Date.now().toString(36)}`;
  }

  let containers = new Map<string, ContainerState>();
  let publishedMedia = new Map<string, { permalink: string }>();

  const server = createServer(async (req, res) => {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const versioned = VERSION_PREFIX.test(url.pathname);
    const path = versioned ? url.pathname.replace(VERSION_PREFIX, "/") : url.pathname;
    const method = req.method ?? "GET";

    if (method === "POST" && path === "/oauth/access_token") {
      await readBody(req);
      return json(res, 200, { access_token: nextId("shortlived"), user_id: "17841400000000001", permissions: ["instagram_business_basic"] });
    }
    if (method === "GET" && path === "/access_token") {
      return json(res, 200, { access_token: nextId("longlived"), token_type: "bearer", expires_in: 5184000 });
    }
    if (method === "GET" && path === "/refresh_access_token") {
      return json(res, 200, { access_token: nextId("refreshed"), token_type: "bearer", expires_in: 5184000 });
    }
    if (method === "GET" && path === "/me") {
      return json(res, 200, { user_id: "17841400000000001", username: "mock_account" });
    }

    const mediaCreateMatch = path.match(/^\/([^/]+)\/media$/);
    if (method === "POST" && mediaCreateMatch) {
      const params = await getParams(req, url);
      const isCarousel = params.get("media_type") === "CAROUSEL";
      const id = nextId(isCarousel ? "carousel" : params.get("is_carousel_item") === "true" ? "child" : "single");
      containers.set(id, { status: "IN_PROGRESS", pollCount: 0 });
      return json(res, 200, { id });
    }

    const publishMatch = path.match(/^\/([^/]+)\/media_publish$/);
    if (method === "POST" && publishMatch) {
      const params = await getParams(req, url);
      const creationId = params.get("creation_id");
      if (!creationId || !containers.has(creationId)) {
        return json(res, 400, { error: { message: "Invalid creation_id", type: "OAuthException", code: 100 } });
      }
      const mediaId = nextId("media");
      publishedMedia.set(mediaId, { permalink: `https://instagram.com/p/${mediaId}` });
      return json(res, 200, { id: mediaId });
    }

    const messagesMatch = path.match(/^\/([^/]+)\/messages$/);
    if (method === "POST" && messagesMatch) {
      await readBody(req);
      return json(res, 200, { recipient_id: "mock_recipient", message_id: nextId("dm") });
    }

    const repliesMatch = path.match(/^\/([^/]+)\/replies$/);
    if (method === "POST" && repliesMatch) {
      await readBody(req);
      return json(res, 200, { id: nextId("reply") });
    }

    const singleIdMatch = path.match(/^\/([^/]+)$/);
    if (method === "GET" && singleIdMatch) {
      const id = singleIdMatch[1] as string;
      const fields = (url.searchParams.get("fields") ?? "").split(",");

      if (containers.has(id) && fields.includes("status_code")) {
        const container = containers.get(id)!;
        container.pollCount += 1;
        if (container.pollCount >= POLLS_TO_FINISH) container.status = "FINISHED";
        return json(res, 200, { status_code: container.status, status: container.status === "FINISHED" ? "Ready" : "Processing" });
      }

      if (publishedMedia.has(id) && fields.includes("permalink")) {
        return json(res, 200, { permalink: publishedMedia.get(id)!.permalink });
      }

      return json(res, 400, { error: { message: `mock-meta: unknown id ${id}`, type: "OAuthException", code: 100 } });
    }

    json(res, 404, { error: { message: `mock-meta: no route for ${method} ${url.pathname}`, type: "OAuthException", code: 100 } });
  });

  return {
    server,
    reset: () => {
      containers = new Map();
      publishedMedia = new Map();
      counter = 0;
    },
    port: () => {
      const address = server.address();
      return typeof address === "object" && address ? address.port : 0;
    }
  };
}
