import { config, isVercel, walletConfigured } from "../config.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { acquireLock, releaseLock, store, storeHelpers } from "../lib/store.js";
import { getAgentAddress, agentEthBalance } from "../chain/client.js";
import { gasUnlockThresholdWei } from "./gas.js";
import { getAcpJobs, getJobCounter } from "./escrow.js";
import { getJobRecord } from "./jobs.js";
import { executeAcpJob } from "./pipeline.js";
import { OFFERINGS, getOffering, validateParams } from "./offerings.js";

const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const LOCK_TTL_SECONDS = 240;
const FUNDED = 1;
const OFFERING_IDS = new Set(OFFERINGS.map((offering) => offering.id));

// Provider-read failures surface as these codes before any job record exists;
// deferring them retries the still-FUNDED job on the next pass instead of
// silently advancing the cursor past it.
const RETRYABLE_INTAKE_CODES = new Set(["ACP_READ_FAILED", "RPC_READ_FAILED", "ACP_CONTRACT_MISSING"]);

export function intakeFailureDisposition(error, recordExists) {
  if (error?.code === "WALLET_GAS_UNAVAILABLE") return "gas_gated";
  if (recordExists) return "advance";
  if (!error?.code || RETRYABLE_INTAKE_CODES.has(error.code)) return "deferred";
  return "advance";
}

/**
 * Jobs carry their order in the ACP description field. Accepted shapes:
 *   {"offeringId":"token_swap","params":{"sellToken":"USDC",...}}
 *   token_swap {"sellToken":"USDC","buyToken":"WETH","amount":"1"}
 *   offering:trending_tokens
 * Free-form prose is not interpreted, because executing an on-chain order from
 * a guessed parse would spend real escrow.
 */
export function parseJobOrder(description) {
  const raw = String(description ?? "").trim();
  if (!raw) return null;

  if (raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const offeringId = String(parsed.offeringId ?? parsed.offering_id ?? parsed.offering ?? "")
        .trim()
        .toLowerCase();
      if (!OFFERING_IDS.has(offeringId)) return null;
      if (
        parsed.params !== undefined &&
        parsed.params !== null &&
        (typeof parsed.params !== "object" || Array.isArray(parsed.params))
      ) {
        return null;
      }
      const params =
        parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)
          ? parsed.params
          : {};
      const quoteId = typeof parsed.quoteId === "string" && parsed.quoteId.trim() ? parsed.quoteId.trim() : null;
      const referrer = typeof parsed.referrer === "string" && parsed.referrer.trim() ? parsed.referrer.trim() : null;
      return { offeringId, params, quoteId, referrer, format: "json" };
    } catch {
      return null;
    }
  }

  const prefixed = raw.match(/^(?:offering\s*[:=]\s*)?([a-z0-9_]+)\s*([\s\S]*)$/i);
  if (!prefixed) return null;
  const offeringId = prefixed[1].toLowerCase();
  if (!OFFERING_IDS.has(offeringId)) return null;

  const rest = prefixed[2].trim();
  if (!rest) return { offeringId, params: {}, format: "id" };
  if (!rest.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(rest);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (
      parsed.params !== undefined &&
      parsed.params !== null &&
      (typeof parsed.params !== "object" || Array.isArray(parsed.params))
    ) {
      return null;
    }
    const params =
      parsed.params && typeof parsed.params === "object" && !Array.isArray(parsed.params)
        ? parsed.params
        : parsed.params === undefined
          ? parsed
          : {};
    return { offeringId, params, format: "text" };
  } catch {
    return null;
  }
}

/**
 * Returns the next [from, to] job-id window. On first run without an explicit
 * start id the cursor initializes at the current head so a fresh deployment
 * does not replay the full on-chain history.
 */
