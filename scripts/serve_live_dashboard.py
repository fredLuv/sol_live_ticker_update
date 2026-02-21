from __future__ import annotations

import argparse
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


def _fetch_coinbase_rest_order_book(
    product_id: str, level: int, limit: int
) -> dict[str, list[dict[str, float]]]:
    level_value = level if level in (1, 2, 3) else 2
    url = f"https://api.exchange.coinbase.com/products/{quote(product_id)}/book?level={level_value}"
    req = Request(
        url,
        headers={
            "User-Agent": "qrt-live-dashboard/1.0",
            "Accept": "application/json",
        },
    )
    with urlopen(req, timeout=8.0) as resp:  # noqa: S310 - intentional trusted outbound request
        payload = json.loads(resp.read().decode("utf-8"))

    bids_raw = payload.get("bids", []) if isinstance(payload, dict) else []
    asks_raw = payload.get("asks", []) if isinstance(payload, dict) else []

    def _parse_side(rows: object, side: str) -> list[dict[str, float]]:
        out: list[dict[str, float]] = []
        if not isinstance(rows, list):
            return out
        for row in rows:
            if not isinstance(row, list) or len(row) < 2:
                continue
            try:
                price = float(row[0])
                size = float(row[1])
            except (TypeError, ValueError):
                continue
            out.append({"price": price, "size": size})
            if len(out) >= limit:
                break
        out.sort(key=lambda r: r["price"], reverse=(side == "bid"))
        return out

    return {
        "bids": _parse_side(bids_raw, side="bid"),
        "asks": _parse_side(asks_raw, side="ask"),
    }


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


def _build_handler(web_root: Path):
    class DashboardHandler(SimpleHTTPRequestHandler):
        _rate_lock = threading.Lock()
        _ip_hits: dict[str, list[float]] = {}
        _bootstrap_cache: dict[tuple[str, int], tuple[float, dict[str, object]]] = {}
        _orderbook_cache: dict[tuple[str, int, int], tuple[float, dict[str, object]]] = {}

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
            if parsed.path in ("/", "/index.html"):
                self.path = "/live_crypto_dashboard.html"
                super().do_GET()
                return
            if parsed.path == "/llve_crypto_dashboard.html":
                self.send_response(HTTPStatus.MOVED_PERMANENTLY)
                self.send_header("Location", "/live_crypto_dashboard.html")
                self.end_headers()
                return
            if parsed.path == "/api/bootstrap":
                if self._is_rate_limited():
                    _json_error(self, HTTPStatus.TOO_MANY_REQUESTS, "rate limit exceeded")
                    return
                query = parse_qs(parsed.query)
                limit = _parse_int(query, key="limit", default=240, low=1, high=2000)
                product = self._sanitize_product(query.get("product", ["SOL-USD"])[0])

                cache_key = (product, limit)
                now = time.time()
                cached = DashboardHandler._bootstrap_cache.get(cache_key)
                if cached and now - cached[0] <= 15.0:
                    _json_response(self, cached[1])
                    return

                try:
                    rest_rows = _fetch_coinbase_rest_candles(product_id=product, limit=limit)
                except Exception as exc:
                    payload = {
                        "source": "unavailable",
                        "candles": [],
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

                payload = {"source": "unavailable", "candles": [], "interval_seconds": 5, "product": product}
                DashboardHandler._bootstrap_cache[cache_key] = (now, payload)
                _json_response(self, payload)
                return

            if parsed.path == "/api/orderbook":
                if self._is_rate_limited():
                    _json_error(self, HTTPStatus.TOO_MANY_REQUESTS, "rate limit exceeded")
                    return
                query = parse_qs(parsed.query)
                product = self._sanitize_product(query.get("product", ["SOL-USD"])[0])
                level = _parse_int(query, key="level", default=2, low=1, high=3)
                limit = _parse_int(query, key="limit", default=20, low=1, high=100)
                key = (product, level, limit)
                now = time.time()
                cached = DashboardHandler._orderbook_cache.get(key)
                if cached and now - cached[0] <= 5.0:
                    _json_response(self, cached[1])
                    return
                try:
                    book = _fetch_coinbase_rest_order_book(product_id=product, level=level, limit=limit)
                except Exception as exc:
                    _json_error(self, HTTPStatus.BAD_GATEWAY, f"orderbook upstream failed: {exc}")
                    return
                payload = {
                    "source": "coinbase_rest_book",
                    "product": product,
                    "level": level,
                    "bids": book["bids"],
                    "asks": book["asks"],
                }
                DashboardHandler._orderbook_cache[key] = (now, payload)
                _json_response(self, payload)
                return

            super().do_GET()

        def do_HEAD(self) -> None:  # noqa: N802
            parsed = urlparse(self.path)
            if parsed.path in ("/", "/index.html"):
                self.path = "/live_crypto_dashboard.html"
            elif parsed.path == "/llve_crypto_dashboard.html":
                self.send_response(HTTPStatus.MOVED_PERMANENTLY)
                self.send_header("Location", "/live_crypto_dashboard.html")
                self.end_headers()
                return
            super().do_HEAD()

    return DashboardHandler


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the live market dashboard")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--web-root", default="web")
    args = parser.parse_args()

    root = Path(args.web_root).resolve()
    if not root.exists():
        raise SystemExit(f"web root not found: {root}")

    handler = _build_handler(root)
    server = ThreadingHTTPServer((args.host, args.port), handler)
    print(f"Serving dashboard: http://{args.host}:{args.port}/live_crypto_dashboard.html")
    print(
        "Bootstrap API: "
        f"http://{args.host}:{args.port}/api/bootstrap?product=SOL-USD&limit=240"
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
