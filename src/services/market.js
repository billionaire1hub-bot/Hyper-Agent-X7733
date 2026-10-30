import { AppError } from "../lib/errors.js";
import { fetchJSON } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { config } from "../config.js";
import { publicClient } from "../chain/client.js";
import { normalizeCandles } from "./ta.js";

const INTEL = config.intelligence;

const CACHE_TTL = Math.max(INTEL.cacheTtlMs, 5000);

const cache = new Map();

function memo(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.promise;
  const promise = Promise.resolve().then(fn);
  cache.set(key, { promise, expiresAt: Date.now() + ttlMs });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  return promise;
}

const num = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const upper = (value) => String(value ?? "").trim().toUpperCase();

const cgHeaders = () => ({
  accept: "application/json",
  ...(INTEL.coingeckoApiKey ? { "x-cg-demo-api-key": INTEL.coingeckoApiKey } : {}),
});

const cg = (path, { timeoutMs = INTEL.dataTimeoutMs, retries = 1 } = {}) =>
  fetchJSON(`${INTEL.coingeckoApiUrl}${path}`, { headers: cgHeaders() }, {
    timeoutMs,
    retries,
    service: "coingecko",
  });

/* ------------------------------- CoinGecko ------------------------------- */

export async function coingeckoPing() {
  return memo("cg:ping", 15000, () => cg("/ping", { timeoutMs: 8000, retries: 1 }));
}

export async function getCoinByContract(address) {
  const key = `cg:contract:${address.toLowerCase()}`;
  return memo(key, CACHE_TTL, async () => {
    const coin = await cg(
      `/coins/base/contract/${address.toLowerCase()}?localization=false&tickers=false&market_data=true&community_data=true&developer_data=false`
    );
    if (!coin?.id) throw AppError.notFound(`CoinGecko has no asset for ${address}.`, "COINGECKO_ASSET_NOT_FOUND");
    const market = coin.market_data || {};
    return {
      id: coin.id,
      symbol: upper(coin.symbol),
      name: coin.name,
      categories: (coin.categories || []).filter(Boolean),
      platforms: coin.platforms || {},
      links: {
        homepage: coin.links?.homepage?.find(Boolean) || null,
        twitter: coin.links?.twitter_screen_name ? `https://x.com/${coin.links.twitter_screen_name}` : null,
      },
      community: {
        twitterFollowers: num(coin.community_data?.twitter_followers),
        redditSubscribers: num(coin.community_data?.reddit_subscribers),
        sentimentUpPct: num(coin.sentiment_votes_up_percentage),
      },
      market: {
        priceUsd: num(market.current_price?.usd),
        marketCapUsd: num(market.market_cap?.usd),
        fdvUsd: num(market.fully_diluted_valuation?.usd),
        volume24hUsd: num(market.total_volume?.usd),
        circulatingSupply: num(market.circulating_supply),
        totalSupply: num(market.total_supply),
        maxSupply: num(market.max_supply),
        change1hPct: num(market.price_change_percentage_1h_in_currency?.usd),
        change24hPct: num(market.price_change_percentage_24h_in_currency?.usd),
        change7dPct: num(market.price_change_percentage_7d_in_currency?.usd),
        athUsd: num(market.ath?.usd),
        athChangePct: num(market.ath_change_percentage?.usd),
        lastUpdated: market.last_updated || null,
      },
      fetchedAt: new Date().toISOString(),
    };
  });
}

export async function getCoinMarkets(ids) {
  const clean = (ids || []).filter(Boolean).slice(0, 20);
  if (clean.length === 0) return [];
  const key = `cg:markets:${clean.join(",")}`;
  return memo(key, CACHE_TTL, async () => {
    const rows = await cg(
      `/coins/markets?vs_currency=usd&ids=${encodeURIComponent(clean.join(","))}&price_change_percentage=1h,24h,7d&order=market_cap_desc`
    );
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      id: row.id,
      symbol: upper(row.symbol),
      name: row.name,
      image: row.image || null,
      priceUsd: num(row.current_price),
      marketCapUsd: num(row.market_cap),
      rank: num(row.market_cap_rank),
      volume24hUsd: num(row.total_volume),
      circulatingSupply: num(row.circulating_supply),
      change1hPct: num(row.price_change_percentage_1h_in_currency),
      change24hPct: num(row.price_change_percentage_24h_in_currency),
      change7dPct: num(row.price_change_percentage_7d_in_currency),
      athUsd: num(row.ath),
      athChangePct: num(row.ath_change_percentage),
      lastUpdated: row.last_updated || null,
    }));
  });
}

