(() => {
  const CONFIG = {
    wsUrl: "wss://advanced-trade-ws.coinbase.com",
    products: ["SOL-USD", "BTC-USD", "SOL-BTC"],
    defaultProduct: "SOL-USD",
    candleMs: 5000,
    maxCandles: 90,
    bootstrapLimit: 240,
    depthLevels: 10,
    priceDecimals: {
      "SOL-USD": 2,
      "BTC-USD": 2,
      "SOL-BTC": 6,
    },
  };

  class LiveDashboard {
    constructor() {
      this.titleEl = document.getElementById("app-title");
      this.marketToggleEl = document.getElementById("market-toggle");
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

      this.activeProduct = CONFIG.defaultProduct;
      this.reconnectMs = 1000;
      this.wsConnected = false;

      this.marketState = new Map(
        CONFIG.products.map((product) => [product, this.createEmptyState()]),
      );

      this.renderMarketToggle();
    }

    createEmptyState() {
      return {
        candles: [],
        tradeBuckets: new Uint16Array(60),
        tradeBucketSec: new Int32Array(60),
        basePrice: null,
        lastPrice: null,
        lastUpdateTs: null,
        bids: new Map(),
        asks: new Map(),
        lastBookHydrateMs: 0,
        bookHydratePending: false,
        historySource: "unknown",
      };
    }

    getState(product = this.activeProduct) {
      if (!this.marketState.has(product)) {
        this.marketState.set(product, this.createEmptyState());
      }
      return this.marketState.get(product);
    }

    async start() {
      this.setStatus("Loading historical context...");
      await Promise.all(CONFIG.products.map((product) => this.bootstrapHistory(product)));
      this.connectWs();
      this.setActiveProduct(this.activeProduct);
      setInterval(() => this.refreshTradeCount(), 1000);
    }

    renderMarketToggle() {
      this.marketToggleEl.textContent = "";
      for (const product of CONFIG.products) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = `market-btn${product === this.activeProduct ? " active" : ""}`;
        btn.dataset.product = product;
        btn.textContent = product;
        btn.addEventListener("click", () => this.setActiveProduct(product));
        this.marketToggleEl.appendChild(btn);
      }
    }

    setActiveProduct(product) {
      if (!CONFIG.products.includes(product)) return;
      this.activeProduct = product;

      const buttons = this.marketToggleEl.querySelectorAll(".market-btn");
      for (const btn of buttons) {
        btn.classList.toggle("active", btn.dataset.product === product);
      }

      this.titleEl.textContent = `${product} Live Terminal`;
      this.chart.setAttribute("aria-label", `${product} live candlestick chart`);
      this.refreshDisplay();
    }

    refreshDisplay() {
      const state = this.getState();
      if (state.lastPrice !== null) {
        this.priceEl.textContent = this.fmtQuotePrice(state.lastPrice, this.activeProduct);
        this.updateChange(state.lastPrice);
      } else {
        this.priceEl.textContent = "--";
        this.changeEl.textContent = "--";
        this.changeEl.className = "chg flat";
      }

      this.updateStats();
      this.refreshTradeCount();
      this.render();
      this.renderOrderBook();

      if (state.lastUpdateTs) {
        this.clockEl.textContent = `Updated ${new Date(state.lastUpdateTs).toLocaleTimeString()}`;
      }

      const streamState = this.wsConnected ? "Coinbase market_trades + level2" : "connecting...";
      this.sourceEl.textContent = `Source: ${state.historySource}. Live stream: ${streamState}.`;
      this.obStatusEl.textContent = this.wsConnected ? "Live" : "Connecting...";
      this.setStatus(this.wsConnected ? `Live: ${this.activeProduct} connected` : `Loading ${this.activeProduct}...`);
    }

    async bootstrapHistory(product) {
      try {
        const q = new URLSearchParams({
          product,
          limit: String(CONFIG.bootstrapLimit),
        });
        const resp = await fetch(`/api/bootstrap?${q.toString()}`, { cache: "no-store" });
        if (!resp.ok) return;

        const payload = await resp.json();
        const source = payload.source || "unknown";
        const rows = Array.isArray(payload.candles) ? payload.candles : [];
        const candles = rows.map((row) => this.parseHistoryRow(row)).filter((row) => row !== null);
        const state = this.getState(product);

        state.candles = candles.slice(-CONFIG.maxCandles);
        state.historySource = source;

        if (state.candles.length > 0) {
          const last = state.candles[state.candles.length - 1];
          state.basePrice = last.close;
          state.lastPrice = last.close;
          state.lastUpdateTs = Date.now();
        }
      } catch (_err) {
        // fall back to live-only mode
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
        this.wsConnected = true;
        this.setStatus(`Live: ${this.activeProduct} connected`);
        this.obStatusEl.textContent = "Live";
        ws.send(JSON.stringify({ type: "subscribe", product_ids: CONFIG.products, channel: "market_trades" }));
        ws.send(JSON.stringify({ type: "subscribe", product_ids: CONFIG.products, channel: "level2" }));
        this.refreshDisplay();
      };

      ws.onmessage = (evt) => {
        const msg = JSON.parse(evt.data);
        this.handleMessage(msg);
      };

      ws.onerror = () => {
        this.wsConnected = false;
        this.setStatus("Stream error; retrying...");
        this.obStatusEl.textContent = "Error; retrying";
      };

      ws.onclose = () => {
        this.wsConnected = false;
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
        const product = t.product_id;
        if (!CONFIG.products.includes(product) || !t.price) continue;

        const price = Number(t.price);
        if (!Number.isFinite(price)) continue;
        const size = t.size ? Number(t.size) : 0;

        this.upsertTick(product, price, Number.isFinite(size) ? size : 0, t.time);
      }
    }

    handleLevel2Event(event) {
      const updates = [];
      const defaultProduct = CONFIG.products.includes(event?.product_id) ? event.product_id : null;

      if (Array.isArray(event?.updates)) {
        for (const row of event.updates) {
          updates.push({ product: this.resolveBookProduct(row, defaultProduct), row });
        }
      }

      if (Array.isArray(event?.bids)) {
        for (const row of event.bids) {
          const normalized = this.normalizeBookRow("bid", row);
          if (normalized) {
            updates.push({ product: defaultProduct, row: normalized });
          }
        }
      }

      if (Array.isArray(event?.asks)) {
        for (const row of event.asks) {
          const normalized = this.normalizeBookRow("ask", row);
          if (normalized) {
            updates.push({ product: defaultProduct, row: normalized });
          }
        }
      }

      let activeChanged = false;
      for (const item of updates) {
        const parsed = this.normalizeUpdate(item.row);
        const product = this.resolveBookProduct(item.row, item.product);
        if (!parsed || !product) continue;
        this.applyBookUpdate(product, parsed.side, parsed.price, parsed.size);
        if (product === this.activeProduct) activeChanged = true;
      }

      if (activeChanged) {
        this.obStatusEl.textContent = "Live";
        this.renderOrderBook();
      }
    }

    resolveBookProduct(update, fallback) {
      const candidate = typeof update?.product_id === "string" ? update.product_id : fallback;
      return CONFIG.products.includes(candidate) ? candidate : null;
    }

    async hydrateOrderBookFromRest(product) {
      const state = this.getState(product);
      if (state.bookHydratePending) return;
      const now = Date.now();
      if (now - state.lastBookHydrateMs < 8000) return;

      state.bookHydratePending = true;
      try {
        const q = new URLSearchParams({
          product,
          level: "2",
          limit: String(Math.max(CONFIG.depthLevels, 20)),
        });
        const resp = await fetch(`/api/orderbook?${q.toString()}`, { cache: "no-store" });
        if (!resp.ok) return;

        const payload = await resp.json();
        const bids = Array.isArray(payload.bids) ? payload.bids : [];
        const asks = Array.isArray(payload.asks) ? payload.asks : [];

        for (const row of bids) {
          const p = Number(row.price);
          const s = Number(row.size);
          if (Number.isFinite(p) && Number.isFinite(s) && s > 0) {
            this.applyBookUpdate(product, "bid", p, s);
          }
        }
        for (const row of asks) {
          const p = Number(row.price);
          const s = Number(row.size);
          if (Number.isFinite(p) && Number.isFinite(s) && s > 0) {
            this.applyBookUpdate(product, "ask", p, s);
          }
        }

        state.lastBookHydrateMs = Date.now();
        if (product === this.activeProduct) {
          this.obStatusEl.textContent = "Live (hydrated)";
          this.renderOrderBook();
        }
      } finally {
        state.bookHydratePending = false;
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
      const side = rawSide === "bid" || rawSide === "buy"
        ? "bid"
        : rawSide === "ask" || rawSide === "offer" || rawSide === "sell"
          ? "ask"
          : "";
      if (!side) return null;

      const price = Number(update.price_level ?? update.price ?? update.px);
      const size = Number(update.new_quantity ?? update.quantity ?? update.size ?? 0);
      if (!Number.isFinite(price) || !Number.isFinite(size)) return null;
      return { side, price, size };
    }

    applyBookUpdate(product, side, price, size) {
      const state = this.getState(product);
      const book = side === "bid" ? state.bids : state.asks;
      const key = price.toFixed(8);
      if (size <= 0) {
        book.delete(key);
      } else {
        book.set(key, size);
      }
    }

    topLevels(product, side, n) {
      const state = this.getState(product);
      const book = side === "bid" ? state.bids : state.asks;
      const entries = [...book.entries()].map(([priceKey, size]) => ({ price: Number(priceKey), size }));
      entries.sort((a, b) => (side === "bid" ? b.price - a.price : a.price - b.price));
      return entries.slice(0, n);
    }

    renderOrderBook() {
      const product = this.activeProduct;
      const bids = this.topLevels(product, "bid", CONFIG.depthLevels);
      const asks = this.topLevels(product, "ask", CONFIG.depthLevels);

      if (bids.length < CONFIG.depthLevels || asks.length < CONFIG.depthLevels) {
        void this.hydrateOrderBookFromRest(product);
      }

      this.bidsTableEl.innerHTML = this.renderBookSideRows(bids, "bid");
      this.asksTableEl.innerHTML = this.renderBookSideRows(asks, "ask");

      const bestBid = bids.length ? bids[0].price : null;
      const bestAsk = asks.length ? asks[0].price : null;
      const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;

      this.bestBidEl.textContent = bestBid === null ? "--" : this.fmtPrice(bestBid);
      this.bestAskEl.textContent = bestAsk === null ? "--" : this.fmtPrice(bestAsk);
      this.spreadEl.textContent = spread === null
        ? "--"
        : `${spread.toFixed(4)} (${((spread / ((bestBid + bestAsk) / 2)) * 100).toFixed(3)}%)`;

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

    upsertTick(product, price, size, timeIso) {
      const state = this.getState(product);
      const arrivalMs = Date.now();
      const parsedTs = timeIso ? Date.parse(timeIso) : NaN;
      const tsMs = Number.isFinite(parsedTs) ? parsedTs : arrivalMs;
      this.recordTradeSample(product, arrivalMs);
      if (state.basePrice === null) state.basePrice = price;

      const bucket = this.bucketStart(tsMs);
      let current = state.candles[state.candles.length - 1];
      if (!current || current.start !== bucket) {
        current = { start: bucket, open: price, high: price, low: price, close: price, volume: size || 0 };
        state.candles.push(current);
        if (state.candles.length > CONFIG.maxCandles) state.candles.shift();
      } else {
        current.high = Math.max(current.high, price);
        current.low = Math.min(current.low, price);
        current.close = price;
        current.volume += size || 0;
      }

      state.lastPrice = price;
      state.lastUpdateTs = tsMs;

      if (product === this.activeProduct) {
        this.priceEl.textContent = this.fmtQuotePrice(price, product);
        this.clockEl.textContent = `Updated ${this.nowClock(tsMs)}`;
        this.updateChange(price);
        this.updateStats();
        this.refreshTradeCount(product);
        this.flashPrice();
        this.render();
      }
    }

    updateChange(price) {
      const state = this.getState();
      if (state.basePrice === null || state.basePrice <= 0) return;
      const pct = ((price - state.basePrice) / state.basePrice) * 100;
      this.changeEl.textContent = `${price >= state.basePrice ? "▲" : "▼"} ${this.fmtPct(pct)} since connect`;
      this.changeEl.className = `chg ${pct > 0.02 ? "up" : pct < -0.02 ? "dn" : "flat"}`;
    }

    updateStats() {
      const state = this.getState();
      if (!state.candles.length) {
        this.rangeEl.textContent = "--";
        this.volEl.textContent = "--";
        return;
      }

      const recent = state.candles.slice(-60);
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
      const state = this.getState();
      this.chart.textContent = "";
      if (!state.candles.length) return;

      const width = 1040;
      const height = 520;
      const pad = { top: 20, right: 80, bottom: 36, left: 14 };
      const innerW = width - pad.left - pad.right;
      const innerH = height - pad.top - pad.bottom;

      const visible = state.candles.slice(-80);
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

    refreshTradeCount(product = this.activeProduct) {
      this.tpmEl.textContent = String(this.rollingTradeCount60s(product));
    }

    recordTradeSample(product, tsMs) {
      const state = this.getState(product);
      const sec = Math.floor(tsMs / 1000);
      const idx = sec % 60;
      if (state.tradeBucketSec[idx] !== sec) {
        state.tradeBucketSec[idx] = sec;
        state.tradeBuckets[idx] = 0;
      }
      if (state.tradeBuckets[idx] < 0xffff) {
        state.tradeBuckets[idx] += 1;
      }
    }

    rollingTradeCount60s(product = this.activeProduct) {
      const state = this.getState(product);
      const nowSec = Math.floor(Date.now() / 1000);
      const cutoff = nowSec - 59;
      let total = 0;
      for (let i = 0; i < 60; i++) {
        const sec = state.tradeBucketSec[i];
        if (sec >= cutoff && sec <= nowSec) total += state.tradeBuckets[i];
      }
      return total;
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
      const digits = CONFIG.priceDecimals[this.activeProduct] ?? 2;
      return Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
    }

    fmtQuotePrice(v, product) {
      const digits = CONFIG.priceDecimals[product] ?? 2;
      const prefix = product.endsWith("-USD") ? "$" : "";
      return `${prefix}${Number(v).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
    }

    fmtPct(v) {
      return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
    }

    nowClock(tsMs = Date.now()) {
      return new Date(tsMs).toLocaleTimeString();
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
