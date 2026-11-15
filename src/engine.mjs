// Paper-trading engine: virtual bankroll, position sizing, exits, ledger.
// NO real money, NO keys, NO signing. All prices are simulated fills from
// DexScreener quotes with a MODELED slippage (see slippageFor) — real fills
// on thin memecoin pools are usually worse than this model.

export class PaperEngine {
  constructor(cfg) {
    this.cfg = cfg;
    this.cashUsd = cfg.bankrollStartUsd;
    this.positions = []; // open + closed, in open order
    this.tradeSeq = 0;
  }

  // Slippage model: grows with trade size relative to pool liquidity, capped.
  // slipPct = min(max, base + (sizeUsd / liquidityUsd) * perLiquidity)
  // e.g. $10 into a $5,000 pool: 0.1 + (10/5000)*100 = 0.3%.
  slippageFor(sizeUsd, liquidityUsd) {
    const ex = this.cfg.execution;
    const liq = Math.max(liquidityUsd || 1, 1);
    const slip = ex.baseSlippagePct + (sizeUsd / liq) * ex.slippagePerLiquidityPct;
    return Math.min(ex.maxSlippagePct, Math.max(0, slip));
  }

  // Position sizing: size = bankroll * (minRisk + riskRange * strength),
  // capped at maxRisk, floored at minRisk. Any warning halves the size once.
  // The size therefore varies per trade (never the same blindly) and never
  // risks more than maxRiskPct of the CURRENT bankroll on one trade.
  sizeFor(strength, hasWarns) {
    const s = this.cfg.sizing;
    let riskPct = s.minRiskPct + s.riskRangePct * Math.max(0, Math.min(1, strength));
    riskPct = Math.min(s.maxRiskPct, Math.max(s.minRiskPct, riskPct));
    if (hasWarns && s.warnSizeHalved) riskPct /= 2;
    const bankroll = this.cashUsd + this.openValue(0);
    const sizeUsd = Math.min(this.cashUsd, (bankroll * riskPct) / 100);
    return { sizeUsd, riskPct, bankroll };
  }

  openValue(markPriceFn) {
    return this.positions
      .filter((p) => p.status === "open")
      .reduce((sum, p) => sum + p.tokens * (markPriceFn ? markPriceFn(p) : p.entryPrice), 0);
  }

  equity(markPriceFn) {
    return this.cashUsd + this.openValue(markPriceFn);
  }

  openCount() {
    return this.positions.filter((p) => p.status === "open").length;
  }

  isHolding(mint) {
    return this.positions.some((p) => p.status === "open" && p.mint === mint);
  }

  // Open a paper position. Returns the position record or null (insufficient cash).
  openPosition({ mint, symbol, pairAddress, priceUsd, sizeUsd, liquidityUsd, entryM5Volume, entryH1Volume, strength, reason, warns, now }) {
    if (sizeUsd <= 0 || sizeUsd > this.cashUsd) return null;
    const slip = this.slippageFor(sizeUsd, liquidityUsd);
    const entryPrice = priceUsd * (1 + slip / 100); // adverse slippage on buy
    const tokens = sizeUsd / entryPrice;
    this.cashUsd -= sizeUsd;
    const pos = {
      id: `T${++this.tradeSeq}`,
      mint,
      symbol,
      pairAddress,
      status: "open",
      entryPrice,
      quotedPrice: priceUsd,
      entrySlippagePct: Number(slip.toFixed(3)),
      entryTime: now,
      sizeUsd: Number(sizeUsd.toFixed(2)),
      tokens,
      entryM5Volume,
      entryH1Volume,
      takeProfitPct: this.cfg.exits.takeProfitPct,
      stopLossPct: this.cfg.exits.stopLossPct,
      signalStrength: strength,
      reason,
      warns: warns ?? [],
      exitPrice: null,
      exitTime: null,
      exitReason: null,
      exitSlippagePct: null,
      pnlUsd: null,
      pnlPct: null,
    };
    this.positions.push(pos);
    return pos;
  }

  // Evaluate exits for one open position against a fresh pair snapshot.
  // Returns a close record if an exit fired, else null.
  // Exit priority: stop-loss > take-profit > volume-drop > max-hold.
  checkExits(pos, pair, now) {
    if (pos.status !== "open") return null;
    const price = Number(pair.priceUsd);
    if (!price || price <= 0) return null;
    const changePct = ((price - pos.entryPrice) / pos.entryPrice) * 100;
    let exitReason = null;
    if (changePct <= -pos.stopLossPct) exitReason = "stop_loss";
    else if (changePct >= pos.takeProfitPct) exitReason = "take_profit";
    else {
      const curM5 = pair?.volume?.m5 ?? null;
      if (curM5 !== null && pos.entryM5Volume > 0) {
        const dropPct = ((pos.entryM5Volume - curM5) / pos.entryM5Volume) * 100;
        if (dropPct >= this.cfg.exits.volumeDropPct) exitReason = "volume_drop";
      }
      if (!exitReason) {
        const heldHours = (now - pos.entryTime) / 3_600_000;
        if (heldHours >= this.cfg.exits.maxHoldHours) exitReason = "max_hold";
      }
    }
    if (!exitReason) return null;
    const slip = this.slippageFor(pos.sizeUsd, pair?.liquidity?.usd ?? 0);
    const exitPrice = price * (1 - slip / 100); // adverse slippage on sell
    const proceeds = pos.tokens * exitPrice;
    const pnlUsd = proceeds - pos.sizeUsd;
    pos.status = "closed";
    pos.exitPrice = exitPrice;
    pos.exitTime = now;
    pos.exitReason = exitReason;
    pos.exitSlippagePct = Number(slip.toFixed(3));
    pos.pnlUsd = Number(pnlUsd.toFixed(2));
    pos.pnlPct = Number(((pnlUsd / pos.sizeUsd) * 100).toFixed(2));
    this.cashUsd += proceeds;
    return { ...pos };
  }
}
