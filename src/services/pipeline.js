import { getAddress, isAddress } from "viem";
import { config, ONCHAIN_EXECUTION_OFFERINGS, USDC, walletConfigured } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger as baseLogger } from "../lib/logger.js";
import { storeHelpers, withLock } from "../lib/store.js";
import {
  completeJobRecord,
  createJobRecord,
  failJobRecord,
  getJobRecord,
  isStaleProcessing,
  JOB_STATUS,
  slaExpired,
} from "./jobs.js";
import { getOffering, validateParams, donationShares } from "./offerings.js";
import { parseJobId, verifyEscrow } from "./escrow.js";
import { settle } from "./settlement.js";
import { refundJob } from "./refunds.js";
import { registerReferral } from "./referrals.js";
import {
  activateRetainer,
  agentCredit,
  agentRevenueAudit,
  deepAnalytics,
  flashAlerts,
  gasAdvisor,
  jobRadar,
  liquidationGuard,
  newPoolRadar,
  previewRevenueOffering,
  providerBenchmark,
  smartMoneyFlow,
  tokenSecurityScan,
  virtualsAlpha,
  walletRiskAudit,
  yieldRadar,
} from "./revenue.js";
import { executeSwap, previewSwap } from "./swap.js";
import { executeBatchUsdcTransfer, executeTransfer } from "./transfer.js";
import { executeDonation } from "./donations.js";
import { resolveTokens, resolveToken } from "./tokens.js";
import {
  cryptoNews,
  intelPreview,
  kolAlpha,
  megaReport,
  suggestTrade,
  tokenAlpha,
  tokenInfo,
  topicResearch,
  trendingTokens,
  twitterAlpha,
  yieldAlpha,
} from "./intel.js";
import {
  fromUnits,
  getAgentAddress,
  getAllowance,
  getTokenBalance,
  toUnits,
  agentEthBalance,
  onchainGasGated,
} from "../chain/client.js";
import { gasUnlockThresholdWei } from "./gas.js";
import { executeInsight, insightsPreview, INSIGHT_OFFERINGS } from "./insights.js";

const LOCK_TTL_SECONDS = 180;
const MIN_REMAINING_MS = 10_000;

export async function runOffering({ offering, params, buyer, log, jobId, priceUsdc, bonusUsdc = 0 }) {
  switch (offering.id) {
    case "token_swap":
      return executeSwap({ params, buyer, log });
    case "transfer_token":
      return executeTransfer({ params, buyer, log });
    case "fund_startup":
    case "semi_batch_fund_startup":
    case "batch_fund_startup":
      return executeDonation({ offering, params, log });
    case "resolve_tokens": {
      const tokens = await resolveTokens(params.tokens);
      return {
        status: "resolved",
        count: tokens.length,
        tokens,
      };
    }
    case "suggest_a_trade":
      return suggestTrade({ params, buyer, log });
    case "mega_report":
      return megaReport({ params, buyer, log });
    case "twitter_alpha":
      return twitterAlpha({ params, buyer, log });
    case "crypto_news":
      return cryptoNews({ params, buyer, log });
    case "topic_research":
      return topicResearch({ params, buyer, log });
    case "yield_alpha":
      return yieldAlpha({ params, buyer, log });
    case "kol_alpha":
      return kolAlpha({ params, buyer, log });
    case "trending_tokens":
      return trendingTokens({ params, buyer, log });
    case "token_info":
      return tokenInfo({ params, buyer, log });
    case "token_alpha":
      return tokenAlpha({ params, buyer, log });
    case "deep_analytics":
      return deepAnalytics({ params, buyer, log, priceUsdc, bonusUsdc });
    case "intel_retainer":
      return activateRetainer({ params, buyer, log, jobId, priceUsdc });
    case "flash_alert":
      return flashAlerts({ params, buyer, log });
    case "gas_advisor":
      return gasAdvisor({ params, buyer, log });
    case "yield_radar":
      return yieldRadar({ params, buyer, log });
    case "agent_credit":
      return agentCredit({ params, buyer, log });
    case "token_security_scan":
      return tokenSecurityScan({ params, log });
    case "wallet_risk_audit":
      return walletRiskAudit({ params, log });
    case "liquidation_guard":
      return liquidationGuard({ params, buyer, log, jobId, priceUsdc });
    case "new_pool_radar":
      return newPoolRadar({ params, buyer, log, jobId, priceUsdc });
    case "smart_money_flow":
      return smartMoneyFlow({ params, buyer, log, jobId, priceUsdc });
    case "batch_executor":
      return executeBatchUsdcTransfer({ params, buyer, priceUsdc, log });
    case "agent_revenue_audit":
      return agentRevenueAudit({ params, log });
    case "provider_benchmark":
      return providerBenchmark({ params, log });
    case "virtuals_alpha":
      return virtualsAlpha({ params, log });
    case "job_radar":
      return jobRadar({ params, buyer, log, jobId, priceUsdc });
    default:
      if (INSIGHT_OFFERINGS.has(offering.id)) {
        return executeInsight({ offering, params });
      }
      throw AppError.badRequest(`Offering ${offering.id} is not executable.`, undefined, "UNSUPPORTED_OFFERING");
  }
}

