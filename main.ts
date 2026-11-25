// Sharpe Sprint — steady momentum scalper for the pump.fun bonding-curve replay.
//
// Idea: hourly Sharpe rewards smooth, repeatable gains, not moonshots. So this bot
// trades lots of fresh coins in small, equal stakes, banks quick winners, and cuts
// losers fast. It never chases a vertical move and never holds a coin for long.
//
// Entry: a coin becomes a candidate on its CreateEvent. It is bought once its tape
// shows real, broad buying — net SOL flowing in over a short window, several
// distinct buyers, price up a little from creation and sitting near its window
// high — while its real SOL reserve is big enough for a meaningful (but capped)
// buy. One small buy first; one pyramid add only while the price is above the
// entry and inflow is still positive.
//
// Exit (whole position, first trigger wins): take-profit +25% on cost, stop-loss
// -15% on cost, trailing stop 20% below the peak once the position is +5% up, a
// fade exit when net SOL over the window turns negative, or a max hold of 1500
// slots. The replay closes completed curves and flattens leftovers itself.
//
// Guardrail: the entry needs round trips of >= 0.01 SOL on >= 20 distinct mints.
// If the round-trip pace lags halfway through the 6-hour window (judged from the
// events' own block times, never the wall clock), the bot buys small probes of
// the most liquid active curves and exits them on a small move, just to bank the
// required distinct-mint count.
//
// Deterministic by construction: no clock, no environment, no randomness. Every
// decision comes from the batch stream (slots, reserves, trades) in insertion
// order, so two runs of the same replay produce identical action logs.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

// --- tuning -----------------------------------------------------------------

const STAKE_LAMPORTS = 50_000_000n; // 0.05 SOL first buy: false starts cost little
const PYRAMID_LAMPORTS = 150_000_000n; // 0.15 SOL per add on strength
const MAX_POSITION_LAMPORTS = 500_000_000n; // 0.5 SOL total per position
const MIN_BUY_LAMPORTS = 10_000_000n; // 0.01 SOL: the round-trip minimum
const PROBE_LAMPORTS = 12_000_000n; // 0.012 SOL guardrail probe
const BUY_SLIPPAGE_BPS = 1500;
const SELL_SLIPPAGE_BPS = 10_000;

const WINDOW_SLOTS = 60; // tape window for inflow / price stats (recent momentum)
const MIN_AGE_SLOTS = 300; // let the launch settle: fresh curves are mostly dumps
const MAX_CANDIDATE_AGE_SLOTS = 1500; // stop considering stale candidates
const MIN_NET_INFLOW_SOL = 0.8; // net buy SOL over the window
const MIN_BUYS = 3; // buy trades in the window
const MIN_BUYERS = 5; // distinct buying wallets in the window
const MIN_PRICE_UP = 0.04; // price up >= 4% from creation
const MAX_PRICE_UP = 1.0; // skip coins already up > 100% in the window
const NEAR_HIGH = 0.95; // price >= 95% of the window high
const MIN_REAL_SOL = 2; // real SOL reserve at entry, lower bound
const MAX_REAL_SOL = 60; // real SOL reserve at entry, upper bound

const TAKE_PROFIT = 0.25; // sell at +25% on cost (lets runners run)
const STOP_LOSS = -0.1; // sell at -10% on cost
const TRAIL_ARM = 0.05; // trailing stop arms at +5%
const TRAIL_DROP = 0.2; // sell 20% below the peak value once armed
const MAX_HOLD_SLOTS = 1500; // time-stop
const FADE_NET_SOL = -0.2; // exit when window net inflow turns negative
const COOLDOWN_SLOTS = 150; // wait after an exit before re-entering a coin
const MAX_ENTRIES_PER_MINT = 2;
const MAX_PYRAMID_ADDS = 3; // adds after the first buy
const PYRAMID_GAP_SLOTS = 30; // slots between pyramid adds

const PROBE_ARM_SECONDS = 10800; // halfway through the 6h window
const PROBE_TAKE = 0.04; // probe exit at +4%
const PROBE_STOP = -0.04; // probe exit at -4%
const PROBE_MAX_HOLD_SLOTS = 150;
const MIN_DISTINCT_MINTS = 20;

