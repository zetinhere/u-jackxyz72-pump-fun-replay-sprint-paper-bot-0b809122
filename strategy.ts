// Whale-print scalper: a disciplined paper-trading bot for pump.fun bonding curves.
//
// Idea (found by measuring the dev window, not by guessing): most new coins bleed slowly
// after launch, so buying every launch loses to fees. The coins that pay are the ones whose
// opening tape already shows a real buyer with size — one single buy of 0.5-2.5 SOL —
// spread over at least five distinct wallets, with real SOL already above 3. A bigger
// single buy is usually the creator or a bundler about to dump; no buy that size means
// nobody with money cares yet. The bot buys those coins small (0.15 SOL), banks half at
// +20%, lets the rest run to +100%, cuts at -10%, and never holds past 600 slots.
//
// Every decision is a pure function of the batches the harness sends: no clock, no
// randomness, no I/O, no network. Iteration is over insertion-ordered sets fed by the
// batch stream, so the two graded executions produce byte-identical action logs.
//
// Speed (why this file looks the way it does): the replay sends one batch per slot that
// carries events — 63,369 batches on the dev window — and the first version scanned the
// whole coin map on every batch, 33M iterations to consider ~6,000 live ones. This
// version keeps a separate `young` set of the coins still inside the entry window
// (3-10 slots after creation) and only ever scans that: a coin enters it on its
// CreateEvent and leaves it the first batch its age passes the window, it completes, or
// it is bought and exited. The per-coin tape (`recent`) is pruned with a head index as
// trades arrive, so the 20-slot flow window never rescans a coin's whole history. All
// SOL thresholds are converted to lamports once, when the strategy is created, instead
// of once per coin per batch. The decisions are unchanged: same order, same filters,
// same fills — only the work that finds the candidates is cheaper.

import type { Batch, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Entry window: slots since the CreateEvent during which a first buy may be decided. */
  minAge: number;
  maxAge: number;
  /** SOL to aim for per coin (each buy is still capped at 1% of the curve's real SOL). */
  stakeSol: number;
  /** Smallest single buy worth paying the transaction fee for. */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: at most this many SOL (a bigger dev buy is a pump). */
  maxDevBuySol: number;
  /** Largest single buy seen before entry must lie in this SOL window (the "whale print"). */
  minMaxBuySol: number;
  maxMaxBuySol: number;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Price now over the create price, as bps (10000 = 1.00x): the launch must already be moving. */
  minRunupBps: number;
  /** Net SOL bought minus sold over the recent-flow window must be at least this. */
  flowWindow: number;
  minFlowSol: number;
  /** First take-profit: sell this share of the position once it is worth this much over cost. */
  tp1Bps: number;
  tp1PartBps: number;
  /** Exit when the position is worth this much over its cost. */
  tpBps: number;
  /** Exit when it is worth this much under its cost (before any partial take-profit). */
  slBps: number;
  /** Exit after holding this many slots. */
  maxHold: number;
  /** Exit at once when the creator sells while the position is held. */
  exitOnDevSell: boolean;
  /** Slippage allowed on buys (bps): a buy whose fill would be worse than this is refused. */
  buySlipBps: number;
}

// Settings traded with. Chosen on the dev window by sweeping each knob in turn and keeping
// the flat region of the grid, not its single best cell: the max-buy window 0.5-2.5 SOL,
// 0.15 SOL stakes and a 600-slot hold were positive across every neighbouring setting tried.
export const DEFAULT_PARAMS: Params = {
  minAge: 3,
  maxAge: 10,
  stakeSol: 0.15,
  minBuySol: 0.005,
  minRealSol: 3,
  maxRealSol: 100,
  maxDevBuySol: 2.5,
  minMaxBuySol: 0.5,
  maxMaxBuySol: 2.5,
  minTrades: 3,
  minBuyers: 5,
  minRunupBps: 10500,
  flowWindow: 20,
  minFlowSol: 0,
  tp1Bps: 2000,
  tp1PartBps: 5000,
  tpBps: 10000,
  slBps: 1000,
  maxHold: 600,
  exitOnDevSell: true,
  buySlipBps: 500,
};

const BPS = 10000n;
/** Curve fees charged on a sale: protocol 95 bps + creator 30 bps. */
const FEE_BPS = 125n;
const LAMPORTS = 1e9;

