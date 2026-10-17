"""Runtime configuration, read from environment variables (see server/.env.example)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field


def _bool(v: str | None, default: bool) -> bool:
    if v is None or v.strip() == "":
        return default
    return v.strip().lower() in ("1", "true", "yes", "on")


def _int(v: str | None, default: int) -> int:
    try:
        return int(v) if v not in (None, "") else default
    except ValueError:
        return default


@dataclass
class Config:
    db_path: str = "data/fandamental.db"
    allowed_origins: list[str] = field(default_factory=list)
    require_https: bool = True
    trust_proxy: bool = False            # honour X-Forwarded-Proto (only behind your own reverse proxy)
    signal_max_age_sec: int = 900        # a signal older than this is refused at submit time
    signal_default_ttl_sec: int = 900    # default validity window when the web app does not send one
    heartbeat_timeout_sec: int = 60      # terminal shown as "disconnected" after this much silence
    sending_timeout_sec: int = 120       # a "sending" execution with no final report becomes "unknown"
    rate_limit_per_min: int = 240        # per API/terminal key
    max_body_bytes: int = 64 * 1024
    log_level: str = "INFO"

    @classmethod
    def from_env(cls) -> "Config":
        e = os.environ.get
        origins = [o.strip().rstrip("/") for o in (e("FA_ALLOWED_ORIGINS") or "").split(",") if o.strip()]
        return cls(
            db_path=e("FA_DB_PATH") or cls.db_path,
            allowed_origins=origins,
            require_https=_bool(e("FA_REQUIRE_HTTPS"), True),
            trust_proxy=_bool(e("FA_TRUST_PROXY"), False),
            signal_max_age_sec=_int(e("FA_SIGNAL_MAX_AGE_SEC"), 900),
            signal_default_ttl_sec=_int(e("FA_SIGNAL_DEFAULT_TTL_SEC"), 900),
            heartbeat_timeout_sec=_int(e("FA_HEARTBEAT_TIMEOUT_SEC"), 60),
            sending_timeout_sec=_int(e("FA_SENDING_TIMEOUT_SEC"), 120),
            rate_limit_per_min=_int(e("FA_RATE_LIMIT_PER_MIN"), 240),
            log_level=(e("FA_LOG_LEVEL") or "INFO").upper(),
        )
