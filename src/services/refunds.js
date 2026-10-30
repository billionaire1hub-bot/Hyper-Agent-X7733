import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { store, storeHelpers } from "../lib/store.js";
import { getAcpJob, rejectJob } from "./escrow.js";
import { shortRpcError } from "../chain/client.js";

const REFUND_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Refunds are executed at the escrow layer: rejecting a FUNDED job returns the
 * locked USDC to the client (directly or via claimRefund after expiry). The
 * agent never releases escrow for failed work, so no wallet-funded double
 * refund is issued.
 */
export async function refundJob({ jobId, reason }) {
  const refundKey = storeHelpers.refund(config.chain.id, jobId);
  const existing = await store.get(refundKey);
  if (existing) return existing;

  let job;
  try {
    job = await getAcpJob(jobId);
  } catch (error) {
    const record = {
      mode: "pending_read",
      reason,
      attemptedAt: new Date().toISOString(),
      error: shortRpcError(error),
      message: "Unable to read the ACP job; refund will be retried by the sweeper.",
    };
    await store.set(refundKey, record, { ttlSeconds: 3600 });
    return record;
  }

  if (!job) {
    const record = {
      mode: "not_found",
      reason,
      attemptedAt: new Date().toISOString(),
      message: "ACP job does not exist on-chain; nothing to refund.",
    };
    await store.set(refundKey, record, { ttlSeconds: 3600 });
    return record;
  }

  if (job.status === 1) {
    try {
      const { txHash, explorer } = await rejectJob(jobId, reason);
      const updated = await getAcpJob(jobId).catch(() => null);
      const record = {
        mode: "escrow_reject",
        reason,
        txHash,
        explorer,
        jobStatusAfter: updated?.statusName || "PENDING_CONFIRMATION",
        claimableBy: job.client,
        claimHint:
          "Escrow funds return to the client. If the contract records a claimable balance, the client may call claimRefund(jobId).",
        attemptedAt: new Date().toISOString(),
      };
      logger.info("job rejected on ACP escrow", { jobId, txHash });
      await store.set(refundKey, record, { ttlSeconds: REFUND_TTL_SECONDS });
      return record;
    } catch (error) {
      const record = {
        mode: "refund_via_expiry",
        reason,
        error: shortRpcError(error),
        claimableBy: job.client,
        expiredAt: job.expiredAt,
        claimHint:
          "Provider-side reject reverted. Escrow stays locked until expiry, then the client can claimRefund(jobId).",
        attemptedAt: new Date().toISOString(),
      };
      logger.warn("escrow reject failed; refund falls back to expiry", {
        jobId,
        message: record.error,
      });
      await store.set(refundKey, record, { ttlSeconds: 3600 });
      return record;
    }
  }

  if (job.status === 4 || job.status === 5) {
    const record = {
      mode: "already_refundable",
      reason,
      jobStatus: job.statusName,
      claimableBy: job.client,
      claimHint: "Job is rejected/expired. Client can call claimRefund(jobId) on the ACP contract.",
      attemptedAt: new Date().toISOString(),
    };
    await store.set(refundKey, record, { ttlSeconds: REFUND_TTL_SECONDS });
    return record;
  }

  const record = {
    mode: "manual_review",
    reason,
    jobStatus: job.statusName,
    message:
      "Escrow is already submitted or completed and cannot be rejected. No automatic refund was issued.",
    attemptedAt: new Date().toISOString(),
  };
  await store.set(refundKey, record, { ttlSeconds: REFUND_TTL_SECONDS });
  return record;
}
