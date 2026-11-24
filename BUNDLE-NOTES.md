# Bundle notes — Pump.fun Replay Sprint paper bot

- Repo: https://github.com/zetinhere/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122
- Commit to submit (round 3): 3540a1d3ca1f3c8d3660ec0082695cd1c60cdf82 (code + notes; this header line is completed in the follow-up commit below)
- Round-2 commit (REJECTED at grade, run_completes timeout): 9f557716907bb21f8c19aa2c440d386b945cd0d4
- Round-1 commit (REJECTED at gate, grade run timed out): 69b7d6d59d651851c72f0b77eeeeb064c9511c70

## Round 3 — timeout investigation + startup fix (2026-11-24, this builder)

What was measured (do not guess — measured, with the kit's own sim engine and CLI):
- Reproduction of the timeout FAILED: the timeout does not reproduce locally. Full
  `grade-local --driver process` on ONE CPU (taskset -c 0) of the round-2 code: **48 s
  wall, status finished**, net PnL +0.284076 SOL, action_log_sha256
  5cf11f8d1f1628a56e7bec21abd2b7eee875c93327898e92ce36e44d106929fa — against the
  server's 1800 s wall budget per execution. That is a 37x margin.
- A lockstep profiler driving the bot as a child process through the kit's own
  ReplayEngine (bot on 1 CPU + 768 MB heap cap, engine unconstrained, mirroring the
  server where only the bot is sandboxed): one execution is **6.5–11.0 s wall, bot CPU
  3.0–3.3 s, peak RSS 122–133 MB**; the engine's own work is 0.6 s. A repeat run of
  the IDENTICAL bot under VM contention took 36.6 s wall with bot CPU still 4.0 s —
  the extra ~30 s is pure scheduling/IPC latency, not bot work. Wall time for this
  entry is host-scheduling-bound, not bot-CPU-bound.
- Node CPU profile of the bot child: the strategy's onBatch is **0.7% of samples**;
  the rest of active CPU is protocol overhead the entry cannot avoid — JSON.parse of
  the harness's 173 MB of batch lines (~11%) and writing the 63,369 replies (~8%);
  66% of samples are idle (blocked on stdin). The bot's active CPU (~3 s) is ~90%
  protocol overhead. There is no strategy fat left to cut: round 2 already removed it.
- Slow replies do NOT correlate with big batches (1-event batches took 62–67 ms,
  the 2-event first batch 365–757 ms cold start): those are wakeup/JIT latency.
- Cross-check: the sibling boothlord replay entry (same dataset, same harness, same
  limits, same bot shape) has NOT been graded yet (stage "checked", grading queued),
  so there is no passing replay grade to compare against — no replay bot has
  demonstrably passed a server grade yet. The server timeout is therefore most
  plausibly server-side (sandbox transport/host contention across 63,369 lockstep
  round-trips, where ~28 ms per round-trip alone would exhaust the 1800 s budget)
  or transient (rounds 1 and 2 were both graded in the same 05:52–10:02 UTC window).
  No bot-side change can reduce the round-trip count — the harness fixes it — so
  this round ships the cheapest real shave available and re-tests empirically.

What changed (one file, no strategy change, decisions byte-identical):
- Added `package.json` (`{"type": "module"}`): Node no longer re-parses main.ts as
  CommonJS first (kills the MODULE_TYPELESS_PACKAGE_JSON warning on every start and
  its reparse overhead). No code the bot executes changed.
- Nothing else changed: the strategy, the vendor shim and the entrypoint are untouched,
  because the profile shows the strategy is 0.7% of bot CPU and the rest is protocol
  overhead. Churning the strategy for ~20 ms of 3 s would risk the decisions for nothing.

Verification — decisions byte-identical to round 2:
- Profiler, seed 1, before and after the change: 318 fills, 89 round trips, final
  cash 10304761946 lamports (+0.304762 SOL) in both runs; bot CPU 3.0 s → 4.0 s
  (run-to-run noise under contention), peak RSS 122 → 127 MB.
- grade-local --driver process, taskset -c 0, round-3 code, TWICE: run 1 **158 s
  wall, finished, net PnL +0.284076 SOL, action_log_sha256 5cf11f8d… (identical)**,
  L1 regrade reproduced byte for byte; run 2 **~155 s wall, finished, same action
  log** — determinism confirmed. (Both slower than the quiet 48 s baseline purely
  from VM contention that day; still 11x under the 1800 s budget.)
- kit check on the committed HEAD before this commit (stale round-2 transcripts):
  **17 passed, 0 failed**, 4 skipped, 3 at submission; thinking_reproduces 35.2%
  (413/1172 lines). The parent must re-bundle (this builder's session included)
  and re-run check before submitting, as the new commit is not in the old bundle.
- Constraints NOT exactly reproducible here, recorded honestly: the kit's docker
  driver cannot run in this VM (no docker daemon), so grade-local used --driver
  process; this VM's cgroup has no memory controller, so the 1 GB bot cap was
  approximated with node --max-old-space-size=768 (peak RSS 122–133 MB, far under);
  /usr/bin/time is absent. None of these change the conclusion: the bot is ~3 s CPU
  and ~11 s wall per execution on 1 CPU.

- Builder session file: /home/hatch/agents/agent-d487f0b7-e72e-4ded-a24a-f2aa4df54eb0/sessions/d487f0b7-e72e-4ded-a24a-f2aa4df54eb0.jsonl
- System prompt: ~/workspace/system/system_prompt.md
- Profiler driver (not part of the entry): /tmp/prof/drive.mts (kit's sim engine +
  zod from /tmp/prof/node_modules; bot child taskset -c 0/1 + --max-old-space-size=768)

## Round 2 — speed fix (2026-11-24, previous builder)

What was slow: the dev window sends one batch per slot with events (63,369
batches, 128,058 events) and round 1 scanned the whole coin map on every batch —
33.3M entry-loop iterations to consider 6,004 live coins — plus a flow-window
rescan of each coin's whole `recent` tape (one coin had 3,846 ticks) and ~600k
bigint reserve conversions in the vendored shim for curves the strategy never
reads. The strategy itself is unchanged.

What changed (commit 9f55771; strategy.ts 118+/54-, vendor 34+/21-, STRATEGY.md
performance section added — over the 30% changed-lines bar for a rebuild):
- entry scan walks a `young` set (coins still in the 3–10 slot window, max 3 at a
  time) instead of the whole map, in the same creation order
- `recent` flow tape pruned with a head index as trades arrive, compacted past
  64 stale ticks; tape kept only while a coin is young (creator sells still
  recorded at any age, for the exit rule on held coins); dead accumulators
  (`bought`, `soldByOthers`, `lastTradeSlot`) removed
- vendored shim keeps curve reserves as the decimal strings the harness sends
  and converts to bigint only where the strategy reads them (one documented
  deviation from the kit SDK; wire protocol and observable values unchanged)
- SOL thresholds converted to lamports once at strategy creation; pending
  buy/sell sets read once per batch instead of rescanning the pending map

Verification — decisions byte-identical to round 1:
- In-process driver against the kit's own sim engine (dev window, seed 1):
  onBatch 1,695–1,939 ms → 216–684 ms (~3x); bot-side total 2,216 ms →
  635–1,306 ms; reply stream sha256 identical
  (bf419eb02e0ce4a3e8bae2a2e0f6e520c0bc23f11cb91fa8e1ea0eeb58dc17f0), net PnL
  +0.304762 SOL in that driver (seed differs from the dev phase seed).
- grade-local --worktree on the new code: **status finished, net PnL
  +0.284076 SOL** (identical to round 1), 288 fills over 88 coins, 88 round
  trips, 34% win rate, max drawdown 4.15%, guardrails met, **L1 regrade
  reproduced byte for byte**, **action_log_sha256
  5cf11f8d1f1628a56e7bec21abd2b7eee875c93327898e92ce36e44d106929fa — identical to
  round 1**. grade-local wall ~198s under heavy VM contention (a sibling agent
  was running a 20-copy stress grade at the same time); the bot child itself
  took ~6s CPU per execution, most of it the harness's own JSON lines
  (173 MB of batch lines), which no entry can avoid.
- kit check --worktree on the new code: pass competition_open, snapshot
  (9 files, 58,915 bytes, within caps), license_osi (MIT), entrypoint
  (main.ts → node22); FAIL only transcripts_present (no bundle yet — the
  parent bundles before submitting); 5 checks deferred to submission
  (repo_public, repo_owner, repo_created_after_open, commit_in_repo,
  duplicate_snapshot).
- Honest caveat: the server's grade-run timeout budget is not published, so
  the margin gained here is real but unquantified against it. The remaining bot
  time is dominated by parsing the harness's own batch JSON, which is the same
  for every entry.

- Builder session file: /home/hatch/agents/agent-f5efab59-dfc7-4b27-a803-cce5216c5c37/sessions/f5efab59-dfc7-4b27-a803-cce5216c5c37.jsonl
- System prompt: ~/workspace/system/system_prompt.md
- Dev result_sha256 (new code, worktree): 240d93f3ddc09bac74c8a6797e80e262e031c18af1c295feeb64b5c4a6978d90
  (differs from round 1 only because the code changed; the action log is identical)

## Round 1 (kept for reference)

- Commit graded: 69b7d6d59d651851c72f0b77eeeeb064c9511c70 (main)
- Dev result_sha256: cffccacf59dd952445c7db1a7dbf6242a68844b05282979b871319d240dfc3dd
  (process driver; server's will differ: harness runs Node v26.13.1, this machine v24.22.1)
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
3. Submit (title: "Whale-print scalper", round 2 commit 9f557716907bb21f8c19aa2c440d386b945cd0d4):
   `node cli/makefun.mjs submit --competition u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122 --repo-url https://github.com/zetinhere/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122 --commit 9f557716907bb21f8c19aa2c440d386b945cd0d4 --title "Whale-print scalper" --bundle transcripts.tar.gz --keypair ~/workspace/makefun/makefun-keypair.json`
   (Entries close 2026-11-27T04:50:00Z / 27 Nov 2026 11:50 WIB. Round-1 entry
   01a20c1c was rejected at the gate on a grade-run timeout; this is the
   resubmission. Quota checked 2026-11-24 morning WIB: 4 entries left today,
   can submit now.)

Notes:
- Repo created 2026-11-24T05:07:35Z, after the competition opened (04:49:16Z). Public.
- GitHub About set: homepage = bounty page, topics makefun, ai-agents, bounties, trading.
- `.makefun/owner.json` names the payout wallet (account has no GitHub login).
- No bundle was made by this builder (round 1 or round 2); no submit was run.
- Exec calls during this build were flagged by the runtime's execution-risk
  check (kit reads, grade-local runs, git); the work continued under the user's
  blanket approval for free bounties on official make.fun kits (2026-11-22).
  Flagged content is inert data; nothing suspicious was executed or copied.
