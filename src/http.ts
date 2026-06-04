import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type JsonRpcRequest = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
};

type ToolCallParams = {
  name?: string;
  arguments?: Record<string, unknown>;
};

type SessionPayload = {
  email: string;
  exp: number;
};

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");
const dbPath = resolve(process.env.DOCS_DB_PATH ?? "data/db/docs.sqlite");
const authMode = process.env.AUTH_MODE ?? "none";
const baseUrl = process.env.BASE_URL;
const allowedDomain = (process.env.ALLOWED_DOMAIN ?? "").toLowerCase();
const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const sessionSecret = process.env.SESSION_SECRET ?? googleClientSecret ?? "local-dev-secret";
const sessionCookieName = "feedmob_docs_session";
const oauthStateCookieName = "feedmob_docs_oauth_state";
const sessionTtlSeconds = 60 * 60 * 8;

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(dbPath, { readOnly: true });
  }
  return db;
}

function appendSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader("set-cookie");
  if (!existing) {
    res.setHeader("set-cookie", cookie);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader("set-cookie", [...existing, cookie]);
    return;
  }
  res.setHeader("set-cookie", [String(existing), cookie]);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sendRpcResult(res: ServerResponse, id: JsonRpcRequest["id"], result: unknown): void {
  sendJson(res, 200, { jsonrpc: "2.0", id: id ?? null, result });
}

