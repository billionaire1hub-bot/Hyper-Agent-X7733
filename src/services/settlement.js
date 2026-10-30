import { keccak256, toBytes } from "viem";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { submitDeliverable } from "./escrow.js";

export function deliverableHashFor(payload) {
  const canonical = JSON.stringify(payload, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );
  return keccak256(toBytes(canonical));
}

/**
 * Submits the deliverable hash to the ACP contract as the provider. A failure
 * here never invalidates completed work: the execution result is returned and
 * the settlement object records what the evaluator still has to do.
 */
export async function settle({ jobId, result }) {
  const deliverableHash = deliverableHashFor(result);
  const base = {
    protocol: "virtuals-acp",
    chainId: config.chain.id,
    escrowContract: config.acp.contract,
    deliverableHash,
    submitted: false,
    submitTxHash: null,
    submitError: null,
    next: "client_or_evaluator_calls_complete",
    completedAt: new Date().toISOString(),
  };

  if (!config.acp.autoSubmitDeliverable) {
    return { ...base, submitError: "AUTO_SUBMIT_DELIVERABLE disabled by configuration." };
  }

  try {
    const submission = await submitDeliverable(jobId, deliverableHash);
    logger.info("deliverable submitted to ACP", { jobId, txHash: submission.txHash });
    return {
      ...base,
      submitted: true,
      submitTxHash: submission.txHash,
      submitExplorer: submission.explorer,
      status: "SUBMITTED",
    };
  } catch (error) {
    logger.warn("deliverable submission failed", { jobId, message: error.message });
    return {
      ...base,
      submitError: error.message,
      submitErrorCode: error.code || "SUBMIT_FAILED",
    };
  }
}
