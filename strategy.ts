// Late-entry graduation hunter for the pump.fun paper sprint (agent-fun/replay/v2).
//
// What the dev data actually shows (24h sample, 1,222 tokens, 35 graduations):
//   - Only ~3% of tokens ever graduate; ~8% end above their first-trade price.
//     Almost every token pumps and then dumps back toward zero, so holding to
//     the end of a token's life loses money on nearly every coin.
//   - Graduations are decided almost at birth. A token that graduates reaches
//     25% of its bonding curve in a median of 0 slots after creation, and a
//     token that needs more than ~500 slots to reach 50% of the curve has NEVER
//     graduated in the sample (0 of 20). Slow grinders are a trap.
//   - The one reliably positive shape found on this window is a LATE entry:
//     buy only once a young token (slots since its CreateEvent under
//     maxAgeSlots) has already crossed ~47% of its curve (entryRqSol = 40 of
//     ~85 SOL). From there graduation is one more ~2.7x in price, and 64% of
//     tokens that reach 50% within 500 slots do graduate. Take the double
//     (+100% target) when it comes, cut at -15%, trail the rest. Early
//     entries (25% progress)
//     and every form of pyramiding into strength tested worse: this market
//     punishes chasing, so there is no pyramid here — one capped buy per
//     position, sized by the harness's 1%-of-real-reserve cap.
//   - The late entry alone trades too few coins for the 20-coin guardrail
//     (about 9 coins in a 6-hour window), so tiny probe round trips (probeSol)
//     on liquid curves top the distinct-coin count up. A probe costs ~0.0015
//     SOL in fees and is sold as soon as its buy lands; it exists only to
//     clear the bar, never to make money.
//   - Sells are sized so their quote-out never exceeds the token's real SOL
//     reserve: a dumping token's reserves collapse, and a whole-position sell
//     bigger than what is left is rejected and the position gets stuck.
//
// Deterministic by construction: no clock, no environment reads, no randomness;
// every decision comes from the batch stream, and maps are iterated in the
// insertion order the stream produced.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Real SOL reserve at which a young token becomes a candidate (50% of curve). */
  entryRqSol: number;
  /** Real SOL reserve at which to exit: 96% of the ~85 SOL graduation point. */
  exitRqSol: number;
  /** Youngest only: slots since the CreateEvent past which a token may not enter. */
  maxAgeSlots: number;
  /** Most SOL (at cost) in one position. The 1% reserve cap binds first. */
  stakeSol: number;
  /** Smallest buy worth sending (SOL). */
  minBuySol: number;
  /** Hard stop: sell all when the mark falls this far below the first fill. */
  stopLoss: number;
  /** Trailing stop arms once the mark reaches entry * (1 + trailArm). */
  trailArm: number;
  /** Trailing stop: sell all when the mark falls this far below its peak. */
  trail: number;
  /** Fixed target: sell all at entry * (1 + target). 0 disables it. */
  target: number;
  /** Time stop: sell all this many slots after the first fill. */
  maxHoldSlots: number;
  /** Slots to wait after an exit before the same token may be bought again. */
  cooldownSlots: number;
  /** Most separate entries (first buys) per token over the run. */
  maxEntriesPerMint: number;
  /** Most core positions open at once (the rest of the cap is for probes). */
  maxMain: number;
  /** Pyramid adds after the first buy. Off: this market punishes chasing. */
  pyramid: boolean;
  /** Slippage allowance on buys (bps). Fresh rockets move fast between the
   *  decision slot and the fill slot, so this is deliberately generous. */
  buySlipBps: number;
  /** Slippage allowance on sells (bps). */
  sellSlipBps: number;
  /** Trades kept per token for the buy-pressure check. */
  tapeN: number;
  /** Lowest buy share of SOL volume over the tape at entry. */
  minBuyShare: number;
  /** Fewest distinct buying wallets over the tape at entry. */
  minBuyers: number;
  /** Largest single wallet's share of the tape's buy SOL at entry. */
  maxBuyerShare: number;
  /** Probe size (SOL) for guardrail breadth round trips. */
  probeSol: number;
  /** Distinct coins to reach (core + probes) before probes stop. */
  probeTargetCoins: number;
  /** Probe only curves with real SOL reserves inside this band. */
  probeMinRqSol: number;
  probeMaxRqSol: number;
  /** Fewest slots between probe buys. */
  probeEverySlots: number;
}

