// DexScreener public API client (no key, free tier ~300 req/min).
// Docs: https://docs.dexscreener.com/api/reference
// Endpoints used:
//   GET /token-profiles/latest/v1        -> latest token profiles (all chains; filter solana)
//   GET /latest/dex/tokens/{mint}        -> all pairs for a token
//   GET /latest/dex/pairs/solana/{pair}  -> single pair refresh (price/volume)

const BASE = "https://api.dexscreener.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(path, { retries = 2, timeoutMs = 15000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(BASE + path, {
        headers: { Accept: "application/json", "User-Agent": "grokbot-sim/1.0 (paper trading, no key)" },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 429) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`DexScreener HTTP ${res.status} for ${path}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
      await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Latest token profiles, filtered to Solana. Returns [{ tokenAddress, url, description, links }]
export async function latestSolanaProfiles(limit = 30) {
  const all = await getJson("/token-profiles/latest/v1");
  return (Array.isArray(all) ? all : [])
    .filter((p) => p.chainId === "solana" && p.tokenAddress)
    .slice(0, limit);
}

// All pairs for a token mint. Returns array of pair objects (may be empty).
export async function pairsForToken(mint) {
  const d = await getJson(`/latest/dex/tokens/${mint}`);
  return Array.isArray(d?.pairs) ? d.pairs : [];
}

// Refresh one pair by address. Returns the pair object or null.
export async function pairByAddress(pairAddress) {
  const d = await getJson(`/latest/dex/pairs/solana/${pairAddress}`);
  const pairs = Array.isArray(d?.pairs) ? d.pairs : [];
  return pairs[0] ?? null;
}

// Pick the "best" pair for a token: highest liquidity among pairs whose quote
// token is SOL/USDC/USDT (or any pair if none match). Returns null if none.
export function pickBestPair(pairs, quoteSymbols = ["SOL", "USDC", "USDT"]) {
  if (!pairs.length) return null;
  const withQuote = pairs.filter((p) => quoteSymbols.includes(p.quoteToken?.symbol));
  const pool = withQuote.length ? withQuote : pairs;
  return pool.sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
}

export { sleep };
