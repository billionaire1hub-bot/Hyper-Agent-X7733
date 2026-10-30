import { getAddress, isAddress, parseUnits } from "viem";
import { config, USDC } from "../config.js";
import { AppError } from "../lib/errors.js";

const usdcUnits = (amount) => parseUnits(String(amount), USDC.decimals);

const ADDRESS_PARAM = (name, description) => ({
  name,
  type: "address",
  required: true,
  description,
});

/**
 * Competitive price book. The benchmarks are supplied by the operator on
 * 2026-10-28 and are not independently verified; the agent never scrapes or
 * guesses a competitor price. COMPETITOR_UNDERCUT_BPS is the hard rule: no
 * listed, quoted, escrowed or pitched price may exceed this share of the
 * declared benchmark (5000 bps = 50% of it, i.e. a 50% undercut).
 */
export const COMPETITOR_UNDERCUT_BPS = 5000;
export const COMPETITOR_BENCHMARK_SOURCE = "operator-supplied 2026-10-28";

export const COMPETITOR_BENCHMARKS = Object.freeze({
  token_swap: { competitor: "Nox/Capminal", product: "token swap", benchmarkUsdc: 0.05 },
  transfer_token: { competitor: "Capminal", product: "ERC20 transfer", benchmarkUsdc: 0.1 },
  fund_startup: { competitor: "Capminal", product: "fund_sample", benchmarkUsdc: 10 },
  semi_batch_fund_startup: { competitor: "Capminal", product: "semi_batch_fund_startup", benchmarkUsdc: 50 },
  batch_fund_startup: { competitor: "Capminal", product: "batch_fund_startup", benchmarkUsdc: 100 },
  suggest_a_trade: { competitor: "Otto AI", product: "trade suggestion", benchmarkUsdc: 0.1 },
  mega_report: { competitor: "Otto AI", product: "market report", benchmarkUsdc: 0.05 },
  twitter_alpha: { competitor: "Otto AI", product: "twitter pulse", benchmarkUsdc: 0.01 },
  crypto_news: { competitor: "Otto AI", product: "crypto news", benchmarkUsdc: 0.01 },
  topic_research: { competitor: "Otto AI", product: "topic research", benchmarkUsdc: 0.01 },
  yield_alpha: { competitor: "Otto AI", product: "yield alpha", benchmarkUsdc: 0.01 },
  kol_alpha: { competitor: "Otto AI", product: "KOL alpha", benchmarkUsdc: 0.01 },
  trending_tokens: { competitor: "Otto AI", product: "trending tokens", benchmarkUsdc: 0.01 },
  token_info: { competitor: "Otto AI", product: "token metrics", benchmarkUsdc: 0.01 },
  token_alpha: { competitor: "Otto AI", product: "token alpha", benchmarkUsdc: 0.01 },
});

const roundUsdcAmount = (value) => Number(Number(value).toFixed(6));
const formatUsdcAmount = (value) => (value >= 1 ? value.toFixed(2) : String(Number(value.toFixed(6))));

export function competitorCeilingUsdc(offeringId) {
  const benchmark = COMPETITOR_BENCHMARKS[String(offeringId ?? "").toLowerCase()];
  if (!benchmark) return null;
  return roundUsdcAmount((benchmark.benchmarkUsdc * (10_000 - COMPETITOR_UNDERCUT_BPS)) / 10_000);
}

export function competitorPosition(offeringId, priceUsdc) {
  const key = String(offeringId ?? "").toLowerCase();
  const benchmark = COMPETITOR_BENCHMARKS[key];
  const ceiling = competitorCeilingUsdc(key);
  if (!benchmark || ceiling === null) return null;
  const ours = Number(priceUsdc);
  if (!Number.isFinite(ours) || ours <= 0) return null;
  return {
    competitor: benchmark.competitor,
    product: benchmark.product,
    benchmarkUsdc: roundUsdcAmount(benchmark.benchmarkUsdc),
    maxPriceUsdc: ceiling,
    ourPriceUsdc: roundUsdcAmount(ours),
    undercutBps: Math.round((1 - ours / benchmark.benchmarkUsdc) * 10_000),
    savingsUsdc: roundUsdcAmount(benchmark.benchmarkUsdc - ours),
    savingsPct: Number(((1 - ours / benchmark.benchmarkUsdc) * 100).toFixed(2)),
    rule: `never above ${100 - COMPETITOR_UNDERCUT_BPS / 100}% of the declared benchmark`,
    benchmarkSource: COMPETITOR_BENCHMARK_SOURCE,
    benchmarkVerified: false,
  };
}


