/**
 * server.js
 * Express + WebSocket 伺服器
 * - 提供前端靜態檔案
 * - 代理 Hyperliquid WebSocket（解決 CORS 問題）
 * - REST API 給前端使用
 * - 控制跟單引擎
 */

require('dotenv').config();
const express  = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const cors     = require('cors');
const http     = require('http');
const path     = require('path');
const CopyEngine = require('./engine/copyEngine');

const PORT = process.env.PORT || 3000;
const HL_WS = process.env.HL_WS_URL || 'wss://api.hyperliquid.xyz/ws';
const HL_REST = process.env.HL_API_URL || 'https://api.hyperliquid.xyz';

/* ─── APP SETUP ─── */
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

/* ─── 跟單引擎 ─── */
const engine = new CopyEngine();
let engineReady = false;

engine.init().then(() => {
  engineReady = true;
  console.log('[Server] 跟單引擎就緒');
}).catch(err => {
  console.warn('[Server] 引擎初始化失敗:', err.message);
});

// 引擎事件 -> 廣播給前端
engine.on('log', (entry) => broadcast({ type: 'engine_log', data: entry }));
engine.on('orderFilled', (data) => broadcast({ type: 'order_filled', data }));
engine.on('positionClosed', (data) => broadcast({ type: 'position_closed', data }));

/* ─── WEBSOCKET PROXY ─────────────────────────────
   前端連到 ws://localhost:3000/ws
   伺服器再連到 wss://api.hyperliquid.xyz/ws
   解決瀏覽器 CORS / Mixed-content 問題
──────────────────────────────────────────────── */

let hlWs = null;
const clientSockets = new Set();

function connectHLWebSocket() {
  console.log('[WS Proxy] 連接 Hyperliquid WebSocket...');
  hlWs = new WebSocket(HL_WS);

  hlWs.on('open', () => {
    console.log('[WS Proxy] HL WebSocket 已連接');
    broadcast({ type: 'ws_status', status: 'connected' });
  });

  hlWs.on('message', (data) => {
    // 直接轉發給所有前端客戶端
    clientSockets.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    });
  });

  hlWs.on('close', () => {
    console.log('[WS Proxy] HL WebSocket 斷線，3 秒後重連...');
    broadcast({ type: 'ws_status', status: 'disconnected' });
    setTimeout(connectHLWebSocket, 3000);
  });

  hlWs.on('error', (err) => {
    console.error('[WS Proxy] 錯誤:', err.message);
  });
}

// 啟動 HL WebSocket 代理
connectHLWebSocket();

// 前端 WebSocket 連接
wss.on('connection', (clientWs, req) => {
  clientSockets.add(clientWs);
  console.log(`[WS] 前端連接，目前 ${clientSockets.size} 個客戶端`);

  // 傳送當前引擎狀態
  if (engineReady) {
    clientWs.send(JSON.stringify({
      type: 'engine_status',
      data: engine.getStatus(),
    }));
  }

  // 前端訂閱請求 -> 轉發到 HL WebSocket
  clientWs.on('message', (msg) => {
    try {
      const parsed = JSON.parse(msg);
      // 如果是 HL 訂閱請求，轉發給 HL WS
      if (parsed.method && hlWs?.readyState === WebSocket.OPEN) {
        hlWs.send(msg);
      }
      // 如果是引擎控制指令
      if (parsed.type === 'engine_command') {
        handleEngineCommand(clientWs, parsed);
      }
    } catch (_) {}
  });

  clientWs.on('close', () => {
    clientSockets.delete(clientWs);
  });
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  clientSockets.forEach(client => {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  });
}

/* ─── REST API ─── */

// 健康檢查
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    engineReady,
    wsConnected: hlWs?.readyState === WebSocket.OPEN,
    clients: clientSockets.size,
    timestamp: new Date().toISOString(),
  });
});

// 代理 Hyperliquid info endpoint（解決 CORS）
app.post('/api/hl/info', async (req, res) => {
  try {
    const response = await fetch(`${HL_REST}/info`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 取得引擎狀態
app.get('/api/engine/status', (req, res) => {
  res.json(engineReady ? engine.getStatus() : { error: '引擎未就緒' });
});

// 新增跟單設定
app.post('/api/engine/copy', (req, res) => {
  try {
    const config = req.body;
    if (!config.id || !config.traderAddress) {
      return res.status(400).json({ error: '缺少必要欄位' });
    }
    engine.addCopy(config);
    res.json({ success: true, id: config.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 停止跟單
app.delete('/api/engine/copy/:id', (req, res) => {
  engine.removeCopy(req.params.id);
  res.json({ success: true });
});

// 取得活動日誌
app.get('/api/engine/log', (req, res) => {
  res.json(engine.log.slice(0, 100));
});

// 取得當前持倉
app.get('/api/engine/positions', (req, res) => {
  res.json(Array.from(engine.positions.entries()).map(([k, v]) => ({
    key: k, ...v,
  })));
});

/* ─── 引擎指令處理（WebSocket） ─── */
function handleEngineCommand(clientWs, cmd) {
  switch (cmd.action) {
    case 'add_copy':
      try {
        engine.addCopy(cmd.config);
        clientWs.send(JSON.stringify({ type: 'command_result', success: true, action: 'add_copy' }));
      } catch (e) {
        clientWs.send(JSON.stringify({ type: 'command_result', success: false, error: e.message }));
      }
      break;
    case 'remove_copy':
      engine.removeCopy(cmd.id);
      clientWs.send(JSON.stringify({ type: 'command_result', success: true, action: 'remove_copy' }));
      break;
    case 'get_status':
      clientWs.send(JSON.stringify({ type: 'engine_status', data: engine.getStatus() }));
      break;
  }
}

/* ─── START ─── */
server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   HyperX Copy Trading Platform       ║
║   http://localhost:${PORT}              ║
║   WS Proxy: ws://localhost:${PORT}/ws   ║
╚══════════════════════════════════════╝
  `);
});
