/**
 * src/crawler.js — v2 修復版
 * 修正：最大回撤計算、只保留獲利錢包
 */

const fs   = require('fs');
const path = require('path');

const HL_REST  = 'https://api.hyperliquid.xyz/info';
const DB_PATH  = path.join(__dirname, '../data/wallets.json');
const LOG_PATH = path.join(__dirname, '../data/crawler.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch(_) {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function hlPost(body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(HL_REST, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (res.status === 429) {
        log(`限速，等待 ${(i+1)*3} 秒...`);
        await sleep((i+1) * 3000);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (e) {
      log(`請求失敗 (${i+1}/${retries}): ${e.message}`);
      if (i === retries - 1) throw e;
      await sleep(2000 * (i + 1));
    }
  }
}

/* ─── 從近期成交抓活躍錢包 ─── */
async function fetchActiveWallets() {
  log('從近期成交抓活躍錢包...');
  const coins = ['BTC','ETH','SOL','ARB','AVAX','DOGE','SUI','BNB','OP','HYPE'];
  const walletSet = new Set();

  for (const coin of coins) {
    try {
      const trades = await hlPost({ type: 'recentTrades', coin });
      if (Array.isArray(trades)) {
        trades.forEach(t => {
          if (t.users) t.users.forEach(u => { if (u) walletSet.add(u); });
        });
        log(`${coin}: 累計 ${walletSet.size} 個錢包`);
      }
      await sleep(300);
    } catch (e) {
      log(`${coin} 失敗: ${e.message}`);
    }
  }

  const list = Array.from(walletSet);
  log(`共找到 ${list.length} 個活躍錢包`);
  return list;
}

/* ─── 抓單一錢包歷史成交 ─── */
async function fetchWalletFills(address, daysBack = 30) {
  const startTime = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  try {
    const fills = await hlPost({
      type:      'userFillsByTime',
      user:      address,
      startTime: startTime,
    });
    return Array.isArray(fills) ? fills : [];
  } catch (e) {
    return [];
  }
}

/* ─── 計算錢包指標（修復版） ─── */
function analyzeWallet(address, fills) {
  if (!fills || fills.length < 3) return null;

  // 按時間排序
  const sorted = [...fills].sort((a, b) => a.time - b.time);

  // 只看有已實現盈虧的成交（真正的開平倉紀錄）
  const trades = sorted
    .filter(f => parseFloat(f.closedPnl || 0) !== 0)
    .map(f => ({
      pnl:  parseFloat(f.closedPnl),
      fee:  parseFloat(f.fee || 0),
      time: f.time,
      coin: f.coin,
      side: f.side === 'B' ? 'LONG' : 'SHORT',
    }));

  if (trades.length < 3) return null;

  // 累計 PnL 和手續費
  const totalPnl  = trades.reduce((s, t) => s + t.pnl, 0);
  const totalFees = sorted.reduce((s, f) => s + parseFloat(f.fee || 0), 0);

  // 勝率
  const winners  = trades.filter(t => t.pnl > 0);
  const losers   = trades.filter(t => t.pnl < 0);
  const winRate  = Math.round(winners.length / trades.length * 10000) / 100;

  // 平均盈虧
  const avgWin  = winners.length > 0
    ? winners.reduce((s,t) => s+t.pnl, 0) / winners.length : 0;
  const avgLoss = losers.length > 0
    ? Math.abs(losers.reduce((s,t) => s+t.pnl, 0) / losers.length) : 1;

  // 盈虧比
  const profitFactor = Math.round(avgWin / avgLoss * 100) / 100;

  // ─── 修復：最大回撤計算 ───
  // 用累計 PnL 曲線計算，而不是用百分比
  // 確保回撤永遠在 0–100% 之間
  let cumPnl = 0;
  let peak   = 0;
  let maxDD  = 0;

  for (const t of trades) {
    cumPnl += t.pnl;
    if (cumPnl > peak) peak = cumPnl;
    // 只有在有正收益之後才計算回撤
    if (peak > 0) {
      const dd = (peak - cumPnl) / peak * 100;
      if (dd > maxDD) maxDD = dd;
    }
  }
  // 限制在 0–100%
  maxDD = Math.min(100, Math.max(0, Math.round(maxDD * 100) / 100));

  // 夏普比率（簡化版）
  const dailyMap = {};
  trades.forEach(t => {
    const day = new Date(t.time).toDateString();
    dailyMap[day] = (dailyMap[day] || 0) + t.pnl;
  });
  const dailyReturns = Object.values(dailyMap);
  const avgReturn = dailyReturns.reduce((s,v) => s+v, 0) / (dailyReturns.length || 1);
  const variance  = dailyReturns.reduce((s,v) => s + Math.pow(v-avgReturn, 2), 0)
                    / (dailyReturns.length || 1);
  const stdDev    = Math.sqrt(variance);
  const sharpe    = stdDev > 0
    ? Math.round(avgReturn / stdDev * Math.sqrt(252) * 100) / 100
    : 0;

  // 主要交易幣種
  const coinCount = {};
  fills.forEach(f => { coinCount[f.coin] = (coinCount[f.coin]||0)+1; });
  const favCoin = Object.entries(coinCount).sort((a,b)=>b[1]-a[1])[0]?.[0] || '--';

  // 活躍天數
  const activeDays = Object.keys(dailyMap).length;

  return {
    address,
    totalPnl:     Math.round(totalPnl * 100) / 100,
    netPnl:       Math.round((totalPnl - totalFees) * 100) / 100,
    totalFees:    Math.round(totalFees * 100) / 100,
    winRate,
    tradeCount:   trades.length,
    fillCount:    fills.length,
    avgWin:       Math.round(avgWin * 100) / 100,
    avgLoss:      Math.round(avgLoss * 100) / 100,
    profitFactor,
    maxDrawdown:  maxDD,
    sharpe:       Math.max(-10, Math.min(10, sharpe)), // 限制在合理範圍
    favoriteCoin: favCoin,
    activeDays,
    lastTradeTime:  sorted[sorted.length-1]?.time || 0,
    firstTradeTime: sorted[0]?.time || 0,
    updatedAt:      Date.now(),
  };
}

