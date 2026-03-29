/**
 * test_order.js
 *
 * 功能：
 * 1) 從 .env 讀取 AGENT_PRIVATE_KEY / MASTER_WALLET
 * 2) 查詢 Hyperliquid 帳戶餘額（先印出）
 * 3) 送出一筆 ETH-PERP 最小數量的「市價式」多單（IOC + 積極價格）
 *
 * 先安裝：
 * npm i @nktkas/hyperliquid viem
 */

const fs = require("fs");
const path = require("path");

const INFO_URL = "https://api.hyperliquid.xyz/info";
const SLIPPAGE = 0.01; // 1% 積極價格，模擬市價成交
const ORDER_NOTIONAL_USDC = 2; // 目標下單金額（USDC）

function readDotEnv(envPath) {
  const out = {};
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#")) continue;
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    const k = s.slice(0, eq).trim();
    const v = s.slice(eq + 1).trim();
    out[k] = v;
  }
  return out;
}

async function hlInfo(body) {
  const res = await fetch(INFO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Info API failed: HTTP ${res.status}`);
  }
  return res.json();
}

async function main() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    throw new Error("找不到 .env，請先建立並填入 AGENT_PRIVATE_KEY / MASTER_WALLET");
  }

  const env = readDotEnv(envPath);
  const AGENT_PRIVATE_KEY = env.AGENT_PRIVATE_KEY;
  const MASTER_WALLET = env.MASTER_WALLET;

  if (!AGENT_PRIVATE_KEY || !MASTER_WALLET) {
    throw new Error(".env 缺少 AGENT_PRIVATE_KEY 或 MASTER_WALLET");
  }

  let ExchangeClient;
  let HttpTransport;
  let privateKeyToAccount;
  try {
    ({ ExchangeClient, HttpTransport } = require("@nktkas/hyperliquid"));
    ({ privateKeyToAccount } = require("viem/accounts"));
  } catch (_) {
    throw new Error(
      "缺少套件：請先執行 `npm i @nktkas/hyperliquid viem` 後再重試。"
    );
  }

  // 1) 查餘額（先印）
  // 餘額查詢固定使用 MASTER_WALLET
  const state = await hlInfo({
    type: "clearinghouseState",
    user: MASTER_WALLET,
  });
  const accountValue = state?.marginSummary?.accountValue ?? "N/A";
  const withdrawable = state?.withdrawable ?? "N/A";

  console.log("=== 帳戶餘額確認 ===");
  console.log("MASTER_WALLET:", MASTER_WALLET);
  console.log("accountValue:", accountValue);
  console.log("withdrawable:", withdrawable);

  // 2) 取得 ETH 資產索引 + 現價
  const [meta, assetCtxs] = await hlInfo({ type: "metaAndAssetCtxs" });
  const ethIndex = meta.universe.findIndex((x) => x.name === "ETH");
  if (ethIndex < 0) {
    throw new Error("找不到 ETH 資產索引，無法下單。");
  }
  const markPx = Number(assetCtxs[ethIndex]?.markPx);
  if (!Number.isFinite(markPx) || markPx <= 0) {
    throw new Error("取得 ETH 現價失敗，無法下單。");
  }

  // Hyperliquid 沒有傳統 market 單，使用 IOC + 積極價格模擬市價
  const aggressiveBuyPx = (markPx * (1 + SLIPPAGE)).toFixed(2);

  console.log("\n=== 準備下單 ===");
  const rawSize = ORDER_NOTIONAL_USDC / markPx;
  // ETH perp 下單量固定 round 到小數點後 4 位
  const orderSize = Math.max(rawSize, 0.0001).toFixed(4);

  console.log("symbol: ETH-PERP");
  console.log("side: LONG (buy)");
  console.log("notional(USDC):", ORDER_NOTIONAL_USDC);
  console.log("size(ETH):", orderSize);
  console.log("markPx:", markPx);
  console.log("iocPrice:", aggressiveBuyPx);

  // 3) 下單
  const wallet = privateKeyToAccount(AGENT_PRIVATE_KEY);
  const exchange = new ExchangeClient({
    transport: new HttpTransport(),
    wallet,
    // 代理錢包代主錢包交易時帶上 master 地址
    vaultAddress: MASTER_WALLET,
  });

  const result = await exchange.order({
    orders: [
      {
        a: ethIndex, // ETH 資產 index
        b: true, // buy/long
        p: aggressiveBuyPx,
        s: orderSize,
        r: false,
        t: { limit: { tif: "Ioc" } }, // 市價式 IOC
      },
    ],
    grouping: "na",
  });

  console.log("\n=== 下單回應 ===");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => {
  console.error("[test_order] 失敗:", err.message);
  process.exit(1);
});

