import { formatUnits, isAddress } from "viem";
import { BASE_TOKENS, ONCHAIN_EXECUTION_OFFERINGS, VIRTUALS, config, USDC, walletConfigured, isVercel } from "../config.js";
import { logger } from "../lib/logger.js";
import { store } from "../lib/store.js";
import {
  explorerAddress,
  getAgentAddress,
  getNativeBalance,
  getTokenBalance,
  publicClient,
  shortRpcError,
} from "../chain/client.js";
import { getPaymentToken } from "./escrow.js";
import { getQuote } from "./kyberswap.js";
import { getVirtualsAssetToken } from "./virtuals.js";
import { aiHealth } from "./ai.js";
import { offeringsPublicJSON } from "./offerings.js";
import { customCapabilityJSON } from "./custom.js";
import { probeDataProviders } from "./market.js";
import { gasUnlockStatus } from "./gas.js";
import { socialStatus } from "./social.js";
import { inboxStatus } from "./inbox.js";
import { outreachStatus } from "./outreach.js";
import { intakeStatus } from "./intake.js";
import { revenueStatus } from "./revenue.js";

let cache = { value: null, expiresAt: 0 };
let inFlight = null;

const withTimeout = (promise, ms, fallback) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve(fallback), ms))]);

async function checkRpc() {
  const started = Date.now();
  try {
    const [blockNumber, chainId] = await Promise.all([
      publicClient.getBlockNumber(),
      publicClient.getChainId(),
    ]);
    return {
      ok: Number(chainId) === config.chain.id,
      chainId: Number(chainId),
      expectedChainId: config.chain.id,
      blockNumber: String(blockNumber),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: shortRpcError(error) };
  }
}

async function checkEscrow() {
  if (!isAddress(config.acp.contract)) {
    return { configured: false, deployed: false, error: "ACP_CONTRACT_ADDRESS is invalid" };
  }
  const started = Date.now();
  try {
    const [code, paymentToken, escrowBalance] = await Promise.all([
      publicClient.getBytecode({ address: config.acp.contract }),
      getPaymentToken().catch(() => null),
      getTokenBalance(USDC.address, config.acp.contract).catch(() => null),
    ]);
    return {
      configured: true,
      contract: config.acp.contract,
      explorer: explorerAddress(config.acp.contract),
      deployed: Boolean(code && code !== "0x"),
      paymentToken,
      paymentTokenIsUsdc: paymentToken ? paymentToken.toLowerCase() === USDC.address.toLowerCase() : false,
      escrowUsdcBalance: escrowBalance === null ? null : formatUnits(escrowBalance, USDC.decimals),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return { configured: true, deployed: false, error: shortRpcError(error), latencyMs: Date.now() - started };
  }
}

async function checkKyber() {
  const started = Date.now();
  try {
    const quote = await getQuote({
      tokenIn: USDC.address,
      tokenOut: BASE_TOKENS.WETH.address,
      amountIn: 1_000_000n,
    });
    return {
      ok: true,
      latencyMs: Date.now() - started,
      sample: { pair: "USDC/WETH", amountIn: "1", amountOut: formatUnits(quote.amountOut, 18) },
    };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error.message, code: error.code };
  }
}