export const OFFERINGS = [
  {
    id: "token_swap",
    name: "Universal Token Swap on Base",
    description:
      "Universal token swap on Base via KyberSwap AMM & Virtuals bonding router. Native composite USDC paths handled automatically with auto-refund SLA. Priced 50% below Nox and Capminal.",
    priceUsdc: "0.025",
    comparison: "50% lower than Nox/Capminal",
    slaSeconds: config.execution.slaSeconds,
    category: "trading",
    params: [
      { name: "sellToken", type: "string", required: true, description: "Symbol (USDC, WETH, VIRTUAL) or Base contract address." },
      { name: "buyToken", type: "string", required: true, description: "Symbol or Base contract address." },
      { name: "amount", type: "string", required: true, description: "Amount of sellToken in human units, e.g. \"25.5\"." },
      { name: "maxSlippage", type: "number", required: false, default: 3, description: "Slippage tolerance in percent (0.1 - 20). Default 3%." },
    ],
  },
  {
    id: "transfer_token",
    name: "ERC20 Transfer on Base",
    description:
      "Transfer ERC20 tokens on Base to a target address after ACP escrow verification. Priced 50% below Capminal.",
    priceUsdc: "0.05",
    comparison: "50% lower than Capminal",
    slaSeconds: config.execution.slaSeconds,
    category: "payments",
    params: [
      ADDRESS_PARAM("tokenAddress", "ERC20 contract address on Base."),
      ADDRESS_PARAM("targetAddress", "Recipient address."),
      { name: "amount", type: "string", required: true, description: "Amount in human units." },
    ],
  },
  {
    id: "fund_startup",
    name: "Startup Micro-Donation",
    description:
      "Micro-donation support for newly launched projects. Of the 5.00 USDC, a minimum 20% service margin is retained by the agent and the remainder is forwarded on-chain to the project treasury. Priced 50% below Capminal's $10.",
    priceUsdc: "5.00",
    comparison: "50% lower than Capminal's $10",
    slaSeconds: config.execution.slaSeconds,
    category: "funding",
    params: [
      ADDRESS_PARAM("projectAddress", "USDC treasury address of the startup."),
      { name: "memo", type: "string", required: false, description: "Optional note recorded in the deliverable." },
    ],
  },
  {
    id: "semi_batch_fund_startup",
    name: "Semi-Batch Startup Donation",
    description:
      "Semi-batch startup support donation split across 2-3 projects. Of the 25.00 USDC, a minimum 20% service margin is retained by the agent and the remainder is forwarded on-chain. Priced 50% below Capminal's $50.",
    priceUsdc: "25.00",
    comparison: "50% lower than Capminal's $50",
    slaSeconds: config.execution.slaSeconds,
    category: "funding",
    params: [
      {
        name: "projects",
        type: "address[]",
        required: true,
        description: "2-3 project treasury addresses. USDC is split equally (remainder to the first).",
      },
      { name: "memo", type: "string", required: false, description: "Optional note recorded in the deliverable." },
    ],
  },
  {
    id: "batch_fund_startup",
    name: "Batch Startup Donation Suite",
    description:
      "Full batch startup donation suite split across 4-10 projects. Of the 50.00 USDC, a minimum 20% service margin is retained by the agent and the remainder is forwarded on-chain. Priced 50% below Capminal's $100.",
    priceUsdc: "50.00",
    comparison: "50% lower than Capminal's $100",
    slaSeconds: config.execution.slaSeconds,
    category: "funding",
    params: [
      {
        name: "projects",
        type: "address[]",
        required: true,
        description: "4-10 project treasury addresses. USDC is split equally (remainder to the first).",
      },
      { name: "memo", type: "string", required: false, description: "Optional note recorded in the deliverable." },
    ],
  },
  {
    id: "resolve_tokens",
    name: "Token Symbol Resolution",
    description:
      "Converts symbols (USDC, WETH) to verified Base contract addresses using the registry plus live on-chain metadata and DexScreener liquidity checks.",
    priceUsdc: "0.001",
    comparison: "Flat micro-fee",
    slaSeconds: config.execution.slaSeconds,
    category: "data",
    params: [
      {
        name: "tokens",
        type: "string[]",
        required: true,
        description: "1-10 symbols or addresses to resolve, e.g. [\"USDC\", \"WETH\"].",
      },
    ],
  },
  {
    id: "suggest_a_trade",
    name: "AI Trade Suggestion",
    description:
      "High-conviction AI trade suggestions with Technical Analysis, derivatives indicators, scientific risk parameters and one-click execution params. Priced 50% below the 0.10 USDC market rate.",
    priceUsdc: "0.05",
    comparison: "50% lower than Otto AI's 0.10",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "token", type: "string", required: true, description: "Base token symbol or address, e.g. VIRTUAL or BTC." },
      { name: "timeframe", type: "string", required: false, default: "4h", description: "15m, 1h, 4h or 1d. Default 4h." },
      { name: "side", type: "string", required: false, default: "auto", description: "auto, long or short. Default auto." },
      { name: "capitalUsdc", type: "number", required: false, description: "Optional capital in USDC used for position sizing." },
      { name: "riskPercent", type: "number", required: false, default: 1, description: "Risk per trade as percent of capital (0.1-5)." },
    ],
  },
  {
    id: "mega_report",
    name: "Mega Market Intelligence Report",
    description:
      "Daily crypto market intelligence briefing combining top headlines, Twitter sentiment, KOL alpha, trending altcoins and yield opportunities. Priced 50% below the 0.05 USDC market rate.",
    priceUsdc: "0.025",
    comparison: "50% lower than Otto AI's 0.05",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [],
  },
  {
    id: "twitter_alpha",
    name: "Twitter Alpha Pulse",
    description:
      "Quick Twitter pulse check, breaking news, trending narratives and sentiment shifts at a glance. Priced 50% below the 0.01 USDC market rate.",
    priceUsdc: "0.005",
    comparison: "50% lower than Otto AI's 0.01",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "topic", type: "string", required: false, description: "Optional topic, token or keyword (max 60 chars)." },
    ],
  },
  {
    id: "crypto_news",
    name: "Real-Time Crypto News",
    description:
      "Real-time crypto market news with importance-ranked headlines and sentiment analysis. Priced 50% below the 0.01 USDC market rate.",
    priceUsdc: "0.005",
    comparison: "50% lower than Otto AI's 0.01",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "query", type: "string", required: false, description: "Optional keyword or token filter (max 60 chars)." },
      { name: "limit", type: "number", required: false, default: 8, description: "Headlines to return (1-20). Default 8." },
    ],
  },
  {
    id: "topic_research",
    name: "AI Topic Research",
    description:
      "AI-filtered crypto news and social search results for non-token crypto topics (airdrops, DeFi trends, protocols). Priced 50% below the 0.01 USDC market rate.",
    priceUsdc: "0.005",
    comparison: "50% lower than Otto AI's 0.01",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "query", type: "string", required: true, description: "Research topic, e.g. \"Base airdrop farming\" (2-160 chars)." },
    ],
  },
  {
    id: "yield_alpha",
    name: "DeFi Yield Alpha",
    description:
      "Best DeFi yield opportunities across stablecoins, ETH and BTC with risk ratings and APY comparisons. Priced 50% below the 0.01 USDC market rate.",
    priceUsdc: "0.005",
    comparison: "50% lower than Otto AI's 0.01",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "assetClass", type: "string", required: false, default: "any", description: "any, stable, eth or btc. Default any." },
      { name: "minTvlUsd", type: "number", required: false, description: "Minimum pool TVL in USD (default 5,000,000)." },
    ],
  },
  {
    id: "kol_alpha",
    name: "KOL Alpha Aggregator",
    description:
      "Alpha signals and token picks aggregated from top Key Opinion Leaders (KOLs) on Web3 social platforms. Priced 50% below the 0.01 USDC market rate.",
    priceUsdc: "0.005",
    comparison: "50% lower than Otto AI's 0.01",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "focus", type: "string", required: false, description: "Optional token or topic to focus the aggregation (max 60 chars)." },
    ],
  },
  {
    id: "trending_tokens",
    name: "Trending Tokens Scanner",
    description:
      "Scours social data and news to identify top trending tokens with high momentum. Priced 50% below the 0.01 USDC market rate.",
    priceUsdc: "0.005",
    comparison: "50% lower than Otto AI's 0.01",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "limit", type: "number", required: false, default: 8, description: "Tokens to return (1-15). Default 8." },
    ],
  },
  {
    id: "token_info",
    name: "Token Metrics Deep Dive",
    description:
      "Deep coin and token metrics analysis (price, supply, volume, market cap and contract validation). Priced 50% below the 0.01 USDC market rate.",
    priceUsdc: "0.005",
    comparison: "50% lower than Otto AI's 0.01",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "token", type: "string", required: true, description: "Base token symbol or contract address." },
    ],
  },
  {
    id: "token_alpha",
    name: "Token Intelligence Alpha",
    description:
      "Real-time token intelligence combining price metrics, news, Twitter sentiment and futures market data. Priced 50% below the 0.01 USDC market rate.",
    priceUsdc: "0.005",
    comparison: "50% lower than Otto AI's 0.01",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "token", type: "string", required: true, description: "Base token symbol or contract address." },
      { name: "timeframe", type: "string", required: false, default: "4h", description: "15m, 1h, 4h or 1d. Default 4h." },
    ],
  },
  {
    id: "deep_analytics",
    name: "Deep On-Chain Analytics & Risk Report",
    description:
      "Tiered deep report: live Base pool data, candles, technical indicators, derivatives positioning, honeypot/tax security checks and an AI risk synthesis. Standard 5.00, Pro 10.00, Enterprise 15.00 USDC.",
    priceUsdc: "5.00",
    comparison: "Tiered 5-15 USDC vs flat competitor research fees",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "target", type: "string", required: true, description: "Base token symbol or contract address (1-42 chars)." },
      { name: "depth", type: "string", required: false, default: "standard", description: "standard (5.00), pro (10.00) or enterprise (15.00) USDC." },
      { name: "timeframe", type: "string", required: false, default: "4h", description: "15m, 1h, 4h or 1d. Default 4h." },
      { name: "includeSecurity", type: "boolean", required: false, default: true, description: "Include honeypot and buy/sell tax checks. Default true." },
      { name: "capitalUsdc", type: "number", required: false, description: "Optional capital in USDC used for position sizing." },
    ],
  },
  {
    id: "intel_retainer",
    name: "Daily Intelligence Retainer",
    description:
      "Weekly (50.00) or monthly (100.00) USDC retainer. The agent pushes a daily live market, news, gas and yield feed to your public A2A endpoint. Renewal requires a new funded ACP job; nothing auto-debits.",
    priceUsdc: "50.00",
    comparison: "Retainer 50-100 USDC vs per-report pricing",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "plan", type: "string", required: false, default: "weekly", description: "weekly (50.00) or monthly (100.00) USDC." },
      { name: "endpoint", type: "string", required: true, description: "Public HTTPS A2A endpoint that accepts message/send JSON-RPC." },
      { name: "topics", type: "string[]", required: false, description: "Optional focus topics, up to 5." },
      { name: "alerts", type: "boolean", required: false, default: true, description: "Also push threshold arbitrage/whale alerts when detected. Default true." },
    ],
  },
  {
    id: "flash_alert",
    name: "Flash Arbitrage & Whale Alerts",
    description:
      "Instant micro-paid alert scan for live Base DEX arbitrage spreads and large USDC/WETH transfers. Only observed alerts are returned; an empty result is reported honestly.",
    priceUsdc: "3.00",
    comparison: "Micro-alert pricing for trading agents",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "types", type: "string[]", required: false, description: "Subset of arbitrage, whale. Default both." },
      { name: "watchlist", type: "string[]", required: false, description: "Optional token symbols or addresses to filter, up to 10." },
      { name: "limit", type: "number", required: false, default: 6, description: "Maximum alerts to return (1-10). Default 6." },
    ],
  },
  {
    id: "gas_advisor",
    name: "Base Gas Optimization Advisor",
    description:
      "Live Base gas read with an 8-block trend, estimated cost for your transaction type and routing advice. Useful during congestion; absolute fees on Base L2 are small.",
    priceUsdc: "1.00",
    comparison: "Micro-fee gas routing advice",
    slaSeconds: config.execution.slaSeconds,
    category: "data",
    params: [
      { name: "txType", type: "string", required: false, default: "swap", description: "transfer, swap or contract. Default swap." },
      { name: "urgency", type: "string", required: false, default: "now", description: "now or cheapest. Default now." },
    ],
  },
  {
    id: "yield_radar",
    name: "Cross-Chain Yield & Liquidity Radar",
    description:
      "Scans live DefiLlama yield pools and ranks Base opportunities by APY against the Base median and p90, with TVL, IL risk and reward-split detail.",
    priceUsdc: "2.50",
    comparison: "Yield-gap radar for liquidity agents",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "assetClass", type: "string", required: false, default: "any", description: "any, stable, eth or btc. Default any." },
      { name: "minApy", type: "number", required: false, default: 8, description: "Minimum APY percent (0-1000). Default 8." },
      { name: "minTvlUsd", type: "number", required: false, description: "Minimum pool TVL in USD (min 100,000)." },
    ],
  },
  {
    id: "agent_credit",
    name: "Autonomous Agent Credit Score",
    description:
      "Paid reputation assessment for any Base ACP agent: scanned on-chain job history, completion and rejection rates, settled volume, recency, plus live ETH/USDC balances and nonce.",
    priceUsdc: "2.00",
    comparison: "Agent credit scoring for counterparty checks",
    slaSeconds: config.execution.slaSeconds,
    category: "data",
    params: [
      ADDRESS_PARAM("address", "Agent wallet address to score on Base."),
    ],
  },
  {
    id: "token_security_scan",
    name: "Token Security & Liquidity Scan",
    description:
      "Live Base token security review: honeypot simulation, buy/sell tax, contract source and proxy flags, holder count, pool liquidity, age and DEX coverage. 1.00 USDC per token, 8.00 USDC for a 10-token bundle.",
    priceUsdc: "1.00",
    comparison: "1 USDC/token, 8 USDC bundle of 10",
    slaSeconds: config.execution.slaSeconds,
    category: "security",
    params: [
      {
        name: "tokens",
        type: "string[]",
        required: true,
        description: "1-10 Base token symbols or contract addresses to scan.",
      },
    ],
  },
  {
    id: "wallet_risk_audit",
    name: "Wallet Risk Audit",
    description:
      "Live Base wallet review: native and ERC20 balances, nonce, contract-vs-EOA status, ACP job history, completion and rejection rates, settled volume and counterparty risk scoring.",
    priceUsdc: "2.00",
    comparison: "Wallet due-diligence for trading and ACP counterparties",
    slaSeconds: config.execution.slaSeconds,
    category: "security",
    params: [
      ADDRESS_PARAM("address", "Wallet address to audit on Base."),
      {
        name: "watchTokens",
        type: "string[]",
        required: false,
        description: "Optional symbols or addresses whose balances should be included (max 8).",
      },
    ],
  },
  {
    id: "liquidation_guard",
    name: "Liquidation Guard Retainer",
    description:
      "24/7 Base collateral monitor: watches up to 10 position tokens against live pool prices and liquidity, and pushes drawdown alerts to your A2A endpoint. 25.00 USDC weekly or 80.00 USDC monthly; renewal requires a new funded ACP job.",
    priceUsdc: "25.00",
    comparison: "25 USDC/week or 80 USDC/month",
    slaSeconds: config.execution.slaSeconds,
    category: "risk",
    params: [
      { name: "plan", type: "string", required: false, default: "weekly", description: "weekly (25.00) or monthly (80.00) USDC." },
      { name: "endpoint", type: "string", required: true, description: "Public HTTPS A2A endpoint that accepts message/send JSON-RPC." },
      {
        name: "positions",
        type: "string[]",
        required: true,
        description: "1-10 collateral or debt token symbols/addresses to monitor.",
      },
      { name: "thresholdPct", type: "number", required: false, default: 8, description: "24h drawdown percent that triggers an alert (1-50). Default 8." },
    ],
  },
  {
    id: "new_pool_radar",
    name: "New Base Pool Radar",
    description:
      "Live GeckoTerminal scan of newly created Base pools with liquidity, volume, age and DEX coverage filters. 1.50 USDC per scan or 25.00 USDC monthly retainer with a daily push.",
    priceUsdc: "1.50",
    comparison: "1.50 USDC/scan or 25 USDC/month",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "plan", type: "string", required: false, default: "once", description: "once (1.50) or monthly (25.00) USDC." },
      { name: "endpoint", type: "string", required: false, description: "Public HTTPS A2A endpoint; required when plan is monthly." },
      { name: "minLiquidityUsd", type: "number", required: false, description: "Minimum pool liquidity in USD (default 25,000)." },
      { name: "maxAgeHours", type: "number", required: false, default: 48, description: "Only pools created within this many hours (1-168). Default 48." },
      { name: "limit", type: "number", required: false, default: 8, description: "Pools to return (1-10). Default 8." },
    ],
  },
  {
    id: "smart_money_flow",
    name: "Smart Money Flow Alerts",
    description:
      "Live Base transfer-log scan for large USDC, WETH and watchlist token movements, classified against known DEX pools and routers. 2.00 USDC per scan or 30.00 USDC monthly retainer.",
    priceUsdc: "2.00",
    comparison: "2 USDC/scan or 30 USDC/month",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "plan", type: "string", required: false, default: "once", description: "once (2.00) or monthly (30.00) USDC." },
      { name: "endpoint", type: "string", required: false, description: "Public HTTPS A2A endpoint; required when plan is monthly." },
      { name: "watchlist", type: "string[]", required: false, description: "Optional token symbols/addresses to watch (max 10)." },
      { name: "minUsd", type: "number", required: false, description: "Minimum transfer size in USD (default 50,000)." },
      { name: "lookbackBlocks", type: "number", required: false, description: "Base blocks to scan (10-200). Default 40." },
      { name: "limit", type: "number", required: false, default: 6, description: "Alerts to return (1-10). Default 6." },
    ],
  },
  {
    id: "batch_executor",
    name: "Batch USDC Payout Executor",
    description:
      "Execute up to 20 USDC payouts on Base in one paid job, each verified by recipient balance change and settled on-chain. 1.00 USDC base + 0.05% of total volume.",
    priceUsdc: "1.00",
    comparison: "1 USDC + 5 bps of batch volume",
    slaSeconds: config.execution.slaSeconds,
    category: "payments",
    params: [
      {
        name: "transfers",
        type: "object[]",
        required: true,
        description: "2-20 entries of { targetAddress, amount } in USDC human units.",
      },
      { name: "memo", type: "string", required: false, description: "Optional note recorded in the deliverable." },
    ],
  },
  {
    id: "agent_revenue_audit",
    name: "Agent Revenue & Performance Audit",
    description:
      "Provider-side ACP revenue audit: completed and rejected jobs, settled USDC volume, unique clients, average job size, 30-day run rate, top clients and live wallet balances.",
    priceUsdc: "5.00",
    comparison: "Revenue due-diligence for ACP providers",
    slaSeconds: config.execution.slaSeconds,
    category: "analytics",
    params: [
      ADDRESS_PARAM("address", "ACP provider wallet address to audit on Base."),
    ],
  },
  {
    id: "provider_benchmark",
    name: "ACP Provider Leaderboard",
    description:
      "Live on-chain benchmark of ACP providers: completed jobs, rejected and expired counts, settled USDC volume, unique clients and last activity, ranked from recent Base ACP job history.",
    priceUsdc: "3.00",
    comparison: "Live provider leaderboard for buyer agents",
    slaSeconds: config.execution.slaSeconds,
    category: "analytics",
    params: [
      { name: "limit", type: "number", required: false, default: 8, description: "Providers to return (1-15). Default 8." },
      { name: "minCompleted", type: "number", required: false, default: 1, description: "Minimum completed jobs to be ranked (0-1000). Default 1." },
    ],
  },
  {
    id: "virtuals_alpha",
    name: "Virtuals Ecosystem Alpha",
    description:
      "Virtuals Protocol intelligence: live VIRTUAL price and market metrics, Base pool liquidity, trending coins, Virtuals news and live ACP ecosystem activity, with an optional AI synthesis.",
    priceUsdc: "2.00",
    comparison: "Ecosystem alpha for Virtuals agents",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "token", type: "string", required: false, description: "Virtuals-related token symbol or address. Default VIRTUAL." },
      { name: "timeframe", type: "string", required: false, default: "4h", description: "15m, 1h, 4h or 1d. Default 4h." },
      { name: "includeEcosystem", type: "boolean", required: false, default: true, description: "Include live ACP job activity and trending coins. Default true." },
    ],
  },
  {
    id: "job_radar",
    name: "ACP Job Lead Radar",
    description:
      "Scans recent on-chain ACP jobs and returns open or funded jobs this agent does not own, filtered by minimum budget and keywords. 2.00 USDC per scan or 30.00 USDC monthly retainer.",
    priceUsdc: "2.00",
    comparison: "2 USDC/scan or 30 USDC/month",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "plan", type: "string", required: false, default: "once", description: "once (2.00) or monthly (30.00) USDC." },
      { name: "endpoint", type: "string", required: false, description: "Public HTTPS A2A endpoint; required when plan is monthly." },
      { name: "minBudgetUsdc", type: "number", required: false, description: "Minimum job budget in USDC (default 0.5)." },
      { name: "keywords", type: "string[]", required: false, description: "Optional description keywords to match (max 5)." },
      { name: "statuses", type: "string[]", required: false, description: "Subset of open, funded. Default both." },
      { name: "limit", type: "number", required: false, default: 8, description: "Leads to return (1-15). Default 8." },
    ],
  },
  {
    id: "macro_brief",
    name: "Macro Market Brief",
    description:
      "Zero-gas macro snapshot: global crypto market cap and dominance, live ETH price, BTC and ETH derivatives posture (funding, open interest, long/short) plus optional AI synthesis.",
    priceUsdc: "0.02",
    comparison: "Live macro data snapshot, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [],
  },
  {
    id: "market_movers",
    name: "Market Movers",
    description:
      "Zero-gas ranking of major assets by 24h change, volume and market cap from live CoinGecko markets, with optional AI commentary.",
    priceUsdc: "0.015",
    comparison: "Live movers ranking, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "limit", type: "number", required: false, default: 10, description: "Assets to return (1-10). Default 10." },
    ],
  },
  {
    id: "sector_rotation",
    name: "Sector Rotation Scanner",
    description:
      "Zero-gas sector momentum: CoinGecko categories ranked by 24h change and market cap, showing which sectors are rotating in and out, with optional AI narrative.",
    priceUsdc: "0.03",
    comparison: "Live sector momentum, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [],
  },
  {
    id: "defi_tvl_report",
    name: "DeFi TVL Report",
    description:
      "Zero-gas DeFi health check: total TVL across chains, Base protocol TVL ranking and 1d/7d flows from DefiLlama, with optional AI interpretation.",
    priceUsdc: "0.02",
    comparison: "Live TVL flows, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [],
  },
  {
    id: "sentiment_pulse",
    name: "Sentiment Pulse",
    description:
      "Zero-gas derivatives sentiment for majors: funding rates, open interest change and long/short ratios from Binance futures, with optional AI sentiment label.",
    priceUsdc: "0.015",
    comparison: "Live derivatives sentiment, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [],
  },
  {
    id: "news_wire",
    name: "Crypto News Wire",
    description:
      "Zero-gas raw news wire: latest headlines across top crypto outlets with sources and timestamps, optional topic filter and optional AI digest.",
    priceUsdc: "0.02",
    comparison: "Live news wire, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "query", type: "string", required: false, description: "Optional topic filter." },
      { name: "limit", type: "number", required: false, default: 10, description: "Headlines to return (1-20). Default 10." },
    ],
  },
  {
    id: "regulatory_radar",
    name: "Regulatory Radar",
    description:
      "Zero-gas regulatory watch: latest regulation and enforcement headlines with sources, filtered from live crypto news, with optional AI risk summary.",
    priceUsdc: "0.015",
    comparison: "Live regulatory watch, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "limit", type: "number", required: false, default: 8, description: "Headlines to return (1-15). Default 8." },
    ],
  },
  {
    id: "funding_radar",
    name: "Crypto Funding Radar",
    description:
      "Zero-gas fundraising watch: recent funding rounds, raises and investments across crypto from live news, with optional AI context on the sectors attracting capital.",
    priceUsdc: "0.015",
    comparison: "Live funding watch, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "limit", type: "number", required: false, default: 8, description: "Headlines to return (1-15). Default 8." },
    ],
  },
  {
    id: "volatility_screen",
    name: "Volatility Screen",
    description:
      "Zero-gas volatility ranking: realized 24h and 7d volatility for majors computed from live candles, with optional AI read on regime risk.",
    priceUsdc: "0.015",
    comparison: "Live volatility math, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [],
  },
  {
    id: "correlation_matrix",
    name: "Correlation Matrix",
    description:
      "Zero-gas 30-day pairwise price correlation across majors computed from live candles, with optional AI interpretation of crowded or diverging trades.",
    priceUsdc: "0.03",
    comparison: "Live correlation math, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [],
  },
  {
    id: "stablecoin_monitor",
    name: "Stablecoin Monitor",
    description:
      "Zero-gas stablecoin watch: market caps, 24h volume and peg deviation for top stablecoins from CoinGecko, with optional AI stability commentary.",
    priceUsdc: "0.015",
    comparison: "Live peg monitor, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [],
  },
  {
    id: "liquidity_map",
    name: "Base Liquidity Map",
    description:
      "Zero-gas Base liquidity landscape: top pools by liquidity and volume plus active DexScreener boosts, with optional AI read on where capital is parked.",
    priceUsdc: "0.02",
    comparison: "Live liquidity map, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "limit", type: "number", required: false, default: 10, description: "Pools to return (1-20). Default 10." },
    ],
  },
  {
    id: "token_compare",
    name: "Token Head-to-Head",
    description:
      "Zero-gas side-by-side comparison of two tokens: live price, 24h change, liquidity, market cap and recent momentum, with optional AI verdict.",
    priceUsdc: "0.02",
    comparison: "Live token comparison, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "tokenA", type: "string", required: true, description: "First token symbol or address." },
      { name: "tokenB", type: "string", required: true, description: "Second token symbol or address." },
    ],
  },
  {
    id: "portfolio_heatmap",
    name: "Portfolio Heatmap",
    description:
      "Zero-gas portfolio pulse: live price, 24h/7d change and market cap for up to 10 tokens, ranked by 24h momentum, with optional AI rebalance commentary.",
    priceUsdc: "0.03",
    comparison: "Live portfolio pulse, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [
      { name: "tokens", type: "string[]", required: true, description: "1-10 token symbols or addresses." },
    ],
  },
  {
    id: "signal_digest",
    name: "Daily Signal Digest",
    description:
      "Zero-gas daily alpha digest combining movers, volatility, funding sentiment and top headlines into one ranked signal sheet, with optional AI conviction scoring.",
    priceUsdc: "0.04",
    comparison: "Live signal digest, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [],
  },
  {
    id: "trend_velocity",
    name: "Trend Velocity",
    description:
      "Zero-gas momentum math: 24h, 7d and 30d rate-of-change across majors computed from live candles, ranked by acceleration, with optional AI trend labels.",
    priceUsdc: "0.015",
    comparison: "Live momentum math, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [],
  },
  {
    id: "ai_agents_radar",
    name: "AI Agents Ecosystem Radar",
    description:
      "Zero-gas Virtuals/ACP ecosystem radar: live VIRTUAL price and liquidity, recent on-chain ACP job activity and trending Base pools, with optional AI outlook.",
    priceUsdc: "0.02",
    comparison: "Live agent-ecosystem radar, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [],
  },
  {
    id: "gas_forecast",
    name: "Base Gas Forecast",
    description:
      "Zero-gas Base fee intelligence: current, average, median, min and max base fee over the last 24 blocks with trend, from the live Base RPC.",
    priceUsdc: "0.015",
    comparison: "Live Base fee data, no gas",
    slaSeconds: config.execution.slaSeconds,
    category: "intelligence",
    params: [],
  },
].map((offering) => {
  const ceiling = competitorCeilingUsdc(offering.id);
  const listUsdc = Number(offering.priceUsdc);
  const priceUsdc =
    ceiling === null || listUsdc <= ceiling ? offering.priceUsdc : formatUsdcAmount(ceiling);
  return {
    ...offering,
    priceUsdc,
    priceUnits: usdcUnits(priceUsdc),
    payment: { symbol: "USDC", address: USDC.address, decimals: USDC.decimals, chainId: config.chain.id },
    competitor: competitorPosition(offering.id, priceUsdc),
  };
});

