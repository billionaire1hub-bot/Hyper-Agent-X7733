import crypto from "node:crypto";
import { getAddress, isAddress, keccak256, parseAbiItem, toBytes } from "viem";
import { config, isVercel, USDC } from "../config.js";
import { AppError } from "../lib/errors.js";
import { fetchJSON } from "../lib/http.js";
import { logger } from "../lib/logger.js";
import { acquireLock, releaseLock, store, storeHelpers } from "../lib/store.js";
import {
  fromUnits,
  getAgentAddress,
  getNativeBalance,
  getTokenBalance,
  publicClient,
  shortRpcError,
} from "../chain/client.js";
import {
  getBasePools,
  getBinanceDerivatives,
  getCandles,
  getCoinByContract,
  getCoinMarkets,
  getDexToken,
  getGlobalMarket,
  getNewBasePools,
  getTokenPools,
  getTrendingCoins,
  getYieldPools,
  checkHoneypot,
} from "./market.js";
import { getLatestNews } from "./news.js";
import { askJSON, aiConfigured } from "./ai.js";
import { resolveToken } from "./tokens.js";
import { computeIndicators, buildTradePlan } from "./ta.js";
import { getAcpJobs, getJobCounter } from "./escrow.js";
import { isPublicHttpUrl, discoverTargets } from "./discovery.js";
import { sendA2APitch, registerOutreachSession } from "./outreach.js";
import { processReferralPayouts, referralStatus } from "./referrals.js";
import { basePriceFor, currentPricing } from "./pricing.js";

const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const SUBSCRIPTION_TTL_SECONDS = 45 * 24 * 60 * 60;
const SNAPSHOT_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 240;
const TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
const WETH = "0x4200000000000000000000000000000000000006";

const nowIso = () => new Date().toISOString();
const dayKey = (date = new Date()) => date.toISOString().slice(0, 10);
const round = (value, digits = 6) => Number(Number(value).toFixed(digits));

async function loadState() {
  const raw = await store.get(storeHelpers.revenueState()).catch(() => null);
  return {
    day: dayKey(),
    deliveries: 0,
    alertsToday: 0,
    lastCycleAt: null,
    lastError: null,
    lastSummary: null,
    bounties: [],
    alertKeys: [],
    ...(raw && typeof raw === "object" ? raw : {}),
  };
}

async function saveState(state) {
  await store
    .set(storeHelpers.revenueState(), state, { ttlSeconds: STATE_TTL_SECONDS })
    .catch((error) => logger.warn("failed to save revenue state", { message: error.message }));
  return state;
}

/* ------------------------------ Arbitrage -------------------------------- */

export function arbitrageOpportunities(
  pools,
  { minSpreadBps = 40, minLiquidityUsd = 50000, maxSpreadBps = 5000 } = {}
) {
  const usable = (Array.isArray(pools) ? pools : []).filter(
    (pool) =>
      pool?.baseAddress &&
      Number.isFinite(Number(pool?.priceUsd)) &&
      Number(pool.priceUsd) > 0 &&
      Number(pool?.liquidityUsd || 0) >= minLiquidityUsd
  );
  if (usable.length < 2) return [];
  // Only pools quoting the same base token are comparable. GeckoTerminal reports
  // base_token_price_usd, so a pool where the scanned token is the quote asset
  // would otherwise compare two unrelated assets.
  const byBase = new Map();
  for (const pool of usable) {
    const base = String(pool.baseAddress).toLowerCase();
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(pool);
  }
  const group = [...byBase.values()].filter((entry) => entry.length >= 2).sort((a, b) => b.length - a.length)[0];
  if (!group) return [];
  const sorted = [...group].sort((a, b) => Number(a.priceUsd) - Number(b.priceUsd));
  const low = sorted[0];
  const high = sorted[sorted.length - 1];
  const spreadBps = ((Number(high.priceUsd) - Number(low.priceUsd)) / Number(low.priceUsd)) * 10_000;
  if (spreadBps < minSpreadBps || spreadBps > maxSpreadBps) return [];
  return [
    {
      type: "arbitrage",
      token: low.baseAddress || low.baseSymbol || null,
      symbol: low.baseSymbol || (low.name ? String(low.name).split("/")[0].trim() : null) || null,
      spreadBps: Math.round(spreadBps),
      buy: { dex: low.dex, pool: low.address, priceUsd: Number(low.priceUsd), liquidityUsd: Number(low.liquidityUsd || 0) },
      sell: { dex: high.dex, pool: high.address, priceUsd: Number(high.priceUsd), liquidityUsd: Number(high.liquidityUsd || 0) },
      depthUsd: Math.min(Number(low.liquidityUsd || 0), Number(high.liquidityUsd || 0)),
      observedAt: nowIso(),
    },
  ];
}

export async function scanArbitrage({ limit = 6 } = {}) {
  const basePools = await getBasePools({ limit: Math.max(3, config.revenue.scanPools) });
  const tokens = [...new Set(basePools.map((pool) => pool.baseAddress).filter(Boolean))].slice(0, limit);
  const results = [];
  for (const token of tokens) {
    try {
      const pools = (await getTokenPools(token)).filter(
        (pool) => String(pool.baseAddress || "").toLowerCase() === String(token).toLowerCase()
      );
      results.push(
        ...arbitrageOpportunities(pools, {
          minSpreadBps: config.revenue.arbitrageMinSpreadBps,
          minLiquidityUsd: config.revenue.arbitrageMinLiquidityUsd,
        })
      );
    } catch (error) {
      logger.warn("arbitrage scan skipped token", { token, message: error.message });
    }
  }
  return results
    .sort((a, b) => b.spreadBps - a.spreadBps)
    .slice(0, limit)
    .map((entry) => ({ ...entry, source: "geckoterminal" }));
}

/* -------------------------------- Whales --------------------------------- */

async function ethUsdPrice() {
  try {
    const rows = await getCoinMarkets(["ethereum"]);
    const price = Number(rows?.find((row) => row.id === "ethereum")?.priceUsd ?? rows?.[0]?.priceUsd);
    if (Number.isFinite(price) && price > 0) return price;
  } catch (error) {
    logger.warn("ethereum price via coingecko failed", { message: error.message });
  }
  try {
    const ticker = await fetchJSON("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT", {}, {
      timeoutMs: 6000,
      retries: 0,
      service: "binance-spot",
    });
    const price = Number(ticker?.price);
    if (Number.isFinite(price) && price > 0) return price;
  } catch (error) {
    logger.warn("ethereum price via binance failed", { message: error.message });
  }
  return null;
}

const topicAddress = (topic) =>
  typeof topic === "string" && topic.length === 66 ? getAddress(`0x${topic.slice(26)}`) : null;

/**
 * Public Base RPC answers eth_getLogs with 429. Receipt scanning is a live
 * fallback that reads the same Transfer events from recent blocks at the cost
 * of a smaller lookback window.
 */
async function transferLogsViaGetLogs(tokens, fromBlock, latest) {
  const collected = new Map(tokens.map((token) => [token.address.toLowerCase(), []]));
  for (const token of tokens) {
    const logs = await publicClient.getLogs({
      address: token.address,
      event: TRANSFER_EVENT,
      fromBlock,
      toBlock: latest,
    });
    collected.get(token.address.toLowerCase()).push(...logs);
  }
  return { method: "eth_getLogs", collected };
}