function completedPayload(record, { replayed = false } = {}) {
  return {
    success: true,
    status: "completed",
    replayed,
    jobId: record.jobId,
    offering_id: record.offeringId,
    offeringName: record.offeringName,
    buyer: record.buyer,
    price: { amount: record.priceUsdc, currency: "USDC", units: record.priceUnits },
    quote: record.quote || null,
    referrer: record.referrer || null,
    result: record.result,
    deliverableHash: record.deliverableHash,
    settlement: record.settlement,
    escrow: record.escrow,
    acp: {
      protocol: "virtuals-acp",
      chainId: record.chainId,
      escrowContract: config.acp.contract,
      jobId: record.jobId,
      status: "completed",
    },
    completedAt: record.completedAt,
    timestamp: new Date().toISOString(),
  };
}

function failedPayload(record) {
  const refund = record.refund;
  const refunded = refund && ["escrow_reject", "already_refundable"].includes(refund.mode);
  return {
    success: false,
    status: refunded ? "refunded" : "refund_pending",
    jobId: record.jobId,
    offering_id: record.offeringId,
    buyer: record.buyer,
    error: record.error,
    refund,
    acp: {
      protocol: "virtuals-acp",
      chainId: record.chainId,
      escrowContract: config.acp.contract,
      jobId: record.jobId,
      status: "failed",
    },
    timestamp: new Date().toISOString(),
  };
}

function assertSameParams(record, params) {
  if (JSON.stringify(record.params) !== JSON.stringify(params)) {
    throw AppError.conflict(
      "This ACP job was already processed with different parameters.",
      { jobId: record.jobId, recordedParams: record.params },
      "PARAMS_MISMATCH"
    );
  }
}