const offeringIndex = new Map(OFFERINGS.map((offering) => [offering.id, offering]));

export function getOffering(offeringId) {
  const id = String(offeringId ?? "").trim().toLowerCase();
  const offering = offeringIndex.get(id);
  if (!offering) {
    throw AppError.notFound(
      `Unknown offering "${offeringId}".`,
      "UNKNOWN_OFFERING"
    );
  }
  return offering;
}

export function offeringPublicJSON(offering) {
  return {
    offering_id: offering.id,
    name: offering.name,
    description: offering.description,
    price: {
      amount: offering.priceUsdc,
      currency: "USDC",
      decimals: USDC.decimals,
      units: String(offering.priceUnits),
      chainId: config.chain.id,
    },
    comparison: offering.comparison,
    competitive: offering.competitor,
    sla_seconds: offering.slaSeconds,
    category: offering.category,
    parameters: offering.params,
    payment: offering.payment,
  };
}

export const offeringsPublicJSON = () => OFFERINGS.map(offeringPublicJSON);

const parseAmount = (value, field) => {
  const raw = String(value ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) {
    throw AppError.badRequest(`${field} must be a positive decimal string.`, { [field]: value }, "INVALID_AMOUNT");
  }
  return raw;
};

const parseAddress = (value, field) => {
  if (typeof value !== "string" || !isAddress(value)) {
    throw AppError.badRequest(`${field} must be a valid EVM address.`, { [field]: value }, "INVALID_ADDRESS");
  }
  return getAddress(value);
};

