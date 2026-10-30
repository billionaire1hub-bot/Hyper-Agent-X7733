#!/usr/bin/env node
/**
 * Live read-only verification against Base mainnet and the configured ACP
 * escrow. No transactions are signed and no wallet is required.
 *
 *   npm run verify
 *   VERIFY_BASE_URL=https://your-agent.vercel.app npm run verify
 */
import { formatUnits } from "viem";
import { BASE_TOKENS, USDC, VIRTUALS, config, walletConfigured } from "../src/config.js";
import { ACP_ABI, ACP_JOB_STATUS } from "../src/abi/index.js";
import { publicClient, getAgentAddress, getNativeBalance, getTokenBalance } from "../src/chain/client.js";
import { getAcpJob, getPaymentToken } from "../src/services/escrow.js";
import { getQuote } from "../src/services/kyberswap.js";
import { getVirtualsAssetToken } from "../src/services/virtuals.js";
import { resolveToken } from "../src/services/tokens.js";
import { OFFERINGS } from "../src/services/offerings.js";
import { coingeckoPing, getBinanceDerivatives, getTokenPools, getTrendingCoins, getYieldPools } from "../src/services/market.js";
import { getLatestNews } from "../src/services/news.js";
import {
  agentRevenueAudit,
  liquidationSnapshot,
  providerBenchmark,
  scanJobLeads,
  scanNewPools,
  scanSmartMoney,
  tokenSecurityScan,
  virtualsAlpha,
  walletRiskAudit,
} from "../src/services/revenue.js";

const results = [];

const record = (name, ok, detail) => {
  results.push({ name, ok, detail });
  const icon = ok === null ? "-" : ok ? "PASS" : "FAIL";
  console.log(`[${icon}] ${name}${detail ? `: ${detail}` : ""}`);
};

const run = async (name, fn, { critical = true } = {}) => {
  try {
    const detail = await fn();
    record(name, true, detail);
  } catch (error) {
    record(name, false, error.shortMessage || error.message);
    if (critical) process.exitCode = 1;
  }
};

console.log(`${config.name} (${config.slug}) live verification`);
console.log(`RPC: ${config.chain.rpcUrl}`);
console.log(`ACP: ${config.acp.contract}`);
console.log(`Wallet: ${walletConfigured ? getAgentAddress() : "not configured (read-only mode)"}`);
console.log("");

await run("Base RPC + chain id", async () => {
  const [chainId, block] = await Promise.all([publicClient.getChainId(), publicClient.getBlockNumber()]);
  if (Number(chainId) !== config.chain.id) throw new Error(`chainId ${chainId} != ${config.chain.id}`);
  return `block ${block}`;
});

await run("ACP contract bytecode", async () => {
  const code = await publicClient.getBytecode({ address: config.acp.contract });
  if (!code || code === "0x") throw new Error("no bytecode at configured address");
  return `${(code.length - 2) / 2} bytes`;
});

await run("ACP payment token is Base USDC", async () => {
  const token = await getPaymentToken();
  if (token.toLowerCase() !== USDC.address.toLowerCase()) throw new Error(`paymentToken=${token}`);
  return token;
});

await run("ACP job counter", async () => {
  const counter = await publicClient.readContract({
    address: config.acp.contract,
    abi: ACP_ABI,
    functionName: "jobCounter",
  });
  const latest = await getAcpJob(counter);
  return `${counter} jobs (latest ${ACP_JOB_STATUS[latest?.status] || "none"})`;
}, { critical: false });

await run("ACP escrow USDC balance", async () => {
  const balance = await getTokenBalance(USDC.address, config.acp.contract);
  return `${formatUnits(balance, USDC.decimals)} USDC`;
});

await run("KyberSwap USDC -> WETH quote", async () => {
  const quote = await getQuote({
    tokenIn: USDC.address,
    tokenOut: BASE_TOKENS.WETH.address,
    amountIn: 1_000_000n,
  });
  return `1 USDC -> ${formatUnits(quote.amountOut, 18)} WETH via ${quote.router}`;
});

await run("Virtuals bonding router asset token", async () => {
  const asset = await getVirtualsAssetToken();
  if (asset.toLowerCase() !== VIRTUALS.token.toLowerCase()) {
    throw new Error(`assetToken=${asset} (expected ${VIRTUALS.token})`);
  }
  return asset;
}, { critical: false });

