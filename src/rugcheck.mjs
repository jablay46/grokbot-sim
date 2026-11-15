// Approximate rug check for Solana memecoins using free public data only.
//
// WHAT IT CAN CHECK (DexScreener + Solana public RPC):
//   - liquidity size and liquidity vs market-cap ratio (DexScreener)
//   - mint authority still active? (RPC getAccountInfo, jsonParsed)
//   - freeze authority still active? (same)
//   - top-holder concentration (RPC getTokenLargestAccounts)
//
// WHAT IT CANNOT CHECK (honest limits — see README):
//   - whether liquidity is LOCKED or LP tokens are burned (free DexScreener data
//     does not expose lock/burn status; the post's bot claimed a lock check —
//     we cannot reproduce that check with free APIs)
//   - honeypot behaviour (cannot simulate a sell without a paid API / private simulation)
//   - developer wallets, snipers, insider allocations, or off-chain promises
//   - contract source (Solana programs are not verified on-chain like EVM)
// A "pass" here means "no red flag found in the free data", NOT "safe".

import { getLargestHolders, getMintInfo, getTokenSupply, sleep } from "./rpc.mjs";

// Off-chain (DexScreener) part. Returns { fails: [], warns: [], facts: {} }.
export function checkLiquidity(pair, cfg) {
  const fails = [];
  const warns = [];
  const facts = {};
  const liq = pair?.liquidity?.usd ?? 0;
  facts.liquidityUsd = liq;
  if (liq < cfg.rugCheck.minLiquidityUsd) {
    fails.push(`liquidity_usd_below_min:${liq.toFixed(0)}<${cfg.rugCheck.minLiquidityUsd}`);
  } else if (liq < cfg.rugCheck.lowLiquidityWarnUsd) {
    warns.push(`liquidity_low:${liq.toFixed(0)}<${cfg.rugCheck.lowLiquidityWarnUsd}`);
  }
  const mcap = pair?.marketCap ?? pair?.fdv ?? null;
  facts.marketCapUsd = mcap;
  if (mcap && mcap > 0) {
    const ratio = (liq / mcap) * 100;
    facts.liquidityToMcapPct = Number(ratio.toFixed(2));
    if (ratio < cfg.rugCheck.minLiquidityToMcapPct) {
      warns.push(`liquidity_thin_vs_mcap:${ratio.toFixed(1)}%<${cfg.rugCheck.minLiquidityToMcapPct}%`);
    }
  }
  const socials = pair?.info?.socials?.length ?? 0;
  const websites = pair?.info?.websites?.length ?? 0;
  facts.socials = socials;
  facts.websites = websites;
  if (socials === 0 && websites === 0) warns.push("no_socials_or_website");
  return { fails, warns, facts };
}

// On-chain part (RPC). Returns { fails: [], warns: [], facts: {} }.
export async function checkOnChain(mint, cfg, rpcDelayMs = 400) {
  const fails = [];
  const warns = [];
  const facts = {};
  const mintInfo = await getMintInfo(mint);
  facts.mintAuthority = mintInfo.mintAuthority;
  facts.freezeAuthority = mintInfo.freezeAuthority;
  if (mintInfo.mintAuthority === "unknown") {
    warns.push("mint_authority_unknown");
  } else if (mintInfo.mintAuthority) {
    const msg = `mint_authority_active:${mintInfo.mintAuthority}`;
    if (cfg.rugCheck.mintAuthorityPresentFails) fails.push(msg);
    else warns.push(msg);
  }
  if (mintInfo.freezeAuthority === "unknown") {
    warns.push("freeze_authority_unknown");
  } else if (mintInfo.freezeAuthority) {
    const msg = `freeze_authority_active:${mintInfo.freezeAuthority}`;
    if (cfg.rugCheck.freezeAuthorityPresentFails) fails.push(msg);
    else warns.push(msg);
  }
  await sleep(rpcDelayMs);
  const supply = await getTokenSupply(mint);
  facts.supply = supply;
  await sleep(rpcDelayMs);
  if (supply) {
    const holders = await getLargestHolders(mint, supply);
    if (holders) {
      facts.topHolderPct = Number(holders.topHolderPct.toFixed(2));
      facts.topHolder = holders.topHolder;
      if (holders.topHolderPct > cfg.rugCheck.maxTopHolderPct) {
        fails.push(`top_holder_concentration:${holders.topHolderPct.toFixed(1)}%>${cfg.rugCheck.maxTopHolderPct}%`);
      } else if (holders.topHolderPct > cfg.rugCheck.warnTopHolderPct) {
        warns.push(`top_holder_elevated:${holders.topHolderPct.toFixed(1)}%>${cfg.rugCheck.warnTopHolderPct}%`);
      }
    } else {
      warns.push("holders_unknown");
    }
  } else {
    warns.push("supply_unknown");
  }
  return { fails, warns, facts };
}

// Full check: liquidity first (cheap), on-chain only if liquidity passes.
export async function rugCheck(pair, cfg, rpcDelayMs = 400) {
  const liq = checkLiquidity(pair, cfg);
  if (liq.fails.length) {
    return { verdict: "fail", fails: liq.fails, warns: liq.warns, facts: liq.facts, onChainChecked: false };
  }
  const chain = await checkOnChain(pair.baseToken.address, cfg, rpcDelayMs);
  const fails = [...liq.fails, ...chain.fails];
  const warns = [...liq.warns, ...chain.warns];
  const facts = { ...liq.facts, ...chain.facts };
  // Market-cap from supply * price when DexScreener did not provide one.
  if (!facts.marketCapUsd && facts.supply && pair.priceUsd) {
    facts.marketCapUsd = facts.supply * Number(pair.priceUsd);
    const ratio = (facts.liquidityUsd / facts.marketCapUsd) * 100;
    facts.liquidityToMcapPct = Number(ratio.toFixed(2));
    if (ratio < cfg.rugCheck.minLiquidityToMcapPct && !warns.some((w) => w.startsWith("liquidity_thin_vs_mcap"))) {
      warns.push(`liquidity_thin_vs_mcap:${ratio.toFixed(1)}%<${cfg.rugCheck.minLiquidityToMcapPct}%`);
    }
  }
  return {
    verdict: fails.length ? "fail" : "pass",
    fails,
    warns,
    facts,
    onChainChecked: true,
  };
}
