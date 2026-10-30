import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.js";
import { getOffering, validateParams } from "../src/services/offerings.js";
import {
  basePriceFor,
  discountWindow,
  isHappyHour,
  issueQuote,
  priceUnitsFor,
  quotePublicJSON,
  resolveQuote,
} from "../src/services/pricing.js";
import { commissionUsdc } from "../src/services/referrals.js";
import {
  anomalyFromSnapshots,
  arbitrageOpportunities,
  classifyTransfer,
  creditScoreFromStats,
  evaluateLiquidationPositions,
  filterNewPools,
  gasAdvice,
  matchJobLeads,
  rankProviders,
  securityRiskFromFacts,
  yieldGaps,
} from "../src/services/revenue.js";

const HAPPY_NOW = Date.parse("2026-10-29T03:00:00Z");
const BUSY_NOW = Date.parse("2026-10-29T12:00:00Z");

test("tiered prices follow depth and retainer plan", () => {
  const deep = getOffering("deep_analytics");
  assert.equal(basePriceFor(deep, { depth: "standard" }), 5);
  assert.equal(basePriceFor(deep, { depth: "pro" }), 10);
  assert.equal(basePriceFor(deep, { depth: "enterprise" }), 15);
  assert.equal(basePriceFor(deep, {}), 5);

  const retainer = getOffering("intel_retainer");
  assert.equal(basePriceFor(retainer, { plan: "weekly" }), 50);
  assert.equal(basePriceFor(retainer, { plan: "monthly" }), 100);
  assert.equal(priceUnitsFor(deep, { depth: "enterprise" }), 15_000_000n);
});

test("happy hour window handles direct and wrapped ranges", () => {
  const original = { start: config.revenue.happyHourStartUtc, end: config.revenue.happyHourEndUtc };
  try {
    config.revenue.happyHourStartUtc = 0;
    config.revenue.happyHourEndUtc = 6;
    assert.equal(isHappyHour(new Date(HAPPY_NOW)), true);
    assert.equal(isHappyHour(new Date(BUSY_NOW)), false);

    config.revenue.happyHourStartUtc = 22;
    config.revenue.happyHourEndUtc = 4;
    assert.equal(isHappyHour(new Date("2026-10-29T23:00:00Z")), true);
    assert.equal(isHappyHour(new Date("2026-10-29T02:00:00Z")), true);
    assert.equal(isHappyHour(new Date("2026-10-29T12:00:00Z")), false);
  } finally {
    config.revenue.happyHourStartUtc = original.start;
    config.revenue.happyHourEndUtc = original.end;
  }
});

test("discount window stacks off-peak and low-gas reasons", () => {
  const window = discountWindow({ now: new Date(HAPPY_NOW), gasGwei: 0.001 });
  assert.equal(window.active, true);
  assert.deepEqual(window.reasons, ["off_peak_utc", "low_base_gas"]);
  assert.equal(window.discountBps, config.revenue.happyHourDiscountBps + config.revenue.gasDiscountBps);

  const busy = discountWindow({ now: new Date(BUSY_NOW), gasGwei: 0.5 });
  assert.equal(busy.active, false);
  assert.equal(busy.discountBps, 0);
});

test("quotes are stored, bound to offering and client, and expire", async () => {
  const deep = getOffering("deep_analytics");
  const quote = await issueQuote({
    offering: deep,
    params: { target: "VIRTUAL", depth: "pro" },
    client: "0x0000000000000000000000000000000000000001",
    referrer: "0x0000000000000000000000000000000000000002",
    now: HAPPY_NOW,
    gasGwei: null,
  });
  assert.equal(quote.listUsdc, 10);
  assert.equal(quote.discountBps, config.revenue.happyHourDiscountBps);
  assert.equal(quote.priceUsdc, 8.5);
  assert.equal(quote.priceUnits, "8500000");
  assert.equal(quote.referrer, "0x0000000000000000000000000000000000000002");

  const resolved = await resolveQuote({
    quoteId: quote.id,
    offering: deep,
    client: "0x0000000000000000000000000000000000000001",
    now: HAPPY_NOW,
  });
  assert.equal(resolved.id, quote.id);

  await assert.rejects(
    resolveQuote({
      quoteId: quote.id,
      offering: getOffering("flash_alert"),
      now: HAPPY_NOW,
    }),
    (error) => error.code === "QUOTE_MISMATCH"
  );
  await assert.rejects(
    resolveQuote({
      quoteId: quote.id,
      offering: deep,
      client: "0x0000000000000000000000000000000000000003",
      now: HAPPY_NOW,
    }),
    (error) => error.code === "QUOTE_CLIENT_MISMATCH"
  );
  await assert.rejects(
    resolveQuote({ quoteId: quote.id, offering: deep, now: HAPPY_NOW + config.revenue.quoteTtlSeconds * 1000 }),
    (error) => error.code === "QUOTE_EXPIRED"
  );
});

