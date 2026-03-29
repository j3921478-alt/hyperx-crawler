/**
 * lib/hyperliquid.js
 * Hyperliquid API 封裝 — REST + WebSocket
 */

const { ethers } = require('ethers');

const HL_REST = process.env.HL_API_URL || 'https://api.hyperliquid.xyz';
const HL_WS   = process.env.HL_WS_URL  || 'wss://api.hyperliquid.xyz/ws';

/* ─── REST INFO ENDPOINTS ─── */

async function post(path, body) {
  const res = await fetch(`${HL_REST}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HL API ${res.status}: ${await res.text()}`);
  return res.json();
}

/** 取得所有合約 meta + 市場數據 */
async function getMetaAndCtxs() {
  return post('/info', { type: 'metaAndAssetCtxs' });
}

/** 取得帳戶倉位與餘額 */
async function getClearinghouse(address) {
  return post('/info', { type: 'clearinghouseState', user: address });
}

/** 取得用戶歷史成交 */
async function getUserFills(address, startTime) {
  return post('/info', {
    type: 'userFillsByTime',
    user: address,
    startTime: startTime || Date.now() - 30 * 24 * 60 * 60 * 1000,
  });
}

/** 取得用戶開放訂單 */
async function getOpenOrders(address) {
  return post('/info', { type: 'openOrders', user: address });
}

/** 取得所有幣種最新 mid price */
async function getAllMids() {
  return post('/info', { type: 'allMids' });
}

/* ─── 簽名與下單 ─── */

/**
 * 建立 Hyperliquid 下單的 EIP-712 簽名
 * @param {ethers.Wallet} wallet - Agent Wallet
 * @param {object} action       - 交易 action object
 * @param {number} nonce        - 時間戳 nonce (ms)
 */
async function signAction(wallet, action, nonce) {
  const domain = {
    chainId: 1337,
    name: 'Exchange',
    verifyingContract: '0x0000000000000000000000000000000000000000',
    version: '1',
  };

  const types = {
    Agent: [
      { name: 'source', type: 'string' },
      { name: 'connectionId', type: 'bytes32' },
    ],
  };

  // 對 action 進行哈希
  const actionHash = ethers.keccak256(
    ethers.toUtf8Bytes(JSON.stringify(action) + nonce.toString())
  );

  const value = {
    source: 'a', // 'a' = API
    connectionId: actionHash,
  };

  const signature = await wallet.signTypedData(domain, types, value);
  const { r, s, v } = ethers.Signature.from(signature);
  return { r, s, v };
}

/**
 * 送出下單請求到 exchange endpoint
 */
