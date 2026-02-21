from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Mapping
import csv


@dataclass(frozen=True)
class CoinbaseTick:
    ts: datetime
    product_id: str
    price: float
    size: float | None


@dataclass(frozen=True)
class OhlcCandle:
    start_ts: datetime
    end_ts: datetime
    product_id: str
    open: float
    high: float
    low: float
    close: float
    volume: float


class CandleAggregator:
    def __init__(self, interval_seconds: int = 5) -> None:
        if interval_seconds <= 0:
            raise ValueError("interval_seconds must be positive")
        self._interval_seconds = interval_seconds
        self._current_bucket: int | None = None
        self._current_product: str | None = None
        self._open: float | None = None
        self._high: float | None = None
        self._low: float | None = None
        self._close: float | None = None
        self._volume: float = 0.0

    def update(self, tick: CoinbaseTick) -> OhlcCandle | None:
        bucket = int(tick.ts.timestamp()) // self._interval_seconds
        if self._current_bucket is None:
            self._start_new(bucket=bucket, tick=tick)
            return None

        if bucket == self._current_bucket and tick.product_id == self._current_product:
            self._high = max(self._high if self._high is not None else tick.price, tick.price)
            self._low = min(self._low if self._low is not None else tick.price, tick.price)
            self._close = tick.price
            self._volume += tick.size or 0.0
            return None

        closed = self._finalize_current()
        self._start_new(bucket=bucket, tick=tick)
        return closed

    def flush(self) -> OhlcCandle | None:
        if self._current_bucket is None:
            return None
        closed = self._finalize_current()
        self._current_bucket = None
        self._current_product = None
        self._open = None
        self._high = None
        self._low = None
        self._close = None
        self._volume = 0.0
        return closed

    def _start_new(self, bucket: int, tick: CoinbaseTick) -> None:
        self._current_bucket = bucket
        self._current_product = tick.product_id
        self._open = tick.price
        self._high = tick.price
        self._low = tick.price
        self._close = tick.price
        self._volume = tick.size or 0.0

    def _finalize_current(self) -> OhlcCandle:
        assert self._current_bucket is not None
        assert self._current_product is not None
        assert self._open is not None
        assert self._high is not None
        assert self._low is not None
        assert self._close is not None

        start_epoch = self._current_bucket * self._interval_seconds
        end_epoch = start_epoch + self._interval_seconds
        return OhlcCandle(
            start_ts=datetime.fromtimestamp(start_epoch, tz=UTC),
            end_ts=datetime.fromtimestamp(end_epoch, tz=UTC),
            product_id=self._current_product,
            open=self._open,
            high=self._high,
            low=self._low,
            close=self._close,
            volume=self._volume,
        )


def parse_coinbase_ticker_message(payload: Mapping[str, object]) -> list[CoinbaseTick]:
    events_obj = payload.get("events")
    if not isinstance(events_obj, list):
        return []

    ticks: list[CoinbaseTick] = []
    for event in events_obj:
        if not isinstance(event, Mapping):
            continue
        tickers_obj = event.get("tickers")
        if not isinstance(tickers_obj, list):
            continue
        for ticker in tickers_obj:
            if not isinstance(ticker, Mapping):
                continue
            parsed = _parse_ticker_row(ticker)
            if parsed is not None:
                ticks.append(parsed)
    return ticks


def parse_coinbase_market_trades_message(payload: Mapping[str, object]) -> list[CoinbaseTick]:
    events_obj = payload.get("events")
    if not isinstance(events_obj, list):
        return []

    ticks: list[CoinbaseTick] = []
    for event in events_obj:
        if not isinstance(event, Mapping):
            continue
        trades_obj = event.get("trades")
        if not isinstance(trades_obj, list):
            continue
        for trade in trades_obj:
            if not isinstance(trade, Mapping):
                continue
            parsed = _parse_trade_row(trade)
            if parsed is not None:
                ticks.append(parsed)
    return ticks


def parse_coinbase_market_message(payload: Mapping[str, object]) -> list[CoinbaseTick]:
    # Prefer market_trades parsing first; fallback to ticker for compatibility.
    ticks = parse_coinbase_market_trades_message(payload)
    if ticks:
        return ticks
    return parse_coinbase_ticker_message(payload)


def _parse_trade_row(trade: Mapping[str, object]) -> CoinbaseTick | None:
    product = trade.get("product_id")
    price_obj = trade.get("price")
    size_obj = trade.get("size")
    if not isinstance(product, str):
        return None

    parsed_price: float | None = None
    if isinstance(price_obj, str):
        parsed_price = _safe_float(price_obj)
    elif isinstance(price_obj, (float, int)):
        parsed_price = float(price_obj)
    if parsed_price is None:
        return None

    parsed_size: float | None = None
    if isinstance(size_obj, str):
        parsed_size = _safe_float(size_obj)
    elif isinstance(size_obj, (float, int)):
        parsed_size = float(size_obj)

    ts_obj = trade.get("time")
    ts = _parse_ts(ts_obj) if isinstance(ts_obj, str) else datetime.now(UTC)

    return CoinbaseTick(ts=ts, product_id=product, price=parsed_price, size=parsed_size)


def _parse_ticker_row(ticker: Mapping[str, object]) -> CoinbaseTick | None:
    product = ticker.get("product_id")
    price = ticker.get("price")
    if not isinstance(product, str) or not isinstance(price, str):
        return None

    parsed_price = _safe_float(price)
    if parsed_price is None:
        return None

    size_obj = ticker.get("last_size")
    parsed_size: float | None = None
    if isinstance(size_obj, str):
        parsed_size = _safe_float(size_obj)

    ts_obj = ticker.get("time")
    ts = _parse_ts(ts_obj) if isinstance(ts_obj, str) else datetime.now(UTC)

    return CoinbaseTick(ts=ts, product_id=product, price=parsed_price, size=parsed_size)


def _safe_float(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None


def _parse_ts(value: str) -> datetime:
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        return datetime.now(UTC)


class CsvTickWriter:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, tick: CoinbaseTick) -> None:
        write_header = not self._path.exists() or self._path.stat().st_size == 0
        with self._path.open("a", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            if write_header:
                writer.writerow(["ts", "product_id", "price", "size"])
            writer.writerow([
                tick.ts.isoformat(),
                tick.product_id,
                f"{tick.price:.8f}",
                "" if tick.size is None else f"{tick.size:.8f}",
            ])


class CsvCandleWriter:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, candle: OhlcCandle) -> None:
        write_header = not self._path.exists() or self._path.stat().st_size == 0
        with self._path.open("a", newline="", encoding="utf-8") as f:
            writer = csv.writer(f)
            if write_header:
                writer.writerow([
                    "start_ts",
                    "end_ts",
                    "product_id",
                    "open",
                    "high",
                    "low",
                    "close",
                    "volume",
                ])
            writer.writerow([
                candle.start_ts.isoformat(),
                candle.end_ts.isoformat(),
                candle.product_id,
                f"{candle.open:.8f}",
                f"{candle.high:.8f}",
                f"{candle.low:.8f}",
                f"{candle.close:.8f}",
                f"{candle.volume:.8f}",
            ])
