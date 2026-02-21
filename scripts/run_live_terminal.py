from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description="Run live dashboard server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--web-root", default="web")
    args = parser.parse_args()

    repo = Path(__file__).resolve().parents[1]
    env = dict(os.environ)
    src_path = str((repo / "src").resolve())
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = src_path if not existing else f"{src_path}:{existing}"

    serve_cmd = [
        sys.executable,
        "scripts/serve_live_dashboard.py",
        "--host",
        args.host,
        "--port",
        str(args.port),
        "--web-root",
        args.web_root,
    ]

    print("Starting live dashboard server...")
    print(f"Dashboard URL: http://{args.host}:{args.port}/live_crypto_dashboard.html")
    subprocess.run(serve_cmd, cwd=str(repo), env=env, check=True)  # noqa: S603


if __name__ == "__main__":
    main()
