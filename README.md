[![Pump.fun Paper Sprint](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/yovmiar19/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/yovmiar19/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/competitions/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Fast-Rise Graduation Hunter — Pump.fun Paper Sprint

A paper-trading bot for [make.fun](https://make.fun)'s Pump.fun Paper Sprint
(`u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b`). One program,
`main.ts` on Node 22, speaking `agent-fun/replay/v2`. Paper trading only —
no real money ever moves.

## The idea

The dev data (24h sample, 1,222 tokens, 35 graduations) says graduations are
decided almost at birth:

- Only ~3% of tokens graduate; ~8% end above their first-trade price. Almost
  every token pumps, then dumps back toward zero.
- A graduating token reaches 25% of its bonding curve in a median of **0 slots**
  after creation and 50% within ~500 slots. A token that needs more than ~500
  slots to reach 50% has **never** graduated in the sample. Slow grinders are
  a trap.
- Graduates carry few trades in total (median 7), so a long momentum window
  can never catch them in time.

So the bot buys **progress + youth, not momentum**: a token becomes a
candidate only while it is young (slots since its `CreateEvent` under
`maxAgeSlots`) and its real SOL reserve has already crossed ~47% of the curve
(`entryRqSol` = 40 SOL of ~85). A 5-trade tape only sanity-checks buy pressure (buy share,
distinct buyers, no single buyer dominating).

Exits do the work, because even good coins round-trip: a hard stop, a trailing
stop armed once the position is up (banking the middle of a run), an exit at
96% curve progress (just before completion), and a time stop. Winners are left
to run to graduation while they keep making new highs.

Size is pyramided: the first buy is capped at 1% of the token's real SOL
reserve per batch (the harness cap), and later batches add the same capped
slice only while the price sits at or above the last buy's price, up to
`stakeSol` per position. False starts cost one small slice; runners
accumulate size.

## Files

- `main.ts` — entrypoint: hands the strategy to `runBot`.
- `strategy.ts` — the whole strategy (entry, pyramid, exits), written for this
  competition. Fully deterministic: no clock, no environment reads, no
  randomness.
- `vendor/makefun-bot.ts` — the kit's wire shim, copied byte for byte from
  the competition kit (excluded from authorship counts).

## Parameters

See `DEFAULT_PARAMS` in `strategy.ts`. Tuned on the dev window with the kit's
local replay, preferring flat regions of the parameter grid over single-cell
spikes, and validated on a first-half / second-half time split.
