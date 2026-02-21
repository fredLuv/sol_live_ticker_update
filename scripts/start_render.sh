#!/usr/bin/env bash
set -euo pipefail

PORT_VALUE="${PORT:-10000}"
HOST_VALUE="${HOST:-0.0.0.0}"

exec python scripts/run_live_terminal.py \
  --product "${PRODUCT_ID:-SOL-USD}" \
  --channel "${CHANNEL:-market_trades}" \
  --host "${HOST_VALUE}" \
  --port "${PORT_VALUE}" \
  --web-root "web" \
  --history-csv "outputs/coinbase_candles_solusd_5s.csv" \
  --candle-seconds "${CANDLE_SECONDS:-5}"
