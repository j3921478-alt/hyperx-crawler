# HyperX 錢包爬蟲

從 Hyperliquid 鏈上抓取真實錢包數據，建立自己的排行榜。

---

## 三步驟上手

### 第一步：安裝 Node.js
到 https://nodejs.org 下載 LTS 版本，安裝後打開終端機：
```bash
node --version   # 應該看到 v18 以上
```

### 第二步：跑爬蟲（先抓 100 個錢包測試）
```bash
cd hyperx-crawler
npm run crawl
```
會看到類似輸出：
```
[2026-03-29] 抓取排行榜錢包列表...
[2026-03-29] 取得 200 個排行榜錢包
[2026-03-29] 進度: 10 個已分析...
[2026-03-29] 進度: 20 個已分析...
[2026-03-29] 爬蟲完成 分析: 87 | 跳過: 13
```
完成後 `data/wallets.json` 會有真實數據。

### 第三步：啟動 API
```bash
npm start
```
瀏覽器打開：http://localhost:3001/leaderboard

---

## 部署到 Railway（免費，24小時持續跑）

Railway 是最簡單的部署方式，免費額度夠用。

1. 到 https://railway.app 用 GitHub 登入
2. 點「New Project」→「Deploy from GitHub repo」
3. 選你的 repo（先把這個資料夾推到 GitHub）
4. Railway 自動偵測 Node.js 並部署
5. 點「Settings」→「Start Command」填入：
   ```
   node src/crawler.js --forever & node src/api.js
   ```
6. 部署完成後拿到一個網址，例如：
   `https://hyperx-crawler-production.up.railway.app`

然後前端的 `index.html` 裡把排行榜 API 改成這個網址即可。

---

## API 端點說明

```
GET /leaderboard
  ?sortBy=totalPnl     排序依據：totalPnl | winRate | sharpe | profitFactor
  ?limit=50            返回幾個
  ?minWinRate=60       最低勝率篩選（%）
  ?maxDrawdown=20      最大回撤上限（%）
  ?minTrades=10        最少交易次數

GET /wallet/0x錢包地址   查詢單一錢包詳情

GET /stats               整體統計
```

範例回應：
```json
{
  "data": [
    {
      "rank": 1,
      "address": "0x8f3a...",
      "totalPnl": 48320.5,
      "winRate": 78.3,
      "maxDrawdown": 6.1,
      "tradeCount": 312,
      "sharpe": 2.4,
      "favoriteCoin": "ETH",
      "lastTradeTime": 1711700000000
    }
  ],
  "total": 87,
  "dbSize": 87,
  "updatedAt": "2026-03-29T13:00:00.000Z"
}
```

---

## 常見問題

**Q: 爬蟲跑多久？**
100 個錢包約 2–3 分鐘，500 個約 10–15 分鐘。

**Q: 會被 Hyperliquid 封鎖嗎？**
每個請求間隔 400ms，遠低於他們的速率限制（每分鐘 1200 次），不會有問題。

**Q: 數據多久更新一次？**
`--forever` 模式每小時自動重跑一次。

**Q: 數據存在哪？**
`data/wallets.json`，純 JSON 文件，不需要安裝資料庫。
