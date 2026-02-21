#!/usr/bin/env bash
set -euo pipefail

PORT_VALUE="${PORT:-10000}"
HOST_VALUE="${HOST:-0.0.0.0}"

exec python scripts/run_live_terminal.py \
  --host "${HOST_VALUE}" \
  --port "${PORT_VALUE}" \
  --web-root "web"