async function transferLogsViaReceipts(tokens, fromBlock, latest, maxBlocks = 8) {
  const collected = new Map(tokens.map((token) => [token.address.toLowerCase(), []]));
  const span = Number(latest - fromBlock) + 1;
  const start = latest - BigInt(Math.min(span, maxBlocks)) + 1n;
  const addresses = new Set(tokens.map((token) => token.address.toLowerCase()));
  const blockNumbers = [];
  for (let block = start; block <= latest; block += 1n) blockNumbers.push(block);
  const receipts = await Promise.all(
    blockNumbers.map((block) =>
      publicClient
        .request({ method: "eth_getBlockReceipts", params: [`0x${block.toString(16)}`] })
        .catch(() => null)
    )
  );
  for (const entries of receipts) {
    for (const receipt of Array.isArray(entries) ? entries : []) {
      for (const log of receipt?.logs || []) {
        const address = String(log.address || "").toLowerCase();
        if (!addresses.has(address)) continue;
        if (String(log.topics?.[0] || "").toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue;
        if (log.topics?.length !== 3) continue;
        collected.get(address).push({
          args: {
            from: topicAddress(log.topics[1]),
            to: topicAddress(log.topics[2]),
            value: BigInt(log.data || 0),
          },
          transactionHash: log.transactionHash,
          blockNumber: BigInt(log.blockNumber),
        });
      }
    }
  }
  return { method: "eth_getBlockReceipts", collected };
}

export async function scanWhales({ lookbackBlocks = config.revenue.whaleLookbackBlocks } = {}) {
  const latest = await publicClient.getBlockNumber();
  const fromBlock = latest - BigInt(Math.max(1, lookbackBlocks)) + 1n;
  const [ethUsd, block] = await Promise.all([
    ethUsdPrice(),
    publicClient.getBlock({ blockNumber: latest }).catch(() => null),
  ]);
  const tokens = [
    { address: USDC.address, symbol: "USDC", decimals: 6, threshold: BigInt(Math.round(config.revenue.whaleMinUsdc * 1e6)) },
    { address: WETH, symbol: "WETH", decimals: 18, threshold: BigInt(Math.round(config.revenue.whaleMinWeth * 1e18)) },
  ];

  let scan;
  try {
    scan = await transferLogsViaGetLogs(tokens, fromBlock, latest);
  } catch (error) {
    logger.warn("whale eth_getLogs failed; scanning block receipts", { message: shortRpcError(error) });
    scan = await transferLogsViaReceipts(tokens, fromBlock, latest).catch((receiptError) => {
      logger.warn("whale receipt scan failed", { message: shortRpcError(receiptError) });
      return null;
    });
  }
  if (!scan) return [];

  const alerts = [];
  for (const token of tokens) {
    for (const log of scan.collected.get(token.address.toLowerCase()) || []) {
      const value = BigInt(log.args?.value || 0);
      if (value < token.threshold) continue;
      const amount = Number(value) / 10 ** token.decimals;
      alerts.push({
        type: "whale",
        token: token.symbol,
        tokenAddress: token.address,
        amount: round(amount, token.decimals > 6 ? 6 : 2),
        usd: token.symbol === "USDC" ? round(amount, 2) : ethUsd ? round(amount * ethUsd, 2) : null,
        from: log.args?.from || null,
        to: log.args?.to || null,
        txHash: log.transactionHash,
        blockNumber: String(log.blockNumber),
        observedAt: block?.timestamp ? new Date(Number(block.timestamp) * 1000).toISOString() : nowIso(),
      });
    }
  }
  return alerts.sort((a, b) => (b.usd || 0) - (a.usd || 0)).slice(0, 10);
}

export async function flashAlerts({ params }) {
  const types = new Set(params.types || ["arbitrage", "whale"]);
  const alerts = [];
  if (types.has("arbitrage")) alerts.push(...(await scanArbitrage({ limit: 6 })));
  if (types.has("whale")) alerts.push(...(await scanWhales()));
  const watchlist = (params.watchlist || []).map((entry) => String(entry).toLowerCase());
  const filtered = watchlist.length
    ? alerts.filter(
        (alert) =>
          watchlist.includes(String(alert.token || "").toLowerCase()) ||
          watchlist.includes(String(alert.symbol || "").toLowerCase()) ||
          watchlist.includes(String(alert.tokenAddress || "").toLowerCase())
      )
    : alerts;
  const limited = filtered.slice(0, Math.max(1, Number(params.limit) || 6));
  return {
    status: "live",
    alerts: limited,
    count: limited.length,
    types: [...types],
    scannedAt: nowIso(),
    thresholds: {
      minSpreadBps: config.revenue.arbitrageMinSpreadBps,
      minLiquidityUsd: config.revenue.arbitrageMinLiquidityUsd,
      whaleMinUsdc: config.revenue.whaleMinUsdc,
      whaleMinWeth: config.revenue.whaleMinWeth,
      lookbackBlocks: config.revenue.whaleLookbackBlocks,
    },
    note: limited.length
      ? "Detected from live Base DEX pools and ERC20 transfer logs. Prices move; verify before trading."
      : "No alert crossed the configured thresholds in the current window. No alert is reported unless observed live.",
  };
}

/* ------------------------------- Gas ------------------------------------- */

export function gasAdvice({ gasPriceGwei, recentBaseFeesGwei = [], txType = "swap", urgency = "now" } = {}) {
  const price = Number(gasPriceGwei);
  if (!Number.isFinite(price) || price <= 0) {
    throw AppError.upstream("Live gas price is unavailable.", undefined, "GAS_UNAVAILABLE");
  }
  const units = txType === "transfer" ? 21000 : txType === "contract" ? 150000 : 250000;
  const recent = recentBaseFeesGwei.map(Number).filter((value) => Number.isFinite(value) && value > 0);
  const avg = recent.length ? recent.reduce((sum, value) => sum + value, 0) / recent.length : null;
  const trend = avg === null ? "unknown" : price > avg * 1.08 ? "rising" : price < avg * 0.92 ? "falling" : "flat";
  const recommendNow = urgency === "now" || trend !== "falling";
  return {
    txType,
    urgency,
    gasPriceGwei: round(price, 6),
    recentAverageGwei: avg === null ? null : round(avg, 6),
    trend,
    estimatedGasUnits: units,
    estimatedCostEth: round((units * price) / 1e9, 9),
    recommendedMaxFeeGwei: round(price * (trend === "rising" ? 1.35 : 1.15), 6),
    advice: recommendNow
      ? "Execute on Base now; current gas is within the observed range."
      : "Base gas is falling. Waiting one or two blocks can reduce the fee; the saving is small in absolute terms.",
    route: txType === "swap" ? "Use the KyberSwap aggregator route; the fee is dominated by L2 execution, not pool choice." : "Send directly on Base L2.",
    observedAt: nowIso(),
  };
}

export async function gasAdvisor({ params }) {
  const [wei, latest, ethUsd] = await Promise.all([
    publicClient.getGasPrice(),
    publicClient.getBlock({ blockTag: "latest" }).catch(() => null),
    ethUsdPrice(),
  ]);
  const blocks = await Promise.all(
    Array.from({ length: 8 }, (_, index) => {
      const blockNumber = latest?.number ? latest.number - BigInt(index) : null;
      if (blockNumber === null) return null;
      return publicClient.getBlock({ blockNumber }).catch(() => null);
    })
  );
  const baseFees = blocks
    .map((block) => (block?.baseFeePerGas ? Number(block.baseFeePerGas) / 1e9 : null))
    .filter((value) => Number.isFinite(value));
  const advice = gasAdvice({
    gasPriceGwei: Number(wei) / 1e9,
    recentBaseFeesGwei: baseFees,
    txType: params.txType,
    urgency: params.urgency,
  });
  return {
    ...advice,
    ethUsd: ethUsd === null ? null : round(ethUsd, 2),
    estimatedCostUsd: ethUsd === null ? null : round(advice.estimatedCostEth * ethUsd, 6),
    blockNumber: latest?.number ? String(latest.number) : null,
    source: "base-rpc",
  };
}

/* ------------------------------ Yield radar ------------------------------ */

export function yieldGaps(pools, { minApy = 8, minTvlUsd = 1_000_000 } = {}) {
  const usable = (Array.isArray(pools) ? pools : []).filter(
    (pool) => Number(pool.apy) >= minApy && Number(pool.tvlUsd) >= minTvlUsd
  );
  if (!usable.length) return { medianApy: null, p90Apy: null, gaps: [], sample: 0 };
  const apys = usable.map((pool) => Number(pool.apy)).sort((a, b) => a - b);
  const median = apys[Math.floor(apys.length / 2)];
  const p90 = apys[Math.min(apys.length - 1, Math.floor(apys.length * 0.9))];
  const gaps = usable
    .filter((pool) => Number(pool.apy) >= p90)
    .sort((a, b) => Number(b.apy) - Number(a.apy))
    .slice(0, 8)
    .map((pool) => ({
      project: pool.project,
      pool: pool.pool,
      symbol: pool.symbol,
      chain: pool.chain,
      tvlUsd: Number(pool.tvlUsd),
      apy: Number(pool.apy),
      apyBase: pool.apyBase,
      apyReward: pool.apyReward,
      ilRisk: pool.ilRisk,
      stablecoin: Boolean(pool.stablecoin),
      risk: pool.risk,
      gapVsMedianPct: median > 0 ? round(((Number(pool.apy) - median) / median) * 100, 2) : null,
    }));
  return { medianApy: round(median, 4), p90Apy: round(p90, 4), gaps, sample: usable.length };
}

export async function yieldRadar({ params }) {
  const pools = await getYieldPools({
    assetClass: params.assetClass || "any",
    minTvlUsd: params.minTvlUsd || config.intelligence.minYieldTvlUsd,
    limit: 60,
  });
  const basePools = pools.filter((pool) => String(pool.chain).toLowerCase() === "base");
  if (!basePools.length) {
    throw AppError.upstream("No Base yield pools matched the filters.", { params }, "YIELDS_NO_BASE_POOLS");
  }
  const analysis = yieldGaps(basePools, {
    minApy: params.minApy ?? 8,
    minTvlUsd: params.minTvlUsd || config.intelligence.minYieldTvlUsd,
  });
  return {
    status: "live",
    chain: "base",
    sample: analysis.sample,
    medianApy: analysis.medianApy,
    p90Apy: analysis.p90Apy,
    gaps: analysis.gaps,
    filters: { minApy: params.minApy ?? 8, minTvlUsd: params.minTvlUsd || config.intelligence.minYieldTvlUsd },
    source: "defillama-yields",
    fetchedAt: nowIso(),
    disclaimer: "APY is variable and can include token incentives. TVL and IL risk are reported; this is not financial advice.",
  };
}

/* ----------------------------- Agent credit ------------------------------ */

export function creditScoreFromStats(stats = {}) {
  const jobs = Number(stats.jobs || 0);
  const providerJobs = Number(stats.providerJobs || 0);
  const clientJobs = Number(stats.clientJobs || 0);
  const completed = Number(stats.completed || 0);
  const rejected = Number(stats.rejected || 0);
  const expired = Number(stats.expired || 0);
  const volumeUsdc = Number(stats.volumeUsdc || 0);
  const lastActivityAt = stats.lastActivityAt ? Date.parse(stats.lastActivityAt) : null;
  if (jobs === 0) {
    return {
      score: 15,
      label: "unproven",
      factors: { activity: 0, completion: 0, volume: 0, recency: 0, penalties: 0 },
      flags: ["no_acp_activity"],
    };
  }
  const activity = Math.min(25, Math.log2(jobs + 1) * 7);
  const settled = completed + rejected + expired;
  const completionRate = settled > 0 ? completed / settled : 0.5;
  const completion = completionRate * 30;
  const volume = Math.min(25, Math.log10(volumeUsdc + 1) * 8);
  const ageDays = lastActivityAt ? (Date.now() - lastActivityAt) / 86_400_000 : Infinity;
  const recency = ageDays <= 7 ? 10 : ageDays <= 30 ? 6 : ageDays <= 90 ? 2 : 0;
  const penalties = Math.min(20, rejected * 5 + expired * 3);
  const score = Math.max(0, Math.min(100, Math.round(activity + completion + volume + recency - penalties)));
  const flags = [];
  if (rejected > 0) flags.push("rejected_jobs");
  if (expired > 0) flags.push("expired_jobs");
  if (ageDays > 90) flags.push("inactive_90d");
  if (jobs < 3) flags.push("limited_history");
  return {
    score,
    label: score >= 75 ? "high" : score >= 45 ? "medium" : "low",
    factors: {
      activity: round(activity, 2),
      completion: round(completion, 2),
      volume: round(volume, 2),
      recency,
      penalties,
    },
    completionRate: round(completionRate * 100, 2),
    flags,
  };
}

export async function scanAgentCredit(address, { scanJobs = 120 } = {}) {
  if (!isAddress(String(address || ""))) {
    throw AppError.badRequest("address must be a valid EVM address.", { address }, "INVALID_ADDRESS");
  }
  const target = getAddress(address);
  const counter = await getJobCounter();
  const head = BigInt(counter);
  const span = BigInt(Math.max(10, scanJobs));
  const from = head - span + 1n > 0n ? head - span + 1n : 1n;
  const ids = [];
  for (let id = from; id <= head; id += 1n) ids.push(id.toString());
  const jobs = await getAcpJobs(ids);
  const stats = {
    jobs: 0,
    providerJobs: 0,
    clientJobs: 0,
    completed: 0,
    rejected: 0,
    expired: 0,
    volumeUsdc: 0,
    lastActivityAt: null,
    lastJobId: null,
  };
  for (const job of jobs) {
    if (!job) continue;
    const isProvider = job.provider.toLowerCase() === target.toLowerCase();
    const isClient = job.client.toLowerCase() === target.toLowerCase();
    if (!isProvider && !isClient) continue;
    stats.jobs += 1;
    if (isProvider) stats.providerJobs += 1;
    if (isClient) stats.clientJobs += 1;
    if (job.status === 3) stats.completed += 1;
    if (job.status === 4) stats.rejected += 1;
    if (job.status === 5) stats.expired += 1;
    stats.volumeUsdc += Number(fromUnits(job.budget, USDC.decimals));
    stats.lastJobId = String(job.id);
    if (Number(job.expiredAt) > 0) {
      const at = new Date(Number(job.expiredAt) * 1000).toISOString();
      if (!stats.lastActivityAt || Date.parse(at) > Date.parse(stats.lastActivityAt)) stats.lastActivityAt = at;
    }
  }
  stats.volumeUsdc = round(stats.volumeUsdc, 6);
  const credit = creditScoreFromStats(stats);
  return { ...credit, address: target, window: { from: String(from), to: String(head), scanned: jobs.filter(Boolean).length }, stats };
}

export async function agentCredit({ params }) {
  const credit = await scanAgentCredit(params.address, { scanJobs: 120 });
  const [eth, usdc, nonce] = await Promise.all([
    getNativeBalance(credit.address).catch(() => null),
    getTokenBalance(USDC.address, credit.address).catch(() => null),
    publicClient.getTransactionCount({ address: credit.address }).catch(() => null),
  ]);
  return {
    status: "scored",
    ...credit,
    balances: {
      eth: eth === null ? null : round(Number(fromUnits(eth, 18)), 6),
      usdc: usdc === null ? null : round(Number(fromUnits(usdc, USDC.decimals)), 6),
      nonce: nonce === null ? null : Number(nonce),
    },
    source: "base-rpc+acp-getJob",
    scoredAt: nowIso(),
  };
}

/* --------------------------- Token security ------------------------------ */

export function securityRiskFromFacts(facts = {}, { minLiquidityUsd = config.revenue.securityMinLiquidityUsd } = {}) {
  const flags = [];
  let score = 0;
  const add = (code, severity, points, detail = null) => {
    flags.push({ code, severity, detail });
    score += points;
  };
  const liquidity = Number(facts.liquidityUsd);
  const buyTax = Number(facts.buyTaxPct);
  const sellTax = Number(facts.sellTaxPct);

  if (facts.honeypot === true) add("honeypot", "critical", 70);
  if (!Number.isFinite(liquidity) || liquidity <= 0) add("no_liquidity", "critical", 40);
  else if (liquidity < minLiquidityUsd) add("low_liquidity", "high", 25, `liquidityUsd=${liquidity}`);
  if (Number.isFinite(buyTax) && buyTax > 10) add("high_buy_tax", "high", 20, `buyTaxPct=${buyTax}`);
  else if (Number.isFinite(buyTax) && buyTax > 5) add("elevated_buy_tax", "medium", 10, `buyTaxPct=${buyTax}`);
  if (Number.isFinite(sellTax) && sellTax > 10) add("high_sell_tax", "high", 25, `sellTaxPct=${sellTax}`);
  else if (Number.isFinite(sellTax) && sellTax > 5) add("elevated_sell_tax", "medium", 12, `sellTaxPct=${sellTax}`);
  if (facts.openSource === false) add("closed_source", "medium", 10);
  if (facts.isProxy === true) add("proxy_contract", "low", 6);
  if (Number.isFinite(Number(facts.totalHolders)) && Number(facts.totalHolders) < 100) {
    add("few_holders", "low", 8, `holders=${facts.totalHolders}`);
  }
  const createdAt = facts.createdAt ? Date.parse(facts.createdAt) : null;
  if (Number.isFinite(createdAt) && Date.now() - createdAt < 86_400_000) add("pool_under_24h", "medium", 10);
  if (Number(facts.pairsObserved || 0) === 0) add("no_dex_coverage", "high", 15);
  else if (Number(facts.pairsObserved) === 1) add("single_pool", "low", 5);

  const riskScore = Math.max(0, Math.min(100, Math.round(score)));
  return {
    riskScore,
    riskLevel: riskScore >= 60 ? "high" : riskScore >= 30 ? "medium" : "low",
    flags,
  };
}

async function scanOneTokenSecurity(input) {
  const token = await resolveToken(input, { allowNative: false }).catch((error) => ({ error }));
  if (token?.error) {
    return { input, resolved: false, error: token.error.message, code: token.error.code || "TOKEN_NOT_RESOLVED" };
  }

  const [honeypot, pools, dex] = await Promise.all([
    checkHoneypot(token.address).catch(() => ({ checked: false })),
    getTokenPools(token.address).catch(() => []),
    getDexToken(token.address).catch(() => null),
  ]);
  const topPool = pools[0] || null;
  const facts = {
    priceUsd: dex?.priceUsd ?? topPool?.priceUsd ?? null,
    liquidityUsd: dex?.totalLiquidityUsd ?? topPool?.liquidityUsd ?? null,
    pairsObserved: dex?.pairsObserved ?? pools.length,
    createdAt: dex?.pairCreatedAt || topPool?.createdAt || null,
    honeypot: honeypot?.isHoneypot ?? null,
    buyTaxPct: honeypot?.buyTaxPct ?? null,
    sellTaxPct: honeypot?.sellTaxPct ?? null,
    openSource: honeypot?.openSource ?? null,
    isProxy: honeypot?.isProxy ?? null,
    totalHolders: honeypot?.totalHolders ?? null,
  };
  const risk = securityRiskFromFacts(facts);
  return {
    input,
    resolved: true,
    token: { symbol: token.symbol, name: token.name, address: token.address, decimals: token.decimals },
    security: {
      checked: Boolean(honeypot?.checked),
      honeypot: honeypot?.isHoneypot ?? null,
      buyTaxPct: honeypot?.buyTaxPct ?? null,
      sellTaxPct: honeypot?.sellTaxPct ?? null,
      openSource: honeypot?.openSource ?? null,
      isProxy: honeypot?.isProxy ?? null,
      totalHolders: honeypot?.totalHolders ?? null,
      riskLevel: honeypot?.riskLevel ?? null,
    },
    facts,
    pools: pools.slice(0, 3).map((pool) => ({
      dex: pool.dex,
      address: pool.address,
      priceUsd: pool.priceUsd,
      liquidityUsd: pool.liquidityUsd,
      volume24hUsd: pool.volume24hUsd,
      createdAt: pool.createdAt,
    })),
    ...risk,
  };
}

export async function tokenSecurityScan({ params }) {
  const tokens = [];
  for (const entry of params.tokens) tokens.push(await scanOneTokenSecurity(entry));
  const resolved = tokens.filter((entry) => entry.resolved);
  if (!resolved.length) {
    throw AppError.notFound(
      "None of the supplied tokens resolved to a Base ERC20 contract.",
      { tokens: params.tokens },
      "TOKENS_NOT_RESOLVED"
    );
  }
  const severityCount = (level) =>
    tokens.reduce(
      (sum, entry) => sum + (entry.resolved ? entry.flags.filter((flag) => flag.severity === level).length : 0),
      0
    );
  return {
    status: "scanned",
    count: tokens.length,
    resolved: resolved.length,
    tokens,
    summary: {
      critical: severityCount("critical"),
      high: severityCount("high"),
      medium: severityCount("medium"),
      low: severityCount("low"),
      highRisk: tokens.filter((entry) => entry.riskLevel === "high").length,
    },
    thresholds: { minLiquidityUsd: config.revenue.securityMinLiquidityUsd },
    sources: ["base-rpc", "honeypot.is", "geckoterminal", "dexscreener"],
    scannedAt: nowIso(),
    disclaimer: "Live contract, tax, holder and liquidity reads. Not a guarantee; verify before trading.",
  };
}

/* ----------------------------- Wallet risk ------------------------------- */

export async function walletRiskAudit({ params }) {
  const address = getAddress(params.address);
  const credit = await scanAgentCredit(address, { scanJobs: 120 });
  const [bytecode, eth, usdc, nonce, ethUsd] = await Promise.all([
    publicClient.getBytecode({ address }).catch(() => null),
    getNativeBalance(address).catch(() => null),
    getTokenBalance(USDC.address, address).catch(() => null),
    publicClient.getTransactionCount({ address }).catch(() => null),
    ethUsdPrice(),
  ]);
  const watchTokens = params.watchTokens.length ? params.watchTokens : ["WETH", "VIRTUAL"];
  const balances = await Promise.all(
    watchTokens.map(async (input) => {
      try {
        const token = await resolveToken(input, { allowNative: false });
        const balance = await getTokenBalance(token.address, address);
        return { symbol: token.symbol, address: token.address, balance: fromUnits(balance, token.decimals) };
      } catch (error) {
        return { input, error: error.message };
      }
    })
  );

  const ethBalance = eth === null ? null : Number(fromUnits(eth, 18));
  const usdcBalance = usdc === null ? null : Number(fromUnits(usdc, USDC.decimals));
  const usdValue =
    usdcBalance === null
      ? null
      : round(usdcBalance + (ethBalance !== null && ethUsd ? ethBalance * ethUsd : 0), 4);

  const flags = [];
  if (bytecode && bytecode !== "0x") flags.push({ code: "contract_wallet", severity: "info" });
  if ((nonce ?? 0) === 0 && credit.stats.jobs === 0) flags.push({ code: "no_activity", severity: "high" });
  if (usdcBalance !== null && usdcBalance + (ethBalance ?? 0) === 0) flags.push({ code: "zero_balance", severity: "medium" });
  if (credit.stats.rejected > 0) flags.push({ code: "rejected_jobs", severity: "medium", detail: credit.stats.rejected });
  if (credit.stats.expired > 0) flags.push({ code: "expired_jobs", severity: "low", detail: credit.stats.expired });
  if (credit.stats.jobs > 0 && credit.completionRate < 50) {
    flags.push({ code: "low_completion_rate", severity: "high", detail: credit.completionRate });
  }

  const penalties = flags.reduce(
    (sum, flag) => sum + (flag.severity === "high" ? 25 : flag.severity === "medium" ? 10 : flag.severity === "low" ? 5 : 0),
    0
  );
  const riskScore = Math.max(0, Math.min(100, Math.round(100 - credit.score + penalties)));
  return {
    status: "audited",
    address,
    type: bytecode && bytecode !== "0x" ? "contract" : "eoa",
    nonce: nonce === null ? null : Number(nonce),
    balances: {
      eth: ethBalance === null ? null : round(ethBalance, 6),
      usdc: usdcBalance === null ? null : round(usdcBalance, 6),
      estimatedUsd: usdValue,
      tokens: balances,
    },
    acp: {
      jobs: credit.stats.jobs,
      providerJobs: credit.stats.providerJobs,
      clientJobs: credit.stats.clientJobs,
      completed: credit.stats.completed,
      rejected: credit.stats.rejected,
      expired: credit.stats.expired,
      volumeUsdc: credit.stats.volumeUsdc,
      completionRate: credit.completionRate,
      lastActivityAt: credit.stats.lastActivityAt,
      window: credit.window,
    },
    credit: { score: credit.score, label: credit.label, flags: credit.flags },
    risk: {
      riskScore,
      riskLevel: riskScore >= 60 ? "high" : riskScore >= 30 ? "medium" : "low",
      flags,
    },
    ethUsd: ethUsd === null ? null : round(ethUsd, 2),
    source: "base-rpc+acp-getJob",
    auditedAt: nowIso(),
    disclaimer: "On-chain facts only. Wallet labels and off-chain reputation are not inferred.",
  };
}

/* --------------------------- Liquidation guard --------------------------- */

export function evaluateLiquidationPositions(positions, { thresholdPct = 8 } = {}) {
  return positions.map((position) => {
    const change = Number(position.change24hPct);
    const liquidity = Number(position.liquidityUsd);
    const drawdownPct = Number.isFinite(change) ? round(Math.max(0, -change), 2) : null;
    const alert = drawdownPct !== null && drawdownPct >= thresholdPct;
    const thin = Number.isFinite(liquidity) && liquidity < config.revenue.securityMinLiquidityUsd;
    return {
      ...position,
      drawdownPct,
      distanceToThresholdPct: drawdownPct === null ? null : round(Math.max(0, thresholdPct - drawdownPct), 2),
      alert,
      reasons: [...(alert ? ["drawdown_threshold"] : []), ...(thin ? ["thin_liquidity"] : [])],
    };
  });
}

export async function liquidationSnapshot({ params }) {
  const positions = await Promise.all(
    params.positions.map(async (input) => {
      try {
        const token = await resolveToken(input, { allowNative: false });
        const pools = await getTokenPools(token.address);
        const pool = pools[0] || null;
        return {
          input,
          token: { symbol: token.symbol, address: token.address, decimals: token.decimals },
          pool: pool ? { dex: pool.dex, address: pool.address } : null,
          priceUsd: pool?.priceUsd ?? null,
          change1hPct: pool?.change1hPct ?? null,
          change24hPct: pool?.change24hPct ?? null,
          liquidityUsd: pool?.liquidityUsd ?? null,
        };
      } catch (error) {
        return { input, error: error.message, code: error.code || "POSITION_NOT_RESOLVED" };
      }
    })
  );
  const monitored = positions.filter((position) => !position.error);
  const evaluated = evaluateLiquidationPositions(monitored, { thresholdPct: params.thresholdPct });
  const alerts = evaluated.filter((position) => position.alert);
  return {
    status: "monitoring",
    kind: "liquidation_guard",
    plan: params.plan,
    thresholdPct: params.thresholdPct,
    positions: evaluated,
    unresolved: positions.filter((position) => position.error),
    alerts,
    alertCount: alerts.length,
    scannedAt: nowIso(),
    source: "geckoterminal",
    note: alerts.length
      ? "One or more positions crossed the configured drawdown threshold. Prices are live pool reads."
      : "No monitored position crossed the configured drawdown threshold in the current 24h window.",
  };
}

/* ------------------------------- New pools ------------------------------- */

export function filterNewPools(pools, { minLiquidityUsd = config.revenue.newPoolMinLiquidityUsd, maxAgeHours = config.revenue.newPoolLookbackHours, now = Date.now(), limit = 8 } = {}) {
  const cutoff = now - maxAgeHours * 3_600_000;
  return (Array.isArray(pools) ? pools : [])
    .filter((pool) => {
      const createdAt = pool?.createdAt ? Date.parse(pool.createdAt) : null;
      return (
        pool?.address &&
        Number.isFinite(createdAt) &&
        createdAt >= cutoff &&
        Number(pool.liquidityUsd) >= minLiquidityUsd
      );
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, Math.max(1, Number(limit) || 1))
    .map((pool) => ({
      address: pool.address,
      name: pool.name,
      dex: pool.dex,
      baseAddress: pool.baseAddress,
      baseSymbol: pool.baseSymbol,
      priceUsd: pool.priceUsd,
      liquidityUsd: pool.liquidityUsd,
      volume24hUsd: pool.volume24hUsd,
      change1hPct: pool.change1hPct,
      createdAt: pool.createdAt,
      ageHours: round((now - Date.parse(pool.createdAt)) / 3_600_000, 2),
    }));
}

export async function scanNewPools(params) {
  const pools = await getNewBasePools({ limit: 40 });
  const filtered = filterNewPools(pools, {
    minLiquidityUsd: params.minLiquidityUsd,
    maxAgeHours: params.maxAgeHours,
    limit: params.limit,
  });
  return {
    status: "scanned",
    pools: filtered,
    count: filtered.length,
    observed: pools.length,
    filters: { minLiquidityUsd: params.minLiquidityUsd, maxAgeHours: params.maxAgeHours },
    scannedAt: nowIso(),
    source: "geckoterminal-new-pools",
    note: filtered.length
      ? "Live GeckoTerminal new-pool feed filtered by liquidity and age."
      : "No newly created Base pool matched the liquidity and age filters in the current feed.",
  };
}

/* ---------------------------- Smart money flow --------------------------- */

export function classifyTransfer({ fromAddress, toAddress, poolAddresses = [], selfAddress = null }) {
  const from = String(fromAddress || "").toLowerCase();
  const to = String(toAddress || "").toLowerCase();
  const pools = new Set([...poolAddresses].map((entry) => String(entry).toLowerCase()));
  if (pools.has(to)) return "sell_into_pool";
  if (pools.has(from)) return "buy_from_pool";
  if (selfAddress && from === String(selfAddress).toLowerCase()) return "agent_outflow";
  if (selfAddress && to === String(selfAddress).toLowerCase()) return "agent_inflow";
  return "wallet_to_wallet";
}

export async function scanSmartMoney(params) {
  const watchlist = params.watchlist.length ? params.watchlist : ["USDC", "WETH", "VIRTUAL"];
  const ethUsd = await ethUsdPrice();
  const tokens = [];
  for (const input of watchlist) {
    try {
      const token = await resolveToken(input, { allowNative: false });
      const pools = await getTokenPools(token.address).catch(() => []);
      let priceUsd = pools[0]?.priceUsd ?? null;
      if (token.address.toLowerCase() === USDC.address.toLowerCase()) priceUsd = 1;
      else if (token.address.toLowerCase() === WETH.toLowerCase()) priceUsd = ethUsd;
      tokens.push({
        address: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        priceUsd,
        poolAddresses: pools.map((pool) => pool.address).filter(Boolean),
      });
    } catch (error) {
      logger.warn("smart-money watch token skipped", { input, message: error.message });
    }
  }
  if (!tokens.length) {
    throw AppError.badRequest("None of the watchlist tokens resolved on Base.", { watchlist }, "TOKENS_NOT_RESOLVED");
  }

  const latest = await publicClient.getBlockNumber();
  const fromBlock = latest - BigInt(Math.max(1, params.lookbackBlocks)) + 1n;
  let scan;
  try {
    scan = await transferLogsViaGetLogs(tokens, fromBlock, latest);
  } catch (error) {
    logger.warn("smart-money eth_getLogs failed; scanning block receipts", { message: shortRpcError(error) });
    scan = await transferLogsViaReceipts(tokens, fromBlock, latest, 10);
  }

  let selfAddress = null;
  try {
    selfAddress = getAgentAddress();
  } catch {
    selfAddress = null;
  }

  const alerts = [];
  const aggregates = new Map();
  for (const token of tokens) {
    const poolAddresses = token.poolAddresses;
    for (const log of scan.collected.get(token.address.toLowerCase()) || []) {
      const value = BigInt(log.args?.value || 0);
      const amount = Number(value) / 10 ** token.decimals;
      const usd = token.priceUsd ? amount * token.priceUsd : null;
      if (usd === null || usd < params.minUsd) continue;
      const classification = classifyTransfer({
        fromAddress: log.args?.from,
        toAddress: log.args?.to,
        poolAddresses,
        selfAddress,
      });
      const aggregate = aggregates.get(token.symbol) || { symbol: token.symbol, buyUsd: 0, sellUsd: 0, walletUsd: 0 };
      if (classification === "buy_from_pool") aggregate.buyUsd += usd;
      else if (classification === "sell_into_pool") aggregate.sellUsd += usd;
      else aggregate.walletUsd += usd;
      aggregates.set(token.symbol, aggregate);
      alerts.push({
        type: "smart_money",
        token: token.symbol,
        tokenAddress: token.address,
        amount: round(amount, token.decimals > 6 ? 6 : 2),
        usd: round(usd, 2),
        from: log.args?.from || null,
        to: log.args?.to || null,
        classification,
        txHash: log.transactionHash,
        blockNumber: String(log.blockNumber),
        observedAt: nowIso(),
      });
    }
  }
  const limited = alerts.sort((a, b) => b.usd - a.usd).slice(0, Math.max(1, Number(params.limit) || 6));
  return {
    status: "live",
    alerts: limited,
    count: limited.length,
    aggregates: [...aggregates.values()].map((entry) => ({
      ...entry,
      buyUsd: round(entry.buyUsd, 2),
      sellUsd: round(entry.sellUsd, 2),
      walletUsd: round(entry.walletUsd, 2),
      netPoolFlowUsd: round(entry.buyUsd - entry.sellUsd, 2),
    })),
    method: scan.method,
    thresholds: { minUsd: params.minUsd, lookbackBlocks: params.lookbackBlocks },
    watchlist: tokens.map((token) => token.symbol),
    scannedAt: nowIso(),
    source: "base-rpc-transfer-logs",
    note: limited.length
      ? "Observed live Base transfers above the USD threshold, classified against the token's known DEX pools."
      : "No transfer above the configured USD threshold was observed in the scanned block window.",
  };
}

/* -------------------------- Agent revenue audit -------------------------- */

export async function scanAgentRevenue(address, { scanJobs = 200 } = {}) {
  if (!isAddress(String(address || ""))) {
    throw AppError.badRequest("address must be a valid EVM address.", { address }, "INVALID_ADDRESS");
  }
  const target = getAddress(address);
  const counter = await getJobCounter();
  const head = BigInt(counter);
  const span = BigInt(Math.max(10, scanJobs));
  const from = head - span + 1n > 0n ? head - span + 1n : 1n;
  const ids = [];
  for (let id = from; id <= head; id += 1n) ids.push(id.toString());
  const jobs = (await getAcpJobs(ids)).filter(Boolean);

  const now = Date.now();
  const stats = { providerJobs: 0, clientJobs: 0, completed: 0, rejected: 0, expired: 0, open: 0, funded: 0, volumeUsdc: 0, recent30dUsdc: 0 };
  const clients = new Map();
  let firstActivityAt = null;
  let lastActivityAt = null;
  let maxJobUsdc = 0;

  for (const job of jobs) {
    const isProvider = job.provider.toLowerCase() === target.toLowerCase();
    const isClient = job.client.toLowerCase() === target.toLowerCase();
    if (!isProvider && !isClient) continue;
    if (isProvider) stats.providerJobs += 1;
    if (isClient) stats.clientJobs += 1;
    if (isProvider) {
      if (job.status === 3) stats.completed += 1;
      if (job.status === 4) stats.rejected += 1;
      if (job.status === 5) stats.expired += 1;
      if (job.status === 0) stats.open += 1;
      if (job.status === 1) stats.funded += 1;
      const budgetUsdc = Number(fromUnits(job.budget, USDC.decimals));
      if (job.status === 3) {
        stats.volumeUsdc += budgetUsdc;
        maxJobUsdc = Math.max(maxJobUsdc, budgetUsdc);
        const key = job.client.toLowerCase();
        const client = clients.get(key) || { client: job.client, jobs: 0, volumeUsdc: 0 };
        client.jobs += 1;
        client.volumeUsdc += budgetUsdc;
        clients.set(key, client);
        if (Number(job.expiredAt) > 0) {
          const at = Date.parse(new Date(Number(job.expiredAt) * 1000).toISOString());
          if (now - at <= 30 * 86_400_000) stats.recent30dUsdc += budgetUsdc;
        }
      }
    }
    if (Number(job.expiredAt) > 0) {
      const at = new Date(Number(job.expiredAt) * 1000).toISOString();
      if (!lastActivityAt || Date.parse(at) > Date.parse(lastActivityAt)) lastActivityAt = at;
      if (!firstActivityAt || Date.parse(at) < Date.parse(firstActivityAt)) firstActivityAt = at;
    }
  }

  for (const key of Object.keys(stats)) {
    if (typeof stats[key] === "number" && key !== "providerJobs" && key !== "clientJobs") {
      stats[key] = round(stats[key], 6);
    }
  }
  const settled = stats.completed + stats.rejected + stats.expired;
  const completionRate = settled > 0 ? round((stats.completed / settled) * 100, 2) : 0;
  const credit = creditScoreFromStats({
    jobs: stats.providerJobs,
    providerJobs: stats.providerJobs,
    clientJobs: stats.clientJobs,
    completed: stats.completed,
    rejected: stats.rejected,
    expired: stats.expired,
    volumeUsdc: stats.volumeUsdc,
    lastActivityAt,
  });
  return {
    address: target,
    stats: {
      ...stats,
      uniqueClients: clients.size,
      averageJobUsdc: stats.completed > 0 ? round(stats.volumeUsdc / stats.completed, 6) : 0,
      maxJobUsdc: round(maxJobUsdc, 6),
      completionRatePct: completionRate,
      monthlyRunRateUsd: stats.recent30dUsdc,
    },
    topClients: [...clients.values()]
      .sort((a, b) => b.volumeUsdc - a.volumeUsdc)
      .slice(0, 5)
      .map((client) => ({ ...client, volumeUsdc: round(client.volumeUsdc, 6) })),
    credit,
    window: { from: String(from), to: String(head), scanned: jobs.length },
    firstActivityAt,
    lastActivityAt,
  };
}

export async function agentRevenueAudit({ params }) {
  const audit = await scanAgentRevenue(params.address, { scanJobs: 200 });
  const [eth, usdc, nonce] = await Promise.all([
    getNativeBalance(audit.address).catch(() => null),
    getTokenBalance(USDC.address, audit.address).catch(() => null),
    publicClient.getTransactionCount({ address: audit.address }).catch(() => null),
  ]);
  return {
    status: "audited",
    ...audit,
    balances: {
      eth: eth === null ? null : round(Number(fromUnits(eth, 18)), 6),
      usdc: usdc === null ? null : round(Number(fromUnits(usdc, USDC.decimals)), 6),
      nonce: nonce === null ? null : Number(nonce),
    },
    source: "base-rpc+acp-getJob",
    auditedAt: nowIso(),
    disclaimer: "Revenue is computed from on-chain ACP job budgets for completed jobs. ExpiredAt is used as the activity timestamp.",
  };
}

/* -------------------------- Provider benchmark --------------------------- */

export function rankProviders(jobs, { limit = 8, minCompleted = 1 } = {}) {
  const map = new Map();
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || !job.provider) continue;
    const key = job.provider.toLowerCase();
    const entry =
      map.get(key) ||
      {
        provider: job.provider,
        jobs: 0,
        completed: 0,
        rejected: 0,
        expired: 0,
        open: 0,
        funded: 0,
        settledVolumeUsdc: 0,
        grossVolumeUsdc: 0,
        clients: new Set(),
        lastActivityAt: null,
      };
    const budgetUsdc = Number(fromUnits(job.budget, USDC.decimals));
    entry.jobs += 1;
    entry.grossVolumeUsdc += budgetUsdc;
    if (job.status === 3) {
      entry.completed += 1;
      entry.settledVolumeUsdc += budgetUsdc;
      entry.clients.add(job.client.toLowerCase());
    }
    if (job.status === 4) entry.rejected += 1;
    if (job.status === 5) entry.expired += 1;
    if (job.status === 0) entry.open += 1;
    if (job.status === 1) entry.funded += 1;
    if (Number(job.expiredAt) > 0) {
      const at = new Date(Number(job.expiredAt) * 1000).toISOString();
      if (!entry.lastActivityAt || Date.parse(at) > Date.parse(entry.lastActivityAt)) entry.lastActivityAt = at;
    }
    map.set(key, entry);
  }
  return [...map.values()]
    .filter((entry) => entry.completed >= Math.max(0, Number(minCompleted) || 0))
    .sort((a, b) => b.settledVolumeUsdc - a.settledVolumeUsdc || b.completed - a.completed)
    .slice(0, Math.max(1, Number(limit) || 1))
    .map((entry, index) => {
      const settled = entry.completed + entry.rejected + entry.expired;
      return {
        rank: index + 1,
        provider: entry.provider,
        jobs: entry.jobs,
        completed: entry.completed,
        rejected: entry.rejected,
        expired: entry.expired,
        open: entry.open,
        funded: entry.funded,
        completionRatePct: settled > 0 ? round((entry.completed / settled) * 100, 2) : null,
        settledVolumeUsdc: round(entry.settledVolumeUsdc, 6),
        grossVolumeUsdc: round(entry.grossVolumeUsdc, 6),
        uniqueClients: entry.clients.size,
        lastActivityAt: entry.lastActivityAt,
      };
    });
}

