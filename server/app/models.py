"""Request schemas (Pydantic v2). Anything that fails here is refused with HTTP 422 and a reason."""
from __future__ import annotations

import math
import re
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

TIMEFRAMES = {"1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"}
_SYM_RE = re.compile(r"^[A-Z0-9._\-]{1,32}$")
_CID_RE = re.compile(r"^[A-Za-z0-9_.:\-]{1,100}$")


def _finite_pos(v: float, name: str) -> float:
    if v is None or not math.isfinite(v) or v <= 0:
        raise ValueError(f"{name} must be a finite positive number")
    return v


class Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class SignalIn(Strict):
    client_signal_id: str = Field(..., description="Deterministic id from the web app; resubmitting it is a no-op")
    symbol: str
    direction: Literal["buy", "sell", "long", "short"]
    order_type: Literal["market", "limit"] = "market"
    entry: float
    sl: float
    tp: float
    tp2: Optional[float] = None
    tp3: Optional[float] = None
    timeframe: str
    generated_at: int = Field(..., description="Unix seconds when the web app produced the signal")
    valid_for_sec: Optional[int] = Field(None, ge=60, le=86400)
    confluence: Optional[int] = Field(None, ge=0, le=100)
    signal_type: Optional[str] = Field(None, max_length=20)
    note: str = Field("", max_length=500)
    account_ids: Optional[list[str]] = Field(None, max_length=50)

    @field_validator("client_signal_id")
    @classmethod
    def _cid(cls, v: str) -> str:
        if not _CID_RE.match(v):
            raise ValueError("client_signal_id may only contain letters, digits and _ . : -")
        return v

    @field_validator("symbol")
    @classmethod
    def _sym(cls, v: str) -> str:
        v = v.upper().replace("/", "")
        if not _SYM_RE.match(v):
            raise ValueError("invalid symbol")
        return v

    @field_validator("timeframe")
    @classmethod
    def _tf(cls, v: str) -> str:
        v = v.lower()
        if v not in TIMEFRAMES:
            raise ValueError(f"timeframe must be one of {sorted(TIMEFRAMES)}")
        return v

    @model_validator(mode="after")
    def _levels(self):
        self.direction = {"long": "buy", "short": "sell"}.get(self.direction, self.direction)
        e = _finite_pos(self.entry, "entry")
        s = _finite_pos(self.sl, "sl")
        t = _finite_pos(self.tp, "tp")
        for name in ("tp2", "tp3"):
            if getattr(self, name) is not None:
                _finite_pos(getattr(self, name), name)
        if self.direction == "buy" and not (s < e < t):
            raise ValueError("for a buy signal: sl < entry < tp is required")
        if self.direction == "sell" and not (s > e > t):
            raise ValueError("for a sell signal: sl > entry > tp is required")
        sgn = 1 if self.direction == "buy" else -1
        for name in ("tp2", "tp3"):
            v = getattr(self, name)
            if v is not None and sgn * (v - e) <= 0:
                raise ValueError(f"{name} is on the wrong side of entry")
        return self


class AccountSettings(Strict):
    name: Optional[str] = Field(None, min_length=1, max_length=60)
    enabled: Optional[bool] = None
    mode: Optional[Literal["notify", "confirm", "auto"]] = None
    risk_percent: Optional[float] = Field(None, gt=0, le=5)
    fixed_lot: Optional[float] = Field(None, ge=0, le=100)
    max_lot: Optional[float] = Field(None, gt=0, le=100)
    max_spread_points: Optional[int] = Field(None, ge=0, le=100000)
    max_spread_sl_ratio: Optional[float] = Field(None, ge=0, le=1)
    max_entry_dev_sl_ratio: Optional[float] = Field(None, ge=0, le=1)
    max_open_positions: Optional[int] = Field(None, ge=1, le=50)
    max_daily_loss_percent: Optional[float] = Field(None, ge=0, le=50)
    tp_index: Optional[int] = Field(None, ge=1, le=3)
    symbol_suffix: Optional[str] = Field(None, max_length=12)
    symbol_map: Optional[dict[str, str]] = None
    allowed_symbols: Optional[list[str]] = Field(None, max_length=200)

    @field_validator("symbol_map")
    @classmethod
    def _map(cls, v):
        if v is None:
            return v
        if len(v) > 200:
            raise ValueError("symbol_map too large")
        out = {}
        for k, b in v.items():
            k2, b2 = k.strip().upper().replace("/", ""), b.strip()
            if not _SYM_RE.match(k2) or not re.match(r"^[A-Za-z0-9._#\-+!]{1,32}$", b2):
                raise ValueError(f"invalid symbol_map entry {k!r}")
            out[k2] = b2
        return out

    @field_validator("allowed_symbols")
    @classmethod
    def _allowed(cls, v):
        if v is None:
            return v
        out = [s.strip().upper().replace("/", "") for s in v if s.strip()]
        for s in out:
            if not _SYM_RE.match(s):
                raise ValueError(f"invalid symbol {s!r}")
        return out


class AccountCreate(AccountSettings):
    name: str = Field(..., min_length=1, max_length=60)


class LiveToggle(Strict):
    enable: bool
    confirm: str = ""


class Heartbeat(Strict):
    login: str = Field(..., min_length=1, max_length=32)
    server: str = Field("", max_length=80)
    company: str = Field("", max_length=120)
    trade_mode: Literal["demo", "real", "contest", "unknown"] = "unknown"
    currency: str = Field("", max_length=10)
    balance: Optional[float] = None
    equity: Optional[float] = None
    trade_allowed: bool = False
    ea_allow_real: bool = False
    ea_version: str = Field("", max_length=20)


EA_REPORT_STATES = Literal["sending", "displayed", "rejected", "filled", "placed", "failed", "unknown", "not_found"]


class ExecReport(Strict):
    report_id: str = Field(..., min_length=4, max_length=64)
    state: EA_REPORT_STATES
    reason: str = Field("", max_length=300)
    broker_symbol: Optional[str] = Field(None, max_length=32)
    requested_price: Optional[float] = None
    fill_price: Optional[float] = None
    volume: Optional[float] = None
    sl: Optional[float] = None
    tp: Optional[float] = None
    ticket: Optional[str] = Field(None, max_length=32)
    retcode: Optional[int] = None


class CloseReport(Strict):
    report_id: str = Field(..., min_length=4, max_length=64)
    close_price: Optional[float] = None
    profit: Optional[float] = None
    closed_at: Optional[int] = None
    close_reason: str = Field("", max_length=40)


class Decision(Strict):
    reason: str = Field("", max_length=300)
