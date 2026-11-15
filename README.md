# GrokBot-Sim — Paper-Trading Solana Memecoin Simulator

**Simulation only. No real money, no wallet, no private keys, no signing, no
real transactions.** The virtual bankroll starts at **$133.70**, mirroring the
X post it is modelled on. Nothing here can move real funds, by design.

Modelled on the "Grok Bot" described in
[@crbpite8's post](https://x.com/crbpite8/status/2121757824128635006)
(15 Nov 2026): a 19-year-old student supposedly turned $133.70 into $14,880 in
8 hours with an automated bot — 92 opportunities scanned, 64 trades, 43 wins,
21 losses. That claim is **unverified marketing with a referral link**; this
simulator reproduces the bot's *mechanics*, not its claimed returns.

## Feature map (post's bot → this simulator)

| Post's bot | This simulator |
|---|---|
| Scanner: new pairs + sudden volume spikes | DexScreener `token-profiles/latest/v1` (new Solana tokens) + h1 volume vs 6h average, h1 breakout, buy/sell ratio (`src/scanner.mjs`) |
| Signal context: reason per opportunity, 1h breakout, liquidity info | Every opportunity gets a written reason (`breakout_h1`, `volume_spike`, `buys_over_sells_h1`, …) in `decisions.jsonl` |
| Rug check before entry | Liquidity size + liquidity/market-cap, mint authority, freeze authority, top-holder concentration (`src/rugcheck.mjs`) — approximate, see Limitations |
| Position sizing by account size, never the same | Size = bankroll × (4% + 8% × signal strength), capped at 12%, floored at 4%; any warning halves the size (`src/engine.mjs`) |
| Execution, max 2% slippage, buy/sell/size recorded | Simulated fill with modeled slippage (grows with size/liquidity, capped at 2%), recorded per trade |
| Logging: 156 records with reasons | JSONL decision log — every opportunity (scanned / filtered / skipped / traded) with its reason |
| Exits: take-profit, volume fell ~60% | Take-profit, stop-loss, m5-volume-drop ≥ 60%, max-hold 8h |

## How to run

```bash
# Node 22 is at ~/workspace/node22/bin/node (the VM default is Node 24)
./run.sh [--cycles N] [--interval-sec S] [--tp PCT] [--sl PCT] [--out DIR]
# Examples:
./run.sh --cycles 6 --interval-sec 90 --tp 12 --sl 8   # verification run
node src/test-engine.mjs                                # deterministic unit test (synthetic data)
```

One bounded run only — no cron, no daemon, no background service. Output goes
to `runs/<timestamp>/`: `decisions.jsonl` (every decision), `summary.json`
(run totals), `config_used.json` (exact config + overrides used).

## Configuration (`config.json`)

| Setting | Default | Meaning |
|---|---|---|
| `bankrollStartUsd` | 133.70 | Virtual bankroll, USD |
| `scanner.maxPairAgeHours` | 24 | Only pairs created within this window |
| `scanner.minLiquidityUsd` | 2000 | Hard floor; below this the pair is filtered |
| `scanner.minH1VolumeUsd` / `minH1Txns` | 500 / 10 | Minimum 1h activity to evaluate |
| `signal.breakoutH1Pct` | 5.0 | Minimum 1h price rise to count as breakout |
| `signal.volumeSpikeRatio` | 1.5 | h1 volume vs average hourly volume (h6/6) |
| `signal.minSignalStrength` | 0.3 | Minimum 0–1 strength score to trade |
| `sizing.minRiskPct` / `maxRiskPct` | 4 / 12 | Risk per trade as % of current bankroll |
| `sizing.warnSizeHalved` | true | Any rug-check warning halves the size once |
| `exits.takeProfitPct` / `stopLossPct` | 30 / 15 | Exit targets (verification run used 12 / 8) |
| `exits.volumeDropPct` | 60 | Exit when m5 volume falls this much from entry |
| `exits.maxHoldHours` | 8 | Maximum hold, mirrors the post's 8-hour session |
| `execution.maxSlippagePct` | 2.0 | Simulated slippage cap (modeled, not measured) |
| `run.cycles` / `run.intervalSec` | 6 / 90 | Bounded run: 6 cycles, 90 s apart |

## Verification run (real data, 15 Nov 2026)

Command: `./run.sh --cycles 6 --interval-sec 90 --tp 12 --sl 8`
(overrides recorded in `runs/2026-11-15T12-29-44/config_used.json`).
Duration 501 s (~8.4 min). Log: `runs/2026-11-15T12-29-44/decisions.jsonl`.

- Opportunities: **24** — scanned 7, filtered 15, skipped 0, traded 2.
- Most filtered tokens were brand-new pairs with ~$0 liquidity (just created,
  no pool yet) — the filter works as designed.
- **T1 GETAJOB**: opened cycle 1, $4.93 @ 0.0007697 (h1 breakout +69.9%,
  strength 0.421), closed cycle 2 via **volume_drop**, **+$0.05 (+1.08%)**.
- **T2 dragoncat**: opened cycle 1, $4.68 @ 0.0000067516 (h1 breakout +9.5%,
  strength 0.376; size halved by warnings `liquidity_low` + `holders_unknown`).
  Still open at run end.
- Bankroll: **$133.70 → $133.76** equity at entry marks (+$0.06); cash $129.07
  + open position $4.68. Post-run mark a few minutes later: dragoncat +7.62%,
  equity **$134.11 (+$0.41)** — marked once, not part of the run summary.
- Closed-trade win rate: 100% — on **n = 1** closed trade. That number means
  nothing as a performance claim, and neither does an 8-minute window against
  the post's 8-hour session.

Unit test: `node src/test-engine.mjs` — **20 passed, 0 failed** (synthetic
prices only; proves sizing/exit/slippage logic, not trading performance).

## Honest limitations — read this before believing any number above

- **Simulated fills are not real fills.** Slippage is a model
  (`base 0.1% + size/liquidity × 100`, capped at 2%). Real memecoin fills on
  thin pools are usually worse, and market orders can fail or partially fill.
- **The rug check is approximate.** What it *can* verify with free data:
  liquidity size, liquidity vs market cap, mint authority revoked, freeze
  authority revoked, top-holder share. What it *cannot* verify:
  - **Liquidity lock / LP burn** — free DexScreener data does not expose lock
    status. The post's bot claimed a lock check; this simulator cannot
    reproduce it with free APIs.
  - **Honeypots** — no sell simulation without a paid API.
  - **Dev wallets, snipers, insider allocations**, off-chain promises.
  - Solana programs are not source-verified on-chain the way EVM contracts are.
  A "pass" means "no red flag found in the free data", **not** "safe".
- **Holder concentration was unavailable during the verification run.** The
  public Solana RPC returns HTTP 429 ("Too many requests for a specific RPC
  call") for `getTokenLargestAccounts`, even for SOL itself. The code retries
  and degrades to a `holders_unknown` warning, which halves position size —
  the conservative outcome. Both traded tokens got that warning for this reason.
- **GMGN was not usable.** Its public endpoints return a Cloudflare challenge
  from this environment, so GMGN contributed nothing; DexScreener + Solana RPC
  are the only live sources. No login was attempted.
- **The m5 volume-drop exit is twitchy.** m5 volume swings fast, so it fired
  after a single cycle for T1. On a longer horizon the post's "volume fell 60%"
  is better read on a wider window; the window is configurable
  (`exits.volumeWindow`, currently `m5`).
- **DexScreener data is aggregated and rolling** (m5/h1/h6/h24 buckets), not
  tick-level. Breakout and spike signals are computed on those buckets.
- **The verification window is tiny** (8 minutes, 24 opportunities, 2 trades).
  It proves the pipeline works end to end on real data; it proves nothing
  about profitability. The post's 111× in 8 hours is not a reproducible
  target — treat it as marketing.

## Design notes

- Stdlib-only Node.js (global `fetch`, no npm dependencies). Node 22.
- Data sources: DexScreener public API (no key, ~300 req/min) and Solana
  public JSON-RPC `https://api.mainnet-beta.solana.com` (no key). No paid APIs,
  no keys of any kind.
- Reference: patterns were checked against the public structure of
  [freqtrade](https://github.com/freqtrade/freqtrade) (56.9k stars, GPL-3.0) —
  strategy/signal logic separated from the ledger/execution layer, as in
  `src/scanner.mjs` vs `src/engine.mjs`. Read-only; no code copied. No
  "grok bot" / "memecoin sniper" repositories were used — that category is
  rife with scams and wallet drainers.
- Files: `config.json`, `run.sh`, `src/rpc.mjs` (Solana RPC),
  `src/dexscreener.mjs` (DexScreener client), `src/scanner.mjs` (signals),
  `src/rugcheck.mjs` (rug checks), `src/engine.mjs` (paper ledger),
  `src/run.mjs` (main loop), `src/test-engine.mjs` (unit test).