export async function providerBenchmark({ params }) {
  const counter = await getJobCounter();
  const head = BigInt(counter);
  const span = BigInt(config.revenue.benchmarkScanJobs);
  const from = head - span + 1n > 0n ? head - span + 1n : 1n;
  const ids = [];
  for (let id = from; id <= head; id += 1n) ids.push(id.toString());
  const jobs = (await getAcpJobs(ids)).filter(Boolean);
  const providers = rankProviders(jobs, { limit: params.limit, minCompleted: params.minCompleted });
  let selfAddress = null;
  try {
    selfAddress = getAgentAddress();
  } catch {
    selfAddress = null;
  }
  const selfRank = selfAddress
    ? providers.find((entry) => entry.provider.toLowerCase() === selfAddress.toLowerCase()) || null
    : null;
  return {
    status: "ranked",
    providers,
    count: providers.length,
    self: selfRank,
    selfAddress,
    sample: { from: String(from), to: String(head), scanned: jobs.length },
    method: "Grouped by ACP provider from live getJob() multicalls. Ranked by completed-job settled volume.",
    scannedAt: nowIso(),
    source: "base-rpc-acp",
  };
}

/* --------------------------- Virtuals alpha ------------------------------ */

export async function virtualsAlpha({ params }) {
  const token = await resolveToken(params.token, { allowNative: false });
  const includeEcosystem = params.includeEcosystem !== false;
  const [coin, pools, trending, news, counter] = await Promise.all([
    getCoinByContract(token.address).catch(() => null),
    getTokenPools(token.address).catch(() => []),
    includeEcosystem ? getTrendingCoins().catch(() => []) : [],
    getLatestNews({ limit: 8, query: "Virtuals", hours: 48 }).catch(() => []),
    includeEcosystem ? getJobCounter().catch(() => null) : null,
  ]);

  let ecosystem = null;
  if (includeEcosystem && counter !== null) {
    const head = BigInt(counter);
    const span = 50n;
    const from = head - span + 1n > 0n ? head - span + 1n : 1n;
    const ids = [];
    for (let id = from; id <= head; id += 1n) ids.push(id.toString());
    const jobs = (await getAcpJobs(ids).catch(() => [])).filter(Boolean);
    const providers = new Set();
    const clients = new Set();
    let volumeUsdc = 0;
    const statuses = { open: 0, funded: 0, submitted: 0, completed: 0, rejected: 0, expired: 0 };
    const names = ["open", "funded", "submitted", "completed", "rejected", "expired"];
    for (const job of jobs) {
      providers.add(job.provider.toLowerCase());
      clients.add(job.client.toLowerCase());
      const label = names[job.status];
      if (label) statuses[label] += 1;
      if (job.status === 3) volumeUsdc += Number(fromUnits(job.budget, USDC.decimals));
    }
    ecosystem = {
      jobCounter: String(counter),
      sampledJobs: jobs.length,
      uniqueProviders: providers.size,
      uniqueClients: clients.size,
      settledVolumeUsdc: round(volumeUsdc, 6),
      statuses,
      window: { from: String(from), to: String(head) },
    };
  }

  const topPool = pools[0] || null;
  const facts = {
    token: { symbol: token.symbol, address: token.address, decimals: token.decimals },
    market: coin
      ? {
          priceUsd: coin.market.priceUsd,
          marketCapUsd: coin.market.marketCapUsd,
          fdvUsd: coin.market.fdvUsd,
          volume24hUsd: coin.market.volume24hUsd,
          change1hPct: coin.market.change1hPct,
          change24hPct: coin.market.change24hPct,
          change7dPct: coin.market.change7dPct,
          athUsd: coin.market.athUsd,
          athChangePct: coin.market.athChangePct,
          categories: coin.categories,
          community: coin.community,
        }
      : null,
    topPool: topPool
      ? { dex: topPool.dex, priceUsd: topPool.priceUsd, liquidityUsd: topPool.liquidityUsd, volume24hUsd: topPool.volume24hUsd }
      : null,
    ecosystem,
    trending: trending.slice(0, 5).map((entry) => ({ symbol: entry.symbol, change24hPct: entry.change24hPct })),
    news: news.slice(0, 6).map((item) => ({ title: item.title, source: item.source, url: item.link || item.url })),
  };

  let ai = null;
  if (aiConfigured()) {
    const synthesis = await askJSON(
      [
        "You are a Virtuals Protocol ecosystem analyst.",
        "Return JSON: {\"summary\": string, \"catalysts\": string[], \"risks\": string[], \"confidence\": \"low|medium|high\"}.",
        "Use only the supplied facts. Never invent prices, dates, addresses or events.",
        "Keep the summary under 120 words.",
      ].join(" "),
      JSON.stringify({ ...facts, timeframe: params.timeframe }),
      { prefer: "gemini", maxTokens: 800, temperature: 0.1 }
    ).catch(() => null);
    if (synthesis?.data) ai = { engine: synthesis.engine, ...synthesis.data };
  }

  return {
    status: "delivered",
    reportType: "virtuals_alpha",
    timeframe: params.timeframe,
    token: facts.token,
    market: facts.market,
    liquidity: {
      topPool: facts.topPool,
      pools: pools.slice(0, 5).map((pool) => ({
        dex: pool.dex,
        address: pool.address,
        priceUsd: pool.priceUsd,
        liquidityUsd: pool.liquidityUsd,
        volume24hUsd: pool.volume24hUsd,
        change24hPct: pool.change24hPct,
      })),
    },
    ecosystem,
    trending: facts.trending,
    news: facts.news,
    ai,
    fetchedAt: nowIso(),
    sources: ["coingecko", "geckoterminal", "rss", "base-acp"],
    disclaimer: "Live data plus optional model synthesis. Not financial advice.",
  };
}

