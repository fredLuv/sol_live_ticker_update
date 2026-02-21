(() => {
  const CONFIG = {
    wsUrl: "wss://advanced-trade-ws.coinbase.com",
    productId: "SOL-USD",
    candleMs: 5000,
    maxCandles: 90,
    bootstrapLimit: 240,
    depthLevels: 10,
  };

  class LiveDashboard {
    constructor() {
      this.statusEl = document.getElementById("status");
      this.sourceEl = document.getElementById("source");
      this.priceEl = document.getElementById("price");
      this.changeEl = document.getElementById("change");
      this.rangeEl = document.getElementById("range");
      this.volEl = document.getElementById("volatility");
      this.tpmEl = document.getElementById("tpm");
      this.clockEl = document.getElementById("clock");
      this.chart = document.getElementById("chart");

      this.obStatusEl = document.getElementById("ob-status");
      this.bestBidEl = document.getElementById("best-bid");
      this.bestAskEl = document.getElementById("best-ask");
      this.spreadEl = document.getElementById("spread");
      this.imbalanceEl = document.getElementById("imbalance");
      this.bidsTableEl = document.getElementById("bids-table");
      this.asksTableEl = document.getElementById("asks-table");

      this.candles = [];
      this.tickTimes = [];
      this.basePrice = null;
      this.reconnectMs = 1000;
      this.bids = new Map();
      this.asks = new Map();
    }

    async start() {
      await this.bootstrapHistory();
      this.connectWs();
    }

    async bootstrapHistory() {
      this.setStatus("Loading historical context...");
      try {
        const q = new URLSearchParams({
          product: CONFIG.productId,
          limit: String(CONFIG.bootstrapLimit),
          min_local: "20",
        });
        const resp = await fetch(`/api/bootstrap?${q.toString()}`, { cache: "no-store" });
        if (!resp.ok) {
          this.setStatus("Bootstrap unavailable; switching to live only");
          return;
        }
        const payload = await resp.json();
        const source = payload.source || "unknown";
        const rows = Array.isArray(payload.candles) ? payload.candles : [];

        this.candles = rows.map((row) => this.parseHistoryRow(row)).filter((row) => row !== null);
        if (this.candles.length > CONFIG.maxCandles) {
          this.candles = this.candles.slice(-CONFIG.maxCandles);
        }

        if (this.candles.length > 0) {
          const last = this.candles[this.candles.length - 1];
          this.basePrice = last.close;
          this.priceEl.textContent = `$${this.fmtPrice(last.close)}`;
          this.clockEl.textContent = `History loaded ${this.nowClock()}`;
          this.setStatus(`Loaded ${this.candles.length} historical candles`);
          this.sourceEl.textContent = `Source: ${source}. Live stream: Coinbase market_trades + level2.`;
          this.updateStats();
          this.render();
          return;
        }

        this.setStatus("No historical candles found; starting live stream");
      } catch (_err) {
        this.setStatus("Bootstrap error; starting live stream");
      }
    }

    parseHistoryRow(row) {
      if (!row || !row.start) return null;
      const startMs = Date.parse(row.start);
      if (!Number.isFinite(startMs)) return null;
      const open = Number(row.open);
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      const volume = Number(row.volume || 0);
      if (![open, high, low, close, volume].every((v) => Number.isFinite(v))) {
        return null;
      }
      return { start: this.bucketStart(startMs), open, high, low, close, volume };
    }

    connectWs() {
      const ws = new WebSocket(CONFIG.wsUrl);
      this.setStatus("Connecting to Coinbase market_trades + level2...");
      this.obStatusEl.textContent = "Connecting...";

      ws.onopen = () => {
        this.reconnectMs = 1000;
        this.setStatus("Live: market_trades connected");
        this.obStatusEl.textContent = "Live";
        ws.send(JSON.stringify({ type: "subscribe", product_ids: [CONFIG.productId], channel: "market_trades" }));
        ws.send(JSON.stringify({ type: "subscribe", product_ids: [CONFIG.productId], channel: "level2" }));
      };

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        this.handleMessage(msg);
      };

      ws.onerror = () => {
        this.setStatus("Stream error; retrying...");
        this.obStatusEl.textContent = "Error; retrying";
      };

      ws.onclose = () => {
        this.setStatus(`Disconnected; reconnecting in ${Math.round(this.reconnectMs / 1000)}s`);
        this.obStatusEl.textContent = "Disconnected";
        setTimeout(() => this.connectWs(), this.reconnectMs);
        this.reconnectMs = Math.min(20000, Math.floor(this.reconnectMs * 1.8));
      };
    }

    handleMessage(msg) {
      const events = Array.isArray(msg.events) ? msg.events : [];
      for (const event of events) {
        this.handleTradeEvent(event);
        this.handleLevel2Event(event);
      }
    }

    handleTradeEvent(event) {
      const trades = Array.isArray(event?.trades) ? event.trades : [];
      for (const t of trades) {
        if (t.product_id !== CONFIG.productId || !t.price) continue;
        const price = Number(t.price);
        if (!Number.isFinite(price)) continue;
        const size = t.size ? Number(t.size) : 0;
        this.upsertTick(price, Number.isFinite(size) ? size : 0, t.time);
        this.priceEl.textContent = `$${this.fmtPrice(price)}`;
        this.flashPrice();
      }
    }

    handleLevel2Event(event) {
      const updates = [];

      if (Array.isArray(event?.updates)) {
        updates.push(...event.updates);
      }

      if (Array.isArray(event?.bids)) {
        for (const row of event.bids) {
          const parsed = this.normalizeBookRow("bid", row);
          if (parsed) updates.push(parsed);
        }
      }

      if (Array.isArray(event?.asks)) {
        for (const row of event.asks) {
          const parsed = this.normalizeBookRow("ask", row);
          if (parsed) updates.push(parsed);
        }
      }

      for (const u of updates) {
        const parsed = this.normalizeUpdate(u);
        if (!parsed) continue;
        this.applyBookUpdate(parsed.side, parsed.price, parsed.size);
      }

      if (updates.length > 0) {
        this.obStatusEl.textContent = "Live";
        this.renderOrderBook();
      }
    }

    normalizeBookRow(side, row) {
      if (Array.isArray(row) && row.length >= 2) {
        return { side, price_level: row[0], new_quantity: row[1] };
      }
      if (row && typeof row === "object") {
        return { side, ...row };
      }
      return null;
    }

    normalizeUpdate(update) {
      const rawSide = String(update.side || "").toLowerCase();
      const side = rawSide === "bid" || rawSide === "buy" ? "bid" : rawSide === "ask" || rawSide === "offer" || rawSide === "sell" ? "ask" : "";
      if (!side) return null;

      const price = Number(update.price_level ?? update.price ?? update.px);
      const size = Number(update.new_quantity ?? update.quantity ?? update.size ?? 0);
      if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
      return { side, price, size };
    }

    applyBookUpdate(side, price, size) {
      const book = side === "bid" ? this.bids : this.asks;
      const key = price.toFixed(8);
      if (size <= 0) {
        book.delete(key);
      } else {
        book.set(key, size);
      }
    }

    topLevels(side, n) {
      const book = side === "bid" ? this.bids : this.asks;
      const entries = [...book.entries()].map(([priceKey, size]) => ({ price: Number(priceKey), size }));
      entries.sort((a, b) => side === "bid" ? b.price - a.price : a.price - b.price);
      return entries.slice(0, n);
    }

    renderOrderBook() {
      const bids = this.topLevels("bid", CONFIG.depthLevels);
      const asks = this.topLevels("ask", CONFIG.depthLevels);

      this.bidsTableEl.innerHTML = this.renderBookSideRows(bids, "bid");
      this.asksTableEl.innerHTML = this.renderBookSideRows(asks, "ask");

      const bestBid = bids.length ? bids[0].price : null;
      const bestAsk = asks.length ? asks[0].price : null;
      const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

      this.bestBidEl.textContent = bestBid === null ? "--" : this.fmtPrice(bestBid);
      this.bestAskEl.textContent = bestAsk === null ? "--" : this.fmtPrice(bestAsk);
      this.spreadEl.textContent = spread === null ? "--" : `${spread.toFixed(4)} (${((spread / ((bestBid + bestAsk) / 2)) * 100).toFixed(3)}%)`;

      const bidVol = bids.reduce((acc, x) => acc + x.size, 0);
      const askVol = asks.reduce((acc, x) => acc + x.size, 0);
      const total = bidVol + askVol;
      const imbalance = total > 0 ? (bidVol / total) * 100 : null;
      this.imbalanceEl.textContent = imbalance === null ? "--" : `${imbalance.toFixed(1)}% bid`;
    }

    renderBookSideRows(rows, cls) {
      if (!rows.length) return '<div class="ob-empty">No levels yet</div>';
      return rows
        .map((r) => `<div class="ob-row ${cls}"><span>${this.fmtPrice(r.price)}</span><span>${r.size.toFixed(4)}</span></div>`)
        .join("");
    }

    upsertTick(price, size, timeIso) {
      const tsMs = timeIso ? Date.parse(timeIso) : Date.now();
      this.trackTickRate(tsMs);
      this.clockEl.textContent = `Updated ${this.nowClock()}`;
      if (this.basePrice === null) this.basePrice = price;

      const bucket = this.bucketStart(tsMs);
      let current = this.candles[this.candles.length - 1];
      if (!current || current.start !== bucket) {
        current = { start: bucket, open: price, high: price, low: price, close: price, volume: size || 0 };
        this.candles.push(current);
        if (this.candles.length > CONFIG.maxCandles) this.candles.shift();
      } else {
        current.high = Math.max(current.high, price);
        current.low = Math.min(current.low, price);
        current.close = price;
        current.volume += size || 0;
      }

      this.updateChange(price);
      this.updateStats();
      this.render();
    }

    updateChange(price) {
      if (this.basePrice === null || this.basePrice <= 0) return;
      const pct = ((price - this.basePrice) / this.basePrice) * 100;
      this.changeEl.textContent = `${price >= this.basePrice ? "▲" : "▼"} ${this.fmtPct(pct)} since connect`;
      this.changeEl.className = `chg ${pct > 0.02 ? "up" : pct < -0.02 ? "dn" : "flat"}`;
    }

    updateStats() {
      if (!this.candles.length) return;
      const recent = this.candles.slice(-60);
      const hi = Math.max(...recent.map((c) => c.high));
      const lo = Math.min(...recent.map((c) => c.low));
      const mid = (hi + lo) / 2;
      const pctRange = mid > 0 ? ((hi - lo) / mid) * 100 : 0;
      this.rangeEl.textContent = `${this.fmtPrice(lo)} - ${this.fmtPrice(hi)} (${pctRange.toFixed(2)}%)`;

      const closes = recent.map((c) => c.close);
      if (closes.length < 2) {
        this.volEl.textContent = "--";
        return;
      }
      const rets = [];
      for (let i = 1; i < closes.length; i++) {
        rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
      }
      const mean = rets.reduce((a, b) => a + b, 0) / Math.max(rets.length, 1);
      const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(rets.length - 1, 1);
      this.volEl.textContent = `${(Math.sqrt(variance) * 100).toFixed(3)}%`;
    }

    render() {
      this.chart.textContent = "";
      if (!this.candles.length) return;

      const width = 1040;
      const height = 520;
      const pad = { top: 20, right: 80, bottom: 36, left: 14 };
      const innerW = width - pad.left - pad.right;
      const innerH = height - pad.top - pad.bottom;

      const visible = this.candles.slice(-80);
      let lo = Math.min(...visible.map((c) => c.low));
      let hi = Math.max(...visible.map((c) => c.high));
      const spreadRaw = Math.max(hi - lo, 1e-8);
      const margin = spreadRaw * 0.12;
      lo -= margin;
      hi += margin;
      const spread = Math.max(hi - lo, 1e-8);

      const scaleY = (price) => pad.top + ((hi - price) / spread) * innerH;

      for (let i = 0; i <= 5; i++) {
        const y = pad.top + (innerH * i) / 5;
        this.appendLine(pad.left, y, width - pad.right, y, "grid");
        const ladderPrice = hi - (spread * i) / 5;
        this.appendText(width - pad.right + 8, y + 4, this.fmtPrice(ladderPrice), "axis");
      }

      const dx = innerW / Math.max(visible.length, 1);
      const bodyW = Math.min(10, Math.max(3, dx * 0.62));

      visible.forEach((c, i) => {
        const x = pad.left + i * dx + dx * 0.5;
        const yHigh = scaleY(c.high);
        const yLow = scaleY(c.low);
        const yOpen = scaleY(c.open);
        const yClose = scaleY(c.close);
        const cls = c.close >= c.open ? "bull" : "bear";

        this.appendLine(x, yHigh, x, yLow, `wick ${cls}`);
        this.appendRect(x - bodyW / 2, Math.min(yOpen, yClose), bodyW, Math.max(1.5, Math.abs(yClose - yOpen)), cls);
      });

      const last = visible[visible.length - 1];
      const lastY = scaleY(last.close);
      this.appendLine(pad.left, lastY, width - pad.right, lastY, "last-line");
      this.appendRect(width - pad.right + 5, lastY - 10, 70, 18, "", "#0f3359", "#4c8bc3", 4);
      this.appendText(width - pad.right + 10, lastY + 3, this.fmtPrice(last.close), "axis", "#d9ecff");

      [0, Math.floor(visible.length / 2), visible.length - 1].forEach((idx) => {
        const c = visible[idx];
        if (!c) return;
        const x = pad.left + idx * dx + dx * 0.5;
        const label = new Date(c.start).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        this.appendText(x - 24, height - 10, label, "axis");
      });
    }

    appendLine(x1, y1, x2, y2, cls) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", "line");
      node.setAttribute("x1", x1);
      node.setAttribute("y1", y1);
      node.setAttribute("x2", x2);
      node.setAttribute("y2", y2);
      node.setAttribute("class", cls);
      this.chart.appendChild(node);
    }

    appendRect(x, y, w, h, cls, fill = null, stroke = null, rx = 1.2) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      node.setAttribute("x", x);
      node.setAttribute("y", y);
      node.setAttribute("width", w);
      node.setAttribute("height", h);
      node.setAttribute("rx", rx);
      if (cls) node.setAttribute("class", cls);
      if (fill) node.setAttribute("fill", fill);
      if (stroke) node.setAttribute("stroke", stroke);
      this.chart.appendChild(node);
    }

    appendText(x, y, text, cls, fill = null) {
      const node = document.createElementNS("http://www.w3.org/2000/svg", "text");
      node.setAttribute("x", x);
      node.setAttribute("y", y);
      node.setAttribute("class", cls);
      if (fill) node.setAttribute("fill", fill);
      node.textContent = text;
      this.chart.appendChild(node);
    }

    trackTickRate(tsMs) {
      this.tickTimes.push(tsMs);
      const cutoff = tsMs - 60_000;
      while (this.tickTimes.length && this.tickTimes[0] < cutoff) this.tickTimes.shift();
      this.tpmEl.textContent = String(this.tickTimes.length);
    }

    flashPrice() {
      this.priceEl.classList.remove("flash");
      void this.priceEl.offsetWidth;
      this.priceEl.classList.add("flash");
    }

    bucketStart(tsMs) {
      return Math.floor(tsMs / CONFIG.candleMs) * CONFIG.candleMs;
    }

    fmtPrice(v) {
      return Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    fmtPct(v) {
      return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
    }

    nowClock() {
      return new Date().toLocaleTimeString();
    }

    setStatus(msg) {
      this.statusEl.textContent = msg;
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    const app = new LiveDashboard();
    app.start();
  });
})();
