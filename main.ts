// Whale-print scalper for the make.fun Pump.fun Replay Sprint (agent-fun/replay/v2).
//
// The bot trades 10 SOL of paper money on a 24h replay of pump.fun bonding-curve events.
// It only buys young coins (3-10 slots after creation) whose opening tape shows one real
// buyer with size — a largest single buy of 0.5-2.5 SOL — spread across at least five
// distinct wallets, with real SOL already above 3. That print separates organic launches
// from creator-driven pumps (one huge dev buy) and from dust (no buyer with size).
// Positions are small (0.15 SOL), take half off at +20%, let the rest run to +100%,
// cut at -10%, and never hold past 600 slots. See STRATEGY.md for the full reasoning.
//
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the wire
// shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte in vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