/* ------------------------------- Job radar ------------------------------- */

const JOB_STATUS_LABELS = ["open", "funded", "submitted", "completed", "rejected", "expired"];

export function matchJobLeads(jobs, { minBudgetUsdc = 0.5, keywords = [], statuses = ["open", "funded"], excludeAddress = null, limit = 8, now = Date.now() } = {}) {
  const allowedStatuses = new Set(statuses);
  const needles = keywords.map((entry) => String(entry).toLowerCase()).filter(Boolean);
  const excluded = excludeAddress ? String(excludeAddress).toLowerCase() : null;
  return (Array.isArray(jobs) ? jobs : [])
    .filter(Boolean)
    .map((job) => {
      const status = JOB_STATUS_LABELS[job.status] || "unknown";
      const budgetUsdc = Number(fromUnits(job.budget, USDC.decimals));
      const description = String(job.description || "");
      const lower = description.toLowerCase();
      const matchedKeywords = needles.filter((needle) => lower.includes(needle));
      const expiresInSeconds = Number(job.expiredAt) > 0 ? Number(job.expiredAt) - Math.floor(now / 1000) : null;
      return {
        jobId: String(job.id),
        status,
        client: job.client,
        provider: job.provider,
        evaluator: job.evaluator,
        budgetUsdc: round(budgetUsdc, 6),
        expiresInSeconds,
        expiredAt: Number(job.expiredAt) > 0 ? new Date(Number(job.expiredAt) * 1000).toISOString() : null,
        description: description.slice(0, 400),
        matchedKeywords,
      };
    })
    .filter((lead) => {
      if (!allowedStatuses.has(lead.status)) return false;
      if (lead.budgetUsdc < minBudgetUsdc) return false;
      if (excluded && (lead.provider.toLowerCase() === excluded || lead.client.toLowerCase() === excluded)) return false;
      if (needles.length && lead.matchedKeywords.length === 0) return false;
      if (lead.expiresInSeconds !== null && lead.expiresInSeconds <= 0) return false;
      return true;
    })
    .sort((a, b) => b.budgetUsdc - a.budgetUsdc || (a.expiresInSeconds ?? Infinity) - (b.expiresInSeconds ?? Infinity))
    .slice(0, Math.max(1, Number(limit) || 1))
    .map((lead) => ({ ...lead, matchedKeywords: [...new Set(lead.matchedKeywords)] }));
}

