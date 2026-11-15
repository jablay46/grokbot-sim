// GrokBot-Sim main loop — paper trading only, no real money, no keys.
// One bounded run: N scan cycles, then a summary. No cron, no daemon.
//
// Usage:
//   node src/run.mjs [--cycles N] [--interval-sec S] [--tp PCT] [--sl PCT]
//                    [--config path] [--out dir]
//   --tp/--sl override the config exits (percent) for this run only and are
//   recorded in the run summary.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { latestSolanaProfiles, pairByAddress, pairsForToken, pickBestPair, sleep } from "./dexscreener.mjs";
import { rugCheck } from "./rugcheck.mjs";
import { evaluateSignal } from "./scanner.mjs";
import { PaperEngine } from "./engine.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      out[key] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const configPath = args.config ? path.resolve(args.config) : path.join(__dirname, "..", "config.json");
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const overrides = {};
  if (args.cycles) cfg.run.cycles = Number(args.cycles);
  if (args.intervalSec) cfg.run.intervalSec = Number(args.intervalSec);
  if (args.tp) { cfg.exits.takeProfitPct = Number(args.tp); overrides.takeProfitPct = Number(args.tp); }
  if (args.sl) { cfg.exits.stopLossPct = Number(args.sl); overrides.stopLossPct = Number(args.sl); }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outDir = args.out ? path.resolve(args.out) : path.join(__dirname, "..", "runs", stamp);
  fs.mkdirSync(outDir, { recursive: true });
  const logPath = path.join(outDir, "decisions.jsonl");
  const logStream = fs.createWriteStream(logPath, { flags: "a" });
  const log = (rec) => {
    logStream.write(JSON.stringify({ ts: new Date().toISOString(), ...rec }) + "\n");
  };

  const engine = new PaperEngine(cfg);
  const seen = new Set();
  const counts = { scanned: 0, filtered: 0, skipped: 0, traded: 0, opportunities: 0 };
  const startedAt = Date.now();
  fs.writeFileSync(path.join(outDir, "config_used.json"), JSON.stringify({ configPath, overrides, cfg }, null, 2));

  console.log(`GrokBot-Sim (PAPER ONLY) — bankroll $${cfg.bankrollStartUsd.toFixed(2)}, cycles=${cfg.run.cycles}, interval=${cfg.run.intervalSec}s, TP=${cfg.exits.takeProfitPct}% SL=${cfg.exits.stopLossPct}%`);
  console.log(`Log: ${logPath}`);

  const runCycle = async (cycle) => {
    let profiles;
    try {
      profiles = await latestSolanaProfiles(cfg.scanner.profilesPerCycle);
    } catch (e) {
      console.log(`[cycle ${cycle}] scanner fetch failed: ${e.message}`);
      log({ type: "cycle_error", cycle, error: String(e.message) });
      return;
    }
    const fresh = profiles.filter((p) => !seen.has(p.tokenAddress));
    fresh.forEach((p) => seen.add(p.tokenAddress));
    console.log(`[cycle ${cycle}] ${profiles.length} latest Solana profiles, ${fresh.length} new`);
    for (const prof of fresh) {
      const mint = prof.tokenAddress;
      counts.opportunities++;
      let pairs;
      try {
        pairs = await pairsForToken(mint);
      } catch (e) {
        log({ type: "opportunity", cycle, mint, outcome: "scanned", reasons: [`pairs_fetch_failed:${e.message}`] });
        counts.scanned++;
        continue;
      }
      const pair = pickBestPair(pairs, cfg.scanner.quoteSymbols);
      if (!pair) {
        log({ type: "opportunity", cycle, mint, outcome: "scanned", reasons: ["no_pairs"] });
        counts.scanned++;
        continue;
      }
      const symbol = pair.baseToken?.symbol ?? "?";
      const sig = evaluateSignal(pair, cfg);
      const base = { type: "opportunity", cycle, mint, symbol, pairAddress: pair.pairAddress, pairAgeHours: sig.ageHours, ...sig.facts };
      if (!sig.tradable) {
        log({ ...base, outcome: sig.outcome, reasons: sig.reasons, strength: sig.strength });
        counts[sig.outcome === "filtered" ? "filtered" : "scanned"]++;
        await sleep(cfg.run.requestDelayMs);
        continue;
      }
      // Signal passed -> rug check (RPC, only for real candidates).
      const rug = await rugCheck(pair, cfg, cfg.run.rpcDelayMs);
      if (rug.verdict === "fail") {
        log({ ...base, outcome: "filtered", reasons: [...sig.reasons, ...rug.fails.map((f) => `rug:${f}`)], strength: sig.strength, rug: { verdict: "fail", fails: rug.fails, warns: rug.warns, facts: rug.facts } });
        counts.filtered++;
        continue;
      }
      if (engine.openCount() >= cfg.sizing.maxOpenPositions) {
        log({ ...base, outcome: "skipped", reasons: [...sig.reasons, `max_open_positions:${cfg.sizing.maxOpenPositions}`], strength: sig.strength, rug: { verdict: "pass", warns: rug.warns } });
        counts.skipped++;
        continue;
      }
      if (engine.isHolding(mint)) {
        log({ ...base, outcome: "skipped", reasons: [...sig.reasons, "already_holding"] , strength: sig.strength, rug: { verdict: "pass", warns: rug.warns } });
        counts.skipped++;
        continue;
      }
      const price = Number(pair.priceUsd);
      if (!price || price <= 0) {
        log({ ...base, outcome: "skipped", reasons: [...sig.reasons, "no_price"] , strength: sig.strength });
        counts.skipped++;
        continue;
      }
      const sizing = engine.sizeFor(sig.strength, rug.warns.length > 0);
      const pos = engine.openPosition({
        mint, symbol, pairAddress: pair.pairAddress, priceUsd: price, sizeUsd: sizing.sizeUsd,
        liquidityUsd: pair?.liquidity?.usd ?? 0,
        entryM5Volume: pair?.volume?.m5 ?? 0, entryH1Volume: pair?.volume?.h1 ?? 0,
        strength: sig.strength, reason: sig.reasons.join("; "), warns: rug.warns, now: Date.now(),
      });
      if (!pos) {
        log({ ...base, outcome: "skipped", reasons: [...sig.reasons, "insufficient_cash"], strength: sig.strength });
        counts.skipped++;
        continue;
      }
      counts.traded++;
      log({ ...base, outcome: "traded", reasons: sig.reasons, strength: sig.strength, rug: { verdict: "pass", warns: rug.warns, facts: rug.facts }, trade: { id: pos.id, sizeUsd: pos.sizeUsd, riskPct: sizing.riskPct, entryPrice: pos.entryPrice, entrySlippagePct: pos.entrySlippagePct, tokens: pos.tokens } });
      log({ type: "trade_open", cycle, ...pos });
      console.log(`[cycle ${cycle}] TRADED ${pos.id} ${symbol} $${pos.sizeUsd} @ ${pos.entryPrice} (strength ${sig.strength}, warns: ${rug.warns.join("|") || "none"})`);
      await sleep(cfg.run.requestDelayMs);
    }
    // Update open positions and check exits.
    for (const pos of engine.positions.filter((p) => p.status === "open")) {
      try {
        const freshPair = await pairByAddress(pos.pairAddress);
        if (!freshPair) continue;
        const closed = engine.checkExits(pos, freshPair, Date.now());
        if (closed) {
          log({ type: "trade_close", cycle, ...closed });
          console.log(`[cycle ${cycle}] CLOSED ${closed.id} ${closed.symbol} via ${closed.exitReason}: PnL $${closed.pnlUsd} (${closed.pnlPct}%)`);
        }
      } catch (e) {
        console.log(`[cycle ${cycle}] position update failed for ${pos.id}: ${e.message}`);
      }
      await sleep(cfg.run.requestDelayMs);
    }
    const open = engine.positions.filter((p) => p.status === "open");
    const equity = engine.equity((p) => p.entryPrice);
    log({ type: "cycle_summary", cycle, counts: { ...counts }, openPositions: open.length, cashUsd: Number(engine.cashUsd.toFixed(2)), equityAtEntryMarks: Number(equity.toFixed(2)) });
    console.log(`[cycle ${cycle}] done. scanned=${counts.scanned} filtered=${counts.filtered} skipped=${counts.skipped} traded=${counts.traded} open=${open.length} cash=$${engine.cashUsd.toFixed(2)}`);
  };

  (async () => {
    for (let cycle = 1; cycle <= cfg.run.cycles; cycle++) {
      await runCycle(cycle);
      if (cycle < cfg.run.cycles) await sleep(cfg.run.intervalSec * 1000);
    }
    const closed = engine.positions.filter((p) => p.status === "closed");
    const wins = closed.filter((p) => p.pnlUsd > 0);
    const losses = closed.filter((p) => p.pnlUsd <= 0);
    // Mark open positions at their last known entry price for the summary
    // (no fresh quote fetched at the very end — see README "marking").
    const openValue = engine.openValue();
    const summary = {
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date().toISOString(),
      durationSec: Math.round((Date.now() - startedAt) / 1000),
      bankrollStartUsd: cfg.bankrollStartUsd,
      cashUsd: Number(engine.cashUsd.toFixed(2)),
      openPositionsValueAtEntryMarksUsd: Number(openValue.toFixed(2)),
      equityAtEntryMarksUsd: Number((engine.cashUsd + openValue).toFixed(2)),
      counts: { ...counts },
      tradesTaken: closed.length + engine.openCount(),
      tradesClosed: closed.length,
      tradesOpen: engine.openCount(),
      wins: wins.length,
      losses: losses.length,
      winRatePct: closed.length ? Number(((wins.length / closed.length) * 100).toFixed(2)) : null,
      totalPnlUsd: Number(closed.reduce((s, p) => s + p.pnlUsd, 0).toFixed(2)),
      closedTrades: closed.map((p) => ({ id: p.id, symbol: p.symbol, entryPrice: p.entryPrice, exitPrice: p.exitPrice, exitReason: p.exitReason, pnlUsd: p.pnlUsd, pnlPct: p.pnlPct })),
      openTrades: engine.positions.filter((p) => p.status === "open").map((p) => ({ id: p.id, symbol: p.symbol, entryPrice: p.entryPrice, sizeUsd: p.sizeUsd })),
      overrides,
      notes: "Paper trading only. Simulated fills use a modeled slippage, not real fills. Open positions are marked at entry price in this summary (see README).",
    };
    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    logStream.end();
    console.log("\n=== RUN SUMMARY ===");
    console.log(JSON.stringify(summary, null, 2));
  })().catch((e) => {
    console.error("Fatal:", e);
    process.exit(1);
  });
}

main();