export async function getTrendingCoins() {
  return memo("cg:trending", CACHE_TTL, async () => {
    const payload = await cg("/search/trending");
    return (payload?.coins || [])
      .map((entry) => entry?.item)
      .filter(Boolean)
      .map((item) => ({
        id: item.id,
        symbol: upper(item.symbol),
        name: item.name,
        rank: num(item.market_cap_rank),
        priceUsd: num(item.data?.price),
        change24hPct: num(item.data?.price_change_percentage_24h?.usd),
        marketCapUsd: num(item.data?.market_cap?.usd),
        volume24hUsd: num(item.data?.total_volume?.usd),
        thumb: item.thumb || null,
      }));
  });
}

export async function getGlobalMarket() {
  return memo("cg:global", CACHE_TTL, async () => {
    const payload = await cg("/global");
    const data = payload?.data || {};
    return {
      marketCapUsd: num(data.total_market_cap?.usd),
      volume24hUsd: num(data.total_volume?.usd),
      marketCapChange24hPct: num(data.market_cap_change_percentage_24h_usd),
      btcDominancePct: num(data.market_cap_percentage?.btc),
      ethDominancePct: num(data.market_cap_percentage?.eth),
      activeCryptocurrencies: num(data.active_cryptocurrencies),
      updatedAt: data.updated_at ? new Date(data.updated_at * 1000).toISOString() : null,
    };
  });
}

export async function searchCoin(query) {
  const key = `cg:search:${String(query).toLowerCase()}`;
  return memo(key, CACHE_TTL, async () => {
    const payload = await cg(`/search?query=${encodeURIComponent(query)}`, { timeoutMs: 6000, retries: 0 });
    return (payload?.coins || [])
      .slice(0, 10)
      .map((coin) => ({ id: coin.id, symbol: upper(coin.symbol), name: coin.name, rank: num(coin.market_cap_rank) }));
  });
}

/**
 * Live ETH/USD price used by the gas unlock threshold. Never throws: on any
 * upstream failure it returns the configured ETH_USD_FALLBACK with an explicit
 * source label so the unlock system keeps operating.
 */
export async function getEthUsdPrice() {
  return memo("cg:eth-usd", 30000, async () => {
    try {
      const payload = await cg("/simple/price?ids=ethereum&vs_currencies=usd", { timeoutMs: 6000, retries: 0 });
      const priceUsd = num(payload?.ethereum?.usd);
      if (priceUsd === null) throw new Error("no ethereum price in response");
      return { priceUsd, source: "coingecko", fetchedAt: new Date().toISOString() };
    } catch (error) {
      logger.warn("ETH/USD price unavailable, using configured fallback", { message: error.message });
      return { priceUsd: config.execution.ethUsdFallback, source: "fallback", fetchedAt: new Date().toISOString() };
    }
  });
}

export async function getCoinCategories({ limit = 15 } = {}) {
  const key = `cg:categories:${limit}`;
  return memo(key, 120000, async () => {
    const payload = await cg("/coins/categories?order=market_cap_desc", { timeoutMs: 8000, retries: 0 });
    return (Array.isArray(payload) ? payload : [])
      .slice(0, Math.max(1, Number(limit) || 1))
      .map((row) => ({
        id: row.category_id,
        name: row.name,
        marketCapUsd: num(row.market_cap),
        change24hPct: num(row.market_cap_change_24h),
        volume24hUsd: num(row.volume_24h),
        topCoins: (row.top_3_coins || []).filter(Boolean),
      }))
      .filter((row) => row.id);
  });
}

/* ----------------------------- GeckoTerminal ----------------------------- */

const gt = (path, opts = {}) =>
  fetchJSON(`${INTEL.geckoterminalApiUrl}${path}`, { headers: { accept: "application/json" } }, {
    timeoutMs: INTEL.dataTimeoutMs,
    retries: 1,
    service: "geckoterminal",
    ...opts,
  });

export async function getTokenPools(address) {
  const key = `gt:pools:${address.toLowerCase()}`;
  return memo(key, CACHE_TTL, async () => {
    const payload = await gt(`/networks/base/tokens/${address.toLowerCase()}/pools`);
    return (payload?.data || [])
      .map((pool) => {
        const attributes = pool.attributes || {};
        const baseId = pool.relationships?.base_token?.data?.id || "";
        return {
          address: attributes.address,
          name: attributes.name,
          dex: pool.relationships?.dex?.data?.id || null,
          priceUsd: num(attributes.base_token_price_usd),
          liquidityUsd: num(attributes.reserve_in_usd),
          fdvUsd: num(attributes.fdv_usd),
          marketCapUsd: num(attributes.market_cap_usd),
          volume24hUsd: num(attributes.volume_usd?.h24),
          volume1hUsd: num(attributes.volume_usd?.h1),
          change1hPct: num(attributes.price_change_percentage?.h1),
          change24hPct: num(attributes.price_change_percentage?.h24),
          buys24h: num(attributes.transactions?.h24?.buys),
          sells24h: num(attributes.transactions?.h24?.sells),
          createdAt: attributes.pool_created_at || null,
          baseAddress: baseId.startsWith("base_") ? baseId.slice(5) : baseId || null,
        };
      })
      .filter((pool) => pool.address && Number.isFinite(pool.priceUsd))
      .sort((a, b) => (b.liquidityUsd || 0) - (a.liquidityUsd || 0));
  });
}

