'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const { parseCsvLine, parseJournal, analyze, applyFilters } = require('../bin/trade-journal.js');
const BIN = path.join(__dirname, '..', 'bin', 'trade-journal.js');
const EXAMPLE = path.join(__dirname, '..', 'examples', 'journal.csv');

const SMALL = `date,symbol,side,pnl
2026-01-01,XAUUSD,long,100
2026-01-02,XAUUSD,short,-50
2026-01-03,EURUSD,long,200
2026-01-04,EURUSD,short,-50
2026-01-05,XAUUSD,long,0
`;

test('parseJournal reads rows and normalizes fields', () => {
  const trades = parseJournal(SMALL);
  assert.equal(trades.length, 5);
  assert.equal(trades[0].symbol, 'XAUUSD');
  assert.equal(trades[0].side, 'long');
  assert.equal(trades[0].pnl, 100);
  assert.equal(trades[0].date.iso, '2026-01-01');
});

test('parseCsvLine handles quoted commas and escaped quotes', () => {
  assert.deepEqual(parseCsvLine('2026-01-01,XAUUSD,long,100,"note, with comma"'),
    ['2026-01-01', 'XAUUSD', 'long', '100', 'note, with comma']);
  assert.deepEqual(parseCsvLine('"a""b",x'), ['a"b', 'x']);
});

test('parseJournal handles CRLF and BOM', () => {
  const t = parseJournal('\uFEFFdate,symbol,side,pnl\r\n2026-01-01,XAUUSD,long,10\r\n2026-01-02,XAUUSD,short,-5\r\n');
  assert.equal(t.length, 2);
  assert.equal(t[1].pnl, -5);
});

test('buy/sell are normalized to long/short', () => {
  const t = parseJournal('date,symbol,side,pnl\n2026-01-01,XAUUSD,buy,10\n2026-01-02,XAUUSD,sell,-5\n');
  assert.equal(t[0].side, 'long');
  assert.equal(t[1].side, 'short');
});

test('analyze computes win rate, profit factor, expectancy', () => {
  const s = analyze(parseJournal(SMALL));
  assert.equal(s.trades, 5);
  assert.equal(s.wins, 2);
  assert.equal(s.losses, 2);
  assert.equal(s.breakeven, 1);
  assert.equal(s.winRate, 0.4);
  assert.equal(s.grossProfit, 300);
  assert.equal(s.grossLoss, 100);
  assert.equal(s.net, 200);
  assert.equal(s.profitFactor, 3);
  assert.equal(s.avgWin, 150);
  assert.equal(s.avgLoss, 50);
  assert.equal(s.expectancy, 40);
});

test('analyze computes max drawdown from the equity curve', () => {
  const s = analyze(parseJournal(SMALL));
  // Equity: 100 -> 50 -> 250 -> 200 -> 200. Max drawdown 50, first seen
  // from the peak of 100, so 50%.
  assert.equal(s.maxDrawdown, 50);
  assert.equal(s.maxDrawdownPct, 0.5);
  // Deeper drawdown: equity 100 -> -50 -> 0, peak 100, drawdown 150 (150%).
  const s2 = analyze(parseJournal(
    'date,symbol,side,pnl\n2026-01-01,XAUUSD,long,100\n2026-01-02,XAUUSD,short,-150\n2026-01-03,XAUUSD,long,50\n'));
  assert.equal(s2.maxDrawdown, 150);
  assert.equal(s2.maxDrawdownPct, 1.5);
});

test('analyze finds streaks and best/worst trades', () => {
  const s = analyze(parseJournal(
    'date,symbol,side,pnl\n2026-01-01,XAUUSD,long,10\n2026-01-02,XAUUSD,long,20\n2026-01-03,XAUUSD,short,-5\n2026-01-04,XAUUSD,short,-6\n2026-01-05,XAUUSD,short,-7\n'));
  assert.equal(s.longestWinStreak, 2);
  assert.equal(s.longestLossStreak, 3);
  assert.equal(s.bestTrade.pnl, 20);
  assert.equal(s.worstTrade.pnl, -7);
});