export function scanRange({ cursor, counter, scanLimit, startId = 0 }) {
  const head = BigInt(counter);
  let from;
  if (cursor === null || cursor === undefined) {
    const start = BigInt(Math.max(0, Number(startId) || 0));
    if (start <= 0n) return null;
    from = start > head ? head + 1n : start;
  } else {
    from = BigInt(cursor) + 1n;
  }

  if (from > head) return { from: null, to: null, last: head };
  const limit = BigInt(Math.max(1, Number(scanLimit) || 1));
  const to = from + limit - 1n > head ? head : from + limit - 1n;
  return { from, to, last: to };
}

const cursorKey = () => storeHelpers.intakeCursor();

async function loadCursor() {
  const raw = await store.get(cursorKey()).catch(() => null);
  if (raw === null || raw === undefined) return null;
  try {
    const value = BigInt(String(raw));
    return value >= 0n ? value : null;
  } catch {
    return null;
  }
}

async function saveState(summary) {
  await store
    .set(storeHelpers.intakeState(), summary, { ttlSeconds: STATE_TTL_SECONDS })
    .catch((error) => logger.warn("failed to save intake state", { message: error.message }));
}

function recordOutcome(summary, entry) {
  summary.outcomes.push(entry);
  if (summary.outcomes.length > 20) summary.outcomes.shift();
}

/**
 * One discovery pass: read the new job ids, keep the FUNDED jobs assigned to
 * this agent, parse the order, validate parameters and execute sequentially.
 * The cursor only advances past work that was actually handled, so deferred
 * jobs are retried on the next pass.
 */
