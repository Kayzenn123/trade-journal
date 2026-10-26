#!/usr/bin/env node
/**
 * trade-journal — analyze a trading journal CSV into performance stats.
 * Single file, zero dependencies, Node >= 18. Works offline and on Termux.
 *
 * Input CSV columns (header row, case-insensitive; extra columns ignored):
 *   date,symbol,side,pnl
 * - date: YYYY-MM-DD (also accepts YYYY/MM/DD)
 * - symbol: e.g. XAUUSD, EURUSD, BTCUSD
 * - side: long | short (buy/sell accepted, normalized)
 * - pnl: net profit/loss in account currency (negative = loss)
 *
 * Usage:
 *   trade-journal journal.csv [--symbol XAUUSD] [--from 2026-01-01] [--to 2026-03-31]
 *   cat journal.csv | trade-journal [--json]
 */
'use strict';

const fs = require('fs');

const VERSION = '1.0.0';
const REQUIRED_COLUMNS = ['date', 'symbol', 'side', 'pnl'];

/* ------------------------------------------------------------------ */
/* CSV parsing (handles quoted fields, embedded commas, CRLF)          */
/* ------------------------------------------------------------------ */

function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map((f) => f.trim());
}

function parseDate(raw, lineNo) {
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})$/.exec(raw.trim());
  if (!m) throw new Error(`line ${lineNo}: invalid date "${raw}" (expected YYYY-MM-DD)`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new Error(`line ${lineNo}: invalid date "${raw}"`);
  }
  return { iso: `${m[1]}-${m[2]}-${m[3]}`, month: `${m[1]}-${m[2]}`, time: d.getTime() };
}

function normalizeSide(raw, lineNo) {
  const s = raw.trim().toLowerCase();
  if (s === 'long' || s === 'buy') return 'long';
  if (s === 'short' || s === 'sell') return 'short';
  throw new Error(`line ${lineNo}: invalid side "${raw}" (expected long/short)`);
}

function parseJournal(text) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  if (lines.length === 0) throw new Error('empty input: expected a CSV header row');
  const header = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = {};
  for (const col of REQUIRED_COLUMNS) {
    const i = header.indexOf(col);
    if (i === -1) {
      throw new Error(`missing required column "${col}" (header must include: ${REQUIRED_COLUMNS.join(', ')})`);
    }
    idx[col] = i;
  }
  const trades = [];
  for (let n = 1; n < lines.length; n++) {
    const lineNo = n + 1;
    const row = parseCsvLine(lines[n]);
    if (row.length < header.length) {
      throw new Error(`line ${lineNo}: expected ${header.length} fields, got ${row.length}`);
    }
    const pnlRaw = row[idx.pnl];
    if (pnlRaw === '' || pnlRaw === undefined) throw new Error(`line ${lineNo}: empty pnl`);
    const pnl = Number(pnlRaw);
    if (!Number.isFinite(pnl)) throw new Error(`line ${lineNo}: invalid pnl "${pnlRaw}" (expected a number)`);
    const symbol = row[idx.symbol];
    if (!symbol) throw new Error(`line ${lineNo}: empty symbol`);
    trades.push({
      date: parseDate(row[idx.date], lineNo),
      symbol: symbol.toUpperCase(),
      side: normalizeSide(row[idx.side], lineNo),
      pnl,
      order: n,
    });
  }
  if (trades.length === 0) throw new Error('no trade rows found (header only?)');
  // Chronological order for the equity curve; stable for same-day trades.
  trades.sort((a, b) => (a.date.time - b.date.time) || (a.order - b.order));
  return trades;
}

/* ------------------------------------------------------------------ */
/* Statistics                                                          */
/* ------------------------------------------------------------------ */

function profitFactor(grossProfit, grossLoss) {
  if (grossLoss === 0) return grossProfit > 0 ? Infinity : null;
  return grossProfit / grossLoss;
}

