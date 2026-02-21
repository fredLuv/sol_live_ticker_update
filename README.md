# Crypto Live Update

Standalone multi-market live terminal app (Coinbase):
- top toggle: `SOL-USD`, `BTC-USD`, `SOL-BTC`
- `market_trades` for trade-driven candles
- `level2` for top-of-book + spread/imbalance panel
- local bootstrap fallback (`CSV -> Coinbase REST -> live websocket`)

## Preview

![SOL Live Terminal](web/assets/sol_live_terminal.png)

## Setup

```bash
cd /Users/fred/Desktop/IMC-Java-Code/sol_live_update
. /Users/fred/Desktop/IMC-Java-Code/.venv/bin/activate
python -m pip install websockets
```

## Run (single command)

```bash
cd /Users/fred/Desktop/IMC-Java-Code/sol_live_update
. /Users/fred/Desktop/IMC-Java-Code/.venv/bin/activate
python scripts/run_live_terminal.py \
  --product SOL-USD \
  --channel market_trades \
  --host 127.0.0.1 \
  --port 8765
```

Note: `--product` controls the local candle writer seed stream. The dashboard itself toggles across all supported products.

Open:
- http://127.0.0.1:8765/live_crypto_dashboard.html

## Folder layout

- `src/sol_live_update/` core parser + candle writer
- `scripts/` runners and local API server
- `web/` modular dashboard (`html/css/js`)
- `outputs/` candle csv files