/** Defaults: tuned on the dev window, preferring flat regions over spikes. */
export const DEFAULT_PARAMS: Params = {
  entryRqSol: 40,
  exitRqSol: 81.6,
  maxAgeSlots: 500,
  stakeSol: 1.0,
  minBuySol: 0.01,
  stopLoss: 0.15,
  trailArm: 0.1,
  trail: 0.25,
  target: 1.0,
  maxHoldSlots: 1500,
  cooldownSlots: 150,
  maxEntriesPerMint: 3,
  maxMain: 4,
  pyramid: false,
  buySlipBps: 5000,
  sellSlipBps: 10000,
  tapeN: 5,
  minBuyShare: 0.5,
  minBuyers: 3,
  maxBuyerShare: 0.6,
  probeSol: 0.05,
  probeTargetCoins: 25,
  probeMinRqSol: 5,
  probeMaxRqSol: 60,
  probeEverySlots: 300,
};

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  /** SOL volume of this trade, in lamports (fits exactly in a float). */
  solLamports: number;
  user: string;
}

interface Tape {
  createdSlot: number | null;
  firstSeenSlot: number;
  trades: TapeTrade[];
  /** Slot of the most recent trade seen on this token. */
  lastTradeSlot: number;
}

/** One live position, tracked from the fills the harness reports. */
interface Tracked {
  /** Price (lamports of SOL per token-lamport) of the first fill. */
  entryPrice: number;
  /** Highest mark price seen since entry. */
  peakPrice: number;
  /** Mark price at the most recent buy fill (pyramid gate). */
  lastBuyPrice: number;
  entrySlot: number;
  tokens: bigint;
  costLamports: bigint;
  /** True when this position is a breadth probe: sell as soon as it lands. */
  probe: boolean;
}

