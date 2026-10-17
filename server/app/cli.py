"""Admin CLI (run on the server, never exposed over HTTP).

  python -m app.cli migrate
  python -m app.cli create-user "Sajjad"        → prints the web-app API key ONCE
  python -m app.cli issue-key <user_id>         → extra key (e.g. another device)
  python -m app.cli revoke-keys <user_id>
  python -m app.cli list-users
"""
from __future__ import annotations

import argparse
import sys

from .config import Config
from .db import connect, migrate
from .services import Service


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="python -m app.cli")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate")
    c = sub.add_parser("create-user"); c.add_argument("name")
    i = sub.add_parser("issue-key"); i.add_argument("user_id", type=int); i.add_argument("--label", default="cli")
    r = sub.add_parser("revoke-keys"); r.add_argument("user_id", type=int)
    sub.add_parser("list-users")
    a = p.parse_args(argv)

    cfg = Config.from_env()
    conn = connect(cfg.db_path)
    applied = migrate(conn)
    svc = Service(conn, cfg)
    if a.cmd == "migrate":
        print("applied:", ", ".join(applied) if applied else "nothing (up to date)")
    elif a.cmd == "create-user":
        uid, key = svc.create_user(a.name)
        print(f"user id: {uid}\nAPI key (shown once, paste it into the web app → MT5 tab): {key}")
    elif a.cmd == "issue-key":
        print("API key (shown once):", svc.issue_user_key(a.user_id, a.label))
    elif a.cmd == "revoke-keys":
        print("revoked:", svc.revoke_user_keys(a.user_id))
    elif a.cmd == "list-users":
        for row in conn.execute("SELECT u.id, u.name, u.disabled, COUNT(k.id) AS keys FROM users u "
                                "LEFT JOIN api_keys k ON k.user_id=u.id AND k.revoked_at IS NULL GROUP BY u.id"):
            print(f"{row['id']}\t{row['name']}\tactive_keys={row['keys']}\tdisabled={row['disabled']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