/* ─── 資料庫 ─── */
function loadDB() {
  try {
    if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH,'utf8'));
  } catch(_) {}
  return { wallets: {}, updatedAt: null, totalProcessed: 0 };
}

function saveDB(db) {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

/* ─── 排行榜（只顯示獲利錢包） ─── */
function buildLeaderboard(db, options = {}) {
  const {
    sortBy      = 'totalPnl',
    minTrades   = 3,
    limit       = 100,
    minWinRate  = 0,
    maxDrawdown = 100,
    onlyProfit  = true,   // 只顯示獲利錢包
  } = options;

  return Object.values(db.wallets)
    .filter(w =>
      w.tradeCount  >= minTrades &&
      w.winRate     >= minWinRate &&
      w.maxDrawdown <= maxDrawdown &&
      (!onlyProfit || w.totalPnl > 0)  // 只保留獲利
    )
    .sort((a, b) => b[sortBy] - a[sortBy])
    .slice(0, limit)
    .map((w, i) => ({ rank: i+1, ...w }));
}

/* ─── 精選種子錢包（KOL + 推薦，優先爬取） ─── */
const SEED_WALLETS = [
  // Recommend
  '0xa312114b5795dff9b8db50474dd57701aa78ad1e',
  '0x418aa6bf98a2b2bc93779f810330d88cde488888',
  '0x99b1098d9d50aa076f78bd26ab22e6abd3710729',
  '0x8bae3527e5a33fa0cf184f37bc112d071463ab6d',
  '0x16bf84af3f85f8c8a97597bf2be549dfe0dee637',
  '0xfd97600ac44b3c4e20ac1a5f23e3b18d10fa5912',
  '0x9c2a2a966ed8e47f0c8b7e2ec2b91424f229f6a8',
  '0x5559da6ec434c5723d0ce9c4da7f29e3f8a3d43b',
  '0xab5e6f394951c28ab1873007e373202689cdbec3',
  '0xbaaaf6571ab7d571043ff1e313a9609a10637864',
  '0x4cb5f4d145cd16460932bbb9b871bb6fd5db97e3',
  '0x0284bbd3646b59740a167ef78a306028343f3806',
  '0x271ce82149c67fae0d2a39571707f382fe425014',
  '0xf770f371cc66499a89ae56aa84f9506e083f99ea',
  '0xf97ad6704baec104d00b88e0c157e2b7b3a1ddd1',
  '0x8feb3a7d8bf1e424679fc75753b363eba5ee8185',
  '0x8951485bff801fab6001e9091b413fd020e8d681',
  '0x7f55bd494bed4b4eed2064eccc1af75e9d76ad4b',
  '0xf94b346387ae5f1ae84bf10e36008cb552ca82d5',
  '0x13a0833e8201b37c161feb2df764159707f71409',
  // KOL
  '0x5b5d51203a0f9079f8aeb098a6523a13f298c060',
  '0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36',
  '0x0ddf9bae2af4b874b96d287a5ad42eb47138a902',
  '0x8def9f50456c6c4e37fa5d3d57f108ed23992dae',
  '0x71dfc07de32c2ebf1c4801f4b1c9e40b76d4a23d',
  '0xefd3ab65915e35105caa462442c9ecc1346728df',
  '0xcb58b8f5ec6d47985f0728465c25a08ef9ad2c7b',
  '0x9b83f16d0a6456f90a8a330f04c0ca1b2f0425b0',
  '0x856f049b70fc94d7155b5b27d8a4b3c36eaabfa6',
  '0xdae4df7207feb3b350e4284c8efe5f7dac37f637',
  '0x30d3ca3bed41c08e98fbdf671418421a76ee019a',
  '0xb78d97390a96a17fd2b58fedbeb3dd876c8f660a',
  '0x3e3868f5e6fd1b2c2b91b234436b46c0a5b1140c',
  '0x5078c2fbea2b2ad61bc840bc023e35fce56bedb6',
  '0x020ca66c30bec2c4fe3861a94e4db4a498a35872',
  '0x94d3735543ecb3d339064151118644501c933814',
];

/* ─── 主爬蟲 ─── */
async function crawl(options = {}) {
  const { maxWallets=100, delayMs=400, daysBack=30, minTrades=3 } = options;
  log(`===== 開始爬蟲 v2 maxWallets=${maxWallets} =====`);

  const db = loadDB();
  // 種子錢包優先，再補充近期活躍錢包
  const activeWallets = await fetchActiveWallets();
  const combined = [...new Set([...SEED_WALLETS, ...activeWallets])];
  const targets = combined.slice(0, maxWallets);
  log(`準備分析 ${targets.length} 個錢包`);

  let processed=0, skipped=0, errors=0;

  for (const addr of targets) {
    if (!addr || addr.length < 10) { skipped++; continue; }

    const existing = db.wallets[addr];
    if (existing && (Date.now() - existing.updatedAt) < 60*60*1000) {
      skipped++; continue;
    }

    try {
      const fills  = await fetchWalletFills(addr, daysBack);
      const result = analyzeWallet(addr, fills);

      if (result && result.tradeCount >= minTrades) {
        db.wallets[addr] = result;
        processed++;
        if (processed % 10 === 0) {
          log(`進度: ${processed} 分析 / ${skipped} 跳過 / ${errors} 錯誤`);
          saveDB(db);
        }
      } else {
        skipped++;
      }
    } catch(e) {
      errors++;
      log(`${addr.slice(0,10)}... 錯誤: ${e.message}`);
    }

    await sleep(delayMs);
  }

  db.updatedAt      = new Date().toISOString();
  db.totalProcessed = Object.keys(db.wallets).length;
  saveDB(db);

  // 顯示排行榜前 5
  const top5 = buildLeaderboard(db, { limit: 5 });
  log(`\n===== 獲利錢包排行榜 TOP 5 =====`);
  top5.forEach(w => {
    log(`#${w.rank} ${w.address.slice(0,12)}... PnL:$${w.totalPnl} 勝率:${w.winRate}% 回撤:${w.maxDrawdown}%`);
  });

  log(`\n===== 完成 分析:${processed} 跳過:${skipped} 錯誤:${errors} =====`);
  log(`資料庫總計: ${db.totalProcessed} 個錢包，其中獲利: ${top5.length > 0 ? buildLeaderboard(db).length : 0} 個`);
  return db;
}

async function runForever(intervalHours=1) {
  while (true) {
    try { await crawl({ maxWallets:200, delayMs:500, daysBack:30 }); }
    catch(e) { log(`錯誤: ${e.message}`); }
    log(`下次更新於 ${intervalHours} 小時後`);
    await sleep(intervalHours * 60 * 60 * 1000);
  }
}

module.exports = { crawl, buildLeaderboard, loadDB, analyzeWallet };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--forever') {
    runForever(1);
  } else {
    crawl({
      maxWallets: parseInt(args[0]) || 50,
      delayMs:    400,
      daysBack:   30,
    }).catch(console.error);
  }
}