function analyze(trades) {
  const total = trades.length;
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  let net = 0;
  let best = trades[0];
  let worst = trades[0];
  let winStreak = 0;
  let lossStreak = 0;
  let maxWinStreak = 0;
  let maxLossStreak = 0;

  // Equity curve / max drawdown.
  let equity = 0;
  let peak = 0;
  let peakDate = null;
  let maxDd = 0;
  let maxDdPct = null;
  let maxDdPeakDate = null;

  const bySymbol = new Map();
  const byMonth = new Map();

  for (const t of trades) {
    net += t.pnl;
    if (t.pnl > 0) {
      wins++;
      grossProfit += t.pnl;
      winStreak++;
      lossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, winStreak);
    } else if (t.pnl < 0) {
      losses++;
      grossLoss += -t.pnl;
      lossStreak++;
      winStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, lossStreak);
    } else {
      breakeven++;
      winStreak = 0;
      lossStreak = 0;
    }
    if (t.pnl > best.pnl) best = t;
    if (t.pnl < worst.pnl) worst = t;

    equity += t.pnl;
    if (equity > peak) {
      peak = equity;
      peakDate = t.date.iso;
    }
    const dd = peak - equity;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = peak > 0 ? dd / peak : null;
      maxDdPeakDate = peakDate;
    }

    if (!bySymbol.has(t.symbol)) bySymbol.set(t.symbol, { symbol: t.symbol, trades: 0, wins: 0, grossProfit: 0, grossLoss: 0, net: 0 });
    const s = bySymbol.get(t.symbol);
    s.trades++;
    if (t.pnl > 0) { s.wins++; s.grossProfit += t.pnl; }
    if (t.pnl < 0) s.grossLoss += -t.pnl;
    s.net += t.pnl;

    if (!byMonth.has(t.date.month)) byMonth.set(t.date.month, { month: t.date.month, trades: 0, net: 0 });
    const m = byMonth.get(t.date.month);
    m.trades++;
    m.net += t.pnl;
  }

  const perSymbol = [...bySymbol.values()]
    .map((s) => ({
      symbol: s.symbol,
      trades: s.trades,
      wins: s.wins,
      winRate: s.trades ? s.wins / s.trades : 0,
      net: round2(s.net),
      profitFactor: pfJson(profitFactor(s.grossProfit, s.grossLoss)),
    }))
    .sort((a, b) => b.net - a.net);

  const monthly = [...byMonth.values()]
    .map((m) => ({ month: m.month, trades: m.trades, net: round2(m.net) }))
    .sort((a, b) => (a.month < b.month ? -1 : 1));

  return {
    trades: total,
    wins,
    losses,
    breakeven,
    winRate: total ? wins / total : 0,
    grossProfit: round2(grossProfit),
    grossLoss: round2(grossLoss),
    net: round2(net),
    profitFactor: pfJson(profitFactor(grossProfit, grossLoss)),
    avgWin: wins ? round2(grossProfit / wins) : null,
    avgLoss: losses ? round2(grossLoss / losses) : null,
    expectancy: total ? round2(net / total) : null,
    maxDrawdown: round2(maxDd),
    maxDrawdownPct: maxDdPct === null ? null : round4(maxDdPct),
    maxDrawdownPeakDate: maxDdPeakDate,
    longestWinStreak: maxWinStreak,
    longestLossStreak: maxLossStreak,
    bestTrade: { date: best.date.iso, symbol: best.symbol, side: best.side, pnl: round2(best.pnl) },
    worstTrade: { date: worst.date.iso, symbol: worst.symbol, side: worst.side, pnl: round2(worst.pnl) },
    perSymbol,
    monthly,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }
function round4(n) { return Math.round(n * 10000) / 10000; }
function pfJson(pf) { return pf === Infinity ? null : (pf === null ? null : round2(pf)); }

function applyFilters(trades, { symbol, from, to }) {
  let out = trades;
  if (symbol) out = out.filter((t) => t.symbol === symbol.toUpperCase());
  if (from) out = out.filter((t) => t.date.iso >= from);
  if (to) out = out.filter((t) => t.date.iso <= to);
  return out;
}

/* ------------------------------------------------------------------ */
/* Output                                                              */
/* ------------------------------------------------------------------ */

function fmtMoney(n) {
  if (n === null || n === undefined) return '-';
  const sign = n < 0 ? '-' : '';
  return sign + Math.abs(n).toFixed(2);
}

function fmtPct(ratio) {
  if (ratio === null || ratio === undefined) return '-';
  return (ratio * 100).toFixed(1) + '%';
}

function fmtPf(pf) {
  if (pf === null || pf === undefined) return '-';
  if (pf === Infinity) return 'inf';
  return pf.toFixed(2);
}

function pad(s, w) { return String(s).padEnd(w); }

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  return rows.map((r) => r.map((c, i) => (i === 0 ? pad(c, widths[i]) : String(c).padStart(widths[i]))).join('  ')).join('\n');
}

