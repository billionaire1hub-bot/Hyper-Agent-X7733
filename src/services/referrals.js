import { getAddress, isAddress } from "viem";
import { config, USDC } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { store, storeHelpers, withLock } from "../lib/store.js";
import {
  encodeErc20Transfer,
  getAgentAddress,
  getTokenBalance,
  sendTransaction,
} from "../chain/client.js";
import { getAcpJob } from "./escrow.js";
import { usdcToUnits } from "./pricing.js";

const RECORD_TTL_SECONDS = 60 * 24 * 60 * 60;
const MAX_ATTEMPTS = 6;

export function commissionUsdc(priceUsdc) {
  const price = Number(priceUsdc);
  if (!Number.isFinite(price) || price <= 0) return 0;
  const raw = (price * config.revenue.referralBps) / 10_000;
  return Number(Math.min(raw, config.revenue.referralMaxUsdc).toFixed(6));
}

function validateReferrer(referrer, { buyer } = {}) {
  if (!isAddress(String(referrer || ""))) {
    throw AppError.badRequest("referrer must be a valid EVM address.", { referrer }, "INVALID_REFERRER");
  }
  const address = getAddress(referrer);
  if (buyer && address.toLowerCase() === getAddress(buyer).toLowerCase()) {
    throw AppError.badRequest("referrer cannot be the buyer.", undefined, "INVALID_REFERRER");
  }
  if (address.toLowerCase() === getAgentAddress().toLowerCase()) {
    throw AppError.badRequest("referrer cannot be the agent wallet.", undefined, "INVALID_REFERRER");
  }
  return address;
}

/**
 * Commissions are queued when a job completes locally, then paid only after the
 * ACP escrow job reaches COMPLETED on-chain and the agent wallet holds the
 * funds. This never pays from principal before settlement.
 */
export async function registerReferral({ jobId, referrer, buyer, priceUsdc }) {
  if (!referrer) return null;
  const amount = commissionUsdc(priceUsdc);
  if (amount < 0.001) return null;
  const address = validateReferrer(referrer, { buyer });
  const id = String(jobId);
  const existing = await store.get(storeHelpers.revenueReferral(id)).catch(() => null);
  if (existing) return existing;

  const record = {
    jobId: id,
    referrer: address,
    buyer: buyer ? getAddress(buyer) : null,
    priceUsdc: Number(priceUsdc),
    commissionUsdc: amount,
    commissionUnits: String(usdcToUnits(amount)),
    bps: config.revenue.referralBps,
    status: "pending",
    attempts: 0,
    createdAt: new Date().toISOString(),
    lastError: null,
    txHash: null,
  };
  await store.set(storeHelpers.revenueReferral(id), record, { ttlSeconds: RECORD_TTL_SECONDS });
  await store.sadd(storeHelpers.revenueReferralQueue(), id);
  logger.info("referral registered", { jobId: id, referrer: address, commissionUsdc: amount });
  return record;
}

async function updateReferral(jobId, patch) {
  const current = await store.get(storeHelpers.revenueReferral(jobId)).catch(() => null);
  if (!current) return null;
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  await store.set(storeHelpers.revenueReferral(jobId), next, { ttlSeconds: RECORD_TTL_SECONDS });
  return next;
}