async function placeOrder(wallet, orderParams) {
  const nonce = Date.now();

  const action = {
    type: 'order',
    orders: [{
      a: orderParams.assetIndex,  // asset index
      b: orderParams.isBuy,       // true=buy, false=sell
      p: removeTrailingZeros(orderParams.price.toString()),
      s: removeTrailingZeros(orderParams.size.toString()),
      r: false,                   // reduceOnly
      t: { limit: { tif: 'Gtc' } },
    }],
    grouping: 'na',
  };

  const sig = await signAction(wallet, action, nonce);

  const res = await fetch(`${HL_REST}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      nonce,
      signature: sig,
      vaultAddress: null,
    }),
  });

  return res.json();
}

/**
 * 市價平倉
 */
async function closePosition(wallet, assetIndex, size, isBuy) {
  const nonce = Date.now();

  const action = {
    type: 'order',
    orders: [{
      a: assetIndex,
      b: isBuy,
      p: '0',   // 0 = market price for reduceOnly
      s: removeTrailingZeros(size.toString()),
      r: true,  // reduceOnly = true => close
      t: { limit: { tif: 'Ioc' } }, // Immediate-or-cancel
    }],
    grouping: 'na',
  };

  const sig = await signAction(wallet, action, nonce);

  const res = await fetch(`${HL_REST}/exchange`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, nonce, signature: sig, vaultAddress: null }),
  });

  return res.json();
}

/* ─── WEBSOCKET CLIENT ─── */

class HyperliquidWS {
  constructor() {
    this.ws = null;
    this.handlers = {};
    this.retryCount = 0;
    this.pingInterval = null;
  }

  connect() {
    const WebSocket = require('ws');
    this.ws = new WebSocket(HL_WS);

    this.ws.on('open', () => {
      console.log('[WS] 連接成功');
      this.retryCount = 0;
      // 定時發送 ping 防止斷線
      this.pingInterval = setInterval(() => {
        if (this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ method: 'ping' }));
        }
      }, 20000);
      this.emit('connected');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data);
        if (msg.channel && this.handlers[msg.channel]) {
          this.handlers[msg.channel].forEach(fn => fn(msg.data));
        }
        this.emit('message', msg);
      } catch (e) {
        console.warn('[WS] 解析錯誤:', e.message);
      }
    });

    this.ws.on('close', () => {
      console.log('[WS] 連接關閉，準備重連...');
      clearInterval(this.pingInterval);
      this.emit('disconnected');
      const delay = Math.min(1000 * Math.pow(2, this.retryCount++), 30000);
      setTimeout(() => this.connect(), delay);
    });

    this.ws.on('error', (err) => {
      console.error('[WS] 錯誤:', err.message);
    });
  }

  subscribe(type, params = {}, handler) {
    const sub = { type, ...params };
    const channel = type;

    if (!this.handlers[channel]) this.handlers[channel] = [];
    this.handlers[channel].push(handler);

    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ method: 'subscribe', subscription: sub }));
    } else {
      // 等連線後再訂閱
      this.once('connected', () => {
        this.ws.send(JSON.stringify({ method: 'subscribe', subscription: sub }));
      });
    }
  }

  subscribeUserEvents(address, handler) {
    this.subscribe('userEvents', { user: address }, handler);
  }

  subscribeAllMids(handler) {
    this.subscribe('allMids', {}, handler);
  }

  subscribeTrades(coin, handler) {
    this.subscribe('trades', { coin }, handler);
  }

  on(event, fn) {
    if (!this.handlers[`_${event}`]) this.handlers[`_${event}`] = [];
    this.handlers[`_${event}`].push(fn);
  }

  once(event, fn) {
    const wrapper = (...args) => {
      fn(...args);
      this.handlers[`_${event}`] = this.handlers[`_${event}`].filter(f => f !== wrapper);
    };
    this.on(event, wrapper);
  }

  emit(event, data) {
    (this.handlers[`_${event}`] || []).forEach(fn => fn(data));
  }
}

/* ─── UTILS ─── */

/** Hyperliquid 要求價格/數量不能有尾隨零 */
function removeTrailingZeros(str) {
  if (!str.includes('.')) return str;
  return str.replace(/\.?0+$/, '');
}

/** 取得 asset index (從 meta universe) */
function getAssetIndex(universe, coinName) {
  return universe.findIndex(a => a.name === coinName);
}

/** 計算跟單倉位大小 */
function calcCopySize(traderMargin, traderSize, config) {
  const { mode, ratio, fixedAmount, maxLeverage, minMargin, maxMargin } = config;
  let margin;
  if (mode === 'ratio') {
    margin = traderMargin * (ratio / 100);
  } else {
    margin = fixedAmount;
  }
  // 套用上下限
  margin = Math.max(minMargin, Math.min(maxMargin, margin));
  return { margin, size: (margin * maxLeverage) / parseFloat(traderSize) };
}

module.exports = {
  getMetaAndCtxs,
  getClearinghouse,
  getUserFills,
  getOpenOrders,
  getAllMids,
  placeOrder,
  closePosition,
  HyperliquidWS,
  getAssetIndex,
  calcCopySize,
  removeTrailingZeros,
};