export async function scanJobLeads(params) {
  const counter = await getJobCounter();
  const head = BigInt(counter);
  const span = BigInt(config.revenue.jobRadarScanJobs);
  const from = head - span + 1n > 0n ? head - span + 1n : 1n;
  const ids = [];
  for (let id = from; id <= head; id += 1n) ids.push(id.toString());
  const jobs = (await getAcpJobs(ids)).filter(Boolean);
  let selfAddress = null;
  try {
    selfAddress = getAgentAddress();
  } catch {
    selfAddress = null;
  }
  const leads = matchJobLeads(jobs, {
    minBudgetUsdc: params.minBudgetUsdc,
    keywords: params.keywords,
    statuses: params.statuses,
    excludeAddress: selfAddress,
    limit: params.limit,
  });
  return {
    status: "scanned",
    leads,
    count: leads.length,
    sample: { from: String(from), to: String(head), scanned: jobs.length },
    filters: { minBudgetUsdc: params.minBudgetUsdc, keywords: params.keywords, statuses: params.statuses },
    scannedAt: nowIso(),
    source: "base-acp-getJob",
    note: leads.length
      ? "Open or funded ACP jobs above the budget floor that are not assigned to this agent."
      : "No matching open or funded job was observed in the scanned window.",
  };
}

/* --------------------------- Deep analytics ------------------------------ */

export async function deepAnalytics({ params, priceUsdc, bonusUsdc = 0 }) {
  if (!aiConfigured()) {
    throw AppError.unavailable(
      "Deep analytics requires GROQ_API_KEY or GEMINI_API_KEY.",
      { missing: "GROQ_API_KEY|GEMINI_API_KEY" },
      "AI_NOT_CONFIGURED"
    );
  }
  const token = await resolveToken(params.target).catch(() => null);
  if (!token) {
    throw AppError.notFound(`Unable to resolve target "${params.target}" on Base.`, "TARGET_NOT_RESOLVED");
  }
  const [candles, pools, derivatives, security, news] = await Promise.all([
    getCandles({ token, timeframe: params.timeframe, limit: 240 }).catch(() => null),
    getTokenPools(token.address).catch(() => []),
    getBinanceDerivatives(token.symbol).catch(() => null),
    checkHoneypot(token.address).catch(() => null),
    getLatestNews({ limit: 8, query: token.symbol, hours: 48 }).catch(() => []),
  ]);
  const indicators = candles?.candles?.length ? computeIndicators(candles.candles, { candlesPerDay: 6 }) : null;
  const plan =
    indicators && candles?.candles?.length
      ? buildTradePlan({
          token,
          candles: candles.candles,
          indicators,
          timeframe: params.timeframe,
          side: "auto",
          capitalUsdc: params.capitalUsdc || null,
          riskPercent: 1,
        })
      : null;
  const topPool = Array.isArray(pools) ? pools[0] : null;
  const facts = {
    token: { symbol: token.symbol, address: token.address, decimals: token.decimals },
    depth: params.depth,
    priceUsd: topPool?.priceUsd ?? null,
    liquidityUsd: topPool?.liquidityUsd ?? null,
    change24hPct: topPool?.change24hPct ?? null,
    indicators: indicators
      ? {
          price: indicators.price,
          ema21: indicators.ema21,
          ema55: indicators.ema55,
          rsi14: indicators.rsi14,
          atr14: indicators.atr14,
          trend: indicators.trend,
          momentum: indicators.momentum,
        }
      : null,
    derivatives: derivatives
      ? {
          fundingRatePct: derivatives.fundingRatePct,
          openInterestUsd: derivatives.openInterestUsd,
          openInterestChangePct: derivatives.openInterestChangePct,
          longShortRatio: derivatives.longShortRatio,
        }
      : null,
    security: security
      ? { honeypot: security.isHoneypot, buyTaxPct: security.buyTax, sellTaxPct: security.sellTax }
      : null,
    news: (Array.isArray(news) ? news : []).slice(0, 6).map((item) => ({ title: item.title, source: item.source, url: item.link || item.url })),
    plan: plan
      ? { bias: plan.bias, entry: plan.entry, stopLoss: plan.stopLoss, takeProfit: plan.takeProfit, riskNote: plan.riskNote }
      : null,
    pricing: {
      upfrontUsdc: Number(priceUsdc || 0),
      performanceBonusUsdc: Number(bonusUsdc || 0),
      bonusPolicy: bonusUsdc
        ? "Performance bonus is invoiced as a separate ACP job after delivery if the client elects to pay it. It cannot be debited from this escrow."
        : null,
    },
  };
  const ai = await askJSON(
    [
      "You are a senior on-chain risk and market analyst.",
      "Return JSON: {\"summary\": string, \"risks\": string[], \"opportunities\": string[], \"confidence\": \"low|medium|high\"}.",
      "Use only the supplied facts. Never invent prices, addresses, dates or events. Do not add numbers that are absent from the facts.",
      "Keep the summary under 140 words.",
    ].join(" "),
    JSON.stringify(facts),
    { prefer: "gemini", maxTokens: 900, temperature: 0.1 }
  );
  if (!ai?.data) {
    throw AppError.upstream("AI synthesis failed for deep analytics.", undefined, "AI_UNAVAILABLE");
  }
  return {
    status: "delivered",
    reportType: "deep_analytics",
    depth: params.depth,
    token: facts.token,
    snapshot: {
      priceUsd: facts.priceUsd,
      liquidityUsd: facts.liquidityUsd,
      change24hPct: facts.change24hPct,
      indicators: facts.indicators,
      derivatives: facts.derivatives,
      security: facts.security,
      topPools: (Array.isArray(pools) ? pools : []).slice(0, 5).map((pool) => ({
        dex: pool.dex,
        address: pool.address,
        priceUsd: pool.priceUsd,
        liquidityUsd: pool.liquidityUsd,
      })),
    },
    plan: facts.plan,
    narrative: ai.data,
    news: facts.news,
    engine: ai.engine,
    pricing: facts.pricing,
    fetchedAt: nowIso(),
    disclaimer: "Live data plus model synthesis. Not financial advice; verify security and liquidity before trading.",
  };
}