test("quotes are bound to their exact params and performance is intelligence-only", async () => {
  const deep = getOffering("deep_analytics");
  const client = "0x0000000000000000000000000000000000000001";
  const quote = await issueQuote({
    offering: deep,
    params: { target: "VIRTUAL", depth: "standard" },
    client,
    now: HAPPY_NOW,
    gasGwei: null,
  });

  await assert.rejects(
    resolveQuote({
      quoteId: quote.id,
      offering: deep,
      params: { target: "VIRTUAL", depth: "enterprise" },
      client,
      now: HAPPY_NOW,
    }),
    (error) => error.code === "QUOTE_PARAMS_MISMATCH"
  );
  const resolved = await resolveQuote({
    quoteId: quote.id,
    offering: deep,
    params: { depth: "standard", target: "VIRTUAL" },
    client,
    now: HAPPY_NOW,
  });
  assert.equal(resolved.id, quote.id);

  await assert.rejects(
    issueQuote({ offering: getOffering("token_swap"), model: "performance", now: HAPPY_NOW, gasGwei: null }),
    (error) => error.code === "PERFORMANCE_NOT_AVAILABLE"
  );
  await assert.rejects(
    issueQuote({
      offering: getOffering("intel_retainer"),
      params: { plan: "monthly" },
      model: "performance",
      now: HAPPY_NOW,
      gasGwei: null,
    }),
    (error) => error.code === "PERFORMANCE_NOT_AVAILABLE"
  );
});

test("performance quotes split upfront and bonus", async () => {
  const deep = getOffering("deep_analytics");
  const quote = await issueQuote({
    offering: deep,
    params: { target: "VIRTUAL", depth: "pro" },
    model: "performance",
    now: BUSY_NOW,
    gasGwei: 1,
  });
  assert.equal(quote.listUsdc, 10);
  assert.equal(quote.priceUsdc, 2.5);
  assert.equal(quote.bonusUsdc, 7.5);
  await assert.rejects(
    issueQuote({ offering: deep, model: "free", now: BUSY_NOW, gasGwei: null }),
    (error) => error.code === "INVALID_PRICING_MODEL"
  );
});

test("referral commission is a capped share of the paid price", () => {
  assert.equal(commissionUsdc(100), Math.min(7, config.revenue.referralMaxUsdc));
  assert.equal(commissionUsdc(5), 0.35);
  assert.equal(commissionUsdc(0), 0);
  assert.equal(commissionUsdc(1_000_000), config.revenue.referralMaxUsdc);
});

test("arbitrage detection needs two liquid pools and a minimum spread", () => {
  const pools = [
    { address: "0xpoolA", dex: "uniswap", baseAddress: "0xtoken", baseSymbol: "TKN", priceUsd: 1, liquidityUsd: 120_000 },
    { address: "0xpoolB", dex: "aerodrome", baseAddress: "0xtoken", baseSymbol: "TKN", priceUsd: 1.02, liquidityUsd: 90_000 },
  ];
  const found = arbitrageOpportunities(pools, { minSpreadBps: 40, minLiquidityUsd: 50_000 });
  assert.equal(found.length, 1);
  assert.equal(found[0].spreadBps, 200);
  assert.equal(found[0].buy.dex, "uniswap");
  assert.equal(found[0].sell.dex, "aerodrome");

  assert.equal(
    arbitrageOpportunities(pools, { minSpreadBps: 500, minLiquidityUsd: 50_000 }).length,
    0
  );
  assert.equal(
    arbitrageOpportunities([pools[0], { ...pools[1], liquidityUsd: 100 }], { minLiquidityUsd: 50_000 }).length,
    0
  );
});

