"""Streaming indicators. Each `update()` consumes exactly one CLOSED value and returns the latest
reading (None until warm). State only ever moves forward, so no lookahead is possible by
construction; tests/test_lookahead.py proves it. Seeding follows TA-Lib conventions."""

from __future__ import annotations

import math
from bisect import bisect_right, insort
from collections import deque


class EMA:
    def __init__(self, n: int) -> None:
        self.n, self.alpha = n, 2.0 / (n + 1)
        self._seed: list[float] = []
        self.value: float | None = None

    def update(self, x: float) -> float | None:
        if self.value is None:
            self._seed.append(x)
            if len(self._seed) == self.n:
                self.value = sum(self._seed) / self.n
            return self.value
        self.value += self.alpha * (x - self.value)
        return self.value


class Wilder:
    """Wilder smoothing (RMA) seeded with the SMA of the first n values."""

    def __init__(self, n: int) -> None:
        self.n = n
        self._seed: list[float] = []
        self.value: float | None = None

    def update(self, x: float) -> float | None:
        if self.value is None:
            self._seed.append(x)
            if len(self._seed) == self.n:
                self.value = sum(self._seed) / self.n
            return self.value
        self.value = (self.value * (self.n - 1) + x) / self.n
        return self.value


class RSI:
    def __init__(self, n: int) -> None:
        self._gain, self._loss = Wilder(n), Wilder(n)
        self._prev: float | None = None
        self.value: float | None = None

    def update(self, x: float) -> float | None:
        if self._prev is not None:
            d = x - self._prev
            g, loss = self._gain.update(max(d, 0.0)), self._loss.update(max(-d, 0.0))
            if g is not None and loss is not None:
                self.value = 100.0 if loss == 0 else 100.0 - 100.0 / (1.0 + g / loss)
        self._prev = x
        return self.value


class ATR:
    def __init__(self, n: int) -> None:
        self._rma = Wilder(n)
        self._prev_close: float | None = None
        self.value: float | None = None

    def update(self, high: float, low: float, close: float) -> float | None:
        if self._prev_close is not None:
            tr = max(high - low, abs(high - self._prev_close), abs(low - self._prev_close))
            self.value = self._rma.update(tr)
        self._prev_close = close
        return self.value


class ADX:
    def __init__(self, n: int = 14) -> None:
        self.n = n
        self._prev: tuple[float, float, float] | None = None
        self._sums: list[float] | None = None  # smoothed [+DM, -DM, TR]
        self._seed: list[tuple[float, float, float]] = []
        self._adx = Wilder(n)
        self.plus_di = self.minus_di = 0.0
        self.value: float | None = None

    def update(self, high: float, low: float, close: float) -> float | None:
        if self._prev is None:
            self._prev = (high, low, close)
            return None
        ph, pl, pc = self._prev
        self._prev = (high, low, close)
        up, down = high - ph, pl - low
        pdm = up if up > down and up > 0 else 0.0
        mdm = down if down > up and down > 0 else 0.0
        tr = max(high - low, abs(high - pc), abs(low - pc))
        if self._sums is None:
            self._seed.append((pdm, mdm, tr))
            if len(self._seed) < self.n:
                return None
            self._sums = [sum(v[i] for v in self._seed) for i in range(3)]
        else:
            s = self._sums
            for i, x in enumerate((pdm, mdm, tr)):
                s[i] = s[i] - s[i] / self.n + x
        sp, sm, st = self._sums
        if st <= 0:
            return self.value
        self.plus_di, self.minus_di = 100 * sp / st, 100 * sm / st
        tot = self.plus_di + self.minus_di
        dx = 0.0 if tot == 0 else 100 * abs(self.plus_di - self.minus_di) / tot
        self.value = self._adx.update(dx)
        return self.value


class Rolling:
    """Fixed window of the last n values."""

    def __init__(self, n: int) -> None:
        self.n = n
        self.q: deque[float] = deque(maxlen=n)

    def update(self, x: float) -> None:
        self.q.append(x)

    @property
    def full(self) -> bool:
        return len(self.q) == self.n

    def mean(self) -> float:
        return sum(self.q) / len(self.q)

    def std(self) -> float:  # population std, as TA-Lib BBANDS
        m = self.mean()
        return math.sqrt(max(0.0, sum((v - m) ** 2 for v in self.q) / len(self.q)))


class Bollinger:
    def __init__(self, n: int = 20, k: float = 2.0) -> None:
        self._w, self.k = Rolling(n), k
        self.mid = self.upper = self.lower = self.bandwidth = None  # type: float | None

    def update(self, x: float) -> float | None:
        self._w.update(x)
        if self._w.full:
            m, sd = self._w.mean(), self._w.std()
            self.mid, self.upper, self.lower = m, m + self.k * sd, m - self.k * sd
            self.bandwidth = (self.upper - self.lower) / m if m else 0.0
        return self.bandwidth


class MACD:
    def __init__(self, fast: int = 12, slow: int = 26, signal: int = 9) -> None:
        self._f, self._s, self._sig = EMA(fast), EMA(slow), EMA(signal)
        self.hist: float | None = None
        self.prev_hist: float | None = None

    def update(self, x: float) -> float | None:
        f, s = self._f.update(x), self._s.update(x)
        if f is None or s is None:
            return None
        sig = self._sig.update(f - s)
        if sig is not None:
            self.prev_hist, self.hist = self.hist, (f - s) - sig
        return self.hist

    @property
    def slope(self) -> float | None:
        return None if self.hist is None or self.prev_hist is None else self.hist - self.prev_hist


class StochRSI:
    def __init__(self, rsi_n: int = 14, stoch_n: int = 14, k: int = 3) -> None:
        self._rsi, self._w, self._k = RSI(rsi_n), Rolling(stoch_n), Rolling(k)
        self.value: float | None = None

    def update(self, x: float) -> float | None:
        r = self._rsi.update(x)
        if r is None:
            return None
        self._w.update(r)
        if not self._w.full:
            return None
        lo, hi = min(self._w.q), max(self._w.q)
        self._k.update(0.5 if hi == lo else (r - lo) / (hi - lo))
        self.value = self._k.mean() if self._k.full else None
        return self.value


class RollingPercentile:
    """Percentile rank (0..1) of the newest value inside the last n values."""

    def __init__(self, n: int) -> None:
        self.q: deque[float] = deque()
        self._sorted: list[float] = []
        self.n = n

    def update(self, x: float) -> float:
        self.q.append(x)
        insort(self._sorted, x)
        if len(self.q) > self.n:
            old = self.q.popleft()
            del self._sorted[bisect_right(self._sorted, old) - 1]
        return bisect_right(self._sorted, x) / len(self._sorted)

    def __len__(self) -> int:
        return len(self.q)


def corr_beta(xs: list[float], ys: list[float]) -> tuple[float, float]:
    """Pearson correlation and beta of ys on xs."""
    n = len(xs)
    if n < 3:
        return 0.0, 0.0
    mx, my = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    syy = sum((y - my) ** 2 for y in ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys, strict=True))
    if sxx <= 0 or syy <= 0:
        return 0.0, 0.0
    return sxy / math.sqrt(sxx * syy), sxy / sxx