/* ---------------------------- Pool anomalies ----------------------------- */

export function anomalyFromSnapshots(previous, current, thresholds = {}) {
  if (!previous || !current) return null;
  const liquidityDropPct = thresholds.liquidityDropPct ?? config.revenue.anomalyLiquidityDropPct;
  const priceDropPct = thresholds.priceDropPct ?? config.revenue.anomalyPriceDropPct;
  const prevLiquidity = Number(previous.liquidityUsd);
  const nextLiquidity = Number(current.liquidityUsd);
  const prevPrice = Number(previous.priceUsd);
  const nextPrice = Number(current.priceUsd);
  if (!Number.isFinite(prevLiquidity) || !Number.isFinite(nextLiquidity) || prevLiquidity <= 0) return null;
  const liquidityChangePct = ((nextLiquidity - prevLiquidity) / prevLiquidity) * 100;
  const priceChangePct = prevPrice > 0 ? ((nextPrice - prevPrice) / prevPrice) * 100 : 0;
  const reasons = [];
  if (liquidityChangePct <= -liquidityDropPct) reasons.push("liquidity_drop");
  if (priceChangePct <= -priceDropPct) reasons.push("price_drop");
  if (!reasons.length) return null;
  return {
    pool: current.address,
    name: current.name,
    dex: current.dex,
    baseAddress: current.baseAddress,
    liquidityUsd: nextLiquidity,
    liquidityChangePct: round(liquidityChangePct, 2),
    priceUsd: nextPrice,
    priceChangePct: round(priceChangePct, 2),
    previousAt: previous.at,
    observedAt: current.at,
    reasons,
  };
}

export async function detectAnomalies({ limit = config.revenue.scanPools } = {}) {
  const pools = await getBasePools({ limit });
  const anomalies = [];
  let seeded = 0;
  for (const pool of pools) {
    const key = storeHelpers.revenuePoolSnapshot(pool.address);
    const previous = await store.get(key).catch(() => null);
    const current = {
      address: pool.address,
      name: pool.name,
      dex: pool.dex,
      baseAddress: pool.baseAddress,
      liquidityUsd: pool.liquidityUsd,
      priceUsd: pool.priceUsd,
      at: nowIso(),
    };
    const anomaly = anomalyFromSnapshots(previous, current);
    if (anomaly) anomalies.push(anomaly);
    if (!previous) seeded += 1;
    await store
      .set(key, current, { ttlSeconds: SNAPSHOT_TTL_SECONDS })
      .catch((error) => logger.warn("pool snapshot save failed", { message: error.message }));
  }
  return { scanned: pools.length, seeded, anomalies };
}

/* ----------------------------- Retainers --------------------------------- */

function subscriptionKey(jobId) {
  return storeHelpers.revenueSubscription(String(jobId));
}

function publicSubscription(record) {
  return {
    subscriptionId: record.id,
    jobId: record.jobId,
    buyer: record.buyer,
    kind: record.kind || "intel",
    plan: record.plan,
    endpoint: record.endpoint,
    topics: record.topics,
    alerts: record.alerts,
    monitor: record.monitor || null,
    priceUsdc: record.priceUsdc,
    status: record.status,
    startedAt: record.startedAt,
    expiresAt: record.expiresAt,
    lastDeliveredAt: record.lastDeliveredAt,
    deliveries: record.deliveries,
    deliveredKeys: (record.deliveredKeys || []).length,
    lastError: record.lastError,
  };
}

const RETAINER_DEFAULT_PRICE = {
  intel: { weekly: 50, monthly: 100 },
  liquidation_guard: { weekly: 25, monthly: 80 },
  new_pool_radar: { weekly: 25, monthly: 25 },
  smart_money_flow: { weekly: 30, monthly: 30 },
  job_radar: { weekly: 30, monthly: 30 },
};

function retainerMonitor(kind, params) {
  if (kind === "liquidation_guard") {
    return { positions: params.positions, thresholdPct: params.thresholdPct };
  }
  if (kind === "new_pool_radar") {
    return {
      minLiquidityUsd: params.minLiquidityUsd,
      maxAgeHours: params.maxAgeHours,
      limit: params.limit,
    };
  }
  if (kind === "smart_money_flow") {
    return {
      watchlist: params.watchlist,
      minUsd: params.minUsd,
      lookbackBlocks: params.lookbackBlocks,
      limit: params.limit,
    };
  }
  if (kind === "job_radar") {
    return {
      minBudgetUsdc: params.minBudgetUsdc,
      keywords: params.keywords,
      statuses: params.statuses,
      limit: params.limit,
    };
  }
  return null;
}

export async function activateRetainer({ params, buyer, jobId, priceUsdc, kind = "intel" }) {
  if (!isPublicHttpUrl(params.endpoint)) {
    throw AppError.badRequest(
      "endpoint must be a public HTTPS A2A endpoint.",
      { endpoint: params.endpoint },
      "INVALID_RETAINER_ENDPOINT"
    );
  }
  const id = String(jobId || crypto.randomUUID());
  const durationDays = params.plan === "monthly" ? 30 : 7;
  const defaultPrice = RETAINER_DEFAULT_PRICE[kind] || RETAINER_DEFAULT_PRICE.intel;
  const record = {
    id,
    jobId: String(jobId || id),
    buyer: buyer ? getAddress(buyer) : null,
    kind,
    plan: params.plan,
    endpoint: params.endpoint.replace(/\/+$/, ""),
    topics: params.topics || [],
    alerts: params.alerts ?? true,
    monitor: retainerMonitor(kind, params),
    priceUsdc: Number(priceUsdc || defaultPrice[params.plan] || defaultPrice.monthly),
    status: "active",
    startedAt: nowIso(),
    expiresAt: new Date(Date.now() + durationDays * 86_400_000).toISOString(),
    lastDeliveredAt: null,
    deliveries: 0,
    deliveredKeys: [],
    lastError: null,
  };
  const feed = await buildSubscriptionFeed(record).catch((error) => ({
    status: "degraded",
    error: error.message,
    kind,
    keys: [],
  }));
  await store.set(subscriptionKey(jobId || id), record, { ttlSeconds: durationDays * 86_400 + 86_400 });
  await store.set(storeHelpers.revenueSubscription(id), record, { ttlSeconds: durationDays * 86_400 + 86_400 });
  await store.sadd(storeHelpers.revenueSubscriptions(), id);
  return {
    status: "active",
    subscription: publicSubscription(record),
    firstFeed: feed,
    delivery: {
      channel: "a2a_push",
      cadence: record.alerts ? "daily feed plus threshold alerts" : "daily feed",
      note: "A renewal requires a new funded ACP job; subscriptions never auto-debit the client.",
    },
  };
}

export async function liquidationGuard({ params, buyer, jobId, priceUsdc }) {
  return activateRetainer({ params, buyer, jobId, priceUsdc, kind: "liquidation_guard" });
}

export async function newPoolRadar({ params, buyer, jobId, priceUsdc }) {
  if (params.plan === "monthly") {
    return activateRetainer({ params, buyer, jobId, priceUsdc, kind: "new_pool_radar" });
  }
  return scanNewPools(params);
}

export async function smartMoneyFlow({ params, buyer, jobId, priceUsdc }) {
  if (params.plan === "monthly") {
    return activateRetainer({ params, buyer, jobId, priceUsdc, kind: "smart_money_flow" });
  }
  return scanSmartMoney(params);
}

export async function jobRadar({ params, buyer, jobId, priceUsdc }) {
  if (params.plan === "monthly") {
    return activateRetainer({ params, buyer, jobId, priceUsdc, kind: "job_radar" });
  }
  return scanJobLeads(params);
}

async function buildFeed({ topics = [], includeYields = false, alerts = [] } = {}) {
  const [global, trending, news, gas, yields] = await Promise.all([
    getGlobalMarket().catch(() => null),
    getTrendingCoins().catch(() => []),
    getLatestNews({ limit: 6, query: topics[0] || null, hours: 48 }).catch(() => []),
    gasAdvisor({ params: { txType: "swap", urgency: "now" } }).catch(() => null),
    includeYields ? yieldRadar({ params: {} }).catch(() => null) : null,
  ]);
  const lines = [];
  if (global) {
    lines.push(
      `Market: cap $${(Number(global.marketCapUsd) / 1e12).toFixed(2)}T, 24h ${Number(global.marketCapChange24hPct).toFixed(2)}%, BTC dominance ${Number(global.btcDominancePct).toFixed(2)}%.`
    );
  }
  if (Array.isArray(trending) && trending.length) {
    lines.push(
      `Trending: ${trending
        .slice(0, 3)
        .map((coin) => `${coin.symbol} ${Number(coin.change24hPct || 0).toFixed(2)}%`)
        .join(", ")}.`
    );
  }
  if (Array.isArray(news) && news.length) {
    lines.push(`Headlines: ${news.slice(0, 3).map((item) => item.title).join(" | ")}.`);
  }
  if (gas) {
    lines.push(`Base gas: ${gas.gasPriceGwei} gwei, trend ${gas.trend}; est. swap fee $${gas.estimatedCostUsd ?? "n/a"}.`);
  }
  if (yields?.gaps?.length) {
    lines.push(
      `Base yield gaps: ${yields.gaps
        .slice(0, 3)
        .map((gap) => `${gap.symbol} ${gap.apy}% (${gap.project})`)
        .join(", ")}.`
    );
  }
  if (alerts.length) {
    lines.push(
      `Alerts: ${alerts
        .slice(0, 3)
        .map((alert) =>
          alert.type === "whale"
            ? `${alert.token} whale ${alert.amount}${alert.usd ? ` (~$${alert.usd})` : ""}`
            : `${alert.symbol || alert.token} spread ${alert.spreadBps}bps`
        )
        .join(", ")}.`
    );
  }
  if (!lines.length) {
    throw AppError.upstream("Live feed providers returned no data.", undefined, "FEED_UNAVAILABLE");
  }
  return {
    status: "live",
    topics,
    generatedAt: nowIso(),
    text: `Hyper Agent X7733 intelligence feed (${dayKey()}):\n${lines.join("\n")}`,
    sources: { global: Boolean(global), trending: Array.isArray(trending) && trending.length > 0, news: Array.isArray(news) && news.length > 0, gas: Boolean(gas), yields: Boolean(yields) },
  };
}

