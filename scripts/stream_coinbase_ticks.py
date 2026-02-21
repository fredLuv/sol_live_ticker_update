from __future__ import annotations

import argparse
import asyncio
import json
import logging
from datetime import UTC, datetime
from pathlib import Path

from sol_live_update import (
    CandleAggregator,
    CsvCandleWriter,
    parse_coinbase_market_message,
)

try:
    import websockets
except ImportError as exc:  # pragma: no cover - runtime dependency boundary
    raise SystemExit("Install dependency first: pip install websockets") from exc


COINBASE_WS_URL = "wss://advanced-trade-ws.coinbase.com"


def _subscribe_message(product_id: str, channel: str) -> str:
    return json.dumps(
        {
            "type": "subscribe",
            "product_ids": [product_id],
            "channel": channel,
        }
    )


async def stream_ticks(
    product_id: str,
    channel: str,
    candle_path: Path,
    interval_seconds: int,
    ping_interval: int,
) -> None:
    candle_writer = CsvCandleWriter(candle_path)
    agg = CandleAggregator(interval_seconds=interval_seconds)

    backoff = 1.0
    while True:
        try:
            logging.info("connecting to %s", COINBASE_WS_URL)
            async with websockets.connect(COINBASE_WS_URL, ping_interval=ping_interval) as ws:
                await ws.send(_subscribe_message(product_id, channel=channel))
                logging.info("subscribed to %s channel=%s", product_id, channel)
                backoff = 1.0

                while True:
                    message = await ws.recv()
                    payload = json.loads(message)
                    ticks = parse_coinbase_market_message(payload)

                    for tick in ticks:
                        if tick.product_id != product_id:
                            continue
                        closed = agg.update(tick)
                        if closed is not None:
                            candle_writer.append(closed)
                        print(
                            f"{datetime.now(UTC).isoformat()} tick={tick.product_id} "
                            f"price={tick.price:.4f} size={tick.size}"
                        )

        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - network boundary
            logging.warning("stream error: %s", exc)
            logging.info("reconnecting in %.1f seconds", backoff)
            await asyncio.sleep(backoff)
            backoff = min(30.0, backoff * 1.8)


def main() -> None:
    parser = argparse.ArgumentParser(description="Stream Coinbase market data and persist candles")
    parser.add_argument("--product", default="SOL-USD", help="Coinbase product id (default: SOL-USD)")
    parser.add_argument(
        "--channel",
        default="market_trades",
        choices=["market_trades", "ticker"],
        help="WebSocket channel for price updates (default: market_trades)",
    )
    parser.add_argument(
        "--candle-output",
        default="outputs/coinbase_candles_solusd_5s.csv",
        help="Output CSV for aggregated candles",
    )
    parser.add_argument("--candle-seconds", type=int, default=5, help="Candle interval in seconds")
    parser.add_argument("--ping-interval", type=int, default=20, help="WebSocket ping interval")
    parser.add_argument("--log-level", default="INFO", help="Logging level")
    args = parser.parse_args()

    logging.basicConfig(level=getattr(logging, args.log_level.upper(), logging.INFO))

    asyncio.run(
        stream_ticks(
            product_id=args.product,
            channel=args.channel,
            candle_path=Path(args.candle_output),
            interval_seconds=args.candle_seconds,
            ping_interval=args.ping_interval,
        )
    )


if __name__ == "__main__":
    main()
