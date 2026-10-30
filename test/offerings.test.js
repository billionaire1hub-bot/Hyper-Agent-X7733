import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPETITOR_BENCHMARKS,
  COMPETITOR_UNDERCUT_BPS,
  OFFERINGS,
  competitorCeilingUsdc,
  donationFeeUnits,
  donationShares,
  getOffering,
  offeringsPublicJSON,
  validateParams,
} from "../src/services/offerings.js";
import { basePriceFor } from "../src/services/pricing.js";
import { parseJobId } from "../src/services/escrow.js";
import { minAmountOut } from "../src/services/kyberswap.js";
import { deliverableHashFor } from "../src/services/settlement.js";

test("publishes all fifty offerings with exact prices", () => {
  const prices = Object.fromEntries(OFFERINGS.map((offering) => [offering.id, offering.priceUsdc]));
  assert.deepEqual(prices, {
    token_swap: "0.025",
    transfer_token: "0.05",
    fund_startup: "5.00",
    semi_batch_fund_startup: "25.00",
    batch_fund_startup: "50.00",
    resolve_tokens: "0.001",
    suggest_a_trade: "0.05",
    mega_report: "0.025",
    twitter_alpha: "0.005",
    crypto_news: "0.005",
    topic_research: "0.005",
    yield_alpha: "0.005",
    kol_alpha: "0.005",
    trending_tokens: "0.005",
    token_info: "0.005",
    token_alpha: "0.005",
    deep_analytics: "5.00",
    intel_retainer: "50.00",
    flash_alert: "3.00",
    gas_advisor: "1.00",
    yield_radar: "2.50",
    agent_credit: "2.00",
    token_security_scan: "1.00",
    wallet_risk_audit: "2.00",
    liquidation_guard: "25.00",
    new_pool_radar: "1.50",
    smart_money_flow: "2.00",
    batch_executor: "1.00",
    agent_revenue_audit: "5.00",
    provider_benchmark: "3.00",
    virtuals_alpha: "2.00",
    job_radar: "2.00",
    macro_brief: "0.02",
    market_movers: "0.015",
    sector_rotation: "0.03",
    defi_tvl_report: "0.02",
    sentiment_pulse: "0.015",
    news_wire: "0.02",
    regulatory_radar: "0.015",
    funding_radar: "0.015",
    volatility_screen: "0.015",
    correlation_matrix: "0.03",
    stablecoin_monitor: "0.015",
    liquidity_map: "0.02",
    token_compare: "0.02",
    portfolio_heatmap: "0.03",
    signal_digest: "0.04",
    trend_velocity: "0.015",
    ai_agents_radar: "0.02",
    gas_forecast: "0.015",
  });
  assert.equal(offeringsPublicJSON().length, 50);
});

test("all eighteen insight offerings are zero-gas and pitchable from empty params where possible", () => {
  const insightIds = [
    "macro_brief",
    "market_movers",
    "sector_rotation",
    "defi_tvl_report",
    "sentiment_pulse",
    "news_wire",
    "regulatory_radar",
    "funding_radar",
    "volatility_screen",
    "correlation_matrix",
    "stablecoin_monitor",
    "liquidity_map",
    "token_compare",
    "portfolio_heatmap",
    "signal_digest",
    "trend_velocity",
    "ai_agents_radar",
    "gas_forecast",
  ];
  for (const id of insightIds) {
    const offering = getOffering(id);
    assert.equal(offering.category, "intelligence", `${id} must be an intelligence offering`);
    assert.equal(offering.payment.symbol, "USDC");
    assert.equal(offering.competitor, null, `${id} must not carry fabricated competitor benchmarks`);
  }
  const paramless = insightIds.filter((id) => !["token_compare", "portfolio_heatmap"].includes(id));
  for (const id of paramless) {
    assert.doesNotThrow(() => validateParams(getOffering(id), {}), `${id} must accept {}`);
  }
  assert.throws(() => validateParams(getOffering("token_compare"), {}), (error) => error.code === "MISSING_TOKEN_A");
  assert.throws(
    () => validateParams(getOffering("portfolio_heatmap"), { tokens: [] }),
    (error) => error.code === "INVALID_TOKENS"
  );
});

