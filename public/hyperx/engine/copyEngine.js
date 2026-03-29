/**
 * engine/copyEngine.js
 * 跟單引擎核心 — 監控交易者倉位變化並自動跟單
 *
 * 流程：
 * 1. WebSocket 訂閱目標交易者的 userEvents
 * 2. 收到 fill 事件時，判斷是開倉還是平倉
 * 3. 依照設定計算跟單倉位大小
 * 4. 通過 Hyperliquid exchange endpoint 執行訂單
 * 5. 記錄跟單結果，並推送狀態給前端
 */

require('dotenv').config();
const { ethers } = require('ethers');
const {
  HyperliquidWS,
  getMetaAndCtxs,
  getClearinghouse,
  placeOrder,
  closePosition,
  getAssetIndex,
  calcCopySize,
} = require('../lib/hyperliquid');

/* ─── 跟單設定格式 ─────────────────────────────────
  {
    id: 'copy_001',
    traderAddress: '0xabc...',
    agentPrivateKey: process.env.AGENT_PRIVATE_KEY,
    masterWallet: process.env.MASTER_WALLET,
    mode: 'ratio',       // 'ratio' | 'fixed'
    ratio: 10,           // 跟單比例 % (mode=ratio時)
    fixedAmount: 500,    // 固定金額 USDC (mode=fixed時)
    maxLeverage: 5,      // 最大槓桿倍數
    minMargin: 200,      // 最小保證金 USDC
    maxMargin: 5000,     // 最大保證金 USDC
    takeProfitPct: 30,   // 止盈 %
    stopLossPct: 10,     // 止損 %
    followOpen: true,    // 跟開倉
    followClose: true,   // 跟平倉
    enabled: true,
  }
──────────────────────────────────────────────── */

class CopyEngine {
  constructor() {
    this.configs  = new Map();   // id -> config
    this.wallets  = new Map();   // id -> ethers.Wallet
    this.positions = new Map();  // `${copyId}:${coin}` -> position info
    this.universe = [];          // asset universe from meta
    this.wsClient = new HyperliquidWS();
    this.listeners = [];         // event listeners for frontend
    this.log = [];               // activity log
  }

  /* ── INIT ── */
  async init() {
    console.log('[Engine] 初始化跟單引擎...');
    const [meta] = await getMetaAndCtxs();
    this.universe = meta.universe;
    console.log(`[Engine] 載入 ${this.universe.length} 個交易對`);

    this.wsClient.connect();
    this.wsClient.on('connected', () => {
      console.log('[Engine] WebSocket 已連接，重新訂閱...');
      this.resubscribeAll();
    });

    console.log('[Engine] 引擎就緒');
  }

  /* ── 新增跟單設定 ── */
  addCopy(config) {
    if (!config.traderAddress) throw new Error('需要 traderAddress');

    // 建立 Agent Wallet
    const pk = config.agentPrivateKey || process.env.AGENT_PRIVATE_KEY;
    if (!pk) throw new Error('需要 agentPrivateKey 或環境變數 AGENT_PRIVATE_KEY');
    const wallet = new ethers.Wallet(pk);

    this.configs.set(config.id, { ...config, enabled: true });
    this.wallets.set(config.id, wallet);

    // 訂閱目標交易者的事件
    this.subscribeTrader(config.id, config.traderAddress);
    this.addLog('info', `開始跟單 ${config.traderAddress.slice(0,10)}... (${config.id})`);
    console.log(`[Engine] 新增跟單：${config.id} -> ${config.traderAddress}`);
  }

  /* ── 停止跟單 ── */
  removeCopy(id) {
    this.configs.delete(id);
    this.wallets.delete(id);
    this.addLog('warn', `停止跟單 ${id}`);
    console.log(`[Engine] 移除跟單：${id}`);
  }

  /* ── 訂閱交易者事件 ── */
  subscribeTrader(copyId, traderAddress) {
    this.wsClient.subscribeUserEvents(traderAddress, async (data) => {
      const config = this.configs.get(copyId);
      if (!config || !config.enabled) return;
      await this.handleTraderEvent(copyId, data);
    });
    console.log(`[Engine] 訂閱 ${traderAddress} 的事件`);
  }

  resubscribeAll() {
    for (const [id, config] of this.configs) {
      this.subscribeTrader(id, config.traderAddress);
    }
  }

  /* ── 處理交易者事件 ── */
  async handleTraderEvent(copyId, data) {
    if (!data || !data.fills) return;

    for (const fill of data.fills) {
      const config = this.configs.get(copyId);
      if (!config) continue;

      const coin    = fill.coin;
      const isBuy   = fill.side === 'B';
      const isOpen  = fill.dir.includes('Open');
      const isClose = fill.dir.includes('Close');
      const size    = parseFloat(fill.sz);
      const price   = parseFloat(fill.px);
      const margin  = Math.abs(parseFloat(fill.closedPnl)) || (size * price / 20); // 估算

      console.log(`[Engine] 偵測到 ${coin} ${fill.dir} @ $${price} sz:${size}`);

      try {
        if (isOpen && config.followOpen) {
          await this.executeCopyOpen(copyId, { coin, isBuy, size, price, margin });
        } else if (isClose && config.followClose) {
          await this.executeCopyClose(copyId, { coin, isBuy: !isBuy, size });
        }
      } catch (err) {
        this.addLog('error', `執行跟單失敗 ${coin}: ${err.message}`);
        console.error(`[Engine] 跟單執行錯誤:`, err);
      }
    }
  }