const parseProjects = (value, min, max) => {
  if (!Array.isArray(value)) {
    throw AppError.badRequest("projects must be an array of addresses.", { projects: value }, "INVALID_PROJECTS");
  }
  if (value.length < min || value.length > max) {
    throw AppError.badRequest(
      `projects must contain between ${min} and ${max} addresses (received ${value.length}).`,
      { min, max, received: value.length },
      "INVALID_PROJECTS"
    );
  }
  const addresses = value.map((entry, index) => parseAddress(entry, `projects[${index}]`));
  if (new Set(addresses.map((address) => address.toLowerCase())).size !== addresses.length) {
    throw AppError.badRequest("projects contains duplicate addresses.", undefined, "DUPLICATE_PROJECTS");
  }
  return addresses;
};

const TIMEFRAME_VALUES = ["15m", "1h", "4h", "1d"];

const parseOptionalText = (value, field, maxLength) => {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > maxLength) {
    throw AppError.badRequest(`${field} must be ${maxLength} characters or fewer.`, { [field]: value }, "INVALID_PARAM");
  }
  return text;
};

const parseRequiredText = (value, field, minLength, maxLength) => {
  const text = parseOptionalText(value, field, maxLength);
  if (!text || text.length < minLength) {
    throw AppError.badRequest(`${field} must be ${minLength}-${maxLength} characters.`, { [field]: value }, "INVALID_PARAM");
  }
  return text;
};