async function buildSubscriptionFeed(record, { alerts = [] } = {}) {
  const kind = record.kind || "intel";
  const monitor = record.monitor || {};
  const delivered = new Set(record.deliveredKeys || []);

  if (kind === "liquidation_guard") {
    const snapshot = await liquidationSnapshot({
      params: { plan: record.plan, positions: monitor.positions || [], thresholdPct: monitor.thresholdPct ?? 8 },
    });
    const lines = snapshot.positions.map(
      (position) =>
        `${position.token?.symbol || position.input}: $${position.priceUsd ?? "n/a"} (24h ${position.change24hPct ?? "n/a"}%, liquidity $${Math.round(position.liquidityUsd || 0)}), drawdown ${position.drawdownPct ?? "n/a"}%${position.alert ? " ALERT" : ""}.`
    );
    if (snapshot.unresolved.length) {
      lines.push(`Unresolved positions: ${snapshot.unresolved.map((entry) => entry.input).join(", ")}.`);
    }
    return {
      status: "live",
      kind,
      generatedAt: nowIso(),
      text: `Hyper Agent X7733 liquidation guard (${dayKey()}):\n${
        lines.length ? lines.join("\n") : "No monitored position is currently resolvable."
      }\nThreshold ${snapshot.thresholdPct}% 24h drawdown.`,
      snapshot,
      keys: [],
    };
  }

  if (kind === "new_pool_radar") {
    const scan = await scanNewPools({
      plan: "once",
      minLiquidityUsd: monitor.minLiquidityUsd ?? config.revenue.newPoolMinLiquidityUsd,
      maxAgeHours: monitor.maxAgeHours ?? config.revenue.newPoolLookbackHours,
      limit: monitor.limit ?? 8,
    });
    const fresh = scan.pools.filter((pool) => !delivered.has(pool.address.toLowerCase()));
    const lines = fresh
      .slice(0, 5)
      .map(
        (pool) =>
          `${pool.baseSymbol || pool.name} on ${pool.dex || "base"}: $${Math.round(pool.liquidityUsd)} liquidity, 24h volume $${Math.round(pool.volume24hUsd || 0)}, age ${pool.ageHours}h.`
      );
    return {
      status: "live",
      kind,
      generatedAt: nowIso(),
      text: `Hyper Agent X7733 new pool radar (${dayKey()}):\n${
        lines.length ? lines.join("\n") : "No newly created pool matched the configured liquidity and age filters."
      }`,
      snapshot: { filters: scan.filters, observed: scan.observed, count: fresh.length },
      keys: fresh.map((pool) => pool.address.toLowerCase()),
    };
  }

  if (kind === "smart_money_flow") {
    const scan = await scanSmartMoney({
      plan: "once",
      watchlist: monitor.watchlist || [],
      minUsd: monitor.minUsd ?? config.revenue.smartMoneyMinUsd,
      lookbackBlocks: monitor.lookbackBlocks ?? config.revenue.smartMoneyLookbackBlocks,
      limit: monitor.limit ?? 6,
    });
    const fresh = scan.alerts.filter((alert) => !delivered.has(`${alert.txHash}:${alert.to}:${alert.amount}`));
    const lines = fresh
      .slice(0, 5)
      .map((alert) => `${alert.token} ${alert.classification} ${alert.amount} (~$${alert.usd}) tx ${String(alert.txHash).slice(0, 12)}...`);
    return {
      status: "live",
      kind,
      generatedAt: nowIso(),
      text: `Hyper Agent X7733 smart money flow (${dayKey()}):\n${
        lines.length ? lines.join("\n") : "No transfer above the configured USD threshold was observed in the scanned block window."
      }`,
      snapshot: { aggregates: scan.aggregates, thresholds: scan.thresholds, method: scan.method },
      keys: fresh.map((alert) => `${alert.txHash}:${alert.to}:${alert.amount}`),
    };
  }

  if (kind === "job_radar") {
    const scan = await scanJobLeads({
      plan: "once",
      minBudgetUsdc: monitor.minBudgetUsdc ?? 0.5,
      keywords: monitor.keywords || [],
      statuses: monitor.statuses || ["open", "funded"],
      limit: monitor.limit ?? 8,
    });
    const fresh = scan.leads.filter((lead) => !delivered.has(`job:${lead.jobId}`));
    const lines = fresh
      .slice(0, 5)
      .map(
        (lead) =>
          `Job ${lead.jobId} (${lead.status}) ${lead.budgetUsdc} USDC, expires in ${Math.max(0, lead.expiresInSeconds || 0)}s: ${lead.description.slice(0, 100)}`
      );
    return {
      status: "live",
      kind,
      generatedAt: nowIso(),
      text: `Hyper Agent X7733 ACP job radar (${dayKey()}):\n${
        lines.length ? lines.join("\n") : "No matching open or funded ACP job was observed in the scanned window."
      }`,
      snapshot: { sample: scan.sample, filters: scan.filters, count: fresh.length },
      keys: fresh.map((lead) => `job:${lead.jobId}`),
    };
  }

  const feed = await buildFeed({ topics: record.topics, includeYields: record.plan === "monthly", alerts });
  return { ...feed, kind: "intel", keys: [] };
}

async function pushFeed(record, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.revenue.retainerSendTimeoutMs);
  try {
    const body = {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "message/send",
      params: {
        message: {
          role: "user",
          messageId: crypto.randomUUID(),
          parts: [{ kind: "text", text: payload.text }],
          metadata: {
            from: getAgentAddress(),
            campaign: record.kind || "intel-retainer",
            subscriptionId: record.id,
            plan: record.plan,
            delivery: payload.delivery || payload.kind || "daily_feed",
            generatedAt: payload.generatedAt,
          },
        },
      },
    };
    const response = await fetchJSON(
      record.endpoint,
      { method: "POST", body: JSON.stringify(body) },
      { timeoutMs: config.revenue.retainerSendTimeoutMs, retries: 0, service: "retainer-push" }
    );
    if (response?.error) throw new Error(response.error.message || "target returned a JSON-RPC error");
    if (!response?.result) throw new Error("target returned no JSON-RPC result");
    return { ok: true, contextId: response.result.contextId || null };
  } catch (error) {
    return { ok: false, error: error.message };
  } finally {
    clearTimeout(timer);
  }
}

export async function deliverRetainers({ alerts = [], limit = 3 } = {}) {
  const ids = await store.smembers(storeHelpers.revenueSubscriptions()).catch(() => []);
  const results = [];
  const now = Date.now();
  for (const id of ids.slice(0, Math.max(1, limit))) {
    const record = await store.get(subscriptionKey(id)).catch(() => null) || await store.get(storeHelpers.revenueSubscription(id)).catch(() => null);
    if (!record) {
      await store.srem(storeHelpers.revenueSubscriptions(), id).catch(() => null);
      continue;
    }
    if (Date.parse(record.expiresAt) <= now) {
      await store.set(subscriptionKey(id), { ...record, status: "expired" }, { ttlSeconds: 7 * 86_400 }).catch(() => null);
      await store.srem(storeHelpers.revenueSubscriptions(), id).catch(() => null);
      results.push({ subscriptionId: id, status: "expired" });
      continue;
    }
    const sameDay = record.lastDeliveredAt && dayKey(new Date(record.lastDeliveredAt)) === dayKey();
    if (sameDay) {
      results.push({ subscriptionId: id, status: "skipped", reason: "ALREADY_DELIVERED_TODAY" });
      continue;
    }
    try {
      const feed = await buildSubscriptionFeed(record, { alerts });
      const send = await pushFeed(record, { ...feed, delivery: "daily_feed" });
      const deliveredKeys = send.ok
        ? [...(record.deliveredKeys || []), ...(feed.keys || [])].slice(-500)
        : record.deliveredKeys || [];
      const next = {
        ...record,
        lastDeliveredAt: send.ok ? nowIso() : record.lastDeliveredAt,
        deliveries: send.ok ? Number(record.deliveries || 0) + 1 : record.deliveries,
        deliveredKeys,
        lastError: send.ok ? null : { code: "RETAINER_PUSH_FAILED", message: send.error, at: nowIso() },
      };
      await store.set(subscriptionKey(id), next, { ttlSeconds: SUBSCRIPTION_TTL_SECONDS }).catch(() => null);
      await store.set(storeHelpers.revenueSubscription(id), next, { ttlSeconds: SUBSCRIPTION_TTL_SECONDS }).catch(() => null);
      results.push({ subscriptionId: id, status: send.ok ? "delivered" : "failed", error: send.error });
    } catch (error) {
      await store.set(
        subscriptionKey(id),
        { ...record, lastError: { code: "RETAINER_BUILD_FAILED", message: error.message, at: nowIso() } },
        { ttlSeconds: SUBSCRIPTION_TTL_SECONDS }
      ).catch(() => null);
      results.push({ subscriptionId: id, status: "failed", error: error.message });
    }
  }
  return { active: ids.length, delivered: results.filter((r) => r.status === "delivered").length, results };
}

export async function subscriptionStatus() {
  const ids = await store.smembers(storeHelpers.revenueSubscriptions()).catch(() => []);
  const records = (await Promise.all(ids.map((id) => store.get(subscriptionKey(id)).catch(() => null)))).filter(Boolean);
  return {
    active: records.filter((record) => record.status === "active" && Date.parse(record.expiresAt) > Date.now()).length,
    total: ids.length,
    plans: records.reduce((acc, record) => {
      acc[record.plan] = (acc[record.plan] || 0) + 1;
      return acc;
    }, {}),
    recent: records.slice(0, 10).map(publicSubscription),
  };
}

/* ----------------------------- Bounty pitch ------------------------------ */

function matchBountyTarget(candidates, anomaly) {
  const needle = `${anomaly.dex || ""} ${anomaly.name || ""}`.toLowerCase();
  return candidates.find((candidate) => {
    if (!candidate.contactable) return false;
    const text = `${candidate.name || ""} ${candidate.description || ""} ${(candidate.skills || []).join(" ")}`.toLowerCase();
    return needle.split(/\s+/).some((part) => part.length >= 4 && text.includes(part));
  });
}

export async function pitchBounties({ anomalies = [], limit = 1 } = {}) {
  if (!config.outreach.enabled) return { status: "disabled", reason: "OUTREACH_ENABLED is false" };
  if (!anomalies.length) return { status: "idle", pitched: 0 };
  const discovery = await discoverTargets({ scanJobs: config.outreach.scanJobs }).catch(() => null);
  if (!discovery) return { status: "degraded", reason: "DISCOVERY_FAILED" };
  const optOuts = new Set(await store.smembers(storeHelpers.outreachOptOut()).catch(() => []));
  const results = [];
  for (const anomaly of anomalies.slice(0, limit)) {
    const target = matchBountyTarget(discovery.candidates, anomaly);
    if (!target || optOuts.has(target.key)) {
      results.push({ pool: anomaly.pool, status: "no_target" });
      continue;
    }
    const contact = await store.get(storeHelpers.outreachContact(target.key)).catch(() => null);
    if (contact?.nextAttemptAt && Date.now() < Date.parse(contact.nextAttemptAt)) {
      results.push({ pool: anomaly.pool, status: "cooldown" });
      continue;
    }
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + config.outreach.sessionTtlSeconds * 1000).toISOString();
    const priceUsdc = 5;
    const text = [
      `Live Base pool anomaly detected: ${anomaly.name || anomaly.pool} on ${anomaly.dex || "Base"}.`,
      `Liquidity ${anomaly.liquidityChangePct}% (now $${Math.round(anomaly.liquidityUsd)}), price ${anomaly.priceChangePct}% since the previous snapshot.`,
      `I can deliver a ${priceUsdc} USDC deep risk report with pool, security and liquidity findings.`,
      `Fund an ACP job with provider ${getAgentAddress()}, budget >= ${priceUsdc} USDC, description ${JSON.stringify({
        offeringId: "deep_analytics",
        params: { target: anomaly.baseAddress || anomaly.pool, depth: "standard", includeSecurity: true },
      })}.`,
      `This offer expires ${expiresAt}.`,
    ].join(" ");
    const send = await sendA2APitch({
      endpoint: target.endpoint,
      text,
      sessionId,
      offeringId: "deep_analytics",
      quoteUsdc: priceUsdc,
      expiresAt,
    });
    if (!send.ok) {
      results.push({ pool: anomaly.pool, status: "send_failed", error: send.error });
      continue;
    }
    const session = {
      id: sessionId,
      contextId: send.contextId || sessionId,
      targetKey: target.key,
      targetName: target.name || target.endpoint,
      endpoint: target.endpoint,
      offeringId: "deep_analytics",
      basePriceUsdc: priceUsdc,
      priceUsdc,
      floorUsdc: priceUsdc,
      status: "open",
      turns: 0,
      conceded: false,
      extended: false,
      createdAt: nowIso(),
      expiresAt,
      lastAt: nowIso(),
      jobId: null,
      hashes: [],
      campaign: "bounty",
    };
    await registerOutreachSession(session).catch(() => null);
    await store.set(
      storeHelpers.outreachContact(target.key),
      {
        targetName: session.targetName,
        endpoint: target.endpoint,
        lastOutcome: "bounty_pitched",
        lastContactAt: nowIso(),
        nextAttemptAt: new Date(Date.now() + config.outreach.cooldownHours * 3_600_000).toISOString(),
        score: target.score,
        sessionId,
      },
      { ttlSeconds: 30 * 86_400 }
    ).catch(() => null);
    results.push({ pool: anomaly.pool, status: "pitched", target: session.targetName, sessionId });
  }
  return { status: "ok", pitched: results.filter((entry) => entry.status === "pitched").length, results };
}

/* ------------------------------- Preview --------------------------------- */

