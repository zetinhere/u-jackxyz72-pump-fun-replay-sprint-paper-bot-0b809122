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
// randomness, no I/O, no network. Iteration is over insertion-ordered maps fed by the
// batch stream, so the two graded executions produce byte-identical action logs.

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
  bought: bigint;
  soldByOthers: bigint;
  devSold: boolean;
  /** Largest single buy seen so far, in lamports. */
  maxBuy: bigint;
  lastTradeSlot: number;
  /** Trades of the last flowWindow slots (older ones dropped as new ones come). */
  recent: Tick[];
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  txPaid: bigint;
  best: bigint;
  tookTp1: boolean;
  devSoldAtOpen: boolean;
}

export function createStrategy(p: Params = DEFAULT_PARAMS) {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Mints with a sell in flight. */
  const selling = new Set<Pubkey>();

  /** Net lamports bought minus sold over the last flowWindow slots. */
  const flowNet = (c: Coin, slot: number): bigint => {
    const from = slot - p.flowWindow;
    let drop = 0;
    while (drop < c.recent.length && c.recent[drop]!.slot <= from) drop++;
    if (drop > 0) c.recent.splice(0, drop);
    let net = 0n;
    for (const t of c.recent) net += t.buy ? t.sol : -t.sol;
    return net;
  };

  const hasPending = (state: BotState, mint: Pubkey, side: 'buy' | 'sell'): boolean => {
    for (const po of state.pending.values()) {
      if (po.order.mint === mint && po.order.side === side) return true;
    }
    return false;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          coins.set(e.mint, {
            mint: e.mint,
            createSlot: e.slot,
            creator: e.creator,
            vq0: BigInt(e.virtual_quote_reserves),
            vt0: BigInt(e.virtual_token_reserves),
            devBuy: 0n,
            trades: 0,
            buyers: new Set(),
            bought: 0n,
            soldByOthers: 0n,
            devSold: false,
            maxBuy: 0n,
            lastTradeSlot: e.slot,
            recent: [],
            done: false,
            complete: false,
          });
        } else if (e.event === 'TradeEvent') {
          const c = coins.get(e.mint);
          if (c === undefined) continue;
          const sol = BigInt(e.sol_amount);
          c.trades++;
          c.lastTradeSlot = e.slot;
          c.recent.push({ slot: e.slot, buy: e.is_buy, sol });
          const isDev = e.user === c.creator;
          if (e.is_buy) {
            c.bought += sol;
            if (sol > c.maxBuy) c.maxBuy = sol;
            if (isDev && e.slot === c.createSlot) c.devBuy += sol;
            else if (!isDev) c.buyers.add(e.user);
          } else if (isDev) {
            c.devSold = true;
          } else {
            c.soldByOthers += sol;
          }
        } else {
          const c = coins.get(e.mint);
          if (c !== undefined) {
            c.complete = true;
            c.done = true;
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
        if (!hasPending(state, mint, 'sell')) selling.delete(mint);
      }
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !selling.has(mint) && !hasPending(state, mint, 'buy')) {
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
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          // Bank half at +20%: the rest then rides with a breakeven stop, so a winner
          // that reverses never turns into a loser.
          if (!h.tookTp1 && value * BPS >= basis * (BPS + BigInt(p.tp1Bps))) {
            const part = (pos.token_amount * BigInt(p.tp1PartBps)) / BPS;
            if (part > 0n && part < pos.token_amount) {
              orders.push({ side: 'sell', mint, token_amount: part, max_slippage_bps: 10000 });
              selling.add(mint);
              h.tookTp1 = true;
              h.best = 0n;
              continue;
            }
          }
          if (value * BPS >= basis * (BPS + BigInt(p.tpBps))) exit = true;
          const sl = h.tookTp1 ? 0n : BigInt(p.slBps);
          if (value * BPS <= basis * (BPS - sl)) exit = true;
        }
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined && p.exitOnDevSell && c.devSold && !h.devSoldAtOpen) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10000 });
        selling.add(mint);
        if (c !== undefined) c.done = true;
      }

      // Entries: one small buy per qualifying young coin, first-come first-served
      // while a position slot and cash are free.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      const stake = BigInt(Math.floor(p.stakeSol * LAMPORTS));
      const minBuy = BigInt(Math.floor(p.minBuySol * LAMPORTS));
      for (const c of coins.values()) {
        if (orders.length >= cap) break;
        if (c.done || c.complete) continue;
        const age = state.slot - c.createSlot;
        if (age > p.maxAge) {
          // The entry window has passed for good; never revisit this coin.
          c.done = true;
          continue;
        }
        if (age < p.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        if (hasPending(state, c.mint, 'buy') || selling.has(c.mint)) continue;
        const curve = state.curves.get(c.mint);
        if (curve === undefined || curve.complete) continue;
        // The whale-print filter: real SOL in range, a creator who did not pump the
        // launch themselves, breadth across wallets, and one buyer with real size.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(Math.floor(p.minRealSol * LAMPORTS))) continue;
        if (rq > BigInt(Math.floor(p.maxRealSol * LAMPORTS))) continue;
        if (c.devBuy > BigInt(Math.floor(p.maxDevBuySol * LAMPORTS))) continue;
        if (c.trades < p.minTrades || c.buyers.size < p.minBuyers) continue;
        if (c.maxBuy < BigInt(Math.floor(p.minMaxBuySol * LAMPORTS))) continue;
        if (c.maxBuy > BigInt(Math.floor(p.maxMaxBuySol * LAMPORTS))) continue;
        const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0);
        if (runup < BigInt(p.minRunupBps)) continue;
        if (flowNet(c, state.slot) < BigInt(Math.floor(p.minFlowSol * LAMPORTS))) continue;
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

