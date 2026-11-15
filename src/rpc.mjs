// Minimal Solana JSON-RPC client (public endpoint, no key, stdlib fetch only).
// Used for the approximate rug check: mint authority, freeze authority,
// token supply (for market-cap estimate) and largest holders (concentration).

const RPC_URL = "https://api.mainnet-beta.solana.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function rpcCall(method, params, { retries = 2, timeoutMs = 12000 } = {}) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (res.status === 429) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`RPC error: ${json.error.message}`);
      return json.result;
    } catch (e) {
      lastErr = e;
      await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

// Returns { mintAuthority: string|null|'unknown', freezeAuthority: string|null|'unknown', decimals }
// mintAuthority === null means revoked (good). A pubkey string means it can still mint.
export async function getMintInfo(mint) {
  try {
    const info = await rpcCall("getAccountInfo", [mint, { encoding: "jsonParsed", commitment: "confirmed" }]);
    const parsed = info?.value?.data?.parsed?.info;
    if (!parsed) return { mintAuthority: "unknown", freezeAuthority: "unknown", decimals: null };
    return {
      mintAuthority: parsed.mintAuthority ?? null,
      freezeAuthority: parsed.freezeAuthority ?? null,
      decimals: parsed.decimals ?? null,
    };
  } catch {
    return { mintAuthority: "unknown", freezeAuthority: "unknown", decimals: null };
  }
}

// Returns total supply in whole tokens (float) or null.
export async function getTokenSupply(mint) {
  try {
    const s = await rpcCall("getTokenSupply", [mint, { commitment: "confirmed" }]);
    const amt = s?.value;
    if (!amt) return null;
    return Number(amt.uiAmount);
  } catch {
    return null;
  }
}

// Returns { topHolderPct, topHolder, holdersChecked } or null when unavailable.
export async function getLargestHolders(mint, supply) {
  try {
    const accts = await rpcCall("getTokenLargestAccounts", [mint, { commitment: "confirmed" }]);
    const list = accts?.value ?? [];
    if (!list.length || !supply) return null;
    const top = list[0];
    return {
      topHolderPct: (Number(top.uiAmount) / supply) * 100,
      topHolder: top.address,
      holdersChecked: list.length,
    };
  } catch {
    return null;
  }
}

export { sleep };
