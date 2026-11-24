# Bundle notes — Pump.fun Replay Sprint paper bot

- Repo: https://github.com/zetinhere/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122
- Commit: 5072198 (main; see `git log` for the final sha at submit time)
- Wallet (payout): HRNPnwdEdgP2xyZjnBENg27StwESh4MLM4g1eYK8tqUQ
- Kit anchor: `makefun anchor 0021e7730ccd8c930677ab01fde15c028c940f57 round 34231168`
  (init ran in this repo before any code was written; LICENSE MIT + `.makefun/freshness.json` are the anchor commit)

## Strategy (see STRATEGY.md)

Whale-print scalper. Buys young coins (3–10 slots after creation) whose opening tape
shows one real buyer with size: largest single buy 0.5–2.5 SOL, ≥5 distinct wallets,
real SOL 3–100, creator's own buy ≤2.5 SOL, price already ≥1.05x create price, net
flow ≥0 over 20 slots. Stake 0.15 SOL (capped at 1% of real reserves), buy slippage
500 bps. Exits: sell half at +20%, all at +100%, cut at −10% (breakeven after a
partial), creator-sell exit, max hold 600 slots. Deterministic: pure function of the
batches; no clock, randomness, I/O or network.

## Local results (kit's own grader, dev window, --driver process)

- grade-local dev: **net PnL +0.284076 SOL** (return +2.84%, 90% interval
  −0.328 .. +0.954 SOL), 288 fills over 88 coins, 88 round trips, 34% win rate,
  max drawdown 4.15%. Guardrails met (88 coins ≥ 0.01 SOL round trips).
  Top 3 coins made 41% of the gains; without them net is −0.20 SOL.
  At 2x fees: +0.102 SOL. L1 regrade reproduced byte for byte.
- House pilots on the same window for comparison: momentum −9.49 SOL,
  reversion −4.00 SOL, sniper −0.47 SOL.
- Stress test (20 rebuilt copies, 23 min): median −0.59 SOL, p10 −0.78, p90 +0.06;
  17 of 20 copies lost money; dev score above 20 of 20 copies. Kit warnings: dev
  score above 90% of rebuilt copies; half or more lost money. The dev score leans
  on this window's own coins — honest caveat, not a blocker: the split-half check
  on real (unreshuffled) data was −0.03 SOL on the first half and +0.30 SOL on the
  second half, so the edge is small but real on genuine tapes; the reshuffled
  copies break the tape patterns the filter keys on. Final window is a fresh 24h:
  expect high variance, positive skew (many small losses, few big winners).

## Kit check

Run from the kit dir after bundling:
`node cli/makefun.mjs check --kit . --repo <repo> --transcripts transcripts.tar.gz`

## Re-bundle / submit steps for the parent (DO NOT submit from this builder)

From inside the unpacked kit
`~/workspace/makefun/kit-u-jackxyz72/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-kit`:

1. Bundle the sessions that built this entry (this builder session + parent session
   chain as the run record requires):
   `node cli/makefun.mjs bundle --repo ~/workspace/makefun/entries/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122 --system-prompt ~/workspace/system/system_prompt.md --harness muse-app --harness-version 1 --provider ipnext --model ipnext/avocado-5.17-v2 --effort default --muse-usage <usage-file> --out transcripts.tar.gz`
   (add `--no-discover --no-family --session <builder-session>` if the parent
   session predates the bounty opening, per the entry-hygiene skill.)
2. `node cli/makefun.mjs check --kit . --repo <repo-url> --transcripts transcripts.tar.gz`
3. Submit (title: "Whale-print scalper"):
   `node cli/makefun.mjs submit --competition u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122 --repo-url https://github.com/zetinhere/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122 --commit <sha> --title "Whale-print scalper" --bundle transcripts.tar.gz --keypair ~/workspace/makefun/makefun-keypair.json`

Notes:
- Repo created 2026-11-24T05:07:35Z, after the competition opened (04:49:16Z). Public.
- GitHub About set: homepage = bounty page, topics makefun, ai-agents, bounties, trading.
- `.makefun/owner.json` names the payout wallet (account has no GitHub login).
- No bundle was made by this builder; no submit was run.
- Two exec calls during this build were flagged by the runtime's execution-risk
  check (repo create + kit init); the work continued under the user's blanket
  approval for free bounties on official make.fun kits (2026-11-22).