async function payOne(jobId, log = logger) {
  const record = await store.get(storeHelpers.revenueReferral(jobId)).catch(() => null);
  if (!record) {
    await store.srem(storeHelpers.revenueReferralQueue(), jobId).catch(() => null);
    return { jobId, status: "missing" };
  }
  if (record.status === "paid") {
    await store.srem(storeHelpers.revenueReferralQueue(), jobId).catch(() => null);
    return { jobId, status: "paid", txHash: record.txHash };
  }
  if (record.status === "failed" || record.status === "cancelled") {
    await store.srem(storeHelpers.revenueReferralQueue(), jobId).catch(() => null);
    return { jobId, status: record.status };
  }
  const ageMs = Date.now() - Date.parse(record.createdAt);
  if (Number.isFinite(ageMs) && ageMs < config.revenue.referralMinJobAgeSeconds * 1000) {
    return { jobId, status: "waiting", reason: "JOB_TOO_YOUNG" };
  }

  const job = await getAcpJob(jobId).catch((error) => {
    log.warn("referral job read failed", { jobId, message: error.message });
    return null;
  });
  if (!job) return { jobId, status: "waiting", reason: "JOB_NOT_READABLE" };
  if (job.status === 4 || job.status === 5) {
    const next = await updateReferral(jobId, { status: "cancelled", reason: "JOB_REJECTED_OR_EXPIRED" });
    await store.srem(storeHelpers.revenueReferralQueue(), jobId).catch(() => null);
    return { jobId, status: next?.status || "cancelled" };
  }
  if (job.status !== 3) {
    return { jobId, status: "waiting", reason: "JOB_NOT_COMPLETED", jobStatus: job.statusName };
  }

  const amount = BigInt(record.commissionUnits);
  const wallet = getAgentAddress();
  const balance = await getTokenBalance(USDC.address, wallet);
  const reserve = usdcToUnits(config.revenue.referralReserveUsdc);
  if (balance < amount + reserve) {
    return { jobId, status: "waiting", reason: "INSUFFICIENT_USDC" };
  }

  try {
    const transfer = await sendTransaction(
      { to: USDC.address, data: encodeErc20Transfer(record.referrer, amount) },
      { label: `referral-${jobId}` }
    );
    const paid = await updateReferral(jobId, {
      status: "paid",
      paidAt: new Date().toISOString(),
      txHash: transfer.hash,
      explorer: transfer.explorer,
      lastError: null,
    });
    await store.srem(storeHelpers.revenueReferralQueue(), jobId).catch(() => null);
    log.info("referral commission paid", { jobId, referrer: record.referrer, txHash: transfer.hash });
    return { jobId, status: "paid", amountUsdc: record.commissionUsdc, txHash: paid.txHash };
  } catch (error) {
    const attempts = Number(record.attempts || 0) + 1;
    const failed = attempts >= MAX_ATTEMPTS || error.code === "WALLET_NOT_CONFIGURED";
    await updateReferral(jobId, {
      attempts,
      status: failed ? "failed" : "pending",
      lastError: { code: error.code || "REFERRAL_PAYOUT_FAILED", message: error.message, at: new Date().toISOString() },
    });
    if (failed) await store.srem(storeHelpers.revenueReferralQueue(), jobId).catch(() => null);
    log.warn("referral payout failed", { jobId, attempts, message: error.message });
    return { jobId, status: failed ? "failed" : "retry", error: error.message };
  }
}

export async function processReferralPayouts({ limit = 3, log = logger } = {}) {
  const ids = await store.smembers(storeHelpers.revenueReferralQueue()).catch(() => []);
  const results = [];
  for (const jobId of ids.slice(0, Math.max(1, limit))) {
    const { acquired, result } = await withLock(
      storeHelpers.revenueReferralLock(jobId),
      120,
      () => payOne(jobId, log),
      { waitMs: 4000 }
    );
    results.push(acquired ? result : { jobId, status: "locked" });
  }
  return {
    queued: ids.length,
    processed: results.length,
    paid: results.filter((entry) => entry.status === "paid").length,
    waiting: results.filter((entry) => entry.status === "waiting").length,
    failed: results.filter((entry) => entry.status === "failed").length,
    results,
  };
}

export async function referralStatus() {
  const ids = await store.smembers(storeHelpers.revenueReferralQueue()).catch(() => []);
  const records = await Promise.all(
    ids.slice(0, 20).map((id) => store.get(storeHelpers.revenueReferral(id)).catch(() => null))
  );
  const valid = records.filter(Boolean);
  return {
    bps: config.revenue.referralBps,
    maxUsdc: config.revenue.referralMaxUsdc,
    queued: ids.length,
    pending: valid.filter((record) => record.status === "pending").length,
    paidTotalUsdc: Number(
      valid
        .filter((record) => record.status === "paid")
        .reduce((sum, record) => sum + Number(record.commissionUsdc || 0), 0)
        .toFixed(6)
    ),
    recent: valid
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, 10)
      .map((record) => ({
        jobId: record.jobId,
        referrer: record.referrer,
        commissionUsdc: record.commissionUsdc,
        status: record.status,
        txHash: record.txHash,
        createdAt: record.createdAt,
      })),
  };
}

