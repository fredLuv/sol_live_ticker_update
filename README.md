# Crypto Live Update

Standalone multi-market live terminal app (Coinbase):
- top toggle: `SOL-USD`, `BTC-USD`, `SOL-BTC`
- `market_trades` for trade-driven candles
- `level2` for top-of-book + spread/imbalance panel
- bootstrap + depth from Coinbase REST, live ticks from Coinbase websocket

## Preview

![SOL Live Terminal](web/assets/sol_live_terminal.png)

## Setup

```bash
cd /Users/fred/Desktop/IMC-Java-Code/sol_live_update
. /Users/fred/Desktop/IMC-Java-Code/.venv/bin/activate
python -m pip install -r requirements.txt
```

## Run (single command)

```bash
cd /Users/fred/Desktop/IMC-Java-Code/sol_live_update
. /Users/fred/Desktop/IMC-Java-Code/.venv/bin/activate
python scripts/run_live_terminal.py \
  --host 127.0.0.1 \
  --port 8765
```

Open:
- http://127.0.0.1:8765/live_crypto_dashboard.html

## Folder layout

- `scripts/` runner and local API server
- `web/` modular dashboard (`html/css/js`)
