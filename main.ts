// Fast-rise graduation hunter for the pump.fun paper sprint (agent-fun/replay/v2).
// The strategy lives in strategy.ts; the wire shim is the kit's sdk/ts/makefun-bot.ts,
// vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
