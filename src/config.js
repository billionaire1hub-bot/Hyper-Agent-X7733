import "dotenv/config";

const str = (value, fallback = "") =>
  value === undefined || value === null || String(value).trim() === ""
    ? fallback
    : String(value).trim();

const num = (value, fallback) => {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const bool = (value, fallback = false) => {
  if (value === undefined || value === null || String(value).trim() === "") return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
};

const normalizePrivateKey = (value) => {
  const key = str(value);
  if (!key) return null;
  const prefixed = key.startsWith("0x") ? key : `0x${key}`;
  return /^0x[0-9a-fA-F]{64}$/.test(prefixed) ? prefixed : null;
};

const slippageDefault = Math.min(
  Math.max(num(process.env.DEFAULT_SLIPPAGE_BPS, 300), 10),
  2000
);

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Vercel deployments are configured by operators under either the X_* or the
// older TWITTER_* variable names, so both families are accepted for every
// credential the posting client needs.
const envFirst = (...values) => {
  for (const value of values) {
    const text = str(value);
    if (text) return text;
  }
  return "";
};

const list = (value, fallback = []) => {
  const raw = str(value);
  if (!raw) return fallback;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
};

const customTaskBasePrice = clamp(num(process.env.CUSTOM_TASK_BASE_PRICE_USDC, 0.05), 0.005, 10);

const DEFAULT_NEWS_FEEDS = [
  "https://www.coindesk.com/arc/outboundfeeds/rss",
  "https://www.theblock.co/rss.xml",
  "https://decrypt.co/feed",
  "https://cryptoslate.com/feed/",
];

export const config = {
  env: str(process.env.NODE_ENV, "development"),
  version: "1.6.2",
  slug: str(process.env.AGENT_SLUG, "hyper-agent-x7733"),
  name: str(process.env.AGENT_NAME, "Hyper Agent X7733"),
  description: str(
    process.env.AGENT_DESCRIPTION,
    "Hyper Agent X7733: ACP-compliant Base utility agent for on-chain swaps, transfers and startup funding plus live AI market intelligence and autonomous X publishing."
  ),
  publicBaseUrl: str(process.env.PUBLIC_BASE_URL, ""),
  port: clamp(num(process.env.PORT, 3000), 1, 65535),

  apiKey: str(process.env.API_KEY),
  cronSecret: str(process.env.CRON_SECRET),

  chain: {
    id: 8453,
    name: "Base",
    rpcUrl: str(process.env.BASE_RPC_URL, "https://mainnet.base.org"),
    explorer: "https://basescan.org",
  },

  wallet: {
    privateKey: normalizePrivateKey(process.env.AGENT_PRIVATE_KEY),
  },

  acp: {
    agentId: str(process.env.ACP_AGENT_ID),
    contract: str(
      process.env.ACP_CONTRACT_ADDRESS,
      "0x238E541BfefD82238730D00a2208E5497F1832E0"
    ),
    apiUrl: str(process.env.ACP_API_URL, "https://api.acp.virtuals.io"),
    apiKey: str(process.env.ACP_API_KEY),
    autoSubmitDeliverable: bool(process.env.AUTO_SUBMIT_DELIVERABLE, true),
    minEscrowWindowSeconds: Math.max(num(process.env.MIN_ESCROW_WINDOW_SECONDS, 90), 30),
  },

  ai: {
    groqApiKey: str(process.env.GROQ_API_KEY),
    groqModel: str(process.env.GROQ_MODEL, "qwen/qwen3.8-27b"),
    groqMaxOutputTokens: clamp(num(process.env.GROQ_MAX_OUTPUT_TOKENS, 1000), 256, 4000),
    geminiApiKey: str(process.env.GEMINI_API_KEY),
    geminiModel: str(process.env.GEMINI_MODEL, "gemini-3.8-flash"),
    timeoutMs: Math.max(num(process.env.AI_TIMEOUT_MS, 12000), 3000),
  },

  intelligence: {
    coingeckoApiUrl: str(process.env.COINGECKO_API_URL, "https://api.coingecko.com/api/v3").replace(/\/+$/, ""),
    coingeckoApiKey: str(process.env.COINGECKO_API_KEY),
    geckoterminalApiUrl: str(
      process.env.GECKOTERMINAL_API_URL,
      "https://api.geckoterminal.com/api/v2"
    ).replace(/\/+$/, ""),
    defillamaApiUrl: str(process.env.DEFILLAMA_API_URL, "https://api.llama.fi").replace(/\/+$/, ""),
    yieldsApiUrl: str(process.env.YIELDS_API_URL, "https://yields.llama.fi").replace(/\/+$/, ""),
    dexscreenerApiUrl: str(
      process.env.DEXSCREENER_API_URL,
      "https://api.dexscreener.com"
    ).replace(/\/+$/, ""),
    honeypotApiUrl: str(process.env.HONEYPOT_API_URL, "https://api.honeypot.is/v2").replace(/\/+$/, ""),
    newsFeeds: list(process.env.NEWS_FEEDS, DEFAULT_NEWS_FEEDS),
    twitterBearerToken: envFirst(process.env.X_BEARER_TOKEN, process.env.TWITTER_BEARER_TOKEN),
    kolHandles: list(process.env.KOL_HANDLES)
      .map((handle) => handle.replace(/^@/, ""))
      .filter((handle) => /^[A-Za-z0-9_]{1,15}$/.test(handle))
      .slice(0, 50),
    dataTimeoutMs: clamp(num(process.env.DATA_TIMEOUT_MS, 9000), 3000, 20000),
    groundingTimeoutMs: clamp(num(process.env.GROUNDING_TIMEOUT_MS, 20000), 5000, 30000),
    newsTimeoutMs: clamp(num(process.env.NEWS_TIMEOUT_MS, 7000), 3000, 15000),
    cacheTtlMs: clamp(num(process.env.INTEL_CACHE_TTL_MS, 45000), 0, 300000),
    maxNewsItems: clamp(num(process.env.INTEL_MAX_NEWS, 12), 3, 30),
    maxYields: clamp(num(process.env.INTEL_MAX_YIELDS, 8), 3, 20),
    minYieldTvlUsd: Math.max(num(process.env.MIN_YIELD_TVL_USD, 5_000_000), 100_000),
    minLiquidityUsd: Math.max(num(process.env.MIN_TOKEN_LIQUIDITY_USD, 25_000), 1_000),
    aiMaxOutputTokens: clamp(num(process.env.AI_MAX_OUTPUT_TOKENS, 1800), 300, 4000),
    aiRetries: clamp(num(process.env.AI_MAX_RETRIES, 1), 0, 2),
  },

  kyber: {
    apiUrl: str(
      process.env.KYBERSWAP_API_URL,
      "https://aggregator-api.kyberswap.com/base/api/v1"
    ).replace(/\/+$/, ""),
    clientId: str(process.env.KYBERSWAP_CLIENT_ID, "virtuals-hyper-agent-x7733"),
    apiKey: str(process.env.KYBERSWAP_API_KEY),
  },

  execution: {
    defaultSlippageBps: slippageDefault,
    minSlippageBps: Math.max(num(process.env.MIN_SLIPPAGE_BPS, 10), 1),
    maxSlippageBps: Math.min(num(process.env.MAX_SLIPPAGE_BPS, 2000), 2000),
    maxAttempts: Math.min(Math.max(num(process.env.TX_MAX_ATTEMPTS, 3), 1), 5),
    confirmations: Math.max(num(process.env.TX_CONFIRMATIONS, 1), 1),
    txTimeoutMs: Math.max(num(process.env.TX_TIMEOUT_MS, 45000), 15000),
    slaSeconds: Math.max(num(process.env.SLA_SECONDS, 120), 30),
    allowUnpaidExecution:
      bool(process.env.ALLOW_UNPAID_EXECUTION, false) &&
      !process.env.VERCEL &&
      str(process.env.NODE_ENV, "development") !== "production",
    allowAgentFundedSwaps: bool(process.env.ALLOW_AGENT_FUNDED_SWAPS, false),
    onchainUnlockMinUsd: clamp(num(process.env.ONCHAIN_UNLOCK_MIN_USD, 0.75), 0.1, 10),
    ethUsdFallback: clamp(num(process.env.ETH_USD_FALLBACK, 3000), 100, 100000),
  },

  intake: {
    enabled: bool(process.env.ACP_INTAKE_ENABLED, true),
    intervalSeconds: clamp(num(process.env.ACP_INTAKE_INTERVAL_SECONDS, 60), 15, 3600),
    batch: clamp(num(process.env.ACP_INTAKE_BATCH, 3), 1, 25),
    scanLimit: clamp(num(process.env.ACP_INTAKE_SCAN_LIMIT, 40), 1, 500),
    budgetMs: clamp(num(process.env.ACP_INTAKE_BUDGET_MS, 45000), 5000, 55000),
    startId: Math.max(num(process.env.ACP_INTAKE_START_ID, 0), 0),
  },

  a2a: {
    enabled: bool(process.env.A2A_ENABLED, true),
  },

  /**
   * The catalogue is fixed at 50 offerings. A peer whose job fits none of them
   * is quoted and executed through a synthetic custom_task offering instead,
   * priced deterministically from the requirement text so escrow verification
   * can never disagree with the quote.
   */
  custom: {
    enabled: bool(process.env.CUSTOM_TASK_ENABLED, true),
    basePriceUsdc: customTaskBasePrice,
    maxPriceUsdc: clamp(num(process.env.CUSTOM_TASK_MAX_PRICE_USDC, 0.5), customTaskBasePrice, 25),
    requirementMinChars: clamp(num(process.env.CUSTOM_TASK_MIN_CHARS, 24), 8, 200),
    requirementMaxChars: clamp(num(process.env.CUSTOM_TASK_MAX_CHARS, 600), 120, 4000),
    deepThreshold: clamp(num(process.env.CUSTOM_TASK_DEEP_THRESHOLD, 4), 2, 5),
    aiTimeoutBudgetMs: clamp(num(process.env.CUSTOM_TASK_BUDGET_MS, 40000), 10000, 55000),
  },

  boss: {
    passcode: str(process.env.BOSS_PASSCODE, "03210388"),
    sessionTtlSeconds: clamp(num(process.env.BOSS_SESSION_TTL_SECONDS, 1800), 60, 86400),
  },

  outreach: {
    enabled: bool(process.env.OUTREACH_ENABLED, true),
    intervalSeconds: clamp(num(process.env.OUTREACH_INTERVAL_SECONDS, 600), 120, 3600),
    cycleBudgetMs: clamp(num(process.env.OUTREACH_BUDGET_MS, 40000), 10000, 50000),
    dailyCap: clamp(num(process.env.OUTREACH_DAILY_CAP, 5), 1, 20),
    maxTargetsPerCycle: clamp(num(process.env.OUTREACH_MAX_TARGETS, 2), 1, 5),
    minScore: clamp(num(process.env.OUTREACH_MIN_SCORE, 55), 0, 100),
    cooldownHours: clamp(num(process.env.OUTREACH_COOLDOWN_HOURS, 72), 6, 720),
    scanJobs: clamp(num(process.env.OUTREACH_SCAN_JOBS, 60), 10, 200),
    indexUrl: str(
      process.env.OUTREACH_INDEX_URL,
      process.env.OUTREACH_INDEX_TOKEN || process.env.ACP_API_KEY ? "https://api.acp.virtuals.io/agents" : ""
    ),
    indexToken: str(process.env.OUTREACH_INDEX_TOKEN) || str(process.env.ACP_API_KEY),
    targets: list(process.env.OUTREACH_TARGETS),
    keywords: list(process.env.OUTREACH_KEYWORDS),
    xPitchEnabled: bool(process.env.OUTREACH_X_PITCH, true),
    directoryUrl: str(process.env.OUTREACH_DIRECTORY_URL, "https://acpx.virtuals.io/api/agents"),
    registryUrl: str(process.env.OUTREACH_REGISTRY_URL, "https://api.acp.virtuals.io/agents"),
    directoryLimit: clamp(num(process.env.OUTREACH_DIRECTORY_LIMIT, 100), 5, 100),
    directoryPages: clamp(num(process.env.OUTREACH_DIRECTORY_PAGES, 4), 1, 4),
    // Fallback bound for the sweep cursor. The directory reports its own page
    // count, and once a cycle has seen it that number wins; this only covers
    // the very first cycle and the case where every page request failed.
    directoryMaxPages: clamp(num(process.env.OUTREACH_DIRECTORY_MAX_PAGES, 900), 1, 2000),
    maxCandidates: clamp(num(process.env.OUTREACH_MAX_CANDIDATES, 40), 5, 200),
    cardProbes: clamp(num(process.env.OUTREACH_CARD_PROBES, 12), 3, 40),
    sessionTtlSeconds: clamp(num(process.env.OUTREACH_SESSION_TTL_SECONDS, 300), 120, 600),
    extensionSeconds: clamp(num(process.env.OUTREACH_EXTENSION_SECONDS, 120), 30, 300),
    maxTurns: clamp(num(process.env.OUTREACH_MAX_TURNS, 6), 2, 12),
    priceMultiplier: clamp(num(process.env.OUTREACH_PRICE_MULTIPLIER, 1), 0.5, 3),
    maxPriceUsdc: clamp(num(process.env.OUTREACH_MAX_PRICE_USDC, 0.075), 0.001, 1),
    cardTimeoutMs: clamp(num(process.env.OUTREACH_CARD_TIMEOUT_MS, 6000), 2000, 15000),
    sendTimeoutMs: clamp(num(process.env.OUTREACH_SEND_TIMEOUT_MS, 9000), 3000, 20000),
  },

  revenue: {
    enabled: bool(process.env.REVENUE_ENABLED, true),
    intervalSeconds: clamp(num(process.env.REVENUE_INTERVAL_SECONDS, 300), 120, 3600),
    budgetMs: clamp(num(process.env.REVENUE_BUDGET_MS, 45000), 10000, 55000),
    quoteTtlSeconds: clamp(num(process.env.QUOTE_TTL_SECONDS, 900), 120, 3600),
    donationMarginBps: clamp(num(process.env.DONATION_SERVICE_MARGIN_BPS, 2000), 2000, 5000),
    referralBps: clamp(num(process.env.REFERRAL_BPS, 700), 500, 1000),
    referralMaxUsdc: clamp(num(process.env.REFERRAL_MAX_USDC, 10), 0.1, 25),
    referralMinJobAgeSeconds: clamp(num(process.env.REFERRAL_MIN_JOB_AGE_SECONDS, 120), 30, 3600),
    referralReserveUsdc: clamp(num(process.env.REFERRAL_RESERVE_USDC, 1), 0, 50),
    happyHourStartUtc: clamp(num(process.env.HAPPY_HOUR_START_UTC, 0), 0, 23),
    happyHourEndUtc: clamp(num(process.env.HAPPY_HOUR_END_UTC, 6), 0, 24),
    happyHourDiscountBps: clamp(num(process.env.HAPPY_HOUR_DISCOUNT_BPS, 1500), 0, 2500),
    gasDiscountBps: clamp(num(process.env.HAPPY_HOUR_GAS_DISCOUNT_BPS, 500), 0, 1000),
    gasDiscountMaxGwei: Math.max(num(process.env.HAPPY_HOUR_MAX_GWEI, 0.02), 0),
    whaleLookbackBlocks: clamp(num(process.env.WHALE_LOOKBACK_BLOCKS, 40), 10, 1000),
    whaleMinUsdc: Math.max(num(process.env.WHALE_MIN_USDC, 250000), 1000),
    whaleMinWeth: Math.max(num(process.env.WHALE_MIN_WETH, 100), 1),
    arbitrageMinSpreadBps: clamp(num(process.env.ARBITRAGE_MIN_SPREAD_BPS, 40), 5, 2000),
    arbitrageMinLiquidityUsd: Math.max(num(process.env.ARBITRAGE_MIN_LIQUIDITY_USD, 50000), 1000),
    anomalyLiquidityDropPct: clamp(num(process.env.ANOMALY_LIQUIDITY_DROP_PCT, 25), 5, 95),
    anomalyPriceDropPct: clamp(num(process.env.ANOMALY_PRICE_DROP_PCT, 15), 2, 95),
    scanPools: clamp(num(process.env.REVENUE_SCAN_POOLS, 12), 3, 30),
    securityMinLiquidityUsd: Math.max(num(process.env.SECURITY_MIN_LIQUIDITY_USD, 25_000), 1_000),
    newPoolLookbackHours: clamp(num(process.env.NEW_POOL_LOOKBACK_HOURS, 48), 1, 168),
    newPoolMinLiquidityUsd: Math.max(num(process.env.NEW_POOL_MIN_LIQUIDITY_USD, 25_000), 1_000),
    smartMoneyMinUsd: Math.max(num(process.env.SMART_MONEY_MIN_USD, 50_000), 1_000),
    smartMoneyLookbackBlocks: clamp(num(process.env.SMART_MONEY_LOOKBACK_BLOCKS, 40), 10, 200),
    benchmarkScanJobs: clamp(num(process.env.BENCHMARK_SCAN_JOBS, 150), 25, 400),
    jobRadarScanJobs: clamp(num(process.env.JOB_RADAR_SCAN_JOBS, 100), 20, 300),
    retainerMaxDeliveriesPerDay: clamp(num(process.env.RETAINER_MAX_DELIVERIES_PER_DAY, 2), 1, 6),
    retainerSendTimeoutMs: clamp(num(process.env.RETAINER_SEND_TIMEOUT_MS, 9000), 3000, 20000),
  },

  social: {
    enabled: bool(process.env.SOCIAL_AUTOPOST, true),
    intervalMinutes: clamp(num(process.env.SOCIAL_INTERVAL_MINUTES, 300), 240, 1440),
    tickMinutes: clamp(num(process.env.SOCIAL_TICK_MINUTES, 15), 1, 60),
    maxPostsPerDay: clamp(num(process.env.SOCIAL_MAX_POSTS_PER_DAY, 4), 1, 12),
    maxThreadLength: clamp(num(process.env.SOCIAL_MAX_THREAD_LENGTH, 6), 2, 10),
    maxTweetChars: 280,
    articleMaxTokens: clamp(num(process.env.SOCIAL_ARTICLE_MAX_TOKENS, 1600), 600, 3000),
    xApiBase: envFirst(process.env.X_API_BASE, process.env.TWITTER_API_BASE, "https://api.x.com/2").replace(/\/+$/, ""),
    oauth1: {
      consumerKey: envFirst(process.env.X_CONSUMER_KEY, process.env.X_API_KEY, process.env.TWITTER_API_KEY, process.env.TWITTER_CONSUMER_KEY),
      consumerSecret: envFirst(process.env.X_CONSUMER_SECRET, process.env.X_API_SECRET, process.env.TWITTER_API_SECRET, process.env.TWITTER_CONSUMER_SECRET),
      accessToken: envFirst(process.env.X_ACCESS_TOKEN, process.env.TWITTER_ACCESS_TOKEN),
      accessSecret: envFirst(process.env.X_ACCESS_SECRET, process.env.TWITTER_ACCESS_TOKEN_SECRET, process.env.TWITTER_ACCESS_SECRET),
    },
    oauth2UserToken: envFirst(
      process.env.X_USER_ACCESS_TOKEN,
      process.env.X_BEARER_TOKEN,
      process.env.TWITTER_USER_ACCESS_TOKEN,
      process.env.TWITTER_OAUTH2_USER_TOKEN
    ),
  },

  store: {
    url: str(process.env.UPSTASH_REDIS_REST_URL).replace(/\/+$/, ""),
    token: str(process.env.UPSTASH_REDIS_REST_TOKEN),
  },

  rateLimitPerMinute: Math.max(num(process.env.RATE_LIMIT_PER_MINUTE, 30), 1),
  logLevel: str(process.env.LOG_LEVEL, "info"),
};

export const isProduction = config.env === "production";
export const isVercel = Boolean(process.env.VERCEL);
export const walletConfigured = Boolean(config.wallet.privateKey);

export const USDC = {
  address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  symbol: "USDC",
  decimals: 6,
};

export const NATIVE_TOKEN = {
  address: "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
  symbol: "ETH",
  decimals: 18,
  native: true,
};

export const ONCHAIN_EXECUTION_OFFERINGS = new Set([
  "token_swap",
  "transfer_token",
  "batch_executor",
  "fund_startup",
  "semi_batch_fund_startup",
  "batch_fund_startup",
]);

export const BASE_TOKENS = {
  ETH: NATIVE_TOKEN,
  USDC,
  WETH: { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 },
  VIRTUAL: { address: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", symbol: "VIRTUAL", decimals: 18 },
  CBBTC: { address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", symbol: "cbBTC", decimals: 8 },
  CBETH: { address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22", symbol: "cbETH", decimals: 18 },
  DAI: { address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", decimals: 18 },
  USDC_E: { address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", symbol: "USDbC", decimals: 6 },
  EURC: { address: "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", symbol: "EURC", decimals: 6 },
  AERO: { address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", symbol: "AERO", decimals: 18 },
  DEGEN: { address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", symbol: "DEGEN", decimals: 18 },
  BRETT: { address: "0x532f27101965dd16442E59d40670FaF5eBB142E4", symbol: "BRETT", decimals: 18 },
  TOSHI: { address: "0xAc1Bd2486aAf3B5C0fc3Fd868558b082a531B2B4", symbol: "TOSHI", decimals: 18 },
  HIGHER: { address: "0x0578d8A44db98B23BF096A382e016e29a5Ce0ffe", symbol: "HIGHER", decimals: 18 },
};

export const VIRTUALS = {
  token: "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b",
  router: "0x8292B43aB73EfAC11FAF357419C38ACF448202C5",
  bondingCurve: "0xF66DeA7b3e897cD44A5a231c61B6B4423d613259",
  uniswapV2Router: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  uniswapUniversalRouter: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
};
