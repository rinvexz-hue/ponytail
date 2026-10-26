"""Domain models. Prices/qty/fees/PnL are Decimal; timestamps are int ms since epoch UTC
(unambiguous, DST-free). Indicator features are floats: they never touch money."""

from __future__ import annotations

from dataclasses import dataclass, field
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal
from enum import StrEnum
from typing import Any

MINUTE_MS = 60_000
D0 = Decimal(0)
D1 = Decimal(1)


# ---- money helpers ---------------------------------------------------------------------
def floor_to(x: Decimal, step: Decimal) -> Decimal:
    return (x / step).to_integral_value(ROUND_FLOOR) * step


def ceil_to(x: Decimal, step: Decimal) -> Decimal:
    return (x / step).to_integral_value(ROUND_CEILING) * step


def bps(x: Decimal) -> Decimal:
    return x / Decimal(10_000)


# ---- enums -----------------------------------------------------------------------------
class Direction(StrEnum):
    LONG = "long"
    SHORT = "short"

    @property
    def sign(self) -> int:
        return 1 if self is Direction.LONG else -1

    @property
    def entry_side(self) -> Side:
        return Side.BUY if self is Direction.LONG else Side.SELL

    @property
    def exit_side(self) -> Side:
        return Side.SELL if self is Direction.LONG else Side.BUY


class Side(StrEnum):
    BUY = "buy"
    SELL = "sell"


class OrderType(StrEnum):
    LIMIT_MAKER = "limit_maker"  # post-only entry
    LIMIT = "limit"  # reduce-only take-profit
    STOP_MARKET = "stop_market"  # reduce-only protective stop
    MARKET = "market"  # only: stops, kill-switch flatten, time stops


class OrderStatus(StrEnum):
    NEW = "new"
    ACKED = "acked"
    PARTIAL = "partial"
    FILLED = "filled"
    CANCELED = "canceled"
    REJECTED = "rejected"


TERMINAL = {OrderStatus.FILLED, OrderStatus.CANCELED, OrderStatus.REJECTED}
_ALLOWED: dict[OrderStatus, set[OrderStatus]] = {
    OrderStatus.NEW: {OrderStatus.ACKED, OrderStatus.REJECTED, OrderStatus.PARTIAL, OrderStatus.FILLED,
                      OrderStatus.CANCELED},
    OrderStatus.ACKED: {OrderStatus.PARTIAL, OrderStatus.FILLED, OrderStatus.CANCELED},
    OrderStatus.PARTIAL: {OrderStatus.PARTIAL, OrderStatus.FILLED, OrderStatus.CANCELED},
    # fill-after-cancel race: a fill may be reported after we saw CANCELED
    OrderStatus.CANCELED: {OrderStatus.PARTIAL, OrderStatus.FILLED},
    OrderStatus.FILLED: set(),
    OrderStatus.REJECTED: set(),
}


class Regime(StrEnum):
    WARMUP = "WARMUP"
    TREND_UP = "TREND_UP"
    TREND_DOWN = "TREND_DOWN"
    RANGE = "RANGE"
    SQUEEZE = "SQUEEZE"
    CHAOS = "CHAOS"
    NEUTRAL = "NEUTRAL"


# ---- market data -----------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class Bar:
    symbol: str
    open_ts: int  # inclusive, ms UTC
    interval_ms: int
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    taker_buy_volume: Decimal

    @property
    def close_ts(self) -> int:  # exclusive end; the bar is only usable at/after this instant
        return self.open_ts + self.interval_ms


@dataclass(frozen=True, slots=True)
class Book:
    """Top-of-book summary computed by the Scout from an L2 snapshot."""

    ts: int
    bid: Decimal
    ask: Decimal
    imbalance5: float
    imbalance10: float
    depth10_bid_usd: Decimal
    depth10_ask_usd: Decimal
    bids: tuple[tuple[Decimal, Decimal], ...] = ()
    asks: tuple[tuple[Decimal, Decimal], ...] = ()

    @property
    def spread_bps(self) -> Decimal:
        mid = (self.bid + self.ask) / 2
        return (self.ask - self.bid) / mid * 10_000

    @property
    def microprice(self) -> Decimal:
        if not self.bids or not self.asks:
            return (self.bid + self.ask) / 2
        bq, aq = self.bids[0][1], self.asks[0][1]
        return (self.ask * bq + self.bid * aq) / (bq + aq)