export async function intakeOnce({
  reason = "manual",
  limit = config.intake.batch,
  scanLimit = config.intake.scanLimit,
  budgetMs = config.intake.budgetMs,
} = {}) {
  if (!config.intake.enabled) return { status: "disabled", reason: "ACP_INTAKE_ENABLED is false" };
  if (!walletConfigured) return { status: "disabled", reason: "WALLET_NOT_CONFIGURED", reasonSource: reason };

  const lockToken = await acquireLock(storeHelpers.intakeLock(), LOCK_TTL_SECONDS);
  if (!lockToken) return { status: "skipped", reason: "ANOTHER_INTAKE_ACTIVE", reasonSource: reason };

  const startedAt = Date.now();
  const summary = {
    status: "ok",
    reasonSource: reason,
    scanned: 0,
    matched: 0,
    executed: 0,
    failed: 0,
    deferred: 0,
    unrecognized: 0,
    gasGated: 0,
    cursor: null,
    lastScanned: null,
    outcomes: [],
    error: null,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
  };

  try {
    const counter = await getJobCounter();
    const cursor = await loadCursor();
    const range = scanRange({
      cursor,
      counter,
      scanLimit,
      startId: config.intake.startId,
    });

    if (!range) {
      await store.set(cursorKey(), String(counter));
      summary.status = "initialized";
      summary.cursor = String(counter);
      summary.finishedAt = new Date().toISOString();
      await saveState(summary);
      logger.info("ACP intake initialized", { cursor: String(counter), reason });
      return summary;
    }

    const agent = getAgentAddress().toLowerCase();
    let executions = 0;

    const processMatchedJob = async ({ job, jobId }) => {
      summary.matched += 1;

      const existing = await getJobRecord(jobId).catch(() => null);
      if (existing) {
        recordOutcome(summary, { jobId, action: "already_recorded", status: existing.status });
        return "advance";
      }

      const order = parseJobOrder(job.description);
      if (!order) {
        summary.unrecognized += 1;
        recordOutcome(summary, { jobId, action: "unrecognized_description" });
        logger.warn("ACP intake skipped job with unreadable description", { jobId });
        return "advance";
      }

      try {
        validateParams(getOffering(order.offeringId), order.params);
      } catch (error) {
        summary.unrecognized += 1;
        recordOutcome(summary, {
          jobId,
          action: "invalid_order",
          offeringId: order.offeringId,
          code: error.code || "INVALID_ORDER",
        });
        return "advance";
      }

      if (executions >= limit || Date.now() - startedAt > budgetMs) {
        return "deferred";
      }

      executions += 1;
      try {
        const result = await executeAcpJob({
          jobId,
          offeringId: order.offeringId,
          params: order.params,
          buyer: job.client,
          quoteId: order.quoteId || null,
          referrer: order.referrer || null,
          log: logger,
        });
        const outcome = result.payload?.status === "completed" ? "completed" : "failed";
        if (outcome === "completed") summary.executed += 1;
        else summary.failed += 1;
        recordOutcome(summary, {
          jobId,
          offeringId: order.offeringId,
          action: outcome,
          httpStatus: result.httpStatus,
        });
      } catch (error) {
        if (error.code === "WALLET_GAS_UNAVAILABLE") {
          summary.gasGated += 1;
          recordOutcome(summary, { jobId, offeringId: order.offeringId, action: "gas_gated", code: error.code });
          await store
            .sadd(storeHelpers.intakeGasGated(), jobId)
            .catch((err) => logger.warn("failed to track gas-gated job", { jobId, message: err.message }));
          logger.info("ACP intake gas-gated on-chain job (agent wallet has no ETH)", {
            jobId,
            offeringId: order.offeringId,
          });
          return "gas_gated";
        }
        const record = await getJobRecord(jobId).catch(() => null);
        if (intakeFailureDisposition(error, Boolean(record)) === "deferred") {
          summary.failed += 1;
          recordOutcome(summary, {
            jobId,
            offeringId: order.offeringId,
            action: "transient_deferred",
            code: error.code || "UNCLASSIFIED",
            message: error.message,
          });
          logger.warn("ACP intake deferred job after transient pre-record failure; retrying next pass", {
            jobId,
            offeringId: order.offeringId,
            message: error.message,
          });
          return "deferred";
        }
        summary.failed += 1;
        recordOutcome(summary, {
          jobId,
          offeringId: order.offeringId,
          action: "error",
          code: error.code || "INTAKE_EXECUTION_FAILED",
          message: error.message,
        });
        logger.warn("ACP intake execution failed", { jobId, message: error.message });
      }
      return "advance";
    };

    // Retry jobs gas-gated by a previous low balance once the wallet crosses
    // the USD-denominated unlock threshold.
    const gatedIds = await store.smembers(storeHelpers.intakeGasGated()).catch(() => []);
    if (gatedIds.length > 0) {
      const ethBalance = await agentEthBalance({ force: true });
      const { thresholdWei } = await gasUnlockThresholdWei();
      if (ethBalance !== null && ethBalance >= thresholdWei) {
        const gatedJobs = await getAcpJobs(gatedIds);
        for (let index = 0; index < gatedJobs.length; index += 1) {
          const job = gatedJobs[index];
          const jobId = gatedIds[index];
          if (!job || job.status !== FUNDED || job.provider.toLowerCase() !== agent) {
            await store.srem(storeHelpers.intakeGasGated(), jobId).catch(() => {});
            continue;
          }
          const disposition = await processMatchedJob({ job, jobId });
          if (disposition === "advance") {
            await store.srem(storeHelpers.intakeGasGated(), jobId).catch(() => {});
          }
        }
      }
    }

    if (range.from === null) {
      await store.set(cursorKey(), String(counter));
      summary.status = "idle";
      summary.cursor = String(counter);
      summary.finishedAt = new Date().toISOString();
      await saveState(summary);
      return summary;
    }

    const ids = [];
    for (let id = range.from; id <= range.to; id += 1n) ids.push(id.toString());
    summary.scanned = ids.length;

    const jobs = await getAcpJobs(ids);
    if (jobs.length > 0 && jobs.every((job) => !job)) {
      throw AppError.upstream(
        "ACP intake could not read any job in the scan window; refusing to advance the cursor over unread jobs.",
        { from: range.from.toString(), to: range.to.toString() },
        "ACP_READ_FAILED"
      );
    }
    let advanceTo = range.from - 1n;

    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index];
      const jobId = ids[index];
      if (!job) {
        advanceTo = BigInt(jobId);
        continue;
      }
      if (job.status !== FUNDED || job.provider.toLowerCase() !== agent) {
        advanceTo = BigInt(jobId);
        continue;
      }
      const disposition = await processMatchedJob({ job, jobId });
      if (disposition === "deferred") {
        summary.deferred = jobs.length - index;
        break;
      }
      advanceTo = BigInt(jobId);
    }

    if (summary.deferred === 0) advanceTo = range.last;
    await store.set(cursorKey(), String(advanceTo));
    summary.cursor = String(advanceTo);
    summary.lastScanned = range.last.toString();
    summary.finishedAt = new Date().toISOString();

    if (summary.executed || summary.failed || summary.unrecognized || summary.gasGated) {
      logger.info("ACP intake pass finished", {
        scanned: summary.scanned,
        matched: summary.matched,
        executed: summary.executed,
        failed: summary.failed,
        deferred: summary.deferred,
        gasGated: summary.gasGated,
        cursor: summary.cursor,
      });
    }
    return summary;
  } catch (error) {
    summary.status = "failed";
    summary.error = { code: error.code || "INTAKE_FAILED", message: error.message };
    summary.finishedAt = new Date().toISOString();
    logger.warn("ACP intake pass failed", { code: summary.error.code, message: summary.error.message });
    return summary;
  } finally {
    await saveState(summary);
    await releaseLock(storeHelpers.intakeLock(), lockToken);
  }
}

