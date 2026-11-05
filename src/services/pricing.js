import crypto from "node:crypto";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { store, storeHelpers } from "../lib/store.js";
import { publicClient } from "../chain/client.js";
import {
  COMPETITOR_BENCHMARKS,
  COMPETITOR_BENCHMARK_SOURCE,
  COMPETITOR_UNDERCUT_BPS,
  assessCustomTask,
  competitorCeilingUsdc,
  competitorPosition,
  customPriceUsdc,
} from "./offerings.js";

const USDC_DECIMALS = 6;
const USDC_SCALE = 10 ** USDC_DECIMALS;

export const PRICING_MODELS = ["standard", "performance"];
export const ANALYTICS_DEPTHS = ["standard", "pro", "enterprise"];

const roundUsdc = (value) => Number(Number(value).toFixed(6));
const toUnits = (value) => BigInt(Math.round(Number(value) * USDC_SCALE));

const canonical = (value) =>
  JSON.stringify(value, (_key, entry) =>
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.keys(entry).sort().map((key) => [key, entry[key]]))
      : entry
  );

const RETAINER_OFFERINGS = new Set([
  "intel_retainer",
  "liquidation_guard",
  "new_pool_radar",
  "smart_money_flow",
  "job_radar",
]);

const supportsPerformance = (offering) =>
  Boolean(offering) && offering.category === "intelligence" && !RETAINER_OFFERINGS.has(offering.id);

const batchVolumeUsdc = (params) =>
  Array.isArray(params.transfers)
    ? params.transfers.reduce((sum, entry) => sum + Number(entry?.amount || 0), 0)
    : 0;

function listPriceFor(offering, params = {}) {
  if (offering.custom) {
    return customPriceUsdc(assessCustomTask(params.requirement).complexity);
  }
  if (offering.id === "deep_analytics") {
    const depth = ANALYTICS_DEPTHS.includes(params.depth) ? params.depth : "standard";
    return depth === "enterprise" ? 15 : depth === "pro" ? 10 : 5;
  }
  if (offering.id === "intel_retainer") {
    return params.plan === "monthly" ? 100 : 50;
  }
  if (offering.id === "token_security_scan") {
    const count = Array.isArray(params.tokens) ? params.tokens.length : 1;
    return count >= 10 ? 8 : roundUsdc(Math.max(1, count));
  }
  if (offering.id === "liquidation_guard") {
    return params.plan === "monthly" ? 80 : 25;
  }
  if (offering.id === "new_pool_radar") {
    return params.plan === "monthly" ? 25 : 1.5;
  }
  if (offering.id === "smart_money_flow") {
    return params.plan === "monthly" ? 30 : 2;
  }
  if (offering.id === "job_radar") {
    return params.plan === "monthly" ? 30 : 2;
  }
  if (offering.id === "batch_executor") {
    return roundUsdc(1 + batchVolumeUsdc(params) * 0.0005);
  }
  return roundUsdc(offering.priceUsdc);
}

/**
 * The competitive ceiling is applied last so no tier, plan or volume formula
 * can drift above 50% of the declared competitor benchmark.
 */
export function basePriceFor(offering, params = {}) {
  if (!offering) return null;
  const amount = listPriceFor(offering, params);
  const ceiling = competitorCeilingUsdc(offering.id);
  return ceiling === null ? amount : Math.min(amount, ceiling);
}

export function priceUnitsFor(offering, params = {}) {
  const amount = basePriceFor(offering, params);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw AppError.badRequest(`Offering ${offering?.id} has no collectible price.`, undefined, "PRICE_UNDEFINED");
  }
  return toUnits(amount);
}