export async function getBasePools({ limit = 20 } = {}) {
  const key = `gt:base-pools:${limit}`;
  return memo(key, Math.min(CACHE_TTL, 30000), async () => {
    const payload = await gt(`/networks/base/pools?page=1`);
    return (payload?.data || [])
      .slice(0, Math.max(1, Number(limit) || 1))
      .map((pool) => {
        const attributes = pool.attributes || {};
        const baseId = pool.relationships?.base_token?.data?.id || "";
        return {
          address: attributes.address,
          name: attributes.name,
          dex: pool.relationships?.dex?.data?.id || null,
          priceUsd: num(attributes.base_token_price_usd),
          liquidityUsd: num(attributes.reserve_in_usd),
          volume24hUsd: num(attributes.volume_usd?.h24),
          change1hPct: num(attributes.price_change_percentage?.h1),
          change24hPct: num(attributes.price_change_percentage?.h24),
          baseAddress: baseId.startsWith("base_") ? baseId.slice(5) : baseId || null,
          baseSymbol: attributes.name?.split("/")[0]?.trim() || null,
        };
      })
      .filter((pool) => pool.address && pool.baseAddress && Number.isFinite(pool.priceUsd));
  });
}

/**
 * GeckoTerminal's new_pools feed lists the most recently created pools on the
 * network. It is the live source for new_pool_radar.
 */
export async function getNewBasePools({ limit = 30 } = {}) {
  const key = `gt:new-base-pools:${limit}`;
  return memo(key, 30000, async () => {
    const payload = await gt(`/networks/base/new_pools?page=1`, { retries: 3 });
    return (payload?.data || [])
      .slice(0, Math.max(1, Number(limit) || 1))
      .map((pool) => {
        const attributes = pool.attributes || {};
        const baseId = pool.relationships?.base_token?.data?.id || "";
        const quoteId = pool.relationships?.quote_token?.data?.id || "";
        return {
          address: attributes.address,
          name: attributes.name,
          dex: pool.relationships?.dex?.data?.id || null,
          priceUsd: num(attributes.base_token_price_usd),
          liquidityUsd: num(attributes.reserve_in_usd),
          fdvUsd: num(attributes.fdv_usd),
          marketCapUsd: num(attributes.market_cap_usd),
          volume24hUsd: num(attributes.volume_usd?.h24),
          volume1hUsd: num(attributes.volume_usd?.h1),
          change1hPct: num(attributes.price_change_percentage?.h1),
          change24hPct: num(attributes.price_change_percentage?.h24),
          buys24h: num(attributes.transactions?.h24?.buys),
          sells24h: num(attributes.transactions?.h24?.sells),
          createdAt: attributes.pool_created_at || null,
          baseAddress: baseId.startsWith("base_") ? baseId.slice(5) : baseId || null,
          baseSymbol: attributes.name?.split("/")[0]?.trim() || null,
          quoteAddress: quoteId.startsWith("base_") ? quoteId.slice(5) : quoteId || null,
        };
      })
      .filter((pool) => pool.address && Number.isFinite(pool.priceUsd));
  });
}

export async function getPoolOhlcv(pool, { timeframe = "hour", aggregate = 1, limit = 240 } = {}) {  const key = `gt:ohlcv:${pool}:${timeframe}:${aggregate}:${limit}`;
  return memo(key, Math.min(CACHE_TTL, 30000), async () => {
    const payload = await gt(
      `/networks/base/pools/${pool}/ohlcv/${timeframe}?aggregate=${aggregate}&limit=${limit}&currency=usd`
    );
    const rows = payload?.data?.attributes?.ohlcv_list || [];
    return normalizeCandles(
      rows.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v }))
    );
  });
}

/* -------------------------------- Candles -------------------------------- */

