const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.resolve(__dirname, "public");

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

function send(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, { "Content-Type": contentType });
  res.end(body);
}

function safeResolvePublicPath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split("?")[0]);
  const relativePath = decodedPath === "/" ? "/index.html" : decodedPath;
  const fullPath = path.normalize(path.join(PUBLIC_DIR, relativePath));

  if (!fullPath.startsWith(PUBLIC_DIR)) return null;
  return fullPath;
}

const server = http.createServer((req, res) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "Method Not Allowed");
    return;
  }

  const filePath = safeResolvePublicPath(req.url || "/");
  if (!filePath) {
    send(res, 400, "Bad Request");
    return;
  }

  fs.stat(filePath, (statErr, stats) => {
    if (statErr || !stats.isFile()) {
      send(res, 404, "Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });

    if (req.method === "HEAD") {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on("error", () => send(res, 500, "Internal Server Error"));
    stream.pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`[STATIC] Serving ${PUBLIC_DIR}`);
  console.log(`[STATIC] http://localhost:${PORT}`);
});