export function createStrategy(params: Params): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const book = new Map<Pubkey, Tracked>();
  /** Last exit slot per mint (cooldown) and how many times it was entered. */
  const lastExitSlot = new Map<Pubkey, number>();
  const entriesByMint = new Map<Pubkey, number>();
  /** Every mint ever bought (core or probe): the distinct-coin count. */
  const coinsTraded = new Set<Pubkey>();
  /** Mints a probe buy was sent for (probe once per mint, ever). */
  const probedMints = new Set<Pubkey>();
  /** Mints with a probe buy in flight (fill not seen yet). */
  const probePending = new Set<Pubkey>();
  let lastProbeSlot = -1_000_000;

  function tapeFor(mint: Pubkey, slot: number): Tape {
    let tape = tapes.get(mint);
    if (tape === undefined) {
      tape = { createdSlot: null, firstSeenSlot: slot, trades: [], lastTradeSlot: slot };
      tapes.set(mint, tape);
    }
    return tape;
  }

  /** Fold one batch's fills into the position book. */
  function applyFills(batch: Batch): void {
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      const mint = fill.mint;
      const tokens = BigInt(fill.token_amount);
      const quote = BigInt(fill.quote_lamports);
      if (fill.side === 'buy') {
        if (tokens === 0n || quote === 0n) continue;
        const fillPrice = Number(quote) / Number(tokens);
        const held = book.get(mint);
        const isProbe = probePending.has(mint);
        probePending.delete(mint);
        coinsTraded.add(mint);
        if (held === undefined) {
          book.set(mint, {
            entryPrice: fillPrice,
            peakPrice: fillPrice,
            lastBuyPrice: fillPrice,
            entrySlot: fill.slot,
            tokens,
            costLamports: quote,
            probe: isProbe,
          });
          entriesByMint.set(mint, (entriesByMint.get(mint) ?? 0) + 1);
        } else {
          held.tokens += tokens;
          held.costLamports += quote;
          held.lastBuyPrice = fillPrice;
          if (fillPrice > held.peakPrice) held.peakPrice = fillPrice;
        }
      } else {
        const held = book.get(mint);
        if (held === undefined) continue;
        if (tokens >= held.tokens) {
          book.delete(mint);
          lastExitSlot.set(mint, fill.slot);
        } else {
          const removed = (held.costLamports * tokens) / held.tokens;
          held.tokens -= tokens;
          held.costLamports -= removed;
        }
      }
    }
  }

  /** Mark price (SOL per token) and real SOL reserve of a curve, or null. */
  function curveQuote(state: BotState, mint: Pubkey): { price: number; rqSol: number } | null {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return null;
    const vt = Number(curve.virtual_token_reserves);
    const vq = Number(curve.virtual_quote_reserves);
    if (vt <= 0 || vq <= 0) return null;
    return { price: vq / vt, rqSol: Number(curve.real_quote_reserves) / 1e9 };
  }

  /** Buy pressure over the tape: share of SOL volume that bought, distinct
   *  buyers, and the largest single buyer's share of buy volume. */
  function tapePressure(tape: Tape): { buyShare: number; buyers: number; topShare: number } {
    let buySol = 0;
    let allSol = 0;
    const buyers = new Set<string>();
    const byBuyer = new Map<string, number>();
    for (const trade of tape.trades) {
      allSol += trade.solLamports;
      if (!trade.isBuy) continue;
      buySol += trade.solLamports;
      buyers.add(trade.user);
      byBuyer.set(trade.user, (byBuyer.get(trade.user) ?? 0) + trade.solLamports);
    }
    let top = 0;
    for (const volume of byBuyer.values()) if (volume > top) top = volume;
    return {
      buyShare: allSol > 0 ? buySol / allSol : 0,
      buyers: buyers.size,
      topShare: buySol > 0 ? top / buySol : 1,
    };
  }

  /**
   * Tokens to sell so the quote-out fits inside the token's real SOL reserve.
   * A dumping token's reserves collapse, and a whole-position sell bigger than
   * what is left is rejected outright; selling the fitting fraction instead
   * keeps the exit working. Returns 0 when nothing can be sold for a profit
   * over the tx fee (the harness writes such dust off at the end).
   */
  function sellSize(state: BotState, mint: Pubkey, tokens: bigint): bigint {
    const curve = state.curves.get(mint);
    if (curve === undefined || curve.complete) return 0n;
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    const rq = curve.real_quote_reserves;
    if (vt <= 0n || vq <= 0n || rq <= 0n) return 0n;
    // quote-out for selling all: q = t*vq/(vt+t). If it fits, sell all.
    const qAll = (tokens * vq) / (vt + tokens);
    if (qAll <= rq) return tokens;
    // Largest t with t*vq/(vt+t) <= 0.98*rq: t <= 0.98*rq*vt/(vq-0.98*rq).
    const capQ = (rq * 98n) / 100n;
    if (capQ <= 0n || vq <= capQ) return 0n;
    const fitted = (capQ * vt) / (vq - capQ);
    return fitted < tokens ? fitted : tokens;
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    // 1. Record this batch's events on each token's tape.
    for (const event of batch.events) {
      if (event.event === 'CreateEvent') {
        tapeFor(event.mint, event.slot).createdSlot = event.slot;
      } else if (event.event === 'TradeEvent') {
        const tape = tapeFor(event.mint, event.slot);
        tape.trades.push({
          slot: event.slot,
          isBuy: event.is_buy,
          solLamports: Number(event.sol_amount),
          user: event.user,
        });
        if (tape.trades.length > params.tapeN) tape.trades.splice(0, tape.trades.length - params.tapeN);
        tape.lastTradeSlot = event.slot;
      }
    }

    // 2. Fold fills into the book, then drop anything the account no longer holds
    //    (the harness closes completed positions itself).
    applyFills(batch);
    for (const mint of [...book.keys()]) {
      if (!state.positions.has(mint)) {
        book.delete(mint);
        lastExitSlot.set(mint, batch.slot);
      }
    }

    const orders: OrderInput[] = [];
    const maxOrders = state.hello.caps.max_orders_per_batch;
    const txFee = state.txFeeLamports();
    let freeCash = state.freeCashLamports();
    const pendingBuy = new Set<Pubkey>();
    const pendingSell = new Set<Pubkey>();
    for (const pending of state.pending.values()) {
      if (pending.order.side === 'buy') pendingBuy.add(pending.order.mint);
      else pendingSell.add(pending.order.mint);
    }
    /** Reserve cash for an order already queued in this reply. */
    function reserveFor(order: OrderInput): void {
      freeCash -= txFee;
      if (order.side === 'buy') freeCash -= BigInt(order.quote_lamports);
    }
    function queueSell(mint: Pubkey): void {
      const holding = state.positions.get(mint);
      if (holding === undefined || holding.token_amount === 0n) return;
      const amount = sellSize(state, mint, holding.token_amount);
      if (amount <= 0n) return;
      if (freeCash < txFee) return;
      const order: OrderInput = { side: 'sell', mint, token_amount: amount, max_slippage_bps: params.sellSlipBps };
      orders.push(order);
      reserveFor(order);
      pendingSell.add(mint);
    }

    // 3. Exits first. Probes sell the moment they land; core positions leave
    //    on graduation, the hard stop, the target, the trailing stop, or time.
    for (const [mint, held] of book) {
      if (orders.length >= maxOrders) break;
      if (pendingSell.has(mint)) continue;
      const holding = state.positions.get(mint);
      if (holding === undefined || holding.token_amount === 0n) continue;
      if (held.probe) {
        queueSell(mint);
        continue;
      }
      const quote = curveQuote(state, mint);
      if (quote === null) continue;
      if (quote.price > held.peakPrice) held.peakPrice = quote.price;
      const atGraduation = quote.rqSol >= params.exitRqSol;
      const atStop = quote.price <= held.entryPrice * (1 - params.stopLoss);
      const atTarget = params.target > 0 && quote.price >= held.entryPrice * (1 + params.target);
      const atTrail =
        held.peakPrice >= held.entryPrice * (1 + params.trailArm) &&
        quote.price <= held.peakPrice * (1 - params.trail);
      const atTime = batch.slot - held.entrySlot > params.maxHoldSlots;
      if (atGraduation || atStop || atTarget || atTrail || atTime) queueSell(mint);
    }

    // 4. Pyramid adds, only when enabled: one capped slice per batch while the
    //    price sits at or above the last buy's price and the position is under
    //    its stake. Disabled by default: this market punishes chasing.
    if (params.pyramid) {
      for (const [mint, held] of book) {
        if (orders.length >= maxOrders) break;
        if (pendingBuy.has(mint) || pendingSell.has(mint) || held.probe) continue;
        const stakeLamports = BigInt(Math.round(params.stakeSol * 1e9));
        if (held.costLamports >= stakeLamports) continue;
        const quote = curveQuote(state, mint);
        if (quote === null || quote.rqSol >= params.exitRqSol) continue;
        if (quote.price < held.lastBuyPrice) continue;
        if (batch.slot - held.entrySlot > params.maxHoldSlots) continue;
        const cap = (state.maxBuyLamports(mint) * 98n) / 100n;
        const room = stakeLamports - held.costLamports;
        let size = cap < room ? cap : room;
        const affordable = freeCash - txFee;
        if (size > affordable) size = affordable;
        const minBuy = BigInt(Math.round(params.minBuySol * 1e9));
        if (size < minBuy) continue;
        const order: OrderInput = { side: 'buy', mint, quote_lamports: size, max_slippage_bps: params.buySlipBps };
        orders.push(order);
        reserveFor(order);
        pendingBuy.add(mint);
      }
    }

    // 5. New core entries: young tokens that already crossed the progress line.
    let newEntriesQueued = 0;
    if (state.committedPositionCount() + newEntriesQueued < params.maxMain) {
      for (const [mint, curve] of state.curves) {
        if (orders.length >= maxOrders) break;
        if (state.committedPositionCount() + newEntriesQueued >= params.maxMain) break;
        if (curve.complete) continue;
        if (book.has(mint) || pendingBuy.has(mint) || pendingSell.has(mint)) continue;
        if ((entriesByMint.get(mint) ?? 0) >= params.maxEntriesPerMint) continue;
        const lastExit = lastExitSlot.get(mint);
        if (lastExit !== undefined && batch.slot - lastExit < params.cooldownSlots) continue;
        const tape = tapes.get(mint);
        const created = tape?.createdSlot ?? curve.created_slot ?? null;
        const age = created === null ? Number.POSITIVE_INFINITY : batch.slot - created;
        if (age > params.maxAgeSlots) continue;
        const quote = curveQuote(state, mint);
        if (quote === null) continue;
        if (quote.rqSol < params.entryRqSol || quote.rqSol >= params.exitRqSol) continue;
        if (tape !== undefined && tape.trades.length > 0) {
          const pressure = tapePressure(tape);
          if (pressure.buyShare < params.minBuyShare) continue;
          if (pressure.buyers < params.minBuyers) continue;
          if (pressure.topShare > params.maxBuyerShare) continue;
        }
        const cap = (state.maxBuyLamports(mint) * 98n) / 100n;
        const stakeLamports = BigInt(Math.round(params.stakeSol * 1e9));
        let size = cap < stakeLamports ? cap : stakeLamports;
        const affordable = freeCash - txFee;
        if (size > affordable) size = affordable;
        const minBuy = BigInt(Math.round(params.minBuySol * 1e9));
        if (size < minBuy) continue;
        const order: OrderInput = { side: 'buy', mint, quote_lamports: size, max_slippage_bps: params.buySlipBps };
        orders.push(order);
        reserveFor(order);
        pendingBuy.add(mint);
        newEntriesQueued += 1;
      }
    }

    // 6. Breadth probes: tiny round trips on liquid curves until the
    //    distinct-coin count is on target. One probe per probeEverySlots, most
    //    recently traded first, never twice on the same mint.
    if (
      coinsTraded.size < params.probeTargetCoins &&
      batch.slot - lastProbeSlot >= params.probeEverySlots &&
      state.committedPositionCount() + newEntriesQueued < state.hello.caps.max_open_positions
    ) {
      let bestMint: Pubkey | null = null;
      let bestSlot = -1;
      for (const [mint, curve] of state.curves) {
        if (curve.complete) continue;
        if (book.has(mint) || pendingBuy.has(mint) || pendingSell.has(mint)) continue;
        if (probedMints.has(mint) || coinsTraded.has(mint)) continue;
        const quote = curveQuote(state, mint);
        if (quote === null) continue;
        if (quote.rqSol < params.probeMinRqSol || quote.rqSol > params.probeMaxRqSol) continue;
        const tape = tapes.get(mint);
        const activity = tape?.lastTradeSlot ?? -1;
        if (activity > bestSlot) {
          bestSlot = activity;
          bestMint = mint;
        }
      }
      if (bestMint !== null && orders.length < maxOrders) {
        const cap = (state.maxBuyLamports(bestMint) * 98n) / 100n;
        const probeLamports = BigInt(Math.round(params.probeSol * 1e9));
        let size = cap < probeLamports ? cap : probeLamports;
        const affordable = freeCash - txFee;
        if (size > affordable) size = affordable;
        const minBuy = BigInt(Math.round(params.minBuySol * 1e9));
        if (size >= minBuy) {
          const order: OrderInput = { side: 'buy', mint: bestMint, quote_lamports: size, max_slippage_bps: params.buySlipBps };
          orders.push(order);
          reserveFor(order);
          pendingBuy.add(bestMint);
          probedMints.add(bestMint);
          probePending.add(bestMint);
          lastProbeSlot = batch.slot;
        }
      }
    }

    return orders;
  }

  return { onBatch };
}