const TIMEFRAMES = {
  "15m": { binance: "15m", coinbase: 900, gt: { timeframe: "minute", aggregate: 15 }, candlesPerDay: 96 },
  "1h": { binance: "1h", coinbase: 3600, gt: { timeframe: "hour", aggregate: 1 }, candlesPerDay: 24 },
  "4h": { binance: "4h", coinbase: 21600, gt: { timeframe: "hour", aggregate: 4 }, candlesPerDay: 6 },
  "1d": { binance: "1d", coinbase: 86400, gt: { timeframe: "day", aggregate: 1 }, candlesPerDay: 1 },
};

const MAJOR_MARKETS = {
  BTC: { binance: "BTCUSDT", coinbase: "BTC-USD" },
  ETH: { binance: "ETHUSDT", coinbase: "ETH-USD" },
  SOL: { binance: "SOLUSDT", coinbase: "SOL-USD" },
  BNB: { binance: "BNBUSDT", coinbase: "BNB-USD" },
  XRP: { binance: "XRPUSDT", coinbase: "XRP-USD" },
  DOGE: { binance: "DOGEUSDT", coinbase: "DOGE-USD" },
  ADA: { binance: "ADAUSDT", coinbase: "ADA-USD" },
  AVAX: { binance: "AVAXUSDT", coinbase: "AVAX-USD" },
  LINK: { binance: "LINKUSDT", coinbase: "LINK-USD" },
  SUI: { binance: "SUIUSDT", coinbase: "SUI-USD" },
};

export const supportedTimeframes = Object.keys(TIMEFRAMES);
export const isMajor = (symbol) => Boolean(MAJOR_MARKETS[upper(symbol)]);

export async function getBinanceKlines(symbol, interval, limit = 240) {
  const key = `binance:klines:${symbol}:${interval}:${limit}`;
  return memo(key, 30000, async () => {
    const rows = await fetchJSON(
      `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
      {},
      { timeoutMs: INTEL.dataTimeoutMs, retries: 1, service: "binance" }
    );
    if (!Array.isArray(rows)) throw AppError.upstream("Binance returned no klines.", { symbol }, "BINANCE_KLINES_EMPTY");
    return normalizeCandles(
      rows.map((row) => ({ t: Number(row[0]) / 1000, o: row[1], h: row[2], l: row[3], c: row[4], v: row[5] }))
    );
  });
}

export async function getCoinbaseCandles(product, granularity, limit = 240) {
  const key = `coinbase:candles:${product}:${granularity}`;
  return memo(key, 30000, async () => {
    const rows = await fetchJSON(
      `https://api.exchange.coinbase.com/products/${encodeURIComponent(product)}/candles?granularity=${granularity}`,
      {},
      { timeoutMs: INTEL.dataTimeoutMs, retries: 1, service: "coinbase" }
    );
    if (!Array.isArray(rows)) throw AppError.upstream("Coinbase returned no candles.", { product }, "COINBASE_CANDLES_EMPTY");
    return normalizeCandles(
      rows
        .map((row) => ({ t: Number(row[0]), l: row[1], h: row[2], o: row[3], c: row[4], v: row[5] }))
        .sort((a, b) => a.t - b.t)
        .slice(-limit)
    );
  });
}

