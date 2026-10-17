"""Keys, hashing, log redaction and a small in-memory rate limiter."""
from __future__ import annotations

import hashlib
import logging
import re
import secrets
import threading
import time

USER_PREFIX = "fa_u_"      # web app → server
TERMINAL_PREFIX = "fa_t_"  # MT5 Expert Advisor → server

_TOKEN_RE = re.compile(r"fa_[ut]_[A-Za-z0-9_\-]{8,}")
_BEARER_RE = re.compile(r"(?i)(bearer\s+|x-terminal-key[\"']?\s*[:=]\s*[\"']?)[^\s\"',}]+")


def new_key(prefix: str) -> str:
    return prefix + secrets.token_urlsafe(32)


def hash_key(key: str) -> str:
    # keys are 256-bit random tokens, so a plain SHA-256 is not brute-forceable;
    # the DB only ever stores this digest.
    return hashlib.sha256(key.encode("utf-8")).hexdigest()


def key_prefix(key: str) -> str:
    return key[:10] + "…"


def redact(text: str) -> str:
    text = _TOKEN_RE.sub("fa_***", text)
    return _BEARER_RE.sub(lambda m: m.group(1) + "***", text)


class RedactingFilter(logging.Filter):
    """Last line of defence: scrubs anything that looks like a key from every log record."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            msg = record.getMessage()
        except Exception:
            return True
        clean = redact(msg)
        if clean != msg:
            record.msg, record.args = clean, ()
        return True


class RateLimiter:
    def __init__(self, per_min: int):
        self.per_min = max(1, per_min)
        self._lock = threading.Lock()
        self._hits: dict[str, list[float]] = {}

    def allow(self, bucket: str) -> bool:
        now = time.monotonic()
        with self._lock:
            arr = [t for t in self._hits.get(bucket, []) if now - t < 60.0]
            if len(arr) >= self.per_min:
                self._hits[bucket] = arr
                return False
            arr.append(now)
            self._hits[bucket] = arr
            return True