for (const symbol of ["USDC", "WETH", "VIRTUAL"]) {
  await run(`Resolve ${symbol}`, async () => {
    const token = await resolveToken(symbol);
    return `${token.address} (${token.decimals} decimals, ${token.source})`;
  }, { critical: false });
}

await run("Resolve contract by address", async () => {
  const token = await resolveToken(BASE_TOKENS.DEGEN.address);
  return `${token.symbol} (${token.decimals} decimals)`;
}, { critical: false });

await run("CoinGecko live API", async () => {
  await coingeckoPing();
  const trending = await getTrendingCoins();
  if (trending.length === 0) throw new Error("no trending coins returned");
  return `${trending.length} trending coins (top ${trending[0].symbol})`;
}, { critical: false });

await run("GeckoTerminal Base pools", async () => {
  const pools = await getTokenPools(BASE_TOKENS.DEGEN.address);
  if (pools.length === 0) throw new Error("no pools returned");
  return `${pools.length} pools, top liquidity $${Math.round(pools[0].liquidityUsd || 0)}`;
}, { critical: false });

await run("Binance derivatives (BTCUSDT)", async () => {
  const derivatives = await getBinanceDerivatives("BTC");
  if (!derivatives) throw new Error("no derivatives data returned");
  return `funding=${derivatives.fundingRatePct?.toFixed(4)}% OI=${derivatives.openInterest ?? "n/a"}`;
}, { critical: false });

await run("Live news feeds (RSS)", async () => {
  const news = await getLatestNews({ limit: 3 });
  return `${news.items.length} headlines from ${news.coverage.feedsOk}/${news.coverage.feedsConfigured} feeds: "${news.items[0].title.slice(0, 60)}"`;
}, { critical: false });

await run("DefiLlama yield pools", async () => {
  const pools = await getYieldPools({ assetClass: "stable", limit: 3 });
  if (pools.length === 0) throw new Error("no stablecoin pools returned");
  return `top APY ${pools[0].apy}% on ${pools[0].project} (${pools[0].chain})`;
}, { critical: false });

await run("Token security scan (VIRTUAL)", async () => {
  const scan = await tokenSecurityScan({ params: { tokens: ["VIRTUAL"] } });
  if (!scan.resolved) throw new Error("token did not resolve");
  return `${scan.tokens[0].token.symbol} risk=${scan.tokens[0].riskLevel} score=${scan.tokens[0].riskScore} pools=${scan.tokens[0].pools.length}`;
}, { critical: false });

await run("Liquidation guard snapshot", async () => {
  const snapshot = await liquidationSnapshot({
    params: { plan: "weekly", positions: ["VIRTUAL", "WETH"], thresholdPct: 8 },
  });
  if (snapshot.positions.length === 0) throw new Error("no positions resolved");
  return `${snapshot.positions.length} positions, ${snapshot.alerts.length} alerts at ${snapshot.thresholdPct}%`;
}, { critical: false });

await run("Smart money flow (live transfer logs)", async () => {
  const scan = await scanSmartMoney({
    plan: "once",
    watchlist: ["USDC"],
    minUsd: 50_000,
    lookbackBlocks: 10,
    limit: 3,
  });
  return `${scan.count} alerts via ${scan.method}, net pool flow ${scan.aggregates[0]?.netPoolFlowUsd ?? 0} USD`;
}, { critical: false });

await run("Virtuals ecosystem alpha", async () => {
  const report = await virtualsAlpha({ params: { token: "VIRTUAL", timeframe: "4h", includeEcosystem: false } });
  if (!report.market?.priceUsd) throw new Error("no live market price");
  return `VIRTUAL $${report.market.priceUsd} (24h ${report.market.change24hPct}%), pools=${report.liquidity.pools.length}`;
}, { critical: false });

await run("New Base pool radar", async () => {
  const scan = await scanNewPools({ plan: "once", minLiquidityUsd: 25_000, maxAgeHours: 48, limit: 5 });
  return `${scan.count}/${scan.observed} pools matched liquidity and age filters`;
}, { critical: false });

await run("ACP job radar", async () => {
  const scan = await scanJobLeads({
    plan: "once",
    minBudgetUsdc: 0.5,
    keywords: [],
    statuses: ["open", "funded"],
    limit: 5,
  });
  return `${scan.count} open/funded leads in ${scan.sample.scanned} jobs`;
}, { critical: false });

let sampledProvider = null;
await run("ACP provider benchmark", async () => {
  const scan = await providerBenchmark({ params: { limit: 5, minCompleted: 1 } });
  const top = scan.providers[0];
  sampledProvider = top?.provider || null;
  return top ? `${scan.count} providers ranked, top settled ${top.settledVolumeUsdc} USDC` : "no ranked providers";
}, { critical: false });