export async function intakeStatus() {
  const [cursor, state, gasGated] = await Promise.all([
    store.get(cursorKey()).catch(() => null),
    store.get(storeHelpers.intakeState()).catch(() => null),
    store.smembers(storeHelpers.intakeGasGated()).catch(() => []),
  ]);
  return {
    enabled: config.intake.enabled,
    walletConfigured,
    intervalSeconds: config.intake.intervalSeconds,
    batch: config.intake.batch,
    scanLimit: config.intake.scanLimit,
    startId: config.intake.startId,
    cursor: cursor === null || cursor === undefined ? null : String(cursor),
    driver: isVercel ? "vercel_cron" : "local_loop",
    gasGatedJobs: (Array.isArray(gasGated) ? gasGated : []).map(String),
    lastRun: state || null,
  };
}

let timer = null;

export function startIntakeLoop() {
  if (timer) return { started: false, reason: "ALREADY_RUNNING" };
  if (isVercel) {
    logger.info("ACP intake runs via Vercel cron (/api/cron/intake)");
    return { started: false, reason: "VERCEL_CRON" };
  }
  if (!config.intake.enabled) {
    logger.info("ACP intake disabled (set ACP_INTAKE_ENABLED=true to enable)");
    return { started: false, reason: "DISABLED" };
  }
  if (!walletConfigured) {
    logger.info("ACP intake idle until AGENT_PRIVATE_KEY is configured");
    return { started: false, reason: "WALLET_NOT_CONFIGURED" };
  }

  const run = () => {
    intakeOnce({ reason: "interval" }).catch((error) => {
      logger.warn("ACP intake iteration crashed", { message: error.message });
    });
  };

  setTimeout(run, 15_000).unref?.();
  timer = setInterval(run, config.intake.intervalSeconds * 1000);
  timer.unref?.();
  logger.info("ACP intake loop started", {
    intervalSeconds: config.intake.intervalSeconds,
    batch: config.intake.batch,
    scanLimit: config.intake.scanLimit,
  });
  return { started: true, intervalSeconds: config.intake.intervalSeconds };
}

export function stopIntakeLoop() {
  if (timer) clearInterval(timer);
  timer = null;
}