export async function previewRevenueOffering({ offering, params }) {
  switch (offering.id) {
    case "deep_analytics": {
      const token = await resolveToken(params.target).catch(() => null);
      const pool = token ? (await getTokenPools(token.address).catch(() => []))[0] || null : null;
      return {
        offering_id: offering.id,
        action: "preview_analytics",
        price: { amount: params.depth === "enterprise" ? "15.00" : params.depth === "pro" ? "10.00" : "5.00", currency: "USDC" },
        token: token ? { symbol: token.symbol, address: token.address, decimals: token.decimals } : null,
        market: pool ? { dex: pool.dex, priceUsd: pool.priceUsd, liquidityUsd: pool.liquidityUsd } : null,
        execute: "Request /api/quote, then fund an ACP job with the returned description.",
      };
    }
    case "flash_alert": {
      const scan = await flashAlerts({ params });
      return { offering_id: offering.id, action: "preview_alerts", price: { amount: "3.00", currency: "USDC" }, ...scan };
    }
    case "gas_advisor":
      return { offering_id: offering.id, action: "preview_gas", price: { amount: "1.00", currency: "USDC" }, ...(await gasAdvisor({ params })) };
    case "yield_radar":
      return { offering_id: offering.id, action: "preview_yield_radar", price: { amount: "2.50", currency: "USDC" }, ...(await yieldRadar({ params })) };
    case "agent_credit":
      return { offering_id: offering.id, action: "preview_credit", price: { amount: "2.00", currency: "USDC" }, ...(await agentCredit({ params })) };
    case "intel_retainer":
      return {
        offering_id: offering.id,
        action: "preview_retainer",
        price: { amount: params.plan === "monthly" ? "100.00" : "50.00", currency: "USDC" },
        plan: params.plan,
        endpoint: params.endpoint,
        endpointValid: isPublicHttpUrl(params.endpoint),
        cadence: "daily feed" + (params.alerts ? " plus threshold alerts" : ""),
        execute: "Fund an ACP job with this endpoint and plan. Delivery starts after activation.",
      };
    case "token_security_scan":
      return {
        offering_id: offering.id,
        action: "preview_security_scan",
        price: { amount: basePriceFor(offering, params).toFixed(2), currency: "USDC" },
        tokens: params.tokens.length,
        checks: ["honeypot", "buy/sell tax", "open source", "proxy", "holders", "liquidity", "DEX coverage"],
        execute: "Fund an ACP job with this offeringId and params. Live contract reads run on execution.",
      };
    case "wallet_risk_audit":
      return {
        offering_id: offering.id,
        action: "preview_wallet_risk",
        price: { amount: basePriceFor(offering, params).toFixed(2), currency: "USDC" },
        address: params.address,
        watchTokens: params.watchTokens,
        checks: ["contract vs EOA", "balances", "nonce", "ACP job history", "completion rate"],
        execute: "Fund an ACP job with this offeringId and params. Live wallet reads run on execution.",
      };
    case "liquidation_guard": {
      const price = basePriceFor(offering, params);
      return {
        offering_id: offering.id,
        action: "preview_liquidation_guard",
        price: { amount: price.toFixed(2), currency: "USDC" },
        plan: params.plan,
        positions: params.positions,
        thresholdPct: params.thresholdPct,
        endpoint: params.endpoint,
        endpointValid: isPublicHttpUrl(params.endpoint),
        cadence: "hourly 24h drawdown check pushed to your A2A endpoint; no auto-debit renewal",
        execute: "Fund an ACP job with this endpoint and plan. Monitoring starts after activation.",
      };
    }
    case "new_pool_radar":
    case "smart_money_flow":
    case "job_radar": {
      const price = basePriceFor(offering, params);
      const retainer = params.plan === "monthly";
      return {
        offering_id: offering.id,
        action: "preview_scan",
        price: { amount: price.toFixed(2), currency: "USDC" },
        plan: params.plan,
        endpoint: params.endpoint,
        endpointValid: retainer ? isPublicHttpUrl(params.endpoint) : null,
        cadence: retainer ? "daily feed pushed to your A2A endpoint; no auto-debit renewal" : "single live scan",
        execute: "Fund an ACP job with this offeringId and params.",
      };
    }
    case "batch_executor": {
      const totalUsdc = params.transfers.reduce((sum, entry) => sum + Number(entry.amount), 0);
      return {
        offering_id: offering.id,
        action: "preview_batch",
        price: { amount: basePriceFor(offering, params).toFixed(2), currency: "USDC" },
        transfers: params.transfers.length,
        totalUsdc: round(totalUsdc, 6),
        serviceFeeUsdc: round(Math.max(0, basePriceFor(offering, params) - 1), 6),
        token: { address: USDC.address, symbol: "USDC", decimals: USDC.decimals },
        execute: "Create a funded ACP job and POST /api/acp with this offeringId and params.",
      };
    }
    case "agent_revenue_audit":
      return {
        offering_id: offering.id,
        action: "preview_revenue_audit",
        price: { amount: basePriceFor(offering, params).toFixed(2), currency: "USDC" },
        address: params.address,
        metrics: ["completed jobs", "settled volume", "30d run rate", "unique clients", "completion rate"],
        execute: "Fund an ACP job with this offeringId and params. Live ACP job reads run on execution.",
      };
    case "provider_benchmark":
      return {
        offering_id: offering.id,
        action: "preview_benchmark",
        price: { amount: basePriceFor(offering, params).toFixed(2), currency: "USDC" },
        limit: params.limit,
        minCompleted: params.minCompleted,
        execute: "Fund an ACP job with this offeringId and params. Live provider rankings are computed on execution.",
      };
    case "virtuals_alpha":
      return {
        offering_id: offering.id,
        action: "preview_virtuals_alpha",
        price: { amount: basePriceFor(offering, params).toFixed(2), currency: "USDC" },
        token: params.token,
        timeframe: params.timeframe,
        includeEcosystem: params.includeEcosystem,
        execute: "Fund an ACP job with this offeringId and params. Live market and ACP reads run on execution.",
      };
    default:
      return null;
  }
}

/* ------------------------------ Revenue cycle ---------------------------- */

export async function runRevenueCycle({ reason = "interval", force = false } = {}) {
  if (!config.revenue.enabled) {
    return { status: "disabled", reason: "REVENUE_ENABLED is false", reasonSource: reason };
  }
  const startedAt = Date.now();
  const token = await acquireLock(storeHelpers.revenueLock(), LOCK_TTL_SECONDS);
  if (!token) return { status: "skipped", reason: "ANOTHER_CYCLE_ACTIVE", reasonSource: reason };
  const summary = {
    status: "ok",
    reasonSource: reason,
    alerts: 0,
    newAlerts: 0,
    subscriptions: null,
    referrals: null,
    anomalies: null,
    bounties: null,
    startedAt: new Date(startedAt).toISOString(),
  };
  try {
    const state = await loadState();
    if (state.lastCycleAt && !force) {
      const due = Date.parse(state.lastCycleAt) + config.revenue.intervalSeconds * 1000;
      if (Date.now() < due) {
        return { ...summary, status: "skipped", reason: "INTERVAL_NOT_ELAPSED", nextRunAt: new Date(due).toISOString() };
      }
    }
    state.lastCycleAt = nowIso();

    const [arb, whales, anomalyScan] = await Promise.all([
      scanArbitrage({ limit: 4 }).catch((error) => {
        logger.warn("revenue arbitrage scan failed", { message: error.message });
        return [];
      }),
      scanWhales().catch((error) => {
        logger.warn("revenue whale scan failed", { message: error.message });
        return [];
      }),
      detectAnomalies().catch((error) => {
        logger.warn("revenue anomaly scan failed", { message: error.message });
        return { scanned: 0, seeded: 0, anomalies: [] };
      }),
    ]);
    const alerts = [...arb, ...whales];
    const known = new Set(state.alertKeys || []);
    const freshAlerts = alerts.filter((alert) => {
      const key = `${alert.type}:${alert.txHash || alert.pool || alert.symbol}:${alert.observedAt}`;
      return !known.has(key);
    });
    state.alertKeys = [...(state.alertKeys || []), ...freshAlerts.map((alert) => `${alert.type}:${alert.txHash || alert.pool || alert.symbol}:${alert.observedAt}`)].slice(-200);
    summary.alerts = alerts.length;
    summary.newAlerts = freshAlerts.length;
    summary.anomalies = anomalyScan;

    if (state.day !== dayKey()) {
      state.day = dayKey();
      state.deliveries = 0;
      state.alertsToday = 0;
    }

    state.alertsToday = Number(state.alertsToday || 0) + freshAlerts.length;

    const deliveryBudget = Math.max(0, config.revenue.retainerMaxDeliveriesPerDay - Number(state.deliveries || 0));
    if (deliveryBudget > 0 && Date.now() - startedAt < config.revenue.budgetMs * 0.7) {
      summary.subscriptions = await deliverRetainers({ alerts: freshAlerts, limit: Math.min(3, deliveryBudget) }).catch(
        (error) => ({ status: "failed", error: error.message })
      );
      state.deliveries = Number(state.deliveries || 0) + Number(summary.subscriptions?.delivered || 0);
    } else {
      summary.subscriptions = { status: "skipped", reason: deliveryBudget > 0 ? "TIME_BUDGET" : "DAILY_DELIVERY_CAP" };
    }
    if (Date.now() - startedAt < config.revenue.budgetMs * 0.85) {
      summary.referrals = await processReferralPayouts({ limit: 3 }).catch((error) => ({
        status: "failed",
        error: error.message,
      }));
    }
    if (anomalyScan.anomalies?.length && Date.now() - startedAt < config.revenue.budgetMs * 0.9) {
      summary.bounties = await pitchBounties({ anomalies: anomalyScan.anomalies, limit: 1 }).catch((error) => ({
        status: "failed",
        error: error.message,
      }));
      state.bounties = [
        ...(state.bounties || []),
        ...anomalyScan.anomalies.map((anomaly) => ({ ...anomaly, queuedAt: nowIso() })),
      ].slice(-20);
    }

    state.lastSummary = summary;
    state.lastError = null;
    await saveState(state);
    logger.info("revenue cycle finished", {
      alerts: summary.alerts,
      newAlerts: summary.newAlerts,
      subscriptions: summary.subscriptions?.delivered ?? 0,
      referralsPaid: summary.referrals?.paid ?? 0,
      anomalies: anomalyScan.anomalies?.length ?? 0,
    });
    return { ...summary, finishedAt: nowIso() };
  } catch (error) {
    logger.warn("revenue cycle failed", { message: error.message });
    const state = await loadState();
    state.lastError = { code: error.code || "REVENUE_CYCLE_FAILED", message: error.message, at: nowIso() };
    await saveState(state).catch(() => null);
    return { ...summary, status: "failed", error: { code: error.code || "REVENUE_CYCLE_FAILED", message: error.message } };
  } finally {
    await releaseLock(storeHelpers.revenueLock(), token);
  }
}

export async function revenueStatus() {
  const [state, subscriptions, referrals, pricing] = await Promise.all([
    loadState(),
    subscriptionStatus().catch(() => null),
    referralStatus().catch(() => null),
    currentPricing().catch(() => null),
  ]);
  return {
    enabled: config.revenue.enabled,
    driver: "local_loop_or_cron",
    intervalSeconds: config.revenue.intervalSeconds,
    pricing,
    lastCycleAt: state.lastCycleAt,
    lastSummary: state.lastSummary,
    lastError: state.lastError,
    alertsToday: state.alertsToday,
    deliveriesToday: state.deliveries,
    bounties: (state.bounties || []).slice(-5),
    subscriptions,
    referrals,
    thresholds: {
      arbitrageMinSpreadBps: config.revenue.arbitrageMinSpreadBps,
      arbitrageMinLiquidityUsd: config.revenue.arbitrageMinLiquidityUsd,
      whaleMinUsdc: config.revenue.whaleMinUsdc,
      whaleMinWeth: config.revenue.whaleMinWeth,
      anomalyLiquidityDropPct: config.revenue.anomalyLiquidityDropPct,
      anomalyPriceDropPct: config.revenue.anomalyPriceDropPct,
    },
  };
}

export { buildFeed, buildTradePlan };

let revenueTimer = null;

export function startRevenueLoop() {
  if (revenueTimer) return { started: false, reason: "ALREADY_RUNNING" };
  if (isVercel) {
    logger.info("revenue suite runs via Vercel cron (/api/cron/revenue)");
    return { started: false, reason: "VERCEL_CRON" };
  }
  if (!config.revenue.enabled) {
    logger.info("revenue suite disabled (set REVENUE_ENABLED=true to enable)");
    return { started: false, reason: "DISABLED" };
  }
  const run = () => {
    runRevenueCycle({ reason: "interval" }).catch((error) => {
      logger.warn("revenue iteration crashed", { message: error.message });
    });
  };
  setTimeout(run, 45_000).unref?.();
  revenueTimer = setInterval(run, config.revenue.intervalSeconds * 1000);
  revenueTimer.unref?.();
  logger.info("revenue loop started", {
    intervalSeconds: config.revenue.intervalSeconds,
    referrals: config.revenue.referralBps / 100,
    happyHourUtc: `${config.revenue.happyHourStartUtc}-${config.revenue.happyHourEndUtc}`,
  });
  return { started: true, intervalSeconds: config.revenue.intervalSeconds };
}

export function stopRevenueLoop() {
  if (revenueTimer) clearInterval(revenueTimer);
  revenueTimer = null;
}