test("arbitrage discards implausible spreads and pools quoting another base token", () => {
  const mixed = [
    { address: "0xpoolA", dex: "uniswap", baseAddress: "0xtoken", priceUsd: 1, liquidityUsd: 200_000 },
    { address: "0xpoolB", dex: "uniswap", baseAddress: "0xweth", priceUsd: 2_500, liquidityUsd: 200_000 },
    { address: "0xpoolC", dex: "aerodrome", baseAddress: "0xtoken", priceUsd: 3, liquidityUsd: 200_000 },
  ];
  assert.equal(arbitrageOpportunities(mixed, { minSpreadBps: 40 }).length, 0);
  const sane = arbitrageOpportunities(
    [
      { address: "0xpoolA", dex: "uniswap", baseAddress: "0xtoken", priceUsd: 1, liquidityUsd: 200_000 },
      { address: "0xpoolC", dex: "aerodrome", baseAddress: "0xtoken", priceUsd: 1.01, liquidityUsd: 200_000 },
    ],
    {}
  );
  assert.equal(sane.length, 1);
  assert.equal(sane[0].spreadBps, 100);
});

test("yield gaps compare Base pools against the median and p90", () => {
  const pools = [
    { project: "a", pool: "p1", symbol: "USDC", chain: "Base", tvlUsd: 5_000_000, apy: 4 },
    { project: "b", pool: "p2", symbol: "ETH", chain: "Base", tvlUsd: 8_000_000, apy: 9 },
    { project: "c", pool: "p3", symbol: "BTC", chain: "Base", tvlUsd: 9_000_000, apy: 30 },
  ];
  const result = yieldGaps(pools, { minApy: 3, minTvlUsd: 1_000_000 });
  assert.equal(result.sample, 3);
  assert.equal(result.gaps[0].apy, 30);
  assert.ok(result.gaps[0].gapVsMedianPct > 0);
  assert.equal(yieldGaps([], {}).gaps.length, 0);
});

test("credit scoring rewards completion and penalises failures", () => {
  const unproven = creditScoreFromStats({});
  assert.equal(unproven.score, 15);
  assert.equal(unproven.label, "unproven");

  const strong = creditScoreFromStats({
    jobs: 50,
    providerJobs: 40,
    clientJobs: 10,
    completed: 45,
    rejected: 1,
    expired: 1,
    volumeUsdc: 50_000,
    lastActivityAt: new Date().toISOString(),
  });
  assert.ok(strong.score >= 75);
  assert.equal(strong.label, "high");
  assert.equal(strong.flags.includes("rejected_jobs"), true);

  const weak = creditScoreFromStats({
    jobs: 4,
    completed: 1,
    rejected: 2,
    expired: 1,
    volumeUsdc: 2,
    lastActivityAt: new Date(Date.now() - 200 * 86_400_000).toISOString(),
  });
  assert.ok(weak.score < strong.score);
  assert.ok(weak.flags.includes("inactive_90d"));
});

test("gas advice reports trend and estimated cost", () => {
  const rising = gasAdvice({
    gasPriceGwei: 0.05,
    recentBaseFeesGwei: [0.01, 0.01, 0.01],
    txType: "swap",
    urgency: "now",
  });
  assert.equal(rising.trend, "rising");
  assert.ok(rising.estimatedCostEth > 0);
  assert.match(rising.advice, /now/i);

  const falling = gasAdvice({
    gasPriceGwei: 0.005,
    recentBaseFeesGwei: [0.05, 0.05],
    txType: "transfer",
    urgency: "cheapest",
  });
  assert.equal(falling.trend, "falling");
  assert.match(falling.advice, /waiting/i);
  assert.equal(falling.estimatedGasUnits, 21000);
  assert.throws(
    () => gasAdvice({ gasPriceGwei: 0 }),
    (error) => error.code === "GAS_UNAVAILABLE"
  );
});