function sendRpcError(
  res: ServerResponse,
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): void {
  sendJson(res, 200, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function textContent(text: string): Array<{ type: "text"; text: string }> {
  return [{ type: "text", text }];
}

function encodeBase64Url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(input: string): Buffer {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + padding, "base64");
}

function sign(value: string): string {
  return encodeBase64Url(createHmac("sha256", sessionSecret).update(value).digest());
}

function createCookie(name: string, value: string, maxAgeSeconds: number): string {
  return `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie;
  if (!raw) {
    return {};
  }
  return Object.fromEntries(
    raw.split(/;\s*/).map((part) => {
      const idx = part.indexOf("=");
      if (idx === -1) {
        return [part, ""];
      }
      return [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))];
    }),
  );
}

function createSessionCookie(email: string): string {
  const payload: SessionPayload = {
    email,
    exp: Math.floor(Date.now() / 1000) + sessionTtlSeconds,
  };
  const encodedPayload = encodeBase64Url(JSON.stringify(payload));
  const signature = sign(encodedPayload);
  return createCookie(sessionCookieName, `${encodedPayload}.${signature}`, sessionTtlSeconds);
}

function readSession(req: IncomingMessage): SessionPayload | null {
  const token = parseCookies(req)[sessionCookieName];
  if (!token) {
    return null;
  }
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) {
    return null;
  }
  const expectedSignature = sign(payloadPart);
  const actual = Buffer.from(signaturePart);
  const expected = Buffer.from(expectedSignature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return null;
  }
  try {
    const payload = JSON.parse(decodeBase64Url(payloadPart).toString("utf8")) as SessionPayload;
    if (payload.exp <= Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

function isAuthenticated(req: IncomingMessage): boolean {
  if (authMode !== "oauth") {
    return true;
  }
  return readSession(req) !== null;
}

function requireAuth(req: IncomingMessage, res: ServerResponse): boolean {
  if (isAuthenticated(req)) {
    return true;
  }
  if (req.method === "GET") {
    redirectToGoogleAuth(res);
    return false;
  }
  sendJson(res, 401, { error: "authentication required" });
  return false;
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
}

function assertOAuthConfigured(): void {
  if (!baseUrl || !googleClientId || !googleClientSecret || !allowedDomain) {
    throw new Error("OAuth mode is enabled but required environment variables are missing");
  }
}

function redirectToGoogleAuth(res: ServerResponse): void {
  assertOAuthConfigured();
  const state = encodeBase64Url(randomBytes(24));
  appendSetCookie(res, createCookie(oauthStateCookieName, state, 600));
  const params = new URLSearchParams({
    client_id: googleClientId!,
    redirect_uri: `${baseUrl!}/auth/google/callback`,
    response_type: "code",
    scope: "openid email profile",
    access_type: "offline",
    prompt: "select_account",
    state,
  });
  redirect(res, `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
}

async function exchangeGoogleCode(code: string): Promise<string> {
  assertOAuthConfigured();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: googleClientId!,
      client_secret: googleClientSecret!,
      redirect_uri: `${baseUrl!}/auth/google/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!response.ok) {
    throw new Error(`token exchange failed (${response.status})`);
  }
  const tokenPayload = (await response.json()) as { access_token?: string };
  if (!tokenPayload.access_token) {
    throw new Error("token exchange returned no access_token");
  }
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { authorization: `Bearer ${tokenPayload.access_token}` },
  });
  if (!profileResponse.ok) {
    throw new Error(`userinfo request failed (${profileResponse.status})`);
  }
  const profile = (await profileResponse.json()) as { email?: string; email_verified?: boolean; hd?: string };
  const email = profile.email?.toLowerCase();
  if (!email || !profile.email_verified) {
    throw new Error("google account email is missing or unverified");
  }
  const emailDomain = email.split("@")[1] ?? "";
  if (emailDomain !== allowedDomain && profile.hd?.toLowerCase() !== allowedDomain) {
    throw new Error("account domain is not allowed");
  }
  return email;
}

function searchDocs(args: Record<string, unknown> | undefined) {
  const query = String(args?.query ?? "").trim();
  const limitRaw = Number(args?.limit ?? 10);
  const limit = Math.max(1, Math.min(Number.isFinite(limitRaw) ? limitRaw : 10, 25));

  if (!query) {
    throw new Error("query is required");
  }

  const rows = getDb()
    .prepare(
      `
      SELECT
        pages.id,
        pages.path,
        pages.title,
        snippet(pages_fts, 1, '[', ']', '...', 24) AS snippet,
        bm25(pages_fts) AS score
      FROM pages_fts
      JOIN pages ON pages.id = pages_fts.rowid
      WHERE pages_fts MATCH ?
      ORDER BY score
      LIMIT ?
      `,
    )
    .all(query, limit);

  return {
    content: textContent(JSON.stringify({ query, results: rows }, null, 2)),
  };
}

function getPage(args: Record<string, unknown> | undefined) {
  const id = args?.id;
  const path = typeof args?.path === "string" ? args.path : undefined;

  if (id === undefined && !path) {
    throw new Error("id or path is required");
  }

  const row =
    id !== undefined
      ? getDb().prepare("SELECT id, path, title, content FROM pages WHERE id = ?").get(Number(id))
      : getDb().prepare("SELECT id, path, title, content FROM pages WHERE path = ?").get(path!);

  if (!row) {
    throw new Error("page not found");
  }

  return {
    content: textContent(JSON.stringify(row, null, 2)),
  };
}

function listTools() {
  return {
    tools: [
      {
        name: "search_docs",
        description: "Search the local docs SQLite FTS5 index.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number", minimum: 1, maximum: 25 },
          },
          required: ["query"],
        },
      },
      {
        name: "get_page",
        description: "Fetch a full documentation page by id or path.",
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "number" },
            path: { type: "string" },
          },
          anyOf: [{ required: ["id"] }, { required: ["path"] }],
        },
      },
    ],
  };
}

function handleRpc(req: JsonRpcRequest, res: ServerResponse): void {
  switch (req.method) {
    case "initialize":
      sendRpcResult(res, req.id, {
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "feedmob-docs-lunar-mcp", version: "0.1.0" },
      });
      return;
    case "notifications/initialized":
      res.writeHead(202).end();
      return;
    case "tools/list":
      sendRpcResult(res, req.id, listTools());
      return;
    case "tools/call": {
      const params = req.params as ToolCallParams | undefined;
      try {
        if (params?.name === "search_docs") {
          sendRpcResult(res, req.id, searchDocs(params.arguments));
          return;
        }
        if (params?.name === "get_page") {
          sendRpcResult(res, req.id, getPage(params.arguments));
          return;
        }
        sendRpcError(res, req.id, -32602, "unknown tool");
      } catch (error) {
        const message = error instanceof Error ? error.message : "tool call failed";
        sendRpcResult(res, req.id, {
          isError: true,
          content: textContent(message),
        });
      }
      return;
    }
    default:
      sendRpcError(res, req.id, -32601, "method not found");
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/google") {
    redirectToGoogleAuth(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/auth/google/callback") {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const cookies = parseCookies(req);
    if (!state || !code || cookies[oauthStateCookieName] !== state) {
      appendSetCookie(res, clearCookie(oauthStateCookieName));
      sendJson(res, 400, { error: "invalid oauth callback" });
      return;
    }
    try {
      const email = await exchangeGoogleCode(code);
      appendSetCookie(res, clearCookie(oauthStateCookieName));
      appendSetCookie(res, createSessionCookie(email));
      redirect(res, "/");
    } catch (error) {
      appendSetCookie(res, clearCookie(oauthStateCookieName));
      const message = error instanceof Error ? error.message : "oauth callback failed";
      sendJson(res, 403, { error: message });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/logout") {
    appendSetCookie(res, clearCookie(sessionCookieName));
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    if (!requireAuth(req, res)) {
      return;
    }
    sendJson(res, 200, {
      name: "feedmob-docs-lunar-mcp",
      endpoints: { mcp: "/mcp", health: "/health" },
      authMode,
      user: readSession(req)?.email ?? null,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/mcp") {
    if (!requireAuth(req, res)) {
      return;
    }
    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
      if (Array.isArray(parsed)) {
        sendRpcError(res, null, -32600, "batch requests are not supported");
        return;
      }
      handleRpc(parsed, res);
    } catch {
      sendRpcError(res, null, -32700, "parse error");
    }
    return;
  }

  sendJson(res, 404, { error: "not found" });
});

server.listen(port, host, () => {
  const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  console.log(`${packageJson.name} listening on ${host}:${port}`);
});
