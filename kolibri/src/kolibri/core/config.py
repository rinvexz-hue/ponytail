"""Frozen, validated configuration. The only place risk/gate/strategy numbers live."""

from __future__ import annotations

import hashlib
import json
import os
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, model_validator

ROOT = Path(__file__).resolve().parents[3]
CONFIG_DIR = Path(os.environ.get("KOLIBRI_CONFIG_DIR", ROOT / "config"))


class _Frozen(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")


class RiskCfg(_Frozen):
    risk_per_trade_pct: Decimal
    max_positions: int = Field(ge=1)
    heat_cap_pct: Decimal
    max_same_direction: int = Field(ge=1)
    corr_threshold: float
    corr_heat_multiplier: Decimal
    max_net_exposure: Decimal
    daily_loss_pct: Decimal
    weekly_loss_pct: Decimal
    max_drawdown_pct: Decimal
    max_trades_per_day: int
    stopout_cooldown_s: int
    loss_streak: int
    loss_streak_cooldown_s: int

    @model_validator(mode="after")
    def _consistent(self) -> RiskCfg:
        r, heat = self.risk_per_trade_pct, self.heat_cap_pct
        if not (Decimal(0) < r <= Decimal("1")):
            raise ValueError("risk_per_trade_pct must be in (0, 1]")
        if not (r <= heat <= r * self.max_positions):
            raise ValueError(f"heat_cap_pct {heat} must be within [{r}, {r * self.max_positions}]")
        if not (self.daily_loss_pct < self.weekly_loss_pct < self.max_drawdown_pct):
            raise ValueError("loss limits must satisfy daily < weekly < max_drawdown")
        if self.max_same_direction > self.max_positions:
            raise ValueError("max_same_direction > max_positions is a dead limit")
        return self


class TimeframesCfg(_Frozen):
    signal_minutes: int = Field(gt=0)
    context_minutes: int = Field(gt=0)

    @model_validator(mode="after")
    def _nested(self) -> TimeframesCfg:
        if self.context_minutes % self.signal_minutes or 1440 % self.context_minutes:
            raise ValueError("context must be a multiple of signal and divide the UTC day")
        return self


class KillCfg(_Frozen):
    stale_data_s: float
    ws_gap_recover_s: float
    max_consecutive_rejects: int
    max_clock_drift_ms: int
    api_error_rate: float


class GatesCfg(_Frozen):
    max_spread_bps: Decimal
    max_slip_bps: Decimal
    cost_multiple: Decimal
    min_net_r: Decimal
    max_tick_age_s: float
    max_clock_drift_ms: int
    score_threshold: float = Field(ge=0, le=100)
    event_blackout_min: int
    funding_blackout_min: int
    funding_blackout_enabled: bool
    sessions_allowed: tuple[Literal["asia", "london", "ny", "off"], ...]
    signal_dedup_bars: int
    min_room_r: Decimal
    btc_block_atr: float
    weights: dict[str, float]
    win_prob_prior: Decimal
    win_prob_by_setup: dict[str, Decimal] = Field(default_factory=dict)  # calibrated by `kolibri optimize`
    win_prob_per_score_pt: Decimal

    @model_validator(mode="after")
    def _weights(self) -> GatesCfg:
        need = {"trend", "momentum", "volume", "cvd", "book", "cross", "deriv"}
        if set(self.weights) != need or sum(self.weights.values()) <= 0:
            raise ValueError(f"weights must define exactly {sorted(need)} with a positive sum")
        return self


class RegimeCfg(_Frozen):
    adx_trend: float
    adx_range: float
    squeeze_pct: float
    chaos_rv_pct: float
    min_depth_usd: Decimal
    squeeze_memory_bars: int


class StrategyCfg(_Frozen):
    stop_atr_min: Decimal
    stop_atr_max: Decimal
    structure_buffer_atr: Decimal
    runner_expected_r: Decimal
    trail_atr: Decimal
    trail_step_atr: Decimal
    time_stop_s: int
    time_stop_min_r: Decimal
    tp1_fraction: Decimal
    rsi_reset_low: float
    rsi_reset_high: float
    rsi_extreme: float
    breakout_volz: float
    sweep_volz: float

    @model_validator(mode="after")
    def _stops(self) -> StrategyCfg:
        if not (0 < self.stop_atr_min < self.stop_atr_max):
            raise ValueError("need 0 < stop_atr_min < stop_atr_max")
        if not (0 < self.tp1_fraction <= 1):
            raise ValueError("tp1_fraction must be in (0, 1]")
        return self


class ExecutionCfg(_Frozen):
    canary_notional: Decimal = Decimal(25)  # max order value (quote) while graduation only allows "canary"
    latency_ms: int
    entry_timeout_s: float
    max_chase_atr: Decimal
    reconcile_s: float
    order_rate_per_min: int
    flatten_on_shutdown: bool
    bar_grace_ms: int


class AlertsCfg(_Frozen):
    heartbeat_min: int
    max_per_min: int
    critical_repeat_s: int
    send_rejected_high_score: bool
    rejected_score_alert: float


class DashboardCfg(_Frozen):
    host: str
    port: int


class GraduationCfg(_Frozen):
    report_path: str
    max_age_days: int
    min_trades: int
    min_profit_factor: Decimal
    min_expectancy_r: Decimal
    max_drawdown_pct: Decimal
    min_sharpe: Decimal
    max_fee_ratio: Decimal
    mc_runs: int
    mc_max_dd_pct: Decimal
    min_paper_days: int
    canary_min_paper_trades: int = 10  # stage 1 (canary): OOS proof + paper is not negative
    paper_min_trades: int = 30  # stage 2 (live): paper must also meet the OOS quality bars
    canary_min_live_trades: int = 10  # stage 2 also needs this many clean canary trades


class VenueCfg(_Frozen):
    supports_short: bool
    supports_reduce_only: bool  # False (spot): resting sells lock balance, so TPs are synthetic
    max_leverage: Decimal
    maker_fee: Decimal
    taker_fee: Decimal
    fee_discount: Decimal

    @property
    def maker(self) -> Decimal:
        return self.maker_fee * (1 - self.fee_discount)

    @property
    def taker(self) -> Decimal:
        return self.taker_fee * (1 - self.fee_discount)


class SymbolCfg(_Frozen):
    base: str
    tick: Decimal
    step: Decimal
    min_notional: Decimal
    min_qty: Decimal = Decimal(0)  # venue minimum order size in base units
    spread_bps: Decimal  # modelled spread for backtest / paper when no book is available
    impact_bps: Decimal  # modelled taker impact per fill


class Event(_Frozen):
    ts: datetime
    name: str


class Config(_Frozen):
    mode: Literal["paper", "live"]
    venue: str
    symbols: tuple[str, ...]
    leader: str
    paper_equity: Decimal
    state_db: str
    data_dir: str
    warmup_days: int
    timeframes: TimeframesCfg
    risk: RiskCfg
    kill: KillCfg
    gates: GatesCfg
    regime: RegimeCfg
    strategy: StrategyCfg
    execution: ExecutionCfg
    tunable: tuple[str, ...]
    alerts: AlertsCfg
    dashboard: DashboardCfg
    graduation: GraduationCfg
    venues: dict[str, VenueCfg]
    symbol_specs: dict[str, SymbolCfg]
    events: tuple[Event, ...] = ()

    @model_validator(mode="after")
    def _cross(self) -> Config:
        if self.leader not in self.symbols:
            raise ValueError("leader must be one of symbols")
        missing = [s for s in self.symbols if s not in self.symbol_specs]
        if missing:
            raise ValueError(f"no symbol spec for {missing}")
        if self.venue not in self.venues:
            raise ValueError(f"unknown venue {self.venue}")
        if len(self.tunable) > 12:
            raise ValueError("more than 12 tunable params invites overfitting")
        for path in self.tunable:
            try:
                get_path(self, path)
            except AttributeError as e:
                raise ValueError(f"unknown tunable param {path}") from e
        return self

    @property
    def state_path(self) -> str:
        """Paper and live keep separate journals (halts, equity anchors, trades)."""
        return self.state_db.format(mode=self.mode)

    @property
    def venue_cfg(self) -> VenueCfg:
        return self.venues[self.venue]

    @property
    def quote(self) -> str:
        return self.leader[len(self.symbol_specs[self.leader].base):]

    def fingerprint(self) -> str:
        """Hash of everything that changes trading behaviour (not mode/paths)."""
        d = self.model_dump(mode="json", exclude={"mode", "state_db", "data_dir", "dashboard", "alerts"})
        return hashlib.sha256(json.dumps(d, sort_keys=True).encode()).hexdigest()[:16]


def get_path(cfg: BaseModel, path: str) -> Any:
    obj: Any = cfg
    for part in path.split("."):
        obj = getattr(obj, part)
    return obj


def with_overrides(cfg: Config, overrides: dict[str, Any]) -> Config:
    """Return a new Config with dotted-path overrides (used by walk-forward / perturbation only)."""
    data = cfg.model_dump()
    for path, value in overrides.items():
        node = data
        *parents, leaf = path.split(".")
        for p in parents:
            node = node[p]
        node[leaf] = value
    return Config.model_validate(data)


def _deep_merge(base: dict[str, Any], over: dict[str, Any]) -> dict[str, Any]:
    for k, v in over.items():
        base[k] = _deep_merge(dict(base[k]), v) if isinstance(v, dict) and isinstance(base.get(k), dict) else v
    return base


def load_config(config_dir: Path = CONFIG_DIR, **overrides: Any) -> Config:
    raw = yaml.safe_load((config_dir / "default.yaml").read_text())
    local = config_dir / "local.yaml"  # your overrides (e.g. written by `kolibri optimize --apply`)
    if local.exists():
        raw = _deep_merge(raw, yaml.safe_load(local.read_text()) or {})
    sym = yaml.safe_load((config_dir / "symbols.yaml").read_text())
    cal_path = config_dir / "events_calendar.yaml"
    events = (yaml.safe_load(cal_path.read_text()) or {}).get("events", []) if cal_path.exists() else []
    raw.update(venues=sym["venues"], symbol_specs=sym["symbols"], events=events)
    if os.environ.get("MODE"):
        raw["mode"] = os.environ["MODE"]
    raw.update(overrides)
    return Config.model_validate(raw)
