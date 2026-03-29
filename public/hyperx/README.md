# HyperX — Hyperliquid 跟單平台

即時跟單、智能錢包追蹤、深度交易分析，全部建立在 Hyperliquid 公開 API 上。

---

## 專案結構

```
hyperx/
├── public/
│   └── index.html          ← 前端（單頁應用）
├── engine/
│   └── copyEngine.js       ← 跟單引擎核心
├── lib/
│   └── hyperliquid.js      ← Hyperliquid API 封裝
├── server.js               ← Express + WebSocket 代理伺服器
├── vercel.json             ← Vercel 部署設定
├── package.json
└── .env.example            ← 環境變數範本
```

---

## 快速開始（本地開發）

### 1. 安裝依賴

```bash
npm install
```

### 2. 設定環境變數

```bash
cp .env.example .env
```

編輯 `.env`，填入你的設定：

```env
AGENT_PRIVATE_KEY=0x你的_Agent_Wallet_私鑰
MASTER_WALLET=0x你的主錢包地址
```

> ⚠️ Agent Wallet 產生方式：
> 1. 登入 app.hyperliquid.xyz
> 2. 點右上角頭像 → Settings → API
> 3. 點「Generate API Wallet」
> 4. 複製 Private Key 到 .env

### 3. 啟動伺服器

```bash
npm run dev
```

瀏覽器開啟 http://localhost:3000

---

## 部署到 Vercel（推薦）

### 方法一：Vercel CLI（最快）

```bash
# 安裝 Vercel CLI
npm i -g vercel

# 登入（首次需要）
vercel login

# 部署（在專案目錄執行）
vercel

# 設定環境變數
vercel env add AGENT_PRIVATE_KEY
vercel env add MASTER_WALLET

# 部署到生產環境
vercel --prod
```

完成後你會拿到一個 `https://你的專案名.vercel.app` 網址。

### 方法二：GitHub 自動部署

1. 將專案推到 GitHub：
```bash
git init
git add .
git commit -m "init hyperx platform"
git remote add origin https://github.com/你的帳號/hyperx
git push -u origin main
```

2. 到 vercel.com 登入 → Import Project → 選你的 GitHub repo
3. 在 Vercel dashboard 設定環境變數（Settings → Environment Variables）
4. 之後每次 `git push` 都會自動部署

---

## 跟單引擎使用方式

### 透過 REST API 新增跟單

```bash
curl -X POST http://localhost:3000/api/engine/copy \
  -H "Content-Type: application/json" \
  -d '{
    "id": "copy_001",
    "traderAddress": "0x目標交易者錢包地址",
    "mode": "ratio",
    "ratio": 10,
    "maxLeverage": 5,
    "minMargin": 200,
    "maxMargin": 5000,
    "takeProfitPct": 30,
    "stopLossPct": 10,
    "followOpen": true,
    "followClose": true
  }'
```

### 查詢引擎狀態

```bash
curl http://localhost:3000/api/engine/status
```

### 停止跟單

```bash
curl -X DELETE http://localhost:3000/api/engine/copy/copy_001
```

---

## WebSocket 連接方式（前端）

部署後，前端改用你自己的伺服器 WS（不直接連 Hyperliquid，解決 CORS）：

```javascript
// 舊的（直連 HL，有 CORS 問題）
const ws = new WebSocket('wss://api.hyperliquid.xyz/ws');

// 新的（透過你的伺服器代理）
const ws = new WebSocket('wss://你的網域.vercel.app/ws');

// 訂閱方式完全一樣
ws.send(JSON.stringify({
  method: 'subscribe',
  subscription: { type: 'allMids' }
}));
```

---

## 跟單設定參數說明

| 參數 | 說明 | 範例 |
|------|------|------|
| `mode` | 跟單模式 | `"ratio"` 或 `"fixed"` |
| `ratio` | 跟單比例 % (ratio 模式) | `10` = 帳戶 10% |
| `fixedAmount` | 固定金額 USDC (fixed 模式) | `500` |
| `maxLeverage` | 最大槓桿倍數 | `5` |
| `minMargin` | 最小保證金 USDC | `200` |
| `maxMargin` | 最大保證金 USDC | `5000` |
| `takeProfitPct` | 止盈百分比 | `30` = +30% |
| `stopLossPct` | 止損百分比 | `10` = -10% |
| `followOpen` | 跟開倉 | `true` |
| `followClose` | 跟平倉 | `true` |

---

## 安全注意事項

- `.env` 已加入 `.gitignore`，私鑰不會被上傳到 GitHub
- Agent Wallet 只有下單權限，無法提款，風險隔離
- 建議在 Hyperliquid 設定 Agent Wallet 的最大授權額度
- 正式上線前先在 Testnet 測試：`https://api.hyperliquid-testnet.xyz`

---

## Testnet 測試

將 `.env` 改為：

```env
HL_API_URL=https://api.hyperliquid-testnet.xyz
HL_WS_URL=wss://api.hyperliquid-testnet.xyz/ws
```

到 https://app.hyperliquid-testnet.xyz 領取測試 USDC，完全免費測試所有功能。

---

## 技術棧

- **前端**：Vanilla JS + WebSocket
- **後端**：Node.js + Express
- **WS 代理**：ws 套件
- **鏈上簽名**：ethers.js v6（EIP-712）
- **部署**：Vercel

---

## 授權

MIT License — 自由使用、修改、商業化。