const parseEnum = (value, allowed, fallback, field) => {
  if (value === undefined || value === null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.includes(normalized)) {
    throw AppError.badRequest(`${field} must be one of: ${allowed.join(", ")}.`, { [field]: value }, "INVALID_PARAM");
  }
  return normalized;
};

const parseOptionalNumber = (value, field, { min, max, fallback = null }) => {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw AppError.badRequest(`${field} must be a number between ${min} and ${max}.`, { [field]: value }, "INVALID_PARAM");
  }
  return parsed;
};

const parseSlippage = (value) => {
  if (value === undefined || value === null || value === "") {
    return config.execution.defaultSlippageBps;
  }
  const percent = Number(value);
  if (!Number.isFinite(percent)) {
    throw AppError.badRequest("maxSlippage must be a number in percent (e.g. 3).", { maxSlippage: value }, "INVALID_SLIPPAGE");
  }
  let bps = Math.round(percent * 100);
  bps = Math.max(config.execution.minSlippageBps, Math.min(bps, config.execution.maxSlippageBps));
  return bps;
};

const parseBool = (value, field, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  throw AppError.badRequest(`${field} must be a boolean.`, { [field]: value }, "INVALID_PARAM");
};

const parseStringList = (value, field, { max, allowed = null } = {}) => {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value)) {
    throw AppError.badRequest(`${field} must be an array of strings.`, { [field]: value }, "INVALID_PARAM");
  }
  if (value.length > max) {
    throw AppError.badRequest(`${field} must contain at most ${max} entries.`, { [field]: value }, "INVALID_PARAM");
  }
  const entries = value.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean);
  if (allowed) {
    const invalid = entries.filter((entry) => !allowed.includes(entry));
    if (invalid.length) {
      throw AppError.badRequest(`${field} must only contain: ${allowed.join(", ")}.`, { [field]: invalid }, "INVALID_PARAM");
    }
  }
  return [...new Set(entries)];
};

