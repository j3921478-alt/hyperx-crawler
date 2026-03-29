const http = require("http");
const fs = require("fs");
const path = require("path");
const { buildLeaderboard, loadDB } = require("./src/crawler_v2");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.resolve(__dirname, "public");
const INDEX_FILE = path.join(PUBLIC_DIR, "index.html");

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
};

function jsonResponse(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
  });
  res.end(JSON.stringify(data));
}

function sendText(res, statusCode, body) {
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function sendFile(res, filePath, method = "GET") {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });

  if (method === "HEAD") {
    res.end();
    return;
  }

  const stream = fs.createReadStream(filePath);
  stream.on("error", () => sendText(res, 500, "Internal Server Error"));
  stream.pipe(res);
}

function safeResolve(urlPath) {
  const decoded = decodeURIComponent((urlPath || "/").split("?")[0]);
  const rel = decoded === "/" ? "/index.html" : decoded;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!fullPath.startsWith(PUBLIC_DIR)) return null;
  return fullPath;
}

function handleApi(url, res) {
  const route = url.pathname;

  if (route === "/leaderboard") {
    const db = loadDB();
    const sortBy = url.searchParams.get("sortBy") || "totalPnl";
    const limit = parseInt(url.searchParams.get("limit"), 10) || 100;
    const minTrades = parseInt(url.searchParams.get("minTrades"), 10) || 10;
    const minWinRate = parseFloat(url.searchParams.get("minWinRate")) || 0;
    const maxDrawdown = parseFloat(url.searchParams.get("maxDrawdown")) || 100;

    const data = buildLeaderboard(db, {
      sortBy,
      limit,
      minTrades,
      minWinRate,
      maxDrawdown,
    });

    return jsonResponse(res, {
      data,
      total: data.length,
      dbSize: db.totalProcessed || 0,
      updatedAt: db.updatedAt,
    });
  }

  if (route.startsWith("/wallet/")) {
    const address = route.replace("/wallet/", "");
    const db = loadDB();
    const wallet = db.wallets[address];
    if (!wallet) return jsonResponse(res, { error: "找不到此錢包" }, 404);
    return jsonResponse(res, wallet);
  }

  if (route === "/stats") {
    const db = loadDB();
    const wallets = Object.values(db.wallets);
    return jsonResponse(res, {
      totalWallets: wallets.length,
      updatedAt: db.updatedAt,
      topPnl: wallets.length ? Math.max(...wallets.map((w) => w.totalPnl || 0)) : 0,
      avgWinRate: wallets.length
        ? wallets.reduce((s, w) => s + w.winRate, 0) / wallets.length
        : 0,
    });
  }

  return false;
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
    res.end();
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendText(res, 405, "Method Not Allowed");
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  // API 路由優先
  if (url.pathname === "/leaderboard" || url.pathname === "/stats" || url.pathname.startsWith("/wallet/")) {
    const handled = handleApi(url, res);
    if (handled !== false) return;
  }

  // 靜態檔案
  const filePath = safeResolve(url.pathname);
  if (!filePath) {
    sendText(res, 400, "Bad Request");
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (!err && stats.isFile()) {
      sendFile(res, filePath, req.method);
      return;
    }

    // SPA fallback: 找不到路徑時回傳 index.html
    fs.stat(INDEX_FILE, (indexErr, indexStats) => {
      if (indexErr || !indexStats.isFile()) {
        sendText(res, 404, "Not Found");
        return;
      }
      sendFile(res, INDEX_FILE, req.method);
    });
  });
});

server.listen(PORT, () => {
  console.log(`[SERVER] http://localhost:${PORT}`);
  console.log(`[SERVER] static root: ${PUBLIC_DIR}`);
  console.log("[SERVER] API: /leaderboard /wallet/:address /stats");
});

