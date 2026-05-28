#!/usr/bin/env python3
from __future__ import annotations

import re
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRAPED_DIR = ROOT / "scraped"
DB_PATH = ROOT / "data" / "db" / "docs.sqlite"


def title_from_markdown(path: Path, content: str) -> str:
    for line in content.splitlines():
        match = re.match(r"^#\s+(.+?)\s*$", line)
        if match:
            return match.group(1).strip()
    stem = re.sub(r"^\d+-", "", path.stem)
    return stem.replace("-", " ").strip() or path.stem


def build() -> int:
    files = sorted(SCRAPED_DIR.rglob("*.md"))
    if not files:
        raise SystemExit(f"No markdown files found under {SCRAPED_DIR}")

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", "-shm", "-wal"):
        path = Path(f"{DB_PATH}{suffix}")
        if path.exists():
            path.unlink()

    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute("PRAGMA synchronous=NORMAL")
        conn.execute(
            """
            CREATE TABLE pages (
              id INTEGER PRIMARY KEY,
              path TEXT NOT NULL UNIQUE,
              title TEXT NOT NULL,
              content TEXT NOT NULL
            )
            """
        )
        conn.execute(
            """
            CREATE VIRTUAL TABLE pages_fts
            USING fts5(title, content, path UNINDEXED, content='pages', content_rowid='id')
            """
        )

        for path in files:
            rel_path = path.relative_to(SCRAPED_DIR).as_posix()
            content = path.read_text(encoding="utf-8")
            title = title_from_markdown(path, content)
            cursor = conn.execute(
                "INSERT INTO pages(path, title, content) VALUES (?, ?, ?)",
                (rel_path, title, content),
            )
            conn.execute(
                "INSERT INTO pages_fts(rowid, title, content, path) VALUES (?, ?, ?, ?)",
                (cursor.lastrowid, title, content, rel_path),
            )

        conn.execute("PRAGMA user_version=1")
        conn.commit()
        conn.execute("VACUUM")
    finally:
        conn.close()

    return len(files)


if __name__ == "__main__":
    count = build()
    print(f"Built {DB_PATH} from {count} markdown files")