if (sampledProvider) {
  await run("Wallet risk audit (top provider sample)", async () => {
    const audit = await walletRiskAudit({ params: { address: sampledProvider, watchTokens: ["WETH"] } });
    return `${audit.type} risk=${audit.risk.riskLevel} jobs=${audit.acp.jobs} volume=${audit.acp.volumeUsdc} USDC`;
  }, { critical: false });

  await run("Agent revenue audit (top provider sample)", async () => {
    const audit = await agentRevenueAudit({ params: { address: sampledProvider } });
    return `completed=${audit.stats.completed} volume=${audit.stats.volumeUsdc} USDC runRate=${audit.stats.monthlyRunRateUsd}`;
  }, { critical: false });
}

if (walletConfigured) {
  await run("Agent wallet risk audit", async () => {
    const audit = await walletRiskAudit({ params: { address: getAgentAddress(), watchTokens: ["WETH"] } });
    return `${audit.type} risk=${audit.risk.riskLevel} jobs=${audit.acp.jobs}`;
  }, { critical: false });

  await run("Agent revenue audit", async () => {
    const audit = await agentRevenueAudit({ params: { address: getAgentAddress() } });
    return `completed=${audit.stats.completed} volume=${audit.stats.volumeUsdc} USDC runRate=${audit.stats.monthlyRunRateUsd}`;
  }, { critical: false });
}

if (walletConfigured) {
  await run("Agent wallet balances", async () => {
    const agent = getAgentAddress();
    const [eth, usdc] = await Promise.all([
      getNativeBalance(agent),
      getTokenBalance(USDC.address, agent),
    ]);
    return `${formatUnits(eth, 18)} ETH, ${formatUnits(usdc, USDC.decimals)} USDC`;
  }, { critical: false });
}