const parseSymbolList = (value, field, { min, max }) => {
  if (value === undefined || value === null || value === "") return [];
  if (!Array.isArray(value)) {
    throw AppError.badRequest(`${field} must be an array of symbols.`, { [field]: value }, "INVALID_PARAM");
  }
  if (value.length < min || value.length > max) {
    throw AppError.badRequest(
      `${field} must contain ${min}-${max} symbols.`,
      { [field]: value },
      field === "tokens" ? "INVALID_TOKENS" : "INVALID_PARAM"
    );
  }
  const entries = value.map((entry) => String(entry).trim().toUpperCase()).filter(Boolean);
  if (entries.length !== value.length || entries.some((entry) => !/^[A-Z0-9.$-]{1,20}$/.test(entry))) {
    throw AppError.badRequest(
      `${field} must contain only valid token symbols (1-20 characters).`,
      { [field]: value },
      "INVALID_PARAM"
    );
  }
  return [...new Set(entries)];
};

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const parseEndpoint = (value, { required = true } = {}) => {
  if (!required && (value === undefined || value === null || value === "")) return null;
  const raw = typeof value === "string" ? value.trim() : "";
  if (raw.length < 8 || raw.length > 300) {
    throw AppError.badRequest(
      "endpoint must be a public HTTPS URL (8-300 characters).",
      { endpoint: value },
      "INVALID_RETAINER_ENDPOINT"
    );
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw AppError.badRequest("endpoint must be an absolute HTTPS URL.", { endpoint: raw }, "INVALID_RETAINER_ENDPOINT");
  }
  if (parsed.protocol !== "https:") {
    throw AppError.badRequest("endpoint must use HTTPS.", { endpoint: raw }, "INVALID_RETAINER_ENDPOINT");
  }
  return raw.replace(/\/+$/, "");
};

const parseTransfers = (value, min, max) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw AppError.badRequest(
      `transfers must be an array of ${min}-${max} entries.`,
      { transfers: value, min, max },
      "INVALID_TRANSFERS"
    );
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw AppError.badRequest(`transfers[${index}] must be an object.`, { entry }, "INVALID_TRANSFERS");
    }
    const targetAddress = parseAddress(entry.targetAddress, `transfers[${index}].targetAddress`);
    if (targetAddress.toLowerCase() === ZERO_ADDRESS) {
      throw AppError.badRequest(`transfers[${index}] cannot target the zero address.`, undefined, "INVALID_TRANSFERS");
    }
    return { targetAddress, amount: parseAmount(entry.amount, `transfers[${index}].amount`) };
  });
};

