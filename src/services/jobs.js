import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { store, storeHelpers } from "../lib/store.js";

export const JOB_STATUS = {
  PROCESSING: "processing",
  COMPLETED: "completed",
  FAILED: "failed",
  REFUNDED: "refunded",
  REFUND_PENDING: "refund_pending",
};

const JOB_TTL_SECONDS = 7 * 24 * 60 * 60;
const STALE_PROCESSING_MS = 10 * 60 * 1000;

const jobKey = (jobId) => storeHelpers.job(config.chain.id, jobId);

export const isTerminal = (status) =>
  [JOB_STATUS.COMPLETED, JOB_STATUS.REFUNDED, JOB_STATUS.FAILED].includes(status);

export async function getJobRecord(jobId) {
  return store.get(jobKey(jobId));
}

export async function saveJobRecord(record) {
  const stored = { ...record, updatedAt: new Date().toISOString() };
  await store.set(jobKey(record.jobId), stored, { ttlSeconds: JOB_TTL_SECONDS });
  return stored;
}

export async function createJobRecord({ jobId, offering, buyer, params, escrow, priceUsdc, priceUnits, referrer }) {
  const now = Date.now();
  const record = {
    jobId: String(jobId),
    chainId: config.chain.id,
    offeringId: offering.id,
    offeringName: offering.name,
    buyer,
    priceUsdc: String(priceUsdc ?? offering.priceUsdc),
    priceUnits: String(priceUnits ?? offering.priceUnits),
    params,
    referrer: referrer || null,
    quote: escrow?.quote || null,
    status: JOB_STATUS.PROCESSING,
    createdAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + offering.slaSeconds * 1000).toISOString(),
    attempts: 0,
    escrow: escrow
      ? {
          verified: true,
          contract: escrow.escrowContract,
          budget: escrow.job.budget,
          expiredAt: escrow.job.expiredAt,
          verifiedAt: escrow.verifiedAt,
        }
      : null,
    result: null,
    error: null,
    refund: null,
    deliverableHash: null,
    settlement: null,
  };
  const saved = await saveJobRecord(record);
  await store.sadd(storeHelpers.pendingJobs(), record.jobId);
  return saved;
}

export async function completeJobRecord(record, { result, deliverableHash, settlement }) {
  const saved = await saveJobRecord({
    ...record,
    status: JOB_STATUS.COMPLETED,
    completedAt: new Date().toISOString(),
    result,
    deliverableHash: deliverableHash || null,
    settlement: settlement || null,
    error: null,
  });
  await store.srem(storeHelpers.pendingJobs(), record.jobId);
  return saved;
}

export async function failJobRecord(record, { error, refund }) {
  const status =
    refund && (refund.mode === "escrow_reject" || refund.mode === "already_refundable")
      ? JOB_STATUS.REFUNDED
      : JOB_STATUS.REFUND_PENDING;
  const saved = await saveJobRecord({
    ...record,
    status,
    failedAt: new Date().toISOString(),
    error,
    refund: refund || null,
  });
  // Refund-pending jobs stay in the pending set so the cron sweeper can retry.
  if (status === JOB_STATUS.REFUNDED) {
    await store.srem(storeHelpers.pendingJobs(), record.jobId);
  }
  return saved;
}

export async function markRefunded(record, refund) {
  const saved = await saveJobRecord({
    ...record,
    status: JOB_STATUS.REFUNDED,
    refund,
    refundedAt: new Date().toISOString(),
  });
  await store.srem(storeHelpers.pendingJobs(), record.jobId);
  return saved;
}

export async function listPendingJobs() {
  try {
    return await store.smembers(storeHelpers.pendingJobs());
  } catch (error) {
    logger.warn("failed to list pending jobs", { message: error.message });
    return [];
  }
}

export function isStaleProcessing(record) {
  if (!record || record.status !== JOB_STATUS.PROCESSING) return false;
  const updated = Date.parse(record.updatedAt || record.createdAt || 0);
  return Number.isFinite(updated) && Date.now() - updated > STALE_PROCESSING_MS;
}

export function slaExpired(record) {
  const deadline = Date.parse(record?.deadlineAt || 0);
  return Number.isFinite(deadline) && Date.now() > deadline;
}
