# Sharpe Sprint — Steady Momentum Scalper

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/samidyt/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-makefun/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/samidyt/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-makefun/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the [make.fun](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
**"Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins"** bounty. One strategy
program, `main.ts` on Node 22, trading paper money on a 6-hour pump.fun
forward replay. Places go by hourly Sharpe ratio — steady, controlled gains
beat one lucky moonshot.

## Strategy

Hourly Sharpe rewards smooth, repeatable gains, so the bot trades lots of
fresh coins in small, equal stakes, banks quick winners, and cuts losers
fast. It never chases a vertical move and never holds a coin for long.

- **Entry:** a coin becomes a candidate on its CreateEvent. It is bought
  once its tape shows real, broad buying — net SOL flowing in over a 60-slot
  window (≥ 0.8 SOL), ≥ 3 buy trades from ≥ 5 distinct buyers, price up
  ≥ 4% from creation and sitting within 5% of its window high — while its
  real SOL reserve is between 2 and 60 SOL and it is at least 300 slots old
  (fresh curves are mostly dumps). First buy is 0.05 SOL.
- **Pyramid:** up to 3 adds of 0.15 SOL (max 0.5 SOL per position) while the
  position is ≥ 5% up and inflow is still positive.
- **Exit (whole position, first trigger wins):** take-profit +25% on cost,
  stop-loss −10% on cost, trailing stop 20% below the peak once +5% up, a
  fade exit when window net inflow turns negative, or a 1500-slot time-stop.
  The replay closes completed curves and flattens leftovers itself.
- **Guardrail:** the entry needs round trips of ≥ 0.01 SOL on ≥ 20 distinct
  mints. If the round-trip pace lags halfway through the 6-hour window
  (judged from the events' own block times), the bot buys small 0.012 SOL
  probes of the most liquid active curves and exits them on a ±4% move.

Deterministic by construction: no clock, no environment, no randomness —
every decision comes from the batch stream, so two runs produce identical
action logs.

## Dev-grade results (kit local grader, process driver)

| Version | Net PnL | Sharpe (hourly) | Max drawdown | Round trips | Win rate |
| --- | --- | --- | --- | --- | --- |
| v4 (final) | −0.220 SOL | −0.155 | 4.2% | 82 | 18.3% |

The dev window is harsh — every house pilot baseline loses on it too
(momentum −9.44 SOL, reversion −3.99 SOL, sniper −0.50 SOL). This entry is
the closest to breakeven of the four, with the lowest drawdown, and meets
all guardrails (76 coins with qualifying round trips, drawdown ≤ 50%).

## Layout

- `main.ts` — the entrypoint: the strategy, run as `node /bot/main.ts`
- `vendor/makefun-bot.ts` — the kit's bot SDK shim, unchanged
- `LICENSE` — MIT

## License

MIT — see `LICENSE`.
