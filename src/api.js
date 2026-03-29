/**
 * src/api.js
 * 排行榜 API 伺服器
 * 前端直接打這個 API 取得真實錢包數據
 */

const http = require('http');
// 使用 v2 爬蟲模組（crawler_v2.js）
const { buildLeaderboard, loadDB } = require('./crawler_v2');

const PORT = process.env.PORT || 3001;

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, {
    'Content-Type':  'application/json',
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
  });
  res.end(JSON.stringify(data));
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // GET /leaderboard?sortBy=totalPnl&limit=50&minWinRate=60
  if (path === '/leaderboard') {
    const db          = loadDB();
    const sortBy      = url.searchParams.get('sortBy')      || 'totalPnl';
    const limit       = parseInt(url.searchParams.get('limit'))       || 100;
    const minTrades   = parseInt(url.searchParams.get('minTrades'))   || 10;
    const minWinRate  = parseFloat(url.searchParams.get('minWinRate')) || 0;
    const maxDrawdown = parseFloat(url.searchParams.get('maxDrawdown'))|| 100;

    const leaderboard = buildLeaderboard(db, { sortBy, limit, minTrades, minWinRate, maxDrawdown });
    return jsonResponse(res, {
      data:      leaderboard,
      total:     leaderboard.length,
      dbSize:    db.totalProcessed || 0,
      updatedAt: db.updatedAt,
    });
  }

  // GET /wallet/0xabc...
  if (path.startsWith('/wallet/')) {
    const address = path.replace('/wallet/', '');
    const db      = loadDB();
    const wallet  = db.wallets[address];
    if (!wallet) return jsonResponse(res, { error: '找不到此錢包' }, 404);
    return jsonResponse(res, wallet);
  }

  // GET /stats
  if (path === '/stats') {
    const db = loadDB();
    const wallets = Object.values(db.wallets);
    return jsonResponse(res, {
      totalWallets:   wallets.length,
      updatedAt:      db.updatedAt,
      topPnl:         Math.max(...wallets.map(w => w.totalPnl || 0)),
      avgWinRate:     wallets.length
        ? wallets.reduce((s, w) => s + w.winRate, 0) / wallets.length
        : 0,
    });
  }

  jsonResponse(res, { error: 'Not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`[API] 排行榜 API 運行在 http://localhost:${PORT}`);
  console.log(`[API] 端點：`);
  console.log(`  GET /leaderboard?sortBy=totalPnl&limit=50`);
  console.log(`  GET /wallet/0x...`);
  console.log(`  GET /stats`);
});
