# Strategy: whale-print scalper

## What the dev window taught us

Measured on the kit's frozen 24h dev window (1,222 coins, 126,801 trades):

- Buying every launch loses to fees: the average coin bleeds ~4–5% in its first 600
  slots, and a round trip costs ~2.5% in curve fees plus two transaction fees.
- The house pilot baselines all lose on this window: momentum −9.49 SOL (95% drawdown),
  reversion −4.00 SOL, sniper −0.47 SOL.
- What separates the coins that run 2x from the rest is the opening tape: winners had
  a median of 8 distinct buyers (losers: 3), 11.5 SOL bought (losers: 3.1), and 8.2 SOL
  of real reserves at age 10 (losers: 2.2).
- The sharpest single signal is the largest single early buy: coins with one buy of
  0.5–2.5 SOL in their first slots, spread over ≥5 wallets, win 40% of trips at an
  average +0.021 SOL against −0.007 SOL average losses. A bigger single buy is usually
  the creator or a bundler about to dump; no buy that size means nobody with money
  cares yet.

## Rules

Entry — first buy decided while a coin is 3–10 slots old, only when all hold:

- real SOL reserves 3–100
- creator's own create-slot buy ≤ 2.5 SOL
- ≥ 3 trades, ≥ 5 distinct non-creator buyers
- largest single buy so far 0.5–2.5 SOL
- price already ≥ 1.05x its create price
- net flow over the last 20 slots ≥ 0
- buy 0.15 SOL (capped at 1% of real reserves), ≥ 0.005 SOL minimum, at most
  500 bps of buy slippage; one entry per coin, at most 5 open positions.

Exits — checked on every batch:

- +20% → sell half; the rest rides with a breakeven stop
- +100% → sell all
- −10% → sell all (breakeven after a partial take-profit)
- creator sells while held → sell all at once
- 600 slots held → sell all

## Local results (dev window, kit's own grader)

- Net PnL +0.23 SOL on the dev window (56 trips, 39% wins, max drawdown 1.7%),
  vs −0.47 SOL for the best house pilot (sniper) on the same window.
- The profit is concentrated, as it is for every strategy on this data: the top 3
  coins make ~all of the net PnL. That is the nature of pump.fun — many small
  bets, a few big winners — so the sizing stays small and the stops stay hard.
- Robustness: split-half on real data, −0.03 SOL on the first 12h and +0.30 SOL on
  the second 12h. Stress test on 20 rebuilt (reshuffled) copies: median −0.59 SOL,
  17 of 20 losing — the dev score leans on this window's own coins, so the final
  24h window is high-variance with positive skew.

## Determinism

The strategy is a pure function of the batches the harness sends: no clock, no
randomness, no I/O, no network. Two runs on the same data produce byte-identical
action logs.
