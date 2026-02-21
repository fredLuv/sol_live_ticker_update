# SOL Live Update

Standalone SOL-USD live terminal app (Coinbase):
- `market_trades` for trade-driven candles
- `level2` for top-of-book + spread/imbalance panel
- local bootstrap fallback (`CSV -> Coinbase REST -> live websocket`)

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

Open:
- http://127.0.0.1:8765/live_sol_dashboard.html

## Folder layout

- `src/sol_live_update/` core parser + candle writer
- `scripts/` runners and local API server
- `web/` modular dashboard (`html/css/js`)
- `outputs/` tick/candle csv files
