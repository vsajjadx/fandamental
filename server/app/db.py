"""SQLite access + forward-only migrations.

Migrations are the numbered .sql files in app/migrations. Each one is applied once, inside a
transaction, and recorded in schema_migrations. Existing data is never dropped.
"""
from __future__ import annotations

import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

MIGRATIONS_DIR = Path(__file__).with_name("migrations")


def connect(path: str) -> sqlite3.Connection:
    if path != ":memory:" and not path.startswith("file:"):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=15, isolation_level=None, check_same_thread=False, uri=path.startswith("file:"))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    if path != ":memory:":
        try:
            conn.execute("PRAGMA journal_mode = WAL")
        except sqlite3.DatabaseError:
            pass
    return conn


@contextmanager
def tx(conn: sqlite3.Connection):
    """Write transaction. BEGIN IMMEDIATE serialises writers, so two concurrent polls from the
    same terminal can never both claim the same execution."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException as ex:
        # some refusals must persist the state change they made (e.g. "expired") before raising
        conn.execute("COMMIT" if getattr(ex, "commit_on_raise", False) else "ROLLBACK")
        raise
    else:
        conn.execute("COMMIT")


def migrate(conn: sqlite3.Connection) -> list[str]:
    conn.execute("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)")
    done = {r["version"] for r in conn.execute("SELECT version FROM schema_migrations")}
    applied = []
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        ver = f.stem
        if ver in done:
            continue
        sql = f.read_text(encoding="utf-8")
        # executescript() commits implicitly, so run statements one by one inside our own transaction
        stmts = [s.strip() for s in _split_sql(sql) if s.strip()]
        conn.execute("BEGIN IMMEDIATE")
        try:
            for s in stmts:
                conn.execute(s)
            conn.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", (ver, int(time.time())))
        except BaseException:
            conn.execute("ROLLBACK")
            raise
        conn.execute("COMMIT")
        applied.append(ver)
    return applied


def _split_sql(sql: str) -> list[str]:
    out, buf = [], []
    for line in sql.splitlines():
        s = line.strip()
        if s.startswith("--"):
            continue
        buf.append(line)
        if s.endswith(";"):
            out.append("\n".join(buf).rstrip().rstrip(";"))
            buf = []
    if "".join(buf).strip():
        out.append("\n".join(buf))
    return out


def open_db(path: str) -> sqlite3.Connection:
    conn = connect(path)
    migrate(conn)
    return conn


def db_path_from_env() -> str:
    return os.environ.get("FA_DB_PATH") or "data/fandamental.db"
