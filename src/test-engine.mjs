// Deterministic unit test for the paper engine (synthetic prices only).
// This is NOT live data and its results are NOT trading performance — it only
// proves the sizing/exit/slippage logic behaves as documented.
// Run: node src/test-engine.mjs   (exit 0 = all pass)

import { PaperEngine } from "./engine.mjs";

const cfg = {
  bankrollStartUsd: 133.7,
  execution: { baseSlippagePct: 0.1, maxSlippagePct: 2.0, slippagePerLiquidityPct: 100.0 },
  exits: { maxHoldHours: 8, stopLossPct: 15.0, takeProfitPct: 30.0, volumeDropPct: 60.0, volumeWindow: "m5" },
  sizing: { baseRiskPct: 4.0, maxOpenPositions: 5, maxRiskPct: 12.0, minRiskPct: 4.0, riskRangePct: 8.0, warnSizeHalved: true },
};

let passed = 0;
let failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name} ${detail}`); }
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

function fakePair(price, m5Vol = 1000, liq = 50000) {
  return { priceUsd: String(price), volume: { m5: m5Vol, h1: 6000 }, liquidity: { usd: liq } };
}
function openAt(engine, price, strength = 0.5, warns = false, sizeOverride = null) {
  const s = engine.sizeFor(strength, warns);
  return engine.openPosition({
    mint: `MINT${engine.tradeSeq + 1}`, symbol: "TEST", pairAddress: "PAIR",
    priceUsd: price, sizeUsd: sizeOverride ?? s.sizeUsd, liquidityUsd: 50000,
    entryM5Volume: 1000, entryH1Volume: 6000, strength, reason: "test", warns: warns ? ["test_warn"] : [], now: Date.now(),
  });
}

// 1. Sizing varies with strength and is capped/floored.
{
  const e = new PaperEngine(cfg);
  const low = e.sizeFor(0, false);
  const mid = e.sizeFor(0.5, false);
  const high = e.sizeFor(1, false);
  check("sizing: low < mid < high", low.sizeUsd < mid.sizeUsd && mid.sizeUsd < high.sizeUsd, JSON.stringify({ low, mid, high }));
  check("sizing: high capped at 12% of bankroll", approx(high.riskPct, 12), `riskPct=${high.riskPct}`);
  check("sizing: low floored at 4% of bankroll", approx(low.riskPct, 4), `riskPct=${low.riskPct}`);
  const warned = e.sizeFor(1, true);
  check("sizing: warns halve the size", approx(warned.sizeUsd, high.sizeUsd / 2, 0.01), `${warned.sizeUsd} vs ${high.sizeUsd / 2}`);
}

// 2. Slippage is capped at the max and grows with size/liquidity.
{
  const e = new PaperEngine(cfg);
  const small = e.slippageFor(10, 50000);
  const huge = e.slippageFor(1_000_000, 5000);
  check("slippage: small trade < max", small < 2.0, `slip=${small}`);
  check("slippage: huge trade capped at 2%", approx(huge, 2.0), `slip=${huge}`);
  check("slippage: larger size -> larger slip", e.slippageFor(100, 50000) > e.slippageFor(10, 50000));
}

// 3. Take-profit fires at +TP%.
{
  const e = new PaperEngine(cfg);
  const pos = openAt(e, 1.0);
  const closed = e.checkExits(pos, fakePair(1.0 * 1.31), Date.now() + 60_000);
  check("exit: take-profit fires at +31%", closed?.exitReason === "take_profit", JSON.stringify(closed?.exitReason));
  check("exit: TP trade is a win", closed && closed.pnlUsd > 0, `pnl=${closed?.pnlUsd}`);
}

// 4. Stop-loss fires at -SL%.
{
  const e = new PaperEngine(cfg);
  const pos = openAt(e, 1.0);
  const closed = e.checkExits(pos, fakePair(1.0 * 0.84), Date.now() + 60_000);
  check("exit: stop-loss fires at -16%", closed?.exitReason === "stop_loss", JSON.stringify(closed?.exitReason));
  check("exit: SL trade is a loss", closed && closed.pnlUsd < 0, `pnl=${closed?.pnlUsd}`);
}

// 5. No exit inside the TP/SL band.
{
  const e = new PaperEngine(cfg);
  const pos = openAt(e, 1.0);
  const closed = e.checkExits(pos, fakePair(1.05), Date.now() + 60_000);
  check("exit: no exit at +5% (inside band)", closed === null);
}

// 6. Volume-drop exit fires when m5 volume falls >= 60%.
{
  const e = new PaperEngine(cfg);
  const pos = openAt(e, 1.0);
  const closed = e.checkExits(pos, fakePair(1.02, 350), Date.now() + 60_000); // 1000 -> 350 = -65%
  check("exit: volume-drop fires at -65% m5 volume", closed?.exitReason === "volume_drop", JSON.stringify(closed?.exitReason));
  const e2 = new PaperEngine(cfg);
  const pos2 = openAt(e2, 1.0);
  const notClosed = e2.checkExits(pos2, fakePair(1.02, 700), Date.now() + 60_000); // -30% only
  check("exit: no volume-drop at -30% m5 volume", notClosed === null);
}

// 7. Max-hold fires after maxHoldHours.
{
  const e = new PaperEngine(cfg);
  const t0 = Date.now();
  const pos = openAt(e, 1.0);
  const notClosed = e.checkExits(pos, fakePair(1.02), t0 + 7 * 3_600_000);
  check("exit: no max-hold before 8h", notClosed === null);
  const closed = e.checkExits(pos, fakePair(1.02), t0 + 8 * 3_600_000 + 1000);
  check("exit: max-hold fires after 8h", closed?.exitReason === "max_hold", JSON.stringify(closed?.exitReason));
}

// 8. Stop-loss takes priority over take-profit/volume checks (checked first).
{
  const e = new PaperEngine(cfg);
  const pos = openAt(e, 1.0);
  const closed = e.checkExits(pos, fakePair(0.80, 100), Date.now() + 60_000); // -20% AND volume -90%
  check("exit: stop-loss wins over volume-drop", closed?.exitReason === "stop_loss", JSON.stringify(closed?.exitReason));
}

// 9. Insufficient cash refuses the trade.
{
  const e = new PaperEngine(cfg);
  const pos = e.openPosition({
    mint: "X", symbol: "TEST", pairAddress: "PAIR", priceUsd: 1, sizeUsd: 99999,
    liquidityUsd: 50000, entryM5Volume: 1000, entryH1Volume: 6000,
    strength: 1, reason: "test", warns: [], now: Date.now(),
  });
  check("engine: oversized trade refused", pos === null);
}

// 10. Cash accounting: cash falls by size on open, rises by proceeds on close.
{
  const e = new PaperEngine(cfg);
  const before = e.cashUsd;
  const pos = openAt(e, 1.0, 0.5, false, 10);
  check("ledger: cash falls by size on open", approx(e.cashUsd, before - 10), `${e.cashUsd} vs ${before - 10}`);
  e.checkExits(pos, fakePair(1.31), Date.now() + 60_000);
  check("ledger: cash rises on close", e.cashUsd > before - 10, `cash=${e.cashUsd}`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