  /* ── 執行開倉 ── */
  async executeCopyOpen(copyId, { coin, isBuy, size, price, margin }) {
    const config = this.configs.get(copyId);
    const wallet = this.wallets.get(copyId);

    // 計算跟單倉位
    const { margin: copyMargin } = calcCopySize(margin, size, config);
    const assetIdx = getAssetIndex(this.universe, coin);
    if (assetIdx < 0) {
      this.addLog('warn', `找不到 ${coin} 的 asset index`);
      return;
    }

    // 計算跟單倉位大小
    const leverage = Math.min(
      parseFloat(this.universe[assetIdx]?.maxLeverage || 20),
      config.maxLeverage
    );
    const copySize = (copyMargin * leverage) / price;

    // 計算止損止盈價格
    const tpPrice = isBuy
      ? price * (1 + config.takeProfitPct / 100)
      : price * (1 - config.takeProfitPct / 100);
    const slPrice = isBuy
      ? price * (1 - config.stopLossPct / 100)
      : price * (1 + config.stopLossPct / 100);

    this.addLog('signal', `${coin} ${isBuy?'做多':'做空'} — 保證金 $${copyMargin.toFixed(0)} × ${leverage}x`);

    // 下單
    const result = await placeOrder(wallet, {
      assetIndex: assetIdx,
      isBuy,
      price: price * (isBuy ? 1.005 : 0.995), // 0.5% 滑點容忍
      size: parseFloat(copySize.toFixed(4)),
    });

    if (result.status === 'ok') {
      const posKey = `${copyId}:${coin}`;
      this.positions.set(posKey, {
        coin, isBuy, size: copySize, entryPrice: price,
        margin: copyMargin, tpPrice, slPrice,
        openTime: Date.now(),
      });
      this.addLog('fill', `✓ 開倉成功 ${coin} ${isBuy?'LONG':'SHORT'} $${copyMargin.toFixed(0)} @ $${price}`);
      this.emit('orderFilled', { copyId, coin, side: isBuy?'LONG':'SHORT', price, margin: copyMargin });
    } else {
      this.addLog('error', `開倉失敗 ${coin}: ${JSON.stringify(result)}`);
    }
  }

  /* ── 執行平倉 ── */
  async executeCopyClose(copyId, { coin, isBuy, size }) {
    const config = this.configs.get(copyId);
    const wallet = this.wallets.get(copyId);
    const posKey = `${copyId}:${coin}`;
    const pos = this.positions.get(posKey);

    if (!pos) {
      this.addLog('warn', `找不到 ${coin} 的持倉紀錄，跳過平倉`);
      return;
    }

    const assetIdx = getAssetIndex(this.universe, coin);
    if (assetIdx < 0) return;

    const result = await closePosition(wallet, assetIdx, pos.size, isBuy);

    if (result.status === 'ok') {
      this.positions.delete(posKey);
      this.addLog('fill', `✓ 平倉成功 ${coin} @ 市價`);
      this.emit('positionClosed', { copyId, coin });
    } else {
      this.addLog('error', `平倉失敗 ${coin}: ${JSON.stringify(result)}`);
    }
  }

  /* ── 止盈止損監控 ── */
  async checkTPSL(currentPrices) {
    for (const [posKey, pos] of this.positions) {
      const [copyId, coin] = posKey.split(':');
      const currentPrice = parseFloat(currentPrices[coin]);
      if (!currentPrice) continue;

      const hitTP = pos.isBuy
        ? currentPrice >= pos.tpPrice
        : currentPrice <= pos.tpPrice;
      const hitSL = pos.isBuy
        ? currentPrice <= pos.slPrice
        : currentPrice >= pos.slPrice;

      if (hitTP || hitSL) {
        const reason = hitTP ? '止盈' : '止損';
        this.addLog('signal', `${reason}觸發：${coin} @ $${currentPrice}`);
        const wallet = this.wallets.get(copyId);
        const assetIdx = getAssetIndex(this.universe, coin);
        if (wallet && assetIdx >= 0) {
          await closePosition(wallet, assetIdx, pos.size, !pos.isBuy);
          this.positions.delete(posKey);
        }
      }
    }
  }

  /* ── 工具方法 ── */
  addLog(type, msg) {
    const entry = { type, msg, time: new Date().toISOString() };
    this.log.unshift(entry);
    if (this.log.length > 200) this.log.pop();
    this.emit('log', entry);
    console.log(`[${type.toUpperCase()}] ${msg}`);
  }

  on(event, fn) {
    this.listeners.push({ event, fn });
  }

  emit(event, data) {
    this.listeners.filter(l => l.event === event).forEach(l => l.fn(data));
  }

  getStatus() {
    return {
      copies: Array.from(this.configs.values()),
      positions: Array.from(this.positions.entries()).map(([k,v]) => ({key:k,...v})),
      log: this.log.slice(0, 50),
      wsConnected: this.wsClient.ws?.readyState === 1,
    };
  }
}

// ── 若直接執行此檔案，啟動示例跟單 ──
if (require.main === module) {
  const engine = new CopyEngine();
  engine.init().then(() => {
    // 示例：新增一個跟單設定
    // 請替換為真實地址和私鑰
    engine.addCopy({
      id: 'copy_001',
      traderAddress: '0x8f3a7b2c1d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a',
      mode: 'ratio',
      ratio: 10,
      maxLeverage: 5,
      minMargin: 200,
      maxMargin: 5000,
      takeProfitPct: 30,
      stopLossPct: 10,
      followOpen: true,
      followClose: true,
    });

    engine.on('log', (entry) => {
      console.log(`[LOG] [${entry.type}] ${entry.msg}`);
    });

    engine.on('orderFilled', (data) => {
      console.log('[FILLED]', data);
    });
  }).catch(console.error);

  module.exports = engine;
}

module.exports = CopyEngine;