const baseUrl = (process.env.VERIFY_BASE_URL || "").replace(/\/+$/, "");
if (baseUrl) {
  console.log(`\nRemote endpoints: ${baseUrl}`);
  const apiKey = process.env.API_KEY || "";
  const headers = { "content-type": "application/json", ...(apiKey ? { "x-api-key": apiKey } : {}) };

  await run("GET /api/health", async () => {
    const response = await fetch(`${baseUrl}/api/health`, { headers, signal: AbortSignal.timeout(50000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.acp?.escrowVerification !== "onchain_getJob") throw new Error("unexpected health payload");
    const intel = body.services?.intelligence;
    return `${body.status} (rpc=${body.services?.baseRpc?.ok}, escrow=${body.services?.acpEscrow?.deployed}, intel=${intel?.ready})`;
  });

  await run("GET /api/offerings", async () => {
    const response = await fetch(`${baseUrl}/api/offerings`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.count !== OFFERINGS.length) {
      throw new Error(`expected ${OFFERINGS.length} offerings, got ${body.count}`);
    }
    const intelligence = body.offerings.filter((offering) => offering.category === "intelligence").length;
    return `${body.count} offerings (${intelligence} intelligence)`;
  });

  await run("POST /api/chat (resolve preview)", async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "resolve USDC WETH VIRTUAL" }),
      signal: AbortSignal.timeout(40000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.status !== "preview") throw new Error(`status=${body.status}`);
    return `${body.intent?.offeringId} (${body.engine})`;
  });

  await run("POST /api/chat (swap preview)", async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "swap 10 USDC to WETH with slippage 3%" }),
      signal: AbortSignal.timeout(50000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (body.status !== "preview" || !body.preview?.quote?.amountIn) throw new Error("missing swap preview");
    return `${body.preview.quote.venue} out=${body.preview.quote.expectedAmountOutFormatted}`;
  });

  await run("POST /api/chat (intelligence preview)", async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({ message: "what's trending in crypto" }),
      signal: AbortSignal.timeout(40000),
    });
    const body = await response.json();
    if (response.status === 503) throw new Error(`AI_NOT_CONFIGURED: ${body.error?.message}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (body.preview?.action !== "preview_intelligence") throw new Error(`action=${body.preview?.action}`);
    if (body.intent?.offeringId !== "trending_tokens") throw new Error(`offering=${body.intent?.offeringId}`);
    return `${body.intent.offeringId} (${body.engine}) providers=${body.preview?.providers ? "reported" : "missing"}`;
  });

  await run("GET /api/social", async () => {
    const response = await fetch(`${baseUrl}/api/social`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const social = body.social;
    if (!social || typeof social.enabled !== "boolean") throw new Error("unexpected social payload");
    return `enabled=${social.enabled} x=${social.x?.mode} publishedToday=${social.publishedToday}`;
  }, { critical: false });

  await run("GET A2A agent card", async () => {
    const response = await fetch(`${baseUrl}/.well-known/agent-card.json`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const card = await response.json();
    if (card.name !== config.name) throw new Error(`name=${card.name}`);
    if (!Array.isArray(card.skills) || card.skills.length !== 32) throw new Error("unexpected skills");
    return `${card.name} v${card.version} skills=${card.skills.length}`;
  }, { critical: false });

  await run("POST /a2a (route)", async () => {
    const response = await fetch(`${baseUrl}/a2a`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message/send",
        params: { message: { parts: [{ kind: "text", text: "hello" }] } },
      }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json();
    if (body.error) throw new Error(`${body.error.code}: ${body.error.message}`);
    if (!body.result) throw new Error("missing result");
    return `result=${body.result.kind}`;
  }, { critical: false });

  await run("GET /api/intake", async () => {
    const response = await fetch(`${baseUrl}/api/intake`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body.intake || typeof body.intake.enabled !== "boolean") throw new Error("unexpected intake payload");
    return `enabled=${body.intake.enabled} driver=${body.intake.driver} cursor=${body.intake.cursor}`;
  }, { critical: false });

  await run("GET /api/a2a/inbox", async () => {
    const response = await fetch(`${baseUrl}/api/a2a/inbox`, { headers, signal: AbortSignal.timeout(20000) });
    if (response.status === 401) throw new Error("set API_KEY to query the inbound log");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body.inbox || typeof body.inbox.total !== "number") throw new Error("unexpected inbox payload");
    return `total=${body.inbox.total} last24h=${body.inbox.last24h}`;
  }, { critical: false });

  await run("GET /api/outreach", async () => {
    const response = await fetch(`${baseUrl}/api/outreach`, { headers, signal: AbortSignal.timeout(20000) });
    if (response.status === 401) throw new Error("set API_KEY to query outreach state");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body.outreach || typeof body.outreach.enabled !== "boolean") throw new Error("unexpected outreach payload");
    return `enabled=${body.outreach.enabled} pitchedToday=${body.outreach.state?.pitchedToday ?? 0}`;
  }, { critical: false });

  await run("GET /api/pricing", async () => {
    const response = await fetch(`${baseUrl}/api/pricing`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body.pricing?.tiers?.deep_analytics) throw new Error("missing pricing tiers");
    return `happyHour=${body.pricing.active} discountBps=${body.pricing.discountBps} gas=${body.pricing.gasGwei ?? "n/a"}`;
  }, { critical: false });

  await run("POST /api/quote", async () => {
    const response = await fetch(`${baseUrl}/api/quote`, {
      method: "POST",
      headers,
      body: JSON.stringify({ offeringId: "gas_advisor", params: {} }),
      signal: AbortSignal.timeout(20000),
    });
    if (response.status === 401) throw new Error("set API_KEY to issue quotes");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body.quote?.quoteId || !body.quote?.priceUnits) throw new Error("missing quote");
    return `${body.quote.offeringId} price=${body.quote.priceUsdc} USDC expires=${body.quote.expiresAt}`;
  }, { critical: false });

  await run("GET /api/revenue", async () => {
    const response = await fetch(`${baseUrl}/api/revenue`, { headers, signal: AbortSignal.timeout(20000) });
    if (response.status === 401) throw new Error("set API_KEY to query revenue state");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body.revenue || typeof body.revenue.enabled !== "boolean") throw new Error("unexpected revenue payload");
    return `enabled=${body.revenue.enabled} lastCycle=${body.revenue.lastCycleAt || "never"}`;
  }, { critical: false });

  await run("POST /api/acp (validation path)", async () => {
    const response = await fetch(`${baseUrl}/api/acp`, {
      method: "POST",
      headers,
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json();
    if (response.status !== 400 || body.error?.code !== "MISSING_JOB_ID") {
      throw new Error(`expected 400 MISSING_JOB_ID, got ${response.status} ${body.error?.code}`);
    }
    return "400 MISSING_JOB_ID";
  }, { critical: false });
}

const failed = results.filter((entry) => entry.ok === false).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
if (failed > 0 && process.exitCode !== 1) process.exitCode = 0;
