// Signal evaluation for one DexScreener pair.
// Mirrors the post's bot: 1h breakout + volume spike + buy pressure, each
// opportunity carrying a written reason. No trade is taken on signal alone —
// the rug check (rugcheck.mjs) runs afterwards and can still filter it.

// Returns { tradable, outcome, reasons, strength, ageHours, facts }.
// outcome is one of: "scanned" (evaluated, no trade), "filtered" (hard
// minimum not met), "signal" (passed signal evaluation, rug check next).
export function evaluateSignal(pair, cfg) {
  const now = Date.now();
  const ageHours = pair.pairCreatedAt ? (now - pair.pairCreatedAt) / 3_600_000 : null;
  if (ageHours === null) {
    return { tradable: false, outcome: "scanned", reasons: ["age_unknown"], strength: 0, ageHours: null, facts: {} };
  }
  if (ageHours > cfg.scanner.maxPairAgeHours) {
    return { tradable: false, outcome: "scanned", reasons: [`too_old:${ageHours.toFixed(1)}h`], strength: 0, ageHours: Number(ageHours.toFixed(2)), facts: {} };
  }
  const liq = pair?.liquidity?.usd ?? 0;
  if (liq < cfg.scanner.minLiquidityUsd) {
    return { tradable: false, outcome: "filtered", reasons: [`liquidity_below_min:$${liq.toFixed(0)}`], strength: 0, ageHours: Number(ageHours.toFixed(2)), facts: { liquidityUsd: liq } };
  }
  const h1Vol = pair?.volume?.h1 ?? 0;
  if (h1Vol < cfg.scanner.minH1VolumeUsd) {
    return { tradable: false, outcome: "scanned", reasons: [`h1_volume_low:$${h1Vol.toFixed(0)}`], strength: 0, ageHours: Number(ageHours.toFixed(2)), facts: { h1Vol, liquidityUsd: liq } };
  }
  const h1Buys = pair?.txns?.h1?.buys ?? 0;
  const h1Sells = pair?.txns?.h1?.sells ?? 0;
  const h1Txns = h1Buys + h1Sells;
  if (h1Txns < cfg.scanner.minH1Txns) {
    return { tradable: false, outcome: "scanned", reasons: [`h1_txns_low:${h1Txns}`], strength: 0, ageHours: Number(ageHours.toFixed(2)), facts: { h1Vol, h1Txns, liquidityUsd: liq } };
  }

  const h1Chg = pair?.priceChange?.h1 ?? 0;
  const buyRatio = h1Txns > 0 ? h1Buys / h1Txns : 0;
  const avgHourly = (pair?.volume?.h6 ?? 0) / 6;
  const spikeRatio = avgHourly > 0 ? h1Vol / avgHourly : 0;
  const reasons = [];

  // Strength 0..1 = 0.4 breakout + 0.3 volume spike + 0.3 buy pressure.
  const bo = cfg.signal.breakoutH1Pct;
  const breakoutScore = Math.max(0, Math.min(1, (h1Chg - bo) / bo));
  let strength = 0.4 * breakoutScore;
  if (h1Chg >= bo) reasons.push(`breakout_h1:+${h1Chg.toFixed(1)}%`);
  const spikeScore = Math.max(0, Math.min(1, (spikeRatio - 1) / Math.max(cfg.signal.volumeSpikeRatio - 1, 0.01)));
  strength += 0.3 * spikeScore;
  if (spikeRatio >= cfg.signal.volumeSpikeRatio) reasons.push(`volume_spike:${spikeRatio.toFixed(2)}x_avg_hourly`);
  const buyScore = Math.max(0, Math.min(1, (buyRatio - 0.5) * 2));
  strength += 0.3 * buyScore;
  if (buyRatio > 0.5) reasons.push(`buys_over_sells_h1:${(buyRatio * 100).toFixed(0)}%`);

  const buysOk = !cfg.signal.requireBuysOverSellsH1 || h1Buys > h1Sells;
  const tradable = strength >= cfg.signal.minSignalStrength && buysOk && h1Chg >= bo;
  if (!tradable) {
    if (!buysOk) reasons.push("sells_over_buys_h1");
    if (h1Chg < bo) reasons.push(`no_breakout_h1:${h1Chg.toFixed(1)}%<${bo}%`);
    if (strength < cfg.signal.minSignalStrength) reasons.push(`strength_low:${strength.toFixed(2)}<${cfg.signal.minSignalStrength}`);
  }
  return {
    tradable,
    outcome: tradable ? "signal" : "scanned",
    reasons,
    strength: Number(strength.toFixed(3)),
    ageHours: Number(ageHours.toFixed(2)),
    facts: {
      h1Chg: Number(h1Chg.toFixed(2)),
      buyRatio: Number(buyRatio.toFixed(3)),
      spikeRatio: Number(spikeRatio.toFixed(2)),
      h1Vol: Number(h1Vol.toFixed(0)),
      h1Txns,
      liquidityUsd: Number(liq.toFixed(0)),
    },
  };
}
