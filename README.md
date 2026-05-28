# feedmob-docs-lunar-mcp

Stage-one MCP service for searching scraped markdown docs from a bundled SQLite FTS5 database.

## Build the database

```bash
python scripts/build_db.py
```

This reads local `scraped/*.md` files and writes `data/db/docs.sqlite`. The `scraped/` directory is ignored and must not be committed.

## Run locally

```bash
npm ci
npm run build
HOST=0.0.0.0 PORT=3000 npm start
```

Endpoints:

- `GET /health` returns `{"ok":true}` and does not touch the database.
- `POST /mcp` handles Streamable HTTP JSON-RPC requests.

Tools:

- `search_docs`
- `get_page`

