import { erc20Abi, getAddress, hexToString, isAddress } from "viem";
import { BASE_TOKENS, NATIVE_TOKEN } from "../config.js";
import { AppError } from "../lib/errors.js";
import { fetchJSON } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { publicClient } from "../chain/client.js";
import { ERC20_BYTES32_ABI } from "../abi/index.js";

const NATIVE_ALIASES = new Set(["ETH", "NATIVE", "ETHER", "0XEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"]);
const CACHE_TTL_MS = 10 * 60 * 1000;
const metadataCache = new Map();
const searchCache = new Map();

const normalizeSymbol = (value) =>
  String(value || "")
    .trim()
    .replace(/^\$/, "")
    .toUpperCase();

const cached = (map, key) => {
  const entry = map.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    map.delete(key);
    return null;
  }
  return entry.value;
};

const remember = (map, key, value, ttl = CACHE_TTL_MS) =>
  map.set(key, { value, expiresAt: Date.now() + ttl });

const registryBySymbol = new Map();
const registryByAddress = new Map();

for (const token of Object.values(BASE_TOKENS)) {
  if (!token.native) {
    registryBySymbol.set(normalizeSymbol(token.symbol), token);
    registryByAddress.set(token.address.toLowerCase(), token);
  }
}

function decodeBytes32Symbol(hex) {
  try {
    if (!hex || hex === "0x") return null;
    const trimmed = hex.replace(/0x/, "").replace(/(00)+$/, "");
    if (!trimmed) return null;
    return hexToString(`0x${trimmed.length % 2 ? `${trimmed}0` : trimmed}`).trim() || null;
  } catch {
    return null;
  }
}

export async function readTokenMetadata(address) {
  const cacheKey = address.toLowerCase();
  const hit = cached(metadataCache, cacheKey);
  if (hit) return hit;

  let bytecode;
  try {
    bytecode = await publicClient.getBytecode({ address });
  } catch (error) {
    throw AppError.upstream(`Failed to read token contract code: ${error.message}`, { address }, "RPC_TOKEN_READ_FAILED");
  }
  if (!bytecode || bytecode === "0x") {
    throw AppError.badRequest(
      `Address ${address} is not an ERC20 contract on Base.`,
      { address },
      "NOT_A_CONTRACT"
    );
  }

  const [symbolResult, decimalsResult, nameResult] = await Promise.allSettled([
    publicClient.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    publicClient.readContract({ address, abi: erc20Abi, functionName: "name" }),
  ]);

  let symbol =
    symbolResult.status === "fulfilled" && typeof symbolResult.value === "string"
      ? symbolResult.value.trim()
      : null;

  if (!symbol) {
    try {
      const raw = await publicClient.readContract({
        address,
        abi: ERC20_BYTES32_ABI,
        functionName: "symbol",
      });
      symbol = decodeBytes32Symbol(raw);
    } catch {
      symbol = null;
    }
  }

  if (decimalsResult.status !== "fulfilled") {
    throw AppError.badRequest(
      `Address ${address} does not implement ERC20 decimals().`,
      { address },
      "NOT_AN_ERC20"
    );
  }

  const decimals = Number(decimalsResult.value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw AppError.badRequest(`Token ${address} reports invalid decimals.`, { address }, "INVALID_DECIMALS");
  }

  const name =
    nameResult.status === "fulfilled" && typeof nameResult.value === "string" && nameResult.value.trim()
      ? nameResult.value.trim()
      : symbol || "Unknown Token";

  const registry = registryByAddress.get(address.toLowerCase());
  const metadata = {
    address: getAddress(address),
    symbol: symbol || registry?.symbol || "UNKNOWN",
    name,
    decimals,
    native: false,
    verified: true,
    source: registry ? "registry" : "onchain",
  };

  remember(metadataCache, cacheKey, metadata);
  return metadata;
}

