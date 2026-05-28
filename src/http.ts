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

const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? "3000");
const dbPath = resolve(process.env.DOCS_DB_PATH ?? "data/db/docs.sqlite");

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (!db) {
    db = new DatabaseSync(dbPath, { readOnly: true });
  }
  return db;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
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

  if (req.method === "GET" && url.pathname === "/") {
    sendJson(res, 200, {
      name: "feedmob-docs-lunar-mcp",
      endpoints: { mcp: "/mcp", health: "/health" },
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/mcp") {
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
