import { logger } from "../lib/logger.js";
import { store, storeHelpers } from "../lib/store.js";
import {
  JOB_STATUS,
  getJobRecord,
  isStaleProcessing,
  isTerminal,
  listPendingJobs,
  saveJobRecord,
} from "./jobs.js";
import { refundJob } from "./refunds.js";

const MAX_REFUND_ATTEMPTS = 5;

export async function sweepJobs({ limit = 25 } = {}) {
  const ids = await listPendingJobs();
  const outcomes = [];

  for (const id of ids.slice(0, limit)) {
    const record = await getJobRecord(id);
    if (!record) {
      await store.srem(storeHelpers.pendingJobs(), id);
      outcomes.push({ jobId: id, action: "dropped", reason: "record_missing" });
      continue;
    }

    if (isTerminal(record.status)) {
      await store.srem(storeHelpers.pendingJobs(), id);
      outcomes.push({ jobId: id, action: "closed" });
      continue;
    }

    if (record.status === JOB_STATUS.PROCESSING && !isStaleProcessing(record)) {
      continue;
    }

    const refundMode = record.refund?.mode;
    if (refundMode === "escrow_reject" || refundMode === "already_refundable") {
      await saveJobRecord({ ...record, status: JOB_STATUS.REFUNDED, refundedAt: new Date().toISOString() });
      await store.srem(storeHelpers.pendingJobs(), id);
      outcomes.push({ jobId: id, action: "marked_refunded" });
      continue;
    }

    const attempts = Number(record.sweepAttempts || 0) + 1;
    if (attempts > MAX_REFUND_ATTEMPTS) {
      await store.srem(storeHelpers.pendingJobs(), id);
      await saveJobRecord({
        ...record,
        status: JOB_STATUS.REFUND_PENDING,
        sweepAttempts: attempts,
        refund: {
          ...(record.refund || {}),
          mode: "manual_review",
          message: "Sweeper exhausted refund attempts. Inspect the ACP job manually.",
        },
      });
      outcomes.push({ jobId: id, action: "manual_review" });
      continue;
    }

    const refund = await refundJob({
      jobId: id,
      reason: record.status === JOB_STATUS.PROCESSING ? "SLA sweep: execution did not complete" : "refund retry",
    }).catch((error) => ({ mode: "refund_error", message: error.message }));

    const resolved = ["escrow_reject", "already_refundable"].includes(refund.mode);
    const saved = await saveJobRecord({
      ...record,
      status: resolved ? JOB_STATUS.REFUNDED : JOB_STATUS.REFUND_PENDING,
      refund,
      sweepAttempts: attempts,
      error:
        record.error ||
        (record.status === JOB_STATUS.PROCESSING
          ? { code: "SLA_EXCEEDED", message: "Execution did not finish within the SLA window." }
          : null),
      ...(resolved ? { refundedAt: new Date().toISOString() } : {}),
    });

    if (resolved) {
      await store.srem(storeHelpers.pendingJobs(), id);
    }
    outcomes.push({ jobId: id, action: resolved ? "refunded" : "refund_pending", mode: refund.mode, status: saved.status });
    logger.info("sweeper processed job", { jobId: id, mode: refund.mode, resolved });
  }

  return { scanned: ids.length, processed: outcomes.length, outcomes };
}