test("pool anomaly detection flags liquidity and price drops", () => {
  const previous = { liquidityUsd: 100_000, priceUsd: 1, at: "2026-10-29T00:00:00Z" };
  const current = {
    address: "0xpool",
    name: "TKN/USDC",
    dex: "uniswap",
    baseAddress: "0xtoken",
    liquidityUsd: 60_000,
    priceUsd: 0.8,
    at: "2026-10-29T01:00:00Z",
  };
  const anomaly = anomalyFromSnapshots(previous, current, { liquidityDropPct: 25, priceDropPct: 15 });
  assert.deepEqual(anomaly.reasons, ["liquidity_drop", "price_drop"]);
  assert.equal(anomaly.liquidityChangePct, -40);
  assert.equal(anomaly.priceChangePct, -20);

  assert.equal(anomalyFromSnapshots({ liquidityUsd: 100_000, priceUsd: 1 }, { ...current, liquidityUsd: 99_000, priceUsd: 0.99 }), null);
  assert.equal(anomalyFromSnapshots(null, current), null);
});

test("revenue offering params are validated strictly", () => {
  assert.deepEqual(validateParams(getOffering("deep_analytics"), { target: "VIRTUAL" }), {
    target: "VIRTUAL",
    depth: "standard",
    timeframe: "4h",
    includeSecurity: true,
    capitalUsdc: null,
  });
  assert.throws(
    () => validateParams(getOffering("deep_analytics"), { target: "VIRTUAL", depth: "max" }),
    (error) => error.code === "INVALID_PARAM"
  );

  const retainer = validateParams(getOffering("intel_retainer"), {
    endpoint: "https://agent.example.com/a2a",
    plan: "monthly",
    alerts: "false",
  });
  assert.equal(retainer.plan, "monthly");
  assert.equal(retainer.alerts, false);
  assert.throws(
    () => validateParams(getOffering("intel_retainer"), { endpoint: "http://agent.example.com" }),
    (error) => error.code === "INVALID_RETAINER_ENDPOINT"
  );

  assert.deepEqual(validateParams(getOffering("flash_alert"), {}), {
    types: ["arbitrage", "whale"],
    watchlist: [],
    limit: 6,
  });
  assert.throws(
    () => validateParams(getOffering("flash_alert"), { types: ["rug"] }),
    (error) => error.code === "INVALID_PARAM"
  );

  assert.deepEqual(validateParams(getOffering("gas_advisor"), {}), { txType: "swap", urgency: "now" });
  assert.deepEqual(validateParams(getOffering("yield_radar"), {}), { assetClass: "any", minApy: 8, minTvlUsd: null });
  assert.throws(
    () => validateParams(getOffering("agent_credit"), { address: "0x123" }),
    (error) => error.code === "INVALID_ADDRESS"
  );
});

test("dynamic prices cover every new revenue tier", () => {
  assert.equal(basePriceFor(getOffering("token_security_scan"), { tokens: ["A"] }), 1);
  assert.equal(basePriceFor(getOffering("liquidation_guard"), { plan: "weekly" }), 25);
  assert.equal(basePriceFor(getOffering("liquidation_guard"), { plan: "monthly" }), 80);
  assert.equal(basePriceFor(getOffering("new_pool_radar"), { plan: "once" }), 1.5);
  assert.equal(basePriceFor(getOffering("smart_money_flow"), { plan: "monthly" }), 30);
  assert.equal(basePriceFor(getOffering("job_radar"), { plan: "once" }), 2);
  assert.equal(
    basePriceFor(getOffering("batch_executor"), {
      transfers: [
        { targetAddress: "0x0000000000000000000000000000000000000001", amount: "5000" },
        { targetAddress: "0x0000000000000000000000000000000000000002", amount: "5000" },
      ],
    }),
    6
  );
  assert.equal(basePriceFor(getOffering("provider_benchmark")), 3);
  assert.equal(basePriceFor(getOffering("virtuals_alpha")), 2);
});