# ---- signals ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class Candidate:
    """A setup that fired. Becomes an Intent only if every gate passes."""

    symbol: str
    setup: str
    direction: Direction
    ts: int
    entry: Decimal
    stop: Decimal
    tp1: Decimal
    tp2: Decimal | None  # hard final target (mean-reversion); None = ATR-trailed runner
    atr: Decimal
    htf_exempt: bool = False
    full_exit: bool = False  # whole position exits at tp1 (mean-reversion target inside 1R)


@dataclass(frozen=True, slots=True)
class Intent:
    candidate: Candidate
    score: float
    expected_net_r: Decimal
    cost_r: Decimal
    components: dict[str, float]


@dataclass(frozen=True, slots=True)
class Rejection:
    symbol: str
    setup: str
    direction: Direction
    ts: int
    gate: str
    detail: str
    score: float | None = None


# ---- orders ----------------------------------------------------------------------------
@dataclass(slots=True)
class Order:
    client_id: str
    symbol: str
    side: Side
    type: OrderType
    qty: Decimal
    price: Decimal | None = None  # limit price
    stop_price: Decimal | None = None
    reduce_only: bool = False
    status: OrderStatus = OrderStatus.NEW
    filled: Decimal = D0
    avg_price: Decimal = D0
    fee: Decimal = D0
    created_ts: int = 0
    purpose: str = ""  # entry | stop | tp1 | exit

    def transition(self, new: OrderStatus) -> None:
        if new == self.status and new is OrderStatus.PARTIAL:
            return
        if new not in _ALLOWED[self.status]:
            raise InconsistencyError(f"illegal order transition {self.client_id}: {self.status} -> {new}")
        self.status = new

    @property
    def remaining(self) -> Decimal:
        return self.qty - self.filled

    @property
    def open(self) -> bool:
        return self.status not in TERMINAL


@dataclass(frozen=True, slots=True)
class OrderUpdate:
    """What an adapter reports. `exec_id` makes fill processing idempotent."""

    client_id: str
    status: OrderStatus
    ts: int
    exec_id: str = ""
    fill_qty: Decimal = D0
    fill_price: Decimal = D0
    fee: Decimal = D0
    reason: str = ""


@dataclass(slots=True)
class Position:
    symbol: str
    direction: Direction
    setup: str
    qty: Decimal  # currently open
    entry: Decimal  # avg entry
    stop: Decimal  # current protective stop
    initial_stop: Decimal
    tp1: Decimal
    tp2: Decimal | None
    atr: Decimal
    opened_ts: int
    initial_qty: Decimal = D0
    full_exit: bool = False
    tp_qty: Decimal = D0  # pending synthetic TP1 size (venues without reduce-only)
    tp1_done: bool = False
    extreme: Decimal = D0  # best price since entry (for trail / MFE)
    realized: Decimal = D0  # pnl net of all fees
    fees: Decimal = D0
    exit_reason: str = ""

    @property
    def risk_per_unit(self) -> Decimal:
        return abs(self.entry - self.initial_stop)

    def r_multiple(self, price: Decimal) -> Decimal:
        if self.risk_per_unit == 0:
            return D0
        return (price - self.entry) * self.direction.sign / self.risk_per_unit

    def open_risk(self) -> Decimal:
        """Money lost if the current stop fills (0 once stop is at/through breakeven)."""
        return max(D0, (self.entry - self.stop) * self.direction.sign) * self.qty


@dataclass(frozen=True, slots=True)
class ClosedTrade:
    symbol: str
    setup: str
    direction: Direction
    opened_ts: int
    closed_ts: int
    entry: Decimal
    qty: Decimal
    pnl: Decimal  # net of fees
    fees: Decimal
    r: Decimal
    exit_reason: str
    equity_before: Decimal


class InconsistencyError(RuntimeError):
    """Anything that should never happen. The desk answers with flatten + halt + alert."""


@dataclass(frozen=True, slots=True)
class DeskEvent:
    kind: str  # market | signal | intent | rejection | order | fill | risk | alert | trade
    ts: int
    symbol: str = ""
    data: dict[str, Any] = field(default_factory=dict)