async function searchDexScreener(symbol) {
  const cacheKey = normalizeSymbol(symbol);
  const hit = cached(searchCache, cacheKey);
  if (hit) return hit;

  const payload = await fetchJSON(
    `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`,
    {},
    { timeoutMs: 8000, retries: 1, service: "dexscreener" }
  );

  const pairs = Array.isArray(payload?.pairs) ? payload.pairs : [];
  const candidates = pairs
    .filter(
      (pair) =>
        pair?.chainId === "base" &&
        pair?.baseToken?.address &&
        normalizeSymbol(pair.baseToken.symbol) === normalizeSymbol(symbol) &&
        Number(pair?.liquidity?.usd || 0) >= 500
    )
    .sort((a, b) => Number(b?.liquidity?.usd || 0) - Number(a?.liquidity?.usd || 0))
    .slice(0, 5)
    .map((pair) => ({
      address: pair.baseToken.address,
      symbol: pair.baseToken.symbol,
      name: pair.baseToken.name,
      liquidityUsd: Number(pair?.liquidity?.usd || 0),
    }));

  remember(searchCache, cacheKey, candidates, 5 * 60 * 1000);
  return candidates;
}

export async function resolveToken(input, { allowNative = true } = {}) {
  const raw = String(input ?? "").trim();
  if (!raw) throw AppError.badRequest("Token symbol or address is required.", undefined, "MISSING_TOKEN");

  const normalized = normalizeSymbol(raw);

  if (allowNative && (NATIVE_ALIASES.has(normalized) || raw.toLowerCase() === NATIVE_TOKEN.address.toLowerCase())) {
    return { ...NATIVE_TOKEN, verified: true, source: "native", name: "Ether" };
  }
  if (!allowNative && NATIVE_ALIASES.has(normalized)) {
    throw AppError.badRequest("Native ETH is not supported for this operation.", { token: raw }, "NATIVE_NOT_SUPPORTED");
  }

  if (raw.startsWith("0x") && raw.length === 42) {
    if (!isAddress(raw)) {
      throw AppError.badRequest(`Invalid token address: ${raw}`, undefined, "INVALID_ADDRESS");
    }
    return readTokenMetadata(raw);
  }

  const registryToken = registryBySymbol.get(normalized);
  if (registryToken) {
    return { ...registryToken, name: registryToken.name || registryToken.symbol, verified: true, source: "registry" };
  }

  const candidates = await searchDexScreener(raw);
  for (const candidate of candidates) {
    try {
      const metadata = await readTokenMetadata(candidate.address);
      if (normalizeSymbol(metadata.symbol) !== normalized) continue;
      const resolved = {
        ...metadata,
        source: "dexscreener",
        liquidityUsd: candidate.liquidityUsd,
      };
      remember(metadataCache, metadata.address.toLowerCase(), resolved);
      return resolved;
    } catch (error) {
      logger.debug("dex candidate rejected", { address: candidate.address, message: error.message });
    }
  }

  throw AppError.notFound(
    `Unable to resolve token "${raw}" on Base. Provide the contract address or use a symbol with on-chain liquidity.`,
    "TOKEN_NOT_RESOLVED"
  );
}

export async function resolveTokens(inputs, options) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw AppError.badRequest("Provide at least one token symbol or address.", undefined, "MISSING_TOKENS");
  }
  if (inputs.length > 10) {
    throw AppError.badRequest("resolve_tokens supports up to 10 tokens per call.", undefined, "TOO_MANY_TOKENS");
  }

  const settled = await Promise.allSettled(inputs.map((input) => resolveToken(input, options)));
  return settled.map((entry, index) =>
    entry.status === "fulfilled"
      ? entry.value
      : {
          input: inputs[index],
          resolved: false,
          error: entry.reason?.message || "Resolution failed",
          code: entry.reason?.code || "TOKEN_NOT_RESOLVED",
        }
  );
}

export const isNativeToken = (token) => Boolean(token?.native) || token?.address === NATIVE_TOKEN.address;

export const usdcToUnits = (amount) => {
  const [whole, fraction = ""] = String(amount).split(".");
  return BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
};