export function isHappyHour(now = new Date()) {
  const hour = now.getUTCHours();
  const start = config.revenue.happyHourStartUtc;
  const end = config.revenue.happyHourEndUtc;
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/**
 * Low-traffic UTC hours plus a low-gas bonus. The discount only ever applies to
 * an issued quote; list prices and escrow minimums stay unchanged.
 */
export function discountWindow({ now = new Date(), gasGwei = null } = {}) {
  let discountBps = 0;
  const reasons = [];
  if (isHappyHour(now)) {
    discountBps += config.revenue.happyHourDiscountBps;
    reasons.push("off_peak_utc");
  }
  const gas = gasGwei === null || gasGwei === undefined ? null : Number(gasGwei);
  if (Number.isFinite(gas) && gas <= config.revenue.gasDiscountMaxGwei) {
    discountBps += config.revenue.gasDiscountBps;
    reasons.push("low_base_gas");
  }
  discountBps = Math.min(discountBps, 3000);
  return {
    active: discountBps > 0,
    discountBps,
    discountPct: roundUsdc(discountBps / 100),
    reasons,
    window: {
      startUtcHour: config.revenue.happyHourStartUtc,
      endUtcHour: config.revenue.happyHourEndUtc,
    },
    gasGwei: Number.isFinite(gas) ? gas : null,
  };
}

export async function liveGasGwei() {
  try {
    const wei = await publicClient.getGasPrice();
    return Number(wei) / 1e9;
  } catch {
    return null;
  }
}

export async function currentPricing({ now = new Date() } = {}) {
  const gasGwei = await liveGasGwei();
  return {
    version: config.version,
    currency: "USDC",
    now: now.toISOString(),
    ...discountWindow({ now, gasGwei }),
    tiers: {
      deep_analytics: { standard: 5, pro: 10, enterprise: 15 },
      intel_retainer: { weekly: 50, monthly: 100 },
      token_security_scan: { single: 1, bundle10: 8 },
      liquidation_guard: { weekly: 25, monthly: 80 },
      new_pool_radar: { scan: 1.5, monthly: 25 },
      smart_money_flow: { scan: 2, monthly: 30 },
      batch_executor: { base: 1, volumeBps: 5 },
      job_radar: { scan: 2, monthly: 30 },
    },
    performance: { upfrontShare: 0.25, bonusShare: 0.75 },
    referral: { bps: config.revenue.referralBps, maxUsdc: config.revenue.referralMaxUsdc },
    competition: {
      undercutBps: COMPETITOR_UNDERCUT_BPS,
      undercutPct: COMPETITOR_UNDERCUT_BPS / 100,
      rule: `listed, quoted, escrowed and pitched prices never exceed ${COMPETITOR_UNDERCUT_BPS / 100}% of the declared benchmark`,
      benchmarkSource: COMPETITOR_BENCHMARK_SOURCE,
      benchmarkVerified: false,
      benchmarks: Object.fromEntries(
        Object.entries(COMPETITOR_BENCHMARKS).map(([id, benchmark]) => [
          id,
          { ...benchmark, ceilingUsdc: competitorCeilingUsdc(id) },
        ])
      ),
    },
  };
}

function normaliseReferrer(value) {
  if (!value) return null;
  const raw = String(value).trim();
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? raw : null;
}

/**
 * Quote ids are stored server-side and bound to the offering, params, client
 * and referrer. A client can fund below list only with a quote this agent
 * issued; the escrow check resolves the record again.
 */
export async function issueQuote({
  offering,
  params = {},
  client = null,
  referrer = null,
  model = "standard",
  now = Date.now(),
  gasGwei = undefined,
} = {}) {
  if (!offering) throw AppError.badRequest("offering is required.", undefined, "MISSING_OFFERING");
  if (!PRICING_MODELS.includes(model)) {
    throw AppError.badRequest(`model must be one of: ${PRICING_MODELS.join(", ")}.`, undefined, "INVALID_PRICING_MODEL");
  }
  if (model === "performance" && !supportsPerformance(offering)) {
    throw AppError.badRequest(
      "Performance pricing is only available for one-off intelligence offerings.",
      { offeringId: offering.id },
      "PERFORMANCE_NOT_AVAILABLE"
    );
  }
  const listUsdc = basePriceFor(offering, params);
  const gas = gasGwei === undefined ? await liveGasGwei() : gasGwei;
  const discount = discountWindow({ now: new Date(now), gasGwei: gas });
  const performance = model === "performance";
  if (performance && roundUsdc(Math.max(listUsdc * 0.25, 1)) > listUsdc) {
    throw AppError.badRequest(
      "The 1 USDC minimum upfront exceeds this offering's list price; use standard pricing.",
      { offeringId: offering.id, listUsdc },
      "PERFORMANCE_UPFRONT_EXCEEDS_LIST"
    );
  }
  const upfrontUsdc = performance ? roundUsdc(Math.max(listUsdc * 0.25, 1)) : listUsdc;
  const priceUsdc = roundUsdc(upfrontUsdc * (1 - discount.discountBps / 10_000));
  const bonusUsdc = performance ? roundUsdc(listUsdc - upfrontUsdc) : 0;
  const quoteId = crypto.randomUUID();
  const expiresAt = new Date(now + config.revenue.quoteTtlSeconds * 1000).toISOString();
  const quote = {
    id: quoteId,
    offeringId: offering.id,
    params,
    model,
    listUsdc,
    priceUsdc,
    priceUnits: String(toUnits(priceUsdc)),
    bonusUsdc,
    discountBps: discount.discountBps,
    discountReasons: discount.reasons,
    competitive: competitorPosition(offering.id, priceUsdc),
    client: client || null,
    referrer: normaliseReferrer(referrer),
    createdAt: new Date(now).toISOString(),
    expiresAt,
  };
  await store.set(storeHelpers.revenueQuote(quoteId), quote, {
    ttlSeconds: Math.ceil((Date.parse(expiresAt) - now) / 1000),
  });
  return quote;
}

export async function resolveQuote({ quoteId, offering, params = null, client = null, now = Date.now() } = {}) {
  if (!quoteId) return null;
  const quote = await store.get(storeHelpers.revenueQuote(String(quoteId))).catch(() => null);
  if (!quote) {
    throw AppError.conflict("Quote not found or expired. Request a new quote.", { quoteId }, "QUOTE_EXPIRED");
  }
  if (Date.parse(quote.expiresAt) <= now) {
    throw AppError.conflict("Quote expired. Request a new quote.", { quoteId }, "QUOTE_EXPIRED");
  }
  if (offering && quote.offeringId !== offering.id) {
    throw AppError.conflict("Quote was issued for a different offering.", { quoteId }, "QUOTE_MISMATCH");
  }
  if (params !== null && canonical(quote.params) !== canonical(params)) {
    throw AppError.conflict(
      "Quote was issued for different parameters.",
      { quoteId, quotedParams: quote.params },
      "QUOTE_PARAMS_MISMATCH"
    );
  }
  if (quote.client && client && String(quote.client).toLowerCase() !== String(client).toLowerCase()) {
    throw AppError.forbidden("Quote belongs to a different client.", { quoteId }, "QUOTE_CLIENT_MISMATCH");
  }
  return quote;
}

export function quoteEnvelope(quote) {
  return JSON.stringify({
    offeringId: quote.offeringId,
    params: quote.params,
    quoteId: quote.id,
    ...(quote.referrer ? { referrer: quote.referrer } : {}),
  });
}

export async function quotePublicJSON(quote) {
  return {
    quoteId: quote.id,
    offeringId: quote.offeringId,
    params: quote.params,
    model: quote.model,
    listUsdc: quote.listUsdc,
    priceUsdc: quote.priceUsdc,
    priceUnits: quote.priceUnits,
    bonusUsdc: quote.bonusUsdc,
    discountBps: quote.discountBps,
    discountReasons: quote.discountReasons,
    competitive: quote.competitive || competitorPosition(quote.offeringId, quote.priceUsdc),
    referrer: quote.referrer,
    expiresAt: quote.expiresAt,
    escrow: {
      chainId: config.chain.id,
      contract: config.acp.contract,
      currency: "USDC",
      description: quoteEnvelope(quote),
    },
  };
}

export { toUnits as usdcToUnits, USDC_DECIMALS, USDC_SCALE };