/** What selling `tokens` against (vq, vt) would pay after curve fees. */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + BPS - 1n) / BPS;
}

interface Tick {
  slot: number;
  buy: boolean;
  sol: bigint;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** Create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  devSold: boolean;
  /** Largest single buy seen so far, in lamports. */
  maxBuy: bigint;
  /**
   * Trades of the last flowWindow slots. `recentStart` is the head index: ticks before
   * it are older than the window and already dropped. The array is compacted once the
   * head grows past COMPACT_AT, so a hot coin never carries its whole history.
   */
  recent: Tick[];
  recentStart: number;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

/** Compact a coin's tick window once this many stale ticks pile up at its head. */
const COMPACT_AT = 64;

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  tookTp1: boolean;
  devSoldAtOpen: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  // Every SOL threshold converted to lamports once, up front: the old code rebuilt
  // these BigInts for every coin on every batch.
  const stake = BigInt(Math.floor(p.stakeSol * LAMPORTS));
  const minBuy = BigInt(Math.floor(p.minBuySol * LAMPORTS));
  const minReal = BigInt(Math.floor(p.minRealSol * LAMPORTS));
  const maxReal = BigInt(Math.floor(p.maxRealSol * LAMPORTS));
  const maxDevBuy = BigInt(Math.floor(p.maxDevBuySol * LAMPORTS));
  const minMaxBuy = BigInt(Math.floor(p.minMaxBuySol * LAMPORTS));
  const maxMaxBuy = BigInt(Math.floor(p.maxMaxBuySol * LAMPORTS));
  const minRunup = BigInt(p.minRunupBps);
  const minFlow = BigInt(Math.floor(p.minFlowSol * LAMPORTS));
  const tp1 = BigInt(p.tp1Bps);
  const tp1Part = BigInt(p.tp1PartBps);
  const tp = BigInt(p.tpBps);
  const sl = BigInt(p.slBps);

  /** Every coin ever seen, for exit checks (creator-sell) on held positions. */
  const coins = new Map<Pubkey, Coin>();
  /**
   * Coins still inside the entry window, in creation order. The entry scan walks this
   * set only — a handful of coins per batch, never the whole map. A coin leaves it the
   * first batch its age passes maxAge, when it completes, or when it is done for good.
   * Iteration order matches the old full-map scan restricted to the same coins, so the
   * first-come-first-served entry order is unchanged.
   */
  const young = new Set<Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();

  /** Drop ticks older than the flow window (called as trades arrive, in slot order). */
  const pruneRecent = (c: Coin, slot: number): void => {
    const from = slot - p.flowWindow;
    while (c.recentStart < c.recent.length && c.recent[c.recentStart]!.slot <= from) c.recentStart++;
    if (c.recentStart >= COMPACT_AT) {
      c.recent.splice(0, c.recentStart);
      c.recentStart = 0;
    }
  };