export async function executeAcpJob({ jobId, offeringId, params, buyer, quoteId = null, referrer = null, log = baseLogger }) {
  const offering = getOffering(offeringId);
  const normalized = validateParams(offering, params);
  const id = String(parseJobId(jobId));
  const normalizedReferrer = referrer && isAddress(String(referrer)) ? getAddress(referrer) : null;

  const preexisting = await getJobRecord(id);
  if (preexisting) {
    assertSameParams(preexisting, normalized);
    if (preexisting.status === JOB_STATUS.COMPLETED) {
      return { replayed: true, httpStatus: 200, payload: completedPayload(preexisting, { replayed: true }) };
    }
    if ([JOB_STATUS.REFUNDED, JOB_STATUS.REFUND_PENDING, JOB_STATUS.FAILED].includes(preexisting.status)) {
      return { replayed: true, httpStatus: 200, payload: failedPayload(preexisting) };
    }
    if (!isStaleProcessing(preexisting)) {
      throw AppError.conflict(
        "This ACP job is already being processed.",
        { jobId: id, startedAt: preexisting.createdAt },
        "JOB_IN_PROGRESS"
      );
    }
  }

  if (ONCHAIN_EXECUTION_OFFERINGS.has(offering.id)) {
    const ethBalance = await agentEthBalance();
    const { thresholdWei, minUsd, ethUsd, ethUsdSource } = await gasUnlockThresholdWei();
    if (onchainGasGated({ offeringId: offering.id, ethBalance, unlockThresholdWei: thresholdWei })) {
      throw AppError.unavailable(
        `On-chain offering ${offering.id} is temporarily gated: the agent wallet holds less than ${minUsd} USD of ETH for gas (${ethUsdSource} ETH/USD price ${ethUsd}).`,
        {
          offeringId: offering.id,
          unlockMinUsd: minUsd,
          hint: "Off-chain revenue funds the wallet until it crosses the unlock threshold; the job stays funded in escrow and will be retried by intake.",
        },
        "WALLET_GAS_UNAVAILABLE"
      );
    }
  }

  const escrow = await verifyEscrow({ jobId: id, offering, buyer, params: normalized, quoteId });
  const buyerAddress = getAddress(buyer || escrow.job.client);
  const effectiveReferrer =
    normalizedReferrer ||
    (escrow.quote?.referrer && isAddress(String(escrow.quote.referrer)) ? getAddress(escrow.quote.referrer) : null);

  const lock = await withLock(
    storeHelpers.jobLock(config.chain.id, id),
    LOCK_TTL_SECONDS,
    async () => {
      const fresh = await getJobRecord(id);
      if (fresh?.status === JOB_STATUS.COMPLETED) {
        assertSameParams(fresh, normalized);
        return { kind: "replay", record: fresh };
      }
      if (fresh?.status === JOB_STATUS.PROCESSING && !isStaleProcessing(fresh)) {
        throw AppError.conflict(
          "This ACP job is already being processed.",
          { jobId: id, startedAt: fresh.createdAt },
          "JOB_IN_PROGRESS"
        );
      }

      const record = await createJobRecord({
        jobId: id,
        offering,
        buyer: buyerAddress,
        params: normalized,
        escrow,
        priceUsdc: escrow.priceUsdc,
        priceUnits: escrow.requiredUnits,
        referrer: effectiveReferrer,
      });

      const remainingMs = Date.parse(record.deadlineAt) - Date.now();
      if (slaExpired(record) || remainingMs < MIN_REMAINING_MS) {
        log.warn("job rejected before execution: SLA window too short", { jobId: id, remainingMs });
        const refund = await refundJob({ jobId: id, reason: "SLA window expired before execution" }).catch(
          (error) => ({ mode: "refund_error", message: error.message })
        );
        const failed = await failJobRecord(record, {
          error: {
            code: "SLA_EXPIRED",
            message: "The SLA window expired before execution could start. Escrow refund initiated.",
          },
          refund,
        });
        return { kind: "failed", record: failed };
      }

      try {
        const result = await runOffering({
          offering,
          params: normalized,
          buyer: buyerAddress,
          log,
          jobId: id,
          priceUsdc: record.priceUsdc,
          bonusUsdc: record.quote?.bonusUsdc || 0,
        });
        const settlement = await settle({ jobId: id, result });
        const completed = await completeJobRecord(record, {
          result,
          deliverableHash: settlement.deliverableHash,
          settlement,
        });
        await registerReferral({
          jobId: id,
          referrer: effectiveReferrer,
          buyer: buyerAddress,
          priceUsdc: record.priceUsdc,
        }).catch((error) => log.warn("referral registration failed", { jobId: id, message: error.message }));
        log.info("ACP job completed", {
          jobId: id,
          offering: offering.id,
          txHash: result?.txHash || result?.projects?.[0]?.txHash || null,
          submitted: settlement.submitted,
        });
        return { kind: "completed", record: completed };
      } catch (error) {
        log.error("ACP job failed", {
          jobId: id,
          offering: offering.id,
          code: error.code,
          message: error.message,
        });
        const refund = await refundJob({
          jobId: id,
          reason: `execution failed: ${error.code || "ERROR"}`,
        }).catch((refundError) => ({ mode: "refund_error", message: refundError.message }));

        const failed = await failJobRecord(record, {
          error: {
            code: error.code || "EXECUTION_FAILED",
            message: error.message,
            details: error.details || null,
          },
          refund,
        });
        return { kind: "failed", record: failed };
      }
    },
    { waitMs: 6000 }
  );

  if (!lock.acquired) {
    throw AppError.conflict(
      "Another execution is currently holding this job lock. Retry shortly.",
      { jobId: id },
      "JOB_LOCKED"
    );
  }

  if (lock.result.kind === "replay") {
    return { replayed: true, httpStatus: 200, payload: completedPayload(lock.result.record, { replayed: true }) };
  }
  if (lock.result.kind === "completed") {
    return { replayed: false, httpStatus: 200, payload: completedPayload(lock.result.record) };
  }
  return { replayed: false, httpStatus: 200, payload: failedPayload(lock.result.record) };
}