test("insight params normalize symbols and limits", () => {
  assert.deepEqual(validateParams(getOffering("portfolio_heatmap"), { tokens: ["eth", " btc ", "SOL"] }), {
    tokens: ["ETH", "BTC", "SOL"],
  });
  assert.throws(
    () => validateParams(getOffering("portfolio_heatmap"), { tokens: ["not a symbol!"] }),
    (error) => error.code === "INVALID_PARAM"
  );
  assert.deepEqual(validateParams(getOffering("token_compare"), { tokenA: "eth", tokenB: "BTC" }), {
    tokenA: "eth",
    tokenB: "BTC",
  });
  assert.deepEqual(validateParams(getOffering("market_movers"), { limit: 8.6 }), { limit: 9 });
  assert.deepEqual(validateParams(getOffering("news_wire"), {}), { query: null, limit: 10 });
  assert.deepEqual(validateParams(getOffering("liquidity_map"), {}), { limit: 10 });
});

test("offering lookup is case-insensitive and rejects unknown ids", () => {
  assert.equal(getOffering("TOKEN_SWAP").id, "token_swap");
  assert.throws(() => getOffering("nope"), (error) => error.code === "UNKNOWN_OFFERING");
});

test("validates swap params and converts percent slippage to bps", () => {
  const params = validateParams(getOffering("token_swap"), {
    sellToken: " USDC ",
    buyToken: "WETH",
    amount: "10.5",
    maxSlippage: 3,
  });
  assert.deepEqual(params, {
    sellToken: "USDC",
    buyToken: "WETH",
    amount: "10.5",
    maxSlippageBps: 300,
  });
});

test("clamps slippage to configured bounds and rejects bad amounts", () => {
  const params = validateParams(getOffering("token_swap"), {
    sellToken: "USDC",
    buyToken: "WETH",
    amount: "1",
    maxSlippage: 99,
  });
  assert.ok(params.maxSlippageBps <= 2000);
  assert.throws(
    () => validateParams(getOffering("token_swap"), { sellToken: "USDC", buyToken: "WETH", amount: "-5" }),
    (error) => error.code === "INVALID_AMOUNT"
  );
  assert.throws(
    () => validateParams(getOffering("token_swap"), { buyToken: "WETH", amount: "1" }),
    (error) => error.code === "MISSING_SELL_TOKEN"
  );
});

test("transfer validation rejects malformed addresses", () => {
  assert.throws(
    () =>
      validateParams(getOffering("transfer_token"), {
        tokenAddress: "not-an-address",
        targetAddress: "0x0000000000000000000000000000000000000001",
        amount: "1",
      }),
    (error) => error.code === "INVALID_ADDRESS"
  );
});

test("donation shares forward the post-margin amount, split equally with remainder to the first project", () => {
  const offering = getOffering("semi_batch_fund_startup");
  const projects = [
    "0x0000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000002",
    "0x0000000000000000000000000000000000000003",
  ];
  const shares = donationShares(offering, { projects });
  const total = shares.reduce((sum, share) => sum + share.amount, 0n);
  assert.equal(total, (offering.priceUnits * 80n) / 100n);
  assert.equal(shares[0].amount, 6_666_668n);
  assert.equal(shares[1].amount, 6_666_666n);
  assert.equal(shares[2].amount, 6_666_666n);
});

test("the donation service fee is at least 20% of the escrowed price", () => {
  const fund = getOffering("fund_startup");
  assert.equal(fund.priceUnits, 5_000_000n);
  assert.equal(donationFeeUnits(fund), 1_000_000n);

  const semi = getOffering("semi_batch_fund_startup");
  assert.equal(donationFeeUnits(semi), semi.priceUnits / 5n);

  const batch = getOffering("batch_fund_startup");
  assert.equal(donationFeeUnits(batch), batch.priceUnits / 5n);

  const shares = donationShares(fund, {
    projectAddress: "0x0000000000000000000000000000000000000001",
  });
  const forwarded = shares.reduce((sum, share) => sum + share.amount, 0n);
  assert.equal(forwarded, 4_000_000n);
  assert.equal(forwarded + donationFeeUnits(fund), fund.priceUnits);
});

