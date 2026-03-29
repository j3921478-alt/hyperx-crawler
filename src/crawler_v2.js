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

/* ─── 主爬蟲 ─── */
async function crawl(options = {}) {
  const { maxWallets=100, delayMs=400, daysBack=30, minTrades=3 } = options;
  log(`===== 開始爬蟲 v2 maxWallets=${maxWallets} =====`);

  const db = loadDB();
  const wallets = await fetchActiveWallets();
  const targets = wallets.slice(0, maxWallets);
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