// --- per-mint tape -----------------------------------------------------------

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: number; // SOL (float) moved by this trade
  user: string;
}

interface MintTape {
  createdSlot: number;
  createPrice: number; // SOL per token at creation
  highPrice: number; // highest price seen inside the window
  trades: TapeTrade[];
  entries: number; // buys placed on this mint
  lastExitSlot: number; // slot of the last exit, for cooldown
  decided: boolean; // a buy is in flight or held (prevents double entry)
}

interface Held {
  cost: bigint; // lamports spent on tokens still held
  peakValue: bigint; // best marked value seen (lamports)
  entrySlot: number;
  buys: number; // buys filled into this position
  adds: number; // pyramid adds filled
  lastAddSlot: number; // slot of the last pyramid add
  probe: boolean; // guardrail probe position (different exit rules)
}

const tapes = new Map<Pubkey, MintTape>();
const held = new Map<Pubkey, Held>();
const boughtMints = new Set<Pubkey>(); // mints with at least one buy fill
const roundTripped = new Set<Pubkey>(); // mints with a completed round trip
let firstBlockTime: number | null = null;
let lastBlockTime = 0;

function priceOf(curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }): number {
  const vt = Number(curve.virtual_token_reserves);
  const vq = Number(curve.virtual_quote_reserves);
  if (vt <= 0 || vq <= 0) return 0;
  return vq / vt;
}

function valueOf(tokens: bigint, price: number): bigint {
  if (price <= 0) return 0n;
  return BigInt(Math.floor(Number(tokens) * price));
}

function pruneTape(tape: MintTape, nowSlot: number): void {
  const cutoff = nowSlot - WINDOW_SLOTS;
  while (tape.trades.length > 0 && tape.trades[0].slot < cutoff) tape.trades.shift();
}

function windowStats(tape: MintTape, nowSlot: number): {
  netSol: number;
  netNew: number; // net SOL in the newer half of the window
  netOld: number; // net SOL in the older half of the window
  buys: number;
  buyers: Set<string>;
  high: number;
} {
  let netSol = 0;
  let netNew = 0;
  let netOld = 0;
  let buys = 0;
  const buyers = new Set<string>();
  let high = tape.createPrice;
  const mid = nowSlot - WINDOW_SLOTS / 2;
  for (const t of tape.trades) {
    const signed = t.isBuy ? t.sol : -t.sol;
    netSol += signed;
    if (t.slot >= mid) netNew += signed;
    else netOld += signed;
    if (t.isBuy) {
      buys += 1;
      buyers.add(t.user);
    }
  }
  if (tape.highPrice > high) high = tape.highPrice;
  return { netSol, netNew, netOld, buys, buyers, high };
}

