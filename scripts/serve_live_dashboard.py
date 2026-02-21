from __future__ import annotations

import argparse
import csv
import json
import re
import threading
import time
from datetime import UTC, datetime
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen

PRODUCT_RE = re.compile(r"^[A-Z0-9-]{3,20}$")


def _read_history_rows(path: Path, limit: int) -> list[dict[str, object]]:
    if not path.exists():
        return []
    rows: list[dict[str, object]] = []
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                rows.append(
                    {
                        "start": row["start_ts"],
                        "open": float(row["open"]),
                        "high": float(row["high"]),
                        "low": float(row["low"]),
                        "close": float(row["close"]),
                        "volume": float(row["volume"]),
                    }
                )
            except (KeyError, TypeError, ValueError):
                continue
    if limit <= 0:
        return rows
    return rows[-limit:]


def _fetch_coinbase_rest_candles(product_id: str, limit: int) -> list[dict[str, object]]:
    # Coinbase Exchange public REST endpoint (up to ~300 buckets, 60s granularity).
    url = (
        f"https://api.exchange.coinbase.com/products/{quote(product_id)}/candles?granularity=60"
    )
    req = Request(
        url,
        headers={
            "User-Agent": "qrt-live-dashboard/1.0",
            "Accept": "application/json",
        },
    )
    with urlopen(req, timeout=8.0) as resp:  # noqa: S310 - intentional trusted outbound request
        payload = json.loads(resp.read().decode("utf-8"))

    if not isinstance(payload, list):
        return []

    rows: list[dict[str, object]] = []
    for item in payload:
        if not isinstance(item, list) or len(item) < 6:
            continue
        try:
            ts = int(item[0])
            low = float(item[1])
            high = float(item[2])
            open_px = float(item[3])
            close = float(item[4])
            volume = float(item[5])
        except (TypeError, ValueError):
            continue

        rows.append(
            {
                "start": datetime.fromtimestamp(ts, tz=UTC).isoformat(),
                "open": open_px,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume,
            }
        )

    rows.sort(key=lambda r: str(r["start"]))
    if limit <= 0:
        return rows
    return rows[-limit:]


def _json_response(handler: SimpleHTTPRequestHandler, payload_obj: dict[str, object]) -> None:
    payload = json.dumps(payload_obj).encode("utf-8")
    handler.send_response(HTTPStatus.OK)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("X-Frame-Options", "DENY")
    handler.send_header("Referrer-Policy", "no-referrer")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def _json_error(handler: SimpleHTTPRequestHandler, status: HTTPStatus, message: str) -> None:
    payload = json.dumps({"error": message}).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


def _parse_int(query: dict[str, list[str]], key: str, default: int, low: int, high: int) -> int:
    raw = query.get(key, [str(default)])[0]
    try:
        value = int(raw)
    except ValueError:
        value = default
    return max(low, min(value, high))


def _build_handler(web_root: Path, history_csv: Path):
    class DashboardHandler(SimpleHTTPRequestHandler):
        _rate_lock = threading.Lock()
        _ip_hits: dict[str, list[float]] = {}
        _bootstrap_cache: dict[tuple[str, int, int], tuple[float, dict[str, object]]] = {}

        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(web_root), **kwargs)

        def end_headers(self) -> None:
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("X-Frame-Options", "DENY")
            self.send_header("Referrer-Policy", "no-referrer")
            self.send_header("Content-Security-Policy", "default-src 'self'; connect-src 'self' wss://advanced-trade-ws.coinbase.com; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'")
            super().end_headers()

        def list_directory(self, path: str):  # type: ignore[override]
            # Avoid exposing directory structure in public deployments.
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return None

        def _is_rate_limited(self) -> bool:
            ip = self.client_address[0] if self.client_address else "unknown"
            now = time.time()
            window = 10.0
            max_hits = 60
            with DashboardHandler._rate_lock:
                hits = DashboardHandler._ip_hits.get(ip, [])
                hits = [t for t in hits if now - t <= window]
                if len(hits) >= max_hits:
                    DashboardHandler._ip_hits[ip] = hits
                    return True
                hits.append(now)
                DashboardHandler._ip_hits[ip] = hits
                return False

        def _sanitize_product(self, product_raw: str) -> str:
            candidate = product_raw.strip().upper()
            if PRODUCT_RE.match(candidate):
                return candidate
            return "SOL-USD"

        def do_GET(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path == "/api/history":
                if self._is_rate_limited():
                    _json_error(self, HTTPStatus.TOO_MANY_REQUESTS, "rate limit exceeded")
                    return
                query = parse_qs(parsed.query)
                limit = _parse_int(query, key="limit", default=120, low=1, high=2000)
                rows = _read_history_rows(history_csv, limit)
                _json_response(self, {"source": "local_csv", "candles": rows})
                return

            if parsed.path == "/api/bootstrap":
                if self._is_rate_limited():
                    _json_error(self, HTTPStatus.TOO_MANY_REQUESTS, "rate limit exceeded")
                    return
                query = parse_qs(parsed.query)
                limit = _parse_int(query, key="limit", default=240, low=1, high=2000)
                min_local = _parse_int(query, key="min_local", default=20, low=1, high=500)
                product = self._sanitize_product(query.get("product", ["SOL-USD"])[0])

                cache_key = (product, limit, min_local)
                now = time.time()
                cached = DashboardHandler._bootstrap_cache.get(cache_key)
                if cached and now - cached[0] <= 15.0:
                    _json_response(self, cached[1])
                    return

                local_rows = _read_history_rows(history_csv, limit)
                if len(local_rows) >= min_local:
                    payload = {
                        "source": "local_csv",
                        "candles": local_rows,
                        "interval_seconds": 5,
                        "product": product,
                    }
                    DashboardHandler._bootstrap_cache[cache_key] = (now, payload)
                    _json_response(self, payload)
                    return

                try:
                    rest_rows = _fetch_coinbase_rest_candles(product_id=product, limit=limit)
                except Exception as exc:
                    payload = {
                        "source": "unavailable",
                        "candles": local_rows,
                        "interval_seconds": 5,
                        "product": product,
                        "error": str(exc),
                    }
                    DashboardHandler._bootstrap_cache[cache_key] = (now, payload)
                    _json_response(self, payload)
                    return

                if rest_rows:
                    payload = {
                        "source": "coinbase_rest",
                        "candles": rest_rows,
                        "interval_seconds": 60,
                        "product": product,
                    }
                    DashboardHandler._bootstrap_cache[cache_key] = (now, payload)
                    _json_response(self, payload)
                    return

                payload = {
                    "source": "local_csv_partial",
                    "candles": local_rows,
                    "interval_seconds": 5,
                    "product": product,
                }
                DashboardHandler._bootstrap_cache[cache_key] = (now, payload)
                _json_response(self, payload)
                return

            super().do_GET()

    return DashboardHandler


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the live market dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--web-root", default="web")
    parser.add_argument(
        "--history-csv",
        default="outputs/coinbase_candles_solusd_5s.csv",
        help="CSV used by /api/history and bootstrap local fallback",
    )
    args = parser.parse_args()

    root = Path(args.web_root).resolve()
    if not root.exists():
        raise SystemExit(f"web root not found: {root}")

    history_csv = Path(args.history_csv).resolve()
    handler = _build_handler(root, history_csv)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving dashboard: http://{args.host}:{args.port}/live_sol_dashboard.html")
    print(f"History API: http://{args.host}:{args.port}/api/history?limit=120 -> {history_csv}")
    print(
        "Bootstrap API: "
        f"http://{args.host}:{args.port}/api/bootstrap?product=SOL-USD&limit=240&min_local=20"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
