# trade-journal

> Analyze a trading journal CSV into win rate, profit factor, drawdown and per-symbol stats. Daily Tools #20.

## Why

Traders keep a journal of every trade, but a spreadsheet full of rows does
not answer the one question that matters: "am I actually profitable, or
just lucky?" Existing analyzers (e.g. `AHKH86/trade-journal-analyzer`,
a small Python report generator) produce a report file; `trade-journal`
is different — it is a single-file, zero-dependency Node CLI that reads
from a file or straight from stdin, prints the answer as a terminal table
or `--json` for scripts, and runs on Termux/Android with nothing to
install. Pipe an MT5 export in, get the verdict out.

## Install

```bash
git clone https://github.com/Kayzenn123/trade-journal.git
cd trade-journal
# no dependencies — Node >= 18 is all you need
```

Requires: Node >= 18.

## Usage

```bash
node bin/trade-journal.js examples/journal.csv
node bin/trade-journal.js examples/journal.csv --symbol XAUUSD --json
cat examples/journal.csv | node bin/trade-journal.js --from 2026-09-01 --to 2026-09-30
trade-journal --help
```

Input CSV (header row required, extra columns are ignored):

```csv
date,symbol,side,pnl
2026-10-01,XAUUSD,long,125.50
2026-10-02,XAUUSD,short,-80.00
```

`pnl` is the net profit/loss per trade in account currency (negative =
loss). `side` accepts `long`/`short` (or `buy`/`sell`).

| Flag | Function | Default |
| --- | --- | --- |
| `[file]` | CSV file to read (omit to read stdin) | stdin |
| `--symbol SYM` | Only include this symbol | all |
| `--from YYYY-MM-DD` | Only trades on/after this date | none |
| `--to YYYY-MM-DD` | Only trades on/before this date | none |
| `--json` | Machine-readable JSON output | table |
| `--help` | Show help | — |
| `--version` | Show version | — |

Exit codes: 0 ok, 1 runtime error (missing file, bad CSV), 2 usage error.

## Example output

Command:

```bash
node bin/trade-journal.js examples/journal.csv
```

Output (real, copied from an actual run):

```text
Trade journal summary

Trades                                              20
Wins / Losses / BE                          12 / 7 / 1
Win rate                                         60.0%
Net P&L                                         971.10
Gross profit                                   1690.55
Gross loss                                      719.45
Profit factor                                     2.35
Avg win                                         140.88
Avg loss                                        102.78
Expectancy / trade                               48.56
Max drawdown                            265.40 (45.6%)
Longest win streak                                   3
Longest loss streak                                  1
Best trade             320.00 (2026-09-09 BTCUSD long)
Worst trade          -210.40 (2026-09-15 BTCUSD short)

Per symbol
Symbol  Trades  Win rate  Net P&L    PF
XAUUSD      11     63.6%   705.40  2.83
BTCUSD       4     50.0%   167.20  1.56
EURUSD       5     60.0%    98.50  3.76

Per month
Month    Trades  Net P&L
2026-09      15   670.75
2026-10       5   300.35
```

Filtered to one symbol as JSON (`--symbol XAUUSD --json`, excerpt from a real run):

```json
{
  "filters": { "symbol": "XAUUSD", "from": null, "to": null },
  "trades": 11,
  "wins": 7,
  "losses": 4,
  "winRate": 0.6363636363636364,
  "net": 705.4,
  "profitFactor": 2.83,
  "maxDrawdown": 150,
  "maxDrawdownPct": 0.5871
}
```

## How it works

1. A small hand-written CSV parser reads the file or stdin (quoted
   fields, embedded commas, CRLF and BOM handled), validates the
   `date,symbol,side,pnl` columns, and reports the exact line number of
   any bad row.
2. Trades are sorted chronologically and walked once to build the
   equity curve, from which max drawdown (value and percent of peak)
   is derived; wins, losses, profit factor, expectancy, streaks and
   best/worst trades are tallied in the same pass.
3. Results are aggregated per symbol and per month (`YYYY-MM`), then
   rendered as aligned tables or as JSON.

Files: `bin/trade-journal.js` (single file, ~410 lines, Node stdlib
only), `test/trade-journal.test.js`, `examples/journal.csv`.

## Limitations

- Reads `pnl` as given; it does not compute P&L from entry/exit prices
  or lot size, and it does not know commissions unless they are already
  included in `pnl`.
- Max drawdown is computed from the order of trades in the journal, not
  from intraday equity — a losing trade that recovered intraday still
  counts at its close.
- `profitFactor` is `null` in JSON when there are no losing trades
  (mathematically infinite); the table shows `inf` in that case.
- Dates must be `YYYY-MM-DD` (or `YYYY/MM/DD`); timestamps and
  timezones are not supported.
- No live broker connection and no order execution — analysis only.

## Disclaimer

This tool analyzes past trades from a CSV file. It is not investment
advice, and backtest/journal statistics do not guarantee future results.
A good profit factor in your journal says nothing about your next trade.

## Development

```bash
npm test
```

## License

MIT

---
Ringkasan (Bahasa Indonesia): trade-journal menganalisis file CSV jurnal trading menjadi statistik performa — win rate, profit factor, expectancy, max drawdown, streak menang/kalah, plus rincian per simbol dan per bulan. Cara pakai: `node bin/trade-journal.js jurnal.csv`, atau pipe dari stdin, dengan filter `--symbol`, `--from`, `--to`, dan output `--json` untuk mesin. Batasannya: tool ini hanya membaca kolom `pnl` apa adanya (tidak menghitung dari harga entry/exit), dan hanya untuk analisis — bukan saran investasi dan tidak mengeksekusi order.