test("performance pricing is rejected for every retainer-capable offering", async () => {
  for (const id of ["liquidation_guard", "new_pool_radar", "smart_money_flow", "job_radar"]) {
    await assert.rejects(
      issueQuote({
        offering: getOffering(id),
        params: { plan: "once" },
        model: "performance",
        now: HAPPY_NOW,
        gasGwei: null,
      }),
      (error) => error.code === "PERFORMANCE_NOT_AVAILABLE"
    );
  }
});

test("token security scoring flags honeypots, taxes and thin liquidity", () => {
  const dangerous = securityRiskFromFacts({
    honeypot: true,
    liquidityUsd: 0,
    buyTaxPct: 25,
    sellTaxPct: 30,
    openSource: false,
    isProxy: true,
    totalHolders: 20,
    pairsObserved: 0,
  });
  assert.ok(dangerous.riskScore >= 60);
  assert.equal(dangerous.riskLevel, "high");
  const codes = dangerous.flags.map((flag) => flag.code);
  for (const code of ["honeypot", "no_liquidity", "high_buy_tax", "high_sell_tax", "closed_source", "no_dex_coverage"]) {
    assert.ok(codes.includes(code), `expected ${code}`);
  }

  const clean = securityRiskFromFacts({
    honeypot: false,
    liquidityUsd: 2_000_000,
    buyTaxPct: 0,
    sellTaxPct: 0,
    openSource: true,
    isProxy: false,
    totalHolders: 50_000,
    pairsObserved: 5,
  });
  assert.equal(clean.riskScore, 0);
  assert.equal(clean.riskLevel, "low");
});

test("liquidation guard evaluates drawdown and thin liquidity", () => {
  const positions = evaluateLiquidationPositions(
    [
      { input: "TKN", change24hPct: -12, liquidityUsd: 500_000 },
      { input: "SAFE", change24hPct: -2, liquidityUsd: 500_000 },
      { input: "THIN", change24hPct: 5, liquidityUsd: 5_000 },
    ],
    { thresholdPct: 8 }
  );
  assert.equal(positions[0].alert, true);
  assert.equal(positions[0].drawdownPct, 12);
  assert.deepEqual(positions[0].reasons, ["drawdown_threshold"]);
  assert.equal(positions[1].alert, false);
  assert.equal(positions[1].distanceToThresholdPct, 6);
  assert.deepEqual(positions[2].reasons, ["thin_liquidity"]);
});

test("new pool radar filters by age and liquidity", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const pools = [
    { address: "0xnew", name: "NEW/USDC", dex: "uniswap", baseSymbol: "NEW", liquidityUsd: 80_000, createdAt: "2026-10-30T11:00:00Z" },
    { address: "0xold", name: "OLD/USDC", dex: "uniswap", baseSymbol: "OLD", liquidityUsd: 90_000, createdAt: "2026-10-25T11:00:00Z" },
    { address: "0xthin", name: "THIN/USDC", dex: "uniswap", baseSymbol: "THIN", liquidityUsd: 1_000, createdAt: "2026-10-30T11:30:00Z" },
  ];
  const fresh = filterNewPools(pools, { minLiquidityUsd: 25_000, maxAgeHours: 48, now, limit: 8 });
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].address, "0xnew");
  assert.equal(fresh[0].ageHours, 1);
});

test("smart money classification uses known pool addresses and agent wallet", () => {
  const poolAddresses = ["0xpool"];
  assert.equal(classifyTransfer({ fromAddress: "0xwallet", toAddress: "0xpool", poolAddresses }), "sell_into_pool");
  assert.equal(classifyTransfer({ fromAddress: "0xpool", toAddress: "0xwallet", poolAddresses }), "buy_from_pool");
  assert.equal(
    classifyTransfer({ fromAddress: "0xagent", toAddress: "0xwallet", poolAddresses, selfAddress: "0xagent" }),
    "agent_outflow"
  );
  assert.equal(
    classifyTransfer({ fromAddress: "0xwallet", toAddress: "0xagent", poolAddresses, selfAddress: "0xagent" }),
    "agent_inflow"
  );
  assert.equal(classifyTransfer({ fromAddress: "0xa", toAddress: "0xb", poolAddresses }), "wallet_to_wallet");
});