test("batch donation requires 4-10 unique projects", () => {
  const offering = getOffering("batch_fund_startup");
  assert.throws(
    () => validateParams(offering, { projects: ["0x0000000000000000000000000000000000000001"] }),
    (error) => error.code === "INVALID_PROJECTS"
  );
  assert.throws(
    () =>
      validateParams(offering, {
        projects: Array(4).fill("0x0000000000000000000000000000000000000001"),
      }),
    (error) => error.code === "DUPLICATE_PROJECTS"
  );
});

test("resolve_tokens requires 1-10 non-empty entries", () => {
  const offering = getOffering("resolve_tokens");
  assert.deepEqual(validateParams(offering, { tokens: ["USDC", "WETH"] }), { tokens: ["USDC", "WETH"] });
  assert.throws(() => validateParams(offering, { tokens: ["  "] }), (error) => error.code === "INVALID_TOKENS");
  assert.throws(
    () => validateParams(offering, { tokens: Array(11).fill("USDC") }),
    (error) => error.code === "INVALID_TOKENS"
  );
});

test("ACP job ids must be positive integers", () => {
  assert.equal(parseJobId("42"), 42n);
  assert.throws(() => parseJobId("0"), (error) => error.code === "INVALID_JOB_ID");
  assert.throws(() => parseJobId("abc"), (error) => error.code === "INVALID_JOB_ID");
  assert.throws(() => parseJobId("-1"), (error) => error.code === "INVALID_JOB_ID");
});

test("slippage floor math rounds down", () => {
  assert.equal(minAmountOut(1_000_000n, 300), 970_000n);
  assert.equal(minAmountOut(1n, 300), 0n);
});

test("deliverable hash is deterministic for equivalent payloads", () => {
  const a = deliverableHashFor({ status: "executed", amount: 10n });
  const b = deliverableHashFor({ status: "executed", amount: "10" });
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.equal(a, b);
  assert.notEqual(a, deliverableHashFor({ status: "executed", amount: "11" }));
});

test("security scan prices per token and bundles ten for eight USDC", () => {
  const offering = getOffering("token_security_scan");
  const one = validateParams(offering, { tokens: ["VIRTUAL"] });
  assert.deepEqual(one, { tokens: ["VIRTUAL"] });
  assert.equal(basePriceFor(offering, one), 1);
  const five = validateParams(offering, { tokens: ["A", "B", "C", "D", "E"] });
  assert.equal(basePriceFor(offering, five), 5);
  const ten = validateParams(offering, { tokens: Array.from({ length: 10 }, (_, index) => `T${index}`) });
  assert.equal(basePriceFor(offering, ten), 8);
  assert.throws(
    () => validateParams(offering, { tokens: Array.from({ length: 11 }, (_, index) => `T${index}`) }),
    (error) => error.code === "INVALID_TOKENS"
  );
});

test("retainer plans require an HTTPS endpoint only when monthly", () => {
  for (const id of ["new_pool_radar", "smart_money_flow", "job_radar"]) {
    const offering = getOffering(id);
    const once = validateParams(offering, {});
    assert.equal(once.endpoint, null);
    assert.equal(once.plan, "once");
    assert.throws(
      () => validateParams(offering, { plan: "monthly" }),
      (error) => error.code === "INVALID_RETAINER_ENDPOINT"
    );
    const monthly = validateParams(offering, { plan: "monthly", endpoint: "https://agent.example.com/a2a/" });
    assert.equal(monthly.endpoint, "https://agent.example.com/a2a");
    assert.equal(basePriceFor(offering, monthly), id === "new_pool_radar" ? 25 : 30);
  }
  assert.throws(
    () => validateParams(getOffering("liquidation_guard"), { positions: ["VIRTUAL"], endpoint: "http://insecure.example.com" }),
    (error) => error.code === "INVALID_RETAINER_ENDPOINT"
  );
  const guard = validateParams(getOffering("liquidation_guard"), {
    endpoint: "https://agent.example.com/a2a",
    positions: ["VIRTUAL", "WETH"],
    plan: "monthly",
  });
  assert.equal(guard.thresholdPct, 8);
  assert.equal(basePriceFor(getOffering("liquidation_guard"), guard), 80);
});