function renderText(stats, filters) {
  const pf = stats.profitFactor === null && stats.grossLoss === 0 && stats.grossProfit > 0 ? Infinity : stats.profitFactor;
  const lines = [];
  lines.push('Trade journal summary');
  if (filters.symbol || filters.from || filters.to) {
    const parts = [];
    if (filters.symbol) parts.push(`symbol=${filters.symbol.toUpperCase()}`);
    if (filters.from) parts.push(`from=${filters.from}`);
    if (filters.to) parts.push(`to=${filters.to}`);
    lines.push(`Filters: ${parts.join(' ')}`);
  }
  lines.push('');
  lines.push(table([
    ['Trades', stats.trades],
    ['Wins / Losses / BE', `${stats.wins} / ${stats.losses} / ${stats.breakeven}`],
    ['Win rate', fmtPct(stats.winRate)],
    ['Net P&L', fmtMoney(stats.net)],
    ['Gross profit', fmtMoney(stats.grossProfit)],
    ['Gross loss', fmtMoney(stats.grossLoss)],
    ['Profit factor', fmtPf(pf)],
    ['Avg win', fmtMoney(stats.avgWin)],
    ['Avg loss', fmtMoney(stats.avgLoss)],
    ['Expectancy / trade', fmtMoney(stats.expectancy)],
    ['Max drawdown', `${fmtMoney(stats.maxDrawdown)}${stats.maxDrawdownPct !== null ? ` (${fmtPct(stats.maxDrawdownPct)})` : ''}`],
    ['Longest win streak', stats.longestWinStreak],
    ['Longest loss streak', stats.longestLossStreak],
    ['Best trade', `${fmtMoney(stats.bestTrade.pnl)} (${stats.bestTrade.date} ${stats.bestTrade.symbol} ${stats.bestTrade.side})`],
    ['Worst trade', `${fmtMoney(stats.worstTrade.pnl)} (${stats.worstTrade.date} ${stats.worstTrade.symbol} ${stats.worstTrade.side})`],
  ]));
  lines.push('');
  lines.push('Per symbol');
  lines.push(table([
    ['Symbol', 'Trades', 'Win rate', 'Net P&L', 'PF'],
    ...stats.perSymbol.map((s) => [s.symbol, s.trades, fmtPct(s.winRate), fmtMoney(s.net), fmtPf(s.profitFactor === null && s.net > 0 ? Infinity : s.profitFactor)]),
  ]));
  lines.push('');
  lines.push('Per month');
  lines.push(table([
    ['Month', 'Trades', 'Net P&L'],
    ...stats.monthly.map((m) => [m.month, m.trades, fmtMoney(m.net)]),
  ]));
  return lines.join('\n') + '\n';
}

/* ------------------------------------------------------------------ */
/* CLI                                                                 */
/* ------------------------------------------------------------------ */

const HELP = `trade-journal ${VERSION} — analyze a trading journal CSV

Usage:
  trade-journal [file.csv] [options]
  cat file.csv | trade-journal [options]

Options:
  --symbol SYM        only include this symbol (e.g. XAUUSD)
  --from YYYY-MM-DD   only trades on/after this date
  --to YYYY-MM-DD     only trades on/before this date
  --json              output machine-readable JSON instead of tables
  --help              show this help
  --version           show version

CSV format (header row required, extra columns ignored):
  date,symbol,side,pnl
  2026-10-01,XAUUSD,long,125.50

Exit codes: 0 ok, 1 runtime error, 2 usage error.
`;

function parseArgs(argv) {
  const opts = { file: null, symbol: null, from: null, to: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help') { process.stdout.write(HELP); process.exit(0); }
    if (a === '--version') { process.stdout.write(`trade-journal ${VERSION}\n`); process.exit(0); }
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--symbol' || a === '--from' || a === '--to') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw usageError(`option ${a} needs a value`);
      opts[a.slice(2)] = v;
      continue;
    }
    if (a.startsWith('--')) throw usageError(`unknown option: ${a}`);
    if (a.startsWith('-') && a !== '-') throw usageError(`unknown option: ${a}`);
    if (opts.file) throw usageError('only one input file is allowed');
    opts.file = a;
  }
  if (opts.from && !/^\d{4}-\d{2}-\d{2}$/.test(opts.from)) throw usageError('--from must be YYYY-MM-DD');
  if (opts.to && !/^\d{4}-\d{2}-\d{2}$/.test(opts.to)) throw usageError('--to must be YYYY-MM-DD');
  return opts;
}

function usageError(msg) {
  const e = new Error(msg);
  e.code = 'USAGE';
  return e;
}

function readInput(file) {
  if (file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw Object.assign(new Error(`file not found: ${file}`), { code: 'RUNTIME' });
      throw Object.assign(new Error(`cannot read ${file}: ${err.message}`), { code: 'RUNTIME' });
    }
  }
  if (process.stdin.isTTY) {
    throw usageError('no input: give a CSV file or pipe CSV on stdin (see --help)');
  }
  return fs.readFileSync(0, 'utf8');
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    const text = readInput(opts.file);
    const trades = parseJournal(text);
    const filtered = applyFilters(trades, opts);
    if (filtered.length === 0) throw Object.assign(new Error('no trades match the given filters'), { code: 'RUNTIME' });
    const stats = analyze(filtered);
    if (opts.json) {
      process.stdout.write(JSON.stringify({ filters: { symbol: opts.symbol, from: opts.from, to: opts.to }, ...stats }, null, 2) + '\n');
    } else {
      process.stdout.write(renderText(stats, opts));
    }
  } catch (err) {
    if (err.code === 'USAGE') {
      process.stderr.write(`error: ${err.message}\nRun with --help for usage.\n`);
      process.exit(2);
    }
    process.stderr.write(`error: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = { parseCsvLine, parseJournal, analyze, applyFilters, VERSION };

if (require.main === module) main();