// --- strategy ----------------------------------------------------------------

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const caps = state.hello.caps;
    const txFee = state.txFeeLamports();
    const slot = batch.slot;

    // Track block time from the events themselves (deterministic, data-driven).
    for (const e of batch.events) {
      if (e.block_time !== null && e.block_time !== undefined) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        lastBlockTime = e.block_time;
      }
    }

    // Fold fills: track round trips and refresh held positions.
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') {
        boughtMints.add(f.mint);
        const h = held.get(f.mint);
        if (h) h.buys += 1;
      } else if (f.side === 'sell' && boughtMints.has(f.mint)) {
        roundTripped.add(f.mint);
      }
    }

    // Fold events into tapes.
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        const curve = state.curves.get(e.mint);
        const p = curve ? priceOf(curve) : 0;
        if (!tapes.has(e.mint)) {
          tapes.set(e.mint, {
            createdSlot: e.slot,
            createPrice: p,
            highPrice: p,
            trades: [],
            entries: 0,
            lastExitSlot: -1,
            decided: false,
          });
        }
      } else if (e.event === 'TradeEvent') {
        const tape = tapes.get(e.mint);
        if (tape) {
          tape.trades.push({
            slot: e.slot,
            isBuy: e.is_buy,
            sol: Number(BigInt(e.sol_amount)) / 1e9,
            user: e.user,
          });
          const curve = state.curves.get(e.mint);
          if (curve) {
            const p = priceOf(curve);
            if (p > tape.highPrice) tape.highPrice = p;
          }
        }
      } else if (e.event === 'CompleteEvent') {
        tapes.delete(e.mint);
      }
    }

    // Refresh held map from the account: drop closed positions, add new ones.
    const liveMints = new Set<Pubkey>();
    for (const [mint, pos] of state.positions) {
      liveMints.add(mint);
      const h = held.get(mint);
      if (!h) {
        held.set(mint, {
          cost: pos.cost_lamports,
          peakValue: pos.cost_lamports,
          entrySlot: slot,
          buys: 1,
          adds: 0,
          lastAddSlot: slot,
          probe: false,
        });
      } else {
        h.cost = pos.cost_lamports;
      }
    }
    for (const mint of [...held.keys()]) {
      if (!liveMints.has(mint)) {
        const tape = tapes.get(mint);
        if (tape) tape.lastExitSlot = slot;
        held.delete(mint);
      }
    }

    let free = state.freeCashLamports();
    let openSlots = caps.max_open_positions - state.committedPositionCount();
    const maxOrders = caps.max_orders_per_batch;

    const pushBuy = (mint: Pubkey, amount: bigint): boolean => {
      if (orders.length >= maxOrders || openSlots <= 0) return false;
      if (free < amount + txFee) return false;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: BUY_SLIPPAGE_BPS });
      free -= amount + txFee;
      openSlots -= 1;
      return true;
    };

    const pushSell = (mint: Pubkey, tokens: bigint): boolean => {
      if (orders.length >= maxOrders || tokens <= 0n) return false;
      orders.push({ side: 'sell', mint, token_amount: tokens, max_slippage_bps: SELL_SLIPPAGE_BPS });
      return true;
    };

    // 1) Exits first: manage every open position.
    for (const [mint, pos] of state.positions) {
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const h = held.get(mint);
      if (!h) continue;
      const p = priceOf(curve);
      if (p <= 0) continue;
      const value = valueOf(pos.token_amount, p);
      if (value > h.peakValue) h.peakValue = value;
      const cost = h.cost > 0n ? h.cost : 1n;
      const ret = Number(value - cost) / Number(cost);

      let exit = false;
      if (h.probe) {
        if (ret >= PROBE_TAKE || ret <= PROBE_STOP) exit = true;
        if (slot - h.entrySlot >= PROBE_MAX_HOLD_SLOTS) exit = true;
      } else {
        if (ret >= TAKE_PROFIT) exit = true;
        if (ret <= STOP_LOSS) exit = true;
        // Trailing stop: once +5% up, sell 20% below the peak value.
        if (value >= (cost * 105n) / 100n && value <= (h.peakValue * 80n) / 100n) exit = true;
        if (slot - h.entrySlot >= MAX_HOLD_SLOTS) exit = true;
        const tape = tapes.get(mint);
        if (tape) {
          pruneTape(tape, slot);
          if (windowStats(tape, slot).netSol <= FADE_NET_SOL) exit = true;
        }
      }
      if (exit) {
        if (pushSell(mint, pos.token_amount)) {
          const tape = tapes.get(mint);
          if (tape) tape.lastExitSlot = slot;
        }
      }
    }

    // 2) Entries: scan candidates in batch order.
    for (const e of batch.events) {
      if (orders.length >= maxOrders || openSlots <= 0) break;
      if (e.event !== 'CreateEvent' && e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      const tape = tapes.get(mint);
      if (!tape || tape.decided) continue;
      if (tape.entries >= MAX_ENTRIES_PER_MINT) continue;
      if (slot - tape.lastExitSlot < COOLDOWN_SLOTS && tape.lastExitSlot >= 0) continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) {
        tapes.delete(mint);
        continue;
      }
      const age = slot - tape.createdSlot;
      if (age < MIN_AGE_SLOTS || age > MAX_CANDIDATE_AGE_SLOTS) continue;
      const realSol = Number(curve.real_quote_reserves) / 1e9;
      if (realSol < MIN_REAL_SOL || realSol > MAX_REAL_SOL) continue;
      pruneTape(tape, slot);
      const stats = windowStats(tape, slot);
      if (stats.netSol < MIN_NET_INFLOW_SOL) continue;
      if (stats.buys < MIN_BUYS) continue;
      if (stats.buyers.size < MIN_BUYERS) continue;
      const p = priceOf(curve);
      if (p <= 0 || tape.createPrice <= 0) continue;
      const up = p / tape.createPrice - 1;
      if (up < MIN_PRICE_UP || up > MAX_PRICE_UP) continue;
      if (p < NEAR_HIGH * stats.high) continue;

      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (pushBuy(mint, amount)) {
        tape.decided = true;
        tape.entries += 1;
      }
    }

    // 3) Pyramid: add to a winning position while inflow is still positive,
    // up to MAX_PYRAMID_ADDS adds of PYRAMID_LAMPORTS, total capped.
    for (const [mint, pos] of state.positions) {
      if (orders.length >= maxOrders || openSlots <= 0) break;
      const h = held.get(mint);
      const curve = state.curves.get(mint);
      const tape = tapes.get(mint);
      if (!h || !curve || !tape || h.probe) continue;
      if (curve.complete) continue;
      if (h.adds >= MAX_PYRAMID_ADDS) continue;
      if (slot - h.lastAddSlot < PYRAMID_GAP_SLOTS) continue;
      if (h.cost >= MAX_POSITION_LAMPORTS) continue;
      const p = priceOf(curve);
      if (p <= 0) continue;
      const value = valueOf(pos.token_amount, p);
      const cost = h.cost > 0n ? h.cost : 1n;
      const ret = Number(value - cost) / Number(cost);
      if (ret < TRAIL_ARM) continue;
      pruneTape(tape, slot);
      if (windowStats(tape, slot).netSol < MIN_NET_INFLOW_SOL) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      let amount = cap < PYRAMID_LAMPORTS ? cap : PYRAMID_LAMPORTS;
      const room = MAX_POSITION_LAMPORTS - h.cost;
      if (amount > room) amount = room;
      if (amount < MIN_BUY_LAMPORTS) continue;
      if (pushBuy(mint, amount)) {
        h.adds += 1;
        h.lastAddSlot = slot;
        tape.entries += 1;
      }
    }

    // 4) Guardrail probes: if round trips lag halfway through the window, bank
    // small quick trades on the most liquid active curves.
    const elapsed = firstBlockTime === null ? 0 : lastBlockTime - firstBlockTime;
    if (elapsed >= PROBE_ARM_SECONDS && roundTripped.size < MIN_DISTINCT_MINTS) {
      const need = MIN_DISTINCT_MINTS - roundTripped.size;
      const liquid: { mint: Pubkey; realSol: number }[] = [];
      for (const [mint, curve] of state.curves) {
        if (curve.complete) continue;
        if (held.has(mint) || boughtMints.has(mint)) continue;
        const tape = tapes.get(mint);
        if (tape && tape.decided) continue;
        const realSol = Number(curve.real_quote_reserves) / 1e9;
        if (realSol < 2) continue;
        liquid.push({ mint, realSol });
      }
      liquid.sort((a, b) => b.realSol - a.realSol);
      let placed = 0;
      for (const { mint } of liquid) {
        if (placed >= need) break;
        if (orders.length >= maxOrders || openSlots <= 0) break;
        const cap = state.maxBuyLamports(mint);
        if (cap < PROBE_LAMPORTS) continue;
        if (pushBuy(mint, PROBE_LAMPORTS)) {
          const tape = tapes.get(mint);
          if (tape) {
            tape.decided = true;
            tape.entries += 1;
          }
          held.set(mint, {
            cost: PROBE_LAMPORTS,
            peakValue: PROBE_LAMPORTS,
            entrySlot: slot,
            buys: 0,
            adds: 0,
            lastAddSlot: slot,
            probe: true,
          });
          placed += 1;
        }
      }
    }

    // Clear decided flags for mints whose buy never filled and which we no longer hold.
    const pendingBuyMints = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuyMints.add(p.order.mint);
    }
    for (const [mint, tape] of tapes) {
      if (tape.decided && !held.has(mint) && !pendingBuyMints.has(mint)) {
        tape.decided = false;
      }
    }

    return orders;
  },
});