test("batch executor validates transfers and charges 1 USDC plus 5 bps", () => {
  const offering = getOffering("batch_executor");
  const params = validateParams(offering, {
    transfers: [
      { targetAddress: "0x0000000000000000000000000000000000000001", amount: "1000" },
      { targetAddress: "0x0000000000000000000000000000000000000002", amount: "3000" },
    ],
    memo: "salaries",
  });
  assert.equal(params.transfers.length, 2);
  assert.equal(params.memo, "salaries");
  assert.equal(basePriceFor(offering, params), 3);
  assert.throws(
    () => validateParams(offering, { transfers: [{ targetAddress: "0x0000000000000000000000000000000000000001", amount: "1" }] }),
    (error) => error.code === "INVALID_TRANSFERS"
  );
  assert.throws(
    () =>
      validateParams(offering, {
        transfers: [
          { targetAddress: "0x0000000000000000000000000000000000000000", amount: "1" },
          { targetAddress: "0x0000000000000000000000000000000000000002", amount: "1" },
        ],
      }),
    (error) => error.code === "INVALID_TRANSFERS"
  );
});

test("analytics offerings normalize limits and defaults", () => {
  const benchmark = validateParams(getOffering("provider_benchmark"), { limit: 8.6, minCompleted: 2.2 });
  assert.deepEqual(benchmark, { limit: 9, minCompleted: 2 });
  const alpha = validateParams(getOffering("virtuals_alpha"), {});
  assert.deepEqual(alpha, { token: "VIRTUAL", timeframe: "4h", includeEcosystem: true });
  const radar = validateParams(getOffering("job_radar"), { keywords: ["audit", "security"], statuses: ["funded"] });
  assert.deepEqual(radar.statuses, ["funded"]);
  assert.deepEqual(radar.keywords, ["audit", "security"]);
  const defaults = validateParams(getOffering("job_radar"), {});
  assert.deepEqual(defaults.statuses, ["open", "funded"]);
});

test("competitor-mapped offerings are capped at 50% of the declared benchmark", () => {
  assert.equal(COMPETITOR_UNDERCUT_BPS, 5000);
  const mapped = OFFERINGS.filter((offering) => COMPETITOR_BENCHMARKS[offering.id]);
  assert.equal(mapped.length, 15);
  const published = new Map(offeringsPublicJSON().map((entry) => [entry.offering_id, entry]));
  for (const offering of mapped) {
    const benchmark = COMPETITOR_BENCHMARKS[offering.id];
    const ceiling = competitorCeilingUsdc(offering.id);
    assert.equal(ceiling, Number((benchmark.benchmarkUsdc / 2).toFixed(6)), `${offering.id} ceiling`);
    assert.ok(Number(offering.priceUsdc) <= ceiling, `${offering.id} must not exceed its ceiling`);
    assert.ok(offering.competitor, `${offering.id} must expose comparative metadata`);
    assert.equal(offering.competitor.competitor, benchmark.competitor);
    assert.equal(offering.competitor.maxPriceUsdc, ceiling);
    assert.ok(offering.competitor.undercutBps >= COMPETITOR_UNDERCUT_BPS, `${offering.id} must undercut by 50%`);
    assert.equal(offering.competitor.benchmarkVerified, false);
    assert.equal(published.get(offering.id).competitive.maxPriceUsdc, ceiling);
  }
});