async function checkVirtuals() {
  try {
    const assetToken = await getVirtualsAssetToken();
    return { ok: true, router: VIRTUALS.router, bondingCurve: VIRTUALS.bondingCurve, assetToken };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkWallet() {
  if (!walletConfigured) {
    return { configured: false, address: null };
  }
  try {
    const address = getAgentAddress();
    const [usdc, eth] = await Promise.all([
      getTokenBalance(USDC.address, address),
      getNativeBalance(address),
    ]);
    return {
      configured: true,
      address,
      explorer: explorerAddress(address),
      usdc: formatUnits(usdc, USDC.decimals),
      eth: formatUnits(eth, 18),
      ethUnits: eth.toString(),
    };
  } catch (error) {
    return { configured: true, address: getAgentAddress(), error: shortRpcError(error) };
  }
}

async function collect() {
  const [rpc, escrow, kyber, virtuals, wallet, ai, providers, social, intake, outreach, inbox, revenue] = await Promise.all([
    withTimeout(checkRpc(), 6000, { ok: false, error: "timeout" }),
    withTimeout(checkEscrow(), 6000, { configured: true, deployed: false, error: "timeout" }),
    withTimeout(checkKyber(), 7000, { ok: false, error: "timeout" }),
    withTimeout(checkVirtuals(), 5000, { ok: false, error: "timeout" }),
    withTimeout(checkWallet(), 6000, { configured: walletConfigured, address: null, error: "timeout" }),
    withTimeout(aiHealth(), 9000, {
      groq: { configured: Boolean(config.ai.groqApiKey), reachable: false },
      gemini: { configured: Boolean(config.ai.geminiApiKey), reachable: false },
    }),
    withTimeout(probeDataProviders(), 8000, {
      coingecko: { ok: false, error: "timeout" },
      geckoterminal: { ok: false, error: "timeout" },
      binance: { ok: false, error: "timeout" },
      defillama: { ok: false, error: "timeout" },
    }),
    withTimeout(socialStatus(), 2500, {
      enabled: config.social.enabled,
      status: "timeout",
      x: { configured: false, mode: "unknown" },
    }),
    withTimeout(intakeStatus(), 2500, {
      enabled: config.intake.enabled,
      status: "timeout",
      lastRun: null,
    }),
    withTimeout(outreachStatus(), 2500, {
      enabled: config.outreach.enabled,
      status: "timeout",
      state: null,
    }),
    withTimeout(inboxStatus(), 2500, {
      total: 0,
      last24h: 0,
      status: "timeout",
      recent: [],
    }),
    withTimeout(revenueStatus(), 3500, {
      enabled: config.revenue.enabled,
      pricing: null,
      subscriptions: null,
      referrals: null,
      status: "timeout",
    }),
  ]);

  const gasUnlock = await withTimeout(
    gasUnlockStatus({ ethBalance: wallet?.ethUnits ? BigInt(wallet.ethUnits) : null }),
    5000,
    null
  );

  const aiReady = Boolean(config.ai.groqApiKey || config.ai.geminiApiKey);
  const marketOk = Boolean(providers.coingecko?.ok || providers.geckoterminal?.ok || providers.binance?.ok);
  const intelMarketReady = aiReady && marketOk;
  const intelOnchainReady = aiReady && marketOk && rpc.ok;
  const yieldReady = aiReady && Boolean(providers.defillama?.ok);

  const gasGated = wallet.configured && (gasUnlock ? !gasUnlock.unlocked : wallet.ethUnits === "0");

  const readiness = {
    token_swap: rpc.ok && wallet.configured && (kyber.ok || virtuals.ok) && !gasGated,
    transfer_token: rpc.ok && wallet.configured && !gasGated,
    fund_startup: rpc.ok && wallet.configured && !gasGated,
    semi_batch_fund_startup: rpc.ok && wallet.configured && !gasGated,
    batch_fund_startup: rpc.ok && wallet.configured && !gasGated,
    resolve_tokens: rpc.ok,
    suggest_a_trade: intelOnchainReady,
    mega_report: intelMarketReady,
    twitter_alpha: aiReady,
    crypto_news: aiReady && config.intelligence.newsFeeds.length > 0,
    topic_research: aiReady,
    yield_alpha: yieldReady,
    kol_alpha: aiReady,
    trending_tokens: intelMarketReady,
    token_info: intelOnchainReady,
    token_alpha: intelOnchainReady,
    deep_analytics: intelOnchainReady,
    intel_retainer: intelMarketReady && wallet.configured,
    flash_alert: rpc.ok && marketOk,
    gas_advisor: rpc.ok,
    yield_radar: Boolean(providers.defillama?.ok),
    agent_credit: rpc.ok,
    token_security_scan: rpc.ok && marketOk,
    wallet_risk_audit: rpc.ok,
    liquidation_guard: rpc.ok && marketOk && wallet.configured,
    new_pool_radar: marketOk && wallet.configured,
    smart_money_flow: rpc.ok && marketOk && wallet.configured,
    batch_executor: rpc.ok && wallet.configured && !gasGated,
    agent_revenue_audit: rpc.ok,
    provider_benchmark: rpc.ok,
    virtuals_alpha: marketOk,
    job_radar: rpc.ok,
    macro_brief: marketOk,
    market_movers: marketOk,
    sector_rotation: marketOk,
    defi_tvl_report: Boolean(providers.defillama?.ok),
    sentiment_pulse: Boolean(providers.binance?.ok),
    news_wire: config.intelligence.newsFeeds.length > 0,
    regulatory_radar: config.intelligence.newsFeeds.length > 0,
    funding_radar: config.intelligence.newsFeeds.length > 0,
    volatility_screen: Boolean(providers.binance?.ok),
    correlation_matrix: Boolean(providers.binance?.ok),
    stablecoin_monitor: marketOk,
    liquidity_map: marketOk,
    token_compare: marketOk,
    portfolio_heatmap: marketOk,
    signal_digest: marketOk && config.intelligence.newsFeeds.length > 0,
    trend_velocity: Boolean(providers.binance?.ok),
    ai_agents_radar: rpc.ok && marketOk,
    gas_forecast: rpc.ok,
  };

  const storeReady = !isVercel || store.type === "upstash";
  const escrowReady = escrow.deployed && escrow.paymentTokenIsUsdc && wallet.configured;
  const ok = rpc.ok && escrowReady && storeReady;

  return {
    status: ok ? "ok" : "degraded",
    ready: ok,
    agent: {
      name: config.name,
      slug: config.slug,
      description: config.description,
      version: config.version,
      environment: config.env,
      acpAgentId: config.acp.agentId || null,
      publicBaseUrl: config.publicBaseUrl || null,
      wallet: wallet.address,
      address: wallet.address,
      chainId: config.chain.id,
      chain: config.chain.name,
    },
    acp: {
      protocol: "virtuals-acp",
      escrowReady,
      escrowVerification: "onchain_getJob",
      minEscrowWindowSeconds: config.acp.minEscrowWindowSeconds,
      autoSubmitDeliverable: config.acp.autoSubmitDeliverable,
    },
    a2a: {
      enabled: config.a2a.enabled,
      endpoint: "/a2a",
      cardPath: "/.well-known/agent-card.json",
      legacyCardPath: "/.well-known/agent.json",
      streaming: false,
    },
    services: {
      baseRpc: rpc,
      acpEscrow: escrow,
      kyberswap: kyber,
      virtualsRouter: virtuals,
      wallet,
      groq: ai.groq,
      gemini: ai.gemini,
      aiOrder: ai.order || ["groq", "gemini"],
      aiRouting: ai.routing || { json: "groq", grounding: "gemini", articles: "gemini" },
      intelligence: {
        ready: aiReady,
        providers,
        twitter: {
          configured: Boolean(config.intelligence.twitterBearerToken),
          kolHandles: config.intelligence.kolHandles.length,
        },
        newsFeeds: config.intelligence.newsFeeds.length,
        cacheTtlMs: config.intelligence.cacheTtlMs,
      },
      social: {
        enabled: social.enabled,
        configured: Boolean(social.x?.configured),
        mode: social.x?.mode || "none",
        lastPublishedAt: social.lastPublishedAt || null,
        lastError: social.lastError || null,
        publishedToday: social.publishedToday ?? 0,
        maxPostsPerDay: social.maxPostsPerDay,
        nextRunAt: social.nextRunAt || null,
        totalPublished: social.totalPublished ?? 0,
      },
      intake,
      outreach: {
        enabled: outreach.enabled,
        aiConfigured: outreach.aiConfigured,
        publicBaseUrlConfigured: outreach.publicBaseUrlConfigured,
        driver: outreach.driver,
        dailyCap: outreach.dailyCap,
        pitchedToday: outreach.state?.pitchedToday ?? 0,
        lastAttemptAt: outreach.state?.lastAttemptAt || null,
        lastError: outreach.state?.lastError || null,
        optOuts: outreach.optOuts ?? 0,
      },
      inbox: {
        total: inbox.total ?? 0,
        last24h: inbox.last24h ?? 0,
        lastAt: inbox.lastAt || null,
      },
      revenue: {
        enabled: config.revenue.enabled,
        driver: revenue.driver || (isVercel ? "vercel_cron" : "local_loop"),
        intervalSeconds: config.revenue.intervalSeconds,
        referralBps: config.revenue.referralBps,
        referralMaxUsdc: config.revenue.referralMaxUsdc,
        quoteTtlSeconds: config.revenue.quoteTtlSeconds,
        happyHour: {
          startUtcHour: config.revenue.happyHourStartUtc,
          endUtcHour: config.revenue.happyHourEndUtc,
          discountBps: config.revenue.happyHourDiscountBps,
          active: revenue.pricing?.active ?? null,
        },
        lastCycleAt: revenue.lastCycleAt || null,
        lastError: revenue.lastError || null,
        activeSubscriptions: revenue.subscriptions?.active ?? null,
        referralQueue: revenue.referrals?.queued ?? null,
      },
      store: {
        type: store.type,
        durable: store.type === "upstash",
        ...(isVercel && store.type === "memory"
          ? { warning: "Ephemeral on Vercel. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN." }
          : {}),
      },
    },
    offerings: offeringsPublicJSON().map((offering) => ({
      ...offering,
      ready: Boolean(readiness[offering.offering_id]),
    })),
    customTask: customCapabilityJSON(),
    endpoints: {
      health: { method: "GET", path: "/api/health" },
      offerings: { method: "GET", path: "/api/offerings" },
      custom: { method: "GET", path: "/api/custom" },
      chat: { method: "POST", path: "/api/chat" },
      acp: { method: "POST", path: "/api/acp" },
      jobStatus: { method: "GET", path: "/api/jobs/:jobId" },
      intake: { method: "GET", path: "/api/intake" },
      cronIntake: { method: "GET", path: "/api/cron/intake" },
      cronSweep: { method: "GET", path: "/api/cron/sweep" },
      social: { method: "GET", path: "/api/social" },
      cronSocial: { method: "GET", path: "/api/cron/social" },
      a2a: { method: "POST", path: "/a2a" },
      agentCard: { method: "GET", path: "/.well-known/agent-card.json" },
      inbox: { method: "GET", path: "/api/a2a/inbox" },
      outreach: { method: "GET", path: "/api/outreach" },
      cronOutreach: { method: "GET", path: "/api/cron/outreach" },
      pricing: { method: "GET", path: "/api/pricing" },
      quote: { method: "POST", path: "/api/quote" },
      revenue: { method: "GET", path: "/api/revenue" },
      revenueSubscriptions: { method: "GET", path: "/api/revenue/subscriptions" },
      revenueReferrals: { method: "GET", path: "/api/revenue/referrals" },
      cronRevenue: { method: "GET", path: "/api/cron/revenue" },
    },
    execution: {
      defaultSlippageBps: config.execution.defaultSlippageBps,
      maxSlippageBps: config.execution.maxSlippageBps,
      txMaxAttempts: config.execution.maxAttempts,
      slaSeconds: config.execution.slaSeconds,
      donationMarginBps: config.revenue.donationMarginBps,
      onchainGasGated: wallet.configured ? gasGated : null,
      onchainOfferings: [...ONCHAIN_EXECUTION_OFFERINGS],
      gasUnlock: gasUnlock
        ? {
            minUsd: gasUnlock.minUsd,
            ethUsd: gasUnlock.ethUsd,
            ethUsdSource: gasUnlock.ethUsdSource,
            thresholdWei: gasUnlock.thresholdWei.toString(),
            thresholdEth: gasUnlock.thresholdEth,
            balanceEth: gasUnlock.balanceEth,
            unlocked: gasUnlock.unlocked,
          }
        : null,
    },
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  };
}

export async function buildHealth({ force = false } = {}) {
  if (!force && cache.value && cache.expiresAt > Date.now()) return cache.value;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const value = await collect();
      cache = { value, expiresAt: Date.now() + 25_000 };
      return value;
    } catch (error) {
      logger.error("health collection failed", { message: error.message });
      return {
        status: "degraded",
        ready: false,
        error: error.message,
        agent: { name: config.name, version: config.version },
        offerings: offeringsPublicJSON(),
        timestamp: new Date().toISOString(),
      };
    }
  })();

  try {
    return await inFlight;
  } finally {
    inFlight = null;
  }
}