test("provider ranking sorts by settled volume and counts outcomes", () => {
  const jobs = [
    { provider: "0xaaa", client: "0xc1", status: 3, budget: 5_000_000n, expiredAt: 1_760_000_000 },
    { provider: "0xaaa", client: "0xc2", status: 3, budget: 10_000_000n, expiredAt: 1_760_000_100 },
    { provider: "0xaaa", client: "0xc2", status: 4, budget: 1_000_000n, expiredAt: 1_760_000_200 },
    { provider: "0xbbb", client: "0xc3", status: 3, budget: 20_000_000n, expiredAt: 1_760_000_300 },
    { provider: "0xbbb", client: "0xc4", status: 0, budget: 2_000_000n, expiredAt: 1_760_000_400 },
  ];
  const ranked = rankProviders(jobs, { limit: 5, minCompleted: 1 });
  assert.equal(ranked.length, 2);
  assert.equal(ranked[0].provider, "0xbbb");
  assert.equal(ranked[0].settledVolumeUsdc, 20);
  assert.equal(ranked[1].provider, "0xaaa");
  assert.equal(ranked[1].completed, 2);
  assert.equal(ranked[1].rejected, 1);
  assert.equal(ranked[1].settledVolumeUsdc, 15);
  assert.equal(ranked[1].uniqueClients, 2);
  assert.equal(ranked[1].completionRatePct, 66.67);
});

test("job radar matches open leads by budget, keyword and expiry", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const nowSeconds = Math.floor(now / 1000);
  const jobs = [
    {
      id: 1,
      status: 0,
      client: "0xclient",
      provider: "0x0000000000000000000000000000000000000000",
      evaluator: "0xeval",
      budget: 3_000_000n,
      expiredAt: nowSeconds + 3_600,
      description: "Need a token security audit",
    },
    {
      id: 2,
      status: 3,
      client: "0xclient",
      provider: "0xother",
      evaluator: "0xeval",
      budget: 9_000_000n,
      expiredAt: nowSeconds + 3_600,
      description: "Completed security work",
    },
    {
      id: 3,
      status: 1,
      client: "0xclient",
      provider: "0xother",
      evaluator: "0xeval",
      budget: 100_000n,
      expiredAt: nowSeconds + 3_600,
      description: "Tiny security job",
    },
    {
      id: 4,
      status: 0,
      client: "0xclient",
      provider: "0x0000000000000000000000000000000000000000",
      evaluator: "0xeval",
      budget: 4_000_000n,
      expiredAt: nowSeconds - 60,
      description: "Expired security audit",
    },
  ];
  const leads = matchJobLeads(jobs, {
    minBudgetUsdc: 0.5,
    keywords: ["security", "audit"],
    statuses: ["open", "funded"],
    excludeAddress: "0xother",
    limit: 8,
    now,
  });
  assert.equal(leads.length, 1);
  assert.equal(leads[0].jobId, "1");
  assert.equal(leads[0].budgetUsdc, 3);
  assert.deepEqual(leads[0].matchedKeywords, ["security", "audit"]);
});

test("quotes carry the competitor ceiling and reject micro performance upfronts", async () => {
  const mega = getOffering("mega_report");
  const quote = await issueQuote({ offering: mega, params: {}, now: HAPPY_NOW, gasGwei: null });
  assert.equal(quote.listUsdc, 0.025);
  assert.equal(quote.competitive.competitor, "Otto AI");
  assert.equal(quote.competitive.benchmarkUsdc, 0.05);
  assert.equal(quote.competitive.maxPriceUsdc, 0.025);
  assert.ok(quote.competitive.undercutBps >= 5000);
  assert.equal(quote.competitive.benchmarkVerified, false);

  const publicJson = await quotePublicJSON(quote);
  assert.equal(publicJson.competitive.competitor, "Otto AI");
  assert.equal(publicJson.competitive.maxPriceUsdc, 0.025);

  const twitter = getOffering("twitter_alpha");
  await assert.rejects(
    issueQuote({ offering: twitter, params: {}, model: "performance", now: HAPPY_NOW, gasGwei: null }),
    (error) => error.code === "PERFORMANCE_UPFRONT_EXCEEDS_LIST"
  );
});
