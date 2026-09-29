"""Copy a Xianyu SQLite database for server deployment without exposing card tokens."""

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path


PUBLIC_URL = "https://91zhajinwanyi.cn/api/delivery/codes"
INTERNAL_URL = "http://delivery-gateway:8081/api/delivery/codes"


def prepare_database(
    source: Path, destination: Path, new_admin_password: str | None = None
) -> int:
    source = source.resolve(strict=True)
    destination = destination.resolve()
    if source == destination or destination.exists():
        raise ValueError("Destination must be a new file separate from the source")
    if not destination.parent.is_dir():
        raise ValueError("Destination directory does not exist")

    source_db = sqlite3.connect(source.as_uri() + "?mode=ro", uri=True)
    target_db = sqlite3.connect(destination)
    try:
        source_db.backup(target_db)
        with target_db:
            admin = target_db.execute(
                "SELECT password_hash FROM users WHERE username = 'admin'"
            ).fetchone()
            if not admin:
                raise ValueError("Admin account is missing")
            if new_admin_password is not None:
                if len(new_admin_password) < 16 or new_admin_password == "admin123":
                    raise ValueError("New admin password must have at least 16 characters")
                target_db.execute(
                    "UPDATE users SET password_hash = ? WHERE username = 'admin'",
                    (hashlib.sha256(new_admin_password.encode()).hexdigest(),),
                )
            elif admin[0] == hashlib.sha256(b"admin123").hexdigest():
                raise ValueError("Set a non-default admin password before migration")

            rows = target_db.execute(
                "SELECT id, api_config FROM cards WHERE type = 'api'"
            ).fetchall()
            changed = 0
            for card_id, serialized in rows:
                try:
                    config = json.loads(serialized)
                except (TypeError, ValueError) as exc:
                    raise ValueError(f"API card {card_id} has invalid JSON") from exc
                if not isinstance(config, dict):
                    raise ValueError(f"API card {card_id} has invalid configuration")
                if config.get("url") != PUBLIC_URL:
                    continue
                config["url"] = INTERNAL_URL
                target_db.execute(
                    "UPDATE cards SET api_config = ? WHERE id = ?",
                    (json.dumps(config, ensure_ascii=False), card_id),
                )
                changed += 1
            if changed == 0:
                raise ValueError("No API cards matched the expected public delivery URL")

            for key in ("registration_enabled", "show_default_login_info"):
                target_db.execute(
                    "INSERT INTO system_settings (key, value, description) "
                    "VALUES (?, 'false', '') "
                    "ON CONFLICT(key) DO UPDATE SET value = 'false'",
                    (key,),
                )
        return changed
    except Exception:
        target_db.close()
        destination.unlink(missing_ok=True)
        raise
    finally:
        source_db.close()
        target_db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Original SQLite database")
    parser.add_argument("destination", type=Path, help="New, private server copy")
    parser.add_argument(
        "--new-admin-password-file",
        type=Path,
        help="Private file containing a new admin password for the copied database",
    )
    args = parser.parse_args()
    try:
        password = None
        if args.new_admin_password_file:
            if os.name == "posix" and args.new_admin_password_file.stat().st_mode & 0o077:
                raise ValueError("Admin password file must not be readable by group or others")
            password = args.new_admin_password_file.read_text(encoding="utf-8").rstrip("\r\n")
        count = prepare_database(args.source, args.destination, password)
    except (OSError, sqlite3.Error, ValueError) as exc:
        print(f"Migration failed: {exc}", file=sys.stderr)
        return 1
    print(f"Prepared database: {count} API card URL(s) updated; registration disabled")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