test('analyze aggregates per symbol and per month', () => {
  const s = analyze(parseJournal(SMALL));
  const xau = s.perSymbol.find((x) => x.symbol === 'XAUUSD');
  const eur = s.perSymbol.find((x) => x.symbol === 'EURUSD');
  assert.equal(xau.trades, 3);
  assert.equal(xau.net, 50);
  assert.equal(eur.net, 150);
  assert.equal(s.monthly.length, 1);
  assert.equal(s.monthly[0].month, '2026-01');
  assert.equal(s.monthly[0].net, 200);
});

test('profit factor is null (JSON-safe) when there are no losing trades', () => {
  const s = analyze(parseJournal('date,symbol,side,pnl\n2026-01-01,XAUUSD,long,10\n2026-01-02,XAUUSD,long,20\n'));
  assert.equal(s.profitFactor, null);
  assert.equal(s.grossLoss, 0);
});

test('parseJournal rejects missing column, bad pnl, bad date, bad side', () => {
  assert.throws(() => parseJournal('date,symbol,side\n2026-01-01,XAUUSD,long\n'), /missing required column "pnl"/);
  assert.throws(() => parseJournal('date,symbol,side,pnl\n2026-01-01,XAUUSD,long,abc\n'), /line 2: invalid pnl/);
  assert.throws(() => parseJournal('date,symbol,side,pnl\n2026-13-01,XAUUSD,long,10\n'), /line 2: invalid date/);
  assert.throws(() => parseJournal('date,symbol,side,pnl\n2026-01-01,XAUUSD,hold,10\n'), /line 2: invalid side/);
});

test('parseJournal rejects empty input and header-only input', () => {
  assert.throws(() => parseJournal(''), /empty input/);
  assert.throws(() => parseJournal('date,symbol,side,pnl\n'), /no trade rows found/);
});

test('applyFilters filters by symbol and date range', () => {
  const trades = parseJournal(SMALL);
  assert.equal(applyFilters(trades, { symbol: 'EURUSD' }).length, 2);
  assert.equal(applyFilters(trades, { from: '2026-01-03', to: '2026-01-04' }).length, 2);
  assert.equal(applyFilters(trades, { symbol: 'XAUUSD', from: '2026-01-02' }).length, 2);
});

function runCli(args, input) {
  return spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', input });
}

test('e2e: CLI prints a table for the example journal', () => {
  const r = runCli([EXAMPLE]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Trade journal summary/);
  assert.match(r.stdout, /Win rate/);
  assert.match(r.stdout, /Profit factor/);
  assert.match(r.stdout, /Per symbol/);
  assert.match(r.stdout, /XAUUSD/);
});

test('e2e: --json outputs valid JSON with the right counts', () => {
  const r = runCli([EXAMPLE, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.trades, 20);
  assert.equal(data.perSymbol.length, 3);
  assert.equal(data.monthly.length, 2);
  assert.equal(typeof data.winRate, 'number');
});

test('e2e: stdin works and --symbol filters', () => {
  const r = runCli(['--json', '--symbol', 'XAUUSD'], SMALL);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.trades, 3);
  assert.equal(data.perSymbol.length, 1);
  assert.equal(data.perSymbol[0].symbol, 'XAUUSD');
});

test('e2e: no matching trades is a runtime error (exit 1)', () => {
  const r = runCli(['--symbol', 'NOPE', EXAMPLE]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no trades match/);
});

test('e2e: missing file exits 1, unknown option exits 2', () => {
  const missing = runCli(['nope.csv']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /file not found/);
  const badOpt = runCli(['--nope', EXAMPLE]);
  assert.equal(badOpt.status, 2);
  assert.match(badOpt.stderr, /unknown option/);
});

test('e2e: --help and --version exit 0', () => {
  assert.equal(runCli(['--help']).status, 0);
  assert.match(runCli(['--help']).stdout, /Usage:/);
  assert.match(runCli(['--version']).stdout, /trade-journal 1\.0\.0/);
});