export async function previewOffering({ offering, params, buyer }) {
  const normalized = validateParams(offering, params);

  const revenue = await previewRevenueOffering({ offering, params: normalized });
  if (revenue) return revenue;

  if (INSIGHT_OFFERINGS.has(offering.id)) {
    return insightsPreview({ offering, params: normalized });
  }

  if (offering.category === "intelligence") {
    return intelPreview({ offering, params: normalized });
  }

  switch (offering.id) {
    case "token_swap":
      return {
        offering_id: offering.id,
        action: "preview_swap",
        price: { amount: offering.priceUsdc, currency: "USDC" },
        quote: await previewSwap({
          sellToken: normalized.sellToken,
          buyToken: normalized.buyToken,
          amount: normalized.amount,
          slippageBps: normalized.maxSlippageBps,
        }),
        execute: "Create a funded ACP job and POST /api/acp with this offeringId and params.",
      };
    case "transfer_token": {
      const token = await resolveToken(normalized.tokenAddress, { allowNative: false });
      const amount = toUnits(normalized.amount, token.decimals);
      const agent = walletConfigured ? getAgentAddress() : null;
      const owner = buyer ? getAddress(buyer) : null;
      const allowance = owner && agent ? await getAllowance(token.address, owner, agent) : null;
      return {
        offering_id: offering.id,
        action: "preview_transfer",
        price: { amount: offering.priceUsdc, currency: "USDC" },
        token: { address: token.address, symbol: token.symbol, decimals: token.decimals },
        target: normalized.targetAddress,
        amount: String(amount),
        allowance: allowance === null ? null : String(allowance),
        requiresApproval: allowance !== null ? allowance < amount : null,
        execute: "Create a funded ACP job and POST /api/acp with this offeringId and params.",
      };
    }
    case "fund_startup":
    case "semi_batch_fund_startup":
    case "batch_fund_startup": {
      const shares = donationShares(offering, normalized);
      const forwardTotal = shares.reduce((sum, share) => sum + share.amount, 0n);
      const serviceFee = offering.priceUnits - forwardTotal;
      const agent = walletConfigured ? getAgentAddress() : null;
      const balance = agent ? await getTokenBalance(USDC.address, agent) : null;
      return {
        offering_id: offering.id,
        action: "preview_donation",
        price: { amount: offering.priceUsdc, currency: "USDC" },
        marginBps: config.revenue.donationMarginBps,
        serviceFeeUsdc: fromUnits(serviceFee, USDC.decimals),
        forwardedUsdc: fromUnits(forwardTotal, USDC.decimals),
        shares: shares.map((share) => ({
          project: share.address,
          amountUnits: String(share.amount),
          amountUsdc: fromUnits(share.amount, USDC.decimals),
        })),
        agentUsdcBalance: balance === null ? null : fromUnits(balance, USDC.decimals),
        execute: "Create a funded ACP job and POST /api/acp with this offeringId and params.",
      };
    }
    case "resolve_tokens": {
      const tokens = await resolveTokens(normalized.tokens);
      return {
        offering_id: offering.id,
        action: "resolve_tokens",
        price: { amount: offering.priceUsdc, currency: "USDC" },
        tokens,
      };
    }
    default:
      throw AppError.badRequest("Unsupported offering preview.", undefined, "UNSUPPORTED_OFFERING");
  }
}