export async function getBinanceDerivatives(symbol) {
  const major = MAJOR_MARKETS[upper(symbol)];
  if (!major) return null;
  const key = `binance:derivatives:${major.binance}`;
  return memo(key, 30000, async () => {
    const [premium, interest, ratio, history] = await Promise.allSettled([
      fetchJSON(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${major.binance}`, {}, { timeoutMs: 7000, retries: 0, service: "binance-futures" }),
      fetchJSON(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${major.binance}`, {}, { timeoutMs: 7000, retries: 0, service: "binance-futures" }),
      fetchJSON(`https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${major.binance}&period=4h&limit=2`, {}, { timeoutMs: 7000, retries: 0, service: "binance-futures" }),
      fetchJSON(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${major.binance}&period=4h&limit=13`, {}, { timeoutMs: 7000, retries: 0, service: "binance-futures" }),
    ]);

    const premiumValue = premium.status === "fulfilled" ? premium.value : null;
    const interestValue = interest.status === "fulfilled" ? interest.value : null;
    const ratioValue = ratio.status === "fulfilled" && Array.isArray(ratio.value) ? ratio.value.at(-1) : null;
    const histories = history.status === "fulfilled" && Array.isArray(history.value) ? history.value : [];

    if (!premiumValue && !interestValue && histories.length === 0) return null;

    const openInterest = num(interestValue?.openInterest);
    const oldestInterest = histories.length ? num(histories[0].sumOpenInterest) : null;
    const fundingRate = num(premiumValue?.lastFundingRate);

    return {
      venue: "Binance USD-M perpetuals",
      symbol: major.binance,
      markPriceUsd: num(premiumValue?.markPrice),
      fundingRatePct: fundingRate === null ? null : fundingRate * 100,
      nextFundingAt: premiumValue?.nextFundingTime ? new Date(Number(premiumValue.nextFundingTime)).toISOString() : null,
      openInterest,
      openInterestChangePct:
        openInterest !== null && oldestInterest ? ((openInterest - oldestInterest) / oldestInterest) * 100 : null,
      longShortRatio: num(ratioValue?.longShortRatio),
      longAccountPct: ratioValue?.longAccount ? num(ratioValue.longAccount) * 100 : null,
      shortAccountPct: ratioValue?.shortAccount ? num(ratioValue.shortAccount) * 100 : null,
      fetchedAt: new Date().toISOString(),
    };
  });
}

export async function getCandles({ token, timeframe = "4h", limit = 240 }) {
  const frame = TIMEFRAMES[timeframe];
  if (!frame) {
    throw AppError.badRequest(`Unsupported timeframe "${timeframe}".`, { supported: supportedTimeframes }, "INVALID_TIMEFRAME");
  }
  const symbol = upper(token.symbol);
  const major = MAJOR_MARKETS[symbol];
  const failures = [];

  if (major) {
    try {
      const candles = await getBinanceKlines(major.binance, frame.binance, limit);
      if (candles.length >= 60) {
        return {
          source: "binance-spot",
          market: major.binance,
          timeframe,
          candlesPerDay: frame.candlesPerDay,
          candles,
          priceUsd: candles.at(-1).c,
        };
      }
      failures.push("binance: insufficient candles");
    } catch (error) {
      failures.push(`binance: ${error.message}`);
    }
    try {
      const candles = await getCoinbaseCandles(major.coinbase, frame.coinbase, limit);
      if (candles.length >= 60) {
        return {
          source: "coinbase-spot",
          market: major.coinbase,
          timeframe,
          candlesPerDay: frame.candlesPerDay,
          candles,
          priceUsd: candles.at(-1).c,
        };
      }
      failures.push("coinbase: insufficient candles");
    } catch (error) {
      failures.push(`coinbase: ${error.message}`);
    }
  }

  if (!token.native && token.address) {
    try {
      const pools = await getTokenPools(token.address);
      const pool = pools[0];
      if (!pool) throw new Error("no Base liquidity pool");
      const candles = await getPoolOhlcv(pool.address, { ...frame.gt, limit });
      if (candles.length < 60) throw new Error(`insufficient candles (${candles.length})`);
      return {
        source: "geckoterminal",
        market: `${pool.name} (${pool.dex || "base"})`,
        timeframe,
        candlesPerDay: frame.candlesPerDay,
        candles,
        priceUsd: candles.at(-1).c,
        pool,
      };
    } catch (error) {
      failures.push(`geckoterminal: ${error.message}`);
    }
  }

  logger.warn("no live candle source available", { symbol, timeframe, failures });
  throw AppError.unavailable(
    `No live OHLCV source is available for ${symbol} on the ${timeframe} timeframe.`,
    { symbol, timeframe, attempts: failures },
    "NO_MARKET_DATA"
  );
}

/* ------------------------------- DexScreener ------------------------------ */

const dex = (path, { timeoutMs = INTEL.dataTimeoutMs, retries = 1 } = {}) =>
  fetchJSON(`${INTEL.dexscreenerApiUrl}${path}`, { headers: { accept: "application/json" } }, {
    timeoutMs,
    retries,
    service: "dexscreener",
  });

export async function getDexToken(address) {
  const key = `dex:token:${address.toLowerCase()}`;
  return memo(key, CACHE_TTL, async () => {
    const payload = await dex(`/latest/dex/tokens/${address}`);
    const pairs = (payload?.pairs || []).filter((pair) => pair?.chainId === "base");
    if (pairs.length === 0) return null;
    const best = pairs.sort((a, b) => (num(b.liquidity?.usd) || 0) - (num(a.liquidity?.usd) || 0))[0];
    const totalLiquidity = pairs.reduce((sum, pair) => sum + (num(pair.liquidity?.usd) || 0), 0);
    return {
      pairAddress: best.pairAddress,
      url: best.url,
      dexId: best.dexId,
      priceUsd: num(best.priceUsd),
      liquidityUsd: num(best.liquidity?.usd),
      totalLiquidityUsd: totalLiquidity,
      fdvUsd: num(best.fdv),
      marketCapUsd: num(best.marketCap),
      volume24hUsd: num(best.volume?.h24),
      volume6hUsd: num(best.volume?.h6),
      volume1hUsd: num(best.volume?.h1),
      change1hPct: num(best.priceChange?.h1),
      change6hPct: num(best.priceChange?.h6),
      change24hPct: num(best.priceChange?.h24),
      buys24h: num(best.txns?.h24?.buys),
      sells24h: num(best.txns?.h24?.sells),
      pairCreatedAt: best.pairCreatedAt ? new Date(best.pairCreatedAt).toISOString() : null,
      baseToken: best.baseToken ? { address: best.baseToken.address, symbol: upper(best.baseToken.symbol), name: best.baseToken.name } : null,
      quoteToken: best.quoteToken ? { address: best.quoteToken.address, symbol: upper(best.quoteToken.symbol) } : null,
      pairsObserved: pairs.length,
      fetchedAt: new Date().toISOString(),
    };
  });
}

export async function getDexBoosts() {
  return memo("dex:boosts", 60000, async () => {
    const [boosts, profiles] = await Promise.allSettled([
      dex("/token-boosts/latest/v1", { timeoutMs: 6000, retries: 0 }),
      dex("/token-profiles/latest/v1", { timeoutMs: 6000, retries: 0 }),
    ]);
    const boosted = boosts.status === "fulfilled" && Array.isArray(boosts.value) ? boosts.value : [];
    const profiled = profiles.status === "fulfilled" && Array.isArray(profiles.value) ? profiles.value : [];
    const map = new Map();
    for (const entry of boosted) {
      if (entry?.chainId !== "base" || !entry.tokenAddress) continue;
      map.set(entry.tokenAddress.toLowerCase(), {
        address: entry.tokenAddress,
        boostAmount: num(entry.totalAmount) ?? num(entry.amount),
        description: entry.description || null,
        links: (entry.links || []).map((link) => link?.url).filter(Boolean).slice(0, 3),
      });
    }
    for (const entry of profiled) {
      if (entry?.chainId !== "base" || !entry.tokenAddress) continue;
      const key = entry.tokenAddress.toLowerCase();
      const current = map.get(key) || { address: entry.tokenAddress, boostAmount: null, links: [] };
      map.set(key, {
        ...current,
        description: current.description || entry.description || null,
        links: [...new Set([...(current.links || []), ...(entry.links || []).map((link) => link?.url).filter(Boolean)])].slice(0, 3),
        profile: true,
      });
    }
    return Array.from(map.values()).sort((a, b) => (b.boostAmount || 0) - (a.boostAmount || 0));
  });
}

/* -------------------------------- DefiLlama ------------------------------- */

const SUPPORTED_YIELD_CHAINS = new Set([
  "Ethereum",
  "Base",
  "Arbitrum",
  "Optimism",
  "Polygon",
  "Solana",
  "BSC",
  "Avalanche",
  "Sui",
  "Aptos",
]);

const BLUECHIP_PROJECTS = new Set([
  "aave-v3",
  "morpho-blue",
  "compound-v3",
  "spark",
  "pendle",
  "curve-dex",
  "uniswap-v3",
  "lido",
  "rocket-pool",
  "ether.fi-stake",
  "euler-v2",
  "fluid",
  "moonwell",
  "aerodrome-slipstream",
  "balancer-v2",
  "maple",
  "sky",
]);

const ETH_MARKERS = /(W?ETH|STETH|RETH|WEETH|CBETH|EIGEN|ETH)/i;
const BTC_MARKERS = /(W?BTC|CBBTC|TBTC|LBTC|BTCB|SOLVBTC)/i;

function riskForPool(pool) {
  let score = 3;
  if (pool.ilRisk === "yes") score += 2;
  if ((pool.tvlUsd || 0) < 20_000_000) score += 2;
  else if ((pool.tvlUsd || 0) > 500_000_000) score -= 1;
  if ((pool.apy || 0) > 25) score += 2;
  if ((pool.apy || 0) > 60) score += 2;
  if (pool.stablecoin) score -= 1;
  if (BLUECHIP_PROJECTS.has(pool.project)) score -= 1;
  if (pool.outlier) score += 2;
  const clamped = Math.max(1, Math.min(10, score));
  return {
    score: clamped,
    label: clamped <= 3 ? "low" : clamped <= 6 ? "medium" : "high",
  };
}

export async function getYieldPools({ assetClass = "any", minTvlUsd = INTEL.minYieldTvlUsd, limit = INTEL.maxYields } = {}) {
  const raw = await memo("defillama:yields", 120000, () =>
    fetchJSON(`${INTEL.yieldsApiUrl}/pools`, {}, {
      timeoutMs: 25000,
      retries: 0,
      service: "defillama-yields",
    })
  );
  const rows = Array.isArray(raw?.data) ? raw.data : [];
  if (rows.length === 0) throw AppError.upstream("DefiLlama returned no yield pools.", undefined, "YIELDS_EMPTY");

  const filtered = rows
    .filter(
      (pool) =>
        SUPPORTED_YIELD_CHAINS.has(pool.chain) &&
        Number.isFinite(Number(pool.tvlUsd)) &&
        Number(pool.tvlUsd) >= minTvlUsd &&
        Number.isFinite(Number(pool.apy)) &&
        Number(pool.apy) >= 0.1 &&
        Number(pool.apy) <= 150 &&
        !pool.outlier
    )
    .filter((pool) => {
      if (assetClass === "stable") return pool.stablecoin === true;
      if (assetClass === "eth") return !pool.stablecoin && ETH_MARKERS.test(String(pool.symbol || ""));
      if (assetClass === "btc") return !pool.stablecoin && BTC_MARKERS.test(String(pool.symbol || ""));
      return true;
    })
    .map((pool) => {
      const risk = riskForPool(pool);
      const quality = (Number(pool.apy) * Math.log10(Number(pool.tvlUsd) + 10)) / risk.score;
      return {
        pool: pool.pool,
        project: pool.project,
        chain: pool.chain,
        symbol: pool.symbol,
        stablecoin: Boolean(pool.stablecoin),
        exposure: pool.exposure || null,
        ilRisk: pool.ilRisk || null,
        tvlUsd: Number(pool.tvlUsd),
        apy: Number(pool.apy),
        apyBase: num(pool.apyBase),
        apyReward: num(pool.apyReward),
        apyMean30d: num(pool.apyMean30d),
        apyPct7d: num(pool.apyPct7D),
        rewardTokens: pool.rewardTokens || [],
        underlyingTokens: (pool.underlyingTokens || []).slice(0, 5),
        predictions: pool.predictions?.predictedClass
          ? {
              class: pool.predictions.predictedClass,
              probabilityPct: num(pool.predictions.predictedProbability),
              confidence: pool.predictions.binnedConfidence,
            }
          : null,
        risk,
        qualityScore: Number(quality.toFixed(4)),
      };
    })
    .sort((a, b) => b.qualityScore - a.qualityScore);

  if (filtered.length === 0) {
    throw AppError.upstream(
      "No yield pools matched the requested filters.",
      { assetClass, minTvlUsd },
      "YIELDS_NO_MATCH"
    );
  }

  return filtered.slice(0, Math.max(limit * 3, limit));
}

export async function getChainTvls({ limit = 15 } = {}) {
  const key = `llama:chains:${limit}`;
  return memo(key, 300000, async () => {
    const payload = await fetchJSON(`${INTEL.defillamaApiUrl}/v2/chains`, {}, {
      timeoutMs: 20000,
      retries: 0,
      service: "defillama",
    });
    if (!Array.isArray(payload)) {
      throw AppError.upstream("DefiLlama returned no chains.", undefined, "CHAINS_EMPTY");
    }
    return payload
      .filter((chain) => Number.isFinite(Number(chain.tvl)))
      .sort((a, b) => Number(b.tvl) - Number(a.tvl))
      .slice(0, Math.max(1, Number(limit) || 1))
      .map((chain) => ({
        name: chain.name,
        geckoId: chain.gecko_id || null,
        tvlUsd: Number(chain.tvl),
        tokenSymbol: chain.tokenSymbol || null,
      }));
  });
}

export async function getProtocolsTvl({ chain = "Base", limit = 15 } = {}) {
  const key = `llama:protocols:${chain.toLowerCase()}:${limit}`;
  return memo(key, 300000, async () => {
    const payload = await fetchJSON(`${INTEL.defillamaApiUrl}/protocols`, {}, {
      timeoutMs: 20000,
      retries: 0,
      service: "defillama",
    });
    if (!Array.isArray(payload)) {
      throw AppError.upstream("DefiLlama returned no protocols.", undefined, "PROTOCOLS_EMPTY");
    }
    return payload
      .filter((p) => Array.isArray(p.chains) && p.chains.includes(chain) && Number.isFinite(Number(p.tvl)))
      .sort((a, b) => Number(b.tvl) - Number(a.tvl))
      .slice(0, Math.max(1, Number(limit) || 1))
      .map((p) => ({
        name: p.name,
        slug: p.slug,
        category: p.category || null,
        chains: p.chains,
        tvlUsd: Number(p.tvl),
        change1dPct: num(p.change_1d),
        change7dPct: num(p.change_7d),
      }));
  });
}

/* ------------------------------- Base gas --------------------------------- */

export async function getBaseFeeHistory({ blocks = 24 } = {}) {
  const key = `base:feehistory:${blocks}`;
  return memo(key, 60000, async () => {
    const history = await publicClient.getFeeHistory({ blockCount: blocks, rewardPercentiles: [50] });
    const baseFees = history.baseFeePerGas || [];
    const rows = baseFees.map((fee, index) => ({
      baseFeeGwei: Number(fee) / 1e9,
      gasUsedRatio: num(history.gasUsedRatio?.[index]),
      pending: index === baseFees.length - 1,
    }));
    const settled = rows.filter((row) => !row.pending && row.baseFeeGwei > 0);
    const gwei = settled.map((row) => row.baseFeeGwei).sort((a, b) => a - b);
    const latest = settled.at(-1) ?? null;
    const oldest = settled[0] ?? null;
    return {
      blocksRequested: blocks,
      samples: rows,
      stats: {
        currentGwei: rows.at(-1)?.baseFeeGwei ?? null,
        avgGwei: gwei.length ? Number((gwei.reduce((s, v) => s + v, 0) / gwei.length).toFixed(4)) : null,
        medianGwei: gwei.length ? gwei[Math.floor(gwei.length / 2)] : null,
        minGwei: gwei[0] ?? null,
        maxGwei: gwei.at(-1) ?? null,
        trendPct: latest && oldest ? Number((((latest.baseFeeGwei - oldest.baseFeeGwei) / oldest.baseFeeGwei) * 100).toFixed(2)) : null,
      },
      fetchedAt: new Date().toISOString(),
    };
  });
}

/* ------------------------------ Honeypot.is ------------------------------- */

export async function checkHoneypot(address) {
  const key = `honeypot:${address.toLowerCase()}`;
  return memo(key, 300000, async () => {
    try {
      const payload = await fetchJSON(
        `${INTEL.honeypotApiUrl}/IsHoneypot?address=${address}&chainID=8453`,
        { headers: { accept: "application/json" } },
        { timeoutMs: 7000, retries: 0, service: "honeypot" }
      );
      return {
        checked: true,
        isHoneypot: Boolean(payload?.honeypotResult?.isHoneypot),
        risk: payload?.summary?.risk || null,
        riskLevel: num(payload?.summary?.riskLevel),
        flags: payload?.flags || [],
        buyTaxPct: num(payload?.simulationResult?.buyTax),
        sellTaxPct: num(payload?.simulationResult?.sellTax),
        openSource: Boolean(payload?.contractCode?.openSource),
        isProxy: Boolean(payload?.contractCode?.isProxy),
        totalHolders: num(payload?.token?.totalHolders),
        simulationSuccess: Boolean(payload?.simulationSuccess),
        fetchedAt: new Date().toISOString(),
      };
    } catch (error) {
      logger.warn("honeypot check unavailable", { address, message: error.message });
      return { checked: false, error: error.message };
    }
  });
}

/* ------------------------------- Diagnostics ------------------------------ */

const probe = async (name, fn) => {
  const started = Date.now();
  try {
    const detail = await fn();
    return { name, ok: true, latencyMs: Date.now() - started, detail };
  } catch (error) {
    return { name, ok: false, latencyMs: Date.now() - started, error: error.message };
  }
};

export async function probeDataProviders() {
  const [coingecko, geckoterminal, binance, defillama] = await Promise.all([
    probe("coingecko", async () => (await coingeckoPing())?.gecko_says || "ok"),
    probe("geckoterminal", async () => {
      const pools = await getTokenPools("0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b");
      return `${pools.length} pools`;
    }),
    probe("binance", async () => {
      const derivatives = await getBinanceDerivatives("BTC");
      return derivatives?.symbol || "unavailable";
    }),
    probe("defillama", async () => {
      const payload = await fetchJSON(`${INTEL.defillamaApiUrl}/v2/chains`, {}, {
        timeoutMs: 6000,
        retries: 0,
        service: "defillama",
      });
      return `${Array.isArray(payload) ? payload.length : 0} chains`;
    }),
  ]);
  return {
    coingecko: { configured: true, ...coingecko },
    geckoterminal: { configured: true, ...geckoterminal },
    binance: { configured: true, ...binance },
    defillama: { configured: true, ...defillama },
    dexscreener: { configured: true, probed: false },
    newsFeeds: { configured: INTEL.newsFeeds.length },
    twitter: { configured: Boolean(INTEL.twitterBearerToken), kolHandles: INTEL.kolHandles.length },
    fetchedAt: new Date().toISOString(),
  };
}

export { MAJOR_MARKETS, TIMEFRAMES, INTEL };