  /** Net lamports bought minus sold over the last flowWindow slots. */
  const flowNet = (c: Coin, slot: number): bigint => {
    pruneRecent(c, slot);
    let net = 0n;
    for (let i = c.recentStart; i < c.recent.length; i++) {
      const t = c.recent[i]!;
      net += t.buy ? t.sol : -t.sol;
    }
    return net;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const c: Coin = {
            mint: e.mint,
            createSlot: e.slot,
            creator: e.creator,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            devBuy: 0n,
            trades: 0,
            buyers: new Set(),
            devSold: false,
            maxBuy: 0n,
            recent: [],
            recentStart: 0,
            done: false,
            complete: false,
          };
          coins.set(e.mint, c);
          young.add(c);
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const isDev = e.user === c.creator;
          // A creator sell matters for the exit rule as long as the coin may be
          // held, so it is recorded for every coin, at any age.
          if (!e.is_buy && isDev) c.devSold = true;
          // The opening tape (trades, buyers, largest buy, recent flow) is only ever
          // read while the coin is young — the entry filter never runs for an older
          // coin. Once it leaves the window its tape is dead, so skip the BigInt
          // conversion, the tick allocation and the set work for its later trades.
          // A coin is young through the event fold of the first batch past its window
          // (the sweep runs later, in the entry phase), so every trade the old code
          // counted before a decision is still counted here.
          if (!young.has(c)) continue;
          const sol = BigInt(e.sol_amount);
          c.trades++;
          pruneRecent(c, e.slot);
          c.recent.push({ slot: e.slot, buy: e.is_buy, sol });
          if (e.is_buy) {
            if (sol > c.maxBuy) c.maxBuy = sol;
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
            young.delete(c);
          }
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) {
        marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });
      }

      // Pending orders do not change while this batch is decided, so read them once
      // into sets instead of rescanning the pending map per coin per check.
      const pendingBuy = new Set<Pubkey>();
      const pendingSell = new Set<Pubkey>();
      for (const po of state.pending.values()) {
        if (po.order.side === 'buy') pendingBuy.add(po.order.mint);
        else pendingSell.add(po.order.mint);
      }

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          // A harness close (complete / flatten / writeoff): the position is gone.
          held.delete(f.mint);
          selling.delete(f.mint);
          continue;
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, {
            openedSlot: f.slot,
            txPaid: BigInt(f.tx_fee_lamports),
            best: 0n,
            tookTp1: false,
            devSoldAtOpen: coins.get(f.mint)?.devSold ?? false,
          });
        }
      }
      for (const mint of [...selling]) {
        if (!pendingSell.has(mint)) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !pendingBuy.has(mint)) {
          held.delete(mint);
        }
      }

      // Exits first: every held position is checked against its take-profit, stop,
      // creator-sell and time-limit rules on every batch.
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (selling.has(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = {
            openedSlot: state.slot,
            txPaid: tx,
            best: 0n,
            tookTp1: false,
            devSoldAtOpen: c?.devSold ?? false,
          };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          // Curve reserves are decimal strings in this shim (see vendor/makefun-bot.ts):
          // convert only here, for a position actually being valued.
          mk = { vq: BigInt(cv.virtual_quote_reserves), vt: BigInt(cv.virtual_token_reserves) };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          // Bank half at +20%: the rest then rides with a breakeven stop, so a winner
          // that reverses never turns into a loser.
          if (!h.tookTp1 && value * BPS >= basis * (BPS + tp1)) {
            const part = (pos.token_amount * tp1Part) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + tp)) exit = true;
          const stop = h.tookTp1 ? 0n : sl;
          if (value * BPS <= basis * (BPS - stop)) exit = true;
        }
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined && p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        selling.add(mint);
        if (c !== undefined) {
          c.done = true;
          young.delete(c);
        }
      }

      // Entries: one small buy per qualifying young coin, first-come first-served
      // while a position slot and cash are free. Only coins still in the entry window
      // are visited; the rest can never qualify again.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const c of young) {
        if (orders.length >= cap) break;
        const age = state.slot - c.createSlot;
        if (age > p.maxAge) {
          // The entry window has passed for good; never revisit this coin.
          c.done = true;
          young.delete(c);
          continue;
        }
        if (age < p.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        if (pendingBuy.has(c.mint) || selling.has(c.mint)) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        // The whale-print filter: real SOL in range, a creator who did not pump the
        // launch themselves, breadth across wallets, and one buyer with real size.
        const rq = BigInt(curve.real_quote_reserves);
        if (rq < minReal) continue;
        if (rq > maxReal) continue;
        if (c.devBuy > maxDevBuy) continue;
        if (c.trades < p.minTrades || c.buyers.size < p.minBuyers) continue;
        if (c.maxBuy < minMaxBuy) continue;
        if (c.maxBuy > maxMaxBuy) continue;
        const runup = (BigInt(curve.virtual_quote_reserves) * c.vt0 * BPS) / (BigInt(curve.virtual_token_reserves) * c.vq0);
        if (runup < minRunup) continue;
        if (flowNet(c, state.slot) < minFlow) continue;
        const maxBuy = state.maxBuyLamports(c.mint);
        const amount = stake < maxBuy ? stake : maxBuy;
        if (amount < minBuy) continue;
        if (free < amount + tx) continue;
        orders.push({ side: 'buy', mint: c.mint, quote_lamports: amount, max_slippage_bps: p.buySlipBps });
        free -= amount + tx;
        open += 1;
      }
      return orders;
    },
  };
}
