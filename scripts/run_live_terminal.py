from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import time
from pathlib import Path


def _start_process(cmd: list[str], cwd: Path, env: dict[str, str]) -> subprocess.Popen[str]:
    return subprocess.Popen(  # noqa: S603
        cmd,
        cwd=str(cwd),
        text=True,
        env=env,
    )


def _terminate(proc: subprocess.Popen[str], name: str) -> None:
    if proc.poll() is not None:
        return
    print(f"Stopping {name} (pid={proc.pid})...")
    proc.terminate()
    try:
        proc.wait(timeout=4)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=2)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Run Coinbase stream writer and dashboard server together in one terminal"
    )
    parser.add_argument("--product", default="SOL-USD")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--web-root", default="web")
    parser.add_argument("--history-csv", default="outputs/coinbase_candles_solusd_5s.csv")
    parser.add_argument("--candle-seconds", type=int, default=5)
    parser.add_argument(
        "--channel",
        default="market_trades",
        choices=["market_trades", "ticker"],
        help="Coinbase WS channel used by the stream writer",
    )
    args = parser.parse_args()

    repo = Path(__file__).resolve().parents[1]
    env = dict(os.environ)
    src_path = str((repo / "src").resolve())
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = src_path if not existing else f"{src_path}:{existing}"

    stream_cmd = [
        sys.executable,
        "scripts/stream_coinbase_ticks.py",
        "--product",
        args.product,
        "--channel",
        args.channel,
        "--candle-output",
        args.history_csv,
        "--candle-seconds",
        str(args.candle_seconds),
    ]
    serve_cmd = [
        sys.executable,
        "scripts/serve_live_dashboard.py",
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--web-root",
        args.web_root,
        "--history-csv",
        args.history_csv,
    ]

    print("Starting live stream + dashboard server...")
    print(f"Dashboard URL: http://{args.host}:{args.port}/live_crypto_dashboard.html")

    stream_proc = _start_process(stream_cmd, cwd=repo, env=env)
    serve_proc = _start_process(serve_cmd, cwd=repo, env=env)

    def _handle_stop(_sig: int, _frame: object) -> None:
        _terminate(stream_proc, "stream")
        _terminate(serve_proc, "server")
        raise SystemExit(0)

    signal.signal(signal.SIGINT, _handle_stop)
    signal.signal(signal.SIGTERM, _handle_stop)

    try:
        while True:
            if stream_proc.poll() is not None:
                code = stream_proc.returncode
                _terminate(serve_proc, "server")
                raise SystemExit(code if code is not None else 1)
            if serve_proc.poll() is not None:
                code = serve_proc.returncode
                _terminate(stream_proc, "stream")
                raise SystemExit(code if code is not None else 1)
            time.sleep(0.7)
    finally:
        _terminate(stream_proc, "stream")
        _terminate(serve_proc, "server")


if __name__ == "__main__":
    main()