export function validateParams(offering, params = {}) {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw AppError.badRequest("params must be an object.", undefined, "INVALID_PARAMS");
  }

  switch (offering.id) {
    case "token_swap": {
      const sellToken = String(params.sellToken ?? "").trim();
      const buyToken = String(params.buyToken ?? "").trim();
      if (!sellToken) throw AppError.badRequest("sellToken is required.", undefined, "MISSING_SELL_TOKEN");
      if (!buyToken) throw AppError.badRequest("buyToken is required.", undefined, "MISSING_BUY_TOKEN");
      return {
        sellToken,
        buyToken,
        amount: parseAmount(params.amount, "amount"),
        maxSlippageBps: parseSlippage(params.maxSlippage ?? params.maxSlippageBps),
      };
    }
    case "transfer_token":
      return {
        tokenAddress: parseAddress(params.tokenAddress, "tokenAddress"),
        targetAddress: parseAddress(params.targetAddress, "targetAddress"),
        amount: parseAmount(params.amount, "amount"),
      };
    case "fund_startup":
      return {
        projectAddress: parseAddress(params.projectAddress, "projectAddress"),
        memo: params.memo ? String(params.memo).slice(0, 200) : null,
      };
    case "semi_batch_fund_startup":
      return {
        projects: parseProjects(params.projects, 2, 3),
        memo: params.memo ? String(params.memo).slice(0, 200) : null,
      };
    case "batch_fund_startup":
      return {
        projects: parseProjects(params.projects, 4, 10),
        memo: params.memo ? String(params.memo).slice(0, 200) : null,
      };
    case "resolve_tokens": {
      if (!Array.isArray(params.tokens) || params.tokens.length < 1 || params.tokens.length > 10) {
        throw AppError.badRequest("tokens must be an array of 1-10 symbols or addresses.", undefined, "INVALID_TOKENS");
      }
      const tokens = params.tokens.map((token) => String(token).trim()).filter(Boolean);
      if (tokens.length === 0) {
        throw AppError.badRequest("tokens must contain at least one non-empty symbol or address.", undefined, "INVALID_TOKENS");
      }
      return { tokens };
    }
    case "suggest_a_trade":
      return {
        token: parseRequiredText(params.token, "token", 1, 42),
        timeframe: parseEnum(params.timeframe, TIMEFRAME_VALUES, "4h", "timeframe"),
        side: parseEnum(params.side, ["auto", "long", "short"], "auto", "side"),
        capitalUsdc: parseOptionalNumber(params.capitalUsdc, "capitalUsdc", { min: 0.01, max: 1_000_000 }),
        riskPercent: parseOptionalNumber(params.riskPercent, "riskPercent", { min: 0.1, max: 5, fallback: 1 }),
      };
    case "mega_report":
      return {};
    case "twitter_alpha":
      return {
        topic: parseOptionalText(params.topic, "topic", 60),
      };
    case "crypto_news":
      return {
        query: parseOptionalText(params.query, "query", 60),
        limit: Math.round(parseOptionalNumber(params.limit, "limit", { min: 1, max: 20, fallback: 8 })),
      };
    case "topic_research":
      return {
        query: parseRequiredText(params.query, "query", 2, 160),
      };
    case "yield_alpha":
      return {
        assetClass: parseEnum(params.assetClass, ["any", "stable", "eth", "btc"], "any", "assetClass"),
        minTvlUsd: parseOptionalNumber(params.minTvlUsd, "minTvlUsd", { min: 100_000, max: 10_000_000_000 }),
      };
    case "kol_alpha":
      return {
        focus: parseOptionalText(params.focus, "focus", 60),
      };
    case "trending_tokens":
      return {
        limit: Math.round(parseOptionalNumber(params.limit, "limit", { min: 1, max: 15, fallback: 8 })),
      };
    case "token_info":
      return {
        token: parseRequiredText(params.token, "token", 1, 42),
      };
    case "token_alpha":
      return {
        token: parseRequiredText(params.token, "token", 1, 42),
        timeframe: parseEnum(params.timeframe, TIMEFRAME_VALUES, "4h", "timeframe"),
      };
    case "deep_analytics": {
      const depth = parseEnum(params.depth, ["standard", "pro", "enterprise"], "standard", "depth");
      return {
        target: parseRequiredText(params.target, "target", 1, 42),
        depth,
        timeframe: parseEnum(params.timeframe, TIMEFRAME_VALUES, "4h", "timeframe"),
        includeSecurity: parseBool(params.includeSecurity, "includeSecurity", true),
        capitalUsdc: parseOptionalNumber(params.capitalUsdc, "capitalUsdc", { min: 0.01, max: 1_000_000 }),
      };
    }
    case "intel_retainer": {
      return {
        plan: parseEnum(params.plan, ["weekly", "monthly"], "weekly", "plan"),
        endpoint: parseEndpoint(params.endpoint),
        topics: parseStringList(params.topics, "topics", { max: 5 }),
        alerts: parseBool(params.alerts, "alerts", true),
      };
    }
    case "flash_alert":
      return {
        types: (() => {
          const types = parseStringList(params.types, "types", { max: 2, allowed: ["arbitrage", "whale"] });
          return types.length ? types : ["arbitrage", "whale"];
        })(),
        watchlist: parseStringList(params.watchlist, "watchlist", { max: 10 }),
        limit: Math.round(parseOptionalNumber(params.limit, "limit", { min: 1, max: 10, fallback: 6 })),
      };
    case "gas_advisor":
      return {
        txType: parseEnum(params.txType, ["transfer", "swap", "contract"], "swap", "txType"),
        urgency: parseEnum(params.urgency, ["now", "cheapest"], "now", "urgency"),
      };
    case "yield_radar":
      return {
        assetClass: parseEnum(params.assetClass, ["any", "stable", "eth", "btc"], "any", "assetClass"),
        minApy: parseOptionalNumber(params.minApy, "minApy", { min: 0, max: 1000, fallback: 8 }),
        minTvlUsd: parseOptionalNumber(params.minTvlUsd, "minTvlUsd", { min: 100_000, max: 10_000_000_000 }),
      };
    case "agent_credit":
      return {
        address: parseAddress(params.address, "address"),
      };
    case "token_security_scan": {
      if (!Array.isArray(params.tokens) || params.tokens.length < 1 || params.tokens.length > 10) {
        throw AppError.badRequest("tokens must be an array of 1-10 symbols or addresses.", undefined, "INVALID_TOKENS");
      }
      const tokens = params.tokens.map((token) => String(token).trim()).filter(Boolean);
      if (tokens.length === 0) {
        throw AppError.badRequest("tokens must contain at least one symbol or address.", undefined, "INVALID_TOKENS");
      }
      return { tokens };
    }
    case "wallet_risk_audit":
      return {
        address: parseAddress(params.address, "address"),
        watchTokens: parseStringList(params.watchTokens, "watchTokens", { max: 8 }),
      };
    case "liquidation_guard": {
      const plan = parseEnum(params.plan, ["weekly", "monthly"], "weekly", "plan");
      const positions = parseStringList(params.positions, "positions", { max: 10 });
      if (!positions.length) {
        throw AppError.badRequest("positions must contain 1-10 tokens.", { positions: params.positions }, "INVALID_POSITIONS");
      }
      return {
        plan,
        endpoint: parseEndpoint(params.endpoint),
        positions,
        thresholdPct: parseOptionalNumber(params.thresholdPct, "thresholdPct", { min: 1, max: 50, fallback: 8 }),
      };
    }
    case "new_pool_radar": {
      const plan = parseEnum(params.plan, ["once", "monthly"], "once", "plan");
      return {
        plan,
        endpoint: parseEndpoint(params.endpoint, { required: plan === "monthly" }),
        minLiquidityUsd: parseOptionalNumber(params.minLiquidityUsd, "minLiquidityUsd", {
          min: 1_000,
          max: 10_000_000_000,
          fallback: config.revenue.newPoolMinLiquidityUsd,
        }),
        maxAgeHours: parseOptionalNumber(params.maxAgeHours, "maxAgeHours", {
          min: 1,
          max: 168,
          fallback: config.revenue.newPoolLookbackHours,
        }),
        limit: Math.round(parseOptionalNumber(params.limit, "limit", { min: 1, max: 10, fallback: 8 })),
      };
    }
    case "smart_money_flow": {
      const plan = parseEnum(params.plan, ["once", "monthly"], "once", "plan");
      return {
        plan,
        endpoint: parseEndpoint(params.endpoint, { required: plan === "monthly" }),
        watchlist: parseStringList(params.watchlist, "watchlist", { max: 10 }),
        minUsd: parseOptionalNumber(params.minUsd, "minUsd", {
          min: 1_000,
          max: 10_000_000_000,
          fallback: config.revenue.smartMoneyMinUsd,
        }),
        lookbackBlocks: Math.round(
          parseOptionalNumber(params.lookbackBlocks, "lookbackBlocks", {
            min: 10,
            max: 200,
            fallback: config.revenue.smartMoneyLookbackBlocks,
          })
        ),
        limit: Math.round(parseOptionalNumber(params.limit, "limit", { min: 1, max: 10, fallback: 6 })),
      };
    }
    case "batch_executor":
      return {
        transfers: parseTransfers(params.transfers, 2, 20),
        memo: params.memo ? String(params.memo).slice(0, 200) : null,
      };
    case "agent_revenue_audit":
      return {
        address: parseAddress(params.address, "address"),
      };
    case "provider_benchmark":
      return {
        limit: Math.round(parseOptionalNumber(params.limit, "limit", { min: 1, max: 15, fallback: 8 })),
        minCompleted: Math.round(
          parseOptionalNumber(params.minCompleted, "minCompleted", { min: 0, max: 1_000, fallback: 1 })
        ),
      };
    case "virtuals_alpha":
      return {
        token: parseOptionalText(params.token, "token", 42) || "VIRTUAL",
        timeframe: parseEnum(params.timeframe, TIMEFRAME_VALUES, "4h", "timeframe"),
        includeEcosystem: parseBool(params.includeEcosystem, "includeEcosystem", true),
      };
    case "job_radar": {
      const plan = parseEnum(params.plan, ["once", "monthly"], "once", "plan");
      const statuses = parseStringList(params.statuses, "statuses", { max: 2, allowed: ["open", "funded"] });
      return {
        plan,
        endpoint: parseEndpoint(params.endpoint, { required: plan === "monthly" }),
        minBudgetUsdc: parseOptionalNumber(params.minBudgetUsdc, "minBudgetUsdc", {
          min: 0,
          max: 1_000_000,
          fallback: 0.5,
        }),
        keywords: parseStringList(params.keywords, "keywords", { max: 5 }),
        statuses: statuses.length ? statuses : ["open", "funded"],
        limit: Math.round(parseOptionalNumber(params.limit, "limit", { min: 1, max: 15, fallback: 8 })),
      };
    }
    case "macro_brief":
      return {};
    case "market_movers":
      return {
        limit: Math.round(parseOptionalNumber(params.limit, "limit", { min: 1, max: 10, fallback: 10 })),
      };
    case "sector_rotation":
      return {};
    case "defi_tvl_report":
      return {};
    case "sentiment_pulse":
      return {};
    case "news_wire":
      return {
        query: parseOptionalText(params.query, "query", 60),
        limit: Math.round(parseOptionalNumber(params.limit, "limit", { min: 1, max: 20, fallback: 10 })),
      };
    case "regulatory_radar":
      return {
        limit: Math.round(parseOptionalNumber(params.limit, "limit", { min: 1, max: 15, fallback: 8 })),
      };
    case "funding_radar":
      return {
        limit: Math.round(parseOptionalNumber(params.limit, "limit", { min: 1, max: 15, fallback: 8 })),
      };
    case "volatility_screen":
      return {};
    case "correlation_matrix":
      return {};
    case "stablecoin_monitor":
      return {};
    case "liquidity_map":
      return {
        limit: Math.round(parseOptionalNumber(params.limit, "limit", { min: 1, max: 20, fallback: 10 })),
      };
    case "token_compare": {
      const tokenA = String(params.tokenA ?? "").trim();
      const tokenB = String(params.tokenB ?? "").trim();
      if (!tokenA) throw AppError.badRequest("tokenA is required.", undefined, "MISSING_TOKEN_A");
      if (!tokenB) throw AppError.badRequest("tokenB is required.", undefined, "MISSING_TOKEN_B");
      return { tokenA, tokenB };
    }
    case "portfolio_heatmap": {
      const tokens = parseSymbolList(params.tokens, "tokens", { min: 1, max: 10 });
      if (!tokens.length) {
        throw AppError.badRequest("tokens must contain 1-10 symbols or addresses.", undefined, "INVALID_TOKENS");
      }
      return { tokens };
    }
    case "signal_digest":
      return {};
    case "trend_velocity":
      return {};
    case "ai_agents_radar":
      return {};
    case "gas_forecast":
      return {};
    default:
      throw AppError.badRequest(`Offering ${offering.id} has no param schema.`, undefined, "UNKNOWN_OFFERING");
  }
}

export function donationShares(offering, params) {
  const projects = offering.id === "fund_startup" ? [params.projectAddress] : params.projects;
  const total = offering.priceUnits;
  const marginBps = config.revenue.donationMarginBps;
  const forward = (total * BigInt(10000 - marginBps)) / 10000n;
  const share = forward / BigInt(projects.length);
  const remainder = forward - share * BigInt(projects.length);
  return projects.map((address, index) => ({
    address,
    amount: index === 0 ? share + remainder : share,
  }));
}

export function donationFeeUnits(offering) {
  const marginBps = config.revenue.donationMarginBps;
  return offering.priceUnits - (offering.priceUnits * BigInt(10000 - marginBps)) / 10000n;
}
